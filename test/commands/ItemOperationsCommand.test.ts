///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for ItemOperationsCommand's defensive dependency guard clause only - DI (via
// BaseEasRoute's own @Init) always populates every injected dependency before a real request can reach
// handle(), same rationale test/eas/commands/ComposeMailCommand.test.ts already uses for its own guard
// clause. Every real Fetch behavior (message body, attachment content, 404/403/400 branches) is exercised via
// real HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ModelUtils, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ItemOperationsCommandMongo } from "../../src/commands/mongo/ItemOperationsCommandMongo.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import { MAX_EMPTY_FOLDER_BATCHES } from "../../src/commands/ItemOperationsCommand.js";
import { encodeConversationId } from "../../src/adapters/EmailSyncAdapter.js";
import { childText, element, findChild, opaqueElement, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { createHash } from "crypto";
import { FolderType } from "@rapidmx/restapi";
import { fakeMailAclUtils, TRUSTED_STRANGER_USER } from "../mailAccessTestUtils.js";

describe("ItemOperationsCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<ItemOperationsCommandMongo>(ItemOperationsCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    describe("bulk operations (isolated)", () => {
        /** Builds a command over an in-memory folder of messages whose delete/update fails for the given uids. */
        function build(messages: any[], failing: Set<string>, folderTypes: Record<string, FolderType> = {}) {
            const objectFactory = new ObjectFactory(config, Logger());
            const command = objectFactory.newInstance<ItemOperationsCommandMongo>(ItemOperationsCommandMongo, { initialize: false }) as any;
            let rows = [...messages];
            const messageRepo = {
                find: vi.fn().mockImplementation(async (query: any) => rows.filter((m) => !query.folderUid || m.folderUid === query.folderUid).slice(0, query.limit)),
                delete: vi.fn().mockImplementation(async (uid: string) => {
                    if (failing.has(uid)) throw new Error("version conflict");
                    rows = rows.filter((m) => m.uid !== uid);
                }),
                update: vi.fn().mockImplementation(async (values: any) => {
                    if (failing.has(values.uid)) throw new Error("version conflict");
                    return values;
                }),
            };
            Object.assign(command, {
                folderRepo: { findOne: vi.fn().mockImplementation(async (uid: string) => (uid === "gone" ? undefined : { uid, mailboxUid: "mbx", type: folderTypes[uid] })) },
                messageRepo,
                attachmentRepo: {},
                mailboxRepo: { findOne: vi.fn().mockResolvedValue({ uid: "mbx", ownerUserUid: "u" }) },
                blobStore: {},
                aclUtils: { hasPermission: vi.fn().mockResolvedValue(true) },
                batchSize: 2,
            });
            return { command, messageRepo };
        }
        const ctx = (request: any) => ({ user: { uid: "u" }, mailboxUid: "mbx", request }) as unknown as EasCommandContext;
        const empty = () =>
            element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                element(WbxmlCodePage.ItemOperations, "EmptyFolderContents", [textElement(WbxmlCodePage.AirSync, "CollectionId", "f1")]),
            ]);
        const emptyStatus = (response: any) => childText(findChild(findChild(response, "Response")!, "EmptyFolderContents")!, "Status");
        const messages = (count: number) => Array.from({ length: count }, (_, i) => ({ uid: `m${i}`, version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: "conv" }));

        it("EmptyFolderContents skips a message that fails to delete and reports Status 17, or Status 3 when nothing could be deleted.", async () => {
            const { command, messageRepo } = build(messages(5), new Set(["m1"]));
            expect(emptyStatus(await command.handle(ctx(empty())))).toBe("17");
            expect(messageRepo.delete).toHaveBeenCalledTimes(5);

            const { command: stuck } = build(messages(2), new Set(["m0", "m1"]));
            expect(emptyStatus(await stuck.handle(ctx(empty())))).toBe("3");

            const { command: clean } = build(messages(3), new Set());
            expect(emptyStatus(await clean.handle(ctx(empty())))).toBe("1");
        });

        it("EmptyFolderContents skips a message whose send lease is live, reporting partial success.", async () => {
            const rows = messages(3);
            (rows[1] as any).scheduledSendLeaseExpiresAt = new Date(Date.now() + 60_000);
            (rows[2] as any).scheduledSendLeaseExpiresAt = new Date(Date.now() - 1000);
            const { command, messageRepo } = build(rows, new Set());
            expect(emptyStatus(await command.handle(ctx(empty())))).toBe("17");
            expect(messageRepo.delete.mock.calls.map(([uid]: any[]) => uid)).toEqual(["m0", "m2"]);
        });

        it("EmptyFolderContents deletes at most MAX_EMPTY_FOLDER_BATCHES batches per request, reporting the rest as partial.", async () => {
            const { command, messageRepo } = build(messages(MAX_EMPTY_FOLDER_BATCHES * 2 + 1), new Set());
            expect(emptyStatus(await command.handle(ctx(empty())))).toBe("17");
            expect(messageRepo.delete).toHaveBeenCalledTimes(MAX_EMPTY_FOLDER_BATCHES * 2);
        });

        it("Move reports Status 17 when some messages of the conversation fail to move, and Status 3 when all do.", async () => {
            const move = () =>
                element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                    element(WbxmlCodePage.ItemOperations, "Move", [
                        opaqueElement(WbxmlCodePage.ItemOperations, "ConversationId", encodeConversationId("conv")),
                        textElement(WbxmlCodePage.ItemOperations, "DstFldId", "dest"),
                    ]),
                ]);
            const moveStatus = (response: any) => childText(findChild(findChild(response, "Response")!, "Move")!, "Status");

            const { command } = build(messages(2), new Set(["m0"]));
            expect(moveStatus(await command.handle(ctx(move())))).toBe("17");
            const { command: failing } = build(messages(2), new Set(["m0", "m1"]));
            expect(moveStatus(await failing.handle(ctx(move())))).toBe("3");
        });

        const moveTo = (conversationId: string, dest: string = "dest") =>
            element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                element(WbxmlCodePage.ItemOperations, "Move", [
                    opaqueElement(WbxmlCodePage.ItemOperations, "ConversationId", encodeConversationId(conversationId)),
                    textElement(WbxmlCodePage.ItemOperations, "DstFldId", dest),
                ]),
            ]);
        const statusOf = (response: any) => childText(findChild(findChild(response, "Response")!, "Move")!, "Status");

        it("Move exact-matches the ConversationId in memory, so an operator-shaped id never moves other conversations.", async () => {
            // The fake find ignores conversationId entirely, like a query parser reading `ne(conv)` as "not conv".
            const rows = [{ uid: "target", version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: "ne(conv)" }, messages(1)[0]];
            const { command, messageRepo } = build(rows, new Set());

            expect(statusOf(await command.handle(ctx(moveTo("ne(conv)"))))).toBe("1");
            expect(messageRepo.update.mock.calls.map(([values]: any[]) => values.uid)).toEqual(["target"]);
            expect(messageRepo.find.mock.calls[0][0].conversationId).toEqual(ModelUtils.literal("ne(conv)"));
        });

        it("Move looks an over-long ConversationId up by its bounded (hashed) value.", async () => {
            const longId = "c".repeat(300);
            const key = `sha256:${createHash("sha256").update(longId, "utf8").digest("hex")}`;
            const { command, messageRepo } = build([{ uid: "m", version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: key }], new Set());

            expect(statusOf(await command.handle(ctx(moveTo(longId))))).toBe("1");
            expect(messageRepo.find.mock.calls[0][0].conversationId).toEqual(ModelUtils.literal(key));
        });

        it("Move refuses Outbox, and Drafts for messages that aren't drafts, cancelling the send of a message leaving Outbox.", async () => {
            const folderTypes = { f1: FolderType.INBOX, drafts: FolderType.DRAFTS, outbox: FolderType.OUTBOX, queued: FolderType.OUTBOX, dest: FolderType.ARCHIVE };
            const { command, messageRepo } = build(messages(2), new Set(), folderTypes);
            expect(statusOf(await command.handle(ctx(moveTo("conv", "drafts"))))).toBe("3");
            expect(statusOf(await command.handle(ctx(moveTo("conv", "outbox"))))).toBe("3");
            expect(messageRepo.update).not.toHaveBeenCalled();

            const mixed = [
                { uid: "q", version: 1, folderUid: "queued", mailboxUid: "mbx", conversationId: "conv", scheduledSendTime: new Date() },
                { uid: "i", version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: "conv" },
            ];
            const { command: partial, messageRepo: partialRepo } = build(mixed, new Set(), folderTypes);
            expect(statusOf(await partial.handle(ctx(moveTo("conv", "drafts"))))).toBe("17");
            expect(partialRepo.update.mock.calls[0][0]).toEqual({ uid: "q", version: 1, folderUid: "drafts", scheduledSendTime: null });
        });

        it("EmptyFolderContents answers 404 for a folder that doesn't exist, never querying by the client's string.", async () => {
            const { command, messageRepo } = build(messages(1), new Set());
            const request = element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                element(WbxmlCodePage.ItemOperations, "EmptyFolderContents", [textElement(WbxmlCodePage.AirSync, "CollectionId", "gone")]),
            ]);

            await expect(command.handle(ctx(request))).rejects.toMatchObject({ status: 404 });
            expect(messageRepo.find).not.toHaveBeenCalled();
        });

        it("EmptyFolderContents: a trusted-role stranger with only READ (a real delegate grant) on the folder still gets 403 on DELETE, not let through by the role.", async () => {
            const { command } = build(messages(1), new Set());
            command.aclUtils = fakeMailAclUtils({ f1: { [TRUSTED_STRANGER_USER.uid]: ["read"] } });
            const adminCtx = { user: TRUSTED_STRANGER_USER, mailboxUid: "mbx", request: empty() } as unknown as EasCommandContext;

            await expect(command.handle(adminCtx)).rejects.toMatchObject({ status: 403 });
        });

        it("Move: a trusted-role stranger with only READ on the destination still gets every move refused (Status 3), not let through by the role.", async () => {
            const { command, messageRepo } = build(messages(2), new Set());
            command.aclUtils = fakeMailAclUtils({ dest: { [TRUSTED_STRANGER_USER.uid]: ["read"] } });
            const adminCtx = { user: TRUSTED_STRANGER_USER, mailboxUid: "mbx", request: moveTo("conv") } as unknown as EasCommandContext;

            expect(statusOf(await command.handle(adminCtx))).toBe("3");
            expect(messageRepo.update).not.toHaveBeenCalled();
        });

        it("Move: a trusted-role stranger with CREATE on the destination but no grant on the source folder still can't move anything (Status 3).", async () => {
            const { command, messageRepo } = build(messages(2), new Set());
            command.aclUtils = fakeMailAclUtils({ dest: { [TRUSTED_STRANGER_USER.uid]: ["create"] } });
            const adminCtx = { user: TRUSTED_STRANGER_USER, mailboxUid: "mbx", request: moveTo("conv") } as unknown as EasCommandContext;

            expect(statusOf(await command.handle(adminCtx))).toBe("3");
            expect(messageRepo.update).not.toHaveBeenCalled();
        });
    });

    describe("Round 6: audit of non-owner access", () => {
        const mailboxes: Record<string, any> = { mbx: { uid: "mbx", ownerUserUid: "u" }, other: { uid: "other", ownerUserUid: "boss" } };
        const rows: Record<string, any> = {
            own: { uid: "own", version: 1, folderUid: "f-own", mailboxUid: "mbx", subject: "Mine", bodyBlobKey: "b/own" },
            theirs: { uid: "theirs", version: 1, folderUid: "f-other", mailboxUid: "other", subject: "Payroll", bodyBlobKey: "b/theirs" },
            orphan: { uid: "orphan", version: 1, folderUid: "f-gone", mailboxUid: "deleted-mailbox", subject: "Orphan", bodyBlobKey: "b/orphan" },
        };

        /** A command over in-memory rows whose audit entries go through restapi's real `recordAuditLog()` into `written`. */
        function buildAudited(folderRows: any[] = []) {
            const objectFactory = new ObjectFactory(config, Logger());
            const command = objectFactory.newInstance<ItemOperationsCommandMongo>(ItemOperationsCommandMongo, { initialize: false }) as any;
            class FakeAuditLogEntry {
                constructor(values: any) {
                    Object.assign(this, values);
                }
            }
            const written: any[] = [];
            vi.spyOn(command._objectFactory, "newInstance").mockResolvedValue({ create: vi.fn(async (entry: any) => written.push(entry)) });
            let remaining = [...folderRows];
            Object.assign(command, {
                auditLogClass: FakeAuditLogEntry,
                config,
                folderRepo: { findOne: vi.fn(async (uid: string) => ({ uid, mailboxUid: uid === "f-other" ? "other" : "mbx" })) },
                messageRepo: {
                    findOne: vi.fn(async (uid: string) => rows[uid]),
                    find: vi.fn(async (query: any) => remaining.slice(0, query.limit)),
                    delete: vi.fn(async (uid: string) => {
                        remaining = remaining.filter((row) => row.uid !== uid);
                    }),
                },
                attachmentRepo: {
                    findOne: vi.fn(async (uid: string) => ({ uid, messageUid: uid.replace("att-", ""), filename: "pay.pdf", mimeType: "application/pdf", sizeBytes: 3, blobKey: "a/x" })),
                },
                mailboxRepo: { findOne: vi.fn(async (uid: string) => mailboxes[uid]) },
                blobStore: { get: vi.fn(async () => Buffer.from("abc")) },
                aclUtils: { hasPermission: vi.fn().mockResolvedValue(true) },
                batchSize: 2,
            });
            return { command, written };
        }
        const auditCtx = (children: any[]) =>
            ({ user: { uid: "u" }, mailboxUid: "mbx", deviceId: "dev-9", request: element(WbxmlCodePage.ItemOperations, "ItemOperations", children) }) as unknown as EasCommandContext;
        const fetchBody = (serverId: string) =>
            element(WbxmlCodePage.ItemOperations, "Fetch", [
                textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                textElement(WbxmlCodePage.AirSync, "ServerId", serverId),
                element(WbxmlCodePage.ItemOperations, "Options", [element(WbxmlCodePage.AirSyncBase, "BodyPreference", [textElement(WbxmlCodePage.AirSyncBase, "Type", "4")])]),
            ]);
        const fetchAttachment = (fileReference: string) =>
            element(WbxmlCodePage.ItemOperations, "Fetch", [
                textElement(WbxmlCodePage.ItemOperations, "Store", "Mailbox"),
                textElement(WbxmlCodePage.AirSyncBase, "FileReference", fileReference),
            ]);

        it("Records one MESSAGE_CONTENT_ACCESSED entry per fetched body or attachment of a mailbox the caller doesn't own.", async () => {
            const { command, written } = buildAudited();

            await command.handle(auditCtx([fetchBody("own"), fetchBody("theirs"), fetchBody("orphan"), fetchAttachment("att-theirs"), fetchAttachment("att-own")]));

            expect(written.map((entry) => [entry.action, entry.targetType, entry.targetUid, entry.mailboxUid])).toEqual([
                ["message.content_accessed", "Message", "theirs", "other"],
                // A mailbox that can't be found counts as non-owner access.
                ["message.content_accessed", "Message", "orphan", "deleted-mailbox"],
                ["message.content_accessed", "Attachment", "att-theirs", "other"],
            ]);
            expect(written[0]).toMatchObject({ actorUserUid: "u", details: { protocol: "ActiveSync", command: "ItemOperations", deviceId: "dev-9", subject: "Payroll", bodyType: "4" } });
            expect(written[2].details).toMatchObject({ messageUid: "theirs", filename: "pay.pdf" });
            // The other mailbox is looked up once, the caller's own never.
            expect(command.mailboxRepo.findOne.mock.calls.map(([uid]: any[]) => uid)).toEqual(["other", "deleted-mailbox"]);
        });

        it("Records nothing for a Fetch answered with Status 11 instead of content.", async () => {
            const { command, written } = buildAudited();
            command.maxResponseBytes = 1;

            await command.handle(auditCtx([fetchBody("theirs"), fetchAttachment("att-theirs")]));

            expect(written).toEqual([]);
        });

        it("Records one MESSAGE_DELETE entry per EmptyFolderContents batch in another owner's folder, and none in the caller's own.", async () => {
            const folderRows = Array.from({ length: 3 }, (_, i) => ({ uid: `m${i}`, folderUid: "f-other", mailboxUid: "other" }));
            const empty = (folderUid: string) => element(WbxmlCodePage.ItemOperations, "EmptyFolderContents", [textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid)]);

            const { command, written } = buildAudited(folderRows);
            await command.handle(auditCtx([empty("f-other")]));
            expect(written.map((entry) => [entry.action, entry.targetType, entry.targetUid, entry.details.count, entry.details.messageUids])).toEqual([
                ["message.delete", "Folder", "f-other", 2, ["m0", "m1"]],
                ["message.delete", "Folder", "f-other", 1, ["m2"]],
            ]);

            const { command: own, written: ownWritten } = buildAudited(folderRows);
            await own.handle(auditCtx([empty("f-own")]));
            expect(ownWritten).toEqual([]);
        });

        it("Never fails the command when the audit entry can't be written.", async () => {
            const { command } = buildAudited();
            vi.spyOn(command._objectFactory, "newInstance").mockRejectedValue(new Error("audit store down"));
            command.logger = { warn: vi.fn() };
            command.mailboxRepo.findOne.mockRejectedValue(new Error("db down"));

            const response = await command.handle(auditCtx([fetchBody("theirs")]));

            expect(childText(findChild(findChild(response, "Response")!, "Fetch")!, "Status")).toBe("1");
            expect(command.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Failed to persist audit log entry.*audit store down/));
        });

        it("Fetch (Message body): a trusted-role stranger with READ elsewhere but not on this folder still gets 403, not let through by the role.", async () => {
            const { command } = buildAudited();
            command.aclUtils = fakeMailAclUtils({ "f-own": { [TRUSTED_STRANGER_USER.uid]: ["read"] } });
            const request = element(WbxmlCodePage.ItemOperations, "ItemOperations", [fetchBody("theirs")]);
            const adminCtx = { user: TRUSTED_STRANGER_USER, mailboxUid: "mbx", deviceId: "dev-9", request } as unknown as EasCommandContext;

            await expect(command.handle(adminCtx)).rejects.toMatchObject({ status: 403 });
        });

        it("Fetch (Attachment): a trusted-role stranger with no grant at all on the owning message's folder still gets 403, not let through by the role.", async () => {
            const { command } = buildAudited();
            command.aclUtils = fakeMailAclUtils({});
            const request = element(WbxmlCodePage.ItemOperations, "ItemOperations", [fetchAttachment("att-theirs")]);
            const adminCtx = { user: TRUSTED_STRANGER_USER, mailboxUid: "mbx", deviceId: "dev-9", request } as unknown as EasCommandContext;

            await expect(command.handle(adminCtx)).rejects.toMatchObject({ status: 403 });
        });
    });
});
