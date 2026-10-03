///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, ObjectFactory, UserUtils, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import type { DeviceSyncState } from "./models/DeviceSyncState.js";
import { persistDeviceSyncState } from "./EasSyncKeyUtils.js";
const { Config, Init } = ObjectDecorators;
const { Auth, Param, Post, Request, User: AuthUser } = RouteDecorators;

/**
 * Admin-only trigger for the `RemoteWipe` sub-flow `ProvisionCommand` implements. `restapi` has no route of its
 * own for `DeviceSyncState` (it's a protocol-internal entity, not a domain object a normal API consumer ever
 * lists or edits directly), so this lives here instead, following the exact `trustedRoles`/`UserUtils.hasRoles`
 * gating pattern `BaseMailboxRoute` already uses for its own admin-vs-owner scoping.
 *
 * Setting `remoteWipeRequested: true` (and `provisioned: false` alongside it) is the entire trigger: the next
 * request that device makes of any kind is already forced back through `Provision` by `BaseEasRoute.dispatch()`'s
 * existing 449 gate, at which point `ProvisionCommand.issuePolicy` sees the flag and sends the device a
 * `RemoteWipe` directive instead of a normal policy document - no separate push/notification channel is needed.
 *
 * **Scope**: a `DeviceSyncState` row is one (mailbox, client-supplied `DeviceId`) pairing, so the wipe and the block
 * that follows its acknowledgement apply to that `DeviceId` only. A compliant client wipes itself; a client that
 * ignores the directive can pair again under a different `DeviceId` with the same credentials. Cutting such a client
 * off requires revoking the account's credentials - not something this route does.
 *
 * `deviceSyncStateClass` is supplied by the Mongo/SQL concrete subclasses, the same one-line-per-backend
 * pattern used throughout this library.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDeviceSyncStateRoute<D extends DeviceSyncState> {
    protected abstract deviceSyncStateClass: any;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private deviceSyncStateRepo?: RepoUtils<D>;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.deviceSyncStateRepo && this.deviceSyncStateClass) {
            this.deviceSyncStateRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.deviceSyncStateClass.name,
                args: [this.deviceSyncStateClass],
            });
        }
    }

    /**
     * Marks `uid` (a `DeviceSyncState`'s own id, not a device id string - the admin looks this up via whatever
     * device-listing view a deployment builds on top of `DeviceSyncState`'s ordinary CRUD, out of scope here)
     * for remote wipe. Optional JSON body `{ accountOnly?: boolean }` — recorded for admin audit only; see
     * `ProvisionCommand`'s own doc comment for why the wire directive sent to the device doesn't distinguish
     * the two.
     */
    @Auth(["jwt"])
    @Post("/:uid/remote-wipe")
    public async remoteWipe(
        @Param("uid") uid: string,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<D> {
        if (!user || !UserUtils.hasRoles(user, this.trustedRoles)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const repo: RepoUtils<D> = this.deviceSyncStateRepo!;
        const deviceSyncState: D | undefined = await repo.findOne(uid, { ignoreACL: true });
        if (!deviceSyncState) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const accountOnly: boolean = req.body?.accountOnly === true;
        await persistDeviceSyncState(deviceSyncState, repo, {
            remoteWipeRequested: true,
            remoteWipeAccountOnly: accountOnly,
            provisioned: false,
            // The old key must stop working immediately, not just once the device next provisions.
            policyKey: null,
        });
        return deviceSyncState;
    }

    /**
     * Lets a device that acknowledged a remote wipe (`blocked`, see `ProvisionCommand`) connect again: it must still
     * complete a fresh Provision handshake. Admin-only, like `remoteWipe`.
     */
    @Auth(["jwt"])
    @Post("/:uid/unblock")
    public async unblock(@Param("uid") uid: string, @AuthUser user?: JWTUser): Promise<D> {
        if (!user || !UserUtils.hasRoles(user, this.trustedRoles)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const repo: RepoUtils<D> = this.deviceSyncStateRepo!;
        const deviceSyncState: D | undefined = await repo.findOne(uid, { ignoreACL: true });
        if (!deviceSyncState) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        await persistDeviceSyncState(deviceSyncState, repo, { blocked: false });
        return deviceSyncState;
    }
}
