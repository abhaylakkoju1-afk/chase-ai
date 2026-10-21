import { test } from "node:test";
import assert from "node:assert/strict";
import {
    rowToLocalPb, rowsToLocalPbs, rowsToCloudPbs, entriesToRpc, bestTimeAfterMerge, planPbSync,
    createTestPbRepository, toMs, RPC_MAX_ENTRIES,
} from "../../src/app/data/supabase-test-pbs.js";
import { pbKey, deviceEntryId, mergeIntoCloudPb, planImport, timeToSeconds } from "../../src/app/data/user-data.js";

const row = (event, course, best, entries) => ({
    pb_key: pbKey(event, course), event, course, best_time: best,
    pb_entries: entries.map(([entry_id, seconds, ord]) => ({ entry_id, seconds, ord })),
});

test("a personal_bests row becomes the working-copy PB, history ordered, with ids", () => {
    const r = row("Freestyle 50m", "Short Course", "27.10", [["b", 28.5, 2], ["a", 29.0, 1], ["c", 27.1, 2]]);
    assert.deepEqual(rowToLocalPb(r), {
        event: "Freestyle 50m", course: "Short Course", time: "27.10",
        history: [29.0, 28.5, 27.1], historyIds: ["a", "b", "c"],
    });
    assert.deepEqual(rowsToLocalPbs([r, null, { event: "", course: "x" }]).length, 1);
    // numeric strings from PostgREST are accepted
    assert.deepEqual(rowToLocalPb(row("Back 50m", "Long Course", "31", [["x", "31.00", "5"]])).history, [31]);
});

test("rows convert to the cloud shape planImport() expects, so import is idempotent", () => {
    const local = { profile: { name: "Device Owner" }, pbs: [{ event: "Fly 50m", course: "Short Course", time: "30.10", history: [31.2, 30.1] }] };
    const first = planImport(local, { profile: {}, pbs: rowsToCloudPbs([]) });
    assert.equal(first.pbEntries, 2);
    assert.deepEqual(first.profileFill, { name: "Device Owner" });

    // the account now holds exactly what that import wrote
    const p = first.pbs[0];
    const imported = row(p.event, p.course, p.time, Object.entries(p.entries).map(([id, e]) => [id, e.s, e.n]));
    const again = planImport(local, { profile: { name: "Device Owner" }, pbs: rowsToCloudPbs([imported]) });
    assert.equal(again.pbEntries, 0, "re-importing the same device data adds nothing");
    assert.equal(again.isEmpty, true);
    assert.equal(again.fingerprint, first.fingerprint);
});

test("entries become the p_entries array add_pb_entries() takes, seconds at millisecond precision", () => {
    assert.deepEqual(entriesToRpc({ h_1: { s: 30.1, n: 3 }, h_2: { s: 29.9, n: 4 } }), [
        { entry_id: "h_1", seconds: 30.1, ord: 3 }, { entry_id: "h_2", seconds: 29.9, ord: 4 },
    ]);
    assert.deepEqual(entriesToRpc(undefined), []);
    // the app's own parsing leaves float noise; the database stores at most 3 decimals
    const noisy = timeToSeconds("1:08.04");
    assert.equal(noisy, 68.03999999999999);
    assert.deepEqual(entriesToRpc({ x: { s: noisy, n: 1 } }), [{ entry_id: "x", seconds: 68.04, ord: 1 }]);
    assert.equal(toMs(noisy), 68040);
});

test("float noise never replaces a correct m:ss best time, and fallbacks stay short (regression)", () => {
    // every m:ss.xx time from 1:00.00 to 9:59.99, stored as its own best with its own (noisy) swim
    let noisyCount = 0;
    for (let m = 1; m <= 9; m++) {
        for (let c = 0; c < 6000; c++) {
            const t = `${m}:${String(Math.floor(c / 100)).padStart(2, "0")}.${String(c % 100).padStart(2, "0")}`;
            const s = timeToSeconds(t);
            if (JSON.stringify(s).length > 9) noisyCount++;
            assert.equal(bestTimeAfterMerge(t, t, [s]), t, t);
        }
    }
    assert.ok(noisyCount > 2000, "the noise really occurs in the app's parsing");
    // when the fastest swim wins, its seconds are formatted cleanly (the column allows 16 characters)
    assert.equal(bestTimeAfterMerge("abc", "xyz", [125.47000000000001]), "125.47");
    assert.equal(bestTimeAfterMerge("2:10.00", "2:10.00", [timeToSeconds("2:05.47")]), "125.47");
    assert.ok(bestTimeAfterMerge("abc", "xyz", [99999.9994]).length <= 16);
});

test("the best-time rule (mirrored in SQL) matches mergeIntoCloudPb() for valid hundredths times", () => {
    const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}` : s.toFixed(2));
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 2000; i++) {
        const swims = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => Math.round((20 + rand() * 100) * 100) / 100);
        const stored = rand() < 0.15 ? null : fmt(Math.round((20 + rand() * 100) * 100) / 100);
        const incoming = fmt(Math.round((20 + rand() * 100) * 100) / 100);
        const existing = rand() < 0.5 ? swims.slice(0, 1) : [];
        const current = stored === null ? null : {
            event: "E", course: "C", time: stored,
            history: Object.fromEntries(existing.map((s, j) => [`old${j}`, { s, n: j }])),
        };
        const entries = Object.fromEntries(swims.map((s, j) => [`new${j}`, { s, n: 10 + j }]));
        const merged = mergeIntoCloudPb(current, { event: "E", course: "C", time: incoming, entries });
        const allSeconds = Object.values(merged.history).map((e) => e.s);
        const ours = bestTimeAfterMerge(current ? stored : incoming, incoming, allSeconds);
        assert.equal(ours, merged.time, `case ${i}: stored=${stored} incoming=${incoming} swims=${swims}`);
    }
});

test("the best-time rule treats malformed times as unknown and falls back to the fastest swim", () => {
    assert.equal(bestTimeAfterMerge("abc", "31.00", [32]), "31.00");
    assert.equal(bestTimeAfterMerge("abc", "xyz", [32.5]), "32.5");
    assert.equal(bestTimeAfterMerge("30.00", "29.50", [29.5, 31]), "29.50");
    assert.equal(bestTimeAfterMerge("30.00", "31.00", [28.4]), "28.4");
    assert.equal(bestTimeAfterMerge("1:02.30", "1:01.90", [61.9, 63]), "1:01.90");
});

test("sync plan: new PBs are sent whole, new swims get deterministic ids, removed PBs are deleted", () => {
    const keyFree = pbKey("Free 50m", "Short Course");
    const working = [
        { event: "Free 50m", course: "Short Course", time: "27.00", history: [28, 27], historyIds: ["h_known"] },  // one new swim
        { event: "Back 50m", course: "Short Course", time: "31.00", history: [31], historyIds: ["h_b"] },          // unchanged
        { event: "Fly 50m", course: "Long Course", time: "30.00", history: [30] },                                   // new PB
        { event: "", course: "x", history: [1] },                                                                    // invalid: ignored
    ];
    const plan = planPbSync(working, [keyFree, pbKey("Back 50m", "Short Course"), pbKey("Breast 50m", "Short Course")], "dev-1", 1000);
    assert.equal(plan.items.length, 3);
    const [free, back, fly] = plan.items;
    assert.equal(free.type, "add");
    assert.deepEqual(Object.keys(free.entries), [deviceEntryId("dev-1", keyFree, 1, 27)]);
    assert.deepEqual(Object.values(free.entries), [{ s: 27, n: 1000 }]);
    assert.equal(back.type, "keep");
    assert.deepEqual(back.pb.historyIds, ["h_b"]);
    assert.equal(fly.type, "add");
    assert.equal(Object.keys(fly.entries).length, 1);
    assert.deepEqual(plan.deletes, [pbKey("Breast 50m", "Short Course")]);

    // the same pending change planned again gets the same ids (a retry can't duplicate a swim)
    const retry = planPbSync(working, [], "dev-1", 9999);
    assert.deepEqual(Object.keys(retry.items[0].entries), Object.keys(free.entries));
    // a different device gets different ids for the same swim
    assert.notDeepEqual(Object.keys(planPbSync(working, [], "dev-2").items[0].entries), Object.keys(free.entries));
});

test("more than 500 swims for one PB are sent in calls of at most 500", async () => {
    assert.equal(RPC_MAX_ENTRIES, 500);
    const calls = [];
    const client = {
        rpc: (fn, args) => {
            calls.push(args.p_entries.length);
            return Promise.resolve({ data: { event: args.p_event, course: args.p_course, best_time: args.p_time, pb_entries: [] }, error: null });
        },
    };
    const repo = createTestPbRepository(client);
    const entries = Object.fromEntries(Array.from({ length: 1201 }, (_, i) => [`e${i}`, { s: 30 + i / 100, n: i }]));
    await repo.addPbEntries({ key: "k", event: "E", course: "C", time: "30.00", entries });
    assert.deepEqual(calls, [500, 500, 201]);
    calls.length = 0;
    await repo.addPbEntries({ key: "k", event: "E", course: "C", time: "30.00", entries: {} });
    assert.deepEqual(calls, [0], "a PB with no new swims is still sent once");
});

test("the repository sends the user's own id, the RPC payload and the import record", async () => {
    const calls = [];
    const chain = (table) => {
        const q = { table, filters: [] };
        const api = {
            select(cols) { q.op = "select"; q.cols = cols; return api; },
            delete() { q.op = "delete"; return api; },
            upsert(body, opts) { q.op = "upsert"; q.body = body; q.opts = opts; calls.push(q); return Promise.resolve({ error: null }); },
            eq(col, val) { q.filters.push([col, val]); return api; },
            then(resolve) { calls.push(q); return Promise.resolve({ data: table === "device_imports" ? [{ fingerprint: "f1" }] : [], error: null }).then(resolve); },
        };
        return api;
    };
    const client = {
        from: chain,
        rpc: (fn, args) => { calls.push({ rpc: fn, args }); return Promise.resolve({ data: { event: args.p_event, course: args.p_course, best_time: args.p_time, pb_entries: args.p_entries }, error: null }); },
    };
    const repo = createTestPbRepository(client);

    await repo.loadRows("u-1");
    assert.deepEqual(calls.at(-1).filters, [["user_id", "u-1"]]);

    const out = await repo.syncPbs("u-1", [{ event: "Free 50m", course: "Short Course", time: "27.00", history: [27] }], [pbKey("Old", "SC")], "dev");
    const rpc = calls.find((c) => c.rpc);
    assert.equal(rpc.rpc, "add_pb_entries");
    assert.equal(rpc.args.p_pb_key, pbKey("Free 50m", "Short Course"));
    assert.equal(rpc.args.p_entries.length, 1);
    assert.equal(out[0].historyIds.length, 1);
    const del = calls.find((c) => c.op === "delete");
    assert.deepEqual(del.filters, [["user_id", "u-1"], ["pb_key", pbKey("Old", "SC")]]);

    assert.deepEqual([...await repo.importedFingerprints("u-1")], ["f1"]);

    calls.length = 0;
    const plan = planImport({ profile: { club: "Home Club" }, pbs: [] }, { profile: {}, pbs: {} });
    await repo.importLocal("u-1", plan, { name: "Account Name" });
    const prof = calls.find((c) => c.table === "profiles");
    assert.equal(prof.body.user_id, "u-1");
    assert.equal(prof.body.name, "Account Name");          // kept
    assert.equal(prof.body.club, "Home Club");             // filled
    const rec = calls.find((c) => c.table === "device_imports");
    assert.deepEqual(rec.body, { user_id: "u-1", fingerprint: plan.fingerprint, pb_entries: 0, profile_fields: 1 });
    assert.deepEqual(rec.opts, { onConflict: "user_id,fingerprint", ignoreDuplicates: true });
});
