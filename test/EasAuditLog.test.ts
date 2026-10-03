///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for EasAuditLog's owner decision and failure handling. The entries each command records are covered in
// the ItemOperations/Sync/Search command tests, and end to end (a real AuditLogEntry row) in test/routes/{mongo,sql}.
import { AuditAction } from "@rapidmx/restapi";
import { EasAuditLog } from "../src/EasAuditLog.js";
import type { EasCommandContext } from "../src/EasCommandHandler.js";

const ctx = { user: { uid: "user-1" }, mailboxUid: "mbx-1", deviceId: "dev-1" } as unknown as EasCommandContext;
const entry = (mailboxUid: string) => ({ action: AuditAction.MESSAGE_DELETE, mailboxUid, targetType: "Message", targetUid: "m1" });

describe("EasAuditLog Tests", () => {
    it("Decides non-owner access like restapi's isNonOwnerAccess(), looking each other mailbox up once.", async () => {
        const mailboxes: Record<string, any> = { mine: { uid: "mine", ownerUserUid: "user-1" }, theirs: { uid: "theirs", ownerUserUid: "user-2" } };
        const findOne = vi.fn(async (uid: string) => {
            if (uid === "broken") throw new Error("db down");
            return mailboxes[uid];
        });
        const audit = new EasAuditLog({ auditLogUtils: { record: vi.fn() } as any, mailboxRepo: { findOne } as any }, ctx, "Sync");

        expect(await audit.isNonOwner("mbx-1")).toBe(false);
        expect(await audit.isNonOwner("mine")).toBe(false);
        expect(await audit.isNonOwner("theirs")).toBe(true);
        expect(await audit.isNonOwner("theirs")).toBe(true);
        // A mailbox that is gone, or can't be read, counts as non-owner.
        expect(await audit.isNonOwner("gone")).toBe(true);
        expect(await audit.isNonOwner("broken")).toBe(true);
        expect(findOne.mock.calls.map(([uid]) => uid)).toEqual(["mine", "theirs", "gone", "broken"]);
    });

    it("Logs instead of throwing when recording fails outright.", async () => {
        const logger = { warn: vi.fn() };
        const audit = new EasAuditLog({ auditLogUtils: { record: vi.fn() } as any, mailboxRepo: undefined as any, logger }, ctx, "Sync");

        await expect(audit.record(entry("theirs"))).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^Sync: failed to record audit entry message\.delete Message:m1/));

        // Without a logger, too.
        const silent = new EasAuditLog({ auditLogUtils: { record: vi.fn() } as any, mailboxRepo: undefined as any }, ctx, "Sync");
        await expect(silent.record(entry("theirs"))).resolves.toBeUndefined();
    });
});
