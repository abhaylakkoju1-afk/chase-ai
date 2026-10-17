// Realtime Database security rules — runs only inside the Firebase Emulator Suite:
//   npm run test:emulator
// Uses the demo-swimtics project ID, so it can never reach a real Firebase project.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import {
    initializeTestEnvironment, assertFails, assertSucceeds,
} from "@firebase/rules-unit-testing";

let env;

before(async () => {
    env = await initializeTestEnvironment({
        projectId: "demo-swimtics",
        database: { host: "127.0.0.1", port: 9000, rules: readFileSync("database.rules.json", "utf8") },
    });
});

after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearDatabase(); });

const as = (uid) => env.authenticatedContext(uid).database();
const anon = () => env.unauthenticatedContext().database();

const pb = {
    event: "Freestyle 50m", course: "Short Course", time: "28.50",
    history: { e1: { s: 28.5, n: 1 } },
};

async function seedAlice() {
    await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.database().ref("users/alice").set({
            profile: { name: "Alice", club: "Sharks", updatedAt: 1 },
            pbs: { k1: pb },
        });
    });
}

test("signed-out visitors can read or write nothing", async () => {
    await seedAlice();
    await assertFails(anon().ref("users/alice").get());
    await assertFails(anon().ref("users/alice/profile").set({ name: "x" }));
    await assertFails(anon().ref("/").get());
});

test("a user can read and write their own profile and PBs", async () => {
    const db = as("alice");
    await assertSucceeds(db.ref("users/alice/profile").set({ name: "Alice", dob: "2008-01-01", updatedAt: 5 }));
    await assertSucceeds(db.ref("users/alice/pbs/k1").set(pb));
    await assertSucceeds(db.ref("users/alice").get());
});

test("one user cannot read or write another user's data", async () => {
    await seedAlice();
    const bob = as("bob");
    await assertFails(bob.ref("users/alice").get());
    await assertFails(bob.ref("users/alice/profile").get());
    await assertFails(bob.ref("users/alice/pbs").get());
    await assertFails(bob.ref("users/alice/profile/name").set("Bob was here"));
    await assertFails(bob.ref("users/alice/pbs/k2").set(pb));
    await assertFails(bob.ref("users/alice").remove());
});

test("no one can list all users or read the database root", async () => {
    await seedAlice();
    await assertFails(as("alice").ref("users").get());
    await assertFails(as("alice").ref("/").get());
});

test("profile writes are limited to the known fields, as short strings — no photos", async () => {
    const db = as("alice");
    await assertFails(db.ref("users/alice/profile").set({ name: "A", photo: "data:image/png;base64,AAAA" }));
    await assertFails(db.ref("users/alice/profile").set({ name: "A", favouriteColour: "blue" }));
    await assertFails(db.ref("users/alice/profile").set({ name: 42 }));
    await assertFails(db.ref("users/alice/profile").set({ name: "x".repeat(201) }));
    await assertFails(db.ref("users/alice/profile").set({ name: "A", updatedAt: "yesterday" }));
});

test("PB writes must be well-formed", async () => {
    const db = as("alice");
    await assertFails(db.ref("users/alice/pbs/k1").set({ event: "E", course: "C" }));                 // no time
    await assertFails(db.ref("users/alice/pbs/k1").set({ ...pb, extra: 1 }));                          // unknown child
    await assertFails(db.ref("users/alice/pbs/k1").set({ ...pb, history: { e1: { s: -1, n: 1 } } })); // bad seconds
    await assertFails(db.ref("users/alice/pbs/k1").set({ ...pb, history: { e1: { s: 28.5 } } }));     // missing n
});

test("only the defined top-level sections can be written under a user", async () => {
    const db = as("alice");
    await assertFails(db.ref("users/alice/analyzerReports/r1").set({ score: 1 }));
    await assertFails(db.ref("users/alice/photos/p1").set("data:..."));
    await assertSucceeds(db.ref("users/alice/meta/imports/abc123").set({ at: 1, pbEntries: 2, profileFields: 1 }));
    await assertFails(db.ref("users/alice/meta/imports/abc123").set({ at: 1 }));
});

test("section nodes cannot be replaced with primitives (validation can't be skipped)", async () => {
    const db = as("alice");
    await assertFails(db.ref("users/alice").set("not an object"));
    await assertFails(db.ref("users/alice/profile").set("hello"));
    await assertFails(db.ref("users/alice/pbs").set(5));
    await assertFails(db.ref("users/alice/pbs/k1/history").set(true));
    await assertFails(db.ref("users/alice/meta").set("x"));
    await assertFails(db.ref("users/alice/meta/imports").set(1));
});

test("writing a parent path still validates every child", async () => {
    const db = as("alice");
    await assertSucceeds(db.ref("users/alice").set({ profile: { name: "A", updatedAt: 1 }, pbs: { k1: pb } }));
    await assertFails(db.ref("users/alice").set({ profile: { name: "A", photo: "data:..." }, pbs: { k1: pb } }));
    await assertFails(db.ref("users/alice").set({ profile: { name: "A" }, pbs: { k1: { ...pb, time: 28.5 } } }));
    await assertFails(db.ref("users/alice").set({ profile: { name: "A" }, extraSection: { x: 1 } }));
    await assertFails(db.ref("users/alice/pbs").set({ k1: pb, k2: { event: "E" } }));
});

test("multi-path updates can't reach another user, even mixed with your own paths", async () => {
    const db = as("alice");
    await assertFails(db.ref().update({
        "users/alice/profile/name": "Alice",
        "users/bob/profile/name": "Overwritten",
    }));
    await assertFails(db.ref("users").update({ "bob/profile/name": "x" }));
    await assertFails(db.ref("users").set({ alice: { profile: { name: "A" } } }));
    await assertSucceeds(db.ref("users/alice").update({ "profile/name": "Alice", "profile/club": "Sharks" }));
});

test("oversized keys are rejected", async () => {
    const db = as("alice");
    await assertFails(db.ref(`users/alice/pbs/${"k".repeat(401)}`).set(pb));
    await assertFails(db.ref("users/alice/pbs/k1").set({ ...pb, history: { ["e".repeat(121)]: { s: 28.5, n: 1 } } }));
    await assertFails(db.ref(`users/alice/meta/imports/${"f".repeat(65)}`).set({ at: 1, pbEntries: 0, profileFields: 0 }));
});

test("a user can delete their own data but not anyone else's", async () => {
    await seedAlice();
    await assertFails(as("bob").ref("users/alice/pbs/k1").remove());
    await assertSucceeds(as("alice").ref("users/alice/pbs/k1").remove());
    await assertSucceeds(as("alice").ref("users/alice").remove());
});

test("a uid-shaped path can't be spoofed with a different auth uid", async () => {
    await assertFails(as("alice ").ref("users/alice/profile/name").set("x"));
    await seedAlice();
    for (const lookalike of ["ALICE", "alice2", "alic", "users/alice"]) {
        await assertFails(as(lookalike).ref("users/alice").get());
    }
});
