///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import { type Contact, type ContactPostalAddress, ContactAddressKind } from "@rapidmx/restapi";

/** MS-ASCMD only has three positional email slots (`Email1Address`/`Email2Address`/`Email3Address`) - unlike
 * `ContactEmail.type`, EAS doesn't distinguish a "kind" per address, only position. Extra addresses beyond the
 * third are dropped, matching this library's "pragmatic subset" precedent elsewhere. */
const EMAIL_TAGS = ["Email1Address", "Email2Address", "Email3Address"] as const;

/** MS-ASCONTACTS street/city/state/postalCode/country tag prefixes, keyed by `ContactAddressKind`. There is no
 * generic "OtherPhoneNumber"-equivalent tag family gap here (Home/Business/Other all exist for addresses,
 * unlike phone numbers below), so all three kinds round-trip. */
const ADDRESS_PREFIX: Record<ContactAddressKind, string> = {
    [ContactAddressKind.HOME]: "Home",
    [ContactAddressKind.WORK]: "Business",
    [ContactAddressKind.OTHER]: "Other",
};

/** MS-ASCONTACTS has no `OtherPhoneNumber`-equivalent tag - only Home/Business phone numbers exist as plain
 * single-value tags (plus several Home2/Business2/Car/Radio/Pager/Fax variants this pragmatic subset doesn't
 * use). A phone tagged `OTHER` in this library's model has nowhere to go and is dropped, documented here rather
 * than silently - matching `FolderSyncCommand`'s own precedent for this kind of unavoidable field-count gap. */
const PHONE_TAG: Partial<Record<ContactAddressKind, string>> = {
    [ContactAddressKind.HOME]: "HomePhoneNumber",
    [ContactAddressKind.WORK]: "BusinessPhoneNumber",
};

/**
 * Maps `Contact` to/from the EAS `Sync` `Contacts` collection class (MS-ASCONTACTS/MS-ASCNTC2). Contacts are
 * also this library's GAL source (see the architecture note on `Contact` itself), but that's `SearchCommand`'s
 * concern, not this adapter's.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ContactsSyncAdapter implements EasCollectionSyncAdapter<Contact> {
    public readonly collectionClass = "Contacts";

    public toApplicationData(contact: Contact): WbxmlElement {
        const children: WbxmlElement[] = [
            // `?? ""` - a defensive fallback, not an expected case: `displayName` is typed as a required `string`,
            // but (the same "TypeORM hands back `null` for an unset column" hazard already documented on
            // `CalendarSyncAdapter`'s `organizer`/`reminderMinutesBeforeStart`) a row written before a NOT NULL
            // default existed, or by a path outside this library's own writers, could still hydrate `null` here -
            // and the WBXML encoder writes a `null` `text` value (it only treats `undefined` as "no content")
            // rather than rejecting it, so an unguarded `null` would throw deep inside the encoder instead of
            // rendering a usable (if blank) `FileAs`.
            textElement(WbxmlCodePage.Contacts, "FileAs", contact.displayName ?? ""),
            ...(contact.givenName ? [textElement(WbxmlCodePage.Contacts, "FirstName", contact.givenName)] : []),
            ...(contact.surname ? [textElement(WbxmlCodePage.Contacts, "LastName", contact.surname)] : []),
            ...(contact.company ? [textElement(WbxmlCodePage.Contacts, "CompanyName", contact.company)] : []),
            ...(contact.jobTitle ? [textElement(WbxmlCodePage.Contacts, "JobTitle", contact.jobTitle)] : []),
        ];

        // `?? []` on `emails`/`phones`/`addresses` below - same reasoning as `displayName` above: each is typed as
        // a required array, but a `simple-json` column (SQL) or document field (Mongo) written `null`/absent by
        // some path other than this library's own constructors hydrates as `null`/`undefined`, not `[]`, and
        // `.slice()`/`for...of` on that throws rather than rendering a contact with no entries of that kind.
        (contact.emails ?? []).slice(0, EMAIL_TAGS.length).forEach((email, i) => {
            children.push(textElement(WbxmlCodePage.Contacts, EMAIL_TAGS[i], email.address));
        });

        for (const phone of contact.phones ?? []) {
            const tag = PHONE_TAG[phone.type];
            if (tag) {
                children.push(textElement(WbxmlCodePage.Contacts, tag, phone.phoneNumber));
            }
        }

        for (const address of contact.addresses ?? []) {
            children.push(...this.addressElements(address));
        }

        if (contact.notes) {
            children.push(
                element(WbxmlCodePage.AirSyncBase, "Body", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                    textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(Buffer.byteLength(contact.notes, "utf8"))),
                    textElement(WbxmlCodePage.AirSyncBase, "Data", contact.notes),
                ]),
            );
        }

        if (contact.categories && contact.categories.length > 0) {
            children.push(
                element(
                    WbxmlCodePage.Contacts,
                    "Categories",
                    contact.categories.map((category) => textElement(WbxmlCodePage.Contacts, "Category", category)),
                ),
            );
        }

        return element(WbxmlCodePage.AirSync, "ApplicationData", children);
    }

    private addressElements(address: ContactPostalAddress): WbxmlElement[] {
        const prefix = ADDRESS_PREFIX[address.type];
        const parts: [string, string | undefined][] = [
            [`${prefix}Street`, address.street],
            [`${prefix}City`, address.city],
            [`${prefix}State`, address.state],
            [`${prefix}PostalCode`, address.postalCode],
            [`${prefix}Country`, address.country],
        ];
        return parts
            .filter((part): part is [string, string] => part[1] !== undefined)
            .map(([tag, value]) => textElement(WbxmlCodePage.Contacts, tag, value));
    }

    /**
     * Reverse of `toApplicationData`. Scalar fields (`FileAs`/`FirstName`/.../`JobTitle`, and the `Body`
     * `notes`) are properly ghosted - a field's own tag missing from `el` leaves that `Contact` field
     * untouched. `emails`/`phones`/`addresses` are ghosted only as a **whole group**, not per slot: if *none*
     * of a group's tags are present the group is left untouched, but if *any* one is, the entire group is
     * rebuilt from just what's present in `el` (a real client's own Contacts edit UI typically resends every
     * field it manages anyway, so this only under-preserves data for a client that deliberately sends a
     * single-slot partial update within one of these groups - a documented simplification, not silent data
     * loss for the common case). Emails lose their original `type` on any round trip through a `Change`
     * (rebuilt as `ContactAddressKind.OTHER`) since EAS's own `Email1/2/3Address` tags carry no kind at all,
     * matching `toApplicationData`'s own already-documented encode-side loss of the same information.
     * `categories` is ghosted as its own whole group (same rule as `emails`/`phones`/`addresses`): an absent
     * `Categories` element leaves `Contact.categories` untouched, while a present one - even `<Categories/>`
     * with no `Category` children - rebuilds it from scratch (an empty array clears it).
     *
     * **Phones specifically** also preserve any existing phone of a kind EAS has no tag for at all (see
     * `PHONE_TAG`'s own doc comment - `OTHER`, today) across a rebuild: a real device's Contacts edit UI only
     * ever sends `HomePhoneNumber`/`BusinessPhoneNumber`, so rebuilding the group from just those two (as every
     * other ghosted group here rebuilds from exactly what's present) would silently delete a phone number this
     * protocol simply has no way to round-trip, on the next edit of *any* phone field - discovered live via a
     * spec audit, not a hypothetical. `existing` is `undefined` only for client-originated `Add`, where there's
     * nothing to carry forward yet.
     */
    public fromApplicationData(el: WbxmlElement, existing?: Contact): Partial<Contact> {
        const partial: Partial<Contact> = {};

        const fileAs = childText(el, "FileAs");
        if (fileAs !== undefined) partial.displayName = fileAs;
        const firstName = childText(el, "FirstName");
        if (firstName !== undefined) partial.givenName = firstName;
        const lastName = childText(el, "LastName");
        if (lastName !== undefined) partial.surname = lastName;
        const companyName = childText(el, "CompanyName");
        if (companyName !== undefined) partial.company = companyName;
        const jobTitle = childText(el, "JobTitle");
        if (jobTitle !== undefined) partial.jobTitle = jobTitle;

        if (EMAIL_TAGS.some((tag) => findChild(el, tag))) {
            partial.emails = EMAIL_TAGS.map((tag) => childText(el, tag))
                .filter((address): address is string => !!address)
                .map((address) => ({ address, type: ContactAddressKind.OTHER }));
        }

        const phoneEntries = Object.entries(PHONE_TAG) as [ContactAddressKind, string][];
        if (phoneEntries.some(([, tag]) => findChild(el, tag))) {
            const taggedKinds = new Set(phoneEntries.map(([kind]) => kind));
            const preserved = (existing?.phones ?? []).filter((phone) => !taggedKinds.has(phone.type));
            partial.phones = [
                ...preserved,
                ...phoneEntries
                    .map(([type, tag]) => ({ type, phoneNumber: childText(el, tag) }))
                    .filter((phone): phone is { type: ContactAddressKind; phoneNumber: string } => !!phone.phoneNumber),
            ];
        }

        const addressKinds = Object.values(ContactAddressKind);
        const touchedKinds = addressKinds.filter((kind) => this.addressTags(kind).some((tag) => findChild(el, tag)));
        if (touchedKinds.length > 0) {
            partial.addresses = touchedKinds
                .map((kind) => this.parseAddress(el, kind))
                .filter((address): address is ContactPostalAddress => address !== undefined);
        }

        const bodyEl = findChild(el, "Body");
        const notes = bodyEl ? childText(bodyEl, "Data") : undefined;
        if (notes !== undefined) partial.notes = notes;

        const categoriesEl = findChild(el, "Categories");
        if (categoriesEl) {
            partial.categories = findChildren(categoriesEl, "Category")
                .map((category) => category.text)
                .filter((category): category is string => !!category);
        }

        return partial;
    }

    private addressTags(kind: ContactAddressKind): string[] {
        const prefix = ADDRESS_PREFIX[kind];
        return [`${prefix}Street`, `${prefix}City`, `${prefix}State`, `${prefix}PostalCode`, `${prefix}Country`];
    }

    private parseAddress(el: WbxmlElement, kind: ContactAddressKind): ContactPostalAddress | undefined {
        const prefix = ADDRESS_PREFIX[kind];
        const address: ContactPostalAddress = {
            type: kind,
            street: childText(el, `${prefix}Street`),
            city: childText(el, `${prefix}City`),
            state: childText(el, `${prefix}State`),
            postalCode: childText(el, `${prefix}PostalCode`),
            country: childText(el, `${prefix}Country`),
        };
        const hasAnyField = address.street || address.city || address.state || address.postalCode || address.country;
        return hasAnyField ? address : undefined;
    }
}
