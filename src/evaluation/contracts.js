// Chase evaluation infrastructure — data contracts.
//
// This is a plain ES module (unlike src/chase-engine/*.js, which are
// classic scripts loaded into index.html's global scope). Nothing here
// is loaded by the browser app. It exists only to be imported by Node
// evaluation code and Node tests, per docs/evaluation's independence
// requirement from the DOM/MediaPipe/Firebase/UI.
//
// These are PROPOSED EVALUATION CONTRACTS, distinct from the production
// pipeline contracts in docs/ARCHITECTURE.md §2.4 (PoseFrame,
// TrackedSequence, StrokePhaseLabel, StrokeCycle, BiomechMeasurement,
// TechniqueReport, CoachingObservation). This file does not define,
// redefine, or depend on any of those. A "ground-truth cycle" here is a
// human-annotation record per Annotation Protocol v0.1, not the
// production StrokeCycle contract.
//
// Every factory below performs minimal shape validation (required
// fields present) and returns a plain, JSON-serializable object — never
// a class instance — so results can be written to disk or compared with
// deepStrictEqual without ceremony. None of these factories know how to
// score, compare, or judge anything; see matching.js and metrics.js for
// that.

function requireFields(obj, fields, contractName) {
  const missing = fields.filter((field) => obj[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${contractName}: missing required field(s): ${missing.join(", ")}`
    );
  }
}

// ---------------------------------------------------------------------
// 1. Evaluation clip metadata
// ---------------------------------------------------------------------
//
// Describes one clip in the evaluation dataset. Matches the metadata
// fields identified during pilot-selection planning (clip_id,
// swimmer_id, stroke, camera_view, duration, consent_status,
// annotation_status, benchmark_inclusion_status), plus optional
// characteristics. No field here implies anything about who the
// swimmer is beyond the opaque swimmer_id.
export function createClipMetadata({
  clip_id,
  swimmer_id,
  stroke,
  camera_view,
  duration_ms,
  consent_status,
  annotation_status,
  benchmark_inclusion_status,
  pilot_condition_tag = null,
  fps = null,
  resolution = null,
  lighting = null,
  splash_occlusion_level = null,
  camera_movement = null,
  notes = null,
} = {}) {
  const record = {
    clip_id,
    swimmer_id,
    stroke,
    camera_view,
    duration_ms,
    consent_status,
    annotation_status,
    benchmark_inclusion_status,
    pilot_condition_tag,
    fps,
    resolution,
    lighting,
    splash_occlusion_level,
    camera_movement,
    notes,
  };
  requireFields(
    record,
    [
      "clip_id",
      "swimmer_id",
      "stroke",
      "camera_view",
      "duration_ms",
      "consent_status",
      "annotation_status",
      "benchmark_inclusion_status",
    ],
    "createClipMetadata"
  );
  return record;
}

// ---------------------------------------------------------------------
// 2. Human annotation / ground truth
// ---------------------------------------------------------------------
//
// One annotated event, matching Annotation Protocol v0.1 §8's per-event
// field list exactly. `unusable_interval` is a reference to an excluded
// interval (or null if this event is not inside one) rather than a
// boolean, so the interval's own start/end/reason can be looked up.
export function createGroundTruthEvent({
  clip_id,
  swimmer_id,
  stroke,
  event_type,
  timestamp_ms,
  confidence,
  ambiguous,
  unusable_interval = null,
  annotator_id,
  protocol_version,
} = {}) {
  const record = {
    clip_id,
    swimmer_id,
    stroke,
    event_type,
    timestamp_ms,
    confidence,
    ambiguous,
    unusable_interval,
    annotator_id,
    protocol_version,
  };
  requireFields(
    record,
    [
      "clip_id",
      "swimmer_id",
      "stroke",
      "event_type",
      "annotator_id",
      "protocol_version",
    ],
    "createGroundTruthEvent"
  );
  // timestamp_ms and confidence/ambiguous are intentionally NOT in the
  // required list above: Protocol §9 explicitly allows an annotator to
  // omit a timestamp for a genuinely indeterminate event, and to record
  // only a plausible range instead. A ground-truth event with no
  // timestamp is a valid, expected record — not a malformed one.
  return record;
}

// A ground-truth cycle is a pairing of two same-type ground-truth
// events (ANNOTATION_PROTOCOL_V0.1.md §8) — it does not carry its own
// timestamp data, only references to the two event records that bound
// it. This is NOT the production StrokeCycle contract.
export function createGroundTruthCycle({ cycle_id, start_event, end_event } = {}) {
  const record = { cycle_id, start_event, end_event };
  requireFields(record, ["cycle_id", "start_event", "end_event"], "createGroundTruthCycle");
  return record;
}

// ---------------------------------------------------------------------
// 3. Detector predictions
// ---------------------------------------------------------------------
//
// A DetectorPrediction is a record-keeping wrapper around plain
// predicted timestamps for one clip/event type — metadata for
// reproducibility (Protocol §17), not something the matcher needs to
// understand. matching.js operates on `timestamps_ms` alone (or on
// bare arrays passed directly) and has no knowledge of `source` or
// `detector_commit`. This function does not call, import, or depend on
// chaseDetectFreestyleCycles or any other detector — the timestamps are
// supplied externally, by whatever produced them.
export function createDetectorPrediction({
  clip_id,
  event_type,
  timestamps_ms,
  detector_commit,
  source,
  notes = null,
} = {}) {
  const record = { clip_id, event_type, timestamps_ms, detector_commit, source, notes };
  requireFields(
    record,
    ["clip_id", "event_type", "timestamps_ms", "detector_commit", "source"],
    "createDetectorPrediction"
  );
  if (!Array.isArray(timestamps_ms)) {
    throw new Error("createDetectorPrediction: timestamps_ms must be an array");
  }
  return record;
}

// ---------------------------------------------------------------------
// 4. Evaluation configuration
// ---------------------------------------------------------------------
//
// IMPORTANT: matching_tolerance_ms has NO default value anywhere in
// this module. There is currently no approved benchmark tolerance
// (ANNOTATION_PROTOCOL_V0.1.md §14) — a caller must supply an explicit
// value every time, so it is structurally impossible to silently fall
// back to an unstated project-wide default. Synthetic tests must pass
// an obviously-fake value (see test/evaluation/fixtures.js) — never a
// bare number that could be mistaken for a considered choice.
export function createEvaluationConfig({
  dataset_version,
  annotation_version,
  evaluation_version,
  detector_commit,
  event_type,
  matching_tolerance_ms,
  notes = null,
} = {}) {
  const record = {
    dataset_version,
    annotation_version,
    evaluation_version,
    detector_commit,
    event_type,
    matching_tolerance_ms,
    notes,
  };
  requireFields(
    record,
    [
      "dataset_version",
      "annotation_version",
      "evaluation_version",
      "detector_commit",
      "event_type",
      "matching_tolerance_ms",
    ],
    "createEvaluationConfig"
  );
  if (typeof matching_tolerance_ms !== "number" || !Number.isFinite(matching_tolerance_ms) || matching_tolerance_ms < 0) {
    throw new Error(
      "createEvaluationConfig: matching_tolerance_ms must be a non-negative finite number, " +
      "supplied explicitly by the caller — there is no default."
    );
  }
  return record;
}

// ---------------------------------------------------------------------
// 5. Evaluation result
// ---------------------------------------------------------------------
//
// The output of running the matcher + metrics for one clip/config
// combination. Deliberately holds each metric as its own named field —
// no combined/weighted score field exists, and none should be added
// here without a separate, explicit decision.
export function createEvaluationResult({
  clip_id,
  config,
  matches,
  unmatchedPredictedIndices,
  unmatchedGroundTruthIndices,
  truePositives,
  falsePositives,
  falseNegatives,
  precision,
  recall,
  f1,
  boundaryTimingErrorsMs,
} = {}) {
  const record = {
    clip_id,
    config,
    matches,
    unmatchedPredictedIndices,
    unmatchedGroundTruthIndices,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    boundaryTimingErrorsMs,
  };
  requireFields(
    record,
    [
      "clip_id",
      "config",
      "matches",
      "unmatchedPredictedIndices",
      "unmatchedGroundTruthIndices",
      "truePositives",
      "falsePositives",
      "falseNegatives",
    ],
    "createEvaluationResult"
  );
  return record;
}

// ---------------------------------------------------------------------
// 6. Experiment metadata
// ---------------------------------------------------------------------
//
// A reproducibility record: exactly the version tuple Protocol §17
// requires, plus whatever configuration/metrics/notes describe one
// evaluation run. This function only shapes and validates the record —
// it does not write it anywhere. No persistence/database is implied or
// provided.
export function createExperiment({
  experiment_id,
  dataset_version,
  annotation_version,
  evaluation_version,
  detector_commit,
  configuration,
  metrics,
  notes = null,
  created_at = null,
} = {}) {
  const record = {
    experiment_id,
    dataset_version,
    annotation_version,
    evaluation_version,
    detector_commit,
    configuration,
    metrics,
    notes,
    created_at,
  };
  requireFields(
    record,
    [
      "experiment_id",
      "dataset_version",
      "annotation_version",
      "evaluation_version",
      "detector_commit",
      "configuration",
      "metrics",
    ],
    "createExperiment"
  );
  return record;
}
