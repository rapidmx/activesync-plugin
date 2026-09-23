///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors, type RecoverableBaseEntity, type RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "@rapidmx/restapi";
import type { DeviceSyncState } from "./models/DeviceSyncState.js";

/**
 * A position in a `(dateModified, uid)`-ordered change stream. `dateModified` alone is not a total order - several
 * rows can share one timestamp (a bulk update inside one millisecond) - so a cursor that only remembered the
 * timestamp would either re-send or skip the rows sharing the page boundary's timestamp. `uid` breaks the tie;
 * `""` means "before every row at `date`".
 */
export interface ChangeCursor {
    date: Date;
    uid: string;
}

/** Whether `uid` can be listed in an `in(...)` query operand as itself: no comma (the operand separator), no parentheses
 * or other punctuation, and not one of the literals the query parser substitutes (`me`, `null`). */
export function isListableUid(uid: string): boolean {
    return /^[A-Za-z0-9_.:@+-]+$/.test(uid) && uid !== "me" && uid !== "null";
}

/** The cursor that precedes every row ever written. */
export function epochCursor(): ChangeCursor {
    return { date: new Date(0), uid: "" };
}

/** Orders two `(date, uid)` positions: negative when `a` sorts before `b`, positive when after, `0` when equal. */
export function compareCursor(a: ChangeCursor, b: ChangeCursor): number {
    const byDate = a.date.getTime() - b.date.getTime();
    if (byDate !== 0) {
        return byDate;
    }
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/** The cursor position of `row`. */
export function cursorOf(row: { dateModified: Date | string; uid: string }): ChangeCursor {
    return { date: new Date(row.dateModified), uid: row.uid };
}

/**
 * A parsed EAS `SyncKey`. The wire value is opaque to the client per spec, so this library encodes it as
 * `"<generation>:<watermarkIso>"`, optionally followed by `"#<uid>"` when the cursor has a tie-breaking uid (e.g.
 * `"3:2026-09-04T12:00:00.000Z#6f1c..."`) - a monotonic generation counter (bumped once per successful sync round,
 * satisfying the spec's "the server MUST return a different SyncKey every time" requirement) paired with the
 * `(dateModified, uid)` cursor that generation was issued at.
 */
export interface SyncKey {
    generation: number;
    watermark: Date;
    uid?: string;
}

/** Formats a `SyncKey` back into its wire string form. */
export function formatSyncKey(key: SyncKey): string {
    return `${key.generation}:${key.watermark.toISOString()}${key.uid ? `#${key.uid}` : ""}`;
}

/** Parses a stored/previously-issued `SyncKey` string. Returns `undefined` for a malformed value - callers
 * only ever parse a key this library itself minted and stored (never a raw, unvalidated client value; see
 * `resolveSyncKey`'s doc comment), so `undefined` here signals corrupted persisted state, not client input. */
export function parseSyncKey(value: string): SyncKey | undefined {
    const separator = value.indexOf(":");
    if (separator === -1) {
        return undefined;
    }
    const generation = Number(value.slice(0, separator));
    const rest = value.slice(separator + 1);
    const hash = rest.indexOf("#");
    const watermark = new Date(hash === -1 ? rest : rest.slice(0, hash));
    if (!Number.isFinite(generation) || Number.isNaN(watermark.getTime())) {
        return undefined;
    }
    return hash === -1 ? { generation, watermark } : { generation, watermark, uid: rest.slice(hash + 1) };
}

export type SyncKeyResolution =
    | { kind: "initial" }
    | { kind: "valid"; key: SyncKey }
    | { kind: "invalid" };

/**
 * Resolves an incoming client `SyncKey` string against the value this library itself previously issued and
 * stored (`storedValue`, e.g. `DeviceSyncState.folderSyncKeys["$foldersync"]`) — deliberately a plain string
 * equality check, not a re-parse-and-compare of the client's value, so a client that echoes back anything
 * other than the exact opaque string it was handed is treated as `"invalid"` even if it happens to parse.
 *
 * - `"0"` (or empty/missing) from the client is always `"initial"` regardless of `storedValue` — an EAS
 * client legitimately sends this to (re)start a collection from scratch (first-ever sync, or recovering
 * from an `"invalid"` response elsewhere), and the spec requires the server honor it unconditionally.
 * - Otherwise, a match against `storedValue` is `"valid"`; anything else (including `storedValue` being
 * unset, i.e. the server has no record of ever issuing a key for this scope) is `"invalid"` — forcing the
 * client back to `"0"`, per spec, rather than guessing at recovery.
 */
export function resolveSyncKey(clientValue: string | undefined, storedValue: string | undefined): SyncKeyResolution {
    if (!clientValue || clientValue === "0") {
        return { kind: "initial" };
    }
    if (storedValue === undefined || clientValue !== storedValue) {
        return { kind: "invalid" };
    }
    const parsed = parseSyncKey(storedValue);
    return parsed ? { kind: "valid", key: parsed } : { kind: "invalid" };
}

/** How many times `persistDeviceSyncState` re-reads and re-applies its patch after losing an optimistic-lock race. */
const PERSIST_MAX_ATTEMPTS = 5;

/**
 * Applies `patch` to `deviceSyncState` and persists it - the one correct way any EAS command handler (or
 * `BaseEasRoute` itself) should ever write to a `DeviceSyncState`.
 *
 * `RepoUtils.update()` does **not** mutate the `existing` object passed to it - it only returns a freshly-fetched
 * instance reflecting the write - so the returned row (including its bumped `version`) is copied back onto
 * `deviceSyncState`, keeping a second write later in the same request from being built off a stale version.
 *
 * **Concurrent requests**: one device routinely has several requests in flight at once (a long-poll `Ping`
 * alongside a `Sync`, or two `Sync`s for different folders), and the row's optimistic lock covers the whole row.
 * Losing that race used to surface as a 409 *after* the command's side effects had already happened. Instead, a
 * version conflict re-reads the row, re-applies the patch on top of the fresh copy and retries (bounded). Pass
 * `patch` as a function when it derives from the row's current content (e.g. updating one entry of the
 * `folderSyncKeys` map) so the retry merges into what the other request wrote rather than overwriting it.
 */
export async function persistDeviceSyncState(
    deviceSyncState: DeviceSyncState,
    deviceSyncStateRepo: RepoUtils<any>,
    patch: Record<string, unknown> | ((current: DeviceSyncState) => Record<string, unknown>),
): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        const values: Record<string, unknown> = typeof patch === "function" ? patch(deviceSyncState) : patch;
        Object.assign(deviceSyncState, values);
        try {
            const updated = await deviceSyncStateRepo.update(
                { uid: deviceSyncState.uid, version: (deviceSyncState as any).version, ...values } as any,
                asEntity(deviceSyncStateRepo, deviceSyncState),
                { ignoreACL: true, skipPush: true },
            );
            Object.assign(deviceSyncState, updated);
            return;
        } catch (err: any) {
            if (!(err instanceof ApiError) || err.code !== ApiErrors.INVALID_OBJECT_VERSION || attempt >= PERSIST_MAX_ATTEMPTS) {
                throw err;
            }
            const fresh = await deviceSyncStateRepo.findOne(deviceSyncState.uid, { ignoreACL: true });
            if (!fresh) {
                throw err;
            }
            Object.assign(deviceSyncState, fresh);
        }
    }
}

/** The JSON sort expression both backends' query builders accept for a `(dateModified, uid)` ordering. */
const CURSOR_SORT = JSON.stringify({ dateModified: "ASC", uid: "ASC" });

/**
 * Reads up to `limit` rows matching `criteria` that sort strictly after `cursor` in `(dateModified, uid)` order,
 * live and soft-deleted rows merged into one stream. `more` is `true` when rows beyond the returned page exist.
 *
 * `RepoUtils.find()` excludes soft-deleted rows unless the query names `deleted` explicitly, so the two halves are
 * separate queries (the second with a literal `deleted: true`), each over-fetched by one and merged. `limit`/`sort`
 * are baked into the query object as well as the options - the SQL query builder only reads the former.
 */
export async function scanAfter<T extends RecoverableBaseEntity>(
    repo: RepoUtils<T>,
    criteria: Record<string, unknown>,
    cursor: ChangeCursor,
    limit: number,
): Promise<{ rows: T[]; more: boolean }> {
    const iso = cursor.date.toISOString();
    const position: Record<string, unknown> = cursor.uid
        ? { $or: [{ dateModified: `gt(${iso})` }, { dateModified: `range(${iso},${iso})`, uid: `gt(${cursor.uid})` }] }
        : { dateModified: `gt(${iso})` };
    const query: any = { ...criteria, ...position, sort: CURSOR_SORT, limit: limit + 1 };
    const options: any = { ignoreACL: true, limit: limit + 1 };
    const [live, deleted] = await Promise.all([repo.find(query, options), repo.find({ ...query, deleted: true }, options)]);
    const merged: T[] = [...live, ...deleted].sort((a: any, b: any) => compareCursor(cursorOf(a), cursorOf(b)));
    return { rows: merged.slice(0, limit), more: merged.length > limit };
}

/** The JSON sort expression for the newest-first `(dateModified, uid)` ordering `scanOverlap` reads with. */
const CURSOR_SORT_DESC = JSON.stringify({ dateModified: "DESC", uid: "DESC" });

/**
 * Reads the rows matching `criteria` at or before `cursor` whose `dateModified` lies within `windowMs` of it - the
 * part of the stream a cursor has already passed but where a row committed out of order (another replica stamped
 * `dateModified` before this one read past it, but committed after) can still appear. At most `limit` rows, the
 * newest ones, returned in ascending `(dateModified, uid)` order; live and soft-deleted rows merged as `scanAfter`
 * does. Returns nothing for the epoch cursor (nothing has been passed yet).
 */
export async function scanOverlap<T extends RecoverableBaseEntity>(
    repo: RepoUtils<T>,
    criteria: Record<string, unknown>,
    cursor: ChangeCursor,
    windowMs: number,
    limit: number,
): Promise<T[]> {
    if (cursor.date.getTime() === 0 || windowMs <= 0 || limit <= 0) {
        return [];
    }
    const from = new Date(Math.max(0, cursor.date.getTime() - windowMs)).toISOString();
    const query: any = { ...criteria, dateModified: `range(${from},${cursor.date.toISOString()})`, sort: CURSOR_SORT_DESC, limit };
    const options: any = { ignoreACL: true, limit };
    const [live, deleted] = await Promise.all([repo.find(query, options), repo.find({ ...query, deleted: true }, options)]);
    return [...live, ...deleted]
        .filter((row: any) => compareCursor(cursorOf(row), cursor) <= 0)
        .sort((a: any, b: any) => compareCursor(cursorOf(b), cursorOf(a)))
        .slice(0, limit)
        .reverse();
}

/** One page of enumerated changes for a `RecoverableBaseEntity` collection scoped by a single field. */
export interface ChangeSet<T extends RecoverableBaseEntity> {
    adds: T[];
    changes: T[];
    deletes: T[];
    /** The cursor to persist for the next round - the last row actually included in this page, never simply
     * "now" (which would silently skip any row modified after this page was read). Equal to the input cursor when
     * nothing changed. */
    cursor: ChangeCursor;
    /** `true` when more changed rows exist beyond `windowSize`. */
    moreAvailable: boolean;
}

/**
 * Enumerates `Add`/`Change`/`Delete`s for one scoped collection after `cursor` - used by `FolderSyncCommand`
 * (scoped by `mailboxUid` over `Folder`). `Sync` item collections use `EasCollectionSync` instead, which tracks the
 * exact set of items each device holds; the folder hierarchy is small and always fully re-sent on `SyncKey 0`, so
 * a creation-time rule is enough here: a row created after the cursor can't be on the device yet, so a live one is
 * an `Add` (never an `Update` for a `ServerId` the device has never seen) and a deleted one is not reported at all.
 */
export async function computeChanges<T extends RecoverableBaseEntity>(
    repo: RepoUtils<T>,
    scopeField: string,
    scopeUid: string,
    cursor: ChangeCursor,
    windowSize: number,
): Promise<ChangeSet<T>> {
    const { rows, more } = await scanAfter(repo, { [scopeField]: scopeUid }, cursor, windowSize);

    const adds: T[] = [];
    const changes: T[] = [];
    const deletes: T[] = [];
    let next: ChangeCursor = cursor;
    for (const row of rows) {
        next = cursorOf(row);
        const createdAfterCursor = new Date((row as any).dateCreated).getTime() > cursor.date.getTime();
        if ((row as any).deleted === true) {
            if (!createdAfterCursor) {
                deletes.push(row);
            }
        } else {
            (createdAfterCursor ? adds : changes).push(row);
        }
    }

    return { adds, changes, deletes, cursor: next, moreAvailable: more };
}
