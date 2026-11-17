// Chase evaluation infrastructure: four-stroke label and candidate
// contracts, version chase.stroke-labels.v0.1 (DRAFT).
//
// Specification: docs/evaluation/STROKE_LABEL_CONTRACT_V0.1.md.
//
// Plain ES module for Node evaluation code and tests only. Nothing here
// is loaded by index.html, and nothing here calls a detector, MediaPipe,
// the DOM, storage, or the network. It is additive: it does not replace
// or change src/evaluation/contracts.js (the freestyle pilot contracts
// for Annotation Protocol v0.1).
//
// Privacy by construction (CLAUDE.md §13-§14):
//   - Records carry no video, frames, file paths, URLs, names, ages,
//     dates of birth, or free-text fields. Validation rejects any field
//     not in this contract, so such data cannot be added by accident.
//   - Clip, subject, annotator and label-set references must be short
//     opaque codes (OPAQUE_REF_PATTERN). Any mapping from a code to a
//     real person or file must live outside this repository.
//   - data_status "synthetic" requires every reference to start with
//     "SYNTHETIC-", and "expert_labelled" forbids that prefix, so test
//     data and real labels cannot be mixed up silently.
//
// The event and phase vocabulary below is PROVISIONAL. It is drawn from
// the owner-provided Elite Competitive Swimming research paper
// (Chapters 2-5, 9, 15 and 17) to make labels comparable, not to assert
// that these events are reliably observable or that any detector finds
// them. Operational definitions must be fixed per stroke in an approved
// annotation protocol before real labelling (see the contract doc).

export const STROKE_LABEL_SCHEMA_VERSION = "chase.stroke-labels.v0.1";
export const STROKE_CANDIDATE_SCHEMA_VERSION = "chase.stroke-candidates.v0.1";

export const STROKES = Object.freeze(["freestyle", "backstroke", "butterfly", "breaststroke"]);

export const DATA_STATUSES = Object.freeze(["synthetic", "expert_labelled"]);

export const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SYNTHETIC_REF_PREFIX = "SYNTHETIC-";

const ALTERNATING = Object.freeze(["left", "right"]);
const BILATERAL = Object.freeze(["both"]);
const WHOLE_BODY = Object.freeze(["none"]);
const ANY_TOUCH = Object.freeze(["left", "right", "both"]);

// Allowed sides per event type, per stroke. "both" marks a simultaneous
// bilateral action; "none" marks a head or whole-body event.
export const STROKE_EVENT_TYPES = Object.freeze({
  freestyle: Object.freeze({
    hand_entry: ALTERNATING,
    hand_exit: ALTERNATING,
    breath_start: ALTERNATING, // side = breathing side
    wrist_height_minimum: WHOLE_BODY, // the current freestyle detector's event (Protocol v0.1 §6B)
    wall_touch: ANY_TOUCH,
  }),
  backstroke: Object.freeze({
    hand_entry: ALTERNATING,
    hand_exit: ALTERNATING,
    wall_touch: ANY_TOUCH,
  }),
  butterfly: Object.freeze({
    hand_entry: BILATERAL,
    hand_exit: BILATERAL,
    kick_1_downbeat: BILATERAL,
    kick_2_downbeat: BILATERAL,
    breath_start: WHOLE_BODY,
    wall_touch: BILATERAL,
  }),
  breaststroke: Object.freeze({
    arm_outsweep_start: BILATERAL,
    arm_insweep_start: BILATERAL,
    head_emergence: WHOLE_BODY,
    leg_recovery_start: BILATERAL,
    kick_propulsion_start: BILATERAL,
    glide_start: BILATERAL,
    wall_touch: BILATERAL,
  }),
});

// Allowed sides per phase label, per stroke (labelled as time intervals).
export const STROKE_PHASE_LABELS = Object.freeze({
  freestyle: Object.freeze({
    entry_extension: ALTERNATING,
    catch: ALTERNATING,
    pull: ALTERNATING,
    push: ALTERNATING,
    recovery: ALTERNATING,
  }),
  backstroke: Object.freeze({
    entry_extension: ALTERNATING,
    catch: ALTERNATING,
    pull: ALTERNATING,
    push: ALTERNATING,
    recovery: ALTERNATING,
  }),
  butterfly: Object.freeze({
    entry: BILATERAL,
    catch_pull: BILATERAL,
    push: BILATERAL,
    recovery: BILATERAL,
  }),
  breaststroke: Object.freeze({
    outsweep_catch: BILATERAL,
    insweep_breath: BILATERAL,
    kick_propulsion: BILATERAL,
    glide: BILATERAL,
  }),
});

export const CAMERA_VIEWS = Object.freeze(["side", "front", "front_oblique", "end_on", "overhead", "other"]);
export const CAMERA_MEDIA = Object.freeze(["above_water", "underwater", "split_waterline"]);
export const CAMERA_PLACEMENTS = Object.freeze(["pool_deck", "end_wall", "in_water", "elevated", "unknown"]);
export const CAMERA_SIDES = Object.freeze(["swimmer_left", "swimmer_right", "head_on", "behind", "above", "unknown"]);
export const CAMERA_MOTIONS = Object.freeze(["static", "panning", "tracking", "handheld", "unknown"]);
export const POOL_COURSES = Object.freeze(["SCM", "SCY", "LCM", "unknown"]);
export const RACE_SEGMENTS = Object.freeze([
  "start", "underwater", "breakout", "clean_swim", "approach", "turn", "post_turn", "finish", "drill", "unknown",
]);
export const PACES = Object.freeze(["easy", "moderate", "threshold", "race_pace", "sprint", "unknown"]);
export const ANNOTATOR_ROLES = Object.freeze(["coach", "biomechanist", "trained_annotator", "adjudicator"]);
export const CERTAINTIES = Object.freeze(["certain", "probable", "uncertain"]);
export const VISIBILITY_STATUSES = Object.freeze(["visible", "partially_occluded", "occluded", "out_of_frame"]);
export const UNUSABLE_REASONS = Object.freeze([
  "occlusion", "out_of_frame", "splash_or_bubbles", "camera_motion", "identity_uncertain", "low_light", "other",
]);
export const CANDIDATE_SOURCE_KINDS = Object.freeze(["detector", "baseline", "synthetic"]);
export const ABSTENTION_REASONS = Object.freeze([
  "low_confidence", "occlusion", "view_unsupported", "stroke_uncertain", "identity_uncertain", "integrity_withheld", "other",
]);

// MediaPipe Pose landmark names (33), for occlusion records.
export const POSE_LANDMARK_NAMES = Object.freeze([
  "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
  "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow",
  "right_elbow", "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index",
  "left_thumb", "right_thumb", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
  "left_heel", "right_heel", "left_foot_index", "right_foot_index",
]);

// Nominal pool lengths in metres; 25 yd = 22.86 m.
const COURSE_LENGTH_M = Object.freeze({ SCM: 25, SCY: 22.86, LCM: 50 });

// ---------------------------------------------------------------------
// Small validation helpers. Each records "path: message" strings into
// `errors` (deterministic order: the order fields are checked).
// ---------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function checkObject(value, path, required, optional, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: field is not part of the contract`);
  }
  for (const key of required) {
    if (value[key] === undefined) errors.push(`${path}.${key}: required`);
  }
  return true;
}

function checkEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) errors.push(`${path}: must be one of ${allowed.join(", ")}`);
}

function checkRef(value, path, dataStatus, errors) {
  if (typeof value !== "string" || !OPAQUE_REF_PATTERN.test(value)) {
    errors.push(`${path}: must be an opaque code (letters, digits, "_" or "-", max 64 chars)`);
    return;
  }
  const synthetic = value.startsWith(SYNTHETIC_REF_PREFIX);
  if (dataStatus === "synthetic" && !synthetic) {
    errors.push(`${path}: synthetic data must use the ${SYNTHETIC_REF_PREFIX} prefix`);
  }
  if (dataStatus === "expert_labelled" && synthetic) {
    errors.push(`${path}: expert-labelled data must not use the ${SYNTHETIC_REF_PREFIX} prefix`);
  }
}

function checkNonNegative(value, path, errors, { nullable = false, integer = false, positive = false } = {}) {
  if (nullable && value === null) return;
  if (!isFiniteNumber(value) || value < 0 || (positive && value === 0) || (integer && !Number.isInteger(value))) {
    errors.push(`${path}: must be a ${positive ? "positive" : "non-negative"} ${integer ? "integer" : "finite number"}${nullable ? " or null" : ""}`);
  }
}

function checkNonEmptyString(value, path, errors) {
  if (typeof value !== "string" || value.trim().length === 0) errors.push(`${path}: must be a non-empty string`);
}

function checkInterval(value, path, durationMs, errors) {
  if (!checkObject(value, path, ["start_ms", "end_ms"], [], errors)) return false;
  const { start_ms, end_ms } = value;
  if (!isFiniteNumber(start_ms) || !isFiniteNumber(end_ms) || start_ms < 0 || end_ms < start_ms) {
    errors.push(`${path}: needs finite 0 <= start_ms <= end_ms`);
    return false;
  }
  if (isFiniteNumber(durationMs) && end_ms > durationMs) {
    errors.push(`${path}: end_ms is beyond the clip duration`);
    return false;
  }
  return true;
}

function checkTimeInClip(value, path, durationMs, errors) {
  if (!isFiniteNumber(value) || value < 0) {
    errors.push(`${path}: must be a non-negative finite number`);
    return false;
  }
  if (isFiniteNumber(durationMs) && value > durationMs) {
    errors.push(`${path}: is beyond the clip duration`);
    return false;
  }
  return true;
}

function checkSide(stroke, table, type, side, path, errors) {
  const sides = table[stroke]?.[type];
  if (!sides) return;
  if (!sides.includes(side)) errors.push(`${path}: side for ${type} in ${stroke} must be one of ${sides.join(", ")}`);
}

function checkUniqueIds(items, idField, path, errors) {
  const seen = new Set();
  items.forEach((item, index) => {
    const id = isPlainObject(item) ? item[idField] : undefined;
    if (typeof id !== "string") return;
    if (seen.has(id)) errors.push(`${path}[${index}].${idField}: duplicate id ${id}`);
    seen.add(id);
  });
}

function checkArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// Clip context
// ---------------------------------------------------------------------

function validateClip(clip, dataStatus, errors) {
  const path = "clip";
  if (!checkObject(clip, path, ["clip_ref", "subject_ref", "stroke", "duration_ms", "frame_rate_fps", "camera", "pool", "segment"], [], errors)) {
    return null;
  }
  checkRef(clip.clip_ref, `${path}.clip_ref`, dataStatus, errors);
  checkRef(clip.subject_ref, `${path}.subject_ref`, dataStatus, errors);
  checkEnum(clip.stroke, STROKES, `${path}.stroke`, errors);
  checkNonNegative(clip.duration_ms, `${path}.duration_ms`, errors, { positive: true });
  checkNonNegative(clip.frame_rate_fps, `${path}.frame_rate_fps`, errors, { positive: true });

  const camera = clip.camera;
  if (checkObject(camera, `${path}.camera`, ["view", "medium", "placement", "side", "motion", "distance_m"], [], errors)) {
    checkEnum(camera.view, CAMERA_VIEWS, `${path}.camera.view`, errors);
    checkEnum(camera.medium, CAMERA_MEDIA, `${path}.camera.medium`, errors);
    checkEnum(camera.placement, CAMERA_PLACEMENTS, `${path}.camera.placement`, errors);
    checkEnum(camera.side, CAMERA_SIDES, `${path}.camera.side`, errors);
    checkEnum(camera.motion, CAMERA_MOTIONS, `${path}.camera.motion`, errors);
    checkNonNegative(camera.distance_m, `${path}.camera.distance_m`, errors, { nullable: true });
  }

  const pool = clip.pool;
  if (checkObject(pool, `${path}.pool`, ["course", "pool_length_m"], [], errors)) {
    checkEnum(pool.course, POOL_COURSES, `${path}.pool.course`, errors);
    checkNonNegative(pool.pool_length_m, `${path}.pool.pool_length_m`, errors, { nullable: true, positive: true });
    const nominal = COURSE_LENGTH_M[pool.course];
    if (nominal !== undefined && isFiniteNumber(pool.pool_length_m) && Math.abs(pool.pool_length_m - nominal) > 0.01) {
      errors.push(`${path}.pool.pool_length_m: does not match course ${pool.course} (${nominal} m)`);
    }
  }

  const segment = clip.segment;
  if (checkObject(segment, `${path}.segment`, ["race_segment", "pace", "event_distance_m", "lap_index"], [], errors)) {
    checkEnum(segment.race_segment, RACE_SEGMENTS, `${path}.segment.race_segment`, errors);
    checkEnum(segment.pace, PACES, `${path}.segment.pace`, errors);
    checkNonNegative(segment.event_distance_m, `${path}.segment.event_distance_m`, errors, { nullable: true, positive: true });
    checkNonNegative(segment.lap_index, `${path}.segment.lap_index`, errors, { nullable: true, integer: true });
  }

  return STROKES.includes(clip.stroke) && isFiniteNumber(clip.duration_ms) ? clip : null;
}

// ---------------------------------------------------------------------
// One annotator's pass over the clip
// ---------------------------------------------------------------------

function validateVisibility(visibility, path, errors) {
  if (!checkObject(visibility, path, ["status", "occluded_landmarks"], [], errors)) return;
  checkEnum(visibility.status, VISIBILITY_STATUSES, `${path}.status`, errors);
  if (!checkArray(visibility.occluded_landmarks, `${path}.occluded_landmarks`, errors)) return;
  const seen = new Set();
  visibility.occluded_landmarks.forEach((name, index) => {
    if (!POSE_LANDMARK_NAMES.includes(name)) errors.push(`${path}.occluded_landmarks[${index}]: unknown landmark`);
    if (seen.has(name)) errors.push(`${path}.occluded_landmarks[${index}]: duplicate landmark`);
    seen.add(name);
  });
  if (visibility.status === "visible" && visibility.occluded_landmarks.length > 0) {
    errors.push(`${path}: a "visible" label cannot list occluded landmarks`);
  }
}

function validateEvent(event, path, stroke, durationMs, errors) {
  if (!checkObject(event, path, ["event_id", "event_type", "side", "timestamp_ms", "timestamp_range_ms", "certainty", "visibility"], [], errors)) {
    return;
  }
  if (typeof event.event_id !== "string" || !OPAQUE_REF_PATTERN.test(event.event_id)) {
    errors.push(`${path}.event_id: must be an opaque code`);
  }
  if (stroke && !STROKE_EVENT_TYPES[stroke][event.event_type]) {
    errors.push(`${path}.event_type: ${String(event.event_type)} is not an event type for ${stroke}`);
  }
  if (stroke) checkSide(stroke, STROKE_EVENT_TYPES, event.event_type, event.side, `${path}.side`, errors);
  checkEnum(event.certainty, CERTAINTIES, `${path}.certainty`, errors);
  validateVisibility(event.visibility, `${path}.visibility`, errors);

  const timed = event.timestamp_ms !== null;
  if (timed) checkTimeInClip(event.timestamp_ms, `${path}.timestamp_ms`, durationMs, errors);
  if (event.timestamp_range_ms !== null) {
    const ok = checkInterval(event.timestamp_range_ms, `${path}.timestamp_range_ms`, durationMs, errors);
    if (ok && timed && isFiniteNumber(event.timestamp_ms)
        && (event.timestamp_ms < event.timestamp_range_ms.start_ms || event.timestamp_ms > event.timestamp_range_ms.end_ms)) {
      errors.push(`${path}.timestamp_ms: lies outside its timestamp_range_ms`);
    }
  }
  // An event with no point timestamp is a valid "indeterminate" label
  // (Protocol v0.1 §9), but it cannot also claim to be certain.
  if (!timed && event.certainty === "certain") {
    errors.push(`${path}.certainty: an event with no timestamp_ms cannot be "certain"`);
  }
}

function validatePhase(phase, path, stroke, durationMs, errors) {
  if (!checkObject(phase, path, ["phase_id", "phase_label", "side", "start_ms", "end_ms", "certainty"], [], errors)) return;
  if (typeof phase.phase_id !== "string" || !OPAQUE_REF_PATTERN.test(phase.phase_id)) {
    errors.push(`${path}.phase_id: must be an opaque code`);
  }
  if (stroke && !STROKE_PHASE_LABELS[stroke][phase.phase_label]) {
    errors.push(`${path}.phase_label: ${String(phase.phase_label)} is not a phase label for ${stroke}`);
  }
  if (stroke) checkSide(stroke, STROKE_PHASE_LABELS, phase.phase_label, phase.side, `${path}.side`, errors);
  checkEnum(phase.certainty, CERTAINTIES, `${path}.certainty`, errors);
  checkInterval({ start_ms: phase.start_ms, end_ms: phase.end_ms }, path, durationMs, errors);
  if (isFiniteNumber(phase.start_ms) && isFiniteNumber(phase.end_ms) && phase.end_ms === phase.start_ms) {
    errors.push(`${path}: a phase must have end_ms > start_ms`);
  }
}

function validateCycle(cycle, path, eventsById, errors) {
  if (!checkObject(cycle, path, ["cycle_id", "start_event_id", "end_event_id"], [], errors)) return;
  if (typeof cycle.cycle_id !== "string" || !OPAQUE_REF_PATTERN.test(cycle.cycle_id)) {
    errors.push(`${path}.cycle_id: must be an opaque code`);
  }
  const start = eventsById.get(cycle.start_event_id);
  const end = eventsById.get(cycle.end_event_id);
  if (!start) errors.push(`${path}.start_event_id: does not reference an event in this annotation`);
  if (!end) errors.push(`${path}.end_event_id: does not reference an event in this annotation`);
  if (!start || !end) return;
  if (start.event_type !== end.event_type || start.side !== end.side) {
    errors.push(`${path}: start and end events must share event_type and side`);
  }
  if (!isFiniteNumber(start.timestamp_ms) || !isFiniteNumber(end.timestamp_ms)) {
    errors.push(`${path}: both boundary events need a timestamp_ms`);
  } else if (end.timestamp_ms <= start.timestamp_ms) {
    errors.push(`${path}: end event must be later than start event`);
  }
}

function validateAnnotation(annotation, path, clip, dataStatus, errors) {
  const required = ["annotation_id", "annotator", "protocol_version", "events", "phases", "cycles", "unusable_intervals"];
  if (!checkObject(annotation, path, required, [], errors)) return;
  checkRef(annotation.annotation_id, `${path}.annotation_id`, dataStatus, errors);
  checkNonEmptyString(annotation.protocol_version, `${path}.protocol_version`, errors);

  const annotator = annotation.annotator;
  if (checkObject(annotator, `${path}.annotator`, ["annotator_ref", "role", "blinded_to_candidates"], [], errors)) {
    checkRef(annotator.annotator_ref, `${path}.annotator.annotator_ref`, dataStatus, errors);
    checkEnum(annotator.role, ANNOTATOR_ROLES, `${path}.annotator.role`, errors);
    if (typeof annotator.blinded_to_candidates !== "boolean") {
      errors.push(`${path}.annotator.blinded_to_candidates: must be a boolean`);
    }
  }

  const stroke = clip ? clip.stroke : null;
  const durationMs = clip ? clip.duration_ms : null;
  const eventsById = new Map();

  if (checkArray(annotation.events, `${path}.events`, errors)) {
    annotation.events.forEach((event, index) => {
      validateEvent(event, `${path}.events[${index}]`, stroke, durationMs, errors);
      if (isPlainObject(event) && typeof event.event_id === "string" && !eventsById.has(event.event_id)) {
        eventsById.set(event.event_id, event);
      }
    });
    checkUniqueIds(annotation.events, "event_id", `${path}.events`, errors);
  }
  if (checkArray(annotation.phases, `${path}.phases`, errors)) {
    annotation.phases.forEach((phase, index) => validatePhase(phase, `${path}.phases[${index}]`, stroke, durationMs, errors));
    checkUniqueIds(annotation.phases, "phase_id", `${path}.phases`, errors);
  }
  if (checkArray(annotation.cycles, `${path}.cycles`, errors)) {
    annotation.cycles.forEach((cycle, index) => validateCycle(cycle, `${path}.cycles[${index}]`, eventsById, errors));
    checkUniqueIds(annotation.cycles, "cycle_id", `${path}.cycles`, errors);
  }
  if (checkArray(annotation.unusable_intervals, `${path}.unusable_intervals`, errors)) {
    annotation.unusable_intervals.forEach((interval, index) => {
      const intervalPath = `${path}.unusable_intervals[${index}]`;
      if (!checkObject(interval, intervalPath, ["start_ms", "end_ms", "reason"], [], errors)) return;
      checkEnum(interval.reason, UNUSABLE_REASONS, `${intervalPath}.reason`, errors);
      checkInterval({ start_ms: interval.start_ms, end_ms: interval.end_ms }, intervalPath, durationMs, errors);
    });
  }
}

// ---------------------------------------------------------------------
// Public: label sets
// ---------------------------------------------------------------------

/**
 * Validates one StrokeLabelSet (all annotations of one clip).
 * Returns { valid, errors } and never throws for bad input.
 */
export function validateStrokeLabelSet(labelSet) {
  const errors = [];
  if (!checkObject(labelSet, "label_set", ["schema_version", "label_set_id", "data_status", "clip", "annotations"], [], errors)) {
    return { valid: false, errors };
  }
  if (labelSet.schema_version !== STROKE_LABEL_SCHEMA_VERSION) {
    errors.push(`label_set.schema_version: must be ${STROKE_LABEL_SCHEMA_VERSION}`);
  }
  checkEnum(labelSet.data_status, DATA_STATUSES, "label_set.data_status", errors);
  const dataStatus = DATA_STATUSES.includes(labelSet.data_status) ? labelSet.data_status : null;
  checkRef(labelSet.label_set_id, "label_set.label_set_id", dataStatus, errors);

  const clip = validateClip(labelSet.clip, dataStatus, errors);

  if (checkArray(labelSet.annotations, "label_set.annotations", errors)) {
    if (labelSet.annotations.length === 0) errors.push("label_set.annotations: needs at least one annotation");
    labelSet.annotations.forEach((annotation, index) => {
      validateAnnotation(annotation, `label_set.annotations[${index}]`, clip, dataStatus, errors);
    });
    checkUniqueIds(labelSet.annotations, "annotation_id", "label_set.annotations", errors);
    const adjudications = labelSet.annotations.filter((a) => isPlainObject(a) && a.annotator?.role === "adjudicator");
    if (adjudications.length > 1) errors.push("label_set.annotations: at most one adjudicator annotation per clip");
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidStrokeLabelSet(labelSet) {
  const { valid, errors } = validateStrokeLabelSet(labelSet);
  if (!valid) throw new Error(`Invalid StrokeLabelSet:\n- ${errors.join("\n- ")}`);
  return labelSet;
}

// ---------------------------------------------------------------------
// Public: candidate outputs (what a detector, baseline or synthetic
// fixture claims for one clip)
// ---------------------------------------------------------------------

/**
 * Validates one StrokeCandidateSet. `durationMs` (optional) bounds
 * timestamps when the matching label set is known.
 */
export function validateStrokeCandidateSet(candidate, { durationMs = null } = {}) {
  const errors = [];
  const required = ["schema_version", "candidate_id", "data_status", "clip_ref", "stroke", "source", "events", "cycles", "abstentions"];
  if (!checkObject(candidate, "candidate", required, [], errors)) return { valid: false, errors };
  if (candidate.schema_version !== STROKE_CANDIDATE_SCHEMA_VERSION) {
    errors.push(`candidate.schema_version: must be ${STROKE_CANDIDATE_SCHEMA_VERSION}`);
  }
  checkEnum(candidate.data_status, DATA_STATUSES, "candidate.data_status", errors);
  const dataStatus = DATA_STATUSES.includes(candidate.data_status) ? candidate.data_status : null;
  checkRef(candidate.candidate_id, "candidate.candidate_id", dataStatus, errors);
  checkRef(candidate.clip_ref, "candidate.clip_ref", dataStatus, errors);
  checkEnum(candidate.stroke, STROKES, "candidate.stroke", errors);
  const stroke = STROKES.includes(candidate.stroke) ? candidate.stroke : null;

  const source = candidate.source;
  if (checkObject(source, "candidate.source", ["kind", "name", "commit"], [], errors)) {
    checkEnum(source.kind, CANDIDATE_SOURCE_KINDS, "candidate.source.kind", errors);
    checkNonEmptyString(source.name, "candidate.source.name", errors);
    if (source.commit !== null) checkNonEmptyString(source.commit, "candidate.source.commit", errors);
    if (dataStatus === "synthetic" && source.kind !== "synthetic") {
      errors.push('candidate.source.kind: synthetic data must have source kind "synthetic"');
    }
    if (dataStatus === "expert_labelled" && source.kind === "synthetic") {
      errors.push('candidate.source.kind: "synthetic" source requires data_status "synthetic"');
    }
  }

  const abstentions = [];
  if (checkArray(candidate.abstentions, "candidate.abstentions", errors)) {
    candidate.abstentions.forEach((abstention, index) => {
      const path = `candidate.abstentions[${index}]`;
      if (!checkObject(abstention, path, ["start_ms", "end_ms", "reason"], [], errors)) return;
      checkEnum(abstention.reason, ABSTENTION_REASONS, `${path}.reason`, errors);
      if (checkInterval({ start_ms: abstention.start_ms, end_ms: abstention.end_ms }, path, durationMs, errors)) {
        abstentions.push(abstention);
      }
    });
  }

  if (checkArray(candidate.events, "candidate.events", errors)) {
    candidate.events.forEach((event, index) => {
      const path = `candidate.events[${index}]`;
      if (!checkObject(event, path, ["event_type", "side", "timestamp_ms"], [], errors)) return;
      if (stroke && !STROKE_EVENT_TYPES[stroke][event.event_type]) {
        errors.push(`${path}.event_type: ${String(event.event_type)} is not an event type for ${stroke}`);
      }
      if (stroke) checkSide(stroke, STROKE_EVENT_TYPES, event.event_type, event.side, `${path}.side`, errors);
      if (checkTimeInClip(event.timestamp_ms, `${path}.timestamp_ms`, durationMs, errors)
          && abstentions.some((a) => event.timestamp_ms >= a.start_ms && event.timestamp_ms <= a.end_ms)) {
        errors.push(`${path}: an event cannot lie inside the candidate's own abstention interval`);
      }
    });
  }

  if (checkArray(candidate.cycles, "candidate.cycles", errors)) {
    candidate.cycles.forEach((cycle, index) => {
      const path = `candidate.cycles[${index}]`;
      if (!checkObject(cycle, path, ["side", "start_ms", "end_ms"], [], errors)) return;
      if (!["left", "right", "both", "none"].includes(cycle.side)) errors.push(`${path}.side: must be left, right, both or none`);
      if (checkInterval({ start_ms: cycle.start_ms, end_ms: cycle.end_ms }, path, durationMs, errors) && cycle.end_ms === cycle.start_ms) {
        errors.push(`${path}: a cycle must have end_ms > start_ms`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidStrokeCandidateSet(candidate, options) {
  const { valid, errors } = validateStrokeCandidateSet(candidate, options);
  if (!valid) throw new Error(`Invalid StrokeCandidateSet:\n- ${errors.join("\n- ")}`);
  return candidate;
}
