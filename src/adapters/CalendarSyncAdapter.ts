///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ModelUtils, type RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { fromCompactDateTime, toCompactDateTime } from "../CompactDateTime.js";
import { isProtocol16OrLater } from "../EasCommandHandler.js";
import type { EasCollectionSyncAdapter, SyncBodyPreference, SyncRenderContext } from "./EasCollectionSyncAdapter.js";
import { isPlainAddress, safeDisplayName } from "../MimeHeaderUtils.js";
import { allDayDateToLocalMidnight, allDayInstantToDate, decodeTimeZone, encodeTimeZone } from "../TimeZoneInfo.js";
import {
    asEntity,
    AttendeeResponseStatus,
    AttendeeRole,
    boundIndexedValue,
    BusyStatus,
    type CalendarEvent,
    type RecurrenceRule,
    RecurrenceFrequency,
    RecipientType,
    resolveTimeZone,
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
 * **Time zones** (`Timezone`, the base64 Win32 structure - see `TimeZoneInfo.ts`): every timed event carries its own
 * zone (`CalendarEvent.timezone`, else the mailbox's, else UTC), which is what lets a device expand a recurring series
 * at the right wall-clock time across daylight saving changes and on the right local weekday; `StartTime`/`EndTime`
 * stay absolute UTC instants. A device's `Timezone` on `Add`/`Change` is decoded back to an IANA zone and stored.
 *
 * **All-day events** are stored as the UTC midnights of their dates (restapi's convention, which recurrence expansion
 * relies on), and go over the wire per the client's protocol version (MS-ASCAL `AllDayEvent`): from 16.0 with no
 * `Timezone` and date-only `StartTime`/`EndTime`/`Until` (time 00:00:00Z), which the device shows on those dates
 * whatever zone it is in; before 16.0 as the instants the dates' local midnights fall at in the event's zone, beside
 * that zone's `Timezone`. Either form the device sends back is read to the same stored dates (`allDayInstantToDate()`).
 *
 * **Pragmatic subset, deliberately not the full MS-ASCAL semantics**:
 * - `Sensitivity` is always reported `0` (Normal) - this library's `CalendarEvent` has no privacy dimension of
 * its own to source a real value from.
 * - Recurrence patterns keyed by an ordinal weekday (MS-ASCAL `Type` 3/6, e.g. "the 2nd Tuesday of the month")
 * are not emitted - see `RECURRENCE_TYPE_CODES`'s own doc comment.
 * - Recurrence exceptions (individually modified/cancelled occurrences of a recurring series) are not synced in the
 * *series'* own `Recurrence` element - a device `Change` of the recurrence keeps the series' existing exceptions
 * rather than wiping them. A single occurrence is instead targeted directly via `airsyncbase:InstanceId` on a
 * `Sync` `Change`/`Delete` (protocol 16.0+ - see `changeInstance`/`deleteInstance`), the actual MS-ASAIRS
 * mechanism a real device (confirmed live) uses for "edit/delete just this occurrence" - which is the only
 * reason this now needs `RepoUtils`/`asEntity`/`ModelUtils` at all.
 *
 * @author Jean-Philippe Steinmetz
 */
export class CalendarSyncAdapter implements EasCollectionSyncAdapter<CalendarEvent> {
    public readonly collectionClass = "Calendar";

    public toApplicationData(event: CalendarEvent, _bodyPreference?: SyncBodyPreference, render?: SyncRenderContext): WbxmlElement {
        const hasAttendees = event.attendees.length > 0;
        const zone: string = resolveTimeZone(event.timezone) ?? resolveTimeZone(render?.mailboxTimezone) ?? "UTC";
        // See this class's doc comment: an all-day event is floating dates from 16.0, local midnights before it.
        const floating: boolean = event.allDay && isProtocol16OrLater(render?.protocolVersion);
        const wireTime = (value: Date | string): Date => {
            if (!event.allDay) {
                return new Date(value);
            }
            const date = allDayInstantToDate(new Date(value), zone);
            return floating ? date : allDayDateToLocalMidnight(date, zone);
        };

        return element(WbxmlCodePage.AirSync, "ApplicationData", [
            ...(floating ? [] : [textElement(WbxmlCodePage.Calendar, "Timezone", encodeTimeZone(zone, new Date(event.startDate)))]),
            textElement(WbxmlCodePage.Calendar, "Subject", event.title),
            ...(event.location ? [textElement(WbxmlCodePage.Calendar, "Location", event.location)] : []),
            textElement(WbxmlCodePage.Calendar, "StartTime", toCompactDateTime(wireTime(event.startDate))),
            textElement(WbxmlCodePage.Calendar, "EndTime", toCompactDateTime(wireTime(event.endDate))),
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
            ...(event.recurrenceRule
                ? [this.recurrenceElement(event.recurrenceRule, new Date(event.startDate), event.allDay ? "UTC" : zone, wireTime)]
                : []),
        ]);
    }

    /** `dayZone` is the zone the start date's day and month are read in - the event's own for a timed event, UTC for an
     * all-day one (whose stored dates are UTC midnights). `untilOnWire` puts `Until` in the same form as `StartTime`. */
    private recurrenceElement(rule: RecurrenceRule, startDate: Date, dayZone: string, untilOnWire: (until: Date | string) => Date): WbxmlElement {
        const dayOfWeekBits = (rule.byDay ?? []).reduce((sum, day) => sum + (DAY_OF_WEEK_BITS[day] ?? 0), 0);
        // A rule without an explicit day/month recurs on the start date's day/month *as the event's own timezone
        // sees it* - an evening event east of UTC falls on the previous UTC day.
        const local = localDayAndMonth(startDate, dayZone);

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
            ...(rule.until ? [textElement(WbxmlCodePage.Calendar, "Until", toCompactDateTime(untilOnWire(rule.until)))] : []),
            // See the identical `!= null` reasoning on `reminderMinutesBeforeStart` above.
            ...(rule.count != null ? [textElement(WbxmlCodePage.Calendar, "Occurrences", String(rule.count))] : []),
        ]);
    }

    /**
     * Reverse of `toApplicationData`. `status`/`icalUid` have no wire representation at all and are never included in
     * the returned partial - `newEntityDefaults()` supplies `icalUid`/`sequence` for a brand new event, and a `Change`
     * merges onto `existing`. `timezone` and all-day dates: see `applyTimeZone()`.
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
        if (recurrenceEl && childText(recurrenceEl, "Type") === undefined) {
            // A `Recurrence` without a `Type` is how iOS describes an event that doesn't repeat (it sends one on every
            // Add) - no rule, and on a Change a series made non-repeating loses its rule.
            if (existing?.recurrenceRule) {
                partial.recurrenceRule = null as any;
            }
        } else if (recurrenceEl) {
            partial.recurrenceRule = {
                ...this.recurrenceRuleFromElement(recurrenceEl),
                exceptions: existing?.recurrenceRule?.exceptions ?? [],
            };
        }

        this.applyTimeZone(el, partial, existing, mailbox);

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

    /**
     * The zone and all-day dates of a device's `Add`/`Change` (see this class's doc comment). A `Timezone` is decoded to
     * an IANA zone, preferring the event's current zone and then the mailbox's when they describe the same rules; one
     * that can't be decoded leaves the zone as it was. A new event without one (an all-day event from 16.0, which carries
     * none) gets the mailbox's zone. An all-day event's `StartTime`/`EndTime`/`Until` - date-only from 16.0, local
     * midnights before it - are stored as the UTC midnights of their dates, read in that zone. An `AllDayEvent` change sent
     * without new times keeps the stored ones: a device sends them together.
     */
    private applyTimeZone(el: WbxmlElement, partial: Partial<CalendarEvent>, existing: CalendarEvent | undefined, mailbox: Mailbox | undefined): void {
        const timezoneValue = childText(el, "Timezone");
        if (timezoneValue !== undefined) {
            const reference: Date = partial.startDate ?? (existing ? new Date(existing.startDate) : new Date());
            const decoded = decodeTimeZone(timezoneValue, reference, [existing?.timezone, mailbox?.timezone]);
            if (decoded) {
                partial.timezone = decoded;
            }
        }
        if (!existing && partial.timezone === undefined) {
            const mailboxZone = resolveTimeZone(mailbox?.timezone);
            if (mailboxZone) {
                partial.timezone = mailboxZone;
            }
        }
        if (!(partial.allDay ?? existing?.allDay)) {
            return;
        }
        const zone: string | undefined = partial.timezone ?? existing?.timezone ?? mailbox?.timezone;
        if (partial.startDate) {
            partial.startDate = allDayInstantToDate(partial.startDate, zone);
        }
        if (partial.endDate) {
            partial.endDate = allDayInstantToDate(partial.endDate, zone);
        }
        if (partial.recurrenceRule?.until) {
            partial.recurrenceRule.until = allDayInstantToDate(new Date(partial.recurrenceRule.until), zone);
        }
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

    /**
     * MS-ASAIRS `InstanceId` on a `Sync` `Change`: edits one occurrence of `master`'s recurring series via
     * `ensureCalendarOccurrence()` (shared with `MeetingResponseCommand`'s own identical `InstanceId` handling -
     * see that function's own doc comment for exactly how the occurrence's own row is found or created), then
     * applies `appData` to it the same way a whole-series `Change` applies to the series itself - `existing` is
     * the occurrence's own row either way, so `fromApplicationData`'s ghosting ("unset means unchanged") already
     * does the right thing with no special-casing here.
     */
    public async changeInstance(master: CalendarEvent, instanceId: string, appData: WbxmlElement, repo: RepoUtils<CalendarEvent>, mailbox: Mailbox): Promise<void> {
        const occurrence = await ensureCalendarOccurrence(repo, master, fromCompactDateTime(instanceId));
        const partial = this.fromApplicationData(appData, occurrence, mailbox);
        await repo.update({ uid: occurrence.uid, version: occurrence.version, ...partial }, asEntity(repo, occurrence), { ignoreACL: true });
    }

    /**
     * MS-ASAIRS `InstanceId` on a `Sync` `Delete`: cancels one occurrence of `master`'s recurring series rather
     * than the whole series. An occurrence already individually modified (`changeInstance` created its own
     * override row) has that row deleted directly; one never touched is instead recorded in the series' own
     * `recurrenceRule.exceptions` (`CalendarSyncAdapter.toApplicationData()`/`recurrenceElement()` never emits
     * `Exceptions` to the device - MS-ASCAL's own `Recurrence` has no such child, EAS drops a cancelled
     * occurrence purely by the device never resolving a `ServerId` for it again, the same mechanism a real
     * Exchange server uses). Uses `findCalendarOccurrence()` directly, not `ensureCalendarOccurrence()` - a
     * never-touched occurrence being deleted has no reason to first create a row just to delete it again.
     */
    public async deleteInstance(master: CalendarEvent, instanceId: string, repo: RepoUtils<CalendarEvent>): Promise<void> {
        const recurrenceId = fromCompactDateTime(instanceId);
        const override = await findCalendarOccurrence(repo, master, recurrenceId);
        if (override) {
            await repo.delete(override.uid, { ignoreACL: true });
            return;
        }
        const exceptions = [...(master.recurrenceRule?.exceptions ?? []), recurrenceId];
        await repo.update(
            { uid: master.uid, version: master.version, recurrenceRule: { ...master.recurrenceRule!, exceptions } },
            asEntity(repo, master),
            { ignoreACL: true },
        );
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

/** Finds `master`'s own override row (if any) for the occurrence starting at `recurrenceId` - MS-ASAIRS
 * `InstanceId`'s target, shared between `CalendarSyncAdapter.deleteInstance()` and `MeetingResponseCommand`'s
 * own identical `InstanceId` handling. Queried by `mailboxUid`/`icalUid` only (no backend indexes or supports
 * exact-`Date` equality in a query, confirmed against this repo's own `recurrenceIdsMatch()` precedent in
 * restapi's `ScanQueueJob`, which takes the same two-step approach), then matched in memory by `getTime()` to
 * dodge any Mongo/SQL date-representation inconsistency a DB-level predicate would risk. */
export async function findCalendarOccurrence(repo: RepoUtils<CalendarEvent>, master: CalendarEvent, recurrenceId: Date): Promise<CalendarEvent | undefined> {
    const rows: CalendarEvent[] = await repo.find({ mailboxUid: master.mailboxUid, icalUid: ModelUtils.literal(master.icalUid), limit: 50 } as any, { ignoreACL: true, limit: 50 });
    return rows.find((row) => row.recurrenceId && new Date(row.recurrenceId).getTime() === recurrenceId.getTime());
}

/** `findCalendarOccurrence()`, creating the occurrence's own override row when none exists yet - a full copy
 * of `master`'s own current fields (every field but its identity/bookkeeping ones: `uid`/`dateCreated`/
 * `dateModified`/`version`/`deleted`), sharing `master`'s `icalUid`, `recurrenceId` set to the occurrence's
 * own start, and no `Recurrence` of its own since the series still owns the pattern. Used wherever an
 * `InstanceId`-targeted write needs *a* row for this occurrence to act on, whether or not the device (or, for
 * `MeetingResponseCommand`, the caller's own response) has touched it before. */
export async function ensureCalendarOccurrence(repo: RepoUtils<CalendarEvent>, master: CalendarEvent, recurrenceId: Date): Promise<CalendarEvent> {
    const existing = await findCalendarOccurrence(repo, master, recurrenceId);
    if (existing) {
        return existing;
    }
    const { uid: _uid, dateCreated: _dateCreated, dateModified: _dateModified, version: _version, deleted: _deleted, ...base } = master as any;
    return repo.create({ ...base, recurrenceId, recurrenceRule: undefined }, { ignoreACL: true });
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
