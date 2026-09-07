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
  createExperimentRun,
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

describe("createExperimentRun()", () => {
  function syntheticConfig() {
    return createEvaluationConfig({
      dataset_version: "synthetic-fixture-v0",
      annotation_version: "synthetic-fixture-v0",
      evaluation_version: "eval-v0",
      detector_commit: "SYNTHETIC-COMMIT-0000000",
      event_type: "synthetic_test_event",
      matching_tolerance_ms: 50,
    });
  }

  function syntheticResult(clip_id, overrides = {}) {
    return createEvaluationResult({
      clip_id,
      config: syntheticConfig(),
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
      ...overrides,
    });
  }

  test("builds a valid run bundling multiple EvaluationResults under one config", () => {
    const config = syntheticConfig();
    const run = createExperimentRun({
      experiment_id: "SYNTHETIC-EXPERIMENT-RUN-001",
      config,
      results: [syntheticResult("SYNTHETIC-CLIP-001"), syntheticResult("SYNTHETIC-CLIP-002")],
      created_at: "2026-09-07T00:00:00.000Z",
    });

    assert.strictEqual(run.experiment_id, "SYNTHETIC-EXPERIMENT-RUN-001");
    assert.strictEqual(run.config, config);
    assert.strictEqual(run.results.length, 2);
    assert.strictEqual(run.created_at, "2026-09-07T00:00:00.000Z");
    assert.strictEqual(run.notes, null);
  });

  test("accepts an empty results array (a run with no evaluated clips yet)", () => {
    const run = createExperimentRun({
      experiment_id: "SYNTHETIC-EXPERIMENT-RUN-EMPTY",
      config: syntheticConfig(),
      results: [],
      created_at: "2026-09-07T00:00:00.000Z",
    });
    assert.deepStrictEqual(run.results, []);
  });

  test("does not accept or duplicate version fields as its own parameters", () => {
    // Passing these should have NO effect: they are not part of
    // createExperimentRun()'s destructured parameters, so they are
    // silently absent from the returned record. The version tuple must
    // be read from `config` only.
    const config = syntheticConfig();
    const run = createExperimentRun({
      experiment_id: "SYNTHETIC-EXPERIMENT-RUN-002",
      config,
      results: [],
      created_at: "2026-09-07T00:00:00.000Z",
      // Deliberately attempting to smuggle in duplicated version fields:
      dataset_version: "SHOULD-BE-IGNORED",
      annotation_version: "SHOULD-BE-IGNORED",
      evaluation_version: "SHOULD-BE-IGNORED",
      detector_commit: "SHOULD-BE-IGNORED",
      event_type: "SHOULD-BE-IGNORED",
      matching_tolerance_ms: 999,
    });

    assert.strictEqual(run.dataset_version, undefined);
    assert.strictEqual(run.annotation_version, undefined);
    assert.strictEqual(run.evaluation_version, undefined);
    assert.strictEqual(run.detector_commit, undefined);
    assert.strictEqual(run.event_type, undefined);
    assert.strictEqual(run.matching_tolerance_ms, undefined);
    // The real values live only on config, exactly once.
    assert.strictEqual(run.config.dataset_version, "synthetic-fixture-v0");
    assert.strictEqual(run.config.detector_commit, "SYNTHETIC-COMMIT-0000000");
  });

  test("throws when a required field is missing", () => {
    assert.throws(() =>
      createExperimentRun({ experiment_id: "SYNTHETIC-EXPERIMENT-RUN-003", config: syntheticConfig(), results: [] })
    );
  });

  test("throws when experiment_id is an empty string", () => {
    assert.throws(() =>
      createExperimentRun({
        experiment_id: "   ",
        config: syntheticConfig(),
        results: [],
        created_at: "2026-09-07T00:00:00.000Z",
      })
    );
  });

  test("throws when results is not an array", () => {
    assert.throws(() =>
      createExperimentRun({
        experiment_id: "SYNTHETIC-EXPERIMENT-RUN-004",
        config: syntheticConfig(),
        results: "not-an-array",
        created_at: "2026-09-07T00:00:00.000Z",
      })
    );
  });

  test("throws when config is missing or not an object", () => {
    assert.throws(() =>
      createExperimentRun({
        experiment_id: "SYNTHETIC-EXPERIMENT-RUN-005",
        config: null,
        results: [],
        created_at: "2026-09-07T00:00:00.000Z",
      })
    );
  });

  describe("created_at validation", () => {
    test("accepts the canonical ISO-8601 timestamp format (new Date().toISOString())", () => {
      const run = createExperimentRun({
        experiment_id: "SYNTHETIC-EXPERIMENT-RUN-006",
        config: syntheticConfig(),
        results: [],
        created_at: "2026-09-07T00:00:00.000Z",
      });
      assert.strictEqual(run.created_at, "2026-09-07T00:00:00.000Z");
    });

    test("accepts a freshly generated new Date().toISOString() value", () => {
      const now = new Date().toISOString();
      const run = createExperimentRun({
        experiment_id: "SYNTHETIC-EXPERIMENT-RUN-007",
        config: syntheticConfig(),
        results: [],
        created_at: now,
      });
      assert.strictEqual(run.created_at, now);
    });

    test("throws when created_at is an empty string", () => {
      assert.throws(() =>
        createExperimentRun({
          experiment_id: "SYNTHETIC-EXPERIMENT-RUN-008",
          config: syntheticConfig(),
          results: [],
          created_at: "",
        })
      );
    });

    test("throws when created_at is an obviously non-date string", () => {
      assert.throws(() =>
        createExperimentRun({
          experiment_id: "SYNTHETIC-EXPERIMENT-RUN-009",
          config: syntheticConfig(),
          results: [],
          created_at: "not-a-date",
        })
      );
    });

    test("throws when created_at is an arbitrary non-date string", () => {
      assert.throws(() =>
        createExperimentRun({
          experiment_id: "SYNTHETIC-EXPERIMENT-RUN-010",
          config: syntheticConfig(),
          results: [],
          created_at: "synthetic-placeholder-text",
        })
      );
    });

    test("throws when created_at is a bare calendar date, not a timestamp", () => {
      // "2026-09-07" parses as a valid Date, but round-trips through
      // toISOString() to "2026-09-07T00:00:00.000Z" (a different
      // string) -- it is a date, not the timestamp format this field
      // requires.
      assert.throws(() =>
        createExperimentRun({
          experiment_id: "SYNTHETIC-EXPERIMENT-RUN-011",
          config: syntheticConfig(),
          results: [],
          created_at: "2026-09-07",
        })
      );
    });

    test("throws when created_at is not a string at all", () => {
      assert.throws(() =>
        createExperimentRun({
          experiment_id: "SYNTHETIC-EXPERIMENT-RUN-012",
          config: syntheticConfig(),
          results: [],
          created_at: 1757200000000,
        })
      );
    });
  });
});
