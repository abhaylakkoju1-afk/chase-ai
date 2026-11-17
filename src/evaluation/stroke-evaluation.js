// Chase evaluation infrastructure: four-stroke evaluation harness,
// report version chase.stroke-evaluation-report.v0.1 (DRAFT).
//
// Specification: docs/evaluation/STROKE_LABEL_CONTRACT_V0.1.md.
//
// Compares candidate event/cycle outputs (StrokeCandidateSet) with
// expert labels (StrokeLabelSet) and reports, per stroke, per camera
// view and per stroke x view: event errors, coverage, abstentions,
// cycle errors and annotator agreement. It is a pure, deterministic
// function of its inputs: no clock, randomness, I/O, detector calls or
// default tolerances. The same inputs always produce the same report.
//
// It reuses the v0.1 matcher and metric primitives (matching.js,
// metrics.js) unchanged. A report is never evidence of real-world
// accuracy unless its inputs are real expert labels AND the stroke
// validation gate (docs/DECISIONS.md EVAL-1) has been passed; see
// `evidence_status`.

import { matchEvents } from "./matching.js";
import { precision, recall, f1Score, summariseTimingErrorsMs } from "./metrics.js";
import {
  STROKES,
  STROKE_EVENT_TYPES,
  assertValidStrokeLabelSet,
  assertValidStrokeCandidateSet,
} from "./stroke-labels.js";

export const STROKE_EVALUATION_CONFIG_VERSION = "chase.stroke-evaluation-config.v0.1";
export const STROKE_EVALUATION_REPORT_VERSION = "chase.stroke-evaluation-report.v0.1";

export const EVIDENCE_STATUS = Object.freeze({
  NO_DATA: "no_data",
  SYNTHETIC: "synthetic_test_data_not_evidence",
  EXPERT_UNREVIEWED: "expert_labelled_not_validated",
});

const DISCLAIMERS = Object.freeze({
  [EVIDENCE_STATUS.NO_DATA]: "No labelled clips were evaluated. This report says nothing about accuracy.",
  [EVIDENCE_STATUS.SYNTHETIC]:
    "SYNTHETIC TEST DATA. These numbers exercise the harness only and are not evidence of real-world accuracy for any stroke.",
  [EVIDENCE_STATUS.EXPERT_UNREVIEWED]:
    "Expert-labelled inputs, not yet reviewed against the stroke validation gate (docs/DECISIONS.md EVAL-1). Do not treat as validated accuracy.",
});

const ALL_EVENT_TYPES = new Set(STROKES.flatMap((stroke) => Object.keys(STROKE_EVENT_TYPES[stroke])));

// ---------------------------------------------------------------------
// Configuration: every tolerance is explicit. There is no default.
// ---------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string} params.evaluation_version
 * @param {Record<string, number>} params.tolerance_ms_by_event_type
 *   Explicit matching tolerance per event type. Event types not listed
 *   are NOT evaluated (and are listed in the report), never defaulted.
 * @param {number|null} params.cycle_start_tolerance_ms
 *   Explicit tolerance for matching cycle start times, or null to skip
 *   cycle evaluation.
 */
export function createStrokeEvaluationConfig({ evaluation_version, tolerance_ms_by_event_type, cycle_start_tolerance_ms } = {}) {
  if (typeof evaluation_version !== "string" || evaluation_version.trim().length === 0) {
    throw new Error("createStrokeEvaluationConfig: evaluation_version must be a non-empty string");
  }
  if (typeof tolerance_ms_by_event_type !== "object" || tolerance_ms_by_event_type === null || Array.isArray(tolerance_ms_by_event_type)) {
    throw new Error("createStrokeEvaluationConfig: tolerance_ms_by_event_type must be an object of explicit tolerances");
  }
  const tolerances = {};
  for (const eventType of Object.keys(tolerance_ms_by_event_type).sort()) {
    const value = tolerance_ms_by_event_type[eventType];
    if (!ALL_EVENT_TYPES.has(eventType)) {
      throw new Error(`createStrokeEvaluationConfig: unknown event type ${eventType}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`createStrokeEvaluationConfig: tolerance for ${eventType} must be a non-negative finite number`);
    }
    tolerances[eventType] = value;
  }
  if (cycle_start_tolerance_ms === undefined) {
    throw new Error("createStrokeEvaluationConfig: cycle_start_tolerance_ms is required (a number, or null to skip cycles)");
  }
  if (cycle_start_tolerance_ms !== null
      && (typeof cycle_start_tolerance_ms !== "number" || !Number.isFinite(cycle_start_tolerance_ms) || cycle_start_tolerance_ms < 0)) {
    throw new Error("createStrokeEvaluationConfig: cycle_start_tolerance_ms must be a non-negative finite number or null");
  }
  return {
    config_version: STROKE_EVALUATION_CONFIG_VERSION,
    evaluation_version,
    tolerance_ms_by_event_type: tolerances,
    cycle_start_tolerance_ms,
  };
}

// ---------------------------------------------------------------------
// Interval helpers (inclusive bounds)
// ---------------------------------------------------------------------

function insideAny(timeMs, intervals) {
  return intervals.some((interval) => timeMs >= interval.start_ms && timeMs <= interval.end_ms);
}

function overlapsAny(startMs, endMs, intervals) {
  return intervals.some((interval) => startMs <= interval.end_ms && endMs >= interval.start_ms);
}

function mergedIntervals(intervals, durationMs) {
  const sorted = intervals
    .map((i) => ({ start_ms: Math.max(0, i.start_ms), end_ms: Math.min(durationMs, i.end_ms) }))
    .filter((i) => i.end_ms > i.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, interval.end_ms);
    else merged.push({ ...interval });
  }
  return merged;
}

function totalLength(intervals) {
  return intervals.reduce((sum, i) => sum + (i.end_ms - i.start_ms), 0);
}

function intersectionLength(a, b) {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start_ms, y.start_ms);
      const end = Math.min(x.end_ms, y.end_ms);
      if (end > start) total += end - start;
    }
  }
  return total;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------
// Reference selection and annotator agreement
// ---------------------------------------------------------------------

/**
 * Fixed, documented rule: the adjudicator's annotation if there is one;
 * otherwise the only annotation; otherwise null (unresolved
 * disagreement: the clip is not scored, and is counted as such).
 */
export function selectReferenceAnnotation(labelSet) {
  const adjudicated = labelSet.annotations.find((a) => a.annotator.role === "adjudicator");
  if (adjudicated) return { annotation: adjudicated, basis: "adjudicated" };
  if (labelSet.annotations.length === 1) return { annotation: labelSet.annotations[0], basis: "single_annotation" };
  return null;
}

function evaluatedEventKeys(stroke, config) {
  const keys = [];
  for (const eventType of Object.keys(STROKE_EVENT_TYPES[stroke]).sort()) {
    if (config.tolerance_ms_by_event_type[eventType] === undefined) continue;
    for (const side of STROKE_EVENT_TYPES[stroke][eventType]) keys.push({ event_type: eventType, side });
  }
  return keys;
}

function timedEvents(annotation, eventType, side) {
  return annotation.events
    .filter((e) => e.event_type === eventType && e.side === side && e.timestamp_ms !== null)
    .map((e) => e.timestamp_ms)
    .sort((a, b) => a - b);
}

/**
 * Pairwise agreement between every two non-adjudicator annotations of
 * one clip, per evaluated event type and side, using the same explicit
 * tolerances. Events inside either annotation's unusable intervals are
 * left out. Returns [] when fewer than two such annotations exist.
 */
export function computeAnnotatorAgreement(labelSet, config) {
  const annotations = labelSet.annotations
    .filter((a) => a.annotator.role !== "adjudicator")
    .slice()
    .sort((a, b) => compareText(a.annotation_id, b.annotation_id));
  const pairs = [];
  for (let i = 0; i < annotations.length; i++) {
    for (let j = i + 1; j < annotations.length; j++) {
      const a = annotations[i];
      const b = annotations[j];
      const excluded = [...a.unusable_intervals, ...b.unusable_intervals];
      const events = evaluatedEventKeys(labelSet.clip.stroke, config).map(({ event_type, side }) => {
        const timesA = timedEvents(a, event_type, side).filter((t) => !insideAny(t, excluded));
        const timesB = timedEvents(b, event_type, side).filter((t) => !insideAny(t, excluded));
        const match = matchEvents(timesA, timesB, config.tolerance_ms_by_event_type[event_type]);
        return {
          event_type,
          side,
          matched: match.matches.length,
          only_first: match.unmatchedPredictedIndices.length,
          only_second: match.unmatchedGroundTruthIndices.length,
          offsets_ms: match.matches.map((m) => m.offsetMs),
        };
      });
      pairs.push({ first_annotation_id: a.annotation_id, second_annotation_id: b.annotation_id, events });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------
// One clip
// ---------------------------------------------------------------------

function clipShell(labelSet, candidate, status, reference) {
  const { clip } = labelSet;
  return {
    clip_ref: clip.clip_ref,
    label_set_id: labelSet.label_set_id,
    candidate_id: candidate ? candidate.candidate_id : null,
    stroke: clip.stroke,
    view_key: `${clip.camera.view}/${clip.camera.medium}`,
    status,
    reference: reference ? { annotation_id: reference.annotation.annotation_id, basis: reference.basis } : null,
    events: [],
    cycles: null,
    coverage: null,
    annotator_agreement: [],
  };
}

function evaluateEvents(labelSet, reference, candidate, config, unusable, abstentions) {
  const results = [];
  for (const { event_type, side } of evaluatedEventKeys(labelSet.clip.stroke, config)) {
    const tolerance = config.tolerance_ms_by_event_type[event_type];
    const labels = reference.events.filter((e) => e.event_type === event_type && e.side === side);
    const counts = {
      labels_total: labels.length,
      labels_indeterminate: 0,
      labels_in_unusable: 0,
      labels_abstained: 0,
      labels_evaluable: 0,
      labels_uncertain_evaluable: 0,
    };
    const groundTruth = [];
    for (const label of labels) {
      if (label.timestamp_ms === null) counts.labels_indeterminate += 1;
      else if (insideAny(label.timestamp_ms, unusable)) counts.labels_in_unusable += 1;
      else if (insideAny(label.timestamp_ms, abstentions)) counts.labels_abstained += 1;
      else {
        counts.labels_evaluable += 1;
        if (label.certainty === "uncertain") counts.labels_uncertain_evaluable += 1;
        groundTruth.push(label.timestamp_ms);
      }
    }
    groundTruth.sort((a, b) => a - b);

    const predictions = candidate.events
      .filter((e) => e.event_type === event_type && e.side === side)
      .map((e) => e.timestamp_ms)
      .sort((a, b) => a - b);
    const scoredPredictions = predictions.filter((t) => !insideAny(t, unusable));
    const match = matchEvents(scoredPredictions, groundTruth, tolerance);

    results.push({
      event_type,
      side,
      tolerance_ms: tolerance,
      ...counts,
      predictions_total: predictions.length,
      predictions_in_unusable: predictions.length - scoredPredictions.length,
      true_positives: match.matches.length,
      false_positives: match.unmatchedPredictedIndices.length,
      false_negatives: match.unmatchedGroundTruthIndices.length,
      offsets_ms: match.matches.map((m) => m.offsetMs),
    });
  }
  return results;
}

function evaluateCycles(reference, candidate, config, unusable, abstentions) {
  if (config.cycle_start_tolerance_ms === null) return { evaluated: false };
  const eventsById = new Map(reference.events.map((e) => [e.event_id, e]));
  const excluded = [...unusable, ...abstentions];

  const referenceCycles = reference.cycles
    .map((c) => {
      const start = eventsById.get(c.start_event_id);
      const end = eventsById.get(c.end_event_id);
      return { side: start.side, start_ms: start.timestamp_ms, end_ms: end.timestamp_ms };
    });
  const scoredReference = referenceCycles.filter((c) => !overlapsAny(c.start_ms, c.end_ms, excluded));
  const scoredCandidate = candidate.cycles.filter((c) => !overlapsAny(c.start_ms, c.end_ms, excluded));

  const sides = [...new Set([...scoredReference, ...scoredCandidate].map((c) => c.side))].sort(compareText);
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const startOffsets = [];
  const durationErrors = [];
  for (const side of sides) {
    const ref = scoredReference.filter((c) => c.side === side).sort((a, b) => a.start_ms - b.start_ms);
    const cand = scoredCandidate.filter((c) => c.side === side).sort((a, b) => a.start_ms - b.start_ms);
    const match = matchEvents(cand.map((c) => c.start_ms), ref.map((c) => c.start_ms), config.cycle_start_tolerance_ms);
    truePositives += match.matches.length;
    falsePositives += match.unmatchedPredictedIndices.length;
    falseNegatives += match.unmatchedGroundTruthIndices.length;
    for (const m of match.matches) {
      startOffsets.push(m.offsetMs);
      const c = cand[m.predictedIndex];
      const r = ref[m.groundTruthIndex];
      durationErrors.push((c.end_ms - c.start_ms) - (r.end_ms - r.start_ms));
    }
  }
  return {
    evaluated: true,
    tolerance_ms: config.cycle_start_tolerance_ms,
    reference_cycles_total: referenceCycles.length,
    reference_cycles_scored: scoredReference.length,
    candidate_cycles_total: candidate.cycles.length,
    candidate_cycles_scored: scoredCandidate.length,
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    start_offsets_ms: startOffsets,
    duration_errors_ms: durationErrors,
  };
}

function evaluateClipPair(labelSet, candidate, config) {
  const agreement = computeAnnotatorAgreement(labelSet, config);
  if (!candidate) return { ...clipShell(labelSet, null, "missing_candidate", null), annotator_agreement: agreement };
  if (candidate.stroke !== labelSet.clip.stroke) {
    return { ...clipShell(labelSet, candidate, "stroke_mismatch", null), annotator_agreement: agreement };
  }
  const reference = selectReferenceAnnotation(labelSet);
  if (!reference) {
    return { ...clipShell(labelSet, candidate, "unresolved_disagreement", null), annotator_agreement: agreement };
  }

  const durationMs = labelSet.clip.duration_ms;
  const unusable = reference.annotation.unusable_intervals;
  const abstentions = candidate.abstentions;
  const unusableMerged = mergedIntervals(unusable, durationMs);
  const abstainedMerged = mergedIntervals(abstentions, durationMs);
  const usableDuration = durationMs - totalLength(unusableMerged);
  const abstainedUsable = totalLength(abstainedMerged) - intersectionLength(abstainedMerged, unusableMerged);

  return {
    ...clipShell(labelSet, candidate, "evaluated", reference),
    events: evaluateEvents(labelSet, reference.annotation, candidate, config, unusable, abstentions),
    cycles: evaluateCycles(reference.annotation, candidate, config, unusable, abstentions),
    coverage: {
      duration_ms: durationMs,
      usable_duration_ms: usableDuration,
      abstained_usable_duration_ms: abstainedUsable,
    },
    annotator_agreement: agreement,
  };
}

// ---------------------------------------------------------------------
// Aggregation over a group of clip results
// ---------------------------------------------------------------------

function sumEventEntries(entries) {
  const total = {
    labels_total: 0, labels_indeterminate: 0, labels_in_unusable: 0, labels_abstained: 0,
    labels_evaluable: 0, labels_uncertain_evaluable: 0, predictions_total: 0, predictions_in_unusable: 0,
    true_positives: 0, false_positives: 0, false_negatives: 0,
  };
  const offsets = [];
  for (const entry of entries) {
    for (const key of Object.keys(total)) total[key] += entry[key];
    offsets.push(...entry.offsets_ms);
  }
  const p = precision(total.true_positives, total.false_positives);
  const r = recall(total.true_positives, total.false_negatives);
  return {
    ...total,
    precision: p,
    recall: r,
    f1: f1Score(p, r),
    timing_error_ms: summariseTimingErrorsMs(offsets),
    // Share of scoreable labels (not indeterminate, not in unusable
    // intervals) that the candidate abstained on, and its complement.
    abstention_rate: ratio(total.labels_abstained, total.labels_evaluable + total.labels_abstained),
    event_coverage: ratio(total.labels_evaluable, total.labels_evaluable + total.labels_abstained),
  };
}

function summariseGroup(clipResults) {
  const evaluated = clipResults.filter((c) => c.status === "evaluated");
  const eventEntries = evaluated.flatMap((c) => c.events);

  const byEvent = {};
  const eventKeys = [...new Set(eventEntries.map((e) => `${e.event_type}/${e.side}`))].sort(compareText);
  for (const key of eventKeys) {
    byEvent[key] = sumEventEntries(eventEntries.filter((e) => `${e.event_type}/${e.side}` === key));
  }

  const cycleEntries = evaluated.map((c) => c.cycles).filter((c) => c && c.evaluated);
  let cycles = null;
  if (cycleEntries.length > 0) {
    const sum = (key) => cycleEntries.reduce((acc, c) => acc + c[key], 0);
    const tp = sum("true_positives");
    const fp = sum("false_positives");
    const fn = sum("false_negatives");
    const p = precision(tp, fp);
    const r = recall(tp, fn);
    cycles = {
      clips: cycleEntries.length,
      reference_cycles_scored: sum("reference_cycles_scored"),
      candidate_cycles_scored: sum("candidate_cycles_scored"),
      cycle_count_error: sum("candidate_cycles_scored") - sum("reference_cycles_scored"),
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      precision: p,
      recall: r,
      f1: f1Score(p, r),
      start_timing_error_ms: summariseTimingErrorsMs(cycleEntries.flatMap((c) => c.start_offsets_ms)),
      duration_error_ms: summariseTimingErrorsMs(cycleEntries.flatMap((c) => c.duration_errors_ms)),
    };
  }

  const usable = evaluated.reduce((acc, c) => acc + c.coverage.usable_duration_ms, 0);
  const abstained = evaluated.reduce((acc, c) => acc + c.coverage.abstained_usable_duration_ms, 0);

  const agreementEvents = clipResults.flatMap((c) => c.annotator_agreement.flatMap((pair) => pair.events));
  const matched = agreementEvents.reduce((acc, e) => acc + e.matched, 0);
  const unmatched = agreementEvents.reduce((acc, e) => acc + e.only_first + e.only_second, 0);

  return {
    clips: clipResults.length,
    clips_evaluated: evaluated.length,
    clips_missing_candidate: clipResults.filter((c) => c.status === "missing_candidate").length,
    clips_unresolved_disagreement: clipResults.filter((c) => c.status === "unresolved_disagreement").length,
    clips_stroke_mismatch: clipResults.filter((c) => c.status === "stroke_mismatch").length,
    subjects: new Set(clipResults.map((c) => c.subject_ref)).size,
    events: sumEventEntries(eventEntries),
    by_event: byEvent,
    cycles,
    time_coverage: {
      usable_duration_ms: usable,
      abstained_usable_duration_ms: abstained,
      coverage: ratio(usable - abstained, usable),
    },
    annotator_agreement: {
      annotation_pairs: clipResults.reduce((acc, c) => acc + c.annotator_agreement.length, 0),
      matched_events: matched,
      unmatched_events: unmatched,
      agreement_rate: ratio(matched, matched + unmatched),
      offset_ms: summariseTimingErrorsMs(agreementEvents.flatMap((e) => e.offsets_ms)),
    },
  };
}

function groupBy(clipResults, keyOf, keys) {
  const groups = {};
  for (const key of keys) groups[key] = summariseGroup(clipResults.filter((c) => keyOf(c) === key));
  return groups;
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Evaluates every labelled clip against its candidate (matched by
 * clip_ref) and returns a StrokeEvaluationReport. Throws on invalid
 * input, duplicate clip_refs, or a mix of synthetic and expert data.
 */
export function evaluateStrokeCandidates({ labelSets, candidates, config }) {
  if (!Array.isArray(labelSets) || !Array.isArray(candidates)) {
    throw new Error("evaluateStrokeCandidates: labelSets and candidates must be arrays");
  }
  if (!config || config.config_version !== STROKE_EVALUATION_CONFIG_VERSION) {
    throw new Error("evaluateStrokeCandidates: config must come from createStrokeEvaluationConfig()");
  }

  const labelsByClip = new Map();
  for (const labelSet of labelSets) {
    assertValidStrokeLabelSet(labelSet);
    const clipRef = labelSet.clip.clip_ref;
    if (labelsByClip.has(clipRef)) throw new Error(`evaluateStrokeCandidates: duplicate label set for clip ${clipRef}`);
    labelsByClip.set(clipRef, labelSet);
  }
  const candidatesByClip = new Map();
  for (const candidate of candidates) {
    const labelled = labelsByClip.get(candidate?.clip_ref);
    assertValidStrokeCandidateSet(candidate, { durationMs: labelled ? labelled.clip.duration_ms : null });
    if (candidatesByClip.has(candidate.clip_ref)) {
      throw new Error(`evaluateStrokeCandidates: duplicate candidate set for clip ${candidate.clip_ref}`);
    }
    candidatesByClip.set(candidate.clip_ref, candidate);
  }

  const statuses = new Set([...labelSets, ...candidates].map((x) => x.data_status));
  if (statuses.has("synthetic") && statuses.has("expert_labelled")) {
    throw new Error("evaluateStrokeCandidates: synthetic and expert-labelled data must never be evaluated together");
  }
  const evidenceStatus = labelSets.length === 0
    ? EVIDENCE_STATUS.NO_DATA
    : statuses.has("synthetic") ? EVIDENCE_STATUS.SYNTHETIC : EVIDENCE_STATUS.EXPERT_UNREVIEWED;

  const clipRefs = [...labelsByClip.keys()].sort(compareText);
  const clipResults = clipRefs.map((clipRef) => {
    const labelSet = labelsByClip.get(clipRef);
    return { ...evaluateClipPair(labelSet, candidatesByClip.get(clipRef) || null, config), subject_ref: labelSet.clip.subject_ref };
  });

  const viewKeys = [...new Set(clipResults.map((c) => c.view_key))].sort(compareText);
  const strokeViewKeys = [...new Set(clipResults.map((c) => `${c.stroke}|${c.view_key}`))].sort(compareText);
  const evaluatedTypes = new Set(Object.keys(config.tolerance_ms_by_event_type));

  return {
    report_version: STROKE_EVALUATION_REPORT_VERSION,
    evaluation_version: config.evaluation_version,
    evidence_status: evidenceStatus,
    disclaimer: DISCLAIMERS[evidenceStatus],
    config,
    inputs: {
      label_set_ids: labelSets.map((l) => l.label_set_id).sort(compareText),
      candidate_ids: candidates.map((c) => c.candidate_id).sort(compareText),
      candidates_without_labels: [...candidatesByClip.keys()].filter((ref) => !labelsByClip.has(ref)).sort(compareText),
      event_types_not_evaluated: [...ALL_EVENT_TYPES].filter((t) => !evaluatedTypes.has(t)).sort(compareText),
    },
    overall: summariseGroup(clipResults),
    // Every stroke is always present, so a stroke with no labelled
    // clips shows clips: 0 and null metrics instead of disappearing.
    by_stroke: groupBy(clipResults, (c) => c.stroke, STROKES),
    by_view: groupBy(clipResults, (c) => c.view_key, viewKeys),
    by_stroke_and_view: groupBy(clipResults, (c) => `${c.stroke}|${c.view_key}`, strokeViewKeys),
    clips: clipResults,
  };
}
