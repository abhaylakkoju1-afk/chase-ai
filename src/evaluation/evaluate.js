// Chase evaluation infrastructure — orchestration.
//
// The only place matching.js and metrics.js are wired together. This
// function still does not know where its inputs came from: it takes
// plain prediction/ground-truth timestamp arrays and an
// EvaluationConfig (src/evaluation/contracts.js), and returns an
// EvaluationResult. It never touches MediaPipe, the DOM, Firebase, or
// chaseDetectFreestyleCycles.

import { matchEvents } from "./matching.js";
import {
  truePositiveCount,
  falsePositiveCount,
  falseNegativeCount,
  precision,
  recall,
  f1Score,
  boundaryTimingErrorsMs,
} from "./metrics.js";
import { createEvaluationResult } from "./contracts.js";

/**
 * Evaluate one clip's predicted event timestamps against its
 * ground-truth event timestamps, under one EvaluationConfig.
 *
 * @param {object} params
 * @param {string} params.clip_id
 * @param {number[]} params.predictedTimestampsMs
 * @param {number[]} params.groundTruthTimestampsMs
 * @param {object} params.config - an EvaluationConfig from contracts.js
 *   (must already carry an explicit matching_tolerance_ms — this
 *   function does not supply or default one).
 * @returns {object} an EvaluationResult (contracts.js)
 */
export function evaluateClip({ clip_id, predictedTimestampsMs, groundTruthTimestampsMs, config }) {
  if (!config || typeof config.matching_tolerance_ms !== "number") {
    throw new Error(
      "evaluateClip: config.matching_tolerance_ms is required and must be an explicit number " +
      "(see createEvaluationConfig — there is no default tolerance)."
    );
  }

  const matchResult = matchEvents(predictedTimestampsMs, groundTruthTimestampsMs, config.matching_tolerance_ms);

  const tp = truePositiveCount(matchResult);
  const fp = falsePositiveCount(matchResult);
  const fn = falseNegativeCount(matchResult);
  const precisionValue = precision(tp, fp);
  const recallValue = recall(tp, fn);
  const f1Value = f1Score(precisionValue, recallValue);

  return createEvaluationResult({
    clip_id,
    config,
    matches: matchResult.matches,
    unmatchedPredictedIndices: matchResult.unmatchedPredictedIndices,
    unmatchedGroundTruthIndices: matchResult.unmatchedGroundTruthIndices,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: precisionValue,
    recall: recallValue,
    f1: f1Value,
    boundaryTimingErrorsMs: boundaryTimingErrorsMs(matchResult),
  });
}
