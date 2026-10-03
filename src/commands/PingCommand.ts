///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createClient, type RedisClientType } from "redis";
import { ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { hasMailAccess, RecoverableRepoUtils } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import { compareCursor, cursorOf, isListableUid, scanAfter } from "../EasSyncKeyUtils.js";
import type { EasCollectionState } from "../models/EasCollectionState.js";
const { Config, Init, Inject } = ObjectDecorators;

/** MS-ASCMD `Ping` `Status` codes this pragmatic subset distinguishes - not the full enumeration the real
 * spec defines (e.g. it also has a code for "folder hierarchy changed"), matching this library's "pragmatic
 * subset, not full fidelity" precedent elsewhere. */
const STATUS_NO_CHANGES = "1";
const STATUS_CHANGES_FOUND = "2";
const STATUS_MISSING_PARAMETERS = "3";
const STATUS_TOO_MANY_FOLDERS = "6";

/** How many `ACLUtils.hasPermission()` checks run concurrently. */
const ACL_CHECK_CHUNK_SIZE = 25;

/** Rows read per folder when looking for changes a device hasn't synced yet - enough to see past a few of the
 * device's own writes (`echoes`); a full page is reported as a change regardless. */
const PENDING_CHANGE_SCAN_LIMIT = 5;

/** Most per-folder fallback scans (`scanAfter`) `pendingInClass` runs at once. */
const FALLBACK_SCAN_CHUNK_SIZE = 25;

/** Folder uids per batched `EasCollectionState` lookup, and folders per batched pending-change check. */
const STATE_LOOKUP_CHUNK = 500;

/** Rows per stream (live, soft-deleted) one batched pending-change check reads before falling back to per-folder scans. */
const PENDING_BATCH_ROW_LIMIT = 500;

/** The `(dateModified, uid)` stream order, as `scanAfter()` reads it. */
const PENDING_BATCH_SORT = JSON.stringify({ dateModified: "ASC", uid: "ASC" });

/** Binds one MS-ASCMD `Class` value to the entity class whose rows a `Ping` checks for pending changes. */
export interface PingCollectionBinding {
    entityClass: any;
}

type PingListener = (message: string, channel: string) => void;

/**
 * Handles EAS `Ping`: a long-poll HTTP request that blocks for up to `HeartbeatInterval` seconds waiting for a
 * change in any of the client-specified folders, then reports which (if any) actually changed. Every
 * `Message`/`CalendarEvent`/etc. mutation already publishes to the `folderUid` channels via
 * `BaseScopedChildRoute.notify()`/`RepoUtils`'s own push - `Ping` only needs a subscriber.
 *
 * Resource bounds:
 * - One shared Redis subscriber client per process (per Redis URL), lazily connected once. Each `Ping` attaches
 * its own listener to its channels and removes exactly that listener when it settles. A connect/subscribe
 * failure fails open (the `Ping` just waits out its heartbeat and reports no changes) and a failed connect is
 * forgotten so a later `Ping` retries it.
 * - At most one active `Ping` per (mailbox, device) per process: a newer one supersedes (answers Status 1) the
 * older one.
 * - The wait ends as soon as the HTTP response finishes (including a client abort).
 * - More than `mail:eas:ping_max_folders` folders is rejected with Status 6 before any ACL work, and the ACL
 * checks themselves run in bounded concurrent chunks.
 * - Without a `datastores:events` config the `Ping` still waits the full (clamped) heartbeat before answering
 * Status 1, so a device can't hot-loop against it.
 *
 * **Changes made before the `Ping` started**: a publish only reaches a subscriber that exists at that moment, so a
 * change landing between the device's last `Sync` and this `Ping`'s subscribe would otherwise go unnoticed until
 * the next change. Once subscribed (or right away, without Redis), each folder's stream is checked for a row after
 * the cursor its `EasCollectionState` recorded, and any folder with one is answered with Status 2 immediately. This
 * needs `collectionStateClass`/`collectionBindings` (set by `PingCommandMongo`/`PingCommandSQL`); a folder the
 * device never synced has no cursor and isn't checked.
 *
 * Requested folder uids are filtered down to only those the caller currently has `READ` on before subscribing -
 * without it a device could long-poll on any folder uid it happens to know (including one whose share was since
 * revoked) and learn from this channel when that other mailbox's data changes.
 *
 * @author Jean-Philippe Steinmetz
 */
export class PingCommand implements EasCommandHandler {
    /** Shared subscriber connections, keyed by Redis URL - each value resolves once that client is connected. */
    private static readonly subscribers: Map<string, Promise<RedisClientType>> = new Map();
    /** The cancel function of the currently active `Ping` for each (mailbox, device) pair. */
    private static readonly activePings: Map<string, () => void> = new Map();

    public readonly command = "Ping";

    // `null` (not the decorator's own literal default of `undefined`) is deliberate: `@Config()` throws at
    // injection time if neither a real value nor a non-`undefined` default is available, but a deployment
    // with no `datastores:events` block configured (Redis pub/sub not set up) is legitimate.
    @Config("datastores:events", null)
    private redisConfig: any;

    @Config("mail:eas:ping_min_heartbeat_seconds", 60)
    private minHeartbeatSeconds: number = 60;

    @Config("mail:eas:ping_max_heartbeat_seconds", 1740)
    private maxHeartbeatSeconds: number = 1740;

    @Config("mail:eas:ping_max_folders", 300)
    private maxFolders: number = 300;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** Roles `ACLUtils.hasPermission()` treats as always-permitted, which must never apply to another user's
     * mail - see `SyncCommand`'s identical field for the full rationale (restapi's own `MailAccessUtils.ts`). */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    /** Supplied by the Mongo/SQL subclasses; without them the pending-change check is skipped. */
    protected collectionStateClass?: any;
    protected collectionBindings: Record<string, PingCollectionBinding> = {};

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private collectionStateRepo?: RepoUtils<any>;
    private repos = new Map<string, RepoUtils<any>>();

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.collectionStateRepo && this.collectionStateClass) {
            this.collectionStateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.collectionStateClass.name, args: [this.collectionStateClass] });
        }
        if (!this.collectionStateClass) {
            return;
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
        }
    }

    /** Forgets all process-wide shared state (subscriber clients and active pings). Intended for tests. */
    public static resetSharedState(): void {
        PingCommand.subscribers.clear();
        PingCommand.activePings.clear();
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!ctx.request) {
            return this.statusResponse(STATUS_MISSING_PARAMETERS);
        }

        const foldersEl = findChild(ctx.request, "Folders");
        const requestedFolderUids: string[] = foldersEl
            ? findChildren(foldersEl, "Folder")
                  .map((folderEl) => childText(folderEl, "ServerId"))
                  .filter((uid): uid is string => !!uid)
            : [];
        if (requestedFolderUids.length === 0) {
            return this.statusResponse(STATUS_MISSING_PARAMETERS);
        }
        if (requestedFolderUids.length > this.maxFolders) {
            return element(WbxmlCodePage.Ping, "Ping", [
                textElement(WbxmlCodePage.Ping, "Status", STATUS_TOO_MANY_FOLDERS),
                textElement(WbxmlCodePage.Ping, "MaxFolders", String(this.maxFolders)),
            ]);
        }

        // Filtered down to the permitted subset rather than failing the whole request: `Ping`'s wire response
        // has no per-folder status to report a partial denial through.
        const folderUids: string[] = await this.filterPermitted(ctx, requestedFolderUids);
        if (folderUids.length === 0) {
            return this.statusResponse(STATUS_MISSING_PARAMETERS);
        }

        const requestedSeconds: number = Number(childText(ctx.request, "HeartbeatInterval") ?? this.minHeartbeatSeconds);
        const heartbeatSeconds: number = Math.min(
            Math.max(Number.isFinite(requestedSeconds) ? requestedSeconds : this.minHeartbeatSeconds, this.minHeartbeatSeconds),
            this.maxHeartbeatSeconds,
        );

        const changedFolderUids: string[] = await this.waitForChange(ctx, folderUids, heartbeatSeconds);
        if (changedFolderUids.length === 0) {
            return this.statusResponse(STATUS_NO_CHANGES);
        }

        return element(WbxmlCodePage.Ping, "Ping", [
            textElement(WbxmlCodePage.Ping, "Status", STATUS_CHANGES_FOUND),
            element(
                WbxmlCodePage.Ping,
                "Folders",
                changedFolderUids.map((uid) => textElement(WbxmlCodePage.Ping, "Folder", uid)),
            ),
        ]);
    }

    private statusResponse(status: string): WbxmlElement {
        return element(WbxmlCodePage.Ping, "Ping", [textElement(WbxmlCodePage.Ping, "Status", status)]);
    }

    /** Returns the subset of `folderUids` the caller has `READ` on, checking at most `ACL_CHECK_CHUNK_SIZE` at once. */
    private async filterPermitted(ctx: EasCommandContext, folderUids: string[]): Promise<string[]> {
        const result: string[] = [];
        for (let i = 0; i < folderUids.length; i += ACL_CHECK_CHUNK_SIZE) {
            const chunk = folderUids.slice(i, i + ACL_CHECK_CHUNK_SIZE);
            const permitted = await Promise.all(
                chunk.map((uid) => hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, uid, ACLAction.READ)),
            );
            result.push(...chunk.filter((_uid, j) => permitted[j]));
        }
        return result;
    }

    /**
     * The subset of `folderUids` whose change stream has a row the device hasn't synced yet (after its collection's
     * recorded cursor, other than the device's own writes). A failed lookup counts as "no pending change".
     *
     * Batched, so a `Ping` watching hundreds of folders costs a handful of queries rather than three per folder: every
     * folder's `EasCollectionState` is read in one `in(...)` query per `STATE_LOOKUP_CHUNK`, and each collection class's
     * folders are checked together (`pendingInClass()`); only a folder that batch can't decide is scanned on its own.
     */
    private async pendingChanges(ctx: EasCommandContext, folderUids: string[]): Promise<string[]> {
        if (!this.collectionStateRepo) {
            return [];
        }
        let states: Map<string, EasCollectionState>;
        try {
            states = await this.loadStates(ctx, folderUids);
        } catch {
            return [];
        }
        const byClass = new Map<string, EasCollectionState[]>();
        for (const folderUid of folderUids) {
            const state: EasCollectionState | undefined = states.get(folderUid);
            if (state && this.repos.has(state.collectionClass)) {
                byClass.set(state.collectionClass, [...(byClass.get(state.collectionClass) ?? []), state]);
            }
        }
        const changed = new Set<string>();
        for (const [collectionClass, classStates] of byClass) {
            for (let i = 0; i < classStates.length; i += STATE_LOOKUP_CHUNK) {
                const found: string[] = await this.pendingInClass(this.repos.get(collectionClass)!, classStates.slice(i, i + STATE_LOOKUP_CHUNK)).catch(
                    () => [],
                );
                found.forEach((uid) => changed.add(uid));
            }
        }
        return folderUids.filter((uid) => changed.has(uid));
    }

    /** Every requested folder's collection state for this device, keyed by folder uid - one query per chunk of plain
     * folder uids (exact-matched in memory), and one query per folder uid that can't be listed in `in(...)`. */
    private async loadStates(ctx: EasCommandContext, folderUids: string[]): Promise<Map<string, EasCollectionState>> {
        const wanted = new Set(folderUids);
        const states = new Map<string, EasCollectionState>();
        const keep = (rows: EasCollectionState[]): void => {
            for (const row of rows) {
                if (wanted.has(row.folderUid) && row.mailboxUid === ctx.mailboxUid && row.deviceId === ctx.deviceId && !states.has(row.folderUid)) {
                    states.set(row.folderUid, row);
                }
            }
        };
        const listable: string[] = folderUids.filter(isListableUid);
        for (let i = 0; i < listable.length; i += STATE_LOOKUP_CHUNK) {
            const chunk: string[] = listable.slice(i, i + STATE_LOOKUP_CHUNK);
            const limit: number = Math.min(chunk.length * 2, 1000);
            keep(
                await this.collectionStateRepo!.find(
                    { mailboxUid: ctx.mailboxUid, deviceId: ctx.deviceId, folderUid: `in(${chunk.join(",")})`, limit } as any,
                    { ignoreACL: true, limit },
                ),
            );
        }
        for (const folderUid of folderUids.filter((uid) => !isListableUid(uid))) {
            keep(await this.collectionStateRepo!.find({ mailboxUid: ctx.mailboxUid, deviceId: ctx.deviceId, folderUid } as any, { ignoreACL: true, limit: 1 }));
        }
        return states;
    }

    /**
     * The folders among `states` (all of one collection class, stored in `repo`) with a pending change. One pair of
     * queries (live and soft-deleted rows) reads, across all of them, the rows at or after the earliest cursor, in
     * stream order, up to `PENDING_BATCH_ROW_LIMIT`. When neither page is full, that is every row that could be pending
     * for any of the folders, so each folder is decided exactly in memory - the same rule as a per-folder `scanAfter()`.
     * When a page is full, a folder with a pending row among the rows read is still pending; any other folder is scanned
     * on its own, as before. A folder uid that can't be listed in `in(...)` is always scanned on its own.
     */
    private async pendingInClass(repo: RepoUtils<any>, states: EasCollectionState[]): Promise<string[]> {
        const cursorFor = (state: EasCollectionState) => ({ date: new Date(state.cursorDate), uid: state.cursorUid });
        const isPending = (state: EasCollectionState, rows: any[], complete: boolean): boolean | undefined => {
            const echoes: Record<string, string> = state.echoes ?? {};
            const after: any[] = rows.filter((row) => row.folderUid === state.folderUid && compareCursor(cursorOf(row), cursorFor(state)) > 0);
            if (after.length > PENDING_CHANGE_SCAN_LIMIT || after.some((row) => echoes[row.uid] !== new Date(row.dateModified).toISOString())) {
                return true;
            }
            return complete ? false : undefined;
        };

        const listed: EasCollectionState[] = states.filter((state) => isListableUid(state.folderUid));
        let rows: any[] = [];
        let complete = false;
        if (listed.length > 0) {
            const earliest: Date = new Date(Math.min(...listed.map((state) => new Date(state.cursorDate).getTime())));
            const query: any = {
                folderUid: `in(${listed.map((state) => state.folderUid).join(",")})`,
                dateModified: `gte(${earliest.toISOString()})`,
                sort: PENDING_BATCH_SORT,
                limit: PENDING_BATCH_ROW_LIMIT + 1,
            };
            const options: any = { ignoreACL: true, limit: PENDING_BATCH_ROW_LIMIT + 1 };
            const [live, deleted] = await Promise.all([repo.find(query, options), repo.find({ ...query, deleted: true }, options)]);
            rows = [...live, ...deleted];
            complete = live.length <= PENDING_BATCH_ROW_LIMIT && deleted.length <= PENDING_BATCH_ROW_LIMIT;
        }

        const decided: (boolean | undefined)[] = states.map((state) => (isListableUid(state.folderUid) ? isPending(state, rows, complete) : undefined));
        // Undecided folders fall back to their own scan, `FALLBACK_SCAN_CHUNK_SIZE` at a time rather than one by one.
        const undecided: number[] = decided.flatMap((pending, index) => (pending === undefined ? [index] : []));
        for (let i = 0; i < undecided.length; i += FALLBACK_SCAN_CHUNK_SIZE) {
            await Promise.all(
                undecided.slice(i, i + FALLBACK_SCAN_CHUNK_SIZE).map(async (index) => {
                    const state: EasCollectionState = states[index];
                    const scanned = await scanAfter<any>(repo, { folderUid: state.folderUid }, cursorFor(state), PENDING_CHANGE_SCAN_LIMIT);
                    decided[index] = isPending(state, scanned.rows, true) || scanned.more;
                }),
            );
        }
        return states.filter((_state, index) => decided[index]).map((state) => state.folderUid);
    }

    /** Returns the process-wide subscriber client for `url`, connecting it on first use. A failed connect is
     * evicted from the cache (and the client destroyed) so a later call retries. */
    private static getSubscriber(url: string): Promise<RedisClientType> {
        let pending = PingCommand.subscribers.get(url);
        if (!pending) {
            const client = createClient({ url }) as RedisClientType;
            // An unhandled `error` event would crash the process; the client reconnects on its own.
            client.on("error", () => undefined);
            const connecting: Promise<RedisClientType> = client.connect().then(() => client);
            connecting.catch(() => {
                if (PingCommand.subscribers.get(url) === connecting) {
                    PingCommand.subscribers.delete(url);
                }
                try {
                    client.destroy();
                } catch {
                    // ignored
                }
            });
            PingCommand.subscribers.set(url, connecting);
            pending = connecting;
        }
        return pending;
    }

    /** Waits up to `timeoutSeconds` for a publish on any of `folderUids`, resolving with the channel that changed,
     * or `[]` on timeout, supersede by a newer `Ping` from the same device, request close, or Redis being
     * unavailable (in which case the full heartbeat is still waited). */
    private waitForChange(ctx: EasCommandContext, folderUids: string[], timeoutSeconds: number): Promise<string[]> {
        const key: string = JSON.stringify([ctx.mailboxUid, ctx.deviceId]);
        const redisUrl: string | undefined = this.redisConfig ? this.redisConfig.url : undefined;

        return new Promise<string[]>((resolve) => {
            let settled = false;
            let unsubscribe: (() => Promise<void>) | undefined;

            const finish = (changed: string[]): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (PingCommand.activePings.get(key) === cancel) {
                    PingCommand.activePings.delete(key);
                }
                if (unsubscribe) {
                    void unsubscribe();
                }
                resolve(changed);
            };
            const cancel = (): void => finish([]);
            const checkPending = (): void => {
                void this.pendingChanges(ctx, folderUids).then((changed) => {
                    if (changed.length > 0) {
                        finish(changed);
                    }
                });
            };

            PingCommand.activePings.get(key)?.();
            PingCommand.activePings.set(key, cancel);
            const timer = setTimeout(cancel, timeoutSeconds * 1000);
            ctx.res?.onFinish(cancel);

            if (redisUrl === undefined) {
                checkPending();
                return;
            }

            const listener: PingListener = (_message, channel) => finish([channel]);
            PingCommand.getSubscriber(redisUrl)
                .then(async (client) => {
                    if (settled) {
                        return;
                    }
                    const release = (): Promise<void> => client.unsubscribe(folderUids, listener).catch(() => undefined);
                    try {
                        await client.subscribe(folderUids, listener);
                    } catch {
                        // Fail open: keep waiting out the heartbeat, just without notifications.
                    }
                    if (settled) {
                        // Settled while the subscribe was in flight - `finish()` had nothing to release yet.
                        await release();
                    } else {
                        unsubscribe = release;
                        // Subscribed: every later change is published to the listener, so this covers the ones before.
                        checkPending();
                    }
                })
                .catch(() => {
                    // Connect failed - fail open, the timer/cancel still answers Status 1.
                    checkPending();
                });
        });
    }
}
