// SYNTHETIC test fixtures for the evaluation infrastructure.
//
// Nothing in this file is real swimmer data, real video, or a real
// annotation. Every timestamp below is a hand-picked number chosen only
// to exercise a specific mechanical case in matching.js/metrics.js.
// None of it should ever be read as evidence about Chase's real-world
// accuracy — see docs/evaluation/EVALUATION_INFRASTRUCTURE.md.
//
// SYNTHETIC_TOLERANCE_MS is likewise NOT an approved benchmark
// tolerance (no such value exists yet — see
// docs/evaluation/ANNOTATION_PROTOCOL_V0.1.md §14). It is an arbitrary
// round number chosen only so these fixtures have *something* to test
// tolerance handling against. Do not reuse this constant outside tests.

export const SYNTHETIC_TOLERANCE_MS = 50;

// 1. Perfect matching — every prediction exactly equals a ground-truth
// timestamp.
export const SYNTHETIC_PERFECT_MATCH = {
  predictedTimestampsMs: [1000, 2000, 3000],
  groundTruthTimestampsMs: [1000, 2000, 3000],
};

// 2. Small timestamp offsets — every prediction is inside tolerance but
// not exact.
export const SYNTHETIC_SMALL_OFFSETS = {
  predictedTimestampsMs: [1010, 1980, 3025],
  groundTruthTimestampsMs: [1000, 2000, 3000],
};

// 3. Predictions outside tolerance — every prediction is further than
// SYNTHETIC_TOLERANCE_MS from the nearest ground truth.
export const SYNTHETIC_OUTSIDE_TOLERANCE = {
  predictedTimestampsMs: [1200, 2300],
  groundTruthTimestampsMs: [1000, 2000],
};

// 4. Missing predictions — fewer predictions than ground-truth events;
// the detector simply failed to fire for one event.
export const SYNTHETIC_MISSING_PREDICTIONS = {
  predictedTimestampsMs: [1000],
  groundTruthTimestampsMs: [1000, 2000, 3000],
};

// 5. Extra predictions — more predictions than ground-truth events; the
// detector fired on something no annotator marked.
export const SYNTHETIC_EXTRA_PREDICTIONS = {
  predictedTimestampsMs: [1000, 1500, 2000],
  groundTruthTimestampsMs: [1000, 2000],
};

// 6. Multiple predictions near one ground-truth event — only the
// nearest should match; the other remains an unmatched false positive.
export const SYNTHETIC_MULTIPLE_NEAR_ONE_GROUND_TRUTH = {
  predictedTimestampsMs: [995, 1010],
  groundTruthTimestampsMs: [1000],
};

// 6b. The mirror case: one prediction within tolerance of TWO
// ground-truth events. With only one prediction available, at most one
// match is possible under any one-to-one strategy (this is not a test
// of global optimality — there is no alternative assignment to compare
// against). It verifies the documented nearest-neighbor tie-break picks
// the closer ground-truth event (990, offset 10) over the farther one
// (1030, offset 30), leaving the farther event an unmatched false
// negative.
export const SYNTHETIC_ONE_PREDICTION_NEAR_TWO_GROUND_TRUTH = {
  predictedTimestampsMs: [1000],
  groundTruthTimestampsMs: [990, 1030],
};

// 7. Different prediction/ground-truth counts (general case, not
// specifically "missing" or "extra" — a genuinely different shape).
export const SYNTHETIC_DIFFERENT_COUNTS = {
  predictedTimestampsMs: [1000, 4000, 4010],
  groundTruthTimestampsMs: [1000, 2000, 3000, 4000],
};

// 8. Empty predictions — no detector output at all for this clip.
export const SYNTHETIC_EMPTY_PREDICTIONS = {
  predictedTimestampsMs: [],
  groundTruthTimestampsMs: [1000, 2000],
};

// 9. Empty ground truth — no annotated events at all for this clip.
export const SYNTHETIC_EMPTY_GROUND_TRUTH = {
  predictedTimestampsMs: [1000, 2000],
  groundTruthTimestampsMs: [],
};

// 10. Both empty.
export const SYNTHETIC_BOTH_EMPTY = {
  predictedTimestampsMs: [],
  groundTruthTimestampsMs: [],
};

// 11. Boundary timing error — a fixed, hand-computable offset to verify
// summariseTimingErrorsMs()'s arithmetic.
export const SYNTHETIC_TIMING_ERROR_SET = {
  predictedTimestampsMs: [1010, 1990, 3020],
  groundTruthTimestampsMs: [1000, 2000, 3000],
  // Expected offsets (predicted - groundTruth): +10, -10, +20
};

// 12. Duplicate / near-duplicate predictions — two predictions at (or
// almost at) the same timestamp, only one ground-truth event to match.
export const SYNTHETIC_DUPLICATE_PREDICTIONS = {
  predictedTimestampsMs: [1000, 1000, 1001],
  groundTruthTimestampsMs: [1000],
};

// 13. Events exactly on the tolerance boundary — offset equals
// SYNTHETIC_TOLERANCE_MS exactly (matching.js treats this as a match:
// the comparison is inclusive, <=).
export const SYNTHETIC_EXACTLY_ON_TOLERANCE_BOUNDARY = {
  predictedTimestampsMs: [1000 + SYNTHETIC_TOLERANCE_MS],
  groundTruthTimestampsMs: [1000],
};

// 14. Events just outside the tolerance boundary — offset is
// SYNTHETIC_TOLERANCE_MS + 1, one millisecond too far to match.
export const SYNTHETIC_JUST_OUTSIDE_TOLERANCE_BOUNDARY = {
  predictedTimestampsMs: [1000 + SYNTHETIC_TOLERANCE_MS + 1],
  groundTruthTimestampsMs: [1000],
};
