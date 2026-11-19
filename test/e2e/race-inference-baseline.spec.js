// BASELINE: the Race page's CURRENT inference lifecycle, recorded before any
// change to it (CLAUDE.md §7: smoke coverage before a refactor). These tests
// describe what the page does today, including behaviour that a later,
// separately approved change may alter (for example the overlap after a
// restart, or a late result being processed after the video ended). A test
// here passing means "unchanged", not "correct".
//
// WHAT IS REAL: index.html's Race page, its Start / Stop buttons, its video
// `change` and `ended` handlers, its frame driver (raceStartVideoFrameTicker,
// raceDispatchPoseInference, the busy flag), onRacePoseResults,
// src/race-pipeline/* (controller, pose-sample adapter, frame timing),
// SwimmerTracking, ChronosEngine, and the report / diagnostics / status DOM.
//
// WHAT IS SCRIPTED:
// - MediaPipe. pose.js is answered with a stand-in `Pose` whose send()
//   returns a promise the test settles by hand and whose results callback
//   the test invokes by hand. It computes nothing, reads no pixels, and
//   never asks for a model or wasm file. Every other @mediapipe script is
//   answered with an empty script. It is NOT evidence of how real
//   MediaPipe orders callbacks and settlements.
// - The <video>. #racePlayer gets scripted playback properties (src,
//   currentTime, readyState, ended, paused, size, play/pause/load) and its
//   requestVideoFrameCallback is captured, so the test presents frames at
//   exact media times. No media is loaded and no footage is used.
//
// Observation: the page's state is module-scoped, so the tests read it
// through the DOM and through pass-through spies on the shared
// SwimmerTracking module object (observe(): the PoseSample the controller
// received, including its atMs) and the shared window.ChronosEngine
// (buildReport() / abortSession() calls). Nothing in index.html is changed.

import { test, expect } from "@playwright/test";

const KNOWN_BASELINE_ERROR = "updateProfileAccountSection is not defined";

// Manually settled stand-in for the legacy Pose API (NOT MediaPipe).
const POSE_STAND_IN = `
(function () {
    "use strict";
    var registry = { instances: [], totalSends: 0, maxOutstanding: 0, locateFileCalls: 0 };
    window.__poseStandIn = registry;
    function outstanding() {
        var n = 0;
        registry.instances.forEach(function (inst) { inst.__sends.forEach(function (s) { if (!s.settled) n++; }); });
        return n;
    }
    registry.outstanding = outstanding;
    function Pose(config) {
        this.__config = config || null;
        this.__onResults = null;
        this.__sends = [];
        registry.instances.push(this);
    }
    Pose.prototype.setOptions = function () {};
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
            reject: function (e) { record.settled = true; rejectFn(e || new Error("scripted rejection")); }
        };
        this.__sends.push(record);
        registry.totalSends++;
        registry.maxOutstanding = Math.max(registry.maxOutstanding, outstanding());
        return promise;
    };
    window.Pose = Pose;
})();
`;

async function stubMediaPipe(page) {
  const requested = [];
  await page.route(
    (url) => url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/@mediapipe/"),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requested.push(path);
      const isPose = /^\/npm\/@mediapipe\/pose@[^/]+\/pose\.js$/.test(path);
      return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: isPose ? POSE_STAND_IN : "/* not loaded in tests */" });
    }
  );
  return requested;
}

// Runs in the page after load: scripted <video>, frame-callback capture,
// pass-through spies, and helpers on window.__r.
async function installHarness(page, { rvfc = true } = {}) {
  await page.evaluate(async ({ rvfc }) => {
    const video = document.getElementById("racePlayer");
    const vs = { src: "", currentTime: 0, ended: false, paused: true, plays: 0, loads: 0, cb: null, handle: 0, cancelled: 0 };
    const define = (name, get, set) => Object.defineProperty(video, name, { configurable: true, get, set: set || (() => {}) });
    define("src", () => vs.src, (v) => { vs.src = String(v); });
    define("currentTime", () => vs.currentTime, (v) => { vs.currentTime = Number(v); });
    define("readyState", () => 4);
    define("ended", () => vs.ended);
    define("paused", () => vs.paused);
    define("videoWidth", () => 640);
    define("videoHeight", () => 360);
    define("duration", () => 30);
    video.load = () => { vs.loads++; };
    video.play = () => { vs.plays++; vs.paused = false; return Promise.resolve(); };
    video.pause = () => { vs.paused = true; };
    if (rvfc) {
      video.requestVideoFrameCallback = (cb) => { vs.cb = cb; vs.handle += 1; return vs.handle; };
      video.cancelVideoFrameCallback = () => { vs.cancelled++; vs.cb = null; };
    } else {
      video.requestVideoFrameCallback = undefined;
      video.cancelVideoFrameCallback = undefined;
    }

    // Pass-through spies on the SAME module objects the page's controller uses.
    const tracking = (await import("/src/swimmer-tracking/index.js")).SwimmerTracking;
    const observed = [];
    const observe = tracking.observe;
    tracking.observe = function (session, sample) {
      observed.push({ atMs: sample ? sample.atMs : null, hasPose: !!(sample && sample.hasPose) });
      return observe.apply(this, arguments);
    };
    const engine = window.ChronosEngine;
    const calls = { buildReport: 0, abortSession: 0 };
    for (const name of ["buildReport", "abortSession"]) {
      const fn = engine[name];
      engine[name] = function () { calls[name]++; return fn.apply(this, arguments); };
    }

    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
    // Chase creates its own Pose at DOMContentLoaded (index.html, initialiseChasePose);
    // the Race instance is the one whose callback is not Chase's.
    const isChase = (inst) => inst.__onResults === window.onChasePoseResults;
    const raceInstances = () => window.__poseStandIn.instances.filter((inst) => !isChase(inst));
    const raceInstance = () => raceInstances()[raceInstances().length - 1];
    const sends = () => window.__poseStandIn.instances.flatMap((inst) => inst.__sends);

    // 33 visible landmarks; nose and hips at `hip` (normalised x).
    const pose = (hip) => {
      const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
      lm[0] = { x: hip + 0.04, y: 0.5, z: 0, visibility: 0.9 };
      lm[23] = { x: hip, y: 0.5, z: 0, visibility: 0.9 };
      lm[24] = { x: hip, y: 0.5, z: 0, visibility: 0.9 };
      return { poseLandmarks: lm, image: {} };
    };

    window.__r = {
      vs, observed, calls, flush, pose,
      sendCount: () => sends().length,
      outstanding: () => window.__poseStandIn.outstanding(),
      maxOutstanding: () => window.__poseStandIn.maxOutstanding,
      instances: () => window.__poseStandIn.instances.length,
      raceInstances: () => raceInstances().length,
      chaseSends: () => window.__poseStandIn.instances.filter(isChase).reduce((n, inst) => n + inst.__sends.length, 0),
      raceSends: () => raceInstances().reduce((n, inst) => n + inst.__sends.length, 0),
      // Present a frame: currentTime and the frame callback's mediaTime may differ on purpose.
      frame(mediaTimeS, currentTimeS = mediaTimeS) {
        vs.currentTime = currentTimeS;
        const cb = vs.cb; vs.cb = null;
        if (cb) cb(performance.now(), { mediaTime: mediaTimeS });
        return !!cb;
      },
      callback(results) { raceInstance().__onResults(results); },
      async resolve(i) { sends()[i].resolve(); await flush(); },
      async reject(i) { sends()[i].reject(); await flush(); },
      endVideo() { vs.ended = true; video.dispatchEvent(new Event("ended")); },
      dom() {
        return {
          status: document.getElementById("racePipelineStatus").textContent,
          report: document.getElementById("racePipelineReport").innerHTML,
          pb: document.getElementById("racePipelinePbComparison").innerHTML,
          // The panel sits in a collapsed <details>, so innerText is empty: read each line's text.
          diagnostics: [...document.querySelectorAll("#racePipelineDiagnostics .metric-box")].map((el) => el.textContent).join(" | "),
          calibration: document.getElementById("raceCalibrationStatus").textContent,
        };
      },
    };
  }, { rvfc });
}

async function openRacePage(page, opts) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requested = await stubMediaPipe(page);
  await page.goto("/index.html", { waitUntil: "load" });
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
  await page.evaluate(() => showPage("race"));
  await installHarness(page, opts);
  return { errors, requested };
}

// Uses the page's real controls: a file choice (scripted src), event and
// course, then the real calibration gesture (button, paused frame, click).
async function configureRace(page, { referenceS = 0.5 } = {}) {
  await page.setInputFiles("#raceVideo", { name: "synthetic.webm", mimeType: "video/webm", buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) });
  await page.selectOption("#raceEventSelect", "Freestyle 50m");
  await page.selectOption("#raceCourseSelect", "Short Course");
  await page.evaluate((t) => { window.__r.vs.currentTime = t; }, referenceS);
  await page.click("#raceCalibrateBtn");
  await page.evaluate(() => {
    const r = document.getElementById("racePlayer").getBoundingClientRect();
    document.getElementById("raceCanvas").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  });
  await expect(page.locator("#raceCalibrationStatus")).toContainText("Start and lane marked");
}

async function start(page) {
  await page.click("#raceAutoStartBtn");
  await page.evaluate(() => window.__r.flush());
}

const r = (page, fn, arg) => page.evaluate(fn, arg);
const lifecycle = async (page) => (await r(page, () => window.__r.dom().diagnostics)).match(/Lifecycle: (\w+)/)?.[1] ?? null;

function expectOnlyStubbedScripts(requested) {
  for (const path of requested) {
    expect(path, "only <script> URLs; the stand-in never requests a model or wasm file").toMatch(
      /^\/npm\/@mediapipe\/(pose|camera_utils|drawing_utils)@[^/]+\/(pose|camera_utils|drawing_utils)\.js$/
    );
  }
}

// The stand-in intercepted every send, and every send was the Race page's.
async function expectAllSendsAreRaceSends(page) {
  const c = await page.evaluate(() => ({ total: window.__poseStandIn.totalSends, race: window.__r.raceSends(), chase: window.__r.chaseSends() }));
  expect(c.chase).toBe(0);
  expect(c.race).toBe(c.total);
}

function expectNoUnexpectedErrors(errors) {
  expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
}

test.describe("Race page inference baseline (scripted Pose stand-in, scripted video)", () => {
  test("start and normal results: one send per due frame, processed at the CALLBACK (before settlement), report updated per result", async ({ page }) => {
    const { errors, requested } = await openRacePage(page);
    await configureRace(page);
    // Chase's own instance exists from page load; Race creates its own only on Start.
    expect(await r(page, () => window.__r.instances())).toBe(1);
    expect(await r(page, () => window.__r.raceInstances())).toBe(0);
    await start(page);
    expect(await r(page, () => window.__r.instances())).toBe(2);
    expect(await r(page, () => window.__r.raceInstances())).toBe(1);
    expect(await lifecycle(page)).toBe("armed");

    // Frame 1 at mediaTime 1.000 s (currentTime deliberately different).
    expect(await r(page, () => window.__r.frame(1.0, 7.0))).toBe(true);
    expect(await r(page, () => window.__r.sendCount())).toBe(1);
    const reportsBefore = await r(page, () => window.__r.calls.buildReport);
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    // Processed inside the callback, before the send has settled.
    expect(await r(page, () => window.__r.outstanding())).toBe(1);
    expect(await r(page, () => window.__r.observed)).toEqual([{ atMs: 1000, hasPose: true }]);
    expect(await r(page, () => window.__r.calls.buildReport)).toBe(reportsBefore + 1);
    await r(page, () => window.__r.resolve(0));

    // Further due frames (>= 120 ms apart) each send once and are attributed their own mediaTime.
    for (const [i, t] of [[1, 1.2], [2, 1.4]]) {
      await r(page, (t) => window.__r.frame(t), t);
      expect(await r(page, () => window.__r.sendCount())).toBe(i + 1);
      await r(page, () => window.__r.callback(window.__r.pose(0.1)));
      await r(page, (i) => window.__r.resolve(i), i);
    }
    // A frame less than 120 ms after the last dispatched one is not sent.
    await r(page, () => window.__r.frame(1.45));
    expect(await r(page, () => window.__r.sendCount())).toBe(3);

    expect((await r(page, () => window.__r.observed)).map((o) => o.atMs)).toEqual([1000, 1200, 1400]);
    const dom = await r(page, () => window.__r.dom());
    expect(dom.report).toContain("Status:");
    expect(await r(page, () => window.__r.maxOutstanding())).toBe(1);
    expectOnlyStubbedScripts(requested);
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });

  test("overlapping dispatch attempts: while a send is outstanding no due frame is sent (busy flag); a rejected send clears it and shows a status", async ({ page }) => {
    const { errors } = await openRacePage(page);
    await configureRace(page);
    await start(page);
    await r(page, () => window.__r.frame(1.0));
    for (let k = 1; k <= 10; k++) await r(page, (t) => window.__r.frame(t), 1.0 + k * 0.2);
    expect(await r(page, () => window.__r.sendCount())).toBe(1);
    expect(await r(page, () => window.__r.vs.cb !== null)).toBe(true); // the ticker keeps re-registering

    await r(page, () => window.__r.reject(0));
    expect((await r(page, () => window.__r.dom())).status).toBe("Part of the video couldn't be analyzed. Choose Stop / Reset Analysis, then start again.");
    expect(await lifecycle(page)).toBe("armed"); // the session continues
    await r(page, () => window.__r.frame(3.4));
    expect(await r(page, () => window.__r.sendCount())).toBe(2);
    expect(await r(page, () => window.__r.observed)).toEqual([]);
    expect(await r(page, () => window.__r.maxOutstanding())).toBe(1);
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });

  test("callbacks are not counted per send: a second callback in one send, and a callback with no send outstanding, are both processed", async ({ page }) => {
    const { errors } = await openRacePage(page);
    await configureRace(page);
    await start(page);
    await r(page, () => window.__r.frame(1.0));
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    await r(page, () => window.__r.callback(window.__r.pose(0.1))); // duplicate in the same send
    await r(page, () => window.__r.resolve(0));
    await r(page, () => window.__r.callback(window.__r.pose(0.1))); // nothing outstanding
    // All three are attributed the last dispatched frame's time (the shared timing slot).
    expect((await r(page, () => window.__r.observed)).map((o) => o.atMs)).toEqual([1000, 1000, 1000]);
    expect(await r(page, () => window.__r.sendCount())).toBe(1);
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });

  test("stop while a send is outstanding: report cleared, session reset, busy flag cleared; the late result is discarded", async ({ page }) => {
    const { errors } = await openRacePage(page);
    await configureRace(page);
    await start(page);
    await r(page, () => window.__r.frame(1.0));
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    await r(page, () => window.__r.resolve(0));
    await r(page, () => window.__r.frame(1.2)); // send 1, left outstanding
    expect(await r(page, () => window.__r.outstanding())).toBe(1);

    await page.click("#raceAutoStopBtn");
    const dom = await r(page, () => window.__r.dom());
    expect(dom.status).toBe("Analysis stopped. Choose Start Automatic Analysis to run it again.");
    expect(dom.report).toBe("");
    expect(dom.pb).toBe("");
    expect(await lifecycle(page)).toBe("idle");
    expect(await r(page, () => window.__r.calls.abortSession)).toBe(1);
    expect(await r(page, () => window.__r.vs.cb)).toBe(null);
    expect(dom.calibration).toContain("Start and lane marked"); // calibration survives Stop

    // The outstanding send's late result is not processed; settling it changes nothing.
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    await r(page, () => window.__r.resolve(1));
    expect((await r(page, () => window.__r.observed)).length).toBe(1);
    expect((await r(page, () => window.__r.dom())).report).toBe("");
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });

  test("restart while the earlier send is outstanding: a new send is made at once (two outstanding), and a callback is attributed the NEW frame's time", async ({ page }) => {
    const { errors } = await openRacePage(page);
    await configureRace(page);
    await start(page);
    await r(page, () => window.__r.frame(1.0)); // send 0, left outstanding
    await page.click("#raceAutoStopBtn");
    await start(page);
    expect(await lifecycle(page)).toBe("armed");
    expect(await r(page, () => window.__r.frame(2.0))).toBe(true);
    // CURRENT BEHAVIOUR: both Stop (stopRaceFrameProcessing) and Start
    // (racePipelineHandleStartClick) clear the busy flag, so the restart sends
    // while send 0 is still outstanding. Either one alone is enough for this.
    expect(await r(page, () => window.__r.sendCount())).toBe(2);
    expect(await r(page, () => window.__r.outstanding())).toBe(2);
    expect(await r(page, () => window.__r.maxOutstanding())).toBe(2);
    expect(await r(page, () => window.__r.raceInstances())).toBe(1); // same Race engine instance

    // Whichever send it belongs to, a callback now is attributed send 1's frame (2.000 s).
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    await r(page, () => window.__r.resolve(0));
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    await r(page, () => window.__r.resolve(1));
    expect((await r(page, () => window.__r.observed)).map((o) => o.atMs)).toEqual([2000, 2000]);
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });

  test("video end: frame processing stops and the report is rendered; a late result after `ended` is STILL processed", async ({ page }) => {
    const { errors } = await openRacePage(page);
    await configureRace(page);
    await start(page);
    await r(page, () => window.__r.frame(1.0));
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    await r(page, () => window.__r.resolve(0));
    await r(page, () => window.__r.frame(1.2)); // send 1, left outstanding

    const reportsBefore = await r(page, () => window.__r.calls.buildReport);
    await r(page, () => window.__r.endVideo());
    await r(page, () => window.__r.flush());
    const dom = await r(page, () => window.__r.dom());
    expect(dom.status).toBe("Analysis incomplete: the video ended before a finish was detected. See the results below.");
    expect(dom.report).toContain("Status:");
    expect(await r(page, () => window.__r.calls.buildReport)).toBeGreaterThan(reportsBefore);
    expect(await r(page, () => window.__r.vs.cb)).toBe(null);
    expect(await r(page, () => window.__r.calls.abortSession)).toBe(0);

    // CURRENT BEHAVIOUR: `ended` does not change the generation or clear the
    // pending timing, so the outstanding send's callback is processed after the end.
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    expect((await r(page, () => window.__r.observed)).map((o) => o.atMs)).toEqual([1000, 1200]);
    await r(page, () => window.__r.resolve(1));
    // No new frame is sent after the end.
    await r(page, () => window.__r.frame(2.0));
    expect(await r(page, () => window.__r.sendCount())).toBe(2);
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });

  test("replacing the video: the analysis is stopped, calibration is cleared, and the outstanding send's late result is discarded", async ({ page }) => {
    const { errors } = await openRacePage(page);
    await configureRace(page);
    await start(page);
    await r(page, () => window.__r.frame(1.0)); // send 0, left outstanding
    const loadsBefore = await r(page, () => window.__r.vs.loads);

    await page.setInputFiles("#raceVideo", { name: "second.webm", mimeType: "video/webm", buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]) });
    await r(page, () => window.__r.flush());
    const dom = await r(page, () => window.__r.dom());
    expect(await r(page, () => window.__r.vs.loads)).toBe(loadsBefore + 1);
    expect(await r(page, () => window.__r.vs.src.startsWith("blob:"))).toBe(true);
    expect(dom.calibration).toBe("Start and lane not marked yet. A new video needs to be marked again.");
    expect(dom.report).toBe("");
    expect(await lifecycle(page)).toBe("idle");
    expect(await r(page, () => window.__r.calls.abortSession)).toBe(1);

    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    await r(page, () => window.__r.resolve(0));
    expect(await r(page, () => window.__r.observed)).toEqual([]);

    // Starting again needs a new calibration.
    await page.click("#raceAutoStartBtn");
    expect((await r(page, () => window.__r.dom())).status).toMatch(/mark the start and lane/i);
    expect(await r(page, () => window.__r.sendCount())).toBe(1);
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });

  test("no requestVideoFrameCallback: the interval fallback sends once and then waits for settlement (busy flag)", async ({ page }) => {
    const { errors } = await openRacePage(page, { rvfc: false });
    await configureRace(page);
    await start(page);
    await page.waitForFunction(() => window.__r.sendCount() === 1, null, { timeout: 5000 });
    await page.waitForTimeout(600); // about five more 120 ms ticks
    expect(await r(page, () => window.__r.sendCount())).toBe(1);
    await r(page, () => window.__r.vs.currentTime = 2.5);
    await r(page, () => window.__r.callback(window.__r.pose(0.1)));
    // Fallback timing is video.currentTime read at DISPATCH (Start rewinds it to 0), not at the callback (2.5 s).
    expect((await r(page, () => window.__r.observed)).map((o) => o.atMs)).toEqual([0]);
    await r(page, () => window.__r.resolve(0));
    await page.waitForFunction(() => window.__r.sendCount() === 2, null, { timeout: 5000 });
    await page.click("#raceAutoStopBtn");
    await expectAllSendsAreRaceSends(page);
    expectNoUnexpectedErrors(errors);
  });
});
