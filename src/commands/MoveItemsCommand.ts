///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity, hasMailAccess, type Folder, type Message } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import { type MessageMovePlan, planMessageMove } from "../MessageMoveRules.js";
const { Config, Init, Inject } = ObjectDecorators;

/** [MS-ASCMD] `MoveItems` `Status` codes (section 2.2.3.177.10): `3` is success - not `1`, which means an invalid
 * source. */
const STATUS_INVALID_SOURCE = "1";
const STATUS_INVALID_DESTINATION = "2";
const STATUS_SUCCESS = "3";
const STATUS_SAME_FOLDER = "4";
const STATUS_LOCKED = "7";

/** Most `Move` elements one `MoveItems` request may carry - more is rejected with HTTP 400. */
export const MAX_MOVES_PER_REQUEST = 500;

/**
 * Handles the standalone EAS `MoveItems` command: moves one or more `Message`s between folders in the caller's
 * own mailbox by `ServerId`/`uid`. A move never crosses mailboxes (the destination folder must belong to the
 * message's own mailbox) and a request may carry at most `MAX_MOVES_PER_REQUEST` moves.
 *
 * Each move gets its own [MS-ASCMD] status: `3` success; `1` an unknown/unreadable message, or a `SrcFldId` that
 * isn't where it lives (or can't be updated); `2` an unknown destination, one in another mailbox, one the caller
 * can't create in, Outbox, or Drafts for a message that isn't already a draft (`MessageMoveRules.planMessageMove`);
 * `4` source and destination are the same folder; `7` the update itself failed (e.g. a concurrent edit's version
 * conflict - the update is version-checked on both backends), a send in flight, or the message already left Outbox as sent - one failing
 * move never aborts the others. Moving a message out of Outbox cancels its scheduled send.
 *
 * **Pragmatic subset**: `Message` only - `Contacts`/`Calendar`/`Tasks` moves are rare in practice (unlike
 * `Message`, whose Inbox-to-subfolder filing is a real, common client action) and would each need their own
 * ACL/ownership verification path for comparatively little value; a client attempting one gets Status 1 (its
 * `SrcMsgId` isn't a message) rather than being silently ignored. `DstMsgId` in the response is always the same `uid` as `SrcMsgId` - this
 * library never mints a new identifier on move, unlike a real Exchange server, which sometimes does.
 *
 * `messageClass`/`folderClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MoveItemsCommand implements EasCommandHandler {
    public readonly command = "MoveItems";

    protected abstract messageClass: any;
    protected abstract folderClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private messageRepo?: RepoUtils<any>;
    private folderRepo?: RepoUtils<any>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** Roles `ACLUtils.hasPermission()` treats as always-permitted, which must never apply to another user's
     * mail - see `SyncCommand`'s identical field for the full rationale (restapi's own `MailAccessUtils.ts`). */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Init
    public async init(): Promise<void> {
        this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const moveEls = ctx.request ? findChildren(ctx.request, "Move") : [];
        if (moveEls.length > MAX_MOVES_PER_REQUEST) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `MoveItems supports at most ${MAX_MOVES_PER_REQUEST} Move elements per request.`);
        }
        const responses: WbxmlElement[] = [];
        for (const moveEl of moveEls) {
            responses.push(await this.moveOne(ctx, moveEl));
        }
        return element(WbxmlCodePage.Move, "MoveItems", responses);
    }

    private async moveOne(ctx: EasCommandContext, moveEl: WbxmlElement): Promise<WbxmlElement> {
        const srcMsgId = childText(moveEl, "SrcMsgId");
        const srcFldId = childText(moveEl, "SrcFldId");
        const dstFldId = childText(moveEl, "DstFldId");
        if (!srcMsgId || !srcFldId) {
            return this.responseElement(srcMsgId, STATUS_INVALID_SOURCE, undefined);
        }
        if (!dstFldId) {
            return this.responseElement(srcMsgId, STATUS_INVALID_DESTINATION, undefined);
        }
        if (srcFldId === dstFldId) {
            return this.responseElement(srcMsgId, STATUS_SAME_FOLDER, undefined);
        }

        const message: Message | undefined = await this.messageRepo!.findOne(srcMsgId, { ignoreACL: true });
        // The client's claimed SrcFldId must match where the message actually lives - protects against a
        // stale/mismatched client cache rather than trusting the claim outright.
        if (!message || message.folderUid !== srcFldId || !(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, srcFldId, ACLAction.UPDATE))) {
            return this.responseElement(srcMsgId, STATUS_INVALID_SOURCE, undefined);
        }
        if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, dstFldId, ACLAction.CREATE))) {
            return this.responseElement(srcMsgId, STATUS_INVALID_DESTINATION, undefined);
        }

        const destFolder: Folder | undefined = await this.folderRepo!.findOne(dstFldId, { ignoreACL: true });
        // A message never changes mailbox by moving: its `mailboxUid` (quota, retention, search scoping) must keep
        // matching its folder's mailbox, so a destination in any other mailbox is refused.
        if (!destFolder || destFolder.mailboxUid !== message.mailboxUid) {
            return this.responseElement(srcMsgId, STATUS_INVALID_DESTINATION, undefined);
        }

        const sourceFolder: Folder | undefined = await this.folderRepo!.findOne(message.folderUid, { ignoreACL: true });
        const plan: MessageMovePlan = planMessageMove(message, sourceFolder?.type, destFolder.type);
        if (!plan.allowed) {
            return this.responseElement(srcMsgId, plan.reason === "destination" ? STATUS_INVALID_DESTINATION : STATUS_LOCKED, undefined);
        }

        try {
            await this.messageRepo!.update(
                { uid: message.uid, version: (message as any).version, folderUid: dstFldId, ...plan.patch } as any,
                asEntity(this.messageRepo!, message),
                { ignoreACL: true, user: ctx.user },
            );
        } catch {
            return this.responseElement(srcMsgId, STATUS_LOCKED, undefined);
        }

        return this.responseElement(srcMsgId, STATUS_SUCCESS, message.uid);
    }

    private responseElement(srcMsgId: string | undefined, status: string, dstMsgId: string | undefined): WbxmlElement {
        return element(WbxmlCodePage.Move, "Response", [
            ...(srcMsgId ? [textElement(WbxmlCodePage.Move, "SrcMsgId", srcMsgId)] : []),
            textElement(WbxmlCodePage.Move, "Status", status),
            ...(dstMsgId ? [textElement(WbxmlCodePage.Move, "DstMsgId", dstMsgId)] : []),
        ]);
    }
}
