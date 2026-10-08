///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for SyncCommand's request handling (collection/key resolution, client-originated
// Add/Change/Delete, Status 3/4/6/7/8 mapping, retries, options, state persistence) against fake repos/adapters.
// The version-conflict (Status 7), malformed-item (Status 6) and lost-state-write branches need injected failures
// that a real single-threaded HTTP request never produces. The change enumeration itself is covered by
// test/EasCollectionSync.test.ts, and real end-to-end Sync rounds over Mongo/SQL by test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ApiError, Logger } from "@rapidrest/core";
import { ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import { AuditLogUtils, FolderType } from "@rapidmx/restapi";
import { MAX_SYNC_COLLECTIONS, MAX_SYNC_COMMANDS_PER_COLLECTION } from "../../src/commands/SyncCommand.js";
import { SyncCommandMongo } from "../../src/commands/mongo/SyncCommandMongo.js";
import { element, findChild, findChildren, childText, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { formatSyncKey } from "../../src/EasSyncKeyUtils.js";
import { EasCollectionLease } from "../../src/EasCollectionLease.js";
import { INLINE_HELD_LIMIT } from "../../src/EasCollectionStore.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import type { EasCollectionSyncAdapter } from "../../src/adapters/EasCollectionSyncAdapter.js";
import { fakeMailAclUtils, TRUSTED_STRANGER_USER } from "../mailAccessTestUtils.js";

const FOLDER_UID = "folder-1";
const OLD_WATERMARK = new Date("2026-01-01T00:00:00.000Z");
const STORED_KEY = formatSyncKey({ generation: 2, watermark: OLD_WATERMARK });
const PREVIOUS_KEY = formatSyncKey({ generation: 1, watermark: new Date(0) });

/** A fake adapter that renders an empty ApplicationData - every test here is about request handling, not mapping. */
function fakeAdapter(overrides: Partial<EasCollectionSyncAdapter<any>> = {}): EasCollectionSyncAdapter<any> {
    return {
        collectionClass: "Fake",
        toApplicationData: () => element(WbxmlCodePage.AirSync, "ApplicationData", []),
        ...overrides,
    };
}

/** A fake item repo implementing the RepoUtils surface SyncCommand calls. `find` resolves empty (no server-side
 * changes) unless overridden. */
function fakeRepo(overrides: Record<string, any> = {}): any {
    return {
        find: vi.fn().mockResolvedValue([]),
        findOne: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        ...overrides,
    };
}

function storedState(overrides: Record<string, any> = {}): any {
    return {
        uid: "state-1",
        version: 4,
        mailboxUid: "mbx-1",
        deviceId: "dev-1",
        folderUid: FOLDER_UID,
        collectionClass: "Fake",
        syncKey: STORED_KEY,
        cursorDate: OLD_WATERMARK,
        cursorUid: "",
        moveCursorDate: OLD_WATERMARK,
        moveCursorUid: "",
        serverIds: [],
        echoes: {},
        filterType: "0",
        previous: undefined,
        ...overrides,
    };
}

function collectionEl(children: WbxmlElement[], opts: { syncKey?: string; collectionClass?: string } = {}): WbxmlElement {
    return element(WbxmlCodePage.AirSync, "Collection", [
        ...(opts.collectionClass === "" ? [] : [textElement(WbxmlCodePage.AirSync, "Class", opts.collectionClass ?? "Fake")]),
        textElement(WbxmlCodePage.AirSync, "SyncKey", opts.syncKey ?? STORED_KEY),
        textElement(WbxmlCodePage.AirSync, "CollectionId", FOLDER_UID),
        ...children,
    ]);
}

function syncRequest(collectionClass: string, commandsChildren: WbxmlElement[], extra: WbxmlElement[] = [], syncKey?: string): WbxmlElement {
    return element(WbxmlCodePage.AirSync, "Sync", [
        element(WbxmlCodePage.AirSync, "Collections", [
            collectionEl([element(WbxmlCodePage.AirSync, "Commands", commandsChildren), ...extra], { collectionClass, syncKey }),
        ]),
    ]);
}

interface Harness {
    command: SyncCommandMongo;
    stateRepo: any;
    folderRepo: any;
    chunkRepo: any;
    logger: any;
}

/** Builds a command with its repos/adapters poked directly, bypassing @Init/DI - the same isolation pattern
 * MeetingResponseCommand.test.ts uses. */
async function buildCommand(
    collectionClass: string,
    adapter: EasCollectionSyncAdapter<any>,
    repo: any,
    options: { aclUtils?: any; state?: any; folder?: any } = {},
): Promise<Harness> {
    const objectFactory = new ObjectFactory(config, Logger());
    const command = await objectFactory.newInstance<SyncCommandMongo>(SyncCommandMongo, { initialize: false });
    const stateRepo = {
        find: vi.fn().mockResolvedValue(options.state === null ? [] : [options.state ?? storedState()]),
        update: vi.fn().mockImplementation(async (obj: any) => ({ ...obj, version: (obj.version ?? 0) + 1 })),
        create: vi.fn().mockResolvedValue(undefined),
    };
    const folderRepo = {
        findOne: vi.fn().mockResolvedValue(options.folder === null ? undefined : (options.folder ?? { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.USER })),
        find: vi.fn().mockResolvedValue([{ uid: "deleted-items", mailboxUid: "mbx-1", type: FolderType.DELETED_ITEMS }]),
    };
    const chunkRepo = {
        find: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockImplementation(async (obj: any) => ({ ...obj, version: (obj.version ?? 0) + 1 })),
        delete: vi.fn().mockResolvedValue(undefined),
        truncate: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    (command as any).repos = new Map([[collectionClass, repo]]);
    (command as any).adapters = new Map([[collectionClass, adapter]]);
    (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue({ uid: "mbx-1", primarySmtpAddress: "owner@example.com", displayName: "Owner" }) };
    (command as any).folderRepo = folderRepo;
    (command as any).collectionStateRepo = stateRepo;
    (command as any).collectionChunkRepo = chunkRepo;
    // The reconcile would look every held item up in these fakes (which find nothing) - covered on its own below and
    // in test/EasCollectionSync.test.ts.
    (command as any).reconcileLimit = 0;
    (command as any).windowSize = 100;
    (command as any).logger = logger;
    // Every permission granted by default.
    (command as any).aclUtils = options.aclUtils ?? { hasPermission: vi.fn().mockResolvedValue(true) };
    return { command, stateRepo, folderRepo, chunkRepo, logger };
}

function buildContext(request: WbxmlElement): { ctx: EasCommandContext; deviceSyncStateUpdate: ReturnType<typeof vi.fn> } {
    const deviceSyncStateUpdate = vi.fn().mockResolvedValue(undefined);
    const ctx = {
        user: { uid: "user-1", roles: [], scopes: [] },
        mailboxUid: "mbx-1",
        deviceId: "dev-1",
        deviceType: "Test",
        deviceSyncState: { uid: "dss-1", version: 1, folderSyncKeys: {} },
        deviceSyncStateRepo: { update: deviceSyncStateUpdate },
        query: {},
        request,
    } as unknown as EasCommandContext;
    return { ctx, deviceSyncStateUpdate };
}

function collection(response: WbxmlElement): WbxmlElement {
    return findChild(findChild(response, "Collections")!, "Collection")!;
}

function responseStatus(response: WbxmlElement | undefined, kind: string): string | undefined {
    return childText(findChild(findChild(collection(response!), "Responses")!, kind)!, "Status");
}

function savedState(stateRepo: any): any {
    return (stateRepo.update.mock.calls.at(-1) ?? stateRepo.create.mock.calls[0])[0];
}

describe("SyncCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<SyncCommandMongo>(SyncCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });
});

describe("SyncCommand Tests (isolated)", () => {
    afterEach(() => {
        EasCollectionLease.resetSharedState();
        vi.restoreAllMocks();
    });

    describe("collection resolution", () => {
        it("Answers a top-level Status 3 when the request has no collections, and Status 4 when it has too many.", async () => {
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo());

            const none = await command.handle(buildContext(element(WbxmlCodePage.AirSync, "Sync", [])).ctx);
            expect(childText(none!, "Status")).toBe("3");

            const tooMany = element(WbxmlCodePage.AirSync, "Sync", [
                element(
                    WbxmlCodePage.AirSync,
                    "Collections",
                    Array.from({ length: MAX_SYNC_COLLECTIONS + 1 }, () => collectionEl([])),
                ),
            ]);
            const response = await command.handle(buildContext(tooMany).ctx);
            expect(childText(response!, "Status")).toBe("4");
            expect(findChild(response!, "Collections")).toBeUndefined();
        });

        it("Reports Status 4 for the whole collection when the caller lacks READ on the folder, without reading anything.", async () => {
            const repo = fakeRepo();
            const aclUtils = { hasPermission: vi.fn().mockResolvedValue(false) };
            const { command, folderRepo } = await buildCommand("Fake", fakeAdapter(), repo, { aclUtils });
            const { ctx } = buildContext(syncRequest("Fake", []));

            const response = await command.handle(ctx);

            expect(childText(collection(response!), "Status")).toBe("4");
            expect(aclUtils.hasPermission).toHaveBeenCalledWith(ctx.user, FOLDER_UID, "read");
            expect(folderRepo.findOne).not.toHaveBeenCalled();
            expect(repo.find).not.toHaveBeenCalled();
        });

        it("Reports Status 4 when CollectionId is missing or the folder no longer exists.", async () => {
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { folder: null });
            const missingId = element(WbxmlCodePage.AirSync, "Sync", [
                element(WbxmlCodePage.AirSync, "Collections", [
                    element(WbxmlCodePage.AirSync, "Collection", [textElement(WbxmlCodePage.AirSync, "SyncKey", "0")]),
                ]),
            ]);
            expect(childText(collection((await command.handle(buildContext(missingId).ctx))!), "Status")).toBe("4");
            expect(childText(collection((await command.handle(buildContext(syncRequest("Fake", [])).ctx))!), "Status")).toBe("4");
        });

        it("Reports Status 4 for an unsupported Class, and for more Commands than one collection may carry.", async () => {
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter(), fakeRepo());
            const unsupported = await command.handle(buildContext(syncRequest("Nope", [])).ctx);
            expect(childText(collection(unsupported!), "Status")).toBe("4");

            const commands = Array.from({ length: MAX_SYNC_COMMANDS_PER_COLLECTION + 1 }, () =>
                element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "x")]),
            );
            const tooMany = await command.handle(buildContext(syncRequest("Fake", commands)).ctx);
            expect(childText(collection(tooMany!), "Status")).toBe("4");
            expect(stateRepo.update).not.toHaveBeenCalled();
        });

        it("Uses the Class remembered for the collection when the request omits it.", async () => {
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo());
            const request = element(WbxmlCodePage.AirSync, "Sync", [
                element(WbxmlCodePage.AirSync, "Collections", [collectionEl([], { collectionClass: "" })]),
            ]);

            const response = await command.handle(buildContext(request).ctx);

            expect(childText(collection(response!), "Status")).toBe("1");
            expect(childText(collection(response!), "Class")).toBe("Fake");
        });
    });

    describe("SyncKey handling", () => {
        it("SyncKey 0 resets an existing collection row to an empty item set, remembering Class and FilterType.", async () => {
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), {
                state: storedState({ serverIds: ["a"], echoes: { a: "x" } }),
            });
            const options = [element(WbxmlCodePage.AirSync, "Options", [textElement(WbxmlCodePage.AirSync, "FilterType", "3")])];

            const response = await command.handle(buildContext(syncRequest("Fake", [], options, "0")).ctx);

            expect(childText(collection(response!), "Status")).toBe("1");
            expect(findChild(collection(response!), "Commands")).toBeUndefined();
            const saved = savedState(stateRepo);
            expect(saved).toEqual(
                expect.objectContaining({ uid: "state-1", version: 4, serverIds: [], echoes: {}, filterType: "3", collectionClass: "Fake", previous: undefined }),
            );
            expect(saved.syncKey).toBe(childText(collection(response!), "SyncKey"));
            expect(saved.cursorDate).toEqual(new Date(0));
        });

        it("SyncKey 0 creates the collection row when none exists, recording no FilterType without Options; a failed save is Status 5 without a key.", async () => {
            const { command, stateRepo, logger } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { state: null });

            const created = await command.handle(buildContext(syncRequest("Fake", [], [], "0")).ctx);
            expect(childText(collection(created!), "Status")).toBe("1");
            expect(savedState(stateRepo).filterType).toBeNull();

            stateRepo.create.mockRejectedValue(new Error("duplicate key"));
            const response = await command.handle(buildContext(syncRequest("Fake", [], [], "0")).ctx);

            expect(childText(collection(response!), "Status")).toBe("5");
            expect(findChild(collection(response!), "SyncKey")).toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("duplicate key"));
        });

        it("SyncKey 0 of a chunked collection removes its chunk rows and goes back to an inline held set.", async () => {
            const { command, stateRepo, chunkRepo } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { state: storedState({ chunked: true }) });

            await command.handle(buildContext(syncRequest("Fake", [], [], "0")).ctx);

            expect(chunkRepo.truncate).toHaveBeenCalledWith({ mailboxUid: "mbx-1", deviceId: "dev-1", folderUid: FOLDER_UID }, { ignoreACL: true });
            expect(savedState(stateRepo)).toEqual(expect.objectContaining({ chunked: false, serverIds: [], recent: {}, reconcileCursor: "" }));
        });

        it("Adopts the first FilterType of a collection started without one while the device holds nothing, and otherwise restarts it.", async () => {
            const options = [element(WbxmlCodePage.AirSync, "Options", [textElement(WbxmlCodePage.AirSync, "FilterType", "3")])];
            const firstKey = formatSyncKey({ generation: 1, watermark: new Date(0) });
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), {
                state: storedState({ syncKey: firstKey, filterType: null }),
            });

            const adopted = await command.handle(buildContext(syncRequest("Fake", [], options, firstKey)).ctx);
            expect(childText(collection(adopted!), "Status")).toBe("1");
            expect(savedState(stateRepo).filterType).toBe("3");

            const { command: holding } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), {
                state: storedState({ filterType: undefined, serverIds: ["held"] }),
            });
            expect(childText(collection((await holding.handle(buildContext(syncRequest("Fake", [], options)).ctx))!), "Status")).toBe("3");
        });

        it("Answers Status 3 without a SyncKey when the round's state can't be saved.", async () => {
            const { command, stateRepo, logger } = await buildCommand("Fake", fakeAdapter(), fakeRepo());
            stateRepo.update.mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "Version conflict"));

            const response = await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            expect(childText(collection(response!), "Status")).toBe("3");
            expect(findChild(collection(response!), "SyncKey")).toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Version conflict"));
        });

        it("Answers Status 5 when a chunked held set can't be loaded.", async () => {
            const { command, chunkRepo, stateRepo } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { state: storedState({ chunked: true }) });
            chunkRepo.find.mockRejectedValue(new Error("db down"));

            const response = await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            expect(childText(collection(response!), "Status")).toBe("5");
            expect(stateRepo.update).not.toHaveBeenCalled();
        });

        it("Reads a chunked held set from its chunk rows and writes only the chunks a round changed.", async () => {
            const chunkRows = [
                { uid: "chunk-0", version: 1, mailboxUid: "mbx-1", deviceId: "dev-1", folderUid: FOLDER_UID, chunkIndex: 0, ids: ["held-1", "held-2"] },
            ];
            const repo = fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) =>
                    !query.deleted && query.folderUid === FOLDER_UID && !String(query.dateModified).startsWith("range")
                        ? [{ uid: "held-2", folderUid: FOLDER_UID, deleted: false, dateModified: new Date("2026-02-01T00:00:00.000Z") }]
                        : [],
                ),
            });
            const { command, stateRepo, chunkRepo } = await buildCommand("Fake", fakeAdapter(), repo, { state: storedState({ chunked: true }) });
            chunkRepo.find.mockResolvedValue(chunkRows);

            const response = await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            // held-2 is in the chunk, so it's a Change rather than an Add; nothing was added or removed, so no chunk write.
            expect(childText(findChild(findChild(collection(response!), "Commands")!, "Change")!, "ServerId")).toBe("held-2");
            expect(chunkRepo.update).not.toHaveBeenCalled();
            expect(chunkRepo.create).not.toHaveBeenCalled();
            expect(savedState(stateRepo)).toEqual(expect.objectContaining({ chunked: true, serverIds: [] }));
        });

        it("Moves a held set that outgrows the inline limit into chunk rows.", async () => {
            const held = Array.from({ length: INLINE_HELD_LIMIT }, (_, i) => `held-${i}`);
            const repo = fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) =>
                    !query.deleted && query.folderUid === FOLDER_UID && !String(query.dateModified).startsWith("range")
                        ? [{ uid: "one-more", folderUid: FOLDER_UID, dateModified: new Date("2026-02-01T00:00:00.000Z") }]
                        : [],
                ),
            });
            const { command, stateRepo, chunkRepo } = await buildCommand("Fake", fakeAdapter(), repo, { state: storedState({ serverIds: held }) });

            await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            // INLINE_HELD_LIMIT + 1 ids fill one whole chunk and start a second.
            expect(chunkRepo.create).toHaveBeenCalledTimes(2);
            expect(chunkRepo.create.mock.calls[0][0]).toEqual(expect.objectContaining({ chunkIndex: 0, folderUid: FOLDER_UID }));
            expect(chunkRepo.create.mock.calls[0][0].ids.length + chunkRepo.create.mock.calls[1][0].ids.length).toBe(INLINE_HELD_LIMIT + 1);
            expect(savedState(stateRepo)).toEqual(expect.objectContaining({ chunked: true, serverIds: [] }));
        });

        it("Waits for another request's lease on the same collection, and answers Status 16 when it can't get one in time.", async () => {
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo());
            vi.spyOn(EasCollectionLease, "acquire").mockResolvedValue(undefined);

            const response = await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            expect(childText(collection(response!), "Status")).toBe("16");
            expect(childText(collection(response!), "SyncKey")).toBe(STORED_KEY);
        });

        it("Serializes two concurrent Syncs of the same collection, the second reading the state the first saved.", async () => {
            let current: any = storedState();
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter(), fakeRepo());
            stateRepo.find.mockImplementation(async () => [current]);
            stateRepo.update.mockImplementation(async (values: any) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                current = { ...current, ...values, version: current.version + 1 };
            });

            const [first, second] = await Promise.all([
                command.handle(buildContext(syncRequest("Fake", [])).ctx),
                command.handle(buildContext(syncRequest("Fake", [])).ctx),
            ]);

            expect(childText(collection(first!), "Status")).toBe("1");
            // The second request's key is now the previous one: it's replayed as a retry, not computed from stale state.
            expect(childText(collection(second!), "Status")).toBe("1");
            expect(stateRepo.update.mock.calls[1][0].version).toBe(5);
            expect(stateRepo.update.mock.calls[1][0].previous.syncKey).toBe(STORED_KEY);
        });

        it("Rejects an unknown SyncKey (or any key when the collection was never started) with Status 3.", async () => {
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo());
            const unknown = await command.handle(buildContext(syncRequest("Fake", [], [], "9:2020-01-01T00:00:00.000Z")).ctx);
            expect(childText(collection(unknown!), "Status")).toBe("3");

            const { command: fresh } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { state: null });
            const never = await fresh.handle(buildContext(syncRequest("Fake", [])).ctx);
            expect(childText(collection(never!), "Status")).toBe("3");
        });

        it("Rejects a FilterType different from the one the collection was synced with (Status 3), but accepts the same one.", async () => {
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { state: storedState({ filterType: "2" }) });
            const options = (value: string) => [element(WbxmlCodePage.AirSync, "Options", [textElement(WbxmlCodePage.AirSync, "FilterType", value)])];

            expect(childText(collection((await command.handle(buildContext(syncRequest("Fake", [], options("4"))).ctx))!), "Status")).toBe("3");
            expect(childText(collection((await command.handle(buildContext(syncRequest("Fake", [], options("2"))).ctx))!), "Status")).toBe("1");
        });

        it("Persists the round with its previous key and delta, never touching DeviceSyncState.", async () => {
            const repo = fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) =>
                    !query.deleted && query.folderUid === FOLDER_UID
                        ? [{ uid: "new-item", folderUid: FOLDER_UID, dateModified: new Date("2026-02-01T00:00:00.000Z") }]
                        : [],
                ),
            });
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter(), repo);
            const { ctx, deviceSyncStateUpdate } = buildContext(syncRequest("Fake", []));

            const response = await command.handle(ctx);

            expect(childText(findChild(findChild(collection(response!), "Commands")!, "Add")!, "ServerId")).toBe("new-item");
            expect(stateRepo.update).toHaveBeenCalledTimes(1);
            expect(deviceSyncStateUpdate).not.toHaveBeenCalled();
            const saved = savedState(stateRepo);
            expect(saved.serverIds).toEqual(["new-item"]);
            expect(saved.cursorDate).toEqual(new Date("2026-02-01T00:00:00.000Z"));
            expect(saved.previous).toEqual(expect.objectContaining({ syncKey: STORED_KEY, addedIds: ["new-item"], removedIds: [], clientIds: [] }));
            expect(saved.syncKey).toBe(childText(collection(response!), "SyncKey"));
        });

        it("Aborts the whole request - without ever saving state - when rendering a server change throws, so a retry replays the identical round against the unmoved cursor.", async () => {
            const repo = fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) =>
                    !query.deleted && query.folderUid === FOLDER_UID
                        ? [{ uid: "bad-item", folderUid: FOLDER_UID, dateModified: new Date("2026-02-01T00:00:00.000Z") }]
                        : [],
                ),
            });
            const renderError = new Error("malformed item");
            const { command, stateRepo, logger } = await buildCommand(
                "Fake",
                fakeAdapter({
                    toApplicationData: () => {
                        throw renderError;
                    },
                }),
                repo,
            );
            const { ctx } = buildContext(syncRequest("Fake", []));

            await expect(command.handle(ctx)).rejects.toThrow("malformed item");

            expect(stateRepo.update).not.toHaveBeenCalled();
            expect(stateRepo.create).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("bad-item"));
        });

        it("Accepts the previous SyncKey (a retried round), recomputing from the state before that round.", async () => {
            const state = storedState({
                serverIds: ["kept", "added-last-round", "client-created"],
                echoes: { "client-created": "2026-01-01T00:00:05.000Z" },
                previous: {
                    syncKey: PREVIOUS_KEY,
                    cursorDate: new Date(0).toISOString(),
                    cursorUid: "",
                    moveCursorDate: OLD_WATERMARK.toISOString(),
                    moveCursorUid: "",
                    addedIds: ["added-last-round", "client-created"],
                    removedIds: ["removed-last-round"],
                    echoes: {},
                    clientIds: [
                        { clientId: "client-1", serverId: "client-created" },
                        { clientId: "client-2", serverId: "since-deleted" },
                    ],
                },
            });
            const repo = fakeRepo({
                findOne: vi
                    .fn()
                    .mockImplementation(async (uid: string) =>
                        uid === "client-created" ? { uid, folderUid: FOLDER_UID, dateModified: new Date("2026-01-01T00:00:05.000Z") } : undefined,
                    ),
            });
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), repo, { state });
            const request = syncRequest(
                "Fake",
                [
                    element(WbxmlCodePage.AirSync, "Add", [
                        textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                        element(WbxmlCodePage.AirSync, "ApplicationData", []),
                    ]),
                    element(WbxmlCodePage.AirSync, "Add", [
                        textElement(WbxmlCodePage.AirSync, "ClientId", "client-2"),
                        element(WbxmlCodePage.AirSync, "ApplicationData", []),
                    ]),
                    element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "removed-last-round")]),
                    element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "never-there")]),
                ],
                [],
                PREVIOUS_KEY,
            );

            const response = await command.handle(buildContext(request).ctx);

            const responses = findChild(collection(response!), "Responses")!;
            const [add, deletedMeanwhile] = findChildren(responses, "Add");
            expect(childText(add, "ServerId")).toBe("client-created");
            expect(childText(add, "Status")).toBe("1");
            expect(childText(deletedMeanwhile, "ServerId")).toBe("since-deleted");
            expect(repo.create).not.toHaveBeenCalled();
            // The already-deleted item is silently accepted; an item that round never removed is still "not found".
            expect(findChildren(responses, "Delete").map((d) => childText(d, "ServerId"))).toEqual(["never-there"]);
            const saved = savedState(stateRepo);
            expect(saved.previous.syncKey).toBe(PREVIOUS_KEY);
            expect(saved.previous.clientIds).toEqual([
                { clientId: "client-1", serverId: "client-created" },
                { clientId: "client-2", serverId: "since-deleted" },
            ]);
            expect([...saved.serverIds].sort()).toEqual(["client-created", "kept"]);
            // The replayed item's current state counts as the device's own write, so it isn't sent back as a Change.
            expect(saved.echoes).toEqual({ "client-created": "2026-01-01T00:00:05.000Z" });
        });
    });

    describe("options", () => {
        it("Reports no server changes when GetChanges is 0.", async () => {
            const repo = fakeRepo({ find: vi.fn().mockResolvedValue([{ uid: "x", folderUid: FOLDER_UID, dateModified: new Date() }]) });
            const { command } = await buildCommand("Fake", fakeAdapter(), repo);

            const response = await command.handle(buildContext(syncRequest("Fake", [], [textElement(WbxmlCodePage.AirSync, "GetChanges", "0")])).ctx);

            expect(findChild(collection(response!), "Commands")).toBeUndefined();
            expect(repo.find).not.toHaveBeenCalled();
        });

        it("Honours the collection's WindowSize, then the request's, capped by the configured window; ignores an invalid one.", async () => {
            const rows = Array.from({ length: 6 }, (_, i) => ({ uid: `r${i}`, folderUid: FOLDER_UID, dateModified: new Date(Date.UTC(2026, 1, 1, 0, i)) }));
            const limits: number[] = [];
            const repo = fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) => {
                    if (String(query.dateModified).startsWith("range")) {
                        return []; // the overlap re-read
                    }
                    limits.push(query.limit);
                    return query.deleted ? [] : rows.slice(0, query.limit);
                }),
            });
            const { command } = await buildCommand("Fake", fakeAdapter(), repo);
            (command as any).windowSize = 4;

            const collectionLevel = await command.handle(buildContext(syncRequest("Fake", [], [textElement(WbxmlCodePage.AirSync, "WindowSize", "2")])).ctx);
            expect(findChildren(findChild(collection(collectionLevel!), "Commands")!, "Add").length).toBe(2);
            expect(findChild(collection(collectionLevel!), "MoreAvailable")).toBeDefined();

            const requestLevel = element(WbxmlCodePage.AirSync, "Sync", [
                element(WbxmlCodePage.AirSync, "Collections", [collectionEl([])]),
                textElement(WbxmlCodePage.AirSync, "WindowSize", "50"),
            ]);
            await command.handle(buildContext(requestLevel).ctx);
            await command.handle(buildContext(syncRequest("Fake", [], [textElement(WbxmlCodePage.AirSync, "WindowSize", "zero")])).ctx);

            expect(limits).toEqual([3, 3, 5, 5, 5, 5]);
        });

        it("Ignores a command element it doesn't know (e.g. SoftDelete, not implemented), logging it rather than silently dropping it with no trace - the exact gap that hid the Fetch element for a long time.", async () => {
            const { command, logger } = await buildCommand("Fake", fakeAdapter(), fakeRepo());
            const response = await command.handle(buildContext(syncRequest("Fake", [element(WbxmlCodePage.AirSync, "SoftDelete", [])])).ctx);
            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ignoring unrecognized Commands child 'SoftDelete'"));
        });

        it("Parses Options/BodyPreference and passes it to the adapter's render call, so an adapter that cares (EmailSyncAdapter) can honour it - undefined when the device sent none.", async () => {
            const repoWith = (): any =>
                fakeRepo({
                    find: vi.fn().mockImplementation(async (query: any) =>
                        !query.deleted && query.folderUid === FOLDER_UID
                            ? [{ uid: "item-1", folderUid: FOLDER_UID, dateModified: new Date("2026-02-01T00:00:00.000Z") }]
                            : [],
                    ),
                });

            const withPreference = vi.fn().mockResolvedValue(element(WbxmlCodePage.AirSync, "ApplicationData", []));
            const { command: commandWith } = await buildCommand("Fake", fakeAdapter({ toApplicationData: withPreference }), repoWith());
            const bodyPreferenceOptions = element(WbxmlCodePage.AirSync, "Options", [
                element(WbxmlCodePage.AirSyncBase, "BodyPreference", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", "2"),
                    textElement(WbxmlCodePage.AirSyncBase, "TruncationSize", "4096"),
                ]),
            ]);
            await commandWith.handle(buildContext(syncRequest("Fake", [], [bodyPreferenceOptions])).ctx);
            expect(withPreference).toHaveBeenCalledWith(expect.objectContaining({ uid: "item-1" }), { type: "2", truncationSize: 4096 }, expect.anything());

            const withoutPreference = vi.fn().mockResolvedValue(element(WbxmlCodePage.AirSync, "ApplicationData", []));
            const { command: commandWithout } = await buildCommand("Fake", fakeAdapter({ toApplicationData: withoutPreference }), repoWith());
            await commandWithout.handle(buildContext(syncRequest("Fake", [])).ctx);
            expect(withoutPreference).toHaveBeenCalledWith(expect.objectContaining({ uid: "item-1" }), undefined, expect.anything());
        });

        it("Picks the HTML BodyPreference over a plain-text sibling regardless of which came first in the request, when a device (e.g. Apple Mail) sends more than one - a real device report showed a plain-text BodyPreference listed before an HTML one, and honouring whichever came first produced a body the device couldn't render.", async () => {
            const repo = fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) =>
                    !query.deleted && query.folderUid === FOLDER_UID
                        ? [{ uid: "item-1", folderUid: FOLDER_UID, dateModified: new Date("2026-02-01T00:00:00.000Z") }]
                        : [],
                ),
            });
            const render = vi.fn().mockResolvedValue(element(WbxmlCodePage.AirSync, "ApplicationData", []));
            const { command } = await buildCommand("Fake", fakeAdapter({ toApplicationData: render }), repo);
            const plainTextFirst = element(WbxmlCodePage.AirSync, "Options", [
                element(WbxmlCodePage.AirSyncBase, "BodyPreference", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                    textElement(WbxmlCodePage.AirSyncBase, "TruncationSize", "1024"),
                ]),
                element(WbxmlCodePage.AirSyncBase, "BodyPreference", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", "2"),
                    textElement(WbxmlCodePage.AirSyncBase, "TruncationSize", "32768"),
                ]),
            ]);

            await command.handle(buildContext(syncRequest("Fake", [], [plainTextFirst])).ctx);

            expect(render).toHaveBeenCalledWith(expect.objectContaining({ uid: "item-1" }), { type: "2", truncationSize: 32768 }, expect.anything());
        });

        describe("render context (protocol version and the mailbox's zone)", () => {
            const changed = (item: Record<string, any> = {}): any =>
                fakeRepo({
                    find: vi.fn().mockImplementation(async (query: any) =>
                        !query.deleted && query.folderUid === FOLDER_UID
                            ? [{ uid: "item-1", folderUid: FOLDER_UID, dateModified: new Date("2026-02-01T00:00:00.000Z"), ...item }]
                            : [],
                    ),
                });
            const withVersion = (cls: string, version: string) => ({ ...buildContext(syncRequest(cls, [])).ctx, protocolVersion: version });

            it("Hands a Calendar render the client's protocol version and the folder mailbox's zone.", async () => {
                const render = vi.fn().mockReturnValue(element(WbxmlCodePage.AirSync, "ApplicationData", []));
                const { command } = await buildCommand("Calendar", fakeAdapter({ collectionClass: "Calendar", toApplicationData: render }), changed(), {
                    state: storedState({ collectionClass: "Calendar" }),
                });
                (command as any).mailboxRepo.findOne.mockResolvedValue({ uid: "mbx-1", timezone: "Europe/Berlin" });

                await command.handle(withVersion("Calendar", "16.1"));

                expect(render).toHaveBeenCalledWith(expect.anything(), undefined, { protocolVersion: "16.1", mailboxTimezone: "Europe/Berlin" });
            });

            it("Renders without the mailbox's zone, rather than failing the round, when the mailbox can't be read.", async () => {
                const render = vi.fn().mockReturnValue(element(WbxmlCodePage.AirSync, "ApplicationData", []));
                const { command } = await buildCommand("Calendar", fakeAdapter({ collectionClass: "Calendar", toApplicationData: render }), changed(), {
                    state: storedState({ collectionClass: "Calendar" }),
                });
                (command as any).mailboxRepo.findOne.mockResolvedValue(undefined);

                const response = await command.handle(withVersion("Calendar", "14.1"));

                expect(childText(collection(response!), "Status")).toBe("1");
                expect(render).toHaveBeenCalledWith(expect.anything(), undefined, { protocolVersion: "14.1", mailboxTimezone: undefined });
            });

            it("Looks the mailbox up for an Email round only when it renders a meeting invite.", async () => {
                const render = vi.fn().mockReturnValue(element(WbxmlCodePage.AirSync, "ApplicationData", []));
                const { command } = await buildCommand("Email", fakeAdapter({ collectionClass: "Email", toApplicationData: render }), changed({ meetingMethod: "REQUEST" }), {
                    state: storedState({ collectionClass: "Email" }),
                });
                (command as any).mailboxRepo.findOne.mockResolvedValue({ uid: "mbx-1", timezone: "Asia/Tokyo" });

                await command.handle(withVersion("Email", "16.0"));

                expect(render).toHaveBeenCalledWith(expect.anything(), undefined, { protocolVersion: "16.0", mailboxTimezone: "Asia/Tokyo" });
            });
        });
    });

    describe("ACL/ownership enforcement (IDOR regression coverage)", () => {
        it("Add: reports Status 6 without creating anything when the caller lacks CREATE on the folder.", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter({ fromApplicationData: () => ({ title: "New Item" }) });
            const aclUtils = { hasPermission: vi.fn().mockImplementation((_u: any, _f: any, action: string) => Promise.resolve(action !== "create")) };
            const { command } = await buildCommand("Fake", adapter, repo, { aclUtils });
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])])]);

            expect(responseStatus(await command.handle(buildContext(request).ctx), "Add")).toBe("6");
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("Change: reports Status 8 (not 6) when the resolved item actually lives in a different folder/mailbox than the synced CollectionId - the cross-mailbox IDOR case.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: "someone-elses-folder" }) });
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({ title: "Updated" }) }), repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);

            expect(responseStatus(await command.handle(buildContext(request).ctx), "Change")).toBe("8");
            expect(repo.update).not.toHaveBeenCalled();
        });

        it("Change: reports Status 6 without updating anything when the caller lacks UPDATE on the folder.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: FOLDER_UID }) });
            const aclUtils = { hasPermission: vi.fn().mockImplementation((_u: any, _f: any, action: string) => Promise.resolve(action !== "update")) };
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({ title: "Updated" }) }), repo, { aclUtils });
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);

            expect(responseStatus(await command.handle(buildContext(request).ctx), "Change")).toBe("6");
            expect(repo.update).not.toHaveBeenCalled();
        });

        it("Delete: reports Status 8 (not 6) when the resolved item actually lives in a different folder/mailbox than the synced CollectionId.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: "someone-elses-folder" }) });
            const { command } = await buildCommand("Fake", fakeAdapter(), repo);
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")])]);

            expect(responseStatus(await command.handle(buildContext(request).ctx), "Delete")).toBe("8");
            expect(repo.delete).not.toHaveBeenCalled();
        });

        it("Delete: reports Status 6 without deleting anything when the caller lacks DELETE on the folder.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: FOLDER_UID }) });
            const aclUtils = { hasPermission: vi.fn().mockImplementation((_u: any, _f: any, action: string) => Promise.resolve(action !== "delete")) };
            const { command } = await buildCommand("Fake", fakeAdapter(), repo, { aclUtils });
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")])]);

            expect(responseStatus(await command.handle(buildContext(request).ctx), "Delete")).toBe("6");
            expect(repo.delete).not.toHaveBeenCalled();
        });
    });

    describe("Trusted-role (admin) bypass regression - a trusted role must never substitute for a real ACL grant", () => {
        it("READ: denies the whole collection to a trusted-role stranger with no grant at all, same as an ordinary stranger.", async () => {
            const aclUtils = fakeMailAclUtils({});
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { aclUtils });
            const { ctx } = buildContext(syncRequest("Fake", []));
            (ctx as any).user = TRUSTED_STRANGER_USER;

            const response = await command.handle(ctx);

            expect(childText(collection(response!), "Status")).toBe("4");
        });

        it("Add: a trusted-role caller with only READ on the folder (a real delegate grant) still gets Status 6 on CREATE, not let through by the role.", async () => {
            const repo = fakeRepo();
            const aclUtils = fakeMailAclUtils({ [FOLDER_UID]: { [TRUSTED_STRANGER_USER.uid]: ["read"] } });
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({ title: "New Item" }) }), repo, { aclUtils });
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])])]);
            const { ctx } = buildContext(request);
            (ctx as any).user = TRUSTED_STRANGER_USER;

            expect(responseStatus(await command.handle(ctx), "Add")).toBe("6");
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("Change: a trusted-role caller with only READ on the folder still gets Status 6 on UPDATE, not let through by the role.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: FOLDER_UID }) });
            const aclUtils = fakeMailAclUtils({ [FOLDER_UID]: { [TRUSTED_STRANGER_USER.uid]: ["read"] } });
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({ title: "Updated" }) }), repo, { aclUtils });
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);
            (ctx as any).user = TRUSTED_STRANGER_USER;

            expect(responseStatus(await command.handle(ctx), "Change")).toBe("6");
            expect(repo.update).not.toHaveBeenCalled();
        });

        it("Delete: a trusted-role caller with only READ on the folder still gets Status 6 on DELETE, not let through by the role.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: FOLDER_UID }) });
            const aclUtils = fakeMailAclUtils({ [FOLDER_UID]: { [TRUSTED_STRANGER_USER.uid]: ["read"] } });
            const { command } = await buildCommand("Fake", fakeAdapter(), repo, { aclUtils });
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")])]);
            const { ctx } = buildContext(request);
            (ctx as any).user = TRUSTED_STRANGER_USER;

            expect(responseStatus(await command.handle(ctx), "Delete")).toBe("6");
            expect(repo.delete).not.toHaveBeenCalled();
        });
    });

    describe("Add", () => {
        it("Creates a new item in the folder's own mailbox and reports Status 1 with the assigned ServerId, remembering the write.", async () => {
            const created = { uid: "new-uid", dateModified: new Date("2026-01-02T00:00:00.000Z") };
            const repo = fakeRepo({ create: vi.fn().mockResolvedValue(created) });
            const fromApplicationData = vi.fn().mockReturnValue({ title: "New Item" });
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter({ fromApplicationData }), repo, {
                folder: { uid: FOLDER_UID, mailboxUid: "shared-mbx", type: FolderType.USER },
            });
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [
                    textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);

            const response = await command.handle(buildContext(request).ctx);

            const add = findChild(findChild(collection(response!), "Responses")!, "Add")!;
            expect(childText(add, "ClientId")).toBe("client-1");
            expect(childText(add, "ServerId")).toBe("new-uid");
            expect(childText(add, "Status")).toBe("1");
            expect(repo.create).toHaveBeenCalledWith({ title: "New Item", mailboxUid: "shared-mbx", folderUid: FOLDER_UID }, { ignoreACL: true });
            expect(fromApplicationData).toHaveBeenCalledWith(expect.anything(), undefined, expect.objectContaining({ uid: "mbx-1" }));
            const saved = savedState(stateRepo);
            expect(saved.serverIds).toEqual(["new-uid"]);
            expect(saved.echoes).toEqual({ "new-uid": "2026-01-02T00:00:00.000Z" });
            expect(saved.previous.clientIds).toEqual([{ clientId: "client-1", serverId: "new-uid" }]);
        });

        it("Merges newEntityDefaults() under the parsed partial, letting an explicit field win.", async () => {
            const repo = fakeRepo({ create: vi.fn().mockResolvedValue({ uid: "new-uid" }) });
            const adapter = fakeAdapter({
                fromApplicationData: () => ({ sequence: 5 }),
                newEntityDefaults: () => ({ icalUid: "generated@eas", sequence: 0 }),
            });
            const { command } = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])])]);

            await command.handle(buildContext(request).ctx);

            expect(repo.create).toHaveBeenCalledWith(
                { icalUid: "generated@eas", sequence: 5, mailboxUid: "mbx-1", folderUid: FOLDER_UID },
                { ignoreACL: true },
            );
        });

        it("Rejects an Email Add outside a Drafts folder with Status 6.", async () => {
            const repo = fakeRepo();
            const { command } = await buildCommand("Email", fakeAdapter({ fromApplicationData: () => ({}) }), repo, {
                state: storedState({ collectionClass: "Email" }),
                folder: { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.INBOX },
            });
            const request = syncRequest("Email", [element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])])]);

            expect(responseStatus(await command.handle(buildContext(request).ctx), "Add")).toBe("6");
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("Rejects with Status 6 when the caller's own mailbox has vanished.", async () => {
            const repo = fakeRepo();
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), repo);
            (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(undefined) };
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])])]);

            expect(responseStatus(await command.handle(buildContext(request).ctx), "Add")).toBe("6");
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("Rejects with Status 6 when the adapter has no fromApplicationData, or ApplicationData is missing.", async () => {
            const repo = fakeRepo();
            const { command } = await buildCommand("Fake", fakeAdapter(), repo);
            const noParser = await command.handle(
                buildContext(
                    syncRequest("Fake", [
                        element(WbxmlCodePage.AirSync, "Add", [
                            textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                            element(WbxmlCodePage.AirSync, "ApplicationData", []),
                        ]),
                    ]),
                ).ctx,
            );
            const add = findChild(findChild(collection(noParser!), "Responses")!, "Add")!;
            expect(childText(add, "ClientId")).toBe("client-1");
            expect(findChild(add, "ServerId")).toBeUndefined();
            expect(childText(add, "Status")).toBe("6");

            const { command: parsing } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), repo);
            const noData = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Add", [textElement(WbxmlCodePage.AirSync, "ClientId", "client-1")])]);
            expect(responseStatus(await parsing.handle(buildContext(noData).ctx), "Add")).toBe("6");
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("Rejects with Status 6 when the adapter throws or repo.create() throws.", async () => {
            const throwing = fakeAdapter({
                fromApplicationData: () => {
                    throw new Error("bad enum value");
                },
            });
            const { command } = await buildCommand("Fake", throwing, fakeRepo());
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])])]);
            expect(responseStatus(await command.handle(buildContext(request).ctx), "Add")).toBe("6");

            const failingRepo = fakeRepo({ create: vi.fn().mockRejectedValue(new Error("db error")) });
            const { command: failing } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), failingRepo);
            expect(responseStatus(await failing.handle(buildContext(request).ctx), "Add")).toBe("6");
        });
    });

    describe("Change", () => {
        it("Succeeds silently, records the write as an echo, and never advances the cursor past unsent server changes.", async () => {
            const existing = { uid: "item-1", version: 1, folderUid: FOLDER_UID };
            const updated = { uid: "item-1", version: 2, dateModified: new Date("2026-02-01T00:00:00.000Z") };
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(existing), update: vi.fn().mockResolvedValue(updated) });
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({ title: "Updated" }) }), repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);

            const response = await command.handle(buildContext(request).ctx);

            expect(childText(collection(response!), "Status")).toBe("1");
            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(repo.update).toHaveBeenCalledWith({ uid: "item-1", version: 1, title: "Updated" }, existing, { ignoreACL: true });
            const saved = savedState(stateRepo);
            expect(saved.cursorDate).toEqual(OLD_WATERMARK);
            expect(saved.echoes).toEqual({ "item-1": "2026-02-01T00:00:00.000Z" });
            expect(saved.serverIds).toEqual(["item-1"]);
        });

        it("Reports Status 8 when ServerId doesn't resolve, and Status 6 when the adapter can't parse or ApplicationData is missing.", async () => {
            const change = (children: WbxmlElement[]) => syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Change", children)]);
            const withData = change([textElement(WbxmlCodePage.AirSync, "ServerId", "missing-1"), element(WbxmlCodePage.AirSync, "ApplicationData", [])]);

            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), fakeRepo({ findOne: vi.fn().mockResolvedValue(undefined) }));
            const notFound = findChild(findChild(collection((await command.handle(buildContext(withData).ctx))!), "Responses")!, "Change")!;
            expect(childText(notFound, "ServerId")).toBe("missing-1");
            expect(childText(notFound, "Status")).toBe("8");

            const noParserRepo = fakeRepo();
            const { command: noParser } = await buildCommand("Fake", fakeAdapter(), noParserRepo);
            expect(responseStatus(await noParser.handle(buildContext(withData).ctx), "Change")).toBe("6");
            expect(noParserRepo.findOne).not.toHaveBeenCalled();

            const existingRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: FOLDER_UID }) });
            const { command: noData } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), existingRepo);
            expect(responseStatus(await noData.handle(buildContext(change([textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")])).ctx), "Change")).toBe("6");
        });

        it("Reports Status 7 on an optimistic-concurrency conflict and Status 6 on any other update failure.", async () => {
            // A genuine conflict only arises from a concurrent write racing between findOne() and update() - injected.
            const existing = { uid: "item-1", version: 1, folderUid: FOLDER_UID };
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const conflictRepo = fakeRepo({
                findOne: vi.fn().mockResolvedValue(existing),
                update: vi.fn().mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "Version conflict")),
            });
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), conflictRepo);
            expect(responseStatus(await command.handle(buildContext(request).ctx), "Change")).toBe("7");

            const brokenRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue(existing), update: vi.fn().mockRejectedValue(new Error("db error")) });
            const { command: broken } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), brokenRepo);
            expect(responseStatus(await broken.handle(buildContext(request).ctx), "Change")).toBe("6");
        });

        it("Ignores a Change or Delete command with no ServerId at all.", async () => {
            const repo = fakeRepo();
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}) }), repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [element(WbxmlCodePage.AirSync, "ApplicationData", [])]),
                element(WbxmlCodePage.AirSync, "Delete", []),
            ]);

            const response = await command.handle(buildContext(request).ctx);

            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(repo.findOne).not.toHaveBeenCalled();
        });
    });

    describe("Fetch", () => {
        it("Renders the item's full ApplicationData (honouring BodyPreference) inline in Responses, with Status 1 - the mechanism a real device (Apple Mail) uses to fetch a message body, instead of ItemOperations.", async () => {
            const existing = { uid: "item-1", folderUid: FOLDER_UID };
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) });
            const render = vi.fn().mockResolvedValue(element(WbxmlCodePage.AirSync, "ApplicationData", [textElement(WbxmlCodePage.Email, "Subject", "Hi")]));
            const { command } = await buildCommand("Fake", fakeAdapter({ toApplicationData: render }), repo);
            const bodyPreferenceOptions = element(WbxmlCodePage.AirSync, "Options", [
                element(WbxmlCodePage.AirSyncBase, "BodyPreference", [textElement(WbxmlCodePage.AirSyncBase, "Type", "4")]),
            ]);
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Fetch", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")])], [bodyPreferenceOptions]);

            const response = await command.handle(buildContext(request).ctx);

            const fetchResponse = findChild(findChild(collection(response!), "Responses")!, "Fetch")!;
            expect(childText(fetchResponse, "ServerId")).toBe("item-1");
            expect(childText(fetchResponse, "Status")).toBe("1");
            expect(childText(findChild(fetchResponse, "ApplicationData")!, "Subject")).toBe("Hi");
            expect(render).toHaveBeenCalledWith(existing, { type: "4", truncationSize: undefined }, expect.anything());
        });

        it("Reports Status 8 when ServerId doesn't resolve (or resolves outside this collection), and Status 6 when the adapter's render throws - and ignores a Fetch with no ServerId at all. No separate per-item READ check: handleCollection()'s own gate already requires READ on this exact folder before any command in it runs.", async () => {
            const fetch = (serverId?: string) =>
                syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Fetch", serverId ? [textElement(WbxmlCodePage.AirSync, "ServerId", serverId)] : [])]);

            const { command: notFound } = await buildCommand("Fake", fakeAdapter(), fakeRepo({ findOne: vi.fn().mockResolvedValue(undefined) }));
            expect(responseStatus(await notFound.handle(buildContext(fetch("missing-1")).ctx), "Fetch")).toBe("8");

            const outsideCollection = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", folderUid: "someone-elses-folder" }) });
            const { command: outside } = await buildCommand("Fake", fakeAdapter(), outsideCollection);
            expect(responseStatus(await outside.handle(buildContext(fetch("item-1")).ctx), "Fetch")).toBe("8");

            const brokenRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", folderUid: FOLDER_UID }) });
            const { command: broken } = await buildCommand(
                "Fake",
                fakeAdapter({
                    toApplicationData: () => {
                        throw new Error("render failed");
                    },
                }),
                brokenRepo,
            );
            expect(responseStatus(await broken.handle(buildContext(fetch("item-1")).ctx), "Fetch")).toBe("6");

            const ignoredRepo = fakeRepo();
            const { command: ignored } = await buildCommand("Fake", fakeAdapter(), ignoredRepo);
            const ignoredResponse = await ignored.handle(buildContext(fetch()).ctx);
            expect(findChild(collection(ignoredResponse!), "Responses")).toBeUndefined();
            expect(ignoredRepo.findOne).not.toHaveBeenCalled();
        });
    });

    describe("airsyncbase:InstanceId (one occurrence of a recurring series, protocol 16.0+)", () => {
        const withInstanceId = (kind: "Change" | "Delete", instanceId = "20260101T120000Z") =>
            syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, kind, [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    textElement(WbxmlCodePage.AirSyncBase, "InstanceId", instanceId),
                    ...(kind === "Change" ? [element(WbxmlCodePage.AirSync, "ApplicationData", [])] : []),
                ]),
            ]);

        it("Change: delegates to the adapter's changeInstance() instead of the whole-item update, when InstanceId is present.", async () => {
            const existing = { uid: "item-1", version: 1, folderUid: FOLDER_UID };
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) });
            const changeInstance = vi.fn().mockResolvedValue(undefined);
            const { command } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: () => ({}), changeInstance }), repo);

            const response = await command.handle(buildContext(withInstanceId("Change")).ctx);

            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(changeInstance).toHaveBeenCalledWith(existing, "20260101T120000Z", expect.objectContaining({ tag: "ApplicationData" }), repo, expect.anything());
            expect(repo.update).not.toHaveBeenCalled();
        });

        it("Change: reports Status 6 when the adapter has no changeInstance(), Status 7 on a version conflict, and Status 6 on any other changeInstance() failure.", async () => {
            const existing = { uid: "item-1", version: 1, folderUid: FOLDER_UID };

            const { command: noHandler } = await buildCommand(
                "Fake",
                fakeAdapter({ fromApplicationData: () => ({}) }),
                fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) }),
            );
            expect(responseStatus(await noHandler.handle(buildContext(withInstanceId("Change")).ctx), "Change")).toBe("6");

            const { command: conflict } = await buildCommand(
                "Fake",
                fakeAdapter({
                    fromApplicationData: () => ({}),
                    changeInstance: vi.fn().mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "Version conflict")),
                }),
                fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) }),
            );
            expect(responseStatus(await conflict.handle(buildContext(withInstanceId("Change")).ctx), "Change")).toBe("7");

            const { command: broken } = await buildCommand(
                "Fake",
                fakeAdapter({ fromApplicationData: () => ({}), changeInstance: vi.fn().mockRejectedValue(new Error("db error")) }),
                fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) }),
            );
            expect(responseStatus(await broken.handle(buildContext(withInstanceId("Change")).ctx), "Change")).toBe("6");
        });

        it("Delete: delegates to the adapter's deleteInstance() instead of the whole-item delete, when InstanceId is present.", async () => {
            const existing = { uid: "item-1", version: 1, folderUid: FOLDER_UID };
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) });
            const deleteInstance = vi.fn().mockResolvedValue(undefined);
            const { command } = await buildCommand("Fake", fakeAdapter({ deleteInstance }), repo);

            const response = await command.handle(buildContext(withInstanceId("Delete")).ctx);

            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(deleteInstance).toHaveBeenCalledWith(existing, "20260101T120000Z", repo);
            expect(repo.delete).not.toHaveBeenCalled();
        });

        it("Delete: reports Status 6 when the adapter has no deleteInstance(), and Status 6 on any deleteInstance() failure.", async () => {
            const existing = { uid: "item-1", version: 1, folderUid: FOLDER_UID };

            const { command: noHandler } = await buildCommand("Fake", fakeAdapter(), fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) }));
            expect(responseStatus(await noHandler.handle(buildContext(withInstanceId("Delete")).ctx), "Delete")).toBe("6");

            const { command: broken } = await buildCommand(
                "Fake",
                fakeAdapter({ deleteInstance: vi.fn().mockRejectedValue(new Error("db error")) }),
                fakeRepo({ findOne: vi.fn().mockResolvedValue(existing) }),
            );
            expect(responseStatus(await broken.handle(buildContext(withInstanceId("Delete")).ctx), "Delete")).toBe("6");
        });
    });

    describe("Delete", () => {
        it("Deletes a non-Email item silently and forgets it.", async () => {
            const repo = fakeRepo({
                findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1, folderUid: FOLDER_UID }),
                delete: vi.fn().mockResolvedValue(undefined),
            });
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter(), repo, {
                state: storedState({ serverIds: ["item-1"], echoes: { "item-1": "2099-01-01T00:00:00.000Z" } }),
            });
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")])]);

            const response = await command.handle(buildContext(request).ctx);

            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(repo.delete).toHaveBeenCalledWith("item-1", { ignoreACL: true });
            const saved = savedState(stateRepo);
            expect(saved.serverIds).toEqual([]);
            expect(saved.echoes).toEqual({});
        });

        it("Moves a deleted Email to the mailbox's Deleted Items by default, deleting only inside Deleted Items or with DeletesAsMoves 0.", async () => {
            const emailState = storedState({ collectionClass: "Email" });
            const request = (extra: WbxmlElement[] = []) =>
                syncRequest("Email", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "msg-1")])], extra);
            const message = { uid: "msg-1", version: 3, folderUid: FOLDER_UID };

            const movingRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue(message), update: vi.fn().mockResolvedValue({}) });
            const { command, folderRepo } = await buildCommand("Email", fakeAdapter(), movingRepo, {
                state: emailState,
                folder: { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.INBOX },
            });
            await command.handle(buildContext(request()).ctx);
            // restapi's `findOrCreateWellKnownFolder` (>= 0.10.0) queries with an explicit oldest-first sort/limit
            // and passes matching `find()` options, rather than the bare `{ mailboxUid, type }` + generic options
            // this assertion originally expected.
            expect(folderRepo.find).toHaveBeenCalledWith(
                { mailboxUid: "mbx-1", type: FolderType.DELETED_ITEMS, sort: { dateCreated: "ASC", uid: "ASC" }, limit: 1 },
                { ignoreACL: true, limit: 1, skipCache: true },
            );
            expect(movingRepo.update).toHaveBeenCalledWith(
                { uid: "msg-1", version: 3, folderUid: "deleted-items" },
                message,
                expect.objectContaining({ ignoreACL: true }),
            );
            expect(movingRepo.delete).not.toHaveBeenCalled();

            const hardRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue(message), delete: vi.fn().mockResolvedValue(undefined) });
            const { command: hard } = await buildCommand("Email", fakeAdapter(), hardRepo, {
                state: emailState,
                folder: { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.INBOX },
            });
            await hard.handle(buildContext(request([textElement(WbxmlCodePage.AirSync, "DeletesAsMoves", "0")])).ctx);
            expect(hardRepo.delete).toHaveBeenCalledWith("msg-1", { ignoreACL: true });

            const trashRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue(message), delete: vi.fn().mockResolvedValue(undefined) });
            const { command: trash } = await buildCommand("Email", fakeAdapter(), trashRepo, {
                state: emailState,
                folder: { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.DELETED_ITEMS },
            });
            await trash.handle(buildContext(request()).ctx);
            expect(trashRepo.delete).toHaveBeenCalledWith("msg-1", { ignoreACL: true });
        });

        it("Stamps what the adapter's beforeDelete asks for (judged against the folder's own mailbox) before deleting, and passes that mailbox to a Change.", async () => {
            const existing = { uid: "event-1", version: 2, folderUid: FOLDER_UID };
            const repo = fakeRepo({
                findOne: vi.fn().mockResolvedValue(existing),
                update: vi.fn().mockResolvedValue({ uid: "event-1", version: 3 }),
                delete: vi.fn().mockResolvedValue(undefined),
            });
            const beforeDelete = vi.fn().mockReturnValue({ cancelNoticeSentAt: new Date("2026-02-01T00:00:00.000Z") });
            const fromApplicationData = vi.fn().mockReturnValue({});
            const { command } = await buildCommand("Fake", fakeAdapter({ beforeDelete, fromApplicationData }), repo, {
                folder: { uid: FOLDER_UID, mailboxUid: "shared-mbx", type: FolderType.CALENDAR },
            });
            const ownerMailbox = { uid: "shared-mbx", primarySmtpAddress: "owner@example.com" };
            (command as any).mailboxRepo = { findOne: vi.fn().mockImplementation(async (uid: string) => (uid === "shared-mbx" ? ownerMailbox : { uid })) };

            await command.handle(
                buildContext(
                    syncRequest("Fake", [
                        element(WbxmlCodePage.AirSync, "Change", [textElement(WbxmlCodePage.AirSync, "ServerId", "event-1"), element(WbxmlCodePage.AirSync, "ApplicationData", [])]),
                        element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "event-1")]),
                    ]),
                ).ctx,
            );

            expect(fromApplicationData).toHaveBeenCalledWith(expect.anything(), existing, ownerMailbox);
            expect(beforeDelete).toHaveBeenCalledWith(existing, ownerMailbox);
            expect(repo.update).toHaveBeenLastCalledWith({ uid: "event-1", version: 2, cancelNoticeSentAt: new Date("2026-02-01T00:00:00.000Z") }, existing, { ignoreACL: true });
            expect(repo.delete).toHaveBeenCalledWith("event-1", { ignoreACL: true });

            // Nothing to stamp: straight to the delete.
            const plainRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue(existing), delete: vi.fn().mockResolvedValue(undefined) });
            const { command: plain } = await buildCommand("Fake", fakeAdapter({ beforeDelete: () => undefined }), plainRepo);
            await plain.handle(buildContext(syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "event-1")])])).ctx);
            expect(plainRepo.update).not.toHaveBeenCalled();
            expect(plainRepo.delete).toHaveBeenCalled();
        });

        it("Reports Status 8 when ServerId doesn't resolve and Status 6 when the delete itself throws.", async () => {
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "missing-1")])]);
            const { command } = await buildCommand("Fake", fakeAdapter(), fakeRepo({ findOne: vi.fn().mockResolvedValue(undefined) }));
            const del = findChild(findChild(collection((await command.handle(buildContext(request).ctx))!), "Responses")!, "Delete")!;
            expect(childText(del, "ServerId")).toBe("missing-1");
            expect(childText(del, "Status")).toBe("8");

            const failingRepo = fakeRepo({
                findOne: vi.fn().mockResolvedValue({ uid: "missing-1", version: 1, folderUid: FOLDER_UID }),
                delete: vi.fn().mockRejectedValue(new Error("db error")),
            });
            const { command: failing } = await buildCommand("Fake", fakeAdapter(), failingRepo);
            expect(responseStatus(await failing.handle(buildContext(request).ctx), "Delete")).toBe("6");
        });
    });

    describe("Round 5", () => {
        const newItemRepo = (uid: string = "one-more") =>
            fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) =>
                    !query.deleted && query.folderUid === FOLDER_UID && !String(query.dateModified).startsWith("range")
                        ? [{ uid, folderUid: FOLDER_UID, dateModified: new Date("2026-02-01T00:00:00.000Z") }]
                        : [],
                ),
            });

        it("Blanks the current and previous SyncKey (marking the row chunked) before any chunk write, so a failed chunk round leaves no key to retry.", async () => {
            const chunkRows = [{ uid: "chunk-0", version: 1, mailboxUid: "mbx-1", deviceId: "dev-1", folderUid: FOLDER_UID, chunkIndex: 0, ids: ["held-1"] }];
            const stored = storedState({ chunked: true, previous: { syncKey: PREVIOUS_KEY, addedIds: [], removedIds: [], echoes: {}, clientIds: [] } });
            const { command, stateRepo, chunkRepo, logger } = await buildCommand("Fake", fakeAdapter(), newItemRepo(), { state: stored });
            chunkRepo.find.mockResolvedValue(chunkRows);
            chunkRepo.update.mockRejectedValue(new Error("chunk write failed"));

            const response = await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            expect(childText(collection(response!), "Status")).toBe("3");
            expect(stateRepo.update).toHaveBeenCalledTimes(1);
            const [invalidation, existing] = stateRepo.update.mock.calls[0];
            expect(invalidation).toEqual({ uid: "state-1", version: 4, syncKey: "", previous: expect.objectContaining({ syncKey: "" }), serverIds: [], chunked: true });
            expect(existing).toBe(stored);
            expect(stateRepo.update.mock.invocationCallOrder[0]).toBeLessThan(chunkRepo.update.mock.invocationCallOrder[0]);
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("chunk write failed"));

            // Neither the key the device holds nor the previous one matches the invalidated row.
            for (const key of [STORED_KEY, PREVIOUS_KEY]) {
                const { command: next } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { state: { ...stored, ...invalidation } });
                expect(childText(collection((await next.handle(buildContext(syncRequest("Fake", [], [], key)).ctx))!), "Status")).toBe("3");
            }
        });

        it("A successful chunked round writes the final state on top of the invalidated row's version.", async () => {
            const chunkRows = [{ uid: "chunk-0", version: 1, mailboxUid: "mbx-1", deviceId: "dev-1", folderUid: FOLDER_UID, chunkIndex: 0, ids: ["held-1"] }];
            const { command, stateRepo, chunkRepo } = await buildCommand("Fake", fakeAdapter(), newItemRepo(), { state: storedState({ chunked: true }) });
            chunkRepo.find.mockResolvedValue(chunkRows);

            const response = await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            expect(childText(collection(response!), "Status")).toBe("1");
            expect(stateRepo.update).toHaveBeenCalledTimes(2);
            expect(stateRepo.update.mock.calls[0][0].previous).toBeUndefined();
            expect(stateRepo.update.mock.calls[1][0]).toEqual(
                expect.objectContaining({ version: 5, syncKey: childText(collection(response!), "SyncKey"), chunked: true }),
            );
            expect(chunkRepo.update.mock.calls[0][0].ids).toEqual(["held-1", "one-more"]);
        });

        it("Clears leftover chunk rows before converting an inline held set to chunks, and on every SyncKey 0.", async () => {
            const held = Array.from({ length: INLINE_HELD_LIMIT }, (_, i) => `held-${i}`);
            const { command, chunkRepo } = await buildCommand("Fake", fakeAdapter(), newItemRepo(), { state: storedState({ serverIds: held }) });

            await command.handle(buildContext(syncRequest("Fake", [])).ctx);

            expect(chunkRepo.truncate).toHaveBeenCalledWith({ mailboxUid: "mbx-1", deviceId: "dev-1", folderUid: FOLDER_UID }, { ignoreACL: true });
            expect(chunkRepo.truncate.mock.invocationCallOrder[0]).toBeLessThan(chunkRepo.create.mock.invocationCallOrder[0]);

            // A row that says it isn't chunked (orphans from a failed conversion) is still cleared by SyncKey 0.
            const { command: restart, chunkRepo: restartChunks } = await buildCommand("Fake", fakeAdapter(), fakeRepo(), { state: storedState({ chunked: false }) });
            await restart.handle(buildContext(syncRequest("Fake", [], [], "0")).ctx);
            expect(restartChunks.truncate).toHaveBeenCalledTimes(1);
        });

        it("A delete (as a move) out of Outbox cancels the scheduled send, and is refused once the message was relayed.", async () => {
            const request = syncRequest("Email", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "msg-1")])]);
            const outbox = { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.OUTBOX };
            const queued = { uid: "msg-1", version: 3, folderUid: FOLDER_UID, scheduledSendTime: new Date(), scheduledSendAttempts: 2 };

            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(queued), update: vi.fn().mockResolvedValue({}) });
            const { command } = await buildCommand("Email", fakeAdapter(), repo, { state: storedState({ collectionClass: "Email" }), folder: outbox });
            await command.handle(buildContext(request).ctx);
            expect(repo.update.mock.calls[0][0]).toEqual({
                uid: "msg-1",
                version: 3,
                folderUid: "deleted-items",
                scheduledSendTime: null,
                scheduledSendAttempts: null,
            });

            const relayedRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ ...queued, scheduledSendRelayedAt: new Date() }), update: vi.fn() });
            const { command: relayed } = await buildCommand("Email", fakeAdapter(), relayedRepo, { state: storedState({ collectionClass: "Email" }), folder: outbox });
            expect(responseStatus(await relayed.handle(buildContext(request).ctx), "Delete")).toBe("6");
            expect(relayedRepo.update).not.toHaveBeenCalled();
        });

        it("Hands every update a version-checked entity when the repository has a model class.", async () => {
            class FakeEntity {
                constructor(row: any) {
                    Object.assign(this, row);
                }
            }
            const existing = { uid: "item-1", version: 1, folderUid: FOLDER_UID };
            const repo = fakeRepo({ modelClass: FakeEntity, findOne: vi.fn().mockResolvedValue(existing), update: vi.fn().mockResolvedValue({ uid: "item-1" }) });
            const { command, stateRepo } = await buildCommand("Fake", fakeAdapter({ fromApplicationData: vi.fn().mockReturnValue({}) }), repo);
            (stateRepo).modelClass = FakeEntity;

            await command.handle(
                buildContext(
                    syncRequest("Fake", [
                        element(WbxmlCodePage.AirSync, "Change", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"), element(WbxmlCodePage.AirSync, "ApplicationData", [])]),
                    ]),
                ).ctx,
            );

            expect(repo.update.mock.calls[0][1]).toBeInstanceOf(FakeEntity);
            expect(stateRepo.update.mock.calls[0][1]).toBeInstanceOf(FakeEntity);
        });
    });

    describe("Round 6: deletes during a send", () => {
        it("Refuses (Status 6) to delete, or delete-as-move, a message whose send lease is live, and deletes it once it lapsed.", async () => {
            const live = { uid: "msg-1", version: 3, folderUid: FOLDER_UID, mailboxUid: "mbx-1", scheduledSendLeaseExpiresAt: new Date(Date.now() + 60_000) };
            const request = (extra: WbxmlElement[] = []) =>
                syncRequest("Email", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "msg-1")])], extra);
            for (const extra of [[], [textElement(WbxmlCodePage.AirSync, "DeletesAsMoves", "0")]]) {
                const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(live), update: vi.fn(), delete: vi.fn() });
                const { command } = await buildCommand("Email", fakeAdapter(), repo, { state: storedState({ collectionClass: "Email" }), folder: { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.OUTBOX } });
                expect(responseStatus(await command.handle(buildContext(request(extra)).ctx), "Delete")).toBe("6");
                expect(repo.update).not.toHaveBeenCalled();
                expect(repo.delete).not.toHaveBeenCalled();
            }

            const lapsedRepo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ ...live, scheduledSendLeaseExpiresAt: new Date(Date.now() - 1000) }), delete: vi.fn() });
            const { command: lapsed } = await buildCommand("Email", fakeAdapter(), lapsedRepo, { state: storedState({ collectionClass: "Email" }), folder: { uid: FOLDER_UID, mailboxUid: "mbx-1", type: FolderType.DELETED_ITEMS } });
            await lapsed.handle(buildContext(request()).ctx);
            expect(lapsedRepo.delete).toHaveBeenCalledWith("msg-1", { ignoreACL: true });
        });
    });

    describe("Round 6: audit of non-owner access", () => {
        const mailboxes: Record<string, any> = {
            "mbx-1": { uid: "mbx-1", ownerUserUid: "user-1", primarySmtpAddress: "owner@example.com", displayName: "Owner" },
            "mbx-2": { uid: "mbx-2", ownerUserUid: "user-2", primarySmtpAddress: "boss@example.com", displayName: "Boss" },
        };
        const shared = { uid: FOLDER_UID, mailboxUid: "mbx-2", type: FolderType.INBOX };

        /** Gives `command` a real restapi `AuditLogUtils` over a fake audit repository; returns the rows written. */
        function withAudit(command: SyncCommandMongo): any[] {
            class FakeAuditLogEntry {
                constructor(values: any) {
                    Object.assign(this, values);
                }
            }
            const written: any[] = [];
            const auditLogUtils: any = new AuditLogUtils({ modelClass: FakeAuditLogEntry, create: vi.fn(async (entry: any) => written.push(entry)) } as any);
            auditLogUtils.config = config;
            (command as any).auditLogUtils = auditLogUtils;
            (command as any).mailboxRepo = { findOne: vi.fn(async (uid: string) => mailboxes[uid]) };
            return written;
        }
        const rows = [
            { uid: "m1", folderUid: FOLDER_UID, mailboxUid: "mbx-2", dateModified: new Date(Date.UTC(2026, 1, 1, 0, 1)) },
            { uid: "m2", folderUid: FOLDER_UID, mailboxUid: "mbx-2", dateModified: new Date(Date.UTC(2026, 1, 1, 0, 2)) },
        ];
        const enumerating = () =>
            fakeRepo({
                find: vi.fn().mockImplementation(async (query: any) => (query.deleted || String(query.dateModified).startsWith("range") || query.folderUid !== FOLDER_UID ? [] : rows)),
            });

        it("Records one MESSAGE_CONTENT_ACCESSED entry per Email round sent from another owner's mailbox, listing the items.", async () => {
            const { command } = await buildCommand("Email", fakeAdapter(), enumerating(), { state: storedState({ collectionClass: "Email" }), folder: shared });
            const written = withAudit(command);

            const response = await command.handle(buildContext(syncRequest("Email", [])).ctx);

            expect(findChildren(findChild(collection(response!), "Commands")!, "Add")).toHaveLength(2);
            expect(written).toHaveLength(1);
            expect(written[0]).toMatchObject({
                action: "message.content_accessed",
                targetType: "Folder",
                targetUid: FOLDER_UID,
                mailboxUid: "mbx-2",
                actorUserUid: "user-1",
                details: { protocol: "ActiveSync", command: "Sync", deviceId: "dev-1", operation: "Sync", count: 2, messageUids: ["m1", "m2"] },
            });
        });

        it("Records nothing for the caller's own mailbox, for a round with no items, or for other collection classes.", async () => {
            const own = await buildCommand("Email", fakeAdapter(), enumerating(), {
                state: storedState({ collectionClass: "Email" }),
                folder: { ...shared, mailboxUid: "mbx-1" },
            });
            const ownWritten = withAudit(own.command);
            await own.command.handle(buildContext(syncRequest("Email", [])).ctx);
            expect(ownWritten).toEqual([]);
            expect((own.command as any).mailboxRepo.findOne).not.toHaveBeenCalledWith("mbx-1", expect.anything());

            const quiet = await buildCommand("Email", fakeAdapter(), fakeRepo(), { state: storedState({ collectionClass: "Email" }), folder: shared });
            const quietWritten = withAudit(quiet.command);
            await quiet.command.handle(buildContext(syncRequest("Email", [])).ctx);
            expect(quietWritten).toEqual([]);

            const contacts = await buildCommand("Contacts", fakeAdapter(), enumerating(), { state: storedState({ collectionClass: "Contacts" }), folder: shared });
            const contactsWritten = withAudit(contacts.command);
            await contacts.command.handle(buildContext(syncRequest("Contacts", [])).ctx);
            expect(contactsWritten).toEqual([]);
        });

        it("Records a MESSAGE_DELETE entry per Email Delete in another owner's mailbox, whether moved to Deleted Items or deleted.", async () => {
            const message = { uid: "msg-1", version: 3, folderUid: FOLDER_UID, mailboxUid: "mbx-2", subject: "Payroll" };
            const request = (extra: WbxmlElement[] = []) =>
                syncRequest("Email", [element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "msg-1")])], extra);

            const moving = await buildCommand("Email", fakeAdapter(), fakeRepo({ findOne: vi.fn().mockResolvedValue(message), update: vi.fn().mockResolvedValue({}) }), {
                state: storedState({ collectionClass: "Email" }),
                folder: shared,
            });
            const movedWritten = withAudit(moving.command);
            await moving.command.handle(buildContext(request()).ctx);
            expect(movedWritten).toEqual([
                expect.objectContaining({
                    action: "message.delete",
                    targetType: "Message",
                    targetUid: "msg-1",
                    mailboxUid: "mbx-2",
                    details: expect.objectContaining({ subject: "Payroll", folderUid: FOLDER_UID, movedToDeletedItems: true, command: "Sync" }),
                }),
            ]);

            const hard = await buildCommand("Email", fakeAdapter(), fakeRepo({ findOne: vi.fn().mockResolvedValue(message), delete: vi.fn().mockResolvedValue(undefined) }), {
                state: storedState({ collectionClass: "Email" }),
                folder: shared,
            });
            const hardWritten = withAudit(hard.command);
            await hard.command.handle(buildContext(request([textElement(WbxmlCodePage.AirSync, "DeletesAsMoves", "0")])).ctx);
            expect(hardWritten.map((entry) => [entry.action, entry.details.movedToDeletedItems])).toEqual([["message.delete", false]]);

            // A failed delete records nothing.
            const failing = await buildCommand("Email", fakeAdapter(), fakeRepo({ findOne: vi.fn().mockResolvedValue(message), delete: vi.fn().mockRejectedValue(new Error("x")) }), {
                state: storedState({ collectionClass: "Email" }),
                folder: shared,
            });
            const failedWritten = withAudit(failing.command);
            await failing.command.handle(buildContext(request([textElement(WbxmlCodePage.AirSync, "DeletesAsMoves", "0")])).ctx);
            expect(failedWritten).toEqual([]);
        });
    });
});
