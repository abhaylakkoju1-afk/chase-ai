// OPT-IN validation of the integrated Chase path on the REAL pinned
// MediaPipe Pose runtime (@mediapipe/pose@0.5.1675469404). Skipped unless
// CHASE_POSE_MIRROR_DIR names a local copy of the pinned files (checked by
// sha256, as in test/e2e/pose-adapter-real-engine.spec.js).
//
// What it drives: the real index.html from the local static server, the
// real Analyze button, the real upload input and <video> element, and the
// real Pose engine created by initialiseChasePose() through the adapter.
//
// Input: a SYNTHETIC video generated in the browser (flat background and
// moving geometric shapes; no person, no footage). So MediaPipe is expected
// to find no pose, and the end-of-analysis output is the analyzer's
// "no reliable body-tracking data" report, not coaching feedback.
//
// Network: no request leaves the machine. The page's own files come from
// the local static server; the pinned Pose runtime is answered from
// CHASE_POSE_MIRROR_DIR; camera_utils / drawing_utils (loaded by the page
// but not used by Chase) get an empty script; every other external request
// (fonts, gsap, Chart.js, Firebase, analytics, ...) is aborted and
// recorded. Page errors are compared with a baseline load that has the same
// blocking but no analysis.
//
// What it is not: a performance benchmark or real-footage validation. It
// is one headless-Chromium run on one machine with a local (not CDN) copy
// of the runtime, so download time is excluded from every measurement.
//
// Measurements are written to CHASE_REAL_ENGINE_OUT (a directory) when set:
// timelines as JSON and the painted frames captured around the warm-up.

import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIRROR = process.env.CHASE_POSE_MIRROR_DIR || "";
const OUT = process.env.CHASE_REAL_ENGINE_OUT || "";
const LOCAL_ORIGIN = "http://127.0.0.1:4173";
const PINNED = {
  "pose.js": "fcb703afcce65d0a1c540f6a70c3bb45fc84521498c21a9d4160265dde648ab4",
  "pose_landmark_full.tflite": "e9a5c5cb17f736fafd4c2ec1da3b3d331d6edbe8a0d32395855aeb2cdfd64b9f",
  "pose_solution_packed_assets.data": "a63c614bef30d35947f13be361820b1e4e3bec9cfeebf4d11216a18373108e85",
  "pose_solution_packed_assets_loader.js": "d7aa29b7d8e11b5c97a58d719e982dd15c2de72995d95112d60492b854840a36",
  "pose_solution_simd_wasm_bin.js": "3983d1dca31d945d81abb70b18dd61f28ef4736e112463d7cfb1cbadef588127",
  "pose_solution_simd_wasm_bin.wasm": "195a929430e2ce130b3efb82e64ba27c8e68cb0f6bad870b715688060ea6f7e2",
  "pose_web.binarypb": "dc8efd1c2d62007b34278467407fda5f70847f41310e0e39f0f59fc17b1d01f7",
};
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm" };
const typeOf = (name) => TYPES[name.slice(name.lastIndexOf("."))] || "application/octet-stream";

const PREPARING = "Preparing the analysis engine";
const RELOAD_IDLE = "Results couldn't be matched reliably to video frames. Reload the page before trying again.";

function save(name, data) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
}

// Routes every request in the context. `failAsset` (a mirror file name)
// answers that one runtime file with 404, to inject a warm-up fault.
async function routeOffline(context, { failAsset = null } = {}) {
  const net = { mirror: [], stubbed: [], blocked: [], failed: [] };
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === LOCAL_ORIGIN) return route.continue();
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    if (url.hostname === "cdn.jsdelivr.net") {
      const pinnedScript = url.pathname === "/npm/@mediapipe/pose@0.5.1675469404/pose.js";
      const located = url.pathname.match(/^\/npm\/@mediapipe\/pose\/([^/]+)$/);
      const name = pinnedScript ? "pose.js" : located ? located[1] : null;
      if (name && Object.prototype.hasOwnProperty.call(PINNED, name)) {
        if (name === failAsset) { net.failed.push(name); return route.fulfill({ status: 404, body: "" }); }
        net.mirror.push(name);
        return route.fulfill({ contentType: typeOf(name), body: readFileSync(join(MIRROR, name)) });
      }
      if (/^\/npm\/@mediapipe\/(camera_utils|drawing_utils)@[^/]+\/(camera_utils|drawing_utils)\.js$/.test(url.pathname)) {
        net.stubbed.push(url.pathname);
        return route.fulfill({ contentType: "text/javascript", body: "/* not used by Chase; stubbed offline */" });
      }
    }
    net.blocked.push(url.origin + url.pathname);
    return route.abort();
  });
  return net;
}

// A synthetic test video: grey background, moving coloured shapes. No person.
async function syntheticVideo(context, seconds = 3) {
  const gen = await context.newPage();
  await gen.setContent("<!doctype html><canvas id=c width=640 height=360></canvas>");
  const b64 = await gen.evaluate(async (ms) => {
    const c = document.getElementById("c");
    const ctx = c.getContext("2d");
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        ctx.fillStyle = "#7a8a99"; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#2d5f8a"; ctx.fillRect(0, 240, 640, 120);
        ctx.fillStyle = "#e0c060"; ctx.beginPath(); ctx.arc(100 + 140 * t, 180, 30, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#c04040"; ctx.fillRect(420 - 60 * t, 120 + 20 * Math.sin(t * 6), 90, 40);
        if (performance.now() - t0 < ms) requestAnimationFrame(draw); else resolve();
      };
      draw();
    });
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: "video/webm" });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  }, seconds * 1000);
  await gen.close();
  return Buffer.from(b64, "base64");
}

async function openAnalyzer(page, video) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message)));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#enterButton").evaluate((b) => b.click());
  await expect(page.locator("#entryGate")).toBeHidden();
  const decline = page.locator('#consentBanner [data-consent-choice="decline"]');
  if (await decline.isVisible().catch(() => false)) await decline.click();
  await page.locator("#siteNavToolsButton").click();
  await page.locator("#siteNavToolsMenu button").filter({ hasText: "Chase" }).click();
  await expect(page.locator("#analyzer")).toBeVisible();
  await page.locator("#videoUpload").setInputFiles({ name: "synthetic-shapes.webm", mimeType: "video/webm", buffer: video });
  await page.locator("#stroke").selectOption("freestyle");
  await page.waitForFunction(() => document.getElementById("analyzerPlayer").readyState >= 2, null, { timeout: 15_000 });
  return errors;
}

// Page-side instrumentation (serialized). Records sends, status changes,
// long tasks and animation frames on performance.now(); counts any new
// Pose construction (Race creates its own engine only on its Start).
function instrument() {
  const rec = { sends: [], status: [], longtasks: [], frames: [], clicks: [], poseConstructions: 0, warmupInput: null };
  window.__rec = rec;
  const engine = pose;
  const originalSend = engine.send.bind(engine);
  engine.send = (input) => {
    const image = input && input.image;
    const entry = { call: performance.now(), returned: null, settled: null, outcome: null,
      analysisCanvas: image === chaseAnalysisCanvas, w: image && image.width, h: image && image.height,
      engineAtCall: chaseInferenceIntegrityDiagnostics().engine };
    rec.sends.push(entry);
    let p;
    try { p = originalSend(input); } finally { entry.returned = performance.now(); }
    Promise.resolve(p).then(() => { entry.settled = performance.now(); entry.outcome = "resolved"; },
      () => { entry.settled = performance.now(); entry.outcome = "rejected"; });
    return p;
  };
  const OriginalPose = window.Pose;
  window.Pose = function (...a) { rec.poseConstructions++; return new OriginalPose(...a); };
  const status = document.getElementById("chaseStatus");
  new MutationObserver(() => rec.status.push({ t: performance.now(), text: status.textContent })).observe(status, { childList: true, characterData: true, subtree: true });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.longtasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: "longtask" }); } catch (e) { rec.longtaskError = String(e); }
  const tick = (ts) => { rec.frames.push(ts); if (rec.frames.length < 20000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  document.querySelector('button[onclick="upload()"]').addEventListener("click", () => rec.clicks.push(performance.now()), true);
  status.scrollIntoView({ block: "center" });
  return { timeOrigin: performance.timeOrigin };
}

const readState = (page) => page.evaluate(() => JSON.parse(JSON.stringify({
  integrity: chaseInferenceIntegrityDiagnostics(),
  analyzing,
  status: document.getElementById("chaseStatus").textContent,
  feedback: document.getElementById("feedback").innerText,
  metricsHtml: document.getElementById("metrics").innerHTML,
  metricsLen: metricsHistory.timestamps.length,
  poseFrames: chasePoseFrameHistory.length,
  poseFramesWithPose: chasePoseFrameHistory.filter((f) => f.hasPose).length,
  tracked: window.chaseAI.lastTrackedSequence ? { id: window.chaseAI.lastTrackedSequence.sequenceId, frames: window.chaseAI.lastTrackedSequence.frames.length, generation: window.chaseAI.lastTrackedSequence.generation } : null,
  rec: window.__rec,
})));

async function runToEnd(page) {
  await expect.poll(async () => (await readState(page)).analyzing, { timeout: 120_000 }).toBe(true);
  await page.waitForFunction(() => document.getElementById("analyzerPlayer").ended, null, { timeout: 60_000 });
  await expect.poll(async () => (await readState(page)).analyzing, { timeout: 10_000 }).toBe(false);
}

test.describe("Chase on the real pinned Pose runtime (opt-in, offline, synthetic input)", () => {
  test.skip(!MIRROR, "opt-in: set CHASE_POSE_MIRROR_DIR to a local copy of @mediapipe/pose@0.5.1675469404");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    for (const [name, sha] of Object.entries(PINNED)) {
      const path = join(MIRROR, name);
      expect(existsSync(path), `${name} missing`).toBe(true);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), name).toBe(sha);
    }
  });

  let baselineErrors = null;

  test("baseline: page errors from the offline blocking alone (no analysis)", async ({ browser }) => {
    const context = await browser.newContext();
    const net = await routeOffline(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e && e.message)));
    await page.goto("/", { waitUntil: "load" });
    await page.waitForTimeout(1500);
    baselineErrors = [...new Set(errors)];
    save("baseline.json", { errors: baselineErrors, net });
    console.log("baseline page errors:", JSON.stringify(baselineErrors), "blocked:", net.blocked.length);
    await context.close();
  });

  test("warm-up paint and timing, frames after warm-up, report, latch reload message", async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const net = await routeOffline(context);
    const video = await syntheticVideo(context);
    const page = await context.newPage();
    const errors = await openAnalyzer(page, video);
    const { timeOrigin } = await page.evaluate(instrument);

    // Painted frames, as the compositor produced them.
    const cdp = await context.newCDPSession(page);
    const painted = [];
    cdp.on("Page.screencastFrame", (f) => {
      painted.push({ t: f.metadata.timestamp * 1000 - timeOrigin, data: f.data });
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1280, maxHeight: 800 });
    await page.waitForTimeout(500);

    await page.locator('button[onclick="upload()"]').click();
    await expect.poll(async () => (await readState(page)).integrity.engine, { timeout: 120_000 }).not.toMatch(/^(CREATED|WARMING)$/);
    await page.waitForTimeout(300);
    await cdp.send("Page.stopScreencast");

    const s1 = await readState(page);
    const r = s1.rec;
    const click = r.clicks[0];
    const preparing = r.status.find((x) => x.text.includes(PREPARING));
    const analysing = r.status.find((x) => x.text.includes("Analysing"));
    const warm = r.sends[0];
    const blockTask = r.longtasks.filter((l) => l.start >= click - 1).sort((a, b) => b.duration - a.duration)[0] || null;
    const framesBetween = r.frames.filter((f) => preparing && f > preparing.t && f < warm.call);
    const paintedAfterStatus = painted.filter((p) => preparing && p.t > preparing.t).sort((a, b) => a.t - b.t);
    const firstPaint = paintedAfterStatus[0] || null;
    const timeline = {
      clickMs: click,
      statusSetMs: preparing && preparing.t - click,
      firstAnimationFrameAfterStatusMs: framesBetween.length ? framesBetween[0] - click : null,
      firstPaintedFrameAfterStatusMs: firstPaint && firstPaint.t - click,
      warmupSendCallMs: warm.call - click,
      warmupSendSyncReturnMs: warm.returned - click,
      warmupSendSyncBlockMs: warm.returned - warm.call,
      warmupSettledMs: warm.settled - click,
      warmupOutcome: warm.outcome,
      analysingStatusMs: analysing && analysing.t - click,
      longestTaskAfterClick: blockTask && { startMs: blockTask.start - click, durationMs: blockTask.duration },
      longTasksAfterClick: r.longtasks.filter((l) => l.start >= click - 1).map((l) => ({ startMs: Math.round(l.start - click), durationMs: Math.round(l.duration) })),
      paintedFrameTimesMs: painted.map((p) => Math.round(p.t - click)),
      maxAnimationFrameGapMs: (() => { let g = 0; for (let i = 1; i < r.frames.length; i++) if (r.frames[i] > click) g = Math.max(g, r.frames[i] - r.frames[i - 1]); return Math.round(g); })(),
    };
    console.log("warm-up timeline:", JSON.stringify(timeline));
    save("warmup-timeline.json", timeline);
    painted.forEach((p, i) => { if (p.t > click - 300 && p.t < warm.settled + 500) save(`frame-${String(i).padStart(3, "0")}-${Math.round(p.t - click)}ms.png`, Buffer.from(p.data, "base64")); });

    expect(warm.outcome).toBe("resolved");
    expect(warm.engineAtCall).toBe("WARMING");
    expect(warm.analysisCanvas).toBe(false);
    expect([warm.w, warm.h]).toEqual([256, 256]);
    expect(preparing, "the preparing status was set").toBeTruthy();
    expect(preparing.t).toBeLessThan(warm.call);
    expect(firstPaint, "a frame was painted after the preparing status was set").toBeTruthy();

    // Frames and the end-of-analysis output.
    await runToEnd(page);
    const s2 = await readState(page);
    const frames = s2.rec.sends.slice(1);
    const summary = {
      frameSends: frames.length,
      allFramesAfterWarmupSettled: frames.every((f) => f.call > warm.settled),
      allFramesOnAnalysisCanvas: frames.every((f) => f.analysisCanvas),
      frameOutcomes: frames.reduce((m, f) => { m[f.outcome] = (m[f.outcome] || 0) + 1; return m; }, {}),
      maxFrameSyncBlockMs: Math.round(Math.max(...frames.map((f) => f.returned - f.call))),
      medianFrameRoundTripMs: (() => { const v = frames.filter((f) => f.settled).map((f) => f.settled - f.call).sort((a, b) => a - b); return v.length ? Math.round(v[Math.floor(v.length / 2)]) : null; })(),
      poseFrames: s2.poseFrames, poseFramesWithPose: s2.poseFramesWithPose, metrics: s2.metricsLen,
      tracked: s2.tracked, status: s2.status, feedback: s2.feedback.slice(0, 300),
      counters: s2.integrity.counters, engine: s2.integrity.engine, latched: s2.integrity.latched,
      poseConstructions: s2.rec.poseConstructions,
    };
    console.log("analysis 1:", JSON.stringify(summary));
    save("analysis-1.json", summary);
    expect(summary.frameSends).toBeGreaterThan(0);
    expect(summary.allFramesAfterWarmupSettled, "no frame before warm-up completes").toBe(true);
    expect(summary.allFramesOnAnalysisCanvas).toBe(true);
    expect(summary.latched).toBeNull();
    expect(summary.counters.resultsCommitted).toBeGreaterThan(0);
    expect(s2.poseFrames).toBe(summary.counters.resultsCommitted);
    expect(s2.feedback.length, "an end-of-analysis report is shown").toBeGreaterThan(0);
    expect(summary.poseConstructions, "no new Pose engine (Race untouched)").toBe(0);

    // Integrity latch on the real engine: an unsolicited result delivered
    // through the real MediaPipe callback path while no send is open.
    const latch = await page.evaluate(async () => {
      const before = window.__rec.sends.length;
      onChasePoseResults({ poseLandmarks: undefined });
      const sync = document.getElementById("chaseStatus").textContent;
      await new Promise((r) => setTimeout(r, 50));
      return { sync, after: document.getElementById("chaseStatus").textContent, latched: chaseInferenceIntegrityDiagnostics().latched, sends: window.__rec.sends.length - before };
    });
    console.log("latch:", JSON.stringify(latch));
    save("latch.json", latch);
    expect(latch.latched.violation).toBe("CALLBACK_WITHOUT_OPEN_SEND");
    expect(latch.after).toContain(RELOAD_IDLE);
    await page.locator('button[onclick="upload()"]').click();
    await page.waitForTimeout(500);
    const refused = await readState(page);
    expect(refused.analyzing).toBe(false);
    expect(refused.status).toContain("Reload the page before trying again.");
    expect(refused.rec.sends.length).toBe(s2.rec.sends.length);

    const unexpectedErrors = [...new Set(errors)].filter((e) => !(baselineErrors || []).includes(e));
    save("network-1.json", net);
    console.log("network:", JSON.stringify({ mirror: [...new Set(net.mirror)], stubbed: net.stubbed.length, blocked: [...new Set(net.blocked.map((u) => new URL(u).hostname))], failed: net.failed }));
    console.log("page errors beyond baseline:", JSON.stringify(unexpectedErrors));
    expect(unexpectedErrors).toEqual([]);
    await context.close();
  });

  test("consumer failure: report withheld, partial results cleared, later analysis on the same engine", async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext();
    const net = await routeOffline(context);
    const video = await syntheticVideo(context);
    const page = await context.newPage();
    const errors = await openAnalyzer(page, video);
    await page.evaluate(instrument);

    await page.locator('button[onclick="upload()"]').click();
    await runToEnd(page);
    const first = await readState(page);
    expect(first.tracked).not.toBeNull();

    // Analysis 2: the page's own consumer throws on its third result.
    await page.evaluate(() => {
      const original = window.chaseCaptureAdditivePoseFrame;
      let calls = 0;
      window.__restoreCapture = () => { window.chaseCaptureAdditivePoseFrame = original; };
      window.chaseCaptureAdditivePoseFrame = function () { calls++; const r = original.apply(this, arguments); if (calls === 3) throw new Error("validation: scripted consumer failure"); return r; };
    });
    await page.locator('button[onclick="upload()"]').click();
    await expect.poll(async () => (await readState(page)).integrity.sessionFailures.length, { timeout: 60_000 }).toBe(1);
    const failed = await readState(page);
    await page.evaluate(() => window.__restoreCapture());
    await page.waitForFunction(() => document.getElementById("analyzerPlayer").ended, null, { timeout: 60_000 });
    await page.waitForTimeout(500);
    const afterEnd = await readState(page);
    const sendsAtEnd = afterEnd.rec.sends.length;

    // Analysis 3 on the same engine, no reload, no new warm-up.
    await page.locator('button[onclick="upload()"]').click();
    await runToEnd(page);
    const third = await readState(page);

    const summary = {
      failure: failed.integrity.sessionFailures[0],
      failedState: { analyzing: failed.analyzing, metrics: failed.metricsLen, poseFrames: failed.poseFrames, metricsHtml: failed.metricsHtml, status: failed.status, feedback: failed.feedback, engine: failed.integrity.engine, latched: failed.integrity.latched },
      trackedKept: JSON.stringify(failed.tracked) === JSON.stringify(first.tracked) && JSON.stringify(afterEnd.tracked) === JSON.stringify(first.tracked),
      noReportAtEnd: afterEnd.feedback === failed.feedback && afterEnd.status === failed.status,
      third: { status: third.status, poseFrames: third.poseFrames, tracked: third.tracked, warmupsOpened: third.integrity.counters.warmupsOpened, engine: third.integrity.engine, sendsInThird: third.rec.sends.length - sendsAtEnd, poseConstructions: third.rec.poseConstructions },
    };
    console.log("consumer failure:", JSON.stringify(summary));
    save("consumer-failure.json", summary);
    expect(summary.failure.reason).toBe("CONSUMER_ERROR");
    expect(summary.failedState.analyzing).toBe(false);
    expect(summary.failedState.metrics).toBe(0);
    expect(summary.failedState.poseFrames).toBe(0);
    expect(summary.failedState.metricsHtml).toBe("");
    expect(summary.failedState.feedback).toContain("Analysis Stopped");
    expect(summary.failedState.feedback).toContain("Reference code: CONSUMER_ERROR");
    expect(summary.failedState.latched).toBeNull();
    expect(summary.failedState.engine).toBe("READY");
    expect(summary.trackedKept).toBe(true);
    expect(summary.noReportAtEnd).toBe(true);
    expect(summary.third.warmupsOpened).toBe(1);
    expect(summary.third.engine).toBe("READY");
    expect(summary.third.sendsInThird).toBeGreaterThan(0);
    expect(summary.third.poseFrames).toBeGreaterThan(0);
    expect(summary.third.tracked.generation).toBeGreaterThan(first.tracked.generation);
    expect(summary.third.poseConstructions).toBe(0);
    expect([...new Set(errors)].filter((e) => !(baselineErrors || []).includes(e))).toEqual([]);
    save("network-2.json", net);
    await context.close();
  });

  // Which local asset fault makes the real engine reject its warm-up send
  // is not known in advance; each is tried with a bound, and the observed
  // behaviour is reported. The documented refusal is asserted only when the
  // warm-up was actually rejected.
  for (const asset of ["pose_solution_simd_wasm_bin.wasm", "pose_solution_packed_assets.data", "pose_landmark_full.tflite", "pose_web.binarypb"]) {
    test(`warm-up fault: ${asset} answered with 404`, async ({ browser }) => {
      test.setTimeout(180_000);
      const context = await browser.newContext();
      const net = await routeOffline(context, { failAsset: asset });
      const video = await syntheticVideo(context, 1);
      const page = await context.newPage();
      const errors = await openAnalyzer(page, video);
      await page.evaluate(instrument);
      await page.locator('button[onclick="upload()"]').click();
      const deadline = Date.now() + 60_000;
      let s = await readState(page);
      while (Date.now() < deadline && (s.integrity.engine === "CREATED" || s.integrity.engine === "WARMING")) {
        await page.waitForTimeout(500);
        s = await readState(page);
      }
      const result = { asset, engine: s.integrity.engine, warmup: s.rec.sends[0] || null, status: s.status, warmupFailure: s.integrity.warmupFailure, latched: s.integrity.latched, failedRequests: net.failed, pageErrors: [...new Set(errors)].filter((e) => !(baselineErrors || []).includes(e)) };
      if (s.integrity.engine === "WARMUP_FAILED") {
        await page.locator('button[onclick="upload()"]').click();
        await page.waitForTimeout(500);
        const again = await readState(page);
        result.secondClick = { analyzing: again.analyzing, status: again.status, sends: again.rec.sends.length, plays: null };
        expect(again.analyzing).toBe(false);
        expect(again.status).toContain("The analysis engine couldn't start. Reload the page before trying again.");
        expect(again.rec.sends.length).toBe(1);
        expect(s.integrity.latched).toBeNull();
      }
      console.log("warm-up fault:", JSON.stringify(result));
      save(`warmup-fault-${asset}.json`, result);
      await context.close();
    });
  }
});
