// Lifecycle coverage for TrackedSequence v1's live wiring in
// finishChaseAnalysis() (see src/chase-engine/tracked-sequence.js for
// the pure builder and its unit tests, which cover the builder's
// decision logic in isolation).
//
// This does NOT use a real video fixture, real MediaPipe inference, or
// any external test media. finishChaseAnalysis() is driven directly
// via page.evaluate() against synthetic, hand-constructed
// chasePoseFrameHistory/currentAnalysis/chaseAnalysisGeneration state —
// the same page-scoped-`let`-reachable-from-page.evaluate() technique
// established in frame-timing-lifecycle.spec.js. This exercises the
// real, shipped finishChaseAnalysis() function (a `function` declaration
// in index.html's classic top-level script), not a reimplementation.
//
// VALIDATION STATUS: this does not cover a real end-to-end analysis
// run (real video, real MediaPipe) producing chasePoseFrameHistory
// organically — only finishChaseAnalysis()'s handling of whatever
// chasePoseFrameHistory already contains at the moment it runs. Real
// end-to-end validation is deferred, same as frame-timing-lifecycle.spec.js.

import { test, expect } from "@playwright/test";

async function dismissEntryGate(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

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

test.describe("TrackedSequence v1 lifecycle (finishChaseAnalysis wiring)", () => {
  test("the analyzer script exposes the TrackedSequence builder functions", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const exposed = await page.evaluate(() => ({
      chaseBuildTrackedSequence: typeof chaseBuildTrackedSequence,
      chaseGenerateSequenceId: typeof chaseGenerateSequenceId,
      finishChaseAnalysis: typeof finishChaseAnalysis,
    }));

    expect(exposed.chaseBuildTrackedSequence).toBe("function");
    expect(exposed.chaseGenerateSequenceId).toBe("function");
    expect(exposed.finishChaseAnalysis).toBe("function");
  });

  test("finishChaseAnalysis() builds window.chaseAI.lastTrackedSequence from chasePoseFrameHistory, additively", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const result = await page.evaluate((frames) => {
      // Synthetic session state — no real video, no MediaPipe.
      analyzing = true;
      chaseAnalysisGeneration = 9;
      window.chaseAI.videoTimestampMode = "requestVideoFrameCallback";
      currentAnalysis = { frames: 2, validFrames: 2, startedAt: 1000, endedAt: null };
      chasePoseFrameHistory = frames;

      // metricsHistory left exactly as it already was (empty at page
      // load) — this session's finishChaseAnalysis() call should not
      // need any metricsHistory data to build the sequence.
      const metricsHistoryBefore = JSON.parse(JSON.stringify(metricsHistory));

      finishChaseAnalysis();

      const metricsHistoryAfter = JSON.parse(JSON.stringify(metricsHistory));

      return {
        sequence: window.chaseAI.lastTrackedSequence,
        metricsHistoryUnchanged: JSON.stringify(metricsHistoryBefore) === JSON.stringify(metricsHistoryAfter),
        chasePoseFrameHistoryStillIntact: chasePoseFrameHistory.length,
      };
    }, [
      syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 0 }),
      syntheticPoseFrame({ frameIndex: 1, videoTimestampMs: 120, hasPose: false }),
    ]);

    expect(result.sequence).not.toBeNull();
    expect(result.sequence.generation).toBe(9);
    expect(result.sequence.timestampMode).toBe("requestVideoFrameCallback");
    expect(result.sequence.startedAt).toBe(1000);
    expect(result.sequence.frames).toHaveLength(2);
    expect(result.sequence.frames[1].hasPose).toBe(false);
    expect(result.sequence.sequenceId).toBe("chase-sequence-gen-9");

    // Additivity: TrackedSequence's introduction must not have touched
    // metricsHistory or chasePoseFrameHistory itself.
    expect(result.metricsHistoryUnchanged).toBe(true);
    expect(result.chasePoseFrameHistoryStillIntact).toBe(2);

    await page.evaluate(() => { analyzing = false; });
  });

  test("finishChaseAnalysis() sets lastTrackedSequence to null when zero PoseFrames were captured, not an empty-but-valid sequence", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const result = await page.evaluate(() => {
      analyzing = true;
      chaseAnalysisGeneration = 3;
      window.chaseAI.videoTimestampMode = "requestVideoFrameCallback";
      currentAnalysis = { frames: 0, validFrames: 0, startedAt: 500, endedAt: null };
      chasePoseFrameHistory = [];
      window.chaseAI.lastTrackedSequence = "sentinel-should-be-overwritten";

      finishChaseAnalysis();

      return window.chaseAI.lastTrackedSequence;
    });

    expect(result).toBeNull();

    await page.evaluate(() => { analyzing = false; });
  });

  test("a later push onto chasePoseFrameHistory after finishChaseAnalysis() does not retroactively change the already-built sequence", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const result = await page.evaluate((frame) => {
      analyzing = true;
      chaseAnalysisGeneration = 11;
      window.chaseAI.videoTimestampMode = "requestVideoFrameCallback";
      currentAnalysis = { frames: 1, validFrames: 1, startedAt: 0, endedAt: null };
      chasePoseFrameHistory = [frame];

      finishChaseAnalysis();

      const lengthImmediatelyAfter = window.chaseAI.lastTrackedSequence.frames.length;

      // Simulate a straggling, late-resolving pose.send() result still
      // pushing into the live array after the session already "ended".
      chasePoseFrameHistory.push({ frameIndex: 1, videoTimestampMs: 999, hasPose: false, imageWidth: null, imageHeight: null, modelSource: null, landmarks: null, worldLandmarks: null });

      return {
        lengthImmediatelyAfter,
        liveArrayLengthNow: chasePoseFrameHistory.length,
        sequenceLengthNow: window.chaseAI.lastTrackedSequence.frames.length,
      };
    }, syntheticPoseFrame({ frameIndex: 0, videoTimestampMs: 0 }));

    expect(result.lengthImmediatelyAfter).toBe(1);
    expect(result.liveArrayLengthNow).toBe(2);
    expect(result.sequenceLengthNow).toBe(1);

    await page.evaluate(() => { analyzing = false; });
  });
});
