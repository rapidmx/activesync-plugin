///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EasLiveUpdates } from "../src/EasLiveUpdates.js";

describe("EasLiveUpdates", () => {
    it("Publishes a write on the folder's channel under the model name, a deletion naming only the item.", () => {
        const sendMessage = vi.fn();
        const live = new EasLiveUpdates({ sendMessage } as any);

        live.publish("folder-1", "CalendarEventMongo", "create", { uid: "e1", title: "Standup" });
        live.deleted("folder-1", "CalendarEventMongo", "e1");

        expect(sendMessage.mock.calls).toEqual([
            ["folder-1", "CalendarEventMongo", "create", { uid: "e1", title: "Standup" }],
            ["folder-1", "CalendarEventMongo", "delete", { uid: "e1" }],
        ]);
    });

    it("Publishes a move as an update on the folder the item is in now and a delete on the one it left, with an optional payload.", () => {
        const sendMessage = vi.fn();
        const live = new EasLiveUpdates({ sendMessage } as any);
        const moved = { uid: "m1", folderUid: "archive" };

        live.moved("inbox", "MessageMongo", moved);
        live.moved("inbox", "MessageMongo", moved, { uid: "m1", redacted: true });

        expect(sendMessage.mock.calls).toEqual([
            ["archive", "MessageMongo", "update", moved],
            ["inbox", "MessageMongo", "delete", { uid: "m1" }],
            ["archive", "MessageMongo", "update", { uid: "m1", redacted: true }],
            ["inbox", "MessageMongo", "delete", { uid: "m1" }],
        ]);
    });

    it("Does nothing without NotificationUtils.", () => {
        expect(() => new EasLiveUpdates(undefined).moved("inbox", "MessageMongo", { uid: "m1", folderUid: "archive" })).not.toThrow();
    });
});
