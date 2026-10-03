///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { Contact } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { element, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import { boundedEscapedPattern } from "../RegexPatternUtils.js";
const { Config, Init, Logger } = ObjectDecorators;

/** A simple, deliberately permissive email-address shape check - just enough to distinguish "the client sent
 * an address it already knows how to reach" from "the client sent a partial name/string that needs GAL
 * lookup", not full RFC 5322 validation. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** [MS-ASCMD] `ResolveRecipients` per-`To` `Status` codes this pragmatic subset actually distinguishes: `1`
 * success (at least one match, or the input already looked like a resolvable address), `4` no match found -
 * an approximation, not a byte-exact enumeration of every real status code MS-ASCMD's `ResolveRecipients` page
 * defines, matching `ProvisionCommand`'s own identical precedent for the same reasoning. */
const STATUS_SUCCESS = "1";
const STATUS_NOT_FOUND = "4";

/** [MS-ASCMD] top-level `ResolveRecipients` `Status` codes: `5` protocol error (the request violates the command's
 * schema, e.g. more `To` elements than allowed), `6` server error (the lookup itself failed, e.g. a database
 * outage - reported for the whole command rather than masquerading as every recipient simply not matching). */
const STATUS_PROTOCOL_ERROR = "5";
const STATUS_SERVER_ERROR = "6";

/** [MS-ASCMD]: a `ResolveRecipients` request MUST NOT contain more than 100 `To` elements. */
export const MAX_RESOLVE_RECIPIENTS_TO = 100;

/**
 * Handles EAS `ResolveRecipients`: resolves each `<To>` value (a display name, partial name, or address) the
 * client is unsure how to reach against the mailbox's own `Contact` (GAL) store - the same substring-match
 * approach `SearchCommand` uses for its own `Store Name="GAL"` lookups, duplicated rather than shared (small
 * enough, and specific enough to each command's own surrounding logic, that extracting a shared utility for two
 * call sites isn't worth a new cross-command dependency). Both use `RepoUtils`' `regex(...)` operator (not
 * `like(...)`, which compiles a glob pattern under `@rapidrest/service-core` ^2.0 - anchored, and with no escape
 * for a literal `*`/`?`): `StringUtils.escapeRegExp(value)` gives a genuine, unanchored literal-substring match
 * with no residual wildcard ambiguity, matching the same fix already applied to the `mapi` plugin's own
 * identical GAL-search gap.
 *
 * **Pragmatic subset**: no free-busy `Availability`, no S/MIME `Certificates`/`Options` handling at all - this
 * command's real-world use is overwhelmingly enterprise S/MIME certificate lookup, which this library doesn't
 * implement elsewhere either (`ComposeMailCommand` sends plain MIME, never signed/encrypted). A `<To>` value
 * that already looks like an email address (`LOOKS_LIKE_EMAIL`) is echoed straight back as its own single
 * exact match rather than searched for, matching a real client's own common case of resolving an address it
 * already typed correctly.
 *
 * `contactClass` is supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ResolveRecipientsCommand implements EasCommandHandler {
    public readonly command = "ResolveRecipients";

    protected abstract contactClass: any;

    @Config("mail:eas:resolve_recipients_max_matches", 10)
    private maxMatches: number = 10;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private contactRepo?: RepoUtils<any>;

    @Logger
    private logger: any;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.contactRepo && this.contactClass) {
            this.contactRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.contactClass.name, args: [this.contactClass] });
        }
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const toEls = ctx.request ? findChildren(ctx.request, "To") : [];
        if (toEls.length > MAX_RESOLVE_RECIPIENTS_TO) {
            // Each `To` costs up to three regex scans, so an unbounded count is a cheap way to load the database.
            return this.statusOnly(STATUS_PROTOCOL_ERROR);
        }
        const responses: WbxmlElement[] = [];
        for (const toEl of toEls) {
            const value = toEl.text ?? "";
            try {
                responses.push(await this.resolveOne(ctx, value));
            } catch (err) {
                if (!(err instanceof ApiError) || err.status !== 400) {
                    // A real lookup failure (e.g. the database is down) is a server error, not "no match".
                    this.logger?.error(`ResolveRecipients lookup failed: ${String(err)}`);
                    return this.statusOnly(STATUS_SERVER_ERROR);
                }
                // One unresolvable `To` (e.g. a pattern service-core rejects) must not fail every other recipient.
                this.logger?.warn(`ResolveRecipients lookup failed for one recipient: ${String(err)}`);
                responses.push(this.responseElement(value, STATUS_NOT_FOUND, []));
            }
        }
        return element(WbxmlCodePage.ResolveRecipients, "ResolveRecipients", [
            textElement(WbxmlCodePage.ResolveRecipients, "Status", STATUS_SUCCESS),
            ...responses,
        ]);
    }

    private statusOnly(status: string): WbxmlElement {
        return element(WbxmlCodePage.ResolveRecipients, "ResolveRecipients", [
            textElement(WbxmlCodePage.ResolveRecipients, "Status", status),
        ]);
    }

    private async resolveOne(ctx: EasCommandContext, value: string): Promise<WbxmlElement> {
        if (!value.trim()) {
            // An empty term would compile to `regex()`, matching every contact - there's nothing to resolve.
            return this.responseElement(value, STATUS_NOT_FOUND, []);
        }
        if (LOOKS_LIKE_EMAIL.test(value)) {
            return this.responseElement(value, STATUS_SUCCESS, [this.recipientElement(value, undefined)]);
        }

        // Bounded so the escaped operand never trips service-core's regex length guard (-> INVALID_REQUEST).
        const pattern = boundedEscapedPattern(value);
        const findOptions: any = { ignoreACL: true, limit: this.maxMatches };
        const perField = await Promise.all(
            ["displayName", "givenName", "surname"].map((field) =>
                this.contactRepo!.find({ mailboxUid: ctx.mailboxUid, [field]: `regex(${pattern})` } as any, findOptions),
            ),
        );
        const byUid = new Map<string, Contact & { uid: string }>();
        for (const contact of perField.flat()) {
            byUid.set(contact.uid, contact);
        }
        const matches = Array.from(byUid.values())
            .filter((contact) => contact.emails[0])
            .slice(0, this.maxMatches);

        if (matches.length === 0) {
            return this.responseElement(value, STATUS_NOT_FOUND, []);
        }

        return this.responseElement(
            value,
            STATUS_SUCCESS,
            matches.map((contact) => this.recipientElement(contact.emails[0].address, contact.displayName)),
        );
    }

    private recipientElement(address: string, displayName: string | undefined): WbxmlElement {
        return element(WbxmlCodePage.ResolveRecipients, "Recipient", [
            textElement(WbxmlCodePage.ResolveRecipients, "Type", "1"),
            ...(displayName ? [textElement(WbxmlCodePage.ResolveRecipients, "DisplayName", displayName)] : []),
            textElement(WbxmlCodePage.ResolveRecipients, "EmailAddress", address),
        ]);
    }

    private responseElement(to: string, status: string, recipients: WbxmlElement[]): WbxmlElement {
        return element(WbxmlCodePage.ResolveRecipients, "Response", [
            textElement(WbxmlCodePage.ResolveRecipients, "To", to),
            textElement(WbxmlCodePage.ResolveRecipients, "Status", status),
            ...(recipients.length > 0
                ? [
                      textElement(WbxmlCodePage.ResolveRecipients, "RecipientCount", String(recipients.length)),
                      ...recipients,
                  ]
                : []),
        ]);
    }
}
