///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `PingCommand`'s real logic (parsing the request, clamping the heartbeat, building the response) is tested
// directly against the handler here rather than through a full HTTP+DB server harness, since it has no
// database dependency of its own - only `@Config`-injected Redis settings. Its Redis-dependent wait/publish
// path is exercised against a small hand-rolled fake `redis` module via `vi.mock`, mirroring service-core's
// own documented precedent for the exact same infrastructure gap (`service-core/test/helpers/FakeRedis.ts`,
// used because no real Redis server is part of this repo's test setup either - only that helper lives in
// service-core's own test/ directory, not published for reuse, hence this smaller, purpose-built copy).
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { PingCommand } from "../../src/commands/PingCommand.js";
import { element, textElement, findChild, childText } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import { fakeMailAclUtils, TRUSTED_STRANGER_USER } from "../mailAccessTestUtils.js";

type PubSubListener = (message: string, channel: string) => void;

class FakeRedisServer {
    private subscribers: Map<string, Set<PubSubListener>> = new Map();

    public publish(channel: string, message: string): void {
        const subs = this.subscribers.get(channel);
        if (!subs) {
            return;
        }
        // Deferred (not called inline) so delivery never happens in the same tick as the publish, like real Redis.
        const listeners = [...subs];
        queueMicrotask(() => {
            for (const listener of listeners) {
                listener(message, channel);
            }
        });
    }

    public subscribe(channel: string, listener: PubSubListener): void {
        if (!this.subscribers.has(channel)) {
            this.subscribers.set(channel, new Set());
        }
        this.subscribers.get(channel)!.add(listener);
    }

    public unsubscribe(channel: string, listener: PubSubListener): void {
        this.subscribers.get(channel)?.delete(listener);
    }

    public listenerCount(channel: string): number {
        return this.subscribers.get(channel)?.size ?? 0;
    }

    public reset(): void {
        this.subscribers.clear();
    }
}

/** Per-test knobs and counters for the fake client, all reset in `afterEach`. */
const fake = {
    createClientCount: 0,
    connectCount: 0,
    nextConnectShouldFail: false,
    nextDestroyShouldFail: false,
    nextSubscribeShouldFail: false,
    nextUnsubscribeShouldFail: false,
    /** When set, `connect()` waits on this before completing. */
    connectGate: undefined as Promise<void> | undefined,
    /** When set, `subscribe()` waits on this before completing. */
    subscribeGate: undefined as Promise<void> | undefined,
    lastClient: undefined as FakeRedisClient | undefined,
    reset(): void {
        this.createClientCount = 0;
        this.connectCount = 0;
        this.nextConnectShouldFail = false;
        this.nextDestroyShouldFail = false;
        this.nextSubscribeShouldFail = false;
        this.nextUnsubscribeShouldFail = false;
        this.connectGate = undefined;
        this.subscribeGate = undefined;
        this.lastClient = undefined;
    },
};

class FakeRedisClient {
    public readonly handlers: Map<string, Array<(...args: any[]) => void>> = new Map();
    public destroyed = false;

    constructor(private readonly server: FakeRedisServer) {}

    public on(event: string, handler: (...args: any[]) => void): this {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
        return this;
    }

    public emit(event: string, ...args: any[]): void {
        for (const handler of this.handlers.get(event) ?? []) {
            handler(...args);
        }
    }

    public async connect(): Promise<this> {
        fake.connectCount++;
        // Consumed at call time, so a gated failing connect doesn't also fail a later, ungated one.
        const shouldFail = fake.nextConnectShouldFail;
        fake.nextConnectShouldFail = false;
        if (fake.connectGate) {
            await fake.connectGate;
        }
        if (shouldFail) {
            throw new Error("simulated Redis connect failure");
        }
        return this;
    }

    public destroy(): void {
        this.destroyed = true;
        if (fake.nextDestroyShouldFail) {
            fake.nextDestroyShouldFail = false;
            throw new Error("simulated Redis destroy failure");
        }
    }

    public async subscribe(channels: string[], listener: PubSubListener): Promise<void> {
        if (fake.subscribeGate) {
            await fake.subscribeGate;
        }
        if (fake.nextSubscribeShouldFail) {
            fake.nextSubscribeShouldFail = false;
            throw new Error("simulated Redis connection failure");
        }
        for (const channel of channels) {
            this.server.subscribe(channel, listener);
        }
    }

    public async unsubscribe(channels: string[], listener: PubSubListener): Promise<void> {
        if (fake.nextUnsubscribeShouldFail) {
            fake.nextUnsubscribeShouldFail = false;
            throw new Error("simulated Redis unsubscribe failure");
        }
        for (const channel of channels) {
            this.server.unsubscribe(channel, listener);
        }
    }
}

const fakeRedisServer = new FakeRedisServer();

vi.mock("redis", () => ({
    createClient: () => {
        fake.createClientCount++;
        fake.lastClient = new FakeRedisClient(fakeRedisServer);
        return fake.lastClient;
    },
}));

const REDIS_CONFIG = {
    "datastores:events": { url: "redis://fake" },
    "mail:eas:ping_min_heartbeat_seconds": 1,
    "mail:eas:ping_max_heartbeat_seconds": 5,
};

/** Builds a minimal nconf-compatible config double exposing only the paths `PingCommand` reads. */
function makeConfig(values: Record<string, any>): any {
    return { get: (path: string) => values[path] };
}

/**
 * Builds a `PingCommand` via a real `ObjectFactory` (so its `@Config` fields resolve normally), then stubs its
 * `@Inject(ACLUtils)` field directly - this file's config double has no real datastore for `ObjectFactory` to
 * construct a working `ACLUtils` against. `deniedFolderUids` lets a test assert on permission filtering.
 */
async function createCommand(values: Record<string, any>, deniedFolderUids: string[] = []): Promise<PingCommand> {
    const command = await new ObjectFactory(makeConfig(values), Logger()).newInstance<PingCommand>(PingCommand);
    const denied = new Set(deniedFolderUids);
    (command as any).aclUtils = { hasPermission: async (_user: unknown, uid: string) => !denied.has(uid) };
    return command;
}

function pingRequest(heartbeatSeconds: number | undefined, folderUids: string[]): any {
    return element(WbxmlCodePage.Ping, "Ping", [
        ...(heartbeatSeconds !== undefined ? [textElement(WbxmlCodePage.Ping, "HeartbeatInterval", String(heartbeatSeconds))] : []),
        element(
            WbxmlCodePage.Ping,
            "Folders",
            folderUids.map((uid) =>
                element(WbxmlCodePage.Ping, "Folder", [textElement(WbxmlCodePage.Ping, "ServerId", uid)]),
            ),
        ),
    ]);
}

/** A fake `HttpResponse` exposing only `onFinish()`, plus a `finish()` to fire the registered handlers. */
function makeRes(): { onFinish: (handler: () => void) => void; finish: () => void } {
    const handlers: Array<() => void> = [];
    return {
        onFinish: (handler) => handlers.push(handler),
        finish: () => handlers.forEach((handler) => handler()),
    };
}

function makeContext(request: any, overrides: Partial<Record<"deviceId" | "mailboxUid" | "res" | "user", any>> = {}): EasCommandContext {
    return {
        user: { uid: "user-1", roles: [], scopes: [] },
        mailboxUid: "mbx-1",
        deviceId: "dev-1",
        deviceType: "TestPhone",
        deviceSyncState: {} as any,
        deviceSyncStateRepo: {} as any,
        query: {},
        request,
        req: {} as any,
        ...overrides,
    };
}

function tick(ms: number = 10): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

describe("PingCommand Tests", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        PingCommand.resetSharedState();
        fakeRedisServer.reset();
        fake.reset();
    });

    it("Returns Status 3 (missing parameters) when the request body is absent.", async () => {
        const command = await createCommand({});
        const response = await command.handle(makeContext(undefined));
        expect(childText(response!, "Status")).toBe("3");
    });

    it("Returns Status 3 (missing parameters) when no folders are specified.", async () => {
        const command = await createCommand({});
        const response = await command.handle(makeContext(element(WbxmlCodePage.Ping, "Ping", [])));
        expect(childText(response!, "Status")).toBe("3");
    });

    it("Returns Status 3 (missing parameters) when the caller has no permission on any requested folder.", async () => {
        const command = await createCommand({}, ["folder-1"]);
        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("3");
    });

    it("Returns Status 6 with MaxFolders when more folders than the configured cap are requested, before any ACL check.", async () => {
        const command = await createCommand({ ...REDIS_CONFIG, "mail:eas:ping_max_folders": 2 });
        const hasPermission = vi.fn(async () => true);
        (command as any).aclUtils = { hasPermission };

        const response = await command.handle(makeContext(pingRequest(1, ["folder-1", "folder-2", "folder-3"])));
        expect(childText(response!, "Status")).toBe("6");
        expect(childText(response!, "MaxFolders")).toBe("2");
        expect(hasPermission).not.toHaveBeenCalled();
        expect(fake.createClientCount).toBe(0);
    });

    it("Accepts exactly the configured folder cap.", async () => {
        const command = await createCommand({ ...REDIS_CONFIG, "mail:eas:ping_max_folders": 2 });
        const res = makeRes();
        const responsePromise = command.handle(makeContext(pingRequest(1, ["folder-1", "folder-2"]), { res }));
        await tick();
        res.finish();
        expect(childText((await responsePromise)!, "Status")).toBe("1");
    });

    it("Filters out a folder the caller has no permission on, still watching the rest.", async () => {
        const command = await createCommand(REDIS_CONFIG, ["folder-1"]);

        const responsePromise = command.handle(makeContext(pingRequest(1, ["folder-1", "folder-2"])));
        await tick();
        // Only "folder-2" was subscribed to - a publish on the denied folder must never be observable.
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);
        fakeRedisServer.publish("folder-1", JSON.stringify({ type: "Folder", action: "update" }));
        fakeRedisServer.publish("folder-2", JSON.stringify({ type: "Folder", action: "update" }));

        const response = await responsePromise;
        expect(childText(response!, "Status")).toBe("2");
        const folders = findChild(response!, "Folders")!;
        expect(folders.children.map((f) => f.text)).toEqual(["folder-2"]);
    });

    it("Evaluates ACL checks in bounded chunks and still filters correctly across more folders than one chunk.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        const folderUids = Array.from({ length: 60 }, (_v, i) => `folder-${i}`);
        const denied = new Set(folderUids.filter((_uid, i) => i % 7 === 0));
        let inFlight = 0;
        let maxInFlight = 0;
        let calls = 0;
        (command as any).aclUtils = {
            hasPermission: async (_user: unknown, uid: string) => {
                calls++;
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await tick(1);
                inFlight--;
                return !denied.has(uid);
            },
        };

        const res = makeRes();
        const responsePromise = command.handle(makeContext(pingRequest(1, folderUids), { res }));
        await tick(100);
        expect(calls).toBe(60);
        expect(maxInFlight).toBeLessThanOrEqual(25);
        expect(maxInFlight).toBeGreaterThan(1);
        for (const uid of folderUids) {
            expect(fakeRedisServer.listenerCount(uid)).toBe(denied.has(uid) ? 0 : 1);
        }

        fakeRedisServer.publish("folder-0", "{}"); // denied
        fakeRedisServer.publish("folder-59", "{}"); // permitted, in the last chunk
        const response = await responsePromise;
        expect(childText(response!, "Status")).toBe("2");
        expect(findChild(response!, "Folders")!.children.map((f) => f.text)).toEqual(["folder-59"]);
    });

    it("Trusted-role bypass regression: an admin-role stranger with only READ (a real delegate grant) on one folder only watches that folder, not both via the role.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        (command as any).aclUtils = fakeMailAclUtils({ "folder-granted": { [TRUSTED_STRANGER_USER.uid]: ["read"] } });

        const res = makeRes();
        const responsePromise = command.handle(makeContext(pingRequest(1, ["folder-granted", "folder-denied"]), { res, user: TRUSTED_STRANGER_USER }));
        await tick(20);

        expect(fakeRedisServer.listenerCount("folder-granted")).toBe(1);
        expect(fakeRedisServer.listenerCount("folder-denied")).toBe(0);

        res.finish();
        await responsePromise;
    });

    it("Waits the full heartbeat before answering Status 1 when no datastores:events config is present.", async () => {
        const command = await createCommand({ "mail:eas:ping_min_heartbeat_seconds": 1, "mail:eas:ping_max_heartbeat_seconds": 1 });
        const start = Date.now();
        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        // Returning immediately would let a device hot-loop Ping requests against the server.
        expect(Date.now() - start).toBeGreaterThanOrEqual(900);
        expect(fake.createClientCount).toBe(0);
    });

    it("Ends the no-Redis heartbeat wait early when the request closes.", async () => {
        const command = await createCommand({});
        const res = makeRes();
        const start = Date.now();
        const responsePromise = command.handle(makeContext(pingRequest(60, ["folder-1"]), { res }));
        await tick();
        res.finish();
        expect(childText((await responsePromise)!, "Status")).toBe("1");
        expect(Date.now() - start).toBeLessThan(500);
    });

    it("Defaults to minHeartbeatSeconds when HeartbeatInterval is omitted from the request entirely.", async () => {
        const command = await createCommand({ "mail:eas:ping_min_heartbeat_seconds": 1, "mail:eas:ping_max_heartbeat_seconds": 5 });

        const start = Date.now();
        const response = await command.handle(makeContext(pingRequest(undefined, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        expect(Date.now() - start).toBeGreaterThanOrEqual(900);
        expect(Date.now() - start).toBeLessThan(3000);
    });

    it("Falls back to minHeartbeatSeconds when HeartbeatInterval is present but not a valid number.", async () => {
        const command = await createCommand({ "mail:eas:ping_min_heartbeat_seconds": 1, "mail:eas:ping_max_heartbeat_seconds": 5 });
        const request = element(WbxmlCodePage.Ping, "Ping", [
            textElement(WbxmlCodePage.Ping, "HeartbeatInterval", "not-a-number"),
            element(WbxmlCodePage.Ping, "Folders", [
                element(WbxmlCodePage.Ping, "Folder", [textElement(WbxmlCodePage.Ping, "ServerId", "folder-1")]),
            ]),
        ]);

        const start = Date.now();
        const response = await command.handle(makeContext(request));
        expect(childText(response!, "Status")).toBe("1");
        expect(Date.now() - start).toBeGreaterThanOrEqual(900);
        expect(Date.now() - start).toBeLessThan(3000);
    });

    it("Returns Status 2 with the changed folder when a publish arrives before the timeout.", async () => {
        const command = await createCommand(REDIS_CONFIG);

        const responsePromise = command.handle(makeContext(pingRequest(1, ["folder-1", "folder-2"])));
        await tick();
        fakeRedisServer.publish("folder-2", JSON.stringify({ type: "Folder", action: "update" }));

        const response = await responsePromise;
        expect(childText(response!, "Status")).toBe("2");
        const folders = findChild(response!, "Folders")!;
        expect(folders.children.map((f) => f.text)).toEqual(["folder-2"]);
        await tick();
        // This Ping's own listener was removed once it settled.
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);
        expect(fakeRedisServer.listenerCount("folder-2")).toBe(0);
    });

    it("Returns Status 1 (no changes) when the heartbeat elapses with no publish.", async () => {
        const command = await createCommand(REDIS_CONFIG);

        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        await tick();
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);
    });

    it("Shares one Redis subscriber client across multiple concurrent and sequential Pings.", async () => {
        const command = await createCommand(REDIS_CONFIG);

        const first = command.handle(makeContext(pingRequest(1, ["folder-1"]), { deviceId: "dev-1" }));
        const second = command.handle(makeContext(pingRequest(1, ["folder-1"]), { deviceId: "dev-2" }));
        await tick();
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(2);
        fakeRedisServer.publish("folder-1", "{}");
        expect(childText((await first)!, "Status")).toBe("2");
        expect(childText((await second)!, "Status")).toBe("2");

        const third = command.handle(makeContext(pingRequest(1, ["folder-3"])));
        await tick();
        fakeRedisServer.publish("folder-3", "{}");
        expect(childText((await third)!, "Status")).toBe("2");

        // A second command instance in the same process reuses the same client too.
        const otherCommand = await createCommand(REDIS_CONFIG);
        const fourth = otherCommand.handle(makeContext(pingRequest(1, ["folder-4"])));
        await tick();
        fakeRedisServer.publish("folder-4", "{}");
        expect(childText((await fourth)!, "Status")).toBe("2");

        expect(fake.createClientCount).toBe(1);
        expect(fake.connectCount).toBe(1);
    });

    it("Supersedes an older Ping for the same mailbox and device, leaving other devices unaffected.", async () => {
        const command = await createCommand(REDIS_CONFIG);

        const older = command.handle(makeContext(pingRequest(5, ["folder-1"]), { deviceId: "dev-1" }));
        const otherDevice = command.handle(makeContext(pingRequest(5, ["folder-1"]), { deviceId: "dev-2" }));
        const otherMailbox = command.handle(makeContext(pingRequest(5, ["folder-1"]), { mailboxUid: "mbx-2", deviceId: "dev-1" }));
        await tick();
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(3);

        const start = Date.now();
        const newer = command.handle(makeContext(pingRequest(5, ["folder-1"]), { deviceId: "dev-1" }));
        expect(childText((await older)!, "Status")).toBe("1");
        expect(Date.now() - start).toBeLessThan(500);
        await tick();
        // older's listener removed, newer's added.
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(3);

        fakeRedisServer.publish("folder-1", "{}");
        expect(childText((await newer)!, "Status")).toBe("2");
        expect(childText((await otherDevice)!, "Status")).toBe("2");
        expect(childText((await otherMailbox)!, "Status")).toBe("2");
    });

    it("Stops waiting and answers Status 1 when the request closes, and a later close is harmless.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        const res = makeRes();

        const start = Date.now();
        const responsePromise = command.handle(makeContext(pingRequest(5, ["folder-1"]), { res }));
        await tick();
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(1);
        res.finish();
        expect(childText((await responsePromise)!, "Status")).toBe("1");
        expect(Date.now() - start).toBeLessThan(500);
        await tick();
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);

        // Firing onFinish again (e.g. normal end after an abort) must not throw or affect a newer Ping.
        const newer = command.handle(makeContext(pingRequest(1, ["folder-1"])));
        await tick();
        res.finish();
        fakeRedisServer.publish("folder-1", "{}");
        expect(childText((await newer)!, "Status")).toBe("2");
    });

    it("Releases the subscription when the request closes while the shared client is still connecting.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        const gate = deferred();
        fake.connectGate = gate.promise;
        const res = makeRes();

        const responsePromise = command.handle(makeContext(pingRequest(5, ["folder-1"]), { res }));
        await tick();
        res.finish();
        expect(childText((await responsePromise)!, "Status")).toBe("1");

        gate.resolve();
        await tick();
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);
    });

    it("Releases the subscription when the request closes while subscribe() is still in flight.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        const gate = deferred();
        fake.subscribeGate = gate.promise;
        const res = makeRes();

        const responsePromise = command.handle(makeContext(pingRequest(5, ["folder-1"]), { res }));
        await tick();
        res.finish();
        expect(childText((await responsePromise)!, "Status")).toBe("1");

        gate.resolve();
        await tick();
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);
    });

    it("Fails open on a connect failure and retries connecting on a later Ping.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        fake.nextConnectShouldFail = true;
        const res = makeRes();

        const failed = command.handle(makeContext(pingRequest(5, ["folder-1"]), { res }));
        await tick();
        expect(fake.lastClient!.destroyed).toBe(true);
        expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);
        // Still waiting (no hot-loop), until the request closes.
        res.finish();
        expect(childText((await failed)!, "Status")).toBe("1");

        const retried = command.handle(makeContext(pingRequest(1, ["folder-1"])));
        await tick();
        fakeRedisServer.publish("folder-1", "{}");
        expect(childText((await retried)!, "Status")).toBe("2");
        expect(fake.createClientCount).toBe(2);
        expect(fake.connectCount).toBe(2);
    });

    it("Fails open when destroying a client whose connect failed also throws.", async () => {
        const command = await createCommand({ ...REDIS_CONFIG, "mail:eas:ping_max_heartbeat_seconds": 1 });
        fake.nextConnectShouldFail = true;
        fake.nextDestroyShouldFail = true;

        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        expect(fake.lastClient!.destroyed).toBe(true);
    });

    it("Does not evict a newer shared client when an older failed connect settles late.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        const gate = deferred();
        fake.connectGate = gate.promise;
        fake.nextConnectShouldFail = true;
        const res1 = makeRes();
        const first = command.handle(makeContext(pingRequest(5, ["folder-1"]), { res: res1 }));
        await tick();

        // Simulate the cache having been replaced before the failure lands (e.g. a reset between tests).
        PingCommand.resetSharedState();
        fake.connectGate = undefined;
        const res2 = makeRes();
        const second = command.handle(makeContext(pingRequest(5, ["folder-2"]), { deviceId: "dev-2", res: res2 }));
        await tick();
        expect(fake.createClientCount).toBe(2);

        gate.resolve();
        await tick();
        res1.finish();
        expect(childText((await first)!, "Status")).toBe("1");

        const third = command.handle(makeContext(pingRequest(5, ["folder-3"]), { deviceId: "dev-3" }));
        await tick();
        // The second client stayed cached.
        expect(fake.createClientCount).toBe(2);
        fakeRedisServer.publish("folder-3", "{}");
        expect(childText((await third)!, "Status")).toBe("2");
        res2.finish();
        expect(childText((await second)!, "Status")).toBe("1");
    });

    it("Fails open to Status 1 when the Redis client's subscribe() call itself rejects.", async () => {
        const command = await createCommand(REDIS_CONFIG);

        fake.nextSubscribeShouldFail = true;
        const start = Date.now();
        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        // Still waits the heartbeat rather than answering immediately.
        expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    });

    it("Still returns a successful response when the post-wait unsubscribe itself fails.", async () => {
        const command = await createCommand(REDIS_CONFIG);

        fake.nextUnsubscribeShouldFail = true;
        const responsePromise = command.handle(makeContext(pingRequest(1, ["folder-1"])));
        await tick();
        fakeRedisServer.publish("folder-1", "{}");
        expect(childText((await responsePromise)!, "Status")).toBe("2");
        await tick();
        expect(fake.nextUnsubscribeShouldFail).toBe(false);
    });

    it("Swallows error events emitted by the shared Redis client.", async () => {
        const command = await createCommand(REDIS_CONFIG);
        const res = makeRes();
        const responsePromise = command.handle(makeContext(pingRequest(5, ["folder-1"]), { res }));
        await tick();
        expect(() => fake.lastClient!.emit("error", new Error("socket closed"))).not.toThrow();
        res.finish();
        expect(childText((await responsePromise)!, "Status")).toBe("1");
    });

    describe("changes made before the Ping subscribed", () => {
        const CURSOR = new Date("2026-03-01T00:00:00.000Z");
        const after = new Date("2026-03-01T00:00:01.000Z");

        /** Evaluates the query shapes the pending-change check sends (`in`/`gte`/`gt`/`range` operands, `$or`,
         * `deleted`, `sort`, `limit`) over `rows`. */
        function matches(row: any, query: Record<string, any>): boolean {
            return Object.entries(query).every(([key, value]) => {
                if (key === "sort" || key === "limit") return true;
                if (key === "$or") return (value as any[]).some((sub) => matches(row, sub));
                if (key === "deleted") return (row.deleted === true) === value;
                const field = row[key] instanceof Date ? row[key].toISOString() : row[key];
                const op = /^(gt|gte|range|in)\((.*)\)$/.exec(String(value));
                if (!op) return field === value;
                if (op[1] === "in") return op[2].split(",").includes(field);
                if (op[1] === "gt") return field > op[2];
                if (op[1] === "gte") return field >= op[2];
                const [lo, hi] = op[2].split(",");
                return field >= lo && field <= hi;
            });
        }

        function fakeStore(rows: any[], fail?: (query: any) => boolean): any {
            return {
                find: vi.fn().mockImplementation(async (query: any) => {
                    if (fail?.(query)) throw new Error("db down");
                    const effective = "deleted" in query || !("dateModified" in query || "$or" in query) ? query : { ...query, deleted: false };
                    return rows
                        .filter((row) => matches(row, effective))
                        .sort((a, b) => (a.dateModified?.getTime?.() ?? 0) - (b.dateModified?.getTime?.() ?? 0) || (a.uid < b.uid ? -1 : 1))
                        .slice(0, query.limit);
                }),
            };
        }

        /** Gives `command` a fake collection state store and item repos, as PingCommandMongo/SQL would. */
        function withPendingCheck(command: PingCommand, states: Record<string, any>, items: any[], repos: Record<string, any> = {}): { itemRepo: any; stateRepo: any } {
            const itemRepo = fakeStore(items);
            const stateRepo = fakeStore(Object.entries(states).map(([folderUid, state]) => ({ mailboxUid: "mbx-1", deviceId: "dev-1", folderUid, ...state })));
            (command as any).collectionStateRepo = stateRepo;
            (command as any).repos = new Map([["Email", itemRepo], ...Object.entries(repos)]);
            return { itemRepo, stateRepo };
        }
        const state = (overrides: Record<string, any> = {}) => ({ collectionClass: "Email", cursorDate: CURSOR, cursorUid: "", echoes: {}, ...overrides });
        const item = (uid: string, folderUid: string, overrides: Record<string, any> = {}) => ({ uid, folderUid, dateModified: after, ...overrides });

        it("Answers Status 2 at once for a folder with a row after its recorded cursor, without Redis.", async () => {
            const command = await createCommand({});
            withPendingCheck(
                command,
                {
                    "folder-1": state({ cursorUid: "at-cursor" }),
                    "folder-2": state(),
                    "unsynced-class": state({ collectionClass: "Notes" }),
                    broken: state({ collectionClass: "Broken" }),
                    // Another device's state for the same folder is never used.
                    "folder-3": state({ deviceId: "other-device" }),
                },
                [item("m1", "folder-2"), item("at-cursor", "folder-1", { dateModified: CURSOR }), item("m3", "folder-3")],
                { Broken: { find: vi.fn().mockRejectedValue(new Error("db down")) } },
            );
            const start = Date.now();

            const response = await command.handle(makeContext(pingRequest(60, ["folder-1", "folder-2", "never-synced", "unsynced-class", "broken", "folder-3"])));

            expect(childText(response!, "Status")).toBe("2");
            expect(findChild(response!, "Folders")!.children.map((f) => f.text)).toEqual(["folder-2"]);
            expect(Date.now() - start).toBeLessThan(1000);
        });

        it("Ignores the device's own writes, but counts a full page as a change.", async () => {
            const command = await createCommand({});
            const echoes = { m1: after.toISOString() };
            withPendingCheck(command, { "folder-1": state({ echoes }), "folder-2": state({ echoes }) }, [
                item("m1", "folder-1"),
                ...Array.from({ length: 6 }, (_, i) => item("m1", "folder-2", { dateModified: new Date(after.getTime() + i) })),
            ]);
            const res = makeRes();

            const response = await command.handle(makeContext(pingRequest(60, ["folder-1", "folder-2"]), { res }));

            expect(findChild(response!, "Folders")!.children.map((f) => f.text)).toEqual(["folder-2"]);
        });

        it("Keeps waiting when nothing is pending, until the request closes.", async () => {
            const command = await createCommand({});
            withPendingCheck(command, { "folder-1": state({ echoes: { m1: after.toISOString() } }) }, [item("m1", "folder-1")]);
            const res = makeRes();

            const pending = command.handle(makeContext(pingRequest(60, ["folder-1"]), { res }));
            await tick(50);
            res.finish();

            expect(childText((await pending)!, "Status")).toBe("1");
        });

        it("Treats a failed state lookup as nothing pending.", async () => {
            const command = await createCommand({});
            withPendingCheck(command, { "folder-1": state() }, [item("m1", "folder-1")]);
            (command as any).collectionStateRepo = fakeStore([], () => true);
            const res = makeRes();

            const pending = command.handle(makeContext(pingRequest(60, ["folder-1"]), { res }));
            await tick(50);
            res.finish();

            expect(childText((await pending)!, "Status")).toBe("1");
        });

        it("Checks hundreds of folders with one state query and one pair of change queries per collection class.", async () => {
            const command = await createCommand({ "mail:eas:ping_max_folders": 300 });
            const folderUids = Array.from({ length: 300 }, (_, i) => `f-${i}`);
            const states = Object.fromEntries(folderUids.map((uid, i) => [uid, state({ cursorDate: new Date(CURSOR.getTime() + i) })]));
            const { itemRepo, stateRepo } = withPendingCheck(command, states, [
                // Before f-250's own cursor, but after the earliest one: not a change for f-250.
                item("old", "f-250", { dateModified: new Date(CURSOR.getTime() + 100) }),
                item("new", "f-299", { dateModified: new Date(CURSOR.getTime() + 5000) }),
            ]);

            const response = await command.handle(makeContext(pingRequest(60, folderUids)));

            expect(findChild(response!, "Folders")!.children.map((f) => f.text)).toEqual(["f-299"]);
            expect(stateRepo.find).toHaveBeenCalledTimes(1);
            expect(itemRepo.find).toHaveBeenCalledTimes(2);
        });

        it("Falls back to a per-folder scan for folders a full batch page can't decide, and for folder uids that can't be listed.", async () => {
            const command = await createCommand({});
            const busy = Array.from({ length: 501 }, (_, i) => item(`busy-${String(i).padStart(3, "0")}`, "busy", { dateModified: new Date(CURSOR.getTime() + 1000 + i) }));
            const { itemRepo } = withPendingCheck(
                command,
                { busy: state(), quiet: state(), late: state(), "odd,uid": state() },
                [...busy, item("late-row", "late", { dateModified: new Date(CURSOR.getTime() + 999_999) }), item("odd-row", "odd,uid")],
            );

            const response = await command.handle(makeContext(pingRequest(60, ["busy", "quiet", "late", "odd,uid"])));

            expect(findChild(response!, "Folders")!.children.map((f) => f.text)).toEqual(["busy", "late", "odd,uid"]);
            // The batch pair, then scanAfter's pair for each undecided folder (quiet, late) and for "odd,uid".
            expect(itemRepo.find).toHaveBeenCalledTimes(8);
            expect(itemRepo.find.mock.calls.some(([query]: any[]) => String(query.folderUid).startsWith("in(") && String(query.folderUid).includes("odd"))).toBe(false);
        });

        it("Runs the per-folder fallback scans 25 at a time rather than one after another.", async () => {
            const command = await createCommand({});
            // Uids that can't be listed in in(...) are always scanned on their own.
            const folderUids = Array.from({ length: 60 }, (_, i) => `odd,${i}`);
            const { itemRepo } = withPendingCheck(
                command,
                Object.fromEntries(folderUids.map((uid) => [uid, state()])),
                folderUids.filter((_uid, i) => i % 20 === 0).map((uid) => item(`row-${uid}`, uid)),
            );
            const find = itemRepo.find.getMockImplementation();
            let inFlight = 0;
            let maxInFlight = 0;
            itemRepo.find.mockImplementation(async (query: any) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await tick(5);
                inFlight--;
                return await find(query);
            });

            const response = await command.handle(makeContext(pingRequest(60, folderUids)));

            expect(findChild(response!, "Folders")!.children.map((f) => f.text)).toEqual(["odd,0", "odd,20", "odd,40"]);
            // Each scan is a live + deleted pair: 25 scans at once is 50 queries, never more.
            expect(maxInFlight).toBe(50);
            expect(itemRepo.find).toHaveBeenCalledTimes(120);
        });

        it("Checks once subscribed to Redis, releasing the subscription, and also when the Redis connect fails.", async () => {
            const command = await createCommand(REDIS_CONFIG);
            withPendingCheck(command, { "folder-1": state() }, [item("m1", "folder-1")]);

            const response = await command.handle(makeContext(pingRequest(5, ["folder-1"])));
            expect(childText(response!, "Status")).toBe("2");
            await tick();
            expect(fakeRedisServer.listenerCount("folder-1")).toBe(0);

            fake.nextConnectShouldFail = true;
            PingCommand.resetSharedState();
            const failedConnect = await command.handle(makeContext(pingRequest(5, ["folder-1"])));
            expect(childText(failedConnect!, "Status")).toBe("2");
        });

        it("Changes nothing when a publish already answered the Ping before the check completes.", async () => {
            const command = await createCommand(REDIS_CONFIG);
            const gate = deferred();
            const { itemRepo } = withPendingCheck(command, { "folder-1": state() }, []);
            itemRepo.find.mockImplementation(async (query: any) => {
                await gate.promise;
                return query.deleted ? [] : [item("m1", "folder-1")];
            });

            const pending = command.handle(makeContext(pingRequest(5, ["folder-1", "folder-2"])));
            await tick();
            fakeRedisServer.publish("folder-2", "{}");
            const response = await pending;
            gate.resolve();
            await tick();

            expect(findChild(response!, "Folders")!.children.map((f) => f.text)).toEqual(["folder-2"]);
        });
    });

    it("Clamps a HeartbeatInterval outside the configured min/max range.", async () => {
        const command = await createCommand({
            "datastores:events": { url: "redis://fake" },
            "mail:eas:ping_min_heartbeat_seconds": 1,
            "mail:eas:ping_max_heartbeat_seconds": 2,
        });

        const start = Date.now();
        // Requests a 100-second heartbeat, clamped down to the configured 2-second max.
        const response = await command.handle(makeContext(pingRequest(100, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
        expect(Date.now() - start).toBeLessThan(4000);
    });
});
