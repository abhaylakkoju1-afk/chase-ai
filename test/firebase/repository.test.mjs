// User-data repository against the Auth + Database emulators, with the real
// security rules and real (emulated) email/password accounts.
//   npm run test:emulator
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase/app";
import {
    getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signOut,
} from "firebase/auth";
import {
    getDatabase, connectDatabaseEmulator, goOffline, ref, get, set, update, remove, runTransaction,
} from "firebase/database";
import { createUserDataRepository, planImport, pbKey } from "../../src/app/data/user-data.js";

const PROJECT = "demo-swimtics";
const apps = [];
const clients = [];

/* each user gets its own app instance so their auth sessions are independent */
function makeClient(name) {
    const app = initializeApp({
        apiKey: "demo-api-key", projectId: PROJECT,
        databaseURL: `http://127.0.0.1:9000/?ns=${PROJECT}-default-rtdb`,
    }, name);
    apps.push(app);
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    const db = getDatabase(app);
    connectDatabaseEmulator(db, "127.0.0.1", 9000);
    const repo = createUserDataRepository({ db, ref, get, set, update, remove, runTransaction });
    const client = { auth, db, repo };
    clients.push(client);
    return client;
}

let alice, bob, aliceUid, bobUid;

before(async () => {
    // clear emulator auth users from earlier runs
    await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
    alice = makeClient("alice");
    bob = makeClient("bob");
    aliceUid = (await createUserWithEmailAndPassword(alice.auth, "alice@example.com", "correct-horse-1")).user.uid;
    bobUid = (await createUserWithEmailAndPassword(bob.auth, "bob@example.com", "battery-staple-2")).user.uid;
});

after(async () => {
    for (const c of clients) {
        await signOut(c.auth).catch(() => {});
        goOffline(c.db);
    }
    for (const a of apps) await deleteApp(a);
});

test("profile save/load round trip, photo never sent to the database", async () => {
    await alice.repo.saveProfile(aliceUid, { name: "Alice", club: "Sharks", photo: "data:image/png;base64,AAA" });
    const data = await alice.repo.load(aliceUid);
    assert.equal(data.profile.name, "Alice");
    assert.equal(data.profile.club, "Sharks");
    assert.ok(!("photo" in data.profile));
    assert.equal(typeof data.profile.updatedAt, "number");
});

test("PB sync adds new history entries, keeps old ones, and handles deletes", async () => {
    let working = [{ event: "Freestyle 50m", course: "Short Course", time: "29.00", history: [29] }];
    working = await alice.repo.syncPbs(aliceUid, working, []);
    assert.equal(working[0].historyIds.length, 1);

    // a new swim recorded in the working copy (as pb.js does: push + maybe new best)
    working[0].history.push(28.4);
    working[0].time = "28.40";
    working.push({ event: "Backstroke 100m", course: "Long Course", time: "1:05.00", history: [65] });
    const synced = await alice.repo.syncPbs(aliceUid, working, [pbKey("Freestyle 50m", "Short Course")]);
    const free = synced.find((p) => p.event === "Freestyle 50m");
    assert.deepEqual(free.history, [29, 28.4]);
    assert.equal(free.time, "28.40");

    // delete the backstroke PB in the working copy -> removed from the account
    const keys = synced.map((p) => pbKey(p.event, p.course));
    await alice.repo.syncPbs(aliceUid, synced.filter((p) => p.event !== "Backstroke 100m"), keys);
    const data = await alice.repo.load(aliceUid);
    assert.deepEqual(Object.keys(data.pbs), [pbKey("Freestyle 50m", "Short Course")]);
});

test("two devices adding swims to the same PB both keep their entries", async () => {
    const deviceA = (await alice.repo.load(aliceUid)).pbs;
    const key = pbKey("Freestyle 50m", "Short Course");
    await alice.repo.addPbEntries(aliceUid, { event: "Freestyle 50m", course: "Short Course", time: "28.90", entries: { devA: { s: 28.9, n: 100 } } });
    await alice.repo.addPbEntries(aliceUid, { event: "Freestyle 50m", course: "Short Course", time: "29.30", entries: { devB: { s: 29.3, n: 101 } } });
    const after = (await alice.repo.load(aliceUid)).pbs[key];
    assert.ok(after.history.devA && after.history.devB);
    assert.equal(Object.keys(after.history).length, Object.keys(deviceA[key].history).length + 2);
    assert.equal(after.time, "28.40", "best time unchanged by slower swims");
});

test("importing local data merges PB histories, fills empty profile fields, and is idempotent", async () => {
    const local = {
        profile: { name: "Local Name", level: "Competitive", photo: "data:..." },
        pbs: [
            { event: "Freestyle 50m", course: "Short Course", time: "28.10", history: [30, 28.1] },
            { event: "Butterfly 100m", course: "Short Course", time: "1:02.00", history: [62] },
        ],
    };
    const before = await alice.repo.load(aliceUid);
    const plan = planImport(local, before);
    assert.deepEqual(plan.profileFill, { level: "Competitive" }, "name already set in the account is kept");
    assert.deepEqual(plan.profileKept, ["name"]);
    assert.equal(plan.pbEntries, 3);

    const afterImport = await alice.repo.importLocal(aliceUid, plan);
    assert.equal(afterImport.profile.name, "Alice");
    assert.equal(afterImport.profile.level, "Competitive");
    const free = afterImport.pbs[pbKey("Freestyle 50m", "Short Course")];
    const freeBefore = before.pbs[pbKey("Freestyle 50m", "Short Course")];
    assert.equal(Object.keys(free.history).length, Object.keys(freeBefore.history).length + 2, "no existing entries lost");
    assert.equal(free.time, "28.10", "faster imported time becomes the best");
    assert.ok(afterImport.imports[plan.fingerprint], "import recorded on the account");

    // a second import of the same local data adds nothing
    const again = planImport(local, afterImport);
    assert.equal(again.pbEntries, 0);
    assert.equal(again.isEmpty, true);
    const afterSecond = await alice.repo.importLocal(aliceUid, again);
    assert.deepEqual(afterSecond.pbs, afterImport.pbs);
});

test("a signed-in user cannot read or overwrite another user's data", async () => {
    await assert.rejects(() => bob.repo.load(aliceUid), /permission/i);
    await assert.rejects(() => bob.repo.saveProfile(aliceUid, { name: "Bob" }), /permission/i);
    await assert.rejects(() => bob.repo.addPbEntries(aliceUid, { event: "X", course: "Y", time: "1", entries: { b: { s: 1, n: 1 } } }), /permission/i);
    // and bob's own space is separate and empty
    const own = await bob.repo.load(bobUid);
    assert.deepEqual(own, { profile: {}, pbs: {}, imports: {} });
});

test("after signing out, the same client can no longer read the account", async () => {
    await signOut(alice.auth);
    await assert.rejects(() => alice.repo.load(aliceUid), /permission/i);
});

test("retrying the same PB sync (e.g. a replayed pending backup) never duplicates times", async () => {
    const carol = makeClient("carol");
    const uid = (await createUserWithEmailAndPassword(carol.auth, "carol@example.com", "pass-word-3")).user.uid;
    const working = [{ event: "Freestyle 100m", course: "Long Course", time: "58.00", history: [59, 58] }];
    await carol.repo.syncPbs(uid, working, [], "device-A");
    await carol.repo.syncPbs(uid, working, [], "device-A");          // same stale snapshot again
    const node = (await carol.repo.load(uid)).pbs[pbKey("Freestyle 100m", "Long Course")];
    assert.equal(Object.keys(node.history).length, 2);
    // the same times recorded independently on another device are kept as separate swims
    await carol.repo.syncPbs(uid, working, [], "device-B");
    const after = (await carol.repo.load(uid)).pbs[pbKey("Freestyle 100m", "Long Course")];
    assert.equal(Object.keys(after.history).length, 4);
});
