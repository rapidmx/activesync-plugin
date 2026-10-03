///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RepoUtils } from "@rapidrest/service-core";
import { AuditAction, isNonOwnerAccess, type AuditLogUtils, type Mailbox } from "@rapidmx/restapi";
import type { EasCommandContext } from "./EasCommandHandler.js";

/** What an `EasAuditLog` needs from the command using it. */
export interface EasAuditDependencies {
    /** restapi's `AuditLogUtils` service, built once by the command's `@Init` hook over its audit-log repository. */
    auditLogUtils: AuditLogUtils;
    mailboxRepo: RepoUtils<any>;
    logger?: any;
}

/** One audited ActiveSync action against a mailbox. */
export interface EasAuditEntry {
    action: AuditAction;
    /** The mailbox whose content was read or deleted - only a mailbox the caller doesn't own is audited. */
    mailboxUid: string;
    targetType: string;
    targetUid: string;
    details?: Record<string, any>;
}

/**
 * Audit entries for ActiveSync access to mail in a mailbox the caller doesn't own - an administrator reaching in
 * through a trusted role, or a delegate working in a shared folder. It uses restapi's `AuditLogUtils.record()` and
 * `isNonOwnerAccess()`, as `BaseMessageRoute` does: REST records `MESSAGE_CONTENT_ACCESSED` for a non-owner content
 * read and `MESSAGE_DELETE` for a delete.
 *
 * Built once per request. The caller's own mailbox (`ctx.mailboxUid`, resolved by `ownerUserUid`) is never audited
 * and needs no lookup. Any other mailbox is loaded once. A mailbox that can't be loaded counts as non-owner, the
 * defensive reading restapi's `content()` uses. Recording never throws: an audit failure is logged and the command
 * goes on, like restapi's own best-effort persistence.
 *
 * Every entry's `details` carries `protocol: "ActiveSync"`, the command and the `DeviceId`.
 */
export class EasAuditLog {
    private readonly nonOwner: Map<string, Promise<boolean>> = new Map();

    constructor(
        private readonly deps: EasAuditDependencies,
        private readonly ctx: EasCommandContext,
        private readonly command: string,
    ) {}

    /** Whether reading `mailboxUid`'s content is a non-owner access for this request's caller. */
    public isNonOwner(mailboxUid: string): Promise<boolean> {
        if (mailboxUid === this.ctx.mailboxUid) {
            return Promise.resolve(false);
        }
        let pending: Promise<boolean> | undefined = this.nonOwner.get(mailboxUid);
        if (!pending) {
            pending = this.deps.mailboxRepo
                .findOne(mailboxUid, { ignoreACL: true })
                .then((mailbox: Mailbox | undefined) => !mailbox || isNonOwnerAccess(mailbox, this.ctx.user))
                .catch(() => true);
            this.nonOwner.set(mailboxUid, pending);
        }
        return pending;
    }

    /** Records `entry` when its mailbox isn't the caller's own. */
    public async record(entry: EasAuditEntry): Promise<void> {
        try {
            if (!(await this.isNonOwner(entry.mailboxUid))) {
                return;
            }
            await this.deps.auditLogUtils.record(
                {
                    action: entry.action,
                    targetType: entry.targetType,
                    targetUid: entry.targetUid,
                    mailboxUid: entry.mailboxUid,
                    details: { protocol: "ActiveSync", command: this.command, deviceId: this.ctx.deviceId, ...entry.details },
                },
                { req: this.ctx.req, user: this.ctx.user },
            );
        } catch (err: any) {
            this.deps.logger?.warn(`${this.command}: failed to record audit entry ${entry.action} ${entry.targetType}:${entry.targetUid}: ${err?.message}`);
        }
    }
}
