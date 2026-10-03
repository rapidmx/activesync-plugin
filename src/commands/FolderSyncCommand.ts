///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import {
    type ChangeCursor,
    computeChanges,
    epochCursor,
    formatSyncKey,
    persistDeviceSyncState,
    resolveSyncKey,
} from "../EasSyncKeyUtils.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import { Folder, FolderType } from "@rapidmx/restapi";
const { Config, Init } = ObjectDecorators;

/** Maps this library's `FolderType` to the closest MS-ASCMD folder type code. Several of this app's types
 * collapse onto the spec's "default well-known folder" codes rather than distinguishing a default folder from
 * a second, user-created folder of the same content type (e.g. a second calendar also reports as `8`) - a
 * deliberate pragmatic-subset simplification, not an oversight; see `BaseFolderRoute`'s own precedent for
 * this library's general stance on this kind of gap. */
const FOLDER_TYPE_CODES: Record<FolderType, string> = {
    [FolderType.INBOX]: "2",
    [FolderType.DRAFTS]: "3",
    [FolderType.DELETED_ITEMS]: "4",
    [FolderType.SENT_ITEMS]: "5",
    [FolderType.OUTBOX]: "6",
    [FolderType.TASKS]: "7",
    [FolderType.CALENDAR]: "8",
    [FolderType.CONTACTS]: "9",
    [FolderType.NOTES]: "10",
    [FolderType.JUNK]: "12",
    // MS-ASCMD's FolderHierarchy Type enumeration has no dedicated "Archive" code - real Exchange either treats
    // Archive as a wholly separate mailbox (Online Archive, out of scope here) or, for an ordinary in-mailbox
    // Archive folder as this library models it, a Type 12 user-created folder is the closest fit. Same fallback
    // as USER/JUNK above, not a distinct case.
    [FolderType.ARCHIVE]: "12",
    [FolderType.USER]: "12",
};

/** EAS represents "no parent" (a top-level folder) as the literal string `"0"`, not an absent element. */
const ROOT_PARENT_ID = "0";

/** The (somewhat arbitrary, since `FolderSync` covers the whole mailbox's folder hierarchy rather than one
 * particular folder) key `DeviceSyncState.folderSyncKeys` is stored under for this cursor - distinct from any
 * real `Folder.uid`, which is exactly why using the mailbox's own uid here would be ambiguous. */
const FOLDER_HIERARCHY_CURSOR_KEY = "$foldersync";

/** Where the key issued before the current one is kept, so a client that never received the last response can retry
 * with it. */
const FOLDER_HIERARCHY_PREVIOUS_KEY = "$foldersyncPrevious";

/** [MS-ASCMD] FolderSync Status 9: the synchronization key is invalid or doesn't match - restart from `SyncKey 0`. */
const STATUS_INVALID_SYNC_KEY = "9";

/** Caps how many folder changes are enumerated per round - real mailboxes rarely have more than a few dozen
 * folders, so this is generous, not a real-world binding constraint; it exists so `computeChanges()`'s
 * `MoreAvailable` mechanism is exercised the same way it will be for `SyncCommand`'s much larger item
 * collections. */
const DEFAULT_WINDOW_SIZE = 512;

/** Safety bound on how many `windowSize` pages a `SyncKey "0"` request reads while returning the full hierarchy. */
const MAX_INITIAL_PAGES = 100;

/**
 * Handles EAS `FolderSync`: enumerates `Add`/`Update`/`Delete`s for the caller's mailbox's `Folder` hierarchy
 * since the device's last `FolderSync`, using the shared watermark-based cursor mechanism in
 * `EasSyncKeyUtils.ts` (scoped by `mailboxUid` over the `Folder` collection, rather than `folderUid` over a
 * per-folder item collection the way `SyncCommand` will be).
 *
 * **Keys**: an unknown `SyncKey` is answered with Status 9 ([MS-ASCMD] FolderSync: "synchronization key mismatch or
 * invalid synchronization key"; the client restarts from `0`). The key issued before the current one is still
 * accepted: the key itself encodes its cursor, so a retry simply recomputes that round's changes.
 *
 * `folderClass` is supplied by the Mongo/SQL concrete subclasses, following the exact one-line-per-backend
 * pattern used throughout this library's other routes/jobs.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class FolderSyncCommand<F extends Folder> implements EasCommandHandler {
    public readonly command = "FolderSync";

    protected abstract folderClass: any;

    @Config("mail:eas:foldersync_window_size", DEFAULT_WINDOW_SIZE)
    private windowSize: number = DEFAULT_WINDOW_SIZE;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private folderRepo?: RepoUtils<F>;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.folderRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const clientSyncKey: string | undefined = ctx.request ? childText(ctx.request, "SyncKey") : undefined;
        const storedSyncKey: string | undefined = ctx.deviceSyncState.folderSyncKeys?.[FOLDER_HIERARCHY_CURSOR_KEY];
        const previousSyncKey: string | undefined = ctx.deviceSyncState.folderSyncKeys?.[FOLDER_HIERARCHY_PREVIOUS_KEY];
        let resolution = resolveSyncKey(clientSyncKey, storedSyncKey);
        let retry = false;
        if (resolution.kind === "invalid" && previousSyncKey !== undefined) {
            resolution = resolveSyncKey(clientSyncKey, previousSyncKey);
            retry = resolution.kind === "valid";
        }

        if (resolution.kind === "invalid") {
            return element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                textElement(WbxmlCodePage.FolderHierarchy, "Status", STATUS_INVALID_SYNC_KEY),
            ]);
        }

        let generation: number;
        let adds: F[];
        let updates: F[] = [];
        let deletes: F[] = [];
        let cursor: ChangeCursor;
        if (resolution.kind === "initial") {
            // [MS-ASCMD] FolderSync: a SyncKey "0" request returns the entire folder hierarchy as Adds together
            // with the new key - there is no separate "empty handshake" round (unlike Sync), and FolderSync has no
            // MoreAvailable, so every page is read here rather than leaving the rest for a later round (where a
            // folder created before that round's cursor would wrongly be reported as an Update).
            generation = 0;
            adds = [];
            cursor = epochCursor();
            for (let page = 0; page < MAX_INITIAL_PAGES; page++) {
                const changes = await computeChanges(this.folderRepo, "mailboxUid", ctx.mailboxUid, cursor, this.windowSize);
                adds.push(...changes.adds, ...changes.changes);
                cursor = changes.cursor;
                if (!changes.moreAvailable) {
                    break;
                }
            }
        } else {
            generation = resolution.key.generation;
            const changes = await computeChanges(
                this.folderRepo,
                "mailboxUid",
                ctx.mailboxUid,
                { date: resolution.key.watermark, uid: resolution.key.uid ?? "" },
                this.windowSize,
            );
            adds = changes.adds;
            updates = changes.changes;
            deletes = changes.deletes;
            cursor = changes.cursor;
        }

        const newKey = formatSyncKey({ generation: generation + 1, watermark: cursor.date, uid: cursor.uid });
        // A retry keeps the previous key as it was; a normal round makes the key just consumed the previous one; a
        // restart forgets it.
        const previous: string | undefined = retry ? previousSyncKey : resolution.kind === "valid" ? clientSyncKey : undefined;
        await persistDeviceSyncState(ctx.deviceSyncState, ctx.deviceSyncStateRepo, (current) => {
            const { [FOLDER_HIERARCHY_PREVIOUS_KEY]: _dropped, ...rest } = current.folderSyncKeys ?? {};
            return {
                folderSyncKeys: {
                    ...rest,
                    [FOLDER_HIERARCHY_CURSOR_KEY]: newKey,
                    ...(previous !== undefined ? { [FOLDER_HIERARCHY_PREVIOUS_KEY]: previous } : {}),
                },
            };
        });

        const totalChanges: number = adds.length + updates.length + deletes.length;
        if (totalChanges === 0) {
            return element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                textElement(WbxmlCodePage.FolderHierarchy, "Status", "1"),
                textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", newKey),
            ]);
        }

        const changeElements: WbxmlElement[] = [
            ...adds.map((folder) => this.folderToChangeElement("Add", folder)),
            ...updates.map((folder) => this.folderToChangeElement("Update", folder)),
            ...deletes.map((folder) =>
                element(WbxmlCodePage.FolderHierarchy, "Delete", [
                    textElement(WbxmlCodePage.FolderHierarchy, "ServerId", folder.uid),
                ]),
            ),
        ];

        return element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
            textElement(WbxmlCodePage.FolderHierarchy, "Status", "1"),
            textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", newKey),
            element(WbxmlCodePage.FolderHierarchy, "Changes", [
                textElement(WbxmlCodePage.FolderHierarchy, "Count", String(totalChanges)),
                ...changeElements,
            ]),
        ]);
    }

    private folderToChangeElement(kind: "Add" | "Update", folder: F): WbxmlElement {
        return element(WbxmlCodePage.FolderHierarchy, kind, [
            textElement(WbxmlCodePage.FolderHierarchy, "ServerId", folder.uid),
            textElement(WbxmlCodePage.FolderHierarchy, "ParentId", folder.parentFolderUid ?? ROOT_PARENT_ID),
            textElement(WbxmlCodePage.FolderHierarchy, "DisplayName", folder.name),
            /* v8 ignore next -- unreachable via real data: FOLDER_TYPE_CODES has an entry for every FolderType
               enum value, so the `??` fallback only guards a future enum member added to one without the
               other; `folder.type` can never carry a value outside the enum. */
            textElement(WbxmlCodePage.FolderHierarchy, "Type", FOLDER_TYPE_CODES[folder.type] ?? FOLDER_TYPE_CODES[FolderType.USER]),
        ]);
    }
}
