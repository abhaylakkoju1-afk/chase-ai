// Unit tests for src/chronos-engine/detectors/start-detector.js.
//
// Every fixture below is a hand-built, synthetic landmark sample — never
// real video, never real MediaPipe output. This detector's own file
// header explains why its defaults (e.g. displacementThreshold: 0.08)
// are legacy-inspired starting points, not validated thresholds; these
// tests lock in the detector's CURRENT behavior for those defaults, they
// do not assert the defaults are scientifically correct.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosDetectStart } from "../../../src/chronos-engine/detectors/start-detector.js";

function noseSample(atMs, x, visibility = 0.9) {
  return { atMs, nose: { x, y: 0.5, visibility } };
}

function stableBaseline({ count = 5, x = 0.5, visibility = 0.9, startAtMs = 0, stepMs = 100 } = {}) {
  return Array.from({ length: count }, (_, i) => noseSample(startAtMs + i * stepMs, x, visibility));
}

describe("chronosDetectStart() — clean signal", () => {
  test("a clear displacement past threshold, after a stable baseline, produces a candidate", () => {
    const baselineWindow = stableBaseline();
    const sample = noseSample(500, 0.65); // baseline x=0.5, displacement=0.15

    const result = chronosDetectStart({ sample, baselineWindow, config: {} });

    assert.notEqual(result, null);
    assert.equal(result.atMs, 500);
    assert.ok(result.confidence > 0 && result.confidence <= 1);
  });

  test("strong displacement in the positive x direction produces a candidate", () => {
    const baselineWindow = stableBaseline();
    const sample = noseSample(500, 0.8); // displacement +0.30, saturating strength

    const result = chronosDetectStart({ sample, baselineWindow });

    assert.notEqual(result, null);
    assert.ok(result.evidence.displacement > 0);
    assert.equal(Math.round(result.evidence.displacement * 1000) / 1000, 0.3);
    // Displacement well past 2x threshold should saturate displacementStrength's
    // contribution — confidence should sit at or near its ceiling for this signal.
    assert.ok(result.confidence > 0.5);
  });

  test("strong displacement in the negative x direction produces a candidate — direction-agnostic", () => {
    const baselineWindow = stableBaseline();
    const sample = noseSample(500, 0.2); // displacement -0.30

    const result = chronosDetectStart({ sample, baselineWindow });

    assert.notEqual(result, null);
    assert.ok(result.evidence.displacement < 0);
    assert.ok(result.evidence.absDisplacement > 0.08);
  });
});

describe("chronosDetectStart() — hard gates", () => {
  test("insufficient baseline history returns null even with a large displacement", () => {
    const baselineWindow = stableBaseline({ count: 4 }); // one short of the default minimum (5)
    const sample = noseSample(500, 0.9);

    assert.equal(chronosDetectStart({ sample, baselineWindow }), null);
  });

  test("a low-visibility current sample returns null even with a large displacement and a good baseline", () => {
    const baselineWindow = stableBaseline();
    const sample = noseSample(500, 0.9, 0.2); // visibility 0.2 < default minVisibility 0.5

    assert.equal(chronosDetectStart({ sample, baselineWindow }), null);
  });

  test("a stationary swimmer (no meaningful displacement) returns null", () => {
    const baselineWindow = stableBaseline();
    const sample = noseSample(500, 0.505); // displacement 0.005, well under threshold

    assert.equal(chronosDetectStart({ sample, baselineWindow }), null);
  });

  test("a missing baselineWindow (undefined) is treated as empty, not a crash", () => {
    const sample = noseSample(500, 0.9);
    assert.equal(chronosDetectStart({ sample }), null);
  });
});

describe("chronosDetectStart() — borderline displacement boundary", () => {
  test("displacement exactly AT displacementThreshold is accepted (comparison is strict less-than)", () => {
    // Uses 0.125 (1/8) rather than the default 0.08 threshold: 0.125 and
    // 0.5/0.625 are exactly representable in IEEE-754 double precision,
    // so 0.625 - 0.5 lands on EXACTLY 0.125 with no floating-point
    // rounding error — the default 0.08 threshold cannot make that
    // guarantee with simple decimal literals (0.58 - 0.5 !== 0.08 to the
    // bit), which is a floating-point fixture concern, not a detector
    // behavior this test needs to re-litigate.
    const baselineWindow = stableBaseline({ x: 0.5 });
    const sample = noseSample(500, 0.625); // displacement exactly 0.125
    const config = { displacementThreshold: 0.125 };

    const result = chronosDetectStart({ sample, baselineWindow, config });

    assert.notEqual(result, null);
    assert.equal(result.evidence.absDisplacement, 0.125);
  });

  test("displacement just BELOW displacementThreshold is rejected", () => {
    const baselineWindow = stableBaseline({ x: 0.5 });
    const sample = noseSample(500, 0.579); // displacement 0.079

    assert.equal(chronosDetectStart({ sample, baselineWindow }), null);
  });
});

describe("chronosDetectStart() — baseline stability affects confidence, not acceptance", () => {
  test("an unstable (high-spread) baseline lowers confidence relative to an equally-displaced stable baseline, but still produces a candidate", () => {
    const stableWindow = stableBaseline({ x: 0.5 });
    const unstableWindow = [
      noseSample(0, 0.3),
      noseSample(100, 0.7),
      noseSample(200, 0.3),
      noseSample(300, 0.7),
      noseSample(400, 0.5)
    ]; // same mean (0.5) as the stable window, much higher spread

    const sample = noseSample(500, 0.65); // displacement 0.15 relative to either baseline's mean

    const stableResult = chronosDetectStart({ sample, baselineWindow: stableWindow });
    const unstableResult = chronosDetectStart({ sample, baselineWindow: unstableWindow });

    assert.notEqual(stableResult, null);
    assert.notEqual(unstableResult, null); // instability alone must not hard-reject
    assert.ok(unstableResult.confidence < stableResult.confidence);
    assert.equal(unstableResult.evidence.baselineStability, 0); // spread exceeds baselineStabilityScale
    assert.equal(stableResult.evidence.baselineStability, 1);
  });
});

describe("chronosDetectStart() — determinism and purity", () => {
  test("identical inputs produce identical output across repeated calls", () => {
    const baselineWindow = stableBaseline();
    const sample = noseSample(500, 0.65);

    const first = chronosDetectStart({ sample, baselineWindow });
    const second = chronosDetectStart({ sample, baselineWindow });

    assert.deepEqual(first, second);
  });

  test("confidence is always within [0, 1] across a spread of fixtures", () => {
    const baselineWindow = stableBaseline();
    const fixtures = [0.58, 0.65, 0.8, 0.99, 0.2, 0.01];

    for (const x of fixtures) {
      const result = chronosDetectStart({ sample: noseSample(500, x), baselineWindow });
      if (result !== null) {
        assert.ok(result.confidence >= 0 && result.confidence <= 1, `confidence out of range for x=${x}`);
      }
    }
  });

  test("evidence exposes the numerical signals the decision was based on", () => {
    const baselineWindow = stableBaseline();
    const result = chronosDetectStart({ sample: noseSample(500, 0.65), baselineWindow });

    assert.notEqual(result, null);
    assert.equal(typeof result.evidence.displacement, "number");
    assert.equal(typeof result.evidence.absDisplacement, "number");
    assert.equal(typeof result.evidence.baselinePositionX, "number");
    assert.equal(typeof result.evidence.baselineSampleCount, "number");
    assert.equal(typeof result.evidence.baselineStability, "number");
    assert.equal(typeof result.evidence.visibility, "number");
  });

  test("no hidden mutable state leaks between unrelated calls", () => {
    const baselineWindow = stableBaseline();

    // A qualifying call, then a non-qualifying call — the second call's
    // null result must not be influenced by the first call's success.
    const first = chronosDetectStart({ sample: noseSample(500, 0.9), baselineWindow });
    const second = chronosDetectStart({ sample: noseSample(600, 0.505), baselineWindow });

    assert.notEqual(first, null);
    assert.equal(second, null);
  });

  test("passing a plain config object is never mutated by the call", () => {
    const baselineWindow = stableBaseline();
    const config = { displacementThreshold: 0.1 };
    const configSnapshot = { ...config };

    chronosDetectStart({ sample: noseSample(500, 0.9), baselineWindow, config });

    assert.deepEqual(config, configSnapshot);
  });
});

describe("chronosDetectStart() — malformed/invalid input handling", () => {
  test("a missing sample returns null, not a throw", () => {
    assert.doesNotThrow(() => chronosDetectStart({ baselineWindow: stableBaseline() }));
    assert.equal(chronosDetectStart({ baselineWindow: stableBaseline() }), null);
  });

  test("a sample with a missing nose landmark returns null", () => {
    const result = chronosDetectStart({ sample: { atMs: 500 }, baselineWindow: stableBaseline() });
    assert.equal(result, null);
  });

  test("a non-finite atMs on the sample returns null", () => {
    const result = chronosDetectStart({
      sample: { atMs: NaN, nose: { x: 0.9, y: 0.5, visibility: 0.9 } },
      baselineWindow: stableBaseline()
    });
    assert.equal(result, null);
  });

  test("a non-finite nose.x returns null", () => {
    const result = chronosDetectStart({
      sample: { atMs: 500, nose: { x: Infinity, y: 0.5, visibility: 0.9 } },
      baselineWindow: stableBaseline()
    });
    assert.equal(result, null);
  });

  test("a non-numeric visibility returns null", () => {
    const result = chronosDetectStart({
      sample: { atMs: 500, nose: { x: 0.9, y: 0.5, visibility: "high" } },
      baselineWindow: stableBaseline()
    });
    assert.equal(result, null);
  });

  test("malformed entries inside baselineWindow are excluded rather than crashing the call", () => {
    const baselineWindow = [
      ...stableBaseline({ count: 5 }),
      { atMs: 500, nose: { x: NaN, y: 0.5, visibility: 0.9 } },
      { atMs: 600 }, // missing nose entirely
      null
    ];
    const sample = noseSample(700, 0.65);

    const result = chronosDetectStart({ sample, baselineWindow });

    assert.notEqual(result, null);
    assert.equal(result.evidence.baselineSampleCount, 5); // malformed entries excluded, not counted
  });
});
