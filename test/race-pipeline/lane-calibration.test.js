// Lane-Y calibration and the lane gate (Chronos reliability, phase 3).
//
// WHAT IS UNDER TEST. `referenceLaneY` is a normalized frame position: the
// vertical position (fraction of the frame height, 0 = top edge, 1 = bottom edge)
// of the point the user clicked on the swimmer. The turn assessment compares the
// swimmer's NOSE y at a complete wall reversal's apex with it and refuses the
// reversal when |nose.y - referenceLaneY| > 0.20 (a provisional threshold); the
// controller then marks distance unconfirmed (phase 2D, covered in
// lane-gate-confidence.test.js and not repeated here).
//
// What phase 3 changed: the controller used to accept ANY finite referenceLaneY.
// A value just outside the frame (for example 1.1) is not a position in the
// frame, yet it made the gate PERMISSIVE for a swimmer near the frame edge
// (|0.95 - 1.1| = 0.15 <= 0.20), while values far outside refused everything. Now
// a reference outside [0, 1] is refused at start with `invalid-reference-lane-y`.
// (The UI's calibration builder already produced null for such a click.)
//
// ALL DATA IS SYNTHETIC: a constant-lane swimmer on the deterministic 100 m path
// of synthetic-race.js, with explicit ground truth for each wall. Passing proves
// the gate's logic and its conservative outcome on these inputs. It does NOT
// establish that a real swimmer's nose height or a real click corresponds to
// anything, that 0.20 is a good threshold, or any real-world accuracy; wall
// position and frame-width-to-metres scale are not calibrated by any of this.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePath,
    sampleRace,
    raceConfig,
    runRace,
    poseSample,
    seededRandom
} from "./synthetic-race.js";

import {
    racePipelineCreateController,
    racePipelineStartAnalysis,
    DISTANCE_LANE_GATE_REASON,
    TURN_DETECTION_UNAVAILABLE_REASON
} from "../../src/race-pipeline/controller.js";
import {
    racePipelineBuildRaceConfig,
    racePipelineDescribeMissingConfigFields
} from "../../src/race-pipeline/race-config.js";
import { TURN_ASSESSMENT_DEFAULTS } from "../../src/chronos-engine/detectors/turn-detector.js";

const path100 = racePath({ lengths: 4 }); // walls 25/50/75 m are turns; the 4th wall is the finish
const THRESHOLD = TURN_ASSESSMENT_DEFAULTS.laneDeviationThreshold;

// The same swimmer path, held at one vertical position the whole race.
function constantLaneSamples(y) {
    return sampleRace(path100).map((s) => (s.hasPose
        ? poseSample(s.atMs, s.landmarks.hip.x, { y, face: s.landmarks.nose.x > s.landmarks.hip.x ? 1 : -1 })
        : s));
}

function startWith(referenceLaneY, overrides = {}) {
    const config = { ...raceConfig({ distanceMeters: 100, referenceLaneY }), ...overrides };
    if (referenceLaneY === undefined) delete config.referenceLaneY; // raceConfig() defaults an undefined argument to 0.5
    return racePipelineStartAnalysis(racePipelineCreateController(), config);
}

function raceWith(referenceLaneY, swimmerY) {
    return runRace({ config: raceConfig({ distanceMeters: 100, referenceLaneY }), samples: constantLaneSamples(swimmerY) });
}

// A trusted turn is correct if it carries the right label at (about) the true wall time.
function trustedTurnsAreCorrect(result) {
    return result.turns.every((turn, i) => (
        turn.distanceMeters === path100.turns[i].distanceMeters
        && Math.abs(turn.atMs - path100.turns[i].arrivalMs) <= 400
    ));
}

// ===========================================================================
// 1. THE REFERENCE IS VALIDATED AGAINST THE FRAME, NOT JUST FOR FINITENESS
// ===========================================================================

describe("referenceLaneY validation at the controller", () => {
    test("a finite value outside the frame [0, 1] is refused at start; no session or state is created", () => {
        for (const bad of [-0.1, -1e-9, 1 + 1e-9, 1.1, 1.14, 2, 5, -50]) {
            const result = startWith(bad);
            assert.equal(result.ok, false, String(bad));
            assert.equal(result.reason, "invalid-reference-lane-y", String(bad));
            assert.equal(result.controller.chronosSession, null, String(bad));
            assert.equal(result.controller.trackingSession, null, String(bad));
            assert.equal(result.controller.blockedReason, "invalid-reference-lane-y", String(bad));
        }
    });

    test("non-finite and non-numeric values are refused, never coerced", () => {
        for (const bad of [NaN, Infinity, -Infinity, "0.5", "", {}, [], [0.5], true, false]) {
            const result = startWith(bad);
            assert.equal(result.ok, false, String(bad));
            assert.equal(result.reason, "invalid-reference-lane-y", String(bad));
        }
    });

    test("the frame edges and interior are valid, and are stored exactly as given", () => {
        for (const good of [0, 1, 0.5, 0.0001, 0.9999, 0.42]) {
            const result = startWith(good);
            assert.equal(result.ok, true, String(good));
            assert.equal(result.controller.config.referenceLaneY, good);
            assert.equal(result.controller.diagnostics.turnDetectionAvailable, true);
            assert.equal(result.controller.diagnostics.turnDetectionUnavailableReason, null);
        }
    });

    test("an ABSENT reference is explicit: turn detection is unavailable for the race with its stable reason, and no lane position is substituted", () => {
        for (const absent of [null, undefined]) {
            const result = startWith(absent);
            assert.equal(result.ok, true);
            assert.equal(result.controller.config.referenceLaneY, null);
            assert.equal(result.controller.diagnostics.turnDetectionAvailable, false);
            assert.equal(result.controller.diagnostics.turnDetectionUnavailableReason, TURN_DETECTION_UNAVAILABLE_REASON);
        }
    });

    test("BEFORE/AFTER: a reference of 1.1 used to be accepted and to admit a swimmer at the bottom edge (|0.95 - 1.1| = 0.15), trusting three turns; now nothing starts", () => {
        const refused = startWith(1.1);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, "invalid-reference-lane-y");
        // The in-frame equivalent of the same swimmer (reference at the swimmer's lane) is the control:
        // it is the legitimate way to get these three trusted turns.
        const control = raceWith(0.95, 0.95);
        assert.deepEqual(control.turns.map((t) => t.distanceMeters), [25, 50, 75]);
    });

    test("the reference and the pre-start reference stay coupled at the controller: neither a bad lane nor a missing pre-start frame produces a running analysis", () => {
        const missingStart = startWith(0.5, { startReferenceMs: null });
        assert.equal(missingStart.ok, false);
        assert.equal(missingStart.reason, "missing-start-reference");

        const badLaneGoodStart = startWith(1.1, { startReferenceMs: 3000 });
        assert.equal(badLaneGoodStart.ok, false);
        assert.equal(badLaneGoodStart.reason, "invalid-reference-lane-y");

        const both = startWith(0.5, { startReferenceMs: 3000 });
        assert.equal(both.ok, true);
        assert.equal(both.controller.config.startReferenceMs, 3000);
        assert.equal(both.controller.config.referenceLaneY, 0.5);
    });
});

// ===========================================================================
// 2. ONE CALIBRATION CLICK -> BOTH VALUES, TOGETHER OR NOT AT ALL (config layer)
// ===========================================================================

describe("one calibration click yields the lane reference and the pre-start reference together, or neither", () => {
    const selection = { eventValue: "Freestyle 100m", courseValue: "Short Course", poolLengthMetersValue: 25 };

    test("a valid click and a readable pre-start time both reach the config the controller starts from", () => {
        const config = racePipelineBuildRaceConfig({ ...selection, calibrationPoint: { x: 0.3, y: 0.62 }, startReferenceMs: 4000 });
        assert.equal(config.referenceLaneY, 0.62);
        assert.equal(config.startReferenceMs, 4000);
        assert.deepEqual(racePipelineDescribeMissingConfigFields(config), []);

        const started = racePipelineStartAnalysis(racePipelineCreateController(), { ...config, calibrationPoint: { x: 0.3, y: 0.62 } });
        assert.equal(started.ok, true);
        assert.equal(started.controller.config.referenceLaneY, 0.62);
        assert.equal(started.controller.config.startReferenceMs, 4000);
    });

    test("a click outside the frame (no valid lane position) with a valid pre-start time is one missing calibration, not a half-set one; nothing is clamped", () => {
        for (const y of [-0.01, 1.01, NaN]) {
            const config = racePipelineBuildRaceConfig({ ...selection, calibrationPoint: { x: 0.5, y }, startReferenceMs: 4000 });
            assert.equal(config.referenceLaneY, null, String(y));
            assert.deepEqual(racePipelineDescribeMissingConfigFields(config), ["lane calibration"], String(y));
        }
    });
});

// ===========================================================================
// 3. THE GATE, THROUGH THE REAL CONTROLLER (constant-lane synthetic swimmers)
// ===========================================================================

describe("the lane gate follows the calibrated lane, wherever it is in the frame", () => {
    test("CONTROL: reference equal to the swimmer's lane, at several frame positions, trusts the three turns correctly with confidence untouched", () => {
        for (const y of [0.05, 0.3, 0.5, 0.7, 0.95]) {
            const result = raceWith(y, y);
            assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75], `lane ${y}`);
            assert.ok(trustedTurnsAreCorrect(result), `lane ${y}`);
            assert.equal(result.controller.chronosSession.distanceConfidence, null, `lane ${y}`);
            assert.equal(result.controller.diagnostics.lastTurnAssessment.reason === "lane-deviation", false, `lane ${y}`);
        }
    });

    test("a swimmer inside the threshold of the reference (0.19 either side, at the frame edges too) is accepted", () => {
        for (const [reference, swimmer] of [[0.5, 0.69], [0.5, 0.31], [0.19, 0.0], [0.81, 1.0], [0.0, 0.19], [1.0, 0.81]]) {
            const result = raceWith(reference, swimmer);
            assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75], `ref ${reference} swimmer ${swimmer}`);
            assert.equal(result.controller.chronosSession.distanceConfidence, null, `ref ${reference} swimmer ${swimmer}`);
        }
    });

    test("a swimmer beyond the threshold (0.21 either side, at the frame edges too) is refused AND distance is marked unconfirmed from the apex", () => {
        for (const [reference, swimmer] of [[0.5, 0.71], [0.5, 0.29], [0.21, 0.0], [0.79, 1.0], [0.0, 0.21], [1.0, 0.79]]) {
            const result = raceWith(reference, swimmer);
            const confidence = result.controller.chronosSession.distanceConfidence;
            assert.deepEqual(result.turns, [], `ref ${reference} swimmer ${swimmer}: no turn is trusted`);
            assert.equal(confidence.state, "unconfirmed", `ref ${reference} swimmer ${swimmer}`);
            assert.equal(confidence.reason, DISTANCE_LANE_GATE_REASON, `ref ${reference} swimmer ${swimmer}`);
            assert.ok(confidence.evidence.laneDeviation > THRESHOLD, `ref ${reference} swimmer ${swimmer}`);
            assert.equal(result.report.distanceConfidence.state, "unconfirmed");
        }
    });

    test("SEEDED SWEEP: for random in-frame reference/lane pairs, a poor calibration NEVER yields a wrong trusted label - it either matches ground truth or is refused and unconfirmed", () => {
        const random = seededRandom(20260314);
        let accepted = 0;
        let refused = 0;
        for (let i = 0; i < 60; i += 1) {
            const reference = Math.round(random() * 1000) / 1000;
            const swimmer = Math.round(random() * 1000) / 1000;
            const deviation = Math.abs(swimmer - reference);
            if (Math.abs(deviation - THRESHOLD) < 0.005) continue; // keep clear of the (float) boundary itself

            const result = raceWith(reference, swimmer);
            const confidence = result.controller.chronosSession.distanceConfidence;
            const label = `ref ${reference} swimmer ${swimmer} (|dev| ${deviation.toFixed(3)})`;
            assert.ok(trustedTurnsAreCorrect(result), label);
            if (deviation < THRESHOLD) {
                accepted += 1;
                assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75], label);
                assert.equal(confidence, null, label);
            } else {
                refused += 1;
                assert.deepEqual(result.turns, [], label);
                assert.equal(confidence.state, "unconfirmed", label);
                assert.equal(confidence.reason, DISTANCE_LANE_GATE_REASON, label);
            }
        }
        // The sweep must have exercised both outcomes, or it proves nothing.
        assert.ok(accepted >= 10 && refused >= 10, `accepted ${accepted}, refused ${refused}`);
    });

    test("LIMITATION: the gate cannot tell an approximate calibration from an exact one - a reference 0.19 off is accepted exactly like a perfect one", () => {
        const exact = raceWith(0.5, 0.5);
        const approximate = raceWith(0.5, 0.69);
        assert.deepEqual(approximate.turns.map((t) => [t.distanceMeters, t.atMs]), exact.turns.map((t) => [t.distanceMeters, t.atMs]));
        assert.equal(approximate.controller.chronosSession.distanceConfidence, null);
    });
});
