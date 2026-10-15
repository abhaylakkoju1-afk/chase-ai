// Chronos engine — race-distance bound, duplicate-turn rejection, event
// ordering and timestamp validity (Chronos reliability phase 2).
//
// ENGINE LAYER ONLY: events are submitted directly to ChronosEngine.recordEvent()
// so a failure localises to src/chronos-engine/events.js, independent of any
// detector or pipeline. All sessions and events are synthetic.
//
// CONTRACT UNDER TEST (docs/CHRONOS_ARCHITECTURE.md §10-§13 plus the phase-2
// additions documented in docs/RACE_PIPELINE_ARCHITECTURE.md §9):
//   - when session.distanceMeters (the race distance) is known, no
//     distance-bearing event may lie beyond it, and a TURN may not lie AT it;
//   - a second turn at a distance an earlier turn already holds is a duplicate;
//   - a rejected event returns the ORIGINAL session untouched and no event;
//   - when the race distance is unknown nothing is bounded (backward compatible).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChronosEngine } from "../../src/chronos-engine/index.js";
import { MIN_EVENT_GAP_MS } from "../../src/chronos-engine/events.js";

function runningSession({ distanceMeters = 100, poolLengthMeters = 25, startAtMs = 1000 } = {}) {
    const created = ChronosEngine.createSession({
        sessionId: "race-distance-test",
        poolLengthMeters,
        course: "Short Course",
        event: "Freestyle 100m",
        distanceMeters,
        timeSource: "video"
    });
    assert.equal(created.ok, true);
    const armed = ChronosEngine.armSession(created.session);
    const started = ChronosEngine.recordEvent(armed.session, { type: "start", atMs: startAtMs, source: "detector", detector: "d", confidence: 0.9 });
    assert.equal(started.ok, true);
    return started.session;
}

function turn(atMs, distanceMeters, extra = {}) {
    return { type: "turn", atMs, distanceMeters, source: "detector", detector: "turn-detector-v1", confidence: 0.8, ...extra };
}

function record(session, input) {
    return ChronosEngine.recordEvent(session, input);
}

function assertRejectedUntouched(session, result, reason) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.event, null);
    assert.equal(result.session, session, "a rejected event returns the ORIGINAL session object");
}

// ===========================================================================
// RACE-DISTANCE BOUND
// ===========================================================================

describe("Chronos — race-distance bound", () => {
    test("turns at every pool-length multiple BELOW the race distance are accepted", () => {
        let session = runningSession({ distanceMeters: 100 });
        for (const [index, distance] of [25, 50, 75].entries()) {
            const result = record(session, turn(10000 + index * 10000, distance));
            assert.equal(result.ok, true, `turn at ${distance} m`);
            session = result.session;
        }
        assert.deepEqual(session.events.filter((e) => e.type === "turn").map((e) => e.distanceMeters), [25, 50, 75]);
    });

    test("a turn AT the race distance is rejected: that is a finish, and Chronos never relabels one as the other", () => {
        const session = runningSession({ distanceMeters: 50 });
        const first = record(session, turn(10000, 25));
        assert.equal(first.ok, true);
        const atRaceDistance = record(first.session, turn(20000, 50));
        assertRejectedUntouched(first.session, atRaceDistance, "turn-at-or-beyond-race-distance");
    });

    test("a turn BEYOND the race distance is rejected, whichever way the distance got there (125 m for a 50 m race)", () => {
        const session = runningSession({ distanceMeters: 50 });
        for (const distance of [51, 75, 125, 1e9]) {
            const result = record(session, turn(10000, distance));
            assertRejectedUntouched(session, result, "distance-exceeds-race-distance");
        }
    });

    test("a 50 m race in a 50 m pool, and a 25 m race in a 25 m pool, can have no turn at all", () => {
        for (const [distance, pool] of [[50, 50], [25, 25]]) {
            const session = runningSession({ distanceMeters: distance, poolLengthMeters: pool });
            assertRejectedUntouched(session, record(session, turn(10000, pool)), "turn-at-or-beyond-race-distance");
        }
    });

    test("checkpoints (split) may not pass the race distance either, but one AT it is a legal checkpoint", () => {
        const session = runningSession({ distanceMeters: 100 });
        const atDistance = record(session, { type: "split", atMs: 10000, distanceMeters: 100, source: "manual" });
        assert.equal(atDistance.ok, true);
        assertRejectedUntouched(session, record(session, { type: "split", atMs: 10000, distanceMeters: 100.5, source: "manual" }), "distance-exceeds-race-distance");
    });

    test("a finish beyond the race distance is rejected; a finish AT it is accepted and sets the final time", () => {
        const session = runningSession({ distanceMeters: 50 });
        assertRejectedUntouched(session, record(session, { type: "finish", atMs: 30000, distanceMeters: 75, source: "manual" }), "distance-exceeds-race-distance");
        const finished = record(session, { type: "finish", atMs: 30000, distanceMeters: 50, source: "manual" });
        assert.equal(finished.ok, true);
        assert.equal(finished.session.status, "finished");
        assert.equal(finished.session.finalTimeMs, 29000);
    });

    test("COMPATIBILITY: a session with no race distance is not bounded (the field is optional, docs/CHRONOS_ARCHITECTURE.md §5)", () => {
        const created = ChronosEngine.createSession({ sessionId: "no-distance", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 100m", timeSource: "video" });
        const armed = ChronosEngine.armSession(created.session);
        let session = record(armed.session, { type: "start", atMs: 0, source: "manual" }).session;
        assert.equal(session.distanceMeters, null);
        for (const [index, distance] of [25, 50, 75, 100, 125].entries()) {
            const result = record(session, { type: "turn", atMs: 5000 + index * 5000, distanceMeters: distance, source: "manual" });
            assert.equal(result.ok, true, `turn at ${distance} m with no configured race distance`);
            session = result.session;
        }
    });

    test("the bound is checked before the ordering rules, so an over-distance event never reaches them", () => {
        const session = runningSession({ distanceMeters: 50 });
        const first = record(session, turn(10000, 25));
        // Would also be 'non-monotonic-timestamp' and 'distance-out-of-order' — the bound is the reported reason.
        const result = record(first.session, turn(5000, 500));
        assertRejectedUntouched(first.session, result, "distance-exceeds-race-distance");
    });
});

// ===========================================================================
// DUPLICATE TURNS
// ===========================================================================

describe("Chronos — one physical turn, one accepted turn", () => {
    test("a second turn at the SAME distance is a duplicate even long after the minimum gap", () => {
        const session = runningSession({ distanceMeters: 200 });
        const first = record(session, turn(10000, 25));
        assert.equal(first.ok, true);
        for (const atMs of [10001, 12500, 20000, 100000]) {
            assertRejectedUntouched(first.session, record(first.session, turn(atMs, 25)), "duplicate-turn-distance");
        }
        assert.equal(first.session.events.filter((e) => e.type === "turn").length, 1);
    });

    test("resubmitting the identical accepted event (reprocessing) is rejected and cannot advance state", () => {
        const session = runningSession({ distanceMeters: 200 });
        const input = turn(10000, 25);
        const first = record(session, input);
        const again = record(first.session, input);
        assert.equal(again.ok, false);
        assert.equal(again.session, first.session);
        assert.equal(again.session.events.length, first.session.events.length);
    });

    test("a turn at the same distance as an earlier SPLIT (a mid-length checkpoint at a wall distance) is still permitted — only turn/turn duplicates are rejected", () => {
        const session = runningSession({ distanceMeters: 200 });
        const split = record(session, { type: "split", atMs: 10000, distanceMeters: 25, source: "manual" });
        const turned = record(split.session, turn(13000, 25));
        assert.equal(turned.ok, true);
    });
});

// ===========================================================================
// ORDERING AND TIMESTAMPS
// ===========================================================================

describe("Chronos — event ordering and timestamp validity", () => {
    test("no turn before an accepted start: an armed session refuses every non-start type", () => {
        const created = ChronosEngine.createSession({ sessionId: "armed", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 100m", distanceMeters: 100, timeSource: "video" });
        const armed = ChronosEngine.armSession(created.session).session;
        for (const type of ["turn", "split", "finish"]) {
            const result = record(armed, { type, atMs: 5000, distanceMeters: 25, source: "manual" });
            assertRejectedUntouched(armed, result, "event-type-illegal-in-status-armed");
        }
        const idle = created.session;
        assertRejectedUntouched(idle, record(idle, turn(5000, 25)), "event-type-illegal-in-status-idle");
    });

    test("a turn at or before the start time is rejected", () => {
        const session = runningSession({ startAtMs: 5000 });
        for (const atMs of [0, 4999, 5000]) {
            assertRejectedUntouched(session, record(session, turn(atMs, 25)), "event-before-start-time");
        }
    });

    test("invalid timestamps are rejected, never coerced", () => {
        const session = runningSession();
        const cases = [[NaN, "timestamp-not-finite"], [Infinity, "timestamp-not-finite"], [-Infinity, "timestamp-not-finite"], ["10000", "timestamp-not-finite"], [null, "timestamp-not-finite"], [undefined, "timestamp-not-finite"], [-1, "timestamp-negative"]];
        for (const [atMs, reason] of cases) {
            assertRejectedUntouched(session, record(session, turn(atMs, 25)), reason);
        }
    });

    test("out-of-order timestamps and distances are rejected and leave the sequence untouched", () => {
        let session = runningSession({ distanceMeters: 200 });
        session = record(session, turn(20000, 50)).session;
        // earlier time, higher distance
        assertRejectedUntouched(session, record(session, turn(15000, 75)), "non-monotonic-timestamp");
        // later time, LOWER distance
        assertRejectedUntouched(session, record(session, turn(40000, 25)), "distance-out-of-order");
        // same timestamp
        assertRejectedUntouched(session, record(session, turn(20000, 75)), "non-monotonic-timestamp");
        assert.deepEqual(session.events.map((e) => e.type), ["start", "turn"]);
    });

    test("the minimum gap between distance-bearing events is enforced exactly", () => {
        const session = runningSession({ distanceMeters: 200 });
        const first = record(session, turn(10000, 25)).session;
        assertRejectedUntouched(first, record(first, turn(10000 + MIN_EVENT_GAP_MS - 1, 50)), "event-too-soon-after-previous");
        assert.equal(record(first, turn(10000 + MIN_EVENT_GAP_MS, 50)).ok, true);
    });

    test("a second start and a second finish are rejected with their specific reasons", () => {
        const session = runningSession({ distanceMeters: 50 });
        assertRejectedUntouched(session, record(session, { type: "start", atMs: 9999, source: "manual" }), "start-already-recorded");
        const finished = record(session, { type: "finish", atMs: 30000, distanceMeters: 50, source: "manual" }).session;
        assertRejectedUntouched(finished, record(finished, { type: "finish", atMs: 31000, distanceMeters: 50, source: "manual" }), "finish-already-recorded");
        assertRejectedUntouched(finished, record(finished, turn(32000, 25)), "event-type-illegal-in-status-finished");
    });

    test("no finish or final time is ever created by turn activity or by the passage of video time", () => {
        let session = runningSession({ distanceMeters: 100 });
        for (const [index, distance] of [25, 50, 75].entries()) session = record(session, turn(10000 + index * 12000, distance)).session;
        assert.equal(session.status, "running");
        assert.equal(session.finalTimeMs, null);
        assert.equal(session.events.some((e) => e.type === "finish"), false);
        // The reported final time is Chronos's, never derived from the last turn.
        assert.equal(ChronosEngine.buildReport(session).report.finalTimeMs, null);
    });

    test("elapsed time is never negative: every accepted distance-bearing event is strictly after the start", () => {
        let session = runningSession({ distanceMeters: 200, startAtMs: 4000 });
        for (const atMs of [1000, 3999, 4000, 4001, 9000]) {
            const result = record(session, turn(atMs, 25));
            if (result.ok) session = result.session;
        }
        const start = session.events[0];
        for (const event of session.events.slice(1)) {
            assert.ok(event.atMs - start.atMs > 0);
        }
    });
});

// ===========================================================================
// PROPERTY FUZZ — an independent invariant checker over random event streams
// ===========================================================================

function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Checks, from the accepted events ALONE, every invariant the contract promises. Written independently of events.js.
function checkInvariants(session, label) {
    const events = session.events;
    const starts = events.filter((e) => e.type === "start");
    assert.ok(starts.length <= 1, `${label}: at most one start`);
    if (events.length > 0) assert.equal(events[0].type, "start", `${label}: the first accepted event is the start`);
    assert.ok(events.filter((e) => e.type === "finish").length <= 1, `${label}: at most one finish`);

    const bearing = events.filter((e) => e.type !== "start");
    for (let i = 0; i < bearing.length; i += 1) {
        const event = bearing[i];
        assert.ok(Number.isFinite(event.atMs) && event.atMs > starts[0].atMs, `${label}: after the start, finite`);
        assert.ok(Number.isFinite(event.distanceMeters) && event.distanceMeters >= 0, `${label}: finite non-negative distance`);
        if (isFinite(session.distanceMeters) && session.distanceMeters > 0) {
            assert.ok(event.distanceMeters <= session.distanceMeters, `${label}: within the race distance`);
            if (event.type === "turn") assert.ok(event.distanceMeters < session.distanceMeters, `${label}: a turn is strictly before the race distance`);
        }
        if (i > 0) {
            assert.ok(event.atMs > bearing[i - 1].atMs, `${label}: strictly increasing time`);
            assert.ok(event.atMs - bearing[i - 1].atMs >= MIN_EVENT_GAP_MS, `${label}: minimum gap`);
            assert.ok(event.distanceMeters >= bearing[i - 1].distanceMeters, `${label}: non-decreasing distance`);
        }
    }
    const turns = events.filter((e) => e.type === "turn");
    assert.equal(new Set(turns.map((e) => e.distanceMeters)).size, turns.length, `${label}: no two turns at one distance`);
    if (session.status === "finished") {
        assert.equal(session.finalTimeMs, events.find((e) => e.type === "finish").atMs - starts[0].atMs, `${label}: final time is finish - start`);
    } else {
        assert.equal(session.finalTimeMs, null, `${label}: no final time before a finish`);
    }
}

describe("Chronos — invariants hold under random event streams (synthetic fuzz)", () => {
    test("400 random streams of valid and invalid events never violate an invariant, and a rejection never changes the session", () => {
        let accepted = 0;
        let rejected = 0;
        for (let seed = 1; seed <= 400; seed += 1) {
            const random = seeded(seed * 2654435761);
            const pool = random() < 0.5 ? 25 : 50;
            const raceDistance = random() < 0.15 ? null : pool * (1 + Math.floor(random() * 6));
            const created = ChronosEngine.createSession({ sessionId: `fuzz-${seed}`, poolLengthMeters: pool, course: "Short Course", event: "Freestyle 100m", distanceMeters: raceDistance, timeSource: "video" });
            let session = ChronosEngine.armSession(created.session).session;

            const weird = [NaN, Infinity, -5, "7", null, undefined, 0, 1e12];
            for (let step = 0; step < 40; step += 1) {
                const type = ["start", "turn", "turn", "turn", "split", "finish"][Math.floor(random() * 6)];
                const atMs = random() < 0.1 ? weird[Math.floor(random() * weird.length)] : Math.floor(random() * 120000);
                const distanceMeters = random() < 0.08 ? weird[Math.floor(random() * weird.length)] : pool * Math.floor(random() * 9);
                const input = { type, atMs, distanceMeters, source: "detector", detector: "fuzz", confidence: random() };
                const before = session;
                const snapshot = JSON.stringify(before);
                const result = ChronosEngine.recordEvent(before, input);
                if (result.ok) {
                    accepted += 1;
                    session = result.session;
                } else {
                    rejected += 1;
                    assert.equal(result.session, before, `seed ${seed} step ${step}: a rejection returns the original session`);
                    assert.equal(JSON.stringify(before), snapshot, `seed ${seed} step ${step}: ...unchanged`);
                    assert.equal(result.event, null);
                    assert.equal(typeof result.reason, "string");
                }
                checkInvariants(session, `seed ${seed} step ${step}`);
                if (session.status === "finished") break;
            }
        }
        assert.ok(accepted > 500, `fuzz accepted real events (${accepted})`);
        assert.ok(rejected > 5000, `fuzz exercised rejections (${rejected})`);
    });
});
