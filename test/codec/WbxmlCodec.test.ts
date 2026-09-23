///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The WBXML codec is pure binary-format logic with no DI/DB dependency, so it's tested directly here rather
// than only indirectly through a real-server HTTP round trip (which BaseEasRoute's own tests will still do,
// once that lands, using this exact codec to build/parse the request/response bytes).
import {
    WbxmlDecoder,
    WbxmlDecodeError,
    WbxmlLimitError,
    WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT,
    WBXML_DEFAULT_MAX_DEPTH,
    WBXML_DEFAULT_MAX_ELEMENTS,
    WBXML_DEFAULT_MAX_INLINE_STRING_BYTES,
} from "../../src/codec/WbxmlDecoder.js";
import {
    WbxmlEncoder,
    WbxmlSizeLimitError,
    WBXML_ENCODER_SCRATCH_SIZE,
    wbxmlOpaqueSize,
} from "../../src/codec/WbxmlEncoder.js";
import { codeForTagName, tagNameForCode, WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import {
    element,
    opaqueElement,
    textElement,
    findChild,
    findChildren,
    childText,
    type WbxmlElement,
} from "../../src/codec/WbxmlElement.js";

/** The fixed EAS WBXML header: version 1.3, publicid 1, charset UTF-8, empty string table. */
const HEADER = [0x03, 0x01, 0x6a, 0x00];

/** `depth` content-flagged page-0 Sync tags nested inside one another, each closed by END. */
function nested(depth: number): Buffer {
    return Buffer.concat([Buffer.from(HEADER), Buffer.alloc(depth, 0x05 | 0x40), Buffer.alloc(depth, 0x01)]);
}

/** A page-0 Sync root carrying `count` empty (no-content) Sync children. */
function flat(count: number): Buffer {
    return Buffer.concat([Buffer.from([...HEADER, 0x05 | 0x40]), Buffer.alloc(count, 0x05), Buffer.from([0x01])]);
}

/** The original byte-at-a-time `number[]` encoder, kept as an independent reference for byte-identity checks. */
function referenceEncode(root: WbxmlElement): Buffer {
    const bytes: number[] = [0x03, 0x01, 0x6a, 0x00];
    let currentPage = 0;
    const writeMbUint = (value: number): void => {
        const groups: number[] = [value & 0x7f];
        value = Math.floor(value / 128);
        while (value > 0) {
            groups.unshift((value & 0x7f) | 0x80);
            value = Math.floor(value / 128);
        }
        for (const group of groups) {
            bytes.push(group);
        }
    };
    const writeElement = (el: WbxmlElement): void => {
        if (el.page !== currentPage) {
            bytes.push(0x00, el.page);
            currentPage = el.page;
        }
        const code = codeForTagName(el.page, el.tag);
        const hasContent = el.children.length > 0 || el.text !== undefined || el.opaque !== undefined;
        bytes.push(hasContent ? code | 0x40 : code);
        if (!hasContent) {
            return;
        }
        if (el.text !== undefined) {
            bytes.push(0x03);
            for (const byte of Buffer.from(el.text.split(String.fromCharCode(0)).join(""), "utf-8")) {
                bytes.push(byte);
            }
            bytes.push(0x00);
        } else if (el.opaque !== undefined) {
            bytes.push(0xc3);
            writeMbUint(el.opaque.length);
            for (const byte of el.opaque) {
                bytes.push(byte);
            }
        } else {
            el.children.forEach(writeElement);
        }
        bytes.push(0x01);
    };
    writeElement(root);
    return Buffer.from(bytes);
}

describe("WBXML codec Tests", () => {
    describe("Real captured ActiveSync traffic (Microsoft's own published worked example)", () => {
        // From "How to manually decode an ActiveSync WBXML stream" (Microsoft, archived MSDN blog) - a real
        // Sync request captured from an ActiveSync client, published byte-for-byte alongside its decoded XML.
        // Verifying against this exact, independently-authored stream (not just our own encode/decode
        // round-tripping) is the strongest available confirmation that this codec's binary framing (header,
        // tag content/attribute flag bits, SWITCH_PAGE, STR_I, END) matches the real wire protocol, not just
        // itself.
        const capturedRequestHex =
            "03 01 6A 00 45 5C 4F 4B 03 30 00 01 52 03 32 00 01 57 00 11 45 46 03 31 00 01 47 03 33 32 37 36 38 00 01 01 01 01 01 01";
        const capturedRequestBytes: Buffer = Buffer.from(capturedRequestHex.replace(/ /g, ""), "hex");

        // <Sync xmlns="AirSync">
        //   <Collections>
        //     <Collection>
        //       <SyncKey>0</SyncKey>
        //       <CollectionId>2</CollectionId>
        //       <Options>
        //         <airsyncbase:BodyPreference xmlns:airsyncbase="AirSyncBase">
        //           <airsyncbase:Type>1</airsyncbase:Type>
        //           <airsyncbase:TruncationSize>32768</airsyncbase:TruncationSize>
        //         </airsyncbase:BodyPreference>
        //       </Options>
        //     </Collection>
        //   </Collections>
        // </Sync>
        const capturedRequestTree: WbxmlElement = element(WbxmlCodePage.AirSync, "Sync", [
            element(WbxmlCodePage.AirSync, "Collections", [
                element(WbxmlCodePage.AirSync, "Collection", [
                    textElement(WbxmlCodePage.AirSync, "SyncKey", "0"),
                    textElement(WbxmlCodePage.AirSync, "CollectionId", "2"),
                    element(WbxmlCodePage.AirSync, "Options", [
                        element(WbxmlCodePage.AirSyncBase, "BodyPreference", [
                            textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                            textElement(WbxmlCodePage.AirSyncBase, "TruncationSize", "32768"),
                        ]),
                    ]),
                ]),
            ]),
        ]);

        it("Encodes the tree to the exact real captured byte stream.", () => {
            const encoded: Buffer = new WbxmlEncoder().encode(capturedRequestTree);
            expect(encoded.equals(capturedRequestBytes)).toBe(true);
        });

        it("Decodes the real captured byte stream into the equivalent tree.", () => {
            const decoded: WbxmlElement = new WbxmlDecoder().decode(capturedRequestBytes);
            expect(decoded).toEqual(capturedRequestTree);
        });

        it("Round-trips the real captured byte stream (decode then re-encode) byte-for-byte.", () => {
            const decoded: WbxmlElement = new WbxmlDecoder().decode(capturedRequestBytes);
            const reEncoded: Buffer = new WbxmlEncoder().encode(decoded);
            expect(reEncoded.equals(capturedRequestBytes)).toBe(true);
        });
    });

    describe("Encode -> decode round-trips (synthetic cases)", () => {
        it("Round-trips a single leaf element with no content (self-closing, no children/text/opaque).", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSync, "GetChanges");
            const encoded: Buffer = new WbxmlEncoder().encode(tree);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(encoded);
            expect(decoded).toEqual(tree);
        });

        it("Round-trips a leaf element carrying inline text.", () => {
            const tree: WbxmlElement = textElement(WbxmlCodePage.AirSync, "SyncKey", "42");
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips a leaf element carrying opaque binary content.", () => {
            const payload: Buffer = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0xaa, 0x00]);
            const tree: WbxmlElement = opaqueElement(WbxmlCodePage.ItemOperations, "Data", payload);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
            expect(decoded.opaque?.equals(payload)).toBe(true);
        });

        it("Round-trips opaque content large enough to require a multi-byte mb_u_int32 length (>127 bytes).", () => {
            const payload: Buffer = Buffer.alloc(500, 0x5a);
            const tree: WbxmlElement = opaqueElement(WbxmlCodePage.ItemOperations, "Data", payload);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded.opaque?.length).toBe(500);
            expect(decoded.opaque?.equals(payload)).toBe(true);
        });

        it("Round-trips text containing multi-byte UTF-8 characters.", () => {
            const tree: WbxmlElement = textElement(WbxmlCodePage.Contacts, "FirstName", "José 日本語 😀");
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded.text).toBe("José 日本語 😀");
        });

        it("Strips U+0000 from inline text so it can't terminate the string early and inject tokens.", () => {
            const nul = String.fromCharCode(0);
            // Without stripping, the bytes after the first NUL (0x01 = END) would be parsed as markup.
            const tree = element(WbxmlCodePage.AirSync, "Sync", [
                textElement(WbxmlCodePage.Email, "Subject", `Hi${nul}${String.fromCharCode(1)}${nul}there`),
                textElement(WbxmlCodePage.Email, "Read", "1"),
            ]);

            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));

            expect(decoded.children.map((child) => child.tag)).toEqual(["Subject", "Read"]);
            expect(decoded.children[0].text).toBe(`Hi${String.fromCharCode(1)}there`);
            expect(childText(decoded, "Read")).toBe("1");
        });

        it("Round-trips a tree switching between more than two code pages across sibling elements.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSync, "Sync", [
                textElement(WbxmlCodePage.AirSync, "SyncKey", "1"),
                element(WbxmlCodePage.Provision, "Policies", [
                    textElement(WbxmlCodePage.Provision, "PolicyKey", "123456789"),
                ]),
                textElement(WbxmlCodePage.AirSync, "GetChanges", "1"),
                element(WbxmlCodePage.Settings, "DeviceInformation", [
                    textElement(WbxmlCodePage.Settings, "Model", "TestPhone"),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Does not emit a redundant SWITCH_PAGE when consecutive elements stay on the same code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSyncBase, "BodyPreference", [
                textElement(WbxmlCodePage.AirSyncBase, "Type", "2"),
                textElement(WbxmlCodePage.AirSyncBase, "TruncationSize", "0"),
            ]);
            const encoded: Buffer = new WbxmlEncoder().encode(tree);
            // header(4) + SWITCH_PAGE(2, root itself isn't page 0) + BodyPreference tag(1) + Type(1+1+1+1+1)
            // + TruncationSize(1+1+1+1+1) + BodyPreference END(1) - exactly one SWITCH_PAGE (2 bytes) total.
            const switchPageOccurrences = [...encoded].filter((b, i) => b === 0x00 && encoded[i + 1] === WbxmlCodePage.AirSyncBase).length;
            expect(switchPageOccurrences).toBe(1);
        });

        it("Round-trips every tag on the Move (MoveItems) code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.Move, "MoveItems", [
                element(WbxmlCodePage.Move, "Move", [
                    textElement(WbxmlCodePage.Move, "SrcMsgId", "msg-1"),
                    textElement(WbxmlCodePage.Move, "SrcFldId", "folder-1"),
                    textElement(WbxmlCodePage.Move, "DstFldId", "folder-2"),
                ]),
                element(WbxmlCodePage.Move, "Response", [
                    textElement(WbxmlCodePage.Move, "Status", "3"),
                    textElement(WbxmlCodePage.Move, "DstMsgId", "msg-1"),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips every tag on the ItemEstimate (GetItemEstimate) code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", [
                element(WbxmlCodePage.AirSync, "Collections", [
                    element(WbxmlCodePage.AirSync, "Collection", [
                        textElement(WbxmlCodePage.AirSync, "Class", "Email"),
                        textElement(WbxmlCodePage.AirSync, "CollectionId", "folder-1"),
                        element(WbxmlCodePage.ItemEstimate, "Response", [
                            textElement(WbxmlCodePage.ItemEstimate, "Status", "1"),
                            textElement(WbxmlCodePage.ItemEstimate, "Estimate", "12"),
                        ]),
                    ]),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips every tag on the ResolveRecipients code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.ResolveRecipients, "ResolveRecipients", [
                textElement(WbxmlCodePage.ResolveRecipients, "To", "jane@example.com"),
                element(WbxmlCodePage.ResolveRecipients, "Response", [
                    textElement(WbxmlCodePage.ResolveRecipients, "Status", "1"),
                    element(WbxmlCodePage.ResolveRecipients, "Recipient", [
                        textElement(WbxmlCodePage.ResolveRecipients, "Type", "1"),
                        textElement(WbxmlCodePage.ResolveRecipients, "DisplayName", "Jane Doe"),
                        textElement(WbxmlCodePage.ResolveRecipients, "EmailAddress", "jane@example.com"),
                    ]),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips deeply nested structural elements (Sync/Collections/Collection/Commands/Add/ApplicationData).", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSync, "Sync", [
                element(WbxmlCodePage.AirSync, "Collections", [
                    element(WbxmlCodePage.AirSync, "Collection", [
                        textElement(WbxmlCodePage.AirSync, "SyncKey", "5"),
                        element(WbxmlCodePage.AirSync, "Commands", [
                            element(WbxmlCodePage.AirSync, "Add", [
                                textElement(WbxmlCodePage.AirSync, "ServerId", "5:1"),
                                element(WbxmlCodePage.AirSync, "ApplicationData", [
                                    element(WbxmlCodePage.Email, "Attachments", []),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });
    });

    describe("Error handling", () => {
        it("Throws when encoding a tag name with no registered token on the given code page.", () => {
            const encoder = new WbxmlEncoder();
            expect(() => encoder.encode(textElement(WbxmlCodePage.AirSync, "NotARealTag", "x"))).toThrow(
                /no token registered/,
            );
        });

        it("Decodes an unrecognized tag code into a synthetic placeholder name rather than throwing.", () => {
            // Code 0x3f is unassigned on the Ping page - see WbxmlCodePages.ts's own table.
            const tag = tagNameForCode(WbxmlCodePage.Ping, 0x3f);
            expect(tag).toBe("Unknown0x3f");
        });

        it("Throws when decoding a tag byte with the (unsupported) attribute flag set.", () => {
            // header + a Sync tag byte (0x05) with both content(0x40) and attribute(0x80) flags set.
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x05 | 0x40 | 0x80]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/attributes are not supported/);
        });

        it("Throws when the buffer ends mid-header (before the version byte's follow-on fields).", () => {
            // Only the version byte is present - reading `publicid` immediately runs off the end of the
            // buffer inside `readMbUint()`'s own `readByte()` call, distinct from the content-parsing loop's
            // own explicit end-of-buffer check exercised by the test below.
            expect(() => new WbxmlDecoder().decode(Buffer.from([0x03]))).toThrow(/unexpected end of buffer/);
        });

        it("Throws when the buffer ends before a tag's content is terminated.", () => {
            // header + Sync tag (with content flag) but no following END token.
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x05 | 0x40]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/unexpected end of buffer/);
        });

        it("Throws when an inline string (STR_I) is never null-terminated.", () => {
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x05 | 0x40, 0x03, 0x41, 0x42]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/unterminated inline string/);
        });

        it("codeForTagName() throws for an unregistered tag/page pair.", () => {
            expect(() => codeForTagName(WbxmlCodePage.AirSync, "DoesNotExist")).toThrow(/no token registered/);
        });

        it("Throws a bounded 'maximum nesting depth' error rather than a raw stack overflow for pathologically deep nesting.", () => {
            // header + 250 content-flagged Sync tag bytes (each ~2 bytes of wire format), then 250 matching
            // ENDs to close them all - a crafted request could reach this depth in well under a kilobyte,
            // exercising the exact DoS surface the depth cap exists to close off.
            const bytes = nested(250);

            expect(WBXML_DEFAULT_MAX_DEPTH).toBe(64);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(WbxmlLimitError);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/exceeded maximum nesting depth of 64/);
            // Exactly at the default limit decodes fine; one more level fails.
            expect(() => new WbxmlDecoder().decode(nested(64))).not.toThrow();
            expect(() => new WbxmlDecoder().decode(nested(65))).toThrow(WbxmlLimitError);
        });

        it("Malformed-input errors are WbxmlDecodeError instances (and not WbxmlLimitError).", () => {
            let caught: unknown;
            try {
                new WbxmlDecoder().decode(Buffer.from([0x03]));
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(WbxmlDecodeError);
            expect(caught).not.toBeInstanceOf(WbxmlLimitError);
            expect((caught as Error).name).toBe("WbxmlDecodeError");
        });

        it("Throws when an OPAQUE length runs past the end of the buffer instead of silently truncating.", () => {
            // header + Sync(content) + OPAQUE, length 10, but only 2 payload bytes follow.
            const bytes = Buffer.from([...HEADER, 0x45, 0xc3, 0x0a, 0xaa, 0xbb]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(WbxmlDecodeError);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/OPAQUE length 10 runs past the end of the buffer/);
        });

        it("Accepts an OPAQUE payload that ends exactly at the END token.", () => {
            const bytes = Buffer.from([...HEADER, 0x45, 0xc3, 0x02, 0xaa, 0xbb, 0x01]);
            expect(new WbxmlDecoder().decode(bytes).opaque?.equals(Buffer.from([0xaa, 0xbb]))).toBe(true);
        });

        it("Throws when the string table length runs past the end of the buffer.", () => {
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x05, 0x05, 0x05]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(WbxmlDecodeError);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/string table length 5 runs past the end/);
        });

        it("Skips a non-empty string table that fits within the buffer.", () => {
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x02, 0x41, 0x42, 0x05]);
            expect(new WbxmlDecoder().decode(bytes)).toEqual(element(WbxmlCodePage.AirSync, "Sync"));
        });
    });

    describe("Decoder resource limits", () => {
        it("Exposes the documented default limits.", () => {
            expect(WBXML_DEFAULT_MAX_ELEMENTS).toBe(50_000);
            expect(WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT).toBe(10_000);
            expect(WBXML_DEFAULT_MAX_DEPTH).toBe(64);
            expect(WBXML_DEFAULT_MAX_INLINE_STRING_BYTES).toBe(4 * 1024 * 1024);
        });

        it("Throws WbxmlLimitError when a custom maxElements is exceeded (root counts as one element).", () => {
            // Root + 4 empty children = 5 elements.
            const bytes = flat(4);
            expect(new WbxmlDecoder({ maxElements: 5 }).decode(bytes).children).toHaveLength(4);
            expect(() => new WbxmlDecoder({ maxElements: 4 }).decode(bytes)).toThrow(WbxmlLimitError);
            expect(() => new WbxmlDecoder({ maxElements: 4 }).decode(bytes)).toThrow(
                /exceeded maximum element count of 4/,
            );
        });

        it("Counts elements across the whole document, not per parent.", () => {
            // Root > 2 containers > 3 empty children each = 1 + 2 + 6 = 9 elements.
            const container = [0x45, 0x05, 0x05, 0x05, 0x01];
            const bytes = Buffer.from([...HEADER, 0x45, ...container, ...container, 0x01]);
            expect(() => new WbxmlDecoder({ maxElements: 9 }).decode(bytes)).not.toThrow();
            expect(() => new WbxmlDecoder({ maxElements: 8 }).decode(bytes)).toThrow(WbxmlLimitError);
        });

        it("Throws WbxmlLimitError past the default maxElements even when no single element has too many children.", () => {
            // Root > 6 containers > 10,000 empty children each = 60,007 elements (~60 KB of wire bytes).
            const perContainer = WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT;
            const container = Buffer.concat([Buffer.from([0x45]), Buffer.alloc(perContainer, 0x05), Buffer.from([0x01])]);
            const bytes = Buffer.concat([
                Buffer.from([...HEADER, 0x45]),
                ...Array.from({ length: 6 }, () => container),
                Buffer.from([0x01]),
            ]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(WbxmlLimitError);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/exceeded maximum element count of 50000/);

            // Four containers (40,005 elements) stays within the default.
            const smaller = Buffer.concat([
                Buffer.from([...HEADER, 0x45]),
                ...Array.from({ length: 4 }, () => container),
                Buffer.from([0x01]),
            ]);
            expect(new WbxmlDecoder().decode(smaller).children).toHaveLength(4);
        });

        it("Throws WbxmlLimitError when one element exceeds the default maxChildrenPerElement.", () => {
            const bytes = flat(WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT + 1);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(WbxmlLimitError);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/exceeded maximum of 10000 children per element/);
            expect(new WbxmlDecoder().decode(flat(WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT)).children).toHaveLength(
                WBXML_DEFAULT_MAX_CHILDREN_PER_ELEMENT,
            );
        });

        it("Honors a custom maxChildrenPerElement.", () => {
            expect(new WbxmlDecoder({ maxChildrenPerElement: 3 }).decode(flat(3)).children).toHaveLength(3);
            expect(() => new WbxmlDecoder({ maxChildrenPerElement: 3 }).decode(flat(4))).toThrow(WbxmlLimitError);
        });

        it("Honors a custom maxDepth.", () => {
            expect(() => new WbxmlDecoder({ maxDepth: 3 }).decode(nested(3))).not.toThrow();
            expect(() => new WbxmlDecoder({ maxDepth: 3 }).decode(nested(4))).toThrow(
                /exceeded maximum nesting depth of 3/,
            );
            // A raised limit allows deeper documents than the default.
            expect(() => new WbxmlDecoder({ maxDepth: 100 }).decode(nested(100))).not.toThrow();
        });

        it("Throws WbxmlLimitError when a single STR_I run exceeds a custom maxInlineStringBytes.", () => {
            const bytes = new WbxmlEncoder().encode(textElement(WbxmlCodePage.AirSync, "Sync", "a".repeat(1000)));
            expect(() => new WbxmlDecoder({ maxInlineStringBytes: 999 }).decode(bytes)).toThrow(WbxmlLimitError);
            expect(() => new WbxmlDecoder({ maxInlineStringBytes: 999 }).decode(bytes)).toThrow(
                /exceeded maximum inline string \(STR_I\) total of 999 bytes/,
            );
            expect(new WbxmlDecoder({ maxInlineStringBytes: 1000 }).decode(bytes).text).toBe("a".repeat(1000));
        });

        it("Sums STR_I bytes across every element in the document, not just the largest one.", () => {
            // Two children, each carrying 600 bytes of inline text: 1200 bytes total, over a 1000-byte cap, even
            // though neither child alone would trip it.
            const bytes = new WbxmlEncoder().encode(
                element(WbxmlCodePage.AirSync, "Sync", [
                    textElement(WbxmlCodePage.AirSync, "Class", "b".repeat(600)),
                    textElement(WbxmlCodePage.AirSync, "Class", "c".repeat(600)),
                ]),
            );
            expect(() => new WbxmlDecoder({ maxInlineStringBytes: 1000 }).decode(bytes)).toThrow(WbxmlLimitError);
            expect(() => new WbxmlDecoder({ maxInlineStringBytes: 1200 }).decode(bytes)).not.toThrow();
        });

        it("Rejects an oversized inline string under the real default cap, not just a lowered test cap.", () => {
            // One STR_I run one byte over WBXML_DEFAULT_MAX_INLINE_STRING_BYTES - the poison-pill shape (a huge
            // Subject/Body/notes field) this cap exists to catch, with no other limit anywhere near tripped.
            const bytes = new WbxmlEncoder().encode(
                textElement(WbxmlCodePage.AirSync, "Sync", "x".repeat(WBXML_DEFAULT_MAX_INLINE_STRING_BYTES + 1)),
            );
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(WbxmlLimitError);
        });

        it("Honors a raised maxInlineStringBytes.", () => {
            const bytes = new WbxmlEncoder().encode(textElement(WbxmlCodePage.AirSync, "Sync", "d".repeat(2000)));
            expect(() => new WbxmlDecoder({ maxInlineStringBytes: 1000 }).decode(bytes)).toThrow(WbxmlLimitError);
            expect(new WbxmlDecoder({ maxInlineStringBytes: 2000 }).decode(bytes).text).toBe("d".repeat(2000));
        });

        it("Resets counters between decode() calls on the same instance.", () => {
            const decoder = new WbxmlDecoder({ maxElements: 5 });
            expect(() => decoder.decode(flat(4))).not.toThrow();
            expect(() => decoder.decode(flat(4))).not.toThrow();
        });

        it("Resets the inline-string byte counter between decode() calls on the same instance.", () => {
            const decoder = new WbxmlDecoder({ maxInlineStringBytes: 1000 });
            const bytes = new WbxmlEncoder().encode(textElement(WbxmlCodePage.AirSync, "Sync", "e".repeat(900)));
            expect(() => decoder.decode(bytes)).not.toThrow();
            // A second, independent document under the same cap must not fail from the first call's leftover count.
            expect(() => decoder.decode(bytes)).not.toThrow();
        });

        it("Rejects non-positive or non-integer limit options with a RangeError.", () => {
            expect(() => new WbxmlDecoder({ maxElements: 0 })).toThrow(RangeError);
            expect(() => new WbxmlDecoder({ maxChildrenPerElement: 1.5 })).toThrow(/maxChildrenPerElement/);
            expect(() => new WbxmlDecoder({ maxDepth: -1 })).toThrow(/maxDepth must be a positive integer/);
            expect(() => new WbxmlDecoder({ maxElements: Number.NaN })).toThrow(RangeError);
            expect(() => new WbxmlDecoder({ maxInlineStringBytes: 0 })).toThrow(/maxInlineStringBytes/);
        });
    });

    describe("Encoder chunking and size limits", () => {
        it("Produces byte-identical output to a naive reference encoder for a large opaque payload.", () => {
            const payload = Buffer.alloc(3 * 1024 * 1024);
            for (let i = 0; i < payload.length; i++) {
                payload[i] = (i * 31) & 0xff;
            }
            const tree = element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
                opaqueElement(WbxmlCodePage.ItemOperations, "Data", payload),
                textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
            ]);
            const encoded = new WbxmlEncoder().encode(tree);
            expect(encoded.equals(referenceEncode(tree))).toBe(true);
            expect(new WbxmlDecoder().decode(encoded).children[1].opaque?.equals(payload)).toBe(true);
        });

        it("Produces byte-identical output to a naive reference encoder for large text with NULs and multi-byte characters.", () => {
            const nul = String.fromCharCode(0);
            const text = `héllo${nul}日本😀 `.repeat(50_000);
            const tree = element(WbxmlCodePage.AirSync, "Sync", [textElement(WbxmlCodePage.Email, "Subject", text)]);
            const encoded = new WbxmlEncoder().encode(tree);
            expect(encoded.equals(referenceEncode(tree))).toBe(true);
            expect(new WbxmlDecoder().decode(encoded).children[0].text).toBe(text.split(nul).join(""));
        });

        it("Concatenates many token-only chunks correctly (output spans several scratch flushes).", () => {
            const children = Array.from({ length: WBXML_ENCODER_SCRATCH_SIZE * 2 }, (_, i) =>
                i % 3 === 0
                    ? element(WbxmlCodePage.Email, "Read")
                    : i % 3 === 1
                      ? textElement(WbxmlCodePage.AirSync, "SyncKey", String(i))
                      : opaqueElement(WbxmlCodePage.ItemOperations, "Data", Buffer.from([i & 0xff, 0x00])),
            );
            const tree = element(WbxmlCodePage.AirSync, "Sync", children);
            const encoded = new WbxmlEncoder().encode(tree);
            expect(encoded.length).toBeGreaterThan(WBXML_ENCODER_SCRATCH_SIZE * 3);
            expect(encoded.equals(referenceEncode(tree))).toBe(true);
            expect(new WbxmlDecoder({ maxChildrenPerElement: children.length }).decode(encoded)).toEqual(tree);
        });

        it("Concatenates token-only output that fills the scratch buffer several times, including an exact boundary.", () => {
            // header(4) + root tag(1) + N empty children + END(1): N = SCRATCH - 6 ends exactly on a flush boundary.
            for (const count of [WBXML_ENCODER_SCRATCH_SIZE - 6, WBXML_ENCODER_SCRATCH_SIZE * 3 + 17]) {
                const tree = element(
                    WbxmlCodePage.AirSync,
                    "Sync",
                    Array.from({ length: count }, () => element(WbxmlCodePage.AirSync, "Sync")),
                );
                const encoded = new WbxmlEncoder().encode(tree);
                expect(encoded.length).toBe(count + 6);
                expect(encoded.equals(flat(count))).toBe(true);
                expect(encoded.equals(referenceEncode(tree))).toBe(true);
            }
        });

        it("Encodes an empty opaque payload and empty text identically to the reference.", () => {
            const tree = element(WbxmlCodePage.AirSync, "Sync", [
                opaqueElement(WbxmlCodePage.ItemOperations, "Data", Buffer.alloc(0)),
                textElement(WbxmlCodePage.AirSync, "SyncKey", ""),
            ]);
            expect(new WbxmlEncoder().encode(tree).equals(referenceEncode(tree))).toBe(true);
        });

        it("Succeeds at exactly maxBytes and throws WbxmlSizeLimitError one byte below (text path).", () => {
            const tree = textElement(WbxmlCodePage.AirSync, "SyncKey", "x".repeat(1000));
            const exact = new WbxmlEncoder().encode(tree).length;
            expect(new WbxmlEncoder({ maxBytes: exact }).encode(tree).equals(referenceEncode(tree))).toBe(true);

            let caught: unknown;
            try {
                new WbxmlEncoder({ maxBytes: exact - 1 }).encode(tree);
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(WbxmlSizeLimitError);
            expect((caught as WbxmlSizeLimitError).name).toBe("WbxmlSizeLimitError");
            expect((caught as WbxmlSizeLimitError).maxBytes).toBe(exact - 1);
            expect((caught as Error).message).toMatch(new RegExp(`maximum size of ${exact - 1} bytes`));
        });

        it("Throws WbxmlSizeLimitError before appending an oversized opaque payload, and succeeds at exactly the limit.", () => {
            const payload = Buffer.alloc(200_000, 0x42);
            const tree = opaqueElement(WbxmlCodePage.ItemOperations, "Data", payload);
            // header(4) + SWITCH_PAGE(2) + tag(1) + OPAQUE token/length/payload + END(1)
            const exact = 4 + 2 + 1 + wbxmlOpaqueSize(payload.length) + 1;
            expect(new WbxmlEncoder().encode(tree).length).toBe(exact);
            expect(new WbxmlEncoder({ maxBytes: exact }).encode(tree).length).toBe(exact);
            expect(() => new WbxmlEncoder({ maxBytes: exact - 1 }).encode(tree)).toThrow(WbxmlSizeLimitError);
            expect(() => new WbxmlEncoder({ maxBytes: 1000 }).encode(tree)).toThrow(/maximum size of 1000 bytes/);
        });

        it("Throws WbxmlSizeLimitError on token bytes alone (header larger than the limit).", () => {
            expect(() => new WbxmlEncoder({ maxBytes: 3 }).encode(element(WbxmlCodePage.AirSync, "Sync"))).toThrow(
                WbxmlSizeLimitError,
            );
        });

        it("Reuses an encoder instance cleanly after a size-limit failure.", () => {
            const encoder = new WbxmlEncoder({ maxBytes: 20 });
            expect(() => encoder.encode(textElement(WbxmlCodePage.AirSync, "SyncKey", "x".repeat(100)))).toThrow(
                WbxmlSizeLimitError,
            );
            const small = textElement(WbxmlCodePage.AirSync, "SyncKey", "1");
            expect(encoder.encode(small).equals(referenceEncode(small))).toBe(true);
        });

        it("wbxmlOpaqueSize() accounts for the mb_u_int32 length width.", () => {
            expect(wbxmlOpaqueSize(0)).toBe(2);
            expect(wbxmlOpaqueSize(127)).toBe(1 + 1 + 127);
            expect(wbxmlOpaqueSize(128)).toBe(1 + 2 + 128);
            expect(wbxmlOpaqueSize(16_384)).toBe(1 + 3 + 16_384);
            for (const length of [0, 127, 128, 16_383, 16_384]) {
                const tree = opaqueElement(WbxmlCodePage.AirSync, "SyncKey", Buffer.alloc(length));
                // header(4) + tag(1) + opaque + END(1)
                expect(new WbxmlEncoder().encode(tree).length).toBe(4 + 1 + wbxmlOpaqueSize(length) + 1);
            }
        });

        it("Rejects an invalid maxBytes option with a RangeError, and accepts Infinity.", () => {
            expect(() => new WbxmlEncoder({ maxBytes: 0 })).toThrow(RangeError);
            expect(() => new WbxmlEncoder({ maxBytes: 1.5 })).toThrow(/maxBytes must be a positive integer or Infinity/);
            expect(() => new WbxmlEncoder({ maxBytes: Number.NaN })).toThrow(RangeError);
            expect(() => new WbxmlEncoder({ maxBytes: Infinity })).not.toThrow();
        });
    });

    describe("WbxmlElement helpers", () => {
        const parent: WbxmlElement = element(WbxmlCodePage.AirSync, "Collection", [
            textElement(WbxmlCodePage.AirSync, "SyncKey", "1"),
            textElement(WbxmlCodePage.AirSync, "CollectionId", "2"),
            textElement(WbxmlCodePage.AirSync, "CollectionId", "3"),
        ]);

        it("findChild() returns the first direct child with the given tag.", () => {
            expect(findChild(parent, "CollectionId")?.text).toBe("2");
        });

        it("findChild() returns undefined when no direct child matches.", () => {
            expect(findChild(parent, "Status")).toBeUndefined();
        });

        it("findChildren() returns every direct child with the given tag.", () => {
            expect(findChildren(parent, "CollectionId").map((c) => c.text)).toEqual(["2", "3"]);
        });

        it("childText() shorthand returns the first matching child's text value.", () => {
            expect(childText(parent, "SyncKey")).toBe("1");
        });

        it("childText() returns undefined when no direct child matches.", () => {
            expect(childText(parent, "Status")).toBeUndefined();
        });
    });
});
