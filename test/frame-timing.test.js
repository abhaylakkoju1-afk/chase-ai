// Unit tests for the pure frame/timestamp association logic backing
// frame-accurate PoseFrame capture (see src/chase-engine/frame-timing.js
// for the problem statement and the corrected requestVideoFrameCallback
// association model).
//
// These functions are the entire decision logic for (a) whether a
// displayed video frame is due to be analyzed at the existing ~120ms
// cadence, and (b) whether a PoseFrame gets a requestVideoFrameCallback
// -derived timestamp or the provisional video.currentTime fallback.
// Everything browser-specific (registering/cancelling
// requestVideoFrameCallback, drawing to canvas, calling pose.send())
// stays in index.html and is out of scope for a node:test file.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { normalizeVmValue } from "./normalize-vm-value.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAME_TIMING_MODULE_PATH = join(__dirname, "..", "src", "chase-engine", "frame-timing.js");
const FRAME_TIMING_HELPER_NAMES = [
  "chaseSupportsVideoFrameCallback",
  "chaseIsSampleDue",
  "chaseBuildPendingFrameTiming",
  "chaseSelectFrameTimestamp",
];

function loadFrameTimingHelpers() {
  const source = readFileSync(FRAME_TIMING_MODULE_PATH, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);

  try {
    vm.runInContext(source, sandbox, { filename: "chase-engine-frame-timing.vm.js" });
  } catch (error) {
    throw new Error(
      `Failed to evaluate src/chase-engine/frame-timing.js in an isolated vm sandbox: ${error.message}`
    );
  }

  for (const name of FRAME_TIMING_HELPER_NAMES) {
    if (typeof sandbox[name] === "undefined") {
      throw new Error(
        `src/chase-engine/frame-timing.js loaded without error, but "${name}" is not present on ` +
        `the sandbox afterwards. This should not happen and likely indicates the file's ` +
        `contents no longer match FRAME_TIMING_HELPER_NAMES.`
      );
    }
  }

  return sandbox;
}

const frameTiming = loadFrameTimingHelpers();
const SAMPLE_INTERVAL_MS = 120;

describe("chaseSupportsVideoFrameCallback(video)", () => {
  test("true when the video-like object exposes a requestVideoFrameCallback function", () => {
    const video = { requestVideoFrameCallback: () => {} };
    assert.strictEqual(frameTiming.chaseSupportsVideoFrameCallback(video), true);
  });

  test("false when requestVideoFrameCallback is missing (older/unsupporting browser)", () => {
    assert.strictEqual(frameTiming.chaseSupportsVideoFrameCallback({}), false);
  });

  test("false for a non-function property, null, or undefined", () => {
    assert.strictEqual(frameTiming.chaseSupportsVideoFrameCallback({ requestVideoFrameCallback: null }), false);
    assert.strictEqual(frameTiming.chaseSupportsVideoFrameCallback(null), false);
    assert.strictEqual(frameTiming.chaseSupportsVideoFrameCallback(undefined), false);
  });
});

describe("chaseIsSampleDue() — sampling-cadence decision, driven by rVFC-reported mediaTime", () => {
  test("first frame of an analysis (no prior sample) is always due", () => {
    const due = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: null,
      currentMediaTimeMs: 0,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due, true);
  });

  test("a callback that is not yet due (less than ~120ms elapsed) does not trigger a sample", () => {
    const due = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: 1000,
      currentMediaTimeMs: 1050, // only 50ms elapsed
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due, false);
  });

  test("a callback at exactly the sample interval is due", () => {
    const due = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: 1000,
      currentMediaTimeMs: 1120,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due, true);
  });

  test("a callback well past the sample interval is due (preserves ~120ms cadence under jitter, not an exact frame count)", () => {
    const due = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: 1000,
      currentMediaTimeMs: 1180,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due, true);
  });

  test("a backward jump (seek/loop) relative to the last analyzed sample is treated as due, not stalled", () => {
    const due = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: 5000,
      currentMediaTimeMs: 200, // playback jumped backward
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due, true);
  });

  test("a non-finite current mediaTime is never due", () => {
    assert.strictEqual(
      frameTiming.chaseIsSampleDue({
        lastAnalyzedMediaTimeMs: 1000,
        currentMediaTimeMs: NaN,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
      }),
      false
    );
    assert.strictEqual(
      frameTiming.chaseIsSampleDue({
        lastAnalyzedMediaTimeMs: null,
        currentMediaTimeMs: Infinity,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
      }),
      false
    );
  });
});

describe("chaseBuildPendingFrameTiming() — dispatch-time record for one inference request", () => {
  test("uses the rVFC-reported mediaTime FROM THE SAME callback that selected this frame, marked frame-accurate", () => {
    // This is the corrected model: candidateMediaTimeMs must be the
    // exact value the caller observed in the same rVFC callback that
    // decided to sample this frame — never a separately cached value.
    const pending = normalizeVmValue(
      frameTiming.chaseBuildPendingFrameTiming({
        candidateMediaTimeMs: 1234.5,
        supportsVideoFrameCallback: true,
        generation: 3,
        fallbackVideoTimeMs: 9999,
      })
    );

    assert.strictEqual(pending.mediaTimeMs, 1234.5);
    assert.strictEqual(pending.isFrameAccurate, true);
    assert.strictEqual(pending.generation, 3);
  });

  test("falls back to video.currentTime-derived value when rVFC is unsupported", () => {
    const pending = normalizeVmValue(
      frameTiming.chaseBuildPendingFrameTiming({
        candidateMediaTimeMs: null,
        supportsVideoFrameCallback: false,
        generation: 1,
        fallbackVideoTimeMs: 500,
      })
    );

    assert.strictEqual(pending.mediaTimeMs, 500);
    assert.strictEqual(pending.isFrameAccurate, false);
  });

  test("non-finite mediaTime (NaN/Infinity) falls back safely rather than being trusted", () => {
    const nanCase = normalizeVmValue(
      frameTiming.chaseBuildPendingFrameTiming({
        candidateMediaTimeMs: NaN,
        supportsVideoFrameCallback: true,
        generation: 1,
        fallbackVideoTimeMs: 42,
      })
    );
    assert.strictEqual(nanCase.mediaTimeMs, 42);
    assert.strictEqual(nanCase.isFrameAccurate, false);

    const infinityCase = normalizeVmValue(
      frameTiming.chaseBuildPendingFrameTiming({
        candidateMediaTimeMs: Infinity,
        supportsVideoFrameCallback: true,
        generation: 1,
        fallbackVideoTimeMs: 42,
      })
    );
    assert.strictEqual(infinityCase.mediaTimeMs, 42);
    assert.strictEqual(infinityCase.isFrameAccurate, false);
  });
});

describe("chaseSelectFrameTimestamp() — result-time timestamp for one PoseFrame", () => {
  test("a video timestamp remains associated with the mediaTime supplied by the rVFC invocation that selected the frame submitted for inference", () => {
    const pendingTiming = { mediaTimeMs: 1000, isFrameAccurate: true, generation: 5 };

    const selected = normalizeVmValue(
      frameTiming.chaseSelectFrameTimestamp({
        pendingTiming,
        currentGeneration: 5,
        fallbackVideoTimeMs: 1000,
      })
    );

    assert.strictEqual(selected.videoTimestampMs, 1000);
    assert.strictEqual(selected.isFrameAccurate, true);
  });

  test("a later video.currentTime value cannot overwrite the selected mediaTime", () => {
    // The video has moved on by the time inference resolves (simulated
    // by a much larger fallbackVideoTimeMs) — the frozen dispatch-time
    // mediaTime must win, not "now".
    const pendingTiming = { mediaTimeMs: 1000, isFrameAccurate: true, generation: 1 };

    const selected = normalizeVmValue(
      frameTiming.chaseSelectFrameTimestamp({
        pendingTiming,
        currentGeneration: 1,
        fallbackVideoTimeMs: 4500, // "now", well after the captured frame
      })
    );

    assert.strictEqual(selected.videoTimestampMs, 1000);
    assert.notStrictEqual(selected.videoTimestampMs, 4500);
  });

  test("stale generation results cannot use an old session's timestamp (delayed inference across a reset/new upload)", () => {
    // pendingTiming was stamped during session 1; by the time this
    // delayed result arrives, session 2 has already started (new
    // upload) and a later frame's timing would otherwise be sitting in
    // the pending slot. The mismatch must be caught and rejected.
    const pendingTiming = { mediaTimeMs: 1000, isFrameAccurate: true, generation: 1 };

    const selected = normalizeVmValue(
      frameTiming.chaseSelectFrameTimestamp({
        pendingTiming,
        currentGeneration: 2,
        fallbackVideoTimeMs: 250,
      })
    );

    assert.strictEqual(selected.videoTimestampMs, 250);
    assert.strictEqual(selected.isFrameAccurate, false);
    assert.notStrictEqual(selected.videoTimestampMs, 1000);
  });

  test("no pending record at all (e.g. a result arrives before any dispatch was recorded) falls back safely", () => {
    const selected = normalizeVmValue(
      frameTiming.chaseSelectFrameTimestamp({
        pendingTiming: null,
        currentGeneration: 1,
        fallbackVideoTimeMs: 77,
      })
    );

    assert.strictEqual(selected.videoTimestampMs, 77);
    assert.strictEqual(selected.isFrameAccurate, false);
  });

  test("fallback behavior uses the dispatch-time currentTime and is never silently claimed as frame-accurate", () => {
    const pendingTiming = { mediaTimeMs: 10, isFrameAccurate: false, generation: 1 };

    const selected = normalizeVmValue(
      frameTiming.chaseSelectFrameTimestamp({
        pendingTiming,
        currentGeneration: 1,
        fallbackVideoTimeMs: 999,
      })
    );

    // Even though the generation matches and the pending value is used
    // verbatim, isFrameAccurate must propagate as false since it was
    // itself built from a fallback (rVFC unsupported/unavailable).
    assert.strictEqual(selected.videoTimestampMs, 10);
    assert.strictEqual(selected.isFrameAccurate, false);
  });
});

describe("end-to-end: chaseIsSampleDue + chaseBuildPendingFrameTiming + chaseSelectFrameTimestamp together", () => {
  test("a callback that is due creates exactly one pending frame timing record, which survives to result time unchanged", () => {
    const generation = 7;

    // rVFC callback #1: t=0ms, no prior sample -> due.
    const due1 = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: null,
      currentMediaTimeMs: 0,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due1, true);

    const pending1 = frameTiming.chaseBuildPendingFrameTiming({
      candidateMediaTimeMs: 0,
      supportsVideoFrameCallback: true,
      generation,
      fallbackVideoTimeMs: 0,
    });

    // Simulate a delayed result: fallbackVideoTimeMs at result time has
    // moved on, but the frozen pending record must still win.
    const selected1 = frameTiming.chaseSelectFrameTimestamp({
      pendingTiming: pending1,
      currentGeneration: generation,
      fallbackVideoTimeMs: 65, // video kept playing during inference
    });
    assert.strictEqual(selected1.videoTimestampMs, 0);
    assert.strictEqual(selected1.isFrameAccurate, true);

    // rVFC callback #2: t=60ms — well under 120ms since the last
    // ANALYZED sample (0ms) -> not due, no inference should occur.
    const due2 = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: 0,
      currentMediaTimeMs: 60,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due2, false);

    // rVFC callback #3: t=125ms — due again.
    const due3 = frameTiming.chaseIsSampleDue({
      lastAnalyzedMediaTimeMs: 0,
      currentMediaTimeMs: 125,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    assert.strictEqual(due3, true);
  });
});
