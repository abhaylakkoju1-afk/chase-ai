// Unit tests for matchEvents() (src/evaluation/matching.js).
//
// All timestamps here are SYNTHETIC fixtures (test/evaluation/fixtures.js)
// — no real swimmer data, no real annotations. These tests verify
// matching MECHANICS only: determinism, one-to-one enforcement,
// tolerance handling, and the documented tie-breaking rule. They make
// no claim about Chase's real-world accuracy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchEvents } from "../../src/evaluation/matching.js";
import {
  SYNTHETIC_TOLERANCE_MS,
  SYNTHETIC_PERFECT_MATCH,
  SYNTHETIC_SMALL_OFFSETS,
  SYNTHETIC_OUTSIDE_TOLERANCE,
  SYNTHETIC_MISSING_PREDICTIONS,
  SYNTHETIC_EXTRA_PREDICTIONS,
  SYNTHETIC_MULTIPLE_NEAR_ONE_GROUND_TRUTH,
  SYNTHETIC_ONE_PREDICTION_NEAR_TWO_GROUND_TRUTH,
  SYNTHETIC_DIFFERENT_COUNTS,
  SYNTHETIC_EMPTY_PREDICTIONS,
  SYNTHETIC_EMPTY_GROUND_TRUTH,
  SYNTHETIC_BOTH_EMPTY,
  SYNTHETIC_DUPLICATE_PREDICTIONS,
  SYNTHETIC_EXACTLY_ON_TOLERANCE_BOUNDARY,
  SYNTHETIC_JUST_OUTSIDE_TOLERANCE_BOUNDARY,
} from "./fixtures.js";

describe("matchEvents() — input validation", () => {
  test("throws if predicted timestamps is not an array", () => {
    assert.throws(() => matchEvents(null, [1], SYNTHETIC_TOLERANCE_MS));
  });

  test("throws if ground-truth timestamps is not an array", () => {
    assert.throws(() => matchEvents([1], null, SYNTHETIC_TOLERANCE_MS));
  });

  test("throws if tolerance is missing (no default is ever applied)", () => {
    assert.throws(() => matchEvents([1], [1], undefined));
  });

  test("throws if tolerance is negative", () => {
    assert.throws(() => matchEvents([1], [1], -5));
  });
});

describe("matchEvents() — perfect matching", () => {
  test("every prediction matches its exact ground-truth counterpart", () => {
    const result = matchEvents(
      SYNTHETIC_PERFECT_MATCH.predictedTimestampsMs,
      SYNTHETIC_PERFECT_MATCH.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 3);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, []);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, []);
    for (const match of result.matches) {
      assert.strictEqual(match.offsetMs, 0);
    }
  });
});

describe("matchEvents() — small offsets within tolerance", () => {
  test("all predictions match despite non-zero offsets", () => {
    const result = matchEvents(
      SYNTHETIC_SMALL_OFFSETS.predictedTimestampsMs,
      SYNTHETIC_SMALL_OFFSETS.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 3);
    assert.deepStrictEqual(
      result.matches.map((m) => m.offsetMs),
      [10, -20, 25]
    );
  });
});

describe("matchEvents() — predictions outside tolerance", () => {
  test("no matches occur when every candidate pair exceeds tolerance", () => {
    const result = matchEvents(
      SYNTHETIC_OUTSIDE_TOLERANCE.predictedTimestampsMs,
      SYNTHETIC_OUTSIDE_TOLERANCE.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 0);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, [0, 1]);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, [0, 1]);
  });
});

describe("matchEvents() — missing predictions", () => {
  test("unmatched ground-truth events surface as false negatives", () => {
    const result = matchEvents(
      SYNTHETIC_MISSING_PREDICTIONS.predictedTimestampsMs,
      SYNTHETIC_MISSING_PREDICTIONS.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 1);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, []);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, [1, 2]);
  });
});

describe("matchEvents() — extra predictions", () => {
  test("unmatched predictions surface as false positives", () => {
    const result = matchEvents(
      SYNTHETIC_EXTRA_PREDICTIONS.predictedTimestampsMs,
      SYNTHETIC_EXTRA_PREDICTIONS.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 2);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, [1]);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, []);
  });
});

describe("matchEvents() — multiple predictions near one ground-truth event", () => {
  test("only the nearest prediction matches; the other is unmatched", () => {
    const result = matchEvents(
      SYNTHETIC_MULTIPLE_NEAR_ONE_GROUND_TRUTH.predictedTimestampsMs,
      SYNTHETIC_MULTIPLE_NEAR_ONE_GROUND_TRUTH.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 1);
    // predicted[0] = 995 (diff 5) is nearer than predicted[1] = 1010 (diff 10).
    assert.strictEqual(result.matches[0].predictedIndex, 0);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, [1]);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, []);
  });
});

describe("matchEvents() — one prediction near two ground-truth events", () => {
  test("only the nearest ground-truth event matches; the other remains an unmatched false negative", () => {
    // With a single prediction, at most one match is possible under
    // ANY one-to-one strategy — this test verifies the CURRENT
    // documented nearest-neighbor/tie-break behavior of matchEvents(),
    // not that it found a "globally optimal" assignment (there is no
    // alternative assignment to be more or less optimal than here).
    const result = matchEvents(
      SYNTHETIC_ONE_PREDICTION_NEAR_TWO_GROUND_TRUTH.predictedTimestampsMs,
      SYNTHETIC_ONE_PREDICTION_NEAR_TWO_GROUND_TRUTH.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );

    assert.strictEqual(result.matches.length, 1);
    // groundTruth[0] = 990 (diff 10) is nearer than groundTruth[1] = 1030 (diff 30).
    assert.strictEqual(result.matches[0].groundTruthIndex, 0);
    assert.strictEqual(result.matches[0].predictedIndex, 0);
    assert.strictEqual(result.matches[0].offsetMs, 10);

    // Exactly one prediction was available and it was consumed by the match.
    assert.deepStrictEqual(result.unmatchedPredictedIndices, []);
    // The farther ground-truth event was never a candidate for anything
    // else and remains an unmatched false negative.
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, [1]);
  });
});

describe("matchEvents() — different prediction/ground-truth counts", () => {
  test("one-to-one matching still holds with mismatched array lengths", () => {
    const result = matchEvents(
      SYNTHETIC_DIFFERENT_COUNTS.predictedTimestampsMs,
      SYNTHETIC_DIFFERENT_COUNTS.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    // predicted: [1000, 4000, 4010], groundTruth: [1000, 2000, 3000, 4000]
    // 1000<->1000 exact; 4000<->4000 exact (nearer than 4010); 4010 unmatched;
    // 2000 and 3000 unmatched ground truth.
    assert.strictEqual(result.matches.length, 2);
    const usedPredicted = result.matches.map((m) => m.predictedIndex).sort();
    assert.deepStrictEqual(usedPredicted, [0, 1]);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, [2]);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, [1, 2]);
  });
});

describe("matchEvents() — empty predictions", () => {
  test("every ground-truth event is unmatched; no matches", () => {
    const result = matchEvents(
      SYNTHETIC_EMPTY_PREDICTIONS.predictedTimestampsMs,
      SYNTHETIC_EMPTY_PREDICTIONS.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.deepStrictEqual(result.matches, []);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, []);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, [0, 1]);
  });
});

describe("matchEvents() — empty ground truth", () => {
  test("every prediction is unmatched; no matches", () => {
    const result = matchEvents(
      SYNTHETIC_EMPTY_GROUND_TRUTH.predictedTimestampsMs,
      SYNTHETIC_EMPTY_GROUND_TRUTH.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.deepStrictEqual(result.matches, []);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, [0, 1]);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, []);
  });
});

describe("matchEvents() — both empty", () => {
  test("no matches, no unmatched entries either", () => {
    const result = matchEvents(
      SYNTHETIC_BOTH_EMPTY.predictedTimestampsMs,
      SYNTHETIC_BOTH_EMPTY.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.deepStrictEqual(result.matches, []);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, []);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, []);
  });
});

describe("matchEvents() — duplicate/near-duplicate predictions", () => {
  test("only one duplicate matches the single ground-truth event", () => {
    const result = matchEvents(
      SYNTHETIC_DUPLICATE_PREDICTIONS.predictedTimestampsMs,
      SYNTHETIC_DUPLICATE_PREDICTIONS.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 1);
    // Exact-zero-diff duplicates (index 0 and 1) tie on absDiff; the
    // documented tie-break (lower predicted index) picks index 0.
    assert.strictEqual(result.matches[0].predictedIndex, 0);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, [1, 2]);
  });
});

describe("matchEvents() — tolerance boundary", () => {
  test("an offset exactly equal to the tolerance matches (inclusive)", () => {
    const result = matchEvents(
      SYNTHETIC_EXACTLY_ON_TOLERANCE_BOUNDARY.predictedTimestampsMs,
      SYNTHETIC_EXACTLY_ON_TOLERANCE_BOUNDARY.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].offsetMs, SYNTHETIC_TOLERANCE_MS);
  });

  test("an offset one millisecond beyond the tolerance does not match", () => {
    const result = matchEvents(
      SYNTHETIC_JUST_OUTSIDE_TOLERANCE_BOUNDARY.predictedTimestampsMs,
      SYNTHETIC_JUST_OUTSIDE_TOLERANCE_BOUNDARY.groundTruthTimestampsMs,
      SYNTHETIC_TOLERANCE_MS
    );
    assert.strictEqual(result.matches.length, 0);
    assert.deepStrictEqual(result.unmatchedPredictedIndices, [0]);
    assert.deepStrictEqual(result.unmatchedGroundTruthIndices, [0]);
  });
});

describe("matchEvents() — determinism", () => {
  test("repeated calls on the same input produce identical results", () => {
    const runOnce = () =>
      matchEvents(
        SYNTHETIC_DIFFERENT_COUNTS.predictedTimestampsMs,
        SYNTHETIC_DIFFERENT_COUNTS.groundTruthTimestampsMs,
        SYNTHETIC_TOLERANCE_MS
      );
    assert.deepStrictEqual(runOnce(), runOnce());
  });
});
