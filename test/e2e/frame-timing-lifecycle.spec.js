// Lifecycle coverage for requestVideoFrameCallback-driven PoseFrame
// timing (see src/chase-engine/frame-timing.js and its unit tests for
// the pure decision logic this exercises through the real browser code
// in index.html).
//
// This does NOT use a real video fixture or any external test media.
// chaseStartVideoFrameTicker()/chaseStopVideoFrameTicker() only need a
// duck-typed object exposing `ended`, `readyState`, `currentTime`,
// `requestVideoFrameCallback()`, and `cancelVideoFrameCallback()` — and
// chaseDispatchPoseInference() only needs something drawImage() accepts
// as a CanvasImageSource. A blank, in-page <canvas> element satisfies
// both: it IS a valid drawImage() source, and this file adds the
// video-shaped properties/methods it needs on top, entirely
// synthetically, with a fully scripted (not real-time) fake
// requestVideoFrameCallback so callback firing/timing is deterministic.
//
// This intentionally drives index.html's actual, shipped
// chaseStartVideoFrameTicker/chaseStopVideoFrameTicker/
// chaseDispatchPoseInference functions directly (they are `function`
// declarations in the page's classic top-level script, so they are
// reachable as bare identifiers from page.evaluate(), which runs in the
// same realm) — this is real lifecycle coverage of the shipped code,
// not a reimplementation.
//
// VALIDATION STATUS: what this file does NOT cover is real
// browser-native rVFC firing cadence against actually-decoded video
// frames, or real MediaPipe inference — that native, real-video
// validation has not been performed. It is deferred until the
// evaluation pilot clips described in
// docs/evaluation/EVALUATION_INFRASTRUCTURE.md are available; no real
// swimmer footage or video fixture is being added here to close that
// gap early.

import { test, expect } from "@playwright/test";

async function dismissEntryGate(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

// Installs `window.__chaseTestVideo`: a blank canvas standing in for a
// <video> element, plus a scripted fake requestVideoFrameCallback whose
// callback is only ever invoked when the test explicitly fires it (via
// window.__chaseTestFire(mediaTimeMs)) — never on a real timer/rAF —
// so every assertion below is deterministic.
async function installFakeVideo(page) {
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;

    let registeredCallback = null;
    let handleCounter = 0;

    window.__chaseTestState = {
      cancelledHandles: [],
      registrationCount: 0,
    };

    canvas.ended = false;
    canvas.readyState = 4;
    canvas.currentTime = 0;
    canvas.requestVideoFrameCallback = (cb) => {
      registeredCallback = cb;
      handleCounter += 1;
      window.__chaseTestState.registrationCount += 1;
      return handleCounter;
    };
    canvas.cancelVideoFrameCallback = (handle) => {
      window.__chaseTestState.cancelledHandles.push(handle);
    };

    window.__chaseTestVideo = canvas;

    // Fires the currently-registered rVFC callback, if any, with a
    // given mediaTime (seconds, matching the real API's units).
    window.__chaseTestFire = (mediaTimeSeconds) => {
      const cb = registeredCallback;
      registeredCallback = null; // consumed until re-registered
      if (cb) cb(0, { mediaTime: mediaTimeSeconds });
    };

    window.__chaseTestHasPendingCallback = () => registeredCallback !== null;
  });
}

test.describe("PoseFrame frame-timing lifecycle (requestVideoFrameCallback)", () => {
  test("the analyzer script exposes the new timing functions and pure helpers", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const exposed = await page.evaluate(() => ({
      chaseStartVideoFrameTicker: typeof chaseStartVideoFrameTicker,
      chaseStopVideoFrameTicker: typeof chaseStopVideoFrameTicker,
      chaseDispatchPoseInference: typeof chaseDispatchPoseInference,
      chaseSupportsVideoFrameCallback: typeof chaseSupportsVideoFrameCallback,
      chaseIsSampleDue: typeof chaseIsSampleDue,
      chaseBuildPendingFrameTiming: typeof chaseBuildPendingFrameTiming,
      chaseSelectFrameTimestamp: typeof chaseSelectFrameTimestamp,
    }));

    for (const [name, kind] of Object.entries(exposed)) {
      expect(kind, `${name} should be a function`).toBe("function");
    }
  });

  test("a due rVFC frame is drawn and dispatched, associating it with the mediaTime from that same callback", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    await installFakeVideo(page);

    const result = await page.evaluate(() => {
      analyzing = true;
      const generation = ++chaseAnalysisGeneration;
      chaseLastAnalyzedMediaTimeMs = null;
      chasePendingFrameTiming = null;

      chaseStartVideoFrameTicker(window.__chaseTestVideo, generation);
      const registeredBeforeFire = window.__chaseTestHasPendingCallback();

      // First frame of the session: always due (no prior sample).
      window.__chaseTestFire(0);

      return {
        registeredBeforeFire,
        pendingAfterDueFire: chasePendingFrameTiming ? { ...chasePendingFrameTiming } : null,
        lastAnalyzedAfterDueFire: chaseLastAnalyzedMediaTimeMs,
        reregisteredAfterFire: window.__chaseTestHasPendingCallback(),
      };
    });

    expect(result.registeredBeforeFire).toBe(true);
    expect(result.pendingAfterDueFire).not.toBeNull();
    expect(result.pendingAfterDueFire.mediaTimeMs).toBe(0);
    expect(result.pendingAfterDueFire.isFrameAccurate).toBe(true);
    expect(result.lastAnalyzedAfterDueFire).toBe(0);
    // The ticker must re-register itself for the next displayed frame.
    expect(result.reregisteredAfterFire).toBe(true);

    await page.evaluate(() => {
      chaseStopVideoFrameTicker(window.__chaseTestVideo);
      analyzing = false;
    });
  });

  test("a frame that is not yet due (~<120ms elapsed) does not create an inference", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    await installFakeVideo(page);

    const result = await page.evaluate(() => {
      analyzing = true;
      const generation = ++chaseAnalysisGeneration;
      chaseLastAnalyzedMediaTimeMs = null;
      chasePendingFrameTiming = null;

      chaseStartVideoFrameTicker(window.__chaseTestVideo, generation);

      window.__chaseTestFire(0); // due (first frame) -> dispatches, mediaTimeMs 0
      const pendingAfterFirst = chasePendingFrameTiming ? chasePendingFrameTiming.mediaTimeMs : null;

      window.__chaseTestFire(0.06); // 60ms later -> not due yet
      const pendingAfterSecond = chasePendingFrameTiming ? chasePendingFrameTiming.mediaTimeMs : null;
      const lastAnalyzedAfterSecond = chaseLastAnalyzedMediaTimeMs;

      return { pendingAfterFirst, pendingAfterSecond, lastAnalyzedAfterSecond };
    });

    expect(result.pendingAfterFirst).toBe(0);
    // Not due yet: the pending record and the "last analyzed" baseline
    // must be untouched by the 60ms callback.
    expect(result.pendingAfterSecond).toBe(0);
    expect(result.lastAnalyzedAfterSecond).toBe(0);

    await page.evaluate(() => {
      chaseStopVideoFrameTicker(window.__chaseTestVideo);
      analyzing = false;
    });
  });

  test("a due frame while inference is busy is skipped, not queued", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    await installFakeVideo(page);

    const result = await page.evaluate(() => {
      analyzing = true;
      const generation = ++chaseAnalysisGeneration;
      chaseLastAnalyzedMediaTimeMs = null;
      chasePendingFrameTiming = null;
      chaseAnalysisBusy = true; // simulate an in-flight inference

      chaseStartVideoFrameTicker(window.__chaseTestVideo, generation);

      // Due (first frame), but busy -> must be skipped entirely.
      window.__chaseTestFire(0);

      const skippedWhileBusy = {
        pending: chasePendingFrameTiming,
        lastAnalyzed: chaseLastAnalyzedMediaTimeMs,
        stillReregistered: window.__chaseTestHasPendingCallback(),
      };

      chaseAnalysisBusy = false;

      // Now not busy -> the still-due sample should dispatch (0.13s = 130ms).
      window.__chaseTestFire(0.13);

      return {
        skippedWhileBusy,
        pendingAfterUnblock: chasePendingFrameTiming ? chasePendingFrameTiming.mediaTimeMs : null,
      };
    });

    expect(result.skippedWhileBusy.pending).toBeNull();
    expect(result.skippedWhileBusy.lastAnalyzed).toBeNull();
    expect(result.skippedWhileBusy.stillReregistered).toBe(true);
    expect(result.pendingAfterUnblock).toBe(130);

    await page.evaluate(() => {
      chaseStopVideoFrameTicker(window.__chaseTestVideo);
      analyzing = false;
    });
  });

  test("a generation mismatch (new upload/reset while a callback is pending) stops the chain from re-registering", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    await installFakeVideo(page);

    const result = await page.evaluate(() => {
      analyzing = true;
      const staleGeneration = ++chaseAnalysisGeneration;

      chaseStartVideoFrameTicker(window.__chaseTestVideo, staleGeneration);

      // Simulate a new analysis session starting (new upload()) while
      // this ticker's callback is still pending.
      chaseAnalysisGeneration++;

      const registeredBeforeFire = window.__chaseTestHasPendingCallback();
      window.__chaseTestFire(0);

      return {
        registeredBeforeFire,
        reregisteredAfterStaleFire: window.__chaseTestHasPendingCallback(),
        pendingAfterStaleFire: chasePendingFrameTiming,
      };
    });

    expect(result.registeredBeforeFire).toBe(true);
    // A stale-generation firing must neither dispatch nor re-register.
    expect(result.pendingAfterStaleFire).toBeNull();
    expect(result.reregisteredAfterStaleFire).toBe(false);

    await page.evaluate(() => {
      analyzing = false;
    });
  });

  test("stopping analysis explicitly cancels the live requestVideoFrameCallback registration", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    await installFakeVideo(page);

    const result = await page.evaluate(() => {
      analyzing = true;
      const generation = ++chaseAnalysisGeneration;
      chaseStartVideoFrameTicker(window.__chaseTestVideo, generation);

      const registrationCountBeforeStop = window.__chaseTestState.registrationCount;
      chaseStopVideoFrameTicker(window.__chaseTestVideo);

      return {
        registrationCountBeforeStop,
        cancelledHandles: window.__chaseTestState.cancelledHandles,
      };
    });

    expect(result.registrationCountBeforeStop).toBeGreaterThan(0);
    // cancelVideoFrameCallback must have been called with the handle
    // that was actually registered (the last requestVideoFrameCallback
    // return value), not left uncancelled.
    expect(result.cancelledHandles).toEqual([result.registrationCountBeforeStop]);

    await page.evaluate(() => {
      analyzing = false;
    });
  });
});
