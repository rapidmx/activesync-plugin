///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { simpleParser } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ModelUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import {
    asEntity,
    type Attendee,
    AttendeeResponseStatus,
    type BlobStore,
    boundIndexedValue,
    buildEventIcs,
    type CalendarEvent,
    hasMailAccess,
    type Mailbox,
    type Message,
    parseIcsEvent,
    RecoverableRepoUtils,
    type TransportResult,
} from "@rapidmx/restapi";
import { isOrganizedBy } from "../adapters/CalendarSyncAdapter.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** MS-ASCMD `UserResponse`: 1=Accepted, 2=Tentatively accepted, 3=Declined. */
const USER_RESPONSE_STATUS: Record<string, AttendeeResponseStatus> = {
    "1": AttendeeResponseStatus.ACCEPTED,
    "2": AttendeeResponseStatus.TENTATIVE,
    "3": AttendeeResponseStatus.DECLINED,
};

const USER_RESPONSE_LABEL: Record<string, string> = { "1": "Accepted", "2": "Tentative", "3": "Declined" };

const USER_RESPONSE_DECLINED = "3";

/** MS-ASCMD `MeetingResponse` `Result/Status` values this command reports. */
const STATUS_SUCCESS = "1";
const STATUS_INVALID_REQUEST = "2";
const STATUS_MAILBOX_ERROR = "3";
const STATUS_SERVER_ERROR = "4";

/** Most `Request` elements one `MeetingResponse` may carry. */
export const MAX_MEETING_RESPONSES = 100;

type StoredEvent = CalendarEvent & { uid: string; version: number };

/**
 * Handles EAS `MeetingResponse`: records the caller's own accept/tentative/decline response to each meeting the
 * request's `<Request>` elements name, each answered with its own `<Result>`.
 *
 * **`RequestId`** is either the `CalendarEvent.uid` (a response from the calendar) or the `Message.uid` of the
 * meeting request in the Inbox (a response from the mail view - what most clients send). For a message, the
 * caller needs `READ` on its folder; its `text/calendar` part's `UID` is then resolved to the caller's own copy of
 * the event (`icalUid` within the caller's mailbox) - looked up bounded (`boundIndexedValue`, as restapi stores it) and
 * exact-matched in memory, since the UID is sender-controlled text a query parser could read as an operator.
 *
 * **Someone else's calendar**: whether a copy is the organizer's is judged against the event's own mailbox, not the
 * caller's. A response to an event in another mailbox (a delegate with `UPDATE` on it) is refused with Status 2 when
 * that event is its owner's organizer copy - it can only ever be an attendee copy. Updates are version-checked on both
 * backends (`asEntity`).
 *
 * **Effect**: the caller must be an attendee and have `UPDATE` on the event's folder. Accept/Tentative update
 * the caller's `Attendee.responseStatus`. A decline removes the caller's own copy of the event (matching Exchange)
 * when the caller also has `DELETE` on the folder, and otherwise just records the declined status - a delegate
 * with edit-only rights can't delete. Each mailbox has its own event row, so neither touches the organizer's or
 * any other attendee's copy. `CalendarId` is omitted for a removed event. Since the caller's copy is an attendee's copy
 * of someone else's meeting, neither write may look like the organizer acting to restapi's `MeetingSchedulingJob`:
 * a removed copy is stamped `cancelNoticeSentAt` first (no CANCEL mailed as the organizer), and an updated copy keeps
 * `inviteSequenceSent` equal to its `sequence` (no REQUEST).
 *
 * **Reply to the organizer**: in protocol 16.x the client asks the server to notify the organizer with
 * `SendResponse`; when it's present an iTIP `REPLY` (built with restapi's `buildEventIcs`, the same payload
 * `BaseCalendarEventRoute.respond` sends) is mailed from the caller's attendee address to the organizer,
 * and a transport that accepts none of it (or rejects the organizer) is reported as Status 4 - the response itself is
 * already recorded, so a retry only re-sends the reply. Without it (14.x clients send their own reply via `SendMail`) nothing is mailed, so the organizer
 * never receives two replies.
 *
 * Failures are per request: an unknown/unresolvable meeting, a meeting the caller may not respond to, or a
 * malformed `Request` gets Status 2 (indistinguishable, so nothing about other mailboxes leaks); a failed write
 * Status 3.
 *
 * `calendarEventClass`/`mailboxClass`/`messageClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MeetingResponseCommand implements EasCommandHandler {
    public readonly command = "MeetingResponse";

    protected abstract calendarEventClass: any;
    protected abstract mailboxClass: any;
    protected abstract messageClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private calendarEventRepo?: RecoverableRepoUtils<any>;
    private mailboxRepo?: RepoUtils<any>;
    private messageRepo?: RepoUtils<any>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    /** Roles `ACLUtils.hasPermission()` treats as always-permitted, which must never apply to another user's
     * mail - see `SyncCommand`'s identical field for the full rationale (restapi's own `MailAccessUtils.ts`). */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Logger
    private logger: any;

    @Init
    public async init(): Promise<void> {
        this.calendarEventRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.calendarEventClass.name,
            args: [this.calendarEventClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.calendarEventRepo || !this.mailboxRepo || !this.messageRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const requestEls = ctx.request ? findChildren(ctx.request, "Request") : [];
        if (requestEls.length === 0 || requestEls.length > MAX_MEETING_RESPONSES) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const mailbox: Mailbox | undefined = await this.mailboxRepo.findOne(ctx.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const results: WbxmlElement[] = [];
        for (const requestEl of requestEls) {
            results.push(await this.respond(ctx, mailbox, requestEl));
        }
        return element(WbxmlCodePage.MeetingResponse, "MeetingResponse", results);
    }

    private result(requestId: string | undefined, status: string, calendarId?: string): WbxmlElement {
        return element(WbxmlCodePage.MeetingResponse, "Result", [
            ...(requestId ? [textElement(WbxmlCodePage.MeetingResponse, "RequestId", requestId)] : []),
            textElement(WbxmlCodePage.MeetingResponse, "Status", status),
            ...(calendarId ? [textElement(WbxmlCodePage.MeetingResponse, "CalendarId", calendarId)] : []),
        ]);
    }

    private async respond(ctx: EasCommandContext, mailbox: Mailbox, requestEl: WbxmlElement): Promise<WbxmlElement> {
        const userResponse: string | undefined = childText(requestEl, "UserResponse");
        const requestId: string | undefined = childText(requestEl, "RequestId");
        if (!userResponse || !requestId || !USER_RESPONSE_STATUS[userResponse]) {
            return this.result(requestId, STATUS_INVALID_REQUEST);
        }

        const event: StoredEvent | undefined = await this.resolveEvent(ctx, requestId);
        if (!event || !(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, event.folderUid, ACLAction.UPDATE))) {
            return this.result(requestId, STATUS_INVALID_REQUEST);
        }

        const callerAddresses = new Set([mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].map((a) => a.toLowerCase()));
        const attendeeIndex = event.attendees.findIndex((attendee) => callerAddresses.has(attendee.address.toLowerCase()));
        if (attendeeIndex === -1) {
            return this.result(requestId, STATUS_INVALID_REQUEST);
        }
        const updatedAttendee: Attendee = { ...event.attendees[attendeeIndex], responseStatus: USER_RESPONSE_STATUS[userResponse] };

        // Whose copy this is decides whether it's the organizer's: the event's own mailbox, which for a delegate
        // responding in someone else's calendar is not the caller's. A delegate never responds on (and so never
        // deletes, or re-invites from) the owner's organizer copy of a meeting.
        const owner: Mailbox | undefined =
            event.mailboxUid === ctx.mailboxUid ? mailbox : await this.mailboxRepo!.findOne(event.mailboxUid, { ignoreACL: true });
        if (!owner) {
            return this.result(requestId, STATUS_INVALID_REQUEST);
        }
        const attendeeCopy: boolean = !isOrganizedBy(event, owner);
        if (!attendeeCopy && owner !== mailbox) {
            return this.result(requestId, STATUS_INVALID_REQUEST);
        }
        let removed = false;
        try {
            if (userResponse === USER_RESPONSE_DECLINED && (await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, event.folderUid, ACLAction.DELETE))) {
                if (attendeeCopy && event.cancelNoticeSentAt == null) {
                    await this.calendarEventRepo!.update(
                        { uid: event.uid, version: event.version, cancelNoticeSentAt: new Date() } as any,
                        asEntity(this.calendarEventRepo!, event),
                        { ignoreACL: true, user: ctx.user },
                    );
                }
                await this.calendarEventRepo!.delete(event.uid, { ignoreACL: true, user: ctx.user });
                removed = true;
            } else {
                const attendees = event.attendees.map((attendee, i) => (i === attendeeIndex ? updatedAttendee : attendee));
                const inviteSequence =
                    attendeeCopy && event.inviteSequenceSent !== event.sequence ? { inviteSequenceSent: event.sequence ?? 0 } : {};
                await this.calendarEventRepo!.update(
                    { uid: event.uid, version: event.version, attendees, ...inviteSequence } as any,
                    asEntity(this.calendarEventRepo!, event),
                    { ignoreACL: true, user: ctx.user },
                );
            }
        } catch (err: any) {
            this.logger?.warn(`MeetingResponseCommand: failed to record response to event ${event.uid}: ${err?.message}`);
            return this.result(requestId, STATUS_MAILBOX_ERROR);
        }

        if (findChild(requestEl, "SendResponse") && !(await this.sendReply(mailbox, event, updatedAttendee, userResponse))) {
            return this.result(requestId, STATUS_SERVER_ERROR, removed ? undefined : event.uid);
        }

        return this.result(requestId, STATUS_SUCCESS, removed ? undefined : event.uid);
    }

    /** Resolves `requestId` to the caller's event: an event uid directly, or a meeting request message's
     * `text/calendar` `UID` looked up among the caller's own mailbox's events. */
    private async resolveEvent(ctx: EasCommandContext, requestId: string): Promise<StoredEvent | undefined> {
        const direct: StoredEvent | undefined = await this.calendarEventRepo!.findOne(requestId, { ignoreACL: true });
        if (direct) {
            return direct;
        }
        const message: Message | undefined = await this.messageRepo!.findOne(requestId, { ignoreACL: true });
        if (!message || !(await hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, message.folderUid, ACLAction.READ))) {
            return undefined;
        }
        const icalUid: string | undefined = await this.meetingUidOf(message);
        if (!icalUid) {
            return undefined;
        }
        // The UID is sender-controlled: looked up bounded (restapi stores `icalUid` through `boundIndexedValue()`) as a
        // `ModelUtils.literal()`, and exact-matched in memory as restapi's `ScanQueueJob.findCalendarEventRows()` does -
        // a UID like `ne(x)` must never be parsed as a query operator and select (and let a decline delete) a different
        // meeting.
        const key: string = boundIndexedValue(icalUid);
        const events: StoredEvent[] = (
            await this.calendarEventRepo!.find({ mailboxUid: ctx.mailboxUid, icalUid: ModelUtils.literal(key), limit: 50 } as any, {
                ignoreACL: true,
                limit: 50,
            })
        ).filter((row: StoredEvent) => row.icalUid === key && row.mailboxUid === ctx.mailboxUid);
        // The series master (no `recurrenceId`) is what a response to the whole invitation applies to.
        return events.find((candidate) => !candidate.recurrenceId) ?? events[0];
    }

    /** The iCalendar `UID` of a meeting request message's `text/calendar` part, if it has one. */
    private async meetingUidOf(message: Message): Promise<string | undefined> {
        try {
            const parsed = await simpleParser(await this.blobStore!.get(message.bodyBlobKey));
            const calendarPart = parsed.attachments.find((part) => part.contentType === "text/calendar");
            return calendarPart ? parseIcsEvent(calendarPart.content.toString("utf-8"))?.uid : undefined;
        } catch {
            return undefined;
        }
    }

    /** Mails an iTIP `REPLY` for `attendee`'s response to the event's organizer. Returns `false` (after logging) when
     * the transport threw or didn't accept the message for the organizer - checked the way restapi's `sendOrThrow`
     * does, since every bundled transport reports a relay failure through `TransportResult.rejected` rather than
     * throwing. */
    private async sendReply(mailbox: Mailbox, event: StoredEvent, attendee: Attendee, userResponse: string): Promise<boolean> {
        try {
            const ics = buildEventIcs({ ...event, attendees: [attendee] }, "REPLY", { onlyAttendee: attendee });
            const boundary = `eas-${crypto.randomUUID()}`;
            const subject = `${USER_RESPONSE_LABEL[userResponse]}: ${event.title}`.replace(/[\r\n]+/g, " ");
            const fromName = (mailbox.displayName ?? "").replace(/[\r\n"]+/g, " ");
            const raw = [
                `From: "${fromName}" <${attendee.address}>`,
                `To: <${event.organizer.address}>`,
                `Subject: ${subject}`,
                `Date: ${new Date().toUTCString()}`,
                `Message-ID: <${crypto.randomUUID()}@eas>`,
                "MIME-Version: 1.0",
                `Content-Type: multipart/alternative; boundary="${boundary}"`,
                "",
                `--${boundary}`,
                "Content-Type: text/plain; charset=utf-8",
                "",
                `${attendee.displayName ?? attendee.address} has responded ${USER_RESPONSE_LABEL[userResponse].toLowerCase()} to: ${event.title}`,
                `--${boundary}`,
                'Content-Type: text/calendar; charset=utf-8; method=REPLY',
                "",
                ics,
                `--${boundary}--`,
                "",
            ].join("\r\n");
            const result: TransportResult | undefined = await this.mailTransport.send({
                raw: Buffer.from(raw, "utf-8"),
                envelopeFrom: attendee.address,
                envelopeTo: [event.organizer.address],
            });
            if (!result || (result.accepted ?? []).length === 0 || (result.rejected ?? []).length > 0) {
                this.logger?.warn(`MeetingResponseCommand: the mail transport did not accept the iTIP REPLY for event ${event.uid}`);
                return false;
            }
            return true;
        } catch (err: any) {
            this.logger?.warn(`MeetingResponseCommand: failed to send iTIP REPLY for event ${event.uid}: ${err?.message}`);
            return false;
        }
    }
}
