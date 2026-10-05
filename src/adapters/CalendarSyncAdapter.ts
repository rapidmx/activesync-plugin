///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { fromCompactDateTime, toCompactDateTime } from "../CompactDateTime.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import { isPlainAddress, safeDisplayName } from "../MimeHeaderUtils.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    boundIndexedValue,
    BusyStatus,
    type CalendarEvent,
    type RecurrenceRule,
    RecurrenceFrequency,
    RecipientType,
    type Attendee,
    type Mailbox,
} from "@rapidmx/restapi";

/** Most attendees one event may carry from a device - restapi's `MAX_EVENT_ATTENDEES` (REST calendar writes) and
 * `MeetingSchedulingJob`'s default `max_attendees`, and the MAPI plugin's cap. The job mails every attendee, so an
 * unbounded list would make one Sync item a bulk mailing. */
export const MAX_CALENDAR_ATTENDEES = 500;

/** Builds the reverse of a forward code-table once at module load, rather than re-deriving it per call. */
function invert<K extends string>(table: Record<K, string>): Record<string, K> {
    return Object.fromEntries(Object.entries(table).map(([k, v]) => [v, k])) as Record<string, K>;
}

/** MS-ASCAL `BusyStatus`: 0=Free, 1=Tentative, 2=Busy, 3=Out of Office. Confirmed against the published
 * MS-ASCAL spec, not assumed - note the value order does not match this library's own `BusyStatus` enum
 * declaration order, so an identity/positional mapping would have been silently wrong. */
const BUSY_STATUS_CODES: Record<BusyStatus, string> = {
    [BusyStatus.FREE]: "0",
    [BusyStatus.TENTATIVE]: "1",
    [BusyStatus.BUSY]: "2",
    [BusyStatus.OUT_OF_OFFICE]: "3",
};

/** MS-ASCAL `AttendeeStatus`: 0=Response unknown, 2=Tentative, 3=Accept, 4=Decline, 5=Not responded. This
 * library's own `AttendeeResponseStatus.NEEDS_ACTION` maps to 0 (unknown) rather than 5 (not responded) - both
 * are defensible for "no response yet", and 0 is the spec's own documented fallback/default value. */
const ATTENDEE_STATUS_CODES: Record<AttendeeResponseStatus, string> = {
    [AttendeeResponseStatus.NEEDS_ACTION]: "0",
    [AttendeeResponseStatus.TENTATIVE]: "2",
    [AttendeeResponseStatus.ACCEPTED]: "3",
    [AttendeeResponseStatus.DECLINED]: "4",
};

/** MS-ASCAL `AttendeeType`: 1=Required, 2=Optional, 3=Resource. */
const ATTENDEE_TYPE_CODES: Record<AttendeeRole, string> = {
    [AttendeeRole.REQUIRED]: "1",
    [AttendeeRole.OPTIONAL]: "2",
    [AttendeeRole.RESOURCE]: "3",
};

/** MS-ASCAL `Recurrence.Type`: 0=Daily, 1=Weekly, 2=Monthly, 5=Yearly (3="monthly on the nth day" and
 * 6="yearly on the nth day" - patterns keyed by an ordinal weekday, e.g. "the 2nd Tuesday" - are a documented,
 * out-of-scope gap for this pragmatic subset; `RecurrenceRule` has no ordinal-weekday field to source them
 * from anyway, only plain day-of-month/day-of-week lists). */
const RECURRENCE_TYPE_CODES: Record<RecurrenceFrequency, string> = {
    [RecurrenceFrequency.DAILY]: "0",
    [RecurrenceFrequency.WEEKLY]: "1",
    [RecurrenceFrequency.MONTHLY]: "2",
    [RecurrenceFrequency.YEARLY]: "5",
};

/** MS-ASCAL `DayOfWeek` bitmask: Sunday=1, Monday=2, Tuesday=4, Wednesday=8, Thursday=16, Friday=32,
 * Saturday=64 - summed when a recurrence applies to more than one day. `RecurrenceRule.byDay` uses RFC 5545's
 * two-letter day codes. */
const DAY_OF_WEEK_BITS: Record<string, number> = { SU: 1, MO: 2, TU: 4, WE: 8, TH: 16, FR: 32, SA: 64 };

const BUSY_STATUS_FROM_CODE = invert(BUSY_STATUS_CODES);
const ATTENDEE_STATUS_FROM_CODE = invert(ATTENDEE_STATUS_CODES);
const ATTENDEE_TYPE_FROM_CODE = invert(ATTENDEE_TYPE_CODES);
const RECURRENCE_FREQUENCY_FROM_CODE = invert(RECURRENCE_TYPE_CODES);

/**
 * Maps `CalendarEvent` to/from the EAS `Sync` `Calendar` collection class (MS-ASCAL).
 *
 * **Pragmatic subset, deliberately not the full MS-ASCAL semantics**:
 * - `TimeZone` is not emitted - the real element is a base64-encoded binary Win32 `TIME_ZONE_INFORMATION`
 * structure, not a plain IANA string; `CalendarEvent.timezone` (an IANA identifier) can't be losslessly
 * re-encoded into that format without a full IANA-to-Windows zone mapping table, and a real device would
 * rather see no `TimeZone` element (falling back to its own default) than a malformed one.
 * - `Sensitivity` is always reported `0` (Normal) - this library's `CalendarEvent` has no privacy dimension of
 * its own to source a real value from.
 * - Recurrence patterns keyed by an ordinal weekday (MS-ASCAL `Type` 3/6, e.g. "the 2nd Tuesday of the month")
 * are not emitted - see `RECURRENCE_TYPE_CODES`'s own doc comment.
 * - Recurrence exceptions (individually modified/cancelled occurrences of a recurring series) are not synced to the
 * device; a device `Change` of the recurrence keeps the series' existing exceptions rather than wiping them.
 *
 * @author Jean-Philippe Steinmetz
 */
export class CalendarSyncAdapter implements EasCollectionSyncAdapter<CalendarEvent> {
    public readonly collectionClass = "Calendar";

    public toApplicationData(event: CalendarEvent): WbxmlElement {
        const hasAttendees = event.attendees.length > 0;

        return element(WbxmlCodePage.AirSync, "ApplicationData", [
            textElement(WbxmlCodePage.Calendar, "Subject", event.title),
            ...(event.location ? [textElement(WbxmlCodePage.Calendar, "Location", event.location)] : []),
            textElement(WbxmlCodePage.Calendar, "StartTime", toCompactDateTime(event.startDate)),
            textElement(WbxmlCodePage.Calendar, "EndTime", toCompactDateTime(event.endDate)),
            textElement(WbxmlCodePage.Calendar, "AllDayEvent", event.allDay ? "1" : "0"),
            textElement(WbxmlCodePage.Calendar, "DtStamp", toCompactDateTime(event.dateModified)),
            // `?? BUSY_STATUS_CODES[BusyStatus.FREE]` - a defensive fallback, not an expected case: `event.busyStatus`
            // is typed as the `BusyStatus` enum, but (like `reminderMinutesBeforeStart` above) a row written before
            // a later enum value existed, or by a path outside this library's own writers, could hold anything.
            // Per MS-ASCAL's own spec text "0=Free" is its documented default, the same reasoning this file already
            // uses for `ATTENDEE_STATUS_CODES`'s `NEEDS_ACTION` fallback below. A thrown render error here would -
            // see `SyncCommand.ts`'s own comment on why the render now runs before `saveState()` - still just fail
            // this one sync round rather than corrupt the device's cursor, but there is no reason to let a single
            // malformed field block the whole round when a safe default renders something usable instead.
            textElement(WbxmlCodePage.Calendar, "BusyStatus", BUSY_STATUS_CODES[event.busyStatus] ?? BUSY_STATUS_CODES[BusyStatus.FREE]),
            textElement(WbxmlCodePage.Calendar, "Sensitivity", "0"),
            textElement(WbxmlCodePage.Calendar, "MeetingStatus", hasAttendees ? "1" : "0"),
            // `event.organizer` is typed as a required `Recipient` (`CalendarEventMongo`/`SQL` both default it to
            // `{ address: "", type: RecipientType.TO }`), but that default is only ever applied by this library's
            // own entity constructors - a row written some other way (a direct DB write, an older migration) could
            // still hydrate it `null`/`undefined`, the same "TypeORM hands back `null` for an unset column" hazard
            // already documented on `reminderMinutesBeforeStart` below. Falls back to an empty organizer rather
            // than throwing and losing the whole sync round over one malformed item.
            textElement(WbxmlCodePage.Calendar, "OrganizerEmail", event.organizer?.address ?? ""),
            ...(event.organizer?.displayName
                ? [textElement(WbxmlCodePage.Calendar, "OrganizerName", event.organizer.displayName)]
                : []),
            ...(hasAttendees
                ? [
                      element(
                          WbxmlCodePage.Calendar,
                          "Attendees",
                          event.attendees.map((attendee) =>
                              element(WbxmlCodePage.Calendar, "Attendee", [
                                  textElement(WbxmlCodePage.Calendar, "Email", attendee.address),
                                  ...(attendee.displayName
                                      ? [textElement(WbxmlCodePage.Calendar, "Name", attendee.displayName)]
                                      : []),
                                  // Same defensive-fallback reasoning as `BusyStatus` above - a value outside the
                                  // known enum (rather than missing entirely) falls back to this spec's own
                                  // documented default instead of rendering `undefined` onto the wire or throwing.
                                  textElement(WbxmlCodePage.Calendar, "AttendeeType", ATTENDEE_TYPE_CODES[attendee.role] ?? ATTENDEE_TYPE_CODES[AttendeeRole.REQUIRED]),
                                  textElement(
                                      WbxmlCodePage.Calendar,
                                      "AttendeeStatus",
                                      ATTENDEE_STATUS_CODES[attendee.responseStatus] ?? ATTENDEE_STATUS_CODES[AttendeeResponseStatus.NEEDS_ACTION],
                                  ),
                              ]),
                          ),
                      ),
                  ]
                : []),
            // `!= null` (not `!== undefined`) deliberately - TypeORM hydrates an unset nullable SQL column as
            // `null`, not `undefined` (confirmed by a real test failure against the SQL backend: `undefined`
            // survives a Mongo round-trip for a genuinely-absent field, but SQL hands back `null` instead, and
            // a strict `!== undefined` check would then wrongly treat that "absent" value as present).
            ...(event.reminderMinutesBeforeStart != null
                ? [textElement(WbxmlCodePage.Calendar, "Reminder", String(event.reminderMinutesBeforeStart))]
                : []),
            ...(event.recurrenceRule ? [this.recurrenceElement(event.recurrenceRule, event.startDate, event.timezone)] : []),
        ]);
    }

    private recurrenceElement(rule: RecurrenceRule, startDate: Date, timezone: string): WbxmlElement {
        const dayOfWeekBits = (rule.byDay ?? []).reduce((sum, day) => sum + (DAY_OF_WEEK_BITS[day] ?? 0), 0);
        // A rule without an explicit day/month recurs on the start date's day/month *as the event's own timezone
        // sees it* - an evening event east of UTC falls on the previous UTC day.
        const local = localDayAndMonth(startDate, timezone);

        return element(WbxmlCodePage.Calendar, "Recurrence", [
            textElement(WbxmlCodePage.Calendar, "Type", RECURRENCE_TYPE_CODES[rule.freq]),
            textElement(WbxmlCodePage.Calendar, "Interval", String(rule.interval)),
            ...(rule.freq === RecurrenceFrequency.WEEKLY && dayOfWeekBits > 0
                ? [textElement(WbxmlCodePage.Calendar, "DayOfWeek", String(dayOfWeekBits))]
                : []),
            ...(rule.freq === RecurrenceFrequency.MONTHLY || rule.freq === RecurrenceFrequency.YEARLY
                ? [textElement(WbxmlCodePage.Calendar, "DayOfMonth", String(rule.byMonthDay?.[0] ?? local.day))]
                : []),
            ...(rule.freq === RecurrenceFrequency.YEARLY
                ? [textElement(WbxmlCodePage.Calendar, "MonthOfYear", String(rule.byMonth?.[0] ?? local.month))]
                : []),
            ...(rule.until ? [textElement(WbxmlCodePage.Calendar, "Until", toCompactDateTime(rule.until))] : []),
            // See the identical `!= null` reasoning on `reminderMinutesBeforeStart` above.
            ...(rule.count != null ? [textElement(WbxmlCodePage.Calendar, "Occurrences", String(rule.count))] : []),
        ]);
    }

    /**
     * Reverse of `toApplicationData`. `timezone`/`status`/`icalUid` have no wire representation at all and are
     * never included in the returned partial - `newEntityDefaults()` supplies `icalUid`/`sequence` for a brand new
     * event, and a `Change` merges onto `existing`.
     *
     * **Organizer** (`mailbox` = the caller's own mailbox, supplied by `SyncCommand`): a device can only create an
     * event organized by itself - on an `Add`, an `OrganizerEmail` that isn't one of the mailbox's own addresses (or
     * a missing one) is replaced by the mailbox's primary address, since the organizer is who iTIP invitations are
     * sent as. The organizer's display name is always the mailbox's own (`MimeHeaderUtils.safeDisplayName()`: omitted
     * when it looks like an address or has a line break) - never the device's `OrganizerName`, which invitations would
     * otherwise show as the sender's name (e.g. `payroll@corp.com`). On a `Change` the organizer is never reassigned (an
     * attendee's copy of someone else's meeting keeps its real organizer). Without a `mailbox` (direct use),
     * `OrganizerEmail` must be one plain address (`isPlainAddress()`) and `OrganizerName` is kept only when it passes the
     * same rule.
     *
     * **Attendees** match restapi's REST calendar validation (`BaseCalendarEventRoute.assertParticipants()`, 400 there):
     * each `Email` must be one plain address (`MimeHeaderUtils.isPlainAddress()`, so not a list like `a@x, b@y`), and at
     * most `MAX_CALENDAR_ATTENDEES` are accepted - refused, never truncated. As in restapi, on a `Change` only a changed
     * list is checked: a device re-sending exactly the addresses the event already has (e.g. an attendee copy filed with
     * a larger or odder list) still saves. A `Name` is kept only when `safeDisplayName()` allows it. A refusal throws,
     * which `SyncCommand` reports as Status 6.
     *
     * **Change merging** (`existing` given): `Attendees`/`Recurrence` are ghosted as a whole element - present ->
     * rebuilt from what's there, absent -> untouched - but a rebuilt attendee the event already had keeps the fields
     * the device didn't send (`AttendeeStatus`/`AttendeeType`/`Name`, and `isOrganizer`), and a rebuilt recurrence
     * keeps the series' existing exceptions (cancelled occurrences have no wire representation here). A change to the
     * time, location, attendees or recurrence bumps `sequence`, as `BaseCalendarEventRoute.update` does, so updated
     * invitations go out - but only on the organizer's copy: when `mailbox` (the item's owner on a `Change`) isn't
     * the organizer, `sequence` is left alone and `inviteSequenceSent` is kept equal to it, so an attendee editing
     * their own copy never makes `MeetingSchedulingJob` send invitations as the organizer.
     */
    public fromApplicationData(el: WbxmlElement, existing?: CalendarEvent, mailbox?: Mailbox): Partial<CalendarEvent> {
        const partial: Partial<CalendarEvent> = {};

        const subject = childText(el, "Subject");
        if (subject !== undefined) partial.title = subject;
        const location = childText(el, "Location");
        if (location !== undefined) partial.location = location;
        const startTime = childText(el, "StartTime");
        if (startTime !== undefined) partial.startDate = fromCompactDateTime(startTime);
        const endTime = childText(el, "EndTime");
        if (endTime !== undefined) partial.endDate = fromCompactDateTime(endTime);
        const allDayEvent = childText(el, "AllDayEvent");
        if (allDayEvent !== undefined) partial.allDay = allDayEvent === "1";
        const busyStatus = childText(el, "BusyStatus");
        if (busyStatus !== undefined) {
            const mapped = BUSY_STATUS_FROM_CODE[busyStatus];
            if (!mapped) {
                throw new Error(`Unrecognized BusyStatus value: '${busyStatus}'`);
            }
            partial.busyStatus = mapped;
        }

        const organizerEmail = childText(el, "OrganizerEmail");
        if (!existing && mailbox) {
            const own = new Set([mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].map((a) => a.toLowerCase()));
            partial.organizer = {
                address: organizerEmail !== undefined && own.has(organizerEmail.toLowerCase()) ? organizerEmail : mailbox.primarySmtpAddress,
                displayName: safeDisplayName(mailbox.displayName),
                type: RecipientType.TO,
            };
        } else if (!existing && organizerEmail !== undefined) {
            if (organizerEmail !== "" && !isPlainAddress(organizerEmail)) {
                throw new Error("OrganizerEmail must be a single plain email address.");
            }
            partial.organizer = {
                address: organizerEmail,
                displayName: safeDisplayName(childText(el, "OrganizerName")),
                type: RecipientType.TO,
            };
        }

        const reminder = childText(el, "Reminder");
        if (reminder !== undefined) partial.reminderMinutesBeforeStart = Number(reminder);

        const attendeesEl = findChild(el, "Attendees");
        if (attendeesEl) {
            const attendeeEls: WbxmlElement[] = attendeesEl.children.filter((child) => child.tag === "Attendee");
            const attendees: Attendee[] = attendeeEls.map((attendeeEl) => this.attendeeFromElement(attendeeEl, existing?.attendees));
            const addresses = (list: Attendee[] | undefined): string => JSON.stringify((list ?? []).map((attendee) => attendee.address));
            if (!existing || addresses(attendees) !== addresses(existing.attendees)) {
                if (attendees.length > MAX_CALENDAR_ATTENDEES) {
                    throw new Error(`An event may have at most ${MAX_CALENDAR_ATTENDEES} attendees.`);
                }
                if (!attendees.every((attendee) => isPlainAddress(attendee.address))) {
                    throw new Error("Attendee Email must be a single plain email address.");
                }
            }
            partial.attendees = attendees;
        }

        const recurrenceEl = findChild(el, "Recurrence");
        if (recurrenceEl) {
            partial.recurrenceRule = {
                ...this.recurrenceRuleFromElement(recurrenceEl),
                exceptions: existing?.recurrenceRule?.exceptions ?? [],
            };
        }

        if (existing && mailbox && !isOrganizedBy(existing, mailbox)) {
            // An attendee's copy: the attendee can't reschedule the organizer's meeting for everyone, so the sequence
            // stays put, and the copy is marked as already invited at it so MeetingSchedulingJob never mails a REQUEST
            // on the organizer's behalf because of this edit.
            if (existing.inviteSequenceSent !== existing.sequence) {
                partial.inviteSequenceSent = existing.sequence ?? 0;
            }
        } else if (existing && isSchedulingRelevantChange(existing, partial)) {
            partial.sequence = (existing.sequence ?? 0) + 1;
        }

        return partial;
    }

    /** Stamps `cancelNoticeSentAt` on an attendee's copy of a meeting before it is deleted, so the deletion is never
     * taken as the organizer cancelling the meeting (see `EasCollectionSyncAdapter.beforeDelete`). */
    public beforeDelete(existing: CalendarEvent, mailbox: Mailbox): Partial<CalendarEvent> | undefined {
        if (isOrganizedBy(existing, mailbox) || existing.cancelNoticeSentAt != null) {
            return undefined;
        }
        return { cancelNoticeSentAt: new Date() };
    }

    /** `icalUid`/`sequence` have no wire representation on `Add` (see `fromApplicationData`'s own doc comment)
     * - without this, every Sync-created event would fall back to `CalendarEventMongo`/`CalendarEventSQL`'s own
     * constructor default of `icalUid: ""`, violating RFC 5545's uniqueness expectation for `UID`. Mirrors
     * MAPI's identical `RopSaveChangesMessageHandler` pattern (`${crypto.randomUUID()}@mapi`), `@eas` suffix
     * instead. */
    public newEntityDefaults(): Partial<CalendarEvent> {
        return { icalUid: boundIndexedValue(`${crypto.randomUUID()}@eas`), sequence: 0 };
    }

    private attendeeFromElement(el: WbxmlElement, existingAttendees: Attendee[] = []): Attendee {
        const address = childText(el, "Email");
        if (!address) {
            throw new Error("Attendee element is missing its required Email child.");
        }
        const known = existingAttendees.find((attendee) => attendee.address.toLowerCase() === address.toLowerCase());
        const attendeeType = childText(el, "AttendeeType");
        const attendeeStatus = childText(el, "AttendeeStatus");
        return {
            address,
            displayName: safeDisplayName(childText(el, "Name") ?? known?.displayName),
            role: (attendeeType && ATTENDEE_TYPE_FROM_CODE[attendeeType]) || known?.role || AttendeeRole.REQUIRED,
            responseStatus:
                (attendeeStatus && ATTENDEE_STATUS_FROM_CODE[attendeeStatus]) || known?.responseStatus || AttendeeResponseStatus.NEEDS_ACTION,
            isOrganizer: known?.isOrganizer ?? false,
        };
    }

    private recurrenceRuleFromElement(el: WbxmlElement): RecurrenceRule {
        const type = childText(el, "Type");
        const freq = type && RECURRENCE_FREQUENCY_FROM_CODE[type];
        if (!freq) {
            throw new Error(`Unrecognized or unsupported Recurrence Type value: '${type}'`);
        }
        const interval = childText(el, "Interval");
        const dayOfWeek = childText(el, "DayOfWeek");
        const dayOfMonth = childText(el, "DayOfMonth");
        const monthOfYear = childText(el, "MonthOfYear");
        const until = childText(el, "Until");
        const occurrences = childText(el, "Occurrences");

        const byDay: string[] = [];
        if (dayOfWeek !== undefined) {
            const bits = Number(dayOfWeek);
            for (const [code, bit] of Object.entries(DAY_OF_WEEK_BITS)) {
                if ((bits & bit) !== 0) byDay.push(code);
            }
        }

        return {
            freq,
            interval: interval !== undefined ? Number(interval) : 1,
            ...(byDay.length > 0 ? { byDay } : {}),
            ...(dayOfMonth !== undefined ? { byMonthDay: [Number(dayOfMonth)] } : {}),
            ...(monthOfYear !== undefined ? { byMonth: [Number(monthOfYear)] } : {}),
            ...(until !== undefined ? { until: fromCompactDateTime(until) } : {}),
            ...(occurrences !== undefined ? { count: Number(occurrences) } : {}),
            exceptions: [],
        };
    }
}

/** The calendar day (1-31) and month (1-12) `date` falls on in IANA `timezone`, falling back to UTC for a zone
 * `Intl` doesn't recognize. */
export function localDayAndMonth(date: Date, timezone: string): { day: number; month: number } {
    try {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, day: "numeric", month: "numeric" }).formatToParts(date);
        return {
            day: Number(parts.find((part) => part.type === "day")!.value),
            month: Number(parts.find((part) => part.type === "month")!.value),
        };
    } catch {
        return { day: date.getUTCDate(), month: date.getUTCMonth() + 1 };
    }
}

/** `true` when `event`'s organizer is one of `mailbox`'s own addresses - the organizer's copy of a meeting, as opposed
 * to an attendee's copy of someone else's. An event without an organizer address counts as the mailbox's own. */
export function isOrganizedBy(event: CalendarEvent, mailbox: Mailbox): boolean {
    const organizer: string | undefined = event.organizer?.address?.toLowerCase();
    if (!organizer) {
        return true;
    }
    return [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].some((address) => address.toLowerCase() === organizer);
}

/** Normalizes a value for comparison - `null` (SQL) and `undefined` (Mongo) mean the same "unset". */
function comparable(value: unknown): string {
    return JSON.stringify(value ?? null);
}

/** `true` when `partial` changes anything invitations carry: time, location, attendees or recurrence. */
function isSchedulingRelevantChange(existing: CalendarEvent, partial: Partial<CalendarEvent>): boolean {
    const time = (value: Date | undefined) => (value ? new Date(value).getTime() : null);
    if (partial.startDate !== undefined && time(partial.startDate) !== time(existing.startDate)) return true;
    if (partial.endDate !== undefined && time(partial.endDate) !== time(existing.endDate)) return true;
    if (partial.location !== undefined && partial.location !== (existing.location ?? "")) return true;
    const attendeeKey = (attendees: Attendee[] | undefined) =>
        comparable((attendees ?? []).map((a) => [a.address.toLowerCase(), a.role, a.responseStatus]));
    if (partial.attendees !== undefined && attendeeKey(partial.attendees) !== attendeeKey(existing.attendees)) return true;
    const ruleKey = (rule: RecurrenceRule | undefined) =>
        rule
            ? comparable([rule.freq, rule.interval, rule.byDay ?? null, rule.byMonthDay ?? null, rule.byMonth ?? null, rule.count ?? null, time(rule.until)])
            : comparable(null);
    return partial.recurrenceRule !== undefined && ruleKey(partial.recurrenceRule) !== ruleKey(existing.recurrenceRule);
}
