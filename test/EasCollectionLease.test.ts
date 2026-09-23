///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for EasCollectionLease: the in-process lease, and the Redis `SET NX PX` lease against a small fake
// `redis` module (no real Redis is part of this repo's test setup - see PingCommand.test.ts for the same approach).
import { EasCollectionLease } from "../src/EasCollectionLease.js";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const redis = {
    keys: new Map<string, string>(),
    connectFails: false,
    connectHangs: false,
    setFails: false,
    evalFails: false,
    releaseHangs: false,
    isOpen: undefined as boolean | undefined,
    /** When set, `set` calls wait on it before answering. */
    setGate: undefined as Promise<void> | undefined,
    setCalls: 0,
    clientsCreated: 0,
    clientOptions: [] as any[],
    renewCalls: [] as string[][],
    errorHandlers: [] as Array<(err: Error) => void>,
    reset(): void {
        this.errorHandlers = [];
        this.keys.clear();
        this.connectFails = false;
        this.connectHangs = false;
        this.setFails = false;
        this.evalFails = false;
        this.releaseHangs = false;
        this.isOpen = undefined;
        this.setGate = undefined;
        this.setCalls = 0;
        this.clientsCreated = 0;
        this.clientOptions = [];
        this.renewCalls = [];
    },
};

vi.mock("redis", () => ({
    createClient: (options: any) => {
        redis.clientsCreated++;
        redis.clientOptions.push(options);
        return {
            get isOpen() {
                return redis.isOpen;
            },
            on: (_event: string, handler: (err: Error) => void) => {
                redis.errorHandlers.push(handler);
            },
            connect: async () => {
                if (redis.connectHangs) {
                    await never();
                }
                if (redis.connectFails) {
                    throw new Error("connect refused");
                }
            },
            set: async (key: string, value: string, options: any) => {
                redis.setCalls++;
                if (redis.setGate) {
                    await redis.setGate;
                }
                if (redis.setFails) {
                    throw new Error("connection lost");
                }
                expect(options).toEqual({ condition: "NX", expiration: { type: "PX", value: expect.any(Number) } });
                if (redis.keys.has(key)) {
                    return null;
                }
                redis.keys.set(key, value);
                return "OK";
            },
            eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
                if (redis.evalFails) {
                    throw new Error("connection lost");
                }
                if (redis.releaseHangs && !script.includes("pexpire")) {
                    await never();
                }
                if (script.includes("pexpire")) {
                    redis.renewCalls.push(options.arguments);
                    return redis.keys.get(options.keys[0]) === options.arguments[0] ? 1 : 0;
                }
                if (redis.keys.get(options.keys[0]) === options.arguments[0]) {
                    redis.keys.delete(options.keys[0]);
                    return 1;
                }
                return 0;
            },
        };
    },
}));

const tick = (ms: number = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("EasCollectionLease Tests", () => {
    afterEach(() => {
        EasCollectionLease.resetSharedState();
        redis.reset();
    });

    it("Serializes holders of the same key in-process, leaves other keys alone, and gives up after waitMs.", async () => {
        const events: string[] = [];
        const first = await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 1000 });
        const other = await EasCollectionLease.acquire("other", { ttlMs: 1000, waitMs: 0 });
        expect(other).toBeDefined();

        const second = EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 1000 }).then((release) => {
            events.push("second");
            return release;
        });
        const timedOut = await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 20 });
        expect(timedOut).toBeUndefined();
        expect(events).toEqual([]);

        await first!();
        const release = await second;
        expect(events).toEqual(["second"]);
        await release!();
        await other!();
        // A released key is free again straight away.
        expect(await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 0 })).toBeDefined();
    });

    it("Holds a Redis key across server copies, waiting for another copy's key and releasing only its own token.", async () => {
        const options = { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 200, pollMs: 5 };
        redis.keys.set("eas:lease:k", "another-server-copy");

        const waiting = EasCollectionLease.acquire("k", options);
        await tick(30);
        expect(redis.setCalls).toBeGreaterThan(1);
        redis.keys.delete("eas:lease:k");
        const release = await waiting;
        expect(release).toBeDefined();
        const token = redis.keys.get("eas:lease:k");
        expect(token).toBeDefined();

        await release!();
        expect(redis.keys.has("eas:lease:k")).toBe(false);

        // An expired-and-retaken key isn't deleted by the old holder; a failed release is swallowed.
        const stale = await EasCollectionLease.acquire("k", options);
        redis.keys.set("eas:lease:k", "retaken");
        await stale!();
        expect(redis.keys.get("eas:lease:k")).toBe("retaken");
        redis.keys.clear();
        const failing = await EasCollectionLease.acquire("k", options);
        redis.evalFails = true;
        await expect(failing!()).resolves.toBeUndefined();
    });

    it("Gives up when another copy's Redis key outlives waitMs, freeing the in-process lease again.", async () => {
        redis.keys.set("eas:lease:k", "another-server-copy");

        expect(await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 30, pollMs: 100 })).toBeUndefined();

        redis.keys.clear();
        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(release).toBeDefined();
        // Released, so its renewal timer can't fire into a later test.
        await release!();
    });

    it("Fails open to the in-process lease when Redis can't be reached, retrying the connection later.", async () => {
        redis.connectFails = true;
        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(release).toBeDefined();
        expect(await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 })).toBeUndefined();
        await release!();

        redis.connectFails = false;
        redis.setFails = true;
        const afterSetFailure = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(afterSetFailure).toBeDefined();
        await afterSetFailure!();

        redis.setFails = false;
        const reconnected = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(redis.keys.has("eas:lease:k")).toBe(true);
        // The shared client's error events never crash the process.
        expect(() => redis.errorHandlers.forEach((handler) => handler(new Error("socket closed")))).not.toThrow();
        expect(redis.errorHandlers.length).toBeGreaterThan(0);
        await reconnected!();
    });

    it("Creates the client without an offline queue and with a reconnect strategy that gives up.", async () => {
        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0, redisTimeoutMs: 1234 });
        await release!();

        const options = redis.clientOptions[0];
        expect(options.disableOfflineQueue).toBe(true);
        expect(options.socket.connectTimeout).toBe(1234);
        expect(typeof options.socket.reconnectStrategy(0)).toBe("number");
        expect(options.socket.reconnectStrategy(10)).toBeInstanceOf(Error);
    });

    it("Fails open instead of hanging when a connect never completes, so a Redis outage can't stall Sync.", async () => {
        redis.connectHangs = true;
        const started = Date.now();

        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 15_000, redisTimeoutMs: 30 });

        expect(release).toBeDefined();
        expect(Date.now() - started).toBeLessThan(1_000);
        await release!();
        // The in-process lease really was released.
        expect(await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 0 })).toBeDefined();
    });

    it("Fails open when a SET never answers, and gives the key back if that SET lands later.", async () => {
        let open!: () => void;
        redis.setGate = new Promise<void>((resolve) => (open = resolve));

        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 15_000, redisTimeoutMs: 20 });
        expect(release).toBeDefined();

        open();
        await tick(10);
        expect(redis.setCalls).toBe(1);
        expect(redis.keys.has("eas:lease:k")).toBe(false);
        await release!();

        // A late SET that fails instead is swallowed.
        let fail!: () => void;
        redis.setGate = new Promise<void>((resolve) => (fail = resolve));
        const again = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 15_000, redisTimeoutMs: 20 });
        expect(again).toBeDefined();
        redis.setFails = true;
        fail();
        await tick(10);
        expect(redis.keys.has("eas:lease:k")).toBe(false);
        await again!();
    });

    it("Gives up (not fails open) when Redis answers but the wait for another copy's key runs out mid-SET.", async () => {
        redis.keys.set("eas:lease:k", "another-server-copy");
        const acquiring = EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 60, pollMs: 5, redisTimeoutMs: 5_000 });
        await tick(20);
        // Every later SET hangs, so the loop's last attempt is cut short by the deadline.
        redis.setGate = never();

        expect(await acquiring).toBeUndefined();
    });

    it("Gives the first SET all of redisTimeoutMs even when the in-process wait used up waitMs, instead of failing open.", async () => {
        const first = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        const second = EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 60, redisTimeoutMs: 2_000 });
        await tick(30);
        // Redis is healthy but slow to answer: the SET only lands after the wait's deadline has passed.
        let open!: () => void;
        redis.setGate = new Promise<void>((resolve) => (open = resolve));
        await first!();
        setTimeout(open, 60);

        const release = await second;
        expect(release).toBeDefined();
        expect(redis.setCalls).toBe(2);
        // The lease really is held in Redis, not an in-process fail-open.
        expect(redis.keys.has("eas:lease:k")).toBe(true);
        await release!();
        expect(redis.keys.has("eas:lease:k")).toBe(false);
    });

    it("Releases the in-process lease without waiting on an unresponsive Redis release.", async () => {
        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0, redisTimeoutMs: 30 });
        redis.releaseHangs = true;
        const started = Date.now();

        await release!();

        expect(Date.now() - started).toBeLessThan(1_000);
        // The same key is free again on this server copy (Redis still holds it until it expires).
        expect(await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 0 })).toBeDefined();
    });

    it("Renews a held Redis lease every third of its TTL with its own token, and stops once released.", async () => {
        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 30, waitMs: 0 });
        const token = redis.keys.get("eas:lease:k")!;

        await tick(70);
        expect(redis.renewCalls.length).toBeGreaterThanOrEqual(2);
        expect(redis.renewCalls.every((args) => args[0] === token && args[1] === "30")).toBe(true);

        await release!();
        const renewals = redis.renewCalls.length;
        await tick(40);
        expect(redis.renewCalls.length).toBe(renewals);

        // A failing renewal is swallowed.
        const failing = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 30, waitMs: 0 });
        redis.evalFails = true;
        await tick(25);
        await failing!();
    });

    it("forgetClient() only clears the map entry if it still matches the pending promise being forgotten.", () => {
        const stale = Promise.resolve({} as any);
        const current = Promise.resolve({} as any);
        (EasCollectionLease as any).clients.set("url-x", current);

        (EasCollectionLease as any).forgetClient("url-x", stale);

        // A newer client already replaced the stale one for this URL - it must survive being "forgotten" by a
        // late callback that still references the older promise.
        expect((EasCollectionLease as any).clients.get("url-x")).toBe(current);
    });

    it("Releasing an in-process lease resolves without clearing a key that something else has since taken over.", async () => {
        const release = await EasCollectionLease.acquire("k-release-race", { ttlMs: 1000, waitMs: 0 });
        expect(release).toBeDefined();
        const replacement = new Promise<void>(() => undefined);
        (EasCollectionLease as any).local.set("k-release-race", replacement);

        await release!();

        // This release's own local entry was already superseded, so it must leave the replacement in place rather
        // than evicting whoever holds the key now.
        expect((EasCollectionLease as any).local.get("k-release-race")).toBe(replacement);
        (EasCollectionLease as any).local.delete("k-release-race");
    });

    it("Ignores a late SET that resolves without acquiring the key, because another copy took it first.", async () => {
        let open!: () => void;
        redis.setGate = new Promise<void>((resolve) => (open = resolve));

        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 15_000, redisTimeoutMs: 20 });
        expect(release).toBeDefined(); // failed open: the gated SET hasn't answered within redisTimeoutMs

        // Another copy claims the key before the gated SET is finally allowed to resolve.
        redis.keys.set("eas:lease:k", "another-copy");
        open();
        await tick(10);
        // The late SET saw NX fail (the key was already taken), so nothing was released - the other copy's key stands.
        expect(redis.keys.get("eas:lease:k")).toBe("another-copy");
        await release!();
    });

    it("Falls back to a 100ms poll interval between SET attempts when pollMs isn't configured.", async () => {
        redis.keys.set("eas:lease:k", "another-copy");
        const acquiring = EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 150, redisTimeoutMs: 5_000 });

        await tick(30);
        // Still within the default ~100ms poll delay, so no second SET attempt yet.
        expect(redis.setCalls).toBe(1);

        redis.keys.delete("eas:lease:k");
        const release = await acquiring;
        expect(release).toBeDefined();
        expect(redis.setCalls).toBeGreaterThanOrEqual(2);
        await release!();
    });

    it("Replaces a client whose reconnects gave up, failing open meanwhile.", async () => {
        const first = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        await first!();
        expect(redis.clientsCreated).toBe(1);

        redis.isOpen = false;
        const closed = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(closed).toBeDefined();
        expect(redis.keys.has("eas:lease:k")).toBe(false);
        await closed!();

        redis.isOpen = true;
        const fresh = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(redis.clientsCreated).toBe(2);
        expect(redis.keys.has("eas:lease:k")).toBe(true);
        await fresh!();
    });
});
