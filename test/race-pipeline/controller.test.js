// Unit/integration tests for src/race-pipeline/controller.js.
//
// These tests exercise the REAL ChronosEngine and SwimmerTracking (never
// mocked) through the controller, using hand-built, deterministic
// PoseSample fixtures — never real video/MediaPipe. Several tests drive
// a full synthetic race (lock -> start -> turn) end to end through
// racePipelineProcessPoseSample(), proving the whole
// SwimmerTracking -> detector-adapter -> event-adapter -> ChronosEngine
// chain, not just each adapter in isolation (already covered by their own
// test files).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineCreateController,
    racePipelineStartAnalysis,
    racePipelineProcessPoseSample,
    racePipelineStopAnalysis,
    racePipelineBuildReport,
    racePipelineControllerStatus,
    TURN_DETECTION_UNAVAILABLE_REASON
} from "../../src/race-pipeline/controller.js";

import { ChronosEngine } from "../../src/chronos-engine/index.js";
import { SwimmerTracking } from "../../src/swimmer-tracking/index.js";
import { racePipelineCreateDetectorState } from "../../src/race-pipeline/detector-adapter.js";
import { racePipelineCreateEventAdapterState } from "../../src/race-pipeline/event-adapter.js";

const VALID_CONFIG = {
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 100m",
    strokeKey: "freestyle",
    distanceMeters: 100
};

function poseSample(atMs, { hipX = 0.5, hipY = 0.5, noseX = 0.5, noseY = 0.5, hipVisibility = 0.9, noseVisibility = 0.9 } = {}) {
    return {
        atMs,
        hasPose: true,
        landmarks: {
            hip: { x: hipX, y: hipY, visibility: hipVisibility },
            nose: { x: noseX, y: noseY, visibility: noseVisibility }
        }
    };
}

// Drives a fresh controller through SwimmerTracking's locking phase with
// 5 perfectly stationary samples (well within maxLockingPositionError),
// starting at `seedAtMs`, 100ms apart — reaches TARGET_LOCKED on the 5th
// call (selectionConfirmationSamples default: 5). Returns the resulting
// controller and the atMs of the last (lock-completing) sample.
function driveToLocked(controller, seedAtMs) {
    let current = controller;
    let lastAtMs = seedAtMs;
    for (let i = 0; i < 5; i++) {
        lastAtMs = seedAtMs + i * 100;
        const result = racePipelineProcessPoseSample(current, poseSample(lastAtMs), current.generation);
        current = result.controller;
    }
    assert.equal(current.trackingSession.status, "TARGET_LOCKED", "test setup: must reach TARGET_LOCKED");
    return { controller: current, lastAtMs };
}

// ===========================================================================
// 3 / 4 — FRESH SESSION GETS FRESH DETECTOR/EVENT-ADAPTER STATE
// ===========================================================================

describe("racePipelineStartAnalysis() — fresh state per session", () => {
    test("a successful start produces a fresh Chronos session, tracking session, detector state, and event-adapter state", () => {
        const controller = racePipelineCreateController();
        const result = racePipelineStartAnalysis(controller, VALID_CONFIG);

        assert.equal(result.ok, true);
        assert.equal(result.controller.chronosSession.status, "armed");
        assert.equal(result.controller.trackingSession.status, "UNSELECTED");
        assert.deepEqual(result.controller.detectorState, racePipelineCreateDetectorState());
        assert.deepEqual(result.controller.eventAdapterState, racePipelineCreateEventAdapterState());
        assert.equal(result.controller.eventAdapterState.confirmedDistanceMeters, 0);
        assert.equal(result.controller.generation, controller.generation + 1);
    });

    test("missing/invalid config blocks analysis with a clear reason and never creates a session", () => {
        const controller = racePipelineCreateController();
        const result = racePipelineStartAnalysis(controller, null);

        assert.equal(result.ok, false);
        assert.equal(result.reason, "missing-config");
        assert.equal(result.controller.chronosSession, null);
        assert.equal(racePipelineControllerStatus(result.controller), "blocked");
    });

    test("a config missing required Chronos metadata (course/event/poolLength) is blocked, not defaulted", () => {
        const controller = racePipelineCreateController();
        const result = racePipelineStartAnalysis(controller, { poolLengthMeters: 25 });

        assert.equal(result.ok, false);
        assert.equal(result.reason, "missing-course");
    });
});

// ===========================================================================
// STAGE 4D.7 — calibrationPoint (TargetSelection.point reuse, decision #7)
// ===========================================================================

describe("racePipelineStartAnalysis() / racePipelineProcessPoseSample() — calibrationPoint threading", () => {
    test("a supplied calibrationPoint is stored on controller.config exactly as given", () => {
        const result = racePipelineStartAnalysis(racePipelineCreateController(), {
            ...VALID_CONFIG,
            referenceLaneY: 0.47,
            calibrationPoint: { x: 0.5, y: 0.47 }
        });
        assert.equal(result.ok, true);
        assert.deepEqual(result.controller.config.calibrationPoint, { x: 0.5, y: 0.47 });
    });

    test("the first-sample auto-selection uses the calibrationPoint as TargetSelection.point, not null", () => {
        let controller = racePipelineStartAnalysis(racePipelineCreateController(), {
            ...VALID_CONFIG,
            referenceLaneY: 0.47,
            calibrationPoint: { x: 0.5, y: 0.47 }
        }).controller;

        controller = racePipelineProcessPoseSample(controller, poseSample(0), controller.generation).controller;

        assert.deepEqual(controller.trackingSession.selection, { atMs: 0, point: { x: 0.5, y: 0.47 } });
    });

    test("without a calibrationPoint, auto-selection still uses point: null exactly as before Stage 4D.7 (backward compatible)", () => {
        let controller = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG).controller;
        controller = racePipelineProcessPoseSample(controller, poseSample(0), controller.generation).controller;

        assert.deepEqual(controller.trackingSession.selection, { atMs: 0, point: null });
    });

    test("a malformed calibrationPoint (non-finite x/y) is rejected at start, never silently dropped or coerced", () => {
        const result = racePipelineStartAnalysis(racePipelineCreateController(), {
            ...VALID_CONFIG,
            calibrationPoint: { x: 0.5, y: "not-a-number" }
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "invalid-calibration-point");
    });
});

// ===========================================================================
// 5 / 6 — START CANDIDATE REACHES CHRONOS; ACCEPTED START STOPS START DETECTION
// ===========================================================================

describe("racePipelineProcessPoseSample() — start lifecycle", () => {
    test("a real start-triggering sequence (lock, stable baseline, then displacement) produces an accepted Chronos start event", () => {
        let started = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG);
        assert.equal(started.ok, true);
        let controller = started.controller;

        // Lock (atMs 0..400), then 4 more stationary samples to build the
        // start detector's 5-sample baseline (atMs 400 was already fed as
        // the lock-completing sample and became baseline sample #1).
        ({ controller } = driveToLocked(controller, 0));
        for (const atMs of [500, 600, 700, 800]) {
            const result = racePipelineProcessPoseSample(controller, poseSample(atMs), controller.generation);
            controller = result.controller;
        }
        assert.equal(controller.detectorState.startBaselineWindow.length, 5);
        assert.equal(controller.chronosSession.status, "armed");

        // Displacement sample: nose.x 0.5 -> 0.62 (0.12 >= 0.08 threshold),
        // hip held still, so the tracking midpoint only shifts by 0.06 —
        // comfortably within maxSteadyStatePositionError (0.08), keeping
        // the target confirmed for this exact frame.
        const displaced = racePipelineProcessPoseSample(controller, poseSample(900, { noseX: 0.62 }), controller.generation);
        controller = displaced.controller;

        assert.equal(controller.chronosSession.status, "running");
        const startEvent = controller.chronosSession.events.find((e) => e.type === "start");
        assert.notEqual(startEvent, undefined);
        assert.equal(startEvent.atMs, 900);
        assert.equal(startEvent.source, "detector");
        assert.equal(startEvent.detector, "start-detector-v1");
        assert.equal(controller.diagnostics.lastEvent.kind, "start");
        assert.equal(controller.diagnostics.lastEvent.ok, true);
    });

    test("once Chronos has accepted a start, the controller stops calling the start detector for the rest of the race", () => {
        let started = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG);
        let controller = started.controller;
        ({ controller } = driveToLocked(controller, 0));
        for (const atMs of [500, 600, 700, 800]) {
            controller = racePipelineProcessPoseSample(controller, poseSample(atMs), controller.generation).controller;
        }
        controller = racePipelineProcessPoseSample(controller, poseSample(900, { noseX: 0.62 }), controller.generation).controller;
        assert.equal(controller.chronosSession.status, "running");

        const baselineLengthAfterStart = controller.detectorState.startBaselineWindow.length;

        // A second, even larger nose displacement — if the start detector
        // were still being called, this would be another qualifying
        // candidate. Hip stays still so tracking remains confirmed.
        const after = racePipelineProcessPoseSample(controller, poseSample(1000, { noseX: 0.9 }), controller.generation);
        controller = after.controller;

        // The start baseline window must be COMPLETELY untouched — proof
        // the start detector was never invoked again (Stage 4D.6 §10,
        // Stage 4D.5.1's flagged baseline-drift concern).
        assert.equal(controller.detectorState.startBaselineWindow.length, baselineLengthAfterStart);
        assert.equal(controller.diagnostics.lastEvent.kind, "start"); // unchanged — no new event
        assert.equal(controller.chronosSession.events.filter((e) => e.type === "start").length, 1);
    });
});

// ===========================================================================
// TURN LIFECYCLE FIXTURE — a controller already "running" with a locked
// target, built directly against the real ChronosEngine/SwimmerTracking
// APIs (mirroring test/race-pipeline/event-adapter.test.js's armedSession()
// pattern) so the turn-specific tests don't need to re-derive locking and
// start detection every time.
// ===========================================================================

function runningControllerWithLockedTarget({ referenceLaneY = 0.5 } = {}) {
    const created = ChronosEngine.createSession({
        sessionId: "turn-fixture",
        poolLengthMeters: 25,
        course: "Short Course",
        event: "Freestyle 100m",
        timeSource: "video"
    });
    const armed = ChronosEngine.armSession(created.session);
    const started = ChronosEngine.recordEvent(armed.session, {
        type: "start",
        atMs: 0,
        source: "detector",
        detector: "start-detector-v1",
        confidence: 0.9
    });
    assert.equal(started.ok, true, "test setup: start must be accepted");

    let trackingSession = SwimmerTracking.createSession({ sessionId: "turn-fixture" }).session;
    trackingSession = SwimmerTracking.selectTarget(trackingSession, { atMs: 1000, point: null }).session;
    for (let i = 0; i < 5; i++) {
        const atMs = 1000 + i * 100;
        trackingSession = SwimmerTracking.observe(trackingSession, poseSample(atMs)).session;
    }
    assert.equal(trackingSession.status, "TARGET_LOCKED", "test setup: must reach TARGET_LOCKED");

    return {
        generation: 1,
        chronosSession: started.session,
        trackingSession,
        detectorState: racePipelineCreateDetectorState(),
        eventAdapterState: racePipelineCreateEventAdapterState(),
        config: {
            poolLengthMeters: 25,
            course: "Short Course",
            event: "Freestyle 100m",
            strokeKey: null,
            distanceMeters: null,
            referenceLaneY
        },
        blockedReason: null,
        report: null,
        diagnostics: {
            lastTrackingStatus: "TARGET_LOCKED",
            lastObservationOutcome: "confirmed",
            lastEvent: null,
            turnDetectionAvailable: referenceLaneY !== null,
            turnDetectionUnavailableReason: referenceLaneY !== null ? null : TURN_DETECTION_UNAVAILABLE_REASON
        }
    };
}

// A linear hip approach toward the near-zero wall edge, nose held fixed at
// (0.5, referenceLaneY). Hand-verified (see the accompanying investigation
// in this stage's own working notes) to keep SwimmerTracking continuously
// CONFIRMED (well under maxSteadyStatePositionError) while still crossing
// the turn detector's wallThreshold (0.25) with velocity well under its
// velocityThreshold (0.12/s). atMs values continue from the fixture's lock
// (last locked sample at atMs 1400).
const TURN_APPROACH = [
    { atMs: 2400, hipX: 0.45 },
    { atMs: 3400, hipX: 0.40 },
    { atMs: 4400, hipX: 0.35 },
    { atMs: 5400, hipX: 0.30 },
    { atMs: 6400, hipX: 0.25 }, // exactly at wallThreshold — NOT "near" (strict <)
    { atMs: 7400, hipX: 0.20 }, // first wall-qualifying sample -> turn candidate #1 (accepted)
    { atMs: 8400, hipX: 0.19 }, // second candidate, too soon after #1 (gap 1000ms < 2500ms) -> rejected
    { atMs: 10200, hipX: 0.18 } // third candidate, gap from #1 is 2800ms >= 2500ms -> accepted
];

function driveTurnApproach(controller) {
    let current = controller;
    for (const { atMs, hipX } of TURN_APPROACH) {
        const result = racePipelineProcessPoseSample(current, poseSample(atMs, { hipX }), current.generation);
        current = result.controller;
    }
    return current;
}

// ===========================================================================
// 7 / 8 / 9 — TURN CANDIDATE REACHES CHRONOS; REJECTED/ACCEPTED DISTANCE
// ===========================================================================

describe("racePipelineProcessPoseSample() — turn lifecycle (the 25m worked example, end to end)", () => {
    test("a full wall-approach sequence produces exactly the expected accept/reject/accept turn pattern and distance progression", () => {
        let controller = runningControllerWithLockedTarget();
        controller = driveTurnApproach(controller);

        const turnEvents = controller.chronosSession.events.filter((e) => e.type === "turn");
        assert.equal(turnEvents.length, 2); // only the two ACCEPTED turns land in session.events
        assert.equal(turnEvents[0].atMs, 7400);
        assert.equal(turnEvents[0].distanceMeters, 25);
        assert.equal(turnEvents[0].source, "detector");
        assert.equal(turnEvents[0].detector, "turn-detector-v1");
        assert.equal(turnEvents[1].atMs, 10200);
        assert.equal(turnEvents[1].distanceMeters, 50);

        assert.equal(controller.eventAdapterState.confirmedDistanceMeters, 50);

        // The rejected middle candidate must never have been able to
        // advance distance even transiently.
        assert.equal(controller.diagnostics.lastEvent.kind, "turn");
    });

    test("the rejected duplicate candidate specifically reports Chronos's own too-soon reason, not a fabricated one", () => {
        let controller = runningControllerWithLockedTarget();

        // Drive through the first accepted candidate and the rejected one,
        // stopping right after the rejection to inspect it directly.
        for (const { atMs, hipX } of TURN_APPROACH.slice(0, 7)) {
            controller = racePipelineProcessPoseSample(controller, poseSample(atMs, { hipX }), controller.generation).controller;
        }

        assert.equal(controller.diagnostics.lastEvent.kind, "turn");
        assert.equal(controller.diagnostics.lastEvent.ok, false);
        assert.equal(controller.diagnostics.lastEvent.reason, "event-too-soon-after-previous");
        assert.equal(controller.eventAdapterState.confirmedDistanceMeters, 25); // unchanged by the rejection
    });
});

// ===========================================================================
// 10 — MISSING referenceLaneY DISABLES TURN DETECTION SAFELY
// ===========================================================================

describe("racePipelineProcessPoseSample() — turn detection disabled without referenceLaneY", () => {
    test("the exact same wall-approach sequence never produces a turn candidate or event when referenceLaneY is not configured", () => {
        let controller = runningControllerWithLockedTarget({ referenceLaneY: null });

        assert.equal(controller.diagnostics.turnDetectionAvailable, false);
        assert.equal(controller.diagnostics.turnDetectionUnavailableReason, "Turn detection unavailable: reference lane Y not configured.");

        controller = driveTurnApproach(controller);

        assert.equal(controller.chronosSession.events.filter((e) => e.type === "turn").length, 0);
        assert.equal(controller.eventAdapterState.confirmedDistanceMeters, 0);
        assert.equal(controller.detectorState.turnRecentSamples.length, 0); // detector never even called
    });
});

// ===========================================================================
// 11 / 12 — ONLY THE CONFIRMED TARGET REACHES A DETECTOR
// ===========================================================================

describe("racePipelineProcessPoseSample() — only confirmed target poses reach detectors", () => {
    test("while still TARGET_LOCKING (not yet confirmed), no sample ever reaches a detector", () => {
        let started = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG);
        let controller = started.controller;

        // Only 3 of the 5 required locking samples — status stays
        // TARGET_LOCKING, never reaches TARGET_LOCKED.
        for (let i = 0; i < 3; i++) {
            const result = racePipelineProcessPoseSample(controller, poseSample(i * 100), controller.generation);
            controller = result.controller;
        }

        assert.equal(controller.trackingSession.status, "TARGET_LOCKING");
        assert.deepEqual(controller.detectorState, racePipelineCreateDetectorState());
    });

    test("a spatially-distant intruder frame spliced into the stream is rejected by tracking continuity and never reaches a detector", () => {
        let controller = runningControllerWithLockedTarget();

        // A wildly different pose (simulating a different swimmer handed
        // to the single-pose pipeline for one frame) — far outside
        // maxSteadyStatePositionError from the locked target's projected
        // position.
        const intruderFrame = poseSample(2400, { hipX: 0.95, noseX: 0.95 });
        const intruderResult = racePipelineProcessPoseSample(controller, intruderFrame, controller.generation);

        assert.equal(intruderResult.controller.trackingSession.status, "TARGET_LOCKED"); // not lost outright on one bad frame
        const lastObservation = intruderResult.controller.trackingSession.observationHistory.slice(-1)[0];
        assert.equal(lastObservation.outcome, "ambiguous");
        assert.deepEqual(intruderResult.controller.detectorState, racePipelineCreateDetectorState()); // untouched

        // The legitimate target's own trajectory, immediately afterward,
        // is still accepted normally — no identity corruption occurred.
        const legitimateFrame = poseSample(3400, { hipX: 0.5, noseX: 0.5 });
        const legitimateResult = racePipelineProcessPoseSample(intruderResult.controller, legitimateFrame, intruderResult.controller.generation);
        assert.notEqual(legitimateResult.controller.trackingSession.observationHistory.slice(-1)[0].outcome, "ambiguous");
    });
});

// ===========================================================================
// 14 — RESET PREVENTS STALE CALLBACKS
// ===========================================================================

describe("racePipelineStopAnalysis() / generation handling — reset prevents stale callbacks", () => {
    test("a sample carrying a stale (superseded) generation is rejected and never touches the new session's state", () => {
        const firstRun = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG);
        const staleGeneration = firstRun.controller.generation;

        const stopped = racePipelineStopAnalysis(firstRun.controller);
        const secondRun = racePipelineStartAnalysis(stopped.controller, VALID_CONFIG);
        assert.equal(secondRun.ok, true);
        assert.notEqual(secondRun.controller.generation, staleGeneration);

        const beforeSnapshot = structuredClone({
            chronosSession: secondRun.controller.chronosSession,
            trackingSession: secondRun.controller.trackingSession,
            detectorState: secondRun.controller.detectorState,
            eventAdapterState: secondRun.controller.eventAdapterState
        });

        const staleResult = racePipelineProcessPoseSample(secondRun.controller, poseSample(0), staleGeneration);

        assert.equal(staleResult.processed, false);
        assert.equal(staleResult.reason, "stale-generation");
        assert.deepEqual(
            {
                chronosSession: staleResult.controller.chronosSession,
                trackingSession: staleResult.controller.trackingSession,
                detectorState: staleResult.controller.detectorState,
                eventAdapterState: staleResult.controller.eventAdapterState
            },
            beforeSnapshot
        );
    });

    test("stopping analysis discards session/detector/event-adapter state and returns to idle", () => {
        const started = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG);
        const stopped = racePipelineStopAnalysis(started.controller);

        assert.equal(stopped.controller.chronosSession, null);
        assert.equal(stopped.controller.trackingSession, null);
        assert.equal(stopped.controller.detectorState, null);
        assert.equal(stopped.controller.eventAdapterState, null);
        assert.equal(racePipelineControllerStatus(stopped.controller), "idle");
    });

    test("stopping a running session legally aborts the Chronos session (never called on an already-finished one)", () => {
        const started = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG);
        // status: "armed" — abortSession is legal from armed.
        assert.doesNotThrow(() => racePipelineStopAnalysis(started.controller));
    });
});

// ===========================================================================
// 15 / 16 — REPORT GENERATION
// ===========================================================================

describe("racePipelineBuildReport()", () => {
    test("an unfinished (running) session's report has finalTimeMs: null — never a fabricated time", () => {
        const controller = runningControllerWithLockedTarget();
        const result = racePipelineBuildReport(controller);

        assert.equal(result.ok, true);
        assert.equal(result.report.finalTimeMs, null);
        assert.equal(result.report.status, "running");
    });

    test("the report is produced through the real ChronosEngine.buildReport(), not reimplemented", () => {
        const controller = runningControllerWithLockedTarget();
        const viaController = racePipelineBuildReport(controller);
        const viaChronosDirectly = ChronosEngine.buildReport(controller.chronosSession);

        assert.deepEqual(viaController, viaChronosDirectly);
    });

    test("no active session produces a stable rejection rather than a crash or a fabricated report", () => {
        const controller = racePipelineCreateController();
        const result = racePipelineBuildReport(controller);

        assert.equal(result.ok, false);
        assert.equal(result.reason, "no-active-session");
        assert.equal(result.report, null);
    });
});

// ===========================================================================
// PURITY
// ===========================================================================

describe("controller purity", () => {
    test("no Date.now()/performance.now() access across a full start -> process -> stop workflow", () => {
        const originalDateNow = Date.now;
        const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

        Date.now = () => { throw new Error("controller.js must never call Date.now()"); };
        if (typeof performance !== "undefined") {
            performance.now = () => { throw new Error("controller.js must never call performance.now()"); };
        }

        try {
            let controller = racePipelineStartAnalysis(racePipelineCreateController(), VALID_CONFIG).controller;
            controller = racePipelineProcessPoseSample(controller, poseSample(0), controller.generation).controller;
            racePipelineBuildReport(controller);
            racePipelineStopAnalysis(controller);
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

describe("controller determinism", () => {
    test("identical inputs produce identical results across repeated calls", () => {
        const controller = runningControllerWithLockedTarget();
        const sample = poseSample(2400, { hipX: 0.45 });

        const first = racePipelineProcessPoseSample(controller, sample, controller.generation);
        const second = racePipelineProcessPoseSample(controller, sample, controller.generation);

        assert.deepEqual(first, second);
    });
});
