// Unit tests for src/chronos-engine/detectors/turn-detector.js.
//
// Every fixture below is a hand-built, synthetic landmark sample — never
// real video, never real MediaPipe output. This detector's own file
// header explains why its defaults (wallThreshold/laneDeviationThreshold
// are legacy-inspired; velocityThreshold and detectorSuppressionMs are
// fresh placeholders with no honest legacy equivalent) are provisional,
// not validated thresholds; these tests lock in current behavior for
// those defaults, they do not assert the defaults are correct.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosDetectTurn } from "../../../src/chronos-engine/detectors/turn-detector.js";

const REFERENCE_LANE_Y = 0.5;

function turnSample(atMs, hipX, { noseY = REFERENCE_LANE_Y, hipVisibility = 0.9, noseVisibility = 0.9 } = {}) {
  return {
    atMs,
    hip: { x: hipX, y: 0.5, visibility: hipVisibility },
    nose: { x: 0.5, y: noseY, visibility: noseVisibility }
  };
}

function priorHip(atMs, hipX, visibility = 0.9) {
  return { atMs, hip: { x: hipX, y: 0.5, visibility } };
}

const BASE_CONFIG = { referenceLaneY: REFERENCE_LANE_Y };

describe("chronosDetectTurn() — clean signal", () => {
  test("wall approach + slowdown near the LEFT edge (right-to-left travel) produces a candidate", () => {
    const recentSamples = [priorHip(0, 0.30)];
    const sample = turnSample(1000, 0.20); // velocity = |0.20-0.30|/1s = 0.10/s < 0.12 threshold; 0.20 < wallThreshold 0.25

    const result = chronosDetectTurn({ sample, recentSamples, previousCandidateAtMs: null, config: BASE_CONFIG });

    assert.notEqual(result, null);
    assert.equal(result.atMs, 1000);
    assert.equal(result.evidence.wallSide, "near-zero");
    assert.ok(result.confidence > 0 && result.confidence <= 1);
  });

  test("left-to-right trajectory reaching the RIGHT edge produces a candidate", () => {
    const recentSamples = [priorHip(0, 0.70)];
    const sample = turnSample(1000, 0.79); // velocity = 0.09/s < 0.12; 0.79 > 1-0.25=0.75

    const result = chronosDetectTurn({ sample, recentSamples, previousCandidateAtMs: null, config: BASE_CONFIG });

    assert.notEqual(result, null);
    assert.equal(result.evidence.wallSide, "near-one");
  });

  test("right-to-left trajectory reaching the LEFT edge produces a candidate", () => {
    const recentSamples = [priorHip(0, 0.33)];
    const sample = turnSample(1000, 0.23); // velocity = 0.10/s < 0.12; 0.23 < 0.25

    const result = chronosDetectTurn({ sample, recentSamples, previousCandidateAtMs: null, config: BASE_CONFIG });

    assert.notEqual(result, null);
    assert.equal(result.evidence.wallSide, "near-zero");
  });
});

describe("chronosDetectTurn() — hard gates", () => {
  test("insufficient wall proximity (hip far from either edge) returns null", () => {
    const recentSamples = [priorHip(0, 0.52)];
    const sample = turnSample(1000, 0.50); // slow, but nowhere near a wall

    assert.equal(chronosDetectTurn({ sample, recentSamples, config: BASE_CONFIG }), null);
  });

  test("velocity above threshold returns null even when near a wall", () => {
    const recentSamples = [priorHip(0, 0.05)];
    const sample = turnSample(1000, 0.20); // velocity = 0.15/s > 0.12 threshold

    assert.equal(chronosDetectTurn({ sample, recentSamples, config: BASE_CONFIG }), null);
  });

  test("lane deviation beyond threshold returns null", () => {
    const recentSamples = [priorHip(0, 0.30)];
    const sample = turnSample(1000, 0.20, { noseY: 0.80 }); // deviation 0.30 > 0.20 threshold

    assert.equal(chronosDetectTurn({ sample, recentSamples, config: BASE_CONFIG }), null);
  });

  test("low hip visibility returns null", () => {
    const recentSamples = [priorHip(0, 0.30)];
    const sample = turnSample(1000, 0.20, { hipVisibility: 0.3 });

    assert.equal(chronosDetectTurn({ sample, recentSamples, config: BASE_CONFIG }), null);
  });

  test("low nose visibility returns null", () => {
    const recentSamples = [priorHip(0, 0.30)];
    const sample = turnSample(1000, 0.20, { noseVisibility: 0.3 });

    assert.equal(chronosDetectTurn({ sample, recentSamples, config: BASE_CONFIG }), null);
  });

  test("a missing referenceLaneY in config returns null — there is no default", () => {
    const recentSamples = [priorHip(0, 0.30)];
    const sample = turnSample(1000, 0.20);

    assert.equal(chronosDetectTurn({ sample, recentSamples, config: {} }), null);
  });
});

describe("chronosDetectTurn() — malformed/invalid input handling", () => {
  test("a missing sample returns null, not a throw", () => {
    assert.doesNotThrow(() => chronosDetectTurn({ recentSamples: [priorHip(0, 0.3)], config: BASE_CONFIG }));
    assert.equal(chronosDetectTurn({ recentSamples: [priorHip(0, 0.3)], config: BASE_CONFIG }), null);
  });

  test("a sample missing the hip landmark returns null", () => {
    const result = chronosDetectTurn({
      sample: { atMs: 1000, nose: { x: 0.5, y: 0.5, visibility: 0.9 } },
      recentSamples: [priorHip(0, 0.3)],
      config: BASE_CONFIG
    });
    assert.equal(result, null);
  });

  test("a sample missing the nose landmark returns null", () => {
    const result = chronosDetectTurn({
      sample: { atMs: 1000, hip: { x: 0.2, y: 0.5, visibility: 0.9 } },
      recentSamples: [priorHip(0, 0.3)],
      config: BASE_CONFIG
    });
    assert.equal(result, null);
  });

  test("a non-finite hip.x returns null", () => {
    const result = chronosDetectTurn({
      sample: turnSample(1000, NaN),
      recentSamples: [priorHip(0, 0.3)],
      config: BASE_CONFIG
    });
    assert.equal(result, null);
  });

  test("no usable prior sample (empty recentSamples) returns null — insufficient history, not a throw", () => {
    assert.equal(chronosDetectTurn({ sample: turnSample(1000, 0.2), recentSamples: [], config: BASE_CONFIG }), null);
    assert.doesNotThrow(() => chronosDetectTurn({ sample: turnSample(1000, 0.2), config: BASE_CONFIG }));
  });

  test("a prior sample with low visibility is excluded, not used, from velocity calculation", () => {
    const recentSamples = [priorHip(0, 0.30, 0.2)]; // below minVisibility — excluded
    const sample = turnSample(1000, 0.20);

    assert.equal(chronosDetectTurn({ sample, recentSamples, config: BASE_CONFIG }), null);
  });
});

describe("chronosDetectTurn() — detector-local suppression (independent of Chronos's 2500ms rule)", () => {
  test("repeated qualifying frames around one physical wall contact produce exactly one candidate when previousCandidateAtMs is correctly threaded", () => {
    let previousCandidateAtMs = null;
    let candidateCount = 0;
    const hipTrajectory = [
      [0, 0.30],
      [100, 0.24],
      [200, 0.23],
      [300, 0.235],
      [400, 0.24]
    ];

    for (let i = 1; i < hipTrajectory.length; i++) {
      const recentSamples = [priorHip(hipTrajectory[i - 1][0], hipTrajectory[i - 1][1])];
      const [atMs, hipX] = hipTrajectory[i];
      const result = chronosDetectTurn({
        sample: turnSample(atMs, hipX),
        recentSamples,
        previousCandidateAtMs,
        config: BASE_CONFIG
      });

      if (result !== null) {
        candidateCount++;
        previousCandidateAtMs = result.atMs;
      }
    }

    assert.equal(candidateCount, 1);
  });

  // Note: recentSamples below is deliberately spaced CLOSE to the current
  // sample (100ms, small delta -> low velocity) so the velocity gate
  // always passes — these tests isolate the suppression gate specifically
  // from previousCandidateAtMs, which is a wholly separate time reference
  // the detector never conflates with the velocity window.

  test("suppression boundary: exactly detectorSuppressionMs since the previous candidate is ACCEPTED", () => {
    const recentSamples = [priorHip(400, 0.21)];
    const sample = turnSample(500, 0.20); // gap from previousCandidateAtMs(0) is exactly 500ms

    const result = chronosDetectTurn({
      sample,
      recentSamples,
      previousCandidateAtMs: 0,
      config: BASE_CONFIG // default detectorSuppressionMs: 500
    });

    assert.notEqual(result, null);
  });

  test("suppression boundary: 1ms less than detectorSuppressionMs is REJECTED", () => {
    const recentSamples = [priorHip(399, 0.21)];
    const sample = turnSample(499, 0.20); // gap from previousCandidateAtMs(0) is 499ms

    const result = chronosDetectTurn({
      sample,
      recentSamples,
      previousCandidateAtMs: 0,
      config: BASE_CONFIG
    });

    assert.equal(result, null);
  });

  test("two distinct physical candidates well inside Chronos's 2500ms gap rule may BOTH be proposed by the detector", () => {
    // 600ms apart: more than the default 500ms detectorSuppressionMs, but
    // less than Chronos's separate, larger MIN_EVENT_GAP_MS (2500ms) —
    // proving the detector has no coupling to that constant at all.
    const first = chronosDetectTurn({
      sample: turnSample(1000, 0.20),
      recentSamples: [priorHip(0, 0.30)],
      previousCandidateAtMs: null,
      config: BASE_CONFIG
    });
    assert.notEqual(first, null);

    const second = chronosDetectTurn({
      sample: turnSample(1600, 0.79),
      recentSamples: [priorHip(600, 0.70)],
      previousCandidateAtMs: first.atMs,
      config: BASE_CONFIG
    });
    assert.notEqual(second, null);
  });

  test("a gap of exactly Chronos's 2500ms is accepted under the default 500ms suppression window — the two constants are unrelated", () => {
    const result = chronosDetectTurn({
      sample: turnSample(2500, 0.20),
      recentSamples: [priorHip(2400, 0.21)],
      previousCandidateAtMs: 0,
      config: BASE_CONFIG
    });
    assert.notEqual(result, null);
  });

  test("the SAME exactly-2500ms gap is rejected if detectorSuppressionMs is independently configured larger than 2500 — proving no hardcoded coupling to Chronos's constant", () => {
    const result = chronosDetectTurn({
      sample: turnSample(2500, 0.20),
      recentSamples: [priorHip(2400, 0.21)],
      previousCandidateAtMs: 0,
      config: { ...BASE_CONFIG, detectorSuppressionMs: 3000 }
    });
    assert.equal(result, null);
  });

  test("previousCandidateAtMs of null/undefined applies no suppression at all", () => {
    const recentSamples = [priorHip(999900, 0.21)];
    const sample = turnSample(1000000, 0.20);

    const withNull = chronosDetectTurn({ sample, recentSamples, previousCandidateAtMs: null, config: BASE_CONFIG });
    const withUndefined = chronosDetectTurn({ sample, recentSamples, config: BASE_CONFIG });

    assert.notEqual(withNull, null);
    assert.notEqual(withUndefined, null);
  });
});

describe("chronosDetectTurn() — time-normalized velocity", () => {
  test("equivalent physical speed sampled at different intervals produces the same computed velocity", () => {
    // Scenario A: 0.10 normalized-x units covered in 1000ms -> 0.10/s
    const resultA = chronosDetectTurn({
      sample: turnSample(1000, 0.20),
      recentSamples: [priorHip(0, 0.30)],
      config: BASE_CONFIG
    });

    // Scenario B: the SAME 0.10/s physical speed, but sampled over a
    // much shorter 500ms window (0.05 units covered, starting slightly
    // closer to the wall so the endpoint still clears the wallThreshold
    // gate) — a naive raw, un-normalized frame-to-frame delta (the
    // legacy bug) would report 0.05 here and 0.10 in scenario A: two
    // different numbers for identical physical speed. The
    // time-normalized calculation must report the same velocity in both.
    const resultB = chronosDetectTurn({
      sample: turnSample(500, 0.24),
      recentSamples: [priorHip(0, 0.29)],
      config: BASE_CONFIG
    });

    assert.notEqual(resultA, null);
    assert.notEqual(resultB, null);
    assert.equal(resultA.evidence.velocityPerSecond, resultB.evidence.velocityPerSecond);
    assert.equal(Math.round(resultA.evidence.velocityPerSecond * 100) / 100, 0.10);

    // The raw, un-normalized deltas WOULD have differed (0.10 vs 0.05) —
    // explicitly confirming this is not merely coincidentally equal.
    assert.notEqual(Math.abs(0.20 - 0.30), Math.abs(0.24 - 0.29));
  });
});

describe("chronosDetectTurn() — determinism and purity", () => {
  test("identical inputs produce identical output across repeated calls", () => {
    const recentSamples = [priorHip(0, 0.30)];
    const sample = turnSample(1000, 0.20);

    const first = chronosDetectTurn({ sample, recentSamples, previousCandidateAtMs: null, config: BASE_CONFIG });
    const second = chronosDetectTurn({ sample, recentSamples, previousCandidateAtMs: null, config: BASE_CONFIG });

    assert.deepEqual(first, second);
  });

  test("confidence is always within [0, 1] across a spread of fixtures", () => {
    const fixtures = [
      [0.24, 0.20],
      [0.70, 0.79],
      [0.05, 0.245],
      [0.30, 0.249]
    ];

    for (const [priorX, currentX] of fixtures) {
      const result = chronosDetectTurn({
        sample: turnSample(1000, currentX),
        recentSamples: [priorHip(0, priorX)],
        config: BASE_CONFIG
      });
      if (result !== null) {
        assert.ok(result.confidence >= 0 && result.confidence <= 1, `confidence out of range for ${priorX}->${currentX}`);
      }
    }
  });

  test("evidence exposes wall/velocity/visibility/lane signals", () => {
    const result = chronosDetectTurn({
      sample: turnSample(1000, 0.20),
      recentSamples: [priorHip(0, 0.30)],
      config: BASE_CONFIG
    });

    assert.notEqual(result, null);
    assert.equal(typeof result.evidence.hipX, "number");
    assert.equal(typeof result.evidence.wallSide, "string");
    assert.equal(typeof result.evidence.velocityPerSecond, "number");
    assert.equal(typeof result.evidence.laneDeviation, "number");
    assert.equal(typeof result.evidence.visibility, "number");
    assert.equal(typeof result.evidence.wallProximityScore, "number");
    assert.equal(typeof result.evidence.velocityDropScore, "number");
    assert.equal(typeof result.evidence.laneAgreementScore, "number");
  });

  test("no hidden mutable state leaks between unrelated calls", () => {
    const qualifying = chronosDetectTurn({
      sample: turnSample(1000, 0.20),
      recentSamples: [priorHip(0, 0.30)],
      config: BASE_CONFIG
    });
    const nonQualifying = chronosDetectTurn({
      sample: turnSample(2000, 0.50), // nowhere near a wall
      recentSamples: [priorHip(1900, 0.50)],
      config: BASE_CONFIG
    });

    assert.notEqual(qualifying, null);
    assert.equal(nonQualifying, null);
  });

  test("passing a plain config object is never mutated by the call", () => {
    const config = { ...BASE_CONFIG, velocityThreshold: 0.2 };
    const configSnapshot = { ...config };

    chronosDetectTurn({ sample: turnSample(1000, 0.20), recentSamples: [priorHip(0, 0.30)], config });

    assert.deepEqual(config, configSnapshot);
  });
});
