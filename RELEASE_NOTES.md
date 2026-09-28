# Release Notes

## Unreleased

### Added

- **Temporary diagnostic logging for the `Provision` command**, to capture the real wire bytes of a device's `Provision` handshake while chasing an Android Gmail Provision-loop that beta.12's fuller `EASProvisionDoc` didn't resolve. `BaseEasRoute.dispatch()` now logs (`warn` level, tag `EAS_DEBUG`) the decoded request and raw incoming hex on the way in, and the raw outgoing response hex on the way out, for `Cmd=Provision` only. Not a behavior change - purely observational - and expected to be removed again once the real root cause is confirmed from what this reveals.

## v1.0.0-beta.12

### Fixed

- **`Provision`'s policy document now sends the full `EASProvisionDoc` field set, not just the five fields this deployment actually makes configurable.** A device stuck endlessly re-requesting `Provision` (never completing the second, acknowledging request) despite a correct, spec-compliant server response was traced to Android's Gmail app: its EAS provisioning parser is defensive-but-brittle about a policy document missing fields it expects to always be present (real Exchange, and interoperable servers like Z-Push, always send the complete schema), and appears to silently discard the whole policy rather than apply the parts it understood - indistinguishable, from the outside, from a network or auth failure. The document now includes every `EASProvisionDoc` field with maximally permissive fixed values for anything not already `@Config`-driven, plus the legacy `DeviceEncryptionEnabled` tag mirroring `RequireDeviceEncryption` for a client that still looks for the older tag. This only adds clarity for a strict client; it never changes what a deployment actually enforces (still just password/encryption, exactly as configured).

## v1.0.0-beta.11

### Fixed

- **`SendMail`, `SmartForward`, and `SmartReply` now accept the request body real clients actually send from protocol version 14.0 on, so a message no longer gets stuck retrying in a device's Outbox forever.** [MS-ASCMD] sends these three commands' body as raw MIME (`Content-Type: message/rfc822`) directly from 14.0 onward - the only versions this library ever advertises - with `SaveInSentItems` and the item being forwarded/replied to (`ItemId`) as URL query-string parameters, not the older WBXML-wrapped `<ComposeMail:Mime>` element this library only ever accepted. Every client correctly negotiating 14.0+ (confirmed against Gmail for Android's own ActiveSync implementation) got a 400 on every send. The server now decides which shape it's looking at from the client's own `Content-Type` header - `application/vnd.ms-sync.wbxml` still decodes the legacy wrapped body exactly as before (for any client that sends it despite negotiating a newer version), anything else (`message/rfc822`, or no `Content-Type` at all) reads the raw MIME body and query parameters instead. Nothing that worked before regresses; this only adds the format every real 14.0+ client was actually sending. `EasCommandHandler` gained an optional `rawBody` flag a command sets to opt into this dispatch.

## v1.0.0-beta.10

## v1.0.0-beta.9

### Changed

- The development dependency on `@rapidmx/restapi` is 0.23.0 (was 0.22.1); the plugin is otherwise unchanged. A minor bump (a new beta) because restapi's release is a minor.

## v1.0.0-beta.8

## v1.0.0-beta.7

## v1.0.0-beta.6

### Changed

- Bump the `@rapidmx/restapi` development dependency to `^0.21.1` (peer range unchanged) and rebuild against it.

## v1.0.0-beta.5
