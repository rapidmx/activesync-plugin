///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Records the ActiveSync devices that sync a mailbox, and which data types each one syncs, on `Mailbox.syncClients` - what restapi's
 * zero-access defaults and the encryption settings' warnings go by (restapi `specs/search.md` §3 *What It Covers*): a type a phone
 * syncs is left out of zero-access by default, since the phone couldn't read it protected.
 */
import type { RepoUtils } from "@rapidrest/service-core";

/** The data types zero-access encryption can cover (restapi `ZeroAccessDataType`). */
export type SyncedDataType = "mail" | "calendar" | "contacts" | "tasks";

/** One device as recorded on `Mailbox.syncClients.activesync.devices` (restapi `SyncClientDevice`). */
export interface RecordedDevice {
    id: string;
    model?: string;
    types: SyncedDataType[];
    lastSeenAt: number;
}

/** The EAS collection `Class` of each data type. */
const CLASS_TYPES: Readonly<Record<string, SyncedDataType>> = { Email: "mail", Calendar: "calendar", Contacts: "contacts", Tasks: "tasks" };

/** How long a device's record stands before it is refreshed. */
export const SYNC_CLIENT_REFRESH_MS = 6 * 60 * 60 * 1000;

/** A device not seen for this long is dropped from the record. */
export const SYNC_CLIENT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/** At most this many devices are recorded per mailbox (the most recently seen). */
export const MAX_RECORDED_DEVICES = 20;

/** The data types of a device's collections, from their EAS classes. */
export function typesOfClasses(classes: readonly string[]): SyncedDataType[] {
    const types: Set<SyncedDataType> = new Set();
    for (const cls of classes) {
        const type: SyncedDataType | undefined = CLASS_TYPES[cls];
        if (type) {
            types.add(type);
        }
    }
    return [...types].sort();
}

/**
 * `devices` with `device` recorded (replacing its earlier record), devices unseen for `SYNC_CLIENT_EXPIRY_MS` dropped, and at most
 * `MAX_RECORDED_DEVICES` kept, the most recently seen first - or `undefined` when nothing worth writing changed: the device was
 * recorded with the same model and types within `SYNC_CLIENT_REFRESH_MS`.
 */
export function recordDevice(devices: readonly RecordedDevice[] | undefined, device: RecordedDevice): RecordedDevice[] | undefined {
    const known: RecordedDevice | undefined = (devices ?? []).find((d) => d.id === device.id);
    if (
        known &&
        known.model === device.model &&
        known.types.join() === device.types.join() &&
        device.lastSeenAt - known.lastSeenAt < SYNC_CLIENT_REFRESH_MS
    ) {
        return undefined;
    }
    return [device, ...(devices ?? []).filter((d) => d.id !== device.id && device.lastSeenAt - d.lastSeenAt < SYNC_CLIENT_EXPIRY_MS)]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, MAX_RECORDED_DEVICES);
}

/** What `recordSyncClient()` reads and writes. */
export interface SyncClientRepos {
    mailboxRepo: RepoUtils<any>;
    /** `EasCollectionState`: the collections each device syncs, with their EAS class. */
    collectionStateRepo?: RepoUtils<any>;
}

/**
 * Records that `deviceId` (`model`, the device's `DeviceType`) synced `mailboxUid` now, with the data types of the collections it
 * syncs. Writes only when the record changed or went stale (`recordDevice()`), so a device polling all day costs one read per request
 * and one write every few hours.
 */
export async function recordSyncClient(repos: SyncClientRepos, mailboxUid: string, deviceId: string, model: string, now: number = Date.now()): Promise<void> {
    const mailbox: any = await repos.mailboxRepo.findOne(mailboxUid, { ignoreACL: true });
    if (!mailbox) {
        return;
    }
    const devices: RecordedDevice[] | undefined = mailbox.syncClients?.activesync?.devices;
    const known: RecordedDevice | undefined = devices?.find((d) => d.id === deviceId);
    if (known && now - known.lastSeenAt < SYNC_CLIENT_REFRESH_MS && known.model === model) {
        return;
    }
    const collections: { collectionClass?: string }[] = repos.collectionStateRepo
        ? await repos.collectionStateRepo.find({ mailboxUid, deviceId } as any, { ignoreACL: true, limit: 1_000 })
        : [];
    const recorded = recordDevice(devices, {
        id: deviceId,
        model,
        types: typesOfClasses(collections.map((c) => c.collectionClass ?? "")),
        lastSeenAt: now,
    });
    if (recorded) {
        await repos.mailboxRepo.update(
            { uid: mailbox.uid, version: mailbox.version, syncClients: { ...(mailbox.syncClients ?? {}), activesync: { devices: recorded } } } as any,
            mailbox,
            { ignoreACL: true },
        );
    }
}
