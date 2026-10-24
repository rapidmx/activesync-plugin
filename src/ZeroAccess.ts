///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Zero-access messages (@rapidmx/restapi `specs/search.md` §3): mail the server encrypted at rest on arrival, stored as an
 * ordinary S/MIME `enveloped-data` message whose `Subject` is `[...]`. This server can't read one, so a device gets it as S/MIME
 * (`IPM.Note.SMIME`, MIME body type 4), which a mail app holding the user's RapidMX encryption keys decrypts itself; any other
 * body type gets `ZERO_ACCESS_PLACEHOLDER_TEXT`.
 */

/** The `MessageClass` of an S/MIME encrypted message - what tells a device to fetch the MIME and decrypt it. */
export const ZERO_ACCESS_MESSAGE_CLASS = "IPM.Note.SMIME";

/** The body a device gets in place of a zero-access message's text when it asks for anything but its MIME. */
export const ZERO_ACCESS_PLACEHOLDER_TEXT =
    "This message is encrypted. Read it in RapidMX, or install your RapidMX encryption keys on this device to read it here.";

/** The body a device gets in place of an end-to-end encrypted message's text (S/MIME or OpenPGP - @rapidmx/restapi
 * `specs/end-to-end_encryption.md` *OpenPGP Interoperability*) when it asks for anything but its MIME: this server can't read it
 * either, so only the MIME is any use, to a mail app holding the recipient's keys. */
export const ENCRYPTED_PLACEHOLDER_TEXT =
    "This message is end-to-end encrypted. Read it in RapidMX, or in a mail app on this device that has your encryption keys.";

/** Whether `message` is end-to-end encrypted by its sender (`Message.encrypted`: S/MIME, OpenPGP/MIME or inline OpenPGP). */
export function isEndToEndEncryptedMessage(message: object): boolean {
    return (message as { encrypted?: unknown }).encrypted === true;
}

/** Whether `message` is stored zero-access encrypted (`Message.zeroAccess`) - read structurally, so this works against a
 * @rapidmx/restapi that predates the field. */
export function isZeroAccessMessage(message: object): boolean {
    return !!(message as { zeroAccess?: unknown }).zeroAccess;
}
