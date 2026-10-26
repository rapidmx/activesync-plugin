# Release Notes

## Unreleased

## v1.2.0

### Added

- **Zero-access encryption for calendars, contacts and tasks** (`@rapidmx/restapi` 0.35). When a mailbox's zero-access encryption covers
  calendars, contacts or tasks, whatever a device creates or edits there is sealed on arrival, like a change made in the web client: event
  titles, locations and descriptions; contact names, company, job title, notes, phone numbers, postal addresses and categories; task
  titles and notes. A device is shown placeholders for those fields (for example "Protected task"), and a placeholder it sends back unchanged, or empty,
  never overwrites the sealed value, so a device can't clear a protected field. Email addresses stay readable. Editing one occurrence of a protected repeating series is sealed too.
- **Meetings a device adds to a protected calendar send their invitations at once**, from the details the device sent, since the server
  can't read them back from the sealed event later.
- **Devices are recorded on the mailbox.** Each ActiveSync device that syncs a mailbox, and the data types it syncs (mail, calendar,
  contacts, tasks), is recorded on the mailbox (at most 20, refreshed every 6 hours, forgotten after 90 days). RapidMX uses it for
  each type's zero-access default (a type a phone syncs defaults to off) and to warn a user that turning one on hides its details on their
  phone.
- **End-to-end encrypted mail gets an explanation.** A message its sender encrypted (S/MIME, or OpenPGP since `@rapidmx/restapi` 0.35's
  OpenPGP support) is served verbatim when a device asks for the raw message, so a mail app holding the keys decrypts it; a device asking for
  text or HTML gets a short explanation instead of an empty body.

### Changed

- **Drafts and sent mail saved from a device are sealed in a zero-access mailbox.** Drafts a device adds or edits, and the Sent Items copy of
  mail it sends, are stored encrypted, with nothing readable left in storage or the search index. Before, they were stored readable.
- **Some device edits of protected items are now refused** (Status 6), because the server can't merge them with what it can't read:
  - changing only the subject of a sealed draft (the body has to come with it);
  - adding phone numbers, addresses or categories to a protected contact whose existing ones the device was shown as empty;
  - renaming, or changing the location of, an event filed from a zero-access invitation.
- **Legal holds cover device draft edits.** While an open Matter holds the mailbox, a device edit that seals a draft keeps the body it
  replaces for the Matter's export, as the web client's compose does. A draft that has already kept the maximum number of bodies refuses
  further edits (Status 6) until the Matter closes.
- **`@rapidmx/restapi` 0.35** also brings OpenPGP interoperability (per-recipient choice of S/MIME or OpenPGP, Web Key Directory), restoring
  a deleted scheduled message in a zero-access mailbox resumes its send (within `mail:jobs:zero_access_backfill:deleted_scheduled_send_days`,
  30 by default), and the zero-access backfill now seals existing calendar events, contacts and tasks once their type is protected.
- **Requires `@rapidmx/restapi` 0.35.** The peer range is raised to match. On an older restapi the plugin still loads (the server's plugin
  installer doesn't enforce peer ranges) and cleans up after a failed draft save itself, but a failed Sent Items seal can then leave its
  encrypted blob behind.

### Fixed

- **Every attachment is listed.** Sync listed only one attachment per message.
- **Repeating meetings with more than 50 changed occurrences**: editing, deleting or answering one occurrence could duplicate it or change
  the wrong one.
- **Contacts with more than three email addresses** lost the fourth one onward when edited on a device.
- **A meeting a device adds to a protected calendar** came back to it as a change showing placeholders, replacing what the user typed.
- **A new device** was recorded with no synced data types for up to six hours, which skewed the zero-access defaults.
- **Large Sync pages** read every message's body at once; they are now read a few at a time.
- **Draft saves racing the web client.** A device draft save that loses to a concurrent save (Status 7) or fails no longer leaves its
  encrypted body behind or replaces the draft's search entry with its own content, and never removes the winning save's entry.
- **A sealed draft saved readable again** after zero-access was turned off is no longer still marked encrypted.
- **Search results stay current after a device edit.** A device changing a message's subject, recipients, flags or body, or sealing a
  draft, has it re-indexed.

### Security

- **No readable copy of sealed mail is left behind.** Before, a device's drafts and Sent Items copies were stored readable in a zero-access
  mailbox, an occurrence edit on a protected calendar stored its new title and location readable, and a device sending an empty field it was
  shown nothing in could delete the sealed value. The relay scan's readable HTML of a sent message is now removed whenever no readable Sent
  Items copy names it, including when filing the copy fails, and a failed filing removes its body and search entry too.
- **A message waiting in Outbox is never indexed readable.** A device flagging or reading a message the server assembled readable for
  sending no longer has its subject, body and attachment text indexed for a zero-access mailbox.
- **Dependency audit.** Transitive dependencies with high-severity advisories are forced to fixed versions. Only node-forge's advisory
  GHSA-86w9-cpqp-85rv (npm 1240912), which has no fixed release and reaches this repo's build through `acme-client`, is ignored by the audit,
  until a fix ships.

## v1.1.0

### Added

- **Zero-access encrypted mail is served as S/MIME.** A message stored with zero-access encryption (`@rapidmx/restapi` 0.34) is sent to the device as an S/MIME message (`IPM.Note.SMIME`) whose MIME the device decrypts itself, once the user has installed their exported RapidMX keys (web client: Settings > Encryption > Export keys for Outlook or a phone). A device that asks for the message as text or HTML gets a short explanation instead of an empty body.

## v1.0.0

Phones and mail apps that speak Exchange ActiveSync (EAS) can now sync a RapidMX mailbox's mail, contacts, calendars and tasks, send mail, and get
changes pushed to them as they happen. It has been tested end to end on iOS (Apple Mail, Contacts and Calendar), and on Android (native Gmail
app), with every item type syncing both ways and pushed in real time.

### Requirements

- **`@rapidmx/autodiscover-plugin`** (optional, recommended) lets a device find this server from an email address alone.
- When adding an RapidMX account via ActiveSync, accounts must use an app password for authentication.

### What a device can do

- **Mail**: sync every folder, with plain text, HTML or the raw message as the device asks (including several preferences at once, and
  truncation); read attachments; flag, mark read and move; delete to Deleted Items; create and edit drafts; send, reply and forward, with
  replies threaded to the message they answer and the original marked replied or forwarded; search the mailbox and the directory; empty a
  folder; move a whole conversation.
- **Meeting invites** arrive as invites: the device shows its Accept/Tentative/Decline buttons, and a response updates the calendar and
  can be sent to the organizer. A response to one occurrence of a repeating meeting affects only that occurrence.
- **Calendar**: create, edit and delete events both ways, including repeating series and single occurrences of them. Each event carries its
  time zone, so repeating events keep their local time across daylight saving changes, and an event created on a device keeps the zone it
  was created in. All-day events stay on their date whatever the device's time zone.
- **Contacts**: create, edit and delete both ways, including mobile, home, business and other phone numbers, categories and the Suggested
  Contacts folder.
- **Tasks**: create, edit, complete and delete both ways.
- **Out of office**: read and set the automatic reply from the device.

Compatibl with EAS protocol versions 14.0, 14.1, 16.0 and 16.1.

### Device security

- **Provisioning policy**: devices must accept the server's policy before they sync. The defaults require a passcode of at least four
  characters (no simple ones such as 1111), device encryption, and a wipe after eight failed unlocks. Each is a setting.
- **Remote wipe**: an administrator can wipe a lost device, or only this account's data on it (`POST /api/mail/devices/:uid/remote-wipe`,
  with `{ "accountOnly": true }` for the latter). A wiped device stays locked out until an administrator unblocks it
  (`POST /api/mail/devices/:uid/unblock`).
- **Access**: every folder, message and item is checked against the mailbox's sharing permissions, the same rules as the web app and REST
  API; an administrator role does not bypass a mailbox's own grants. Access to a mailbox the caller doesn't own is recorded in the audit log.
- **Sending**: a device can only send as the mailbox's own addresses. Look-alike senders (an address in a display name, duplicate or empty
  `From`/`Sender` headers, and the like) are refused, and `Bcc` recipients never appear in the copy recipients receive.
- **Limits**: request sizes, the number of items per request, push folders and heartbeat, search results and fetch sizes are all bounded,
  and the WBXML decoder refuses deeply nested or oversized input.

### Settings

Every limit and policy is in the plugin's Settings in the admin console (or the matching `mail:eas:*` configuration key): sync and folder
sync batch sizes, fetch and request size limits, push heartbeat range and folder limit, search result limits, the provisioning policy, and
how long an idle device pairing is kept (90 days by default; a device with a remote wipe pending is never forgotten).

### Known limitations

- **Outlook for iOS and Android** cannot add the account: setup goes through Microsoft's cloud service and stops after discovery. Apple's
  apps and the Gmail app work.
- **Forward and reply** send what the device composed; the server does not add the original message's body or attachments itself
  (`SmartForward`/`SmartReply` without `ReplaceMime`). The devices tested include the original themselves.
- **A field a device leaves out of an edit is kept**, never cleared. A device that clears a field by omitting it, rather than sending it
  empty, keeps the old value.
- **Not supported**: Notes, document libraries, rights management (IRM), `Find`, `AirNotification`, and creating, renaming or deleting
  folders from a device.
