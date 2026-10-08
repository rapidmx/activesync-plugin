///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// ProvisionCommand's @Config fields (password/encryption policy knobs) are never actually injected in these
// tests - `new ProvisionCommand()` bypasses ObjectFactory entirely, so each field keeps its own class-field-
// initializer default (the same value the decorator itself would fall back to with no config set), which is
// exactly what these tests want to assert against. The real two-phase handshake (issue -> acknowledge,
// including the mismatched-key rejection) and the full three-step RemoteWipe flow are already covered end to
// end in test/routes/{mongo,sql}/EasRoute.test.ts; this file covers only the malformed/absent-request shapes
// and edge branches those real-flow tests never produce (a real EAS client always sends a well-formed
// Policies/Policy body, and never sends a wipe acknowledgement to a device that never requested one).
import { ProvisionCommand } from "../../src/commands/ProvisionCommand.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement } from "../../src/codec/WbxmlElement.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

function makeContext(overrides: Partial<EasCommandContext> = {}): EasCommandContext {
    return {
        user: { uid: "user-1", roles: [], scopes: [] },
        mailboxUid: "mbx-1",
        deviceId: "dev-1",
        deviceType: "TestPhone",
        deviceSyncState: { uid: "dss-1", version: 1, policyKey: undefined, provisioned: false } as any,
        deviceSyncStateRepo: { update: vi.fn().mockResolvedValue(undefined) } as any,
        query: {},
        request: undefined,
        req: {} as any,
        ...overrides,
    };
}

describe("ProvisionCommand Tests", () => {
    it("Issues a new policy using the default policy type when the request body is absent entirely.", async () => {
        const command = new ProvisionCommand();
        const ctx = makeContext({ request: undefined });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("1");
        const policy = findChild(findChild(response!, "Policies")!, "Policy")!;
        expect(childText(policy, "PolicyType")).toBe("MS-EAS-Provisioning-WBXML");
        expect(childText(policy, "PolicyKey")).toBeTruthy();
        expect(ctx.deviceSyncState.provisioned).toBe(false);
    });

    it("Populates the policy document from the (default) configured password/encryption requirements.", async () => {
        const command = new ProvisionCommand();
        const ctx = makeContext({ request: undefined });

        const response = await command.handle(ctx);

        const doc = findChild(
            findChild(findChild(findChild(response!, "Policies")!, "Policy")!, "Data")!,
            "EASProvisionDoc",
        )!;
        expect(childText(doc, "DevicePasswordEnabled")).toBe("1");
        expect(childText(doc, "MinDevicePasswordLength")).toBe("4");
        expect(childText(doc, "MaxDevicePasswordFailedAttempts")).toBe("8");
        expect(childText(doc, "AllowSimpleDevicePassword")).toBe("0");
        expect(childText(doc, "RequireDeviceEncryption")).toBe("1");
        // The rest of the full EASProvisionDoc field set (see easProvisionDocFields()'s own doc comment for why
        // it's sent in full rather than just these five configurable fields) - spot-check a few, including
        // DeviceEncryptionEnabled, the legacy pre-14.0 tag mirroring RequireDeviceEncryption for a client that
        // still looks for it.
        expect(childText(doc, "DeviceEncryptionEnabled")).toBe("1");
        expect(childText(doc, "AlphanumericDevicePasswordRequired")).toBe("0");
        expect(childText(doc, "MaxAttachmentSize")).toBe("0");
        expect(childText(doc, "AllowCamera")).toBe("1");
        expect(childText(doc, "MaxEmailBodyTruncationSize")).toBe("-1");
    });

    it("Reflects non-default password/encryption config values in the policy document, both the configurable fields and their DeviceEncryptionEnabled/RequireDeviceEncryption mirror.", async () => {
        const command = new ProvisionCommand();
        (command as any).passwordEnabled = false;
        (command as any).allowSimplePassword = true;
        (command as any).requireDeviceEncryption = false;
        const ctx = makeContext({ request: undefined });

        const response = await command.handle(ctx);

        const doc = findChild(
            findChild(findChild(findChild(response!, "Policies")!, "Policy")!, "Data")!,
            "EASProvisionDoc",
        )!;
        expect(childText(doc, "DevicePasswordEnabled")).toBe("0");
        expect(childText(doc, "AllowSimpleDevicePassword")).toBe("1");
        expect(childText(doc, "RequireDeviceEncryption")).toBe("0");
        expect(childText(doc, "DeviceEncryptionEnabled")).toBe("0");
    });

    it("Sends a RemoteWipe directive instead of a policy document when a wipe is pending, without minting a policy key.", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        const ctx = makeContext({
            request: undefined,
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: undefined, provisioned: false, remoteWipeRequested: true } as any,
            deviceSyncStateRepo: { update } as any,
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("1");
        const remoteWipe = findChild(response!, "RemoteWipe")!;
        expect(childText(remoteWipe, "Status")).toBe("1");
        expect(findChild(response!, "Policies")).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
    });

    it("Sends AccountOnlyRemoteWipe instead of RemoteWipe when the pending wipe was requested as account-only, and acknowledges it the same way.", async () => {
        const command = new ProvisionCommand();
        const ctx = makeContext({
            request: undefined,
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: undefined, provisioned: false, remoteWipeRequested: true, remoteWipeAccountOnly: true } as any,
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("1");
        expect(findChild(response!, "RemoteWipe")).toBeUndefined();
        const accountOnly = findChild(response!, "AccountOnlyRemoteWipe")!;
        expect(childText(accountOnly, "Status")).toBe("1");

        const update = vi.fn().mockResolvedValue(undefined);
        const ackCtx = makeContext({
            deviceSyncState: { uid: "dss-1", version: 1, remoteWipeRequested: true, remoteWipeAccountOnly: true } as any,
            deviceSyncStateRepo: { update } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "AccountOnlyRemoteWipe", [textElement(WbxmlCodePage.Provision, "Status", "1")]),
            ]),
        });
        const ackResponse = await command.handle(ackCtx);
        expect(childText(ackResponse!, "Status")).toBe("1");
        expect(update.mock.calls[0][0]).toMatchObject({ remoteWipeRequested: false, blocked: true });
    });

    it("Rejects phase 2 acknowledgement when the client's own Policy Status is not 1, without provisioning.", async () => {
        const command = new ProvisionCommand();
        const ctx = makeContext({
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: "abc123", provisioned: false } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                        textElement(WbxmlCodePage.Provision, "PolicyKey", "abc123"),
                        textElement(WbxmlCodePage.Provision, "Status", "2"),
                    ]),
                ]),
            ]),
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("2");
        expect(ctx.deviceSyncState.provisioned).toBe(false);
    });

    it("Provisions the device on a matching phase-2 acknowledgement (Status 1, exact policy key).", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        const ctx = makeContext({
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: "abc123", provisioned: false } as any,
            deviceSyncStateRepo: { update } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyType", "MS-EAS-Provisioning-WBXML"),
                        textElement(WbxmlCodePage.Provision, "PolicyKey", "abc123"),
                        textElement(WbxmlCodePage.Provision, "Status", "1"),
                    ]),
                ]),
            ]),
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("1");
        const policy = findChild(findChild(response!, "Policies")!, "Policy")!;
        expect(childText(policy, "PolicyKey")).toBe("abc123");
        expect(ctx.deviceSyncState.provisioned).toBe(true);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("Rejects phase 2 acknowledgement when the presented key differs from the stored one (timing-safe compare), without provisioning.", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        // Both a same-length and a different-length mismatch: `timingSafeEqualStrings()` takes different code
        // paths for each (a length check up front, then `crypto.timingSafeEqual` only when lengths match), so
        // both need their own case rather than assuming one implies the other.
        for (const presented of ["abc124", "different-length-entirely"]) {
            const ctx = makeContext({
                deviceSyncState: { uid: "dss-1", version: 1, policyKey: "abc123", provisioned: false } as any,
                deviceSyncStateRepo: { update } as any,
                request: element(WbxmlCodePage.Provision, "Provision", [
                    element(WbxmlCodePage.Provision, "Policies", [
                        element(WbxmlCodePage.Provision, "Policy", [
                            textElement(WbxmlCodePage.Provision, "PolicyKey", presented),
                            textElement(WbxmlCodePage.Provision, "Status", "1"),
                        ]),
                    ]),
                ]),
            });

            const response = await command.handle(ctx);

            expect(childText(response!, "Status")).toBe("2");
            expect(ctx.deviceSyncState.provisioned).toBe(false);
        }
        expect(update).not.toHaveBeenCalled();
    });

    it("Treats a Policy with an empty-text PolicyKey as absent, issuing a fresh policy rather than comparing an empty string.", async () => {
        // `childText()` reads an empty `<PolicyKey/>` the same as a missing one, so `handle()`'s own
        // `!clientPolicyKey` check routes this to `issuePolicy()` (Status 1, a freshly minted key) - it never
        // reaches `acknowledgePolicy()`'s timing-safe comparison at all, unlike a genuinely wrong (but
        // non-empty) presented key, which does and is rejected with Status 2 (see the test above).
        const command = new ProvisionCommand();
        const ctx = makeContext({
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: "abc123", provisioned: false } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyKey", ""),
                        textElement(WbxmlCodePage.Provision, "Status", "1"),
                    ]),
                ]),
            ]),
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("1");
        const policy = findChild(findChild(response!, "Policies")!, "Policy")!;
        expect(childText(policy, "PolicyKey")).toBeTruthy();
        expect(childText(policy, "PolicyKey")).not.toBe("abc123");
        expect(ctx.deviceSyncState.provisioned).toBe(false);
    });

    it("Rejects phase 2 acknowledgement when no policy was ever issued (deviceSyncState.policyKey undefined).", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        const ctx = makeContext({
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: undefined, provisioned: false } as any,
            deviceSyncStateRepo: { update } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyKey", "abc123"),
                        textElement(WbxmlCodePage.Provision, "Status", "1"),
                    ]),
                ]),
            ]),
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("2");
        expect(ctx.deviceSyncState.provisioned).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it("Acknowledges a device's own RemoteWipe completion, clearing the flag but leaving provisioned false.", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        const ctx = makeContext({
            deviceSyncState: {
                uid: "dss-1",
                version: 1,
                policyKey: "abc123",
                provisioned: false,
                remoteWipeRequested: true,
            } as any,
            deviceSyncStateRepo: { update } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "RemoteWipe", [textElement(WbxmlCodePage.Provision, "Status", "1")]),
            ]),
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("1");
        expect(findChild(response!, "Policies")).toBeUndefined();
        expect(ctx.deviceSyncState.remoteWipeRequested).toBe(false);
        expect(ctx.deviceSyncState.provisioned).toBe(false);
        expect((ctx.deviceSyncState as any).remoteWipeAcknowledgedAt).toBeInstanceOf(Date);
        // Blocked until an administrator unblocks it, so the device can't simply provision again.
        expect((ctx.deviceSyncState as any).blocked).toBe(true);
    });

    it("Answers an acknowledgement of a policy key issued before a wipe was requested with the RemoteWipe directive, never provisioning.", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        const ctx = makeContext({
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: "abc123", provisioned: false, remoteWipeRequested: true } as any,
            deviceSyncStateRepo: { update } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "Policies", [
                    element(WbxmlCodePage.Provision, "Policy", [
                        textElement(WbxmlCodePage.Provision, "PolicyKey", "abc123"),
                        textElement(WbxmlCodePage.Provision, "Status", "1"),
                    ]),
                ]),
            ]),
        });

        const response = await command.handle(ctx);

        expect(childText(findChild(response!, "RemoteWipe")!, "Status")).toBe("1");
        expect(findChild(response!, "Policies")).toBeUndefined();
        expect(ctx.deviceSyncState.provisioned).toBe(false);
        expect(update).not.toHaveBeenCalled();
    });

    it("Ignores a RemoteWipe acknowledgement when no wipe is pending (Status 2, nothing written).", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        const ctx = makeContext({
            deviceSyncState: { uid: "dss-1", version: 1, policyKey: "abc123", provisioned: true } as any,
            deviceSyncStateRepo: { update } as any,
            request: element(WbxmlCodePage.Provision, "Provision", [
                element(WbxmlCodePage.Provision, "RemoteWipe", [textElement(WbxmlCodePage.Provision, "Status", "1")]),
            ]),
        });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("2");
        expect(update).not.toHaveBeenCalled();
        expect((ctx.deviceSyncState as any).remoteWipeAcknowledgedAt).toBeUndefined();
    });

    it("Refuses every Provision request from a blocked device with Status 129, writing nothing.", async () => {
        const command = new ProvisionCommand();
        const update = vi.fn().mockResolvedValue(undefined);
        for (const request of [
            undefined,
            element(WbxmlCodePage.Provision, "Provision", [element(WbxmlCodePage.Provision, "RemoteWipe", [textElement(WbxmlCodePage.Provision, "Status", "1")])]),
        ]) {
            const ctx = makeContext({
                deviceSyncState: { uid: "dss-1", version: 1, provisioned: false, blocked: true, remoteWipeRequested: true } as any,
                deviceSyncStateRepo: { update } as any,
                request,
            });
            const response = await command.handle(ctx);
            expect(childText(response!, "Status")).toBe("129");
            expect(findChild(response!, "Policies")).toBeUndefined();
            expect(findChild(response!, "RemoteWipe")).toBeUndefined();
        }
        expect(update).not.toHaveBeenCalled();
    });
});
