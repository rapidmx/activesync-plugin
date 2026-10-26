///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { createClient, type RedisClientType } from "redis";

/** Releases an acquired lease. Never throws. */
export type LeaseRelease = () => Promise<void>;

export interface LeaseOptions {
    /** Redis to hold the lease in across server copies (`datastores:cache`); in-process only without it. */
    redisUrl?: string;
    /** How long a Redis lease lives if its holder never releases it (a crashed server copy). While held, it's renewed
     * every third of this. */
    ttlMs: number;
    /** How long to wait for a held lease before giving up. */
    waitMs: number;
    /** Delay between Redis acquisition attempts. */
    pollMs?: number;
    /** Longest a single Redis connect, `SET` or release may take before the lease fails open. The connect and the first
     * `SET` always get all of it, however long the in-process wait took; a later `SET` while polling for another
     * copy's key is also capped by `waitMs`'s deadline. */
    redisTimeoutMs?: number;
}

/** Deletes the lease key only while it still carries this holder's token, so an expired-and-retaken lease survives. */
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** Extends the lease key's expiry only while it still carries this holder's token. */
const RENEW_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

/** Default `LeaseOptions.redisTimeoutMs`. */
const DEFAULT_REDIS_TIMEOUT_MS = 2_000;

/** Reconnect attempts after which a lost Redis connection gives up (and a later lease creates a fresh client). */
const MAX_RECONNECT_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sentinel a timed-out Redis call resolves with. */
const TIMED_OUT: unique symbol = Symbol("timed out");

/** Resolves with `promise`'s value, or `TIMED_OUT` after `ms` (a rejection still rejects). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms))))]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A short exclusive lease on one key - `SyncCommand` holds one per (mailbox, device, folder) for the duration of a
 * collection's round, so two concurrent `Sync`s of the same collection (a client retrying while its first request is
 * still running, or two server copies) can't both read the same state, apply their commands and overwrite each
 * other's result.
 *
 * Always taken in-process first (a per-key promise chain), then - when a Redis URL is configured - as a `SET NX PX`
 * key shared by every server copy, released with a token check and renewed (token-checked `PEXPIRE`) every
 * `ttlMs / 3` while held, so a round that outlasts `ttlMs` doesn't lose it to another copy.
 *
 * **Redis being unreachable fails open** to the in-process lease alone rather than refusing - or hanging - every
 * `Sync`: the client is created with `disableOfflineQueue` (a command fails at once while disconnected instead of
 * waiting in a queue) and a bounded `reconnectStrategy` (so `connect()` rejects instead of retrying forever), and
 * every connect/`SET` is additionally raced against `redisTimeoutMs`. The connect and the first `SET` get the whole
 * `redisTimeoutMs` even when the in-process wait already used up `waitMs` - otherwise a healthy Redis would get no time
 * at all and the lease would fail open for nothing; only the polling `SET`s after Redis has answered are cut short by
 * the deadline, which then means another copy still holds the key (`undefined`). A `SET` that times out but lands later
 * is released again straight away. A client whose reconnects gave up is replaced on the next lease.
 *
 * **Release never hangs**: the token-checked release is raced against `redisTimeoutMs` too (the key expires on its
 * own), and the in-process lease is freed whatever happens to it.
 *
 * @author Jean-Philippe Steinmetz
 */
export class EasCollectionLease {
    /** The in-process holder of each key: resolves once that holder releases. */
    private static readonly local: Map<string, Promise<void>> = new Map();
    /** Shared command clients, keyed by Redis URL. */
    private static readonly clients: Map<string, Promise<RedisClientType>> = new Map();

    /** Forgets all process-wide state. Intended for tests. */
    public static resetSharedState(): void {
        EasCollectionLease.local.clear();
        EasCollectionLease.clients.clear();
    }

    private static getClient(url: string, connectTimeoutMs: number): Promise<RedisClientType> {
        let pending = EasCollectionLease.clients.get(url);
        if (!pending) {
            const client = createClient({
                url,
                disableOfflineQueue: true,
                socket: {
                    connectTimeout: connectTimeoutMs,
                    reconnectStrategy: (retries: number) =>
                        retries >= MAX_RECONNECT_ATTEMPTS ? new Error("Redis unreachable") : Math.min(100 * 2 ** retries, 1_000),
                },
            }) as RedisClientType;
            // An unhandled `error` event would crash the process.
            client.on("error", () => undefined);
            const connecting: Promise<RedisClientType> = client.connect().then(() => client);
            connecting.catch(() => EasCollectionLease.forgetClient(url, connecting));
            EasCollectionLease.clients.set(url, connecting);
            pending = connecting;
        }
        return pending;
    }

    private static forgetClient(url: string, pending: Promise<RedisClientType>): void {
        if (EasCollectionLease.clients.get(url) === pending) {
            EasCollectionLease.clients.delete(url);
        }
    }

    /** Waits for `key`'s in-process holder (if any) to release, up to `deadline`, then takes it over with `held` - the
     * check and the take-over happen in the same tick, so two waiters can never both find the key free. `false` on
     * timeout. */
    private static async takeLocal(key: string, held: Promise<void>, deadline: number): Promise<boolean> {
        for (;;) {
            const holder = EasCollectionLease.local.get(key);
            if (!holder) {
                EasCollectionLease.local.set(key, held);
                return true;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                return false;
            }
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([holder, new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining)))]);
            clearTimeout(timer);
        }
    }

    /**
     * Acquires the lease on `key`, waiting up to `options.waitMs` for a current holder. Resolves with the release
     * function, or `undefined` when the lease couldn't be acquired in time.
     */
    public static async acquire(key: string, options: LeaseOptions): Promise<LeaseRelease | undefined> {
        const deadline: number = Date.now() + options.waitMs;
        let resolveLocal!: () => void;
        const held = new Promise<void>((resolve) => (resolveLocal = resolve));
        if (!(await EasCollectionLease.takeLocal(key, held, deadline))) {
            return undefined;
        }
        const releaseLocal = (): void => {
            if (EasCollectionLease.local.get(key) === held) {
                EasCollectionLease.local.delete(key);
            }
            resolveLocal();
        };
        const failOpen: LeaseRelease = async () => releaseLocal();

        if (!options.redisUrl) {
            return failOpen;
        }

        const url: string = options.redisUrl;
        const redisTimeoutMs: number = options.redisTimeoutMs ?? DEFAULT_REDIS_TIMEOUT_MS;
        // A polling SET never waits past the deadline for Redis; with no time left at all, it still gets the current tick.
        const pollTimeout = (): number => Math.min(redisTimeoutMs, Math.max(0, deadline - Date.now()));
        const redisKey = `eas:lease:${key}`;
        const token: string = crypto.randomUUID();
        const releaseRedis = async (client: RedisClientType): Promise<void> => {
            try {
                await client.eval(RELEASE_SCRIPT, { keys: [redisKey], arguments: [token] });
            } catch {
                // The key expires on its own.
            }
        };

        let client: RedisClientType;
        try {
            const pending: Promise<RedisClientType> = EasCollectionLease.getClient(url, redisTimeoutMs);
            const connected = await withTimeout(pending, redisTimeoutMs);
            if (connected === TIMED_OUT) {
                return failOpen;
            }
            client = connected;
            if ((client as any).isOpen === false) {
                // Its reconnects gave up: the next lease starts a fresh client.
                EasCollectionLease.forgetClient(url, pending);
                return failOpen;
            }
            let answered = false;
            for (;;) {
                const setting = client.set(redisKey, token, { condition: "NX", expiration: { type: "PX", value: options.ttlMs } });
                // A SET after Redis has answered is cut short by the wait's deadline, not just by redisTimeoutMs.
                const limit: number = answered ? pollTimeout() : redisTimeoutMs;
                const reply = await withTimeout(setting, limit);
                if (reply === TIMED_OUT) {
                    // Give back the key should the SET still land.
                    setting.then((late) => (late === "OK" ? releaseRedis(client) : undefined)).catch(() => undefined);
                    // Decided by the limit applied, not by re-reading the clock: a timer may fire a millisecond before Date.now() reaches the deadline.
                    if (answered && limit < redisTimeoutMs) {
                        // Redis is up and another copy holds the key - only the wait ran out.
                        releaseLocal();
                        return undefined;
                    }
                    return failOpen;
                }
                answered = true;
                if (reply === "OK") {
                    break;
                }
                if (Date.now() >= deadline) {
                    releaseLocal();
                    return undefined;
                }
                await sleep(Math.min(options.pollMs ?? 100, Math.max(1, deadline - Date.now())));
            }
        } catch {
            // Redis unreachable: fail open to the in-process lease.
            return failOpen;
        }

        const renewal: NodeJS.Timeout = setInterval(
            () => {
                client.eval(RENEW_SCRIPT, { keys: [redisKey], arguments: [token, String(options.ttlMs)] }).catch(() => undefined);
            },
            Math.max(1, Math.floor(options.ttlMs / 3)),
        );
        renewal.unref?.();

        return async () => {
            clearInterval(renewal);
            try {
                // An unresponsive (but connected) Redis must not hold this collection on this server copy.
                await withTimeout(releaseRedis(client), redisTimeoutMs);
            } finally {
                releaseLocal();
            }
        };
    }
}
