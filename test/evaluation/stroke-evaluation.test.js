// Unit tests for the four-stroke evaluation harness
// (src/evaluation/stroke-evaluation.js).
//
// Every input is a SYNTHETIC fixture with hand-computed expected
// values. These tests check the harness's arithmetic and bookkeeping;
// they are not a benchmark and say nothing about real accuracy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_STATUS,
  createStrokeEvaluationConfig,
  computeAnnotatorAgreement,
  evaluateStrokeCandidates,
  selectReferenceAnnotation,
} from "../../src/evaluation/stroke-evaluation.js";
import { STROKES } from "../../src/evaluation/stroke-labels.js";
import {
  SYNTHETIC_EMPTY_INPUTS,
  SYNTHETIC_TOLERANCE_MS,
  syntheticAnnotation,
  syntheticCandidate,
  syntheticEvent,
  syntheticLabelSet,
  syntheticPerfectCandidate,
  syntheticStrokeLabelSet,
} from "./stroke-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function config(overrides = {}) {
  return createStrokeEvaluationConfig({
    evaluation_version: "SYNTHETIC-EVAL",
    tolerance_ms_by_event_type: { hand_entry: SYNTHETIC_TOLERANCE_MS, arm_outsweep_start: SYNTHETIC_TOLERANCE_MS },
    cycle_start_tolerance_ms: null,
    ...overrides,
  });
}

const entry = (ms) => ({ event_type: "hand_entry", side: "left", timestamp_ms: ms });

function freestyleLabels(times, { clip = {}, annotation = {} } = {}) {
  return syntheticLabelSet({
    clip,
    annotations: [
      syntheticAnnotation({
        events: times.map((t, i) => syntheticEvent(`SYNTHETIC-E${i + 1}`, "hand_entry", "left", t)),
        ...annotation,
      }),
    ],
  });
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

describe("configuration has no default tolerances", () => {
  test("cycle tolerance must be stated (a number or null)", () => {
    assert.throws(
      () => createStrokeEvaluationConfig({ evaluation_version: "SYNTHETIC-EVAL", tolerance_ms_by_event_type: {} }),
      /cycle_start_tolerance_ms is required/,
    );
  });

  test("tolerances must be known event types with non-negative values", () => {
    const base = { evaluation_version: "SYNTHETIC-EVAL", cycle_start_tolerance_ms: null };
    assert.throws(() => createStrokeEvaluationConfig({ ...base, tolerance_ms_by_event_type: { hand_slap: 10 } }), /unknown event type hand_slap/);
    assert.throws(() => createStrokeEvaluationConfig({ ...base, tolerance_ms_by_event_type: { hand_entry: -1 } }), /non-negative/);
    assert.throws(() => createStrokeEvaluationConfig({ ...base, tolerance_ms_by_event_type: { hand_entry: "50" } }), /non-negative/);
    assert.throws(() => createStrokeEvaluationConfig({ ...base, evaluation_version: "", tolerance_ms_by_event_type: {} }), /evaluation_version/);
  });

  test("event types without a tolerance are reported as not evaluated, never defaulted", () => {
    const report = evaluateStrokeCandidates({ ...SYNTHETIC_EMPTY_INPUTS, config: config() });
    assert.ok(report.inputs.event_types_not_evaluated.includes("wall_touch"));
    assert.ok(report.inputs.event_types_not_evaluated.includes("kick_1_downbeat"));
    assert.ok(!report.inputs.event_types_not_evaluated.includes("hand_entry"));
  });

  test("evaluation requires a config built by the factory", () => {
    assert.throws(
      () => evaluateStrokeCandidates({ ...SYNTHETIC_EMPTY_INPUTS, config: { tolerance_ms_by_event_type: {} } }),
      /createStrokeEvaluationConfig/,
    );
  });
});

describe("empty inputs", () => {
  test("report no data, keep all four strokes visible, and give null metrics", () => {
    const report = evaluateStrokeCandidates({ ...SYNTHETIC_EMPTY_INPUTS, config: config() });
    assert.equal(report.evidence_status, EVIDENCE_STATUS.NO_DATA);
    assert.deepEqual(Object.keys(report.by_stroke), [...STROKES]);
    for (const stroke of STROKES) {
      const group = report.by_stroke[stroke];
      assert.equal(group.clips, 0);
      assert.equal(group.events.precision, null);
      assert.equal(group.events.recall, null);
      assert.equal(group.events.f1, null);
      assert.equal(group.events.timing_error_ms, null);
      assert.equal(group.time_coverage.coverage, null);
      assert.equal(group.cycles, null);
    }
    assert.deepEqual(report.by_view, {});
    assert.deepEqual(report.clips, []);
  });
});

describe("event errors", () => {
  test("counts matches, false positives, false negatives and signed timing errors", () => {
    const report = evaluateStrokeCandidates({
      labelSets: [freestyleLabels([1000, 2000, 3000])],
      candidates: [syntheticCandidate({ events: [entry(1010), entry(1970), entry(3300)] })],
      config: config(),
    });
    const events = report.by_stroke.freestyle.events;
    assert.equal(events.true_positives, 2);
    assert.equal(events.false_positives, 1);
    assert.equal(events.false_negatives, 1);
    close(events.precision, 2 / 3);
    close(events.recall, 2 / 3);
    close(events.f1, 2 / 3);
    assert.equal(events.timing_error_ms.count, 2);
    close(events.timing_error_ms.meanMs, -10);
    close(events.timing_error_ms.meanAbsMs, 20);
    assert.equal(events.timing_error_ms.minMs, -30);
    assert.equal(events.timing_error_ms.maxMs, 10);
    assert.deepEqual(Object.keys(report.by_stroke.freestyle.by_event), ["hand_entry/left", "hand_entry/right"]);
    assert.equal(report.by_stroke.freestyle.by_event["hand_entry/right"].labels_total, 0);
    assert.equal(report.evidence_status, EVIDENCE_STATUS.SYNTHETIC);
    assert.match(report.disclaimer, /SYNTHETIC TEST DATA/);
  });
});

describe("abstentions, unusable intervals and indeterminate labels", () => {
  function scenario() {
    const labelSet = syntheticLabelSet({
      annotations: [
        syntheticAnnotation({
          events: [
            syntheticEvent("SYNTHETIC-E1", "hand_entry", "left", 1000),
            syntheticEvent("SYNTHETIC-E2", "hand_entry", "left", 2000), // inside the candidate's abstention
            syntheticEvent("SYNTHETIC-E3", "hand_entry", "left", 5000), // inside the annotator's unusable interval
            syntheticEvent("SYNTHETIC-E4", "hand_entry", "left", null, { timestamp_range_ms: { start_ms: 6000, end_ms: 6300 } }),
            syntheticEvent("SYNTHETIC-E5", "hand_entry", "left", 7000, { certainty: "uncertain" }),
          ],
          unusable_intervals: [{ start_ms: 4900, end_ms: 5100, reason: "splash_or_bubbles" }],
        }),
      ],
    });
    const candidate = syntheticCandidate({
      events: [entry(1000), entry(4920), entry(7000)],
      abstentions: [
        { start_ms: 1800, end_ms: 2200, reason: "occlusion" },
        { start_ms: 4950, end_ms: 5300, reason: "low_confidence" },
      ],
    });
    return evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [candidate], config: config() });
  }

  test("abstained labels are not misses; unusable and indeterminate labels are not scored", () => {
    const events = scenario().by_stroke.freestyle.events;
    assert.equal(events.labels_total, 5);
    assert.equal(events.labels_indeterminate, 1);
    assert.equal(events.labels_in_unusable, 1);
    assert.equal(events.labels_abstained, 1);
    assert.equal(events.labels_evaluable, 2);
    assert.equal(events.labels_uncertain_evaluable, 1);
    assert.equal(events.predictions_total, 3);
    assert.equal(events.predictions_in_unusable, 1);
    assert.equal(events.true_positives, 2);
    assert.equal(events.false_positives, 0);
    assert.equal(events.false_negatives, 0);
    close(events.abstention_rate, 1 / 3);
    close(events.event_coverage, 2 / 3);
  });

  test("time coverage excludes unusable time and counts overlapping abstention once", () => {
    const coverage = scenario().by_stroke.freestyle.time_coverage;
    // usable = 10000 - 200; abstained = 400 + 350 - 150 (overlap with unusable)
    assert.equal(coverage.usable_duration_ms, 9800);
    assert.equal(coverage.abstained_usable_duration_ms, 600);
    close(coverage.coverage, 9200 / 9800);
  });

  test("a whole-clip abstention leaves nothing scored and zero coverage", () => {
    const report = evaluateStrokeCandidates({
      labelSets: [freestyleLabels([1000, 2000])],
      candidates: [syntheticCandidate({ abstentions: [{ start_ms: 0, end_ms: 10000, reason: "view_unsupported" }] })],
      config: config(),
    });
    const group = report.by_stroke.freestyle;
    assert.equal(group.events.labels_abstained, 2);
    assert.equal(group.events.false_negatives, 0);
    assert.equal(group.events.recall, null);
    assert.equal(group.events.abstention_rate, 1);
    assert.equal(group.time_coverage.coverage, 0);
  });
});

describe("per-stroke and per-view grouping", () => {
  test("separates camera views and stroke x view combinations; empty strokes stay visible", () => {
    const report = evaluateStrokeCandidates({
      labelSets: [
        freestyleLabels([1000, 2000, 3000], { clip: { clip_ref: "SYNTHETIC-CLIP-A" } }),
        freestyleLabels([1000, 2000, 3000], { clip: { clip_ref: "SYNTHETIC-CLIP-B", subject_ref: "SYNTHETIC-SUBJECT-2", camera: { view: "front", medium: "underwater" } } }),
      ],
      candidates: [
        syntheticCandidate({ clip_ref: "SYNTHETIC-CLIP-A", events: [entry(1000), entry(2000), entry(3000)] }),
        syntheticCandidate({ clip_ref: "SYNTHETIC-CLIP-B", events: [] }),
      ],
      config: config(),
    });
    assert.deepEqual(Object.keys(report.by_view), ["front/underwater", "side/above_water"]);
    assert.equal(report.by_view["side/above_water"].events.recall, 1);
    assert.equal(report.by_view["front/underwater"].events.recall, 0);
    assert.equal(report.by_view["front/underwater"].events.precision, null);
    close(report.by_stroke.freestyle.events.recall, 0.5);
    assert.equal(report.by_stroke.freestyle.subjects, 2);
    assert.deepEqual(Object.keys(report.by_stroke_and_view), ["freestyle|front/underwater", "freestyle|side/above_water"]);
    assert.equal(report.by_stroke.backstroke.clips, 0);
    assert.equal(report.by_stroke.backstroke.events.recall, null);
  });

  test("a perfect synthetic candidate scores 1.0 for each stroke, labelled as synthetic", () => {
    const report = evaluateStrokeCandidates({
      labelSets: STROKES.map((s) => syntheticStrokeLabelSet(s)),
      candidates: STROKES.map((s) => syntheticPerfectCandidate(s)),
      config: config({ cycle_start_tolerance_ms: SYNTHETIC_TOLERANCE_MS }),
    });
    assert.equal(report.evidence_status, EVIDENCE_STATUS.SYNTHETIC);
    for (const stroke of STROKES) {
      const group = report.by_stroke[stroke];
      assert.equal(group.clips_evaluated, 1, stroke);
      assert.equal(group.events.precision, 1, stroke);
      assert.equal(group.events.recall, 1, stroke);
      assert.equal(group.cycles.f1, 1, stroke);
      assert.equal(group.cycles.cycle_count_error, 0, stroke);
    }
  });
});

describe("reference annotation and annotator disagreement", () => {
  const annA = syntheticAnnotation({
    annotation_id: "SYNTHETIC-ANN-A",
    events: [syntheticEvent("SYNTHETIC-A1", "hand_entry", "left", 1000), syntheticEvent("SYNTHETIC-A2", "hand_entry", "left", 2000)],
  });
  const annB = syntheticAnnotation({
    annotation_id: "SYNTHETIC-ANN-B",
    annotator: { annotator_ref: "SYNTHETIC-ANNOTATOR-2", role: "biomechanist", blinded_to_candidates: true },
    events: [syntheticEvent("SYNTHETIC-B1", "hand_entry", "left", 1020), syntheticEvent("SYNTHETIC-B2", "hand_entry", "left", 2600)],
  });
  const adjudicator = syntheticAnnotation({
    annotation_id: "SYNTHETIC-ANN-Z",
    annotator: { annotator_ref: "SYNTHETIC-ANNOTATOR-3", role: "adjudicator", blinded_to_candidates: true },
    events: [syntheticEvent("SYNTHETIC-Z1", "hand_entry", "left", 1000), syntheticEvent("SYNTHETIC-Z2", "hand_entry", "left", 2000)],
  });
  const candidate = syntheticCandidate({ events: [entry(1000), entry(2000)] });

  test("two annotators without an adjudicator leave the clip unresolved and unscored", () => {
    const labelSet = syntheticLabelSet({ annotations: [annA, annB] });
    assert.equal(selectReferenceAnnotation(labelSet), null);
    const report = evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [candidate], config: config() });
    assert.equal(report.clips[0].status, "unresolved_disagreement");
    assert.equal(report.overall.clips_unresolved_disagreement, 1);
    assert.equal(report.overall.events.true_positives, 0);
    const agreement = report.overall.annotator_agreement;
    assert.equal(agreement.annotation_pairs, 1);
    assert.equal(agreement.matched_events, 1);
    assert.equal(agreement.unmatched_events, 2);
    close(agreement.agreement_rate, 1 / 3);
    assert.equal(agreement.offset_ms.meanMs, -20);
  });

  test("an adjudicator's annotation becomes the reference; agreement is still reported", () => {
    const labelSet = syntheticLabelSet({ annotations: [annA, annB, adjudicator] });
    assert.equal(selectReferenceAnnotation(labelSet).basis, "adjudicated");
    const report = evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [candidate], config: config() });
    assert.deepEqual(report.clips[0].reference, { annotation_id: "SYNTHETIC-ANN-Z", basis: "adjudicated" });
    assert.equal(report.overall.events.recall, 1);
    const pairs = computeAnnotatorAgreement(labelSet, config());
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].first_annotation_id, "SYNTHETIC-ANN-A");
  });
});

describe("clips that cannot be scored", () => {
  test("missing candidates, stroke mismatches and unlabelled candidates are counted, not scored", () => {
    const report = evaluateStrokeCandidates({
      labelSets: [
        freestyleLabels([1000], { clip: { clip_ref: "SYNTHETIC-CLIP-X" } }),
        freestyleLabels([1000], { clip: { clip_ref: "SYNTHETIC-CLIP-Y" } }),
      ],
      candidates: [
        syntheticCandidate({ clip_ref: "SYNTHETIC-CLIP-Y", stroke: "backstroke" }),
        syntheticCandidate({ clip_ref: "SYNTHETIC-CLIP-Z" }),
      ],
      config: config(),
    });
    assert.deepEqual(report.clips.map((c) => [c.clip_ref, c.status]), [
      ["SYNTHETIC-CLIP-X", "missing_candidate"],
      ["SYNTHETIC-CLIP-Y", "stroke_mismatch"],
    ]);
    assert.equal(report.by_stroke.freestyle.clips_missing_candidate, 1);
    assert.equal(report.by_stroke.freestyle.clips_stroke_mismatch, 1);
    assert.equal(report.by_stroke.freestyle.clips_evaluated, 0);
    assert.deepEqual(report.inputs.candidates_without_labels, ["SYNTHETIC-CLIP-Z"]);
  });
});

describe("cycles", () => {
  const labelSet = syntheticStrokeLabelSet("freestyle"); // cycles 1000-2000 and 2000-3000, left
  const cfg = config({ cycle_start_tolerance_ms: SYNTHETIC_TOLERANCE_MS });

  test("matches cycle starts and reports count, start and duration errors", () => {
    const candidate = syntheticCandidate({
      clip_ref: labelSet.clip.clip_ref,
      cycles: [{ side: "left", start_ms: 1010, end_ms: 2030 }, { side: "left", start_ms: 2600, end_ms: 3400 }],
    });
    const cycles = evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [candidate], config: cfg }).by_stroke.freestyle.cycles;
    assert.equal(cycles.true_positives, 1);
    assert.equal(cycles.false_positives, 1);
    assert.equal(cycles.false_negatives, 1);
    assert.equal(cycles.cycle_count_error, 0);
    assert.equal(cycles.start_timing_error_ms.meanMs, 10);
    assert.equal(cycles.duration_error_ms.meanMs, 20);
  });

  test("cycles overlapping an abstention are excluded from both sides", () => {
    const candidate = syntheticCandidate({
      clip_ref: labelSet.clip.clip_ref,
      cycles: [{ side: "left", start_ms: 1000, end_ms: 2000 }],
      abstentions: [{ start_ms: 2500, end_ms: 2550, reason: "occlusion" }],
    });
    const cycles = evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [candidate], config: cfg }).by_stroke.freestyle.cycles;
    assert.equal(cycles.reference_cycles_scored, 1);
    assert.equal(cycles.true_positives, 1);
    assert.equal(cycles.false_negatives, 0);
  });

  test("with no cycle tolerance, cycles are not evaluated", () => {
    const report = evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [syntheticPerfectCandidate("freestyle")], config: config() });
    assert.deepEqual(report.clips[0].cycles, { evaluated: false });
    assert.equal(report.by_stroke.freestyle.cycles, null);
  });
});

describe("input guards", () => {
  // Test-only relabelling to exercise the guards. "NOT-REAL-" records
  // are still invented data; nothing here is a real expert label.
  function asNotRealExpert(record) {
    const text = JSON.stringify(record).replace(/SYNTHETIC-/g, "NOT-REAL-").replace(/"data_status":"synthetic"/g, '"data_status":"expert_labelled"');
    const parsed = JSON.parse(text);
    if (parsed.source) parsed.source.kind = "baseline";
    return parsed;
  }

  test("synthetic and expert-labelled data can never be evaluated together", () => {
    assert.throws(
      () => evaluateStrokeCandidates({
        labelSets: [syntheticStrokeLabelSet("freestyle"), asNotRealExpert(syntheticStrokeLabelSet("backstroke"))],
        candidates: [],
        config: config(),
      }),
      /must never be evaluated together/,
    );
  });

  test("non-synthetic inputs are reported as not yet validated, never as validated", () => {
    const report = evaluateStrokeCandidates({
      labelSets: [asNotRealExpert(syntheticStrokeLabelSet("freestyle"))],
      candidates: [asNotRealExpert(syntheticPerfectCandidate("freestyle"))],
      config: config(),
    });
    assert.equal(report.evidence_status, EVIDENCE_STATUS.EXPERT_UNREVIEWED);
    assert.match(report.disclaimer, /not yet reviewed against the stroke validation gate/);
  });

  test("duplicate clips and invalid records are rejected", () => {
    const labelSet = syntheticStrokeLabelSet("freestyle");
    assert.throws(() => evaluateStrokeCandidates({ labelSets: [labelSet, labelSet], candidates: [], config: config() }), /duplicate label set/);
    const candidate = syntheticPerfectCandidate("freestyle");
    assert.throws(() => evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [candidate, candidate], config: config() }), /duplicate candidate set/);
    assert.throws(() => evaluateStrokeCandidates({ labelSets: [{ ...labelSet, extra: 1 }], candidates: [], config: config() }), /Invalid StrokeLabelSet/);
    const late = syntheticCandidate({ clip_ref: labelSet.clip.clip_ref, events: [entry(10001)] });
    assert.throws(() => evaluateStrokeCandidates({ labelSets: [labelSet], candidates: [late], config: config() }), /beyond the clip duration/);
  });
});

describe("determinism and isolation", () => {
  test("input order does not change the report, which is plain JSON and leaves inputs untouched", () => {
    const labelSets = STROKES.map((s) => syntheticStrokeLabelSet(s));
    const candidates = STROKES.map((s) => syntheticPerfectCandidate(s));
    const snapshot = JSON.stringify({ labelSets, candidates });
    const cfg = config({ cycle_start_tolerance_ms: SYNTHETIC_TOLERANCE_MS });
    const forward = evaluateStrokeCandidates({ labelSets, candidates, config: cfg });
    const reversed = evaluateStrokeCandidates({ labelSets: [...labelSets].reverse(), candidates: [...candidates].reverse(), config: cfg });
    assert.deepEqual(reversed, forward);
    assert.deepEqual(JSON.parse(JSON.stringify(forward)), forward);
    assert.equal(JSON.stringify({ labelSets, candidates }), snapshot);
  });

  test("the harness does not touch the browser, network, storage, clock, randomness or detectors", () => {
    for (const file of ["src/evaluation/stroke-labels.js", "src/evaluation/stroke-evaluation.js"]) {
      const code = readFileSync(join(ROOT, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of [/\bdocument\b/, /\bwindow\b/, /\bfetch\s*\(/, /localStorage/, /XMLHttpRequest/, /chase-engine/, /Math\.random/, /Date\.now/, /new Date/, /from "node:/]) {
        assert.doesNotMatch(code, forbidden, `${file} must not use ${forbidden}`);
      }
    }
  });

  test("the browser app does not load the evaluation modules", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    assert.doesNotMatch(html, /src\/evaluation\//);
  });
});
