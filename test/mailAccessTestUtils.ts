///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Shared test double for the "a trusted role bypasses ACL" behavior every mailbox-scoped `hasPermission()`
// call in this plugin must now be protected against (see restapi's `MailAccessUtils.ts`, and this repo's own
// `.claude/NOTES.md` entry on the fix). `@rapidrest/service-core`'s real `ACLUtils.hasPermission()` answers
// `true` for any caller holding a trusted role (`trusted_roles`, default `["admin"]`) BEFORE it ever looks at
// the actual ACL record - correct for administering the platform, wrong for a person's mail. Every command
// call site must go through restapi's `hasMailAccess()` (which calls `stripTrustedRoles()` on the caller
// first), never `aclUtils.hasPermission(ctx.user, ...)` directly.

/** The mailbox/folder owner in tests that need one - holds whatever `grants` actually lists for it. */
export const OWNER_USER = { uid: "owner-1", roles: [] as string[] };

/** A caller holding the default trusted role (`admin`) but no ACL grant of their own on anything - the exact
 * shape the vulnerability this fake exists to catch would have let straight through. Also usable as a
 * "trusted delegate": give this uid a real, narrower grant in `grants` (e.g. `READ` only) to prove the admin
 * role doesn't additionally unlock actions that grant doesn't cover. */
export const TRUSTED_STRANGER_USER = { uid: "admin-1", roles: ["admin"] };

/** A stranger with no trusted role and no grant either - the ordinary "access denied" case, for contrast. */
export const PLAIN_STRANGER_USER = { uid: "stranger-1", roles: [] as string[] };

/**
 * A minimal `ACLUtils`-shaped fake whose `hasPermission()` reproduces the real (and, for mailbox data, unsafe)
 * `@rapidrest/service-core` contract: a caller holding one of `trustedRoles` is granted access
 * unconditionally, checked BEFORE the real per-uid/per-user grant. `grants` is `{ [uid]: { [userUid]: actions[] } }`
 * - a real ACL record's shape (owner FULL, a delegate's own narrower record).
 *
 * A command that reaches this via `hasMailAccess()` (which strips trusted roles off the caller first) only
 * ever gets what `grants` actually lists for that exact user - `TRUSTED_STRANGER_USER`'s trusted role never
 * substitutes for a missing or narrower grant, because the role was already stripped from the user object
 * `hasPermission()` receives. A command that still called `aclUtils.hasPermission(ctx.user, ...)` directly on
 * the raw, unstripped caller would incorrectly grant every action to `TRUSTED_STRANGER_USER` regardless of
 * `grants` - that's the regression these tests exist to catch if a future edit reintroduces a direct call.
 */
export function fakeMailAclUtils(grants: Record<string, Record<string, string[]>>, trustedRoles: readonly string[] = ["admin"]): any {
    return {
        hasPermission: vi.fn(async (user: any, uid: string, action: string) => {
            if (user?.roles?.some((role: string) => trustedRoles.includes(role))) {
                return true;
            }
            return !!grants[uid]?.[user?.uid]?.includes(action);
        }),
    };
}
