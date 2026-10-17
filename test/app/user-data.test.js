import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PROFILE_FIELDS, pbKey, sanitizeProfile, fingerprintLocal, planImport,
    mergeIntoCloudPb, cloudPbToLocal, cloudPbsToLocal, timeToSeconds,
} from "../../src/app/data/user-data.js";

test("pbKey encodes characters Realtime Database keys cannot contain", () => {
    const key = pbKey("Free.style $50#m [x]/y", "Short Course");
    assert.doesNotMatch(key, /[.$#[\]/]/);
    assert.equal(pbKey("Freestyle 50m", "Short Course"), pbKey("Freestyle 50m", "Short Course"));
    assert.notEqual(pbKey("Freestyle 50m", "Short Course"), pbKey("Freestyle 50m", "Long Course"));
});

test("sanitizeProfile keeps only known fields, trims, caps length and never includes the photo", () => {
    const out = sanitizeProfile({
        name: "  Alex  ", photo: "data:image/png;base64,AAAA", hacked: "x",
        club: "", height: 180, shortGoal: "g".repeat(500),
    });
    assert.deepEqual(Object.keys(out).sort(), ["height", "name", "shortGoal"]);
    assert.equal(out.name, "Alex");
    assert.equal(out.height, "180");
    assert.equal(out.shortGoal.length, 200);
    assert.ok(!("photo" in out));
    assert.ok(Object.keys(out).every((k) => PROFILE_FIELDS.includes(k)));
});

test("fingerprintLocal is stable for the same data and ignores the photo", () => {
    const a = { profile: { name: "A" }, pbs: [{ event: "Freestyle 50m", course: "Short Course", time: "28.50", history: [28.5] }] };
    const b = { profile: { name: "A", photo: "data:..." }, pbs: [...a.pbs] };
    assert.equal(fingerprintLocal(a), fingerprintLocal(b));
    assert.notEqual(fingerprintLocal(a), fingerprintLocal({ ...a, profile: { name: "B" } }));
});

test("planImport fills only empty account profile fields and reports kept conflicts", () => {
    const plan = planImport(
        { profile: { name: "Local", club: "Local Club", level: "Competitive" }, pbs: [] },
        { profile: { name: "Account", club: "" }, pbs: {} },
    );
    assert.deepEqual(plan.profileFill, { club: "Local Club", level: "Competitive" });
    assert.deepEqual(plan.profileKept, ["name"]);
});

test("planImport counts only history entries the account does not already have", () => {
    const local = { profile: {}, pbs: [{ event: "Freestyle 50m", course: "Short Course", time: "28.50", history: [29.1, 28.5] }] };
    const first = planImport(local, { profile: {}, pbs: {} });
    assert.equal(first.pbEntries, 2);
    // the same plan's entries already in the account -> nothing new to import
    const key = first.pbs[0].key;
    const cloud = { profile: {}, pbs: { [key]: { event: "Freestyle 50m", course: "Short Course", time: "28.50", history: first.pbs[0].entries } } };
    const again = planImport(local, cloud);
    assert.equal(again.pbEntries, 0);
    assert.equal(again.isEmpty, true);
});

test("planImport skips malformed local PBs and keeps a PB that only has a best time", () => {
    const plan = planImport({ pbs: [null, { event: "" }, { event: "Back 100m", course: "Long Course", time: "1:05.20" }] }, {});
    assert.equal(plan.pbs.length, 1);
    assert.equal(plan.pbs[0].newEntries, 1);
    assert.equal(Object.values(plan.pbs[0].entries)[0].s, timeToSeconds("1:05.20"));
});

test("mergeIntoCloudPb unions histories by id and never drops existing entries", () => {
    const current = { event: "Freestyle 50m", course: "Short Course", time: "28.50", history: { a: { s: 28.5, n: 1 }, b: { s: 30, n: 2 } } };
    const merged = mergeIntoCloudPb(current, { event: "Freestyle 50m", course: "Short Course", time: "29.00", entries: { b: { s: 99, n: 9 }, c: { s: 29, n: 3 } } });
    assert.deepEqual(Object.keys(merged.history).sort(), ["a", "b", "c"]);
    assert.equal(merged.history.b.s, 30, "an existing entry is never overwritten");
    assert.equal(merged.time, "28.50", "best time stays the fastest");
});

test("mergeIntoCloudPb takes a faster incoming best time and creates a new PB node", () => {
    const fresh = mergeIntoCloudPb(null, { event: "Fly 100m", course: "Long Course", time: "1:01.00", entries: { x: { s: 61, n: 0 } } });
    assert.equal(fresh.event, "Fly 100m");
    assert.equal(fresh.time, "1:01.00");
    const faster = mergeIntoCloudPb(fresh, { event: "Fly 100m", course: "Long Course", time: "59.80", entries: { y: { s: 59.8, n: 1 } } });
    assert.equal(faster.time, "59.80");
});

test("cloudPbToLocal orders history by n and returns matching historyIds", () => {
    const local = cloudPbToLocal({ event: "E", course: "C", time: "30", history: { z: { s: 31, n: 2 }, y: { s: 30, n: 1 } } });
    assert.deepEqual(local.history, [30, 31]);
    assert.deepEqual(local.historyIds, ["y", "z"]);
    assert.deepEqual(cloudPbsToLocal(null), []);
});

test("deviceEntryId is deterministic per device, position and time, and differs across devices", async () => {
    const { deviceEntryId } = await import("../../src/app/data/user-data.js");
    const k = pbKey("Freestyle 50m", "Short Course");
    assert.equal(deviceEntryId("dev1", k, 2, 28.5), deviceEntryId("dev1", k, 2, 28.5));
    assert.notEqual(deviceEntryId("dev1", k, 2, 28.5), deviceEntryId("dev2", k, 2, 28.5));
    assert.notEqual(deviceEntryId("dev1", k, 2, 28.5), deviceEntryId("dev1", k, 3, 28.5));
    assert.notEqual(deviceEntryId("dev1", k, 2, 28.5), deviceEntryId("dev1", k, 2, 28.6));
});
