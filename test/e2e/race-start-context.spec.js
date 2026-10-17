// Browser integration for the pre-start reference frame (Chronos reliability
// phase 1C).
//
// WHAT IS REAL: index.html, the calibration button and canvas click handler
// (racePipelineHandleCalibrateClick and its click listener, including the
// paused-video requirement and the media-time capture from a real <video>
// element), the race page's frame driver (raceStartVideoFrameTicker,
// raceDispatchPoseInference, onRacePoseResults), src/race-pipeline/*
// (controller, detector adapter, event adapter), SwimmerTracking, the start
// detector, ChronosEngine, and the Developer Diagnostics panel and report.
//
// WHAT IS SYNTHETIC: (1) the video's pixels — a generated, content-free WebM
// that exists only so the <video> element has a source and can seek;
// (2) MediaPipe — a scripted fake `Pose` whose landmarks are a deterministic
// function of a scripted media time; (3) the FRAME CALLBACKS — the page's
// requestVideoFrameCallback registration for #racePlayer is captured and fired
// by the test at exact 30 fps media times, so the sampling cadence does not
// depend on how loaded the machine is (an earlier version that let the browser
// play the video at its own pace was flaky under parallel workers, because the
// sampling cadence thinned out). That makes this test deterministic; it also
// means it does NOT exercise the browser's native rVFC cadence
// (test/e2e/frame-timing-lifecycle.spec.js covers the rVFC wiring with
// stand-ins, and real-cadence behaviour has not been validated). NOTHING HERE
// measures how well real MediaPipe output on real swimming footage is handled;
// no such footage or independently annotated start times exist in this
// repository. Passing proves the wiring (pause -> media time -> controller ->
// detector -> diagnostics/report) and the wording, not accuracy.
//
// Scripted trajectory (hip x, normalized, nose 0.04 ahead), in scripted media seconds:
//   0.0-2.4 s  rest at 0.10
//   2.4-3.4 s  WALK to 0.25          <- must NOT be the estimate when the marked frame is after it
//   3.4-6.0 s  rest at 0.25
//   6.0 s+     departs at 0.06 frame-widths/s
// The page samples every 4th frame (~133 ms). The estimated motion onset for the
// departure is the first sample more than 0.02 beyond rest: 6.40 s.

// END OF STREAM (Chronos reliability phase 2C follow-up). The second describe
// block at the bottom drives the page's REAL video "ended" handler (the video is
// seeked near its end and played until the browser fires "ended") and checks
// what the page's real controller did with it. The page's controller is a
// module-scoped variable, so the tests observe it through the shared
// ChronosEngine singleton the page and controller both import: a pass-through
// spy on markDistanceUnconfirmed() and on buildReport() (the report the page
// itself last built). Nothing in index.html is exposed or changed for testing.
// Same synthetic-only caveat as above.

import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KNOWN_BASELINE_ERROR = "updateProfileAccountSection is not defined";
const VIDEO_SECONDS = 10;

let videoBase64 = null;

async function dismissEntryGate(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

// Installs the scripted pose and the frame-callback capture BEFORE the page's scripts run.
async function installScriptedPageHooks(page) {
  // The page loads MediaPipe from a CDN; replace that script so the fake is the only `Pose`.
  await page.route("**/@mediapipe/pose@*/pose.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "/* replaced by the e2e test */" })
  );
  await page.addInitScript(() => {
    const walkThenDepart = (t) => {
      if (t < 2.4) return 0.1;
      if (t < 3.4) return 0.1 + 0.15 * (t - 2.4);
      if (t < 6.0) return 0.25;
      return 0.25 + 0.06 * (t - 6.0);
    };
    // "turn": rest at the near wall until 6 s, swim to the far wall at 0.1
    // frame-widths/s (arrive 14.4 s), touch for 0.4 s, swim back. One turn (25 m
    // of a 50 m race in a 25 m pool).
    const turnRace = (t) => {
      if (t < 6.0) return 0.06;
      if (t < 14.4) return 0.06 + 0.1 * (t - 6.0);
      if (t < 14.8) return 0.9;
      return Math.max(0.4, 0.9 - 0.1 * (t - 14.8));
    };
    window.__trajectory = "walk-then-depart";
    const hipAt = (t) => (window.__trajectory === "turn" ? turnRace(t) : walkThenDepart(t));
    window.__poseHiddenFromS = null; // when set, the pose is "lost" from this scripted second on
    window.__scriptedTime = 0;
    window.__poseCalls = 0;
    window.__rvfc = null;

    // send() answers for the SCRIPTED media time; it never looks at pixels.
    window.Pose = class {
      setOptions() {}
      onResults(cb) { this.cb = cb; }
      async send() {
        const hip = hipAt(window.__scriptedTime);
        window.__poseCalls += 1;
        if (window.__poseHiddenFromS !== null && window.__scriptedTime >= window.__poseHiddenFromS) {
          this.cb({ poseLandmarks: [] }); // no pose found this frame
          return;
        }
        const landmarks = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
        landmarks[0] = { x: hip + 0.04, y: 0.5, z: 0, visibility: 0.9 }; // nose
        landmarks[23] = { x: hip, y: 0.5, z: 0, visibility: 0.9 };       // left hip
        landmarks[24] = { x: hip, y: 0.5, z: 0, visibility: 0.9 };       // right hip
        this.cb({ poseLandmarks: landmarks });
      }
    };

    // Capture the race page's frame callback instead of letting the browser schedule it.
    const nativeRequest = HTMLVideoElement.prototype.requestVideoFrameCallback;
    const nativeCancel = HTMLVideoElement.prototype.cancelVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
      if (this.id === "racePlayer") {
        window.__rvfc = cb;
        return 1;
      }
      return nativeRequest ? nativeRequest.call(this, cb) : 0;
    };
    HTMLVideoElement.prototype.cancelVideoFrameCallback = function (handle) {
      if (this.id === "racePlayer") {
        window.__rvfc = null;
        return undefined;
      }
      return nativeCancel ? nativeCancel.call(this, handle) : undefined;
    };
  });
}

// Generates a real, playable WebM (VP8) in the page. Content is irrelevant.
async function generateVideo(page, seconds) {
  return page.evaluate(async (secs) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext("2d");
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    let n = 0;
    const timer = setInterval(() => {
      g.fillStyle = `hsl(${(n * 7) % 360},60%,40%)`;
      g.fillRect(0, 0, 320, 180);
      g.fillStyle = "#fff";
      g.fillText("f" + n++, 10, 20);
    }, 33);
    recorder.start();
    await new Promise((r) => setTimeout(r, secs * 1000));
    clearInterval(timer);
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, seconds);
}

// MediaRecorder output has no duration, so it cannot seek until the browser has
// computed one: seeking to a huge time forces that, then return to 0.
async function makeSeekable(page) {
  await page.evaluate(async () => {
    const v = document.getElementById("racePlayer");
    if (Number.isFinite(v.duration)) return;
    await new Promise((resolve) => {
      v.addEventListener("durationchange", () => resolve(), { once: true });
      v.currentTime = 1e101;
    });
    await new Promise((resolve) => {
      v.addEventListener("seeked", () => resolve(), { once: true });
      v.currentTime = 0;
    });
  });
}

async function openRacePageWithVideo(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await installScriptedPageHooks(page);
  await page.goto("/index.html", { waitUntil: "load" });
  await dismissEntryGate(page);
  await page.evaluate(() => showPage("race"));

  if (videoBase64 === null) {
    videoBase64 = await generateVideo(page, VIDEO_SECONDS);
  }
  await page.setInputFiles("#raceVideo", { name: "synthetic-race.webm", mimeType: "video/webm", buffer: Buffer.from(videoBase64, "base64") });
  await page.waitForFunction(() => {
    const v = document.getElementById("racePlayer");
    return v && v.videoWidth > 0 && v.readyState >= 2;
  }, null, { timeout: 30000 });
  await makeSeekable(page);

  await page.selectOption("#raceEventSelect", "Freestyle 50m");
  await page.selectOption("#raceCourseSelect", "Short Course");
  return errors;
}

// Clicks the middle of the video overlay with Playwright's own actionability
// handling (scroll into view, hit-target check) so the click works at any viewport size.
async function clickSwimmer(page) {
  const canvas = page.locator("#raceCanvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
}

// The user's calibration gesture: press the button (which pauses the video),
// scrub to a frame, then click the swimmer.
async function markPreStartFrame(page, seekSeconds) {
  await page.click("#raceCalibrateBtn");
  await page.evaluate(async (t) => {
    const v = document.getElementById("racePlayer");
    await new Promise((resolve) => {
      v.addEventListener("seeked", () => resolve(), { once: true });
      v.currentTime = t;
    });
  }, seekSeconds);
  await clickSwimmer(page);
}

// Starts the analysis, then fires the page's own frame callback at exact 30 fps
// media times until the report shows an estimated onset (or the script ends).
async function runAnalysisUntilOnset(page) {
  await page.click("#raceAutoStartBtn");
  await page.waitForFunction(() => window.__rvfc !== null, null, { timeout: 30000 }); // the page registered its ticker
  await page.evaluate(async () => {
    document.getElementById("racePlayer").pause(); // the scripted time, not playback, drives the analysis
    const report = () => document.getElementById("racePipelineReport").innerText;
    for (let k = 0; k <= 480; k += 1) {
      const t = k / 30;
      window.__scriptedTime = t;
      const cb = window.__rvfc;
      window.__rvfc = null;
      if (cb) cb(performance.now(), { mediaTime: t });
      await new Promise((r) => setTimeout(r, 3));
      if (/Estimated motion onset:\s*\d+\.\d\ds/.test(report())) break;
    }
  });
}

// ---- end-of-stream helpers ------------------------------------------------

// Pass-through spies on the shared ChronosEngine singleton (same object the page's controller calls).
async function installEngineSpies(page) {
  await page.evaluate(() => {
    const engine = window.ChronosEngine;
    window.__marks = [];
    window.__lastReport = null;
    const mark = engine.markDistanceUnconfirmed;
    engine.markDistanceUnconfirmed = function (session, params) {
      const result = mark.call(this, session, params);
      window.__marks.push({ reason: params.reason, sinceAtMs: params.sinceAtMs, trigger: params.evidence && params.evidence.trigger, ok: result.ok });
      return result;
    };
    const build = engine.buildReport;
    engine.buildReport = function (...args) {
      const result = build.apply(this, args);
      window.__lastReport = result.report;
      return result;
    };
    window.__endedCount = 0;
    document.getElementById("racePlayer").addEventListener("ended", () => { window.__endedCount += 1; });
  });
}

// Mark a pre-start frame, install the spies, start the analysis and take over the frame clock.
async function startScriptedAnalysis(page, trajectory) {
  await page.evaluate((name) => { window.__trajectory = name; }, trajectory);
  await markPreStartFrame(page, 4.0);
  await installEngineSpies(page);
  await page.click("#raceAutoStartBtn");
  await page.waitForFunction(() => window.__rvfc !== null, null, { timeout: 30000 });
  await page.evaluate(() => {
    document.getElementById("racePlayer").pause();
    window.__tickK = 0;
  });
}

// Fire the page's own frame callback at exact 30 fps scripted times up to `seconds`.
async function tickTo(page, seconds) {
  await page.evaluate(async (target) => {
    while (window.__tickK <= target * 30) {
      const t = window.__tickK / 30;
      window.__scriptedTime = t;
      const cb = window.__rvfc;
      window.__rvfc = null;
      if (cb) cb(performance.now(), { mediaTime: t });
      window.__tickK += 1;
      await new Promise((r) => setTimeout(r, 3));
    }
  }, seconds);
}

async function hidePoseFrom(page, seconds) {
  await page.evaluate((s) => { window.__poseHiddenFromS = s; }, seconds);
}

// Let the browser reach the REAL end of the video: seek near the end and play until "ended" fires.
async function playToRealEnd(page) {
  await page.evaluate(async () => {
    const v = document.getElementById("racePlayer");
    await new Promise((resolve) => {
      v.addEventListener("ended", () => resolve(), { once: true });
      v.currentTime = Math.max(0, v.duration - 0.3);
      v.play();
    });
  });
}

const trackingLine = async (page) => (await page.locator("#racePipelineDiagnostics").innerText()).match(/Tracking: (\w+)/)?.[1] ?? null;
const lastReport = (page) => page.evaluate(() => window.__lastReport);
const marksOf = (page) => page.evaluate(() => window.__marks);

function onsetSeconds(reportText) {
  const m = reportText.match(/Estimated motion onset:\s*(\d+\.\d\d)s/);
  return m ? Number(m[1]) : null;
}

test.describe("race page: pre-start reference frame (synthetic video, scripted pose and frame callbacks)", () => {
  test.setTimeout(180000);

  test("the paused frame's media time is captured, reaches the controller, and constrains the start: the walk before it is ignored", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);

    await markPreStartFrame(page, 4.0);
    const calibration = await page.locator("#raceCalibrationStatus").innerText();
    expect(calibration).toMatch(/Pre-start reference frame: 4\.0\d s \(video time\)/);

    const timerBefore = await page.locator("#timer").innerText();

    // Record every state the diagnostics panel passes through, so the refused
    // walk (which is overwritten once the real departure is confirmed) can be asserted.
    await page.evaluate(() => {
      const panel = document.getElementById("racePipelineDiagnostics");
      window.__diagnosticsHistory = [];
      new MutationObserver(() => window.__diagnosticsHistory.push(panel.innerText)).observe(panel, { childList: true, subtree: true });
    });
    await runAnalysisUntilOnset(page);

    const report = await page.locator("#racePipelineReport").innerText();
    const diagnostics = await page.locator("#racePipelineDiagnostics").innerText();
    const onset = onsetSeconds(report);

    // The estimate is the departure at ~6.0 s, NOT the 2.4-3.4 s walk, and not before the reference.
    expect(onset).toBeGreaterThanOrEqual(6.3);
    expect(onset).toBeLessThanOrEqual(6.7);
    expect(onset).toBeGreaterThanOrEqual(4.0);

    // The controller received the reference exactly as the UI showed it.
    expect(report).toMatch(/Pre-start reference frame: 4\.0\ds/);
    expect(diagnostics).toMatch(/Reference frame \(marked pre-start\): 4\.0\d s/);

    // Four distinct values are shown, never conflated.
    expect(diagnostics).toMatch(/Start assessment: confirmed \(sustained-departure\), evaluated at \d+\.\d\d s/);
    const estimated = diagnostics.match(/Estimated motion onset: (\d+\.\d\d) s \(confirmed at (\d+\.\d\d) s\)/);
    expect(estimated).not.toBeNull();
    expect(Number(estimated[2])).toBeGreaterThan(Number(estimated[1]));          // confirmation is later than the onset
    expect(Math.abs(Number(estimated[1]) - onset)).toBeLessThan(0.011);          // diagnostics onset == report onset
    expect(diagnostics).toMatch(/Chronos start event \(estimated motion onset, not an official start\): accepted @ \d+\.\d\d s/);

    // The walk (2.4-3.4 s, before the 4.0 s reference) was seen and REFUSED, visibly,
    // with its would-be onset — and nothing in the history ever offered it as the estimate.
    const history = await page.evaluate(() => window.__diagnosticsHistory);
    const refused = history.filter((h) => /onset-before-reference-frame/.test(h));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.some((h) => /Refused motion onset: [23]\.\d\d s \(it begins before the reference frame\)/.test(h))).toBe(true);
    expect(history.every((h) => !/Estimated motion onset: [0-5]\.\d\d s/.test(h))).toBe(true);

    // The UI never claims an official start.
    const raceText = await page.locator("#race").innerText();
    expect(raceText).not.toMatch(/Start detected/i);
    expect(raceText).not.toMatch(/race start/i);
    expect(raceText).not.toMatch(/(?<!not an )official/i);
    expect(report).not.toMatch(/<b>Start:/);

    // The legacy manual timer is not driven by Chronos.
    expect(await page.locator("#timer").innerText()).toBe(timerBefore);
    expect(await page.locator("#timer").innerText()).toBe("0.00 s");

    await page.click("#raceAutoStopBtn");
    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("CONTROL: a frame marked at the very start of the clip does not exclude the walk, so the walk is taken as the estimated onset", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);

    await markPreStartFrame(page, 0);
    expect(await page.locator("#raceCalibrationStatus").innerText()).toMatch(/Pre-start reference frame: 0\.00 s/);
    await runAnalysisUntilOnset(page);

    const onset = onsetSeconds(await page.locator("#racePipelineReport").innerText());
    expect(onset).toBeGreaterThanOrEqual(2.3);
    expect(onset).toBeLessThanOrEqual(3.6); // the walk (2.4-3.4 s), not the departure at 6 s

    await page.click("#raceAutoStopBtn");
    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("a click while the video is PLAYING records no reference; the analysis cannot start until a paused frame is marked", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);

    await page.click("#raceCalibrateBtn");                       // arms and pauses
    await page.evaluate(() => document.getElementById("racePlayer").play());
    await clickSwimmer(page);

    expect(await page.locator("#raceCalibrationStatus").innerText()).toMatch(/pause the video on the pre-start frame first/i);

    await page.click("#raceAutoStartBtn");
    expect(await page.locator("#racePipelineStatus").innerText()).toMatch(/lane calibration/);
    expect(await page.locator("#racePipelineReport").innerText()).toBe("");
    expect(await page.evaluate(() => window.__poseCalls)).toBe(0);

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("loading a different video clears the marked frame, and the analysis is blocked until it is marked again", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);

    await markPreStartFrame(page, 4.0);
    expect(await page.locator("#raceCalibrationStatus").innerText()).toMatch(/Pre-start reference frame: 4\.0\d s/);

    await page.setInputFiles("#raceVideo", { name: "another.webm", mimeType: "video/webm", buffer: Buffer.from(videoBase64, "base64") });
    await page.waitForFunction(() => /not set/i.test(document.getElementById("raceCalibrationStatus").innerText));

    await page.click("#raceAutoStartBtn");
    expect(await page.locator("#racePipelineStatus").innerText()).toMatch(/lane calibration/);
    expect(await page.evaluate(() => window.__poseCalls)).toBe(0);

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });
});

// ===========================================================================
// END OF STREAM
// ===========================================================================

const ENDED_REASON = "analysis-ended-before-distance-confirmed";
const ENDED_STATUS_TEXT = "Analysis incomplete — video ended without a finish event.";

test.describe("race page: the video's end is passed to the controller (synthetic video, scripted pose and frame callbacks)", () => {
  test.setTimeout(240000);

  test("a clip that ends while the target is still LOST, with a required turn outstanding, is marked distance-unconfirmed — and not before it ends", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);
    await startScriptedAnalysis(page, "turn");

    await hidePoseFrom(page, 9.0); // after the start is accepted (~7.5 s), before the turn
    await tickTo(page, 12.0);

    // Lost, but only lost: a recoverable state is NOT terminal and must not be marked.
    expect(await trackingLine(page)).toBe("TARGET_LOST");
    expect(await marksOf(page)).toEqual([]);
    const before = await lastReport(page);
    expect(before.start).not.toBeNull();
    expect(before.distanceConfidence.state).toBe("confirmed");
    expect(await page.evaluate(() => window.__endedCount)).toBe(0);

    await playToRealEnd(page);

    // The page's own handler ran (existing behavior intact)...
    expect(await page.evaluate(() => window.__endedCount)).toBe(1);
    await expect(page.locator("#racePipelineStatus")).toHaveText(ENDED_STATUS_TEXT);
    // ...and passed the end to the controller exactly once.
    const marks = await marksOf(page);
    expect(marks).toHaveLength(1);
    expect(marks[0].reason).toBe(ENDED_REASON);
    expect(marks[0].trigger).toBe("stream-ended-while-target-lost");
    expect(marks[0].ok).toBe(true);
    expect(marks[0].sinceAtMs).toBeGreaterThan(8500);
    expect(marks[0].sinceAtMs).toBeLessThanOrEqual(9100); // the last confirmed observation, just before the pose was lost

    // The report the page built AFTER the end reflects it, and nothing was fabricated.
    const after = await lastReport(page);
    expect(after.distanceConfidence).toMatchObject({ state: "unconfirmed", reason: ENDED_REASON, sinceAtMs: marks[0].sinceAtMs, resumedAtMs: null });
    expect(after.dataQuality.notes.some((n) => n.includes("distance progression unconfirmed") && n.includes(ENDED_REASON))).toBe(true);
    expect(after.finish).toBeNull();
    expect(after.finalTimeMs).toBeNull();
    expect(after.splits).toEqual([]);
    expect(after.confirmedDistanceMeters).toBe(0);
    expect(after.start).toEqual(before.start);
    expect(await page.locator("#racePipelineReport").innerText()).toMatch(/Final Time:\s*Not available/);
    expect(await page.locator("#racePipelinePbComparison").innerText()).toMatch(/PB comparison unavailable until the race is finished/);
    expect(await page.locator("#timer").innerText()).toBe("0.00 s");

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("repeated 'ended' handling is idempotent: the first ambiguity record is kept and nothing else appears", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);
    await startScriptedAnalysis(page, "turn");
    await hidePoseFrom(page, 9.0);
    await tickTo(page, 12.0);
    await playToRealEnd(page);
    const first = await lastReport(page);
    expect(first.distanceConfidence.state).toBe("unconfirmed");

    for (let i = 0; i < 3; i += 1) {
      await page.evaluate(() => document.getElementById("racePlayer").dispatchEvent(new Event("ended")));
    }

    expect(await page.evaluate(() => window.__endedCount)).toBe(4);
    expect(await marksOf(page)).toHaveLength(1); // the controller never re-marked
    const again = await lastReport(page);
    expect(again.distanceConfidence).toEqual(first.distanceConfidence);
    expect(again.splits).toEqual(first.splits);
    expect(again.finish).toBeNull();
    expect(again.dataQuality.notes.filter((n) => n.startsWith("distance progression unconfirmed"))).toHaveLength(1);
    await expect(page.locator("#racePipelineStatus")).toHaveText(ENDED_STATUS_TEXT);

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("a clip that ends after ALL required turns are recorded is NOT downgraded, even though the target is lost at the end", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);
    await startScriptedAnalysis(page, "turn");

    await tickTo(page, 16.5); // start ~7.5 s, far wall 14.4 s, recovery confirmed ~16 s
    const recorded = await lastReport(page);
    expect(recorded.splits.map((s) => [s.kind, s.distanceMeters])).toEqual([["turn", 25]]);
    expect(recorded.distanceConfidence.state).toBe("confirmed");

    await hidePoseFrom(page, 17.0);
    await tickTo(page, 19.5);
    expect(await trackingLine(page)).toBe("TARGET_LOST");

    await playToRealEnd(page);

    await expect(page.locator("#racePipelineStatus")).toHaveText(ENDED_STATUS_TEXT);
    expect(await marksOf(page)).toEqual([]);
    const after = await lastReport(page);
    expect(after.distanceConfidence.state).toBe("confirmed");
    expect(after.splits).toEqual(recorded.splits);
    expect(after.confirmedDistanceMeters).toBe(25);
    expect(after.finish).toBeNull();
    expect(after.finalTimeMs).toBeNull();

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("a clip that ends BEFORE an accepted start does not mark race distance unconfirmed", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);
    await startScriptedAnalysis(page, "walk-then-depart");

    await hidePoseFrom(page, 3.0); // lost long before the departure at 6.0 s
    await tickTo(page, 6.0);
    expect(await trackingLine(page)).toBe("TARGET_LOST");

    await playToRealEnd(page);

    await expect(page.locator("#racePipelineStatus")).toHaveText(ENDED_STATUS_TEXT);
    expect(await marksOf(page)).toEqual([]);
    const after = await lastReport(page);
    expect(after.status).toBe("armed");
    expect(after.start).toBeNull();
    expect(after.distanceConfidence.state).toBe("confirmed");
    expect(after.splits).toEqual([]);

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("a RECOVERABLE loss, with a pause and a seek during it and no end of stream, never triggers end-of-stream handling", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);
    await startScriptedAnalysis(page, "turn");

    await hidePoseFrom(page, 9.0);
    await tickTo(page, 10.8);
    expect(await trackingLine(page)).toBe("TARGET_LOST");

    // An ordinary pause and seek while lost: neither is the end of the stream.
    await page.evaluate(() => {
      const v = document.getElementById("racePlayer");
      v.pause();
      v.currentTime = 1;
    });
    await page.waitForFunction(() => !document.getElementById("racePlayer").seeking);
    expect(await page.evaluate(() => window.__endedCount)).toBe(0);
    expect(await marksOf(page)).toEqual([]);

    await page.evaluate(() => { window.__poseHiddenFromS = null; }); // the swimmer is visible again
    await tickTo(page, 13.0);

    expect(await trackingLine(page)).toBe("TARGET_LOCKED"); // reacquired: recoverable stayed recoverable
    expect(await marksOf(page)).toEqual([]);
    const report = await lastReport(page);
    expect(report.distanceConfidence.state).toBe("confirmed");
    expect(report.start).not.toBeNull();
    await expect(page.locator("#racePipelineStatus")).not.toHaveText(ENDED_STATUS_TEXT);

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });

  test("the video ending with NO analysis running is a safe no-op for the controller and keeps the existing message", async ({ page }) => {
    const errors = await openRacePageWithVideo(page);
    await installEngineSpies(page);

    await playToRealEnd(page);

    expect(await page.evaluate(() => window.__endedCount)).toBe(1);
    await expect(page.locator("#racePipelineStatus")).toHaveText(ENDED_STATUS_TEXT);
    expect(await marksOf(page)).toEqual([]);
    expect(await page.evaluate(() => window.__poseCalls)).toBe(0);

    expect(errors.filter((e) => !e.includes(KNOWN_BASELINE_ERROR))).toEqual([]);
  });
});
