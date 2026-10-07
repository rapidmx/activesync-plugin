///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RecoverableBaseEntity, RepoUtils } from "@rapidrest/service-core";
import { FolderType } from "@rapidmx/restapi";
import { type ChangeCursor, compareCursor, cursorOf, isListableUid, parseSyncKey, scanAfter, scanOverlap } from "./EasSyncKeyUtils.js";
import type { EasCollectionRound, EasCollectionState } from "./models/EasCollectionState.js";

/** How far before a round's start the out-of-folder cursor is fast-forwarded while the device holds nothing -
 * generous slack for clock differences between the servers stamping `dateModified`. */
const MOVE_CURSOR_SLACK_MS = 60_000;

/** How far behind each cursor a round re-reads the stream for rows committed out of order by another replica. */
export const DEFAULT_OVERLAP_MS = 5_000;

/** Most rows one overlap re-read returns, and most entries `recent` keeps. */
export const DEFAULT_OVERLAP_LIMIT = 1000;

/** The in-memory, mutable form of an `EasCollectionState` for one `Sync`/`GetItemEstimate` round. */
export interface CollectionWorkingState {
    generation: number;
    cursor: ChangeCursor;
    moveCursor: ChangeCursor;
    serverIds: Set<string>;
    echoes: Map<string, string>;
    /** Rows the folder stream processed within the overlap window (see `EasCollectionState.recent`). `undefined` for a
     * row written before overlap tracking existed - the rows currently in the window are then taken as reported. */
    recent?: Map<string, string>;
    /** See `EasCollectionState.reconcileCursor`. */
    reconcileCursor: string;
    /** `undefined` when the collection was started without a `FilterType`. */
    filterType?: string;
}

/** One server-side change to report to the device. */
export type CollectionCommand<T> = { kind: "Add" | "Change"; item: T } | { kind: "Delete"; uid: string };

function mapOf(record: Record<string, string> | null | undefined): Map<string, string> | undefined {
    return record ? new Map(Object.entries(record)) : undefined;
}

/** Loads the working state for the round a client's current `SyncKey` (`state.syncKey`) continues. `held` is the
 * collection's held set (see `EasCollectionStore.loadHeldSet`); defaults to the inline `serverIds`. */
export function workingStateFromRow(state: EasCollectionState, held: Set<string> = new Set(state.serverIds)): CollectionWorkingState {
    return {
        generation: parseSyncKey(state.syncKey)?.generation ?? 0,
        cursor: { date: new Date(state.cursorDate), uid: state.cursorUid },
        moveCursor: { date: new Date(state.moveCursorDate), uid: state.moveCursorUid },
        serverIds: new Set(held),
        echoes: new Map(Object.entries(state.echoes ?? {})),
        recent: mapOf(state.recent),
        reconcileCursor: state.reconcileCursor ?? "",
        filterType: state.filterType ?? undefined,
    };
}

/** Rebuilds the working state as it stood before the most recent round, for a client retrying `round.syncKey`. */
export function workingStateFromRound(
    state: EasCollectionState,
    round: EasCollectionRound,
    held: Set<string> = new Set(state.serverIds),
): CollectionWorkingState {
    const serverIds = new Set(held);
    for (const uid of round.addedIds) {
        serverIds.delete(uid);
    }
    for (const uid of round.removedIds) {
        serverIds.add(uid);
    }
    return {
        generation: parseSyncKey(round.syncKey)?.generation ?? 0,
        cursor: { date: new Date(round.cursorDate), uid: round.cursorUid },
        moveCursor: { date: new Date(round.moveCursorDate), uid: round.moveCursorUid },
        serverIds,
        echoes: new Map(Object.entries(round.echoes)),
        recent: mapOf(round.recent),
        reconcileCursor: round.reconcileCursor ?? "",
        filterType: state.filterType ?? undefined,
    };
}

/** Deep-copies a working state so a dry run (`GetItemEstimate`) can't disturb the original. */
export function cloneWorkingState(state: CollectionWorkingState): CollectionWorkingState {
    return {
        ...state,
        cursor: { ...state.cursor },
        moveCursor: { ...state.moveCursor },
        serverIds: new Set(state.serverIds),
        echoes: new Map(state.echoes),
        recent: state.recent ? new Map(state.recent) : undefined,
    };
}

/** Records the round that turned `base` into `result` (see `EasCollectionRound`). */
export function roundRecord(
    syncKey: string,
    base: CollectionWorkingState,
    result: CollectionWorkingState,
    clientIds: Map<string, string>,
): EasCollectionRound {
    return {
        syncKey,
        cursorDate: base.cursor.date.toISOString(),
        cursorUid: base.cursor.uid,
        moveCursorDate: base.moveCursor.date.toISOString(),
        moveCursorUid: base.moveCursor.uid,
        addedIds: [...result.serverIds].filter((uid) => !base.serverIds.has(uid)),
        removedIds: [...base.serverIds].filter((uid) => !result.serverIds.has(uid)),
        echoes: Object.fromEntries(base.echoes),
        ...(base.recent ? { recent: Object.fromEntries(base.recent) } : {}),
        reconcileCursor: base.reconcileCursor,
        clientIds: [...clientIds].map(([clientId, serverId]) => ({ clientId, serverId })),
    };
}

export interface EnumerateCollectionOptions<T> {
    repo: RepoUtils<T & RecoverableBaseEntity>;
    folderUid: string;
    /** The mailbox that owns the folder - items moved out of it stay within this mailbox. */
    folderMailboxUid: string;
    /** Most commands to report. */
    windowSize: number;
    /** Rows read from the out-of-folder stream per round. */
    moveScanLimit: number;
    /** `FilterType` window: an item the device doesn't hold yet is only added when this returns `true`. */
    include?: (item: T) => boolean;
    /** How far behind each cursor the streams are re-read (default `DEFAULT_OVERLAP_MS`; `0` disables). */
    overlapMs?: number;
    /** Most rows per overlap re-read and entries kept in `recent` (default `DEFAULT_OVERLAP_LIMIT`). */
    overlapLimit?: number;
    /** Held `ServerId`s checked against the store per caught-up round (`0`/absent disables the reconcile). */
    reconcileLimit?: number;
    now?: Date;
}

/**
 * Computes one round of server-side changes for a `Sync` collection and advances `state` past them:
 *
 * - **Out-of-folder stream** (rows of the same mailbox in any other folder after `state.moveCursor`, live or
 * deleted): an item the device holds has been moved out of this folder and is a `Delete`. Read before the folder
 * rows are processed, so when an item moves between the two reads the out-of-folder row (the newer one) wins.
 * Skipped while the device holds nothing; the cursor is then fast-forwarded to just before the round started
 * instead, so the first real scan doesn't have to crawl the whole mailbox history.
 * - **Folder stream** (rows of this folder after `state.cursor`): a live item the device holds is a `Change`, one
 * it doesn't hold is an `Add` (subject to `include`), a soft-deleted item it holds is a `Delete`; a row whose
 * `dateModified` still equals the device's own recorded write (`state.echoes`) is skipped.
 * - **Overlap**: `dateModified` is stamped before a write commits, so with several replicas a row can become visible
 * after a cursor has already passed its timestamp. Both streams therefore also re-read the last `overlapMs` behind
 * their cursor. Out-of-folder rows are idempotent (an item is only deleted while held), so they're simply
 * re-applied; folder rows are deduplicated against `state.recent` (uid -> the `dateModified` it was processed at),
 * and only a row not recorded there at that timestamp - one that became visible late - is processed.
 * - **Reconcile**: a hard-purged row leaves no trace in either stream. Once a round has caught up (nothing more
 * available), up to `reconcileLimit` held ids after `state.reconcileCursor` are looked up in the folder, and each
 * one that no longer exists there is a `Delete`; the cursor wraps around after the last held id.
 *
 * Both cursors only ever advance past rows actually processed - never to "now" - so nothing is skipped when the
 * window fills up (`moreAvailable`).
 */
export async function enumerateCollection<T extends RecoverableBaseEntity>(
    state: CollectionWorkingState,
    options: EnumerateCollectionOptions<T>,
): Promise<{ commands: CollectionCommand<T>[]; moreAvailable: boolean }> {
    const startedAt: number = (options.now ?? new Date()).getTime();
    const overlapMs: number = options.overlapMs ?? DEFAULT_OVERLAP_MS;
    const overlapLimit: number = options.overlapLimit ?? DEFAULT_OVERLAP_LIMIT;
    const folderCriteria = { folderUid: options.folderUid };
    const moveCriteria = { mailboxUid: options.folderMailboxUid, folderUid: `ne(${options.folderUid})` };

    const folderLate: T[] = await scanOverlap<T>(options.repo, folderCriteria, state.cursor, overlapMs, overlapLimit);
    const folderPage = await scanAfter<T>(options.repo, folderCriteria, state.cursor, options.windowSize);
    const holdsItems: boolean = state.serverIds.size > 0;
    const moveLate: T[] = holdsItems ? await scanOverlap<T>(options.repo, moveCriteria, state.moveCursor, overlapMs, overlapLimit) : [];
    const movePage = holdsItems ? await scanAfter<T>(options.repo, moveCriteria, state.moveCursor, options.moveScanLimit) : undefined;

    const commands: CollectionCommand<T>[] = [];
    let budget: number = options.windowSize;
    let moreAvailable: boolean = folderPage.more || !!movePage?.more;
    // A row saved before overlap tracking existed has no record of what its window already reported: everything
    // currently visible there is taken as reported, rather than re-sent.
    const recent: Map<string, string> =
        state.recent ?? new Map(folderLate.map((row) => [row.uid, new Date((row as any).dateModified).toISOString()]));

    const movedOut = new Set<string>();
    /** Processes one out-of-folder row; `false` when the window is full and the row was left for a later round. */
    const processMoved = (row: T): boolean => {
        if (state.serverIds.has(row.uid)) {
            if (budget === 0) {
                moreAvailable = true;
                return false;
            }
            commands.push({ kind: "Delete", uid: row.uid });
            state.serverIds.delete(row.uid);
            budget--;
        }
        movedOut.add(row.uid);
        return true;
    };
    if (movePage) {
        for (const row of moveLate) {
            if (!processMoved(row)) {
                break;
            }
        }
        for (const row of movePage.rows) {
            if (!processMoved(row)) {
                break;
            }
            state.moveCursor = cursorOf(row);
        }
    } else {
        const floor: ChangeCursor = { date: new Date(startedAt - MOVE_CURSOR_SLACK_MS), uid: "" };
        if (compareCursor(floor, state.moveCursor) > 0) {
            state.moveCursor = floor;
        }
    }

    /** Processes one folder-stream row; `false` when the window is full and the row was left for a later round. */
    const processFolderRow = (row: T, iso: string): boolean => {
        const uid: string = row.uid;
        const echo: string | undefined = state.echoes.get(uid);
        let command: CollectionCommand<T> | undefined;
        if (movedOut.has(uid) || (echo !== undefined && echo === iso)) {
            command = undefined;
        } else if ((row as any).deleted === true) {
            command = state.serverIds.has(uid) ? { kind: "Delete", uid } : undefined;
        } else if (state.serverIds.has(uid)) {
            command = { kind: "Change", item: row };
        } else if (!options.include || options.include(row)) {
            command = { kind: "Add", item: row };
        }
        if (command) {
            if (budget === 0) {
                moreAvailable = true;
                return false;
            }
            commands.push(command);
            if (command.kind === "Delete") {
                state.serverIds.delete(uid);
            } else {
                state.serverIds.add(uid);
            }
            budget--;
        }
        recent.set(uid, iso);
        return true;
    };
    for (const row of folderLate) {
        const iso: string = new Date((row as any).dateModified).toISOString();
        if (recent.get(row.uid) !== iso && !processFolderRow(row, iso)) {
            break;
        }
    }
    for (const row of folderPage.rows) {
        if (!processFolderRow(row, new Date((row as any).dateModified).toISOString())) {
            break;
        }
        state.cursor = cursorOf(row);
    }

    for (const [uid, iso] of state.echoes) {
        if (compareCursor({ date: new Date(iso), uid }, state.cursor) <= 0) {
            state.echoes.delete(uid);
        }
    }
    state.recent = pruneRecent(recent, state.cursor, overlapMs, overlapLimit);

    if (!moreAvailable && budget > 0 && (options.reconcileLimit ?? 0) > 0 && state.serverIds.size > 0) {
        moreAvailable = await reconcile(state, options, commands, budget);
    }

    return { commands, moreAvailable };
}

/** Keeps only the `recent` entries still inside the overlap window behind `cursor`, at most `limit` (the newest). */
function pruneRecent(recent: Map<string, string>, cursor: ChangeCursor, overlapMs: number, limit: number): Map<string, string> {
    const floor: number = cursor.date.getTime() - overlapMs;
    const kept = [...recent].filter(([, iso]) => new Date(iso).getTime() >= floor);
    kept.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
    return new Map(kept.slice(0, limit));
}

/** One reconcile slice (see `enumerateCollection`). Returns whether commands were left for a later round. */
async function reconcile<T extends RecoverableBaseEntity>(
    state: CollectionWorkingState,
    options: EnumerateCollectionOptions<T>,
    commands: CollectionCommand<T>[],
    budget: number,
): Promise<boolean> {
    const limit: number = options.reconcileLimit!;
    const slice: string[] = [...state.serverIds]
        .filter((uid) => uid > state.reconcileCursor)
        .sort()
        .slice(0, limit);
    if (slice.length === 0) {
        state.reconcileCursor = "";
        return false;
    }
    // Only plain uids go into the `in(...)` operand, which the query parser splits on commas and coerces per value (`me`
    // is the caller, `null` is null); any other held id is checked on its own by exact uid.
    const listable: string[] = slice.filter(isListableUid);
    const found: T[] =
        listable.length === 0
            ? []
            : await options.repo.find({ folderUid: options.folderUid, uid: `in(${listable.join(",")})`, limit: listable.length } as any, {
                  ignoreACL: true,
                  limit: listable.length,
              });
    const present = new Set(found.filter((row: any) => row.folderUid === options.folderUid).map((row) => row.uid));
    for (const uid of slice.filter((id) => !isListableUid(id))) {
        const row: any = await options.repo.findOne(uid, { ignoreACL: true });
        if (row && row.uid === uid && row.folderUid === options.folderUid) {
            present.add(uid);
        }
    }
    for (const uid of slice) {
        if (!present.has(uid)) {
            if (budget === 0) {
                return true;
            }
            commands.push({ kind: "Delete", uid });
            state.serverIds.delete(uid);
            state.echoes.delete(uid);
            budget--;
        }
        state.reconcileCursor = uid;
    }
    if (slice.length < limit) {
        state.reconcileCursor = "";
    }
    return false;
}

/** The `Class` a folder of `type` holds - for a `Sync`/`GetItemEstimate` request that omits `Class` for a collection
 * with no remembered class. */
export function classForFolderType(type: FolderType): string {
    switch (type) {
        case FolderType.CALENDAR:
            return "Calendar";
        case FolderType.CONTACTS:
        case FolderType.SUGGESTED_CONTACTS:
            return "Contacts";
        case FolderType.TASKS:
            return "Tasks";
        default:
            return "Email";
    }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** [MS-ASCMD] `FilterType` age windows, in days (`1`..`7`). */
const FILTER_DAYS: Record<string, number> = { "1": 1, "2": 3, "3": 7, "4": 14, "5": 30, "6": 90, "7": 180 };

/**
 * Builds the `include` predicate for a collection's `FilterType`, or `undefined` for no filtering: `Email` keeps
 * messages received within the window; `Calendar` keeps recurring events and events ending within it; `Tasks`
 * keeps incomplete tasks for `8`. Values a class doesn't define (and no `FilterType` at all) are treated as "no
 * filter".
 */
export function filterPredicate(
    collectionClass: string,
    filterType: string | undefined,
    now: Date = new Date(),
): ((item: any) => boolean) | undefined {
    const days: number | undefined = filterType !== undefined ? FILTER_DAYS[filterType] : undefined;
    if (collectionClass === "Email" && days !== undefined && days <= 30) {
        const cutoff = now.getTime() - days * DAY_MS;
        return (item) => new Date(item.receivedDate).getTime() >= cutoff;
    }
    if (collectionClass === "Calendar" && days !== undefined && days >= 14) {
        const cutoff = now.getTime() - days * DAY_MS;
        return (item) => !!item.recurrenceRule || new Date(item.endDate).getTime() >= cutoff;
    }
    if (collectionClass === "Tasks" && filterType === "8") {
        return (item) => !item.completed;
    }
    return undefined;
}
