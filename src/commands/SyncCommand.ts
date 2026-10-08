///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import {
    ACLAction,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    ObjectFactory,
    RepoUtils,
    type RecoverableBaseEntity,
} from "@rapidrest/service-core";
import {
    asEntity,
    AuditAction,
    AuditLogUtils,
    findOrCreateWellKnownFolder,
    hasMailAccess,
    type Folder,
    FolderType,
    RecoverableRepoUtils,
    type Mailbox,
} from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { formatSyncKey } from "../EasSyncKeyUtils.js";
import {
    classForFolderType,
    cloneWorkingState,
    type CollectionWorkingState,
    enumerateCollection,
    filterPredicate,
    roundRecord,
    workingStateFromRound,
    workingStateFromRow,
} from "../EasCollectionSync.js";
import { type ChunkStore, clearHeldSet, type HeldSet, INLINE_HELD_LIMIT, loadHeldSet, saveHeldSet } from "../EasCollectionStore.js";
import { hasLiveSendLease, type MessageMovePlan, planMessageMove } from "../MessageMoveRules.js";
import { EasCollectionLease, type LeaseRelease } from "../EasCollectionLease.js";
import { EasAuditLog } from "../EasAuditLog.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { EasCollectionSyncAdapter, SyncBodyPreference } from "../adapters/EasCollectionSyncAdapter.js";
import type { EasCollectionState } from "../models/EasCollectionState.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Default most item changes reported per collection per `Sync` round. */
const DEFAULT_WINDOW_SIZE = 100;

/** [MS-ASCMD]'s own ceiling for `WindowSize`. */
const MAX_WINDOW_SIZE = 512;

/** Most `<Collection>`s one `Sync` request may carry - more is answered with a top-level Status 4. */
export const MAX_SYNC_COLLECTIONS = 300;

/** Most client `Add`/`Change`/`Delete` commands one collection of a `Sync` request may carry - more is answered
 * with that collection's Status 4, without applying any of them. */
export const MAX_SYNC_COMMANDS_PER_COLLECTION = 512;

/** Rows read per round from the stream of items outside a collection's folder (see `enumerateCollection`). */
const DEFAULT_MOVE_SCAN_LIMIT = 1000;

/** Held ids checked against the store per caught-up round (see `enumerateCollection`'s reconcile). */
const DEFAULT_RECONCILE_LIMIT = 100;

/** Slack subtracted from "now" when a collection is (re)started, for the out-of-folder cursor. */
const MOVE_CURSOR_SLACK_MS = 60_000;

/** How long a `Sync` waits for another request's lease on the same collection before answering Status 16. */
const LEASE_WAIT_MS = 15_000;

/** How long a collection lease lives in Redis if its holder dies without releasing it. */
const LEASE_TTL_MS = 120_000;

/** [MS-ASCMD] `Sync` Status values this command reports beyond success. */
const STATUS_INVALID_SYNC_KEY = "3";
const STATUS_SERVER_ERROR = "5";
const STATUS_RETRY = "16";

/** Binds one MS-ASCMD `Class` value (`"Email"`, `"Contacts"`, ...) to the concrete entity class `SyncCommand`
 * should build a `RepoUtils` for, and the adapter class that maps that entity to/from `ApplicationData`.
 * Supplied by the Mongo/SQL concrete subclasses, one map entry per supported collection type. */
export interface SyncCollectionBinding<T extends RecoverableBaseEntity> {
    entityClass: any;
    adapterClass: any;
}

/** Everything one collection's round needs while applying client commands. */
interface CollectionRound {
    ctx: EasCommandContext;
    folder: Folder & { uid: string };
    collectionClass: string;
    adapter: EasCollectionSyncAdapter<any>;
    repo: RepoUtils<any>;
    working: CollectionWorkingState;
    /** Set when the client retried the previous round's `SyncKey`. */
    retry?: { removedIds: Set<string>; clientIds: Map<string, string> };
    clientIds: Map<string, string>;
    deletesAsMoves: boolean;
    getMailbox: () => Promise<Mailbox>;
    /** The mailbox that owns the synced folder (the caller's own, unless the folder is shared). */
    getFolderMailbox: () => Promise<Mailbox>;
    audit: EasAuditLog;
}

/**
 * Handles EAS `Sync` for `Email`/`Contacts`/`Calendar`/`Tasks` folders.
 *
 * **Per-collection state** lives in its own `EasCollectionState` row per (mailbox, device, folder) - see that
 * model - rather than in `DeviceSyncState`, so concurrent `Sync`s of different folders never contend for one row.
 * Besides the issued `SyncKey`, the row records exactly which items the device holds (inline in `serverIds` while
 * small, in `EasCollectionChunk` rows once large - see `EasCollectionStore`). That is what makes the reported
 * commands correct rather than guessed: an item the device doesn't hold is always an `Add` (including on the first
 * round after `SyncKey 0`), an item it holds is a `Change`, and an item it holds that has been deleted *or moved to
 * another folder* is a `Delete` - see `EasCollectionSync.enumerateCollection`.
 *
 * **One round per collection at a time**: each collection's round runs under a lease on (mailbox, device, folder)
 * (`EasCollectionLease`: in-process, plus Redis `datastores:cache` across server copies when configured), and its
 * state is read only once the lease is held - a second `Sync` of the same collection waits for the first to finish
 * and then sees its result (typically answering the now-previous `SyncKey` as a retry), instead of both computing a
 * round from the same state. A lease not acquired within `LEASE_WAIT_MS` is answered with Status 16 (retry).
 *
 * **Round order**: the client's own `Commands` are applied first, then server changes are enumerated. The device's
 * own writes are not echoed back: each successful `Add`/`Change` records the resulting `dateModified` in the row's
 * `echoes`, and a changed row still carrying exactly that timestamp is skipped. The cursor itself only ever advances
 * past rows actually enumerated, never past a pending server change.
 *
 * **Lost state**: a round's state that can't be saved is answered with the collection's Status 3 (and a failed
 * `SyncKey 0` restart with Status 5), never with a `SyncKey` the server doesn't have - the device re-syncs from
 * scratch instead of continuing from a key whose held set was never recorded.
 *
 * **Retries**: a client that never received a response re-sends the `SyncKey` it still holds. The row keeps the
 * previous round's key and delta (`previous`), so that key is accepted and the round is recomputed from the state
 * before it; an `Add` re-sent with the same `ClientId` is answered with the item created the first time, and a
 * `Delete` of an item that round already removed succeeds silently.
 *
 * **Options honoured**: `WindowSize` (capped by `mail:eas:sync_window_size` and 512), `FilterType` (age window for
 * `Email`/`Calendar`, incomplete-only for `Tasks`; applied to items the device doesn't hold yet). A collection
 * started without `Options` has no filter recorded, and the first `FilterType` sent while the device still holds
 * nothing is adopted (clients commonly send `Options` only from the second request on); a `FilterType` differing
 * from the recorded one otherwise gets Status 3 so the client re-syncs from 0. `DeletesAsMoves` (default `true`: an
 * `Email` delete moves the message to Deleted Items; a delete inside Deleted Items, or with `DeletesAsMoves` `0`,
 * deletes it) and `GetChanges` `0` (no server changes this round).
 *
 * **Meetings**: a device deleting or editing an attendee's copy of someone else's meeting never makes restapi's
 * `MeetingSchedulingJob` send cancellations/invitations as the organizer - see `CalendarSyncAdapter.beforeDelete`
 * and its `fromApplicationData`.
 *
 * **Access**: every `CollectionId` needs `READ` on the folder (otherwise Status 4, indistinguishable from an unknown
 * collection); `Add`/`Change`/`Delete` additionally need `CREATE`/`UPDATE`/`DELETE`, and a `ServerId` that resolves
 * to an item outside the synced folder is reported as not found (Status 8). An `Email` `Add` is only accepted in
 * a Drafts folder ([MS-ASCMD]: no non-draft email may be added by a client), and a new item's `mailboxUid` is the
 * folder's own mailbox, so an item added to a shared folder belongs to that folder's mailbox. An `Email` body can only
 * be changed on a genuine draft (`EmailSyncAdapter`), and a delete-as-move out of Outbox cancels the scheduled send
 * (`MessageMoveRules.planMessageMove`; Status 6 once the message was relayed), and no delete at all happens while a send of
 * the message is in flight (`hasLiveSendLease`, Status 6). Every update is version-checked on both
 * backends (`asEntity`).
 *
 * **Audit** (`EasAuditLog`), only in a mailbox the caller doesn't own (restapi's `isNonOwnerAccess()` - an administrator
 * or a delegate syncing a shared folder), and only for `Email`: a round that sends `Add`/`Change` items records one
 * `MESSAGE_CONTENT_ACCESSED` entry for the collection listing the sent message uids (at most a window's worth), rather
 * than one per row; each successful client `Delete` records one `MESSAGE_DELETE` entry, as restapi's REST delete does.
 *
 * Per `[MS-ASCMD]`, `Add` always gets a `Responses` entry; `Change`/`Delete` only on failure.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SyncCommand implements EasCommandHandler {
    public readonly command = "Sync";

    protected abstract collectionBindings: Record<string, SyncCollectionBinding<any>>;

    /** Supplied by the Mongo/SQL concrete subclasses. */
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;
    protected abstract collectionStateClass: any;
    protected abstract collectionChunkClass: any;
    protected abstract auditLogClass: any;

    @Config("mail:eas:sync_window_size", DEFAULT_WINDOW_SIZE)
    private windowSize: number = DEFAULT_WINDOW_SIZE;

    // `null` rather than the decorator's `undefined` default: a deployment without a `datastores:cache` Redis is
    // legitimate (leases are then in-process only).
    @Config("datastores:cache", null)
    private cacheConfig: any;

    @Config()
    private config?: any;

    /** Roles `@rapidrest/service-core`'s `ACLUtils.hasPermission()` treats as always-permitted - which must never
     * apply to another user's mail. Every ACL check below goes through `hasMailAccess()` (restapi's own fix for
     * the identical issue in its REST routes, `MailAccessUtils.ts`), which strips these roles first. */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    protected moveScanLimit: number = DEFAULT_MOVE_SCAN_LIMIT;
    protected reconcileLimit: number = DEFAULT_RECONCILE_LIMIT;
    protected leaseWaitMs: number = LEASE_WAIT_MS;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Logger
    private logger: any;

    private repos = new Map<string, RepoUtils<any>>();
    private adapters = new Map<string, EasCollectionSyncAdapter<any>>();
    private mailboxRepo?: RepoUtils<any>;
    private folderRepo?: RecoverableRepoUtils<any>;
    private collectionStateRepo?: RepoUtils<any>;
    private collectionChunkRepo?: RepoUtils<any>;
    private auditLogRepo?: RepoUtils<any>;
    private auditLogUtils?: AuditLogUtils;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
        if (!this.collectionStateRepo && this.collectionStateClass) {
            this.collectionStateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.collectionStateClass.name, args: [this.collectionStateClass] });
        }
        if (!this.collectionChunkRepo && this.collectionChunkClass) {
            this.collectionChunkRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.collectionChunkClass.name, args: [this.collectionChunkClass] });
        }
        for (const [collectionClass, binding] of Object.entries(this.collectionBindings)) {
            if (!this.repos.has(collectionClass)) {
                // RecoverableRepoUtils: a soft-delete must bump `dateModified`/`version`, or the change stream
                // enumerated here would never see it.
                this.repos.set(
                    collectionClass,
                    await this._objectFactory.newInstance(RecoverableRepoUtils, { name: binding.entityClass.name, args: [binding.entityClass] }),
                );
            }
            if (!this.adapters.has(collectionClass)) {
                this.adapters.set(collectionClass, await this._objectFactory.newInstance(binding.adapterClass));
            }
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
    }

    private get chunkStore(): ChunkStore {
        return { repo: this.collectionChunkRepo!, chunkClass: this.collectionChunkClass };
    }

    /** Resolves a mailbox at most once per request, and only if actually needed. */
    private mailboxLoader(mailboxUid: string): () => Promise<Mailbox> {
        let cached: Mailbox | undefined;
        return async () => {
            if (!cached) {
                cached = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
                if (!cached) {
                    throw new ApiError(ApiErrors.NOT_FOUND, 404, "The mailbox no longer exists.");
                }
            }
            return cached;
        };
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.aclUtils || !this.folderRepo || !this.collectionStateRepo || !this.collectionChunkRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const collections = ctx.request ? findChild(ctx.request, "Collections") : undefined;
        const collectionEls = collections ? findChildren(collections, "Collection") : [];
        if (collectionEls.length === 0) {
            return element(WbxmlCodePage.AirSync, "Sync", [textElement(WbxmlCodePage.AirSync, "Status", "3")]);
        }
        if (collectionEls.length > MAX_SYNC_COLLECTIONS) {
            return element(WbxmlCodePage.AirSync, "Sync", [textElement(WbxmlCodePage.AirSync, "Status", "4")]);
        }

        const requestWindowSize: string | undefined = childText(ctx.request!, "WindowSize");
        const getMailbox = this.mailboxLoader(ctx.mailboxUid);
        const audit = new EasAuditLog(
            { auditLogUtils: this.auditLogUtils!, mailboxRepo: this.mailboxRepo!, logger: this.logger },
            ctx,
            this.command,
        );
        const collectionElements: WbxmlElement[] = [];
        for (const collectionEl of collectionEls) {
            collectionElements.push(await this.processCollection(ctx, collectionEl, getMailbox, requestWindowSize, audit));
        }

        return element(WbxmlCodePage.AirSync, "Sync", [element(WbxmlCodePage.AirSync, "Collections", collectionElements)]);
    }

    private effectiveWindowSize(requested: string | undefined): number {
        const limit = Math.min(this.windowSize, MAX_WINDOW_SIZE);
        const value = Number(requested);
        return requested !== undefined && Number.isInteger(value) && value > 0 ? Math.min(value, limit) : limit;
    }

    private async processCollection(
        ctx: EasCommandContext,
        collectionEl: WbxmlElement,
        getMailbox: () => Promise<Mailbox>,
        requestWindowSize: string | undefined,
        audit: EasAuditLog,
    ): Promise<WbxmlElement> {
        const requestedClass: string | undefined = childText(collectionEl, "Class");
        const folderUid: string | undefined = childText(collectionEl, "CollectionId");
        const clientSyncKey: string | undefined = childText(collectionEl, "SyncKey");

        // A folder the caller can't even read is reported identically to an unrecognized collection - never
        // reveal whether a client-supplied CollectionId belonging to someone else's mailbox actually exists.
        if (!folderUid || !(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, folderUid, ACLAction.READ))) {
            return this.collectionResponse(requestedClass, folderUid, "4", clientSyncKey);
        }
        const folder: (Folder & { uid: string }) | undefined = await this.folderRepo!.findOne(folderUid, { ignoreACL: true });
        if (!folder) {
            return this.collectionResponse(requestedClass, folderUid, "4", clientSyncKey);
        }

        const release: LeaseRelease | undefined = await EasCollectionLease.acquire(JSON.stringify([ctx.mailboxUid, ctx.deviceId, folderUid]), {
            redisUrl: this.cacheConfig?.url,
            ttlMs: LEASE_TTL_MS,
            waitMs: this.leaseWaitMs,
        });
        if (!release) {
            return this.collectionResponse(requestedClass, folderUid, STATUS_RETRY, clientSyncKey);
        }
        try {
            return await this.processLocked(ctx, collectionEl, folder, getMailbox, requestWindowSize, audit);
        } finally {
            await release();
        }
    }

    /** The rest of `processCollection`, run while holding the collection's lease. */
    private async processLocked(
        ctx: EasCommandContext,
        collectionEl: WbxmlElement,
        folder: Folder & { uid: string },
        getMailbox: () => Promise<Mailbox>,
        requestWindowSize: string | undefined,
        audit: EasAuditLog,
    ): Promise<WbxmlElement> {
        const folderUid: string = folder.uid;
        const requestedClass: string | undefined = childText(collectionEl, "Class");
        const clientSyncKey: string | undefined = childText(collectionEl, "SyncKey");

        const stored: (EasCollectionState & { version: number }) | undefined = (
            await this.collectionStateRepo!.find({ mailboxUid: ctx.mailboxUid, deviceId: ctx.deviceId, folderUid } as any, {
                ignoreACL: true,
                limit: 1,
            })
        )[0];
        const collectionClass: string = requestedClass ?? stored?.collectionClass ?? classForFolderType(folder.type);
        const repo: RepoUtils<any> | undefined = this.repos.get(collectionClass);
        const adapter: EasCollectionSyncAdapter<any> | undefined = this.adapters.get(collectionClass);
        const commandsEl: WbxmlElement | undefined = findChild(collectionEl, "Commands");
        if (!repo || !adapter || (commandsEl?.children.length ?? 0) > MAX_SYNC_COMMANDS_PER_COLLECTION) {
            return this.collectionResponse(collectionClass, folderUid, "4", clientSyncKey);
        }

        const optionsEl: WbxmlElement | undefined = findChild(collectionEl, "Options");
        const requestedFilter: string | undefined = optionsEl ? childText(optionsEl, "FilterType") : undefined;
        const bodyPreference: SyncBodyPreference | undefined = parseBodyPreference(optionsEl);

        if (!clientSyncKey || clientSyncKey === "0") {
            return await this.startCollection(ctx, stored, folderUid, collectionClass, requestedFilter);
        }

        let held: HeldSet;
        try {
            held = await loadHeldSet(stored, this.chunkStore);
        } catch (err: any) {
            this.logger?.warn(`SyncCommand: failed to load sync state for folder ${folderUid}: ${err?.message}`);
            return this.collectionResponse(collectionClass, folderUid, STATUS_SERVER_ERROR, clientSyncKey);
        }
        let working: CollectionWorkingState;
        let retry: CollectionRound["retry"];
        if (stored && clientSyncKey === stored.syncKey) {
            working = workingStateFromRow(stored, held.ids);
        } else if (stored?.previous && clientSyncKey === stored.previous.syncKey) {
            working = workingStateFromRound(stored, stored.previous, held.ids);
            retry = {
                removedIds: new Set(stored.previous.removedIds),
                clientIds: new Map(stored.previous.clientIds.map((entry) => [entry.clientId, entry.serverId])),
            };
        } else {
            return this.collectionResponse(collectionClass, folderUid, STATUS_INVALID_SYNC_KEY, undefined);
        }
        if (requestedFilter !== undefined && requestedFilter !== working.filterType) {
            if (working.filterType === undefined && (working.serverIds.size === 0 || working.generation <= 1)) {
                // Started without Options: adopt the first FilterType while the device still holds nothing it was
                // selected without.
                working.filterType = requestedFilter;
            } else {
                // The window the device's items were selected with no longer matches - restart from SyncKey 0.
                return this.collectionResponse(collectionClass, folderUid, STATUS_INVALID_SYNC_KEY, undefined);
            }
        }

        const base: CollectionWorkingState = cloneWorkingState(working);
        const round: CollectionRound = {
            ctx,
            folder,
            collectionClass,
            adapter,
            repo,
            working,
            retry,
            clientIds: new Map(),
            deletesAsMoves: childText(collectionEl, "DeletesAsMoves") !== "0",
            getMailbox,
            getFolderMailbox: folder.mailboxUid === ctx.mailboxUid ? getMailbox : this.mailboxLoader(folder.mailboxUid),
            audit,
        };

        const responseEntries: WbxmlElement[] = [];
        if (commandsEl) {
            for (const el of commandsEl.children) {
                const response =
                    el.tag === "Add"
                        ? await this.applyAdd(round, el)
                        : el.tag === "Change"
                          ? await this.applyChange(round, el)
                          : el.tag === "Delete"
                            ? await this.applyDelete(round, el)
                            : undefined;
                if (response) {
                    responseEntries.push(response);
                }
            }
        }

        const { commands, moreAvailable } =
            childText(collectionEl, "GetChanges") === "0"
                ? { commands: [], moreAvailable: false }
                : await enumerateCollection(working, {
                      repo,
                      folderUid,
                      folderMailboxUid: folder.mailboxUid,
                      windowSize: this.effectiveWindowSize(childText(collectionEl, "WindowSize") ?? requestWindowSize),
                      moveScanLimit: this.moveScanLimit,
                      reconcileLimit: this.reconcileLimit,
                      include: filterPredicate(collectionClass, working.filterType),
                  });

        // Rendered *before* `saveState()` below persists the round's new watermark/cursor - deliberately. An
        // `adapter.toApplicationData(Batch)` failure (a malformed item - see e.g. CalendarSyncAdapter's own
        // defensive fallbacks for why one can still reach this point) must never leave the device's sync state
        // advanced past items it was never actually sent: once `saveState()` commits, the next round's cursor
        // starts *after* those items, and a response that never reached the device (because this request died
        // with an uncaught error) means they silently never sync again - permanently, not just this one retry.
        // Computing this first makes a render failure abort the whole request before any state changes at all,
        // so the device's next attempt replays the exact same round against the exact same (still unmoved) cursor.
        const upserts = commands.filter((c): c is { kind: "Add" | "Change"; item: any } => c.kind !== "Delete");
        let applicationData: WbxmlElement[];
        try {
            applicationData =
                upserts.length === 0
                    ? []
                    : adapter.toApplicationDataBatch
                      ? await adapter.toApplicationDataBatch(upserts.map((c) => c.item), bodyPreference)
                      : await Promise.all(upserts.map(async (c) => await adapter.toApplicationData(c.item, bodyPreference)));
        } catch (err: any) {
            // Logged with enough to find the one malformed item directly (collection/folder/uids), since the
            // state-ordering comment above means this failure is now merely retried, not corrupting - but a
            // render that keeps failing every retry needs a real trace to fix, not another silent mystery.
            this.logger?.error(
                `Sync render failed for ${collectionClass} folderUid=${folderUid} itemUids=${upserts.map((c) => c.item.uid).join(",")}: ${err?.stack ?? err}`,
            );
            throw err;
        }

        const newKey = formatSyncKey({ generation: working.generation + 1, watermark: working.cursor.date, uid: working.cursor.uid });
        const saved: boolean = await this.saveState(stored, { loaded: held, ids: working.serverIds }, {
            mailboxUid: ctx.mailboxUid,
            deviceId: ctx.deviceId,
            folderUid,
            collectionClass,
            syncKey: newKey,
            cursorDate: working.cursor.date,
            cursorUid: working.cursor.uid,
            moveCursorDate: working.moveCursor.date,
            moveCursorUid: working.moveCursor.uid,
            echoes: Object.fromEntries(working.echoes),
            ...(working.recent ? { recent: Object.fromEntries(working.recent) } : {}),
            reconcileCursor: working.reconcileCursor,
            filterType: working.filterType ?? (null as any),
            previous: roundRecord(clientSyncKey, base, working, round.clientIds),
        });
        if (!saved) {
            return this.collectionResponse(collectionClass, folderUid, STATUS_INVALID_SYNC_KEY, undefined);
        }
        const commandElements: WbxmlElement[] = commands.map((c) =>
            c.kind === "Delete"
                ? element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", c.uid)])
                : element(WbxmlCodePage.AirSync, c.kind, [
                      textElement(WbxmlCodePage.AirSync, "ServerId", c.item.uid),
                      applicationData[upserts.indexOf(c)],
                  ]),
        );

        if (collectionClass === "Email" && upserts.length > 0) {
            const messageUids: string[] = upserts.map((c) => c.item.uid);
            await audit.record({
                action: AuditAction.MESSAGE_CONTENT_ACCESSED,
                mailboxUid: folder.mailboxUid,
                targetType: "Folder",
                targetUid: folderUid,
                details: { operation: "Sync", count: messageUids.length, messageUids },
            });
        }

        return this.collectionResponse(collectionClass, folderUid, "1", newKey, [
            ...(moreAvailable ? [element(WbxmlCodePage.AirSync, "MoreAvailable", [])] : []),
            ...(commandElements.length > 0 ? [element(WbxmlCodePage.AirSync, "Commands", commandElements)] : []),
            ...(responseEntries.length > 0 ? [element(WbxmlCodePage.AirSync, "Responses", responseEntries)] : []),
        ]);
    }

    /** `SyncKey 0`: (re)starts the collection with an empty item set. Per [MS-ASCMD] the response carries only the
     * new key; the next round reports every item as an `Add`. */
    private async startCollection(
        ctx: EasCommandContext,
        stored: (EasCollectionState & { version: number }) | undefined,
        folderUid: string,
        collectionClass: string,
        filterType: string | undefined,
    ): Promise<WbxmlElement> {
        const epoch = new Date(0);
        const newKey = formatSyncKey({ generation: 1, watermark: epoch });
        const saved: boolean = await this.saveState(stored, "restart", {
            mailboxUid: ctx.mailboxUid,
            deviceId: ctx.deviceId,
            folderUid,
            collectionClass,
            syncKey: newKey,
            cursorDate: epoch,
            cursorUid: "",
            moveCursorDate: new Date(Date.now() - MOVE_CURSOR_SLACK_MS),
            moveCursorUid: "",
            echoes: {},
            recent: {},
            reconcileCursor: "",
            // `null` (not `undefined`) so a restart without Options clears a FilterType recorded earlier on SQL too.
            filterType: filterType ?? (null as any),
            previous: undefined,
        });
        if (!saved) {
            return this.collectionResponse(collectionClass, folderUid, STATUS_SERVER_ERROR, undefined);
        }
        return this.collectionResponse(collectionClass, folderUid, "1", newKey);
    }

    /**
     * Writes the held set (`held.ids`, given the set `held.loaded` the round started from) and then creates or
     * updates the collection's state row. Returns `false` - after logging - when anything failed (including losing a
     * race for the row): the caller must then not hand out the new key. A `"restart"` empties the held set.
     *
     * **Chunk writes can't be atomic with the state row**, so before any chunk row is touched the state row is first
     * marked `chunked` with both its `SyncKey` and its previous round's key blanked (`invalidateBeforeChunkWrite()`).
     * If anything after that fails - including the final state write, and even when the device never sees this round's
     * Status 3 - no key matches the half-written chunks any more: the device's next `Sync` gets Status 3 and restarts
     * with `SyncKey 0`, which always removes every chunk row of the collection (whether or not the row says `chunked`,
     * so rows orphaned before this rule existed are cleared too). A collection converting from inline to chunked also
     * clears leftover chunk rows first, so an orphan can never collide with the unique `chunkIndex`.
     */
    private async saveState(
        stored: (EasCollectionState & { version: number }) | undefined,
        held: { loaded: HeldSet; ids: Set<string> } | "restart",
        values: Omit<EasCollectionState, "uid" | "version" | "dateCreated" | "dateModified" | "serverIds" | "chunked">,
    ): Promise<boolean> {
        try {
            let heldValues: { serverIds: string[]; chunked: boolean };
            let current: (EasCollectionState & { version: number }) | undefined = stored;
            if (held === "restart") {
                await clearHeldSet(values, this.chunkStore);
                heldValues = { serverIds: [], chunked: false };
            } else {
                const wasChunked: boolean = !!stored?.chunked;
                if (stored && (wasChunked || held.ids.size > INLINE_HELD_LIMIT)) {
                    current = await this.invalidateBeforeChunkWrite(stored);
                    if (!wasChunked) {
                        await clearHeldSet(values, this.chunkStore);
                    }
                }
                heldValues = await saveHeldSet(values, held.loaded, held.ids, wasChunked, this.chunkStore);
            }
            const row = { ...values, ...heldValues };
            if (current) {
                await this.collectionStateRepo!.update(
                    { ...row, uid: current.uid, version: current.version } as any,
                    asEntity(this.collectionStateRepo!, current),
                    { ignoreACL: true, skipPush: true },
                );
            } else {
                await this.collectionStateRepo!.create(new this.collectionStateClass(row), { ignoreACL: true, skipPush: true });
            }
            return true;
        } catch (err: any) {
            this.logger?.warn(`SyncCommand: failed to save sync state for folder ${values.folderUid}: ${err?.message}`);
            return false;
        }
    }

    /** Marks `stored` chunked with no acceptable `SyncKey` (current or previous) before its chunk rows are written - see
     * `saveState()`. Returns the updated row, whose version the final state write must carry. */
    private async invalidateBeforeChunkWrite(
        stored: EasCollectionState & { version: number },
    ): Promise<EasCollectionState & { version: number }> {
        return await this.collectionStateRepo!.update(
            {
                uid: stored.uid,
                version: stored.version,
                syncKey: "",
                ...(stored.previous ? { previous: { ...stored.previous, syncKey: "" } } : {}),
                serverIds: [],
                chunked: true,
            } as any,
            asEntity(this.collectionStateRepo!, stored),
            { ignoreACL: true, skipPush: true },
        );
    }

    private addResponseElement(clientId: string | undefined, serverId: string | undefined, status: string): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "Add", [
            ...(clientId ? [textElement(WbxmlCodePage.AirSync, "ClientId", clientId)] : []),
            ...(serverId ? [textElement(WbxmlCodePage.AirSync, "ServerId", serverId)] : []),
            textElement(WbxmlCodePage.AirSync, "Status", status),
        ]);
    }

    private statusResponseElement(kind: "Change" | "Delete", serverId: string, status: string): WbxmlElement {
        return element(WbxmlCodePage.AirSync, kind, [
            textElement(WbxmlCodePage.AirSync, "ServerId", serverId),
            textElement(WbxmlCodePage.AirSync, "Status", status),
        ]);
    }

    /** Remembers the `dateModified` the device's own write left on `item`, so the write isn't echoed back. */
    private noteWrite(round: CollectionRound, item: { uid: string; dateModified?: Date | string }): void {
        round.working.serverIds.add(item.uid);
        if (item.dateModified !== undefined) {
            round.working.echoes.set(item.uid, new Date(item.dateModified).toISOString());
        }
    }

    private async applyAdd(round: CollectionRound, el: WbxmlElement): Promise<WbxmlElement> {
        const { ctx, adapter, repo, folder } = round;
        const clientId = childText(el, "ClientId");
        const replayed: string | undefined = clientId ? round.retry?.clientIds.get(clientId) : undefined;
        if (clientId && replayed) {
            // The first attempt already created the item: answer with it, and treat its current state as the device's own
            // write so the replayed round doesn't send it back as a Change.
            const item = await repo.findOne(replayed, { ignoreACL: true });
            if (item) {
                this.noteWrite(round, item);
            }
            round.clientIds.set(clientId, replayed);
            return this.addResponseElement(clientId, replayed, "1");
        }
        const appData = findChild(el, "ApplicationData");
        if (!adapter.fromApplicationData || !appData) {
            return this.addResponseElement(clientId, undefined, "6");
        }
        // [MS-ASCMD] "Add (Sync)": a client can only add *draft* email.
        if (round.collectionClass === "Email" && folder.type !== FolderType.DRAFTS) {
            return this.addResponseElement(clientId, undefined, "6");
        }
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, folder.uid, ACLAction.CREATE))) {
            return this.addResponseElement(clientId, undefined, "6");
        }
        try {
            const mailbox = await round.getMailbox();
            const defaults = adapter.newEntityDefaults ? adapter.newEntityDefaults(mailbox) : {};
            const partial = await adapter.fromApplicationData(appData, undefined, mailbox);
            const created = await repo.create(
                { ...defaults, ...partial, mailboxUid: folder.mailboxUid, folderUid: folder.uid } as any,
                { ignoreACL: true },
            );
            this.noteWrite(round, created);
            if (clientId) {
                round.clientIds.set(clientId, created.uid);
            }
            return this.addResponseElement(clientId, created.uid, "1");
        } catch {
            // Status 6: "the client has sent a malformed or invalid item".
            return this.addResponseElement(clientId, undefined, "6");
        }
    }

    private async applyChange(round: CollectionRound, el: WbxmlElement): Promise<WbxmlElement | undefined> {
        const { ctx, adapter, repo, folder } = round;
        const serverId = childText(el, "ServerId");
        if (!serverId) {
            return undefined;
        }
        if (!adapter.fromApplicationData) {
            return this.statusResponseElement("Change", serverId, "6");
        }
        const existing = await repo.findOne(serverId, { ignoreACL: true });
        // An item outside this (READ-checked) collection is reported identically to "doesn't exist".
        if (!existing || existing.folderUid !== folder.uid) {
            return this.statusResponseElement("Change", serverId, "8");
        }
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, folder.uid, ACLAction.UPDATE))) {
            return this.statusResponseElement("Change", serverId, "6");
        }
        const appData = findChild(el, "ApplicationData");
        if (!appData) {
            return this.statusResponseElement("Change", serverId, "6");
        }
        try {
            const partial = await adapter.fromApplicationData(appData, existing, await round.getFolderMailbox());
            const updated = await repo.update({ uid: existing.uid, version: existing.version, ...partial }, asEntity(repo, existing), { ignoreACL: true });
            this.noteWrite(round, updated);
            return undefined;
        } catch (err: any) {
            if (err instanceof ApiError && err.code === ApiErrors.INVALID_OBJECT_VERSION) {
                return this.statusResponseElement("Change", serverId, "7");
            }
            return this.statusResponseElement("Change", serverId, "6");
        }
    }

    private async applyDelete(round: CollectionRound, el: WbxmlElement): Promise<WbxmlElement | undefined> {
        const { ctx, adapter, repo, folder } = round;
        const serverId = childText(el, "ServerId");
        if (!serverId) {
            return undefined;
        }
        const existing = await repo.findOne(serverId, { ignoreACL: true });
        if (!existing || existing.folderUid !== folder.uid) {
            // The retried round already deleted (or moved) this item - the device's retry is already satisfied.
            if (round.retry?.removedIds.has(serverId)) {
                round.working.serverIds.delete(serverId);
                return undefined;
            }
            return this.statusResponseElement("Delete", serverId, "8");
        }
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, folder.uid, ACLAction.DELETE))) {
            return this.statusResponseElement("Delete", serverId, "6");
        }
        // Like restapi's delete (409), never while a send of the message is in flight - a moved or deleted message could
        // miss its relay marker and be sent again.
        if (hasLiveSendLease(existing)) {
            return this.statusResponseElement("Delete", serverId, "6");
        }
        try {
            if (round.collectionClass === "Email" && round.deletesAsMoves && folder.type !== FolderType.DELETED_ITEMS) {
                const deletedItems: Folder & { uid: string } = await findOrCreateWellKnownFolder(
                    this.folderRepo!,
                    this.folderClass,
                    folder.mailboxUid,
                    FolderType.DELETED_ITEMS,
                    ctx.user,
                );
                // A move out of Outbox cancels the scheduled send (or is refused once the message was relayed).
                const plan: MessageMovePlan = planMessageMove(existing, folder.type, FolderType.DELETED_ITEMS);
                if (!plan.allowed) {
                    return this.statusResponseElement("Delete", serverId, "6");
                }
                await repo.update({ uid: existing.uid, version: existing.version, folderUid: deletedItems.uid, ...plan.patch }, asEntity(repo, existing), {
                    ignoreACL: true,
                    user: ctx.user,
                });
            } else {
                const stamp = adapter.beforeDelete ? adapter.beforeDelete(existing, await round.getFolderMailbox()) : undefined;
                if (stamp) {
                    await repo.update({ uid: existing.uid, version: existing.version, ...stamp }, asEntity(repo, existing), { ignoreACL: true });
                }
                await repo.delete(existing.uid, { ignoreACL: true });
            }
            if (round.collectionClass === "Email") {
                await round.audit.record({
                    action: AuditAction.MESSAGE_DELETE,
                    mailboxUid: existing.mailboxUid,
                    targetType: "Message",
                    targetUid: existing.uid,
                    details: {
                        subject: existing.subject,
                        folderUid: existing.folderUid,
                        movedToDeletedItems: round.deletesAsMoves && folder.type !== FolderType.DELETED_ITEMS,
                    },
                });
            }
            round.working.serverIds.delete(serverId);
            round.working.echoes.delete(serverId);
            return undefined;
        } catch {
            return this.statusResponseElement("Delete", serverId, "6");
        }
    }

    /** Builds one `<Collection>` response element. */
    private collectionResponse(
        collectionClass: string | undefined,
        folderUid: string | undefined,
        status: string,
        syncKey: string | undefined,
        extra: WbxmlElement[] = [],
    ): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "Collection", [
            ...(collectionClass ? [textElement(WbxmlCodePage.AirSync, "Class", collectionClass)] : []),
            ...(syncKey ? [textElement(WbxmlCodePage.AirSync, "SyncKey", syncKey)] : []),
            ...(folderUid ? [textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid)] : []),
            textElement(WbxmlCodePage.AirSync, "Status", status),
            ...extra,
        ]);
    }
}

/** MS-ASAIRSYNCBASE `Body.Type` values, richest-first, used to pick among several `BodyPreference` siblings a
 * device sent: `"2"` (HTML) over `"1"` (plain text) - matches `EmailSyncAdapter.resolveBodies()`'s own
 * HTML-over-plain-text preference. `"4"` (raw MIME) is deliberately not in this list: unlike `ItemOperations`
 * `Fetch` (which honors an explicit `Type 4` as the device's own direct request for raw source), a `Sync` page
 * renders many messages at once and MIME isn't a type `EmailSyncAdapter` ever produces inline. */
const BODY_PREFERENCE_TYPE_PRIORITY = ["2", "1"];

/** Parses a collection's `Options/BodyPreference` (MS-ASAIRSYNCBASE), or `undefined` when the device sent none -
 * the adapter then falls back to its own default rendering (`EmailSyncAdapter`'s short preview, unaffected). A
 * `Type`-only `BodyPreference` (no `TruncationSize`) is "no truncation wanted", not "send nothing".
 *
 * `BodyPreference` is repeatable - a real device (confirmed against a live Apple Mail capture) commonly sends
 * one per `Type` it can render (plain text, HTML, MIME) so the server can pick whichever it supports best, not
 * just one fixed type. `findChild()` only ever returned the first sibling in document order, which is not
 * necessarily the richest one on offer - picking a plain-text `BodyPreference` that happened to come first (its
 * own small `TruncationSize`, mismatched `Type`) over a later HTML one made the response not match what the
 * device actually asked for, which is exactly the "message cannot be downloaded" symptom a real device showed
 * with no further `ItemOperations Fetch` ever following the `Sync` that returned it. Preferring HTML over plain
 * text matches `EmailSyncAdapter.resolveBodies()`'s own existing type preference. */
function parseBodyPreference(optionsEl: WbxmlElement | undefined): SyncBodyPreference | undefined {
    const bodyPreferenceEls = optionsEl ? findChildren(optionsEl, "BodyPreference") : [];
    const bodyPreferenceEl = selectBestBodyPreference(bodyPreferenceEls);
    if (!bodyPreferenceEl) {
        return undefined;
    }
    const truncationSizeText = childText(bodyPreferenceEl, "TruncationSize");
    const truncationSize = truncationSizeText !== undefined ? Number(truncationSizeText) : undefined;
    return {
        type: childText(bodyPreferenceEl, "Type"),
        truncationSize: truncationSize !== undefined && Number.isFinite(truncationSize) ? truncationSize : undefined,
    };
}

/** Picks the richest `BodyPreference` among every sibling a device sent, in `BODY_PREFERENCE_TYPE_PRIORITY`
 * order - HTML over plain text, since that's the richer type this library can actually render (see
 * `EmailSyncAdapter`'s own HTML-over-plain-text preference). A `BodyPreference` with no `Type` at all, or a
 * `Type` outside that priority list, is only used when nothing better was offered, so a device's own ordering
 * is no longer load-bearing. */
function selectBestBodyPreference(bodyPreferenceEls: WbxmlElement[]): WbxmlElement | undefined {
    for (const wantedType of BODY_PREFERENCE_TYPE_PRIORITY) {
        const match = bodyPreferenceEls.find((el) => childText(el, "Type") === wantedType);
        if (match) {
            return match;
        }
    }
    return bodyPreferenceEls[0];
}
