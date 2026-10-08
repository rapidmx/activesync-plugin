///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// EmailSyncAdapter is pure mapping logic plus a BlobStore write for Draft bodies - toApplicationData and the
// end-to-end Add/Change flow are already exercised via test/routes/{mongo,sql}/EasRoute.test.ts's real Sync
// command tests; this file is reserved for fromApplicationData's own field-by-field ghosting/parsing edge
// cases (Importance/Read/Flag/address-list parsing), which are far more precise to verify directly than by
// threading every combination through a full HTTP+DB round trip, and newEntityDefaults() in isolation.
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { element, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { EmailSyncAdapter } from "../../src/adapters/EmailSyncAdapter.js";
import { FolderType, MessageImportance, RecipientType, type Mailbox, type Message } from "@rapidmx/restapi";

/** `EmailSyncAdapter` is abstract (it needs a backend-specific `labelClass`, supplied by
 * `EmailSyncAdapterMongo`/`SQL` in real use) - this minimal concrete subclass is all a backend-agnostic unit
 * test needs, since `labelClass` is only ever read by `@Init` (never invoked here; `labelRepo` is stubbed
 * directly instead, the same bypass-DI convention `blobStore` below already uses). */
class TestEmailSyncAdapter extends EmailSyncAdapter {
    protected labelClass: any = {};
    protected folderClass: any = {};
    protected attachmentClass: any = {};
}

function appData(children: WbxmlElement[]): WbxmlElement {
    return element(WbxmlCodePage.AirSync, "ApplicationData", children);
}

function buildAdapter(folderType: FolderType = FolderType.DRAFTS): {
    adapter: EmailSyncAdapter;
    put: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    labelFind: ReturnType<typeof vi.fn>;
    folderFindOne: ReturnType<typeof vi.fn>;
    attachmentFind: ReturnType<typeof vi.fn>;
} {
    const adapter = new TestEmailSyncAdapter();
    const put = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue(Buffer.from(""));
    (adapter as any).blobStore = { put, get, getStream: vi.fn(), delete: vi.fn(), exists: vi.fn(), size: vi.fn() };
    const labelFind = vi.fn().mockResolvedValue([]);
    (adapter as any).labelRepo = { find: labelFind };
    const folderFindOne = vi.fn().mockResolvedValue({ uid: "folder-1", type: folderType });
    (adapter as any).folderRepo = { findOne: folderFindOne };
    const attachmentFind = vi.fn().mockResolvedValue([]);
    (adapter as any).attachmentRepo = { find: attachmentFind };
    return { adapter, put, get, labelFind, folderFindOne, attachmentFind };
}

/** A minimal multipart/mixed raw MIME message carrying a `text/calendar` part - the shape
 * `extractIcsFromRaw()` (`simpleParser` under the hood) reads an invite's `.ics` out of. */
function inviteRawMime(ics: string): Buffer {
    return Buffer.from(
        [
            "Subject: Team Sync",
            "From: organizer@example.com",
            "To: owner@example.com",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="BOUNDARY"',
            "",
            "--BOUNDARY",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "You're invited.",
            "",
            "--BOUNDARY",
            'Content-Type: text/calendar; method=REQUEST; charset=utf-8; name="invite.ics"',
            'Content-Disposition: attachment; filename="invite.ics"',
            "",
            ics,
            "",
            "--BOUNDARY--",
            "",
        ].join("\r\n"),
    );
}

const VALID_INVITE_ICS = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:evt-1",
    "SEQUENCE:0",
    "DTSTART:20260615T120000Z",
    "DTEND:20260615T130000Z",
    "SUMMARY:Team Sync",
    "LOCATION:Conference Room",
    "ORGANIZER;CN=Boss:mailto:boss@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
].join("\r\n");

const baseMessage: Message = {
    uid: "msg-1",
    version: 1,
    dateCreated: new Date(),
    dateModified: new Date(),
    deleted: false,
    mailboxUid: "mbx-1",
    folderUid: "folder-1",
    messageId: "<existing@example.com>",
    subject: "Existing Subject",
    from: { address: "sender@example.com", type: RecipientType.TO },
    recipients: [{ address: "to@example.com", type: RecipientType.TO }],
    sentDate: new Date("2026-01-01T00:00:00.000Z"),
    receivedDate: new Date("2026-01-01T00:00:00.000Z"),
    bodyBlobKey: "bodies/existing",
    bodyPreview: "Existing body",
    flags: { read: false, flagged: false, answered: false, forwarded: false },
    importance: MessageImportance.NORMAL,
    references: [],
    hasAttachments: false,
    encrypted: false,
    deliveryReceiptPending: false,
    readReceiptPending: false,
    deliveryReceiptDeclined: false,
    readReceiptDeclined: false,
};

describe("EmailSyncAdapter Tests", () => {
    it("Reports the Email collection class.", () => {
        expect(new TestEmailSyncAdapter().collectionClass).toBe("Email");
    });

    describe("fromApplicationData", () => {
        it("Parses Subject when present, omitting it from the partial when absent.", async () => {
            const { adapter } = buildAdapter();
            const withSubject = await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Subject", "Hi")]));
            expect(withSubject.subject).toBe("Hi");

            const without = await adapter.fromApplicationData(appData([]));
            expect("subject" in without).toBe(false);
        });

        it("Parses a bare To address list.", async () => {
            const { adapter } = buildAdapter();
            const partial = await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "To", "a@example.com; b@example.com")]));
            expect(partial.recipients).toEqual([
                { address: "a@example.com", type: RecipientType.TO },
                { address: "b@example.com", type: RecipientType.TO },
            ]);
        });

        it("Parses To/Cc with display names, combining both into one recipients list.", async () => {
            const { adapter } = buildAdapter();
            const partial = await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "To", "Jane Doe <jane@example.com>"),
                    textElement(WbxmlCodePage.Email, "Cc", "John Smith <john@example.com>, plain@example.com, <bare@example.com>"),
                ]),
            );
            expect(partial.recipients).toEqual([
                { address: "jane@example.com", displayName: "Jane Doe", type: RecipientType.TO },
                { address: "john@example.com", displayName: "John Smith", type: RecipientType.CC },
                { address: "plain@example.com", type: RecipientType.CC },
                { address: "bare@example.com", type: RecipientType.CC },
            ]);
        });

        it("Leaves recipients untouched when neither To, Cc, nor Bcc is present.", async () => {
            const { adapter } = buildAdapter();
            const partial = await adapter.fromApplicationData(appData([]));
            expect("recipients" in partial).toBe(false);
        });

        it("Parses Bcc into the recipients list alongside To/Cc.", async () => {
            const { adapter } = buildAdapter();
            const partial = await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "To", "to@example.com"),
                    textElement(WbxmlCodePage.Email2, "Bcc", "hidden@example.com"),
                ]),
            );
            expect(partial.recipients).toEqual([
                { address: "to@example.com", type: RecipientType.TO },
                { address: "hidden@example.com", type: RecipientType.BCC },
            ]);
        });

        it("Preserves existing Cc/Bcc recipients when a Change touches only To, ghosting each type independently.", async () => {
            const { adapter } = buildAdapter();
            const existing: Message = {
                ...baseMessage,
                recipients: [
                    { address: "old-to@example.com", type: RecipientType.TO },
                    { address: "keep-cc@example.com", type: RecipientType.CC },
                    { address: "keep-bcc@example.com", type: RecipientType.BCC },
                ],
            };
            const partial = await adapter.fromApplicationData(
                appData([textElement(WbxmlCodePage.Email, "To", "new-to@example.com")]),
                existing,
            );
            expect(partial.recipients).toEqual([
                { address: "keep-cc@example.com", type: RecipientType.CC },
                { address: "keep-bcc@example.com", type: RecipientType.BCC },
                { address: "new-to@example.com", type: RecipientType.TO },
            ]);
        });

        it("Keeps the text, not the markup, of a Draft whose Body is HTML (Type 2) in its preview and MIME.", async () => {
            const { adapter, put } = buildAdapter();
            const partial = await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "To", "to@example.com"),
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", "2"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", "<div dir='auto'>Yay.</div>"),
                    ]),
                ]),
            );

            expect(partial.bodyPreview).toBe("Yay.");
            expect((put.mock.calls[0][1] as Buffer).toString("utf-8")).not.toContain("<div");
        });

        it("Includes a Bcc header in the built Draft MIME when Bcc recipients are present.", async () => {
            const { adapter, put } = buildAdapter();
            await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "To", "to@example.com"),
                    textElement(WbxmlCodePage.Email2, "Bcc", "hidden@example.com"),
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", "Body text"),
                    ]),
                ]),
            );

            const mime = (put.mock.calls[0][1] as Buffer).toString("utf-8");
            expect(mime).toContain("Bcc: hidden@example.com");
        });

        it("Clears Cc to empty when Change sends an empty Cc, without touching To/Bcc.", async () => {
            const { adapter } = buildAdapter();
            const existing: Message = {
                ...baseMessage,
                recipients: [
                    { address: "keep-to@example.com", type: RecipientType.TO },
                    { address: "old-cc@example.com", type: RecipientType.CC },
                    { address: "keep-bcc@example.com", type: RecipientType.BCC },
                ],
            };
            const partial = await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Cc", "")]), existing);
            expect(partial.recipients).toEqual([
                { address: "keep-to@example.com", type: RecipientType.TO },
                { address: "keep-bcc@example.com", type: RecipientType.BCC },
            ]);
        });

        it("Maps every Importance code to its MessageImportance, defaulting an unrecognized code to NORMAL.", async () => {
            const { adapter } = buildAdapter();
            expect((await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Importance", "0")]))).importance).toBe(
                MessageImportance.LOW,
            );
            expect((await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Importance", "2")]))).importance).toBe(
                MessageImportance.HIGH,
            );
            expect((await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Importance", "9")]))).importance).toBe(
                MessageImportance.NORMAL,
            );
        });

        it("Leaves importance untouched when the tag is absent.", async () => {
            const { adapter } = buildAdapter();
            expect("importance" in (await adapter.fromApplicationData(appData([])))).toBe(false);
        });

        it("Builds flags from class defaults when Read/Flag are set on a fresh item (no existing).", async () => {
            const { adapter } = buildAdapter();
            const partial = await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "Read", "1"),
                    element(WbxmlCodePage.Email, "Flag", [textElement(WbxmlCodePage.Email, "FlagStatus", "2")]),
                ]),
            );
            expect(partial.flags).toEqual({ read: true, flagged: true, answered: false, forwarded: false });
        });

        it("Reads Flag as a container: an empty Flag or a completed Status clears the flag.", async () => {
            const { adapter } = buildAdapter();
            const flagged: Message = { ...baseMessage, flags: { ...baseMessage.flags, flagged: true } };
            const cleared = await adapter.fromApplicationData(appData([element(WbxmlCodePage.Email, "Flag", [])]), flagged);
            expect(cleared.flags?.flagged).toBe(false);
            const completed = await adapter.fromApplicationData(
                appData([element(WbxmlCodePage.Email, "Flag", [textElement(WbxmlCodePage.Email, "FlagStatus", "1")])]),
                flagged,
            );
            expect(completed.flags?.flagged).toBe(false);
        });

        it("Merges only the touched flag onto existing's other flags when only one of Read/Flag is present.", async () => {
            const { adapter } = buildAdapter();
            const existing: Message = { ...baseMessage, flags: { read: false, flagged: false, answered: true, forwarded: true } };
            const partial = await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Read", "1")]), existing);
            expect(partial.flags).toEqual({ read: true, flagged: false, answered: true, forwarded: true });
        });

        it("Leaves flags untouched when neither Read nor Flag is present.", async () => {
            const { adapter } = buildAdapter();
            expect("flags" in (await adapter.fromApplicationData(appData([])))).toBe(false);
        });

        it("Writes a new blob key and minimal MIME body for an Add (no existing item).", async () => {
            const { adapter, put } = buildAdapter();
            const partial = await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "Subject", "New Draft"),
                    textElement(WbxmlCodePage.Email, "To", "to@example.com"),
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", "Body text"),
                    ]),
                ]),
            );

            expect(partial.bodyBlobKey).toMatch(/^bodies\//);
            expect(partial.bodyPreview).toBe("Body text");
            expect(put).toHaveBeenCalledTimes(1);
            const [key, buffer, options] = put.mock.calls[0];
            expect(key).toBe(partial.bodyBlobKey);
            expect(options).toEqual({ contentType: "message/rfc822" });
            const mime = (buffer as Buffer).toString("utf-8");
            expect(mime).toContain("Subject: New Draft");
            expect(mime).toContain("To: to@example.com");
            expect(mime).toContain("Body text");
        });

        it("Strips embedded CR/LF from Subject/To before building MIME headers, rather than letting them inject extra header lines.", async () => {
            const { adapter, put } = buildAdapter();
            await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "Subject", "Hi\r\nBcc: attacker@evil.com\r\nX-Injected: yes"),
                    textElement(WbxmlCodePage.Email, "To", "victim@example.com"),
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", "Body text"),
                    ]),
                ]),
            );

            const mime = (put.mock.calls[0][1] as Buffer).toString("utf-8");
            // Exactly one Subject line, folded onto itself - no separate Bcc/X-Injected header line anywhere.
            expect(mime).toContain("Subject: Hi Bcc: attacker@evil.com X-Injected: yes");
            expect(mime).not.toMatch(/^Bcc:/m);
            expect(mime).not.toMatch(/^X-Injected:/m);
            // The header block still ends with exactly one blank line before the real body - a smuggled blank
            // line inside Subject would otherwise have terminated the headers early.
            expect(mime.split("\r\n\r\n").length).toBe(2);
            expect(mime.endsWith("Body text")).toBe(true);
        });

        it("Omits the To header and includes only Cc when a Draft has Cc but no To recipients.", async () => {
            const { adapter, put } = buildAdapter();
            const partial = await adapter.fromApplicationData(
                appData([
                    textElement(WbxmlCodePage.Email, "Cc", "cc-only@example.com"),
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", "Body text"),
                    ]),
                ]),
            );

            const mime = (put.mock.calls[0][1] as Buffer).toString("utf-8");
            expect(mime).not.toContain("To:");
            expect(mime).toContain("Cc: cc-only@example.com");
            expect(partial.recipients).toEqual([{ address: "cc-only@example.com", type: RecipientType.CC }]);
        });

        it("Writes a Draft's changed body to a fresh blob key, never overwriting existing.bodyBlobKey.", async () => {
            const { adapter, put, folderFindOne } = buildAdapter();
            const partial = await adapter.fromApplicationData(
                appData([
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", "Updated text"),
                    ]),
                ]),
                baseMessage,
            );

            expect(folderFindOne).toHaveBeenCalledWith(baseMessage.folderUid, { ignoreACL: true });
            expect(partial.bodyBlobKey).toMatch(/^bodies\//);
            expect(partial.bodyBlobKey).not.toBe(baseMessage.bodyBlobKey);
            expect(partial.bodyPreview).toBe("Updated text");
            expect(put).toHaveBeenCalledTimes(1);
            expect(put).toHaveBeenCalledWith(partial.bodyBlobKey, expect.any(Buffer), { contentType: "message/rfc822" });
            const mime = (put.mock.calls[0][1] as Buffer).toString("utf-8");
            // Falls back to existing's own Subject/From/recipients when the Change doesn't touch them.
            expect(mime).toContain(`Subject: ${baseMessage.subject}`);
            expect(mime).toContain(`From: ${baseMessage.from.address}`);
        });

        it("Mints a fresh blob key on Change when existing.bodyBlobKey was never set (no prior Body on Add).", async () => {
            const { adapter, put } = buildAdapter();
            const existingWithNoBody: Message = { ...baseMessage, bodyBlobKey: "" };
            const partial = await adapter.fromApplicationData(
                appData([
                    element(WbxmlCodePage.AirSyncBase, "Body", [
                        textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                        textElement(WbxmlCodePage.AirSyncBase, "Data", "First body"),
                    ]),
                ]),
                existingWithNoBody,
            );
            expect(partial.bodyBlobKey).toMatch(/^bodies\//);
            expect(partial.bodyBlobKey).not.toBe("");
            expect(put).toHaveBeenCalledTimes(1);
        });

        it("Refuses a Body change on a message outside the Drafts folder (or whose folder is gone) without writing a blob.", async () => {
            for (const folderType of [FolderType.INBOX, FolderType.SENT_ITEMS, undefined]) {
                const { adapter, put, folderFindOne } = buildAdapter(folderType);
                if (folderType === undefined) {
                    folderFindOne.mockResolvedValue(undefined);
                }
                await expect(
                    adapter.fromApplicationData(
                        appData([
                            element(WbxmlCodePage.AirSyncBase, "Body", [
                                textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                                textElement(WbxmlCodePage.AirSyncBase, "Data", "Tampered"),
                            ]),
                        ]),
                        baseMessage,
                    ),
                ).rejects.toMatchObject({ status: 400 });
                expect(put).not.toHaveBeenCalled();
            }
        });

        it("Refuses a Body change on a delivered message that was moved into Drafts (it carries a scan result).", async () => {
            const { adapter, put } = buildAdapter(FolderType.DRAFTS);
            await expect(
                adapter.fromApplicationData(
                    appData([element(WbxmlCodePage.AirSyncBase, "Body", [textElement(WbxmlCodePage.AirSyncBase, "Data", "Forged")])]),
                    { ...baseMessage, scanResultUid: "scan-1" },
                ),
            ).rejects.toMatchObject({ status: 400 });
            expect(put).not.toHaveBeenCalled();
        });

        it("Still applies a non-body Change (Read) to a message outside the Drafts folder.", async () => {
            const { adapter, put, folderFindOne } = buildAdapter(FolderType.INBOX);
            const partial = await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Read", "1")]), baseMessage);
            expect(partial.flags?.read).toBe(true);
            expect(folderFindOne).not.toHaveBeenCalled();
            expect(put).not.toHaveBeenCalled();
        });

        it("Leaves the body untouched when no Body element is present.", async () => {
            const { adapter, put } = buildAdapter();
            const partial = await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Subject", "No body")]), baseMessage);
            expect("bodyBlobKey" in partial).toBe(false);
            expect("bodyPreview" in partial).toBe(false);
            expect(put).not.toHaveBeenCalled();
        });

        it("Returns an empty partial for an ApplicationData element with no recognized children.", async () => {
            const { adapter } = buildAdapter();
            expect(await adapter.fromApplicationData(appData([]), baseMessage)).toEqual({});
        });

        it("Always writes a body blob for a new Draft, empty when no Body was sent, From the caller's mailbox.", async () => {
            const { adapter, put } = buildAdapter();
            const mailbox = { primarySmtpAddress: "me@example.com", displayName: "Me" } as Mailbox;
            const partial = await adapter.fromApplicationData(appData([textElement(WbxmlCodePage.Email, "Subject", "Draft")]), undefined, mailbox);
            expect(partial.bodyBlobKey).toMatch(/^bodies\//);
            expect(partial.bodyPreview).toBe("");
            const mime = (put.mock.calls[0][1] as Buffer).toString("utf-8");
            expect(mime).toContain("From: Me <me@example.com>");
            expect(mime.endsWith("\r\n\r\n")).toBe(true);
        });
    });

    describe("newEntityDefaults", () => {
        it("Populates from the caller's own mailbox and sensible blank-draft defaults.", () => {
            const adapter = new TestEmailSyncAdapter();
            const mailbox: Mailbox = {
                uid: "mbx-1",
                primarySmtpAddress: "owner@example.com",
                displayName: "Owner Name",
            } as unknown as Mailbox;

            const defaults = adapter.newEntityDefaults(mailbox);

            expect(defaults.from).toEqual({ address: "owner@example.com", displayName: "Owner Name", type: RecipientType.TO });
            expect(defaults.subject).toBe("");
            expect(defaults.recipients).toEqual([]);
            expect(defaults.bodyBlobKey).toBe("");
            expect(defaults.bodyPreview).toBe("");
            expect(defaults.importance).toBe(MessageImportance.NORMAL);
            expect(defaults.flags).toEqual({ read: true, flagged: false, answered: false, forwarded: false });
            expect(defaults.hasAttachments).toBe(false);
            expect(defaults.references).toEqual([]);
            expect(defaults.messageId).toMatch(/^<.+@eas>$/);
        });
    });

    describe("toApplicationDataBatch", () => {
        const L1 = "11111111-1111-4111-8111-111111111111";
        const L2 = "22222222-2222-4222-8222-222222222222";
        const STALE = "33333333-3333-4333-8333-333333333333";
        const categoriesOf = (el: WbxmlElement): string[] | undefined =>
            el.children.find((child) => child.tag === "Categories")?.children.map((child) => child.text!);

        it("Resolves every page's labels with one in(...) find per mailbox, not one per labelled message.", async () => {
            const { adapter, labelFind } = buildAdapter();
            labelFind.mockImplementation(async (query: any) => {
                const all = [
                    { uid: L1, mailboxUid: "mbx-1", name: "Important" },
                    { uid: L2, mailboxUid: "mbx-1", name: "Follow Up" },
                    { uid: L1, mailboxUid: "mbx-2", name: "Other Mailbox" },
                ];
                const uids: string[] = /^in\((.*)\)$/.exec(query.uid)![1].split(",");
                return all.filter((label) => label.mailboxUid === query.mailboxUid && uids.includes(label.uid));
            });
            const messages: Message[] = [
                { ...baseMessage, uid: "m1", labelUids: [L2, L1, STALE] },
                { ...baseMessage, uid: "m2", labelUids: [L1, L1] },
                { ...baseMessage, uid: "m3" },
                { ...baseMessage, uid: "m4", mailboxUid: "mbx-2", labelUids: [L1] },
            ];

            const rendered = await adapter.toApplicationDataBatch(messages);

            expect(labelFind).toHaveBeenCalledTimes(2);
            const mbx1Query = labelFind.mock.calls.find(([query]) => query.mailboxUid === "mbx-1")![0];
            expect(mbx1Query.uid.split(",").length).toBe(3);
            expect(rendered.map(categoriesOf)).toEqual([["Follow Up", "Important"], ["Important"], undefined, ["Other Mailbox"]]);
        });

        it("Never splices a non-UUID labelUids entry (me, commas, operators, uppercase) into the in(...) lookup.", async () => {
            const { adapter, labelFind } = buildAdapter();
            labelFind.mockResolvedValue([{ uid: L1, mailboxUid: "mbx-1", name: "Important" }]);

            const [rendered] = await adapter.toApplicationDataBatch([
                { ...baseMessage, labelUids: ["me", `${L1},${L2}`, "like(*)", L1.toUpperCase(), "", L1] },
            ]);

            expect(labelFind).toHaveBeenCalledTimes(1);
            expect(labelFind.mock.calls[0][0].uid).toBe(`in(${L1})`);
            expect(categoriesOf(rendered)).toEqual(["Important"]);

            labelFind.mockClear();
            await adapter.toApplicationDataBatch([{ ...baseMessage, labelUids: ["me", "a,b"] }]);
            expect(labelFind).not.toHaveBeenCalled();
        });

        it("Never queries the Label repo when no message has labels, and toApplicationData() matches the batch form.", async () => {
            const { adapter, labelFind } = buildAdapter();
            const [batched] = await adapter.toApplicationDataBatch([baseMessage]);
            expect(await adapter.toApplicationData(baseMessage)).toEqual(batched);
            expect(await adapter.toApplicationDataBatch([])).toEqual([]);
            expect(labelFind).not.toHaveBeenCalled();
        });

        const attachmentsOf = (el: WbxmlElement) => el.children.find((child) => child.tag === "Attachments")?.children;
        const meetingRequestOf = (el: WbxmlElement) => el.children.find((child) => child.tag === "MeetingRequest");

        it("Renders Attachments for every hasAttachments message in one in(...) query, and queries nothing when none have attachments.", async () => {
            const { adapter, attachmentFind } = buildAdapter();
            attachmentFind.mockResolvedValue([
                { uid: "att-1", messageUid: "m1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 1234, isInline: false },
                { uid: "att-2", messageUid: "m1", filename: "logo.png", mimeType: "image/png", sizeBytes: 42, isInline: true, contentId: "logo@inline" },
            ]);
            const [withAttachments, without] = await adapter.toApplicationDataBatch([
                { ...baseMessage, uid: "m1", hasAttachments: true },
                { ...baseMessage, uid: "m2", hasAttachments: false },
            ]);

            expect(attachmentFind).toHaveBeenCalledTimes(1);
            expect(attachmentFind.mock.calls[0][0].messageUid).toBe("in(m1)");
            const rendered = attachmentsOf(withAttachments)!;
            expect(rendered.map((a) => a.children.find((c) => c.tag === "DisplayName")?.text)).toEqual(["report.pdf", "logo.png"]);
            expect(rendered[0].children.find((c) => c.tag === "FileReference")?.text).toBe("att-1");
            expect(rendered[0].children.find((c) => c.tag === "EstimatedDataSize")?.text).toBe("1234");
            expect(rendered[0].children.find((c) => c.tag === "IsInline")?.text).toBe("0");
            expect(rendered[1].children.find((c) => c.tag === "IsInline")?.text).toBe("1");
            expect(rendered[1].children.find((c) => c.tag === "ContentId")?.text).toBe("logo@inline");
            expect(attachmentsOf(without)).toBeUndefined();

            attachmentFind.mockClear();
            await adapter.toApplicationDataBatch([{ ...baseMessage, hasAttachments: false }]);
            expect(attachmentFind).not.toHaveBeenCalled();
        });

        it("Renders a MeetingRequest for a REQUEST invite whose raw MIME has a readable .ics, derived via the shared restapi invite-parsing utilities.", async () => {
            const { adapter, get } = buildAdapter();
            get.mockResolvedValue(inviteRawMime(VALID_INVITE_ICS));

            const [rendered] = await adapter.toApplicationDataBatch([
                { ...baseMessage, meetingMethod: "REQUEST", bodyBlobKey: "bodies/invite-1" },
            ]);

            expect(get).toHaveBeenCalledWith("bodies/invite-1");
            const meetingRequest = meetingRequestOf(rendered)!;
            expect(meetingRequest).toBeDefined();
            const field = (tag: string) => meetingRequest.children.find((c) => c.tag === tag)?.text;
            expect(field("StartTime")).toBe("20260615T120000Z");
            expect(field("EndTime")).toBe("20260615T130000Z");
            expect(field("Location")).toBe("Conference Room");
            expect(field("Organizer")).toBe("boss@example.com");
            expect(field("AllDayEvent")).toBe("0");
            expect(field("ResponseRequested")).toBe("1");
            expect(field("InstanceType")).toBe("0");
        });

        it("Omits MeetingRequest (without failing the message) when the .ics is unreadable, has no method, or is simply absent.", async () => {
            const { adapter, get } = buildAdapter();

            get.mockResolvedValueOnce(inviteRawMime("not a valid calendar file"));
            const [unreadable] = await adapter.toApplicationDataBatch([{ ...baseMessage, meetingMethod: "REQUEST", bodyBlobKey: "bodies/bad" }]);
            expect(meetingRequestOf(unreadable)).toBeUndefined();

            get.mockRejectedValueOnce(new Error("blob store down"));
            const [blobFailure] = await adapter.toApplicationDataBatch([{ ...baseMessage, meetingMethod: "REQUEST", bodyBlobKey: "bodies/missing" }]);
            expect(meetingRequestOf(blobFailure)).toBeUndefined();

            const [notAnInvite] = await adapter.toApplicationDataBatch([{ ...baseMessage, bodyBlobKey: "bodies/plain" }]);
            expect(meetingRequestOf(notAnInvite)).toBeUndefined();
            expect(get).toHaveBeenCalledTimes(2);
        });

        const fieldOf = (el: WbxmlElement, tag: string): string | undefined => el.children.find((c) => c.tag === tag)?.text;

        it("Renders MessageClass for a REQUEST/CANCEL invite - the signal a real client's Accept/Decline UI actually keys off, checked before it ever looks inside MeetingRequest - and omits it for an ordinary email.", async () => {
            const { adapter } = buildAdapter();
            const [request] = await adapter.toApplicationDataBatch([{ ...baseMessage, meetingMethod: "REQUEST" }]);
            expect(fieldOf(request, "MessageClass")).toBe("IPM.Schedule.Meeting.Request");

            const [cancel] = await adapter.toApplicationDataBatch([{ ...baseMessage, meetingMethod: "CANCEL" }]);
            expect(fieldOf(cancel, "MessageClass")).toBe("IPM.Schedule.Meeting.Canceled");

            const [reply] = await adapter.toApplicationDataBatch([{ ...baseMessage, meetingMethod: "REPLY" }]);
            expect(fieldOf(reply, "MessageClass")).toBeUndefined();

            const [plain] = await adapter.toApplicationDataBatch([baseMessage]);
            expect(fieldOf(plain, "MessageClass")).toBeUndefined();
        });

        describe("BodyPreference", () => {
            it("Falls back to the short bodyPreview, always Truncated 1, when the device sends no BodyPreference at all.", async () => {
                const { adapter, get } = buildAdapter();
                const [rendered] = await adapter.toApplicationDataBatch([baseMessage]);
                const body = rendered.children.find((c) => c.tag === "Body")!;
                expect(fieldOf(body, "Type")).toBe("1");
                expect(fieldOf(body, "Data")).toBe(baseMessage.bodyPreview);
                expect(fieldOf(body, "Truncated")).toBe("1");
                expect(get).not.toHaveBeenCalled();
            });

            it("Sends the real plain-text body (parsed from bodyBlobKey's raw MIME) when the device asks for Type 1, marking Truncated 0 when it fits whole.", async () => {
                const { adapter, get } = buildAdapter();
                get.mockResolvedValue(Buffer.from("Subject: X\r\nFrom: a@x.com\r\n\r\nThe full real body, much longer than the preview.", "utf-8"));
                const [rendered] = await adapter.toApplicationDataBatch([{ ...baseMessage, bodyBlobKey: "bodies/full-1" }], { type: "1" });
                expect(get).toHaveBeenCalledWith("bodies/full-1");
                const body = rendered.children.find((c) => c.tag === "Body")!;
                expect(fieldOf(body, "Type")).toBe("1");
                expect(fieldOf(body, "Data")).toBe("The full real body, much longer than the preview.");
                expect(fieldOf(body, "Truncated")).toBe("0");
            });

            it("Prefers the already-sanitized HTML body over raw-MIME-derived text when the device asks for Type 2 and one exists.", async () => {
                const { adapter, get } = buildAdapter();
                get.mockResolvedValue(Buffer.from("<p>Sanitized HTML body</p>", "utf-8"));
                const [rendered] = await adapter.toApplicationDataBatch(
                    [{ ...baseMessage, bodyBlobKey: "bodies/x", sanitizedHtmlBlobKey: "sanitized/x" }],
                    { type: "2" },
                );
                expect(get).toHaveBeenCalledWith("sanitized/x");
                const body = rendered.children.find((c) => c.tag === "Body")!;
                expect(fieldOf(body, "Type")).toBe("2");
                expect(fieldOf(body, "Data")).toBe("<p>Sanitized HTML body</p>");
            });

            it("Sends the verbatim raw MIME source when the device asks for Type 4, the same explicit-raw-source preference ItemOperationsCommand.fetchMessage() already honours - the mechanism Sync's own embedded Commands/Fetch (not ItemOperations) uses for a real device's (Apple Mail) full-body fetch.", async () => {
                const { adapter, get } = buildAdapter();
                const rawMime = "Subject: X\r\nFrom: a@x.com\r\n\r\nRaw MIME body, verbatim.";
                get.mockResolvedValue(Buffer.from(rawMime, "utf-8"));
                const [rendered] = await adapter.toApplicationDataBatch([{ ...baseMessage, bodyBlobKey: "bodies/raw-1", sanitizedHtmlBlobKey: "sanitized/x" }], { type: "4" });
                expect(get).toHaveBeenCalledWith("bodies/raw-1");
                const body = rendered.children.find((c) => c.tag === "Body")!;
                expect(fieldOf(body, "Type")).toBe("4");
                expect(fieldOf(body, "Data")).toBe(rawMime);
                // NativeBodyType is never "4" (MIME is the wrapper, not a native body format) - it falls back to
                // this message's real native format, HTML here since a sanitized HTML blob exists.
                expect(fieldOf(rendered, "NativeBodyType")).toBe("2");
            });

            it("Falls back NativeBodyType to plain text (not HTML) for a Type 4 fetch when the message has no sanitized HTML body at all.", async () => {
                const { adapter, get } = buildAdapter();
                get.mockResolvedValue(Buffer.from("Subject: X\r\n\r\nRaw MIME, plain-text message.", "utf-8"));
                const [rendered] = await adapter.toApplicationDataBatch([{ ...baseMessage, bodyBlobKey: "bodies/raw-2", sanitizedHtmlBlobKey: undefined }], { type: "4" });
                expect(fieldOf(rendered, "NativeBodyType")).toBe("1");
            });

            it("Truncates to the requested TruncationSize and marks Truncated 1, reporting the pre-truncation EstimatedDataSize - the same truncateUtf8() ItemOperationsCommand.fetchMessage() already uses, shared rather than reimplemented.", async () => {
                const { adapter, get } = buildAdapter();
                get.mockResolvedValue(Buffer.from("Subject: X\r\n\r\n0123456789", "utf-8"));
                const [rendered] = await adapter.toApplicationDataBatch([{ ...baseMessage, bodyBlobKey: "bodies/long" }], { type: "1", truncationSize: 5 });
                const body = rendered.children.find((c) => c.tag === "Body")!;
                expect(fieldOf(body, "Data")).toBe("01234");
                expect(fieldOf(body, "Truncated")).toBe("1");
                expect(fieldOf(body, "EstimatedDataSize")).toBe("10");
            });

            it("Falls back to the short bodyPreview for one message whose blob can't be read, without failing the whole batch.", async () => {
                const { adapter, get } = buildAdapter();
                get.mockRejectedValueOnce(new Error("blob store down"));
                const [rendered] = await adapter.toApplicationDataBatch([{ ...baseMessage, bodyBlobKey: "bodies/missing" }], { type: "1" });
                const body = rendered.children.find((c) => c.tag === "Body")!;
                expect(fieldOf(body, "Data")).toBe(baseMessage.bodyPreview);
                expect(fieldOf(body, "Truncated")).toBe("1");
            });
        });
    });
});
