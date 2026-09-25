# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-beta.8] - 2026-09-25

### Fixed
- Fixed repository URL (again)

## [1.0.0-beta.7] - 2026-09-25

### Changed
- Document that a downstream package's release bump level follows its upstream dependency's, minor for minor, patch for patch and major for major, in NOTES
- Upgraded restapi dep

### Fixed
- Fixed repository URL

## [1.0.0-beta.6] - 2026-09-25

### Changed
- Bump the @rapidmx/restapi development dependency to 0.21.1 and refresh the lockfile, leaving the peer range unchanged
- Document the bump in the release notes

## [1.0.0-beta.5] - 2026-09-24

### Added
- Added tests proving a trusted-role caller without a real ACL grant is still denied, across all 8 affected commands and one real end-to-end Sync request

### Changed
- Cap WBXML STR_I inline-string decoding by a configurable total-byte limit, independent of the request-body-size check
- Compare a presented PolicyKey against the stored one with crypto.timingSafeEqual instead of plain inequality, in BaseEasRoute and ProvisionCommand
- Re-fetch and return the winning DeviceSyncState row when two concurrent first-pairing creates race the unique (mailboxUid, deviceId) index, instead of letting the loser's error propagate
- Upgrade the restapi dependency to 0.19.0 and tighten its peer range to a bounded floor, matching sibling plugin convention
- Route every mailbox-scoped ACL check through restapi's hasMailAccess/stripTrustedRoles instead of aclUtils.hasPermission directly, so the default admin trusted role no longer bypasses per-mailbox ACL grants
- Delete src/RestapiCompat.ts and replace its inline copies with restapi's own boundIndexedValue/asEntity exports now that the dependency is bumped
- Replace MimeHeaderUtils.ts's inline copies of restapi's extractOriginatorHeaders/hasAddressLikeDisplayName/checkOriginatorHeaders/isPlainAddress/safeDisplayName with re-exports, keeping only the two private helpers restapi doesn't export
- Updated rapidrest and rapidmx deps

### Fixed
- Fixed a SyncCommand test's stale expectation and the SearchProvider/DnsResolver test doubles to match restapi's current API surface
- Fixed ProvisionCommand.test.ts's wrong-key loop to stop silently skipping its intended empty-string case, and add a dedicated test for the empty-PolicyKey code path it actually takes

## [1.0.0-beta.4] - 2026-09-15

### Changed
- Upgraded restapi

### Fixed
- Fixed peer dep range for service-core

## [1.0.0-beta.3] - 2026-09-15

### Added
- Added GAL Search without a SearchProvider
- Added a display name that shows only the mailbox's own address, run Ping fallback scans 25 at a time, and reject DeviceId values me and null

### Changed
- Resolve Categories for a page of messages with one label query per mailbox instead of one per message
- Load Mailbox Search hits with one query and check READ once per folder instead of per hit
- Strip NUL characters from WBXML inline strings, which ended the string early and let the rest be read as tokens
- Shorten GAL Search and ResolveRecipients queries so the escaped pattern fits the regex length limit, and report a failed recipient lookup as that recipient's Status 4 instead of failing the command
- Update the README to the @rapidmx/activesync-plugin package name
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Keep device sync state with a pending remote wipe when cleaning up stale devices, so a lost device that reconnects is still wiped
- Limit ResolveRecipients to 100 To elements, skip empty ones, and report unexpected lookup failures as Status 6 instead of recipients not found
- Only resolve UUID-shaped label uids
- Refuse Sync body changes outside Drafts and write draft bodies to a new blob instead of overwriting the message's original MIME, which inbox rule copies can share
- Declare mailboxScopedData in the plugin manifest
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Track per device and folder which items the device holds, so moved and deleted items become Deletes, unseen items become Adds, and the sync position only advances past rows actually sent
- Accept a retried previous SyncKey, deduplicate Adds by ClientId, and return the full folder tree on FolderSync SyncKey 0
- Cap WBXML decoding by elements, children and depth, reject oversized requests with 413, and build responses from Buffer chunks with an ItemOperations size cap
- Require From and Sender to be the mailbox's own addresses, cap recipients, strip Bcc from relayed mail, and keep calendar organizers to the mailbox itself
- Share one Redis subscriber for Ping, allow one active Ping per device, end waits when the request closes, and cap folders
- Retry device state writes on version conflicts instead of failing after side effects
- Clear the policy key on remote wipe, send the wipe to every pending Provision, and require a matching policy key on other commands
- Keep attendee fields and recurrence exceptions on calendar changes and bump the sequence, use the Flag container, honour DeletesAsMoves, FilterType and WindowSize
- Refuse cross-mailbox moves, limit Email Adds to Drafts, fall back to folder class in GetItemEstimate, and handle every MeetingResponse request with iTIP replies
- Page changes by timestamp and uid, cap Sync collections, commands and moves, and check attachment access against the message's current folder
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Stop attendee calendar copies from sending organizer invites or cancellations, stamping the cancel notice before deleting an attendee's copy
- Reject messages with duplicate From or Sender headers before parsing
- Re-read a short overlap behind each sync cursor so out-of-order commits aren't missed, deduplicating against recently sent rows
- Lease each mailbox/device/folder collection during Sync, answering Status 16 when busy and Status 3 when state can't be saved
- Store large held-id sets in EasCollectionChunk rows and reconcile hard-purged items into Deletes
- Block remotely wiped devices until an admin unblocks them, and accept the previous FolderSync key on retry
- Cap GetItemEstimate collections, gate Settings before provisioning to device information only, and bound bulk deletes and moves with partial statuses
- Correct inverted MoveItems status codes and fail MeetingResponse when the reply is rejected by the transport
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Check composed From and Sender headers with restapi's originator rules on the raw MIME, including look-alike @ display names, empty groups and bare CR, strip Bcc with the same lexer, and refuse messages without recipients with Status 119
- Refuse moves into Outbox and into Drafts from other folders, allow body changes only on genuine drafts, clear scheduled send state when leaving Outbox, and refuse moving a message whose send is in flight
- Look meetings and conversations up by bounded, exact-matched ids, validate DeviceId, and check operator-shaped uids one at a time
- Version-check every update of plain rows, and judge organizer copies against the event owner's mailbox
- Fail open quickly when Redis is unreachable and renew Sync leases, always clear collection chunks on SyncKey 0 and cleanup, and blank SyncKeys before chunk writes
- Store the relayed Message-ID, conversation id and Bcc on the Sent Items copy, and batch Ping's pending-change checks
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Updated @rapidrest/service-core to ^2.1.0 as both the dev dependency and the peer range
- Use ModelUtils.literal() for the sender-controlled conversation id and iCalendar UID lookups instead of bounded query strings
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Use the mailbox's safe display name as calendar organizer, validate attendees as plain addresses and refuse more than 500, matching restapi
- Record audit log entries for non-owner EAS access: Fetch bodies and attachments, Sync rounds, Search pages, Sync deletes and EmptyFolderContents
- Release Sync leases locally even when Redis hangs and give the first Redis SET its full timeout
- Refuse deleting messages with a live send lease, moving delivered mail from Outbox to Drafts, and body edits on messages carrying server-set delivery markers
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Fixed
- Fixed the FilterType reset loop on SyncKey 0, and answer Ping immediately when a folder already changed before subscribing

## [1.0.0-beta.2] - 2026-09-14

### Added
- Added DeviceSyncState, its Mongo/SQL models and EasDeviceStateCleanupJob, moved here from @rapidmx/restapi with unchanged entity names and config keys so existing device state carries over
- Added a test that each entry point exports only mounted routes, models and concrete jobs, and that the manifest is valid

### Changed
- Convert this library into a RapidMX server plugin: package.json carries a rapidmx.plugin manifest, and the ./mongo and ./sql entry points export only the ready-to-mount classes a server host loads
- Mount EasRouteMongo/EasRouteSQL at /Microsoft-Server-ActiveSync and DeviceSyncStateRouteMongo/DeviceSyncStateRouteSQL at /api/mail/devices directly, so a server needs no wrapper classes
- Mark the device state models @MailboxScopedData() so restapi's ErasureExecutionJob still purges them with an erased mailbox
- Declare the mail:eas:* sync, ping, search, recipient-lookup and provisioning settings plus the idle-device cleanup age as plugin settings an administrator can edit in the admin console
- Patch @rapidmx/restapi 0.8.0 with its unreleased plugin contract until the next restapi release
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Upgraded deps
- Changing package name to @rapidmx/activesync-plugin

### Fixed
- Fixed peer dep range for restapi

## [1.0.0-beta.1] - 2026-09-13

### Added
- Added a StaticDnsResolver test double, required for Server.start() to boot now that restapi's BaseMessageRoute/ScanQueueJob unconditionally inject DnsResolver
- Added SearchProvider.candidates() to NoopSearchProvider and the new required Message.encrypted field to the EmailSyncAdapter test fixture
- Added EAS Search support for the Mailbox store (previously GAL-only), backed by restapi's SearchProvider full-text index, with per-result folder ACL verification and results rendered via EmailSyncAdapter's existing field mapping
- Added Message.labelUids support to EmailSyncAdapter, rendering resolved Label names as MS-ASEMAIL Categories, closing the gap deferred from the prior restapi 0.8.x upgrade
- Added Label to the SQL/Mongo test harnesses' model registration, missing entirely until the first createLabel() call surfaced it
- Added a regression test per command per backend proving a literal regex metacharacter in the query matches only the literal value, not a broader pattern

### Changed
- Bump @rapidmx/restapi to 0.8.x and @rapidrest/service-core to 2.x, catching up to restapi's E2E encryption/search overhaul/compliance roadmap since the prior 0.3.1 pin
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Widen EasCollectionSyncAdapter.toApplicationData to allow an async return, the same optional-async shape fromApplicationData already had, needed for EmailSyncAdapter's new Label repo lookup
- Split EmailSyncAdapter into an abstract base plus EmailSyncAdapterMongo/SQL concrete subclasses supplying the backend-specific Label model, mirroring every command's own Mongo/SQL split
- Update SyncCommand and SearchCommand to await the now-async toApplicationData at both call sites
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Switch SearchCommand/ResolveRecipientsCommand's GAL search from like() glob-wrapping to the regex() operator, matching the same fix already applied in the sibling mapi plugin for the identical service-core 2.0 like()-glob regression
- Replace globPattern()/its ResolveRecipientsCommand duplicate with a direct StringUtils.escapeRegExp() call at each call site, since regex() needs no *...* wrapping and has a real escape mechanism like() glob syntax lacks for a literal */? in the query
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- update release notes

### Fixed
- Fixed FolderSyncCommand's folder-type map missing the new FolderType.ARCHIVE member, mapping it to the same generic Type 12 fallback as USER/JUNK
- Fixed SearchCommand/ResolveRecipientsCommand's like() escaping, which assumed service-core 1.x's raw-regex semantics and silently broke substring matches containing regex metacharacters under 2.x's new glob-based like(); replaced with a plain wildcard wrap and removed the now-identical per-backend likePattern() split

### Removed
- Removed @rapidrest/cli as a dep

## [1.0.0-beta.0] - 2026-09-09

### Added
- Added real OPTIONS capability discovery (MS-ASProtocolVersions/MS-ASProtocolCommands)
- Added Settings Oof support, bump declared protocol versions to 16.0/16.1
- Added WBXML tag tables for Move, ItemEstimate, ResolveRecipients
- Added GetItemEstimate, MoveItems, and ResolveRecipients commands
- Added multi-Fetch, BodyPreference/truncation, and EmptyFolderContents to ItemOperations
- Added Provision policy enforcement, RemoteWipe flow, and admin trigger route
- Added changelog, contributing, contributors, release notes files
- Added Contact.categories support to ContactsSyncAdapter via MS-ASCONTACTS Categories/Category, both directions
- Added Message.conversationId to EmailSyncAdapter as MS-ASEMAIL2 Email2:ConversationId, encoded as opaque UTF-8 bytes
- Added ItemOperationsCommand support for conversation Move, closing this repo's own documented no-conversation-grouping gap
- Added postWbxmlBinary test helper to both EasRoute test suites, working around @rapidrest/service-core's test request() helper corrupting binary WBXML OPAQUE content via its responseType: text axios config
- Added a per-request cap on ItemOperations Fetch elements and batch the unbounded queries in emptyFolderContents/moveConversation to bound memory and round-trips

### Changed
- Initial commit
- Requires the matching service-core CORS middleware fix to actually run - documented in NOTES.md/README
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Accept client-originated Sync Add/Change/Delete for Contacts/Calendar/Tasks
- SyncCommand previously never read the request's own <Commands> element, so a
- device creating/editing/deleting a Contact, Calendar event, or Task directly
- (the normal way a phone's native apps behave against an EAS account) was
- silently dropped. Email now accepts Delete only, since [MS-ASCMD] itself
- disallows non-draft Add and composing/sending goes through SendMailCommand.
- EasCollectionSyncAdapter gains two optional members (fromApplicationData,
- newEntityDefaults) implemented for Contacts/Calendar/Tasks; their absence on
- EmailSyncAdapter is the capability gate SyncCommand uses to answer Status 6,
- rather than a separate flag that could drift. SyncCommand's own @Init now
- builds RecoverableRepoUtils instead of plain RepoUtils, since it originates
- its own soft-deletes.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add persistDeviceSyncState() to apply a patch and copy back the repo's returned version, since RepoUtils.update() never mutates its `existing` argument
- - Fix ProvisionCommand/FolderSyncCommand/SyncCommand/BaseEasRoute to use it instead of discarding the returned instance
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Bump @rapidmx/restapi to 0.2.x for new DeviceSyncState/Mailbox fields
- - Consume folderCollectionClasses/RemoteWipe fields on DeviceSyncState and Oof fields on Mailbox
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgrade to service-core 1.5.0, making OPTIONS discovery actually run
- - Bump dependency to pick up hasExplicitOptionsRoute()
- - Update EasRoute OPTIONS integration tests to verify live behavior instead of documenting it as dead code
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Support multiple Collections per Sync request
- - Restructure SyncCommand.handle() to process every <Collection>, not just the first
- - Batch all SyncKey/Class writes into a single persistDeviceSyncState call per request
- - Remember a collection's Class in DeviceSyncState.folderCollectionClasses so later requests may omit it
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Instantiate Sync collection adapters via DI, widen adapter interface
- - SyncCollectionBinding carries adapterClass instead of a pre-built instance, resolved via ObjectFactory
- - Widen EasCollectionSyncAdapter: fromApplicationData may return a Promise, newEntityDefaults() takes the caller's Mailbox
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Support Email Draft creation/editing via Sync Add/Change
- - Implement EmailSyncAdapter.fromApplicationData/newEntityDefaults for plain-text Draft bodies
- - Wrap a Draft's body in a minimal RFC 5322 message so ItemOperations Fetch still parses it correctly
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Delete the calendar item on MeetingResponse decline
- - Soft-delete the CalendarEvent instead of just flipping Attendee.responseStatus, matching real Exchange behavior
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Implement SettingsCommand Oof Get/Set backed by new Mailbox oof* fields
- - Declare MS-ASProtocolVersions 16.0/16.1 now that Oof is implemented
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add tag tables sourced from Z-Push's wbxmldefs.php for the three previously enum-only code pages
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add GetItemEstimateCommand (read-only per-collection change count estimate)
- - Add MoveItemsCommand (moves a Message between folders in the caller's own mailbox)
- - Add ResolveRecipientsCommand (resolves a To value against the mailbox's own GAL/Contact store)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Update README/NOTES.md for the practical-full-compliance work so far
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Loop over every <Fetch> instead of only the first
- - Honor Options/BodyPreference (Type 4 raw MIME, others truncate with Truncated set)
- - Reject Fetch Store="DocumentLibrary" with 400
- - Implement EmptyFolderContents, rejecting DeleteSubFolders
- - Correct plan assumptions on Store/Move per MS-ASCMD's published XSD - Store is a Fetch selector, not a write op; conversation Move is out of scope
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Source password/encryption policy from @Config instead of a hardcoded permissive document
- - Reject phase-2 acknowledgement when the client's own Policy Status isn't "1"
- - Implement the three-step RemoteWipe flow on the existing DeviceSyncState fields and 449 gate
- - Add BaseDeviceSyncStateRoute (POST /:uid/remote-wipe) as the admin trigger
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Require ACLAction.READ on the folder before enumerating or accepting Commands
- - Require CREATE/UPDATE/DELETE before Add/Change/Delete actually writes
- - Re-verify a resolved item's folderUid matches the collection being synced, treating a mismatch as not-found
- - Capture applyDelete's watermark after the write resolves instead of before
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - Add sanitizeHeaderValue() to fold embedded CR/LF before interpolating client input into MIME headers
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Cap WBXML decoder nesting depth to prevent stack-exhaustion DoS
- - Add MAX_NESTING_DEPTH (200) tracked across readTagElement()/readContentUntilEnd()'s recursion
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - GetItemEstimateCommand: require ACLAction.READ on the folder before counting
- - ItemOperationsCommand: compute EstimatedDataSize before truncation, not after
- - SearchCommand: fix malformed "0--1" Range on zero matches
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- - SearchCommand: clamp Range start too, not just end, on zero matches
- - SettingsCommand/TasksSyncAdapter: clear optional dates with null instead of undefined so SQL actually clears them
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgraded all dependencies
- Updated CI workflows
- Updated claude commit instructions
- Upgraded @rapidmx/restapi
- Bump @rapidmx/restapi to 0.3.x, catching up to its new Contact.categories and Message.conversationId fields
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed silent no-op when DeviceSyncState is written twice in one request
- Fixed cross-mailbox IDOR in Sync Change/Delete and folder read enumeration
- Fixed CRLF header injection in Draft MIME construction
- Fixed GetItemEstimate cross-mailbox leak, EstimatedDataSize, and empty-result Range
- Fixed incomplete Search Range clamp and SQL undefined-clearing gaps
- Fixed ItemOperationsCommand.moveConversation reporting Status 1 success when every message lacked UPDATE permission and nothing actually moved
- Fixed PingCommand subscribing to client-supplied folder uids with no ACL check, letting a device keep watching a folder's activity after its access was revoked
- Fixed EmailSyncAdapter ghosting To/Cc as one combined group instead of independently, silently dropping the untouched type on a partial Change, and add missing Bcc support in both directions
- Fixed SyncCommand.applyDelete approximating its watermark with wall-clock time instead of the deleted row's own persisted dateModified, which could let a concurrent unrelated write in the same folder be permanently skipped

### Removed
- Removed unused files

[Unreleased]: https://github.com/rapidmx/activesync-plugin/compare/v1.0.0-beta.8...HEAD
[1.0.0-beta.8]: https://github.com/rapidmx/activesync-plugin/compare/v1.0.0-beta.7...v1.0.0-beta.8
[1.0.0-beta.7]: https://github.com/rapidmx/activesync/compare/v1.0.0-beta.6...v1.0.0-beta.7
[1.0.0-beta.6]: https://github.com/RapidMX/activesync/compare/v1.0.0-beta.5...v1.0.0-beta.6
[1.0.0-beta.5]: https://github.com/RapidMX/activesync/compare/v1.0.0-beta.4...v1.0.0-beta.5
[1.0.0-beta.4]: https://github.com/RapidMX/activesync/compare/v1.0.0-beta.3...v1.0.0-beta.4
[1.0.0-beta.3]: https://github.com/RapidMX/activesync/compare/v1.0.0-beta.2...v1.0.0-beta.3
[1.0.0-beta.2]: https://github.com/RapidMX/activesync/compare/v1.0.0-beta.1...v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/RapidMX/activesync/compare/v1.0.0-beta.0...v1.0.0-beta.1
[1.0.0-beta.0]: https://github.com/RapidMX/activesync/releases/tag/v1.0.0-beta.0
