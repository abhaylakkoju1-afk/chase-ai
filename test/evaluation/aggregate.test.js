// Unit tests for aggregateEvaluationResults() (src/evaluation/aggregate.js).
//
// All inputs are SYNTHETIC EvaluationResult-shaped objects — no real
// swimmer data. These tests verify pooled (micro-averaged) TP/FP/FN
// arithmetic only; they are not a benchmark run and make no claim
// about Chase's real-world accuracy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { aggregateEvaluationResults } from "../../src/evaluation/aggregate.js";
import { createEvaluationResult, createEvaluationConfig } from "../../src/evaluation/contracts.js";

function syntheticConfig() {
  return createEvaluationConfig({
    dataset_version: "synthetic-fixture-v0",
    annotation_version: "synthetic-fixture-v0",
    evaluation_version: "eval-v0",
    detector_commit: "SYNTHETIC-COMMIT-0000000",
    event_type: "synthetic_test_event",
    matching_tolerance_ms: 50,
  });
}

function syntheticResult(clip_id, { truePositives, falsePositives, falseNegatives, precision = null, recall = null, f1 = null }) {
  return createEvaluationResult({
    clip_id,
    config: syntheticConfig(),
    matches: [],
    unmatchedPredictedIndices: [],
    unmatchedGroundTruthIndices: [],
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    boundaryTimingErrorsMs: [],
  });
}

describe("aggregateEvaluationResults() — input validation", () => {
  test("throws if evaluationResults is not an array", () => {
    assert.throws(() => aggregateEvaluationResults(null));
    assert.throws(() => aggregateEvaluationResults({}));
  });
});

describe("aggregateEvaluationResults() — empty results", () => {
  test("no clips at all -> zero counts, null precision/recall/F1 (existing no-data semantics)", () => {
    const aggregate = aggregateEvaluationResults([]);
    assert.strictEqual(aggregate.clipCount, 0);
    assert.strictEqual(aggregate.truePositives, 0);
    assert.strictEqual(aggregate.falsePositives, 0);
    assert.strictEqual(aggregate.falseNegatives, 0);
    assert.strictEqual(aggregate.precision, null);
    assert.strictEqual(aggregate.recall, null);
    assert.strictEqual(aggregate.f1, null);
  });
});

describe("aggregateEvaluationResults() — mixed successful and failed clips", () => {
  test("pools TP/FP/FN across clips and recomputes precision/recall/F1 from the pooled totals (micro-average, not a mean of per-clip F1)", () => {
    // Clip A: a perfect clip (TP=3, FP=0, FN=0, own F1=1).
    // Clip B: a complete miss (TP=0, FP=2, FN=2, own F1=0).
    const results = [
      syntheticResult("SYNTHETIC-CLIP-A", { truePositives: 3, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1, f1: 1 }),
      syntheticResult("SYNTHETIC-CLIP-B", { truePositives: 0, falsePositives: 2, falseNegatives: 2, precision: 0, recall: 0, f1: 0 }),
    ];

    const aggregate = aggregateEvaluationResults(results);

    assert.strictEqual(aggregate.clipCount, 2);
    assert.strictEqual(aggregate.truePositives, 3);
    assert.strictEqual(aggregate.falsePositives, 2);
    assert.strictEqual(aggregate.falseNegatives, 2);
    // Pooled precision = 3 / (3 + 2) = 0.6, pooled recall = 3 / (3 + 2) = 0.6.
    assert.strictEqual(aggregate.precision, 0.6);
    assert.strictEqual(aggregate.recall, 0.6);
    assert.strictEqual(aggregate.f1, 0.6);
    // Explicitly NOT the mean of the two clips' own F1 scores (1 and 0),
    // which would be 0.5 — a different, macro-averaged number this
    // function deliberately does not compute.
    assert.notStrictEqual(aggregate.f1, (1 + 0) / 2);
  });

  test("three clips with varied counts pool correctly", () => {
    const results = [
      syntheticResult("SYNTHETIC-CLIP-001", { truePositives: 2, falsePositives: 1, falseNegatives: 0 }),
      syntheticResult("SYNTHETIC-CLIP-002", { truePositives: 1, falsePositives: 0, falseNegatives: 1 }),
      syntheticResult("SYNTHETIC-CLIP-003", { truePositives: 0, falsePositives: 1, falseNegatives: 1 }),
    ];

    const aggregate = aggregateEvaluationResults(results);

    assert.strictEqual(aggregate.clipCount, 3);
    assert.strictEqual(aggregate.truePositives, 3);
    assert.strictEqual(aggregate.falsePositives, 2);
    assert.strictEqual(aggregate.falseNegatives, 2);
    assert.strictEqual(aggregate.precision, 3 / 5);
    assert.strictEqual(aggregate.recall, 3 / 5);
  });
});

describe("aggregateEvaluationResults() — complete-miss aggregation", () => {
  test("every clip a complete miss -> pooled precision=0, recall=0, F1=0 (not null)", () => {
    const results = [
      syntheticResult("SYNTHETIC-CLIP-001", { truePositives: 0, falsePositives: 1, falseNegatives: 1 }),
      syntheticResult("SYNTHETIC-CLIP-002", { truePositives: 0, falsePositives: 2, falseNegatives: 3 }),
    ];

    const aggregate = aggregateEvaluationResults(results);

    assert.strictEqual(aggregate.truePositives, 0);
    assert.strictEqual(aggregate.falsePositives, 3);
    assert.strictEqual(aggregate.falseNegatives, 4);
    // Real data existed (nonzero FP/FN) but zero matched anywhere ->
    // this must be the real 0 case, not the null no-data case (same
    // precision()/recall()/f1Score() distinction verified in metrics.test.js).
    assert.strictEqual(aggregate.precision, 0);
    assert.strictEqual(aggregate.recall, 0);
    assert.strictEqual(aggregate.f1, 0);
  });

  test("a single perfect clip -> pooled precision=1, recall=1, F1=1", () => {
    const results = [syntheticResult("SYNTHETIC-CLIP-001", { truePositives: 4, falsePositives: 0, falseNegatives: 0 })];
    const aggregate = aggregateEvaluationResults(results);
    assert.strictEqual(aggregate.precision, 1);
    assert.strictEqual(aggregate.recall, 1);
    assert.strictEqual(aggregate.f1, 1);
  });
});
