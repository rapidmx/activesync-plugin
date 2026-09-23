///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "@rapidmx/restapi";
import type { EasCollectionChunk } from "./models/EasCollectionChunk.js";
import type { EasCollectionState } from "./models/EasCollectionState.js";

/** Largest held set kept inline on the `EasCollectionState` row (`serverIds`) - past it the set moves to chunk rows. */
export const INLINE_HELD_LIMIT = 2000;

/** Most `ServerId`s one `EasCollectionChunk` row holds. */
export const HELD_CHUNK_SIZE = 2000;

/** Chunk rows read per query while loading a held set. */
const CHUNK_PAGE_SIZE = 100;

/** Identifies one collection's rows. */
export interface CollectionKey {
    mailboxUid: string;
    deviceId: string;
    folderUid: string;
}

type StoredChunk = EasCollectionChunk & { uid: string; version: number };

/** A collection's held set as loaded for one round, with the chunk rows it came from (empty while inline). */
export interface HeldSet {
    ids: Set<string>;
    chunks: StoredChunk[];
}

/** Everything the held-set functions need to reach the chunk rows. */
export interface ChunkStore {
    repo: RepoUtils<any>;
    chunkClass: any;
}

/**
 * Loads the `ServerId`s a device holds for a collection: `state.serverIds` while the set is inline, otherwise every
 * `EasCollectionChunk` row of the collection (read in pages, ordered by `chunkIndex`).
 */
export async function loadHeldSet(state: EasCollectionState | undefined, store: ChunkStore): Promise<HeldSet> {
    if (!state?.chunked) {
        return { ids: new Set(state?.serverIds ?? []), chunks: [] };
    }
    const chunks: StoredChunk[] = [];
    let after = -1;
    for (;;) {
        const page: StoredChunk[] = await store.repo.find(
            {
                mailboxUid: state.mailboxUid,
                deviceId: state.deviceId,
                folderUid: state.folderUid,
                chunkIndex: `gt(${after})`,
                sort: JSON.stringify({ chunkIndex: "ASC" }),
                limit: CHUNK_PAGE_SIZE,
            } as any,
            { ignoreACL: true, limit: CHUNK_PAGE_SIZE },
        );
        chunks.push(...page);
        if (page.length < CHUNK_PAGE_SIZE) {
            break;
        }
        after = page[page.length - 1].chunkIndex;
    }
    const ids = new Set<string>();
    for (const chunk of chunks) {
        for (const id of chunk.ids) {
            ids.add(id);
        }
    }
    return { ids, chunks };
}

/**
 * Persists `ids` as the collection's new held set, given the `loaded` set the round started from, and returns the
 * `serverIds`/`chunked` values the state row must be saved with.
 *
 * A set within `INLINE_HELD_LIMIT` that was never chunked stays inline (no chunk rows touched). Otherwise only the
 * difference is written: each existing chunk drops the ids no longer held, new ids fill the free space of existing
 * chunks before new chunks are appended, and only chunks whose content changed are updated (an emptied chunk is
 * deleted) - a round that adds a window of items rewrites one or two chunks, never the whole set.
 *
 * Writes are not atomic with the state row: the caller must treat a failure here (or of the state row after this)
 * as a lost round and make the device restart the collection.
 */
export async function saveHeldSet(
    key: CollectionKey,
    loaded: HeldSet,
    ids: Set<string>,
    wasChunked: boolean,
    store: ChunkStore,
): Promise<{ serverIds: string[]; chunked: boolean }> {
    if (!wasChunked && ids.size <= INLINE_HELD_LIMIT) {
        return { serverIds: [...ids], chunked: false };
    }

    const placed = new Set<string>();
    const kept: string[][] = loaded.chunks.map((chunk) =>
        chunk.ids.filter((id) => {
            if (!ids.has(id) || placed.has(id)) {
                return false;
            }
            placed.add(id);
            return true;
        }),
    );
    const pending: string[] = [...ids].filter((id) => !placed.has(id));

    let next = 0;
    for (const chunkIds of kept) {
        while (chunkIds.length < HELD_CHUNK_SIZE && next < pending.length) {
            chunkIds.push(pending[next++]);
        }
    }

    for (let i = 0; i < loaded.chunks.length; i++) {
        const chunk = loaded.chunks[i];
        const chunkIds = kept[i];
        const unchanged = chunkIds.length === chunk.ids.length && chunkIds.every((id, j) => id === chunk.ids[j]);
        if (unchanged) {
            continue;
        }
        if (chunkIds.length === 0) {
            await store.repo.delete(chunk.uid, { ignoreACL: true, purge: true, skipPush: true });
        } else {
            await store.repo.update({ uid: chunk.uid, version: chunk.version, ids: chunkIds } as any, asEntity(store.repo, chunk), {
                ignoreACL: true,
                skipPush: true,
            });
        }
    }

    let chunkIndex: number = loaded.chunks.reduce((max, chunk) => Math.max(max, chunk.chunkIndex), -1);
    while (next < pending.length) {
        const chunkIds = pending.slice(next, next + HELD_CHUNK_SIZE);
        next += chunkIds.length;
        chunkIndex++;
        await store.repo.create(new store.chunkClass({ mailboxUid: key.mailboxUid, deviceId: key.deviceId, folderUid: key.folderUid, chunkIndex, ids: chunkIds }), { ignoreACL: true, skipPush: true });
    }

    return { serverIds: [], chunked: true };
}

/** Removes every chunk row of a collection (a restart with `SyncKey 0`, or a forgotten device). */
export async function clearHeldSet(key: CollectionKey, store: ChunkStore): Promise<void> {
    await store.repo.truncate({ mailboxUid: key.mailboxUid, deviceId: key.deviceId, folderUid: key.folderUid } as any, { ignoreACL: true });
}
