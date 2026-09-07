// Chase evaluation infrastructure — one-to-one event matching.
//
// Pure, deterministic, and deliberately ignorant of everything except
// two arrays of numbers and a tolerance. This function does not know
// what a "clip" or an "event type" is, does not call MediaPipe or
// chaseDetectFreestyleCycles, and does not read any file. Predictions
// and ground truth are supplied as plain millisecond timestamps by the
// caller — see src/evaluation/contracts.js for the richer record
// shapes used to carry those timestamps around with metadata.
//
// MATCHING STRATEGY (documented per task requirement — this is a
// deliberately simple, defensible baseline, not a final benchmark
// decision):
//
//   1. Consider every (prediction, ground-truth) pair whose absolute
//      time difference is <= toleranceMs (inclusive — a difference
//      exactly equal to the tolerance counts as a match).
//   2. Sort all such candidate pairs by absolute time difference,
//      ascending. Ties are broken, in order, by: earlier ground-truth
//      timestamp, then earlier prediction timestamp, then lower
//      ground-truth array index, then lower prediction array index —
//      a fixed rule so the result never depends on array/object
//      iteration order.
//   3. Walk the sorted candidate list and greedily accept the first
//      pair for which BOTH the prediction and the ground-truth event
//      are still unmatched. Accepting a pair marks both as used, which
//      is what enforces one-to-one matching (Requirement: "one
//      prediction can match at most one ground-truth event" and vice
//      versa).
//   4. Any prediction left unmatched after this pass is a false
//      positive; any ground-truth event left unmatched is a false
//      negative.
//
// This is a global greedy nearest-neighbor match, not an optimal
// minimum-total-offset assignment (that would be a min-cost bipartite
// matching problem). Greedy nearest-neighbor is the simplest strategy
// that satisfies the stated requirements and is easy to hand-verify;
// it is intentionally not optimized further here, and its choice over
// an optimal assignment algorithm is not a claim that either produces
// the "correct" benchmark result — see docs/evaluation for that
// caveat.

/**
 * @param {number[]} predictedTimestampsMs
 * @param {number[]} groundTruthTimestampsMs
 * @param {number} toleranceMs - non-negative; caller-supplied, no default.
 * @returns {{
 *   matches: Array<{ predictedIndex: number, groundTruthIndex: number, predictedTimestampMs: number, groundTruthTimestampMs: number, offsetMs: number }>,
 *   unmatchedPredictedIndices: number[],
 *   unmatchedGroundTruthIndices: number[],
 * }}
 */
export function matchEvents(predictedTimestampsMs, groundTruthTimestampsMs, toleranceMs) {
  if (!Array.isArray(predictedTimestampsMs) || !Array.isArray(groundTruthTimestampsMs)) {
    throw new Error("matchEvents: predictedTimestampsMs and groundTruthTimestampsMs must be arrays");
  }
  if (typeof toleranceMs !== "number" || !Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new Error("matchEvents: toleranceMs must be an explicit non-negative finite number");
  }

  const candidates = [];

  for (let p = 0; p < predictedTimestampsMs.length; p++) {
    for (let g = 0; g < groundTruthTimestampsMs.length; g++) {
      const predictedTimestampMs = predictedTimestampsMs[p];
      const groundTruthTimestampMs = groundTruthTimestampsMs[g];
      const absDiff = Math.abs(predictedTimestampMs - groundTruthTimestampMs);

      if (absDiff <= toleranceMs) {
        candidates.push({
          predictedIndex: p,
          groundTruthIndex: g,
          predictedTimestampMs,
          groundTruthTimestampMs,
          absDiff,
        });
      }
    }
  }

  candidates.sort((a, b) => {
    if (a.absDiff !== b.absDiff) return a.absDiff - b.absDiff;
    if (a.groundTruthTimestampMs !== b.groundTruthTimestampMs) {
      return a.groundTruthTimestampMs - b.groundTruthTimestampMs;
    }
    if (a.predictedTimestampMs !== b.predictedTimestampMs) {
      return a.predictedTimestampMs - b.predictedTimestampMs;
    }
    if (a.groundTruthIndex !== b.groundTruthIndex) return a.groundTruthIndex - b.groundTruthIndex;
    return a.predictedIndex - b.predictedIndex;
  });

  const usedPredicted = new Set();
  const usedGroundTruth = new Set();
  const matches = [];

  for (const candidate of candidates) {
    if (usedPredicted.has(candidate.predictedIndex) || usedGroundTruth.has(candidate.groundTruthIndex)) {
      continue;
    }
    usedPredicted.add(candidate.predictedIndex);
    usedGroundTruth.add(candidate.groundTruthIndex);
    matches.push({
      predictedIndex: candidate.predictedIndex,
      groundTruthIndex: candidate.groundTruthIndex,
      predictedTimestampMs: candidate.predictedTimestampMs,
      groundTruthTimestampMs: candidate.groundTruthTimestampMs,
      // Signed offset: positive means the prediction occurred AFTER the
      // ground-truth event; negative means it occurred before.
      offsetMs: candidate.predictedTimestampMs - candidate.groundTruthTimestampMs,
    });
  }

  // Restore chronological order (by ground-truth time) for readability —
  // the greedy loop above accepts matches in nearest-first order, not
  // chronological order.
  matches.sort((a, b) => a.groundTruthTimestampMs - b.groundTruthTimestampMs);

  const unmatchedPredictedIndices = predictedTimestampsMs
    .map((_, index) => index)
    .filter((index) => !usedPredicted.has(index));

  const unmatchedGroundTruthIndices = groundTruthTimestampsMs
    .map((_, index) => index)
    .filter((index) => !usedGroundTruth.has(index));

  return { matches, unmatchedPredictedIndices, unmatchedGroundTruthIndices };
}
