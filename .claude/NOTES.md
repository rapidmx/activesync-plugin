# activesync — Design Decisions & Session Notes

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing design decisions & constraints

- **Vulnerability/review threat model: externally-exploitable only.** Only count issues reachable
  from a downstream, untrusted HTTP client hitting a service built on this package (anonymous or
  low-privilege caller). Do NOT flag developer-only footguns or purely theoretical races with no
  concrete external trigger path.
- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.
- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).

### 2026-09-22 (2) — Round-9: trusted-role ACL bypass across every mailbox-scoped command, plus two cleanups

A second-round review of the Round-8 commit (`6a394df`) confirmed those three fixes and the restapi bump were
solid, but surfaced one significant new finding and two minor ones. Committed to `main` as a follow-up.

**Threat-model scoping note** (updates the standing decision above): the admin-bypass finding below is judged a
real, fix-worthy vulnerability, not an excluded "admin-only footgun" - it needs no elevated *intent*, no race, no
timing, nothing beyond an ordinary authenticated request from any account that happens to carry the platform's
default trusted role. restapi hit the identical bug in its own REST routes and fixed it (0.17.0) for the same
reason. The standing "externally-exploitable only" scope still excludes routes gated by genuine platform-admin
actions (`BaseDeviceSyncStateRoute`'s remote-wipe/unblock, both already legitimately admin-only) - those are
unaffected and untouched here.

- **1 [HIGH] Every ACL check in this plugin called `aclUtils.hasPermission(ctx.user, uid, action)` with the raw,
  unstripped caller.** `@rapidrest/service-core`'s `ACLUtils.hasPermission()` unconditionally returns `true` for
  any caller holding a trusted role (`trusted_roles`, default `["admin"]`) - checked *before* it looks at the
  actual ACL record. Any account with the default `admin` role (no special grant needed - just the role) could
  therefore Sync, read, fetch, move, delete or respond to another mailbox's data with well-known-folder uids
  being deterministically computable. This is restapi's own 0.17.0 finding
  ("Fixed an administrator with an elevated token reading every user's mail"), never carried over to this
  plugin's own ACL checks.
  - Fix: every call site now goes through restapi's `hasMailAccess(aclUtils, trustedRoles, user, uid, action)`
    (`util/MailAccessUtils.ts`, exported since 0.17.0), which calls `stripTrustedRoles()` on the caller before
    ever reaching `hasPermission()` - the same idiom restapi's own routes use (confirmed by reading
    `BaseFolderRoute.ts`). Each command class gained its own `@Config("trusted_roles", ["admin"]) private
    trustedRoles: string[] = ["admin"];` field (matching `ACLUtils`'s/`RouteUtils`'s own decorator and default,
    so a deployment that changes the config key affects EAS and REST identically) - there's no shared base class
    across these command classes to hang one copy of the field on, so it's repeated per class, same as restapi's
    own per-route `trustedRoles` field.
  - **20 call sites across 8 files** fixed: `SyncCommand.ts` (READ/CREATE/UPDATE/DELETE on a folder),
    `ItemOperationsCommand.ts` (Fetch body/attachment READ, EmptyFolderContents DELETE, Move CREATE+UPDATE),
    `MoveItemsCommand.ts` (UPDATE on source, CREATE on destination), `MeetingResponseCommand.ts` (UPDATE, DELETE,
    the meeting-request message's READ), `ComposeMailCommand.ts` (Source message READ, `markOriginal` UPDATE),
    `GetItemEstimateCommand.ts` (READ), `SearchCommand.ts` (Mailbox-store per-folder READ), `PingCommand.ts`
    (per-folder READ before subscribing).
  - **Tests**: new `test/mailAccessTestUtils.ts` (`fakeMailAclUtils()`, a minimal `ACLUtils` fake that reproduces
    the real - and, for mail, unsafe - trusted-role shortcut, so a test can prove a caller's role alone no longer
    substitutes for a real per-action grant) plus `TRUSTED_STRANGER_USER`/`OWNER_USER`/`PLAIN_STRANGER_USER`
    fixtures. Added a "Trusted-role (admin) bypass regression" test (or describe block, one or more per distinct
    action/call site) to each of all 8 affected commands' isolated test files, plus one full end-to-end test in
    `test/routes/mongo/EasRoute.test.ts` using this file's real `admin`/`adminToken` fixture against the actual,
    unmocked `@rapidrest/service-core` `ACLUtils` and `trusted_roles` config (not a fake standing in for it) -
    an admin-role caller with no ACL grant on another user's folder still gets Sync Status 4, not silently
    synced. All pre-existing tests kept passing unmodified: none of them asserted on the raw, unstripped
    `ctx.user` being passed to `hasPermission()` in a way `stripTrustedRoles()`'s identity-preserving fast path
    (returns the same object when there's nothing to strip) would break.
- **2 [LOW, cleanup] `RestapiCompat.ts` and `MimeHeaderUtils.ts`'s inline restapi copies were never replaced
  after the 0.19.0 bump**, despite their own doc comments saying to. Verified byte-identical against restapi's
  actual installed source first (not assumed): `boundIndexedValue`/`asEntity` (`ConversationUtils.js`/
  `EntityUtils.js`) and `extractOriginatorHeaders`/`hasAddressLikeDisplayName`/`checkOriginatorHeaders`/
  `isPlainAddress`/`safeDisplayName` (`MimeHeaderUtils.js`) all matched. Deleted `src/RestapiCompat.ts` entirely,
  repointing its 12 importers at `@rapidmx/restapi` directly. `src/MimeHeaderUtils.ts` now re-exports those 5
  functions (plus the `OriginatorHeaders`/`OriginatorHeaderCheckOptions` types) from restapi instead of defining
  them, but **keeps two of restapi's own private helpers as inline copies** (`quotedStringsAndComments()`,
  `decodeEncodedWords()`) - restapi doesn't export them, and this plugin's own `checkComposedOriginators()`/
  `displayTextShowsOnlyAllowedAddresses()` still need them directly, not just the 5 public functions built on
  top of them. Net: ~300 lines of duplicated restapi source removed, ~40 kept (the two helpers restapi doesn't
  export). Added a `MimeHeaderUtils.test.ts` case for a backslash-escaped character *inside* an address-showing
  quoted display name (not just outside it) - the shrunk file's remaining local `quotedStringsAndComments()` had
  lost its only test coverage of that branch when the now-removed local copies of the 5 public functions (which
  used to exercise the exact same escape-handling logic from other angles) went away.
- **3 [LOW, test fix] `ProvisionCommand.test.ts`'s "wrong presented key" loop tested `presented || "x"`, so its
  empty-string case silently became `"x"` and was never actually exercised.** Not a functional gap (the
  different-length case already covers `timingSafeEqualStrings()`'s length-mismatch path), but the empty-string
  input is structurally a *different* branch entirely: `ProvisionCommand.handle()`'s own `!clientPolicyKey` check
  reads an empty `<PolicyKey/>` the same as a missing one and routes to `issuePolicy()` (Status 1, a fresh key)
  rather than ever reaching `acknowledgePolicy()`'s comparison. Split into two tests: the mismatch loop now only
  carries genuinely-wrong, non-empty keys, and a new dedicated test asserts the empty-string case actually takes
  the issue-a-fresh-policy branch instead of being silently coerced into exercising the wrong code path.
- Checks: `yarn lint` and `npx tsc --noEmit -p .` clean. `tsc -p tsconfig.test.json` still exactly the documented
  17 pre-existing errors (unchanged by this round). Full run: 35 files / 851 tests, coverage 100 / 98.39 / 100 /
  100 (thresholds met).

### 2026-09-22 — Round-8 review fixes (STR_I byte cap, timing-safe PolicyKey, pairing race) + restapi 0.19.0 bump + coverage

Three new findings fixed, restapi bumped from `^0.10.0` to `^0.19.0` (real compatibility work, not just a
version-string bump), and the three flagged coverage gaps closed. Committed to `main`.

- **1 WBXML `STR_I` uncapped.** None of `WbxmlDecoder`'s existing caps (`maxElements`/`maxChildrenPerElement`/
  `maxDepth`) bounded the UTF-8 bytes a `STR_I` (inline string) token could carry - a single text-bearing field
  (Subject, a Contact's notes `Body`, ...) could run up to the full 16 MB `mail:eas:max_request_bytes` cap while
  every other decoder limit stayed nowhere near tripped: a poison-pill risk against Mongo's 16 MB document cap
  (permanently unwritable, so it fails identically on every retry) and an egress-multiplication risk (re-served
  every future sync round). Fixed with a new `maxInlineStringBytes` option (default
  `WBXML_DEFAULT_MAX_INLINE_STRING_BYTES`, 4 MiB), tracked as a running total of raw UTF-8 bytes across every
  `STR_I` token in the whole document (not just the largest single one - two 600-byte fields summing past the cap
  throws too), reset per `decode()` call, throwing the same `WbxmlLimitError` every other cap throws. Independent
  of, and in addition to, `BaseEasRoute`'s request-body-size check.
- **2 Non-constant-time PolicyKey comparison.** `BaseEasRoute`'s provisioning-gate check and
  `ProvisionCommand.acknowledgePolicy`'s phase-2 check both used plain `!==`/`===` on a secret token
  (`crypto.randomBytes(8).toString("hex")`). New `src/CryptoUtils.ts` `timingSafeEqualStrings()` (length-checked
  first, since `crypto.timingSafeEqual` throws on a length mismatch rather than returning `false`) is now used in
  both places.
- **3 TOCTOU on first device pairing.** `BaseEasRoute.findOrCreateDeviceSyncState()`'s `create()` call had no
  catch: two concurrent first requests from the same (mailbox, deviceId) could both pass the `find()` check above
  and both call `create()`; the unique index lets only one insert land, and the loser's `create()` throws. Turns
  out `RepoUtils.create()` (this repo's actual installed `@rapidrest/service-core`) already converts a duplicate-
  key error into `ApiError(IDENTIFIER_EXISTS, 400)` rather than an unhandled 500 as originally suspected - but the
  loser still failed its request instead of transparently reading the winner's row. Fixed: the loser now catches
  `IDENTIFIER_EXISTS` (or any raw driver duplicate-key error via service-core's own `isDuplicateKeyError()`,
  covering a duplicate-key error some other layer throws first) and re-reads the row that won, returning it as if
  it had been there all along - the same shape restapi's own `findOrCreateWellKnownFolder()` already uses for the
  identical race (confirmed by reading its actual installed source while investigating finding 4 below).

**restapi `^0.10.0` -> `^0.19.0`** (peer range `0.x` -> `>=0.10.0 <1`, matching `booking-plugin`'s bounded-peer-
range pattern; no `resolutions` entry added here, unlike `booking-plugin`'s "pin to peer floor" convention -
adding one would have forced `yarn install` back onto an old version and defeated the point of this bump, which
was to actually build/test against current):
- `yarn build` and `npx tsc --noEmit -p .` are clean against 0.19.0 with zero source changes needed - no ACL-
  model-change (0.17.0) or query-DSL (0.13.0) fallout hit any mailbox-scoped route this plugin owns.
- **One pre-existing, unrelated-to-the-bump test failure found and fixed while running the full suite**:
  `SyncCommand.test.ts`'s Delete test asserted `folderRepo.find()` was called with the bare
  `{ mailboxUid, type }` + `expect.anything()` shape restapi's `findOrCreateWellKnownFolder()` used well before
  this bump (confirmed failing identically at the old pinned 0.10.0 too, via `git stash`) - it now sends an
  explicit oldest-first `sort`/`limit` and matching `find()` options (the same lost-race retry shape finding 3
  above turned out to mirror). Test updated to match the real call shape; not a regression this session
  introduced, just never caught before because `tsc -p tsconfig.test.json` isn't a gate and this assertion still
  ran (and silently drifted) under `vitest`.
- **`tsc -p tsconfig.test.json` (documented pre-existing, not a gate) briefly went from 17 to 19 errors under
  0.19.0**: `SearchProvider.bulkIndex()`'s return type changed `Promise<void>` -> `Promise<string[]>` (indexed
  uids, so `SearchIndexJob` can retry only what didn't take), and `DnsResolver` gained `resolveCname()`/
  `resolveSrv()` (MS-OXDISCO autodiscover CNAME/SRV checks). Both are pure interface additions with no plugin-code
  fallout - fixed `test/testDoubles.ts`'s `NoopSearchProvider`/`StaticDnsResolver` to implement the current shape
  (back down to the documented 17).
- No genuine behavioral incompatibility found - nothing to report as a blocker.

**Coverage** (target: the three files the review flagged). Full suite: 831 tests, 100% statement/line/function,
98.51% branch (was 97.76%).
- `ComposeMailCommand.ts` 87.1% -> 100% branch. New cases: a `<MIME>` element present but with neither `opaque`
  nor `text` (400, not just the "MIME missing entirely" shape already covered); MIME body arriving as inline
  `STR_I` text instead of `OPAQUE`; a mailbox with no `aliasAddresses` key at all (`?? []` fallback); a composed
  Mime that already carries its own `Message-ID` (the Sent Items copy keeps the original bytes verbatim, the
  `relayed.raw !== stripped` false branch every prior test missed since none of them set one); an absent Subject
  defaulting to `""`; an HTML-only body with no plain-text part (`bodyPreview` defaulting to `""`) plus a real
  attachment (`hasAttachments` true); two separate `To:` header lines (mailparser leaves genuinely-repeated
  `To`/`Cc`/`Bcc` headers as an `AddressObject[]`, not the single-object shape every other test's MIME uses -
  `addressesOf()`'s `Array.isArray` branch was otherwise dead); a `SmartReply` denied `UPDATE` on the original's
  folder (relays, skips `markOriginal`, doesn't throw - as opposed to the already-covered case where `UPDATE` is
  granted but the write itself throws). One branch marked `/* v8 ignore next */` instead of chased: mailparser's
  `simpleParser()` always initializes `attachments` to `[]`, so `parsed.attachments?.length ?? 0`'s nullish side
  is provably dead code, matching this file's own existing precedent for two other defense-in-depth checks.
- `EasCollectionLease.ts` 89.5% -> 100% branch. New cases: `forgetClient()` called with a promise reference a
  newer client already superseded (must not evict the newer one); releasing an in-process lease whose local map
  entry something else has since taken over (same "don't evict what isn't yours" shape, for the in-process side);
  a late Redis `SET` that finally resolves but lost the `NX` race (another copy took the key first, so nothing
  should be released); the undocumented-but-real 100ms default poll interval when `pollMs` is omitted. The middle
  two needed poking `(EasCollectionLease as any).clients`/`.local` directly (TS `private` is compile-time only) -
  there's no way to force these exact interleavings through the public `acquire()`/release-function API alone.
- `MoveItemsCommand.ts` 90.3% -> 100% branch. New cases: `handle()` with no request body at all (empty response,
  no `Move` children); a `Move` element missing `SrcMsgId` itself (response omits `SrcMsgId` rather than any
  particular value); `planMessageMove`'s two distinct refusal reasons actually landing on their documented status
  codes side by side (`"destination"` -> 2, `"inFlight"`/`"sent"` -> 7 via `STATUS_LOCKED`) - previously only the
  update-throws-an-exception path to `STATUS_LOCKED` was covered, not the plan-level refusal path.
- New coverage tests added to `test/routes/mongo/EasRoute.test.ts` only (not mirrored to `sql/` - real HTTP+DB
  integration tests for `ComposeMailCommand`'s success-path behavior already follow that single-backend
  convention in this file per the existing "guard clauses only" isolated-test comment; the codec/lease/plan-level
  gaps are backend-agnostic unit tests either way).
- Checks: `yarn lint` and `npx tsc --noEmit -p .` clean. Full run 35 files / 831 tests, coverage
  100 / 98.51 / 100 / 100 (thresholds met).

### 2026-09-14 (7) — Round-6 review fixes (invite spoofing, non-owner audit, lease hangs, drafts, DeviceId)

All 8 findings re-checked against the code and fixed; nothing skipped. Also aligned with restapi's round-6 "part A"
contract changes, which landed mid-task. Uncommitted, no version bump. Still builds against `@rapidmx/restapi` 0.9.0.
0.9.0 already exports `recordAuditLog`, `isNonOwnerAccess`, `AuditAction` and `AuditLogEntry{Mongo,SQL}`, so no copy
was needed for those. `isPlainAddress`/`safeDisplayName` (with the private `hasControlCharacter`, `PLAIN_ADDRESS_PATTERN`
and `MAX_PLAIN_ADDRESS_LENGTH`) are new **exact inline copies** in the restapi section of `src/MimeHeaderUtils.ts`.

- **1 Calendar invite spoofing** (`CalendarSyncAdapter`), using restapi's semantics exactly:
  - **Organizer on Add with a mailbox:** the display name is always `safeDisplayName(mailbox.displayName)`. The device's
    `OrganizerName` is ignored.
  - **Organizer in direct use (no mailbox):** a non-empty `OrganizerEmail` must be `isPlainAddress`, and
    `OrganizerName` must pass `safeDisplayName`.
  - **Attendees**, like restapi's `BaseCalendarEventRoute.assertParticipants()`: every `Email` must be `isPlainAddress`,
    and more than `MAX_CALENDAR_ATTENDEES` (500) is refused, never truncated. On a Change this only applies when the
    address list actually changed, so an attendee copy filed with an odd list still round-trips.
  - Attendee `Name` goes through `safeDisplayName`. Any refusal throws, which is Sync Status 6.
  - A Change still never touches the organizer. restapi's `MeetingSchedulingJob` now ignores `organizer.displayName`
    anyway.
- **2 Non-owner audit** (new `src/EasAuditLog.ts`, one instance per request):
  - The caller's own `ctx.mailboxUid` needs no lookup. Any other mailbox is loaded once and judged with
    `isNonOwnerAccess()`. A mailbox that's missing or can't be read counts as non-owner.
  - Failures are logged and never thrown. `details` always carries `protocol: "ActiveSync"`, `command` and `deviceId`.
  - **Granularity chosen:**
    - ItemOperations Fetch: one `MESSAGE_CONTENT_ACCESSED` per body (`Message`) or attachment (`Attachment`). Nothing
      for a Status 11 fetch.
    - EmptyFolderContents: one `MESSAGE_DELETE` per batch (`Folder` target, uid list of at most `batchSize`), so at
      most 20 rows.
    - Sync: one `MESSAGE_CONTENT_ACCESSED` per Email collection round that sends Add/Change items (`Folder` target,
      at most one window of uids), plus one `MESSAGE_DELETE` per successful Email Delete, per item like REST. The
      delete entry sets `movedToDeletedItems` for a delete-as-move.
    - Search (Mailbox store): one entry per non-owner mailbox in the returned page (`Mailbox` target). The index is
      the caller's own, so this only fires for stale or moved hits.
  - restapi's `AuditLogEntry` accepts any `targetType`/`targetUid`/`details`, so batch entries are schema-valid.
  - Contacts/Calendar/Tasks rounds aren't audited, since `MESSAGE_CONTENT_ACCESSED` is message-specific.
  - `ItemOperationsCommand`, `SyncCommand` and `SearchCommand` gained an abstract `auditLogClass` (plus `mailboxClass`
    where it was missing). The Mongo/SQL subclasses set them, and the test server model lists now include
    `AuditLogEntry*`.
- **3 Lease release hang**: the release races the token-checked `EVAL` against `redisTimeoutMs`, and the in-process
  lease is freed in `finally`.
- **4 Redis lease skipped after a long local wait**:
  - The connect and the first `SET` always get the full `redisTimeoutMs`.
  - Only polling `SET`s, after Redis has answered, are capped by the deadline. A timeout there means busy
    (`undefined`).
  - One acquire can now overrun `waitMs` by at most one `redisTimeoutMs`.
- **5 Drafts** (`MessageMoveRules`):
  - `sentDate` can't be the marker: every message has one, and EAS drafts get `new Date()`.
  - `isGenuineDraft` now also needs none of these server-managed marks: `scanResultUid`, `scheduledSendRelayedAt`,
    `sanitizedHtmlBlobKey` (a draft is never scanned; the Sent copy keeps it), `encrypted: true`,
    `recallRequestedAt`, or a non-empty `receiptStatus`. A non-trusted client can't set any of them, and EAS, REST
    and compose drafts carry none.
  - Side effect: an imported message sitting in Drafts with sanitized HTML is no longer body-editable over EAS.
  - Residual: a plain-text, unencrypted Sent copy with no receipt request has no mark. restapi now keeps it out of
    Drafts: `send()` needs Drafts for non-trusted callers.
  - Part A: `planMessageMove` refuses Outbox -> Drafts for a delivered message (`scanResultUid`), as restapi's 403
    does.
- **Part A, deletes during a send**:
  - New `hasLiveSendLease()` (also used by `planMessageMove`).
  - Sync Delete answers Status 6 for a live lease, both hard delete and delete-as-move, with nothing written.
  - EmptyFolderContents skips such a message as failed (Status 17, or 3 if nothing was deleted). This mirrors
    restapi's new 409.
- **6 Own address as display name**: `checkComposedOriginators` runs restapi's check without
  `rejectAddressLikeDisplayNames`, then applies its own rule. An address-like display name, group name or comment
  passes only when:
  - every addr-spec token in it passes `isAllowed` (read as UTF-8 and as latin1, encoded words decoded);
  - it has no look-alike `@`;
  - no stray `@` is left over.

  So `"me@x" <me@x>` passes, while any other address still gets 403.
- **7 Ping fallback**: undecided folders run `scanAfter` 25 at a time (`FALLBACK_SCAN_CHUNK_SIZE`), in order.
- **8 DeviceId**: the exported `isValidDeviceId()` also refuses exactly `me` and `null`, which service-core's
  `coerceOperand` special-cases (case-sensitive, so `Me`/`NULL` still pass). `ModelUtils.literal` wasn't added to
  device lookups: `DeviceId` only enters through `BaseEasRoute`, so validation covers it.
- **Test pollution found**: "Gives up when another copy's Redis key outlives waitMs" never released its last lease.
  Its 333 ms renewal timer then fired into the "Renews" test once the new lease tests shifted timings. The test now
  releases it.
- **Tooling gotchas (Windows)**:
  - Python writes: use `newline=''`. A bytes literal needs `rb''`, or `\x00` becomes a real control byte.
  - The Edit tool turns a typed ` ` escape into the literal character, which is a line terminator inside a JS
    regex literal.
- Checks: `yarn lint` clean. `npx tsc --noEmit -p .` clean. `tsc -p tsconfig.test.json` still shows the pre-existing
  17 errors. Full run: 35 files / 805 tests, coverage 100 / 97.76 / 100 / 100.

### 2026-09-14 (6) — Migrated to `@rapidrest/service-core` 2.1.0

Uncommitted, no version bump. `@rapidmx/restapi` stays at 0.9.0.

- **Deps.** service-core devDependency `^2.0.0` -> `^2.1.0`, peerDependency `2.x` -> `^2.1.0`. The lockfile resolves a
  single 2.1.0 copy, and restapi 0.9.0 doesn't nest its own.
- **The full suite passed on 2.1.0 unchanged** (34 files / 778 tests). Checked each 2.1.0 breaking change against `src/`:
  - `allowExistingACL`: every plugin `create()` uses a fresh uid (DeviceSyncState, collection state, chunks, Sync Add,
    Sent Items copy). restapi 0.9.0's `findOrCreateWellKnownFolder` seeds `acl.uid = instance.uid` of a new instance,
    so it doesn't hit `IDENTIFIER_EXISTS`. **No restapi 0.9.0 blocker found.**
  - `$`/dotted update keys are checked at the top level only: `folderSyncKeys["$foldersync"]` (nested) still saves on
    both backends.
  - `$or`: `scanAfter` always builds two non-empty branches.
  - Truncate cap: the plugin's only `truncate()` (chunks) passes `ignoreACL`, so it isn't capped.
  - Optimistic locking: `asEntity` is now redundant against service-core 2.1.0, but harmless. It's kept as restapi's
    copy.
  - Dates are written as `Date` objects. The plugin reads no push payload fields and has no WebSocket routes or
    `@RateLimit`.
- **`ModelUtils.literal()`.** ItemOperations conversation Move (`conversationId`) and MeetingResponse (`icalUid`) now
  query with `ModelUtils.literal(boundedValue)`. The in-memory exact match stays. Results are the same, except that a
  parenthesised non-operator value (e.g. `Support(EU)`) is no longer rejected as an unknown operator. Unit tests now
  expect the literal. Other operator strings (`in(...)` of `isListableUid` uids, `ne(storedUid)`, date cursors) were
  left alone: they're built from stored values, not escapes.
- **Pre-existing, not a gate:** `tsc -p tsconfig.test.json` has 17 errors (`newInstance()` returning
  `T | Promise<T>`, and `MessageMovePlan.reason`). The count is the same before this change.
- Checks: `yarn lint` and `npx tsc --noEmit -p .` are clean. The full run is 34 files / 778 tests, with coverage
  100 / 97.66 / 100 / 100 (thresholds met).

### 2026-09-14 (5) — Round-5 review fixes (sender spoofing, Drafts forgery, query injection, version locks, Redis, chunks)

All 14 findings re-checked against the code and fixed. Uncommitted, no version bump. Builds against
`@rapidmx/restapi` 0.9.0, so restapi helpers it lacks are **inline copies** to replace once the dependency is bumped:
`src/RestapiCompat.ts` (`boundIndexedValue`, `asEntity`, copied exactly) and `src/MimeHeaderUtils.ts`
(`checkOriginatorHeaders` with `rejectAddressLikeDisplayNames`, `hasAddressLikeDisplayName`, copied from restapi's
in-progress source that runs the display-name rule on the lexer's own From/Sender values). `nodemailer` (`^10.0.1`,
already in the lockfile via mailparser/restapi) is now a declared dependency, for `nodemailer/lib/addressparser`.

- **1 SendMail/SmartReply/SmartForward spoofing**: `countHeader` is gone. The raw MIME goes through
  `checkOriginatorHeaders` before `simpleParser`, so all the reported forms are 403: `<me> <victim>`, `"ceo@y" <me>`,
  `me (victim@y)`, `Victim Name, me`, a bare CR hiding a second From, and encoded-word or fullwidth `@` names. One lexer
  (`lexHeaderFields`) backs both the sender check and `stripHeader`. It ends the block at the first CRLFCRLF/LFLF,
  splits lines on CRLF/LF/bare CR, and trims field names, so it sees at least every field mailsplit sees (mailsplit
  trims names and splits on LF only). So `Bcc :` is stripped too. Two plugin-side additions go beyond restapi. A MIME
  with no From at all stays **400**. **An empty group (`victims:;, me`) is refused**, since restapi's flattened parse
  accepts it.
- **13 Sent Items copy** now stores `scanAndRelay`'s `messageId`/`conversationId` (bounded) and `encrypted`. The
  stored blob keeps Bcc. When the relay injected a `Message-ID`, the same header is prepended to the stored copy.
- **2 Drafts forgery** (`src/MessageMoveRules.ts`, shared by MoveItems, ItemOperations Move and Sync delete-as-move):
  - Moves into **Outbox** are always refused.
  - Moves into **Drafts** are allowed only from Drafts or Outbox. MoveItems answers Status 2, ItemOperations counts
    it as a failed message (3/17).
  - Leaving Outbox sets `scheduledSendTime: null`, and nulls `scheduledSendAttempts`/`scheduledSendError` only where
    the row has them (restapi 0.9.0's SQL model has no such columns). A row with `scheduledSendRelayedAt` is refused:
    MoveItems 7, Sync Delete 6.
  - EAS body changes need `isGenuineDraft` (in Drafts and no `scanResultUid`). REST still allows moves into Drafts,
    and a delivered message there still can't be rewritten over EAS. **Residual:** a REST-moved Sent Items copy
    (no `scanResultUid`) would count as a draft. That's restapi's REST rule to close.
- **3 MeetingResponse UID**: looked up as `boundIndexedValue(uid)` and exact-matched in memory
  (`row.icalUid === key`, same mailbox), mirroring restapi's `ScanQueueJob.findCalendarEventRows`.
- **Grep for other client/sender strings in `find()`**:
  - `DeviceId` is now validated in `BaseEasRoute`: at most 128 visible ASCII characters, no `(`, `)` or `,`, else 400.
  - `EmptyFolderContents` resolves the folder and queries by the stored uid (404 if missing).
  - Ping's batched `in(...)` and reconcile only list `isListableUid` values (EasSyncKeyUtils).
  - Other folder-uid queries already went through a `findOne` (exact) first. Label uids were already UUID-guarded.
- **4 ItemOperations conversation Move**: bounded `conversationId`, exact in-memory match (`conversationId` and
  `mailboxUid`).
- **5 Version locks**: `asEntity(repo, row)` is now the `existing` for every plugin update. That covers MoveItems,
  ItemOperations Move, MeetingResponse (both writes), Sync Change/Delete/stamp, SmartReply/SmartForward
  `markOriginal`, Settings Oof, `persistDeviceSyncState`, chunk updates and the state row. On Mongo these now bump
  `version`/`dateModified` and 409 on conflict. The route test checks `version + 1` after a MoveItems move.
- **6 Delegate MeetingResponse**: organizer-ness is judged against `event.mailboxUid`'s mailbox (loaded when it isn't
  the caller's). An organizer copy in another mailbox gets Status 2. The owner mailbox missing also gets 2.
  Own-mailbox behaviour is unchanged.
- **7 Redis outage** (`EasCollectionLease`): the client is created with `disableOfflineQueue`, `connectTimeout` and a
  reconnect strategy that gives up after 3 tries. A client whose reconnects gave up (`isOpen === false`) is replaced
  next time. Connect and each SET are raced against `redisTimeoutMs` (default 2 s), capped by the wait deadline, and
  fail open. A SET that lands late is released. A timeout that only happened because the deadline ran out while Redis
  was answering (another copy holds the key) returns `undefined`, not fail-open.
- **10 Lease renewal**: every `ttlMs/3`, a token-checked `PEXPIRE` script (unref'd interval, cleared on release).
- **8/9 Chunks**: when a round will touch chunk rows (already chunked, or converting), `saveState` first updates the
  state row to `chunked: true`, `syncKey: ""`, `previous.syncKey: ""`. Then it writes the chunks, then the final row
  on the returned version. Any failure after that leaves no key that matches, even if the Status 3 response is lost,
  so the device must send SyncKey 0. SyncKey 0 and `EasDeviceStateCleanupJob` now truncate chunks unconditionally. A
  conversion also truncates leftovers first, so an orphan can't hit the unique `chunkIndex`. The blank-key option
  was chosen over copy-on-write generations. Cost: one extra state write per chunked round.
- **11 Reconcile**: uids failing `isListableUid` (comma, parens, `me`, `null`) are checked one by one with `findOne`.
  Results are exact-matched on `folderUid`.
- **12 Remote wipe**: doc comments in `DeviceSyncState.blocked`, `ProvisionCommand` and `BaseDeviceSyncStateRoute`
  now say the wipe and block are per client-supplied `DeviceId`. A non-compliant client can re-pair under a new id,
  and stopping it means revoking credentials. No token revocation was built.
- **14 Ping queries**:
  - State rows: one `in(...)` query per 500 folders.
  - Per collection class: one live + one deleted query for rows `gte(earliest cursor)`, limit 501. When neither page
    is full, every folder is decided in memory with exactly `scanAfter`'s rule.
  - When a page is full, folders already shown pending are reported and the rest fall back to per-folder
    `scanAfter`.
  - Idle 300 folders is about 3 queries (was about 900).
  - A failed state lookup now means "nothing pending" for the whole Ping (was per folder).
- **Not done (as instructed)**: the chunk-sorting performance item, and the version bump.
- Tests: new `test/MimeHeaderUtils.test.ts` and `test/MessageMoveRules.test.ts`. Also extended the Lease, Ping,
  SyncCommand, MeetingResponse, ItemOperations, EasCollectionSync, EmailSyncAdapter, BaseEasRoute and cleanup-job
  tests, plus Mongo/SQL route tests (originator spoofs, `Bcc :` + relay Message-ID filing, Outbox/Drafts moves with
  the version bump, operator-shaped ConversationId).
- **Follow-up for restapi "part A"** (contract changes landed while round 5 was in progress):
  - **Sender checks.** `MimeHeaderUtils` now carries an exact copy of restapi's `extractOriginatorHeaders`,
    `hasAddressLikeDisplayName` (including look-alike `@`) and `checkOriginatorHeaders(raw, isAllowed, options)`, with
    their private helpers. The plugin-only rules moved to a separate `checkComposedOriginators()`, which runs restapi's
    check with `rejectAddressLikeDisplayNames: true` and then refuses two more cases:
    - a `From`/`Sender` that the byte-preserving lexer counts but restapi's regex doesn't (for example, a leading
      space on the first line, or `Sender\f:` - mailsplit reads both);
    - an empty group in `From`/`Sender`.

    `stripHeader` still uses the byte-preserving lexer.
  - **No recipients.** Like restapi's `send()` 400, but in the ActiveSync form: a composed message with no
    To/Cc/Bcc address gets `<SendMail|SmartReply|SmartForward><Status>119</Status>` (MessageHasNoRecipient) over
    HTTP 200, and nothing is relayed. A message with no `From` at all is still HTTP 400.
  - **Send lease.** `planMessageMove` refuses to move a message anywhere while `scheduledSendLeaseExpiresAt` is
    still in the future. MoveItems answers 7, Sync delete answers 6, and ItemOperations counts it as failed. This
    matches restapi's `assertNotInFlight()`. On a move out of Outbox the lease field is cleared too (only where the
    row has it; restapi 0.9.0's SQL model has no column for it). `toValidDate` is copied inline.
    Only unit-tested: restapi 0.9.0's `MessageMongo`/`RepoUtils` drop the unknown field on read, so no route test
    against 0.9.0 can see a live lease. The check starts working end to end once restapi is bumped.
  - **Bounded writes.** All the plugin's `messageId`/`conversationId`/`icalUid` writes now go through
    `boundIndexedValue`: the Sent Items copy, the Email Add `messageId` default and the Calendar Add `icalUid` default.
  - **Checks.** Final run: 34 files / 778 tests, coverage 100% statements/lines/functions and 97.66% branches.
    `yarn lint` and `tsc --noEmit` are clean.

### 2026-09-14 (4) — Round-4 review fixes (held-set chunks, leases, overlap/reconcile, wipe block, meeting copies)

All findings checked against HEAD `88290ce`. 14 fixed, finding 6 (move stream per device) noted rather than
built. Uncommitted, no version/peerDependency changes. Restapi, server, web-client, react-shared and mapi were
being edited by other agents at the same time and weren't touched.

- **1 (critical, fixed here as a backstop; restapi is fixing `MeetingSchedulingJob` itself)**: the installed job
  sends a REQUEST for any event with attendees whose `inviteSequenceSent !== sequence`, and a CANCEL for any
  soft-deleted event with `cancelNoticeSentAt` unset, always as the organizer. So an attendee deleting or editing
  their own copy of someone else's meeting from a phone mailed everyone. Now `isOrganizedBy(event, mailbox)` in
  `CalendarSyncAdapter` decides whose copy it is. On an attendee copy a `Change` never bumps `sequence` and sets
  `inviteSequenceSent = sequence` when they differ. A new optional adapter hook `beforeDelete` stamps
  `cancelNoticeSentAt` before `SyncCommand` deletes the item. `MeetingResponseCommand` does the same for a decline
  (stamp, then delete) and for accept/tentative (sets `inviteSequenceSent`). For Sync, "own" is judged against the
  **folder's** mailbox, not the caller's. A delegate rescheduling the owner's meeting in a shared calendar is still
  the organizer's copy and still sends invites. So `SyncCommand` now passes the folder-owner mailbox to
  `fromApplicationData` on `Change` (Add still gets the caller's), and the interface doc says so.
- **2**: `countHeader()` counts raw top-level `From`/`Sender` field starts (continuation lines don't count,
  `From :` does). More than one of either is a 403, checked before `simpleParser`, which keeps only one of them.
- **3**: `scanOverlap()` (EasSyncKeyUtils) re-reads the 5 s before each cursor, newest first, limit 1000. The
  folder stream dedupes against the new `EasCollectionState.recent` (uid -> dateModified ISO of rows processed
  inside the window, pruned to the window and 1000 entries). Only a row not recorded there at that timestamp is
  processed, and it never moves the cursor. Move-stream overlap rows are re-applied without dedupe, since a Delete
  only happens while the item is held. A legacy row with no `recent` seeds it from whatever is already in the
  window, so upgrading doesn't re-send anything. The overlap is its own query rather than lowering the cursor:
  lowering it would never make progress once more than a window's worth of rows share the last 5 s.
- **4**: without `Options`, SyncKey 0 stores `filterType: null` (null, not undefined, or SQL keeps an old value).
  The first `FilterType` is adopted while nothing is held or generation <= 1. A mismatch after that is still
  Status 3. `workingState.filterType` is now optional and `filterPredicate` accepts undefined.
- **5**: `PingCommand` checks for pending changes (`scanAfter` from the collection's stored cursor, limit 5,
  ignoring the device's own echoes; a full page counts as a change) once subscribed. It also checks right away when
  Redis isn't configured and when the connect fails. Any hit answers Status 2 immediately. This needs the entity
  classes, so there are new `PingCommandMongo`/`PingCommandSQL` subclasses (the base still works without them) and
  both `EasRoute`s use them.
- **6 (noted, not built)**: one shared out-of-folder stream per device would mean moving the move cursor from
  `EasCollectionState` to device level, and rethinking per-collection retries (`previous.moveCursor*`), GetItemEstimate
  dry runs and SyncKey 0 resets. That isn't contained. The real cost is unindexed change queries, and restapi is adding
  `(folderUid, dateModified, uid)` / `(mailboxUid, dateModified, uid)` indexes. The move stream only runs while the
  device holds items, and is capped at 1000 rows per round.
- **7**: new `EasCollectionLease` takes an in-process per-key lease, plus Redis `SET NX PX` on `datastores:cache`
  when configured (token-checked Lua release; fails open to in-process if Redis is unreachable). `SyncCommand` holds
  it per (mailbox, device, folder) and reads the state row only after acquiring it. Waiting more than 15 s gives
  Status 16. A failed state save now gives Status 3 with no SyncKey (was: log it and return the unsaved key), and a
  failed SyncKey 0 save gives Status 5. **A race in my own first version, caught by the concurrency test**: the check
  "is the key free" was separated from "take it" by an `await`, so two waiters could both win. `takeLocal()` now
  checks and takes in the same tick.
- **8**: new `EasCollectionChunk` model (`@MailboxScopedData`, unique index `(mailboxUid, deviceId, folderUid,
  chunkIndex)`, 2000 ids per chunk). It's exported from `./mongo`/`./sql` and registered in both test servers, the
  cleanup job tests and plugin.test. `EasCollectionStore.saveHeldSet` keeps a held set of 2000 or fewer inline in
  `serverIds` until it first outgrows that. After that `chunked: true` stays set until SyncKey 0, which truncates the
  chunks. Each round writes only the difference: removed ids are dropped from their chunk, new ids fill free space
  before new chunks are appended, only changed chunks are updated, and emptied chunks are deleted. The chunk writes
  and the state row aren't atomic. That's why a failed save is Status 3 (the device restarts from 0, which clears
  the chunks). The cleanup job also truncates a forgotten device's chunks. `GetItemEstimate` loads chunks too.
- **9**: when a round has caught up (no MoreAvailable, window not full), `enumerateCollection` checks up to 100
  held ids after `reconcileCursor` with `uid in(...)` in the folder. Any that are missing are Deleted: hard purges,
  and anything the streams missed. The cursor wraps around. It's off by default in `enumerateCollection`; SyncCommand
  and GetItemEstimate set it. The SyncCommand unit harness sets `reconcileLimit = 0`, because its fake repos find
  nothing.
- **10**: after acknowledging a wipe, a device gets `DeviceSyncState.blocked = true`. `ProvisionCommand` answers
  Status 129 (DeviceIsBlockedForThisUser), `BaseEasRoute` gives 403 for any other command, and the cleanup job
  never purges a blocked row (otherwise the device could re-pair as new). An admin clears it with
  `POST /:uid/unblock` on `BaseDeviceSyncStateRoute`. This doesn't cover a device that changes its client-chosen
  DeviceId; that's inherent to EAS.
- **11**: confirmed against [MS-ASCMD] Status (FolderSync): 9 means "synchronization key mismatch/invalid". The key
  before the current one is kept in `folderSyncKeys.$foldersyncPrevious` and accepted again. The key encodes its own
  cursor, so a retry just recomputes that round, and the previous key stays as it was.
- **12**: GetItemEstimate refuses more than `MAX_SYNC_COLLECTIONS` collections (a single Status 2), estimates a
  repeated CollectionId once, and caps the SyncKey 0 `count()` at `item_estimate_max_count`.
- **13**: the provisioning gate exempts only `Provision`, plus a `Settings` request whose top-level elements are all
  `UserInformation`/`DeviceInformation`. Settings is decoded before the gate to check that; other commands are still
  decoded after it. So an unprovisioned (or wiped) device can't `Oof/Set`.
- **14**: EmptyFolderContents: at most 20 batches per request. A message that fails to delete is skipped, and a
  batch with nothing new ends the loop. Status 17 (partial) or 3 (nothing deleted), per [MS-ASCMD] ItemOperations
  statuses. ItemOperations Move: a per-message failure is skipped, Status 17 if any failed, 3 if none moved.
  MoveItems: a failed update is that move's Status 7. **Also found and fixed while there: MoveItems status codes
  were inverted.** [MS-ASCMD] 2.2.3.177.10 says 3 = success, 1 = invalid source, 2 = invalid destination, 4 = same
  folder, 7 = locked. The code sent 1 for success and 3 for every failure, so clients read success as "invalid
  source" and every failure as success. Route tests updated to match.
- **15**: `sendOrThrow` exists in restapi's source (`transport/TransportResultUtils.ts`) but **not in the installed
  published 0.9.0**, and bumping the dependency wasn't allowed. So `MeetingResponseCommand.sendReply` does the same
  check inline (a result with no accepted recipients, or any rejected ones, counts as a failure). A failed REPLY now
  gives that Result Status 4 ("error on the server"); the response itself is still recorded. **Follow-up:** switch to
  `sendOrThrow` once the peer range includes a restapi that exports it.
- Verified: `yarn vitest run` 733/733 with coverage thresholds met (100/97.9/100/100), `yarn lint` clean,
  `npx tsc --noEmit -p .` clean.

### 2026-09-14 (3) — Round-3 review fixes (Sync state redesign, spoofing, DoS bounds, Ping, provisioning)

All 15 findings confirmed against HEAD `9888059` and fixed; nothing skipped. Uncommitted.

**Sync protocol state (findings 1, 2, 6, 9, 15 cursor) - redesigned, not patched.** New model
`EasCollectionState{Mongo,SQL}` (`@MailboxScopedData`, unique `(mailboxUid, deviceId, folderUid)`, exported from
`./mongo`/`./sql`, purged by `EasDeviceStateCleanupJob` before the device row) holds one `Sync` collection's key,
class, `FilterType`, two `(dateModified, uid)` cursors, the exact `serverIds` the device holds, `echoes` (uid ->
`dateModified` of the device's own write) and `previous` (last round's key + cursors + added/removed delta +
ClientId -> ServerId list; a list because ClientId is client text, unsafe as a Mongo key). Enumeration lives in `EasCollectionSync.enumerateCollection`:
- Add vs Change is decided by `serverIds`, never by the old dateCreated≈dateModified heuristic; a deleted row only
  yields a Delete if the device holds it.
- Moves: a second stream (same mailbox, `folderUid: ne(folder)`, live + deleted) turns a held item that left the
  folder into a Delete; read *after* the folder stream so the newer location wins. Skipped (cursor fast-forwarded
  to now-60s) while the device holds nothing, so the first scan never crawls mailbox history. Gap: an item moved to
  a *different mailbox* via REST isn't seen (MoveItems now refuses that, see 12).
- Client commands are applied first; their writes are recorded as echoes and skipped when enumerated with an
  unchanged `dateModified`. Cursors only ever advance past rows actually processed (window-limited), so the old
  "watermark jumps past unsent changes" bug is structurally gone.
- `scanAfter` uses `$or: [dateModified gt, dateModified range(=) + uid gt]` sorted by `{dateModified, uid}` -
  confirmed both query builders support `$or` and JSON sort strings.
- Retry: `previous.syncKey` is accepted; state is rebuilt from `previous` (serverIds minus added plus removed), a
  replayed ClientId Add returns the stored ServerId (its current row is noted as an echo so it isn't sent back as a
  Change), a Delete of an id that round removed is silent.
- Separate rows also end cross-folder contention. `persistDeviceSyncState` now re-reads + re-applies (function
  patches merge `folderSyncKeys`) on `INVALID_OBJECT_VERSION`, 5 attempts; `lastSyncAt` failures are logged only.
  A lost race on the collection row itself is logged (client gets Status 3 next round) instead of a 409.
- **Migration**: existing devices' Sync keys in `DeviceSyncState.folderSyncKeys[folderUid]` are no longer read -
  the first Sync after upgrade answers Status 3 and the client re-syncs from SyncKey 0 (spec-sanctioned).
  `folderCollectionClasses` is now unused (kept so rows load). FolderSync still uses `folderSyncKeys["$foldersync"]`;
  its key may now carry `#uid`. New collection needs no index migration beyond the entity's own `@Index`.

**Other fixes**
- 3: `WbxmlDecoder` caps elements 50k / children 10k / depth 64, bounds-checks OPAQUE and string-table lengths,
  throws `WbxmlDecodeError`/`WbxmlLimitError` -> HTTP 400. service-core has no per-route body limit (confirmed:
  only global `max_body_size`), so `BaseEasRoute` rejects `mail:eas:max_request_bytes` (16 MB) by Content-Length or
  rawBody length with 413.
- 4: ComposeMail requires every `From` and any `Sender` to be the mailbox's primary/alias (403), caps envelope at
  500 (400), strips `Bcc` (with folds) from the relayed copy only (`stripHeader`). Calendar Add organizer must be
  own address, else primary; a Change never reassigns organizer (attendee copies keep the real organizer).
- 5: Ping (done by a sub-agent, reviewed): one shared subscriber per Redis URL with per-listener
  subscribe/unsubscribe, one active Ping per (mailbox, device), `ctx.res.onFinish` cancels (new optional `res` on
  `EasCommandContext`), Status 6 + `MaxFolders` over `mail:eas:ping_max_folders` (300), ACL checks in chunks of 25,
  no-Redis waits the heartbeat.
- 7: FolderSync SyncKey 0 returns every folder as Add (all pages) with the new key; later rounds classify by
  creation time vs cursor (created after -> Add, deleted-and-created-after -> skipped).
- 8: remote-wipe request clears `policyKey`; any Provision request while a wipe is pending gets the directive;
  unsolicited wipe ack is Status 2; `BaseEasRoute` requires `X-MS-PolicyKey` (or `PolicyKey` query) == stored key for
  everything but Provision/Settings (449). Route tests send the header via a `policyKeyOf()` helper.
- 10: Calendar Change keeps attendee fields the device didn't send and the series' exceptions; bumps `sequence` on
  time/location/attendee/recurrence change (normalized compare - SQL `null` vs Mongo `undefined`); DayOfMonth/
  MonthOfYear fallback computed in the event's timezone (`localDayAndMonth`, UTC fallback).
- 11: `Flag` container (`FlagStatus` token) both ways; `DeletesAsMoves` (default true -> Deleted Items via
  `findOrCreateWellKnownFolder`, hard delete inside Deleted Items or with `0`); `FilterType` (Email 1-5 receivedDate,
  Calendar 4-7 endDate/recurring, Tasks 8 incomplete) applied to Adds only - a changed FilterType answers Status 3
  (simplest spec-plausible choice: items aging out of the window are not soft-deleted); `WindowSize` (collection then
  request level) capped by config and 512; `GetChanges 0` honoured.
- 12: MoveItems rejects a destination outside the message's own mailbox; Sync Add uses the folder's `mailboxUid`;
  Email Add only in Drafts (Status 6); a new Draft always gets a body blob.
- 13: `WbxmlEncoder` builds a `Buffer[]` with one concat (+ optional `maxBytes`); ItemOperations caps embedded
  content at `mail:eas:itemoperations_max_response_bytes` (64 MB) -> that Fetch gets Status 11 (attachments
  pre-checked by `sizeBytes`, re-checked after load).
- 14: GetItemEstimate uses the collection row (dry-run of the same enumeration), falls back to remembered class then
  folder type. MeetingResponse processes every `Request` (<=100) with per-Result Status (2 invalid/denied/not found,
  3 write failure), accepts an Inbox meeting-request Message uid (READ on its folder, `text/calendar` UID ->
  caller's own event, series master preferred), decline deletes only with DELETE (else records DECLINED), and mails
  an iTIP REPLY (restapi `buildEventIcs`; `respond()`'s mailer isn't exported) only when `SendResponse` is present
  (16.x semantics - 14.x clients send their own reply, so no duplicate).
- 15: Sync caps 300 collections (top Status 4) / 512 commands per collection (collection Status 4); MoveItems caps
  500 (400); SmartReply/Forward flag flip needs UPDATE and is best-effort after send; attachment Fetch checks READ on
  the message's current folder.
- Manifest gained `mail:eas:max_request_bytes`, `mail:eas:ping_max_folders`,
  `mail:eas:itemoperations_max_response_bytes`.

**Test notes**: `test/EasCollectionSync.test.ts` (fake repo evaluating the real query shapes), rewritten
`SyncCommand.test.ts`/`MeetingResponseCommand.test.ts`, a "Round-3 protocol fixes (end to end)" block in both route
files. Full-suite runs intermittently failed with 404/ECONNRESET/204 while *other repos'* vitest runs (restapi) were
active - they share mongo port 9999 / HTTP 3737; rerun when those finish (each file passes alone).

### 2026-09-14 (2) — Round-2 review fixes (remote-wipe purge, ResolveRecipients DoS/status, labelUids, Draft-only body)

Each finding was confirmed in code first. Not committed; no version or peerDependency changes.

- **Cleanup job purged pending remote wipes.** `EasDeviceStateCleanupJob` deleted stale and never-synced rows
  even with `remoteWipeRequested: true`, so a lost device that reconnected later re-paired without being
  wiped. Both queries now also filter on `remoteWipeRequested` via a protected
  `noPendingWipeQueryValue()`. Mongo uses `ne(true)`, which matches `false`, `null` and a missing field.
  `EasDeviceStateCleanupJobSQL` overrides it with
  `Raw("(col IS NULL OR col = :noPendingWipe)", false)`, because SQL `!=`/`NOT IN` never match `NULL`
  (`ne(true)` there would have made unset rows unpurgeable). Both backends' job tests cover this.
- **ResolveRecipients DoS.** The number of `<To>` elements was unbounded, and each one cost 3 regex queries.
  More than `MAX_RESOLVE_RECIPIENTS_TO` (100, per [MS-ASCMD]'s "MUST NOT contain more than 100 To elements")
  now gets top-level Status `5` (protocol error) with no queries. That code comes from the spec as recalled;
  the repo holds no copy of it to check against. An empty or whitespace-only `To` would have compiled to
  `regex()`, matching every contact. It now gets that recipient's Status `4` without a query.
- **ResolveRecipients error mapping.** Every exception used to become a per-recipient Status `4`, including DB
  outages. Now only an `ApiError` with status 400 (e.g. a pattern service-core rejects) does. Anything else
  fails the whole command with top-level Status `6` (server error) and is logged at error level.
- **`labelUids` spliced into `in(...)`.** `resolveLabelNames()` now skips any entry that isn't a lowercase
  UUID. `me` would have become the caller's uid (or a 403), and a comma would have split one value into several.
- **Manifest.** Added `"mailboxScopedData": true` to `rapidmx.plugin`, since `DeviceSyncState` is
  `@MailboxScopedData`. `test/plugin.test.ts` asserts it; the installed `parsePluginManifest` ignores the
  unknown field.
- **Sync `Change` could overwrite a received message's original MIME (outside-diff check: real).** Evidence:
  - `SyncCommand.applyChange` accepts `Email` Changes for any folder the caller can UPDATE, not just Drafts.
  - `EmailSyncAdapter.fromApplicationData` reused `existing.bodyBlobKey` and `put()` over it.
  - Body blobs are shared: restapi's `ScanQueueJob` gives an inbox-rule copy the same `entry.rawBlobKey` as
    the delivered message, so one overwrite rewrote both.
  - Retention and erasure jobs and `DataExportJob`/mbox read that blob as the original RFC 5322 source.
  - [MS-ASCMD]/[MS-ASEMAIL] only allow `Add`/`Change` of the body for Drafts.

  Fix: `EmailSyncAdapter` gained an abstract `folderClass` (`FolderMongo`/`FolderSQL` in the concrete
  adapters). A `Change` carrying `Body` for a message whose folder isn't `FolderType.DRAFTS` (or no longer
  exists) throws `ApiError` 400, which `applyChange` reports as Status `6`. Nothing is written. Body writes
  (Draft Add or Change) now always mint a fresh `bodies/<uuid>` key, never overwriting. Non-body Changes
  (Read/Flag) on non-drafts are unaffected and do no folder lookup.
  - Follow-up (not done): a Draft's superseded blob is now orphaned, and so is one whose `update()` then fails
    its version check. Deleting the old blob inline was avoided because it could be shared.
  - Still open: Subject/To/Cc/Bcc/Importance Changes on non-drafts still update DB fields. The blob stays
    intact, but the spec disallows these too.
- Tests:
  - `test/commands/ResolveRecipientsCommand.test.ts`: Status 5 at 101 `To` elements, 100 still OK, empty `To`
    gets 4 with no query, non-400 errors give Status 6.
  - `test/adapters/EmailSyncAdapter.test.ts`: non-UUID labelUids, fresh blob key, non-draft body refused,
    non-body Change still applied.
  - `test/routes/{mongo,sql}/EasRoute.test.ts`: Draft Change writes a new key, and an Inbox body Change gets
    Status 6 with the original MIME byte-identical.
  - Both cleanup-job tests; `test/plugin.test.ts`.

### 2026-09-14 — Review-finding fix pass (perf batching, WBXML NUL injection, regex length, GAL guard)

Each finding was confirmed in code before fixing (the reviewer's line numbers were stale, the code shapes matched).
Not committed; no version/peerDependency changes.

- **Label/Search N+1 batched.** Added optional `EasCollectionSyncAdapter.toApplicationDataBatch(items)`;
  `EmailSyncAdapter` implements it by grouping distinct `labelUids` per `mailboxUid` and fetching each group
  with one `uid: in(...)` find (chunked at 500, `limit` in both query and options, since `RepoUtils.find()`
  defaults to 100 rows). `toApplicationData()` delegates to it. `SyncCommand` renders adds+changes in one
  batch call (falling back to per-item for adapters without it). `SearchCommand`'s Mailbox branch now loads
  all hits with one `uid: in(...)` find instead of a sequential `findOne` per hit, and memoizes
  `hasPermission` per `folderUid`; relevance order, duplicate hits and stale-entry skipping are unchanged.
  Categories now come out in `labelUids` order (was DB order). Supersedes the "one `find()` per labelled
  message" tradeoff noted in the 2026-09-13 (2) entry.
- **WBXML `STR_I` NUL injection.** `WbxmlEncoder.writeStrI` strips U+0000 (UTF-8 emits 0x00 for no other code
  point), so a user-controlled label name/subject can no longer terminate the inline string early and inject
  tokens. The NUL is built via `String.fromCharCode(0)`: tool edits typing an escaped NUL wrote a literal 0x00
  byte into the source twice this session. Check with `file` that a source file still reads as text.
- **Regex length guard.** `service-core`'s `regex()` rejects operands over its private
  `ModelUtils.MAX_PATTERN_LENGTH` (100), checked after escaping, so a metacharacter-heavy term under 100 raw
  chars could 400 the whole command. New `src/RegexPatternUtils.ts` `boundedEscapedPattern()` truncates the raw
  term per code point so the escaped form fits. Used by GAL Search and ResolveRecipients. ResolveRecipients
  also now catches a per-recipient lookup failure and reports that recipient as Status `4`, not failing all.
- **GAL without a SearchProvider.** `SearchCommand.handle()` no longer requires `searchProvider`; only the
  Mailbox branch checks it (500 if missing).
- README package names updated to `@rapidmx/activesync-plugin` / `@rapidmx/autodiscover-plugin`.
- Tests: new `test/commands/ResolveRecipientsCommand.test.ts`, `test/RegexPatternUtils.test.ts`; extended
  `SearchCommand.test.ts`, `EmailSyncAdapter.test.ts`, `WbxmlCodec.test.ts`, and both `EasRoute.test.ts`.

### 2026-09-13 (3) — Switched GAL search from `like()` glob-wrapping to `regex()`, matching the `mapi` plugin's own fix

JP pointed out the sibling `mapi` plugin hit the exact same `service-core` 2.0 `like()`-glob regression this repo
fixed two entries below, and its own follow-up commit (`424bd27`) went further: switched from escaping-then-
wrapping a glob pattern for `like()` to using the newer `regex()` operator directly. Checked out `mapi`'s actual
diff (not just its commit message) before assuming the same applies here - it does, cleanly:

- **`regex()` (`@rapidrest/service-core` ^2.0) takes a real, unanchored regular expression**, case-insensitively
  compiled on both backends (Mongo `$regex`/`$options:"i"`; SQL `~*`/`REGEXP`/`better-sqlite3`'s custom `REGEXP`
  function) - substring matching is its *default* behavior, unlike `like()`'s anchored glob translation, which
  needed wrapping the term in `*...*` to get the same effect. `StringUtils.escapeRegExp(query)` (already in
  `@rapidrest/core`, no new dependency) escapes every regex metacharacter *including* `*`/`?` - closing the one
  residual gap the glob-wrap approach couldn't: a search term containing a literal `*` or `?` no longer acts as
  a wildcard, since `regex()` has a real escape mechanism where glob syntax has none.
- Replaced `SearchCommand.ts`'s `globPattern()`/`ResolveRecipientsCommand.ts`'s duplicate of it with a direct
  `StringUtils.escapeRegExp(...)` call at each of the two call sites - no wrapping function needed at all now,
  since `regex()` doesn't require the `*...*` dressing `like()` did.
- **`regex()` is independently validated by the framework** (`ModelUtils.isUnsafeRegexPattern`) against
  catastrophic-backtracking shapes *and* a 100-character pattern length cap - neither applies to `like()`. Since
  the entire query is escaped before it ever reaches the operator, no unescaped metacharacter can form one of
  the rejected shapes; the length cap is a real, if practically unlikely, new constraint (a GAL/ResolveRecipients
  search term over 100 characters now gets a framework-level 400 it wouldn't have before) - worth knowing if a
  future report ever traces back to it, not worth engineering around today for names/partial-address queries.
- Added a regression test per command, per backend (`"a.b"` matching `"a.b Corp"` but not `"aXb Corp"`) - the
  exact shape that would have failed under either the pre-2.0 assumption (double-escaping) or an unescaped
  `regex()` call (over-matching), mirroring `mapi`'s own added coverage for the identical fix.

### 2026-09-13 (2) — Closed the deferred `Message.labelUids` → Categories gap

JP asked to address the remaining gap the prior entry deliberately deferred. Implemented it after all, since the
real blocker (widening `EmailSyncAdapter.toApplicationData()` to async) turned out cheaper than first estimated:

- **Widened `EasCollectionSyncAdapter.toApplicationData()` to `WbxmlElement | Promise<WbxmlElement>`** - the
  exact same optional-async shape `fromApplicationData()` already had (for `EmailSyncAdapter`'s own `BlobStore`
  write), just applied to the other direction. `SyncCommand.itemToCommandElement()` and
  `SearchCommand.messageToResult()` (both call sites) now `await` it; the three adapters that stay synchronous
  (`Contacts`/`Calendar`/`Tasks`) are unaffected - `await` on a non-`Promise` value resolves immediately.
- **`EmailSyncAdapter` is now `abstract`** with a `protected abstract labelClass: any`, resolved via its own
  `@Init` into a `Label` repo (mirroring every command's own `RepoUtils` construction pattern - adapters go
  through the identical `ObjectFactory.newInstance()` DI lifecycle as commands, confirmed by reading how
  `SyncCommand.init()` already constructs each adapter this way). Added `EmailSyncAdapterMongo`/`SQL` concrete
  subclasses (`src/adapters/{mongo,sql}/`, a first for this adapter - every other adapter stays a single
  shared class since none of them needed a backend-specific model class before) and rewired
  `SyncCommandMongo`/`SQL`'s `Email` binding and `SearchCommandMongo`/`SQL`'s own adapter construction to the
  new concrete classes instead of the old bare `EmailSyncAdapter`.
- **Read-only**, unlike `Contact.categories`: a `Label` is a real mailbox-scoped entity referenced by uid, not a
  free-form string array, so a write path would need to resolve category name strings back to `Label`s *and*
  create new ones on the fly for names that don't exist yet - real added scope deliberately left as a
  documented gap, matching this adapter's own existing precedent for `Email2:ConversationId`.
- **One `find()` per message that actually has labels** (`labelUids` empty/absent short-circuits before ever
  touching the repo), not batched across a whole `Sync` page or search result set - a documented, modest N+1
  tradeoff accepted rather than widening the adapter interface further to let a caller pre-resolve names for an
  entire batch. A stale `labelUids` entry (the `Label` was since deleted) is silently dropped via the same
  `in(...)` query-DSL operator confirmed working in the `SyncCommand`/`ResolveRecipientsCommand` fixes above.
- **Test harness gap found while writing the first integration test**: `test/server-{mongo,sql}/models/index.ts`
  (the named re-export list gating which `@DataStore` classes the test `ClassLoader` actually discovers) didn't
  include `Label{Mongo,SQL}` at all - `EntityMetadataNotFoundError` on the very first `createLabel()` call.
  Added it alongside the other eight model classes already listed in both files.

### 2026-09-13 — Caught up to `restapi` 0.8.x (65 commits: E2E encryption, search overhaul, compliance roadmap); added Mailbox-store Search

JP asked for a full review of `restapi`'s activity since this repo's `0.3.1` pin, including its new
`specs/end-to-end_encryption.md`/`specs/search.md` design docs, and to implement whatever ActiveSync-protocol-
relevant surface it now supports. Bumped `@rapidmx/restapi` to `0.8.x` and `@rapidrest/service-core` to `2.x`
(restapi's own peer range moved to `service-core` 2.x's query-DSL overhaul).

**Scoping pass**: the overwhelming majority of the 65 commits (S/MIME digital signatures, end-to-end encryption
key vault/escrow/discovery, GDPR export/erasure, Legal Hold/Matter/eDiscovery, mailbox import, data retention,
Label entity + mail filter action, `FolderType.ARCHIVE` + archive REST action, SES transport, S3 blob store) are
either pure server/admin/compliance features with no EAS wire mechanism at all, or - for E2E specifically -
fundamentally client-side crypto (key generation/wrapping/S-MIME construction happens on the device; this
library's `SendMail`/`SmartForward`/`SmartReply` already relay a client-supplied raw MIME blob unmodified, so a
client that builds its own S/MIME structure already round-trips through this library with no changes needed).
Two genuinely new things landed:

- **Fixed real breakage from the version bump** (not new features, but required for the bump to be usable at
  all):
  - `FolderType.ARCHIVE` (new restapi enum member) broke `FolderSyncCommand`'s exhaustive `Record<FolderType,
    string>` map - `tsc` catches this (confirmed via `npx tsc --noEmit`, which `yarn lint`/`yarn test` do NOT
    run - worth remembering: neither of this repo's two actual gates type-checks `Record<Enum,X>`
    exhaustiveness, only a real `tsc` invocation does). Mapped to the same Type `12` (generic user folder)
    fallback as `USER`/`JUNK` - MS-ASCMD's `FolderHierarchy` `Type` enumeration has no dedicated Archive code.
  - **`@rapidrest/service-core` 2.x's `like()` operator now compiles glob syntax (`*`/`?`) instead of the old
    per-backend split this file's own doc comments described (Mongo: raw unanchored regex; SQL: exact-unless-
    `%`-wrapped)** - confirmed by reading `ModelUtils.ts`'s `globToLike()`/`globToRegExpSource()` directly, not
    assumed from the changelog. This was a real, silent functional regression risk: `SearchCommand`/
    `ResolveRecipientsCommand`'s existing `escapeForLikeQuery()` backslash-escaped regex metacharacters
    (`. ( ) + ? ^ $ { } | [ ]`) on the assumption Mongo's `like()` compiled to raw regex - but neither
    `globToLike` nor `globToRegExpSource` recognize a backslash as an escape at all, so a query containing any
    of those characters (e.g. searching "jane.doe" or "a+b") would have started matching a literal backslash
    that was never in the stored data, breaking the match entirely. Fixed by replacing the escape function with
    a plain `*query*` glob-wrap (`globPattern()`) - the framework's own doc comment for `globToLike` explicitly
    says a literal `*`/`%`/`_`/`?` can't be fully escaped either way ("a narrow, documented limitation"), so
    over-matching on those four characters is accepted, not worked around. Also deleted the now-provably-false
    per-backend `likePattern()` abstract hook and all four Mongo/SQL overrides, since both backends behave
    identically under the new glob translation - a real simplification, not just a bug fix.
  - `restapi`'s `BaseMessageRoute`/`ScanQueueJob` now unconditionally `@Inject("DnsResolver")` (federated-peer
    detection for the new receipt/encryption-key scoping) - `Server.start()`'s eager route instantiation failed
    outright in every integration test with "No class found with name: DnsResolver" until a `StaticDnsResolver`
    test double (always throws NXDOMAIN-shaped errors, matching "no `_rapidmx` record") was registered in
    `testDoubles.ts` alongside the existing `BlobStore`/`SearchProvider`/etc. doubles.
  - `SearchProvider` interface gained `candidates()` (Tier 3 candidate-set query) - added a trivial
    implementation to `NoopSearchProvider` so it still satisfies the interface.
  - `Message` gained a new required `encrypted: boolean` field - added to `EmailSyncAdapter.test.ts`'s
    `baseMessage` fixture (along with four already-required receipt fields the fixture had apparently never
    actually carried - `tsc -p tsconfig.test.json` was never run as a gate here either, so this had been
    latently wrong since the receipt feature landed and nothing caught it).
- **Added EAS `Search` for the `Mailbox` store** (previously `GAL`-only) - real mailbox full-text search,
  backed by `restapi`'s now much richer `SearchProvider` (the search overhaul in `specs/search.md`: operator
  grammar, `folderUid`/`flags`/`hasAttachments` schema, Tier 3 candidates). **Pragmatic subset**: only `Class`
  `Email` (matches the `GAL`-only precedent this file already set for search generally - Contacts/Calendar/
  Tasks search via `Mailbox` store is a documented gap); only the common real-world `Query` shape -
  `Class`/`CollectionId`/`FreeText`, optionally grouped under one `And` (both forms accepted, since the schema
  permits omitting the wrapper) - not the full recursive `And`/`Or`/`GreaterThan`/`LessThan` boolean-tree
  grammar. Each hit is re-verified for `READ` on its own current `folderUid` before being included -
  `SearchProvider`'s index is scoped by `mailboxUid` alone, not per-folder ACL, so (unlike `GAL`, whose
  `Contact.find()` query is already mailbox-scoped end to end) this is the one place in this command that still
  needs a per-result ACL check, the same "orphaned folderUid" pattern already established for `ItemOperations`
  Move. A stale index entry whose `Message` has since been hard/soft-deleted is silently skipped, not treated
  as an error. `SearchResultPage` carries no total count (full-text relevance search doesn't compute one
  cheaply), so `Total` here honestly means "how many matches this request's own capped fetch actually
  returned," not an exact server-side count - documented as an approximation, same spirit as `GAL`'s own
  already-approximate status-code enumeration. Result properties reuse `EmailSyncAdapter.toApplicationData()`'s
  own field mapping directly (its `.children`) rather than a second parallel mapping, so `Search` and `Sync`
  can never render the same message differently.
- **Considered and rejected**: wiring the new `EncryptionPolicy` singleton (tri-state
  `automatic`/`optional`/`prohibited`, independently per same-org/federated/external recipient tier) into
  `ProvisionCommand`'s existing `RequireSignedSMIMEMessages`/`RequireEncryptedSMIMEMessages` policy booleans.
  The semantics don't actually line up: MS-ASPROV's fields mean "the device MUST sign/encrypt every outgoing
  message," a blanket per-device mandate, while `EncryptionPolicy` is a nuanced per-recipient-tier default that
  can legitimately be `automatic` for one tier and `prohibited` for another - collapsing that into one boolean
  would misrepresent server policy to the device rather than honestly reflect it. No corresponding change made.

### 2026-09-08 (2) — Adversarial two-agent review #2, 6 confirmed findings fixed

JP asked for another full adversarial two-agent review (correctness/bugs-lens + security/performance-lens, same
pattern as the 2026-09-07 entry below) covering all of `src/`, including the conversation-`Move`/`ConversationId`/
`Categories` work from the same day's earlier session. Verified every claim against actual source (one agent
claim about `SyncCommand`'s watermark needed a framework-source read to confirm precisely) before fixing:

- **HIGH, fixed**: `ItemOperationsCommand.moveConversation` fell through to `Status "1"` (success) even when
  every message sharing the `ConversationId` was skipped for lacking `UPDATE` - a device could be told a move
  succeeded when nothing moved. Now tracks whether any message actually moved and returns `Status "3"` if not.
- **HIGH, fixed**: `PingCommand` never checked ACL on client-supplied folder uids before subscribing to their
  Redis pub/sub channels - the one command in the codebase that had this gap (every other command checks
  ownership on a client-supplied id). Concretely: a device that once had a folder shared with it could keep a
  live activity signal for that folder indefinitely, even after the share was revoked, since `Ping` never
  re-checks. Now filters the requested folder list down to only those the caller currently has `READ` on
  before subscribing (not a hard failure - `Ping`'s wire response has no per-folder status to report a partial
  denial through, and a client has no way to know its access changed before it re-sends the same list).
  `PingCommand.test.ts`'s own bespoke minimal config double (deliberately DB-less, since `Ping` itself needs no
  database) can't construct a real `ACLUtils` via `ObjectFactory` - added a `createCommand()` test helper that
  stubs `aclUtils` directly after construction instead.
- **MEDIUM, fixed**: `EmailSyncAdapter.fromApplicationData` ghosted `To`/`Cc` as one combined group rebuilt from
  scratch rather than per-type against `existing.recipients` - a `Change` touching only `To` silently dropped
  any existing `Cc`. `Bcc` (MS-ASEMAIL2's own tag, already in the codec's tag table) was never handled in either
  direction at all. Both fixed together: each of `To`/`Cc`/`Bcc` is now ghosted independently, and `Bcc` is
  read/written symmetrically with the other two (including in the built Draft MIME's own `Bcc:` header).
- **MEDIUM, fixed**: `SyncCommand.applyDelete`'s watermark used a fresh `new Date()` captured after
  `repo.delete()` resolves - a deliberate prior-session fix for duplicate-Delete redelivery, but with its own
  narrow trade-off: since `computeChanges()` snapshots the folder *before* this round's own Delete runs, a
  genuinely concurrent unrelated write to a different message in the same folder landing in that narrow window
  could end up permanently skipped once the watermark advances past it. Fixed by re-reading the now-soft-deleted
  row's own real `dateModified` via `repo.findOne(uid, {ignoreACL:true, includeDeleted:true})` instead of
  approximating with wall-clock time - `RepoFindOptions.includeDeleted` already exists on the base `RepoUtils`
  (confirmed by reading `service-core`'s own source), no need for a `RecoverableRepoUtils`-specific cast.
- **LOW/performance, fixed**: `ItemOperationsCommand`'s `Fetch` loop had no cap on Fetches per request (each
  fully buffered in memory) - added `mail:eas:itemoperations_max_fetch` (default 25), rejected outright like
  `DeleteSubFolders`/`DocumentLibrary` rather than silently truncated.
- **LOW/performance, fixed**: `emptyFolderContents`/`moveConversation` ran unbounded `find()` queries. Added
  `mail:eas:itemoperations_batch_size` (default 500) and switched `emptyFolderContents` to a batched loop
  (repeated bounded `find()`+delete rounds until the folder is actually empty - a soft-deleted row stops
  matching the same query, so this always terminates) and capped `moveConversation`'s own query with the same
  limit.
- **Real bug found and reverted while fixing the above**: my first pass parallelized both batches' writes via
  `Promise.all` (independent rows, seemingly safe) - broke the SQL backend outright with `SqliteError: cannot
  start a transaction within a transaction`. `better-sqlite3` shares one connection per request and each
  `delete()`/`update()` opens its own transaction, so concurrent writes against it always fail; confirmed via
  a real failing SQL test run, not assumed. Reverted to sequential writes in both spots - only the read-only
  ACL permission checks (independent, no shared-connection transaction) are still parallelized via `Promise.all`
  in `moveConversation`. Worth remembering for any future "these look independent, parallelize them" instinct
  in this codebase: reads are fine, writes sharing the SQL connection are not.
- Two agent claims were investigated and found to already be correct as-is, not re-reported: `ItemOperations`
  Move's destination-folder ownership check itself (sound), and the WBXML codec's opaque/length encoding
  (round-trips correctly, verified against the codec's own passing round-trip tests).

### 2026-09-08 — Caught up to `restapi` 0.3.x: Categories, ConversationId, conversation `Move`

JP asked for a full review of `restapi`'s activity since this repo last pinned `0.2.x` (25 commits: iTIP meeting
invites, resource-mailbox auto-accept, `DistributionList`, `TransportRule`, `MailFilterRule`, MDN read/delivery
receipts, `Domain`/DNS setup, `Branding`, Focused Inbox, `Message.conversationId`/`conversations()`, recall,
`AuditLogEntry`, `TaskList`, anonymous booking, plus-addressing) and to implement whatever of that is actually
**ActiveSync-protocol-relevant** - the task was explicitly scoped to what MS-ASCMD itself has a wire mechanism
for, not every new `restapi` feature. Bumped the `@rapidmx/restapi` dependency to `0.3.x`/`^0.3.1`.

- **Scoping pass first, before writing any code**: most of the new surface has no EAS wire equivalent at all
  and was deliberately left alone - `TransportRule`/`MailFilterRule` (no rules-management command in this
  library's MS-ASCMD subset), `Domain`/DNS setup/`Branding`/`AuditLogEntry` (admin/server config, never
  device-facing), Focused Inbox classification (an Outlook/OWA concept with no MS-ASEMAIL field), resource
  auto-accept and iTIP invite generation (transparent at the SMTP/calendar-sync level already - the resulting
  `CalendarEvent` just shows up via ordinary `Sync`), `Message.recall()` (no MS-ASCMD analog), plus-addressing
  and MDN receipts (transparent at delivery time, nothing for a device to see or set). `Contact.favorite`/
  `Task.myDay` also have no MS-ASCONTACTS/MS-ASTASK wire field to land on - left unmapped, matching this
  library's own precedent of documenting a gap rather than inventing a field.
- **`Contact.categories` (new `restapi` field) → MS-ASCONTACTS `Categories`/`Category`** in
  `ContactsSyncAdapter`, both directions. Ghosted as its own whole group, same rule as `emails`/`phones`/
  `addresses`: absent `Categories` element leaves it untouched, a present one (even empty) rebuilds it.
- **`Message.conversationId` (new `restapi` field) → MS-ASEMAIL2 `Email2:ConversationId`**, read-only, in
  `EmailSyncAdapter.toApplicationData`. Encoded as the uid's own UTF-8 bytes in a WBXML `OPAQUE` element
  (`encodeConversationId`/`decodeConversationId`, now exported from `EmailSyncAdapter.ts`) rather than hashed
  into a 16-byte GUID shape - the spec never mandates a particular binary format, a device only ever compares/
  echoes the value byte-for-byte, and this way `decodeConversationId` inverts it exactly.
- **Closed `ItemOperationsCommand`'s own long-documented gap**: conversation `Move` ("this library has no
  conversation-grouping concept for `Message` at all") is now implemented, using the `ConversationId` decoded
  the same way. Every `Message` sharing the decoded `conversationId` across the *whole mailbox* (not just one
  folder - a conversation can span folders) that the caller has `UPDATE` on is relocated to `DstFldId`; one
  lacking permission is silently skipped rather than failing the whole move (mirrors a shared-folder scenario,
  not a new pattern). `MoveAlways` is accepted but not acted on - no conversation-scoped `MailFilterRule`
  condition exists to key an ongoing rule off of; documented, not silent data loss (the move itself still
  happens). Query is deliberately scoped to `ctx.mailboxUid`: `conversationId` is derived from the RFC 5322
  thread (`References`/`In-Reply-To`/`Message-ID`), which can genuinely collide across two different mailboxes
  that both received the same thread - unscoped, a `Move` could reach into a mailbox that never even
  participated in the request.
- **Real bug found and fixed, outside this repo's own code**: `@rapidrest/service-core`'s `test/request.js`
  (the `request()`/`agent()` helper every route-level test in this repo uses) configures its underlying axios
  client with `responseType: "text"`, which silently replaces any response byte sequence that isn't valid
  UTF-8 with U+FFFD *before the test ever sees it* - corrupting the WBXML `OPAQUE` token itself (`0xC3`) in any
  response carrying real binary content. This is why `ItemOperationsCommand.fetchAttachment` was already
  base64-text-encoding attachment `Data` instead of using this codec's own `opaqueElement` for it - sidesteps
  this exact test-harness limitation (whether or not that was the original reason, it has the same effect).
  Confirmed the corruption is test-harness-only, not a wire-format bug: reproduced the exact byte-for-byte
  round trip correctly through raw `uWebSockets.js` directly (`res.end(buffer)` preserves arbitrary bytes
  fine) - a real device's own HTTP stack is unaffected. Didn't touch the sibling `service-core` checkout for
  this (out of scope, not asked); instead added a `postWbxmlBinary` helper to both `test/routes/{mongo,sql}/
  EasRoute.test.ts` that reads the response over a raw Node `http` socket, used only by the handful of new
  tests that assert on `ConversationId`'s exact opaque byte content - every other test's response content is
  plain text and unaffected by the bug, so `postWbxml` (via the shared helper) stays the default.
- Also found and cleaned up: two stale, gitignored `rrst-test`/`rrst-test-acl` SQLite files at the repo root
  left over from a session predating the `restapi` 0.3.x bump - `ec7d387` (receipts) added several new
  required `Mailbox` boolean columns with no SQL-level `DEFAULT`, so `TypeORM`'s `ADD COLUMN` migration against
  those stale files' pre-existing rows failed with `NOT NULL constraint failed`. Not a real bug (a fresh test
  DB never hits this), just a local artifact; deleting them let `synchronize()` create the columns correctly
  from scratch. Worth knowing if this resurfaces: it means a real deployment doing an in-place `synchronize()`
  upgrade across this specific `restapi` version bump would hit the same failure against a populated `Mailbox`
  table - a `restapi`-side migration concern, not this repo's.

### 2026-09-06/07 — Practical full EAS compliance push

JP asked to finalize this package toward full `MS-ASCMD` compliance (scoped decision: every command a real
client uses, explicitly excluding `Notes`/`DocumentLibrary`/`RightsManagement`/`Find`/`AirNotification` -
legacy corners even mature reference servers barely implement). Landed as a sequence of independently-tested
commits, each keeping the 95%/100%/100%/100% coverage gate green:

- **Real bug found and fixed first**: `RepoUtils.update()` (service-core) never mutates its `existing`
  argument - it returns a freshly-fetched instance with the bumped `version` instead, filtering the DB write
  by the *patch's* `version`. Every `DeviceSyncState` writer (`ProvisionCommand.persist`,
  `FolderSyncCommand`/`SyncCommand.persistSyncKey`, `BaseEasRoute.dispatch()`'s trailing `lastSyncAt` write)
  discarded that return value and kept reusing the same in-memory object, so a *second* write within one
  request silently matched zero rows. Added `EasSyncKeyUtils.persistDeviceSyncState()` as the one correct way
  to write it going forward. This was masking itself as `lastSyncAt` never persisting; left unfixed it would
  have broken multi-collection `Sync` (below) silently.
- **`restapi` gained new `DeviceSyncState`/`Mailbox` fields** (`folderCollectionClasses`, `remoteWipeRequested`/
  `remoteWipeAccountOnly`/`remoteWipeAcknowledgedAt`, `oofEnabled`/`oofMessage`/`oofStartTime`/`oofEndTime`).
  **Gotcha**: `oofMessage` needed `@Nullable` despite being a required `string` - this framework's
  `ObjectUtils.validate()` treats an empty string as equivalent to null/undefined for any non-nullable field,
  and this field's natural default (no Oof configured yet) is `""`.
  **Portal links don't work across these sibling repos** - tried `portal:../restapi` +
  `portal:../../rapidrest/service-core` to test against local changes before JP published; even with
  `--preserve-symlinks` (both Node's CLI flag and Vite's own `resolve.preserveSymlinks`, needed for different
  reasons), each repo's own separately-`yarn install`ed `node_modules` produces a second physical copy of
  `@rapidrest/core`/`@rapidrest/service-core`, breaking `instanceof ApiError`/decorator-metadata identity
  across the boundary. Vite's own resolution made it worse, not better, when forced to preserve symlinks (one
  path resolved to a raw `.ts` source file with no build step). Reverted; JP published both packages for real
  instead (`service-core` 1.5.0, `restapi` 0.2.0) and this repo just bumped its own dependency ranges - the
  "right" fix for a true monorepo (shared root `node_modules`) doesn't apply here since these are separate
  standalone repos, each with their own lockfile.
- **`service-core`'s real `OPTIONS` discovery fix (`hasExplicitOptionsRoute`) was NOT actually left
  uncommitted** as the previous entry below claims - it was already committed locally (`c8cde0b`) just not
  pushed to `origin`. Pushed and released as 1.5.0; confirmed live end-to-end here (updated the two
  integration tests that previously documented the CORS-intercepts-everything behavior).
- **`Sync` now handles multiple `<Collection>`s per request** (previously answered only the first) - all
  per-collection `SyncKey`/remembered-`Class` writes for one request batch into a single
  `persistDeviceSyncState` call at the end, never one per collection (exactly the bug above). `Class` can now
  be omitted after a collection's first (`SyncKey "0"`) request too, remembered in the new
  `folderCollectionClasses` field.
- **`EasCollectionSyncAdapter` widened**: `fromApplicationData` may return a `Promise` now, and adapters are
  instantiated via `ObjectFactory` (`adapterClass`, not a pre-built `adapter` instance) so one can `@Inject`
  its own dependencies. This unblocked **`Email` Draft `Add`/`Change` via `Sync`** (previously `Email` only
  accepted client-originated `Delete`) - plain-text-only, no attachments. `Message.bodyBlobKey` is documented
  as holding raw MIME "unmodified from ingestion/send", and `ItemOperationsCommand.fetchMessage` parses it
  with `simpleParser` unconditionally, so a Draft's body is wrapped in a minimal hand-built RFC 5322 message
  rather than stored as bare text - keeps that contract intact for every consumer, not just this write path.
- **`MeetingResponse` decline now soft-deletes the `CalendarEvent`** (matching real Exchange) instead of just
  flipping the caller's own `Attendee.responseStatus` - each attendee already has their own row
  (`mailboxUid`-scoped), so this only removes the meeting from the declining attendee's own calendar.
- **New WBXML tag tables**: `Move`/`ItemEstimate`/`ResolveRecipients` pages, previously registered as enum
  values only. `GetItemEstimate`'s modern (14.0+) shape reuses `AirSync`'s own `Collections`/`Collection`/
  `Class`/`CollectionId`/`SyncKey` via `SWITCH_PAGE`, not `ItemEstimate`'s own legacy `Folders`/`Folder`
  tags - same cross-page-reuse pattern `ItemOperationsCommand.fetchMessage` already used.
- **Three new commands**: `GetItemEstimateCommand` (read-only, never touches a `SyncKey`), `MoveItemsCommand`
  (`Message` only, verifies claimed source folder + destination folder ownership), `ResolveRecipientsCommand`
  (GAL substring match, duplicating `SearchCommand`'s own matching logic rather than extracting a shared
  `GalMatcher` DI abstraction for just two call sites - not worth the new plumbing). Both `Move`/
  `ResolveRecipients` use an honest binary Status mapping (success vs. one generic failure code), matching
  `ProvisionCommand`'s own established precedent, rather than a byte-exact code enumeration nobody could
  verify without the published spec in hand.
- **`Settings` gained `Oof` `Get`/`Set`** - single combined reply message (not the spec's three
  audience-specific variants), `StartTime`/`EndTime` use MS-ASDTYPE's plain `dateTime` type (not Calendar's
  Compact DateTime - a real, distinct MS-ASSETTINGS detail, not assumed).
- **`MS-ASProtocolVersions` now also declares `16.0`/`16.1`** (previously withheld specifically because `Oof`
  was missing) - `RightsManagementInformation` remains unimplemented but doesn't gate the version string,
  since `MS-ASProtocolCommands` (derived live from registered handlers) is the real capability gate.
- **`ItemOperations` now handles multiple `<Fetch>`es per request** (previously first-only), `Options`/
  `BodyPreference` (`Type 4` returns raw MIME verbatim, others truncate to `TruncationSize` on a UTF-8-safe
  boundary), rejects `Store: DocumentLibrary` with 400, and implements `EmptyFolderContents` (soft-deletes a
  folder's messages, rejecting `DeleteSubFolders`). **Corrected a wrong assumption before writing any code**:
  the original plan treated `Store` as a write/upload op and `ItemOperations`' own `Move` as a simple
  per-message move - a research pass against Microsoft's published `MS-ASCMD` XSD confirmed `Store` is actually
  just a required `Fetch` child selecting `"Mailbox"`/`"DocumentLibrary"` (a selector, not a write), and `Move`
  here relocates an entire *conversation* via `ConversationId` (unrelated to the standalone `MoveItemsCommand`
  above) - `ItemOperations` has no write capability at all, and conversation-`Move` stays an explicit,
  documented gap.
- **`Provision` now enforces real policy**: password/encryption requirements are `@Config`-driven
  (`mail:eas:provision:*`, permissive-but-not-empty defaults), and phase-2 acknowledgement now actually reads
  the client's own per-`Policy` `Status` - anything but `"1"` (missing included) is rejected without
  provisioning, not just a `PolicyKey` mismatch as before.
- **Full three-step `RemoteWipe` flow implemented**, riding the existing `DeviceSyncState.remoteWipeRequested`/
  `remoteWipeAccountOnly`/`remoteWipeAcknowledgedAt` fields and the pre-existing 449 provisioning gate (no new
  transport plumbing needed - a wiped device is simply forced back through `Provision` next request): admin
  sets the flag → `ProvisionCommand.issuePolicy` sees it and sends a `RemoteWipe` directive instead of a policy
  document → device wipes and acks with a bare `<RemoteWipe><Status>1</Status></RemoteWipe>` → flag clears but
  `provisioned` deliberately stays `false`, requiring a genuine fresh handshake to re-add the account.
  `remoteWipeAccountOnly` is recorded for admin audit only - the wire directive doesn't distinguish full-device
  vs. account-only wipe, since that split needs an MDM-capable client extension out of this library's scope.
- **New admin route**: `BaseDeviceSyncStateRoute` (`POST /:uid/remote-wipe`, `@Auth(["jwt"])` +
  `trustedRoles`/`UserUtils.hasRoles` gating, same pattern as `restapi`'s `BaseMailboxRoute`) - lives in this
  package rather than `restapi` since `DeviceSyncState` is protocol-internal, not a domain object `restapi`
  otherwise exposes a route for.
- **This closes out the practical-full-compliance roadmap** - every item from the original scoping conversation
  has now landed (multi-collection `Sync`, Email drafts, `ItemOperations` write-adjacent behaviors, the three
  new commands, `MeetingResponse` decline, `Settings`/`Oof`, and `Provision`/`RemoteWipe`).

### 2026-09-07 — Adversarial two-agent code review, 7 confirmed findings fixed

JP asked for a full code review via two adversarial agents (one security-lens, one correctness-lens),
reviewing all of `src/` independently in parallel, followed by manual verification of every claim against the
actual source before trusting it (two low-confidence agent claims didn't survive verification and were
dropped). Then fixed the whole confirmed list, one commit per finding/theme:

- **CRITICAL, fixed**: `SyncCommand.applyChange`/`applyDelete` resolved a client-supplied `ServerId` via
  `repo.findOne(ignoreACL:true)` and mutated/deleted it with **no ACL check and no ownership verification at
  all** - a device could target another mailbox's item by uid. `computeChanges()` had the identical gap for
  reads (a crafted `CollectionId` belonging to another mailbox's folder returned that folder's full content).
  This was the one place in the codebase that dropped the "ACL-check after an `ignoreACL` lookup" pattern every
  sibling command (`ItemOperationsCommand`, `MoveItemsCommand`) already used consistently - not a new pattern
  invented for the fix, a restored one. Now requires `READ` on the folder before touching anything in
  `processCollection()`, `CREATE`/`UPDATE`/`DELETE` respectively in `applyAdd`/`applyChange`/`applyDelete`, and
  `applyChange`/`applyDelete` re-verify the resolved item's own `folderUid` matches (treated as "not found",
  never distinguishable from a genuinely missing item).
- **HIGH, fixed**: `GetItemEstimateCommand` had the identical missing-ownership-check root cause for its own
  `CollectionId` - smaller blast radius (a count leak, not content).
- **MEDIUM, fixed**: `EmailSyncAdapter.buildPlainTextMime()` interpolated client-supplied Subject/To/Cc
  directly into RFC 5322 header lines with no CRLF sanitization - `WbxmlDecoder.readCString()` only stops at a
  NUL byte, so literal `\r\n` bytes in a decoded string survive untouched, enabling header injection into a
  stored Draft's MIME (and whatever gets sent later, if that draft is sent for real).
  Fixed with a `sanitizeHeaderValue()` fold-to-single-line helper at the actual interpolation sink.
- **MEDIUM, fixed**: `ItemOperationsCommand.fetchMessage()` computed `EstimatedDataSize` from the body *after*
  truncation, contrary to MS-ASAIRSYNCBASE (should be the pre-truncation size) - captured before truncation now.
- **LOW/moderate DoS, fixed**: `WbxmlDecoder`'s `readTagElement`/`readContentUntilEnd` recursed with no depth
  cap (unlike every length-prefixed field in the format) - ~2 bytes of wire format per nesting level could
  drive a stack-overflow `RangeError` from a tiny request. Added `MAX_NESTING_DEPTH = 200`.
- **LOW, fixed**: `SearchCommand`'s `Range` element built `${start}-${Math.min(end, matches.length - 1)}`,
  producing the malformed `"0--1"` when a GAL search matched zero contacts. Clamped to 0.
- **LOW, fixed**: `SyncCommand.applyDelete` captured its watermark via `new Date()` *before* the actual
  `repo.delete()` call - moved to after the write resolves, so the persisted SyncKey watermark can no longer
  understate the delete's real effective time (was causing occasional harmless duplicate Delete redelivery).
- **Two agent claims did NOT survive verification** and were dropped rather than reported: a "narrow duplicate
  Add" race in `EasSyncKeyUtils.computeChanges()`'s 1-second newly-created tolerance window (requires two writes
  within ~100ms of each other spanning two sync rounds - real but practically unreachable), and a claim that
  `EasCommandContext.policyKey` being unchecked was a live vulnerability (it's already self-documented in that
  interface's own doc comment as a deferred, known gap - re-flagging your own documented TODO isn't a finding).

### 2026-09-06 — Repo split: `@rapidrest/mail` → four RapidMX packages

- **This repo is `@rapidmx/activesync`**, carved out of the former monolith `@rapidrest/mail`
  (`d:\github\rapidrest\mail`, still present there for reference/history) — was `src/eas`/`test/eas`
  there, moved to this repo's own root (not nested under an `eas/` folder).
- Depends on [`@rapidmx/restapi`](https://github.com/RapidMX/restapi) for the mailbox/folder/message/
  contact/calendar/task models, `resolveCallerMailboxUid`/`RecoverableRepoUtils`/`sendComposedMime`
  REST-layer helpers, `BlobStore`, and the scan pipeline. Originally linked locally via Yarn Berry's
  `portal:../restapi`; switched to the real published `^0.1.0` once JP published it to npm - see the
  very next bullet for exactly why the portal approach was a real problem, not just a temporary
  convenience.
- **Mechanical migration gotcha** (same one hit in the `autodiscover` split, see that repo's notes
  for the fuller writeup): several distinct old import targets collapse onto the same new
  `@rapidmx/restapi` specifier, producing duplicate-import lint errors that needed hand-merging in
  `test/testDoubles.ts` and a few `src/commands/*.ts` files.
- **Real bug found and fixed: `vitest.config.ts`'s `ssr.noExternal` must list `@rapidmx/restapi`
  too, not just `@rapidrest/service-core`/`@rapidrest/core`.** Without it, Vite's SSR pipeline
  bundles/transforms the framework packages for the test file's own direct imports but treats
  `@rapidmx/restapi` as external (untransformed, natively `require`d) - producing TWO separate
  module instances of `@rapidrest/service-core` inside the SAME test process: one Vite-transformed
  (used by the test file and `Server`/`ConnectionManager`), one natively loaded (used by any code
  reached *through* `@rapidmx/restapi`, e.g. `findOrCreateWellKnownFolder`/`RecoverableRepoUtils`).
  Symptom: `ModelUtils`'s static `typeOrm` field (set once by `TypeOrmSupport.connect()`) is only
  visible on ONE of the two instances, so any restapi-side code hitting a SQL query building path
  throws "no SQL datasource has been initialized" - manifesting as a bare 500 on `SendMail`/
  `SmartForward`/`SmartReply`/`MeetingResponse`, since the framework's own `instanceof ApiError`
  error-mapping also silently swallows the real cause. Diagnosed by temporarily instrumenting the
  installed `node_modules/@rapidrest/service-core` `Server.js`/`TypeOrmSupport.js` with
  `console.error` (removed once confirmed - never commit node_modules edits). **Any future split
  package that itself calls into `@rapidmx/restapi` needs the same `ssr.noExternal` entry.**
- **Second, unrelated gap found while chasing the above**: this repo's own `test/server-mongo`/
  `test/server-sql` harness only mounted `EasRoute` - but several EAS tests simulate "the user
  renamed/deleted an item via the webmail REST API" by calling `PUT`/`DELETE /sql/folders/:id`
  and `/sql/messages/:id` directly, which needs `FolderRoute`/`MessageRoute` (from
  `@rapidmx/restapi/mongo`/`sql`) mounted too - not just re-exported as models. Added trivial
  one-line mount files for both, mirroring the monolith's own `test/server-{mongo,sql}/routes/
  {Folder,Message}Route.ts`. `test/server-{mongo,sql}/models/index.ts` was also narrowed from a
  wildcard `export *` (which pulled in every REST route/job class from `@rapidmx/restapi`,
  registering classes this harness has no business initializing) to a named export of just the
  8 model classes EAS actually needs.
- For the original design rationale behind the WBXML codec, the SyncKey watermark-cursor design, the
  per-command `EasCollectionSyncAdapter`s, and every other decision baked into this code, see the
  monolith's own `.claude/NOTES.md` (`d:\github\rapidrest\mail`) — that history wasn't duplicated
  here since it predates this repo's existence.

### 2026-09-07 — Spec-compliance audit: real `OPTIONS` discovery added; Sync gap clarified

- **JP asked whether this package is fully `MS-ASCMD`-compliant or a partial subset.** Answer: partial,
  deliberately. Real gaps beyond the ones already documented in `README.md`/source comments, confirmed
  by reading the actual handler code (not recalled from memory):
  - `SyncCommand.handle()` never reads the request's own `<Commands>` element at all - no
    `findChild(collection, "Commands")` anywhere in the file. A real client's device-originated
    `Add`/`Change`/`Delete` (e.g. creating a new Contact/Calendar event/Task directly in the phone's
    native app, or saving a Drafts-folder item) is silently dropped - not rejected, not erred, just
    never looked at. `SendMail`/`SmartForward`/`SmartReply` are unaffected (separate commands, already
    fully working) - only Contacts/Calendar/Tasks/Drafts creation-on-device is the real gap.
  - No `OPTIONS` capability discovery (now fixed, see below).
  - Auth (`@Auth(["jwt"])`, no OAuth Authorization Server of its own) - JP confirmed this is **already**
    solved at the deployment level: `@rapidrest/auth`/`@rapidrest/auth-server` mint the JWT, and
    `auth.mydomain.com`/`mail.mydomain.com` sharing one parent domain means the browser/OS hands that
    JWT to this package via a domain-level cookie automatically. Not a gap in practice for that
    deployment shape - the `README.md` wording ("tracked as a follow-up in `@rapidrest/auth`") stays
    accurate as written (it correctly says the piece lives outside this package), just worth recording
    that it's not an open problem for JP's own actual deployment.
- **Fixed the `OPTIONS` discovery gap for real**, across two repos:
  1. `@rapidrest/service-core` (`d:\github\rapidrest\service-core`, a sibling checkout - not one of the
     four split packages): added `IHttpRouter.hasExplicitOptionsRoute(path)` (implemented in both
     `HttpRouter`/uWS and `BunRouter`/Bun, tracking literal non-`/*` paths registered via `.options()`,
     normalized for a trailing-slash mismatch either side), and changed `Server.ts`'s global CORS
     middleware to skip its blanket preflight `204` when that returns `true` for the request path -
     letting an app's own `@Options()` handler run instead. Verified via the full existing suite
     (1153/1153 passing) plus new unit tests on both routers and a new end-to-end `Server.test.ts` case
     (a fixture `@Options("capabilities")` route now actually answers with its own JSON body, while an
     unregistered path still gets the old blanket `204`). **Left uncommitted in that repo** - it's JP's
     own separate project, not something to commit without being asked there specifically.
  2. This repo: `BaseEasRoute.ts` gained a real `@Options()` handler (deliberately unauthenticated,
     matching real Exchange's own posture - capability discovery isn't mailbox access) answering
     `MS-ASProtocolVersions: 14.0,14.1` (confirmed via `[MS-ASHTTP]`/`[MS-ASWBXML]` research - 14.0 is
     the floor for the MIME-based `ComposeMail` code page this package's `SendMail`/`SmartForward`/
     `SmartReply` actually use; 16.0/16.1's `Oof`/`RightsManagementInformation` aren't implemented, so
     not claimed) and `MS-ASProtocolCommands` built dynamically from `this.handlers.keys()` (never a
     separately-maintained list that could drift from what a concrete subclass actually registers).
     **This only takes effect once the app's `@rapidrest/service-core` dependency actually includes the
     fix above** - on today's currently-published `service-core`, the CORS middleware still always
     answers `OPTIONS` with a bare `204` before this handler is ever reached. Tested via a direct
     method call in `test/routes/BaseEasRoute.test.ts` (proving the handler's own header-building logic
     is correct) rather than a real HTTP round trip, since the currently-pinned published `service-core`
     wouldn't exercise the new code path at all yet.

### 2026-09-06 — Closed the client-originated Sync `Commands` gap (audit item #4)

- **JP confirmed this specific gap (not `SendMail`, already working) should be fixed now.** `SyncCommand`
  now reads the request's own `<Commands>` element and applies `Add`/`Change`/`Delete` for
  `Contacts`/`Calendar`/`Tasks` - a device creating/editing/deleting an item directly (the normal way a
  phone's native Contacts/Calendar/Tasks apps behave against an EAS account) now actually persists.
  `Email` accepts `Delete` only - `Add`/`Change` still answered with Status `6`, since `[MS-ASCMD]` itself
  disallows non-draft email `Add` and this pragmatic subset doesn't implement Drafts-via-`Add` or
  Read/Flagged-via-`Change` (composing/sending goes through `SendMailCommand` instead) - a documented gap,
  not silently dropped, same as before.
- Verified the exact `Responses`-element inclusion rule from `[MS-ASCMD]`'s own "Add (Sync)"/"Sync" spec
  pages rather than assuming it: `Add` always gets a `Responses/Add` entry (must report the assigned
  `ServerId`); `Change`/`Delete` only get one on **failure** - a silent response means "assume it worked."
  Status codes used: `1` success, `6` client/server conversion error (malformed item, or no adapter support
  at all for that collection/operation), `7` conflict (optimistic-concurrency version mismatch), `8` object
  not found.
- `EasCollectionSyncAdapter` gained two **optional** interface members - optional is the deliberate
  capability-gate mechanism, not a separate flag that could drift out of sync with what an adapter actually
  implements:
  - `fromApplicationData(el, existing?)`: the reverse of each adapter's existing `toApplicationData`,
    implemented for `Contacts`/`Calendar`/`Tasks` (not `Email`). Ghosts per MS-ASCMD's own rule - a field's
    tag missing from the request means "leave it unchanged," not "clear it" - so the same method serves
    both `Add` (partial merged onto a fresh entity) and `Change` (partial merged onto `existing`).
  - `newEntityDefaults()`: supplies defaults a brand-new entity needs regardless of what the client sent.
    Only `CalendarSyncAdapter` implements it (`icalUid`/`sequence`) - EAS's own `Add` has no wire
    representation for either, and the model's own constructor default of `icalUid: ""` for every
    Sync-created event would violate RFC 5545's uniqueness expectation for `UID`. Mirrors MAPI's identical
    `RopSaveChangesMessageHandler` pattern (`${crypto.randomUUID()}@mapi`), `@eas` suffix instead.
- `SyncCommand`'s own `@Init` now builds `RecoverableRepoUtils` (from `@rapidmx/restapi`) instead of plain
  `RepoUtils` - the exact same fix `BaseMapiEmsmdbRoute.ts` already needed for MAPI, necessary here because
  `SyncCommand` now originates its own soft-deletes via `applyDelete` (plain `RepoUtils.delete()` doesn't
  bump `dateModified`/`version`, which would silently break this same class's own watermark-based deletion
  detection for anything deleted via `Sync` instead of the REST API).
- Watermark advancement: computed the outgoing `changes` (server-side Adds/Changes/Deletes to report)
  against the *old* watermark, *before* applying this round's own incoming `Commands` - otherwise a
  client's own fresh write would echo straight back as a `Commands` entry in the very same response. After
  applying, the persisted watermark only ever extends forward past what `computeChanges()` itself already
  found (`Math.max` against the actual `dateModified` of successful writes) - never jumps straight to "now"
  unconditionally, which would silently skip not-yet-enumerated pending changes whenever
  `changes.moreAvailable` is `true`.
- **Testing split**: real version-conflict (Status `7`) and several malformed-item/no-adapter branches
  can't be reached through a real single-request HTTP+DB round trip by construction (`SyncCommand` always
  echoes back the `version` it just read in the same request, so `applyChange`'s own optimistic-concurrency
  check can only fail from a genuine concurrent write racing between its `findOne()` and `update()` calls -
  not reproducible deterministically over real HTTP). Added a new isolated `test/commands/SyncCommand.test.ts`
  (fake repo/adapter doubles, same "poke a private field, mirror `MeetingResponseCommand.test.ts`'s own
  precedent for an unreproducible race" pattern already used elsewhere in this repo) for those branches,
  alongside real HTTP+DB round-trip tests in both `test/routes/{mongo,sql}/EasRoute.test.ts` for the
  reachable happy/not-found paths (Contacts/Calendar/Tasks Add creating a real persisted record, Calendar
  Add's `icalUid`/`sequence` defaults, Contacts Change/Delete against a real record, Email Add rejected,
  Email Delete accepted) and new `fromApplicationData` unit tests per adapter
  (`test/adapters/{Contacts,Calendar,Tasks}SyncAdapter.test.ts`, new files - ghosting/error-path edge cases
  are far more precise to verify directly than by threading malformed WBXML through a full round trip).

### 2026-09-25 - release bump levels follow upstream

When releasing packages that depend on each other (rapidmx: restapi / react-shared -> web-client -> meet-plugin, booking-plugin, autodiscover, mapi, activesync, server; rapidrest: core / service-core -> auth / auth-server / react / cli and the projects built on them), the bump level of a downstream release matches the level of the upstream release it picks up: an upstream **minor** is a downstream **minor**, an upstream patch a downstream patch, major to major. Where a downstream bump crosses several upstream releases, use the highest level among them, and never choose "patch" just because the downstream's own diff is only a `package.json` bump. Betas keep their prerelease line but follow the same idea - say which level was chosen.

Why: meet-plugin 0.4.2 and booking-plugin 0.5.2 were cut as patches after web-client 0.15.x -> 0.16.0 and react-shared 0.17.0 -> 0.18.0 (both minors), and autodiscover 1.1.1 after restapi 0.20.1 -> 0.21.0; the downstream versions then hid additive behaviour. JP accepted those releases as they were (2026-09-25) and asked for the rule going forward. Releases only happen when JP asks for them.

### 2026-09-27 - SendMail/SmartForward/SmartReply were WBXML-only; every real 14.0+ client's send got stuck in Outbox

- **Root cause, found while diagnosing a live report (JP's own phone, powerlevel.gg): Gmail for Android could add the account and receive mail via ActiveSync, but every send stayed stuck retrying in the Outbox and never arrived.** `curl`ing `Microsoft-Server-ActiveSync?Cmd=Provision` with a real app password already returned `200` with a correct WBXML body, so auth/Provision were fine - the break was specific to `SendMail`. Per [MS-ASCMD], `SendMail`/`SmartForward`/`SmartReply` send their request body as **raw MIME** (`Content-Type: message/rfc822`) directly from protocol version 14.0 on - not WBXML-encoded at all, with `SaveInSentItems`/the source item's `ItemId` as URL query parameters instead of WBXML body elements. `BaseEasRoute.dispatch()` unconditionally WBXML-decoded every non-empty body regardless of command, and `ComposeMailCommand.handle()` only ever looked for a WBXML `<MIME>` element - the pre-14.0 wire format. Since `MS_AS_PROTOCOL_VERSIONS` here only ever advertises 14.0+, every spec-compliant client's `SendMail` hit a 400 (malformed WBXML, or no `MIME` element found) and got stuck in retry.
- **Fix, made a strict superset rather than a swap**, in case some client out there sends the legacy wrapped body despite negotiating 14.0+ (unverified, but cheap to keep working): `EasCommandHandler` gained an optional `rawBody` flag; `BaseEasRoute`'s new `decodeRawBodyRequest()` only WBXML-decodes a `rawBody` handler's request when the client's own `Content-Type` says `application/vnd.ms-sync.wbxml` (dispatch on Content-Type, exactly how real Exchange itself decides) - any other Content-Type (`message/rfc822`, or none at all) leaves `ctx.request` undefined so the handler reads `ctx.req.rawBody` directly. `ComposeMailCommand.handle()` (the shared base for all three commands) now branches on `ctx.request`: defined reads MIME/`SaveInSentItems`/`Source>ItemId` from WBXML exactly as before; undefined reads the MIME from `ctx.req.rawBody` and `SaveInSentItems`/`ItemId` from `ctx.query` instead.
- Verified against the live server directly (`curl` with a real app password) before writing any code, not just from spec-reading - the `Provision` round trip's clean `200` is what pointed at `SendMail` specifically rather than a broader auth/transport problem.
- Test suite: kept every original WBXML-shape test in `test/commands/ComposeMailCommand.test.ts` and `test/routes/{mongo,sql}/EasRoute.test.ts` (including the "Source present but missing its required ItemId" 400 case, still real for that shape) and added a parallel set for the raw-body shape (`Content-Type: message/rfc822`, `SaveInSentItems`/`ItemId` via query string) alongside them, plus one direct `BaseEasRoute` unit test for a `rawBody` handler with no `Content-Type` header at all (the one branch no real-HTTP test exercises). 876/876 passing, 100% statements/lines/functions, 98.34% branches (pre-existing gaps elsewhere, unrelated).

### 2026-09-27 (later same day) - hypothesis fix for an Android Gmail Provision loop that never lets a device finish provisioning

- **Same live device (JP's phone, powerlevel.gg), a second, separate problem found while retesting the `SendMail` fix above**: the phone never actually attempted a `SendMail` at all. Diagnosed without any server-side app logging (this app doesn't log per-request at info level) by reading the Envoy Gateway's own JSON access log instead (`kubectl -n envoy-gateway-system logs <shared-gateway-pod>`) - it has `x-envoy-origin-path`, method, and `response_code` per request. Over a full 45-minute window the device did nothing but `Cmd=Provision` (200) immediately followed by `Cmd=Ping` (449, our `HTTP_STATUS_RETRY_WITH`), forever, on two alternating persistent connections - never once reaching `SendMail`, `FolderSync`, or anything else. Every single `Provision` response was exactly 105 bytes, which only matches `ProvisionCommand.issuePolicy()`'s response (fresh-key issuance, request 1) - `acknowledgePolicy()`'s success response is a different, smaller shape - so the device was never once sending a request 2 (`PolicyKey` echoed back). It just keeps re-starting the handshake.
- **Could not get a byte-level capture to confirm the client's exact request shape**: the obvious next step (temporarily add `console.error` logging of the decoded request/encoded response around `BaseEasRoute.dispatch()`, the same technique the `SendMail` fix above used) turned out not to work on this deployment - JP confirmed the server pod's filesystem is not backed by any volume, so an in-place edit is lost the moment the process/pod restarts, and Node has already loaded the module into memory so an edit alone (without a restart) never takes effect either. No safe way to capture the real wire bytes was available this session.
- **Working hypothesis instead, backed by the deployment's own config rather than a byte capture**: this deployment runs every `mail:eas:provision:*` `@Config` at its default (confirmed via the Deployment's env - no overrides), which includes `require_device_encryption: true`. JP explicitly did not want to relax that. Root-caused instead to `ProvisionCommand.issuePolicy()` only ever sending 6 of the real `EASProvisionDoc` schema's ~40 fields - real Exchange and interoperable servers (Z-Push) always send the complete document, even at permissive defaults, and Android's Gmail EAS parser has a documented history of being defensive-but-brittle about a policy document missing fields it expects - silently discarding the whole thing (never sending an ack) rather than applying the parts it understood, which is indistinguishable from the outside from a network/auth failure.
- **Fix**: `easProvisionDocFields()` (new, replaces the inline 6-field array in `issuePolicy()`) now emits the full flat `EASProvisionDoc` field set (everything except the `Application`/`Hash` list-container elements, which are genuinely optional lists real servers omit when empty) - the 5 already-`@Config`-driven fields unchanged, everything else a fixed, maximally-permissive value. Also added the legacy `DeviceEncryptionEnabled` tag (pre-14.0, `0x10`) mirroring `RequireDeviceEncryption` (`0x1D`, added in 14.0) - some clients still key off the older tag. This is additive only: it can never make a deployment's actual enforcement (still just password/encryption, exactly as configured) any stricter or looser than before - only fills in what a strict client might already assume Exchange always sends.
- **Explicitly unverified against the real device** - JP was not willing to relax `require_device_encryption` just to test the old behavior's baseline, and the live-patch capture above wasn't viable, so this fix is shipped on the strength of the "known Android Gmail EAS-provisioning brittleness" pattern matching the observed loop, not a confirmed root cause. **Needs a real retest after this version reaches the live server** - if the loop persists, the next step is a client-side capture (e.g. a trusted-CA mitmproxy on the phone) to see the actual request bytes, since server-side introspection isn't available on this deployment.
- Added a second `ProvisionCommand.test.ts` case (non-default config values via the established "poke a private field via `as any`" pattern, same as `ComposeMailCommand.test.ts`) asserting the full document reflects config that differs from every field's default, including `DeviceEncryptionEnabled` tracking `RequireDeviceEncryption`. 877/877 passing (877, not 876 - one new test), 100% statements/functions/lines, 98.51% branches (`ProvisionCommand.ts` itself now at 100% branches; the new test closed the gap the wider field set would otherwise have opened). `yarn lint`, `npx tsc --noEmit -p .` clean. Not yet released - `RELEASE_NOTES.md`'s `## Unreleased` section has the entry, ready for the next version bump when JP asks for one.

### 2026-09-28 - beta.12 deployed, loop unchanged; shipping temporary diagnostic logging as a real release instead of live-patching

- **beta.12 (the fuller `EASProvisionDoc` above) made no difference on the live device** - confirmed by JP after deploying it. The "Android Gmail discards an incomplete policy document" theory from the previous entry is therefore wrong, or at least not the whole story; real wire-level evidence is needed, not another guess.
- **First tried to get that evidence without a release at all** (live-patching the running pod's compiled `node_modules` file, the same technique the original `SendMail` fix used) - dead end, for two independent reasons found this session: (1) this deployment's pod has no persistent volume backing its filesystem, so a restart (needed for Node to pick up an edited file - it doesn't hot-reload) reverts any in-place edit; (2) separately, this session's own tooling refused the remote-write step outright regardless (`kubectl cp`/`exec`-based writes to the live host are blocked by an operator-side policy). Also considered the local-tarball plugin-source override (`system:plugins:sources`, normally a local-dev-only mechanism - see the `server` repo's own NOTES.md) as a way to sideload a diagnostic build without a real npm release, but JP judged that more workaround than the straightforward alternative.
- **JP's call: just ship it as a real release**, same as every other fix in this file - simpler than any of the above. `BaseEasRoute.dispatch()` gained temporary `this.logger?.warn()` calls (tag `EAS_DEBUG`, to survive whatever this deployment's log level is) around the existing `Cmd === "Provision"` handling: one logging the decoded request tree and raw incoming body hex plus the device's stored `policyKey`/`provisioned` state *before* the command handler runs, one logging the raw outgoing response hex and the same state *after*. Deliberately scoped to `Provision` only (`if (cmd === "Provision")`), not a general request/response logger - this is purely observational, no behavior change, and is expected to be removed again in a follow-up release once it reveals the real cause.
- Pre-existing test suite covers both branches for free (the real end-to-end `Provision` round-trip tests in `test/routes/{mongo,sql}/EasRoute.test.ts` already exercise `cmd === "Provision"` with a real body both ways) - no new tests added. 877/877 passing, 100% statements/functions/lines; `BaseEasRoute.ts` branch coverage dipped slightly (two new always-non-empty-body branches no test exercises with a genuinely empty `Provision` body, which no real test constructs) but the file and the suite both stay comfortably above their 95%/100% thresholds. `yarn lint`, `npx tsc --noEmit -p .` clean.
- **No app-level `.debug()`/`.info()` calls exist anywhere in this codebase** (confirmed via grep before choosing `warn` over `debug`) - the framework's own `Logger()` factory (`@rapidrest/core`) defaults its winston level to `"debug"` already, so a log-level env var wouldn't have surfaced anything that isn't already being called at some level; the actual gap was simply that no code was logging the Provision bytes at all, at any level.
- Released as **v1.0.0-beta.13** (`yarn release prerelease --preid beta`, pushed). JP will deploy it to mail.powerlevel.gg himself and share the resulting `EAS_DEBUG` log lines once his phone (already looping continuously) has hit it a few times.

#### Follow-up (same day) — the trace: this library's handshake is correct; the loop is entirely client-side

JP deployed beta.13 and sent back ~90 seconds of `EAS_DEBUG` log lines (device `androidc71451855`, `Android-Mail/2026.09.07.986350278.Release`, `Pixel 10 Pro Fold`, `Android 17` - all very recent/beta software). The trace is unambiguous and rules out every theory this file's last two entries proposed:

- **Every single cycle completes a fully correct, spec-compliant two-step handshake.** Request 1 (`DeviceInformation` + a bare `Policies/Policy/PolicyType`, no key) gets a freshly minted key and the full `EASProvisionDoc` from beta.12's fix; request 2 arrives within tens of milliseconds, echoes that exact key back with `Status: 1`; the server's own before/after state confirms it: `storedPolicyKey` matches the key just issued, `provisioned` flips `false` -> `true`, `Status: 1` in both directions. No mismatch, no rejection, no malformed request, ever, across dozens of consecutive cycles.
- **The device throws that success away immediately.** Within another ~100-300ms of successfully provisioning, it sends a *brand new* request 1 (fresh `DeviceInformation` block, no `PolicyKey`) instead of ever presenting the key it just had validated to any other command. This repeats continuously - not a transient race, a sustained loop for the entire ~90s capture.
- **Cross-checked against the plain Envoy access log for a wider window**: after the Provision-only loop above, the same device later shifts into exactly the `Ping` -> 449 -> `Provision` loop first documented on 2026-09-27 (see that entry). So this is the same device alternating between two different self-defeating patterns over time, but never once reaching `FolderSync`/`Sync`/anything that would let mail actually flow, regardless of which loop it's in.
- **Conclusion: nothing in this library's `Provision`/`BaseEasRoute` implementation is the cause.** The server answers correctly, every time, by its own byte-level record. The client is discarding a state it itself just confirmed as valid - a bug (or intentional-but-broken retry logic) in that specific Gmail-for-Android build, unreachable from the server side. beta.12's fuller `EASProvisionDoc` (previous entry's fix) was therefore not wrong to add - it's still better spec-compliance/compatibility hygiene - but it was never going to fix this specific symptom, since the document was never the problem.
- **Diagnostic logging reverted** in this same session once the trace confirmed the root cause - see the `## Unreleased` `RELEASE_NOTES.md` entry above this one's sibling. `git diff` against beta.12's `BaseEasRoute.ts` is empty (clean revert, confirmed before committing); 876/876 tests pass, coverage back to beta.12's exact numbers (100% statements/functions/lines, 98.51% branches). `yarn lint`, `npx tsc --noEmit -p .` clean.
- **Recommended next step is client-side, not this repo**: try the account on a different EAS client (native Android Exchange account setup instead of the Gmail app, or a different device) to further confirm the client-side diagnosis, and/or check for a Gmail app update - not something to keep chasing here without new evidence pointing back at the server.

### 2026-09-28 - Always wait for CI to go green before releasing

Standing process rule, applies to every rapidmx/rapidrest repo: push pending commits, wait for the GitHub Actions **Build** workflow on that push to report `success` (`https://api.github.com/repos/<org>/<repo>/actions/runs`, or ask JP for the downloaded log archive if API log access needs auth - it 403s without a token), and only then run `npx @rapidrest/cli release ...`. Do not tag/release first and diagnose CI failures afterward. During a 2026-09-28 multi-repo release wave, restapi was released immediately after pushing pending commits without waiting for CI; CI then failed on a real coverage-threshold regression the pending changes introduced (a missing test for `BasePluginRoute.newestSearchResult()`'s catch branch) - not a flake, as an incomplete local-only reproduction first suggested. Because the release commit/tag were already pushed, the fix had to land as a follow-up commit on top of an already-tagged release instead of before it.

### 2026-09-28 (later) - Apple Mail "server error" reading any message: diagnostic logging (beta.15)

JP tested the live account with Apple Mail over ActiveSync: connects, syncs mail/calendar/contacts, sends fine - but opening any message to read it answers "server error." Read `ItemOperationsCommand.ts` (the `Fetch` handler) closely first: its own doc comment already documents that a `Fetch` failure aborts the whole request via an HTTP-level error rather than an embedded `Status` code (unlike `Move`/`EmptyFolderContents` in the same file) - so whatever throws inside `fetchMessage()` is exactly what Apple Mail is surfacing as "server error." Nothing jumped out from reading the code alone as a guaranteed-repro bug (message lookup, ACL check, and the three body-loading branches - sanitized HTML, raw-MIME-via-`simpleParser`, or verbatim MIME for `BodyPreference Type=4` - all look correct on inspection), and this is real production mail data I can't inspect directly, so per the established pattern from this session's earlier MAPI investigation, JP chose "ship a diagnostic beta first" over pulling logs immediately.

Added temporary `EAS_DEBUG`-tagged logging (`warn` level) to `fetchMessage()`: the message lookup (`serverId`, found, `folderUid`), the ACL permission check's result, entry into the body-loading block (`requestedType`/`TruncationSize`, `bodyBlobKey`/`sanitizedHtmlBlobKey` presence), and - wrapped in a try/catch around the whole body-loading block - the real error (with stack) on any throw before rethrowing unchanged. This should pin down, from the very next real capture, whether the failure is a missing/malformed `bodyBlobKey` on affected messages, an ACL check unexpectedly denying read, or an exception inside the blob store / `simpleParser` itself.

**Not yet verified**: against a real Apple Mail read attempt - this is the beta JP will deploy and reproduce against next. **To revert**: remove the three logging additions (two `this.logger?.warn()` calls plus the try/catch wrapper, restoring the original unwrapped `if/else if/else` body-loading block) once the real cause is confirmed from what this reveals - same lifecycle as beta.13's now-reverted `Provision` logging.

### 2026-10-05 - Three JP-reported bugs: Calendar sync permanently stuck after first new event, Contacts never sync, meeting invites not recognized

JP reported three issues in one session: (1) calendar invite emails never show as recognizable calendar invites on an EAS client (no accept/decline UI), (2) new Calendar events created after a device's first provisioning never sync to it - only what existed at setup time ever shows up, (3) Contacts never sync at all, not even the initial set at setup. JP's own working hypothesis for (1) was that restapi itself strips the ICS attachment from storage and only the web client's own invite-card rendering should be doing any hiding - checked directly against restapi's ingestion code (not assumed) and that is not what is happening; see below.

#### Bug 2 (Calendar): confirmed root cause, fixed

A structural ordering bug in SyncCommand's per-collection Sync handler, not anything Calendar-specific in isolation. The method called saveState() - persisting the round's new watermark/cursor to the device's DeviceSyncState - before calling the adapter's toApplicationDataBatch()/toApplicationData() to actually render the Add/Change items into WBXML. If rendering throws for even one item, the whole request dies with an uncaught error, but the new cursor was already committed, so the device's next sync starts from a watermark that already "knows about" the items it was never actually sent. Since the response never reached the device, those items are gone from sync forever, not just delayed - exactly "only what existed at setup ever showed up."

The likely trigger (found by code inspection, not a live capture): CalendarSyncAdapter.toApplicationData() dereferenced event.organizer.address and indexed the busy-status/attendee-type/attendee-status lookup maps with no fallback for a value TypeScript's compile-time types don't actually guarantee at runtime (a null from a column written before a default existed, or a value outside the current enum) - the same "TypeORM can hand back null for an unset column" hazard this file already documents elsewhere for reminderMinutesBeforeStart.

Fix, two parts:
1. SyncCommand.ts: moved the render call to run before saveState(), with a comment explaining why - a render failure now aborts the whole request before any state changes, so a retry replays the identical round against the identical (unmoved) cursor instead of corrupting it. This protects every collection class (Email/Calendar/Contacts/Tasks) against this exact class of bug, whatever specifically throws - not just Calendar.
2. CalendarSyncAdapter.ts: added defensive fallbacks for the organizer/busy-status/attendee-type/attendee-status lookups so a malformed/missing value renders something reasonable instead of throwing at all - belt-and-suspenders with fix 1, not a replacement for it.
3. Added error logging around the render call in SyncCommand.ts (collection/folder/item identifiers plus the real error and stack) before rethrowing, so a future render failure leaves a real trace server-side instead of the client just seeing a bare request failure.

Not yet verified against a live device - JP will need to deploy this and reproduce (create a new calendar event after a device is already provisioned, confirm it now syncs). Full test suite passing, type-check clean.

#### Bug 1 (meeting invites): root cause confirmed, fix in progress

Confirmed via direct code reading of restapi that it does not strip the ICS attachment - JP's own suspicion. The ingestion pipeline never mutates the raw message bytes, and every scanned attachment (the ICS part included) is persisted as a real blob and Attachment row, fully fetchable the normal way any attachment already is. The real gap is entirely in this repo: EmailSyncAdapter's render step never emits an Attachments element for any message (a broader gap than just invites), and never emits MS-ASEMAIL's MeetingRequest element - the actual spec mechanism a real EAS client uses to recognize an email as a calendar invite and offer accept/decline, not a literal ICS attachment the way IMAP/SMTP clients show one.

What's already available to build on: Message.meetingMethod is already persisted at ingestion - a cheap, already-there gate for "does this message need a MeetingRequest element" with no parsing required. The structured fields (start/end time, location, organizer, etc.) aren't on Message itself, so those need the raw message's ICS part parsed - restapi's own invite-parsing utilities already do exactly this and are what the web client's own accept/decline card already relies on, so reusing them here keeps one source of truth instead of a second, divergent parser.

First step taken: restapi's invite-parsing utilities were not part of its public package export (only the lower-level ICS parser was, even though Message.meetingMethod itself has always been public) - added them to the public export barrel and released restapi 0.31.0 (minor bump, purely additive). This repo's devDependency on restapi was then bumped to pick it up.

Implemented in EmailSyncAdapter.ts: toApplicationDataBatch() now also resolves, per batch (same one-query-per-batch pattern resolveLabelNames() already uses for labels, not one per message), every hasAttachments message's real Attachment rows into a general Attachments element (FileReference is the attachment's own uid, exactly what ItemOperationsCommand.fetchAttachment() already expects to look up directly), and every meetingMethod === "REQUEST" message's raw MIME into a MeetingRequest element, via a new resolveMeetingRequests() that fetches the blob and runs it through restapi's extractIcsFromRaw()/parseInviteIcs() in parallel across the batch. A message whose .ics can't be read/parsed, or that has no StartTime/EndTime, simply gets no MeetingRequest element - the email itself still syncs normally. BusyStatus/Sensitivity are fixed values (no source field in an invite's own file, same reasoning CalendarSyncAdapter already uses for its own Sensitivity); Recurrences/GlobalObjId/TimeZone are not emitted (the same documented pragmatic-subset gap CalendarSyncAdapter already carries for its own TimeZone).

Caught two real regressions before committing: a generic table-driven @Init-hook test (test/InitializeHooks.test.ts) didn't know about the new attachmentRepo/attachmentClass wiring and failed until its EmailSyncAdapter row was updated; and an initial defensive `if (!this.blobStore) return` guard in resolveMeetingRequests() left one line permanently uncovered (100% is a hard threshold here) - removed rather than tested, since every other use of blobStore in this file already assumes DI has set it with no guard, so the added guard was inconsistent dead code, not a real defensive need. Full suite 100% statements/functions/lines, build clean.

Committed and pushed (not released) per JP's explicit instruction to hold the activesync release until he can test it live.

#### Bug 3 (Contacts): confirmed root cause, fixed

First pass found nothing server-side: both the Mongo and SQL Sync command variants correctly register the Contacts collection class and its adapter; FolderSyncCommand correctly maps the Contacts folder type to its MS-ASCMD code; restapi's well-known-folder list includes Contacts, so a mailbox's Contacts folder is auto-provisioned the same as Calendar's; no Contacts-specific special-casing exists anywhere that could silently exclude it. JP confirmed (screenshots) the device's own Contacts sync toggle was already on, and the web client shows real contacts for the mailbox - ruling out both of the live hypotheses from the first pass.

That pointed back at ContactsSyncAdapter itself. Found it: `toApplicationData()` unconditionally dereferenced `contact.displayName`/`emails`/`phones`/`addresses` - every one typed as a *required* field, but (the exact same "TypeORM hands back `null` for a column written before a NOT NULL default existed, or by a path outside this library's own constructors" hazard already documented and fixed for `CalendarSyncAdapter`'s `organizer`/`reminderMinutesBeforeStart` earlier the same day) a real row can still hydrate one of these `null`. Confirmed this is a genuine crash, not just theoretical, by reading `WbxmlEncoder.writeStrI()`: it calls `.split()` on a rendered field's text unconditionally - `undefined` short-circuits earlier (`hasContent` is `false`), but `null` reaches `writeStrI(null)` and throws `TypeError: Cannot read properties of null (reading 'split')`. One contact anywhere in the mailbox with a null field crashes the WBXML encoding of the *entire* Sync response for Contacts - not just that one contact - matching "zero contacts ever sync" exactly (unlike Calendar's "stops after the first new item": Calendar's bug only hit on a *new* item added after setup, while a bad contact row that already existed at setup time fails every round from the first one). JP's own `ryan@powerlevel.gg` contact (no first/last name set, screenshot) matches the profile of a minimally-populated row this would affect.

Fix: `contact.displayName ?? ""`, `(contact.emails ?? [])`, `contact.phones ?? []`, `contact.addresses ?? []` - belt-and-suspenders with the already-shipped `SyncCommand.ts` render-before-saveState ordering fix (Bug 2), same as `CalendarSyncAdapter`'s own fallbacks: a malformed contact now renders with blank/empty fields instead of throwing, and even if some *other* crash reappears here later, the round is retried rather than permanently lost. Added a dedicated `toApplicationData` describe block to `ContactsSyncAdapter.test.ts` (this file previously had none - only `fromApplicationData` - the stated reason being "already exercised end-to-end," which is exactly how a real-data-only edge case like this slipped through): a happy-path baseline plus the null-hydration regression (asserts the adapter renders `FileAs: ""` and nothing else rather than throwing). Full suite 100% statements/functions/lines, build clean.

Not yet verified against JP's own live mailbox - next step is for him to pull this commit and confirm Contacts now sync.

### 2026-10-05 (later) - Live device testing of the three fixes above surfaced two more real bugs

JP tested beta.17+ (uncommitted at the time, now `69441c6`/`fa38edc`/`8550970`) live against a real Android device. Attachments now worked (first confirmation any of today's fixes actually helped in practice), but two new issues: (1) a real calendar invite ("Pick up kids", confirmed server-side correct via a web-client screenshot showing the full Accept/Tentative/Decline card with proper organizer/time/attendees) still showed on the EAS client as a generic email with a plain "attachment", not a recognized invite; (2) mail bodies - both a received message and JP's own composed replies - were visibly cut off mid-sentence on the device, while the same content was complete via the web client, and JP said his replies looked cut off "at the receiving end" too.

**Bug: invite not recognized despite a correct `MeetingRequest` element.** Re-examined MS-ASEMAIL/MS-OXOCAL: a real Exchange-compatible client's Accept/Decline UI is actually gated on the `MessageClass` element (e.g. `IPM.Schedule.Meeting.Request`), checked *before* the client ever looks inside `MeetingRequest`'s own children - `EmailSyncAdapter.render()` never emitted it at all. Since the web-client screenshot already proved `Message.meetingMethod` was correctly `"REQUEST"` server-side (same data this adapter's own `resolveMeetingRequests()` already keys off), this was the single missing piece, not a problem with the `MeetingRequest` content itself. Added `MESSAGE_CLASS_BY_METHOD` (`REQUEST`→`IPM.Schedule.Meeting.Request`, `CANCEL`→`IPM.Schedule.Meeting.Canceled`; `REPLY`/`COUNTER`/`PUBLISH` deliberately left without one - documented pragmatic-subset gap, same style as this file's other omissions) and emit `MessageClass` right alongside `Subject`. Not yet reverified against JP's device - if this alone doesn't fix it, `GlobalObjId` (the MS-OXOCAL-encoded iCalendar UID some clients also require for Accept/Decline round-tripping) is the next suspect, already a documented omission in `meetingRequestElement()`'s own doc comment.

**Bug: body cut off for both received and composed-reply mail, confirmed as one root cause, not two.** Traced the composed-reply path exhaustively first (`ComposeMailCommand.ts`'s raw-MIME relay, `BaseEasRoute.ts`'s body-size gate, restapi's `scanAndRelay()`/`stripHeader()`/`prependHeaders()`) and found no truncation logic anywhere in it - every one of those either passes bytes through unchanged or outright rejects an oversized request, never silently cuts it. That ruled out a send-path data-loss bug and pointed back at the same read-path gap `EmailSyncAdapter`'s own doc comment had assumed away: `Sync`'s `Email` body was *always* `message.bodyPreview` (a short, fixed-length ingestion-time preview) with `Truncated` hardcoded to `"1"`, regardless of what the device's own `Options/BodyPreference`/`TruncationSize` actually asked for - confirmed via grep that `BodyPreference` was read *only* in `ItemOperationsCommand`'s `Fetch` handler, never in `SyncCommand`/`EmailSyncAdapter` at all. The adapter's own prior doc comment assumed every real client would follow up a short Sync preview with an explicit `ItemOperations Fetch` to read the rest - true for some clients, evidently not JP's (a native Android Exchange account), which instead just displays whatever `Sync` gives it inline. Since JP's composed replies get synced back and re-rendered the exact same way (both the device's own view and, if the "receiving end" he checked is this same mailbox via another channel, the same underlying truncated-preview rendering), this single gap plausibly explains both halves of his report, not two separate bugs.

Fixed properly rather than special-cased: `SyncCommand.ts` now parses `Options/BodyPreference` into a `SyncBodyPreference` (`{ type, truncationSize }`) via a new `parseBodyPreference()`, threaded through a new, optional second parameter on `EasCollectionSyncAdapter.toApplicationData()`/`toApplicationDataBatch()` (every other adapter - Calendar/Contacts/Tasks - just ignores it; only `Email` needs this). `EmailSyncAdapter`'s new `resolveBodies()` mirrors `ItemOperationsCommand.fetchMessage()`'s exact own source-preference (prefer `sanitizedHtmlBlobKey` for an HTML request, else parse `bodyBlobKey`'s raw MIME via `simpleParser` for plain text) and truncation logic - batched in parallel across the whole `Sync` page via `Promise.all`, the same pattern this file already uses for `Attachment`/`MeetingRequest` resolution, rather than serially. `truncateUtf8()` (previously private to `ItemOperationsCommand.ts`) moved to the dependency-free `MimeHeaderUtils.ts` so both call sites share one implementation instead of two copies drifting apart - avoided a circular import, since `ItemOperationsCommand.ts` already imports from `EmailSyncAdapter.ts` (`decodeConversationId`). A device that sends no `BodyPreference` at all gets byte-for-byte the previous behavior (short preview, `Truncated: 1`) - zero behavior change for a client that doesn't ask for more, only for one that does and was being ignored.

Full suite 100% statements/functions/lines, build clean. Not yet reverified live - both fixes are pushed, uncommitted to any release per JP's standing hold on an activesync release until he's tested on his own device.

### 2026-10-05 (later still) - Body-truncation fix didn't help; live forensics on JP's own server found the real cause is a different command entirely

JP deployed the above (a real `yarn build; npm pack` + upload, confirmed), tested with a brand-new message - same problem, ruling out stale device cache as the explanation. He gave explicit permission to SSH into the live server (`mail.powerlevel.gg`, a k3s/kubectl deployment, same one `reference_powerlevel_test_server` memory already documents) to pull real evidence rather than keep guessing from code alone.

**What the logs showed first**: the live `SmartReply`/`SendMail`/`SmartForward` diagnostic log line (`ComposeMailCommand.ts`'s own existing `received N bytes (content-length ..., ...)`) - the device sends these via the **legacy WBXML-wrapped** format (`content-type: application/vnd.ms-sync.wbxml`), not the modern 14.0+ raw-MIME format, despite negotiating a newer protocol version. Two real `SmartReply` sends were logged there, both with byte counts that looked like ordinary short replies, not obviously truncated.

**What actually confirmed the bug**: read the real stored message bytes directly off the server's blob storage (`/app/data/blobs/<hash>/<hash>/bodies_<uid>`, filesystem-backed `BlobStore`, found via `kubectl exec ... find`) for JP's two closely-spaced test sends (via `message_mongo`'s `bodyBlobKey`, found by querying on `sentDate`). One was short and genuinely complete. The other - the one with quoted reply history ("Lots and lots more... Le 5 oct. 2026 12h08, jean-philippe@powerlevel.gg a écrit :") - was **truly cut off in storage**, ending mid-word: `"...Will you get th"` (should continue "...the whole message?"). This is real, confirmed data loss, not a rendering/display artifact - exactly matching JP's "receiving end" complaint, since the stored bytes are what actually got relayed.

**The critical misdirection, caught just in time**: this truncated message has **no `Message-ID`, no `In-Reply-To`/`References`, and a `Date` in `toUTCString()` format** - and crucially, **no matching `ComposeMailCommand` log line exists anywhere near its timestamp at all**. Its header shape is an exact match for `EmailSyncAdapter.buildPlainTextMime()`'s own construction (same field order, same `Date` format, no Message-ID - that function never adds one). This message was **not** sent via `SmartReply`/`SendMail` at all - it was composed as a Draft via `Sync`'s `Add`/`Change` to the Drafts folder (`EmailSyncAdapter.fromApplicationData()`), then relayed through some separate path afterward (Outbox move + scheduled send). Today's entire earlier investigation of this bug (`ComposeMailCommand.ts`, `scanAndRelay()`, `stripHeader()`, `applyThreadHeaders()`) was tracing the **wrong command** - all of that code is probably fine; it was just never what produced this particular truncated message. The live evidence is what caught this - code reading alone had no way to know which of two different compose paths a real device actually used for a given send.

**Diagnostic logging added** (temporary, matching this file's own established pattern - to be reverted once root-caused): `BaseEasRoute.dispatch()` now logs `EAS_DEBUG Sync IN` with the raw WBXML byte count the server actually received for a `Sync` request versus the client's declared `Content-Length` (rules in/out an HTTP body-reading truncation, the same category of bug already checked for `SendMail` but never for `Sync`). `EmailSyncAdapter.fromApplicationData()` now logs `EAS_DEBUG ... Body IN` with the decoded `Data` element's length plus a head/tail preview, read at the exact point before this method does anything else with it - this is the decisive one: if the logged string is *already* short, the device (or the WBXML decoder) delivered incomplete data and the bug is upstream of this method; if it's full, something in this method's own handling (which a prior reading found no truncation logic in) needs a second look.

Needs JP to redeploy this diagnostic build and reproduce the same way (a reply with enough quoted history to trigger it) before the real root cause can be confirmed - not yet known whether this is a device-side WBXML encoding issue, a `WbxmlDecoder` bug, or something else entirely.

**Conclusion: this server is not the cause - diagnostic logging reverted.** JP redeployed and reproduced the autosave flow with the logging live. The captured `EAS_DEBUG` sequence for one compose session (device `androidc71451855`) showed four consecutive `Sync Change` rounds against the same Draft as JP typed, each one a clean autosave snapshot: raw WBXML 747/923/1048/1258 bytes decoding to `Data` lengths 510/672/797/1007 - the per-round growth in raw bytes matched the per-round growth in decoded characters almost exactly every time (e.g. the third and fourth rounds' growth matched to the byte), meaning every round was received and WBXML-decoded completely and correctly, with no sign of loss anywhere in `BaseEasRoute`'s request handling or `EmailSyncAdapter.fromApplicationData()`'s own processing. JP then tried to force the original failure by typing fast and hitting Send immediately after finishing (the scenario most likely to race the device's own periodic autosave) - the full message went through intact on every side. Combined, this points squarely at a client-side timing race (the device relaying whatever its last *acknowledged* autosave snapshot was, when a send fires before a final autosave catches up) rather than anything in this library - this server received and handled every byte of every round it was ever sent correctly, confirmed directly from production evidence, not just code reading.

Diagnostic logging reverted (both `BaseEasRoute.dispatch()`'s `EAS_DEBUG Sync IN` and `EmailSyncAdapter.fromApplicationData()`'s `EAS_DEBUG ... Body IN`, plus the `@Logger` field the latter needed) - `git diff` against the pre-diagnostic commit is clean, build and full suite both clean. If this resurfaces, the next step is capturing the same `EAS_DEBUG` sequence for an actual failing send (not yet seen) to find what's different about it, rather than re-litigating the server-side path this evidence already clears.

Separately, in the course of this investigation JP also confirmed Contacts now sync correctly in both directions (server-to-device and device-to-server) when manually triggered - the Bug 3 fix above is confirmed working. Verified directly against the live server (`mongosh` into `rrst_auth`): all 4 of JP's contacts are correctly filed under the mailbox's Contacts folder, and `eas_collection_state_mongo` already shows 3 of them acknowledged as held by the device from activity on 2026-09-27/30 - this server-side state wasn't the problem.

### 2026-10-06 - New report: Calendar and Contacts both need a manual sync trigger; only Email auto-syncs in the background

Found while chasing "Contacts still aren't syncing" that it only happens *without* manually triggering a sync - manually syncing (or creating a contact on-device) works correctly immediately, both directions. JP then confirmed the identical symptom for Calendar - only Email ever updates in the background on its own, despite all three being enabled in the device's own account sync settings (screenshot confirmed: "Synchr. les contacts"/"Synchroniser agenda" both checked).

Read `PingCommand.ts` closely: EAS `Ping` (the long-poll a client uses to get near-real-time push notifications instead of polling) only watches whichever folder uids **the device itself includes in its own request** (`findChildren(foldersEl, "Folder")` - entirely client-supplied; the server has no way to add a folder the device didn't ask for). If this device's `Ping` only ever lists the Inbox (or Email folders generally) and never Calendar/Contacts, that would produce exactly this symptom - Email gets pushed updates instantly, Calendar/Contacts only update whenever the device happens to poll them on its own (e.g. opening the app, or whatever periodic interval its own Contacts/Calendar sync adapter uses, independent of EAS `Ping`) - a real, fairly common limitation of some native Android "account sync adapter" implementations, not something a server can make a client do differently.

Not yet confirmed - nothing previously logged what folders a `Ping` actually requests. Added temporary diagnostic logging (to be reverted once root-caused, same as above): `PingCommand.handle()` now logs `EAS_DEBUG Ping IN` (the raw requested folder uids plus the requested heartbeat) and `EAS_DEBUG Ping OUT` (which of those the server actually watched, after the permission filter, plus which ones it reported changed). Relevant folder uids for this mailbox, for reading the logs directly: Calendar `dd0fbdcb-4b6f-585c-acf4-61b7754d42c9`, Contacts `4163e225-c1eb-566e-8022-8af3013a647e`, Inbox `89e2589c-3aa2-577b-a53e-25c728f8f636`. Full suite 100% statements/functions/lines, build clean.

Needs JP to redeploy and leave the device alone for a while (no manual sync) so a real background `Ping` gets captured - if Calendar/Contacts are simply absent from `requestedFolderUids`, that confirms this is client-side and outside what this library can fix; if they ARE present but nothing ever reports a change for them, that points back at something in `pendingChanges()`/`waitForChange()` instead, which would be a real, fixable server bug.
