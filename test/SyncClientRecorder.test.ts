///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import {
    MAX_RECORDED_DEVICES,
    recordDevice,
    recordSyncClient,
    SYNC_CLIENT_EXPIRY_MS,
    SYNC_CLIENT_REFRESH_MS,
    typesOfClasses,
} from "../src/SyncClientRecorder.js";

const NOW = 10 * SYNC_CLIENT_EXPIRY_MS;
const device = (id: string, fields: object = {}) => ({ id, model: "iPhone", types: ["calendar", "mail"] as any[], lastSeenAt: NOW, ...fields });

describe("SyncClientRecorder", () => {
    it("names the data types of EAS collection classes, once each, ignoring others", () => {
        expect(typesOfClasses(["Email", "Calendar", "Email", "Contacts", "Tasks", "Notes", ""])).toEqual(["calendar", "contacts", "mail", "tasks"]);
        expect(typesOfClasses([])).toEqual([]);
    });

    it("records a device, newest first, refreshing it only when it changed or went stale, and forgetting long-gone devices", () => {
        expect(recordDevice(undefined, device("a"))).toEqual([device("a")]);
        const known = [device("a", { lastSeenAt: NOW - 1000 }), device("old", { lastSeenAt: NOW - SYNC_CLIENT_EXPIRY_MS })];
        expect(recordDevice(known, device("a"))).toBeUndefined();
        expect(recordDevice(known, device("a", { types: ["mail"] }))).toEqual([device("a", { types: ["mail"] })]);
        expect(recordDevice(known, device("a", { model: "iPad" }))?.[0].model).toBe("iPad");
        expect(recordDevice(known, device("a", { lastSeenAt: NOW - 1000 + SYNC_CLIENT_REFRESH_MS }))).toHaveLength(1);
        expect(recordDevice([device("b", { lastSeenAt: NOW - 5 })], device("a"))?.map((d) => d.id)).toEqual(["a", "b"]);
        const many = Array.from({ length: MAX_RECORDED_DEVICES + 5 }, (_, i) => device(`d${i}`, { lastSeenAt: NOW - i - 1 }));
        expect(recordDevice(many, device("new"))).toHaveLength(MAX_RECORDED_DEVICES);
    });

    describe("recordSyncClient()", () => {
        const repos = (mailbox: any, collections: any[] = [{ collectionClass: "Email" }, { collectionClass: "Contacts" }, {}]) => ({
            mailboxRepo: { findOne: vi.fn().mockResolvedValue(mailbox), update: vi.fn().mockResolvedValue(mailbox) } as any,
            collectionStateRepo: { find: vi.fn().mockResolvedValue(collections) } as any,
        });

        it("writes the device with the types of its collections, keeping the other clients' records", async () => {
            const r = repos({ uid: "mb", version: 2, syncClients: { mapi: { lastSeenAt: 1 } } });
            await recordSyncClient(r, "mb", "dev1", "Android", NOW);
            expect(r.collectionStateRepo.find).toHaveBeenCalledWith({ mailboxUid: "mb", deviceId: "dev1" }, { ignoreACL: true, limit: 1_000 });
            expect(r.mailboxRepo.update.mock.calls[0][0]).toEqual({
                uid: "mb",
                version: 2,
                syncClients: { mapi: { lastSeenAt: 1 }, activesync: { devices: [{ id: "dev1", model: "Android", types: ["contacts", "mail"], lastSeenAt: NOW }] } },
            });
        });

        it("reads nothing more for a device recorded recently, and records one with no types without the collection store", async () => {
            const fresh = repos({ uid: "mb", syncClients: { activesync: { devices: [device("dev1", { model: "Android", lastSeenAt: NOW - 1 })] } } });
            await recordSyncClient(fresh, "mb", "dev1", "Android", NOW);
            expect(fresh.collectionStateRepo.find).not.toHaveBeenCalled();
            expect(fresh.mailboxRepo.update).not.toHaveBeenCalled();

            const bare = repos({ uid: "mb" });
            await recordSyncClient({ mailboxRepo: bare.mailboxRepo }, "mb", "dev1", "Android", NOW);
            expect(bare.mailboxRepo.update.mock.calls[0][0].syncClients.activesync.devices[0].types).toEqual([]);
        });

        it("writes nothing when the stale record turns out unchanged, or the mailbox is gone", async () => {
            const stale = repos({ uid: "mb", syncClients: { activesync: { devices: [device("dev1", { model: "Android", types: ["contacts", "mail"], lastSeenAt: NOW - SYNC_CLIENT_REFRESH_MS })] } } });
            await recordSyncClient(stale, "mb", "dev1", "Android", NOW - SYNC_CLIENT_REFRESH_MS + 10);
            expect(stale.mailboxRepo.update).not.toHaveBeenCalled();

            const gone = repos(undefined);
            await recordSyncClient(gone, "mb", "dev1", "Android", NOW);
            expect(gone.mailboxRepo.update).not.toHaveBeenCalled();
        });
    });
});
