///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { ScanPipeline } from "@rapidmx/restapi/scan";
import {
    BlobStore,
    boundIndexedValue,
    findOrCreateWellKnownFolder,
    FolderType,
    hasMailAccess,
    type Mailbox,
    type Message,
    MessageImportance,
    prependHeaders,
    RecipientType,
    RecoverableRepoUtils,
    scanAndRelay,
} from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { checkComposedOriginators, extractOriginatorHeaders, stripHeader } from "../MimeHeaderUtils.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Most envelope recipients (To + Cc + Bcc) one composed message may carry. */
export const MAX_COMPOSE_RECIPIENTS = 500;

/** [MS-ASCMD] common Status 119, MessageHasNoRecipient. */
const STATUS_NO_RECIPIENT = "119";

/** Flattens mailparser's `AddressObject | AddressObject[] | undefined` union (grouped addresses can nest an
 * `AddressObject` per group) into a plain list of SMTP addresses, dropping any entry with no address (a
 * pure-group header with no direct member). */
function addressesOf(value: AddressObject | AddressObject[] | undefined): string[] {
    const objects: AddressObject[] = Array.isArray(value) ? value : value ? [value] : [];
    const addresses: string[] = [];
    for (const obj of objects) {
        for (const entry of obj.value) {
            collectAddresses(entry, addresses);
        }
    }
    return addresses;
}

function collectAddresses(entry: EmailAddress, out: string[]): void {
    if (entry.address) {
        out.push(entry.address);
    }
    for (const grouped of entry.group ?? []) {
        collectAddresses(grouped, out);
    }
}

export { stripHeader };

/**
 * Shared implementation for EAS `SendMail`, `SmartForward`, and `SmartReply` (MS-ASCMD `ComposeMail` namespace)
 * — all three submit a client-composed raw MIME body directly (`<Mime>`, opaque WBXML content) rather than
 * referencing a pre-existing draft `Message`, unlike the webmail REST API's `POST /messages/:id/send` (see
 * `BaseMessageRoute.send()`, which this class's `scanAndRelay()` call shares its scan-then-relay core with via
 * `MailSendUtils.ts`).
 *
 * **Sender and envelope checks** (the MIME is entirely device-controlled): the raw bytes pass restapi's own originator
 * rules before anything parses them (`MimeHeaderUtils.checkComposedOriginators`: an inline copy of restapi's
 * `checkOriginatorHeaders` with `rejectAddressLikeDisplayNames`): exactly one `From`, at most one `Sender` (found by a tolerant lexer - `From :`, folded lines and bare-CR
 * line breaks included), every address in them - group members too - the caller's own mailbox's primary or alias
 * address, no address-like text outside an address (`<me@x> <victim@y>`), and no address in a display name or comment
 * (`"ceo@y" <me@x>`, `me@x (victim@y)`), and - stricter than restapi - no empty group (`victims:;, me@x`). Anything
 * else is HTTP 403 (a MIME with no `From` at all is HTTP 400), so a device can't send as, or appear to be, anyone else;
 * the envelope sender is the validated `From`. A message with no To/Cc/Bcc address is answered with the command's own
 * `Status` 119 (MessageHasNoRecipient), nothing relayed. The envelope is capped at `MAX_COMPOSE_RECIPIENTS`
 * recipients (HTTP 400). `Bcc` recipients are delivered via the envelope, but every `Bcc` header field (found by the
 * same lexer, so `Bcc :` too) is stripped from the relayed copy so other recipients never see it (the Sent Items copy
 * keeps it). The Sent Items copy records the relay's own `Message-ID`/`conversationId` (bounded like restapi's), so
 * recall and threading match what recipients received.
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD semantics**:
 * - `SmartForward`/`SmartReply`'s `<Source>` (the message being forwarded/replied to) is used only to thread
 * the outgoing message (`inReplyTo`/`references`) and to flip the original's `Answered`/`Forwarded` flag - the
 * real spec has the *server* splice the original message's full content into the outgoing MIME; this subset
 * expects the client's own `<Mime>` to already be the complete outgoing message. The flag flip needs `UPDATE` on
 * the original's folder and is best-effort: the message has already been sent, so a denied or conflicting flag
 * update is logged, never turned into a failed request.
 * - `ReplaceMime`/`AccountId`/`InstanceId` are not read - single-account, non-recurring-meeting compose only.
 * - Attachments present in the composed MIME are relayed correctly but are not additionally persisted as
 * `Attachment` records on the saved Sent Items copy (`Message.hasAttachments` is still set).
 *
 * `folderClass`/`messageClass`/`mailboxClass` are supplied by the Mongo/SQL concrete subclasses, and
 * `markOriginal()` by the `SmartForwardCommand`/`SmartReplyCommand` subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ComposeMailCommand implements EasCommandHandler {
    public abstract readonly command: string;

    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected folderRepo?: RecoverableRepoUtils<any>;
    protected messageRepo?: RecoverableRepoUtils<any>;
    protected mailboxRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** Roles `ACLUtils.hasPermission()` treats as always-permitted, which must never apply to another user's
     * mail - see `SyncCommand`'s identical field for the full rationale (restapi's own `MailAccessUtils.ts`). */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Logger
    private logger: any;

    @Init
    public async init(): Promise<void> {
        this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
    }

    /** Called once the outgoing message has been sent, only when the request carried a `<Source>` the caller may
     * update - flips the referenced original message's own `Answered`/`Forwarded` flag. A no-op here; overridden by
     * the two subclasses that need it. */
    protected async markOriginal(_ctx: EasCommandContext, _original: Message & { uid: string }): Promise<void> {
        // No-op by default (plain SendMail has nothing to flag).
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.folderRepo || !this.messageRepo || !this.mailboxRepo || !this.blobStore || !this.mailTransport || !this.scanPipeline) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!ctx.request) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        // Registered as "MIME" (all caps) in WbxmlCodePages' ComposeMail table, per the published MS-ASWBXML
        // token name - not "Mime".
        const mimeEl = findChild(ctx.request, "MIME");
        const raw: Buffer | undefined = mimeEl?.opaque ?? (mimeEl?.text !== undefined ? Buffer.from(mimeEl.text, "utf-8") : undefined);
        if (!raw || raw.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A SendMail/SmartForward/SmartReply request must include a MIME body.");
        }

        // A `SmartForward`/`SmartReply` request identifies the message being acted on via `<Source><ItemId>` -
        // the same `Message.uid` this library already exposes as `ServerId` in Sync/FolderSync responses.
        let original: (Message & { uid: string; version: number }) | undefined;
        const sourceEl = findChild(ctx.request, "Source");
        if (sourceEl) {
            const itemId = childText(sourceEl, "ItemId");
            if (!itemId) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Source is missing its required ItemId.");
            }
            const found = await this.messageRepo.findOne(itemId, { ignoreACL: true });
            if (!found) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            if (!(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, found.folderUid, ACLAction.READ))) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
            }
            original = found;
        }

        const mailbox: Mailbox | undefined = await this.mailboxRepo.findOne(ctx.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const ownAddresses = new Set(
            [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].filter((a) => typeof a === "string").map((a) => a.toLowerCase()),
        );
        const isAllowed = (address: string): boolean => ownAddresses.has(address.toLowerCase());

        // Checked on the raw bytes before parsing, with restapi's own sender rules (see `MimeHeaderUtils`): mailparser
        // keeps just one of several `From`/`Sender` fields and recovers malformed address lists tolerantly, so checking
        // only its parse would validate something other than what a recipient may be shown.
        if (extractOriginatorHeaders(raw).from.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The composed Mime has no resolvable From/To address.");
        }
        if (checkComposedOriginators(raw, isAllowed) !== undefined) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "The composed message's From address is not one of this mailbox's addresses.");
        }

        const parsed: ParsedMail = await simpleParser(raw);
        const fromAddresses: string[] = addressesOf(parsed.from);
        const envelopeFrom: string | undefined = fromAddresses[0];
        const envelopeTo: string[] = [...addressesOf(parsed.to), ...addressesOf(parsed.cc), ...addressesOf(parsed.bcc)].filter(
            (address) => address.trim().length > 0,
        );
        /* v8 ignore start -- checkComposedOriginators() already required a From address mailparser reads too */
        if (!envelopeFrom) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The composed Mime has no resolvable From/To address.");
        }
        /* v8 ignore stop */
        if (envelopeTo.length === 0) {
            // Like restapi's send() (400 for a message with no To/Cc/Bcc recipient), refused before anything is relayed -
            // reported the ActiveSync way, [MS-ASCMD] Status 119 (MessageHasNoRecipient) in the command's own response.
            return element(WbxmlCodePage.ComposeMail, this.command, [textElement(WbxmlCodePage.ComposeMail, "Status", STATUS_NO_RECIPIENT)]);
        }
        if (envelopeTo.length > MAX_COMPOSE_RECIPIENTS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A composed message may have at most ${MAX_COMPOSE_RECIPIENTS} recipients.`);
        }
        // Defense in depth: the raw checks above already cover every address mailparser can report.
        /* v8 ignore start -- unreachable while checkOriginatorHeaders() passes; kept in case the two parsers ever disagree */
        const senderAddresses: string[] = addressesOf(parsed.headers.get("sender") as AddressObject | undefined);
        if ([...fromAddresses, ...senderAddresses].some((address) => !isAllowed(address))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "The composed message's From address is not one of this mailbox's addresses.");
        }
        /* v8 ignore stop */

        const stripped: Buffer = stripHeader(raw, "bcc");
        const relayed = await scanAndRelay(stripped, envelopeFrom, envelopeTo, this.scanPipeline, this.mailTransport, this.blobStore);

        if (findChild(ctx.request, "SaveInSentItems")) {
            const bodyBlobKey = `bodies/${crypto.randomUUID()}`;
            // The Sent Items copy keeps its Bcc header, but must carry the `Message-ID` the message was actually relayed
            // with: `scanAndRelay()` injects one when the device's MIME had none, and recall/threading match on it.
            const stored: Buffer =
                relayed.raw !== stripped ? prependHeaders(raw, [{ name: "Message-ID", value: `<${relayed.messageId}>` }]) : raw;
            await this.blobStore.put(bodyBlobKey, stored, { contentType: "message/rfc822" });

            const sentFolder: any = await findOrCreateWellKnownFolder(
                this.folderRepo,
                this.folderClass,
                ctx.mailboxUid,
                FolderType.SENT_ITEMS,
                ctx.user,
            );

            await this.messageRepo.create(
                new this.messageClass({
                    folderUid: sentFolder.uid,
                    mailboxUid: ctx.mailboxUid,
                    // The relay's own values (angle brackets stripped, as every recipient's ingest stores them), bounded
                    // the way restapi stores indexed identifiers - not mailparser's bracketed `Message-ID`.
                    messageId: boundIndexedValue(relayed.messageId),
                    conversationId: boundIndexedValue(relayed.conversationId),
                    subject: parsed.subject ?? "",
                    from: { address: envelopeFrom, type: RecipientType.TO },
                    recipients: buildRecipients(parsed),
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey,
                    sanitizedHtmlBlobKey: relayed.sanitizedHtmlBlobKey,
                    encrypted: relayed.encrypted,
                    bodyPreview: (parsed.text ?? "").slice(0, 200),
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                    importance: MessageImportance.NORMAL,
                    inReplyTo: original?.messageId,
                    references: original ? [...original.references, original.messageId] : [],
                    /* v8 ignore next -- unreachable via real mailparser output: simpleParser() always initializes
                     * `attachments` to `[]`, never leaves it undefined, so the `?.`/`?? 0` fallback never fires */
                    hasAttachments: (parsed.attachments?.length ?? 0) > 0,
                } as any),
                { ignoreACL: true, user: ctx.user },
            );
        }

        if (original) {
            // The message is already on its way - flagging the original is best-effort bookkeeping.
            try {
                if (await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, original.folderUid, ACLAction.UPDATE)) {
                    await this.markOriginal(ctx, original);
                }
            } catch (err: any) {
                this.logger?.warn(`${this.command}: failed to flag original message ${original.uid}: ${err?.message}`);
            }
        }

        // Per MS-ASCMD: a successful SendMail/SmartForward/SmartReply response is an empty HTTP 200 body, not
        // a Status-coded WBXML document like FolderSync/Sync/Provision return.
        return undefined;
    }
}

function buildRecipients(parsed: ParsedMail): { address: string; type: RecipientType }[] {
    return [
        ...addressesOf(parsed.to).map((address) => ({ address, type: RecipientType.TO })),
        ...addressesOf(parsed.cc).map((address) => ({ address, type: RecipientType.CC })),
        ...addressesOf(parsed.bcc).map((address) => ({ address, type: RecipientType.BCC })),
    ];
}
