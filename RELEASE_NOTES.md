# Release Notes

## Unreleased

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
