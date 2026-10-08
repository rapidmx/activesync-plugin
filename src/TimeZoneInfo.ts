///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { convertLocalToUtc, currentIanaZone, ianaZoneForWindowsZone, resolveTimeZone, windowsZoneForIanaZone } from "@rapidmx/restapi";

/**
 * MS-ASDTYPE `TimeZone` - the Win32 `TIME_ZONE_INFORMATION` structure EAS carries base64-encoded in
 * `calendar:Timezone` and `email:TimeZone`, converted to and from the IANA zone names this server stores
 * (`CalendarEvent.timezone`, `Mailbox.timezone`).
 *
 * Layout (172 bytes, little-endian): `Bias` (LONG, minutes, UTC = local + Bias), `StandardName` (32 WCHAR),
 * `StandardDate` (SYSTEMTIME), `StandardBias` (LONG), `DaylightName` (32 WCHAR), `DaylightDate` (SYSTEMTIME),
 * `DaylightBias` (LONG). A transition date uses the SYSTEMTIME "day-in-month" form: `wYear` 0, `wMonth`, `wDayOfWeek`
 * (0 = Sunday), `wDay` the occurrence of that weekday in the month (1-4, 5 = last), and `wHour`/`wMinute` the local wall
 * clock time just before the transition. `wMonth` 0 in `DaylightDate` means the zone has no daylight saving time.
 *
 * **Encoding** derives a zone's rules from the runtime's own tz database (`Intl`) - the UTC offsets in effect, and
 * the instants they change at - for the year of the event the structure describes, rather than from a hand-maintained
 * table. A Win32 structure can only describe "standard time plus at most one yearly daylight period". A zone with
 * more than two transitions in that year (e.g. Morocco, which suspends DST for Ramadan), or one whose rules changed
 * mid-year, is encoded as a fixed offset (the one in effect at the event), so the event itself is still right.
 * `StandardName` is the zone's Windows id from CLDR (`windowsZoneForIanaZone()`), `DaylightName` the same with
 * `Daylight` for `Standard` (the Windows convention); a zone with no Windows id uses its IANA name.
 *
 * **Decoding** a device's structure back to an IANA zone tries, in order: the caller's preferred zones (the event's
 * existing zone, then the mailbox's), CLDR's zone for the Windows name the device sent, and finally every zone the
 * runtime knows, accepting the first whose rules for the reference year are identical (offsets, transition months,
 * weekdays, occurrences and times). With no exact match, a structure without daylight saving time on a whole-hour
 * offset becomes the matching `Etc/GMT±N` zone; anything else decodes to `undefined` (the caller keeps what it had).
 */

const TIME_ZONE_INFORMATION_BYTES = 172;
const NAME_CHARS = 32;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A Win32 SYSTEMTIME in its "day-in-month" transition-rule form; all zero means "no transition". */
export interface TransitionRule {
    month: number;
    dayOfWeek: number;
    /** 1-4, or 5 for the last such weekday of the month. */
    week: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
}

/** The decoded MS-ASDTYPE `TimeZone` structure. */
export interface TimeZoneInformation {
    bias: number;
    standardName: string;
    standardDate?: TransitionRule;
    standardBias: number;
    daylightName: string;
    daylightDate?: TransitionRule;
    daylightBias: number;
}

interface Transition {
    /** The first instant (ms) the new offset applies. */
    at: number;
    /** UTC offsets (local minus UTC) in minutes, before and after. */
    before: number;
    after: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
    let formatter = formatters.get(zone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hourCycle: "h23",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
        });
        formatters.set(zone, formatter);
    }
    return formatter;
}

/** The zone's local wall clock at `ms`, as a UTC-based timestamp of the same fields. */
function wallClockMs(zone: string, ms: number): number {
    const parts: Record<string, number> = {};
    for (const part of formatterFor(zone).formatToParts(ms)) {
        if (part.type !== "literal") {
            parts[part.type] = Number(part.value);
        }
    }
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The zone's UTC offset (local minus UTC) at `ms`, in minutes. */
function offsetMinutes(zone: string, ms: number): number {
    const wholeSecond = Math.floor(ms / 1000) * 1000;
    return Math.round((wallClockMs(zone, wholeSecond) - wholeSecond) / MINUTE_MS);
}

const transitionCache = new Map<string, Transition[]>();

/** Every offset change in `zone` during UTC calendar year `year`, found by sampling weekly and narrowing each change
 * to the minute. */
function transitionsInYear(zone: string, year: number): Transition[] {
    const key = `${zone}|${year}`;
    const cached = transitionCache.get(key);
    if (cached) {
        return cached;
    }
    const transitions: Transition[] = [];
    const end = Date.UTC(year + 1, 0, 1);
    let previousMs = Date.UTC(year, 0, 1);
    let previousOffset = offsetMinutes(zone, previousMs);
    while (previousMs < end) {
        const nextMs = Math.min(previousMs + 7 * DAY_MS, end);
        const nextOffset = offsetMinutes(zone, nextMs);
        if (nextOffset !== previousOffset) {
            // Narrow to the minute; a second change inside the same week (never seen in practice) is caught by the
            // next window, since the scan resumes from the change just found.
            let lo = previousMs;
            let hi = nextMs;
            while (hi - lo > MINUTE_MS) {
                const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
                if (offsetMinutes(zone, mid) === previousOffset) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            const after = offsetMinutes(zone, hi);
            transitions.push({ at: hi, before: previousOffset, after });
            previousMs = hi;
            previousOffset = after;
            continue;
        }
        previousMs = nextMs;
        previousOffset = nextOffset;
    }
    transitionCache.set(key, transitions);
    return transitions;
}

/** `-n`, but never `-0` (a UTC+0 zone's `Bias` is plain 0). */
function negate(n: number): number {
    return n === 0 ? 0 : -n;
}

function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The local wall clock just before `transition`, as UTC-based date fields. A transition at local midnight is moved to
 * 23:59:59.999 of the day before - how Windows writes such rules (e.g. Chile's "Saturday 23:59:59.999"), since a
 * SYSTEMTIME has no 24:00 - so a device's structure for the same zone compares equal. */
function localBefore(transition: Transition): Date {
    const local = transition.at + transition.before * MINUTE_MS;
    return new Date(local % DAY_MS === 0 ? local - 1 : local);
}

/** The daylight-start and standard-start transitions of `zone` in `year`, when the year has exactly that shape. */
function daylightPair(zone: string, year: number): { daylight: Transition; standard: Transition } | undefined {
    const transitions = transitionsInYear(zone, year);
    if (transitions.length !== 2) {
        return undefined;
    }
    // Two changes that don't undo each other (Crimea in 2014: +2 -> +4 -> +3) aren't a daylight period either.
    const [first, second] = transitions;
    if (first.before !== second.after || first.after !== second.before) {
        return undefined;
    }
    return first.after > first.before ? { daylight: first, standard: second } : { daylight: second, standard: first };
}

/** `transition` as a day-in-month rule. The week is "last" (5) when the transition falls in its month's final seven days
 * in this year and the next two, so a "last Sunday" rule isn't misread as "4th Sunday" in a year where they coincide. */
function ruleFor(zone: string, year: number, kind: "daylight" | "standard", transition: Transition): TransitionRule {
    const local = localBefore(transition);
    const isLastInYear = (y: number): boolean => {
        const t: Transition | undefined = y === year ? transition : daylightPair(zone, y)?.[kind];
        if (!t) {
            return false;
        }
        const l = localBefore(t);
        return l.getUTCDate() + 7 > daysInMonth(l.getUTCFullYear(), l.getUTCMonth() + 1);
    };
    const last = isLastInYear(year) && isLastInYear(year + 1) && isLastInYear(year + 2);
    return {
        month: local.getUTCMonth() + 1,
        dayOfWeek: local.getUTCDay(),
        week: last ? 5 : Math.ceil(local.getUTCDate() / 7),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
        second: local.getUTCSeconds(),
        millisecond: local.getUTCMilliseconds(),
    };
}

/** The `TimeZoneInformation` for IANA `zone` as of the year `reference` falls in (in UTC). An unknown zone is UTC. */
export function timeZoneInformationFor(zone: string | undefined, reference: Date): TimeZoneInformation {
    const resolved: string = resolveTimeZone(zone) ?? "UTC";
    const year: number = reference.getUTCFullYear();
    const windows: string | undefined = windowsZoneForIanaZone(resolved);
    const standardName: string = windows ?? resolved;
    const daylightName: string = windows ? windows.replace("Standard Time", "Daylight Time") : resolved;
    const pair = daylightPair(resolved, year);
    if (!pair) {
        return {
            bias: negate(offsetMinutes(resolved, reference.getTime())),
            standardName,
            standardBias: 0,
            daylightName: standardName,
            daylightBias: 0,
        };
    }
    const standardOffset: number = pair.standard.after;
    return {
        bias: negate(standardOffset),
        standardName,
        standardDate: ruleFor(resolved, year, "standard", pair.standard),
        standardBias: 0,
        daylightName,
        daylightDate: ruleFor(resolved, year, "daylight", pair.daylight),
        daylightBias: negate(pair.daylight.after - standardOffset),
    };
}

/** Writes `name` as at most 31 UTF-16 code units, leaving the rest of its 32-WCHAR field (and so a terminator) zero. */
function writeName(buffer: Buffer, offset: number, name: string): void {
    buffer.write(name.slice(0, NAME_CHARS - 1), offset, (NAME_CHARS - 1) * 2, "utf16le");
}

function writeRule(buffer: Buffer, offset: number, rule: TransitionRule | undefined): void {
    if (!rule) {
        return;
    }
    buffer.writeUInt16LE(0, offset);
    buffer.writeUInt16LE(rule.month, offset + 2);
    buffer.writeUInt16LE(rule.dayOfWeek, offset + 4);
    buffer.writeUInt16LE(rule.week, offset + 6);
    buffer.writeUInt16LE(rule.hour, offset + 8);
    buffer.writeUInt16LE(rule.minute, offset + 10);
    buffer.writeUInt16LE(rule.second, offset + 12);
    buffer.writeUInt16LE(rule.millisecond, offset + 14);
}

/** Serializes `info` as the base64 MS-ASDTYPE `TimeZone` value. */
export function encodeTimeZoneInformation(info: TimeZoneInformation): string {
    const buffer = Buffer.alloc(TIME_ZONE_INFORMATION_BYTES);
    buffer.writeInt32LE(info.bias, 0);
    writeName(buffer, 4, info.standardName);
    writeRule(buffer, 68, info.standardDate);
    buffer.writeInt32LE(info.standardBias, 84);
    writeName(buffer, 88, info.daylightName);
    writeRule(buffer, 152, info.daylightDate);
    buffer.writeInt32LE(info.daylightBias, 168);
    return buffer.toString("base64");
}

/** The base64 MS-ASDTYPE `TimeZone` value for IANA `zone` as of `reference` - see this module's doc comment. */
export function encodeTimeZone(zone: string | undefined, reference: Date): string {
    return encodeTimeZoneInformation(timeZoneInformationFor(zone, reference));
}

function readName(buffer: Buffer, offset: number): string {
    const raw = buffer.toString("utf16le", offset, offset + NAME_CHARS * 2);
    const end = raw.indexOf("\u0000");
    return (end === -1 ? raw : raw.slice(0, end)).trim();
}

function readRule(buffer: Buffer, offset: number): TransitionRule | undefined {
    const month = buffer.readUInt16LE(offset + 2);
    if (month === 0) {
        return undefined;
    }
    return {
        month,
        dayOfWeek: buffer.readUInt16LE(offset + 4),
        week: buffer.readUInt16LE(offset + 6),
        hour: buffer.readUInt16LE(offset + 8),
        minute: buffer.readUInt16LE(offset + 10),
        second: buffer.readUInt16LE(offset + 12),
        millisecond: buffer.readUInt16LE(offset + 14),
    };
}

/** Parses a base64 MS-ASDTYPE `TimeZone` value, or `undefined` when it isn't one (too short, or not base64). */
export function decodeTimeZoneInformation(value: string): TimeZoneInformation | undefined {
    const buffer = Buffer.from(value.trim(), "base64");
    if (buffer.length < TIME_ZONE_INFORMATION_BYTES) {
        return undefined;
    }
    const daylightDate = readRule(buffer, 152);
    return {
        bias: buffer.readInt32LE(0),
        standardName: readName(buffer, 4),
        standardDate: daylightDate ? readRule(buffer, 68) : undefined,
        standardBias: buffer.readInt32LE(84),
        daylightName: readName(buffer, 88),
        daylightDate,
        daylightBias: daylightDate ? buffer.readInt32LE(168) : 0,
    };
}

/** What two structures must share to describe the same zone: effective offsets and transition rules, never names. */
function signature(info: TimeZoneInformation): string {
    // Times compare to the nearest minute, so a rule written as 01:59:59.999 matches 02:00 (and 23:59:59.999 matches
    // itself) on the same day of the week.
    const minuteOf = (r: TransitionRule): number => Math.round((((r.hour * 60 + r.minute) * 60 + r.second) * 1000 + r.millisecond) / MINUTE_MS);
    const rule = (r: TransitionRule | undefined): string => (r ? `${r.month}/${r.dayOfWeek}/${r.week}/${minuteOf(r)}` : "-");
    const standardOffset = -(info.bias + info.standardBias);
    if (!info.daylightDate || !info.standardDate) {
        return `${standardOffset}`;
    }
    return `${standardOffset}|${-(info.bias + info.daylightBias)}|${rule(info.standardDate)}|${rule(info.daylightDate)}`;
}

let allZones: string[] | undefined;

/** Every IANA zone the runtime knows. `Intl.supportedValuesOf` (Node 18+; this package requires 24) isn't in the
 * TypeScript `lib` this project compiles against, hence the cast. */
function knownZones(): string[] {
    allZones ??= (Intl as unknown as { supportedValuesOf(key: "timeZone"): string[] }).supportedValuesOf("timeZone");
    return allZones;
}

/**
 * The IANA zone a device's base64 MS-ASDTYPE `TimeZone` value describes, as of `reference` - see this module's doc
 * comment for the search order. `preferred` zones (unresolvable or empty entries are skipped) win any tie, so an
 * event already filed in `America/Vancouver` stays there rather than becoming `America/Los_Angeles`.
 */
export function decodeTimeZone(value: string, reference: Date, preferred: (string | undefined)[] = []): string | undefined {
    const info = decodeTimeZoneInformation(value);
    if (!info) {
        return undefined;
    }
    const target = signature(info);
    const candidates: string[] = [];
    const add = (zone: string | undefined): void => {
        const resolved = resolveTimeZone(zone);
        if (resolved && !candidates.includes(resolved)) {
            candidates.push(resolved);
        }
    };
    preferred.forEach(add);
    add(ianaZoneForWindowsZone(info.standardName));
    for (const zone of candidates) {
        if (signature(timeZoneInformationFor(zone, reference)) === target) {
            return zone;
        }
    }
    // The full scan derives every remaining zone's rules (cached per zone and year), so it first skips any zone whose
    // offset at `reference` is neither of the two the device's structure allows.
    const standardOffset = -(info.bias + info.standardBias);
    const allowedOffsets = new Set([standardOffset, -(info.bias + info.daylightBias)]);
    for (const zone of knownZones()) {
        if (
            !candidates.includes(zone) &&
            allowedOffsets.has(offsetMinutes(zone, reference.getTime())) &&
            signature(timeZoneInformationFor(zone, reference)) === target
        ) {
            // The runtime lists many zones by legacy names (`Asia/Katmandu`); store the current one.
            return currentIanaZone(zone);
        }
    }
    // Reached only for an offset no listed zone uses (e.g. UTC-12, which only `Etc/GMT+12` has). `Etc` zones' signs are
    // inverted: `Etc/GMT+12` is UTC-12.
    if (!info.daylightDate && standardOffset % 60 === 0 && Math.abs(standardOffset) <= 14 * 60) {
        const hours = -standardOffset / 60;
        return `Etc/GMT${hours > 0 ? "+" : "-"}${Math.abs(hours)}`;
    }
    return undefined;
}

/** Whether `date` is exactly a UTC midnight - how this server stores an all-day event's dates. */
function isUtcMidnight(date: Date): boolean {
    return date.getTime() % DAY_MS === 0;
}

/**
 * An all-day date as this server stores it (the UTC midnight of the calendar date) converted to the instant that
 * date's local midnight falls at in `zone` - the `StartTime`/`EndTime` an all-day event carries beside a `Timezone`
 * before protocol 16.0.
 */
export function allDayDateToLocalMidnight(date: Date, zone: string | undefined): Date {
    const resolved: string = resolveTimeZone(zone) ?? "UTC";
    return convertLocalToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0, 0, resolved) ?? date;
}

/**
 * The calendar date of an all-day `StartTime`/`EndTime` a device sent, as this server stores it (UTC midnight). A value
 * already at UTC midnight is a date with no time component (protocol 16.0+, or a client in a UTC+0 zone) and is kept;
 * any other value is a local midnight expressed in UTC (before 16.0), so its date is read in `zone`. A time in the last
 * minute of a day (a device that ends a day at 23:59:59) counts as the next date's midnight.
 */
export function allDayInstantToDate(instant: Date, zone: string | undefined): Date {
    if (isUtcMidnight(instant)) {
        return instant;
    }
    const resolved: string = resolveTimeZone(zone) ?? "UTC";
    const local: number = wallClockMs(resolved, instant.getTime()) + MINUTE_MS;
    return new Date(local - (local % DAY_MS));
}
