///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { NotificationUtils } from "@rapidrest/service-core";

/** The action of a write's live-update notification, as restapi's routes publish it. */
export type LiveUpdateAction = "create" | "update" | "delete";

/**
 * Live-update notifications for the writes EAS commands make directly through `RepoUtils`, published exactly as
 * restapi's own REST routes publish theirs (`BaseScopedChildRoute.notify()`): on the channel of the folder holding the
 * item - the channel a web client viewing that folder subscribes to - with the concrete model class's name as the
 * event type. `RepoUtils` itself only publishes on the item's own uid, which nothing subscribes to, so without these a
 * change made on a device never reached an open web client until it reloaded.
 *
 * Every subscriber of a folder's channel receives the same payload, so the caller passes what every one of them may see
 * (a private calendar event's busy block - restapi's `redactEventForReader()`). A deleted item's payload only names it.
 * Fire-and-forget, like restapi's: `NotificationUtils.sendMessage()` never blocks or fails the write.
 */
export class EasLiveUpdates {
    constructor(private readonly notificationUtils: NotificationUtils | undefined) {}

    /** Publishes `action` on `item` in `folderUid`. */
    public publish(folderUid: string, modelName: string, action: LiveUpdateAction, payload: unknown): void {
        this.notificationUtils?.sendMessage(folderUid, modelName, action, payload);
    }

    /** Publishes a deletion of `uid` from `folderUid`. */
    public deleted(folderUid: string, modelName: string, uid: string): void {
        this.publish(folderUid, modelName, "delete", { uid });
    }

    /** Publishes an item's move out of `fromFolderUid` as restapi's update of a record's folder does: an update on the
     * folder it is in now, a delete on the one it left. */
    public moved(fromFolderUid: string, modelName: string, moved: { uid: string; folderUid: string }, payload: unknown = moved): void {
        this.publish(moved.folderUid, modelName, "update", payload);
        this.deleted(fromFolderUid, modelName, moved.uid);
    }
}
