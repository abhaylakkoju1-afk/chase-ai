// Chase evaluation infrastructure — run-level aggregation.
//
// A separate file so src/evaluation/metrics.js does not need to change:
// this only IMPORTS the existing precision()/recall()/f1Score()
// primitives and reuses them at a coarser grain. It defines no new
// metric and no weighting scheme.
//
// IMPORTANT — what "aggregate" means here: this pools raw TP/FP/FN
// EVENT counts across every EvaluationResult first, and computes ONE
// precision/recall/F1 from those pooled counts (sometimes called
// "micro-averaging"). It does NOT average each clip's own precision/
// recall/F1 values together ("macro-averaging"). The two are not the
// same number in general — a clip with many events pulls a
// micro-average toward it more than a clip with few, whereas a
// macro-average of per-clip scores would weight every clip equally
// regardless of how many events it contained. Micro-aggregation was
// chosen here because it is a direct, mechanical extension of the
// existing TP/FP/FN counting already used per clip — it introduces no
// new judgment call about how to weight clips against each other.
// Which (if either) becomes part of the eventual benchmark definition
// is still an open, deferred decision (ANNOTATION_PROTOCOL_V0.1.md
// §15, §20) — this function does not settle it.

import { precision, recall, f1Score } from "./metrics.js";

/**
 * Pools true/false positive/negative counts across an array of
 * EvaluationResult objects (createEvaluationResult() / evaluateClip())
 * and recomputes precision/recall/F1 from the pooled totals using the
 * existing metrics.js primitives.
 *
 * @param {object[]} evaluationResults - EvaluationResult objects, each
 *   carrying truePositives/falsePositives/falseNegatives (as produced
 *   by evaluateClip()).
 * @returns {{
 *   clipCount: number,
 *   truePositives: number,
 *   falsePositives: number,
 *   falseNegatives: number,
 *   precision: number|null,
 *   recall: number|null,
 *   f1: number|null,
 * }}
 */
export function aggregateEvaluationResults(evaluationResults) {
  if (!Array.isArray(evaluationResults)) {
    throw new Error("aggregateEvaluationResults: evaluationResults must be an array of EvaluationResult objects");
  }

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const result of evaluationResults) {
    truePositives += result.truePositives;
    falsePositives += result.falsePositives;
    falseNegatives += result.falseNegatives;
  }

  const precisionValue = precision(truePositives, falsePositives);
  const recallValue = recall(truePositives, falseNegatives);

  return {
    clipCount: evaluationResults.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: precisionValue,
    recall: recallValue,
    f1: f1Score(precisionValue, recallValue),
  };
}
