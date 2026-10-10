///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { simpleParser } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ModelUtils, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import {
    AuditAction,
    AuditLogUtils,
    asEntity,
    BlobStore,
    boundIndexedValue,
    hasMailAccess,
    RecoverableRepoUtils,
    refreshFolderCounts,
    type Attachment,
    type Folder,
    type FolderType,
    type Message,
} from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, opaqueElement, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { decodeConversationId } from "../adapters/EmailSyncAdapter.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import { hasLiveSendLease, type MessageMovePlan, planMessageMove } from "../MessageMoveRules.js";
import { truncateUtf8 } from "../MimeHeaderUtils.js";
import { EasAuditLog } from "../EasAuditLog.js";
import { EasLiveUpdates } from "../EasLiveUpdates.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Caps how many messages `emptyFolderContents`/`moveConversation` process per backing `find()`/delete-batch
 * round - keeps memory bounded and, for `emptyFolderContents`, lets an arbitrarily large folder still be fully
 * emptied via repeated batches rather than one unbounded query. */
const DEFAULT_BATCH_SIZE = 500;

/** Default cap on the combined size of the bodies/attachments one `ItemOperations` response embeds. */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** [MS-ASCMD] ItemOperations Status 11: the requested data size is too large. */
const STATUS_TOO_LARGE = "11";

/** [MS-ASCMD] ItemOperations Status 3: server error. */
const STATUS_SERVER_ERROR = "3";

/** [MS-ASCMD] ItemOperations Status 17: the operation completed partially. */
const STATUS_PARTIAL = "17";

/** Most batches (of `mail:eas:itemoperations_batch_size` messages) one `EmptyFolderContents` deletes per request. */
export const MAX_EMPTY_FOLDER_BATCHES = 20;

/** One `Fetch` response element and the content bytes it embeds (counted against the response cap). */
interface FetchResult {
    element: WbxmlElement;
    bytes: number;
}

/**
 * Handles EAS `ItemOperations`: `Fetch` (a `Message`'s full body or an `Attachment`'s binary content, by the
 * same `ServerId`/uid this library already exposes elsewhere) and `EmptyFolderContents`.
 *
 * Per the published [MS-ASCMD] `ItemOperations` request schema (confirmed directly, not assumed), the command
 * is a strict choice of exactly three operations - `Fetch` (unbounded), `EmptyFolderContents`, and `Move` -
 * with no fourth "write a new item" capability anywhere in it; `Store` is a required *child* of `Fetch`
 * (`"Mailbox"` or `"DocumentLibrary"`, the same store-selector role it plays in `SearchCommand`), not a
 * separate write/upload command as its name might suggest.
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD `ItemOperations` semantics**:
 * - `Move` moves an entire *conversation* (by `ConversationId`, opaque binary - see `EmailSyncAdapter`'s
 * `encodeConversationId`/`decodeConversationId`) to a destination folder - unrelated to the standalone
 * `MoveItems` command's per-message `SrcFldId`/`SrcMsgId`/`DstFldId` shape. Every `Message` sharing the
 * decoded `conversationId` across the whole mailbox (not just one folder) that the caller has `UPDATE` on is
 * relocated to `DstFldId`; one lacking permission is silently skipped rather than failing the whole move (a
 * conversation can legitimately span folders the caller doesn't control, e.g. a shared mailbox's Inbox). The
 * `ConversationId` is looked up bounded and exact-matched in memory (it derives from sender-controlled headers), and
 * each message's move follows `MessageMoveRules.planMessageMove` (never into Outbox, into Drafts only for drafts, out of
 * Outbox cancels the scheduled send) - a refused message counts as failed. An
 * optional `MoveAlways` (a hint to keep auto-moving future messages in this conversation) is accepted but not
 * acted on - this library's `MailFilterRule` has no conversation-scoped condition to key an ongoing rule off
 * of, a documented simplification, not silent data loss (the move itself still happens).
 * - `Store: "DocumentLibrary"` is rejected per-`Fetch` - matches `SearchCommand`'s own GAL-only scope decision;
 * this library has no document-library model.
 * - A `Fetch` failure (not found, no permission, malformed) aborts the whole request via an HTTP-level error
 * rather than an embedded per-`Fetch` `Status` code the way `Sync`/`MoveItems`/`ResolveRecipients` report
 * their own per-item failures - a deliberate, documented simplification carried over unchanged from this
 * command's original single-`Fetch` design, not a new gap introduced by adding multi-`Fetch` support.
 * - Only the "inline" delivery method is used (content embedded directly in the WBXML response) - the real
 * spec's "multipart" alternative (WBXML as one part, binary content as a separate part) is not implemented;
 * the combined size of the bodies/attachments embedded in one response is capped at
 * `mail:eas:itemoperations_max_response_bytes` (default 64 MB) - a Fetch that would exceed it gets Status 11
 * ("data too large") instead of content. Attachment access is checked against the owning message's *current*
 * folder (`Attachment.folderUid` is not updated when a message moves).
 * - `Options/BodyPreference`'s `Type`/`TruncationSize` are honored for a `Message` body fetch (plain text,
 * HTML, or - `Type 4` - the raw MIME source verbatim); byte-range fetching (`Range`) is not implemented.
 * - `EmptyFolderContents`'s `DeleteSubFolders` option is rejected outright rather than silently ignored -
 * recursive subfolder deletion is out of scope for this pragmatic subset; emptying a single folder's own
 * `Message`s is the common case this implements.
 *
 * **Bulk operations are bounded and per item**: `EmptyFolderContents` deletes at most `MAX_EMPTY_FOLDER_BATCHES`
 * batches per request, and `Move` at most one batch; a message that fails to delete or move (e.g. a concurrent
 * edit's version conflict) is skipped rather than failing the request, and the operation then reports Status 17
 * (partial success) - or Status 3 when nothing at all succeeded - so the client can retry for the rest.
 * `EmptyFolderContents` skips (as failed) a message whose send is in flight (`MessageMoveRules.hasLiveSendLease`).
 *
 * **Audit**: in a mailbox the caller doesn't own (restapi's `isNonOwnerAccess()` - an administrator or a delegate), a
 * `Fetch` that returns a body or an attachment records one `MESSAGE_CONTENT_ACCESSED` entry per item, and
 * `EmptyFolderContents` records one `MESSAGE_DELETE` entry per delete batch, listing the deleted message uids
 * (`EasAuditLog`).
 *
 * Every message `EmptyFolderContents` deletes or `Move` moves is published to an open web client (`EasLiveUpdates`),
 * and the affected folders' counts are refreshed, as restapi's own message writes do.
 *
 * `folderClass`/`messageClass`/`attachmentClass`/`mailboxClass`/`auditLogClass` are supplied by the Mongo/SQL concrete
 * subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ItemOperationsCommand implements EasCommandHandler {
    public readonly command = "ItemOperations";

    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;
    protected abstract mailboxClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Config()
    private config?: any;

    @Logger
    private logger: any;

    private folderRepo?: RepoUtils<any>;
    private mailboxRepo?: RepoUtils<any>;
    private messageRepo?: RecoverableRepoUtils<any>;
    private attachmentRepo?: RepoUtils<any>;
    private auditLogRepo?: RepoUtils<any>;
    private auditLogUtils?: AuditLogUtils;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    @Config("mail:eas:itemoperations_max_fetch", 25)
    private maxFetchesPerRequest: number = 25;

    @Config("mail:eas:itemoperations_max_response_bytes", DEFAULT_MAX_RESPONSE_BYTES)
    private maxResponseBytes: number = DEFAULT_MAX_RESPONSE_BYTES;

    @Config("mail:eas:itemoperations_batch_size", DEFAULT_BATCH_SIZE)
    private batchSize: number = DEFAULT_BATCH_SIZE;

    /** Roles `ACLUtils.hasPermission()` treats as always-permitted, which must never apply to another user's
     * mail - see `SyncCommand`'s identical field for the full rationale (restapi's own `MailAccessUtils.ts`). */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RecoverableRepoUtils, { name: this.messageClass.name, args: [this.messageClass] });
        }
        if (!this.attachmentRepo && this.attachmentClass) {
            this.attachmentRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.attachmentClass.name, args: [this.attachmentClass] });
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.folderRepo || !this.messageRepo || !this.attachmentRepo || !this.mailboxRepo || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const fetchEls = ctx.request ? findChildren(ctx.request, "Fetch") : [];
        const emptyEl = ctx.request ? findChild(ctx.request, "EmptyFolderContents") : undefined;
        const moveEl = ctx.request ? findChild(ctx.request, "Move") : undefined;
        if (fetchEls.length === 0 && !emptyEl && !moveEl) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        // Each Fetch's content (a full message body or a whole attachment) is buffered in memory and assumed
        // to individually fit comfortably (see this class's own doc comment) - with no cap on the *count* of
        // Fetches, a single request could still force many such buffers to be built and held at once (even
        // repeated fetches of the caller's own single large item), amplifying memory/IO cost far past what one
        // real device round-trip needs. Rejected outright rather than silently truncated, matching this
        // command's own precedent for `DeleteSubFolders`/`DocumentLibrary`.
        if (fetchEls.length > this.maxFetchesPerRequest) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `ItemOperations supports at most ${this.maxFetchesPerRequest} Fetch elements per request.`);
        }

        const audit = new EasAuditLog(
            { auditLogUtils: this.auditLogUtils!, mailboxRepo: this.mailboxRepo, logger: this.logger },
            ctx,
            this.command,
        );
        const responseChildren: WbxmlElement[] = [];
        // Every fetched body/attachment is embedded inline, so their combined size bounds the response. A Fetch
        // that would push it past `maxResponseBytes` is answered with Status 11 ("data too large") instead of content.
        let remainingBytes: number = this.maxResponseBytes;
        for (const fetchEl of fetchEls) {
            const store = childText(fetchEl, "Store");
            if (store === "DocumentLibrary") {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "DocumentLibrary fetches are not supported.");
            }
            const fileReference: string | undefined = childText(fetchEl, "FileReference");
            const serverId: string | undefined = childText(fetchEl, "ServerId");
            const optionsEl = findChild(fetchEl, "Options");
            const fetched = fileReference
                ? await this.fetchAttachment(ctx, audit, fileReference, remainingBytes)
                : await this.fetchMessage(ctx, audit, serverId, optionsEl, remainingBytes);
            remainingBytes -= fetched.bytes;
            responseChildren.push(fetched.element);
        }
        if (emptyEl) {
            responseChildren.push(await this.emptyFolderContents(ctx, audit, emptyEl));
        }
        if (moveEl) {
            responseChildren.push(await this.moveConversation(ctx, moveEl));
        }

        return element(WbxmlCodePage.ItemOperations, "ItemOperations", [
            textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
            element(WbxmlCodePage.ItemOperations, "Response", responseChildren),
        ]);
    }

    private async fetchMessage(
        ctx: EasCommandContext,
        audit: EasAuditLog,
        serverId: string | undefined,
        optionsEl: WbxmlElement | undefined,
        remainingBytes: number,
    ): Promise<FetchResult> {
        if (!serverId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Fetch requires either a ServerId or a FileReference.");
        }
        const message: Message | undefined = await this.messageRepo!.findOne(serverId, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, message.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        // `BodyPreference` is repeatable (MS-ASAIRSYNCBASE) - a device may list several `Type`s it can render,
        // same as `SyncCommand.parseBodyPreference()`'s own identical fix. `findChild()` only ever returned the
        // first sibling, which is not necessarily the one actually wanted. `"4"` (raw MIME) is checked first
        // here, unlike `Sync`'s own priority list, since this method already treats an explicit `Type 4` as the
        // device's own direct ask for raw source (see the `requestedType === "4"` branch below).
        const bodyPreferenceEls = optionsEl ? findChildren(optionsEl, "BodyPreference") : [];
        const bodyPreferenceEl =
            bodyPreferenceEls.find((el) => childText(el, "Type") === "4") ??
            bodyPreferenceEls.find((el) => childText(el, "Type") === "2") ??
            bodyPreferenceEls.find((el) => childText(el, "Type") === "1") ??
            bodyPreferenceEls[0];
        const requestedType = bodyPreferenceEl ? childText(bodyPreferenceEl, "Type") : undefined;
        const truncationSizeText = bodyPreferenceEl ? childText(bodyPreferenceEl, "TruncationSize") : undefined;
        const truncationSize = truncationSizeText !== undefined ? Number(truncationSizeText) : undefined;

        // Prefer the already-sanitized HTML body (script/active-content stripped by ScanPipeline at
        // ingestion/send time) over re-deriving anything from the raw MIME - the same preference
        // `Message.sanitizedHtmlBlobKey`'s own doc comment describes for any renderer. `Type 4` (MIME) is an
        // explicit client request for the verbatim raw source instead, honored regardless of that preference.
        let bodyType = "1";
        let bodyText: string;
        if (requestedType === "4") {
            bodyType = "4";
            bodyText = (await this.blobStore!.get(message.bodyBlobKey)).toString("utf-8");
        } else if (message.sanitizedHtmlBlobKey) {
            bodyType = "2";
            bodyText = (await this.blobStore!.get(message.sanitizedHtmlBlobKey)).toString("utf-8");
        } else {
            const raw = await this.blobStore!.get(message.bodyBlobKey);
            const parsed = await simpleParser(raw);
            bodyText = parsed.text ?? "";
        }

        // Per MS-ASAIRSYNCBASE, EstimatedDataSize reports the body's size BEFORE any truncation was applied
        // (so the client knows how much more content exists beyond what it received) - captured here, before
        // truncateUtf8() below reassigns bodyText to the shorter value.
        const estimatedDataSize = Buffer.byteLength(bodyText, "utf8");

        let truncated = false;
        if (truncationSize !== undefined && Number.isFinite(truncationSize) && estimatedDataSize > truncationSize) {
            bodyText = truncateUtf8(bodyText, truncationSize);
            truncated = true;
        }

        const bytes = Buffer.byteLength(bodyText, "utf8");
        if (bytes > remainingBytes) {
            return {
                element: element(WbxmlCodePage.ItemOperations, "Fetch", [
                    textElement(WbxmlCodePage.ItemOperations, "Status", STATUS_TOO_LARGE),
                    textElement(WbxmlCodePage.AirSync, "ServerId", serverId),
                ]),
                bytes: 0,
            };
        }

        await audit.record({
            action: AuditAction.MESSAGE_CONTENT_ACCESSED,
            mailboxUid: message.mailboxUid,
            targetType: "Message",
            targetUid: (message as any).uid,
            details: { subject: message.subject, folderUid: message.folderUid, bodyType },
        });

        return {
            element: element(WbxmlCodePage.ItemOperations, "Fetch", [
                textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
                textElement(WbxmlCodePage.AirSync, "Class", "Email"),
                textElement(WbxmlCodePage.AirSync, "CollectionId", message.folderUid),
                textElement(WbxmlCodePage.AirSync, "ServerId", serverId),
                element(WbxmlCodePage.ItemOperations, "Properties", [
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", bodyType),
                        textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(estimatedDataSize)),
                        textElement(WbxmlCodePage.AirSyncBase, "Truncated", truncated ? "1" : "0"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", bodyText),
                    ]),
                ]),
            ]),
            bytes,
        };
    }

    private async emptyFolderContents(ctx: EasCommandContext, audit: EasAuditLog, emptyEl: WbxmlElement): Promise<WbxmlElement> {
        // Reuses AirSync's own `CollectionId` (the same tag `Sync`/`Fetch` responses already reference a
        // folder by) rather than a page-specific tag - `WbxmlCodePage.ItemOperations` has no `FolderId` token
        // of its own at all, confirmed against its own tag table.
        const requestedFolderUid = childText(emptyEl, "CollectionId");
        if (!requestedFolderUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "EmptyFolderContents requires a CollectionId.");
        }
        const optionsEl = findChild(emptyEl, "Options");
        if (optionsEl && findChild(optionsEl, "DeleteSubFolders")) {
            // Documented gap, not silently ignored - see this class's own doc comment.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "DeleteSubFolders is not supported.");
        }
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, requestedFolderUid, ACLAction.DELETE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        // The batch query below uses the stored folder's own uid, never the client's string, which a query parser
        // could otherwise read as an operator (`ne(x)`) and match every other folder's messages with.
        const folder: Folder | undefined = await this.folderRepo!.findOne(requestedFolderUid, { ignoreACL: true });
        if (!folder) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const folderUid: string = (folder as any).uid;

        // Processed in bounded batches rather than one unbounded `find()` - a folder with a very large number
        // of messages would otherwise force the whole set into memory at once. Deletes within a batch still run
        // sequentially, not via `Promise.all` - the SQL backend (`better-sqlite3`) shares one connection per
        // request and each `delete()` opens its own transaction, so concurrent deletes fail outright with
        // "cannot start a transaction within a transaction" (confirmed against real SQL test failures, not
        // theoretical). Looping (rather than a single pass) still empties the folder completely, however large -
        // a deleted row no longer matches this same `find()` (soft-deleted rows are excluded from an ordinary
        // query by default), so the loop always terminates once truly empty.
        //
        // Bounded per request (`MAX_EMPTY_FOLDER_BATCHES`), and a message that fails to delete is remembered and skipped:
        // a batch in which nothing new could be deleted ends the loop instead of spinning on the same failing rows.
        const failed = new Set<string>();
        let deleted = 0;
        let complete = false;
        for (let round = 0; round < MAX_EMPTY_FOLDER_BATCHES; round++) {
            const batch = await this.messageRepo!.find({ folderUid, limit: this.batchSize } as any, {
                ignoreACL: true,
                limit: this.batchSize,
            });
            const pending = batch.filter((message: any) => !failed.has(message.uid));
            if (pending.length === 0) {
                complete = batch.length === 0;
                break;
            }
            const deletedUids: string[] = [];
            for (const message of pending) {
                // A message whose send is in flight is skipped, as restapi's delete refuses it (409).
                if (hasLiveSendLease(message)) {
                    failed.add(message.uid);
                    continue;
                }
                try {
                    await this.messageRepo!.delete(message.uid, { ignoreACL: true, user: ctx.user });
                    deletedUids.push(message.uid);
                    new EasLiveUpdates(this.notificationUtils).deleted(folderUid, this.messageClass.name, message.uid);
                } catch {
                    failed.add(message.uid);
                }
            }
            deleted += deletedUids.length;
            if (deletedUids.length > 0) {
                // One entry per batch (at most `batchSize` uids), not one per message: emptying a large folder would
                // otherwise write thousands of rows for one request.
                await audit.record({
                    action: AuditAction.MESSAGE_DELETE,
                    mailboxUid: folder.mailboxUid,
                    targetType: "Folder",
                    targetUid: folderUid,
                    details: { operation: "EmptyFolderContents", count: deletedUids.length, messageUids: deletedUids },
                });
            }
        }

        if (deleted > 0) {
            await this.refreshCounts([folderUid]);
        }
        const status: string = complete && failed.size === 0 ? "1" : deleted === 0 ? STATUS_SERVER_ERROR : STATUS_PARTIAL;
        return element(WbxmlCodePage.ItemOperations, "EmptyFolderContents", [textElement(WbxmlCodePage.ItemOperations, "Status", status)]);
    }

    /**
     * Handles `ItemOperations`' `Move`: relocates every `Message` sharing a decoded `ConversationId` to
     * `DstFldId`. Unlike `emptyFolderContents`/`fetchMessage` (which fail the whole request via a thrown
     * `ApiError`), this reports failure through the embedded `Status` the same way `MoveItemsCommand` does for
     * its own per-item results - a malformed/unresolvable `Move` is a normal outcome for this operation, not an
     * exceptional one. Reports failure (`Status 3`) if not even one message was actually moved - including when
     * every message sharing the conversation sits in a folder the caller lacks `UPDATE` on, which would
     * otherwise silently fall through to a false "success" with nothing having moved.
     */
    private async moveConversation(ctx: EasCommandContext, moveEl: WbxmlElement): Promise<WbxmlElement> {
        const conversationIdEl = findChild(moveEl, "ConversationId");
        const dstFldId = childText(moveEl, "DstFldId");
        if (!conversationIdEl?.opaque || !dstFldId) {
            return this.moveResponse("3");
        }

        const destFolder: Folder | undefined = await this.folderRepo!.findOne(dstFldId, { ignoreACL: true });
        if (
            !destFolder ||
            destFolder.mailboxUid !== ctx.mailboxUid ||
            !(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, dstFldId, ACLAction.CREATE))
        ) {
            return this.moveResponse("3");
        }

        // The ConversationId is the device's echo of `Message.conversationId`, which comes from sender-controlled
        // `References`/`In-Reply-To` headers: looked up bounded (as restapi stores it) as a `ModelUtils.literal()`, so a
        // value shaped like a query operator (`ne(x)`) is compared as itself, and still exact-matched in memory.
        const conversationId: string = boundIndexedValue(decodeConversationId(conversationIdEl.opaque));
        // Capped rather than an unbounded `find()` - an unusually long-running thread could otherwise return an
        // unbounded number of rows for one request.
        const messages: Message[] = (
            await this.messageRepo!.find({ mailboxUid: ctx.mailboxUid, conversationId: ModelUtils.literal(conversationId), limit: this.batchSize } as any, {
                ignoreACL: true,
                limit: this.batchSize,
            })
        ).filter((message: Message) => message.conversationId === conversationId && message.mailboxUid === ctx.mailboxUid);
        if (messages.length === 0) {
            return this.moveResponse("3");
        }

        // The permission checks (reads) are independent and safe to run concurrently, but the updates
        // themselves are not: the SQL backend (`better-sqlite3`) shares one connection per request and each
        // `update()` opens its own transaction, so concurrent updates fail outright with "cannot start a
        // transaction within a transaction" (confirmed against real SQL test failures, not theoretical) -
        // updates run sequentially in a plain loop instead.
        const permitted = await Promise.all(
            messages.map((message) => hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, message.folderUid, ACLAction.UPDATE)),
        );
        const folderTypes = new Map<string, FolderType | undefined>();
        const touched = new Set<string>();
        let moved = 0;
        let failed = 0;
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!permitted[i]) {
                continue;
            }
            if (!folderTypes.has(message.folderUid)) {
                folderTypes.set(message.folderUid, ((await this.folderRepo!.findOne(message.folderUid, { ignoreACL: true })) as Folder | undefined)?.type);
            }
            // Outbox, or Drafts for a message that isn't a draft, is refused per message - see `planMessageMove()`.
            const plan: MessageMovePlan = planMessageMove(message, folderTypes.get(message.folderUid), destFolder.type);
            if (!plan.allowed) {
                failed++;
                continue;
            }
            try {
                const updated = await this.messageRepo!.update(
                    { uid: (message as any).uid, version: (message as any).version, folderUid: dstFldId, ...plan.patch } as any,
                    asEntity(this.messageRepo!, message),
                    { ignoreACL: true, user: ctx.user },
                );
                new EasLiveUpdates(this.notificationUtils).moved(message.folderUid, this.messageClass.name, updated);
                touched.add(message.folderUid);
                moved++;
            } catch {
                failed++;
            }
        }
        if (moved === 0) {
            return this.moveResponse("3");
        }
        await this.refreshCounts([...touched, dstFldId]);

        return element(WbxmlCodePage.ItemOperations, "Move", [
            textElement(WbxmlCodePage.ItemOperations, "Status", failed > 0 ? STATUS_PARTIAL : "1"),
            textElement(WbxmlCodePage.ItemOperations, "DstFldId", dstFldId),
            opaqueElement(WbxmlCodePage.ItemOperations, "ConversationId", conversationIdEl.opaque),
        ]);
    }

    /** Recomputes, stores and publishes the counts of folders whose messages this request deleted or moved (restapi's
     * `refreshFolderCounts()`, as its own message writes do). Never throws. */
    private async refreshCounts(folderUids: Iterable<string>): Promise<void> {
        await refreshFolderCounts(
            { messageRepo: this.messageRepo!, folderRepo: this.folderRepo!, folderClass: this.folderClass, notificationUtils: this.notificationUtils, logger: this.logger },
            folderUids,
        );
    }

    private moveResponse(status: string): WbxmlElement {
        return element(WbxmlCodePage.ItemOperations, "Move", [textElement(WbxmlCodePage.ItemOperations, "Status", status)]);
    }

    private async fetchAttachment(ctx: EasCommandContext, audit: EasAuditLog, fileReference: string, remainingBytes: number): Promise<FetchResult> {
        const attachment: Attachment | undefined = await this.attachmentRepo!.findOne(fileReference, { ignoreACL: true });
        if (!attachment) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        // Access follows the message as it is filed *now*: `Attachment.folderUid` is denormalized and is not
        // updated when the message is moved, so it can point at a folder the message has since left.
        const message: Message | undefined = await this.messageRepo!.findOne(attachment.messageUid, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, message.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const tooLarge = (): FetchResult => ({
            element: element(WbxmlCodePage.ItemOperations, "Fetch", [
                textElement(WbxmlCodePage.ItemOperations, "Status", STATUS_TOO_LARGE),
                textElement(WbxmlCodePage.AirSyncBase, "FileReference", fileReference),
            ]),
            bytes: 0,
        });
        // Checked against the recorded size first, so an oversized attachment is never even loaded.
        if (Math.ceil(attachment.sizeBytes / 3) * 4 > remainingBytes) {
            return tooLarge();
        }
        const data = (await this.blobStore!.get(attachment.blobKey)).toString("base64");
        if (data.length > remainingBytes) {
            return tooLarge();
        }
        await audit.record({
            action: AuditAction.MESSAGE_CONTENT_ACCESSED,
            mailboxUid: message.mailboxUid,
            targetType: "Attachment",
            targetUid: (attachment as any).uid,
            details: { messageUid: attachment.messageUid, subject: message.subject, filename: attachment.filename },
        });

        return {
            element: element(WbxmlCodePage.ItemOperations, "Fetch", [
                textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
                textElement(WbxmlCodePage.AirSyncBase, "FileReference", fileReference),
                element(WbxmlCodePage.ItemOperations, "Properties", [
                    textElement(WbxmlCodePage.AirSyncBase, "ContentType", attachment.mimeType),
                    // "Inline" delivery per MS-ASCMD: binary content is base64-encoded and embedded directly in the
                    // WBXML, rather than this library's own opaque/binary element type.
                    textElement(WbxmlCodePage.ItemOperations, "Data", data),
                ]),
            ]),
            bytes: data.length,
        };
    }
}
