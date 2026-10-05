///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import addressparser from "nodemailer/lib/addressparser";
import { checkOriginatorHeaders, extractOriginatorHeaders, hasAddressLikeDisplayName } from "@rapidmx/restapi";

/**
 * Raw RFC 5322 header-block helpers for the MIME a device composes (`ComposeMailCommand`).
 *
 * `extractOriginatorHeaders()`, `hasAddressLikeDisplayName()`, `checkOriginatorHeaders()`, `isPlainAddress()`
 * and `safeDisplayName()` are restapi's own exports (`util/MimeHeaderUtils.ts`), re-exported here so every
 * caller in this plugin keeps importing from one place. `checkComposedOriginators()` still needs two of
 * restapi's private helpers behind those exports (`quotedStringsAndComments()`, `decodeEncodedWords()`) -
 * restapi doesn't export them, so they're kept here as small inline copies, matched to restapi's source
 * exactly.
 *
 * **Plugin-side** (`checkComposedOriginators()`, `stripHeader()`): a second, byte-preserving lexer
 * (`lexHeaderFields()`) that is at least as eager as the parser reading the message later (mailparser/mailsplit):
 * the header block ends at the first empty line (`CRLF CRLF` or `LF LF`); CRLF, LF and a bare CR all end a physical
 * line; a line starting with a space or tab continues the previous field; and a field's name is everything before
 * its first colon with surrounding whitespace ignored - mailsplit trims names the same way, so a leading space on the
 * very first line or a form feed before the colon still names a `From`.
 */
export { checkOriginatorHeaders, extractOriginatorHeaders, hasAddressLikeDisplayName, isPlainAddress, safeDisplayName } from "@rapidmx/restapi";
export type { OriginatorHeaderCheckOptions, OriginatorHeaders } from "@rapidmx/restapi";

// ---------------------------------------------------------------------------------------------------------------
// Private helpers behind restapi's exports above that checkComposedOriginators() still needs directly - restapi
// doesn't export these, so they're kept as inline copies of its source (util/MimeHeaderUtils.ts).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Collects the text of every quoted string and comment in a structured header value (the counterpart of
 * restapi's own `stripQuotedStringsAndComments()`) - where a display name or comment shows the reader text of
 * the sender's choice.
 */
function quotedStringsAndComments(value: string): string[] {
    const parts: string[] = [];
    let current: string = "";
    let inQuote: boolean = false;
    let commentDepth: number = 0;
    for (let i = 0; i < value.length; i++) {
        const ch: string = value[i];
        if (ch === "\\" && (inQuote || commentDepth > 0)) {
            current += value[i + 1] ?? "";
            i++;
            continue;
        }
        if (inQuote) {
            if (ch === '"') {
                inQuote = false;
                parts.push(current);
                current = "";
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === "(") {
            commentDepth++;
            current += commentDepth > 1 ? ch : "";
            continue;
        }
        if (commentDepth > 0) {
            if (ch === ")") {
                commentDepth--;
                if (commentDepth === 0) {
                    parts.push(current);
                    current = "";
                    continue;
                }
            }
            current += ch;
            continue;
        }
        if (ch === '"') {
            inQuote = true;
        }
    }
    if (inQuote || commentDepth > 0) {
        parts.push(current);
    }
    return parts;
}

/** Decodes RFC 2047 encoded words (B and Q) to UTF-8 text - enough to see what a display name shows the reader. */
function decodeEncodedWords(text: string): string {
    return text.replace(/=\?[^?]+\?([bBqQ])\?([^?]*)\?=/g, (_match, encoding: string, data: string) => {
        if (encoding.toUpperCase() === "B") {
            return Buffer.from(data, "base64").toString("utf8");
        }
        const bytes: Buffer = Buffer.from(
            data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
            "binary",
        );
        return bytes.toString("utf8");
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Plugin-side additions
// ---------------------------------------------------------------------------------------------------------------

/** One top-level header field of a raw message, as `lexHeaderFields()` finds it. */
interface HeaderField {
    /** Lower-cased, trimmed field name (`""` for a line without a colon). */
    name: string;
    /** Offset of the field's first byte in the `latin1` view of the message. */
    start: number;
    /** Offset just past the field's last line terminator (or continuation line). */
    end: number;
}

/** Every top-level header field of `raw`, in order, with byte offsets - see this module's doc comment. */
function lexHeaderFields(raw: Buffer): { text: string; fields: HeaderField[] } {
    const text: string = raw.toString("latin1");
    const separator: RegExpExecArray | null = /\r\n\r\n|\n\n/.exec(text);
    // The header block keeps the terminator of its last line; the empty line itself belongs to the separator.
    const headerEnd: number = separator ? separator.index + (separator[0] === "\n\n" ? 1 : 2) : text.length;
    const fields: HeaderField[] = [];
    const lineRegex = /([^\r\n]*)(\r\n|\n|\r|$)/y;
    let position = 0;
    while (position < headerEnd) {
        lineRegex.lastIndex = position;
        const match: RegExpExecArray = lineRegex.exec(text)!;
        const content: string = match[1];
        const lineEnd: number = position + match[0].length;
        const current: HeaderField | undefined = fields[fields.length - 1];
        if (/^[ \t]/.test(content) && current) {
            current.end = lineEnd;
        } else if (content.length > 0) {
            const colon: number = content.indexOf(":");
            fields.push({ name: colon === -1 ? "" : content.slice(0, colon).trim().toLowerCase(), start: position, end: lineEnd });
        }
        position = lineEnd;
    }
    return { text, fields };
}

/** An addr-spec-looking run inside display text: no whitespace, brackets, quotes, separators or second `@`. */
const DISPLAY_ADDRESS_TOKEN = /[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+/g;

/**
 * Whether every address shown in one `From`/`Sender` value's display names, group names and comments is one
 * `isAllowed` accepts - the case `hasAddressLikeDisplayName()` would refuse although it names only the sender itself
 * (`"me@example.com" <me@example.com>`, as clients do when the display name is the address, e.g. autodiscover's
 * `DisplayName`). Each text is read the way `hasAddressLikeDisplayName()` reads it (as UTF-8 and as latin1, RFC 2047
 * encoded words decoded). A look-alike `@` (fullwidth or small) is never accepted, and neither is an `@` left over once
 * every allowed address is removed (`a@b@c`, a lone encoded `@`, an address split by a quote).
 */
function displayTextShowsOnlyAllowedAddresses(value: string, isAllowed: (address: string) => boolean): boolean {
    const texts: string[] = [...quotedStringsAndComments(value)];
    const visit = (entries: { name?: string; group?: any[] }[]): void => {
        for (const entry of entries) {
            if (typeof entry.name === "string") {
                texts.push(entry.name);
            }
            if (Array.isArray(entry.group)) {
                visit(entry.group);
            }
        }
    };
    visit(addressparser(value));
    return texts.every((text) =>
        [decodeEncodedWords(Buffer.from(text, "binary").toString("utf8")), decodeEncodedWords(text)].every((view) => {
            if (/[＠﹫]/.test(view)) {
                return false;
            }
            const remainder: string = view.replace(DISPLAY_ADDRESS_TOKEN, (token) => (isAllowed(token) ? " " : "@"));
            return !remainder.includes("@");
        }),
    );
}

/**
 * The ActiveSync compose sender check: restapi's `checkOriginatorHeaders()` with `rejectAddressLikeDisplayNames`, plus
 * two plugin-side refusals restapi doesn't make. Returns a refusal reason, or `undefined` if the message passes.
 * - **Relaxed for the sender's own address**: a display name or comment that shows an address is still accepted when
 * every address it shows is one of the mailbox's own (`"me@example.com" <me@example.com>`) - see
 * `displayTextShowsOnlyAllowedAddresses()`. Any other address, or a look-alike `@`, is refused as restapi refuses it.
 * - **A `From`/`Sender` field restapi's lexer can't see** - the tolerant `lexHeaderFields()` counts more of them (e.g.
 * a leading space on the first line, or a form feed before the colon, both of which mailsplit still reads as `From`).
 * - **An empty group** (`victims:;, me@example.com`) - it contributes no address, only text of the sender's choice
 * shown beside the real address, and RFC 5322 doesn't allow groups in `From`/`Sender` at all.
 */
export function checkComposedOriginators(raw: Buffer, isAllowed: (address: string) => boolean): string | undefined {
    const refusal: string | undefined = checkOriginatorHeaders(raw, isAllowed);
    if (refusal !== undefined) {
        return refusal;
    }
    const exact = extractOriginatorHeaders(raw);
    for (const [name, values] of [
        ["From", exact.from],
        ["Sender", exact.sender],
    ] as [string, string[]][]) {
        if (values.some((value) => hasAddressLikeDisplayName(value) && !displayTextShowsOnlyAllowedAddresses(value, isAllowed))) {
            return `The ${name} header's display name or comment contains an address.`;
        }
    }
    const fields: HeaderField[] = lexHeaderFields(raw).fields;
    const count = (name: string): number => fields.filter((field) => field.name === name).length;
    if (count("from") !== exact.from.length || count("sender") !== exact.sender.length) {
        return "The message has a From or Sender header in a form this server doesn't accept.";
    }
    const hasEmptyGroup = (value: string): boolean =>
        (addressparser(value) as { group?: unknown[] }[]).some((entry) => Array.isArray(entry.group) && entry.group.length === 0);
    if ([...exact.from, ...exact.sender].some(hasEmptyGroup)) {
        return "The From or Sender header contains an empty group.";
    }
    return undefined;
}

/**
 * Returns a copy of `raw` with every top-level header field named `name` (case-insensitive, whitespace before the
 * colon allowed, including its folded continuation lines) removed, found with `lexHeaderFields()` - so a field
 * written `Bcc :` is removed too. Only the header block is touched; every other byte is copied verbatim.
 */
export function stripHeader(raw: Buffer, name: string): Buffer {
    const target: string = name.toLowerCase();
    const { text, fields } = lexHeaderFields(raw);
    let result: string = "";
    let copiedUpTo: number = 0;
    for (const field of fields) {
        if (field.name === target) {
            result += text.slice(copiedUpTo, field.start);
            copiedUpTo = field.end;
        }
    }
    return Buffer.from(result + text.slice(copiedUpTo), "latin1");
}

/** Truncates UTF-8 text to at most `maxBytes` bytes without splitting a multi-byte character in half - backs
 * off past any trailing UTF-8 continuation byte (`10xxxxxx`) before decoding back to a string. Only ever called
 * once the caller has already confirmed the text exceeds `maxBytes` - trusts that rather than re-checking it
 * here. Shared by `ItemOperationsCommand.fetchMessage()` (`BodyPreference` truncation on an explicit `Fetch`)
 * and `EmailSyncAdapter` (the identical truncation when a `Sync` round's own `BodyPreference` asks for the real
 * body inline, not just the short preview). */
export function truncateUtf8(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf8");
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) {
        end--;
    }
    return buf.subarray(0, end).toString("utf8");
}
