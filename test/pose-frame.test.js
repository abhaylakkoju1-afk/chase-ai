// Unit tests for chaseBuildPoseFrame() / chaseCopyPoseLandmarks(),
// the additive, parallel raw-evidence capture added alongside
// metricsHistory (see docs/evaluation research report on PoseFrame /
// TrackedSequence). These functions live in the standalone classic
// script src/chase-engine/pose-frame.js (see the loading-order note at
// the top of that file for why it is a classic script, not an ES
// module). Loaded below via loadPoseFrameHelpers(), the same
// self-contained vm-sandbox technique geometry.test.js uses — this
// file has no cross-file dependency (unlike stats.js/stroke-cycles.js,
// which need metricsHistory), so it does not need the shared
// extract-chase-functions.js harness.
//
// Every MediaPipe "results" object below is a hand-built, synthetic
// stand-in for what pose.onResults() would deliver — not real pose
// output, and never real swimmer data.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { normalizeVmValue } from "./normalize-vm-value.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSE_FRAME_MODULE_PATH = join(__dirname, "..", "src", "chase-engine", "pose-frame.js");
const POSE_FRAME_HELPER_NAMES = ["chaseBuildPoseFrame", "chaseCopyPoseLandmarks"];

function loadPoseFrameHelpers() {
  const source = readFileSync(POSE_FRAME_MODULE_PATH, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);

  try {
    vm.runInContext(source, sandbox, { filename: "chase-engine-pose-frame.vm.js" });
  } catch (error) {
    throw new Error(
      `Failed to evaluate src/chase-engine/pose-frame.js in an isolated vm sandbox: ${error.message}`
    );
  }

  for (const name of POSE_FRAME_HELPER_NAMES) {
    if (typeof sandbox[name] === "undefined") {
      throw new Error(
        `src/chase-engine/pose-frame.js loaded without error, but "${name}" is not present on ` +
        `the sandbox afterwards. This should not happen and likely indicates the file's ` +
        `contents no longer match POSE_FRAME_HELPER_NAMES.`
      );
    }
  }

  return sandbox;
}

const chase = loadPoseFrameHelpers();

function syntheticLandmark(x, y, z, visibility) {
  return { x, y, z, visibility };
}

describe("chaseBuildPoseFrame() — a result containing pose landmarks", () => {
  test("preserves normalized landmarks, world landmarks, and context fields exactly", () => {
    const results = {
      poseLandmarks: [
        syntheticLandmark(0.5, 0.25, -0.1, 0.98),
        syntheticLandmark(0.4, 0.3, -0.05, 0.6),
      ],
      poseWorldLandmarks: [
        syntheticLandmark(0.1, -0.2, 0.05, 0.98),
        syntheticLandmark(0.08, -0.15, 0.02, 0.6),
      ],
    };

    const frame = normalizeVmValue(
      chase.chaseBuildPoseFrame({
        results,
        frameIndex: 3,
        videoTimestampMs: 1234.5,
        imageWidth: 640,
        imageHeight: 360,
        modelSource: "mediapipe-pose-legacy@0.5.1675469404 (modelComplexity=1)",
      })
    );

    assert.strictEqual(frame.frameIndex, 3);
    assert.strictEqual(frame.videoTimestampMs, 1234.5);
    assert.strictEqual(frame.imageWidth, 640);
    assert.strictEqual(frame.imageHeight, 360);
    assert.strictEqual(frame.modelSource, "mediapipe-pose-legacy@0.5.1675469404 (modelComplexity=1)");
    assert.strictEqual(frame.hasPose, true);

    assert.deepStrictEqual(frame.landmarks, [
      { x: 0.5, y: 0.25, z: -0.1, visibility: 0.98 },
      { x: 0.4, y: 0.3, z: -0.05, visibility: 0.6 },
    ]);
    assert.deepStrictEqual(frame.worldLandmarks, [
      { x: 0.1, y: -0.2, z: 0.05, visibility: 0.98 },
      { x: 0.08, y: -0.15, z: 0.02, visibility: 0.6 },
    ]);
  });

  test("does not mutate the original MediaPipe results/landmark objects", () => {
    const originalLandmark = syntheticLandmark(0.5, 0.25, -0.1, 0.98);
    const results = { poseLandmarks: [originalLandmark], poseWorldLandmarks: [] };
    const snapshotBefore = JSON.stringify(originalLandmark);

    chase.chaseBuildPoseFrame({ results, frameIndex: 0, videoTimestampMs: 0 });

    assert.strictEqual(JSON.stringify(originalLandmark), snapshotBefore);
  });

  test("stores only observations, never derived/interpreted fields", () => {
    const results = { poseLandmarks: [syntheticLandmark(0.5, 0.25, -0.1, 0.98)] };
    const frame = chase.chaseBuildPoseFrame({ results, frameIndex: 0, videoTimestampMs: 0 });

    const keys = Object.keys(frame).sort();
    assert.deepStrictEqual(keys, [
      "frameIndex",
      "hasPose",
      "imageHeight",
      "imageWidth",
      "landmarks",
      "modelSource",
      "videoTimestampMs",
      "worldLandmarks",
    ]);
    // Explicitly absent: no elbowAngle, bodyAlignment, stroke phase,
    // stroke rate, symmetry, or any quality/confidence score field.
    assert.strictEqual(frame.elbowAngle, undefined);
    assert.strictEqual(frame.bodyAlignment, undefined);
    assert.strictEqual(frame.qualityScore, undefined);
  });

  test("a landmark missing `visibility` is normalized to null, not undefined or NaN", () => {
    const results = { poseLandmarks: [{ x: 0.1, y: 0.2, z: 0.3 }] };
    const frame = chase.chaseBuildPoseFrame({ results, frameIndex: 0, videoTimestampMs: 0 });

    assert.strictEqual(frame.landmarks[0].visibility, null);
    assert.strictEqual(frame.landmarks[0].x, 0.1);
  });

  test("world landmarks missing even though pose landmarks are present -> worldLandmarks is null, landmarks still populated", () => {
    const results = { poseLandmarks: [syntheticLandmark(0.5, 0.25, -0.1, 0.98)] };
    const frame = chase.chaseBuildPoseFrame({ results, frameIndex: 0, videoTimestampMs: 0 });

    assert.strictEqual(frame.worldLandmarks, null);
    assert.strictEqual(frame.landmarks.length, 1);
  });
});

describe("chaseBuildPoseFrame() — an analysis attempt where no pose landmarks were returned", () => {
  test("hasPose is false and both landmark arrays are null, but context fields are still captured", () => {
    const frame = chase.chaseBuildPoseFrame({
      results: { poseLandmarks: undefined },
      frameIndex: 7,
      videoTimestampMs: 5000,
      imageWidth: 640,
      imageHeight: 360,
      modelSource: "mediapipe-pose-legacy@0.5.1675469404 (modelComplexity=1)",
    });

    assert.strictEqual(frame.hasPose, false);
    assert.strictEqual(frame.landmarks, null);
    assert.strictEqual(frame.worldLandmarks, null);
    // Distinguishing "no landmarks this frame" from "never attempted"
    // requires these to survive even on a miss.
    assert.strictEqual(frame.frameIndex, 7);
    assert.strictEqual(frame.videoTimestampMs, 5000);
    assert.strictEqual(frame.imageWidth, 640);
    assert.strictEqual(frame.imageHeight, 360);
  });

  test("an empty poseLandmarks array is also treated as no pose", () => {
    const frame = chase.chaseBuildPoseFrame({
      results: { poseLandmarks: [] },
      frameIndex: 1,
      videoTimestampMs: 100,
    });
    assert.strictEqual(frame.hasPose, false);
    assert.strictEqual(frame.landmarks, null);
  });

  test("a completely missing results object degrades gracefully (no throw)", () => {
    const frame = chase.chaseBuildPoseFrame({ frameIndex: 0, videoTimestampMs: 0 });
    assert.strictEqual(frame.hasPose, false);
    assert.strictEqual(frame.landmarks, null);
    assert.strictEqual(frame.worldLandmarks, null);
  });
});

describe("chaseBuildPoseFrame() — optional context fields", () => {
  test("imageWidth/imageHeight/modelSource default to null when not supplied", () => {
    const frame = chase.chaseBuildPoseFrame({
      results: { poseLandmarks: [syntheticLandmark(0.1, 0.1, 0.1, 1)] },
      frameIndex: 0,
      videoTimestampMs: 0,
    });
    assert.strictEqual(frame.imageWidth, null);
    assert.strictEqual(frame.imageHeight, null);
    assert.strictEqual(frame.modelSource, null);
  });
});

describe("chaseCopyPoseLandmarks()", () => {
  test("returns null for a non-array input", () => {
    assert.strictEqual(chase.chaseCopyPoseLandmarks(undefined), null);
    assert.strictEqual(chase.chaseCopyPoseLandmarks(null), null);
  });

  test("returns a new array of new plain objects, not references to the input", () => {
    const input = [syntheticLandmark(0.1, 0.2, 0.3, 0.9)];
    const copied = chase.chaseCopyPoseLandmarks(input);
    assert.notStrictEqual(copied, input);
    assert.notStrictEqual(copied[0], input[0]);
    assert.deepStrictEqual(normalizeVmValue(copied[0]), { x: 0.1, y: 0.2, z: 0.3, visibility: 0.9 });
  });
});
