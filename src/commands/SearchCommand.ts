///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { EmailSyncAdapter } from "../adapters/EmailSyncAdapter.js";
import { AuditAction, AuditLogUtils, hasMailAccess, type Contact, type Message } from "@rapidmx/restapi";
import type { SearchProvider } from "@rapidmx/restapi/search";
import { boundedEscapedPattern } from "../RegexPatternUtils.js";
import { EasAuditLog } from "../EasAuditLog.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Max message uids per `in(...)` lookup - well under `RepoUtils.find()`'s 1000-row page cap. */
const SEARCH_LOOKUP_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/** Parses a `Range` value (`"m-n"`, a zero-based inclusive index pair) into `{ start, end }`, falling back to
 * `defaultEnd` for a missing/malformed value - never trusting the client to request more than `maxEnd` rows. */
function parseRange(raw: string | undefined, defaultEnd: number, maxEnd: number): { start: number; end: number } {
    const match = raw?.match(/^(\d+)-(\d+)$/);
    if (!match) {
        return { start: 0, end: Math.min(defaultEnd, maxEnd) };
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), maxEnd);
    return start <= end ? { start, end } : { start: 0, end: Math.min(defaultEnd, maxEnd) };
}

/** Clamps a matched-results array against a requested `[start, end]` Range, reporting both the sliced page and
 * the actual Range/Total to echo back - shared by the `GAL` and `Mailbox` branches below, which otherwise
 * differ only in how they produce `matches` and render one entry. Both ends are forced to `0` when there are no
 * matches at all - `start` alone (from a client-requested Range like `"5-10"`) would otherwise survive
 * unclamped, producing a malformed `"5-0"` (start > end) once `end` collapses to `0`. */
function paginate<T>(matches: T[], start: number, end: number): { page: T[]; rangeStart: number; rangeEnd: number } {
    return {
        page: matches.slice(start, end + 1),
        rangeStart: matches.length === 0 ? 0 : start,
        rangeEnd: matches.length === 0 ? 0 : Math.min(end, matches.length - 1),
    };
}

/**
 * Handles EAS `Search` for the `GAL` and `Mailbox` stores - `DocumentLibrary` (the real spec's third store type)
 * remains out of scope, matching `ItemOperationsCommand`'s identical scope decision; this library has no
 * document-library model.
 *
 * **`GAL`**: this library's `Contact` records are also the source of truth for GAL lookups against a mailbox's
 * own address book (see the architecture note on `Contact` itself). A simple case-insensitive substring match
 * via `RepoUtils.find()` directly, not the heavier `SearchProvider` full-text index - GAL lookups are
 * small-scale exact/prefix matching against a personal address book, not relevance-ranked full text over large
 * content. Only `displayName`/`givenName`/`surname`/`company` are matched - `Contact.emails`/`phones` are
 * embedded arrays of objects, which a plain per-field regex query can't reach into on either backend (confirmed:
 * MongoDB's `$regex` against an array-of-objects field matches nothing useful, and this library's own
 * query-injection guard rejects dot-notation field paths like `"emails.address"` outright) - a documented gap,
 * not an oversight.
 *
 * **`Mailbox`**: real full-text search over the caller's own `Email` messages, backed by `restapi`'s
 * `SearchProvider` (its own full-text index, kept eventually-consistent with the primary datastore via
 * `SearchIndexJob` - a just-sent/just-received message may briefly not be findable yet). **Pragmatic subset**:
 * only `Class` `Email` is supported (a `Query` naming any other class is rejected, matching the `GAL`-only
 * precedent this file already established for search generally); only the common real-world `Query` shape -
 * `Class`/`CollectionId`/`FreeText`, optionally grouped under one `And` - is parsed, not the full recursive
 * `And`/`Or`/`EqualTo`/`GreaterThan`/`LessThan` boolean-tree grammar MS-ASCMD's schema allows for, so a
 * multi-level nested query silently only sees the first `And` group's own direct children. Each match is
 * re-verified for `READ` on its own current `folderUid` before being included - `SearchProvider`'s index is
 * scoped by `mailboxUid` alone, not per-folder ACL, so this is the one place that check still has to happen
 * per-result rather than once up front. `SearchResultPage` carries no total count (the underlying providers
 * don't compute one cheaply over a relevance-ranked query), so `Total` here means "how many matches this
 * request's own capped fetch actually returned" - a client requesting a `Range` past that cap sees fewer
 * results than may really exist, a documented approximation rather than exact server-side paging.
 *
 * **Audit**: the index is the caller's own mailbox's, but a hit is rendered from the stored message, wherever it is
 * filed now. Results from a mailbox the caller doesn't own (restapi's `isNonOwnerAccess()`) are recorded as one
 * `MESSAGE_CONTENT_ACCESSED` entry per such mailbox per request, listing the returned message uids (`EasAuditLog`).
 *
 * `contactClass`/`messageClass`/`emailAdapterClass`/`mailboxClass`/`auditLogClass` are supplied by the Mongo/SQL
 * concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SearchCommand implements EasCommandHandler {
    public readonly command = "Search";

    protected abstract contactClass: any;
    protected abstract messageClass: any;
    protected abstract emailAdapterClass: any;
    protected abstract mailboxClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Config()
    private config?: any;

    @Logger
    private logger: any;

    private mailboxRepo?: RepoUtils<any>;

    private contactRepo?: RepoUtils<any>;
    private messageRepo?: RepoUtils<any>;
    private emailAdapter?: EmailSyncAdapter;
    private auditLogRepo?: RepoUtils<any>;
    private auditLogUtils?: AuditLogUtils;

    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** Roles `ACLUtils.hasPermission()` treats as always-permitted, which must never apply to another user's
     * mail - see `SyncCommand`'s identical field for the full rationale (restapi's own `MailAccessUtils.ts`). */
    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Config("mail:eas:search_default_range", 9)
    private defaultRangeEnd: number = 9;

    @Config("mail:eas:search_max_range", 99)
    private maxRangeEnd: number = 99;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.contactRepo && this.contactClass) {
            this.contactRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.contactClass.name, args: [this.contactClass] });
        }
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.messageClass.name, args: [this.messageClass] });
        }
        if (!this.emailAdapter && this.emailAdapterClass) {
            this.emailAdapter = await this._objectFactory.newInstance(this.emailAdapterClass);
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        // `searchProvider` is only needed by the Mailbox store - checked in `handleMailbox()` so a deployment
        // without one can still answer GAL searches.
        if (!this.contactRepo || !this.messageRepo || !this.emailAdapter || !this.mailboxRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const storeEl = ctx.request ? findChild(ctx.request, "Store") : undefined;
        const name: string | undefined = storeEl ? childText(storeEl, "Name") : undefined;
        if (!storeEl || (name !== "GAL" && name !== "Mailbox")) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Search requires a Store with Name 'GAL' or 'Mailbox'.");
        }

        const optionsEl = findChild(storeEl, "Options");
        const { start, end } = parseRange(
            optionsEl ? childText(optionsEl, "Range") : undefined,
            this.defaultRangeEnd,
            this.maxRangeEnd,
        );

        const storeResponse = name === "GAL" ? await this.handleGal(ctx, storeEl, start, end) : await this.handleMailbox(ctx, storeEl, start, end);

        return element(WbxmlCodePage.Search, "Search", [
            textElement(WbxmlCodePage.Search, "Status", "1"),
            element(WbxmlCodePage.Search, "Response", [storeResponse]),
        ]);
    }

    private async handleGal(ctx: EasCommandContext, storeEl: WbxmlElement, start: number, end: number): Promise<WbxmlElement> {
        const query = childText(storeEl, "Query");
        if (!query) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Search requires a Store with Name 'GAL' and a Query.");
        }

        // `$or` is a Mongo-only feature of this framework's query builder - `buildSearchQuerySQL` (confirmed by
        // reading its source) has no handling for it at all, so passing one on the SQL backend silently builds
        // a broken TypeORM `where` clause (a literal `$or` property, not a real OR) and 500s. Querying each
        // field separately and merging in memory - the same workaround `EasSyncKeyUtils.computeChanges()`
        // already uses for its own two-backend query gap - works identically on both backends instead.
        //
        // Uses `regex()`, not `like()`: `like()` (`@rapidrest/service-core` ^2.0) compiles a **glob** pattern
        // (`*`/`?` as wildcards), anchored on both backends, so a substring match needs wrapping the term in
        // `*...*` - and even then a literal `*`/`?` the user typed still acts as a wildcard, since glob syntax
        // has no escape mechanism for either character. `regex()` takes a real, unanchored regular expression
        // compiled case-insensitively on both backends (`$regex`/driver-native `REGEXP`), so escaping the term
        // with `StringUtils.escapeRegExp` gives a genuine literal-substring match with no residual wildcard
        // ambiguity - no `*...*` wrapping needed, `regex()` already matches anywhere in the field by default.
        // Bounded so the escaped operand never trips service-core's regex length guard (-> INVALID_REQUEST).
        const pattern = boundedEscapedPattern(query);
        const findOptions: any = { ignoreACL: true, limit: this.maxRangeEnd + 1 };
        const perField = await Promise.all(
            ["displayName", "givenName", "surname", "company"].map((field) =>
                this.contactRepo!.find({ mailboxUid: ctx.mailboxUid, [field]: `regex(${pattern})`, limit: this.maxRangeEnd + 1 } as any, findOptions),
            ),
        );
        const byUid = new Map<string, Contact & { uid: string }>();
        for (const contact of perField.flat()) {
            byUid.set((contact).uid, contact);
        }
        const matches: Contact[] = Array.from(byUid.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
        const { page, rangeStart, rangeEnd } = paginate(matches, start, end);

        return element(WbxmlCodePage.Search, "Store", [
            textElement(WbxmlCodePage.Search, "Status", "1"),
            ...page.map((contact) => this.contactToResult(contact)),
            textElement(WbxmlCodePage.Search, "Range", `${rangeStart}-${rangeEnd}`),
            textElement(WbxmlCodePage.Search, "Total", String(matches.length)),
        ]);
    }

    private async handleMailbox(ctx: EasCommandContext, storeEl: WbxmlElement, start: number, end: number): Promise<WbxmlElement> {
        if (!this.searchProvider) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const queryEl = findChild(storeEl, "Query");
        if (!queryEl) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Search requires a Store with Name 'Mailbox' and a Query.");
        }
        // The common real-world shape groups Class/CollectionId/FreeText under one And - see this class's own
        // doc comment for why a deeper And/Or tree isn't parsed. Falling back to Query's own direct children
        // also accepts a client that omits the And wrapper entirely, which the schema itself permits.
        const container = findChild(queryEl, "And") ?? queryEl;
        const className = childText(container, "Class");
        const folderUid = childText(container, "CollectionId");
        const freeText = childText(container, "FreeText");
        if (className !== "Email" || !freeText) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                "Search on the 'Mailbox' store requires a Query with Class 'Email' and a FreeText term.",
            );
        }

        const resultPage = await this.searchProvider.search({
            mailboxUid: ctx.mailboxUid,
            text: freeText,
            entityTypes: ["message"],
            folderUid,
            limit: this.maxRangeEnd + 1,
        });

        // One `in(...)` query for every hit (chunked to stay within `RepoUtils`' page size) instead of one
        // `findOne` per hit, then one ACL check per distinct folder instead of per hit. A hit whose message no
        // longer exists (stale index entry) simply isn't in `byUid`.
        const hitUids: string[] = Array.from(new Set(resultPage.results.map((result) => result.entityUid)));
        const byUid = new Map<string, Message>();
        await Promise.all(
            chunk(hitUids, SEARCH_LOOKUP_CHUNK).map(async (uids) => {
                const found: Message[] = await this.messageRepo!.find({ uid: `in(${uids.join(",")})`, limit: uids.length } as any, {
                    ignoreACL: true,
                    limit: uids.length,
                });
                for (const message of found) {
                    byUid.set((message as any).uid, message);
                }
            }),
        );
        const folderReadable = new Map<string, Promise<boolean>>();
        const canRead = (folderUid: string): Promise<boolean> => {
            let allowed = folderReadable.get(folderUid);
            if (!allowed) {
                allowed = hasMailAccess(this.aclUtils, this.trustedRoles, ctx.user, folderUid, ACLAction.READ);
                folderReadable.set(folderUid, allowed);
            }
            return allowed;
        };
        const candidates: Message[] = resultPage.results
            .map((result) => byUid.get(result.entityUid))
            .filter((message): message is Message => message !== undefined);
        const readable: boolean[] = await Promise.all(candidates.map((message) => canRead(message.folderUid)));
        const matches: Message[] = candidates.filter((_message, i) => readable[i]);
        const { page, rangeStart, rangeEnd } = paginate(matches, start, end);
        const applicationData: WbxmlElement[] = await this.emailAdapter!.toApplicationDataBatch(page);
        const results = page.map((message, i) => this.messageToResult(message, applicationData[i]));
        await this.auditResults(ctx, page);

        return element(WbxmlCodePage.Search, "Store", [
            textElement(WbxmlCodePage.Search, "Status", "1"),
            ...results,
            textElement(WbxmlCodePage.Search, "Range", `${rangeStart}-${rangeEnd}`),
            textElement(WbxmlCodePage.Search, "Total", String(matches.length)),
        ]);
    }

    /** One `MESSAGE_CONTENT_ACCESSED` entry per non-owner mailbox among `page`'s messages (see this class's doc comment). */
    private async auditResults(ctx: EasCommandContext, page: Message[]): Promise<void> {
        const byMailbox = new Map<string, string[]>();
        for (const message of page) {
            if (message.mailboxUid !== ctx.mailboxUid) {
                byMailbox.set(message.mailboxUid, [...(byMailbox.get(message.mailboxUid) ?? []), (message as any).uid]);
            }
        }
        if (byMailbox.size === 0) {
            return;
        }
        const audit = new EasAuditLog(
            { auditLogUtils: this.auditLogUtils!, mailboxRepo: this.mailboxRepo!, logger: this.logger },
            ctx,
            this.command,
        );
        for (const [mailboxUid, messageUids] of byMailbox) {
            await audit.record({
                action: AuditAction.MESSAGE_CONTENT_ACCESSED,
                mailboxUid,
                targetType: "Mailbox",
                targetUid: mailboxUid,
                details: { operation: "Search", count: messageUids.length, messageUids },
            });
        }
    }

    private contactToResult(contact: Contact): WbxmlElement {
        const properties: WbxmlElement[] = [
            textElement(WbxmlCodePage.Gal, "DisplayName", contact.displayName),
            ...(contact.givenName ? [textElement(WbxmlCodePage.Gal, "FirstName", contact.givenName)] : []),
            ...(contact.surname ? [textElement(WbxmlCodePage.Gal, "LastName", contact.surname)] : []),
            ...(contact.company ? [textElement(WbxmlCodePage.Gal, "Company", contact.company)] : []),
            ...(contact.jobTitle ? [textElement(WbxmlCodePage.Gal, "Title", contact.jobTitle)] : []),
            ...(contact.emails[0] ? [textElement(WbxmlCodePage.Gal, "EmailAddress", contact.emails[0].address)] : []),
            ...(contact.phones[0] ? [textElement(WbxmlCodePage.Gal, "Phone", contact.phones[0].phoneNumber)] : []),
        ];
        return element(WbxmlCodePage.Search, "Result", [element(WbxmlCodePage.Search, "Properties", properties)]);
    }

    /** Reuses `EmailSyncAdapter.toApplicationData()`'s own field mapping (Subject/From/To/Cc/Bcc/DateReceived/
     * Importance/Read/Flag/Body/ConversationId) for a Mailbox-store search hit's `Properties` - the same
     * per-field shape `Sync` already renders for this message, rather than a second, parallel mapping that
     * could drift out of sync with it. */
    private messageToResult(message: Message, applicationData: WbxmlElement): WbxmlElement {
        return element(WbxmlCodePage.Search, "Result", [
            textElement(WbxmlCodePage.AirSync, "Class", "Email"),
            textElement(WbxmlCodePage.AirSync, "CollectionId", message.folderUid),
            textElement(WbxmlCodePage.AirSync, "ServerId", (message as any).uid),
            element(WbxmlCodePage.Search, "Properties", applicationData.children),
        ]);
    }
}
