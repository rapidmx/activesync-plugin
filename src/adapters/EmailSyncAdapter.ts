///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { simpleParser } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, opaqueElement, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { toCompactDateTime } from "../CompactDateTime.js";
import type { EasCollectionSyncAdapter, SyncBodyPreference } from "./EasCollectionSyncAdapter.js";
import { isGenuineDraft } from "../MessageMoveRules.js";
import { truncateUtf8 } from "../MimeHeaderUtils.js";
import {
    type Attachment,
    type BlobStore,
    type ParsedIcsEvent,
    boundIndexedValue,
    extractIcsFromRaw,
    type Folder,
    type Label,
    type Mailbox,
    type Message,
    parseInviteIcs,
    inviteIsAllDay,
    type Recipient,
    FolderType,
    htmlToPlainText,
    MessageImportance,
    RecipientType,
} from "@rapidmx/restapi";
const { Init, Inject } = ObjectDecorators;

/** MS-ASEMAIL `Importance`: 0=Low, 1=Normal, 2=High. */
const IMPORTANCE_CODES: Record<MessageImportance, string> = {
    [MessageImportance.LOW]: "0",
    [MessageImportance.NORMAL]: "1",
    [MessageImportance.HIGH]: "2",
};

const IMPORTANCE_BY_CODE: Record<string, MessageImportance> = {
    "0": MessageImportance.LOW,
    "1": MessageImportance.NORMAL,
    "2": MessageImportance.HIGH,
};

/** MS-ASAIRSYNCBASE `Body.Type`: 1 = plain text, 2 = HTML, 3 = RTF, 4 = MIME. */
const BODY_TYPE_PLAIN_TEXT = "1";
const BODY_TYPE_HTML = "2";
const BODY_TYPE_MIME = "4";

/**
 * MS-OXCMAIL/MS-OXOCAL `MessageClass` for a meeting-invite email, keyed by its iTIP `METHOD`
 * (`Message.meetingMethod`). This is what a real Exchange-compatible client actually keys its "show Accept/
 * Tentative/Decline" UI off of - checked *before* it ever looks inside `MeetingRequest`'s own child elements -
 * so a `MeetingRequest` element with no `MessageClass` (or the default `IPM.Note`) is commonly just ignored,
 * falling back to showing the message as a plain email with its `.ics` as an ordinary attachment. `REPLY`/
 * `COUNTER` have no single well-known class this pragmatic subset renders specially (an incoming reply/counter
 * is informational to the organizer, not something the recipient needs their own Accept/Decline UI for) -
 * `PUBLISH` likewise has no distinct class of its own (it's conventionally just `IPM.Note` with a calendar
 * attachment, which is already what omitting this tag naturally produces). */
const MESSAGE_CLASS_BY_METHOD: Partial<Record<string, string>> = {
    REQUEST: "IPM.Schedule.Meeting.Request",
    CANCEL: "IPM.Schedule.Meeting.Canceled",
};

/** A message's body as actually resolved for `Sync` (see `resolveBodies()`), honoring the device's own
 * `BodyPreference` instead of always being the short `bodyPreview`. */
interface RenderedBody {
    type: string;
    data: string;
    truncated: boolean;
    estimatedDataSize: number;
}

/** MS-ASEMAIL `Flag/Status` value for an active (flagged, not completed) follow-up flag. */
const FLAG_STATUS_ACTIVE = "2";

/** Max uids per `in(...)` lookup (labels or attachments) - well under `RepoUtils.find()`'s 1000-row page cap. */
const LOOKUP_CHUNK = 500;

/** The shape of a real entity uid (a lowercase UUID). Anything else in `Message.labelUids` can't be a real label
 * and must never be spliced into an `in(...)` operand, where `me` would resolve to the caller's uid and a comma
 * would split one value into several. */
const UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function labelKey(mailboxUid: string, labelUid: string): string {
    return `${mailboxUid}/${labelUid}`;
}

/**
 * Maps `Message` to/from the EAS `Sync` `Email` collection class (MS-ASEMAIL). Only a plain-text preview of the
 * body is included here (`Message.bodyPreview`, always already loaded on the entity, `Truncated: 1`) rather
 * than the full sanitized HTML body from the `BlobStore` - a real device fetches the full body on demand via
 * `ItemOperations`' `Fetch` (see the architecture plan's command table), the same two-step "list, then fetch
 * body" flow every real EAS client already implements for exactly this reason (bodies can be large; a sync
 * window's Add/Change list shouldn't have to pull every one of them from blob storage up front).
 *
 * Also handles client-originated `Add`/`Change` for Drafts (`SyncCommand`'s own doc comment covers why this is
 * the only `Email` write EAS itself allows) - a plain-text-only pragmatic subset: no HTML body, no attachments
 * (mirrors `ComposeMailCommand`'s own already-documented attachment gap). `To`/`Cc`/`Bcc` (the latter MS-ASEMAIL2's
 * own `Bcc` tag) are ghosted independently per recipient type, not as one combined group - a `Change` touching
 * only one of them leaves the others untouched, carried over from `existing.recipients`. A new Draft always gets a body
 * blob (empty when no `Body` was sent), so `ItemOperations` can fetch it like any other message.
 *
 * `Flag` is the MS-ASEMAIL container form in both directions: `<Flag><Status>2</Status></Flag>` (tokenized as
 * `FlagStatus`) for a flagged message, an empty `<Flag/>` otherwise; `Status` 0/1 (cleared/complete) or an empty
 * `Flag` from the device clears `flags.flagged`.
 *
 * Emits MS-ASEMAIL2's `Email2:ConversationId` (read-only - no `fromApplicationData` handling, since EAS itself
 * never lets a client set it) whenever `Message.conversationId` is populated, so a device's threaded-view UI can
 * group messages the same way `BaseMessageRoute.conversations()` does server-side. See `encodeConversationId`'s
 * own doc comment for the wire encoding, and `ItemOperationsCommand`'s `Move` handling for the one place this
 * gets decoded back.
 *
 * Emits MS-ASEMAIL's `Categories`/`Category` (also read-only) from `Message.labelUids`, resolved against the
 * `Label` repo to real display names - a stale `labelUids` entry (the label was since deleted) is silently
 * dropped rather than surfacing as an error, the same "tolerate a dangling reference" stance `SearchCommand`
 * already takes for a stale search-index entry. Deliberately not writable: unlike `Contact.categories` (a
 * plain free-form string array with no separate entity behind it), a `Label` is a real mailbox-scoped entity
 * referenced by uid - a write path would need to resolve category name strings back to `Label`s and create new
 * ones on the fly for names that don't exist yet, real added scope this pragmatic subset defers. Callers
 * rendering a whole Sync page/search result set use `toApplicationDataBatch()`, which resolves every referenced
 * label with one `in(...)` query per mailbox rather than one per labelled message.
 *
 * Also emits MS-ASAIRSYNCBASE's `Attachments` (every message that has any - `Attachment` rows resolved with one
 * `in(...)` query per batch, the same pattern `resolveLabelNames()` already uses for labels) and, for a message
 * whose `meetingMethod` is `"REQUEST"`, MS-ASEMAIL's `MeetingRequest` - the actual mechanism a real EAS client
 * uses to recognize an invite and offer Accept/Decline, built from the raw message's own `.ics` part via
 * restapi's `extractIcsFromRaw()`/`parseInviteIcs()` (the same invite-parsing logic the web client's own
 * Accept/Decline card already relies on, rather than a second, divergent parser). A pragmatic subset, deliberately
 * not the full MS-ASEMAIL semantics: `BusyStatus`/`Sensitivity` have no source field in an invite's own
 * iCalendar file, so both use the spec's documented default (the same choice `CalendarSyncAdapter` already makes
 * for `Sensitivity`); `Recurrences`/`GlobalObjId`/`TimeZone` are not emitted (the same documented gap
 * `CalendarSyncAdapter` already carries for its own `TimeZone`). An invite whose `.ics` can't be read or has no
 * `StartTime`/`EndTime` simply renders without a `MeetingRequest` element - the email itself still syncs
 * normally, just without invite recognition on the device.
 *
 * `labelClass`/`folderClass`/`attachmentClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class EmailSyncAdapter implements EasCollectionSyncAdapter<Message> {
    public readonly collectionClass = "Email";

    protected abstract labelClass: any;

    protected abstract folderClass: any;

    protected abstract attachmentClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private labelRepo?: RepoUtils<any>;

    private folderRepo?: RepoUtils<any>;

    private attachmentRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.labelRepo && this.labelClass) {
            this.labelRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.labelClass.name, args: [this.labelClass] });
        }
        if (!this.folderRepo && this.folderClass) {
            this.folderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
        if (!this.attachmentRepo && this.attachmentClass) {
            this.attachmentRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.attachmentClass.name, args: [this.attachmentClass] });
        }
    }

    public async toApplicationData(message: Message, bodyPreference?: SyncBodyPreference): Promise<WbxmlElement> {
        return (await this.toApplicationDataBatch([message], bodyPreference))[0];
    }

    /** Renders a whole page of messages, resolving every referenced `Label` with one `find()` per distinct
     * mailbox (in practice one per page) instead of one per labelled message, and likewise batching the
     * `Attachment`/`MeetingRequest`/body lookups below rather than doing any of them per message. */
    public async toApplicationDataBatch(messages: Message[], bodyPreference?: SyncBodyPreference): Promise<WbxmlElement[]> {
        const [labelNames, attachmentsByMessage, meetingRequestsByMessage, bodiesByMessage] = await Promise.all([
            this.resolveLabelNames(messages),
            this.resolveAttachments(messages),
            this.resolveMeetingRequests(messages),
            this.resolveBodies(messages, bodyPreference),
        ]);
        return messages.map((message) => {
            const categories: string[] = [];
            for (const uid of new Set(message.labelUids ?? [])) {
                const name = labelNames.get(labelKey(message.mailboxUid, uid));
                if (name !== undefined) {
                    categories.push(name);
                }
            }
            return this.render(
                message,
                categories,
                attachmentsByMessage.get(message.uid) ?? [],
                meetingRequestsByMessage.get(message.uid),
                bodiesByMessage.get(message.uid),
            );
        });
    }

    /** Resolves every message with `hasAttachments` to its `Attachment` rows, in one `in(...)` query per
     * `LOOKUP_CHUNK` of message uids rather than one per message - the same batching `resolveLabelNames()` uses. */
    private async resolveAttachments(messages: Message[]): Promise<Map<string, Attachment[]>> {
        const byMessage = new Map<string, Attachment[]>();
        const uids = messages.filter((m) => m.hasAttachments).map((m) => m.uid);
        if (uids.length === 0 || !this.attachmentRepo) {
            return byMessage;
        }
        for (let i = 0; i < uids.length; i += LOOKUP_CHUNK) {
            const chunk = uids.slice(i, i + LOOKUP_CHUNK);
            const rows: Attachment[] = await this.attachmentRepo.find({ messageUid: `in(${chunk.join(",")})`, limit: chunk.length } as any, {
                ignoreACL: true,
                limit: chunk.length,
            });
            for (const row of rows) {
                const list = byMessage.get(row.messageUid) ?? [];
                list.push(row);
                byMessage.set(row.messageUid, list);
            }
        }
        return byMessage;
    }

    /** Resolves every `meetingMethod === "REQUEST"` message to a rendered `MeetingRequest` element, fetching and
     * parsing each one's raw MIME in parallel (bounded by the page's own `windowSize`, same as any other
     * per-batch work here) rather than serially. A message whose `.ics` can't be read or parsed, or that has no
     * `StartTime`/`EndTime`, simply has no entry - `render()` then omits the element rather than fail the whole
     * item (see `SyncCommand.ts`'s own comment on why a render failure must never be lightly reintroduced). */
    private async resolveMeetingRequests(messages: Message[]): Promise<Map<string, WbxmlElement>> {
        const byMessage = new Map<string, WbxmlElement>();
        const candidates = messages.filter((m) => m.meetingMethod === "REQUEST" && m.bodyBlobKey);
        await Promise.all(
            candidates.map(async (message) => {
                try {
                    const raw = await this.blobStore!.get(message.bodyBlobKey);
                    const ics = await extractIcsFromRaw(raw);
                    const parsed: ParsedIcsEvent | undefined = ics ? parseInviteIcs(ics) : undefined;
                    if (parsed?.startDate && parsed?.endDate) {
                        byMessage.set(message.uid, meetingRequestElement(parsed));
                    }
                } catch {
                    // Malformed/unreadable .ics: no MeetingRequest for this one message, same tolerant-of-a-bad-
                    // reference stance as the stale label uids this file already drops silently above.
                }
            }),
        );
        return byMessage;
    }

    /** Resolves every message to its real body text (not just `bodyPreview`), honoring the device's own
     * `BodyPreference` - mirrors `ItemOperationsCommand.fetchMessage()`'s exact same source-preference and
     * truncation logic, just applied to a whole `Sync` page in parallel instead of one `ItemOperations Fetch`
     * at a time. Returns an empty map (every message falls back to `render()`'s own `bodyPreview` default) when
     * the device sent no `BodyPreference` at all - many real EAS clients do send one and expect the (near-)full
     * body inline in `Sync` itself, not a short preview requiring a separate `Fetch` round trip for ordinary
     * reading; this was discovered live (a real device showing truncated mail that the web client renders in
     * full), not assumed in advance. A message whose blob can't be read falls back to the short preview, same
     * tolerant-of-a-bad-reference stance as this file's other per-message batch lookups. */
    private async resolveBodies(messages: Message[], bodyPreference: SyncBodyPreference | undefined): Promise<Map<string, RenderedBody>> {
        const byMessage = new Map<string, RenderedBody>();
        if (!bodyPreference) {
            return byMessage;
        }
        const wantsMime = bodyPreference.type === BODY_TYPE_MIME;
        const wantsHtml = bodyPreference.type === BODY_TYPE_HTML;
        await Promise.all(
            messages.map(async (message) => {
                try {
                    let type = BODY_TYPE_PLAIN_TEXT;
                    let text: string;
                    // `Type 4` (raw MIME) is an explicit request for the verbatim source - same preference
                    // `ItemOperationsCommand.fetchMessage()` already honors - checked first, ahead of the
                    // HTML-over-plain-text preference below, since it's the device's own direct ask.
                    if (wantsMime) {
                        type = BODY_TYPE_MIME;
                        text = (await this.blobStore!.get(message.bodyBlobKey)).toString("utf-8");
                    } else if (wantsHtml && message.sanitizedHtmlBlobKey) {
                        type = BODY_TYPE_HTML;
                        text = (await this.blobStore!.get(message.sanitizedHtmlBlobKey)).toString("utf-8");
                    } else {
                        const raw = await this.blobStore!.get(message.bodyBlobKey);
                        const parsed = await simpleParser(raw);
                        text = parsed.text ?? message.bodyPreview;
                    }
                    const estimatedDataSize = Buffer.byteLength(text, "utf8");
                    let truncated = false;
                    if (bodyPreference.truncationSize !== undefined && estimatedDataSize > bodyPreference.truncationSize) {
                        text = truncateUtf8(text, bodyPreference.truncationSize);
                        truncated = true;
                    }
                    byMessage.set(message.uid, { type, data: text, truncated, estimatedDataSize });
                } catch {
                    // Blob unreadable/missing: this one message keeps render()'s short-preview fallback rather
                    // than fail the whole Sync round over it.
                }
            }),
        );
        return byMessage;
    }

    private render(
        message: Message,
        categories: string[],
        attachments: Attachment[],
        meetingRequest: WbxmlElement | undefined,
        body: RenderedBody | undefined,
    ): WbxmlElement {
        const to = message.recipients.filter((r) => r.type === RecipientType.TO).map((r) => r.address);
        const cc = message.recipients.filter((r) => r.type === RecipientType.CC).map((r) => r.address);
        const bcc = message.recipients.filter((r) => r.type === RecipientType.BCC).map((r) => r.address);
        const messageClass = message.meetingMethod ? MESSAGE_CLASS_BY_METHOD[message.meetingMethod] : undefined;

        return element(WbxmlCodePage.AirSync, "ApplicationData", [
            textElement(WbxmlCodePage.Email, "Subject", message.subject),
            textElement(WbxmlCodePage.Email, "From", formatAddress(message.from.address, message.from.displayName)),
            ...(to.length > 0 ? [textElement(WbxmlCodePage.Email, "To", to.join("; "))] : []),
            ...(cc.length > 0 ? [textElement(WbxmlCodePage.Email, "Cc", cc.join("; "))] : []),
            ...(bcc.length > 0 ? [textElement(WbxmlCodePage.Email2, "Bcc", bcc.join("; "))] : []),
            textElement(WbxmlCodePage.Email, "DateReceived", message.receivedDate.toISOString()),
            textElement(WbxmlCodePage.Email, "Importance", IMPORTANCE_CODES[message.importance]),
            textElement(WbxmlCodePage.Email, "Read", message.flags.read ? "1" : "0"),
            // MS-ASEMAIL `Flag` is a container: `<Flag><Status>2</Status></Flag>` (active) or an empty `<Flag/>`.
            element(WbxmlCodePage.Email, "Flag", message.flags.flagged ? [textElement(WbxmlCodePage.Email, "FlagStatus", FLAG_STATUS_ACTIVE)] : []),
            // See `MESSAGE_CLASS_BY_METHOD`'s own doc comment: this is the real signal a client keys its
            // Accept/Tentative/Decline UI off of, checked before it ever looks inside `MeetingRequest` itself.
            ...(messageClass ? [textElement(WbxmlCodePage.Email, "MessageClass", messageClass)] : []),
            element(WbxmlCodePage.AirSyncBase, "Body", [
                textElement(WbxmlCodePage.AirSyncBase, "Type", body?.type ?? BODY_TYPE_PLAIN_TEXT),
                textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(body?.estimatedDataSize ?? Buffer.byteLength(message.bodyPreview, "utf8"))),
                textElement(WbxmlCodePage.AirSyncBase, "Truncated", body ? (body.truncated ? "1" : "0") : "1"),
                textElement(WbxmlCodePage.AirSyncBase, "Data", body?.data ?? message.bodyPreview),
            ]),
            // MS-ASAIRS `NativeBodyType` - a sibling of `Body` under `ApplicationData`, spec-optional but
            // mirrors the `Type` just emitted above (the codec already had this token defined; no adapter ever
            // emitted it). Added investigating a real device (Apple Mail/iPadOS) that showed every message as
            // undownloadable despite an otherwise valid, correctly-sized `Body` - a real-world EAS server
            // implementation (not this one) was found to emit this unconditionally for exactly that reason.
            // Valid values are only 1 (plain)/2 (HTML)/3 (RTF) - never `body.type`'s own "4" (MIME is the
            // wrapper around a native body, not a native format itself), so a `Type 4` Fetch response falls
            // back to this message's real native format instead.
            textElement(WbxmlCodePage.AirSyncBase, "NativeBodyType", body?.type !== BODY_TYPE_MIME ? (body?.type ?? BODY_TYPE_PLAIN_TEXT) : message.sanitizedHtmlBlobKey ? BODY_TYPE_HTML : BODY_TYPE_PLAIN_TEXT),
            ...(message.conversationId ? [opaqueElement(WbxmlCodePage.Email2, "ConversationId", encodeConversationId(message.conversationId))] : []),
            ...(categories.length > 0
                ? [
                      element(
                          WbxmlCodePage.Email,
                          "Categories",
                          categories.map((name) => textElement(WbxmlCodePage.Email, "Category", name)),
                      ),
                  ]
                : []),
            ...(attachments.length > 0 ? [attachmentsElement(attachments)] : []),
            ...(meetingRequest ? [meetingRequest] : []),
        ]);
    }

    /** Resolves every distinct `labelUids` entry across `messages` to its `Label.name`, keyed by `labelKey()`.
     * Labels are mailbox-scoped, so uids are grouped per `mailboxUid` and each group is fetched with a single
     * `in(...)` query (chunked to stay within `RepoUtils`' page size). A stale uid simply has no entry. */
    private async resolveLabelNames(messages: Message[]): Promise<Map<string, string>> {
        const uidsByMailbox = new Map<string, Set<string>>();
        for (const message of messages) {
            for (const uid of message.labelUids ?? []) {
                if (!UID_PATTERN.test(uid)) {
                    continue;
                }
                let uids = uidsByMailbox.get(message.mailboxUid);
                if (!uids) {
                    uids = new Set<string>();
                    uidsByMailbox.set(message.mailboxUid, uids);
                }
                uids.add(uid);
            }
        }

        const names = new Map<string, string>();
        const lookups: Promise<void>[] = [];
        for (const [mailboxUid, uidSet] of uidsByMailbox) {
            const uids = Array.from(uidSet);
            for (let i = 0; i < uids.length; i += LOOKUP_CHUNK) {
                const chunk = uids.slice(i, i + LOOKUP_CHUNK);
                lookups.push(
                    this.labelRepo!.find({ mailboxUid, uid: `in(${chunk.join(",")})`, limit: chunk.length } as any, {
                        ignoreACL: true,
                        limit: chunk.length,
                    }).then((labels: Label[]) => {
                        for (const label of labels) {
                            names.set(labelKey(mailboxUid, (label as any).uid), label.name);
                        }
                    }),
                );
            }
        }
        await Promise.all(lookups);
        return names;
    }

    /**
     * `Message.bodyBlobKey` is documented (see the `Message` interface itself) as holding raw MIME "unmodified
     * from ingestion/send" - `ItemOperationsCommand.fetchMessage` parses it with `simpleParser` unconditionally
     * for every message, Draft or not. A Draft's plain-text body is therefore wrapped in a minimal valid
     * RFC 5322 message here (via `buildPlainTextMime`) rather than stored as bare text, so that contract holds
     * for every consumer, not just this write path - a Draft created/edited via `Sync` must `Fetch` correctly
     * the same way any other message does.
     */
    public async fromApplicationData(el: WbxmlElement, existing?: Message, mailbox?: Mailbox): Promise<Partial<Message>> {
        const partial: Partial<Message> = {};

        const subject = childText(el, "Subject");
        if (subject !== undefined) partial.subject = subject;

        const to = childText(el, "To");
        const cc = childText(el, "Cc");
        const bcc = childText(el, "Bcc");
        if (to !== undefined || cc !== undefined || bcc !== undefined) {
            // Ghosted per-recipient-type, not as one combined group: a `Change` touching only `To` must leave
            // any existing `Cc`/`Bcc` recipients alone, so untouched types are carried over from `existing`
            // rather than the whole `recipients` array being rebuilt from just what's present in `el`.
            const untouched = (existing?.recipients ?? []).filter(
                (r) =>
                    (r.type !== RecipientType.TO || to === undefined) &&
                    (r.type !== RecipientType.CC || cc === undefined) &&
                    (r.type !== RecipientType.BCC || bcc === undefined),
            );
            partial.recipients = [
                ...untouched,
                ...(to !== undefined ? parseAddressList(to, RecipientType.TO) : []),
                ...(cc !== undefined ? parseAddressList(cc, RecipientType.CC) : []),
                ...(bcc !== undefined ? parseAddressList(bcc, RecipientType.BCC) : []),
            ];
        }

        const importance = childText(el, "Importance");
        if (importance !== undefined) {
            partial.importance = IMPORTANCE_BY_CODE[importance] ?? MessageImportance.NORMAL;
        }

        const read = childText(el, "Read");
        // `Flag` is a container whose `Status` (tokenized as `FlagStatus`) is 0 = cleared, 1 = complete, 2 = active;
        // an empty `<Flag/>` clears the flag.
        const flagEl = findChild(el, "Flag");
        const flag: string | undefined = flagEl ? (childText(flagEl, "FlagStatus") ?? "0") : undefined;
        if (read !== undefined || flag !== undefined) {
            const baseFlags = existing?.flags ?? { read: false, flagged: false, answered: false, forwarded: false };
            partial.flags = {
                ...baseFlags,
                ...(read !== undefined ? { read: read === "1" } : {}),
                ...(flag !== undefined ? { flagged: flag === FLAG_STATUS_ACTIVE } : {}),
            };
        }

        const bodyEl = findChild(el, "Body");
        // A new Draft always gets a body blob (empty when the device sent no Body) - every consumer of
        // `bodyBlobKey` (`ItemOperations` Fetch, exports) expects it to resolve to real MIME.
        if (bodyEl || !existing) {
            // [MS-ASCMD]/[MS-ASEMAIL] only let a client change the body of a Draft. Any other message's blob is its
            // original MIME - evidence a retention/legal hold may depend on, and possibly shared with other rows
            // (an inbox-rule copy reuses the delivered message's `bodyBlobKey`) - so a Change is refused (the
            // caller reports Status 6) rather than applied.
            if (existing && !(await this.isDraft(existing))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Only a Draft's body can be changed.");
            }
            // A device composing HTML (Gmail does) sends `Body.Type` 2: the draft keeps its text, not the markup, which its preview and
            // the plain-text MIME built below would otherwise show as literal tags.
            const data = (bodyEl && childText(bodyEl, "Data")) ?? "";
            const text = bodyEl && childText(bodyEl, "Type") === BODY_TYPE_HTML ? htmlToPlainText(data) : data;
            // Always a fresh key, never an overwrite of `existing.bodyBlobKey`: an existing blob may be shared, and
            // leaving it intact means a Change that then fails its version check can't corrupt the stored body.
            const bodyBlobKey = `bodies/${crypto.randomUUID()}`;
            const mime = buildPlainTextMime({
                subject: partial.subject ?? existing?.subject ?? "",
                from: existing?.from ?? (mailbox ? { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName, type: RecipientType.TO } : undefined),
                recipients: partial.recipients ?? existing?.recipients ?? [],
                date: existing?.sentDate ?? new Date(),
                text,
            });
            await this.blobStore!.put(bodyBlobKey, Buffer.from(mime, "utf-8"), { contentType: "message/rfc822" });
            partial.bodyBlobKey = bodyBlobKey;
            partial.bodyPreview = text.slice(0, 200);
        }

        return partial;
    }

    /** Whether `message` is a genuine draft (`MessageMoveRules.isGenuineDraft`): in its mailbox's Drafts folder, and
     * never delivered. Moving any other message into Drafts is refused over ActiveSync, so its body can't be rewritten
     * here by first moving it there. */
    private async isDraft(message: Message): Promise<boolean> {
        const folder: Folder | undefined = await this.folderRepo!.findOne(message.folderUid, { ignoreACL: true });
        return isGenuineDraft(message, folder?.type);
    }

    /** Defaults for a brand-new Draft created via a client-originated `Add` - `from` is the caller's own
     * mailbox address, per `ComposeMailCommand`'s identical `{ address, type: RecipientType.TO }` shape
     * convention for a `from` field (the `Recipient` struct's `type` is only meaningful for real recipients;
     * it's reused here as a harmless placeholder). */
    public newEntityDefaults(mailbox: Mailbox): Partial<Message> {
        return {
            messageId: boundIndexedValue(`<${crypto.randomUUID()}@eas>`),
            subject: "",
            from: { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName, type: RecipientType.TO },
            recipients: [],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: "",
            bodyPreview: "",
            flags: { read: true, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: false,
        };
    }
}

/** Encodes `Message.conversationId` (an internal string uid) into the opaque binary blob MS-ASEMAIL2's
 * `Email2:ConversationId` carries on the wire. The spec never mandates any particular binary format for this
 * value - a real Exchange server mints a GUID, but a client only ever compares/echoes it byte-for-byte, never
 * interprets it - so encoding the uid's own UTF-8 bytes directly (rather than hashing into a 16-byte GUID
 * shape) is a valid, simpler choice that `decodeConversationId` can invert exactly, which `ItemOperationsCommand`
 * relies on to resolve an `ItemOperations` `Move`'s `ConversationId` back into this same uid. */
export function encodeConversationId(conversationId: string): Buffer {
    return Buffer.from(conversationId, "utf8");
}

/** Reverse of `encodeConversationId`. */
export function decodeConversationId(opaque: Buffer): string {
    return opaque.toString("utf8");
}

function formatAddress(address: string, displayName?: string): string {
    return displayName ? `${displayName} <${address}>` : address;
}

/** MS-ASAIRSYNCBASE `Attachments`/`Attachment`: `FileReference` is the attachment's own uid, exactly what
 * `ItemOperationsCommand.fetchAttachment()` already expects to look it up directly via `attachmentRepo.findOne()`.
 * `Method` is fixed `"1"` (normal attachment) - this adapter never attaches an embedded message or OLE object. */
function attachmentsElement(attachments: Attachment[]): WbxmlElement {
    return element(
        WbxmlCodePage.AirSyncBase,
        "Attachments",
        attachments.map((attachment) =>
            element(WbxmlCodePage.AirSyncBase, "Attachment", [
                textElement(WbxmlCodePage.AirSyncBase, "DisplayName", attachment.filename),
                textElement(WbxmlCodePage.AirSyncBase, "FileReference", attachment.uid),
                textElement(WbxmlCodePage.AirSyncBase, "Method", "1"),
                textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(attachment.sizeBytes)),
                ...(attachment.contentId ? [textElement(WbxmlCodePage.AirSyncBase, "ContentId", attachment.contentId)] : []),
                textElement(WbxmlCodePage.AirSyncBase, "IsInline", attachment.isInline ? "1" : "0"),
            ]),
        ),
    );
}

/** MS-ASEMAIL `MeetingRequest` - see this file's own doc comment for the pragmatic-subset fields this
 * deliberately omits (`Recurrences`/`GlobalObjId`/`TimeZone`) and why `BusyStatus`/`Sensitivity` are fixed. Only
 * called once `resolveMeetingRequests()` has already confirmed `parsed.startDate`/`endDate` are both present. */
function meetingRequestElement(parsed: ParsedIcsEvent): WbxmlElement {
    return element(WbxmlCodePage.Email, "MeetingRequest", [
        textElement(WbxmlCodePage.Email, "DtStamp", toCompactDateTime(parsed.dtstamp ?? new Date())),
        textElement(WbxmlCodePage.Email, "StartTime", toCompactDateTime(parsed.startDate!)),
        textElement(WbxmlCodePage.Email, "EndTime", toCompactDateTime(parsed.endDate!)),
        textElement(WbxmlCodePage.Email, "AllDayEvent", inviteIsAllDay(parsed) ? "1" : "0"),
        ...(parsed.location ? [textElement(WbxmlCodePage.Email, "Location", parsed.location)] : []),
        ...(parsed.organizer?.address ? [textElement(WbxmlCodePage.Email, "Organizer", parsed.organizer.address)] : []),
        textElement(WbxmlCodePage.Email, "BusyStatus", "2"),
        textElement(WbxmlCodePage.Email, "Sensitivity", "0"),
        textElement(WbxmlCodePage.Email, "InstanceType", parsed.recurrenceRule ? "1" : "0"),
        textElement(WbxmlCodePage.Email, "ResponseRequested", "1"),
        textElement(WbxmlCodePage.Email, "DisallowNewTimeProposal", "0"),
    ]);
}

/** Parses a `;`/`,`-separated address list (`"Name <a@x.com>; b@y.com"`, or the bare-address-only form this
 * adapter's own `toApplicationData` emits) into `Recipient`s of `type`. */
function parseAddressList(value: string, type: RecipientType): Recipient[] {
    return value
        .split(/[;,]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => {
            const match = /^(.*)<(.+)>$/.exec(part);
            return match
                ? { address: match[2].trim(), displayName: match[1].trim() || undefined, type }
                : { address: part, type };
        });
}

/** Strips CR/LF from a value about to be interpolated into a single RFC 5322 header line. `Subject`/`To`/`Cc`
 * arrive from client-controlled WBXML inline strings (`WbxmlDecoder.readCString()`, which terminates only on a
 * NUL byte - literal `\r`/`\n` bytes pass through untouched), so without this a crafted value like
 * `"Hi\r\nBcc: attacker@evil.com"` would inject an arbitrary extra header line (or, via a blank line, a forged
 * second message) into the constructed MIME below. Folds onto a single line rather than rejecting outright -
 * a real device is never expected to send this, but a header value silently losing its embedded newlines is
 * safer than the request failing outright over what a client will never notice either way. */
function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n]+/g, " ");
}

/** Builds a minimal, valid RFC 5322 plain-text message - just enough structure for `simpleParser` (used by
 * `ItemOperationsCommand.fetchMessage`) to read it back correctly. No multipart/HTML/attachments - matches this
 * adapter's own documented pragmatic-subset scope. */
function buildPlainTextMime(parts: { subject: string; from?: Recipient; recipients: Recipient[]; date: Date; text: string }): string {
    const to = parts.recipients.filter((r) => r.type === RecipientType.TO).map((r) => formatAddress(r.address, r.displayName));
    const cc = parts.recipients.filter((r) => r.type === RecipientType.CC).map((r) => formatAddress(r.address, r.displayName));
    const bcc = parts.recipients.filter((r) => r.type === RecipientType.BCC).map((r) => formatAddress(r.address, r.displayName));
    const headers = [
        ...(parts.from ? [`From: ${sanitizeHeaderValue(formatAddress(parts.from.address, parts.from.displayName))}`] : []),
        ...(to.length > 0 ? [`To: ${sanitizeHeaderValue(to.join(", "))}`] : []),
        ...(cc.length > 0 ? [`Cc: ${sanitizeHeaderValue(cc.join(", "))}`] : []),
        ...(bcc.length > 0 ? [`Bcc: ${sanitizeHeaderValue(bcc.join(", "))}`] : []),
        `Subject: ${sanitizeHeaderValue(parts.subject)}`,
        `Date: ${parts.date.toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
    ];
    return `${headers.join("\r\n")}\r\n\r\n${parts.text}`;
}
