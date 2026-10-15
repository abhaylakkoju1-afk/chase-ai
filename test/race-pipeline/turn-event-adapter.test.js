// Event adapter — turn distance contract (Chronos reliability phase 2).
//
// ADAPTER LAYER ONLY: hand-built turn candidates are submitted to
// racePipelineSubmitTurnCandidate() against a REAL Chronos session, so a failure
// localises to src/race-pipeline/event-adapter.js. All data is synthetic.
//
// CONTRACT (docs/RACE_PIPELINE_ARCHITECTURE.md §9): the adapter ASSIGNS a turn's
// distance (confirmed + one pool length). It therefore requires the session to
// state a valid race distance that is a whole number of pool lengths, refuses to
// guess otherwise, never advances its counter on a rejection, and propagates
// every Chronos rejection verbatim.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineCreateEventAdapterState,
    racePipelineSubmitStartCandidate,
    racePipelineSubmitTurnCandidate
} from "../../src/race-pipeline/event-adapter.js";
import { START_DETECTOR_NAME, TURN_DETECTOR_NAME } from "../../src/race-pipeline/detector-adapter.js";
import { ChronosEngine } from "../../src/chronos-engine/index.js";

function runningSession({ distanceMeters = 100, poolLengthMeters = 25, startAtMs = 0 } = {}) {
    const created = ChronosEngine.createSession({ sessionId: "turn-adapter", poolLengthMeters, course: "Short Course", event: "Freestyle 100m", distanceMeters, timeSource: "video" });
    assert.equal(created.ok, true);
    const armed = ChronosEngine.armSession(created.session).session;
    const state = racePipelineCreateEventAdapterState();
    const started = racePipelineSubmitStartCandidate(armed, { atMs: startAtMs, confidence: 0.8, evidence: {}, detector: START_DETECTOR_NAME }, state);
    assert.equal(started.ok, true);
    return { session: started.session, state: started.eventAdapterState };
}

function candidate(atMs, confidence = 0.7) {
    return { atMs, confidence, evidence: { wallSide: "near-one" }, detector: TURN_DETECTOR_NAME };
}

describe("racePipelineSubmitTurnCandidate() — configured race distance", () => {
    test("a session without a valid race distance is refused BEFORE Chronos, with its own reason; nothing is guessed or advanced", () => {
        const { session, state } = runningSession();
        for (const bad of [null, undefined, 0, -50, NaN, Infinity, "100"]) {
            const unknown = { ...session, distanceMeters: bad };
            const result = racePipelineSubmitTurnCandidate(unknown, candidate(10000), state);
            assert.equal(result.ok, false, String(bad));
            assert.equal(result.reason, "race-distance-unknown");
            assert.equal(result.eventAdapterState, state, "the adapter state object is returned untouched");
            assert.equal(result.event, null);
            assert.equal(result.session, unknown, "the session is returned untouched");
        }
    });

    test("a race distance that is not a whole number of pool lengths is refused: the progression is ambiguous", () => {
        for (const [distance, pool] of [[60, 25], [30, 25], [51, 25], [100, 30], [26, 25]]) {
            const { session, state } = runningSession({ distanceMeters: distance, poolLengthMeters: pool });
            const result = racePipelineSubmitTurnCandidate(session, candidate(10000), state);
            assert.equal(result.ok, false, `${distance} m / ${pool} m`);
            assert.equal(result.reason, "race-distance-not-multiple-of-pool-length");
            assert.equal(result.eventAdapterState.confirmedDistanceMeters, 0);
        }
    });

    test("whole-number multiples are accepted, including fractional pool lengths (floating-point tolerant)", () => {
        for (const [distance, pool] of [[50, 25], [100, 50], [37.5, 12.5], [0.3, 0.1], [1500, 25]]) {
            const { session, state } = runningSession({ distanceMeters: distance, poolLengthMeters: pool });
            if (distance <= pool) continue;
            const result = racePipelineSubmitTurnCandidate(session, candidate(10000), state);
            assert.equal(result.ok, true, `${distance} / ${pool}`);
            assert.equal(result.eventAdapterState.confirmedDistanceMeters, pool);
        }
    });

    test("the configured race distance bounds the progression: a 100 m race in a 25 m pool accepts exactly 25, 50, 75", () => {
        let { session, state } = runningSession({ distanceMeters: 100, poolLengthMeters: 25 });
        const accepted = [];
        for (let i = 0; i < 6; i += 1) {
            const result = racePipelineSubmitTurnCandidate(session, candidate(10000 * (i + 1)), state);
            if (result.ok) {
                accepted.push(result.event.distanceMeters);
                session = result.session;
                state = result.eventAdapterState;
            } else {
                assert.equal(result.reason, "turn-at-or-beyond-race-distance");
                assert.equal(result.eventAdapterState, state, "a rejection leaves the adapter state object untouched");
                assert.equal(result.session, session, "...and the session");
            }
        }
        assert.deepEqual(accepted, [25, 50, 75]);
        assert.equal(state.confirmedDistanceMeters, 75);
    });

    test("a 100 m race in a 50 m pool accepts one turn (50 m) and rejects the next", () => {
        let { session, state } = runningSession({ distanceMeters: 100, poolLengthMeters: 50 });
        const first = racePipelineSubmitTurnCandidate(session, candidate(30000), state);
        assert.equal(first.ok, true);
        assert.equal(first.event.distanceMeters, 50);
        const second = racePipelineSubmitTurnCandidate(first.session, candidate(60000), first.eventAdapterState);
        assert.equal(second.ok, false);
        assert.equal(second.reason, "turn-at-or-beyond-race-distance");
        assert.equal(second.eventAdapterState.confirmedDistanceMeters, 50);
    });

    test("a turn is never clamped to the race distance or relabelled as a finish", () => {
        let { session, state } = runningSession({ distanceMeters: 50, poolLengthMeters: 25 });
        const first = racePipelineSubmitTurnCandidate(session, candidate(10000), state);
        const second = racePipelineSubmitTurnCandidate(first.session, candidate(30000), first.eventAdapterState);
        assert.equal(second.ok, false);
        assert.equal(second.session.events.length, first.session.events.length);
        assert.equal(second.session.events.some((e) => e.type === "finish"), false);
        assert.equal(second.session.status, "running");
        assert.equal(second.session.finalTimeMs, null);
    });
});

describe("racePipelineSubmitTurnCandidate() — rejections never advance state; reprocessing cannot advance twice", () => {
    test("every Chronos rejection leaves the counter and the session byte-for-byte unchanged", () => {
        const { session, state } = runningSession({ distanceMeters: 200, poolLengthMeters: 25, startAtMs: 5000 });
        const accepted = racePipelineSubmitTurnCandidate(session, candidate(10000), state);
        assert.equal(accepted.ok, true);

        const snapshot = JSON.stringify({ session: accepted.session, state: accepted.eventAdapterState });
        const rejections = [
            [candidate(10000), "non-monotonic-timestamp"], // the SAME candidate again
            [candidate(9000), "non-monotonic-timestamp"], // earlier
            [candidate(11000), "event-too-soon-after-previous"], // within the minimum gap
            [candidate(4000), "event-before-start-time"], // before the start (checked first) AND before the previous turn
            [candidate(-5), "timestamp-negative"]
        ];
        for (const [input, reason] of rejections) {
            const result = racePipelineSubmitTurnCandidate(accepted.session, input, accepted.eventAdapterState);
            assert.equal(result.ok, false);
            assert.equal(result.reason, reason);
            assert.equal(JSON.stringify({ session: result.session, state: result.eventAdapterState }), snapshot);
        }
    });

    test("a candidate at or before the start time is rejected by Chronos", () => {
        const { session, state } = runningSession({ distanceMeters: 100, startAtMs: 6000 });
        for (const atMs of [0, 5999, 6000]) {
            const result = racePipelineSubmitTurnCandidate(session, candidate(atMs), state);
            assert.equal(result.ok, false);
            assert.equal(result.reason, "event-before-start-time");
            assert.equal(result.eventAdapterState.confirmedDistanceMeters, 0);
        }
    });

    test("REPROCESSING: submitting the same accepted candidate again, any number of times, advances nothing", () => {
        let { session, state } = runningSession({ distanceMeters: 200 });
        const input = candidate(10000);
        const first = racePipelineSubmitTurnCandidate(session, input, state);
        assert.equal(first.ok, true);
        session = first.session;
        state = first.eventAdapterState;
        for (let i = 0; i < 5; i += 1) {
            const again = racePipelineSubmitTurnCandidate(session, input, state);
            assert.equal(again.ok, false);
            assert.equal(again.eventAdapterState.confirmedDistanceMeters, 25);
            assert.equal(again.session.events.length, 2);
        }
    });

    test("candidate shape errors are refused before Chronos and never touch state", () => {
        const { session, state } = runningSession();
        const cases = [
            [null, "missing-candidate"],
            [{ atMs: NaN, confidence: 0.5, detector: TURN_DETECTOR_NAME }, "invalid-candidate-timestamp"],
            [{ atMs: Infinity, confidence: 0.5, detector: TURN_DETECTOR_NAME }, "invalid-candidate-timestamp"],
            [{ atMs: "10000", confidence: 0.5, detector: TURN_DETECTOR_NAME }, "invalid-candidate-timestamp"],
            [{ atMs: 10000, confidence: 1.5, detector: TURN_DETECTOR_NAME }, "invalid-candidate-confidence"],
            [{ atMs: 10000, confidence: 0.5, detector: START_DETECTOR_NAME }, "unknown-detector"],
            [{ atMs: 10000, confidence: 0.5, detector: "other" }, "unknown-detector"]
        ];
        for (const [input, reason] of cases) {
            const result = racePipelineSubmitTurnCandidate(session, input, state);
            assert.equal(result.ok, false);
            assert.equal(result.reason, reason);
            assert.equal(result.eventAdapterState, state);
        }
    });

    test("state belongs to ONE session: two adapter states advanced independently never influence each other (no wrong-race attribution)", () => {
        const a = runningSession({ distanceMeters: 100 });
        const b = runningSession({ distanceMeters: 100 });
        const advancedA = racePipelineSubmitTurnCandidate(a.session, candidate(10000), a.state);
        assert.equal(advancedA.eventAdapterState.confirmedDistanceMeters, 25);
        assert.equal(b.state.confirmedDistanceMeters, 0);
        const advancedB = racePipelineSubmitTurnCandidate(b.session, candidate(10000), b.state);
        assert.equal(advancedB.event.distanceMeters, 25, "race B's first turn is its own 25 m, not 50 m");
    });
});
