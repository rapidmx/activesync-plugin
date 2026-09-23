///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for GetItemEstimateCommand's defensive dependency guard clause only - DI (via
// BaseEasRoute's own @Init) always populates every injected dependency before a real request can reach
// handle(), same rationale test/commands/ItemOperationsCommand.test.ts already uses for its own guard clause.
// Every real estimate/ACL behavior is exercised via real HTTP+DB requests in
// test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { GetItemEstimateCommandMongo } from "../../src/commands/mongo/GetItemEstimateCommandMongo.js";
import { FolderType } from "@rapidmx/restapi";
import { childText, element, findChild, findChildren, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { formatSyncKey } from "../../src/EasSyncKeyUtils.js";
import { MAX_SYNC_COLLECTIONS } from "../../src/commands/SyncCommand.js";
import { fakeMailAclUtils, TRUSTED_STRANGER_USER } from "../mailAccessTestUtils.js";

describe("GetItemEstimateCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<GetItemEstimateCommandMongo>(GetItemEstimateCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    describe("estimates (isolated)", () => {
        const key = formatSyncKey({ generation: 2, watermark: new Date("2026-01-01T00:00:00.000Z") });

        function build(options: { folder?: any; state?: any; rows?: any[] } = {}) {
            const objectFactory = new ObjectFactory(config, Logger());
            const command = objectFactory.newInstance<GetItemEstimateCommandMongo>(GetItemEstimateCommandMongo, { initialize: false }) as any;
            const repo = {
                count: vi.fn().mockResolvedValue(7),
                find: vi.fn().mockImplementation(async (query: any) => (query.deleted ? [] : query.folderUid === "f1" ? (options.rows ?? []) : [])),
            };
            command.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
            command.folderRepo = {
                findOne: vi.fn().mockResolvedValue(options.folder === null ? undefined : (options.folder ?? { uid: "f1", mailboxUid: "m1", type: FolderType.TASKS })),
            };
            command.collectionStateRepo = { find: vi.fn().mockResolvedValue(options.state ? [options.state] : []), update: vi.fn() };
            command.collectionChunkRepo = { find: vi.fn().mockResolvedValue([]) };
            command.repos = new Map([["Tasks", repo]]);
            return { command, repo };
        }

        function collectionEl(syncKey: string, collectionClass?: string, folderUid: string | null = "f1") {
            return element(WbxmlCodePage.AirSync, "Collection", [
                ...(collectionClass ? [textElement(WbxmlCodePage.AirSync, "Class", collectionClass)] : []),
                textElement(WbxmlCodePage.AirSync, "SyncKey", syncKey),
                ...(folderUid !== null ? [textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid)] : []),
            ]);
        }

        function estimateRequest(syncKey: string, collectionClass?: string) {
            return element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", [
                element(WbxmlCodePage.AirSync, "Collections", [collectionEl(syncKey, collectionClass)]),
            ]);
        }

        const ctx = (request: any) => ({ user: { uid: "u1" }, mailboxUid: "m1", deviceId: "d1", request }) as any;

        it("Refuses more collections than one Sync may carry, estimates a repeated CollectionId once, and caps a SyncKey 0 count.", async () => {
            const { command, repo } = build();
            const many = element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", [
                element(WbxmlCodePage.AirSync, "Collections", Array.from({ length: MAX_SYNC_COLLECTIONS + 1 }, () => collectionEl("0"))),
            ]);
            const refused = await command.handle(ctx(many));
            expect(findChildren(refused, "Response").map((r: any) => childText(r, "Status"))).toEqual(["2"]);
            expect(repo.count).not.toHaveBeenCalled();

            command.maxCount = 5;
            const repeated = element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", [
                element(WbxmlCodePage.AirSync, "Collections", [collectionEl("0"), collectionEl("0"), collectionEl("0", undefined, null)]),
            ]);
            const response = await command.handle(ctx(repeated));
            const responses = findChildren(response, "Response");
            expect(responses.map((r: any) => childText(r, "Status"))).toEqual(["1", "2"]);
            expect(childText(findChild(responses[0], "Collection")!, "Estimate")).toBe("5");
            expect(repo.count).toHaveBeenCalledTimes(1);
        });

        it("Reports Status 2 when the folder no longer exists.", async () => {
            const { command } = build({ folder: null });
            const response = await command.handle(ctx(estimateRequest("0", "Tasks")));
            expect(childText(findChild(response, "Response")!, "Status")).toBe("2");
        });

        it("Counts the folder's live items for SyncKey 0, deriving Class from the folder type.", async () => {
            const { command, repo } = build();
            const response = await command.handle(ctx(estimateRequest("0")));
            const collection = findChild(findChild(response, "Response")!, "Collection")!;
            expect(childText(collection, "Class")).toBe("Tasks");
            expect(childText(collection, "Estimate")).toBe("7");
            expect(repo.count).toHaveBeenCalledWith({ folderUid: "f1" }, { ignoreACL: true });
        });

        it("Dry-runs the Sync enumeration for the collection's current key (honouring its filter) without persisting, and rejects other keys.", async () => {
            const state = {
                uid: "s1",
                syncKey: key,
                collectionClass: "Tasks",
                cursorDate: new Date(0),
                cursorUid: "",
                moveCursorDate: new Date(0),
                moveCursorUid: "",
                serverIds: [],
                echoes: {},
                filterType: "8",
                chunked: true,
            };
            const rows = [
                { uid: "t1", folderUid: "f1", dateModified: new Date("2026-02-01T00:00:00.000Z"), completed: false },
                { uid: "t2", folderUid: "f1", dateModified: new Date("2026-02-02T00:00:00.000Z"), completed: true },
            ];
            const { command } = build({ state, rows });
            // A chunked held set is read from its chunk rows: t1 is an Add (t2 is outside the filter), and the held id that no
            // longer exists in the folder is a reconciled Delete.
            command.collectionChunkRepo.find.mockResolvedValue([{ uid: "c0", chunkIndex: 0, ids: ["t9-held-elsewhere"] }]);

            const response = await command.handle(ctx(estimateRequest(key)));
            expect(childText(findChild(findChild(response, "Response")!, "Collection")!, "Estimate")).toBe("2");
            expect(command.collectionStateRepo.update).not.toHaveBeenCalled();

            const stale = await command.handle(ctx(estimateRequest("1:2020-01-01T00:00:00.000Z", "Tasks")));
            const staleResponse = findChildren(stale, "Response")[0];
            expect(childText(staleResponse, "Status")).toBe("2");
            expect(findChild(findChild(staleResponse, "Collection")!, "Estimate")).toBeUndefined();
        });

        it("Trusted-role bypass regression: an admin-role stranger with no grant on the folder gets Status 2, not counted via the role.", async () => {
            const { command, repo } = build();
            command.aclUtils = fakeMailAclUtils({});

            const response = await command.handle({ user: TRUSTED_STRANGER_USER, mailboxUid: "m1", deviceId: "d1", request: estimateRequest("0") } as any);

            expect(childText(findChild(response, "Response")!, "Status")).toBe("2");
            expect(repo.count).not.toHaveBeenCalled();
        });
    });
});
