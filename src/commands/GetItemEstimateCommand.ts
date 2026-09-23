///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { type Folder, hasMailAccess, RecoverableRepoUtils } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { classForFolderType, enumerateCollection, filterPredicate, workingStateFromRow } from "../EasCollectionSync.js";
import { loadHeldSet } from "../EasCollectionStore.js";
import { MAX_SYNC_COLLECTIONS } from "./SyncCommand.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { EasCollectionState } from "../models/EasCollectionState.js";
const { Config, Init, Inject } = ObjectDecorators;

/** Caps how many changes are enumerated (and therefore counted) per collection - a real estimate, not a precise
 * unbounded count; a folder with more pending changes than this reports exactly this many. */
const DEFAULT_MAX_COUNT = 512;

/** Rows read from the out-of-folder stream while estimating (mirrors `SyncCommand`). */
const MOVE_SCAN_LIMIT = 1000;

/** Held ids reconciled against the store while estimating (mirrors `SyncCommand`). */
const RECONCILE_LIMIT = 100;

/** Binds one MS-ASCMD `Class` value to the concrete entity class this command counts against. Supplied by the
 * Mongo/SQL concrete subclasses. */
export interface EstimateCollectionBinding {
    entityClass: any;
}

/**
 * Handles EAS `GetItemEstimate`: reports, per requested `<Collection>`, an estimated count of the
 * `Add`/`Change`/`Delete`s a subsequent `Sync` of that collection would return - read-only, it never issues or
 * consumes a `SyncKey` itself.
 *
 * The modern (14.0+) request/response reuses `WbxmlCodePage.AirSync`'s own `Collections`/`Collection`/`Class`/
 * `CollectionId`/`SyncKey` via `SWITCH_PAGE` rather than this page's own legacy (`Folders`/`Folder`/`FolderId`) shape.
 *
 * The collection's `EasCollectionState` (the same per-device row `SyncCommand` keeps) decides the estimate: a
 * `SyncKey` of `"0"` reports the folder's total live item count (what the first `Sync` would `Add`); the
 * collection's current `SyncKey` runs `SyncCommand`'s own enumeration as a dry run (nothing persisted), capped at
 * `mail:eas:item_estimate_max_count`; any other key is Status 2. A request without `Class` falls back to the class
 * remembered for the collection, then to the folder's type.
 *
 * **Bounded like `Sync`**: at most `MAX_SYNC_COLLECTIONS` collections per request (more is a single Status 2), a
 * `CollectionId` repeated within one request is estimated once, and a `SyncKey 0` count is capped at the same maximum.
 *
 * **ACL-checked like `Sync`**: `READ` on the client-supplied `CollectionId` is required before counting anything;
 * a denied folder is reported identically to an unrecognized collection (`Status 2`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class GetItemEstimateCommand implements EasCommandHandler {
    public readonly command = "GetItemEstimate";

    protected abstract collectionBindings: Record<string, EstimateCollectionBinding>;
    protected abstract folderClass: any;
    protected abstract collectionStateClass: any;
    protected abstract collectionChunkClass: any;

    @Config("mail:eas:item_estimate_max_count", DEFAULT_MAX_COUNT)
    private maxCount: number = DEFAULT_MAX_COUNT;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** Roles `ACLUtils.hasPermission()` treats as always-permitted, which must never apply to another user's
     * mail - see `SyncCommand`'s identical field for the full rationale (restapi's own `MailAccessUtils.ts`). */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    private repos = new Map<string, RepoUtils<any>>();
    private folderRepo?: RepoUtils<any>;
    private collectionStateRepo?: RepoUtils<any>;
    private collectionChunkRepo?: RepoUtils<any>;

    @Init
    public async init(): Promise<void> {
        this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
        this.collectionStateRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.collectionStateClass.name,
            args: [this.collectionStateClass],
        });
        this.collectionChunkRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.collectionChunkClass.name,
            args: [this.collectionChunkClass],
        });
        for (const [collectionClass, binding] of Object.entries(this.collectionBindings)) {
            this.repos.set(
                collectionClass,
                await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                    name: binding.entityClass.name,
                    args: [binding.entityClass],
                }),
            );
        }
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.aclUtils || !this.folderRepo || !this.collectionStateRepo || !this.collectionChunkRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const collections = ctx.request ? findChild(ctx.request, "Collections") : undefined;
        const collectionEls = collections ? findChildren(collections, "Collection") : [];
        if (collectionEls.length === 0 || collectionEls.length > MAX_SYNC_COLLECTIONS) {
            return element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", [this.statusResponse("2")]);
        }

        const responses: WbxmlElement[] = [];
        const seen = new Set<string>();
        for (const collectionEl of collectionEls) {
            const folderUid: string | undefined = childText(collectionEl, "CollectionId");
            if (folderUid !== undefined) {
                if (seen.has(folderUid)) {
                    continue;
                }
                seen.add(folderUid);
            }
            responses.push(await this.estimateCollection(ctx, collectionEl));
        }

        return element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", responses);
    }

    private statusResponse(status: string, extra: WbxmlElement[] = []): WbxmlElement {
        return element(WbxmlCodePage.ItemEstimate, "Response", [textElement(WbxmlCodePage.ItemEstimate, "Status", status), ...extra]);
    }

    private async estimateCollection(ctx: EasCommandContext, collectionEl: WbxmlElement): Promise<WbxmlElement> {
        const requestedClass: string | undefined = childText(collectionEl, "Class");
        const folderUid: string | undefined = childText(collectionEl, "CollectionId");
        const clientSyncKey: string | undefined = childText(collectionEl, "SyncKey");

        // Never count against a folder the caller can't even read - see this class's own doc comment.
        if (!folderUid || !(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, folderUid, ACLAction.READ))) {
            return this.statusResponse("2");
        }
        const folder: (Folder & { uid: string }) | undefined = await this.folderRepo!.findOne(folderUid, { ignoreACL: true });
        if (!folder) {
            return this.statusResponse("2");
        }
        const stored: EasCollectionState | undefined = (
            await this.collectionStateRepo!.find({ mailboxUid: ctx.mailboxUid, deviceId: ctx.deviceId, folderUid } as any, {
                ignoreACL: true,
                limit: 1,
            })
        )[0];
        const collectionClass: string = requestedClass ?? stored?.collectionClass ?? classForFolderType(folder.type);
        const repo = this.repos.get(collectionClass);
        if (!repo) {
            return this.statusResponse("2");
        }

        let count: number;
        if (!clientSyncKey || clientSyncKey === "0") {
            // Every live item would be an Add on the device's first real Sync round.
            count = Math.min(await repo.count({ folderUid } as any, { ignoreACL: true }), this.maxCount);
        } else if (stored && clientSyncKey === stored.syncKey) {
            const working = workingStateFromRow(stored, (await loadHeldSet(stored, { repo: this.collectionChunkRepo!, chunkClass: this.collectionChunkClass })).ids);
            const { commands } = await enumerateCollection(working, {
                repo,
                folderUid,
                folderMailboxUid: folder.mailboxUid,
                windowSize: this.maxCount,
                moveScanLimit: MOVE_SCAN_LIMIT,
                reconcileLimit: RECONCILE_LIMIT,
                include: filterPredicate(collectionClass, working.filterType),
            });
            count = commands.length;
        } else {
            return this.statusResponse("2", [this.collectionElement(collectionClass, folderUid, undefined)]);
        }

        return this.statusResponse("1", [this.collectionElement(collectionClass, folderUid, count)]);
    }

    private collectionElement(collectionClass: string, folderUid: string, estimate: number | undefined): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "Collection", [
            textElement(WbxmlCodePage.AirSync, "Class", collectionClass),
            textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid),
            ...(estimate !== undefined ? [textElement(WbxmlCodePage.ItemEstimate, "Estimate", String(estimate))] : []),
        ]);
    }
}
