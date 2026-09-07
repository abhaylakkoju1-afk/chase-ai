// Chase evaluation infrastructure — candidate evaluation metrics.
//
// Every function here is a separate, pure primitive. There is
// deliberately no combined/weighted "score" function anywhere in this
// file — precision, recall, F1, cycle-count error, and boundary timing
// error are reported independently, per the task's explicit
// instruction not to produce an overall grade. Which of these (if any)
// becomes part of the eventual benchmark is a decision for after the
// real pilot (ANNOTATION_PROTOCOL_V0.1.md §14–15, §20).
//
// This module does not import anything from src/chase-engine/ — it has
// no dependency on the production detector or its statistics helpers,
// so it can be developed, tested, and reasoned about independently of
// the pipeline it will eventually be used to evaluate.

/**
 * Count of matched (prediction, ground-truth) pairs — i.e. events the
 * detector predicted that a human annotator also marked, within
 * tolerance.
 */
export function truePositiveCount(matchResult) {
  return matchResult.matches.length;
}

/**
 * Predictions that did not correspond to any ground-truth event within
 * tolerance.
 */
export function falsePositiveCount(matchResult) {
  return matchResult.unmatchedPredictedIndices.length;
}

/**
 * Ground-truth events that no prediction matched within tolerance.
 */
export function falseNegativeCount(matchResult) {
  return matchResult.unmatchedGroundTruthIndices.length;
}

/**
 * Precision = TP / (TP + FP). Returns null (not NaN, not 0) when there
 * were no predictions at all — "no predictions" is not the same claim
 * as "0% precision", and collapsing them would misrepresent a clip with
 * zero detector output as a confirmed failure rather than an
 * undefined case.
 */
export function precision(truePositives, falsePositives) {
  const denominator = truePositives + falsePositives;
  if (denominator === 0) return null;
  return truePositives / denominator;
}

/**
 * Recall = TP / (TP + FN). Returns null when there was no ground truth
 * at all, for the same reason as precision() above.
 */
export function recall(truePositives, falseNegatives) {
  const denominator = truePositives + falseNegatives;
  if (denominator === 0) return null;
  return truePositives / denominator;
}

/**
 * Harmonic mean of precision and recall.
 *
 * Two distinct "no meaningful F1" situations must not be conflated:
 *
 *   - precision or recall is null: there was no data to compute that
 *     metric at all (no predictions, or no ground truth). F1 is
 *     likewise null here — there is nothing to report.
 *   - precision and recall are both the number 0: predictions and
 *     ground truth both existed, but zero of them matched (a complete
 *     miss). This is a real, well-defined result — by convention (the
 *     same one scikit-learn's f1_score uses for this exact case), F1
 *     is reported as 0, not null. Returning null here would make a
 *     genuine "detector missed everything" result indistinguishable
 *     from "this metric could not be computed."
 */
export function f1Score(precisionValue, recallValue) {
  if (precisionValue === null || recallValue === null) return null;
  if (precisionValue === 0 && recallValue === 0) return 0;
  return (2 * precisionValue * recallValue) / (precisionValue + recallValue);
}

/**
 * Signed difference between a predicted cycle count and a ground-truth
 * cycle count for one clip: predictedCount - groundTruthCount. Positive
 * means the detector reported more cycles than were annotated; negative
 * means fewer. This function takes counts directly — it does not derive
 * cycles from matched events itself, since how ground-truth cycles are
 * constructed from paired events is defined by Annotation Protocol
 * v0.1 §8, not by this evaluator.
 */
export function cycleCountError(predictedCycleCount, groundTruthCycleCount) {
  if (
    typeof predictedCycleCount !== "number" ||
    typeof groundTruthCycleCount !== "number" ||
    !Number.isFinite(predictedCycleCount) ||
    !Number.isFinite(groundTruthCycleCount)
  ) {
    throw new Error("cycleCountError: both arguments must be finite numbers");
  }
  return predictedCycleCount - groundTruthCycleCount;
}

/**
 * Boundary timing error, per matched pair: predictedTimestampMs -
 * groundTruthTimestampMs (the same signed offsetMs already present on
 * each match record from matchEvents()). This measures, for events the
 * matcher considered "the same event" within tolerance, exactly how far
 * apart the two timestamps actually were — it is NOT a measure of
 * whether the match itself was correct, and it says nothing about
 * unmatched (false positive/negative) events, which have no offset by
 * definition.
 *
 * Returns a plain array of signed millisecond offsets, one per match,
 * in the same order as matchResult.matches.
 */
export function boundaryTimingErrorsMs(matchResult) {
  return matchResult.matches.map((match) => match.offsetMs);
}

/**
 * Describes the distribution of a set of boundary timing errors (mean,
 * absolute mean, min, max) purely as a description of that
 * distribution — this is NOT a combined score, and none of its fields
 * imply which offset value is "good" or "bad" without an approved
 * tolerance to compare against. Returns null for an empty input, since
 * there is no distribution to describe.
 *
 * Implemented independently of src/chase-engine/stats.js's
 * summariseMetric, by design (Part 10: evaluation code stays
 * decoupled from the pipeline it evaluates), even though the
 * computation is similar.
 */
export function summariseTimingErrorsMs(offsetsMs) {
  if (!Array.isArray(offsetsMs) || offsetsMs.length === 0) return null;

  const count = offsetsMs.length;
  const mean = offsetsMs.reduce((sum, value) => sum + value, 0) / count;
  const meanAbs = offsetsMs.reduce((sum, value) => sum + Math.abs(value), 0) / count;
  const variance = offsetsMs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;

  return {
    count,
    meanMs: mean,
    meanAbsMs: meanAbs,
    stdDevMs: Math.sqrt(variance),
    minMs: Math.min(...offsetsMs),
    maxMs: Math.max(...offsetsMs),
  };
}
