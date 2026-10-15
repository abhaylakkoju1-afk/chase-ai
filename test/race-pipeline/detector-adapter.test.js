// Unit tests for src/race-pipeline/detector-adapter.js.
//
// Every fixture below is a hand-built, synthetic targetPoseSample — never
// real video, never real MediaPipe/SwimmerTracking output. These tests
// use the REAL chronosDetectStart()/chronosDetectTurn() detector modules
// throughout (never mocked), per this stage's explicit instruction —
// several tests directly compare the adapter's output against a manual
// call into the same real detector function to prove the adapter adds no
// detection logic of its own.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineCreateDetectorState,
    racePipelineBuildStartDetectorSample,
    racePipelineBuildTurnDetectorSample,
    racePipelineDetectStartCandidate,
    racePipelineDetectTurnCandidate,
    START_DETECTOR_NAME,
    TURN_DETECTOR_NAME
} from "../../src/race-pipeline/detector-adapter.js";

import { chronosDetectStart, chronosAssessStart } from "../../src/chronos-engine/detectors/start-detector.js";
import { chronosDetectTurn } from "../../src/chronos-engine/detectors/turn-detector.js";

const REFERENCE_LANE_Y = 0.5;
const TURN_CONFIG = { referenceLaneY: REFERENCE_LANE_Y };

function landmark(x, y, visibility = 0.9) {
    return { x, y, visibility };
}

function targetPoseSample({ atMs, hasPose = true, hip = null, nose = null }) {
    return { atMs, hasPose, landmarks: hasPose ? { hip, nose } : null };
}

// ===========================================================================
// 1 / 3 — VALID TARGET POSE -> START DETECTOR INPUT, NOSE MAPPING
// ===========================================================================

describe("racePipelineBuildStartDetectorSample() — start detector input mapping", () => {
    test("a valid target pose maps to {atMs, nose} with x/y/visibility preserved exactly", () => {
        const sample = targetPoseSample({
            atMs: 1234,
            nose: landmark(0.51, 0.22, 0.83)
        });

        const built = racePipelineBuildStartDetectorSample(sample);

        assert.deepEqual(built, { atMs: 1234, nose: { x: 0.51, y: 0.22, visibility: 0.83 } });
    });

    test("nose mapping does not touch hip at all", () => {
        const sample = targetPoseSample({
            atMs: 1000,
            hip: landmark(0.3, 0.3, 0.9),
            nose: landmark(0.5, 0.2, 0.9)
        });

        const built = racePipelineBuildStartDetectorSample(sample);

        assert.deepEqual(Object.keys(built).sort(), ["atMs", "nose"]);
    });
});

// ===========================================================================
// 2 / 4 — VALID TARGET POSE -> TURN DETECTOR INPUT, HIP MAPPING
// ===========================================================================

describe("racePipelineBuildTurnDetectorSample() — turn detector input mapping", () => {
    test("a valid target pose maps to {atMs, hip, nose} with x/y/visibility preserved exactly", () => {
        const sample = targetPoseSample({
            atMs: 5000,
            hip: landmark(0.22, 0.55, 0.77),
            nose: landmark(0.5, 0.18, 0.91)
        });

        const built = racePipelineBuildTurnDetectorSample(sample);

        assert.deepEqual(built, {
            atMs: 5000,
            hip: { x: 0.22, y: 0.55, visibility: 0.77 },
            nose: { x: 0.5, y: 0.18, visibility: 0.91 }
        });
    });

    test("hip mapping carries the exact hip object, not a recomputed one", () => {
        const hip = landmark(0.4, 0.6, 0.5);
        const sample = targetPoseSample({ atMs: 5000, hip, nose: landmark(0.5, 0.2, 0.9) });

        const built = racePipelineBuildTurnDetectorSample(sample);

        assert.deepEqual(built.hip, hip);
    });
});

// ===========================================================================
// 5 — MISSING NOSE
// ===========================================================================

describe("detector adapter — missing nose", () => {
    test("start: a target pose with landmarks.nose null maps to {atMs, nose: null}, never a fabricated nose", () => {
        const sample = targetPoseSample({ atMs: 1000, nose: null });
        const built = racePipelineBuildStartDetectorSample(sample);
        assert.deepEqual(built, { atMs: 1000, nose: null });
    });

    test("start: a missing nose never produces a candidate, regardless of baseline", () => {
        const detectorState = racePipelineCreateDetectorState();
        const { candidate } = racePipelineDetectStartCandidate(
            targetPoseSample({ atMs: 1000, nose: null }),
            detectorState,
            {}
        );
        assert.equal(candidate, null);
    });

    test("turn: a target pose with landmarks.nose null maps to {atMs, hip, nose: null}", () => {
        const hip = landmark(0.2, 0.5, 0.9);
        const sample = targetPoseSample({ atMs: 1000, hip, nose: null });
        const built = racePipelineBuildTurnDetectorSample(sample);
        assert.deepEqual(built, { atMs: 1000, hip, nose: null });
    });
});

// ===========================================================================
// 6 — MISSING HIP
// ===========================================================================

describe("detector adapter — missing hip", () => {
    test("turn: a target pose with landmarks.hip null maps to {atMs, hip: null, nose}, never substituted", () => {
        const nose = landmark(0.5, 0.2, 0.9);
        const sample = targetPoseSample({ atMs: 1000, hip: null, nose });
        const built = racePipelineBuildTurnDetectorSample(sample);
        assert.deepEqual(built, { atMs: 1000, hip: null, nose });
    });

    test("turn: a missing hip never produces a candidate", () => {
        const detectorState = racePipelineCreateDetectorState();
        const { candidate } = racePipelineDetectTurnCandidate(
            targetPoseSample({ atMs: 1000, hip: null, nose: landmark(0.5, 0.2, 0.9) }),
            detectorState,
            TURN_CONFIG
        );
        assert.equal(candidate, null);
    });
});

// ===========================================================================
// 7 — MISSING POSE
// ===========================================================================

describe("detector adapter — missing pose", () => {
    test("hasPose:false (landmarks:null) maps to a structurally valid sample with null landmarks, never a fabricated one, since atMs is still known", () => {
        const sample = targetPoseSample({ atMs: 1000, hasPose: false });
        assert.deepEqual(racePipelineBuildStartDetectorSample(sample), { atMs: 1000, nose: null });
        assert.deepEqual(racePipelineBuildTurnDetectorSample(sample), { atMs: 1000, hip: null, nose: null });
    });

    test("hasPose:false never produces a candidate from either detector", () => {
        const detectorState = racePipelineCreateDetectorState();
        const sample = targetPoseSample({ atMs: 1000, hasPose: false });

        const startResult = racePipelineDetectStartCandidate(sample, detectorState, {});
        const turnResult = racePipelineDetectTurnCandidate(sample, detectorState, TURN_CONFIG);

        assert.equal(startResult.candidate, null);
        assert.equal(turnResult.candidate, null);
    });

    test("a completely missing targetPoseSample (null/undefined) never throws and never produces a candidate", () => {
        const detectorState = racePipelineCreateDetectorState();

        assert.doesNotThrow(() => racePipelineDetectStartCandidate(null, detectorState, {}));
        assert.doesNotThrow(() => racePipelineDetectTurnCandidate(undefined, detectorState, TURN_CONFIG));

        const startResult = racePipelineDetectStartCandidate(null, detectorState, {});
        const turnResult = racePipelineDetectTurnCandidate(undefined, detectorState, TURN_CONFIG);

        assert.equal(startResult.candidate, null);
        assert.equal(turnResult.candidate, null);
    });

    test("a missing targetPoseSample does not mutate detectorState (nothing meaningful to record)", () => {
        const detectorState = racePipelineCreateDetectorState();
        const { detectorState: nextState } = racePipelineDetectStartCandidate(null, detectorState, {});
        assert.deepEqual(nextState, detectorState);
    });
});

// ===========================================================================
// 8 / 9 / 10 / 11 / 12 — TIMESTAMP, CANDIDATE PROPAGATION, IDENTITY,
// CONFIDENCE, EVIDENCE
// ===========================================================================

function fiveSampleBaselineState(x = 0.5) {
    let detectorState = racePipelineCreateDetectorState();
    for (let i = 0; i < 5; i++) {
        const sample = targetPoseSample({ atMs: i * 100, nose: landmark(x, 0.5, 0.9) });
        ({ detectorState } = racePipelineDetectStartCandidate(sample, detectorState, {}));
    }
    return detectorState;
}

describe("detector adapter — candidate propagation, identity, confidence, evidence, timestamp", () => {
    test("start: a SUSTAINED departure after a real baseline produces a candidate with atMs/confidence/evidence/detector", () => {
        // Chronos reliability phase 1: one displaced sample is no longer enough
        // (it is only a "plausible" departure); the departure must persist
        // for confirmationSamples (3) samples. The candidate carries the
        // ONSET (first departing sample), and exposes when it was confirmed.
        const detectorState = fiveSampleBaselineState();
        const departing = [500, 600, 700].map((atMs) => targetPoseSample({ atMs, nose: landmark(0.65, 0.5, 0.9) }));

        const first = racePipelineDetectStartCandidate(departing[0], detectorState, {});
        assert.equal(first.candidate, null);
        assert.equal(first.assessment.state, "plausible");
        const second = racePipelineDetectStartCandidate(departing[1], first.detectorState, {});
        assert.equal(second.candidate, null);
        assert.equal(second.assessment.state, "plausible");

        const { candidate, assessment } = racePipelineDetectStartCandidate(departing[2], second.detectorState, {});

        assert.notEqual(candidate, null);
        assert.equal(assessment.state, "confirmed");
        assert.equal(candidate.atMs, 500); // the onset sample's timestamp, preserved exactly, not recomputed
        assert.equal(candidate.evidence.onsetAtMs, 500);
        assert.equal(candidate.evidence.confirmedAtMs, 700);
        assert.equal(typeof candidate.confidence, "number");
        assert.equal(typeof candidate.evidence, "object");
        assert.equal(candidate.detector, START_DETECTOR_NAME);
    });

    test("start: confidence and evidence exactly match a direct chronosAssessStart() call with the same inputs", () => {
        let detectorState = fiveSampleBaselineState();
        for (const atMs of [500, 600]) {
            ({ detectorState } = racePipelineDetectStartCandidate(targetPoseSample({ atMs, nose: landmark(0.65, 0.5, 0.9) }), detectorState, {}));
        }
        const sample = targetPoseSample({ atMs: 700, nose: landmark(0.65, 0.5, 0.9) });

        const { candidate } = racePipelineDetectStartCandidate(sample, detectorState, {});
        const direct = chronosAssessStart({
            sample: { atMs: 700, nose: { x: 0.65, y: 0.5, visibility: 0.9 } },
            baselineWindow: detectorState.startBaselineWindow
        });

        assert.notEqual(direct.candidate, null);
        assert.equal(candidate.confidence, direct.candidate.confidence);
        assert.deepEqual(candidate.evidence, direct.candidate.evidence);
        assert.equal(candidate.atMs, direct.candidate.atMs);
    });

    test("start: the candidate's displacement evidence is the chronosDetectStart() primitive's, evaluated against the stationary reference", () => {
        let detectorState = fiveSampleBaselineState();
        for (const atMs of [500, 600]) {
            ({ detectorState } = racePipelineDetectStartCandidate(targetPoseSample({ atMs, nose: landmark(0.65, 0.5, 0.9) }), detectorState, {}));
        }
        const { candidate } = racePipelineDetectStartCandidate(targetPoseSample({ atMs: 700, nose: landmark(0.65, 0.5, 0.9) }), detectorState, {});

        const stationary = detectorState.startBaselineWindow.slice(0, 5);
        const primitive = chronosDetectStart({ sample: { atMs: 700, nose: { x: 0.65, y: 0.5, visibility: 0.9 } }, baselineWindow: stationary });

        assert.equal(candidate.evidence.displacement, primitive.evidence.displacement);
        assert.equal(candidate.evidence.baselinePositionX, primitive.evidence.baselinePositionX);
        assert.equal(candidate.evidence.baselineSampleCount, primitive.evidence.baselineSampleCount);
    });

    test("turn: a qualifying sample produces a candidate with atMs/confidence/evidence/detector", () => {
        let detectorState = racePipelineCreateDetectorState();
        const prior = targetPoseSample({ atMs: 0, hip: landmark(0.3, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
        ({ detectorState } = racePipelineDetectTurnCandidate(prior, detectorState, TURN_CONFIG));

        const current = targetPoseSample({ atMs: 1000, hip: landmark(0.2, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
        const { candidate } = racePipelineDetectTurnCandidate(current, detectorState, TURN_CONFIG);

        assert.notEqual(candidate, null);
        assert.equal(candidate.atMs, 1000);
        assert.equal(typeof candidate.confidence, "number");
        assert.equal(typeof candidate.evidence, "object");
        assert.equal(candidate.detector, TURN_DETECTOR_NAME);
    });

    test("turn: confidence and evidence exactly match a direct chronosDetectTurn() call with the same inputs", () => {
        let detectorState = racePipelineCreateDetectorState();
        const prior = targetPoseSample({ atMs: 0, hip: landmark(0.3, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
        ({ detectorState } = racePipelineDetectTurnCandidate(prior, detectorState, TURN_CONFIG));

        const current = targetPoseSample({ atMs: 1000, hip: landmark(0.2, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
        const { candidate } = racePipelineDetectTurnCandidate(current, detectorState, TURN_CONFIG);

        const direct = chronosDetectTurn({
            sample: { atMs: 1000, hip: { x: 0.2, y: 0.5, visibility: 0.9 }, nose: { x: 0.5, y: 0.5, visibility: 0.9 } },
            recentSamples: [{ atMs: 0, hip: { x: 0.3, y: 0.5, visibility: 0.9 }, nose: { x: 0.5, y: 0.5, visibility: 0.9 } }],
            previousCandidateAtMs: null,
            config: TURN_CONFIG
        });

        assert.equal(candidate.confidence, direct.confidence);
        assert.deepEqual(candidate.evidence, direct.evidence);
    });
});

// ===========================================================================
// 13 — NO INVENTED CANDIDATE
// ===========================================================================

describe("detector adapter — no invented candidate", () => {
    test("start: a non-qualifying (stationary) sample never produces a candidate", () => {
        const detectorState = fiveSampleBaselineState();
        const sample = targetPoseSample({ atMs: 500, nose: landmark(0.505, 0.5, 0.9) }); // displacement 0.005

        const { candidate } = racePipelineDetectStartCandidate(sample, detectorState, {});
        assert.equal(candidate, null);
    });

    test("turn: a sample nowhere near a wall never produces a candidate", () => {
        let detectorState = racePipelineCreateDetectorState();
        const prior = targetPoseSample({ atMs: 0, hip: landmark(0.5, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
        ({ detectorState } = racePipelineDetectTurnCandidate(prior, detectorState, TURN_CONFIG));

        const current = targetPoseSample({ atMs: 1000, hip: landmark(0.5, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
        const { candidate } = racePipelineDetectTurnCandidate(current, detectorState, TURN_CONFIG);

        assert.equal(candidate, null);
    });
});

// ===========================================================================
// 14 — NO DETECTOR-LOGIC DUPLICATION
// ===========================================================================

describe("detector adapter — no detector-logic duplication", () => {
    test("a full sequence run through the adapter matches the same sequence run directly against chronosAssessStart(), sample by sample", () => {
        const samples = [
            targetPoseSample({ atMs: 0, nose: landmark(0.5, 0.5, 0.9) }),
            targetPoseSample({ atMs: 100, nose: landmark(0.5, 0.5, 0.9) }),
            targetPoseSample({ atMs: 200, nose: landmark(0.5, 0.5, 0.9) }),
            targetPoseSample({ atMs: 300, nose: landmark(0.5, 0.5, 0.9) }),
            targetPoseSample({ atMs: 400, nose: landmark(0.5, 0.5, 0.9) }),
            targetPoseSample({ atMs: 500, nose: landmark(0.65, 0.5, 0.9) }), // sustained departure begins
            targetPoseSample({ atMs: 600, nose: landmark(0.66, 0.5, 0.9) }),
            targetPoseSample({ atMs: 700, nose: landmark(0.67, 0.5, 0.9) })
        ];

        let detectorState = racePipelineCreateDetectorState();
        let manualBaseline = [];
        let lastAdapterCandidate = null;
        let lastDirect = null;

        for (const sample of samples) {
            const built = racePipelineBuildStartDetectorSample(sample);
            const direct = chronosAssessStart({ sample: built, baselineWindow: manualBaseline });
            const { candidate, detectorState: nextState, assessment } = racePipelineDetectStartCandidate(sample, detectorState, {});

            // sample by sample: identical state and reason, not just the final answer
            assert.equal(assessment.state, direct.state);
            assert.equal(assessment.reason, direct.reason);

            lastDirect = direct;
            lastAdapterCandidate = candidate;
            detectorState = nextState;
            manualBaseline = [...manualBaseline, built];
        }

        assert.notEqual(lastDirect.candidate, null);
        assert.notEqual(lastAdapterCandidate, null);
        assert.equal(lastAdapterCandidate.atMs, lastDirect.candidate.atMs);
        assert.equal(lastAdapterCandidate.confidence, lastDirect.candidate.confidence);
        assert.deepEqual(lastAdapterCandidate.evidence, lastDirect.candidate.evidence);
    });

    test("turn: a full sequence run through the adapter matches the same sequence run directly against chronosDetectTurn()", () => {
        const hipTrajectory = [
            [0, 0.3],
            [100, 0.24],
            [200, 0.23]
        ];

        let detectorState = racePipelineCreateDetectorState();
        let manualRecentSamples = [];
        let manualPreviousCandidateAtMs = null;
        let lastAdapterCandidate = null;
        let lastDirectCandidate = null;

        for (const [atMs, hipX] of hipTrajectory) {
            const sample = targetPoseSample({ atMs, hip: landmark(hipX, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
            const built = racePipelineBuildTurnDetectorSample(sample);

            const direct = chronosDetectTurn({
                sample: built,
                recentSamples: manualRecentSamples,
                previousCandidateAtMs: manualPreviousCandidateAtMs,
                config: TURN_CONFIG
            });

            const { candidate, detectorState: nextState } = racePipelineDetectTurnCandidate(sample, detectorState, TURN_CONFIG);

            lastDirectCandidate = direct;
            lastAdapterCandidate = candidate;
            detectorState = nextState;
            manualRecentSamples = [...manualRecentSamples, built];
            if (direct) {
                manualPreviousCandidateAtMs = direct.atMs;
            }
        }

        assert.notEqual(lastDirectCandidate, null);
        assert.deepEqual(lastAdapterCandidate, { ...lastDirectCandidate, detector: TURN_DETECTOR_NAME });
    });
});

// ===========================================================================
// 15 — DETERMINISTIC REPEATED CALLS
// ===========================================================================

describe("detector adapter — deterministic repeated calls", () => {
    test("start: identical inputs (same sample, same detectorState) produce identical output across repeated calls", () => {
        const detectorState = fiveSampleBaselineState();
        const sample = targetPoseSample({ atMs: 500, nose: landmark(0.65, 0.5, 0.9) });

        const first = racePipelineDetectStartCandidate(sample, detectorState, {});
        const second = racePipelineDetectStartCandidate(sample, detectorState, {});

        assert.deepEqual(first, second);
    });

    test("turn: identical inputs produce identical output across repeated calls", () => {
        let detectorState = racePipelineCreateDetectorState();
        const prior = targetPoseSample({ atMs: 0, hip: landmark(0.3, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
        ({ detectorState } = racePipelineDetectTurnCandidate(prior, detectorState, TURN_CONFIG));

        const current = targetPoseSample({ atMs: 1000, hip: landmark(0.2, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });

        const first = racePipelineDetectTurnCandidate(current, detectorState, TURN_CONFIG);
        const second = racePipelineDetectTurnCandidate(current, detectorState, TURN_CONFIG);

        assert.deepEqual(first, second);
    });
});

// ===========================================================================
// 16 — NO CROSS-RACE STATE LEAKAGE
// ===========================================================================

describe("detector adapter — no cross-race state leakage", () => {
    test("two independently-created detectorState objects never affect one another", () => {
        const stateA = racePipelineCreateDetectorState();
        const stateB = racePipelineCreateDetectorState();

        const sampleA = targetPoseSample({ atMs: 0, nose: landmark(0.9, 0.5, 0.9) });
        const { detectorState: nextA } = racePipelineDetectStartCandidate(sampleA, stateA, {});

        // stateB (and its snapshot) must be completely unaffected by activity on stateA.
        assert.deepEqual(stateB, racePipelineCreateDetectorState());
        assert.notDeepEqual(nextA, stateB);
    });

    test("a fresh racePipelineCreateDetectorState() call is always independent of any previously mutated state", () => {
        let usedState = racePipelineCreateDetectorState();
        for (let i = 0; i < 5; i++) {
            const sample = targetPoseSample({ atMs: i * 100, nose: landmark(0.5, 0.5, 0.9) });
            ({ detectorState: usedState } = racePipelineDetectStartCandidate(sample, usedState, {}));
        }

        const freshState = racePipelineCreateDetectorState();

        assert.deepEqual(freshState, { startBaselineWindow: [], turnRecentSamples: [], turnPreviousCandidateAtMs: null });
        assert.notDeepEqual(usedState, freshState);
    });

    test("the original detectorState object passed in is never mutated in place", () => {
        const detectorState = racePipelineCreateDetectorState();
        const snapshot = structuredClone(detectorState);
        const sample = targetPoseSample({ atMs: 0, nose: landmark(0.9, 0.5, 0.9) });

        racePipelineDetectStartCandidate(sample, detectorState, {});

        assert.deepEqual(detectorState, snapshot);
    });
});

// ===========================================================================
// PURITY: NO CLOCK / DOM ACCESS
// ===========================================================================

describe("detector adapter — purity", () => {
    test("no Date.now()/performance.now() access across a full detector-adapter workflow", () => {
        const originalDateNow = Date.now;
        const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

        Date.now = () => { throw new Error("detector-adapter.js must never call Date.now()"); };
        if (typeof performance !== "undefined") {
            performance.now = () => { throw new Error("detector-adapter.js must never call performance.now()"); };
        }

        try {
            let detectorState = racePipelineCreateDetectorState();
            const startSample = targetPoseSample({ atMs: 0, nose: landmark(0.5, 0.5, 0.9) });
            ({ detectorState } = racePipelineDetectStartCandidate(startSample, detectorState, {}));

            const turnSampleA = targetPoseSample({ atMs: 0, hip: landmark(0.3, 0.5, 0.9), nose: landmark(0.5, 0.5, 0.9) });
            ({ detectorState } = racePipelineDetectTurnCandidate(turnSampleA, detectorState, TURN_CONFIG));
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
