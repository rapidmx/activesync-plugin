///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Direct unit tests for the Sync collection enumeration (EasCollectionSync.ts) against an in-memory fake repo that
// implements just the query shapes `scanAfter` issues - enough to pin down every branch deterministically (budget
// exhaustion mid-stream, echo suppression, filter windows, the out-of-folder stream), which a real HTTP round trip
// can't reach reliably. End-to-end Sync behavior over real Mongo/SQL lives in test/routes/{mongo,sql}/EasRoute.test.ts.
import { FolderType } from "@rapidmx/restapi";
import {
    classForFolderType,
    cloneWorkingState,
    type CollectionWorkingState,
    enumerateCollection,
    filterPredicate,
    roundRecord,
    workingStateFromRound,
    workingStateFromRow,
} from "../src/EasCollectionSync.js";
import { formatSyncKey } from "../src/EasSyncKeyUtils.js";

interface Row {
    uid: string;
    folderUid: string;
    mailboxUid: string;
    dateModified: Date;
    deleted?: boolean;
    [key: string]: any;
}

/** Evaluates the `scanAfter`/`scanOverlap`/reconcile query shapes (`gt`/`range`/`ne`/`in` operands, `$or`, `deleted`,
 * an ascending or descending `sort`, `limit`) over `rows`. */
function fakeRepo(rows: Row[]): any {
    const matches = (row: Row, query: Record<string, any>): boolean =>
        Object.entries(query).every(([key, value]) => {
            if (key === "sort" || key === "limit") return true;
            if (key === "$or") return (value as any[]).some((sub) => matches(row, sub));
            if (key === "deleted") return (row.deleted === true) === value;
            const op = /^(gt|range|ne|in)\((.*)\)$/.exec(String(value));
            const field = row[key] instanceof Date ? row[key].toISOString() : row[key];
            if (!op) return field === value;
            if (op[1] === "gt") return field > op[2];
            if (op[1] === "ne") return field !== op[2];
            if (op[1] === "in") return op[2].split(",").includes(field);
            const [lo, hi] = op[2].split(",");
            return field >= lo && field <= hi;
        });
    return {
        findOne: vi.fn().mockImplementation(async (uid: string) => rows.find((row) => row.uid === uid && row.deleted !== true)),
        find: vi.fn().mockImplementation(async (query: any) => {
            const effective = "deleted" in query ? query : { ...query, deleted: false };
            const descending = String(query.sort ?? "").includes("DESC");
            return rows
                .filter((row) => matches(row, effective))
                .sort((a, b) => (a.dateModified.getTime() - b.dateModified.getTime() || (a.uid < b.uid ? -1 : 1)) * (descending ? -1 : 1))
                .slice(0, query.limit);
        }),
    };
}

const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

function state(overrides: Partial<CollectionWorkingState> = {}): CollectionWorkingState {
    return {
        generation: 1,
        cursor: { date: new Date(0), uid: "" },
        moveCursor: { date: new Date(0), uid: "" },
        serverIds: new Set(),
        echoes: new Map(),
        reconcileCursor: "",
        filterType: "0",
        ...overrides,
    };
}

const base = { folderUid: "inbox", folderMailboxUid: "mbx", moveScanLimit: 100, now: t(1000) };

describe("EasCollectionSync Tests", () => {
    describe("enumerateCollection", () => {
        it("Reports items the device lacks as Adds and items it holds as Changes, advancing the cursor to the last row.", async () => {
            const repo = fakeRepo([
                { uid: "a", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "b", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(2) },
            ]);
            const s = state({ serverIds: new Set(["b"]) });

            const { commands, moreAvailable } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands.map((c: any) => `${c.kind}:${c.item?.uid ?? c.uid}`)).toEqual(["Add:a", "Change:b"]);
            expect(moreAvailable).toBe(false);
            expect(s.cursor).toEqual({ date: t(2), uid: "b" });
            expect([...s.serverIds].sort()).toEqual(["a", "b"]);
        });

        it("Reports a deleted item only when the device holds it.", async () => {
            const repo = fakeRepo([
                { uid: "held", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1), deleted: true },
                { uid: "never-sent", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(2), deleted: true },
            ]);
            const s = state({ serverIds: new Set(["held"]), moveCursor: { date: t(500), uid: "" } });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands).toEqual([{ kind: "Delete", uid: "held" }]);
            expect(s.serverIds.size).toBe(0);
            expect(s.cursor.uid).toBe("never-sent");
        });

        it("Reports an item moved to another folder of the mailbox as a Delete, and doesn't also Add/Change a stale folder-stream copy of it.", async () => {
            const rows: Row[] = [{ uid: "moved", folderUid: "archive", mailboxUid: "mbx", dateModified: t(5) }];
            const repo = fakeRepo(rows);
            // The folder stream is read first, so an item that moves between the two reads is seen in both.
            repo.find.mockImplementationOnce(async () => [{ uid: "moved", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(4) }]);
            const s = state({ serverIds: new Set(["moved", "other"]) });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands).toEqual([{ kind: "Delete", uid: "moved" }]);
            expect([...s.serverIds]).toEqual(["other"]);
            expect(s.moveCursor).toEqual({ date: t(5), uid: "moved" });
        });

        it("Skips the device's own write (dateModified still equal to the recorded echo) and prunes echoes the cursor has passed.", async () => {
            const repo = fakeRepo([
                { uid: "mine", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(3) },
                { uid: "edited-again", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(4) },
            ]);
            const s = state({
                serverIds: new Set(["mine", "edited-again"]),
                moveCursor: { date: t(900), uid: "" },
                echoes: new Map([
                    ["mine", t(3).toISOString()],
                    ["edited-again", t(2).toISOString()],
                    ["future", t(50).toISOString()],
                ]),
            });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands.map((c: any) => c.item.uid)).toEqual(["edited-again"]);
            expect([...s.echoes.keys()]).toEqual(["future"]);
        });

        it("Stops at the window size, reporting moreAvailable and leaving the cursor before the first unreported row.", async () => {
            const repo = fakeRepo([
                { uid: "a", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "b", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "c", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
            ]);
            const s = state();

            const first = await enumerateCollection(s, { ...base, repo, windowSize: 2 });
            expect(first.commands.map((c: any) => c.item.uid)).toEqual(["a", "b"]);
            expect(first.moreAvailable).toBe(true);
            expect(s.cursor).toEqual({ date: t(1), uid: "b" });

            // Rows sharing one timestamp across the page boundary are neither skipped nor repeated.
            const second = await enumerateCollection(s, { ...base, repo, windowSize: 2 });
            expect(second.commands.map((c: any) => c.item.uid)).toEqual(["c"]);
            expect(second.moreAvailable).toBe(false);
        });

        it("Stops the out-of-folder stream when the window fills, then reports nothing more from the folder stream.", async () => {
            const repo = fakeRepo([
                { uid: "x", folderUid: "archive", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "y", folderUid: "archive", mailboxUid: "mbx", dateModified: t(2) },
                { uid: "z", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(3) },
            ]);
            const s = state({ serverIds: new Set(["x", "y"]) });

            const { commands, moreAvailable } = await enumerateCollection(s, { ...base, repo, windowSize: 1 });

            expect(commands).toEqual([{ kind: "Delete", uid: "x" }]);
            expect(moreAvailable).toBe(true);
            expect(s.moveCursor).toEqual({ date: t(1), uid: "x" });
            expect(s.cursor).toEqual({ date: new Date(0), uid: "" });
        });

        it("Reports moreAvailable when the out-of-folder page itself overflows, even with nothing to report from it.", async () => {
            const repo = fakeRepo([
                { uid: "p", folderUid: "archive", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "q", folderUid: "archive", mailboxUid: "mbx", dateModified: t(2) },
            ]);
            const s = state({ serverIds: new Set(["held"]) });

            const { commands, moreAvailable } = await enumerateCollection(s, { ...base, repo, windowSize: 10, moveScanLimit: 1 });

            expect(commands).toEqual([]);
            expect(moreAvailable).toBe(true);
            expect(s.moveCursor.uid).toBe("p");
        });

        it("Doesn't add an item outside the filter window, but still changes one the device already holds.", async () => {
            const repo = fakeRepo([
                { uid: "old", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1), keep: false },
                { uid: "held-old", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(2), keep: false },
            ]);
            const s = state({ serverIds: new Set(["held-old"]), moveCursor: { date: t(900), uid: "" } });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10, include: (item: any) => item.keep });

            expect(commands.map((c: any) => `${c.kind}:${c.item.uid}`)).toEqual(["Change:held-old"]);
            expect(s.cursor.uid).toBe("held-old");
        });

        it("Fast-forwards the out-of-folder cursor while the device holds nothing, but never moves it backwards.", async () => {
            const repo = fakeRepo([]);
            const behind = state();
            await enumerateCollection(behind, { ...base, repo, windowSize: 10 });
            expect(behind.moveCursor).toEqual({ date: new Date(t(1000).getTime() - 60_000), uid: "" });

            const ahead = state({ moveCursor: { date: t(2000), uid: "k" } });
            await enumerateCollection(ahead, { ...base, repo, windowSize: 10 });
            expect(ahead.moveCursor).toEqual({ date: t(2000), uid: "k" });

            // Defaults `now` to the current time when not given.
            const live = state();
            await enumerateCollection(live, { ...base, now: undefined, repo, windowSize: 10 });
            expect(live.moveCursor.date.getTime()).toBeGreaterThan(t(0).getTime());
        });
    });

    describe("overlap re-read", () => {
        it("Processes a folder row that became visible behind the cursor once, and skips rows already reported there.", async () => {
            const rows: Row[] = [
                { uid: "already", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(10) },
                { uid: "cursor-row", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(10) },
            ];
            const repo = fakeRepo(rows);
            const overlapMs = 5 * 60_000;
            const s = state({
                cursor: { date: t(10), uid: "cursor-row" },
                moveCursor: { date: t(900), uid: "" },
                recent: new Map([
                    ["already", t(10).toISOString()],
                    ["cursor-row", t(10).toISOString()],
                ]),
            });

            // Nothing new: the window only holds rows already reported.
            expect((await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs })).commands).toEqual([]);

            // Another replica commits a row stamped before the cursor.
            rows.push({ uid: "late", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(9) });
            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs });
            expect(commands.map((c: any) => `${c.kind}:${c.item.uid}`)).toEqual(["Add:late"]);
            expect(s.cursor).toEqual({ date: t(10), uid: "cursor-row" });
            expect(s.recent!.get("late")).toBe(t(9).toISOString());

            // Reported once only.
            expect((await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs })).commands).toEqual([]);
        });

        it("Leaves a late row for a later round when the window is already full.", async () => {
            const repo = fakeRepo([
                { uid: "late", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(9) },
                { uid: "next", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(11) },
            ]);
            const s = state({ cursor: { date: t(10), uid: "" }, moveCursor: { date: t(900), uid: "" }, recent: new Map() });

            const { commands, moreAvailable } = await enumerateCollection(s, { ...base, repo, windowSize: 0, overlapMs: 5 * 60_000 });

            expect(commands).toEqual([]);
            expect(moreAvailable).toBe(true);
            expect(s.recent!.has("late")).toBe(false);
            expect(s.cursor).toEqual({ date: t(10), uid: "" });
        });

        it("Takes everything already in the window as reported for a row saved before overlap tracking existed.", async () => {
            const repo = fakeRepo([{ uid: "old", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(9) }]);
            const s = state({ cursor: { date: t(10), uid: "" }, moveCursor: { date: t(900), uid: "" } });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs: 5 * 60_000 });

            expect(commands).toEqual([]);
            expect(s.recent).toEqual(new Map([["old", t(9).toISOString()]]));
        });

        it("Re-applies a move committed behind the out-of-folder cursor, and stops it when the window is full.", async () => {
            const repo = fakeRepo([
                { uid: "moved-late", folderUid: "archive", mailboxUid: "mbx", dateModified: t(19) },
                { uid: "moved-too", folderUid: "archive", mailboxUid: "mbx", dateModified: t(19) },
            ]);
            const s = state({ serverIds: new Set(["moved-late", "moved-too"]), moveCursor: { date: t(20), uid: "" }, recent: new Map() });

            const full = await enumerateCollection(s, { ...base, repo, windowSize: 1, overlapMs: 5 * 60_000 });
            expect(full.commands).toEqual([{ kind: "Delete", uid: "moved-late" }]);
            expect(full.moreAvailable).toBe(true);
            expect(s.moveCursor).toEqual({ date: t(20), uid: "" });

            const rest = await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs: 5 * 60_000 });
            expect(rest.commands).toEqual([{ kind: "Delete", uid: "moved-too" }]);
        });

        it("Prunes recent to the overlap window and the entry limit, keeping the newest.", async () => {
            const repo = fakeRepo([
                { uid: "a", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "b", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(30) },
                { uid: "c", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(31) },
                { uid: "d", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(31) },
            ]);
            const s = state({ moveCursor: { date: t(900), uid: "" }, recent: new Map([["stale", t(0).toISOString()]]) });

            await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs: 5 * 60_000, overlapLimit: 2 });

            expect([...s.recent!.keys()].sort()).toEqual(["c", "d"]);
        });

        it("Does no overlap re-read with a zero window or limit.", async () => {
            const repo = fakeRepo([{ uid: "late", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(9) }]);
            const s = state({ cursor: { date: t(10), uid: "" }, moveCursor: { date: t(900), uid: "" }, recent: new Map() });
            expect((await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs: 0 })).commands).toEqual([]);
            expect((await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapLimit: 0, overlapMs: 5 * 60_000 })).commands).toEqual([]);
        });
    });

    describe("reconcile", () => {
        it("Reports held items that no longer exist in the folder as Deletes, a slice per caught-up round, wrapping around.", async () => {
            const repo = fakeRepo([
                { uid: "a", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "c", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "moved", folderUid: "archive", mailboxUid: "mbx", dateModified: t(1) },
            ]);
            const s = state({
                serverIds: new Set(["a", "b-purged", "c", "d-purged", "moved"]),
                cursor: { date: t(5), uid: "" },
                moveCursor: { date: t(5), uid: "" },
                recent: new Map(),
            });
            const options = { ...base, repo, windowSize: 10, overlapMs: 0, reconcileLimit: 2 };

            const first = await enumerateCollection(s, options);
            expect(first.commands).toEqual([{ kind: "Delete", uid: "b-purged" }]);
            expect(s.reconcileCursor).toBe("b-purged");

            const second = await enumerateCollection(s, options);
            expect(second.commands).toEqual([{ kind: "Delete", uid: "d-purged" }]);

            const third = await enumerateCollection(s, options);
            expect(third.commands).toEqual([{ kind: "Delete", uid: "moved" }]);
            expect(s.reconcileCursor).toBe("");
            expect([...s.serverIds].sort()).toEqual(["a", "c"]);

            // An empty slice (the cursor is past every held id) just starts over.
            s.reconcileCursor = "zzz";
            expect((await enumerateCollection(s, options)).commands).toEqual([]);
            expect(s.reconcileCursor).toBe("");
        });

        it("Stops at the window, leaving the rest for a later round, and doesn't run while more changes are pending.", async () => {
            const repo = fakeRepo([{ uid: "new", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(9) }]);
            const s = state({ serverIds: new Set(["x-purged", "y-purged"]), cursor: { date: t(5), uid: "" }, moveCursor: { date: t(5), uid: "" }, recent: new Map() });

            const busy = await enumerateCollection(s, { ...base, repo, windowSize: 1, overlapMs: 0, reconcileLimit: 10 });
            expect(busy.commands.map((c: any) => c.kind)).toEqual(["Add"]);

            const partial = await enumerateCollection(s, { ...base, repo, windowSize: 1, overlapMs: 0, reconcileLimit: 10 });
            expect(partial.commands).toEqual([{ kind: "Delete", uid: "x-purged" }]);
            expect(partial.moreAvailable).toBe(true);
            expect(s.reconcileCursor).toBe("x-purged");
        });

        it("Checks held ids that can't be listed in an in(...) operand (commas, me, null) one by one by exact uid.", async () => {
            const repo = fakeRepo([
                { uid: "a,b", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "a", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "me", folderUid: "archive", mailboxUid: "mbx", dateModified: t(1) },
            ]);
            const s = state({
                serverIds: new Set(["a,b", "gone,too", "me", "null"]),
                cursor: { date: t(5), uid: "" },
                moveCursor: { date: t(5), uid: "" },
                recent: new Map(),
            });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10, overlapMs: 0, reconcileLimit: 10 });

            expect(commands).toEqual([
                { kind: "Delete", uid: "gone,too" },
                { kind: "Delete", uid: "me" },
                { kind: "Delete", uid: "null" },
            ]);
            expect([...s.serverIds]).toEqual(["a,b"]);
            // Nothing unlistable ever reached an in(...) query.
            for (const [query] of repo.find.mock.calls) {
                expect(String(query.uid ?? "")).not.toMatch(/in\(.*(,b|me|null)/);
            }
        });
    });

    describe("working state", () => {
        const row: any = {
            syncKey: formatSyncKey({ generation: 3, watermark: t(9) }),
            cursorDate: t(9),
            cursorUid: "c9",
            moveCursorDate: t(8),
            moveCursorUid: "m8",
            serverIds: ["a", "new"],
            echoes: { a: t(9).toISOString() },
            filterType: "3",
            previous: {
                syncKey: formatSyncKey({ generation: 2, watermark: t(5) }),
                cursorDate: t(5).toISOString(),
                cursorUid: "c5",
                moveCursorDate: t(4).toISOString(),
                moveCursorUid: "m4",
                addedIds: ["new"],
                removedIds: ["gone"],
                echoes: {},
                clientIds: [{ clientId: "client-1", serverId: "new" }],
            },
        };

        it("Loads the current round from the row.", () => {
            const s = workingStateFromRow(row);
            expect(s.generation).toBe(3);
            expect(s.cursor).toEqual({ date: t(9), uid: "c9" });
            expect(s.moveCursor).toEqual({ date: t(8), uid: "m8" });
            expect([...s.serverIds]).toEqual(["a", "new"]);
            expect(s.echoes.get("a")).toBe(t(9).toISOString());
            expect(s.filterType).toBe("3");
        });

        it("Rebuilds the state before the previous round, undoing its delta.", () => {
            const s = workingStateFromRound(row, row.previous);
            expect(s.generation).toBe(2);
            expect(s.cursor).toEqual({ date: t(5), uid: "c5" });
            expect(s.moveCursor).toEqual({ date: t(4), uid: "m4" });
            expect([...s.serverIds].sort()).toEqual(["a", "gone"]);
            expect(s.echoes.size).toBe(0);
        });

        it("Tolerates a corrupt key, missing echoes and an unset filter.", () => {
            const s = workingStateFromRow({ ...row, syncKey: "garbage", echoes: undefined, filterType: undefined });
            expect(s.generation).toBe(0);
            expect(s.echoes.size).toBe(0);
            expect(s.filterType).toBeUndefined();
            expect(s.recent).toBeUndefined();
            expect(s.reconcileCursor).toBe("");
            const r = workingStateFromRound({ ...row, filterType: null }, { ...row.previous, syncKey: "garbage" });
            expect(r.generation).toBe(0);
            expect(r.filterType).toBeUndefined();
            expect(r.reconcileCursor).toBe("");
        });

        it("Takes the held set from the caller when given, and restores recent/reconcileCursor for a retried round.", () => {
            const withRecent = { ...row, recent: { a: t(9).toISOString() }, reconcileCursor: "m", previous: { ...row.previous, recent: { b: "x" }, reconcileCursor: "c" } };
            const s = workingStateFromRow(withRecent, new Set(["chunked-1", "new"]));
            expect([...s.serverIds]).toEqual(["chunked-1", "new"]);
            expect(s.recent).toEqual(new Map([["a", t(9).toISOString()]]));
            expect(s.reconcileCursor).toBe("m");
            const r = workingStateFromRound(withRecent, withRecent.previous, new Set(["chunked-1", "new"]));
            expect([...r.serverIds].sort()).toEqual(["chunked-1", "gone"]);
            expect(r.recent).toEqual(new Map([["b", "x"]]));
            expect(r.reconcileCursor).toBe("c");
            expect(cloneWorkingState(r).recent).not.toBe(r.recent);
            expect(roundRecord("k", r, r, new Map()).recent).toEqual({ b: "x" });
        });

        it("Clones deeply and records a round's delta.", () => {
            const before = workingStateFromRow(row);
            const after = cloneWorkingState(before);
            after.serverIds.delete("a");
            after.serverIds.add("z");
            after.cursor.uid = "moved";
            expect(before.serverIds.has("a")).toBe(true);
            expect(before.cursor.uid).toBe("c9");

            const record = roundRecord("key-1", before, after, new Map([["c", "z"]]));
            expect(record).toEqual({
                syncKey: "key-1",
                cursorDate: t(9).toISOString(),
                cursorUid: "c9",
                moveCursorDate: t(8).toISOString(),
                moveCursorUid: "m8",
                addedIds: ["z"],
                removedIds: ["a"],
                echoes: { a: t(9).toISOString() },
                reconcileCursor: "",
                clientIds: [{ clientId: "c", serverId: "z" }],
            });
        });
    });

    describe("filterPredicate", () => {
        const now = new Date("2026-06-15T00:00:00.000Z");
        const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

        it("Windows Email by receivedDate for FilterType 1-5.", () => {
            const include = filterPredicate("Email", "3", now)!;
            expect(include({ receivedDate: daysAgo(6) })).toBe(true);
            expect(include({ receivedDate: daysAgo(8) })).toBe(false);
            expect(filterPredicate("Email", "6", now)).toBeUndefined();
        });

        it("Windows Calendar by endDate for FilterType 4-7, always keeping recurring events.", () => {
            const include = filterPredicate("Calendar", "4", now)!;
            expect(include({ endDate: daysAgo(10) })).toBe(true);
            expect(include({ endDate: daysAgo(20) })).toBe(false);
            expect(include({ endDate: daysAgo(400), recurrenceRule: { freq: "weekly" } })).toBe(true);
            expect(filterPredicate("Calendar", "2", now)).toBeUndefined();
        });

        it("Keeps only incomplete Tasks for FilterType 8, and applies no filter otherwise.", () => {
            const include = filterPredicate("Tasks", "8", now)!;
            expect(include({ completed: false })).toBe(true);
            expect(include({ completed: true })).toBe(false);
            expect(filterPredicate("Tasks", "0", now)).toBeUndefined();
            expect(filterPredicate("Contacts", "3", now)).toBeUndefined();
            expect(filterPredicate("Email", "0")).toBeUndefined();
        });
    });

    it("classForFolderType maps a folder's type to the Class it holds.", () => {
        expect(classForFolderType(FolderType.CALENDAR)).toBe("Calendar");
        expect(classForFolderType(FolderType.CONTACTS)).toBe("Contacts");
        expect(classForFolderType(FolderType.SUGGESTED_CONTACTS)).toBe("Contacts");
        expect(classForFolderType(FolderType.TASKS)).toBe("Tasks");
        expect(classForFolderType(FolderType.INBOX)).toBe("Email");
        expect(classForFolderType(FolderType.USER)).toBe("Email");
    });
});
