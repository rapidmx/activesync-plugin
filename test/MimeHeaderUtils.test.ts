///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    checkComposedOriginators,
    checkOriginatorHeaders,
    extractOriginatorHeaders,
    hasAddressLikeDisplayName,
    isPlainAddress,
    safeDisplayName,
    stripHeader,
} from "../src/MimeHeaderUtils.js";

const message = (...headers: string[]): Buffer => Buffer.from([...headers, "To: to@example.com", "", "From: body@example.org"].join("\r\n"));
const own = (address: string): boolean => ["me@example.com", "alias@example.com"].includes(address.toLowerCase());
const refused = (raw: Buffer): boolean => checkComposedOriginators(raw, own) !== undefined;

describe("MimeHeaderUtils Tests", () => {
    it("Lexes From/Sender like the parser that reads the message later: obsolete whitespace, folding, bare CR, and never the body.", () => {
        expect(extractOriginatorHeaders(message("From : me@example.com", "SENDER\t:alias@example.com"))).toEqual({
            from: ["me@example.com"],
            sender: ["alias@example.com"],
        });
        expect(extractOriginatorHeaders(message("From: Me", " <me@example.com>")).from).toEqual(["Me <me@example.com>"]);
        expect(extractOriginatorHeaders(message("From: me@example.com\rFrom: victim@example.org")).from).toHaveLength(2);
        // restapi's lexer never reads the body, and (unlike mailsplit) not a first line starting with a space.
        expect(extractOriginatorHeaders(Buffer.from(" From: victim@example.org\nFrom: me@example.com\n\nFrom: body")).from).toEqual(["me@example.com"]);
        expect(extractOriginatorHeaders(Buffer.from("From: me@example.com")).from).toEqual(["me@example.com"]);
    });

    it("Accepts the mailbox's own addresses, with or without a plain display name, group or Sender.", () => {
        expect(refused(message("From: me@example.com"))).toBe(false);
        expect(refused(message('From: "Me Myself" <ME@example.com>', "Sender: alias@example.com"))).toBe(false);
        // Escaped characters inside a quoted string and a comment.
        expect(refused(message(String.raw`From: "Me \"Myself\"" <me@example.com> (work \) phone)`))).toBe(false);
        expect(refused(message("From: Team: me@example.com, alias@example.com;"))).toBe(false);
        expect(refused(message("From: =?utf-8?q?M=C3=A9?= <me@example.com>"))).toBe(false);
    });

    it("Refuses a missing or repeated From, a repeated Sender, and every address trick restapi refuses.", () => {
        for (const headers of [
            ["Subject: no from"],
            ["From: me@example.com", "from : victim@example.org"],
            ["From: me@example.com\rFrom: victim@example.org"],
            ["From: me@example.com", "Sender: me@example.com", "Sender: alias@example.com"],
            ["From: victim@example.org"],
            ["From: me@example.com", "Sender: victim@example.org"],
            ["From: <me@example.com> <victim@example.org>"],
            ['From: "ceo@example.org" <me@example.com>'],
            ["From: me@example.com (victim@example.org)"],
            ["From: Victim Name, me@example.com"],
            ["From: victims:;, me@example.com"],
            ["From: victims:;"],
            ["From: =?utf-8?q?ceo=40example.org?= <me@example.com>"],
            ["From: =?utf-8?b?Y2VvQGV4YW1wbGUub3Jn?= <me@example.com>"],
        ]) {
            expect(refused(message(...headers))).toBe(true);
        }
        expect(checkOriginatorHeaders(message("Subject: none"), own)).toMatch(/no From/);
        expect(checkOriginatorHeaders(message("From: victims:;"), own)).toMatch(/no address/);
    });

    it("checkOriginatorHeaders only refuses address-like display names with the option, as in restapi.", () => {
        const raw = message('From: "ceo@example.org" <me@example.com>');
        expect(checkOriginatorHeaders(raw, own)).toBeUndefined();
        expect(checkOriginatorHeaders(raw, own, { rejectAddressLikeDisplayNames: true })).toMatch(/display name/);
    });

    it("checkComposedOriginators also refuses a From/Sender only mailsplit would read, and an empty group.", () => {
        for (const headers of [" From: victim@example.org\r\nFrom: me@example.com", "From: me@example.com\r\nSender\f: victim@example.org"]) {
            expect(checkComposedOriginators(message(headers), own)).toMatch(/form this server/);
        }
        expect(checkComposedOriginators(message("From: victims:;, me@example.com"), own)).toMatch(/empty group/);
        expect(checkComposedOriginators(message("From: Team: me@example.com;"), own)).toBeUndefined();
    });

    it("checkComposedOriginators accepts a display name or comment that shows only the sender's own addresses.", () => {
        for (const headers of [
            ['From: "me@example.com" <me@example.com>'],
            ['From: "ME@example.com" <me@example.com>', 'Sender: "alias@example.com" <alias@example.com>'],
            ["From: me@example.com (alias@example.com)"],
            ["From: =?utf-8?q?me=40example.com?= <me@example.com>"],
            ['From: "Me (me@example.com)" <me@example.com>'],
            ["From: me@example.com: alias@example.com;"],
            // A backslash-escaped character inside the quoted display name itself (not just outside it, as in the
            // "accepts the mailbox's own addresses" test above) - still decodes to the sender's own address.
            ['From: "me\\@example.com" <me@example.com>'],
        ]) {
            expect(checkComposedOriginators(message(...headers), own)).toBeUndefined();
        }
        for (const headers of [
            ['From: "me@example.com, ceo@example.org" <me@example.com>'],
            ['From: "me@example.com" <me@example.com>', 'Sender: "ceo@example.org" <me@example.com>'],
            ['From: "me＠example.com" <me@example.com>'],
            ['From: "me@example.com@example.org" <me@example.com>'],
            ["From: =?utf-8?b?QA==?= <me@example.com>"],
            ['From: "me@example.com" me@example.com (ceo@example.org'],
        ]) {
            expect(checkComposedOriginators(message(...headers), own)).toMatch(/display name or comment contains an address/);
        }
    });

    it("safeDisplayName (restapi's) omits names that are blank, carry a line break or control character, or look like an address.", () => {
        expect(safeDisplayName("  Pat Doe ")).toBe("Pat Doe");
        // A tab is not a line break.
        expect(safeDisplayName("Pat\tDoe")).toBe("Pat\tDoe");
        for (const name of [undefined, 42, "", "   ", "pat@example.com", "Pat ＠ Corp", "Pat ﹫ Corp", "=?utf-8?q?pat=40corp?=", "Pat\nDoe", "Pat\rDoe", `Pat${String.fromCharCode(0x7f)}Doe`]) {
            expect(safeDisplayName(name)).toBeUndefined();
        }
    });

    it("isPlainAddress (restapi's) accepts exactly one bare address of at most 320 characters.", () => {
        expect(isPlainAddress("pat.doe+tag@example.com")).toBe(true);
        expect(isPlainAddress(`${"a".repeat(314)}@x.com`)).toBe(true);
        for (const value of [undefined, "", "pat", "a@x.com, b@y.com", "a@x.com;b@y.com", "Pat <pat@x.com>", "<pat@x.com>", "pat@x.com (c)", '"a b"@x.com', "pat＠x.com", "a@b@c.com", `${"a".repeat(315)}@x.com`]) {
            expect(isPlainAddress(value)).toBe(false);
        }
    });

    it("hasAddressLikeDisplayName sees addresses in quoted names, nested or unterminated comments, group names and look-alike @ signs.", () => {
        expect(hasAddressLikeDisplayName('"Plain \\"Name\\"" <me@example.com>')).toBe(false);
        expect(hasAddressLikeDisplayName("me@example.com (a (ceo@example.org) b)")).toBe(true);
        expect(hasAddressLikeDisplayName('"ceo\\@example.org <me@example.com>')).toBe(true);
        expect(hasAddressLikeDisplayName("me@example.com (ceo@example.org")).toBe(true);
        expect(hasAddressLikeDisplayName("ceo＠example.org <me@example.com>")).toBe(true);
        expect(hasAddressLikeDisplayName(Buffer.from("ceo＠example.org <me@example.com>", "utf8").toString("latin1"))).toBe(true);
        expect(hasAddressLikeDisplayName("Team: Boss =?utf-8?b?QA==?= <me@example.com>;")).toBe(true);
    });

    it("stripHeader finds the same fields: whitespace before the colon, a first line with leading space, and bare-CR line breaks.", () => {
        expect(stripHeader(Buffer.from("To: x\r\nBcc : y,\r\n z\r\nSubject: s\r\n\r\nBcc : body"), "bcc").toString("latin1")).toBe(
            "To: x\r\nSubject: s\r\n\r\nBcc : body",
        );
        expect(stripHeader(Buffer.from(" Bcc: y\r\nTo: x\r\n\r\n"), "bcc").toString("latin1")).toBe("To: x\r\n\r\n");
        expect(stripHeader(Buffer.from("To: x\rBcc: y\r\nSubject: s\r\n\r\n"), "bcc").toString("latin1")).toBe("To: x\rSubject: s\r\n\r\n");
        expect(stripHeader(Buffer.from("To: x\r\nNoColonLine\r\n\r\n"), "bcc").toString("latin1")).toBe("To: x\r\nNoColonLine\r\n\r\n");
    });
});
