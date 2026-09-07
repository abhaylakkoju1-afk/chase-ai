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

// ---------------------------------------------------------------------
// 7. Experiment run (additive — does NOT replace or modify createExperiment())
// ---------------------------------------------------------------------
//
// createExperiment() above is left exactly as merged. This is a
// separate, forward-looking contract for the same underlying idea —
// one run of the evaluator over a dataset — structured to avoid a
// problem createExperiment() has: it re-declares dataset_version,
// annotation_version, evaluation_version, and detector_commit as its
// own top-level fields, duplicating whatever those same four values
// already are on the EvaluationConfig that was actually used. Two
// copies of the same fact with nothing enforcing they agree is exactly
// the kind of drift Protocol §17's reproducibility requirement exists
// to prevent.
//
// createExperimentRun() instead holds ONE EvaluationConfig object
// (createEvaluationConfig()) as `config` — the version tuple lives
// there, once, and is read from there. It does not re-accept
// dataset_version/annotation_version/evaluation_version/detector_commit/
// event_type/matching_tolerance_ms as parameters of its own; passing
// them here would do nothing, since they are not part of this
// function's destructured parameters — the single source of truth is
// `config`.
//
// A run spans a DATASET (potentially many clips), not one clip:
// `results` holds one EvaluationResult (createEvaluationResult() /
// evaluateClip()) per clip evaluated in this run. This factory does
// not compute anything — see aggregate.js for the pure run-level
// rollup of `results`.
//
// No ID or timestamp is generated here. `experiment_id` and
// `created_at` must both be supplied by the caller, keeping this
// factory a pure, deterministic function of its inputs — the same
// inputs always produce the same record, regardless of when it is
// called.
export function createExperimentRun({
  experiment_id,
  config,
  results,
  created_at,
  notes = null,
} = {}) {
  const record = { experiment_id, config, results, created_at, notes };

  requireFields(record, ["experiment_id", "config", "results", "created_at"], "createExperimentRun");

  if (typeof experiment_id !== "string" || experiment_id.trim().length === 0) {
    throw new Error("createExperimentRun: experiment_id must be a non-empty string");
  }
  if (typeof config !== "object" || config === null) {
    throw new Error("createExperimentRun: config must be an EvaluationConfig object (see createEvaluationConfig)");
  }
  if (!Array.isArray(results)) {
    throw new Error("createExperimentRun: results must be an array of EvaluationResult objects");
  }
  if (!isValidIso8601Timestamp(created_at)) {
    throw new Error(
      "createExperimentRun: created_at must be a caller-supplied, valid ISO-8601 timestamp string " +
      "(e.g. new Date().toISOString() -> \"2026-09-07T00:00:00.000Z\") — it is never generated " +
      "internally by this factory."
    );
  }

  return record;
}

// Validates that `value` is a real, parseable ISO-8601 timestamp — not
// just "some non-empty string". Deliberately dependency-free: a value
// round-trips only if `new Date(value)` parses to a real instant AND
// re-serializing that instant via the platform's own `toISOString()`
// reproduces the exact input string. This rejects "not-a-date" and
// other non-date text (Date.parse yields NaN), rejects "" (caught by
// the same NaN check), and rejects strings that merely look date-ish
// but aren't the canonical extended format `toISOString()` produces
// (e.g. a bare "2026-09-07" round-trips to
// "2026-09-07T00:00:00.000Z", not to itself, so it is rejected as a
// *timestamp* — the field the caller must supply is a moment in time,
// not a calendar date). It accepts exactly the format
// `new Date().toISOString()` already produces, which is what every
// caller in this codebase is expected to pass.
function isValidIso8601Timestamp(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString() === value;
}
