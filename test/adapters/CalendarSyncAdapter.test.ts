///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// CalendarSyncAdapter is pure mapping logic with no DI/DB dependency - toApplicationData is already exercised
// end-to-end via test/routes/{mongo,sql}/EasRoute.test.ts's real Sync command tests; this file is reserved for
// fromApplicationData's own ghosting/error-path edge cases - see the identical rationale in
// ContactsSyncAdapter.test.ts.
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { CalendarSyncAdapter, localDayAndMonth, MAX_CALENDAR_ATTENDEES } from "../../src/adapters/CalendarSyncAdapter.js";
import { AttendeeResponseStatus, AttendeeRole, BusyStatus, RecipientType, RecurrenceFrequency } from "@rapidmx/restapi";

const adapter = new CalendarSyncAdapter();

function appData(children: WbxmlElement[]): WbxmlElement {
    return element(WbxmlCodePage.AirSync, "ApplicationData", children);
}

function cal(tag: string, value: string): WbxmlElement {
    return textElement(WbxmlCodePage.Calendar, tag, value);
}

describe("CalendarSyncAdapter Tests", () => {
    it("Reports the Calendar collection class.", () => {
        expect(adapter.collectionClass).toBe("Calendar");
    });

    describe("fromApplicationData", () => {
        it("Parses scalar fields when present.", () => {
            const el = appData([
                cal("Subject", "Standup"),
                cal("Location", "Room 1"),
                cal("StartTime", "20260102T090000Z"),
                cal("EndTime", "20260102T093000Z"),
                cal("AllDayEvent", "1"),
            ]);
            const partial = adapter.fromApplicationData(el);
            expect(partial.title).toBe("Standup");
            expect(partial.location).toBe("Room 1");
            expect(partial.startDate?.toISOString()).toBe("2026-01-02T09:00:00.000Z");
            expect(partial.endDate?.toISOString()).toBe("2026-01-02T09:30:00.000Z");
            expect(partial.allDay).toBe(true);
        });

        it("Interprets AllDayEvent '0' as false.", () => {
            const el = appData([cal("AllDayEvent", "0")]);
            expect(adapter.fromApplicationData(el).allDay).toBe(false);
        });

        it("Leaves a scalar field untouched when its tag is absent.", () => {
            expect(adapter.fromApplicationData(appData([]))).toEqual({});
        });

        it("Maps a recognized BusyStatus code.", () => {
            const el = appData([cal("BusyStatus", "2")]);
            expect(adapter.fromApplicationData(el).busyStatus).toBe(BusyStatus.BUSY);
        });

        it("Throws for an unrecognized BusyStatus value.", () => {
            const el = appData([cal("BusyStatus", "99")]);
            expect(() => adapter.fromApplicationData(el)).toThrow(/unrecognized busystatus/i);
        });

        it("Parses OrganizerEmail with OrganizerName.", () => {
            const el = appData([cal("OrganizerEmail", "owner@example.com"), cal("OrganizerName", "Owner")]);
            expect(adapter.fromApplicationData(el).organizer).toEqual({
                address: "owner@example.com",
                displayName: "Owner",
                type: RecipientType.TO,
            });
        });

        it("Omits an address-like OrganizerName without a mailbox, and refuses an OrganizerEmail that isn't one plain address.", () => {
            const el = appData([cal("OrganizerEmail", "owner@example.com"), cal("OrganizerName", "payroll@corp.com")]);
            expect(adapter.fromApplicationData(el).organizer?.displayName).toBeUndefined();
            expect(() => adapter.fromApplicationData(appData([cal("OrganizerEmail", "a@x.com, b@y.com")]))).toThrow(/OrganizerEmail must be/);
            expect(adapter.fromApplicationData(appData([cal("OrganizerEmail", "")])).organizer?.address).toBe("");
        });

        it("Parses OrganizerEmail without OrganizerName.", () => {
            const el = appData([cal("OrganizerEmail", "owner@example.com")]);
            expect(adapter.fromApplicationData(el).organizer).toEqual({
                address: "owner@example.com",
                displayName: undefined,
                type: RecipientType.TO,
            });
        });

        it("Parses Reminder as a number.", () => {
            const el = appData([cal("Reminder", "15")]);
            expect(adapter.fromApplicationData(el).reminderMinutesBeforeStart).toBe(15);
        });

        describe("Attendees", () => {
            it("Leaves attendees untouched when the Attendees element is absent.", () => {
                expect(adapter.fromApplicationData(appData([])).attendees).toBeUndefined();
            });

            it("Parses multiple attendees, defaulting role/status for unrecognized codes.", () => {
                const el = appData([
                    element(WbxmlCodePage.Calendar, "Attendees", [
                        element(WbxmlCodePage.Calendar, "Attendee", [
                            cal("Email", "a@example.com"),
                            cal("Name", "Alice"),
                            cal("AttendeeType", "2"),
                            cal("AttendeeStatus", "3"),
                        ]),
                        element(WbxmlCodePage.Calendar, "Attendee", [
                            cal("Email", "b@example.com"),
                            cal("AttendeeType", "99"),
                            cal("AttendeeStatus", "99"),
                        ]),
                    ]),
                ]);
                expect(adapter.fromApplicationData(el).attendees).toEqual([
                    {
                        address: "a@example.com",
                        displayName: "Alice",
                        role: AttendeeRole.OPTIONAL,
                        responseStatus: AttendeeResponseStatus.ACCEPTED,
                        isOrganizer: false,
                    },
                    {
                        address: "b@example.com",
                        displayName: undefined,
                        role: AttendeeRole.REQUIRED,
                        responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
                        isOrganizer: false,
                    },
                ]);
            });

            it("Throws when an Attendee element is missing its required Email child.", () => {
                const el = appData([
                    element(WbxmlCodePage.Calendar, "Attendees", [element(WbxmlCodePage.Calendar, "Attendee", [])]),
                ]);
                expect(() => adapter.fromApplicationData(el)).toThrow(/missing its required email/i);
            });

            const attendeesOf = (...emails: string[]) =>
                appData([element(WbxmlCodePage.Calendar, "Attendees", emails.map((email) => element(WbxmlCodePage.Calendar, "Attendee", [cal("Email", email)])))]);

            it("Refuses an attendee Email that isn't one plain address, on an Add and on a Change.", () => {
                for (const email of ["a@x.com, b@y.com", "a@x.com b@y.com", "Pat <pat@x.com>", "pat@x.com (boss@y.com)", "group: a@x.com;", "pat＠x.com", "nobody", "a@b@c.com"]) {
                    expect(() => adapter.fromApplicationData(attendeesOf(email))).toThrow(/single plain email address/);
                    expect(() => adapter.fromApplicationData(attendeesOf(email), baseEvent())).toThrow(/single plain email address/);
                }
            });

            it("On a Change, checks only a changed attendee list, as restapi's REST update does.", () => {
                const existing: any = {
                    ...baseEvent(),
                    attendees: [
                        { address: "odd address@x.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION },
                        { address: "b@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION },
                    ],
                };
                // The same addresses re-sent (e.g. with a new status) still save.
                expect(adapter.fromApplicationData(attendeesOf("odd address@x.com", "b@example.com"), existing).attendees).toHaveLength(2);
                // Any change to the list checks every address.
                expect(() => adapter.fromApplicationData(attendeesOf("odd address@x.com"), existing)).toThrow(/single plain email address/);
            });

            it("Accepts at most MAX_CALENDAR_ATTENDEES attendees, on an Add and on a Change.", () => {
                const emails = (count: number) => Array.from({ length: count }, (_, i) => `a${i}@example.com`);
                expect(adapter.fromApplicationData(attendeesOf(...emails(MAX_CALENDAR_ATTENDEES))).attendees).toHaveLength(MAX_CALENDAR_ATTENDEES);
                expect(() => adapter.fromApplicationData(attendeesOf(...emails(MAX_CALENDAR_ATTENDEES + 1)))).toThrow(/at most 500 attendees/);
                expect(() => adapter.fromApplicationData(attendeesOf(...emails(MAX_CALENDAR_ATTENDEES + 1)), baseEvent())).toThrow(/at most 500 attendees/);
            });

            it("Drops an attendee Name that looks like an address, including one kept from the existing attendee.", () => {
                const el = appData([
                    element(WbxmlCodePage.Calendar, "Attendees", [
                        element(WbxmlCodePage.Calendar, "Attendee", [cal("Email", "a@example.com"), cal("Name", "ceo@corp.com")]),
                        element(WbxmlCodePage.Calendar, "Attendee", [cal("Email", "b@example.com")]),
                    ]),
                ]);
                const existing: any = {
                    ...baseEvent(),
                    attendees: [{ address: "b@example.com", displayName: "Line\nbreak", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION }],
                };
                expect(adapter.fromApplicationData(el, existing).attendees!.map((attendee) => attendee.displayName)).toEqual([undefined, undefined]);
            });
        });

        describe("Recurrence", () => {
            it("Leaves recurrenceRule untouched when the Recurrence element is absent.", () => {
                expect(adapter.fromApplicationData(appData([])).recurrenceRule).toBeUndefined();
            });

            it("Parses a Daily recurrence with default interval.", () => {
                const el = appData([element(WbxmlCodePage.Calendar, "Recurrence", [cal("Type", "0")])]);
                expect(adapter.fromApplicationData(el).recurrenceRule).toEqual({
                    freq: RecurrenceFrequency.DAILY,
                    interval: 1,
                    exceptions: [],
                });
            });

            it("Parses a Weekly recurrence's DayOfWeek bitmask into RFC 5545 day codes.", () => {
                const el = appData([
                    element(WbxmlCodePage.Calendar, "Recurrence", [
                        cal("Type", "1"),
                        cal("Interval", "2"),
                        cal("DayOfWeek", String(2 + 8)), // Monday + Wednesday
                    ]),
                ]);
                const rule = adapter.fromApplicationData(el).recurrenceRule;
                expect(rule?.freq).toBe(RecurrenceFrequency.WEEKLY);
                expect(rule?.interval).toBe(2);
                expect(rule?.byDay).toEqual(["MO", "WE"]);
            });

            it("Parses a Monthly recurrence's DayOfMonth.", () => {
                const el = appData([
                    element(WbxmlCodePage.Calendar, "Recurrence", [cal("Type", "2"), cal("DayOfMonth", "15")]),
                ]);
                expect(adapter.fromApplicationData(el).recurrenceRule?.byMonthDay).toEqual([15]);
            });

            it("Parses a Yearly recurrence's DayOfMonth/MonthOfYear/Until/Occurrences.", () => {
                const el = appData([
                    element(WbxmlCodePage.Calendar, "Recurrence", [
                        cal("Type", "5"),
                        cal("DayOfMonth", "25"),
                        cal("MonthOfYear", "12"),
                        cal("Until", "20301231T000000Z"),
                        cal("Occurrences", "10"),
                    ]),
                ]);
                const rule = adapter.fromApplicationData(el).recurrenceRule;
                expect(rule?.freq).toBe(RecurrenceFrequency.YEARLY);
                expect(rule?.byMonthDay).toEqual([25]);
                expect(rule?.byMonth).toEqual([12]);
                expect(rule?.until?.toISOString()).toBe("2030-12-31T00:00:00.000Z");
                expect(rule?.count).toBe(10);
            });

            it("Throws for an unrecognized/unsupported Recurrence Type value.", () => {
                const el = appData([element(WbxmlCodePage.Calendar, "Recurrence", [cal("Type", "3")])]);
                expect(() => adapter.fromApplicationData(el)).toThrow(/unrecognized or unsupported recurrence type/i);
            });
        });
    });

    describe("newEntityDefaults", () => {
        it("Generates a unique icalUid and a sequence of 0 on every call.", () => {
            const a = adapter.newEntityDefaults();
            const b = adapter.newEntityDefaults();
            expect(a.icalUid).toMatch(/^[0-9a-f-]{36}@eas$/);
            expect(a.sequence).toBe(0);
            expect(a.icalUid).not.toBe(b.icalUid);
        });
    });

    describe("organizer (with the caller's mailbox)", () => {
        const mailbox: any = { primarySmtpAddress: "me@example.com", aliasAddresses: ["alias@example.com"], displayName: "Me" };

        it("Keeps an OrganizerEmail that is one of the mailbox's own addresses on an Add.", () => {
            const partial = adapter.fromApplicationData(appData([cal("OrganizerEmail", "Alias@example.com")]), undefined, mailbox);
            expect(partial.organizer).toEqual({ address: "Alias@example.com", displayName: "Me", type: RecipientType.TO });
            // The device's OrganizerName is never used: invitations would show it as the sender's name.
            const named = adapter.fromApplicationData(appData([cal("OrganizerEmail", "me@example.com"), cal("OrganizerName", "payroll@corp.com")]), undefined, mailbox);
            expect(named.organizer).toEqual({ address: "me@example.com", displayName: "Me", type: RecipientType.TO });
        });

        it("Omits the mailbox's own display name when it looks like an address or has a line break.", () => {
            for (const displayName of ["me@example.com", "Me＠example", "=?utf-8?q?ceo=40corp.com?=", "Me\r\nBcc: x", "  "]) {
                const partial = adapter.fromApplicationData(appData([cal("Subject", "x")]), undefined, { ...mailbox, displayName });
                expect(partial.organizer).toEqual({ address: "me@example.com", displayName: undefined, type: RecipientType.TO });
            }
        });

        it("Replaces a foreign or missing OrganizerEmail with the mailbox's primary address on an Add.", () => {
            const spoofed = adapter.fromApplicationData(appData([cal("OrganizerEmail", "ceo@example.com"), cal("OrganizerName", "CEO")]), undefined, mailbox);
            expect(spoofed.organizer).toEqual({ address: "me@example.com", displayName: "Me", type: RecipientType.TO });
            const missing = adapter.fromApplicationData(appData([cal("Subject", "x")]), undefined, { ...mailbox, aliasAddresses: undefined });
            expect(missing.organizer?.address).toBe("me@example.com");
        });

        it("Never reassigns the organizer on a Change.", () => {
            const existing: any = { ...baseEvent(), organizer: { address: "boss@example.com", type: RecipientType.TO } };
            const partial = adapter.fromApplicationData(appData([cal("OrganizerEmail", "me@example.com")]), existing, mailbox);
            expect("organizer" in partial).toBe(false);
        });
    });

    describe("attendee copies (never mistaken for the organizer by MeetingSchedulingJob)", () => {
        const mailbox: any = { primarySmtpAddress: "me@example.com", aliasAddresses: ["alias@example.com"], displayName: "Me" };
        const attendeeCopy = (overrides: Record<string, any> = {}): any => ({
            ...baseEvent(),
            organizer: { address: "boss@example.com", type: RecipientType.TO },
            sequence: 3,
            inviteSequenceSent: 2,
            ...overrides,
        });

        it("Leaves the sequence alone on a scheduling change to an attendee's copy, keeping inviteSequenceSent level with it.", () => {
            const partial = adapter.fromApplicationData(appData([cal("StartTime", "20260101T090000Z")]), attendeeCopy(), mailbox);
            expect(partial.sequence).toBeUndefined();
            expect(partial.inviteSequenceSent).toBe(3);

            const inSync = adapter.fromApplicationData(appData([cal("Location", "Room 9")]), attendeeCopy({ inviteSequenceSent: 3 }), mailbox);
            expect("inviteSequenceSent" in inSync).toBe(false);
            expect(inSync.sequence).toBeUndefined();

            const unset = adapter.fromApplicationData(appData([cal("Subject", "x")]), attendeeCopy({ sequence: undefined, inviteSequenceSent: 1 }), mailbox);
            expect(unset.inviteSequenceSent).toBe(0);
        });

        it("Still bumps the sequence on the organizer's own copy (matched on any of the mailbox's addresses, or no organizer at all).", () => {
            const own = attendeeCopy({ organizer: { address: "ALIAS@example.com", type: RecipientType.TO } });
            expect(adapter.fromApplicationData(appData([cal("StartTime", "20260101T090000Z")]), own, mailbox).sequence).toBe(4);
            const noOrganizer = attendeeCopy({ organizer: undefined });
            expect(adapter.fromApplicationData(appData([cal("StartTime", "20260101T090000Z")]), noOrganizer, { ...mailbox, aliasAddresses: undefined }).sequence).toBe(4);
        });

        it("Stamps cancelNoticeSentAt before an attendee's copy is deleted, but never on the organizer's copy or twice.", () => {
            expect(adapter.beforeDelete(attendeeCopy(), mailbox)).toEqual({ cancelNoticeSentAt: expect.any(Date) });
            expect(adapter.beforeDelete(attendeeCopy({ cancelNoticeSentAt: new Date() }), mailbox)).toBeUndefined();
            expect(adapter.beforeDelete(attendeeCopy({ organizer: { address: "me@example.com", type: RecipientType.TO } }), mailbox)).toBeUndefined();
        });
    });

    describe("Change merging", () => {
        it("Keeps an existing attendee's unsent fields and marks a new attendee with defaults.", () => {
            const existing: any = {
                ...baseEvent(),
                attendees: [
                    { address: "Pat@example.com", displayName: "Pat", role: AttendeeRole.OPTIONAL, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: true },
                ],
            };
            const el = appData([
                element(WbxmlCodePage.Calendar, "Attendees", [
                    element(WbxmlCodePage.Calendar, "Attendee", [cal("Email", "pat@example.com")]),
                    element(WbxmlCodePage.Calendar, "Attendee", [cal("Email", "new@example.com")]),
                ]),
            ]);

            const partial = adapter.fromApplicationData(el, existing);

            expect(partial.attendees).toEqual([
                { address: "pat@example.com", displayName: "Pat", role: AttendeeRole.OPTIONAL, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: true },
                { address: "new@example.com", displayName: undefined, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false },
            ]);
            // A new attendee is a scheduling change.
            expect(partial.sequence).toBe(4);
        });

        it("Keeps the series' existing exceptions when the recurrence is rebuilt, bumping sequence only when the rule changed.", () => {
            const exceptions = [new Date("2026-02-02T09:00:00.000Z")];
            const existing: any = {
                ...baseEvent(),
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, byDay: ["MO"], exceptions },
            };
            const same = adapter.fromApplicationData(appData([element(WbxmlCodePage.Calendar, "Recurrence", [cal("Type", "1"), cal("DayOfWeek", "2")])]), existing);
            expect(same.recurrenceRule?.exceptions).toBe(exceptions);
            expect("sequence" in same).toBe(false);

            const changed = adapter.fromApplicationData(appData([element(WbxmlCodePage.Calendar, "Recurrence", [cal("Type", "1"), cal("DayOfWeek", "4")])]), existing);
            expect(changed.sequence).toBe(4);

            const added = adapter.fromApplicationData(appData([element(WbxmlCodePage.Calendar, "Recurrence", [cal("Type", "0"), cal("Until", "20260301T000000Z")])]), baseEvent());
            expect(added.recurrenceRule?.exceptions).toEqual([]);
            expect(added.sequence).toBe(4);
        });

        it("Bumps sequence for a time or location change, but not for a subject/reminder-only change or an identical value.", () => {
            const existing: any = baseEvent();
            expect(adapter.fromApplicationData(appData([cal("StartTime", "20260101T090000Z")]), existing).sequence).toBe(4);
            expect(adapter.fromApplicationData(appData([cal("EndTime", "20260101T120000Z")]), existing).sequence).toBe(4);
            expect(adapter.fromApplicationData(appData([cal("Location", "Room 9")]), existing).sequence).toBe(4);
            expect(adapter.fromApplicationData(appData([cal("Location", "")]), { ...existing, location: null }).sequence).toBeUndefined();
            expect(adapter.fromApplicationData(appData([cal("Subject", "Renamed"), cal("Reminder", "5")]), existing).sequence).toBeUndefined();
            expect(
                adapter.fromApplicationData(appData([cal("StartTime", "20260101T100000Z"), cal("EndTime", "20260101T110000Z"), cal("Location", "Room 1")]), existing)
                    .sequence,
            ).toBeUndefined();
            expect(adapter.fromApplicationData(appData([cal("StartTime", "20260101T090000Z")]), { ...existing, sequence: undefined }).sequence).toBe(1);
        });

        it("Treats removing all attendees as a scheduling change, and matching attendees as none.", () => {
            const attendee = { address: "a@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false };
            const existing: any = { ...baseEvent(), attendees: [attendee] };
            expect(adapter.fromApplicationData(appData([element(WbxmlCodePage.Calendar, "Attendees", [])]), existing).sequence).toBe(4);
            const same = appData([element(WbxmlCodePage.Calendar, "Attendees", [element(WbxmlCodePage.Calendar, "Attendee", [cal("Email", "a@example.com")])])]);
            expect(adapter.fromApplicationData(same, existing).sequence).toBeUndefined();
            expect(adapter.fromApplicationData(same, { ...existing, attendees: undefined }).sequence).toBe(4);
        });
    });

    describe("toApplicationData recurrence day/month fallback", () => {
        it("Derives DayOfMonth/MonthOfYear from the start date in the event's own timezone.", () => {
            // 2026-01-01T02:00Z is still 31 December in New York.
            const event: any = {
                ...baseEvent(),
                startDate: new Date("2026-01-01T02:00:00.000Z"),
                timezone: "America/New_York",
                recurrenceRule: { freq: RecurrenceFrequency.YEARLY, interval: 1, exceptions: [] },
            };
            const recurrence = findChild(adapter.toApplicationData(event), "Recurrence")!;
            expect(childText(recurrence, "DayOfMonth")).toBe("31");
            expect(childText(recurrence, "MonthOfYear")).toBe("12");
        });

        it("Falls back to UTC for a timezone Intl doesn't recognize.", () => {
            expect(localDayAndMonth(new Date("2026-01-01T02:00:00.000Z"), "Not/AZone")).toEqual({ day: 1, month: 1 });
            expect(localDayAndMonth(new Date("2026-07-04T12:00:00.000Z"), "UTC")).toEqual({ day: 4, month: 7 });
        });
    });

    describe("airsyncbase:InstanceId (changeInstance/deleteInstance - one occurrence of a recurring series, protocol 16.0+)", () => {
        function fakeRepo(overrides: Record<string, any> = {}): any {
            return {
                find: vi.fn().mockResolvedValue([]),
                create: vi.fn().mockImplementation(async (row: any) => ({ uid: "occurrence-1", version: 1, ...row })),
                update: vi.fn().mockImplementation(async (row: any) => ({ ...row })),
                delete: vi.fn().mockResolvedValue(undefined),
                ...overrides,
            };
        }

        function recurringMaster(): any {
            return {
                ...baseEvent(),
                mailboxUid: "mbx-1",
                icalUid: "series@example.com",
                folderUid: "folder-1",
                recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [] },
            };
        }

        describe("changeInstance", () => {
            it("Creates the occurrence's own override row (a copy of the master, minus identity fields, no Recurrence of its own) the first time it's edited, then applies the Change's own fields on top.", async () => {
                const master = recurringMaster();
                const repo = fakeRepo();

                await adapter.changeInstance(master, "20260108T100000Z", appData([cal("Subject", "Moved standup")]), repo, { primarySmtpAddress: "me@example.com", aliasAddresses: [] } as any);

                expect(repo.find).toHaveBeenCalled();
                expect(repo.create).toHaveBeenCalledTimes(1);
                const created = repo.create.mock.calls[0][0];
                expect(created.uid).toBeUndefined();
                expect(created.icalUid).toBe("series@example.com");
                expect(created.mailboxUid).toBe("mbx-1");
                expect(created.recurrenceId).toEqual(new Date("2026-01-08T10:00:00.000Z"));
                expect(created.recurrenceRule).toBeUndefined();
                // Everything the Change didn't send is carried over from the master (ghosted).
                expect(created.location).toBe("Room 1");
                expect(repo.update).toHaveBeenCalledTimes(1);
                expect(repo.update.mock.calls[0][0]).toMatchObject({ uid: "occurrence-1", title: "Moved standup" });
            });

            it("Updates the existing override row directly on a later edit of the same occurrence, without creating another.", async () => {
                const master = recurringMaster();
                const recurrenceId = new Date("2026-01-08T10:00:00.000Z");
                const override = { ...master, uid: "override-1", version: 2, recurrenceId, recurrenceRule: undefined, title: "Already moved" };
                const repo = fakeRepo({ find: vi.fn().mockResolvedValue([override]) });

                await adapter.changeInstance(master, "20260108T100000Z", appData([cal("Location", "Room 9")]), repo, { primarySmtpAddress: "me@example.com", aliasAddresses: [] } as any);

                expect(repo.create).not.toHaveBeenCalled();
                expect(repo.update).toHaveBeenCalledTimes(1);
                expect(repo.update.mock.calls[0][0]).toMatchObject({ uid: "override-1", version: 2, location: "Room 9" });
            });
        });

        describe("deleteInstance", () => {
            it("Deletes the occurrence's own override row directly when one already exists, without touching the master's own exceptions.", async () => {
                const master = recurringMaster();
                const recurrenceId = new Date("2026-01-08T10:00:00.000Z");
                const override = { ...master, uid: "override-1", version: 2, recurrenceId, recurrenceRule: undefined };
                const repo = fakeRepo({ find: vi.fn().mockResolvedValue([override]) });

                await adapter.deleteInstance(master, "20260108T100000Z", repo);

                expect(repo.delete).toHaveBeenCalledWith("override-1", { ignoreACL: true });
                expect(repo.update).not.toHaveBeenCalled();
            });

            it("Records the occurrence in the series' own exceptions when it was never individually edited.", async () => {
                const master = recurringMaster();
                const repo = fakeRepo();

                await adapter.deleteInstance(master, "20260108T100000Z", repo);

                expect(repo.delete).not.toHaveBeenCalled();
                expect(repo.update).toHaveBeenCalledTimes(1);
                const [patch] = repo.update.mock.calls[0];
                expect(patch.uid).toBe(master.uid);
                expect(patch.recurrenceRule.exceptions).toEqual([new Date("2026-01-08T10:00:00.000Z")]);
            });

            it("Appends to any exceptions the series already has, rather than replacing them.", async () => {
                const master = { ...recurringMaster(), recurrenceRule: { freq: RecurrenceFrequency.WEEKLY, interval: 1, exceptions: [new Date("2026-01-01T10:00:00.000Z")] } };
                const repo = fakeRepo();

                await adapter.deleteInstance(master, "20260108T100000Z", repo);

                const [patch] = repo.update.mock.calls[0];
                expect(patch.recurrenceRule.exceptions).toEqual([new Date("2026-01-01T10:00:00.000Z"), new Date("2026-01-08T10:00:00.000Z")]);
            });
        });
    });
});

function baseEvent(): any {
    return {
        uid: "event-1",
        version: 1,
        title: "Existing",
        location: "Room 1",
        startDate: new Date("2026-01-01T10:00:00.000Z"),
        endDate: new Date("2026-01-01T11:00:00.000Z"),
        allDay: false,
        timezone: "UTC",
        dateModified: new Date("2026-01-01T00:00:00.000Z"),
        busyStatus: BusyStatus.BUSY,
        organizer: { address: "me@example.com", type: RecipientType.TO },
        attendees: [],
        sequence: 3,
    };
}
