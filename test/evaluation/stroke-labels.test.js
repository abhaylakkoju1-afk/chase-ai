// Unit tests for the four-stroke label/candidate contracts
// (src/evaluation/stroke-labels.js). All inputs are SYNTHETIC fixtures:
// these tests check schema validation only, never accuracy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  STROKES,
  STROKE_EVENT_TYPES,
  STROKE_PHASE_LABELS,
  STROKE_LABEL_SCHEMA_VERSION,
  POSE_LANDMARK_NAMES,
  validateStrokeLabelSet,
  assertValidStrokeLabelSet,
  validateStrokeCandidateSet,
  assertValidStrokeCandidateSet,
} from "../../src/evaluation/stroke-labels.js";
import {
  syntheticAnnotation,
  syntheticCandidate,
  syntheticEvent,
  syntheticLabelSet,
  syntheticPerfectCandidate,
  syntheticStrokeLabelSet,
} from "./stroke-fixtures.js";

function errorsOf(labelSet) {
  return validateStrokeLabelSet(labelSet).errors;
}

function expectError(labelSet, pattern) {
  const errors = errorsOf(labelSet);
  assert.ok(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n${errors.join("\n")}`);
}

function withEvents(stroke, events, annotationOverrides = {}) {
  return syntheticLabelSet({
    clip: { stroke },
    annotations: [syntheticAnnotation({ events, ...annotationOverrides })],
  });
}

describe("vocabulary", () => {
  test("covers exactly the four competitive strokes, each with events and phases", () => {
    assert.deepEqual([...STROKES], ["freestyle", "backstroke", "butterfly", "breaststroke"]);
    for (const stroke of STROKES) {
      assert.ok(Object.keys(STROKE_EVENT_TYPES[stroke]).length > 0, stroke);
      assert.ok(Object.keys(STROKE_PHASE_LABELS[stroke]).length > 0, stroke);
      for (const sides of [...Object.values(STROKE_EVENT_TYPES[stroke]), ...Object.values(STROKE_PHASE_LABELS[stroke])]) {
        assert.ok(sides.length > 0 && sides.every((s) => ["left", "right", "both", "none"].includes(s)), stroke);
      }
    }
  });

  test("alternating strokes label arms per side; butterfly and breaststroke arm actions are bilateral", () => {
    assert.deepEqual([...STROKE_EVENT_TYPES.freestyle.hand_entry], ["left", "right"]);
    assert.deepEqual([...STROKE_EVENT_TYPES.backstroke.hand_entry], ["left", "right"]);
    assert.deepEqual([...STROKE_EVENT_TYPES.butterfly.hand_entry], ["both"]);
    assert.deepEqual([...STROKE_EVENT_TYPES.breaststroke.arm_outsweep_start], ["both"]);
  });

  test("keeps the current freestyle detector's event and Protocol v0.1's hand-entry event for freestyle", () => {
    assert.ok(STROKE_EVENT_TYPES.freestyle.wrist_height_minimum);
    assert.ok(STROKE_EVENT_TYPES.freestyle.hand_entry);
    assert.equal(POSE_LANDMARK_NAMES.length, 33);
  });
});

describe("valid label sets", () => {
  for (const stroke of STROKES) {
    test(`a complete synthetic ${stroke} label set is valid`, () => {
      assert.deepEqual(errorsOf(syntheticStrokeLabelSet(stroke)), []);
    });
  }

  test("an indeterminate event (no timestamp, plausible range, uncertain) is valid", () => {
    const labelSet = withEvents("freestyle", [
      syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", null, {
        timestamp_range_ms: { start_ms: 900, end_ms: 1100 },
        certainty: "uncertain",
        visibility: { status: "partially_occluded", occluded_landmarks: ["left_wrist", "left_index"] },
      }),
    ]);
    assert.deepEqual(errorsOf(labelSet), []);
  });

  test("multiple annotators with one adjudicator are valid", () => {
    const labelSet = syntheticLabelSet({
      annotations: [
        syntheticAnnotation({ annotation_id: "SYNTHETIC-ANN-1" }),
        syntheticAnnotation({ annotation_id: "SYNTHETIC-ANN-2", annotator: { annotator_ref: "SYNTHETIC-ANNOTATOR-2", role: "biomechanist", blinded_to_candidates: true } }),
        syntheticAnnotation({ annotation_id: "SYNTHETIC-ANN-3", annotator: { annotator_ref: "SYNTHETIC-ANNOTATOR-3", role: "adjudicator", blinded_to_candidates: true } }),
      ],
    });
    assert.deepEqual(errorsOf(labelSet), []);
  });
});

describe("privacy: no footage, personal data or free text can be carried", () => {
  test("unknown fields are rejected at every level", () => {
    const top = { ...syntheticLabelSet(), video_url: "x" };
    expectError(top, /label_set\.video_url: field is not part of the contract/);

    const clip = syntheticLabelSet();
    clip.clip.swimmer_name = "x";
    clip.clip.date_of_birth = "x";
    expectError(clip, /clip\.swimmer_name: field is not part of the contract/);
    expectError(clip, /clip\.date_of_birth: field is not part of the contract/);

    const annotation = syntheticLabelSet({ annotations: [{ ...syntheticAnnotation(), notes: "free text" }] });
    expectError(annotation, /annotations\[0\]\.notes: field is not part of the contract/);

    const event = withEvents("freestyle", [{ ...syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1000), frame_image: "x" }]);
    expectError(event, /events\[0\]\.frame_image: field is not part of the contract/);
  });

  test("references must be opaque codes, not URLs, paths, emails or names", () => {
    for (const bad of ["https://example.com/clip.mp4", "C:\\videos\\swim.mov", "SYNTHETIC-a@b.com", "SYNTHETIC-First Last", "", "SYNTHETIC-" + "x".repeat(60)]) {
      expectError(syntheticLabelSet({ clip: { clip_ref: bad } }), /clip\.clip_ref: must be an opaque code/);
    }
  });

  test("synthetic data must use the SYNTHETIC- prefix, and expert data must not", () => {
    expectError(syntheticLabelSet({ clip: { subject_ref: "SUBJECT-1" } }), /subject_ref: synthetic data must use the SYNTHETIC- prefix/);
    const expert = { ...syntheticLabelSet(), data_status: "expert_labelled" };
    expectError(expert, /clip_ref: expert-labelled data must not use the SYNTHETIC- prefix/);
  });
});

describe("clip context", () => {
  test("requires camera view, medium, placement, side, motion and distance", () => {
    const labelSet = syntheticLabelSet();
    delete labelSet.clip.camera.medium;
    labelSet.clip.camera.view = "drone";
    expectError(labelSet, /clip\.camera\.medium: required/);
    expectError(labelSet, /clip\.camera\.view: must be one of/);
  });

  test("frame rate and duration must be positive", () => {
    expectError(syntheticLabelSet({ clip: { frame_rate_fps: 0 } }), /frame_rate_fps: must be a positive/);
    expectError(syntheticLabelSet({ clip: { duration_ms: -1 } }), /duration_ms: must be a positive/);
  });

  test("pool length must agree with a known course", () => {
    expectError(syntheticLabelSet({ clip: { pool: { course: "LCM", pool_length_m: 25 } } }), /does not match course LCM/);
    assert.deepEqual(errorsOf(syntheticLabelSet({ clip: { pool: { course: "SCY", pool_length_m: 22.86 } } })), []);
    assert.deepEqual(errorsOf(syntheticLabelSet({ clip: { pool: { course: "unknown", pool_length_m: null } } })), []);
  });

  test("segment needs a race segment and pace; lap index is an integer", () => {
    expectError(syntheticLabelSet({ clip: { segment: { pace: "fast" } } }), /segment\.pace: must be one of/);
    expectError(syntheticLabelSet({ clip: { segment: { lap_index: 1.5 } } }), /lap_index: must be a non-negative integer/);
  });

  test("schema version must match exactly", () => {
    expectError({ ...syntheticLabelSet(), schema_version: "chase.stroke-labels.v0.0" }, new RegExp(`must be ${STROKE_LABEL_SCHEMA_VERSION.replace(/\./g, "\\.")}`));
  });
});

describe("events, phases and cycles", () => {
  test("event types must belong to the clip's stroke", () => {
    expectError(withEvents("breaststroke", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "both", 1000)]), /hand_entry is not an event type for breaststroke/);
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "kick_1_downbeat", "both", 1000)]), /kick_1_downbeat is not an event type for freestyle/);
  });

  test("sides must fit the stroke's event", () => {
    expectError(withEvents("butterfly", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1000)]), /side for hand_entry in butterfly must be one of both/);
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "both", 1000)]), /side for hand_entry in freestyle must be one of left, right/);
  });

  test("timestamps stay inside the clip and inside their own range", () => {
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 20000)]), /timestamp_ms: is beyond the clip duration/);
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1500, { timestamp_range_ms: { start_ms: 900, end_ms: 1100 } })]), /lies outside its timestamp_range_ms/);
  });

  test("an event without a timestamp cannot be certain", () => {
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", null, { certainty: "certain" })]), /cannot be "certain"/);
  });

  test("visibility: occluded landmarks must be real names, and a visible label lists none", () => {
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1000, { visibility: { status: "visible", occluded_landmarks: ["left_wrist"] } })]), /a "visible" label cannot list occluded landmarks/);
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1000, { visibility: { status: "occluded", occluded_landmarks: ["left_fin"] } })]), /unknown landmark/);
  });

  test("phase labels must belong to the stroke and have positive length", () => {
    const wrongLabel = withEvents("breaststroke", [], { phases: [{ phase_id: "SYNTHETIC-P1", phase_label: "catch", side: "both", start_ms: 100, end_ms: 200, certainty: "certain" }] });
    expectError(wrongLabel, /catch is not a phase label for breaststroke/);
    const zero = withEvents("freestyle", [], { phases: [{ phase_id: "SYNTHETIC-P1", phase_label: "catch", side: "left", start_ms: 100, end_ms: 100, certainty: "certain" }] });
    expectError(zero, /a phase must have end_ms > start_ms/);
  });

  test("cycles reference two timed events of the same type and side, in order", () => {
    const events = [
      syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1000),
      syntheticEvent("SYNTHETIC-E2", "hand_entry", "right", 1500),
      syntheticEvent("SYNTHETIC-E3", "hand_entry", "left", 500),
      syntheticEvent("SYNTHETIC-E4", "hand_entry", "left", null),
    ];
    const cycles = [
      { cycle_id: "SYNTHETIC-C1", start_event_id: "SYNTHETIC-E1", end_event_id: "SYNTHETIC-MISSING" },
      { cycle_id: "SYNTHETIC-C2", start_event_id: "SYNTHETIC-E1", end_event_id: "SYNTHETIC-E2" },
      { cycle_id: "SYNTHETIC-C3", start_event_id: "SYNTHETIC-E1", end_event_id: "SYNTHETIC-E3" },
      { cycle_id: "SYNTHETIC-C4", start_event_id: "SYNTHETIC-E1", end_event_id: "SYNTHETIC-E4" },
    ];
    const labelSet = withEvents("freestyle", events, { cycles });
    expectError(labelSet, /cycles\[0\]\.end_event_id: does not reference an event/);
    expectError(labelSet, /cycles\[1\]: start and end events must share event_type and side/);
    expectError(labelSet, /cycles\[2\]: end event must be later than start event/);
    expectError(labelSet, /cycles\[3\]: both boundary events need a timestamp_ms/);
  });

  test("ids are unique, annotations are non-empty, and there is at most one adjudicator", () => {
    expectError(withEvents("freestyle", [syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1000), syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 2000)]), /duplicate id SYNTHETIC-E1/);
    expectError(syntheticLabelSet({ annotations: [] }), /needs at least one annotation/);
    const adjudicator = (id) => syntheticAnnotation({ annotation_id: id, annotator: { annotator_ref: "SYNTHETIC-ADJ", role: "adjudicator", blinded_to_candidates: true } });
    expectError(syntheticLabelSet({ annotations: [adjudicator("SYNTHETIC-A"), adjudicator("SYNTHETIC-B")] }), /at most one adjudicator/);
  });

  test("unusable intervals need a known reason and must lie inside the clip", () => {
    expectError(withEvents("freestyle", [], { unusable_intervals: [{ start_ms: 100, end_ms: 50, reason: "occlusion" }] }), /needs finite 0 <= start_ms <= end_ms/);
    expectError(withEvents("freestyle", [], { unusable_intervals: [{ start_ms: 100, end_ms: 200, reason: "boring" }] }), /reason: must be one of/);
  });
});

describe("candidate sets", () => {
  for (const stroke of STROKES) {
    test(`a perfect synthetic ${stroke} candidate is valid`, () => {
      assert.deepEqual(validateStrokeCandidateSet(syntheticPerfectCandidate(stroke), { durationMs: 10000 }).errors, []);
    });
  }

  test("an event may not sit inside the candidate's own abstention", () => {
    const candidate = syntheticCandidate({
      events: [{ event_type: "hand_entry", side: "left", timestamp_ms: 1500 }],
      abstentions: [{ start_ms: 1000, end_ms: 2000, reason: "occlusion" }],
    });
    assert.match(validateStrokeCandidateSet(candidate).errors.join("\n"), /cannot lie inside the candidate's own abstention/);
  });

  test("event types, sides and clip bounds are checked against the candidate's stroke", () => {
    const candidate = syntheticCandidate({
      stroke: "butterfly",
      events: [{ event_type: "hand_entry", side: "left", timestamp_ms: 20000 }],
    });
    const errors = validateStrokeCandidateSet(candidate, { durationMs: 10000 }).errors.join("\n");
    assert.match(errors, /side for hand_entry in butterfly must be one of both/);
    assert.match(errors, /timestamp_ms: is beyond the clip duration/);
  });

  test("synthetic candidates must declare a synthetic source", () => {
    const candidate = syntheticCandidate({ source: { kind: "detector", name: "x", commit: "abc" } });
    assert.match(validateStrokeCandidateSet(candidate).errors.join("\n"), /synthetic data must have source kind "synthetic"/);
  });
});

describe("validator robustness", () => {
  test("validate* never throw on malformed input; assert* throw with every message", () => {
    for (const bad of [null, undefined, "x", 3, [], {}]) {
      assert.equal(validateStrokeLabelSet(bad).valid, false);
      assert.equal(validateStrokeCandidateSet(bad).valid, false);
    }
    assert.throws(() => assertValidStrokeLabelSet({}), /Invalid StrokeLabelSet:[\s\S]*schema_version: required/);
    assert.throws(() => assertValidStrokeCandidateSet({}), /Invalid StrokeCandidateSet:[\s\S]*candidate_id: required/);
  });

  test("validation does not mutate its input", () => {
    const labelSet = syntheticStrokeLabelSet("butterfly");
    const before = JSON.stringify(labelSet);
    validateStrokeLabelSet(labelSet);
    assert.equal(JSON.stringify(labelSet), before);
  });
});
