// Unit tests for evaluateClip() (src/evaluation/evaluate.js) — verifies
// matching.js and metrics.js are wired together correctly, and that an
// EvaluationConfig with no explicit tolerance is rejected rather than
// silently defaulted.
//
// All inputs are SYNTHETIC fixtures. This is a wiring/mechanics test,
// not a benchmark run.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateClip } from "../../src/evaluation/evaluate.js";
import { createEvaluationConfig } from "../../src/evaluation/contracts.js";
import {
  SYNTHETIC_TOLERANCE_MS,
  SYNTHETIC_MISSING_PREDICTIONS,
  SYNTHETIC_OUTSIDE_TOLERANCE,
} from "./fixtures.js";

function syntheticConfig(overrides = {}) {
  return createEvaluationConfig({
    dataset_version: "synthetic-test-fixture-v0",
    annotation_version: "synthetic-test-fixture-v0",
    evaluation_version: "synthetic-test-fixture-v0",
    detector_commit: "0000000",
    event_type: "synthetic_test_event",
    matching_tolerance_ms: SYNTHETIC_TOLERANCE_MS,
    ...overrides,
  });
}

describe("evaluateClip()", () => {
  test("produces an EvaluationResult with correctly wired metrics", () => {
    const config = syntheticConfig();
    const result = evaluateClip({
      clip_id: "SYNTHETIC-CLIP-001",
      predictedTimestampsMs: SYNTHETIC_MISSING_PREDICTIONS.predictedTimestampsMs,
      groundTruthTimestampsMs: SYNTHETIC_MISSING_PREDICTIONS.groundTruthTimestampsMs,
      config,
    });

    assert.strictEqual(result.clip_id, "SYNTHETIC-CLIP-001");
    assert.strictEqual(result.config, config);
    assert.strictEqual(result.truePositives, 1);
    assert.strictEqual(result.falsePositives, 0);
    assert.strictEqual(result.falseNegatives, 2);
    assert.strictEqual(result.precision, 1);
    assert.strictEqual(result.recall, 1 / 3);
    assert.ok(Math.abs(result.f1 - (2 * 1 * (1 / 3)) / (1 + 1 / 3)) < 1e-9);
    assert.deepStrictEqual(result.boundaryTimingErrorsMs, [0]);
    // No combined/weighted score field should exist anywhere on the result.
    assert.strictEqual(result.score, undefined);
    assert.strictEqual(result.overallScore, undefined);
  });

  test("complete-miss clip: TP=0, FP>0, FN>0 -> precision=0, recall=0, F1=0 (not null)", () => {
    // Regression coverage for the f1Score(0, 0) audit fix, exercised
    // through the real evaluateClip() path rather than only a direct
    // f1Score() unit test. SYNTHETIC_OUTSIDE_TOLERANCE has predictions
    // and ground truth on both sides, but every pair is beyond
    // SYNTHETIC_TOLERANCE_MS apart, so nothing matches.
    const config = syntheticConfig();
    const result = evaluateClip({
      clip_id: "SYNTHETIC-CLIP-003",
      predictedTimestampsMs: SYNTHETIC_OUTSIDE_TOLERANCE.predictedTimestampsMs,
      groundTruthTimestampsMs: SYNTHETIC_OUTSIDE_TOLERANCE.groundTruthTimestampsMs,
      config,
    });

    assert.strictEqual(result.truePositives, 0);
    assert.ok(result.falsePositives > 0);
    assert.ok(result.falseNegatives > 0);
    assert.strictEqual(result.precision, 0);
    assert.strictEqual(result.recall, 0);
    assert.strictEqual(result.f1, 0);
  });

  test("rejects a config missing an explicit matching_tolerance_ms", () => {
    assert.throws(() =>
      evaluateClip({
        clip_id: "SYNTHETIC-CLIP-002",
        predictedTimestampsMs: [1000],
        groundTruthTimestampsMs: [1000],
        config: { dataset_version: "x", annotation_version: "x", evaluation_version: "x", detector_commit: "x", event_type: "x" },
      })
    );
  });
});
