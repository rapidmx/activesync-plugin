///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for MeetingResponseCommand's guard clauses and the branches a real request can't reach
// deterministically: the caller's mailbox vanishing mid-request, a failed write, a transport failure while mailing
// the iTIP reply, and a meeting request message whose MIME can't be read. The common flows (accept/decline, a
// response by meeting request message, the reply to the organizer, per-request Status 2) run over real HTTP+DB in
// test/routes/{mongo,sql}/EasRoute.test.ts.
import { createHash } from "crypto";
import config from "../config.js";
import { ModelUtils, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { AttendeeResponseStatus, AttendeeRole, RecipientType } from "@rapidmx/restapi";
import { MeetingResponseCommandMongo } from "../../src/commands/mongo/MeetingResponseCommandMongo.js";
import { MAX_MEETING_RESPONSES } from "../../src/commands/MeetingResponseCommand.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import { fakeMailAclUtils, TRUSTED_STRANGER_USER } from "../mailAccessTestUtils.js";

const MAILBOX = { uid: "mbx-1", primarySmtpAddress: "me@example.com", aliasAddresses: [], displayName: "Me" };

function event(overrides: Record<string, any> = {}): any {
    return {
        uid: "event-1",
        version: 1,
        folderUid: "calendar",
        mailboxUid: "mbx-1",
        title: "Planning",
        icalUid: "ical-1@example.com",
        sequence: 0,
        status: "confirmed",
        startDate: new Date("2026-03-01T10:00:00.000Z"),
        endDate: new Date("2026-03-01T11:00:00.000Z"),
        organizer: { address: "boss@example.com", type: RecipientType.TO },
        attendees: [{ address: "me@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
        ...overrides,
    };
}

function request(...requests: WbxmlElement[][]): WbxmlElement {
    return element(
        WbxmlCodePage.MeetingResponse,
        "MeetingResponse",
        requests.map((children) => element(WbxmlCodePage.MeetingResponse, "Request", children)),
    );
}

function reply(userResponse: string, requestId: string, sendResponse = false): WbxmlElement[] {
    return [
        textElement(WbxmlCodePage.MeetingResponse, "UserResponse", userResponse),
        textElement(WbxmlCodePage.MeetingResponse, "RequestId", requestId),
        ...(sendResponse ? [element(WbxmlCodePage.MeetingResponse, "SendResponse", [])] : []),
    ];
}

function build(overrides: { calendarEventRepo?: any; messageRepo?: any; aclUtils?: any; blobStore?: any; mailTransport?: any; mailbox?: any } = {}) {
    const objectFactory = new ObjectFactory(config, Logger());
    const command = objectFactory.newInstance<MeetingResponseCommandMongo>(MeetingResponseCommandMongo, { initialize: false }) as MeetingResponseCommandMongo;
    const logger = { warn: vi.fn() };
    const calendarEventRepo = overrides.calendarEventRepo ?? {
        findOne: vi.fn().mockResolvedValue(event()),
        find: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
    };
    const mailTransport = overrides.mailTransport ?? { send: vi.fn().mockImplementation(async (message: any) => ({ accepted: message.envelopeTo, rejected: [] })) };
    (command as any).calendarEventRepo = calendarEventRepo;
    (command as any).messageRepo = overrides.messageRepo ?? { findOne: vi.fn().mockResolvedValue(undefined) };
    (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue("mailbox" in overrides ? overrides.mailbox : MAILBOX) };
    (command as any).aclUtils = overrides.aclUtils ?? { hasPermission: vi.fn().mockResolvedValue(true) };
    (command as any).blobStore = overrides.blobStore ?? { get: vi.fn() };
    (command as any).mailTransport = mailTransport;
    (command as any).logger = logger;
    return { command, calendarEventRepo, mailTransport, logger };
}

function ctx(req: WbxmlElement | undefined, user: any = { uid: "user-1", roles: [], scopes: [] }): EasCommandContext {
    return { user, mailboxUid: "mbx-1", request: req } as unknown as EasCommandContext;
}

function statuses(response: WbxmlElement | undefined): string[] {
    return findChildren(response!, "Result").map((result) => childText(result, "Status")!);
}

describe("MeetingResponseCommand Tests (isolated)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<MeetingResponseCommandMongo>(MeetingResponseCommandMongo, { initialize: false });

        await expect((command as any).handle({})).rejects.toThrow(/internal error/i);
    });

    it("handle() throws NOT_FOUND when the caller's own mailbox has vanished since being resolved.", async () => {
        const { command } = build({ mailbox: undefined });

        await expect(command.handle(ctx(request(reply("1", "event-1"))))).rejects.toThrow(/no resource could be found/i);
    });

    it("handle() rejects a request with more Request elements than allowed.", async () => {
        const { command } = build();
        const requests = Array.from({ length: MAX_MEETING_RESPONSES + 1 }, () => reply("1", "event-1"));

        await expect(command.handle(ctx(request(...requests)))).rejects.toThrow(/invalid/i);
    });

    it("Answers every Request with its own Result, including an invalid UserResponse and a missing RequestId.", async () => {
        const { command } = build();

        const response = await command.handle(
            ctx(request(reply("1", "event-1"), reply("9", "event-1"), [textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "1")])),
        );

        expect(statuses(response)).toEqual(["1", "2", "2"]);
        expect(childText(findChildren(response!, "Result")[0], "CalendarId")).toBe("event-1");
        expect(findChild(findChildren(response!, "Result")[2], "RequestId")).toBeUndefined();
    });

    it("Records a decline as a status (keeping the event) when the caller may update but not delete it.", async () => {
        const aclUtils = { hasPermission: vi.fn().mockImplementation(async (_u: any, _f: any, action: string) => action !== "delete") };
        const { command, calendarEventRepo } = build({ aclUtils });

        const response = await command.handle(ctx(request(reply("3", "event-1"))));

        expect(statuses(response)).toEqual(["1"]);
        expect(childText(findChild(response!, "Result")!, "CalendarId")).toBe("event-1");
        expect(calendarEventRepo.delete).not.toHaveBeenCalled();
        expect(calendarEventRepo.update.mock.calls[0][0].attendees[0].responseStatus).toBe(AttendeeResponseStatus.DECLINED);
    });

    it("Reports Status 3 when recording the response fails.", async () => {
        const calendarEventRepo = { findOne: vi.fn().mockResolvedValue(event()), update: vi.fn().mockRejectedValue(new Error("conflict")), delete: vi.fn() };
        const { command, logger } = build({ calendarEventRepo });

        expect(statuses(await command.handle(ctx(request(reply("1", "event-1")))))).toEqual(["3"]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("conflict"));
    });

    it("Mails an iTIP REPLY to the organizer only when SendResponse is present, and reports Status 4 when the transport fails.", async () => {
        const { command, mailTransport } = build();

        await command.handle(ctx(request(reply("2", "event-1"))));
        expect(mailTransport.send).not.toHaveBeenCalled();

        await command.handle(ctx(request(reply("2", "event-1", true))));
        expect(mailTransport.send).toHaveBeenCalledTimes(1);
        const sent = mailTransport.send.mock.calls[0][0];
        expect(sent.envelopeFrom).toBe("me@example.com");
        expect(sent.envelopeTo).toEqual(["boss@example.com"]);
        const raw = sent.raw.toString("utf-8");
        expect(raw).toContain("Subject: Tentative: Planning");
        expect(raw).toContain("method=REPLY");
        expect(raw).toContain("PARTSTAT=TENTATIVE");

        const failing = build({ mailTransport: { send: vi.fn().mockRejectedValue(new Error("smtp down")) }, mailbox: { ...MAILBOX, displayName: undefined } });
        const failed = await failing.command.handle(ctx(request(reply("1", "event-1", true))));
        expect(statuses(failed)).toEqual(["4"]);
        // The response itself was recorded, so the event is still named.
        expect(childText(findChild(failed!, "Result")!, "CalendarId")).toBe("event-1");
        expect(failing.logger.warn).toHaveBeenCalledWith(expect.stringContaining("smtp down"));
    });

    it("Reports Status 4 when the transport accepts nothing or rejects the organizer, like restapi's sendOrThrow.", async () => {
        for (const result of [{ accepted: [], rejected: ["boss@example.com"] }, { accepted: ["boss@example.com"], rejected: ["boss@example.com"] }, undefined]) {
            const { command, logger } = build({ mailTransport: { send: vi.fn().mockResolvedValue(result) } });
            const response = await command.handle(ctx(request(reply("3", "event-1", true))));
            expect(statuses(response)).toEqual(["4"]);
            expect(findChild(findChild(response!, "Result")!, "CalendarId")).toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("did not accept"));
        }
    });

    it("Never lets the attendee's own copy look like the organizer cancelling or re-inviting to MeetingSchedulingJob.", async () => {
        // Decline: the copy is stamped as already cancelled before it's removed.
        const declined = build({ calendarEventRepo: { findOne: vi.fn().mockResolvedValue(event()), update: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue(undefined) } });
        await declined.command.handle(ctx(request(reply("3", "event-1"))));
        expect(declined.calendarEventRepo.update).toHaveBeenCalledWith(
            expect.objectContaining({ uid: "event-1", cancelNoticeSentAt: expect.any(Date) }),
            expect.anything(),
            expect.anything(),
        );
        expect(declined.calendarEventRepo.update.mock.invocationCallOrder[0]).toBeLessThan(declined.calendarEventRepo.delete.mock.invocationCallOrder[0]);

        // Already stamped: deleted without another write.
        const stamped = build({
            calendarEventRepo: { findOne: vi.fn().mockResolvedValue(event({ cancelNoticeSentAt: new Date() })), update: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) },
        });
        await stamped.command.handle(ctx(request(reply("3", "event-1"))));
        expect(stamped.calendarEventRepo.update).not.toHaveBeenCalled();
        expect(stamped.calendarEventRepo.delete).toHaveBeenCalled();

        // Accept: an out-of-date inviteSequenceSent is brought level with the sequence.
        const accepted = build({ calendarEventRepo: { findOne: vi.fn().mockResolvedValue(event({ sequence: 3 })), update: vi.fn().mockResolvedValue({}), delete: vi.fn() } });
        await accepted.command.handle(ctx(request(reply("1", "event-1"))));
        expect(accepted.calendarEventRepo.update.mock.calls[0][0].inviteSequenceSent).toBe(3);

        const inSync = build({
            calendarEventRepo: { findOne: vi.fn().mockResolvedValue(event({ sequence: 3, inviteSequenceSent: 3 })), update: vi.fn().mockResolvedValue({}), delete: vi.fn() },
        });
        await inSync.command.handle(ctx(request(reply("1", "event-1"))));
        expect(inSync.calendarEventRepo.update.mock.calls[0][0]).not.toHaveProperty("inviteSequenceSent");

        // The organizer's own copy (organizer is one of the caller's addresses) is left to the job.
        const own = build({
            calendarEventRepo: {
                findOne: vi.fn().mockResolvedValue(event({ sequence: undefined, organizer: { address: "ME@example.com", type: RecipientType.TO } })),
                update: vi.fn().mockResolvedValue({}),
                delete: vi.fn().mockResolvedValue(undefined),
            },
        });
        await own.command.handle(ctx(request(reply("1", "event-1"))));
        expect(own.calendarEventRepo.update.mock.calls[0][0]).not.toHaveProperty("inviteSequenceSent");
        await own.command.handle(ctx(request(reply("3", "event-1"))));
        expect(own.calendarEventRepo.update).toHaveBeenCalledTimes(1);
        expect(own.calendarEventRepo.delete).toHaveBeenCalled();
    });

    it("Resolves a meeting request message to the series master of the caller's own event, and treats unreadable or non-meeting messages as not found.", async () => {
        const ics = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:ical-1@example.com", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
        const mime = Buffer.from(
            [
                "From: boss@example.com",
                "To: me@example.com",
                "Subject: Planning",
                "MIME-Version: 1.0",
                'Content-Type: multipart/mixed; boundary="b"',
                "",
                "--b",
                "Content-Type: text/plain",
                "",
                "Invite",
                "--b",
                "Content-Type: text/calendar; method=REQUEST",
                "",
                ics,
                "--b--",
                "",
            ].join("\r\n"),
        );
        const calendarEventRepo = {
            findOne: vi.fn().mockResolvedValue(undefined),
            find: vi.fn().mockResolvedValue([event({ uid: "override", recurrenceId: new Date() }), event({ uid: "master" })]),
            update: vi.fn().mockResolvedValue({}),
            delete: vi.fn(),
        };
        const blobStore = {
            get: vi.fn().mockImplementation(async (key: string) => {
                if (key === "plain") return Buffer.from("Subject: hi\r\n\r\nno calendar here");
                if (key === "broken") throw new Error("missing blob");
                return mime;
            }),
        };
        const messages: Record<string, any> = {
            invite: { uid: "invite", folderUid: "inbox", bodyBlobKey: "invite" },
            plain: { uid: "plain", folderUid: "inbox", bodyBlobKey: "plain" },
            broken: { uid: "broken", folderUid: "inbox", bodyBlobKey: "broken" },
        };
        const messageRepo = { findOne: vi.fn().mockImplementation(async (uid: string) => messages[uid]) };
        const { command } = build({ calendarEventRepo, messageRepo, blobStore });

        const response = await command.handle(ctx(request(reply("1", "invite"), reply("1", "plain"), reply("1", "broken"), reply("1", "nothing"))));

        expect(statuses(response)).toEqual(["1", "2", "2", "2"]);
        expect(childText(findChildren(response!, "Result")[0], "CalendarId")).toBe("master");
        expect(calendarEventRepo.find).toHaveBeenCalledWith(
            expect.objectContaining({ mailboxUid: "mbx-1", icalUid: ModelUtils.literal("ical-1@example.com") }),
            expect.objectContaining({ ignoreACL: true }),
        );

        // Without READ on the message's folder the message is never opened.
        const denied = build({
            calendarEventRepo,
            messageRepo,
            blobStore,
            aclUtils: { hasPermission: vi.fn().mockImplementation(async (_u: any, uid: string) => uid !== "inbox") },
        });
        expect(statuses(await denied.command.handle(ctx(request(reply("1", "invite")))))).toEqual(["2"]);

        // A resolved UID with only an override row still answers with that row.
        calendarEventRepo.find.mockResolvedValueOnce([event({ uid: "only-override", recurrenceId: new Date() })]);
        const single = await command.handle(ctx(request(reply("1", "invite"))));
        expect(childText(findChild(single!, "Result")!, "CalendarId")).toBe("only-override");
    });

    describe("Round 5", () => {
        const inviteMime = (uid: string): Buffer =>
            Buffer.from(
                [
                    "From: boss@example.com",
                    "To: me@example.com",
                    "Subject: Planning",
                    "MIME-Version: 1.0",
                    'Content-Type: multipart/mixed; boundary="b"',
                    "",
                    "--b",
                    "Content-Type: text/calendar; method=REQUEST",
                    "",
                    ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", `UID:${uid}`, "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
                    "--b--",
                    "",
                ].join("\r\n"),
            );
        const byMessage = (uid: string, rows: any[]) => {
            const calendarEventRepo = {
                findOne: vi.fn().mockResolvedValue(undefined),
                find: vi.fn().mockResolvedValue(rows),
                update: vi.fn().mockResolvedValue({}),
                delete: vi.fn().mockResolvedValue(undefined),
            };
            const built = build({
                calendarEventRepo,
                messageRepo: { findOne: vi.fn().mockResolvedValue({ uid: "invite", folderUid: "inbox", bodyBlobKey: "invite" }) },
                blobStore: { get: vi.fn().mockResolvedValue(inviteMime(uid)) },
            });
            return { ...built, calendarEventRepo };
        };

        it("Never lets an operator-shaped iCalendar UID select another meeting: rows not exactly matching are ignored.", async () => {
            // A query parser would read `ne(x)` as "icalUid != x" and hand back unrelated meetings.
            const { command, calendarEventRepo } = byMessage("ne(x)", [event({ uid: "other", icalUid: "unrelated@example.com" })]);

            const response = await command.handle(ctx(request(reply("3", "invite"))));

            expect(statuses(response)).toEqual(["2"]);
            expect(calendarEventRepo.find.mock.calls[0][0].icalUid).toEqual(ModelUtils.literal("ne(x)"));
            expect(calendarEventRepo.update).not.toHaveBeenCalled();
            expect(calendarEventRepo.delete).not.toHaveBeenCalled();
        });

        it("Looks up an iCalendar UID over 255 characters by the bounded (hashed) value restapi stores.", async () => {
            const longUid = `${"u".repeat(300)}@example.com`;
            const key = `sha256:${createHash("sha256").update(longUid, "utf8").digest("hex")}`;
            const { command, calendarEventRepo } = byMessage(longUid, [event({ uid: "stored", icalUid: key }), event({ uid: "elsewhere", icalUid: key, mailboxUid: "mbx-2" })]);

            const response = await command.handle(ctx(request(reply("1", "invite"))));

            expect(statuses(response)).toEqual(["1"]);
            expect(calendarEventRepo.find.mock.calls[0][0].icalUid).toEqual(ModelUtils.literal(key));
            expect(childText(findChild(response!, "Result")!, "CalendarId")).toBe("stored");
        });

        it("Refuses a delegate's response on the owner's organizer copy, judging organizer-ness by the event's own mailbox.", async () => {
            const bossMailbox = { uid: "boss-mbx", primarySmtpAddress: "boss@example.com", aliasAddresses: [], displayName: "Boss" };
            const organizerCopy = event({ mailboxUid: "boss-mbx", organizer: { address: "boss@example.com", type: RecipientType.TO } });
            const { command, calendarEventRepo } = build({
                calendarEventRepo: { findOne: vi.fn().mockResolvedValue(organizerCopy), update: vi.fn(), delete: vi.fn() },
            });
            (command as any).mailboxRepo.findOne = vi.fn().mockImplementation(async (uid: string) => (uid === "boss-mbx" ? bossMailbox : MAILBOX));

            expect(statuses(await command.handle(ctx(request(reply("3", "event-1")))))).toEqual(["2"]);
            expect(calendarEventRepo.delete).not.toHaveBeenCalled();
            expect(calendarEventRepo.update).not.toHaveBeenCalled();

            // The owner's attendee copy of a third party's meeting is still fine (and stamped as an attendee copy).
            calendarEventRepo.findOne.mockResolvedValue(event({ mailboxUid: "boss-mbx", organizer: { address: "ceo@example.org", type: RecipientType.TO } }));
            calendarEventRepo.update.mockResolvedValue({});
            calendarEventRepo.delete.mockResolvedValue(undefined);
            expect(statuses(await command.handle(ctx(request(reply("3", "event-1")))))).toEqual(["1"]);
            expect(calendarEventRepo.update.mock.calls[0][0]).toHaveProperty("cancelNoticeSentAt");

            // An owner mailbox that no longer exists answers Status 2.
            (command as any).mailboxRepo.findOne = vi.fn().mockImplementation(async (uid: string) => (uid === "boss-mbx" ? undefined : MAILBOX));
            expect(statuses(await command.handle(ctx(request(reply("1", "event-1")))))).toEqual(["2"]);
        });

        it("Passes each event update a version-checked entity when the repository has a model class.", async () => {
            class FakeEntity {
                constructor(row: any) {
                    Object.assign(this, row);
                }
            }
            const calendarEventRepo = { modelClass: FakeEntity, findOne: vi.fn().mockResolvedValue(event()), update: vi.fn().mockResolvedValue({}), delete: vi.fn() };
            const { command } = build({ calendarEventRepo });

            await command.handle(ctx(request(reply("1", "event-1"))));

            expect(calendarEventRepo.update.mock.calls[0][1]).toBeInstanceOf(FakeEntity);
        });
    });

    describe("Trusted-role (admin) bypass regression - a trusted role must never substitute for a real ACL grant", () => {
        it("A trusted-role stranger with no grant on the event's folder gets Status 2 - UPDATE isn't substituted by the role.", async () => {
            const aclUtils = fakeMailAclUtils({});
            const { command } = build({ aclUtils });

            expect(statuses(await command.handle(ctx(request(reply("1", "event-1")), TRUSTED_STRANGER_USER)))).toEqual(["2"]);
        });

        it("A trusted-role stranger with only UPDATE (a real delegate grant) records a decline as a status instead of deleting - DELETE isn't substituted by the role.", async () => {
            const aclUtils = fakeMailAclUtils({ calendar: { [TRUSTED_STRANGER_USER.uid]: ["update"] } });
            const { command, calendarEventRepo } = build({ aclUtils });

            const response = await command.handle(ctx(request(reply("3", "event-1")), TRUSTED_STRANGER_USER));

            expect(statuses(response)).toEqual(["1"]);
            expect(calendarEventRepo.delete).not.toHaveBeenCalled();
            expect(calendarEventRepo.update.mock.calls[0][0].attendees[0].responseStatus).toBe(AttendeeResponseStatus.DECLINED);
        });

        it("A trusted-role stranger with no grant on the meeting-request message's folder can't use it to resolve an event - READ isn't substituted by the role.", async () => {
            const messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "invite", folderUid: "inbox", bodyBlobKey: "invite" }) };
            const aclUtils = fakeMailAclUtils({});
            const { command } = build({ messageRepo, aclUtils });

            expect(statuses(await command.handle(ctx(request(reply("1", "invite")), TRUSTED_STRANGER_USER)))).toEqual(["2"]);
        });
    });
});
