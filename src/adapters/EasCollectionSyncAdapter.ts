///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RecoverableBaseEntity, RepoUtils } from "@rapidrest/service-core";
import type { Mailbox } from "@rapidmx/restapi";
import type { WbxmlElement } from "../codec/WbxmlElement.js";

/**
 * Maps one application entity type (`Message`/`Contact`/`CalendarEvent`/`Task`) to and from the EAS `Sync`
 * command's per-collection wire representation. `SyncCommand` itself only knows the generic Add/Change/Delete
 * cursor mechanics (shared with `FolderSyncCommand` via `EasSyncKeyUtils`) - everything entity-specific (which
 * fields go in `ApplicationData`, on which code pages) lives in one adapter per collection type, keyed by the
 * MS-ASCMD `Class` value (`"Email"`, `"Contacts"`, `"Calendar"`, `"Tasks"`) it answers to.
 *
 * `fromApplicationData` is deliberately optional: `SyncCommand` uses its absence as the capability check,
 * answering Status `6` for `Add`/`Change` on a collection whose adapter doesn't implement it, rather than
 * needing a separate flag that could drift out of sync with which adapters actually implement it. Every
 * adapter today (`Email`, `Contacts`, `Calendar`, `Tasks`) implements it.
 *
 * @author Jean-Philippe Steinmetz
 */
/** The device's MS-ASAIRSYNCBASE `Options/BodyPreference` for a collection's `Sync` round, as `SyncCommand`
 * parses it from the request - `type` is the requested `Body.Type` (`"1"` plain text, `"2"` HTML; anything else
 * falls back to plain text), `truncationSize` the most bytes of it the device wants inline, or `undefined` for
 * no limit (MS-ASAIRSYNCBASE leaves `TruncationSize` optional; its absence is read as "no truncation wanted",
 * not "send nothing"). Only `EmailSyncAdapter` uses this today - every other adapter's `Body` (where it renders
 * one at all) is small enough that this doesn't apply. */
export interface SyncBodyPreference {
    type?: string;
    truncationSize?: number;
}

export interface EasCollectionSyncAdapter<T extends RecoverableBaseEntity> {
    /** The MS-ASCMD `Class` value this adapter handles, e.g. `"Email"`. */
    readonly collectionClass: string;

    /** Builds the `<ApplicationData>` element for one `Add`/`Change` command reporting `item`. May return a
     * `Promise` - `EmailSyncAdapter` needs this to resolve `Message.labelUids` against the `Label` repo before
     * rendering `Categories`; every other adapter today returns a plain `WbxmlElement`, which callers `await`
     * through unchanged (the same optional-async shape `fromApplicationData` already established below).
     * `bodyPreference` is the device's `Options/BodyPreference` for this round, when it sent one - adapters that
     * don't need it (everything but `EmailSyncAdapter`) simply ignore the parameter. */
    toApplicationData(item: T, bodyPreference?: SyncBodyPreference): WbxmlElement | Promise<WbxmlElement>;

    /** Optional bulk form of `toApplicationData`, returning one element per item in the same order. Implemented
     * where rendering needs a lookup that is far cheaper done once for a whole page (`EmailSyncAdapter`'s
     * `Label`/`Attachment`/body-blob resolution); callers fall back to per-item `toApplicationData` when absent. */
    toApplicationDataBatch?(items: T[], bodyPreference?: SyncBodyPreference): Promise<WbxmlElement[]>;

    /**
     * Parses one client-originated `Add`/`Change` command's `<ApplicationData>` element (`el`) into a partial
     * entity update. Only fields actually present in `el` are included in the result - an omitted field means
     * "unchanged" (MS-ASCMD's own "ghosted property" rule - see `SyncCommand`'s doc comment), never "clear this
     * field" - which is what lets the same method serve both `Add` (the partial is merged onto a fresh
     * `{mailboxUid, folderUid}` baseline) and `Change` (the partial is merged onto `existing`).
     *
     * May return a `Promise` - `EmailSyncAdapter` needs this for a Draft `Add`/`Change`'s body, which must be
     * written to `BlobStore` before the resulting `bodyBlobKey` is known; every other adapter today returns a
     * plain object, which `await`s through unchanged.
     *
     * @param el The command's `<ApplicationData>` element.
     * @param existing The item being changed, for a `Change` command; `undefined` for `Add`. Adapters that
     * need to know the item's current field values to correctly interpret a partial update - `EmailSyncAdapter`
     * uses this to refuse a `Body` change on anything but a Draft, and to carry over unchanged MIME headers.
     * @param mailbox For an `Add`, the caller's own mailbox - `CalendarSyncAdapter` uses it so a device can never
     * make someone else the organizer of an event it creates. For a `Change`, the mailbox that owns the item (the
     * synced folder's mailbox) - `CalendarSyncAdapter` uses it to tell the organizer's copy of a meeting from an
     * attendee's copy.
     */
    fromApplicationData?(el: WbxmlElement, existing?: T, mailbox?: Mailbox): Partial<T> | Promise<Partial<T>>;

    /**
     * Fields to stamp on an item just before a client-originated `Delete` removes it, or `undefined` for none.
     * `CalendarSyncAdapter` marks an attendee's copy of a meeting as already cancelled, so deleting your own copy
     * never makes restapi's `MeetingSchedulingJob` mail a cancellation to everyone on the organizer's behalf.
     *
     * @param mailbox The mailbox that owns the item.
     */
    beforeDelete?(existing: T, mailbox: Mailbox): Partial<T> | undefined;

    /**
     * Supplies default field values for a brand-new entity created via a client-originated `Add`, applied
     * *before* `fromApplicationData`'s own partial is merged on top (so anything the client actually sent
     * always wins). For defaults a fresh entity needs regardless of what the client sent - `CalendarSyncAdapter`
     * uses this for `icalUid`/`sequence`, since EAS's own `Add` command has no wire representation for either
     * (a device doesn't know or send an iCalendar UID) but a stored default of `""` for every Sync-created
     * event (this model's own fallback, see `CalendarEventMongo`'s constructor) would violate RFC 5545's own
     * uniqueness expectation for `UID`. `EmailSyncAdapter` uses `mailbox` to populate a new Draft's `from`.
     * Optional; only implemented where a collection actually needs it - most adapters have no such gap (and
     * ignore the `mailbox` parameter entirely).
     */
    newEntityDefaults?(mailbox: Mailbox): Partial<T>;

    /**
     * Applies a client-originated `Change` targeting one *occurrence* of a recurring series (MS-ASAIRSYNCBASE
     * `InstanceId`, protocol 16.0+) rather than the whole series `master` resolved to. `instanceId` is that
     * occurrence's original start, as the device sent it (MS-ASDTYPE Compact DateTime). Implementations own
     * the entire write themselves (creating the occurrence's own override row via `repo` the first time it's
     * individually modified, or updating it on a later edit) - `SyncCommand` has no concept of what an
     * "occurrence" is beyond this hook. Optional: `SyncCommand` reports Status 6 for an `InstanceId` `Change`
     * when the collection's own adapter doesn't implement this (every adapter but `CalendarSyncAdapter` today -
     * `Email`/`Contacts`/`Tasks` have no recurring-series concept at all).
     *
     * @param master The recurring series' own item, as `SyncCommand` already resolved the device's `ServerId` to.
     * @param instanceId The targeted occurrence's original start.
     * @param appData The command's `<ApplicationData>` element - the occurrence's own new field values.
     * @param repo The collection's own repo, for the create-or-update this performs directly.
     * @param mailbox The mailbox that owns `master`.
     */
    changeInstance?(master: T, instanceId: string, appData: WbxmlElement, repo: RepoUtils<T>, mailbox: Mailbox): Promise<void>;

    /**
     * Applies a client-originated `Delete` targeting one *occurrence* of a recurring series (MS-ASAIRSYNCBASE
     * `InstanceId`, protocol 16.0+) - cancels that occurrence (removing its own override row if `changeInstance`
     * already created one, or else recording it in the series' own exception list) rather than `SyncCommand`'s
     * own generic whole-row delete, which would destroy the entire series. See `changeInstance`'s own doc
     * comment for `master`/`instanceId`; optional the same way, same fallback (Status 6) when absent.
     */
    deleteInstance?(master: T, instanceId: string, repo: RepoUtils<T>): Promise<void>;
}
