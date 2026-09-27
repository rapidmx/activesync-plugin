///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ComposeMailCommand's defensive guard clauses only - DI (via BaseEasRoute's own
// @Init) always populates every injected dependency before a real request can reach handle(), same rationale
// test/routes/BaseEasRoute.test.ts and test/eas/commands/FolderSyncCommand.test.ts already use for their own
// guard clauses. Every real SendMail/SmartForward/SmartReply behavior (relay, Sent Items persistence, Source
// resolution/threading, original-message flag flips, spam/transport rejection) is exercised via real HTTP+DB
// requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { SendMailCommandMongo } from "../../src/commands/mongo/SendMailCommandMongo.js";
import { stripHeader } from "../../src/commands/ComposeMailCommand.js";
import { childText, element, opaqueElement, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import { fakeMailAclUtils, TRUSTED_STRANGER_USER } from "../mailAccessTestUtils.js";

describe("ComposeMailCommand Tests (guard clauses only)", () => {
    const objectFactory = new ObjectFactory(config, Logger());

    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        // `initialize: false` skips `@Init` (and `@Inject`), leaving every dependency genuinely undefined -
        // exactly what this guard clause exists to catch.
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    it("handle() throws INVALID_REQUEST when the request body is absent.", async () => {
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        // Poking the private fields directly (TypeScript `private`/`protected` is compile-time only) isolates
        // this guard from the one above, which would otherwise fire first.
        (command as any).folderRepo = {};
        (command as any).messageRepo = {};
        (command as any).mailboxRepo = {};
        (command as any).blobStore = {};
        (command as any).mailTransport = {};
        (command as any).scanPipeline = {};

        // `ctx.request` undefined selects the modern raw-body shape (see this class's own doc comment), which
        // reads `ctx.req.rawBody`/`ctx.query` instead - both must be present (as `BaseEasRoute.dispatch()` always
        // provides them for a real request) for this guard, not the one above, to be the one that fires.
        await expect(command.handle({ request: undefined, req: {}, query: {} } as any)).rejects.toThrow(/mime body/i);
    });

    it("handle() throws NOT_FOUND when the caller's own mailbox has vanished, before relaying anything.", async () => {
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        const send = vi.fn();
        (command as any).folderRepo = {};
        (command as any).messageRepo = {};
        (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(undefined) };
        (command as any).blobStore = {};
        (command as any).mailTransport = { send };
        (command as any).scanPipeline = {};
        const mime = Buffer.from("From: me@example.com\r\nTo: you@example.com\r\nSubject: Hi\r\n\r\nBody");
        const request = element(WbxmlCodePage.ComposeMail, "SendMail", [opaqueElement(WbxmlCodePage.ComposeMail, "MIME", mime)]);

        await expect((command as any).handle({ mailboxUid: "gone", request })).rejects.toThrow(/no resource could be found/i);
        expect(send).not.toHaveBeenCalled();
    });

    it("handle() refuses a message with more than one From or Sender header with 403, before relaying anything.", async () => {
        const send = vi.fn();
        const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com", aliasAddresses: [] }) };
        for (const headers of [
            ["From: me@example.com", "from : ceo@example.com"],
            ["From: me@example.com", "Sender: me@example.com", "SENDER:ceo@example.com"],
        ]) {
            const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
            Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo, blobStore: {}, mailTransport: { send }, scanPipeline: {} });
            const mime = Buffer.from([...headers, "To: you@example.com", "Subject: Hi", "", "Body"].join("\r\n"));
            const request = element(WbxmlCodePage.ComposeMail, "SendMail", [opaqueElement(WbxmlCodePage.ComposeMail, "MIME", mime)]);

            await expect((command as any).handle({ mailboxUid: "mbx", request })).rejects.toMatchObject({ status: 403 });
        }
        expect(send).not.toHaveBeenCalled();
    });

    it("handle() answers Status 119 for a message with no recipient address and HTTP 400 for no From at all, relaying nothing.", async () => {
        const send = vi.fn();
        const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com", aliasAddresses: [] }) };
        const build = (headers: string[], cmd: string = "SendMail") => {
            const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
            Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo, blobStore: {}, mailTransport: { send }, scanPipeline: {} });
            const mime = Buffer.from([...headers, "Subject: Hi", "", "Body"].join("\r\n"));
            return { command, request: element(WbxmlCodePage.ComposeMail, cmd, [opaqueElement(WbxmlCodePage.ComposeMail, "MIME", mime)]) };
        };

        for (const headers of [["From: me@example.com"], ["From: me@example.com", "To: undisclosed-recipients:;", "Cc: "]]) {
            const { command, request } = build(headers);
            const response = await (command as any).handle({ mailboxUid: "mbx", request });
            expect(response.tag).toBe("SendMail");
            expect(childText(response, "Status")).toBe("119");
        }

        const { command, request } = build(["To: you@example.com"]);
        await expect((command as any).handle({ mailboxUid: "mbx", request })).rejects.toMatchObject({ status: 400 });
        expect(send).not.toHaveBeenCalled();
    });

    it("handle() throws INVALID_REQUEST for a MIME element present but carrying neither opaque nor text content.", async () => {
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo: {}, blobStore: {}, mailTransport: {}, scanPipeline: {} });
        // Unlike the "request body is absent" guard above, `MIME` is present as a child element - it just has no
        // opaque payload and no inline text, the shape `mimeEl?.opaque ?? (mimeEl?.text !== undefined ? ... : undefined)`
        // must also treat as "no body" rather than assuming a present element always carries content.
        const request = element(WbxmlCodePage.ComposeMail, "SendMail", [element(WbxmlCodePage.ComposeMail, "MIME", [])]);

        await expect((command as any).handle({ mailboxUid: "mbx", request })).rejects.toMatchObject({ status: 400 });
    });

    it("handle() reads the MIME body from inline text content, not just an opaque payload.", async () => {
        const send = vi.fn();
        const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com", aliasAddresses: [] }) };
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo, blobStore: {}, mailTransport: { send }, scanPipeline: {} });
        const mime = ["From: me@example.com", "Subject: Hi", "", "Body"].join("\r\n");
        // A `<MIME>` element carrying inline `STR_I` text rather than `OPAQUE` bytes - `mimeEl?.opaque` is
        // undefined here, so the fallback `mimeEl?.text !== undefined` branch must pick the text up instead.
        const request = element(WbxmlCodePage.ComposeMail, "SendMail", [textElement(WbxmlCodePage.ComposeMail, "MIME", mime)]);

        const response = await (command as any).handle({ mailboxUid: "mbx", request });

        expect(childText(response, "Status")).toBe("119");
        expect(send).not.toHaveBeenCalled();
    });

    it("handle() falls back to just the primary address when the mailbox has no aliasAddresses array at all.", async () => {
        const send = vi.fn();
        // No `aliasAddresses` key at all (not even `undefined` explicitly) - `[mailbox.primarySmtpAddress,
        // ...(mailbox.aliasAddresses ?? [])]` must not throw spreading a missing/undefined array.
        const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com" }) };
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo, blobStore: {}, mailTransport: { send }, scanPipeline: {} });
        const mime = Buffer.from(["From: me@example.com", "Subject: Hi", "", "Body"].join("\r\n"));
        const request = element(WbxmlCodePage.ComposeMail, "SendMail", [opaqueElement(WbxmlCodePage.ComposeMail, "MIME", mime)]);

        const response = await (command as any).handle({ mailboxUid: "mbx", request });

        expect(childText(response, "Status")).toBe("119");
        expect(send).not.toHaveBeenCalled();
    });

    it("handle() refuses a Source whose message the trusted-role caller has no ACL grant on, with 403 (READ isn't substituted by the role).", async () => {
        const send = vi.fn();
        const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com", aliasAddresses: [] }) };
        const messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "orig-1", folderUid: "inbox", references: [], messageId: "<orig@example.com>" }) };
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        Object.assign(command as any, {
            folderRepo: {},
            messageRepo,
            mailboxRepo,
            blobStore: {},
            mailTransport: { send },
            scanPipeline: {},
            aclUtils: fakeMailAclUtils({}),
        });
        const mime = Buffer.from(["From: me@example.com", "To: you@example.com", "Subject: Hi", "", "Body"].join("\r\n"));
        const request = element(WbxmlCodePage.ComposeMail, "SmartReply", [
            element(WbxmlCodePage.ComposeMail, "Source", [textElement(WbxmlCodePage.ComposeMail, "ItemId", "orig-1")]),
            opaqueElement(WbxmlCodePage.ComposeMail, "MIME", mime),
        ]);

        await expect((command as any).handle({ mailboxUid: "mbx", user: TRUSTED_STRANGER_USER, request })).rejects.toMatchObject({ status: 403 });
        expect(send).not.toHaveBeenCalled();
    });

    // The tests above all exercise the legacy, pre-14.0 WBXML-wrapped shape (`ctx.request` defined - MIME/
    // SaveInSentItems/Source all travel as WBXML elements), which `handle()` still supports for a client that
    // sends it despite negotiating a newer protocol version (see `ComposeMailCommand`'s own doc comment and
    // `BaseEasRoute.decodeRawBodyRequest()`). The tests below cover the modern, spec-correct shape used from
    // protocol 14.0 on: `ctx.request` is `undefined`, the MIME message is `ctx.req.rawBody` itself, and
    // `SaveInSentItems`/`ItemId` are read from `ctx.query` instead of WBXML elements.
    describe("modern raw-body shape (ctx.request undefined; MIME/SaveInSentItems/ItemId via req.rawBody/query)", () => {
        it("handle() throws INVALID_REQUEST when the raw body is absent.", async () => {
            const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
            Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo: {}, blobStore: {}, mailTransport: {}, scanPipeline: {} });

            await expect(command.handle({ req: {}, query: {} } as any)).rejects.toThrow(/mime body/i);
        });

        it("handle() throws NOT_FOUND when the caller's own mailbox has vanished, before relaying anything.", async () => {
            const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
            const send = vi.fn();
            Object.assign(command as any, {
                folderRepo: {},
                messageRepo: {},
                mailboxRepo: { findOne: vi.fn().mockResolvedValue(undefined) },
                blobStore: {},
                mailTransport: { send },
                scanPipeline: {},
            });
            const mime = Buffer.from("From: me@example.com\r\nTo: you@example.com\r\nSubject: Hi\r\n\r\nBody");

            await expect(
                (command as any).handle({ mailboxUid: "gone", req: { rawBody: mime } as any, query: {} }),
            ).rejects.toThrow(/no resource could be found/i);
            expect(send).not.toHaveBeenCalled();
        });

        it("handle() refuses a message with more than one From or Sender header with 403, before relaying anything.", async () => {
            const send = vi.fn();
            const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com", aliasAddresses: [] }) };
            for (const headers of [
                ["From: me@example.com", "from : ceo@example.com"],
                ["From: me@example.com", "Sender: me@example.com", "SENDER:ceo@example.com"],
            ]) {
                const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
                Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo, blobStore: {}, mailTransport: { send }, scanPipeline: {} });
                const mime = Buffer.from([...headers, "To: you@example.com", "Subject: Hi", "", "Body"].join("\r\n"));

                await expect(
                    (command as any).handle({ mailboxUid: "mbx", req: { rawBody: mime } as any, query: {} }),
                ).rejects.toMatchObject({ status: 403 });
            }
            expect(send).not.toHaveBeenCalled();
        });

        it("handle() answers Status 119 for a message with no recipient address and HTTP 400 for no From at all, relaying nothing.", async () => {
            const send = vi.fn();
            const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com", aliasAddresses: [] }) };
            const build = (headers: string[]) => {
                const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
                Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo, blobStore: {}, mailTransport: { send }, scanPipeline: {} });
                const mime = Buffer.from([...headers, "Subject: Hi", "", "Body"].join("\r\n"));
                return { command, req: { rawBody: mime } as any };
            };

            for (const headers of [["From: me@example.com"], ["From: me@example.com", "To: undisclosed-recipients:;", "Cc: "]]) {
                const { command, req } = build(headers);
                const response = await (command as any).handle({ mailboxUid: "mbx", req, query: {} });
                expect(response.tag).toBe("SendMail");
                expect(childText(response, "Status")).toBe("119");
            }

            const { command, req } = build(["To: you@example.com"]);
            await expect((command as any).handle({ mailboxUid: "mbx", req, query: {} })).rejects.toMatchObject({ status: 400 });
            expect(send).not.toHaveBeenCalled();
        });

        it("handle() falls back to just the primary address when the mailbox has no aliasAddresses array at all.", async () => {
            const send = vi.fn();
            // No `aliasAddresses` key at all (not even `undefined` explicitly) - `[mailbox.primarySmtpAddress,
            // ...(mailbox.aliasAddresses ?? [])]` must not throw spreading a missing/undefined array.
            const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com" }) };
            const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
            Object.assign(command as any, { folderRepo: {}, messageRepo: {}, mailboxRepo, blobStore: {}, mailTransport: { send }, scanPipeline: {} });
            const mime = Buffer.from(["From: me@example.com", "Subject: Hi", "", "Body"].join("\r\n"));

            const response = await (command as any).handle({ mailboxUid: "mbx", req: { rawBody: mime } as any, query: {} });

            expect(childText(response, "Status")).toBe("119");
            expect(send).not.toHaveBeenCalled();
        });

        it("handle() reads ItemId from the query string, refusing a Source whose message the trusted-role caller has no ACL grant on, with 403 (READ isn't substituted by the role).", async () => {
            const send = vi.fn();
            const mailboxRepo = { findOne: vi.fn().mockResolvedValue({ primarySmtpAddress: "me@example.com", aliasAddresses: [] }) };
            const messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "orig-1", folderUid: "inbox", references: [], messageId: "<orig@example.com>" }) };
            const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
            Object.assign(command as any, {
                folderRepo: {},
                messageRepo,
                mailboxRepo,
                blobStore: {},
                mailTransport: { send },
                scanPipeline: {},
                aclUtils: fakeMailAclUtils({}),
            });
            const mime = Buffer.from(["From: me@example.com", "To: you@example.com", "Subject: Hi", "", "Body"].join("\r\n"));

            await expect(
                (command as any).handle({
                    mailboxUid: "mbx",
                    user: TRUSTED_STRANGER_USER,
                    req: { rawBody: mime } as any,
                    query: { ItemId: "orig-1" },
                }),
            ).rejects.toMatchObject({ status: 403 });
            expect(send).not.toHaveBeenCalled();
        });
    });

    describe("stripHeader", () => {
        it("Removes every occurrence of the header, case-insensitively, with its folded continuation lines, keeping other folded headers.", () => {
            const raw = Buffer.from(
                ["From: me@example.com", "Bcc: a@example.com,", " b@example.com", "Subject: long", "\tsubject continued", "bcc: c@example.com", "", "Bcc: in the body stays"].join("\r\n"),
            );
            expect(stripHeader(raw, "Bcc").toString("latin1")).toBe(
                ["From: me@example.com", "Subject: long", "\tsubject continued", "", "Bcc: in the body stays"].join("\r\n"),
            );
        });

        it("Handles LF-only messages, a message with no body at all, and preserves non-UTF-8 bytes.", () => {
            expect(stripHeader(Buffer.from("To: x\nBcc: y\n\nbody\r\n\r\nmore"), "bcc").toString("latin1")).toBe("To: x\n\nbody\r\n\r\nmore");
            expect(stripHeader(Buffer.from("To: x\r\nBcc: y"), "bcc").toString("latin1")).toBe("To: x\r\n");
            const binary = Buffer.concat([Buffer.from("X-Bin: "), Buffer.from([0xff, 0xfe]), Buffer.from("\r\nBcc: z\r\n\r\n")]);
            expect(stripHeader(binary, "bcc")).toEqual(Buffer.concat([Buffer.from("X-Bin: "), Buffer.from([0xff, 0xfe]), Buffer.from("\r\n\r\n")]));
        });
    });
});
