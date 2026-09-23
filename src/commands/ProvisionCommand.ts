///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { timingSafeEqualStrings } from "../CryptoUtils.js";
import { persistDeviceSyncState } from "../EasSyncKeyUtils.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Config } = ObjectDecorators;

const DEFAULT_POLICY_TYPE = "MS-EAS-Provisioning-WBXML";

/** [MS-ASCMD] common status 129 (DeviceIsBlockedForThisUser). */
const STATUS_DEVICE_BLOCKED = "129";

/**
 * Handles the two-request EAS `Provision` handshake (MS-ASPROV) every client must complete before any other
 * command is honored (see `BaseEasRoute`'s provisioning gate), plus the three-step `RemoteWipe` sub-flow that
 * rides the same command.
 *
 * **Policy issuance/enforcement**: the password/encryption requirements sent back in request 1's policy
 * document are sourced from `@Config("mail:eas:provision:*")` (defaults below are permissive but not
 * `0`/`false` across the board, unlike the old hardcoded document) - a deployment can tighten them without
 * code changes. Enforcement itself is honest but shallow: request 2 must carry back `Status: 1` on its own
 * `Policy` (a device that reports it could *not* apply the policy, or omits `Status` entirely, is rejected
 * without provisioning) - this library does not itself verify the device's actual password/encryption state
 * beyond trusting that self-reported status, matching MS-ASPROV's own protocol design (the wire protocol has
 * no way for the server to inspect device state directly either).
 *
 * - **Request 1** (no `PolicyKey` in the body): mint a new policy key, store it on `DeviceSyncState` (not yet
 * provisioned), and send back the policy document under that key.
 * - **Request 2** (client echoes the `PolicyKey` back, acknowledging the policy): if the key matches what was
 * minted in request 1 *and* the client's own `Status` is `1`, mark the device provisioned and re-confirm the
 * same key; anything else (a stale/replayed key, a device that never actually saw request 1's response, or a
 * device reporting it could not comply) is rejected without provisioning.
 * - **While a wipe is pending**, every other Provision request (a policy request *or* an acknowledgement of an
 * older key) gets the `RemoteWipe` directive and never provisions. Requesting the wipe also clears the stored
 * policy key (`BaseDeviceSyncStateRoute.remoteWipe`), and `BaseEasRoute` refuses any command whose presented
 * `X-MS-PolicyKey` doesn't match the stored key, so a device can't keep syncing on its old key.
 * - **RemoteWipe acknowledgement**: after wiping itself, a device sends a bare `<Provision><RemoteWipe>
 * <Status>1</Status></RemoteWipe></Provision>` (no `Policies`). Detected first, ahead of the normal
 * issue/acknowledge branching, and ignored (Status 2) unless a wipe is actually pending. Clears `remoteWipeRequested`,
 * stamps `remoteWipeAcknowledgedAt` for audit and sets `blocked`, leaving `provisioned` `false`.
 * - **A blocked device** (one that acknowledged a wipe) is refused every Provision request with Status 129
 * (DeviceIsBlockedForThisUser) - and `BaseEasRoute` refuses its other commands - until an administrator clears the
 * flag (`BaseDeviceSyncStateRoute.unblock`). Otherwise a device (or whoever holds it) could acknowledge the wipe
 * without wiping anything and simply provision again. The block (like the wipe itself) is keyed on the client-supplied
 * `DeviceId`: a client that ignores the directive can pair again under another `DeviceId` with the same credentials -
 * see `DeviceSyncState.blocked`; revoking the account's credentials is what stops that. `remoteWipeAccountOnly` is recorded for admin audit only; the wire directive sent to the
 * device is identical either way (a real "wipe just this account's data" vs. "wipe the whole device"
 * distinction would require an MDM-capable client extension this library doesn't implement).
 *
 * @author Jean-Philippe Steinmetz
 */
export class ProvisionCommand implements EasCommandHandler {
    public readonly command = "Provision";

    @Config("mail:eas:provision:password_enabled", true)
    private passwordEnabled: boolean = true;

    @Config("mail:eas:provision:min_password_length", 4)
    private minPasswordLength: number = 4;

    @Config("mail:eas:provision:max_failed_attempts", 8)
    private maxFailedAttempts: number = 8;

    @Config("mail:eas:provision:require_device_encryption", true)
    private requireDeviceEncryption: boolean = true;

    @Config("mail:eas:provision:allow_simple_password", false)
    private allowSimplePassword: boolean = false;

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (ctx.deviceSyncState.blocked) {
            return element(WbxmlCodePage.Provision, "Provision", [textElement(WbxmlCodePage.Provision, "Status", STATUS_DEVICE_BLOCKED)]);
        }
        if (ctx.request && findChild(ctx.request, "RemoteWipe")) {
            return await this.acknowledgeRemoteWipe(ctx);
        }

        // While a wipe is pending, no Provision request - neither a fresh policy request nor an acknowledgement of a
        // key issued before the wipe was requested - may (re)provision the device: every one gets the directive.
        if (ctx.deviceSyncState.remoteWipeRequested) {
            return element(WbxmlCodePage.Provision, "Provision", [
                textElement(WbxmlCodePage.Provision, "Status", "1"),
                element(WbxmlCodePage.Provision, "RemoteWipe", [textElement(WbxmlCodePage.Provision, "Status", "1")]),
            ]);
        }

        const policiesEl = ctx.request ? findChild(ctx.request, "Policies") : undefined;
        const policyEl = policiesEl ? findChild(policiesEl, "Policy") : undefined;
        const policyType: string = (policyEl ? childText(policyEl, "PolicyType") : undefined) ?? DEFAULT_POLICY_TYPE;
        const clientPolicyKey: string | undefined = policyEl ? childText(policyEl, "PolicyKey") : undefined;
        const clientStatus: string | undefined = policyEl ? childText(policyEl, "Status") : undefined;

        if (!clientPolicyKey) {
            return await this.issuePolicy(ctx, policyType);
        }
        return await this.acknowledgePolicy(ctx, policyType, clientPolicyKey, clientStatus);
    }

    /** Request 1: mint and store a new policy key and send the policy document. */
    private async issuePolicy(ctx: EasCommandContext, policyType: string): Promise<WbxmlElement> {
        const policyKey: string = crypto.randomBytes(8).toString("hex");
        await this.persist(ctx, { policyKey, provisioned: false });

        return element(WbxmlCodePage.Provision, "Provision", [
            textElement(WbxmlCodePage.Provision, "Status", "1"),
            element(WbxmlCodePage.Provision, "Policies", [
                element(WbxmlCodePage.Provision, "Policy", [
                    textElement(WbxmlCodePage.Provision, "PolicyType", policyType),
                    textElement(WbxmlCodePage.Provision, "Status", "1"),
                    textElement(WbxmlCodePage.Provision, "PolicyKey", policyKey),
                    element(WbxmlCodePage.Provision, "Data", [
                        element(WbxmlCodePage.Provision, "EASProvisionDoc", [
                            textElement(WbxmlCodePage.Provision, "DevicePasswordEnabled", this.passwordEnabled ? "1" : "0"),
                            textElement(WbxmlCodePage.Provision, "MinDevicePasswordLength", String(this.minPasswordLength)),
                            textElement(
                                WbxmlCodePage.Provision,
                                "MaxDevicePasswordFailedAttempts",
                                String(this.maxFailedAttempts),
                            ),
                            textElement(
                                WbxmlCodePage.Provision,
                                "AllowSimpleDevicePassword",
                                this.allowSimplePassword ? "1" : "0",
                            ),
                            textElement(
                                WbxmlCodePage.Provision,
                                "RequireDeviceEncryption",
                                this.requireDeviceEncryption ? "1" : "0",
                            ),
                            textElement(WbxmlCodePage.Provision, "AttachmentsEnabled", "1"),
                        ]),
                    ]),
                ]),
            ]),
        ]);
    }

    /** Request 2: the client acknowledges the policy key it was handed in request 1, self-reporting whether
     * it actually applied the policy via its own `Status`. */
    private async acknowledgePolicy(
        ctx: EasCommandContext,
        policyType: string,
        clientPolicyKey: string,
        clientStatus: string | undefined,
    ): Promise<WbxmlElement> {
        if (
            !ctx.deviceSyncState.policyKey ||
            !timingSafeEqualStrings(clientPolicyKey, ctx.deviceSyncState.policyKey) ||
            clientStatus !== "1"
        ) {
            // Status 2 ("protocol error" per MS-ASPROV) - an approximation, not a byte-exact enumeration of
            // every real status code MS-ASPROV defines; this pragmatic subset only distinguishes success from
            // "something is wrong, start over" (see this class's own doc comment on scope), and deliberately
            // does not distinguish a key mismatch from a device self-reporting non-compliance.
            return element(WbxmlCodePage.Provision, "Provision", [textElement(WbxmlCodePage.Provision, "Status", "2")]);
        }

        await this.persist(ctx, { policyKey: clientPolicyKey, provisioned: true });

        return element(WbxmlCodePage.Provision, "Provision", [
            textElement(WbxmlCodePage.Provision, "Status", "1"),
            element(WbxmlCodePage.Provision, "Policies", [
                element(WbxmlCodePage.Provision, "Policy", [
                    textElement(WbxmlCodePage.Provision, "PolicyType", policyType),
                    textElement(WbxmlCodePage.Provision, "Status", "1"),
                    textElement(WbxmlCodePage.Provision, "PolicyKey", clientPolicyKey),
                ]),
            ]),
        ]);
    }

    /** The device has wiped itself and is acknowledging - clear the pending flag and block the device until an
     * administrator unblocks it; `provisioned` stays `false` (from when the wipe was requested). */
    private async acknowledgeRemoteWipe(ctx: EasCommandContext): Promise<WbxmlElement> {
        // Only a wipe that was actually requested can be acknowledged; an unsolicited acknowledgement changes nothing.
        if (!ctx.deviceSyncState.remoteWipeRequested) {
            return element(WbxmlCodePage.Provision, "Provision", [textElement(WbxmlCodePage.Provision, "Status", "2")]);
        }
        await persistDeviceSyncState(ctx.deviceSyncState, ctx.deviceSyncStateRepo, {
            remoteWipeRequested: false,
            remoteWipeAcknowledgedAt: new Date(),
            blocked: true,
        });
        return element(WbxmlCodePage.Provision, "Provision", [textElement(WbxmlCodePage.Provision, "Status", "1")]);
    }

    private async persist(ctx: EasCommandContext, changes: { policyKey: string; provisioned: boolean }): Promise<void> {
        await persistDeviceSyncState(ctx.deviceSyncState, ctx.deviceSyncStateRepo, changes);
    }
}
