// Browser coverage for the Chase inference-integrity change
// (docs/CHASE_INFERENCE_INTEGRITY.md, decision INT-1 in docs/DECISIONS.md).
//
// What this drives: the REAL index.html page in Chromium — the real
// analyzer script, the real Analyze button, the real `ended` listener,
// and the real #metrics / #feedback / #chaseStatus elements.
//
// What it does NOT use:
// - real MediaPipe. Every request under cdn.jsdelivr.net/npm/@mediapipe/
//   is answered by this spec: pose.js with a scripted `Pose` stand-in,
//   everything else with an empty script. The stand-in delivers exactly
//   the callbacks and settlements each test asks for; it never reads
//   pixels and never computes a pose.
// - real video or swimmer footage. The page's own <video> element is
//   given scripted playback properties (src, currentTime, readyState,
//   play(), requestVideoFrameCallback()) so the real rVFC ticker can be
//   stepped frame by frame. No media is loaded.
//
// These tests therefore show what the analyzer does for each scripted
// ordering in a real browser. They are NOT evidence about which
// orderings real MediaPipe produces, and they do NOT establish
// request/result identity: the legacy onResults callback carries no
// request ID, and nothing here changes that (see the residual test).
//
// Nothing in this file writes to the repository. The pre-change
// index.html used by the equivalence tests is read from Git by blob id
// and served from memory for that test only.

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The pre-integrity main-branch index.html blob used by the Node analyzer harness.
const PRE_INTEGRITY_INDEX_BLOB = "19d32c86049f5180518b95b0da71fa2ed73511f8";

const STROKES = ["freestyle", "backstroke", "butterfly", "breaststroke"];
const RESEARCH_STROKES = ["backstroke", "butterfly", "breaststroke"];

// ---------------------------------------------------------------------
// Scripted MediaPipe Pose stand-in, served in place of pose.js.
// ---------------------------------------------------------------------

const POSE_STAND_IN = `
/* Test-only scripted stand-in for the legacy MediaPipe Pose API.
   Not MediaPipe: it computes nothing and reads no pixels. */
(function () {
    "use strict";
    var registry = { instances: [], maxOutstanding: 0, totalSends: 0 };
    window.__poseStandIn = registry;
    function outstandingAll() {
        var n = 0;
        registry.instances.forEach(function (inst) {
            inst.__sends.forEach(function (s) { if (!s.settled) n++; });
        });
        return n;
    }
    registry.outstanding = outstandingAll;
    function Pose(config) {
        this.__config = config || null;
        this.__options = null;
        this.__onResults = null;
        this.__sends = [];
        registry.instances.push(this);
    }
    Pose.prototype.setOptions = function (options) { this.__options = JSON.parse(JSON.stringify(options)); };
    Pose.prototype.onResults = function (cb) { this.__onResults = cb; };
    Pose.prototype.initialize = function () { return Promise.resolve(); };
    Pose.prototype.close = function () { return Promise.resolve(); };
    Pose.prototype.send = function (input) {
        var resolveFn, rejectFn;
        var promise = new Promise(function (a, b) { resolveFn = a; rejectFn = b; });
        var record = {
            settled: false,
            hadImage: !!(input && input.image),
            resolve: function () { record.settled = true; resolveFn(); },
            reject: function (error) { record.settled = true; rejectFn(error || new Error("scripted rejection")); }
        };
        this.__sends.push(record);
        registry.totalSends++;
        registry.maxOutstanding = Math.max(registry.maxOutstanding, outstandingAll());
        return promise;
    };
    window.Pose = Pose;
})();
`;

// Answers every MediaPipe request locally. Returns the list of MediaPipe
// URLs the page asked for, so a test can show no model or wasm asset was
// ever requested (the stand-in never calls locateFile).
async function stubMediaPipe(page) {
  const requested = [];
  await page.route(
    (url) => url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/@mediapipe/"),
    (route) => {
      const url = new URL(route.request().url());
      requested.push(url.pathname);
      const isPose = /^\/npm\/@mediapipe\/pose@[^/]+\/pose\.js$/.test(url.pathname);
      return route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        body: isPose ? POSE_STAND_IN : "/* MediaPipe asset not loaded in tests */",
      });
    }
  );
  return requested;
}

function expectOnlyStubbedMediaPipeScripts(requested) {
  for (const path of requested) {
    expect(path, "only the three <script> URLs, never a model/wasm asset").toMatch(
      /^\/npm\/@mediapipe\/(pose|camera_utils|drawing_utils)@[^/]+\/(pose|camera_utils|drawing_utils)\.js$/
    );
  }
}

// Serves the pre-integrity index.html (from Git, in memory) for this page.
async function servePreIntegrityIndex(page, html) {
  await page.route(
    (url) => url.host === "127.0.0.1:4173" && (url.pathname === "/" || url.pathname === "/index.html"),
    (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  );
}

function preIntegrityIndexHtml() {
  try {
    return execFileSync("git", ["cat-file", "blob", PRE_INTEGRITY_INDEX_BLOB], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Page-side harness (serialized into the page by page.evaluate).
// ---------------------------------------------------------------------

function installHarnessInPage() {
  const video = document.getElementById("analyzerPlayer");
  const vstate = { currentTime: 0, videoWidth: 640, videoHeight: 360, rvfc: null, handle: 0, cancelled: [], playGate: null, plays: 0 };
  const define = (name, get, set) => Object.defineProperty(video, name, { configurable: true, get, set: set || (() => {}) });
  define("src", () => "blob:scripted-fixture");
  define("currentTime", () => vstate.currentTime, (v) => { vstate.currentTime = Number(v); });
  define("readyState", () => 4);
  define("ended", () => false);
  define("videoWidth", () => vstate.videoWidth);
  define("videoHeight", () => vstate.videoHeight);
  define("duration", () => 30);
  video.play = () => { vstate.plays++; return vstate.playGate ? vstate.playGate.promise : Promise.resolve(); };
  video.requestVideoFrameCallback = (cb) => { vstate.rvfc = cb; vstate.handle += 1; return vstate.handle; };
  video.cancelVideoFrameCallback = (h) => { vstate.cancelled.push(h); vstate.rvfc = null; };

  // The analyzer's own Pose instance (the `pose` global), never the Race page's.
  const analyzerPose = pose;
  const sends = () => analyzerPose.__sends;

  // Every touch of the hidden analysis canvas, with whether any send was
  // outstanding at that moment. drawImage is recorded, not performed: the
  // stand-in never reads pixels, and the scripted <video> has none.
  const canvasEvents = [];
  const proto = HTMLCanvasElement.prototype;
  for (const dim of ["width", "height"]) {
    const d = Object.getOwnPropertyDescriptor(proto, dim);
    Object.defineProperty(chaseAnalysisCanvas, dim, {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) { canvasEvents.push({ type: "resize", dim, value: v, outstanding: window.__poseStandIn.outstanding() }); d.set.call(this, v); },
    });
  }
  chaseAnalysisCtx.drawImage = () => {
    canvasEvents.push({ type: "draw", outstanding: window.__poseStandIn.outstanding(), sendsBefore: window.__poseStandIn.totalSends });
  };

  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

  // 33 visible landmarks whose geometry depends on `seed` (same generator
  // as the Node harness), so different seeds give different metrics.
  const poseResult = (seed) => {
    const landmarks = [];
    for (let i = 0; i < 33; i++) {
      landmarks.push({ x: 0.2 + ((i * 7 + seed * 13) % 60) / 100, y: 0.15 + ((i * 11 + seed * 5) % 70) / 100, z: 0, visibility: 0.9 });
    }
    return { poseLandmarks: landmarks, poseWorldLandmarks: landmarks.map((p) => ({ ...p })), image: { seed } };
  };
  const noPoseResult = () => ({ poseLandmarks: undefined, image: {} });

  const t = {
    vstate,
    canvasEvents,
    poseResult,
    noPoseResult,
    flush,
    sendCount: () => sends().length,
    outstanding: () => window.__poseStandIn.outstanding(),
    maxOutstanding: () => window.__poseStandIn.maxOutstanding,
    // Presents a frame at `seconds`; the real rVFC ticker decides whether to dispatch.
    frame(seconds) { vstate.currentTime = seconds; const cb = vstate.rvfc; vstate.rvfc = null; if (cb) cb(performance.now(), { mediaTime: seconds }); },
    callback(results) { analyzerPose.__onResults(results); },
    async resolve(i) { sends()[i].resolve(); await flush(); },
    async reject(i) { sends()[i].reject(); await flush(); },
    async cleanFrame(seconds, seed) {
      const n = sends().length;
      t.frame(seconds);
      if (sends().length !== n + 1) throw new Error(`frame at ${seconds}s did not dispatch`);
      t.callback(poseResult(seed));
      await t.resolve(n);
    },
    holdPlayback() { let release; const promise = new Promise((r) => { release = r; }); vstate.playGate = { promise, release: () => { vstate.playGate = null; release(); } }; },
    releasePlayback() { if (vstate.playGate) vstate.playGate.release(); },
    endVideo() { video.dispatchEvent(new Event("ended")); },
    state() {
      return JSON.parse(JSON.stringify({
        metrics: metricsHistory,
        poseFrames: chasePoseFrameHistory,
        analysis: { frames: currentAnalysis.frames, validFrames: currentAnalysis.validFrames },
        analyzing,
        busy: chaseAnalysisBusy,
        generation: chaseAnalysisGeneration,
        integrity: typeof chaseInferenceIntegrity !== "undefined" ? chaseInferenceIntegritySummary(chaseInferenceIntegrity) : null,
        tracked: window.chaseAI.lastTrackedSequence,
        ui: {
          metrics: document.getElementById("metrics").innerHTML,
          feedback: document.getElementById("feedback").innerHTML,
          status: document.getElementById("chaseStatus").textContent,
        },
      }));
    },
  };
  window.__t = t;
  return {
    standInInstances: window.__poseStandIn.instances.length,
    analyzerUsesStandIn: analyzerPose instanceof window.Pose && analyzerPose.__onResults === onChasePoseResults,
  };
}

// ---------------------------------------------------------------------
// Node-side helpers.
// ---------------------------------------------------------------------

async function dismissEntryGate(page) {
  await page.locator("#enterButton").evaluate((button) => button.click());
  await expect(page.locator("#entryGate")).toBeHidden();
  const declineAnalytics = page.locator('#consentBanner [data-consent-choice="decline"]');
  if (await declineAnalytics.isVisible()) await declineAnalytics.click();
}

// From a freshly loaded page: open the analyzer, select the stroke, install the harness.
async function enterAnalyzer(page, stroke = "freestyle") {
  await dismissEntryGate(page);
  await page.locator("#siteNavToolsButton").click();
  await page.locator("#siteNavToolsMenu button").filter({ hasText: "Chase" }).click();
  await expect(page.locator("#analyzer")).toBeVisible();
  await page.locator("#stroke").selectOption(stroke);
  const installed = await page.evaluate(installHarnessInPage);
  expect(installed.analyzerUsesStandIn, "the analyzer is wired to the scripted stand-in, not MediaPipe").toBe(true);
}

async function openAnalyzer(page, { stroke = "freestyle", html = null } = {}) {
  const mediapipeRequests = await stubMediaPipe(page);
  if (html) await servePreIntegrityIndex(page, html);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await enterAnalyzer(page, stroke);
  return mediapipeRequests;
}

// Clicks the real Analyze button and lets upload() run to completion.
async function clickAnalyze(page) {
  await page.locator('button[onclick="upload()"]').click();
  await page.evaluate(() => window.__t.flush());
}

async function startSession(page) {
  await clickAnalyze(page);
  const s = await page.evaluate(() => window.__t.state());
  expect(s.analyzing, "the session started").toBe(true);
  return s;
}

const lengths = (s) => ({ metrics: s.metrics.timestamps.length, poseFrames: s.poseFrames.length, frames: s.analysis.frames });
const EMPTY = { metrics: 0, poseFrames: 0, frames: 0 };

// ---------------------------------------------------------------------
// The integrity cases.
// ---------------------------------------------------------------------

test.describe("Chase inference integrity in the browser (scripted Pose stand-in; no real MediaPipe or video)", () => {
  test("1. a callback before pose.send() settles is held, then committed exactly once at settlement", async ({ page }) => {
    const mediapipe = await openAnalyzer(page);
    await startSession(page);

    const r = await page.evaluate(async () => {
      const t = window.__t;
      t.frame(0.5);
      const sendsAfterFrame = t.sendCount();
      t.vstate.currentTime = 0.52;                 // the callback arrives a little later in the video
      t.callback(t.poseResult(1));
      const beforeSettle = t.state();
      t.vstate.currentTime = 0.56;                 // the send settles later still
      await t.resolve(0);
      const afterSettle = t.state();
      await t.flush();
      return { sendsAfterFrame, beforeSettle, afterSettle, later: t.state() };
    });

    expect(r.sendsAfterFrame).toBe(1);
    expect(lengths(r.beforeSettle), "nothing is committed while the send is outstanding").toEqual(EMPTY);
    expect(r.beforeSettle.integrity.status).toBe("SEND_OUTSTANDING");
    expect(r.beforeSettle.ui.metrics, "no live metrics before settlement").toBe("");

    expect(lengths(r.afterSettle)).toEqual({ metrics: 1, poseFrames: 1, frames: 1 });
    expect(r.afterSettle.metrics.timestamps[0], "metric stamp: video time at callback arrival, as before").toBe(520);
    expect(r.afterSettle.poseFrames[0].videoTimestampMs, "PoseFrame stamp: that send's dispatch-time rVFC mediaTime").toBe(500);
    expect(r.afterSettle.integrity.counters.resultsCommitted).toBe(1);
    expect(r.afterSettle.integrity.latched).toBeNull();
    expect(lengths(r.later), "committed once, not again").toEqual({ metrics: 1, poseFrames: 1, frames: 1 });

    await expect(page.locator("#metrics")).toContainText("Frames analysed: 1");
    expectOnlyStubbedMediaPipeScripts(mediapipe);
  });

  test("2. a send resolving without a callback withholds the analysis and refuses a later upload until reload", async ({ page }) => {
    await openAnalyzer(page);
    await startSession(page);

    const s = await page.evaluate(async () => {
      const t = window.__t;
      await t.cleanFrame(0, 1);
      t.frame(0.13);
      await t.resolve(1);                          // settles with no callback observed
      return t.state();
    });

    expect(s.integrity.latched.violation).toBe("RESOLVED_WITHOUT_CALLBACK");
    expect(s.analyzing, "the running session is finished at once").toBe(false);
    expect(s.tracked, "no TrackedSequence for a withheld session").toBeNull();
    await expect(page.locator("#feedback")).toContainText("Analysis Withheld");
    await expect(page.locator("#feedback")).toContainText("Reference code: RESOLVED_WITHOUT_CALLBACK");
    await expect(page.locator("#feedback")).not.toContainText("Coach Feedback");
    await expect(page.locator("#chaseStatus")).toContainText("Analysis withheld because results couldn't be matched reliably to video frames. Reload the page before trying again.");
    expect(s.ui.metrics, "live metrics from the withheld session are cleared").toBe("");

    // A later upload through the real Analyze button is refused explicitly.
    await clickAnalyze(page);
    const refused = await page.evaluate(async () => {
      const t = window.__t;
      const before = t.sendCount();
      await chaseDispatchPoseInference(document.getElementById("analyzerPlayer"), null);
      return { state: t.state(), sendsBefore: before, sendsAfter: t.sendCount(), plays: t.vstate.plays };
    });
    expect(refused.state.analyzing).toBe(false);
    expect(refused.plays, "playback was not even started for the refused upload").toBe(1);
    expect(refused.sendsAfter, "no further send on this page").toBe(refused.sendsBefore);
    await expect(page.locator("#chaseStatus")).toContainText("Analysis withheld because results couldn't be matched reliably to video frames. Reload the page before trying again.");
    await expect(page.locator("#feedback")).toContainText("Reload the page before trying again.");

    // After a reload, analysis works again.
    await page.reload();
    await enterAnalyzer(page);
    const fresh = await page.evaluate(() => window.__t.state());
    expect(fresh.integrity.latched).toBeNull();
    await startSession(page);
    const after = await page.evaluate(async () => { await window.__t.cleanFrame(0, 2); return window.__t.state(); });
    expect(lengths(after)).toEqual({ metrics: 1, poseFrames: 1, frames: 1 });
  });

  test("3. a late callback after that violation is dropped and changes nothing", async ({ page }) => {
    await openAnalyzer(page);
    await startSession(page);

    const r = await page.evaluate(async () => {
      const t = window.__t;
      await t.cleanFrame(0, 1);
      t.frame(0.13);
      await t.resolve(1);                          // RESOLVED_WITHOUT_CALLBACK
      const atViolation = t.state();
      t.callback(t.poseResult(2));                 // ...the result then arrives late
      await t.flush();
      return { atViolation, afterLate: t.state() };
    });

    expect(lengths(r.afterLate), "the late result reached no history").toEqual(lengths(r.atViolation));
    expect(r.afterLate.metrics).toEqual(r.atViolation.metrics);
    expect(r.afterLate.poseFrames).toEqual(r.atViolation.poseFrames);
    expect(r.afterLate.integrity.counters.callbacksDropped).toBe(r.atViolation.integrity.counters.callbacksDropped + 1);
    expect(r.afterLate.integrity.latched.violation, "the first violation stays recorded").toBe("RESOLVED_WITHOUT_CALLBACK");
    expect(r.afterLate.ui.feedback).toBe(r.atViolation.ui.feedback);
    expect(r.afterLate.ui.metrics).toBe("");
    await expect(page.locator("#feedback")).toContainText("Analysis Withheld");
  });

  test("4. multiple callbacks in one send window withhold the analysis", async ({ page }) => {
    await openAnalyzer(page);
    await startSession(page);

    const r = await page.evaluate(async () => {
      const t = window.__t;
      await t.cleanFrame(0, 1);
      t.frame(0.13);
      t.callback(t.poseResult(1));
      t.callback(t.poseResult(2));                 // a second callback in the same window
      const atSecond = t.state();
      await t.resolve(1);
      return { atSecond, settled: t.state() };
    });

    expect(r.atSecond.integrity.latched.violation).toBe("MULTIPLE_CALLBACKS_FOR_SEND");
    expect(r.atSecond.analyzing).toBe(false);
    expect(lengths(r.settled), "only the first frame, committed before the anomaly").toEqual({ metrics: 1, poseFrames: 1, frames: 1 });
    expect(r.settled.tracked).toBeNull();
    expect(r.settled.ui.metrics).toBe("");
    await expect(page.locator("#feedback")).toContainText("Analysis Withheld");
    await expect(page.locator("#feedback")).toContainText("Reference code: MULTIPLE_CALLBACKS_FOR_SEND");
    await expect(page.locator("#chaseStatus")).toContainText("Analysis withheld because results couldn't be matched reliably to video frames. Reload the page before trying again.");
  });

  test("5. an old session's callback during restart playback never enters the new session's metrics or PoseFrames", async ({ page }) => {
    await openAnalyzer(page);
    const first = await startSession(page);

    await page.evaluate(() => { window.__t.frame(0); window.__t.holdPlayback(); });   // A outstanding in session 1
    await clickAnalyze(page);                                                         // session 2 waits on play()

    const r = await page.evaluate(async () => {
      const t = window.__t;
      const duringRestart = t.state();
      t.callback(t.poseResult(9));                 // A's result arrives during restart playback
      await t.resolve(0);
      t.releasePlayback();
      await t.flush();
      const afterOldSettled = t.state();
      await t.cleanFrame(0, 2);
      return { duringRestart, afterOldSettled, afterNewFrame: t.state(), seed2First: t.poseResult(2).poseLandmarks[0], seed9First: t.poseResult(9).poseLandmarks[0] };
    });

    expect(r.duringRestart.generation).toBe(first.generation + 1);
    expect(lengths(r.duringRestart)).toEqual(EMPTY);
    expect(lengths(r.afterOldSettled), "the old result is discarded, not committed to the new session").toEqual(EMPTY);
    expect(r.afterOldSettled.analyzing).toBe(true);
    expect(r.afterOldSettled.integrity.counters.resultsDiscardedStale).toBe(1);
    expect(r.afterOldSettled.integrity.latched).toBeNull();
    expect(r.afterOldSettled.ui.metrics).toBe("");

    expect(lengths(r.afterNewFrame)).toEqual({ metrics: 1, poseFrames: 1, frames: 1 });
    expect(r.afterNewFrame.poseFrames[0].videoTimestampMs).toBe(0);
    expect(r.afterNewFrame.poseFrames[0].landmarks[0].x).toBe(r.seed2First.x);
    expect(r.afterNewFrame.poseFrames[0].landmarks[0].x).not.toBe(r.seed9First.x);
    await expect(page.locator("#metrics")).toContainText("Frames analysed: 1");
  });

  test("6. a send outstanding across stop and restart prevents overlapping sends and any analysis-canvas redraw", async ({ page }) => {
    await openAnalyzer(page);
    await startSession(page);

    const beforeRestart = await page.evaluate(async () => {
      const t = window.__t;
      await t.cleanFrame(0, 1);
      t.frame(0.13);                               // send 1 stays outstanding
      stopChaseAnalysis();
      t.vstate.videoWidth = 1280;                  // the next session's video has a different size
      return { state: t.state(), outstanding: t.outstanding(), canvasEvents: t.canvasEvents.length };
    });
    expect(beforeRestart.outstanding).toBe(1);
    expect(beforeRestart.state.busy, "stop does not clear the outstanding send").toBe(true);

    await clickAnalyze(page);                       // restart while send 1 is outstanding

    const r = await page.evaluate(async () => {
      const t = window.__t;
      const restarted = t.state();
      t.frame(0);
      t.frame(0.13);                               // due frames, refused: the old send is outstanding
      const whileOutstanding = { sends: t.sendCount(), canvasEvents: t.canvasEvents.length };
      t.callback(t.poseResult(2));                 // the old send's result: held, then discarded
      await t.resolve(1);
      const afterOld = t.state();
      t.frame(0.26);                               // now the new session dispatches
      t.callback(t.poseResult(3));
      await t.resolve(2);
      return { restarted, whileOutstanding, afterOld, final: t.state(), canvasEvents: t.canvasEvents, maxOutstanding: t.maxOutstanding() };
    });

    expect(r.restarted.analyzing).toBe(true);
    expect(r.whileOutstanding.sends, "no new send while the old one is outstanding").toBe(2);
    expect(r.whileOutstanding.canvasEvents, "no draw or resize of the analysis canvas while it may be read").toBe(beforeRestart.canvasEvents);
    expect(r.afterOld.busy).toBe(false);
    expect(r.afterOld.integrity.latched).toBeNull();
    expect(r.afterOld.integrity.counters.resultsDiscardedStale).toBe(1);
    expect(r.maxOutstanding, "never two sends outstanding at once").toBe(1);

    expect(r.canvasEvents.filter((e) => e.outstanding), JSON.stringify(r.canvasEvents)).toEqual([]);
    const resizes = r.canvasEvents.filter((e) => e.type === "resize").slice(-2);
    expect(resizes.map((e) => e.value), "the canvas is resized for the new video only at the new session's first dispatch").toEqual([640, 180]);

    expect(lengths(r.final)).toEqual({ metrics: 1, poseFrames: 1, frames: 1 });
    expect(r.final.poseFrames[0].videoTimestampMs).toBe(260);
    expect(r.final.poseFrames[0].imageWidth).toBe(640);
    expect(r.final.poseFrames[0].imageHeight).toBe(180);
  });

  test("7. a callback after finishChaseAnalysis() cannot change the report or the histories", async ({ page }) => {
    await openAnalyzer(page);
    await startSession(page);

    const r = await page.evaluate(async () => {
      const t = window.__t;
      await t.cleanFrame(0, 1);
      await t.cleanFrame(0.13, 2);
      t.frame(0.26);                               // outstanding when the video ends
      t.endVideo();                                // the real `ended` listener runs finishChaseAnalysis()
      const atFinish = t.state();
      t.callback(t.poseResult(3));
      await t.resolve(2);
      return { atFinish, after: t.state() };
    });

    expect(r.atFinish.analyzing).toBe(false);
    expect(r.atFinish.ui.feedback).toContain("Coach Feedback");
    expect(r.after.metrics).toEqual(r.atFinish.metrics);
    expect(r.after.poseFrames).toEqual(r.atFinish.poseFrames);
    expect(r.after.analysis).toEqual(r.atFinish.analysis);
    expect(r.after.tracked.frames).toHaveLength(2);
    expect(r.after.tracked).toEqual(r.atFinish.tracked);
    expect(r.after.ui).toEqual(r.atFinish.ui);
    expect(r.after.integrity.counters.resultsDiscardedStale).toBe(1);
    expect(r.after.integrity.latched).toBeNull();
    await expect(page.locator("#chaseStatus")).toContainText("Analysis complete.");
  });

  // The documented residual (docs/CHASE_INFERENCE_INTEGRITY.md §4). This is
  // NOT a protected case. It asserts the unprotected behaviour on purpose,
  // so that the limit stays visible and a future change to it is noticed.
  test("8. NOT PROTECTED — documented residual: a foreign callback observed alone in a send window, with that send's own callback missing or delayed beyond the report, is not identified and is committed", async ({ page }) => {
    await openAnalyzer(page);
    await startSession(page);

    const r = await page.evaluate(async () => {
      const t = window.__t;
      await t.cleanFrame(0, 1);                    // A, committed
      t.frame(0.13);                               // B dispatched
      t.callback(t.poseResult(1));                 // a duplicate of A's result; B's own does not arrive
      await t.resolve(1);
      const committed = t.state();
      t.endVideo();                                // the report is built before B's own result arrives
      const reported = t.state();
      t.callback(t.poseResult(2));                 // B's own result, after the report
      await t.flush();
      return { committed, reported, afterLate: t.state() };
    });

    // The foreign result is committed as B's, and nothing flags it.
    expect(lengths(r.committed)).toEqual({ metrics: 2, poseFrames: 2, frames: 2 });
    expect(r.committed.integrity.latched, "undetectable when it happens: no request/result identity").toBeNull();
    expect(r.committed.poseFrames[1].videoTimestampMs, "stamped with B's dispatch time").toBe(130);
    expect(r.committed.poseFrames[1].landmarks, "...but carrying A's landmarks").toEqual(r.committed.poseFrames[0].landmarks);
    expect(r.committed.metrics.elbow[1]).toBe(r.committed.metrics.elbow[0]);

    // The report is produced normally from data that includes it.
    expect(r.reported.ui.feedback).toContain("Coach Feedback");
    expect(r.reported.ui.feedback).not.toContain("Withheld");
    expect(r.reported.tracked.frames).toHaveLength(2);

    // B's own late result is detected from then on, but the report
    // already shown is not retracted.
    expect(r.afterLate.integrity.latched.violation).toBe("CALLBACK_WITHOUT_OPEN_SEND");
    expect(r.afterLate.ui.feedback, "the report already shown is not retracted").toBe(r.reported.ui.feedback);
    expect(r.afterLate.tracked).toEqual(r.reported.tracked);
    await expect(page.locator("#chaseStatus")).toContainText("Results couldn't be matched reliably to video frames. Reload the page before trying again.");
  });
});

// ---------------------------------------------------------------------
// Clean serial input: equivalence with the pre-change analyzer, per stroke.
// ---------------------------------------------------------------------

// Ten frames, each dispatched, called back once and resolved in order
// (frame 5 has no pose), then the real `ended` event.
async function scriptedSerialRun(page) {
  await startSession(page);
  return page.evaluate(async () => {
    const t = window.__t;
    for (let i = 0; i < 10; i++) {
      const seconds = i * 0.13;
      const n = t.sendCount();
      t.frame(seconds);
      if (t.sendCount() !== n + 1) throw new Error(`frame ${i} did not dispatch`);
      t.vstate.currentTime = seconds + 0.02;
      t.callback(i === 4 ? t.noPoseResult() : t.poseResult(i + 1));
      t.vstate.currentTime = seconds + 0.04;
      await t.resolve(n);
    }
    t.endVideo();
    const s = t.state();
    return {
      data: { metrics: s.metrics, poseFrames: s.poseFrames, analysis: s.analysis, trackedFrames: s.tracked && s.tracked.frames },
      ui: s.ui,
      maxOutstanding: t.maxOutstanding(),
    };
  });
}

test.describe("Clean serial analysis data is unchanged from the pre-integrity analyzer", () => {
  const oldHtml = preIntegrityIndexHtml();

  for (const stroke of STROKES) {
    test(`${stroke}: histories, live metrics, existing report content and status match the pre-change index.html`, async ({ page, context }) => {
      if (!oldHtml) {
        // Locally, a checkout without the baseline skips with this reason.
        // In CI (full history, fetch-depth: 0) it must exist, so a missing
        // baseline fails instead of skipping silently.
        test.skip(!process.env.CI, "pre-integrity index.html blob is not available from Git in this checkout");
        throw new Error(`pre-integrity index.html blob ${PRE_INTEGRITY_INDEX_BLOB} is not in this checkout; CI needs full history (fetch-depth: 0)`);
      }

      await openAnalyzer(page, { stroke });
      const after = await scriptedSerialRun(page);

      const oldPage = await context.newPage();
      await openAnalyzer(oldPage, { stroke, html: oldHtml });
      const oldHasIntegrity = await oldPage.evaluate(() => typeof chaseInferenceIntegrity !== "undefined");
      expect(oldHasIntegrity, "the comparison page really is the pre-change analyzer").toBe(false);
      const before = await scriptedSerialRun(oldPage);
      await oldPage.close();

      expect(after.data.metrics.timestamps).toHaveLength(9);
      expect(after.data).toEqual(before.data);
      expect(after.ui.metrics).toBe(before.ui.metrics);
      const withoutStrokeContext = html => html
        .replace(/<section data-stroke-context="[^"]+">[\s\S]*?<\/section>/, "")
        .replace(/>\s+</g, "><")
        .trim();
      expect(withoutStrokeContext(after.ui.feedback)).toBe(withoutStrokeContext(before.ui.feedback));
      expect(after.ui.status).toBe(before.ui.status);
      expect(after.maxOutstanding).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------
test.describe("Stroke capabilities and report guidance", () => {
  test("non-freestyle detectors remain research-only and every stroke has camera-specific guidance", async ({ page }) => {
    test.setTimeout(90_000);
    await openAnalyzer(page, { stroke: "freestyle" });
    const support = await page.evaluate(() => JSON.parse(JSON.stringify(CHASE_STROKE_SUPPORT)));
    expect(support.freestyle.supported).toBe(true);
    for (const stroke of RESEARCH_STROKES) expect(support[stroke].supported, stroke).toBe(false);

    for (const stroke of STROKES) {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await enterAnalyzer(page, stroke);
      const run = await scriptedSerialRun(page);
      const contextText = await page.locator(`section[data-stroke-context="${stroke}"]`).innerText();
      expect(contextText, stroke).toContain("research-informed viewing guidance");
      expect(contextText, stroke).toContain("not stroke detection or a technique score");
      const note = "does not yet have a stroke-specific biomechanical model";
      if (stroke === "freestyle") expect(run.ui.feedback).not.toContain(note);
      else expect(run.ui.feedback, stroke).toContain(note);
    }
  });
});
