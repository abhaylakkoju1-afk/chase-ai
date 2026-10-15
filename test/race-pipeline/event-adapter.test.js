// Unit tests for src/race-pipeline/event-adapter.js.
//
// These tests exercise the distance-bookkeeping algorithm
// (docs/RACE_PIPELINE_ARCHITECTURE.md §9, Decision 2) against a REAL
// Chronos session, built exactly the way test/chronos-engine/*.test.js
// already does (chronosCreateSession -> chronosArmSession ->
// ChronosEngine.recordEvent), never a mocked Chronos.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineCreateEventAdapterState,
    racePipelineSubmitStartCandidate,
    racePipelineSubmitTurnCandidate
} from "../../src/race-pipeline/event-adapter.js";

import { START_DETECTOR_NAME, TURN_DETECTOR_NAME } from "../../src/race-pipeline/detector-adapter.js";

import { chronosCreateSession, chronosArmSession } from "../../src/chronos-engine/session.js";

const POOL_LENGTH_METERS = 25;

function armedSession(overrides = {}) {
    const created = chronosCreateSession({
        sessionId: "event-adapter-test",
        poolLengthMeters: POOL_LENGTH_METERS,
        course: "Short Course",
        event: "Freestyle 100m",
        // Phase 2: the event adapter assigns turn distances, so it requires
        // the session to know its race distance (it refuses to guess one).
        // 100 is what "Freestyle 100m" means.
        distanceMeters: 100,
        timeSource: "video",
        ...overrides
    });
    assert.equal(created.ok, true, "test setup: chronosCreateSession must succeed");
    const armed = chronosArmSession(created.session);
    assert.equal(armed.ok, true, "test setup: chronosArmSession must succeed");
    return armed.session;
}

function startCandidate(atMs, confidence = 0.8, evidence = { displacement: 0.2 }) {
    return { atMs, confidence, evidence, detector: START_DETECTOR_NAME };
}

function turnCandidate(atMs, confidence = 0.7, evidence = { hipX: 0.2 }) {
    return { atMs, confidence, evidence, detector: TURN_DETECTOR_NAME };
}

// ===========================================================================
// 1 / 3 / 4 / 5 / 16 — START CANDIDATE -> CHRONOS START EVENT
// ===========================================================================

describe("racePipelineSubmitStartCandidate() — start candidate -> Chronos start event", () => {
    test("a valid start candidate becomes an accepted Chronos start event with source/detector/confidence/atMs preserved", () => {
        const session = armedSession();
        const eventAdapterState = racePipelineCreateEventAdapterState();
        const candidate = startCandidate(1000, 0.83);

        const result = racePipelineSubmitStartCandidate(session, candidate, eventAdapterState);

        assert.equal(result.ok, true);
        assert.equal(result.reason, null);
        assert.equal(result.event.type, "start");
        assert.equal(result.event.atMs, 1000); // timestamp preserved exactly
        assert.equal(result.event.source, "detector");
        assert.equal(result.event.detector, START_DETECTOR_NAME);
        assert.equal(result.event.confidence, 0.83);
        assert.equal(result.session.status, "running");
    });
});

// ===========================================================================
// 2 / 3 / 4 / 5 — TURN CANDIDATE -> CHRONOS TURN EVENT
// ===========================================================================

describe("racePipelineSubmitTurnCandidate() — turn candidate -> Chronos turn event", () => {
    test("a valid turn candidate (after a start) becomes an accepted Chronos turn event with source/detector/confidence preserved", () => {
        let session = armedSession();
        let eventAdapterState = racePipelineCreateEventAdapterState();

        const startResult = racePipelineSubmitStartCandidate(session, startCandidate(0), eventAdapterState);
        session = startResult.session;
        eventAdapterState = startResult.eventAdapterState;

        const turnResult = racePipelineSubmitTurnCandidate(session, turnCandidate(1000, 0.66), eventAdapterState);

        assert.equal(turnResult.ok, true);
        assert.equal(turnResult.event.type, "turn");
        assert.equal(turnResult.event.atMs, 1000);
        assert.equal(turnResult.event.source, "detector");
        assert.equal(turnResult.event.detector, TURN_DETECTOR_NAME);
        assert.equal(turnResult.event.confidence, 0.66);
    });
});

// ===========================================================================
// 6 — DISTANCE STARTS AT ZERO
// ===========================================================================

describe("racePipelineCreateEventAdapterState() — distance starts at zero", () => {
    test("a freshly created event-adapter state has confirmedDistanceMeters === 0", () => {
        assert.equal(racePipelineCreateEventAdapterState().confirmedDistanceMeters, 0);
    });
});

// ===========================================================================
// 7 / 8 / 9 / 10 / 19 — THE EXACT 25m WORKED EXAMPLE FROM THE ARCHITECTURE
// ===========================================================================

describe("racePipelineSubmitTurnCandidate() — the 25m worked example (docs/RACE_PIPELINE_ARCHITECTURE.md §9)", () => {
    test("start(0) -> confirmed=0; turn1(tentative 25, accepted) -> confirmed=25; noisy duplicate(tentative 50, rejected too-soon) -> confirmed stays 25; turn2(tentative 50, accepted) -> confirmed=50", () => {
        let session = armedSession();
        let state = racePipelineCreateEventAdapterState();
        assert.equal(state.confirmedDistanceMeters, 0);

        // start recorded — must NOT touch confirmedDistanceMeters.
        const startResult = racePipelineSubmitStartCandidate(session, startCandidate(0), state);
        assert.equal(startResult.ok, true);
        session = startResult.session;
        state = startResult.eventAdapterState;
        assert.equal(state.confirmedDistanceMeters, 0);

        // 1st turn candidate: tentative = 0 + 25 = 25, accepted.
        const turn1 = racePipelineSubmitTurnCandidate(session, turnCandidate(1000), state);
        assert.equal(turn1.ok, true);
        assert.equal(turn1.event.distanceMeters, 25);
        session = turn1.session;
        state = turn1.eventAdapterState;
        assert.equal(state.confirmedDistanceMeters, 25);

        // Noisy duplicate: tentative = 25 + 25 = 50, but arrives too soon
        // after turn1 (gap 1000ms < MIN_EVENT_GAP_MS 2500ms) -> rejected.
        const noisyDuplicate = racePipelineSubmitTurnCandidate(session, turnCandidate(2000), state);
        assert.equal(noisyDuplicate.ok, false);
        assert.equal(noisyDuplicate.reason, "event-too-soon-after-previous");
        session = noisyDuplicate.session;
        state = noisyDuplicate.eventAdapterState;
        assert.equal(state.confirmedDistanceMeters, 25); // unchanged

        // 2nd turn candidate: tentative computed against the SAME
        // un-advanced base (25 + 25 = 50), now far enough past turn1's
        // atMs (gap exactly 2500ms) to be accepted.
        const turn2 = racePipelineSubmitTurnCandidate(session, turnCandidate(3500), state);
        assert.equal(turn2.ok, true);
        assert.equal(turn2.event.distanceMeters, 50);
        state = turn2.eventAdapterState;
        assert.equal(state.confirmedDistanceMeters, 50);
    });
});

// ===========================================================================
// 11 / 20 — CHRONOS REJECTION IS PROPAGATED / CHRONOS REMAINS AUTHORITATIVE
// ===========================================================================

describe("racePipelineSubmitTurnCandidate() / racePipelineSubmitStartCandidate() — Chronos rejection propagation", () => {
    test("a turn candidate submitted before any start is rejected verbatim by Chronos, and distance is untouched", () => {
        const session = armedSession(); // status: armed, no start recorded
        const state = racePipelineCreateEventAdapterState();

        const result = racePipelineSubmitTurnCandidate(session, turnCandidate(1000), state);

        assert.equal(result.ok, false);
        assert.equal(result.reason, "event-type-illegal-in-status-armed");
        assert.equal(result.eventAdapterState.confirmedDistanceMeters, 0);
    });

    test("a second start candidate is rejected with Chronos's own start-already-recorded reason", () => {
        let session = armedSession();
        let state = racePipelineCreateEventAdapterState();

        const first = racePipelineSubmitStartCandidate(session, startCandidate(0), state);
        session = first.session;
        state = first.eventAdapterState;

        const second = racePipelineSubmitStartCandidate(session, startCandidate(500), state);

        assert.equal(second.ok, false);
        assert.equal(second.reason, "start-already-recorded");
    });

    test("a candidate is never treated as authoritative merely by existing — only Chronos's ok:true makes it so", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();

        // A well-formed candidate, submitted into an illegal state (armed,
        // no start) — the candidate itself is perfectly valid, but Chronos
        // still refuses it, and this file must never override that.
        const result = racePipelineSubmitTurnCandidate(session, turnCandidate(1000), state);

        assert.equal(result.ok, false);
        assert.equal(result.session.events.length, 0);
    });
});

// ===========================================================================
// 12 — INVALID POOL LENGTH REJECTED
// ===========================================================================

describe("racePipelineSubmitTurnCandidate() — invalid pool length", () => {
    test("a session with poolLengthMeters 0 is rejected before Chronos is ever called, distance untouched", () => {
        let session = armedSession();
        let state = racePipelineCreateEventAdapterState();
        const startResult = racePipelineSubmitStartCandidate(session, startCandidate(0), state);
        session = startResult.session;
        state = startResult.eventAdapterState;

        const tamperedSession = { ...session, poolLengthMeters: 0 };
        const result = racePipelineSubmitTurnCandidate(tamperedSession, turnCandidate(1000), state);

        assert.equal(result.ok, false);
        assert.equal(result.reason, "invalid-pool-length-meters");
        assert.equal(result.eventAdapterState.confirmedDistanceMeters, 0);
    });

    test("a session with a non-finite poolLengthMeters (NaN) is rejected", () => {
        let session = armedSession();
        let state = racePipelineCreateEventAdapterState();
        const startResult = racePipelineSubmitStartCandidate(session, startCandidate(0), state);
        session = startResult.session;
        state = startResult.eventAdapterState;

        const tamperedSession = { ...session, poolLengthMeters: NaN };
        const result = racePipelineSubmitTurnCandidate(tamperedSession, turnCandidate(1000), state);

        assert.equal(result.ok, false);
        assert.equal(result.reason, "invalid-pool-length-meters");
    });

    test("a missing session is rejected rather than throwing", () => {
        const state = racePipelineCreateEventAdapterState();
        assert.doesNotThrow(() => racePipelineSubmitTurnCandidate(null, turnCandidate(1000), state));
        const result = racePipelineSubmitTurnCandidate(null, turnCandidate(1000), state);
        assert.equal(result.ok, false);
    });
});

// ===========================================================================
// 13 — MALFORMED CANDIDATE REJECTED
// ===========================================================================

describe("event adapter — malformed candidate handling", () => {
    test("a null candidate is rejected as missing-candidate, not a throw", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();

        assert.doesNotThrow(() => racePipelineSubmitStartCandidate(session, null, state));
        const result = racePipelineSubmitStartCandidate(session, null, state);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "missing-candidate");
    });

    test("a candidate missing atMs is rejected", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();
        const result = racePipelineSubmitStartCandidate(session, { confidence: 0.5, evidence: {}, detector: START_DETECTOR_NAME }, state);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "invalid-candidate-timestamp");
    });

    test("a candidate with an out-of-range confidence (> 1) is rejected", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();
        const result = racePipelineSubmitStartCandidate(session, startCandidate(0, 1.5), state);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "invalid-candidate-confidence");
    });

    test("a candidate with a non-numeric confidence is rejected", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();
        const result = racePipelineSubmitStartCandidate(session, { atMs: 0, confidence: "high", evidence: {}, detector: START_DETECTOR_NAME }, state);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "invalid-candidate-confidence");
    });

    test("an unknown/wrong detector name is rejected (e.g. a turn candidate submitted as a start candidate)", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();
        const result = racePipelineSubmitStartCandidate(session, turnCandidate(0), state);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "unknown-detector");
    });

    test("a completely unrecognized detector string is rejected", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();
        const result = racePipelineSubmitStartCandidate(
            session,
            { atMs: 0, confidence: 0.5, evidence: {}, detector: "some-other-detector-v9" },
            state
        );
        assert.equal(result.ok, false);
        assert.equal(result.reason, "unknown-detector");
    });
});

// ===========================================================================
// 14 — RESET RETURNS DISTANCE TO ZERO
// ===========================================================================

describe("event adapter — reset/lifecycle", () => {
    test("creating a fresh event-adapter state after advancing distance returns to zero", () => {
        let session = armedSession();
        let state = racePipelineCreateEventAdapterState();
        const startResult = racePipelineSubmitStartCandidate(session, startCandidate(0), state);
        session = startResult.session;
        state = startResult.eventAdapterState;

        const turnResult = racePipelineSubmitTurnCandidate(session, turnCandidate(1000), state);
        state = turnResult.eventAdapterState;
        assert.equal(state.confirmedDistanceMeters, 25);

        const resetState = racePipelineCreateEventAdapterState();
        assert.equal(resetState.confirmedDistanceMeters, 0);
    });
});

// ===========================================================================
// 15 — SEPARATE RACE STATES DO NOT LEAK
// ===========================================================================

describe("event adapter — no cross-race state leakage", () => {
    test("two independent event-adapter states, advanced differently, never influence one another", () => {
        const sessionA = armedSession({ sessionId: "race-a" });
        const sessionB = armedSession({ sessionId: "race-b" });

        let stateA = racePipelineCreateEventAdapterState();
        let stateB = racePipelineCreateEventAdapterState();

        const startA = racePipelineSubmitStartCandidate(sessionA, startCandidate(0), stateA);
        stateA = startA.eventAdapterState;
        const turnA = racePipelineSubmitTurnCandidate(startA.session, turnCandidate(1000), stateA);
        stateA = turnA.eventAdapterState;

        assert.equal(stateA.confirmedDistanceMeters, 25);
        assert.equal(stateB.confirmedDistanceMeters, 0); // untouched by race A's activity
    });

    test("the original eventAdapterState object passed in is never mutated in place", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();
        const snapshot = structuredClone(state);

        const startResult = racePipelineSubmitStartCandidate(session, startCandidate(0), state);
        racePipelineSubmitTurnCandidate(startResult.session, turnCandidate(1000), startResult.eventAdapterState);

        assert.deepEqual(state, snapshot);
    });
});

// ===========================================================================
// 17 / 18 — PURITY: NO CLOCK / DOM / BROWSER DEPENDENCY
// ===========================================================================

describe("event adapter — purity", () => {
    test("no Date.now()/performance.now() access across a full submit workflow", () => {
        const originalDateNow = Date.now;
        const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

        Date.now = () => { throw new Error("event-adapter.js must never call Date.now()"); };
        if (typeof performance !== "undefined") {
            performance.now = () => { throw new Error("event-adapter.js must never call performance.now()"); };
        }

        try {
            let session = armedSession();
            let state = racePipelineCreateEventAdapterState();
            const startResult = racePipelineSubmitStartCandidate(session, startCandidate(0), state);
            session = startResult.session;
            state = startResult.eventAdapterState;
            racePipelineSubmitTurnCandidate(session, turnCandidate(1000), state);
        } finally {
            Date.now = originalDateNow;
            if (typeof performance !== "undefined") {
                performance.now = originalPerformanceNow;
            }
        }
    });

    test("this Node environment genuinely has no document/window to accidentally depend on", () => {
        assert.equal(typeof document, "undefined");
    });
});

// ===========================================================================
// DETERMINISM
// ===========================================================================

describe("event adapter — determinism", () => {
    test("identical inputs (session, candidate, state) produce identical results across repeated calls", () => {
        const session = armedSession();
        const state = racePipelineCreateEventAdapterState();
        const candidate = startCandidate(0);

        const first = racePipelineSubmitStartCandidate(session, candidate, state);
        const second = racePipelineSubmitStartCandidate(session, candidate, state);

        assert.deepEqual(first, second);
    });
});
