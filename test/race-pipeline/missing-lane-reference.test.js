// A missing lane reference must not leave distance "confirmed" (Chronos
// reliability, phase 3B), THROUGH THE CONTROLLER.
//
// Turn detection needs a lane reference. Without one the controller never runs the
// turn detector, so no turn is proposed and the gap / lane-gate / outside-zone
// safeguards never run. For a race with intermediate turns that made the pipeline
// blind to turns it requires while the session still said "confirmed" ("no
// concealed turn suspected"), and a manual finish then produced a comparable PB
// (phase 3A audit). Now, once the race has an accepted start, an absent reference
// with a required turn outstanding marks distance UNCONFIRMED from the accepted
// start (reason "turn-detection-unavailable-no-lane-reference"), through the
// existing mark and with the existing first-record-kept behavior.
//
// A one-length race (25 m in a 25 m pool, 50 m in a 50 m pool) has no required
// turn and is unchanged. Manual events are still accepted; they cannot restore
// confidence and cannot make the race PB-comparable. This does NOT change what
// "confirmed" means elsewhere: it still does not guarantee a complete turn history
// (the F1/F2 questions are out of scope here).
//
// ALL DATA IS SYNTHETIC with explicit ground truth from
// test/race-pipeline/synthetic-race.js. Passing proves the pipeline's logic and
// invariants on these inputs; it is not real-world validation of anything.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePath,
    sampleRace,
    raceConfig,
    runRace,
    driveRace,
    freshRaceController,
    poseSample
} from "./synthetic-race.js";

import {
    DISTANCE_NO_LANE_REFERENCE_REASON,
    DISTANCE_AMBIGUITY_REASON,
    DISTANCE_ANALYSIS_ENDED_REASON,
    DISTANCE_LANE_GATE_REASON,
    racePipelineStartAnalysis,
    racePipelineCreateController,
    racePipelineProcessPoseSample,
    racePipelineEndAnalysis
} from "../../src/race-pipeline/controller.js";
import { racePipelineSubmitTurnCandidate } from "../../src/race-pipeline/event-adapter.js";
import { racePipelineMapClickToNormalizedPoint, racePipelineBuildRaceConfig } from "../../src/race-pipeline/race-config.js";
import { ChronosEngine } from "../../src/chronos-engine/index.js";

const path100 = racePath({ lengths: 4 }); // 100 m in a 25 m pool: walls 25/50/75 are turns, the 4th is the finish
const samples100 = sampleRace(path100);
const wall = (i) => path100.turns[i].arrivalMs;

// A race config with the lane reference null, omitted, or a value.
function config(reference, overrides = {}) {
    const c = { ...raceConfig({ distanceMeters: 100 }), ...overrides };
    if (reference === "OMIT") delete c.referenceLaneY;
    else c.referenceLaneY = reference;
    return c;
}

// Drives sample by sample; records the first sample at which a start was accepted and the first at which a
// confidence record existed.
function observe(cfg, samples) {
    let controller = freshRaceController(cfg);
    let startedAtSample = null;
    let markedAtSample = null;
    let turnsBeforeMark = 0;
    for (const sample of samples) {
        controller = driveRace(controller, [sample]).controller;
        const session = controller.chronosSession;
        if (startedAtSample === null && session.events.some((e) => e.type === "start")) startedAtSample = sample.atMs;
        if (markedAtSample === null && session.distanceConfidence) {
            markedAtSample = sample.atMs;
            turnsBeforeMark = session.events.filter((e) => e.type === "turn").length;
        }
    }
    return { controller, startedAtSample, markedAtSample, turnsBeforeMark };
}

const nullRace = observe(config(null), samples100);
const reportOf = (controller) => ChronosEngine.buildReport(controller.chronosSession).report;
const pbFor = (report) => ({ event: report.event, course: report.course, time: "1:30.00", history: [] });

function manualFinish(session, atMs = path100.finishArrivalMs, distanceMeters = 100) {
    return ChronosEngine.recordEvent(session, { type: "finish", atMs, distanceMeters, source: "manual" });
}

// ===========================================================================
// 1-3. THE MARK: WHEN, WITH WHAT
// ===========================================================================

describe("a multi-length race with no lane reference is marked unconfirmed from the accepted start", () => {
    test("null: marked, and at the SAME frame at which the start is accepted", () => {
        const confidence = nullRace.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.state, "unconfirmed");
        assert.equal(confidence.reason, "turn-detection-unavailable-no-lane-reference");
        assert.equal(nullRace.startedAtSample !== null, true);
        assert.equal(nullRace.markedAtSample, nullRace.startedAtSample);
    });

    test("an OMITTED reference behaves identically to null", () => {
        const omitted = observe(config("OMIT"), samples100);
        assert.equal(omitted.controller.config.referenceLaneY, null);
        assert.deepEqual(omitted.controller.chronosSession.distanceConfidence, nullRace.controller.chronosSession.distanceConfidence);
        assert.deepEqual(reportOf(omitted.controller), reportOf(nullRace.controller));
        assert.equal(omitted.markedAtSample, nullRace.markedAtSample);
    });

    test("reason, timestamp and evidence are correct, and the diagnostics and report agree", () => {
        const session = nullRace.controller.chronosSession;
        const start = session.events.find((e) => e.type === "start");
        assert.equal(DISTANCE_NO_LANE_REFERENCE_REASON, "turn-detection-unavailable-no-lane-reference");
        assert.deepEqual(session.distanceConfidence, {
            state: "unconfirmed",
            reason: DISTANCE_NO_LANE_REFERENCE_REASON,
            sinceAtMs: start.atMs,                 // the accepted start (the estimated motion onset)
            resumedAtMs: null,
            evidence: {
                trigger: "no-reference-lane-y",
                turnDetectionAvailable: false,
                sinceBasis: "start",
                confirmedDistanceMeters: 0,
                requiredTurns: 3,
                requiredTurnsKnown: true
            }
        });
        assert.deepEqual(nullRace.controller.diagnostics.distanceConfidence, {
            state: "unconfirmed", reason: DISTANCE_NO_LANE_REFERENCE_REASON, sinceAtMs: start.atMs, resumedAtMs: null
        });
        assert.equal(nullRace.controller.diagnostics.turnDetectionAvailable, false);

        const report = reportOf(nullRace.controller);
        assert.deepEqual(report.distanceConfidence, { state: "unconfirmed", reason: DISTANCE_NO_LANE_REFERENCE_REASON, sinceAtMs: start.atMs, resumedAtMs: null });
        assert.ok(report.dataQuality.notes.some((n) => n.includes("distance progression unconfirmed") && n.includes(DISTANCE_NO_LANE_REFERENCE_REASON)));
    });

    test("not before the start: while the session is armed (and when no start is ever accepted) nothing is marked", () => {
        // Pre-start frames only: stationary swimmer, no departure.
        const stationary = [];
        for (let t = 0; t <= 20000; t += 120) stationary.push(poseSample(t, 0.1));
        const result = observe(config(null), stationary);
        assert.equal(result.controller.chronosSession.status, "armed");
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.markedAtSample, null);
        // A clip that ends (end of stream) before any start also marks nothing.
        const ended = racePipelineEndAnalysis(result.controller);
        assert.equal(ended.marked, false);
        assert.equal(ended.controller.chronosSession.distanceConfidence, null);
    });
});

// ===========================================================================
// 4-5. NO DEPENDENT TURN; REPORT AND PB
// ===========================================================================

describe("no dependent trusted turn is accepted, and the result is not PB-comparable", () => {
    test("no turn exists before the mark (none can: the mark is made on the frame that accepts the start)", () => {
        assert.equal(nullRace.turnsBeforeMark, 0);
        assert.deepEqual(nullRace.controller.chronosSession.events.map((e) => e.type), ["start"]);
    });

    test("a detector-sourced turn, split or finish is refused by Chronos and by the event adapter; nothing advances the counter", () => {
        const session = nullRace.controller.chronosSession;
        for (const type of ["turn", "split", "finish"]) {
            const result = ChronosEngine.recordEvent(session, { type, atMs: wall(0), distanceMeters: 25, source: "detector", detector: "turn-detector-v1", confidence: 0.9 });
            assert.equal(result.ok, false, type);
            assert.equal(result.reason, "distance-progression-unconfirmed", type);
        }
        const candidate = { atMs: wall(0), confidence: 0.9, detector: "turn-detector-v1", evidence: { confirmedAtMs: wall(0) + 400, wallSide: "near-one" } };
        const submitted = racePipelineSubmitTurnCandidate(session, candidate, nullRace.controller.eventAdapterState);
        assert.equal(submitted.ok, false);
        assert.equal(submitted.reason, "distance-progression-unconfirmed");
        assert.equal(submitted.eventAdapterState.confirmedDistanceMeters, 0);
    });

    test("the report exposes the state, and after a finish the PB comparison refuses it - with an existing PB and with none", () => {
        const finished = manualFinish(nullRace.controller.chronosSession);
        assert.equal(finished.ok, true);
        const report = ChronosEngine.buildReport(finished.session).report;
        assert.equal(report.distanceConfidence.state, "unconfirmed");
        assert.equal(report.confirmedDistanceMeters, 0);
        assert.ok(Number.isFinite(report.finalTimeMs), "the recorded time itself is untouched");

        for (const pb of [pbFor(report), null]) {
            const comparison = ChronosEngine.comparePB(report, pb);
            assert.equal(comparison.comparable, false);
            assert.equal(comparison.reason, "distance-unconfirmed");
            assert.equal(comparison.isNewPb, false);
        }
    });
});

// ===========================================================================
// 6-8. WHAT IS NOT MARKED
// ===========================================================================

describe("races that must keep their existing behavior", () => {
    test("a valid lane reference is untouched: three trusted turns, confidence never set, PB comparable after a finish", () => {
        const valid = observe(config(0.5), samples100);
        assert.equal(valid.controller.chronosSession.distanceConfidence, null);
        assert.equal(valid.markedAtSample, null);
        assert.deepEqual(valid.controller.chronosSession.events.filter((e) => e.type === "turn").map((e) => e.distanceMeters), [25, 50, 75]);
        const finished = manualFinish(valid.controller.chronosSession);
        const report = ChronosEngine.buildReport(finished.session).report;
        assert.equal(report.distanceConfidence.state, "confirmed");
        assert.equal(ChronosEngine.comparePB(report, pbFor(report)).comparable, true);
    });

    for (const [label, poolLengthMeters, distanceMeters] of [["25 m race in a 25 m pool", 25, 25], ["50 m race in a 50 m pool", 50, 50]]) {
        test(`one-length race (${label}) with no reference is NOT newly marked, and its PB behavior is unchanged`, () => {
            const path = racePath({ lengths: 1, poolLengthMeters });
            const cfg = config(null, { ...raceConfig({ poolLengthMeters, distanceMeters }) });
            delete cfg.referenceLaneY;
            const result = observe(cfg, sampleRace(path));
            assert.equal(result.controller.chronosSession.status, "running");
            assert.equal(result.controller.chronosSession.distanceConfidence, null);
            assert.equal(result.markedAtSample, null);
            const finished = manualFinish(result.controller.chronosSession, path.finishArrivalMs, distanceMeters);
            const report = ChronosEngine.buildReport(finished.session).report;
            assert.equal(report.distanceConfidence.state, "confirmed");
            assert.equal(ChronosEngine.comparePB(report, pbFor(report)).comparable, true);
        });
    }

    test("an uncountable configuration fails closed: unknown, non-multiple or sub-pool distance is marked, with requiredTurnsKnown false", () => {
        for (const [label, overrides] of [
            ["distance unknown (null)", { distanceMeters: null }],
            ["distance not a multiple of the pool", { distanceMeters: 60 }],
            ["distance shorter than the pool", { distanceMeters: 10 }]
        ]) {
            const result = observe(config(null, overrides), samples100);
            const confidence = result.controller.chronosSession.distanceConfidence;
            assert.ok(confidence, label);
            assert.equal(confidence.reason, DISTANCE_NO_LANE_REFERENCE_REASON, label);
            assert.equal(confidence.evidence.requiredTurnsKnown, false, label);
            assert.equal(confidence.evidence.requiredTurns, null, label);
        }
    });
});

// ===========================================================================
// 9-11. IDEMPOTENT; FIRST RECORD KEPT; CONFIDENCE NEVER RESTORED
// ===========================================================================

describe("first record kept, idempotent, never restored", () => {
    test("the record never changes over the rest of the race, a repeat of the same frames, or end of stream", () => {
        const recordAtMark = JSON.stringify(nullRace.controller.chronosSession.distanceConfidence);
        const replayed = driveRace(nullRace.controller, samples100.slice(40)).controller; // frames fed again (after the start)
        const ended = racePipelineEndAnalysis(replayed);
        assert.equal(JSON.stringify(replayed.chronosSession.distanceConfidence), recordAtMark);
        assert.equal(JSON.stringify(ended.controller.chronosSession.distanceConfidence), recordAtMark);
        // A direct second mark through Chronos keeps the first record too.
        const again = ChronosEngine.markDistanceUnconfirmed(replayed.chronosSession, { reason: "something-else", sinceAtMs: replayed.chronosSession.events[0].atMs + 5000 });
        assert.equal(again.ok, true);
        assert.equal(again.alreadyUnconfirmed, true);
        assert.equal(JSON.stringify(again.session.distanceConfidence), recordAtMark);
    });

    test("terminal tracking degradation LATER in a no-reference race does not replace it", () => {
        const dropFrom = wall(0) - 3000;
        const degraded = observe(config(null), sampleRace(path100, { dropouts: [[dropFrom, 1e9]], endMs: dropFrom + 9000 }));
        assert.equal(degraded.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.equal(degraded.controller.chronosSession.distanceConfidence.reason, DISTANCE_NO_LANE_REFERENCE_REASON);
        assert.equal(degraded.controller.chronosSession.distanceConfidence.sinceAtMs, nullRace.controller.chronosSession.distanceConfidence.sinceAtMs);
    });

    // An EARLIER record of another kind: the other rules need a lane reference to produce one, so these runs begin
    // with a valid reference. Once the record exists the live controller's reference is forced to null (an ARTIFICIAL
    // state, reachable through no real API) so the missing-reference rule is evaluated on every later frame.
    const driftSamples = (y) => sampleRace(path100).map((s) => (s.hasPose
        ? poseSample(s.atMs, s.landmarks.hip.x, { y, face: s.landmarks.nose.x > s.landmarks.hip.x ? 1 : -1 })
        : s));
    for (const [label, expectedReason, samples] of [
        ["observation-gap rule", DISTANCE_AMBIGUITY_REASON, sampleRace(path100, { dropouts: [[wall(0) - 360, wall(0) + 240]] })],
        ["terminal tracking degradation", DISTANCE_ANALYSIS_ENDED_REASON, sampleRace(path100, { dropouts: [[wall(0) - 3000, 1e9]], endMs: wall(0) + 6000 })],
        ["lane-gate refusal", DISTANCE_LANE_GATE_REASON, driftSamples(0.85)]
    ]) {
        test(`an earlier record from the ${label} is preserved byte-for-byte when the reference is (artificially) absent afterwards`, () => {
            let controller = freshRaceController(config(0.5));
            let before = null;
            let forced = false;
            for (const sample of samples) {
                controller = driveRace(controller, [sample]).controller;
                if (!forced && controller.chronosSession.distanceConfidence) {
                    before = JSON.stringify(controller.chronosSession.distanceConfidence);
                    controller = { ...controller, config: { ...controller.config, referenceLaneY: null } };
                    forced = true;
                }
            }
            assert.equal(forced, true, "the earlier rule produced its record");
            assert.equal(controller.chronosSession.distanceConfidence.reason, expectedReason);
            assert.equal(JSON.stringify(controller.chronosSession.distanceConfidence), before);
        });
    }

    test("manual events and later observations cannot restore confirmed distance", () => {
        // Manual turns and a manual finish: accepted, but the state stays unconfirmed.
        let session = nullRace.controller.chronosSession;
        for (const [i, distance] of [25, 50, 75].entries()) {
            const manual = ChronosEngine.recordEvent(session, { type: "turn", atMs: wall(i), distanceMeters: distance, source: "manual" });
            assert.equal(manual.ok, true, `manual turn ${distance} m`);
            session = manual.session;
        }
        const finished = manualFinish(session);
        assert.equal(finished.ok, true);
        const report = ChronosEngine.buildReport(finished.session).report;
        assert.equal(report.distanceConfidence.state, "unconfirmed");
        assert.equal(report.distanceConfidence.reason, DISTANCE_NO_LANE_REFERENCE_REASON);
        assert.equal(report.confirmedDistanceMeters, 0, "events a person recorded after the mark are assertions, not pipeline-established distance");
        const comparison = ChronosEngine.comparePB(report, pbFor(report));
        assert.equal(comparison.comparable, false);
        assert.equal(comparison.reason, "distance-unconfirmed");
        // And a later pipeline frame leaves the record alone.
        const next = racePipelineProcessPoseSample({ ...nullRace.controller, chronosSession: finished.session }, poseSample(path100.endMs + 120, 0.94), nullRace.controller.generation);
        assert.equal(next.controller.chronosSession.distanceConfidence.state, "unconfirmed");
    });
});

// ===========================================================================
// 12-14. NOTHING FABRICATED; START UNTOUCHED
// ===========================================================================

describe("nothing is fabricated and the start is untouched", () => {
    test("no turn, split, finish, time or distance appears from the mark itself", () => {
        const controller = nullRace.controller;
        const report = reportOf(controller);
        assert.deepEqual(controller.chronosSession.events.map((e) => e.type), ["start"]);
        assert.deepEqual(report.splits, []);
        assert.equal(report.finish, null);
        assert.equal(report.finalTimeMs, null);
        assert.equal(controller.chronosSession.status, "running");
        assert.equal(controller.eventAdapterState.confirmedDistanceMeters, 0);
        assert.deepEqual(controller.diagnostics.unconfirmedTurnObservations, []);
        assert.equal(controller.config.referenceLaneY, null, "no lane position was substituted");
    });

    test("the accepted start event is identical to the one a valid-reference run produces (start detection does not depend on the reference)", () => {
        const withReference = runRace({ config: config(0.5), samples: samples100 });
        const without = runRace({ config: config(null), samples: samples100 });
        assert.deepEqual(without.start, withReference.start);
        assert.equal(without.start.type, "start");
        assert.equal(without.controller.diagnostics.lastStartAssessment.state, "confirmed");
        assert.deepEqual(without.controller.diagnostics.lastStartAssessment, withReference.controller.diagnostics.lastStartAssessment);
    });

    test("a missing reference never starts, stops or alters the analysis otherwise: same tracking, same start frame, the config carries the pre-start reference", () => {
        const started = racePipelineStartAnalysis(racePipelineCreateController(), config(null));
        assert.equal(started.ok, true);
        assert.equal(started.controller.chronosSession.distanceConfidence, null, "nothing is marked at creation, before a start exists");
        assert.equal(started.controller.config.startReferenceMs, 3000);
        assert.equal(nullRace.controller.trackingSession.status, "TARGET_LOCKED");
    });
});

// ===========================================================================
// THE PHASE 3A REFERENCE, LATE CALIBRATION, AND INVALID VALUES
// ===========================================================================

// The same swimmer path held at one vertical position (the nose y the lane gate compares).
function samplesAtLane(y) {
    return sampleRace(path100).map((s) => (s.hasPose
        ? poseSample(s.atMs, s.landmarks.hip.x, { y, face: s.landmarks.nose.x > s.landmarks.hip.x ? 1 : -1 })
        : s));
}

describe("a reference made by the phase 3A click mapping is consumed, and the safeguard stays out of its way", () => {
    const native = { width: 1280, height: 720 };
    const box = { width: 700, height: 700 * 720 / 1280 };
    const selection = { eventValue: "Freestyle 100m", courseValue: "Short Course", poolLengthMetersValue: 25, startReferenceMs: 3000 };

    // Where the source-frame fraction (fx, fy) is drawn in `box`, then exactly what the click handler passes.
    function calibrate(fx, fy) {
        return racePipelineMapClickToNormalizedPoint({
            clickX: fx * box.width, clickY: fy * box.height,
            containerWidth: box.width, containerHeight: box.height,
            videoNativeWidth: native.width, videoNativeHeight: native.height
        });
    }

    for (const lane of [0.5, 0.62, 0.3]) {
        test(`a click at ${lane} of the frame height gives referenceLaneY ${lane}; turn detection runs and the race is NOT marked`, () => {
            const point = calibrate(0.5, lane);
            assert.notEqual(point, null);
            const built = racePipelineBuildRaceConfig({ ...selection, calibrationPoint: point });
            assert.ok(Math.abs(built.referenceLaneY - lane) < 1e-12, `built reference ${built.referenceLaneY}`);

            const result = runRace({ config: { ...built }, samples: samplesAtLane(lane) });
            assert.equal(result.controller.diagnostics.turnDetectionAvailable, true);
            assert.deepEqual(result.turns.map((turn) => turn.distanceMeters), [25, 50, 75]);
            assert.equal(result.controller.chronosSession.distanceConfidence, null);
        });
    }

    test("a rejected click gives no reference, the builder reports the calibration as missing, and the page never starts - the safeguard is for direct callers only", () => {
        const outside = calibrate(0.5, 1.5);
        assert.equal(outside, null);
        const built = racePipelineBuildRaceConfig({ ...selection, calibrationPoint: outside });
        assert.equal(built.referenceLaneY, null);
    });
});

describe("late calibration cannot restore trust, and a new analysis is unaffected", () => {
    test("ARTIFICIAL (no public API changes a live controller's reference): a valid reference appearing after the mark changes neither the record nor the outcome", () => {
        let controller = freshRaceController(config(null));
        let before = null;
        let appeared = false;
        const refused = [];
        for (const sample of samples100) {
            controller = driveRace(controller, [sample]).controller;
            if (!appeared && controller.chronosSession.distanceConfidence) {
                before = JSON.stringify(controller.chronosSession.distanceConfidence);
                controller = { ...controller, config: { ...controller.config, referenceLaneY: 0.5 } };   // the "late calibration"
                appeared = true;
            }
            if (controller.diagnostics.lastEvent && controller.diagnostics.lastEvent.kind === "turn") refused.push(controller.diagnostics.lastEvent.reason);
        }
        assert.equal(appeared, true);
        assert.equal(JSON.stringify(controller.chronosSession.distanceConfidence), before, "the first record is unchanged");
        assert.equal(controller.chronosSession.distanceConfidence.reason, DISTANCE_NO_LANE_REFERENCE_REASON);
        // Turn detection DID run after the reference appeared (the swimmer's walls were seen), yet nothing was trusted.
        assert.ok(controller.diagnostics.unconfirmedTurnObservations.length > 0, "turn candidates were seen after the late reference");
        assert.ok(refused.length > 0 && refused.every((reason) => reason === "distance-progression-unconfirmed"), refused.join(","));
        assert.deepEqual(controller.chronosSession.events.map((e) => e.type), ["start"]);
        assert.equal(controller.eventAdapterState.confirmedDistanceMeters, 0);
        const report = ChronosEngine.buildReport(controller.chronosSession).report;
        assert.equal(report.distanceConfidence.state, "unconfirmed");
        assert.equal(report.confirmedDistanceMeters, 0);
    });

    test("a NEW analysis started with a valid reference after a no-reference race starts fresh and trusted, and does not change the earlier controller", () => {
        const earlier = observe(config(null), samples100).controller;
        const earlierRecord = JSON.stringify(earlier.chronosSession.distanceConfidence);
        const fresh = runRace({ config: config(0.5), samples: samples100 });
        assert.equal(fresh.controller.chronosSession.distanceConfidence, null);
        assert.deepEqual(fresh.turns.map((turn) => turn.distanceMeters), [25, 50, 75]);
        assert.equal(JSON.stringify(earlier.chronosSession.distanceConfidence), earlierRecord);
    });
});

describe("invalid references follow the established validation contract and are never treated as absent", () => {
    test("non-finite, non-numeric and out-of-range values are refused at start with invalid-reference-lane-y: no session exists, so nothing can be marked or trusted", () => {
        for (const bad of [NaN, Infinity, -Infinity, "0.5", 1.1, -0.1, 5, {}, true]) {
            const result = racePipelineStartAnalysis(racePipelineCreateController(), config(bad));
            assert.equal(result.ok, false, String(bad));
            assert.equal(result.reason, "invalid-reference-lane-y", String(bad));
            assert.equal(result.controller.chronosSession, null, String(bad));
        }
    });

    test("the boundaries 0 and 1 are valid references (not absent): turn detection is available and nothing is marked at the start", () => {
        for (const edge of [0, 1]) {
            const started = racePipelineStartAnalysis(racePipelineCreateController(), config(edge));
            assert.equal(started.ok, true, String(edge));
            assert.equal(started.controller.diagnostics.turnDetectionAvailable, true);
            const afterStart = observe(config(edge), samples100.slice(0, 80));
            assert.equal(afterStart.controller.chronosSession.status, "running");
            assert.equal(afterStart.controller.chronosSession.distanceConfidence, null, String(edge));
        }
    });
});

// ===========================================================================
// A START RECORDED OUTSIDE THE CONTROLLER, AND A RECORD THAT ALREADY EXISTS
// ===========================================================================
//
// The controller normally accepts the start itself, and the mark is then made on that very frame. A caller can
// also drive Chronos directly (ChronosEngine.recordEvent / markDistanceUnconfirmed) and hand the session to the
// controller. These tests build that state the way such a caller would: they compose the controller object with
// the session the public Chronos API returned.

describe("a caller-made start and a caller-made record are respected", () => {
    function controllerWithManualStart() {
        const controller = freshRaceController(config(null));
        const started = ChronosEngine.recordEvent(controller.chronosSession, { type: "start", atMs: 5000, source: "manual" });
        assert.equal(started.ok, true);
        return { ...controller, chronosSession: started.session };
    }

    test("a start recorded outside the controller is marked from THAT start on the first processed frame, whether or not the frame has a pose", () => {
        for (const frame of [samples100[0], { atMs: 120, hasPose: false, landmarks: null }]) {
            const result = racePipelineProcessPoseSample(controllerWithManualStart(), frame, 1);
            const confidence = result.controller.chronosSession.distanceConfidence;
            assert.ok(confidence, `hasPose=${frame.hasPose}`);
            assert.equal(confidence.reason, DISTANCE_NO_LANE_REFERENCE_REASON);
            assert.equal(confidence.sinceAtMs, 5000, "the caller's start time, not the frame's");
            assert.equal(result.controller.diagnostics.distanceConfidence.reason, DISTANCE_NO_LANE_REFERENCE_REASON);
        }
    });

    test("a record the caller already made through Chronos is kept: the session keeps it AND the diagnostics do not claim the missing-reference reason", () => {
        let controller = controllerWithManualStart();
        const marked = ChronosEngine.markDistanceUnconfirmed(controller.chronosSession, { reason: "caller-marked", sinceAtMs: 5200 });
        assert.equal(marked.ok, true);
        controller = { ...controller, chronosSession: marked.session };
        const before = JSON.stringify(controller.chronosSession.distanceConfidence);

        controller = racePipelineProcessPoseSample(controller, samples100[0], 1).controller;
        controller = racePipelineProcessPoseSample(controller, { atMs: 240, hasPose: false, landmarks: null }, 1).controller;

        assert.equal(JSON.stringify(controller.chronosSession.distanceConfidence), before, "the caller's record is the first record");
        assert.equal(controller.chronosSession.distanceConfidence.reason, "caller-marked");
        // The controller only mirrors marks it makes itself; it must not report one it did not make.
        assert.notEqual(controller.diagnostics.distanceConfidence.reason, DISTANCE_NO_LANE_REFERENCE_REASON);
    });
});
