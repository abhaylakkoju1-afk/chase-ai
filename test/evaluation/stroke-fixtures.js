// SYNTHETIC test fixtures for the four-stroke label contract and
// evaluation harness (src/evaluation/stroke-labels.js,
// src/evaluation/stroke-evaluation.js).
//
// NOTHING HERE IS REAL. No clip, swimmer, annotator or video exists
// behind any of these records. Every timestamp is a hand-picked number
// chosen only to exercise one mechanical case (a match, an offset, an
// abstention, an occlusion, a disagreement). None of it is evidence of
// Chase's accuracy for any stroke, and none of it may be cited as such.
// Every reference uses the SYNTHETIC- prefix and data_status
// "synthetic", which the validator enforces.
//
// SYNTHETIC_TOLERANCE_MS is NOT an approved benchmark tolerance (none
// exists; see docs/evaluation/ANNOTATION_PROTOCOL_V0.1.md §14 and
// docs/evaluation/STROKE_LABEL_CONTRACT_V0.1.md). Do not reuse it
// outside tests.

import { STROKE_LABEL_SCHEMA_VERSION, STROKE_CANDIDATE_SCHEMA_VERSION } from "../../src/evaluation/stroke-labels.js";

export const SYNTHETIC_TOLERANCE_MS = 50;

const SYNTHETIC_PREFIX_RE = /^SYNTHETIC-/;

// The first-listed event type per stroke, used as each stroke's
// synthetic "cycle event" in the fixtures below.
export const SYNTHETIC_CYCLE_EVENT = Object.freeze({
  freestyle: { event_type: "hand_entry", side: "left" },
  backstroke: { event_type: "hand_entry", side: "right" },
  butterfly: { event_type: "hand_entry", side: "both" },
  breaststroke: { event_type: "arm_outsweep_start", side: "both" },
});

export function syntheticClip(overrides = {}) {
  const { camera = {}, pool = {}, segment = {}, ...rest } = overrides;
  return {
    clip_ref: "SYNTHETIC-CLIP-1",
    subject_ref: "SYNTHETIC-SUBJECT-1",
    stroke: "freestyle",
    duration_ms: 10000,
    frame_rate_fps: 60,
    ...rest,
    camera: {
      view: "side",
      medium: "above_water",
      placement: "pool_deck",
      side: "swimmer_left",
      motion: "static",
      distance_m: null,
      ...camera,
    },
    pool: { course: "SCM", pool_length_m: 25, ...pool },
    segment: { race_segment: "clean_swim", pace: "moderate", event_distance_m: null, lap_index: null, ...segment },
  };
}

export function syntheticEvent(event_id, event_type, side, timestamp_ms, overrides = {}) {
  return {
    event_id,
    event_type,
    side,
    timestamp_ms,
    timestamp_range_ms: null,
    certainty: timestamp_ms === null ? "uncertain" : "certain",
    visibility: { status: "visible", occluded_landmarks: [] },
    ...overrides,
  };
}

export function syntheticAnnotation(overrides = {}) {
  return {
    annotation_id: "SYNTHETIC-ANN-1",
    annotator: { annotator_ref: "SYNTHETIC-ANNOTATOR-1", role: "coach", blinded_to_candidates: true },
    protocol_version: "SYNTHETIC-PROTOCOL",
    events: [],
    phases: [],
    cycles: [],
    unusable_intervals: [],
    ...overrides,
  };
}

export function syntheticLabelSet({ clip = {}, annotations, label_set_id } = {}) {
  const builtClip = syntheticClip(clip);
  return {
    schema_version: STROKE_LABEL_SCHEMA_VERSION,
    label_set_id: label_set_id || `SYNTHETIC-LABELS-${builtClip.clip_ref.replace(SYNTHETIC_PREFIX_RE, "")}`,
    data_status: "synthetic",
    clip: builtClip,
    annotations: annotations || [syntheticAnnotation()],
  };
}

export function syntheticCandidate(overrides = {}) {
  const clipRef = overrides.clip_ref || "SYNTHETIC-CLIP-1";
  return {
    schema_version: STROKE_CANDIDATE_SCHEMA_VERSION,
    candidate_id: `SYNTHETIC-CAND-${clipRef.replace(SYNTHETIC_PREFIX_RE, "")}`,
    data_status: "synthetic",
    clip_ref: clipRef,
    stroke: "freestyle",
    source: { kind: "synthetic", name: "synthetic fixture", commit: null },
    events: [],
    cycles: [],
    abstentions: [],
    ...overrides,
  };
}

// A complete, valid label set for one stroke: three cycle-event labels
// 1000 ms apart, two cycles between them, and one phase interval.
export function syntheticStrokeLabelSet(stroke, clipOverrides = {}) {
  const { event_type, side } = SYNTHETIC_CYCLE_EVENT[stroke];
  const phase = {
    freestyle: { phase_label: "catch", side: "left" },
    backstroke: { phase_label: "pull", side: "right" },
    butterfly: { phase_label: "catch_pull", side: "both" },
    breaststroke: { phase_label: "glide", side: "both" },
  }[stroke];
  return syntheticLabelSet({
    clip: { clip_ref: `SYNTHETIC-CLIP-${stroke.toUpperCase()}`, stroke, ...clipOverrides },
    annotations: [
      syntheticAnnotation({
        events: [
          syntheticEvent("SYNTHETIC-E1", event_type, side, 1000),
          syntheticEvent("SYNTHETIC-E2", event_type, side, 2000),
          syntheticEvent("SYNTHETIC-E3", event_type, side, 3000),
        ],
        phases: [{ phase_id: "SYNTHETIC-P1", ...phase, start_ms: 1100, end_ms: 1400, certainty: "probable" }],
        cycles: [
          { cycle_id: "SYNTHETIC-C1", start_event_id: "SYNTHETIC-E1", end_event_id: "SYNTHETIC-E2" },
          { cycle_id: "SYNTHETIC-C2", start_event_id: "SYNTHETIC-E2", end_event_id: "SYNTHETIC-E3" },
        ],
      }),
    ],
  });
}

// A candidate that reproduces syntheticStrokeLabelSet(stroke) exactly.
export function syntheticPerfectCandidate(stroke) {
  const { event_type, side } = SYNTHETIC_CYCLE_EVENT[stroke];
  return syntheticCandidate({
    clip_ref: `SYNTHETIC-CLIP-${stroke.toUpperCase()}`,
    stroke,
    events: [1000, 2000, 3000].map((timestamp_ms) => ({ event_type, side, timestamp_ms })),
    cycles: [
      { side, start_ms: 1000, end_ms: 2000 },
      { side, start_ms: 2000, end_ms: 3000 },
    ],
  });
}

// Empty inputs: no labels, no candidates.
export const SYNTHETIC_EMPTY_INPUTS = Object.freeze({ labelSets: Object.freeze([]), candidates: Object.freeze([]) });
