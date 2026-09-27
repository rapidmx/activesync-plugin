///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseEasRoute, reserved for the defensive guard branches a real wired server can
// never exercise (`!this.deviceSyncStateRepo || !this.mailboxRepo` - DI always populates both before a request
// can reach a route - and `!user`, a second defensive check behind `@Auth(["jwt"])` itself for the rare case
// `dispatch()` is invoked directly, same rationale `BaseFolderRoute.test.ts`/`BaseMessageRoute.test.ts` already
// use for their own guard clauses), plus the "handler legitimately returns no body" response path - no
// currently-registered real command (Provision/FolderSync/Ping) ever takes that branch, so it's exercised here
// against a hand-registered fake handler rather than left uncovered. Every other behavior (query-parameter
// validation, mailbox resolution, DeviceSyncState find-or-create, the provisioning gate, unimplemented-command
// handling) is exercised via real HTTP+DB requests in test/routes/mongo/EasRoute.test.ts (and its sql/
// counterpart), matching this library's real-server-integration-test convention.
//
// `options()` is also tested directly here (a direct method call, not real HTTP) rather than via those
// integration tests: it only actually bypasses the global CORS preflight 204 on a `@rapidrest/service-core`
// version carrying this session's own `hasExplicitOptionsRoute()` fix, which this package's currently-pinned
// published `service-core` dependency doesn't yet include - see `BaseEasRoute.ts`'s own doc comment. A direct
// call proves the handler's own header-building logic is correct regardless of that upstream dependency.
import config from "../config.js";
import { ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import { ApiError, Logger } from "@rapidrest/core";
import { BaseEasRoute } from "../../src/BaseEasRoute.js";
import { WbxmlDecoder } from "../../src/codec/WbxmlDecoder.js";

class TestEasRoute extends BaseEasRoute<any> {
    protected deviceSyncStateClass: any = { name: "TestDeviceSyncState" };
    protected mailboxClass: any = { name: "TestMailbox" };
}

function makeReq(): any {
    return { query: { Cmd: "FolderSync", DeviceId: "dev1" }, headers: {}, rawBody: undefined };
}

function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
    };
}

describe("BaseEasRoute Tests (guard clauses only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("dispatch() throws INTERNAL_ERROR when deviceSyncStateRepo/mailboxRepo are not set.", async () => {
        // `initialize: false` skips `@Init` (and `@Config`/`@Logger`/`@Inject`), leaving both repos
        // genuinely `undefined` - exactly what this guard clause exists to catch.
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });

        await expect(route.dispatch(makeReq(), makeRes(), { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("dispatch() throws AUTH_PERMISSION_FAILURE when no authenticated user is present.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });
        // Poking the private repo fields directly (TypeScript `private` is compile-time only) isolates this
        // guard from the one above, which would otherwise fire first.
        (route as any).deviceSyncStateRepo = {};
        (route as any).mailboxRepo = {};

        await expect(route.dispatch(makeReq(), makeRes(), undefined)).rejects.toThrow(/permission/i);
    });

    it("dispatch() sends a bare 200 with no body when the matched handler returns undefined.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });
        const deviceSyncState = { uid: "dss-1", version: 1, provisioned: true, policyKey: "pk-1", mailboxUid: "mbx-1", deviceId: "dev1" };
        (route as any).deviceSyncStateRepo = {
            find: vi.fn().mockResolvedValue([deviceSyncState]),
            update: vi.fn().mockResolvedValue(undefined),
        };
        (route as any).mailboxRepo = { find: vi.fn().mockResolvedValue([{ uid: "mbx-1" }]) };
        (route as any).handlers.set("NoOp", { command: "NoOp", handle: vi.fn().mockResolvedValue(undefined) });

        const res = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "x-ms-policykey": "pk-1" }, rawBody: undefined } as any, res, {
            uid: "user-1",
        } as any);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith();
    });

    /** A route whose repos resolve one provisioned device (policy key `pk-1`) and one registered `NoOp` handler. */
    function provisionedRoute(update: any = vi.fn().mockResolvedValue(undefined)): { route: TestEasRoute; handle: any; logger: any } {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false }) as TestEasRoute;
        const deviceSyncState = { uid: "dss-1", version: 1, provisioned: true, policyKey: "pk-1", mailboxUid: "mbx-1", deviceId: "dev1" };
        const handle = vi.fn().mockResolvedValue(undefined);
        const logger = { warn: vi.fn() };
        (route as any).deviceSyncStateRepo = { find: vi.fn().mockResolvedValue([deviceSyncState]), update, findOne: vi.fn() };
        (route as any).mailboxRepo = { find: vi.fn().mockResolvedValue([{ uid: "mbx-1" }]) };
        (route as any).handlers.set("NoOp", { command: "NoOp", handle });
        (route as any).logger = logger;
        return { route, handle, logger };
    }

    it("dispatch() leaves a rawBody handler's ctx.request undefined (raw MIME, not WBXML) whenever Content-Type doesn't say wbxml, including when no Content-Type header is sent at all.", async () => {
        const { route, handle } = provisionedRoute();
        (route as any).handlers.set("SendMail", { command: "SendMail", rawBody: true, handle });

        await route.dispatch(
            { query: { Cmd: "SendMail", DeviceId: "dev1" }, headers: { "x-ms-policykey": "pk-1" }, rawBody: Buffer.from("From: a@b.com") } as any,
            makeRes(),
            { uid: "user-1" } as any,
        );

        expect(handle).toHaveBeenCalledWith(expect.objectContaining({ request: undefined }));
    });

    it("dispatch() answers 413 for a body beyond mail:eas:max_request_bytes, by declared or actual size, before any lookup.", async () => {
        const { route, handle } = provisionedRoute();
        (route as any).maxRequestBytes = 10;

        const declared = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "content-length": "11" } } as any, declared, { uid: "user-1" } as any);
        expect(declared.status).toHaveBeenCalledWith(413);

        const actual = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: {}, rawBody: Buffer.alloc(11) } as any, actual, { uid: "user-1" } as any);
        expect(actual.status).toHaveBeenCalledWith(413);
        expect(handle).not.toHaveBeenCalled();
        expect((route as any).mailboxRepo.find).not.toHaveBeenCalled();
    });

    it("dispatch() rejects a DeviceId the query parser could read as an operator or a list, before any lookup.", async () => {
        const { route, handle } = provisionedRoute();

        // `me` and `null` mean something to the query parser even without an operator (the caller's uid, IS NULL).
        for (const deviceId of ["ne(dev1)", "a,b", "has space", "x".repeat(129), "", "me", "null"]) {
            await expect(route.dispatch({ query: { Cmd: "NoOp", DeviceId: deviceId }, headers: {} } as any, makeRes(), { uid: "user-1" } as any)).rejects.toMatchObject({
                status: 400,
            });
        }
        expect(handle).not.toHaveBeenCalled();
        expect((route as any).deviceSyncStateRepo.find).not.toHaveBeenCalled();

        for (const deviceId of ["Appl-F4_1.x:y", "Me", "NULL", "meme"]) {
            const tolerant = makeRes();
            await route.dispatch({ query: { Cmd: "NoOp", DeviceId: deviceId, PolicyKey: "pk-1" }, headers: {} } as any, tolerant, { uid: "user-1" } as any);
            expect(tolerant.status).toHaveBeenCalledWith(200);
        }
    });

    it("dispatch() answers 449 when a provisioned device presents a missing or stale policy key, accepting the PolicyKey query value too.", async () => {
        const { route, handle } = provisionedRoute();

        const missing = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: {} } as any, missing, { uid: "user-1" } as any);
        expect(missing.status).toHaveBeenCalledWith(449);

        const stale = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "x-ms-policykey": "old" } } as any, stale, { uid: "user-1" } as any);
        expect(stale.status).toHaveBeenCalledWith(449);
        expect(handle).not.toHaveBeenCalled();

        const viaQuery = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1", PolicyKey: "pk-1" }, headers: {} } as any, viaQuery, { uid: "user-1" } as any);
        expect(viaQuery.status).toHaveBeenCalledWith(200);
        expect(handle.mock.calls[0][0].policyKey).toBe("pk-1");
    });

    it("dispatch() rejects a wrong-length or wrong-value policy key and accepts the exact stored one (timing-safe compare).", async () => {
        const { route, handle } = provisionedRoute();

        const shorter = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "x-ms-policykey": "pk" } } as any, shorter, { uid: "user-1" } as any);
        expect(shorter.status).toHaveBeenCalledWith(449);

        const sameLengthWrong = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "x-ms-policykey": "pk-2" } } as any, sameLengthWrong, { uid: "user-1" } as any);
        expect(sameLengthWrong.status).toHaveBeenCalledWith(449);
        expect(handle).not.toHaveBeenCalled();

        const exact = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "x-ms-policykey": "pk-1" } } as any, exact, { uid: "user-1" } as any);
        expect(exact.status).toHaveBeenCalledWith(200);
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it("dispatch() transparently reads back the winner's row when two concurrent first-pairing creates race on the unique (mailboxUid, deviceId) index.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false }) as TestEasRoute;
        const winner = { uid: "dss-1", version: 1, provisioned: false, policyKey: undefined, mailboxUid: "mbx-1", deviceId: "dev1" };
        const find = vi
            .fn()
            .mockResolvedValueOnce([]) // this request's own lookup sees no existing row yet
            .mockResolvedValueOnce([winner]); // re-read after the losing create() finds the concurrent winner
        const create = vi.fn().mockRejectedValue(new ApiError(ApiErrors.IDENTIFIER_EXISTS, 400, "already exists"));
        const handle = vi.fn().mockResolvedValue(undefined);
        (route as any).deviceSyncStateRepo = { find, create, instantiateObject: (o: any) => o, update: vi.fn() };
        (route as any).mailboxRepo = { find: vi.fn().mockResolvedValue([{ uid: "mbx-1" }]) };
        (route as any).handlers.set("Provision", { command: "Provision", handle });

        const res = makeRes();
        // Provision is exempt from the provisioning gate, so this exercises find-or-create without needing a policy key.
        await route.dispatch({ query: { Cmd: "Provision", DeviceId: "dev1" }, headers: {} } as any, res, { uid: "user-1" } as any);

        expect(find).toHaveBeenCalledTimes(2);
        expect(create).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(handle.mock.calls[0][0].deviceSyncState).toBe(winner);
    });

    it("dispatch() lets a create() failure that isn't a duplicate-key conflict propagate.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false }) as TestEasRoute;
        const find = vi.fn().mockResolvedValue([]);
        const create = vi.fn().mockRejectedValue(new Error("db unavailable"));
        (route as any).deviceSyncStateRepo = { find, create, instantiateObject: (o: any) => o, update: vi.fn() };
        (route as any).mailboxRepo = { find: vi.fn().mockResolvedValue([{ uid: "mbx-1" }]) };
        (route as any).handlers.set("Provision", { command: "Provision", handle: vi.fn() });

        await expect(
            route.dispatch({ query: { Cmd: "Provision", DeviceId: "dev1" }, headers: {} } as any, makeRes(), { uid: "user-1" } as any),
        ).rejects.toThrow("db unavailable");
        expect(find).toHaveBeenCalledTimes(1);
    });

    it("dispatch() maps a malformed WBXML body to HTTP 400, but lets any other decoding failure propagate.", async () => {
        const { route, handle } = provisionedRoute();
        const req = () => ({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "x-ms-policykey": "pk-1" }, rawBody: Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x45]) });

        await expect(route.dispatch(req() as any, makeRes(), { uid: "user-1" } as any)).rejects.toThrow(/malformed wbxml/i);

        vi.spyOn(WbxmlDecoder.prototype, "decode").mockImplementation(() => {
            throw new Error("unexpected");
        });
        await expect(route.dispatch(req() as any, makeRes(), { uid: "user-1" } as any)).rejects.toThrow("unexpected");
        expect(handle).not.toHaveBeenCalled();
    });

    it("dispatch() still answers when recording lastSyncAt fails after the command ran.", async () => {
        const { route, handle, logger } = provisionedRoute(vi.fn().mockRejectedValue(new Error("db down")));

        const res = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, headers: { "x-ms-policykey": "pk-1" } } as any, res, { uid: "user-1" } as any);

        expect(handle).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("db down"));
    });

    it("options() answers with MS-ASProtocolVersions/MS-ASProtocolCommands derived from the registered handlers.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });
        (route as any).handlers.set("FolderSync", { command: "FolderSync" });
        (route as any).handlers.set("Sync", { command: "Sync" });

        const res = makeRes();
        await route.options(res);

        expect(res.setHeader).toHaveBeenCalledWith("MS-ASProtocolVersions", "14.0,14.1,16.0,16.1");
        expect(res.setHeader).toHaveBeenCalledWith("MS-ASProtocolCommands", "FolderSync,Sync");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith();
    });
});
