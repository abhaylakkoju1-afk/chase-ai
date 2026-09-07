// Unit tests for src/evaluation/metrics.js.
//
// All inputs are SYNTHETIC fixtures (test/evaluation/fixtures.js) —
// no real swimmer data. These tests verify metric ARITHMETIC and edge
// cases only; they are not a benchmark run and make no claim about
// Chase's real-world accuracy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchEvents } from "../../src/evaluation/matching.js";
import {
  truePositiveCount,
  falsePositiveCount,
  falseNegativeCount,
  precision,
  recall,
  f1Score,
  cycleCountError,
  boundaryTimingErrorsMs,
  summariseTimingErrorsMs,
} from "../../src/evaluation/metrics.js";
import {
  SYNTHETIC_TOLERANCE_MS,
  SYNTHETIC_PERFECT_MATCH,
  SYNTHETIC_MISSING_PREDICTIONS,
  SYNTHETIC_EXTRA_PREDICTIONS,
  SYNTHETIC_EMPTY_PREDICTIONS,
  SYNTHETIC_EMPTY_GROUND_TRUTH,
  SYNTHETIC_BOTH_EMPTY,
  SYNTHETIC_OUTSIDE_TOLERANCE,
  SYNTHETIC_TIMING_ERROR_SET,
} from "./fixtures.js";

function match(fixture) {
  return matchEvents(fixture.predictedTimestampsMs, fixture.groundTruthTimestampsMs, SYNTHETIC_TOLERANCE_MS);
}

describe("truePositiveCount / falsePositiveCount / falseNegativeCount", () => {
  test("perfect match: TP=3, FP=0, FN=0", () => {
    const result = match(SYNTHETIC_PERFECT_MATCH);
    assert.strictEqual(truePositiveCount(result), 3);
    assert.strictEqual(falsePositiveCount(result), 0);
    assert.strictEqual(falseNegativeCount(result), 0);
  });

  test("missing predictions: TP=1, FP=0, FN=2", () => {
    const result = match(SYNTHETIC_MISSING_PREDICTIONS);
    assert.strictEqual(truePositiveCount(result), 1);
    assert.strictEqual(falsePositiveCount(result), 0);
    assert.strictEqual(falseNegativeCount(result), 2);
  });

  test("extra predictions: TP=2, FP=1, FN=0", () => {
    const result = match(SYNTHETIC_EXTRA_PREDICTIONS);
    assert.strictEqual(truePositiveCount(result), 2);
    assert.strictEqual(falsePositiveCount(result), 1);
    assert.strictEqual(falseNegativeCount(result), 0);
  });
});

describe("precision()", () => {
  test("normal: 2 TP, 1 FP -> 2/3", () => {
    assert.strictEqual(precision(2, 1), 2 / 3);
  });

  test("boundary: no predictions at all -> null, not 0 or NaN", () => {
    const result = match(SYNTHETIC_EMPTY_PREDICTIONS);
    assert.strictEqual(precision(truePositiveCount(result), falsePositiveCount(result)), null);
  });

  test("perfect: 3 TP, 0 FP -> 1", () => {
    assert.strictEqual(precision(3, 0), 1);
  });
});

describe("recall()", () => {
  test("normal: 2 TP, 1 FN -> 2/3", () => {
    assert.strictEqual(recall(2, 1), 2 / 3);
  });

  test("boundary: no ground truth at all -> null, not 0 or NaN", () => {
    const result = match(SYNTHETIC_EMPTY_GROUND_TRUTH);
    assert.strictEqual(recall(truePositiveCount(result), falseNegativeCount(result)), null);
  });

  test("perfect: 3 TP, 0 FN -> 1", () => {
    assert.strictEqual(recall(3, 0), 1);
  });
});

describe("f1Score()", () => {
  test("normal: precision 0.5, recall 0.5 -> 0.5", () => {
    assert.strictEqual(f1Score(0.5, 0.5), 0.5);
  });

  test("perfect: precision 1, recall 1 -> 1", () => {
    assert.strictEqual(f1Score(1, 1), 1);
  });

  test("boundary: both inputs null -> null (no data at all)", () => {
    assert.strictEqual(f1Score(null, null), null);
  });

  test("boundary: precision null, recall a valid number -> null", () => {
    assert.strictEqual(f1Score(null, 0.5), null);
  });

  test("boundary: precision a valid number, recall null -> null", () => {
    assert.strictEqual(f1Score(0.5, null), null);
  });

  test("boundary: both precision and recall are the number 0 -> 0, not null (real complete-miss result, not missing data)", () => {
    assert.strictEqual(f1Score(0, 0), 0);
  });

  test("both-empty clip: precision and recall are null, so F1 is null", () => {
    const result = match(SYNTHETIC_BOTH_EMPTY);
    const p = precision(truePositiveCount(result), falsePositiveCount(result));
    const r = recall(truePositiveCount(result), falseNegativeCount(result));
    assert.strictEqual(p, null);
    assert.strictEqual(r, null);
    assert.strictEqual(f1Score(p, r), null);
  });

  test("complete-miss clip (predictions and ground truth both exist, nothing matched): precision=0, recall=0, F1=0, not null", () => {
    // SYNTHETIC_OUTSIDE_TOLERANCE has 2 predictions and 2 ground-truth
    // events, all pairwise beyond SYNTHETIC_TOLERANCE_MS apart -> TP=0,
    // FP=2, FN=2. Unlike the both-empty case above, real data existed
    // on both sides here; F1 must reflect a real 0, not an absence of data.
    const result = match(SYNTHETIC_OUTSIDE_TOLERANCE);
    const tp = truePositiveCount(result);
    const fp = falsePositiveCount(result);
    const fn = falseNegativeCount(result);
    assert.strictEqual(tp, 0);
    assert.strictEqual(fp, 2);
    assert.strictEqual(fn, 2);
    const p = precision(tp, fp);
    const r = recall(tp, fn);
    assert.strictEqual(p, 0);
    assert.strictEqual(r, 0);
    assert.strictEqual(f1Score(p, r), 0);
  });
});

describe("cycleCountError()", () => {
  test("predicted more cycles than annotated -> positive", () => {
    assert.strictEqual(cycleCountError(10, 8), 2);
  });

  test("predicted fewer cycles than annotated -> negative", () => {
    assert.strictEqual(cycleCountError(6, 8), -2);
  });

  test("exact match -> 0", () => {
    assert.strictEqual(cycleCountError(8, 8), 0);
  });

  test("throws on non-numeric input", () => {
    assert.throws(() => cycleCountError("8", 8));
    assert.throws(() => cycleCountError(8, NaN));
  });
});

describe("boundaryTimingErrorsMs() / summariseTimingErrorsMs()", () => {
  test("offsets match hand-computed predicted-minus-ground-truth values", () => {
    const result = match(SYNTHETIC_TIMING_ERROR_SET);
    const offsets = boundaryTimingErrorsMs(result);
    assert.deepStrictEqual(offsets, [10, -10, 20]);
  });

  test("summary statistics match hand-computed values", () => {
    const offsets = [10, -10, 20];
    const summary = summariseTimingErrorsMs(offsets);
    assert.strictEqual(summary.count, 3);
    assert.strictEqual(summary.meanMs, 20 / 3);
    assert.strictEqual(summary.meanAbsMs, 40 / 3);
    assert.strictEqual(summary.minMs, -10);
    assert.strictEqual(summary.maxMs, 20);
    // Population variance: mean=20/3; deviations^2 sum manually verified.
    const mean = 20 / 3;
    const variance = ((10 - mean) ** 2 + (-10 - mean) ** 2 + (20 - mean) ** 2) / 3;
    assert.ok(Math.abs(summary.stdDevMs - Math.sqrt(variance)) < 1e-9);
  });

  test("boundary: empty offsets array -> null", () => {
    assert.strictEqual(summariseTimingErrorsMs([]), null);
  });
});
