// Browser coverage for Chase's integration of the Pose adapter
// (src/inference/pose-adapter.js over src/inference/request-lifecycle.js):
// the one-time warm-up, refusal after a failed warm-up, the deferred
// integrity-latch notification, and session failures (CONSUMER_ERROR,
// RESULT_COPY_FAILED, ARRIVAL_TIME_FAILED).
//
// What this drives: the REAL index.html page in Chromium — the real
// analyzer script, the real Analyze button, the real `ended` listener and
// the real #metrics / #feedback / #chaseStatus elements.
//
// What it does NOT use: real MediaPipe or real video. pose.js is answered
// with a scripted `Pose` stand-in (it computes nothing and reads no
// pixels), every other MediaPipe request with an empty script, and the
// page's <video> gets scripted playback properties so the real rVFC
// ticker can be stepped frame by frame. These are logic tests of the
// page's wiring for each scripted ordering, not evidence of how real
// MediaPipe behaves or of request/result identity (the legacy callback
// carries no request ID).

import { test, expect } from "@playwright/test";

const POSE_STAND_IN = `
(function () {
    "use strict";
    var registry = { instances: [], totalSends: 0 };
    window.__poseStandIn = registry;
    registry.outstanding = function () {
        var n = 0;
        registry.instances.forEach(function (inst) { inst.__sends.forEach(function (s) { if (!s.settled) n++; }); });
        return n;
    };
    function Pose(config) { this.__onResults = null; this.__sends = []; registry.instances.push(this); }
    Pose.prototype.setOptions = function () {};
    Pose.prototype.onResults = function (cb) { this.__onResults = cb; };
    Pose.prototype.initialize = function () { return Promise.resolve(); };
    Pose.prototype.close = function () { return Promise.resolve(); };
    Pose.prototype.send = function (input) {
        var resolveFn, rejectFn;
        var promise = new Promise(function (a, b) { resolveFn = a; rejectFn = b; });
        var record = {
            settled: false,
            image: input && input.image,
            resolve: function () { record.settled = true; resolveFn(); },
            reject: function (error) { record.settled = true; rejectFn(error || new Error("scripted rejection")); }
        };
        this.__sends.push(record);
        registry.totalSends++;
        return promise;
    };
    window.Pose = Pose;
})();
`;

async function openAnalyzer(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error && error.message)));
  await page.route(
    (url) => url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/@mediapipe/"),
    (route) => {
      const isPose = /^\/npm\/@mediapipe\/pose@[^/]+\/pose\.js$/.test(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: isPose ? POSE_STAND_IN : "/* not loaded in tests */" });
    }
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#enterButton").evaluate((button) => button.click());
  await expect(page.locator("#entryGate")).toBeHidden();
  const decline = page.locator('#consentBanner [data-consent-choice="decline"]');
  if (await decline.isVisible()) await decline.click();
  await page.locator("#siteNavToolsButton").click();
  await page.locator("#siteNavToolsMenu button").filter({ hasText: "Chase" }).click();
  await expect(page.locator("#analyzer")).toBeVisible();
  await page.locator("#stroke").selectOption("freestyle");
  const ok = await page.evaluate(installHarness);
  expect(ok, "the analyzer's engine is the scripted stand-in, reached through onChasePoseResults").toBe(true);
  return errors;
}

// Page-side harness (serialized by page.evaluate).
function installHarness() {
  const video = document.getElementById("analyzerPlayer");
  const vs = { currentTime: 0, rvfc: null, handle: 0, plays: 0, throwOnTimeRead: false };
  const define = (name, get, set) => Object.defineProperty(video, name, { configurable: true, get, set: set || (() => {}) });
  define("src", () => "blob:scripted-fixture");
  define("currentTime", () => { if (vs.throwOnTimeRead) throw new Error("scripted currentTime failure"); return vs.currentTime; }, (v) => { vs.currentTime = Number(v); });
  define("readyState", () => 4);
  define("ended", () => false);
  define("videoWidth", () => 640);
  define("videoHeight", () => 360);
  define("duration", () => 30);
  video.play = () => { vs.plays++; return Promise.resolve(); };
  video.requestVideoFrameCallback = (cb) => { vs.rvfc = cb; vs.handle += 1; return vs.handle; };
  video.cancelVideoFrameCallback = () => { vs.rvfc = null; };
  chaseAnalysisCtx.drawImage = () => {}; // the scripted <video> has no pixels; the stand-in reads none

  const engine = pose;
  const all = () => engine.__sends;
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  const poseResult = (seed) => {
    const landmarks = [];
    for (let i = 0; i < 33; i++) landmarks.push({ x: 0.2 + ((i * 7 + seed * 13) % 60) / 100, y: 0.15 + ((i * 11 + seed * 5) % 70) / 100, z: 0, visibility: 0.9 });
    return { poseLandmarks: landmarks, poseWorldLandmarks: landmarks.map((p) => ({ ...p })) };
  };
  const t = {
    vs, flush, poseResult,
    sendCount: () => all().length,
    frameSends: () => all().filter((s) => s.image === chaseAnalysisCanvas).length,
    outstanding: () => window.__poseStandIn.outstanding(),
    frame(seconds) { vs.currentTime = seconds; const cb = vs.rvfc; vs.rvfc = null; if (cb) cb(performance.now(), { mediaTime: seconds }); },
    callback(results) { engine.__onResults(results); },
    async resolveLast() { all()[all().length - 1].resolve(); await flush(); },
    async rejectLast() { all()[all().length - 1].reject(); await flush(); },
    // One frame: dispatched by the real ticker, one callback, then the send resolves.
    async cleanFrame(seconds, seed) {
      const n = all().length;
      t.frame(seconds);
      if (all().length !== n + 1) throw new Error(`frame at ${seconds}s did not dispatch`);
      t.callback(poseResult(seed));
      await t.resolveLast();
    },
    // Completes the pending warm-up send: one no-pose callback, then it resolves.
    async completeWarmup() {
      const w = all()[0];
      if (!w || w.settled) throw new Error("no pending warm-up send");
      t.callback({ poseLandmarks: undefined });
      w.resolve();
      await flush();
    },
    endVideo() { video.dispatchEvent(new Event("ended")); },
    state() {
      return JSON.parse(JSON.stringify({
        metrics: metricsHistory,
        poseFrames: chasePoseFrameHistory,
        analysis: currentAnalysis,
        analyzing,
        lastMetrics: window.lastMetrics,
        tracked: window.chaseAI.lastTrackedSequence,
        integrity: chaseInferenceIntegrityDiagnostics(),
        published: window.chaseAI.inferenceIntegrity,
        rvfcPending: vs.rvfc !== null,
        ui: {
          metrics: document.getElementById("metrics").innerHTML,
          feedback: document.getElementById("feedback").innerHTML,
          status: document.getElementById("chaseStatus").textContent,
        },
      }));
    },
  };
  window.__t = t;
  return engine instanceof window.Pose && engine.__onResults === onChasePoseResults && typeof chaseInferenceAdapter === "object";
}

const clickAnalyze = (page) => page.locator('button[onclick="upload()"]').click();
const waitForSends = (page, n) => page.waitForFunction((count) => window.__t.sendCount() >= count, n);
const st = (page) => page.evaluate(() => window.__t.state());

// Analyze -> warm-up completes -> session running.
async function startFirstAnalysis(page) {
  await clickAnalyze(page);
  await waitForSends(page, 1);
  await page.evaluate(() => window.__t.completeWarmup());
  await expect.poll(async () => (await st(page)).analyzing).toBe(true);
}

// Analyze on a page whose engine is already warm.
async function startAnotherAnalysis(page) {
  await clickAnalyze(page);
  await expect.poll(async () => (await st(page)).analyzing).toBe(true);
}

const histories = (s) => ({ metrics: s.metrics.timestamps.length, poseFrames: s.poseFrames.length, frames: s.analysis.frames });

test.describe("Chase inference through the Pose adapter (scripted Pose stand-in; no real MediaPipe or video)", () => {
  test("warm-up: once, on the first Analyze, before playback; preparing status; no frame before ready; a second click is ignored", async ({ page }) => {
    const errors = await openAnalyzer(page);
    const loaded = await st(page);
    expect(loaded.integrity.engine, "nothing is sent at page load").toBe("CREATED");
    expect(await page.evaluate(() => window.__t.sendCount())).toBe(0);

    await clickAnalyze(page);
    await waitForSends(page, 1);
    const during = await page.evaluate(async () => {
      const t = window.__t;
      const warm = pose.__sends[0];
      const info = {
        state: t.state(),
        plays: t.vs.plays,
        warmIsAnalysisCanvas: warm.image === chaseAnalysisCanvas,
        warmIsCanvas: warm.image instanceof HTMLCanvasElement,
        warmSize: [warm.image.width, warm.image.height],
      };
      // Neither a dispatch attempt nor a second Analyze sends anything while it runs.
      await chaseDispatchPoseInference(document.getElementById("analyzerPlayer"), null);
      info.sendsAfterDispatchAttempt = t.sendCount();
      return info;
    });
    expect(during.state.ui.status).toContain("Preparing the analysis engine… The page may not respond for several seconds while it starts. Please wait.");
    expect(during.state.integrity.engine).toBe("WARMING");
    expect(during.state.analyzing).toBe(false);
    expect(during.plays, "playback waits for the warm-up").toBe(0);
    expect(during.warmIsCanvas && !during.warmIsAnalysisCanvas, "the warm-up input is its own synthetic canvas, not a video frame").toBe(true);
    expect(during.warmSize).toEqual([256, 256]);
    expect(during.sendsAfterDispatchAttempt, "no frame before the engine is ready").toBe(1);

    await clickAnalyze(page); // ignored while preparing
    await page.evaluate(() => window.__t.flush());
    expect(await page.evaluate(() => ({ sends: window.__t.sendCount(), plays: window.__t.vs.plays }))).toEqual({ sends: 1, plays: 0 });

    await page.evaluate(() => window.__t.completeWarmup());
    await expect.poll(async () => (await st(page)).analyzing).toBe(true);
    const running = await st(page);
    expect(running.integrity.engine).toBe("READY");
    expect(running.integrity.counters.warmupsOpened).toBe(1);
    expect(running.integrity.counters.windowsOpened, "the warm-up is not a frame request").toBe(0);
    expect(running.ui.status).toContain("Analysing");
    expect(await page.evaluate(() => window.__t.vs.plays)).toBe(1);

    // Frames now flow, and a later analysis does not warm up again.
    await page.evaluate(() => window.__t.cleanFrame(0, 1));
    await page.evaluate(() => window.__t.endVideo());
    await startAnotherAnalysis(page);
    await page.evaluate(() => window.__t.cleanFrame(0, 2));
    const later = await st(page);
    expect(later.integrity.counters.warmupsOpened).toBe(1);
    expect(await page.evaluate(() => window.__t.sendCount())).toBe(3); // warm-up + one frame per analysis
    expect(histories(later)).toEqual({ metrics: 1, poseFrames: 1, frames: 1 });
    expect(errors).toEqual([]);
  });

  test("a failed warm-up refuses analysis until reload, with a clear message; it is not an integrity latch", async ({ page }) => {
    await openAnalyzer(page);
    await clickAnalyze(page);
    await waitForSends(page, 1);
    await page.evaluate(() => window.__t.rejectLast());
    await expect(page.locator("#chaseStatus")).toContainText("The analysis engine couldn't start. Reload the page before trying again.");
    const failed = await st(page);
    expect(failed.integrity.engine).toBe("WARMUP_FAILED");
    expect(failed.integrity.latched).toBeNull();
    expect(failed.integrity.warmupFailure).not.toBeNull();
    expect(failed.analyzing).toBe(false);
    expect(await page.evaluate(() => window.__t.vs.plays)).toBe(0);

    await clickAnalyze(page);
    await page.evaluate(async () => { await window.__t.flush(); await chaseDispatchPoseInference(document.getElementById("analyzerPlayer"), null); });
    expect(await page.evaluate(() => ({ sends: window.__t.sendCount(), plays: window.__t.vs.plays, analyzing }))).toEqual({ sends: 1, plays: 0, analyzing: false });
    await expect(page.locator("#chaseStatus")).toContainText("The analysis engine couldn't start. Reload the page before trying again.");

    await page.reload();
    await openAnalyzer(page);
    await startFirstAnalysis(page);
    await page.evaluate(() => window.__t.cleanFrame(0, 1));
    expect(histories(await st(page))).toEqual({ metrics: 1, poseFrames: 1, frames: 1 });
  });

  test("latch notification: an unsolicited callback triggers the existing integrity response promptly, outside MediaPipe's callback", async ({ page }) => {
    await openAnalyzer(page);
    await startFirstAnalysis(page);

    const r = await page.evaluate(async () => {
      const t = window.__t;
      await t.cleanFrame(0, 1);
      // Instrument the page's integrity response to see where it runs.
      const original = window.chaseHandleInferenceIntegrityViolation;
      let inCallback = false;
      const calls = [];
      window.chaseHandleInferenceIntegrityViolation = function () { calls.push({ inCallback }); return original.apply(this, arguments); };
      inCallback = true;
      t.callback(t.poseResult(5));                 // no send is open: unsolicited
      inCallback = false;
      const sync = { calls: calls.length, analyzing, latched: t.state().integrity.latched };
      await Promise.resolve();
      await Promise.resolve();
      const afterMicrotasks = { calls: calls.slice(), analyzing };
      await t.flush();
      t.callback(t.poseResult(6));                 // a further anomaly after the latch
      await t.flush();
      return { sync, afterMicrotasks, callsTotal: calls.length, final: t.state(), sends: t.sendCount() };
    });

    expect(r.sync.calls, "not run inside the callback").toBe(0);
    expect(r.sync.latched.violation, "the latch itself is recorded at the callback").toBe("CALLBACK_WITHOUT_OPEN_SEND");
    expect(r.afterMicrotasks.calls, "run promptly, in a microtask after the callback").toEqual([{ inCallback: false }]);
    expect(r.afterMicrotasks.analyzing, "the running session is finished at once").toBe(false);
    expect(r.callsTotal, "once per latch").toBe(1);
    expect(r.final.tracked).toBeNull();
    expect(r.final.ui.metrics).toBe("");
    await expect(page.locator("#feedback")).toContainText("Analysis Withheld");
    await expect(page.locator("#feedback")).toContainText("Reference code: CALLBACK_WITHOUT_OPEN_SEND");
    await expect(page.locator("#chaseStatus")).toContainText("Analysis withheld because results couldn't be matched reliably to video frames. Reload the page before trying again.");

    // Latched until reload: a later Analyze is refused and nothing more is sent.
    await clickAnalyze(page);
    await page.evaluate(() => window.__t.flush());
    expect(await page.evaluate(() => window.__t.sendCount())).toBe(r.sends);
    expect((await st(page)).analyzing).toBe(false);
  });

  const FAILURES = [
    {
      reason: "CONSUMER_ERROR",
      // The page's own result consumer throws partway through (after the
      // metrics for this frame were pushed, while drawing the overlay).
      arm: () => { window.__restore = window.drawChaseSkeleton; window.drawChaseSkeleton = () => { throw new Error("scripted consumer failure"); }; },
      deliver: (t) => t.callback(t.poseResult(3)),
    },
    {
      reason: "RESULT_COPY_FAILED",
      arm: () => {},
      deliver: (t) => { const r = t.poseResult(3); Object.defineProperty(r, "poseLandmarks", { get() { throw new Error("scripted result failure"); } }); t.callback(r); },
    },
    {
      reason: "ARRIVAL_TIME_FAILED",
      arm: () => {},
      deliver: (t) => { t.vs.throwOnTimeRead = true; try { t.callback(t.poseResult(3)); } finally { t.vs.throwOnTimeRead = false; } },
    },
  ];

  for (const f of FAILURES) {
    test(`session failure ${f.reason}: drivers stopped, partial results discarded, prior sequence kept, no report at video end, later analysis works on the same engine`, async ({ page }) => {
      const errors = await openAnalyzer(page);

      // A completed analysis first, so there is a prior TrackedSequence to keep.
      await startFirstAnalysis(page);
      await page.evaluate(async () => { await window.__t.cleanFrame(0, 1); await window.__t.cleanFrame(0.13, 2); window.__t.endVideo(); });
      const prior = await st(page);
      expect(prior.tracked.frames).toHaveLength(2);
      expect(prior.ui.feedback).toContain("Coach Feedback");

      // The analysis that fails: one good frame, then the failing one.
      await startAnotherAnalysis(page);
      const r = await page.evaluate(async ({ armSrc, deliverSrc }) => {
        const t = window.__t;
        await t.cleanFrame(0, 1);
        const partial = t.state();
        (0, eval)(`(${armSrc})`)();
        const n = t.sendCount();
        t.frame(0.13);
        if (t.sendCount() !== n + 1) throw new Error("the failing frame did not dispatch");
        (0, eval)(`(${deliverSrc})`)(t);
        await t.resolveLast();
        if (window.__restore) { window.drawChaseSkeleton = window.__restore; delete window.__restore; }
        const failed = t.state();
        const sendsAtFailure = t.sendCount();
        t.frame(0.26);                               // drivers stopped: nothing more is dispatched
        t.frame(0.39);
        const sendsAfterFrames = t.sendCount();
        t.endVideo();                                // the real `ended` listener
        await t.flush();
        return { partial, failed, sendsAtFailure, sendsAfterFrames, afterEnd: t.state() };
      }, { armSrc: f.arm.toString(), deliverSrc: f.deliver.toString() });

      expect(histories(r.partial), "the first frame had been committed").toEqual({ metrics: 1, poseFrames: 1, frames: 1 });

      // Stopped and discarded.
      expect(r.failed.analyzing).toBe(false);
      expect(r.failed.rvfcPending, "the frame driver is stopped").toBe(false);
      expect(r.sendsAfterFrames).toBe(r.sendsAtFailure);
      expect(histories(r.failed), "all partial results discarded").toEqual({ metrics: 0, poseFrames: 0, frames: 0 });
      expect(Object.values(r.failed.metrics).every((a) => a.length === 0)).toBe(true);
      expect(r.failed.lastMetrics).toBeNull();
      expect(r.failed.ui.metrics, "live metrics removed").toBe("");
      expect(r.failed.ui.feedback).toContain("Analysis Stopped");
      expect(r.failed.ui.feedback).toContain(`Reference code: ${f.reason}`);
      expect(r.failed.ui.feedback).not.toContain("Coach Feedback");
      expect(r.failed.ui.status).toContain("Analysis stopped because a result couldn't be processed. Press Analyze to try again.");

      // Not a latch; engine kept; failure recorded.
      expect(r.failed.integrity.latched).toBeNull();
      expect(r.failed.integrity.engine).toBe("READY");
      expect(r.failed.integrity.sessionFailures.map((x) => x.reason)).toEqual([f.reason]);
      expect(r.failed.published.sessionFailures.map((x) => x.reason)).toEqual([f.reason]);

      // The previous completed sequence is untouched.
      expect(r.failed.tracked).toEqual(prior.tracked);

      // No report at video end.
      expect(r.afterEnd.ui).toEqual(r.failed.ui);
      expect(r.afterEnd.tracked).toEqual(prior.tracked);
      expect(histories(r.afterEnd)).toEqual({ metrics: 0, poseFrames: 0, frames: 0 });

      // A later analysis on the same engine, without reload.
      await startAnotherAnalysis(page);
      const later = await page.evaluate(async () => {
        const t = window.__t;
        await t.cleanFrame(0, 4);
        await t.cleanFrame(0.13, 5);
        t.endVideo();
        return { state: t.state(), instances: window.__poseStandIn.instances.filter((i) => i.__onResults === onChasePoseResults).length };
      });
      expect(later.instances, "same engine: no recreation").toBe(1);
      expect(later.state.integrity.counters.warmupsOpened).toBe(1);
      expect(histories(later.state)).toEqual({ metrics: 2, poseFrames: 2, frames: 2 });
      expect(later.state.ui.feedback).toContain("Coach Feedback");
      expect(later.state.ui.status).toContain("Analysis complete.");
      expect(later.state.tracked.frames).toHaveLength(2);
      expect(later.state.tracked.generation).toBeGreaterThan(prior.tracked.generation);
      expect(errors).toEqual([]);
    });
  }

  test("timestamps: metrics keep the callback-arrival video time; PoseFrames keep the dispatch time", async ({ page }) => {
    await openAnalyzer(page);
    await startFirstAnalysis(page);
    const s = await page.evaluate(async () => {
      const t = window.__t;
      t.frame(1.0);                                // dispatched at mediaTime 1.000 s
      t.vs.currentTime = 1.07;                     // the callback arrives later in the video
      t.callback(t.poseResult(1));
      t.vs.currentTime = 1.1;
      await t.resolveLast();
      return t.state();
    });
    expect(s.metrics.timestamps).toEqual([1070]);
    expect(s.lastMetrics.timestamp).toBe(1.07);
    expect(s.poseFrames[0].videoTimestampMs).toBe(1000);
  });
});
