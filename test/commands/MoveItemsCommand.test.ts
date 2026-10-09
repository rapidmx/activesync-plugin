///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for the MoveItems branch a real single request can't reach deterministically: the update
// itself failing (a concurrent edit's version conflict between the read and the write). Every other status is
// exercised over real HTTP+DB in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { FolderType, refreshFolderCounts } from "@rapidmx/restapi";
import { MoveItemsCommandMongo } from "../../src/commands/mongo/MoveItemsCommandMongo.js";
import { childText, element, findChildren, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import { fakeMailAclUtils, TRUSTED_STRANGER_USER } from "../mailAccessTestUtils.js";

// refreshFolderCounts() never throws, so its call is observed directly rather than through its effects.
vi.mock("@rapidmx/restapi", async (importActual) => ({ ...(await importActual<typeof import("@rapidmx/restapi")>()), refreshFolderCounts: vi.fn() }));

describe("MoveItemsCommand Tests (isolated)", () => {
    beforeEach(() => {
        vi.mocked(refreshFolderCounts).mockClear();
    });

    it("Returns an empty MoveItems response with no Move elements when the request body is absent.", async () => {
        const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;

        const response = await command.handle({ user: { uid: "u" }, request: undefined });

        expect(response.tag).toBe("MoveItems");
        expect(findChildren(response, "Response")).toEqual([]);
    });

    it("Omits SrcMsgId from the Response when the Move element didn't carry one at all.", async () => {
        const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;
        const move = element(WbxmlCodePage.Move, "Move", [
            textElement(WbxmlCodePage.Move, "SrcFldId", "inbox"),
            textElement(WbxmlCodePage.Move, "DstFldId", "archive"),
        ]);

        const response = await command.handle({ user: { uid: "u" }, request: element(WbxmlCodePage.Move, "MoveItems", [move]) });

        const only = findChildren(response, "Response")[0];
        expect(childText(only, "SrcMsgId")).toBeUndefined();
        expect(childText(only, "Status")).toBe("1");
    });

    it("Distinguishes a refused destination (Status 2) from a refused, locked move (Status 7) via planMessageMove's own reason.", async () => {
        const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;
        const messages: Record<string, any> = {
            "into-outbox": { uid: "into-outbox", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
            "in-flight": {
                uid: "in-flight",
                version: 1,
                folderUid: "inbox",
                mailboxUid: "mbx",
                scheduledSendLeaseExpiresAt: new Date(Date.now() + 60_000),
            },
        };
        const folders: Record<string, any> = {
            inbox: { uid: "inbox", type: FolderType.INBOX, mailboxUid: "mbx" },
            outbox: { uid: "outbox", type: FolderType.OUTBOX, mailboxUid: "mbx" },
            archive: { uid: "archive", type: FolderType.ARCHIVE, mailboxUid: "mbx" },
        };
        command.messageRepo = { findOne: vi.fn().mockImplementation(async (uid: string) => messages[uid]) };
        command.folderRepo = { findOne: vi.fn().mockImplementation(async (uid: string) => folders[uid]) };
        command.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        const move = (uid: string, dstFldId: string) =>
            element(WbxmlCodePage.Move, "Move", [
                textElement(WbxmlCodePage.Move, "SrcMsgId", uid),
                textElement(WbxmlCodePage.Move, "SrcFldId", "inbox"),
                textElement(WbxmlCodePage.Move, "DstFldId", dstFldId),
            ]);

        const response = await command.handle({
            user: { uid: "u" },
            request: element(WbxmlCodePage.Move, "MoveItems", [move("into-outbox", "outbox"), move("in-flight", "archive")]),
        });

        expect(findChildren(response, "Response").map((r) => [childText(r, "SrcMsgId"), childText(r, "Status")])).toEqual([
            ["into-outbox", "2"],
            ["in-flight", "7"],
        ]);
    });

    it("Reports Status 7 for a move whose update fails, without aborting the other moves in the request.", async () => {
        const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;
        const messages: Record<string, any> = {
            locked: { uid: "locked", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
            fine: { uid: "fine", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
        };
        command.messageRepo = {
            findOne: vi.fn().mockImplementation(async (uid: string) => messages[uid]),
            update: vi.fn().mockImplementation(async (values: any) => {
                if (values.uid === "locked") {
                    throw new Error("version conflict");
                }
                return values;
            }),
        };
        command.folderRepo = { findOne: vi.fn().mockResolvedValue({ uid: "archive", mailboxUid: "mbx" }) };
        command.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        const move = (uid: string) =>
            element(WbxmlCodePage.Move, "Move", [
                textElement(WbxmlCodePage.Move, "SrcMsgId", uid),
                textElement(WbxmlCodePage.Move, "SrcFldId", "inbox"),
                textElement(WbxmlCodePage.Move, "DstFldId", "archive"),
            ]);

        const response = await command.handle({ user: { uid: "u" }, request: element(WbxmlCodePage.Move, "MoveItems", [move("locked"), move("fine")]) });

        expect(findChildren(response, "Response").map((r) => [childText(r, "SrcMsgId"), childText(r, "Status"), childText(r, "DstMsgId")])).toEqual([
            ["locked", "7", undefined],
            ["fine", "3", "fine"],
        ]);
    });

    describe("Live updates and folder counts", () => {
        const move = (uid: string, srcFldId: string, dstFldId: string) =>
            element(WbxmlCodePage.Move, "Move", [
                textElement(WbxmlCodePage.Move, "SrcMsgId", uid),
                textElement(WbxmlCodePage.Move, "SrcFldId", srcFldId),
                textElement(WbxmlCodePage.Move, "DstFldId", dstFldId),
            ]);

        const newCommand = (messages: Record<string, any>, update: (values: any) => Promise<any>) => {
            const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;
            const folders: Record<string, any> = {
                inbox: { uid: "inbox", type: FolderType.INBOX, mailboxUid: "mbx" },
                archive: { uid: "archive", type: FolderType.ARCHIVE, mailboxUid: "mbx" },
                junk: { uid: "junk", type: FolderType.JUNK, mailboxUid: "mbx" },
                outbox: { uid: "outbox", type: FolderType.OUTBOX, mailboxUid: "mbx" },
            };
            command.messageRepo = { findOne: vi.fn().mockImplementation(async (uid: string) => messages[uid]), update: vi.fn().mockImplementation(update) };
            command.folderRepo = { findOne: vi.fn().mockImplementation(async (uid: string) => folders[uid]) };
            command.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
            command.notificationUtils = { sendMessage: vi.fn() };
            return command;
        };

        it("Publishes the saved row as an update on the destination folder and a delete on the source folder for a successful move.", async () => {
            const saved = { uid: "m1", version: 2, folderUid: "archive", mailboxUid: "mbx", subject: "saved" };
            const command = newCommand({ m1: { uid: "m1", version: 1, folderUid: "inbox", mailboxUid: "mbx" } }, async () => saved);

            const response = await command.handle({ user: { uid: "u" }, request: element(WbxmlCodePage.Move, "MoveItems", [move("m1", "inbox", "archive")]) });

            expect(childText(findChildren(response, "Response")[0], "Status")).toBe("3");
            expect(command.notificationUtils.sendMessage.mock.calls).toEqual([
                ["archive", "MessageMongo", "update", saved],
                ["inbox", "MessageMongo", "delete", { uid: "m1" }],
            ]);
        });

        it("Publishes nothing and refreshes no counts when every move fails or is refused.", async () => {
            const command = newCommand(
                {
                    locked: { uid: "locked", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
                    "into-outbox": { uid: "into-outbox", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
                    "wrong-source": { uid: "wrong-source", version: 1, folderUid: "junk", mailboxUid: "mbx" },
                },
                async () => {
                    throw new Error("version conflict");
                },
            );

            const response = await command.handle({
                user: { uid: "u" },
                request: element(WbxmlCodePage.Move, "MoveItems", [
                    move("locked", "inbox", "archive"),
                    move("into-outbox", "inbox", "outbox"),
                    move("wrong-source", "inbox", "archive"),
                    move("missing", "inbox", "archive"),
                    move("locked", "inbox", "inbox"),
                ]),
            });

            expect(findChildren(response, "Response").map((r) => childText(r, "Status"))).toEqual(["7", "2", "1", "1", "4"]);
            expect(command.notificationUtils.sendMessage).not.toHaveBeenCalled();
            expect(refreshFolderCounts).not.toHaveBeenCalled();
        });

        it("Refreshes counts once for exactly the source and destination folders of the successful moves.", async () => {
            const command = newCommand(
                {
                    a: { uid: "a", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
                    b: { uid: "b", version: 1, folderUid: "junk", mailboxUid: "mbx" },
                    locked: { uid: "locked", version: 1, folderUid: "outbox", mailboxUid: "mbx" },
                },
                async (values: any) => {
                    if (values.uid === "locked") {
                        throw new Error("version conflict");
                    }
                    return values;
                },
            );

            await command.handle({
                user: { uid: "u" },
                request: element(WbxmlCodePage.Move, "MoveItems", [move("a", "inbox", "archive"), move("b", "junk", "archive"), move("locked", "outbox", "archive")]),
            });

            expect(refreshFolderCounts).toHaveBeenCalledTimes(1);
            const [deps, touched] = vi.mocked(refreshFolderCounts).mock.calls[0];
            expect([...(touched as Iterable<string>)].sort()).toEqual(["archive", "inbox", "junk"]);
            expect(deps).toMatchObject({
                messageRepo: command.messageRepo,
                folderRepo: command.folderRepo,
                folderClass: command.folderClass,
                notificationUtils: command.notificationUtils,
            });
        });
    });

    describe("Trusted-role (admin) bypass regression - a trusted role must never substitute for a real ACL grant", () => {
        const move = (srcFldId: string, dstFldId: string) =>
            element(WbxmlCodePage.Move, "Move", [
                textElement(WbxmlCodePage.Move, "SrcMsgId", "m1"),
                textElement(WbxmlCodePage.Move, "SrcFldId", srcFldId),
                textElement(WbxmlCodePage.Move, "DstFldId", dstFldId),
            ]);

        it("A trusted-role stranger with only READ on the source folder (a real delegate grant) still gets Status 1 - UPDATE isn't substituted by the role.", async () => {
            const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;
            command.messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "m1", version: 1, folderUid: "inbox", mailboxUid: "mbx" }) };
            command.folderRepo = { findOne: vi.fn().mockResolvedValue({ uid: "archive", mailboxUid: "mbx" }) };
            command.aclUtils = fakeMailAclUtils({ inbox: { [TRUSTED_STRANGER_USER.uid]: ["read"] }, archive: { [TRUSTED_STRANGER_USER.uid]: ["read", "create"] } });

            const response = await command.handle({ user: TRUSTED_STRANGER_USER, request: element(WbxmlCodePage.Move, "MoveItems", [move("inbox", "archive")]) });

            expect(childText(findChildren(response, "Response")[0], "Status")).toBe("1");
        });

        it("A trusted-role stranger with UPDATE on the source but no grant on the destination still gets Status 2 - CREATE isn't substituted by the role.", async () => {
            const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;
            command.messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "m1", version: 1, folderUid: "inbox", mailboxUid: "mbx" }) };
            command.folderRepo = { findOne: vi.fn().mockResolvedValue({ uid: "archive", mailboxUid: "mbx" }) };
            command.aclUtils = fakeMailAclUtils({ inbox: { [TRUSTED_STRANGER_USER.uid]: ["update"] } });

            const response = await command.handle({ user: TRUSTED_STRANGER_USER, request: element(WbxmlCodePage.Move, "MoveItems", [move("inbox", "archive")]) });

            expect(childText(findChildren(response, "Response")[0], "Status")).toBe("2");
        });
    });
});
