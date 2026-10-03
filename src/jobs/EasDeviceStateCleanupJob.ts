///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { DeviceSyncState } from "../models/DeviceSyncState.js";
import { clearHeldSet } from "../EasCollectionStore.js";
const { Config, Init, Logger } = ObjectDecorators;

/**
 * Prunes `DeviceSyncState` rows for EAS devices that haven't synced in more than `device_ttl_days` days (or
 * that have never successfully synced at all), keeping the collection from growing unbounded with abandoned
 * device pairings.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`EasDeviceStateCleanupJobMongo`/
 * `EasDeviceStateCleanupJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class EasDeviceStateCleanupJob<D extends DeviceSyncState> extends BackgroundService {
    protected abstract deviceSyncStateClass: any;
    protected abstract collectionStateClass: any;
    protected abstract collectionChunkClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private deviceSyncStateRepo?: RepoUtils<D>;
    private collectionStateRepo?: RepoUtils<any>;
    private collectionChunkRepo?: RepoUtils<any>;

    @Config("mail:jobs:eas_device_cleanup:schedule", "0 0 4 * * *")
    private scheduleExpr: string = "0 0 4 * * *";

    @Config("mail:jobs:eas_device_cleanup:batch_size", 500)
    private batchSize: number = 500;

    @Config("mail:jobs:eas_device_cleanup:device_ttl_days", 90)
    private deviceTtlDays: number = 90;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    protected async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.deviceSyncStateRepo && this.deviceSyncStateClass) {
            this.deviceSyncStateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.deviceSyncStateClass.name, args: [this.deviceSyncStateClass] });
        }
        if (!this.collectionStateRepo && this.collectionStateClass) {
            this.collectionStateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.collectionStateClass.name, args: [this.collectionStateClass] });
        }
        if (!this.collectionChunkRepo && this.collectionChunkClass) {
            this.collectionChunkRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.collectionChunkClass.name, args: [this.collectionChunkClass] });
        }
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    /**
     * The query value matching rows whose boolean flag isn't set (`false`, `null` or unset) - used for
     * `remoteWipeRequested` and `blocked`. MongoDB's
     * `$ne: true` already matches a missing/`null` field; `EasDeviceStateCleanupJobSQL` overrides this, since SQL's
     * `!=` never matches `NULL`.
     */
    protected noPendingWipeQueryValue(): any {
        return "ne(true)";
    }

    public async run(): Promise<void> {
        if (!this.deviceSyncStateRepo) {
            return;
        }

        const cutoff: Date = new Date(Date.now() - this.deviceTtlDays * 24 * 60 * 60 * 1000);

        // `ModelUtils.buildSearchQuery` supports single-sided `lt(...)` comparisons with correct Date
        // coercion on both backends, so the "stale" half of this job's criteria is pushed into the query. The
        // "never synced at all" half (`lastSyncAt` unset) is a separate, plain-equality query rather than an
        // `$or` of the two — `$or` support isn't confirmed identical across both backends' query builders, and
        // a second bounded query is just as cheap for a low-frequency daily cleanup job.
        //
        // `limit` is passed both via `options` (all the Mongo backend of `RepoUtils.find()` actually reads)
        // *and* baked into each query object (all `ModelUtils.buildSearchQuerySQL` reads - it ignores
        // `options.limit` entirely and falls back to its own default of 100 otherwise). Confirmed by
        // real-database testing: on the SQL backend, `options.limit` alone silently caps at 100 regardless of
        // the configured batch size.
        //
        // A row with a pending remote wipe is never purged: deleting it would lose the wipe directive, so a lost or
        // stolen device that reconnects later would simply re-pair and sync without ever being wiped. Nor is a device
        // blocked after acknowledging a wipe: forgetting it would let it pair again as a brand-new device.
        const remoteWipeRequested: any = this.noPendingWipeQueryValue();
        const blocked: any = this.noPendingWipeQueryValue();
        const [stale, neverSynced]: [D[], D[]] = await Promise.all([
            this.deviceSyncStateRepo.find(
                { lastSyncAt: `lt(${cutoff.toISOString()})`, remoteWipeRequested, blocked, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            ),
            this.deviceSyncStateRepo.find(
                { lastSyncAt: null, remoteWipeRequested, blocked, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            ),
        ]);

        for (const row of [...stale, ...neverSynced]) {
            try {
                await this.deleteCollectionStates(row);
                await this.deviceSyncStateRepo.delete(row.uid, { ignoreACL: true, purge: true });
            } catch (err: any) {
                this.logger?.warn(`EasDeviceStateCleanupJob: failed to delete stale device sync state ${row.uid}: ${err.message}`);
            }
        }
    }

    /** Purges the device's per-collection `Sync` state rows (`EasCollectionState`) before the device row itself,
     * so a forgotten device leaves nothing behind - deleted first, so a failure here leaves the device row in place
     * for the next run to retry. */
    private async deleteCollectionStates(row: D): Promise<void> {
        for (;;) {
            const states: any[] = await this.collectionStateRepo!.find(
                { mailboxUid: row.mailboxUid, deviceId: row.deviceId, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            );
            for (const state of states) {
                // Regardless of `chunked`: a round that failed while converting a collection to chunks can leave chunk
                // rows behind a row that still says it isn't chunked.
                await clearHeldSet(state, { repo: this.collectionChunkRepo!, chunkClass: this.collectionChunkClass });
                await this.collectionStateRepo!.delete(state.uid, { ignoreACL: true, purge: true });
            }
            if (states.length < this.batchSize) {
                return;
            }
        }
    }
}
