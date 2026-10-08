///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The expected rules below are the values Windows itself stores for each zone (the registry's TZI), which is what a
// real EAS client (Outlook, iOS, Android) sends and expects.
import {
    allDayDateToLocalMidnight,
    allDayInstantToDate,
    decodeTimeZone,
    decodeTimeZoneInformation,
    encodeTimeZone,
    encodeTimeZoneInformation,
    timeZoneInformationFor,
    type TimeZoneInformation,
    type TransitionRule,
} from "../src/TimeZoneInfo.js";

const REFERENCE = new Date("2026-06-15T12:00:00.000Z");

function rule(month: number, dayOfWeek: number, week: number, hour: number, minute = 0, second = 0, millisecond = 0): TransitionRule {
    return { month, dayOfWeek, week, hour, minute, second, millisecond };
}

describe("TimeZoneInfo", () => {
    describe("timeZoneInformationFor()", () => {
        it("Derives US Pacific's rules: 2nd Sunday of March 02:00 to 1st Sunday of November 02:00, UTC-8, 60 minutes saved.", () => {
            expect(timeZoneInformationFor("America/Los_Angeles", REFERENCE)).toEqual({
                bias: 480,
                standardName: "Pacific Standard Time",
                standardDate: rule(11, 0, 1, 2),
                standardBias: 0,
                daylightName: "Pacific Daylight Time",
                daylightDate: rule(3, 0, 2, 2),
                daylightBias: -60,
            });
        });

        it("Derives a 'last Sunday' rule as week 5 (Europe), and southern-hemisphere rules whose daylight period spans the new year (Sydney).", () => {
            const berlin = timeZoneInformationFor("Europe/Berlin", REFERENCE);
            expect(berlin).toMatchObject({ bias: -60, standardDate: rule(10, 0, 5, 3), daylightDate: rule(3, 0, 5, 2), daylightBias: -60 });
            expect(berlin.standardName).toBe("W. Europe Standard Time");
            expect(berlin.daylightName).toBe("W. Europe Daylight Time");

            expect(timeZoneInformationFor("Australia/Sydney", REFERENCE)).toMatchObject({
                bias: -600,
                standardName: "AUS Eastern Standard Time",
                standardDate: rule(4, 0, 1, 3),
                daylightDate: rule(10, 0, 1, 2),
                daylightBias: -60,
            });
        });

        it("Writes a transition at local midnight as 23:59:59.999 of the day before, as Windows does (Chile: 1st Saturday 23:59:59.999).", () => {
            expect(timeZoneInformationFor("America/Santiago", REFERENCE)).toMatchObject({
                bias: 240,
                standardDate: rule(4, 6, 1, 23, 59, 59, 999),
                daylightDate: rule(9, 6, 1, 23, 59, 59, 999),
            });
        });

        it("Describes a zone without daylight saving time - including a half-hour one - by its offset alone.", () => {
            expect(timeZoneInformationFor("Asia/Tokyo", REFERENCE)).toEqual({
                bias: -540,
                standardName: "Tokyo Standard Time",
                standardBias: 0,
                daylightName: "Tokyo Standard Time",
                daylightBias: 0,
            });
            expect(timeZoneInformationFor("Asia/Kolkata", REFERENCE)).toMatchObject({ bias: -330, standardName: "India Standard Time" });
            expect(timeZoneInformationFor("America/St_Johns", REFERENCE)).toMatchObject({ bias: 210, daylightBias: -60 });
        });

        it("Puts 'Daylight' for 'Standard' anywhere in the Windows name (Mexico), and uses the IANA name for a zone with no Windows id.", () => {
            expect(timeZoneInformationFor("America/Mexico_City", new Date("2022-06-15T12:00:00Z")).daylightName).toBe("Central Daylight Time (Mexico)");
            expect(timeZoneInformationFor("Antarctica/Troll", REFERENCE).standardName).toBe("Antarctica/Troll");
        });

        it("Falls back to the offset in effect for a year whose rules a Win32 structure can't describe (Volgograd changed offset once in 2020), and to UTC for an unknown zone.", () => {
            expect(timeZoneInformationFor("Europe/Volgograd", new Date("2020-06-15T12:00:00Z"))).toMatchObject({ bias: -240, daylightBias: 0 });
            expect(timeZoneInformationFor("Europe/Volgograd", new Date("2020-06-15T12:00:00Z")).daylightDate).toBeUndefined();
            // Two changes that don't undo each other: Crimea moved +2 -> +4 -> +3 in 2014.
            const crimea = timeZoneInformationFor("Europe/Simferopol", new Date("2014-06-15T12:00:00Z"));
            expect(crimea).toMatchObject({ bias: -240, daylightBias: 0 });
            expect(crimea.daylightDate).toBeUndefined();
            expect(timeZoneInformationFor("Not/AZone", REFERENCE)).toMatchObject({ bias: 0, standardName: "UTC" });
            expect(timeZoneInformationFor(undefined, REFERENCE)).toMatchObject({ bias: 0 });
        });
    });

    describe("encoding", () => {
        it("Serializes the 172-byte little-endian structure, with zero-terminated UTF-16 names.", () => {
            const bytes = Buffer.from(encodeTimeZone("America/Los_Angeles", REFERENCE), "base64");
            expect(bytes.length).toBe(172);
            expect(bytes.readInt32LE(0)).toBe(480);
            expect(bytes.toString("utf16le", 4, 4 + 2 * "Pacific Standard Time".length)).toBe("Pacific Standard Time");
            expect(bytes.readUInt16LE(4 + 2 * "Pacific Standard Time".length)).toBe(0);
            // StandardDate: wYear 0, wMonth 11, wDayOfWeek 0, wDay 1, wHour 2.
            expect([0, 2, 4, 6, 8].map((o) => bytes.readUInt16LE(68 + o))).toEqual([0, 11, 0, 1, 2]);
            expect(bytes.readInt32LE(84)).toBe(0);
            expect([2, 4, 6, 8].map((o) => bytes.readUInt16LE(152 + o))).toEqual([3, 0, 2, 2]);
            expect(bytes.readInt32LE(168)).toBe(-60);
        });

        it("Truncates a name to 31 characters so its field always keeps a terminator.", () => {
            const info: TimeZoneInformation = { bias: 0, standardName: "x".repeat(40), standardBias: 0, daylightName: "", daylightBias: 0 };
            const bytes = Buffer.from(encodeTimeZoneInformation(info), "base64");
            expect(bytes.toString("utf16le", 4, 68)).toBe(`${"x".repeat(31)}\u0000`);
        });

        it("Round-trips through decodeTimeZoneInformation(), which reports no transitions for a zone without daylight saving time.", () => {
            expect(decodeTimeZoneInformation(encodeTimeZone("Europe/Berlin", REFERENCE))).toEqual(timeZoneInformationFor("Europe/Berlin", REFERENCE));
            expect(decodeTimeZoneInformation(encodeTimeZone("Asia/Tokyo", REFERENCE))).toEqual({
                bias: -540,
                standardName: "Tokyo Standard Time",
                standardDate: undefined,
                standardBias: 0,
                daylightName: "Tokyo Standard Time",
                daylightDate: undefined,
                daylightBias: 0,
            });
            expect(decodeTimeZoneInformation(Buffer.alloc(100).toString("base64"))).toBeUndefined();
        });
    });

    describe("decodeTimeZone()", () => {
        it("Decodes a zone's own structure back to it - by its Windows name - with its current IANA name.", () => {
            for (const zone of ["America/Los_Angeles", "Europe/Berlin", "Australia/Sydney", "America/Santiago", "Asia/Kolkata", "Asia/Tokyo"]) {
                expect(decodeTimeZone(encodeTimeZone(zone, REFERENCE), REFERENCE)).toBe(zone);
            }
        });

        it("Prefers the caller's zones when they have the same rules, skipping unresolvable ones.", () => {
            const pacific = encodeTimeZone("America/Los_Angeles", REFERENCE);
            expect(decodeTimeZone(pacific, REFERENCE, [undefined, "Not/AZone", "America/Vancouver"])).toBe("America/Vancouver");
            // A preferred zone with different rules doesn't win.
            expect(decodeTimeZone(pacific, REFERENCE, ["Europe/Berlin"])).toBe("America/Los_Angeles");
        });

        it("Matches a structure a client wrote its own way - a transition at 01:59:59.999 is the same rule as 02:00.", () => {
            const info = { ...timeZoneInformationFor("America/New_York", REFERENCE), standardDate: rule(11, 0, 1, 1, 59, 59, 999), daylightDate: rule(3, 0, 2, 1, 59, 59, 999) };
            expect(decodeTimeZone(encodeTimeZoneInformation(info), REFERENCE)).toBe("America/New_York");
        });

        it("Without a recognizable name, finds a zone with the same rules among every zone the runtime knows, by its current name.", () => {
            const nameless = (zone: string): string =>
                encodeTimeZoneInformation({ ...timeZoneInformationFor(zone, REFERENCE), standardName: "", daylightName: "Custom" });
            const paris = decodeTimeZone(nameless("Europe/Paris"), REFERENCE)!;
            expect(timeZoneInformationFor(paris, REFERENCE)).toMatchObject({ bias: -60, standardDate: rule(10, 0, 5, 3), daylightDate: rule(3, 0, 5, 2) });
            expect(decodeTimeZone(nameless("Asia/Kathmandu"), REFERENCE)).toBe("Asia/Kathmandu");
        });

        it("Falls back to an Etc/GMT zone for a whole-hour offset no listed zone uses, and gives up on anything else.", () => {
            const fixed = (bias: number): string => encodeTimeZoneInformation({ bias, standardName: "", standardBias: 0, daylightName: "", daylightBias: 0 });
            expect(decodeTimeZone(fixed(720), REFERENCE)).toBe("Etc/GMT+12");
            expect(decodeTimeZone(fixed(17), REFERENCE)).toBeUndefined();
            expect(decodeTimeZone("not a structure", REFERENCE)).toBeUndefined();
        });
    });

    describe("all-day dates", () => {
        it("allDayDateToLocalMidnight() gives the instant a date's local midnight falls at in the zone.", () => {
            const date = new Date("2026-10-08T00:00:00.000Z");
            expect(allDayDateToLocalMidnight(date, "Europe/Berlin").toISOString()).toBe("2026-10-07T22:00:00.000Z");
            expect(allDayDateToLocalMidnight(date, "America/Los_Angeles").toISOString()).toBe("2026-10-08T07:00:00.000Z");
            expect(allDayDateToLocalMidnight(date, "Not/AZone").toISOString()).toBe("2026-10-08T00:00:00.000Z");
        });

        it("allDayInstantToDate() keeps a date-only value, reads a local midnight in its zone, and treats a day's last minute as the next date.", () => {
            expect(allDayInstantToDate(new Date("2026-10-08T00:00:00.000Z"), "America/Los_Angeles").toISOString()).toBe("2026-10-08T00:00:00.000Z");
            expect(allDayInstantToDate(new Date("2026-10-07T22:00:00.000Z"), "Europe/Berlin").toISOString()).toBe("2026-10-08T00:00:00.000Z");
            expect(allDayInstantToDate(new Date("2026-10-08T07:00:00.000Z"), "America/Los_Angeles").toISOString()).toBe("2026-10-08T00:00:00.000Z");
            expect(allDayInstantToDate(new Date("2026-10-09T06:59:59.000Z"), "America/Los_Angeles").toISOString()).toBe("2026-10-09T00:00:00.000Z");
            expect(allDayInstantToDate(new Date("2026-10-08T09:00:00.000Z"), undefined).toISOString()).toBe("2026-10-08T00:00:00.000Z");
        });
    });
});
