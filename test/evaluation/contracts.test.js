// Unit tests for src/evaluation/contracts.js.
//
// These verify factory shape/validation only — no real swimmer data,
// no real annotations. Every clip_id/swimmer_id/annotator_id below is
// an obviously-synthetic placeholder string.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createClipMetadata,
  createGroundTruthEvent,
  createGroundTruthCycle,
  createDetectorPrediction,
  createEvaluationConfig,
  createEvaluationResult,
  createExperiment,
} from "../../src/evaluation/contracts.js";

describe("createClipMetadata()", () => {
  test("builds a record with all required fields", () => {
    const clip = createClipMetadata({
      clip_id: "SYNTHETIC-CLIP-001",
      swimmer_id: "SYNTHETIC-SWIMMER-001",
      stroke: "freestyle",
      camera_view: "side",
      duration_ms: 12000,
      consent_status: "obtained",
      annotation_status: "not_started",
      benchmark_inclusion_status: "pilot_only",
    });
    assert.strictEqual(clip.clip_id, "SYNTHETIC-CLIP-001");
    assert.strictEqual(clip.pilot_condition_tag, null);
  });

  test("throws when a required field is missing", () => {
    assert.throws(() => createClipMetadata({ clip_id: "SYNTHETIC-CLIP-001" }));
  });
});

describe("createGroundTruthEvent()", () => {
  test("builds a record matching Annotation Protocol v0.1 §8 fields", () => {
    const event = createGroundTruthEvent({
      clip_id: "SYNTHETIC-CLIP-001",
      swimmer_id: "SYNTHETIC-SWIMMER-001",
      stroke: "freestyle",
      event_type: "hand_entry",
      timestamp_ms: 1234,
      confidence: "clear",
      ambiguous: false,
      annotator_id: "SYNTHETIC-ANNOTATOR-A",
      protocol_version: "v0.1",
    });
    assert.strictEqual(event.event_type, "hand_entry");
    assert.strictEqual(event.unusable_interval, null);
  });

  test("allows an omitted timestamp for a genuinely indeterminate event (Protocol §9)", () => {
    const event = createGroundTruthEvent({
      clip_id: "SYNTHETIC-CLIP-001",
      swimmer_id: "SYNTHETIC-SWIMMER-001",
      stroke: "freestyle",
      event_type: "wrist_min",
      confidence: "ambiguous",
      ambiguous: true,
      annotator_id: "SYNTHETIC-ANNOTATOR-A",
      protocol_version: "v0.1",
    });
    assert.strictEqual(event.timestamp_ms, undefined);
  });

  test("throws when a required field is missing", () => {
    assert.throws(() => createGroundTruthEvent({ clip_id: "SYNTHETIC-CLIP-001" }));
  });
});

describe("createGroundTruthCycle()", () => {
  test("builds a record referencing two bounding events", () => {
    const startEvent = { event_type: "hand_entry", timestamp_ms: 1000 };
    const endEvent = { event_type: "hand_entry", timestamp_ms: 1900 };
    const cycle = createGroundTruthCycle({
      cycle_id: "SYNTHETIC-CYCLE-001",
      start_event: startEvent,
      end_event: endEvent,
    });
    assert.strictEqual(cycle.start_event, startEvent);
    assert.strictEqual(cycle.end_event, endEvent);
  });

  test("throws when a required field is missing", () => {
    assert.throws(() => createGroundTruthCycle({ cycle_id: "SYNTHETIC-CYCLE-001" }));
  });
});

describe("createDetectorPrediction()", () => {
  test("builds a record without calling or referencing any real detector", () => {
    const prediction = createDetectorPrediction({
      clip_id: "SYNTHETIC-CLIP-001",
      event_type: "wrist_min",
      timestamps_ms: [1000, 2000, 3000],
      detector_commit: "synthetic-fixture-no-real-commit",
      source: "synthetic-fixture",
    });
    assert.deepStrictEqual(prediction.timestamps_ms, [1000, 2000, 3000]);
  });

  test("throws when timestamps_ms is not an array", () => {
    assert.throws(() =>
      createDetectorPrediction({
        clip_id: "SYNTHETIC-CLIP-001",
        event_type: "wrist_min",
        timestamps_ms: "not-an-array",
        detector_commit: "x",
        source: "x",
      })
    );
  });

  test("throws when a required field is missing", () => {
    assert.throws(() => createDetectorPrediction({ clip_id: "SYNTHETIC-CLIP-001" }));
  });
});

describe("createEvaluationConfig() — no default tolerance", () => {
  test("builds a record when an explicit tolerance is supplied", () => {
    const config = createEvaluationConfig({
      dataset_version: "synthetic-v0",
      annotation_version: "synthetic-v0",
      evaluation_version: "synthetic-v0",
      detector_commit: "0000000",
      event_type: "synthetic_test_event",
      matching_tolerance_ms: 42,
    });
    assert.strictEqual(config.matching_tolerance_ms, 42);
  });

  test("throws when matching_tolerance_ms is omitted entirely", () => {
    assert.throws(() =>
      createEvaluationConfig({
        dataset_version: "synthetic-v0",
        annotation_version: "synthetic-v0",
        evaluation_version: "synthetic-v0",
        detector_commit: "0000000",
        event_type: "synthetic_test_event",
      })
    );
  });

  test("throws when matching_tolerance_ms is negative", () => {
    assert.throws(() =>
      createEvaluationConfig({
        dataset_version: "synthetic-v0",
        annotation_version: "synthetic-v0",
        evaluation_version: "synthetic-v0",
        detector_commit: "0000000",
        event_type: "synthetic_test_event",
        matching_tolerance_ms: -1,
      })
    );
  });

  test("throws when matching_tolerance_ms is not a number", () => {
    assert.throws(() =>
      createEvaluationConfig({
        dataset_version: "synthetic-v0",
        annotation_version: "synthetic-v0",
        evaluation_version: "synthetic-v0",
        detector_commit: "0000000",
        event_type: "synthetic_test_event",
        matching_tolerance_ms: "42",
      })
    );
  });
});

describe("createEvaluationResult()", () => {
  test("builds a record with no combined score field present", () => {
    const result = createEvaluationResult({
      clip_id: "SYNTHETIC-CLIP-001",
      config: { matching_tolerance_ms: 42 },
      matches: [],
      unmatchedPredictedIndices: [],
      unmatchedGroundTruthIndices: [],
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: null,
      recall: null,
      f1: null,
      boundaryTimingErrorsMs: [],
    });
    assert.strictEqual(result.score, undefined);
    assert.strictEqual(result.overallScore, undefined);
    assert.strictEqual(result.grade, undefined);
  });

  test("throws when a required field is missing", () => {
    assert.throws(() => createEvaluationResult({ clip_id: "SYNTHETIC-CLIP-001" }));
  });
});

describe("createExperiment()", () => {
  test("builds a reproducibility record with the full version tuple", () => {
    const experiment = createExperiment({
      experiment_id: "SYNTHETIC-EXPERIMENT-001",
      dataset_version: "synthetic-v0",
      annotation_version: "synthetic-v0",
      evaluation_version: "synthetic-v0",
      detector_commit: "0000000",
      configuration: { matching_tolerance_ms: 42 },
      metrics: { precision: 1, recall: 1, f1: 1 },
    });
    assert.strictEqual(experiment.experiment_id, "SYNTHETIC-EXPERIMENT-001");
  });

  test("throws when a required field is missing", () => {
    assert.throws(() => createExperiment({ experiment_id: "SYNTHETIC-EXPERIMENT-001" }));
  });
});
