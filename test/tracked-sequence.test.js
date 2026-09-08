// Unit tests for chaseBuildTrackedSequence() / chaseGenerateSequenceId(),
// TrackedSequence v1 — the additive, session-scoped snapshot of raw
// PoseFrame observations (see src/chase-engine/tracked-sequence.js for
// the full problem statement and the TrackedSequence architecture
// assessment it implements).
//
// These functions live in the standalone classic script
// src/chase-engine/tracked-sequence.js (see the loading-order note at
// the top of that file, and geometry.js's note it references, for why
// it is a classic script, not an ES module). Loaded below via
// loadTrackedSequenceHelpers(), the same self-contained vm-sandbox
// technique pose-frame.test.js/frame-timing.test.js use — this file
// has no cross-file dependency (it does not read metricsHistory or any
// other global), so it does not need the shared
// extract-chase-functions.js harness.
//
// Every "PoseFrame" object below is a hand-built, synthetic stand-in
// for what chaseBuildPoseFrame() would produce — not real pose output,
// and never real swimmer data.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { normalizeVmValue } from "./normalize-vm-value.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKED_SEQUENCE_MODULE_PATH = join(__dirname, "..", "src", "chase-engine", "tracked-sequence.js");
const TRACKED_SEQUENCE_HELPER_NAMES = ["chaseBuildTrackedSequence", "chaseGenerateSequenceId"];

function loadTrackedSequenceHelpers() {
  const source = readFileSync(TRACKED_SEQUENCE_MODULE_PATH, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);

  try {
    vm.runInContext(source, sandbox, { filename: "chase-engine-tracked-sequence.vm.js" });
  } catch (error) {
    throw new Error(
      `Failed to evaluate src/chase-engine/tracked-sequence.js in an isolated vm sandbox: ${error.message}`
    );
  }

  for (const name of TRACKED_SEQUENCE_HELPER_NAMES) {
    if (typeof sandbox[name] === "undefined") {
      throw new Error(
        `src/chase-engine/tracked-sequence.js loaded without error, but "${name}" is not present on ` +
        `the sandbox afterwards. This should not happen and likely indicates the file's ` +
        `contents no longer match TRACKED_SEQUENCE_HELPER_NAMES.`
      );
    }
  }

  return sandbox;
}

const chase = loadTrackedSequenceHelpers();

function syntheticPoseFrame({ frameIndex, videoTimestampMs, hasPose = true }) {
  return {
    frameIndex,
    videoTimestampMs,
    imageWidth: 640,
    imageHeight: 360,
    modelSource: "mediapipe-pose-legacy@0.5.1675469404 (modelComplexity=1)",
    hasPose,
    landmarks: hasPose ? [{ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }] : null,
    worldLandmarks: hasPose ? [{ x: 0.1, y: -0.1, z: 0, visibility: 0.9 }] : null,
  };
}

describe("chaseBuildTrackedSequence() — required fields", () => {
  test("carries all required fields through to the built object", () => {
    const frames = [syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 0 })];

    const sequence = normalizeVmValue(
      chase.chaseBuildTrackedSequence({
        sequenceId: "chase-sequence-gen-3",
        generation: 3,
        timestampMode: "requestVideoFrameCallback",
        modelSource: "mediapipe-pose-legacy@0.5.1675469404 (modelComplexity=1)",
        frames,
      })
    );

    assert.strictEqual(sequence.sequenceId, "chase-sequence-gen-3");
    assert.strictEqual(sequence.generation, 3);
    assert.strictEqual(sequence.timestampMode, "requestVideoFrameCallback");
    assert.strictEqual(sequence.modelSource, "mediapipe-pose-legacy@0.5.1675469404 (modelComplexity=1)");
    assert.strictEqual(sequence.frames.length, 1);
  });
});

describe("chaseBuildTrackedSequence() — optional fields", () => {
  test("clipId/startedAt/endedAt default to null when not supplied", () => {
    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s1",
      generation: 1,
      timestampMode: "requestVideoFrameCallback",
      modelSource: "model-x",
      frames: [],
    });

    assert.strictEqual(sequence.clipId, null);
    assert.strictEqual(sequence.startedAt, null);
    assert.strictEqual(sequence.endedAt, null);
  });

  test("supplied optional fields are preserved exactly", () => {
    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s1",
      generation: 1,
      timestampMode: "requestVideoFrameCallback",
      modelSource: "model-x",
      frames: [],
      clipId: "CLIP-014",
      startedAt: 1000.5,
      endedAt: 2500.25,
    });

    assert.strictEqual(sequence.clipId, "CLIP-014");
    assert.strictEqual(sequence.startedAt, 1000.5);
    assert.strictEqual(sequence.endedAt, 2500.25);
  });
});

describe("chaseBuildTrackedSequence() — sequenceId contract", () => {
  test("the builder preserves the caller-supplied sequenceId verbatim, never regenerating it", () => {
    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "a-caller-chosen-id-not-derived-by-the-builder",
      generation: 5,
      timestampMode: "requestVideoFrameCallback",
      modelSource: "model-x",
      frames: [],
    });

    assert.strictEqual(sequence.sequenceId, "a-caller-chosen-id-not-derived-by-the-builder");
  });
});

describe("chaseGenerateSequenceId(generation) — the caller-side id helper", () => {
  test("is deterministic: the same generation always produces the same id", () => {
    assert.strictEqual(chase.chaseGenerateSequenceId(4), chase.chaseGenerateSequenceId(4));
  });

  test("different generations produce different ids", () => {
    assert.notStrictEqual(chase.chaseGenerateSequenceId(4), chase.chaseGenerateSequenceId(5));
  });
});

describe("chaseBuildTrackedSequence() — generation/timestampMode/modelSource are copied, not transformed", () => {
  test("generation is preserved exactly", () => {
    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 42, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames: [],
    });
    assert.strictEqual(sequence.generation, 42);
  });

  test("timestampMode is preserved exactly for both known modes", () => {
    const rvfc = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames: [],
    });
    const fallback = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "currentTime-fallback-provisional", modelSource: "m", frames: [],
    });
    assert.strictEqual(rvfc.timestampMode, "requestVideoFrameCallback");
    assert.strictEqual(fallback.timestampMode, "currentTime-fallback-provisional");
  });

  test("modelSource is preserved exactly, not derived by scanning frames", () => {
    const frames = [syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 0 })];
    frames[0].modelSource = "a-frame-level-value-that-should-be-ignored";

    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback",
      modelSource: "the-caller-supplied-session-level-value", frames,
    });

    assert.strictEqual(sequence.modelSource, "the-caller-supplied-session-level-value");
  });
});

describe("chaseBuildTrackedSequence() — frames are preserved, never reinterpreted", () => {
  test("frame order is preserved exactly (no sorting)", () => {
    const frames = [
      syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 300 }),
      syntheticPoseFrame({ frameIndex: 1, videoTimestampMs: 100 }),
      syntheticPoseFrame({ frameIndex: 2, videoTimestampMs: 200 }),
    ];

    const sequence = normalizeVmValue(
      chase.chaseBuildTrackedSequence({
        sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames,
      })
    );

    assert.deepStrictEqual(
      sequence.frames.map((f) => f.frameIndex),
      [0, 1, 2]
    );
    assert.deepStrictEqual(
      sequence.frames.map((f) => f.videoTimestampMs),
      [300, 100, 200]
    );
  });

  test("frames with hasPose:false are preserved, not filtered out", () => {
    const frames = [
      syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 0, hasPose: true }),
      syntheticPoseFrame({ frameIndex: 1, videoTimestampMs: 120, hasPose: false }),
      syntheticPoseFrame({ frameIndex: 2, videoTimestampMs: 240, hasPose: true }),
    ];

    const sequence = normalizeVmValue(
      chase.chaseBuildTrackedSequence({
        sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames,
      })
    );

    assert.strictEqual(sequence.frames.length, 3);
    assert.strictEqual(sequence.frames[1].hasPose, false);
    assert.strictEqual(sequence.frames[1].landmarks, null);
  });

  test("duplicate timestamps are preserved, not deduplicated", () => {
    const frames = [
      syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 500 }),
      syntheticPoseFrame({ frameIndex: 1, videoTimestampMs: 500 }),
    ];

    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "currentTime-fallback-provisional", modelSource: "m", frames,
    });

    assert.strictEqual(sequence.frames.length, 2);
    assert.strictEqual(sequence.frames[0].videoTimestampMs, sequence.frames[1].videoTimestampMs);
  });

  test("non-monotonic timestamps are preserved verbatim, not reordered or rejected", () => {
    const frames = [
      syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 1000 }),
      syntheticPoseFrame({ frameIndex: 1, videoTimestampMs: 50 }), // e.g. a seek/loop
      syntheticPoseFrame({ frameIndex: 2, videoTimestampMs: 1100 }),
    ];

    const sequence = normalizeVmValue(
      chase.chaseBuildTrackedSequence({
        sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames,
      })
    );

    assert.deepStrictEqual(
      sequence.frames.map((f) => f.videoTimestampMs),
      [1000, 50, 1100]
    );
  });

  test("an empty frames array produces a well-formed sequence, not a throw or a null return", () => {
    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames: [],
    });

    assert.ok(sequence);
    assert.deepStrictEqual(sequence.frames, []);
  });

  test("a non-array frames input degrades to an empty array rather than throwing", () => {
    const sequence = normalizeVmValue(
      chase.chaseBuildTrackedSequence({
        sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames: undefined,
      })
    );

    assert.deepStrictEqual(sequence.frames, []);
  });
});

describe("chaseBuildTrackedSequence() — defensive copy of the frames array", () => {
  test("mutating the caller's original array after building does not affect the built sequence", () => {
    const sourceFrames = [syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 0 })];

    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m",
      frames: sourceFrames,
    });

    assert.strictEqual(sequence.frames.length, 1);

    // Simulates a straggling, late-resolving pose.send() result pushing
    // into the live chasePoseFrameHistory array after this snapshot was
    // already taken.
    sourceFrames.push(syntheticPoseFrame({ frameIndex: 1, videoTimestampMs: 120 }));

    assert.strictEqual(sourceFrames.length, 2);
    assert.strictEqual(sequence.frames.length, 1, "the already-built sequence must not grow");
  });

  test("the built frames array is a different array instance than the one supplied", () => {
    const sourceFrames = [syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 0 })];

    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m",
      frames: sourceFrames,
    });

    assert.notStrictEqual(sequence.frames, sourceFrames);
  });
});

describe("chaseBuildTrackedSequence() — locked v1 shape", () => {
  test("stores only the v1 contract fields, no speculative additions", () => {
    const sequence = chase.chaseBuildTrackedSequence({
      sequenceId: "s", generation: 1, timestampMode: "requestVideoFrameCallback", modelSource: "m", frames: [],
    });

    const keys = Object.keys(sequence).sort();
    assert.deepStrictEqual(keys, [
      "clipId",
      "endedAt",
      "frames",
      "generation",
      "modelSource",
      "sequenceId",
      "startedAt",
      "timestampMode",
    ]);

    // Explicitly absent: no gaps, smoothing, interpolation, confidence,
    // quality, biomechanics, phases, cycles, tracking identity, or
    // persistence metadata — all deliberately deferred to later,
    // separate layers (see src/chase-engine/tracked-sequence.js).
    assert.strictEqual(sequence.gaps, undefined);
    assert.strictEqual(sequence.frameCount, undefined);
    assert.strictEqual(sequence.poseFoundCount, undefined);
    assert.strictEqual(sequence.confidence, undefined);
    assert.strictEqual(sequence.qualityScore, undefined);
    assert.strictEqual(sequence.smoothing, undefined);
    assert.strictEqual(sequence.trackId, undefined);
  });
});
