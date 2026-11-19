// OPT-IN real-engine smoke test for the Pose adapter on its own, outside
// the Chase page (src/inference/pose-adapter.js). Skipped unless CHASE_POSE_MIRROR_DIR
// names a local directory holding the pinned @mediapipe/pose@0.5.1675469404
// files (pose.js, its wasm/js loader, packed assets, graph and model).
//
// What it is: a SMOKE test. It loads the real pinned engine in Chromium
// and drives it ONLY through the adapter, with a synthetic flat-grey
// canvas (no person, no video, no athlete data). It checks that warm-up,
// sequential sends, concurrent-send refusal, a throwing consumer (which
// ends that session) and a later session on the same engine behave as the
// adapter's logic tests expect on one real engine.
//
// What it is not: validation. One short run in one headless browser
// says nothing about other browsers, GPUs, timing, long sessions, real
// footage or failure modes, and it does not establish request identity
// (the legacy onResults callback carries no request ID).
//
// Network: every request goes to the fake host below and is answered
// from memory or from CHASE_POSE_MIRROR_DIR. Any other request is
// aborted and fails the test. Nothing contacts swimtics.com or a CDN.
// No dependency is added; it uses the repository's existing Playwright.

import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIRROR = process.env.CHASE_POSE_MIRROR_DIR || "";
const HOST = "http://pose-adapter-smoke.test";

// sha256 of the pinned 0.5.1675469404 files, as recorded for the local
// mirror used in the Stage 3.2 lifecycle validation runs.
const PINNED = {
  "pose.js": "fcb703afcce65d0a1c540f6a70c3bb45fc84521498c21a9d4160265dde648ab4",
  "pose_landmark_full.tflite": "e9a5c5cb17f736fafd4c2ec1da3b3d331d6edbe8a0d32395855aeb2cdfd64b9f",
  "pose_solution_packed_assets.data": "a63c614bef30d35947f13be361820b1e4e3bec9cfeebf4d11216a18373108e85",
  "pose_solution_packed_assets_loader.js": "d7aa29b7d8e11b5c97a58d719e982dd15c2de72995d95112d60492b854840a36",
  "pose_solution_simd_wasm_bin.js": "3983d1dca31d945d81abb70b18dd61f28ef4736e112463d7cfb1cbadef588127",
  "pose_solution_simd_wasm_bin.wasm": "195a929430e2ce130b3efb82e64ba27c8e68cb0f6bad870b715688060ea6f7e2",
  "pose_web.binarypb": "dc8efd1c2d62007b34278467407fda5f70847f41310e0e39f0f59fc17b1d01f7",
};

const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const typeOf = (name) => TYPES[name.slice(name.lastIndexOf("."))] || "application/octet-stream";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>pose adapter smoke</title>
<script src="/mirror/pose.js"></script>
<script src="/src/inference/request-lifecycle.js"></script>
<script src="/src/inference/pose-adapter.js"></script>
</head><body></body></html>`;

test.describe("Pose adapter on the real pinned engine (opt-in smoke, synthetic input)", () => {
  test.skip(!MIRROR, "opt-in: set CHASE_POSE_MIRROR_DIR to a local copy of @mediapipe/pose@0.5.1675469404");

  test("warm-up, sequential sends, concurrent refusal, a failed session and a later session", async ({ page }) => {
    test.setTimeout(180_000);

    // The mirror must be the pinned version, byte for byte.
    for (const [name, sha] of Object.entries(PINNED)) {
      const path = join(MIRROR, name);
      expect(existsSync(path), `${name} missing from CHASE_POSE_MIRROR_DIR`).toBe(true);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex"), name).toBe(sha);
    }

    const foreign = [];
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error && error.message)));
    await page.context().route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== HOST) { foreign.push(url.href); return route.abort(); }
      const path = url.pathname;
      if (path === "/" || path === "/index.html") return route.fulfill({ contentType: "text/html", body: PAGE });
      if (path === "/src/inference/request-lifecycle.js" || path === "/src/inference/pose-adapter.js") {
        return route.fulfill({ contentType: "text/javascript", body: readFileSync(join(ROOT, path.slice(1))) });
      }
      if (path.startsWith("/mirror/")) {
        const name = path.slice("/mirror/".length);
        if (Object.prototype.hasOwnProperty.call(PINNED, name)) {
          return route.fulfill({ contentType: typeOf(name), body: readFileSync(join(MIRROR, name)) });
        }
      }
      return route.fulfill({ status: 404, body: "" });
    });

    await page.goto(`${HOST}/index.html`);

    const run = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#808080"; // flat grey: synthetic, no person
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const consumed = [];
      let arrivals = 0;
      const adapter = createInferencePoseAdapter({
        createEngine: () => {
          const pose = new Pose({ locateFile: (file) => `/mirror/${file}` });
          pose.setOptions({
            modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false,
            smoothSegmentation: false, minDetectionConfidence: 0.35, minTrackingConfidence: 0.35,
          });
          return pose;
        },
        // A counter, not a clock: it shows the hook ran once per callback.
        readArrivalTime: () => ++arrivals,
        onEligibleResult: (r) => {
          consumed.push({ i: r.meta.i, session: r.sessionToken, timing: { ...r.timing }, hasLandmarks: Array.isArray(r.results && r.results.poseLandmarks) });
          if (r.meta.i === 2) throw new Error("smoke consumer error");
        },
      });

      const frames = [];
      async function send(token, i) {
        const pending = adapter.sendFrame(token, { image: canvas }, { i, dispatchTime: i * 40 });
        const concurrent = await adapter.sendFrame(token, { image: canvas }, { i, concurrent: true });
        const r = await pending;
        frames.push({ i, session: token, state: r.outcome && r.outcome.state, refusal: r.refusal, failure: r.failure && r.failure.reason, sendError: r.sendError, concurrentRefusal: concurrent.refusal });
      }

      const warm = await adapter.warmUp({ image: canvas });
      // Session A: the consumer throws on frame 2, which ends session A.
      const a = adapter.beginSession().token;
      for (let i = 0; i < 3; i++) await send(a, i);
      const lateA = await adapter.sendFrame(a, { image: canvas }, { i: 3 });
      // Session B on the same engine, no reload.
      const b = adapter.beginSession().token;
      for (let i = 3; i < 5; i++) await send(b, i);
      return {
        warm: warm.outcome && warm.outcome.state, warmError: warm.sendError, frames, consumed,
        lateARefusal: lateA.refusal, failureA: adapter.sessionFailure(a), failureB: adapter.sessionFailure(b),
        tokens: { a, b }, snapshot: adapter.snapshot(),
      };
    });

    // Report what the real engine did, then check it.
    console.log("pose-adapter real-engine smoke:", JSON.stringify({ warm: run.warm, frames: run.frames, adapter: run.snapshot.adapter }));
    expect(run.warmError).toBeNull();
    expect(run.warm).toBe("WARMUP_COMPLETE");
    expect(run.frames.map((f) => f.state)).toEqual(Array(5).fill("ELIGIBLE"));
    expect(run.frames.map((f) => f.concurrentRefusal)).toEqual(Array(5).fill("REQUEST_OPEN"));
    expect(run.frames.map((f) => f.failure)).toEqual([null, null, "CONSUMER_ERROR", null, null]);
    expect(run.failureA && run.failureA.reportWithheld).toBe(true);
    expect(run.failureB).toBeNull();
    expect(run.lateARefusal).toBe("NO_ACTIVE_SESSION");
    expect(run.consumed.map((c) => [c.i, c.session])).toEqual([[0, run.tokens.a], [1, run.tokens.a], [2, run.tokens.a], [3, run.tokens.b], [4, run.tokens.b]]);
    expect(run.consumed.map((c) => c.timing.dispatchTime)).toEqual([0, 40, 80, 120, 160]);
    // The warm-up callback also read the hook, so frame arrivals are 2..6.
    expect(run.consumed.map((c) => c.timing.arrivalTime)).toEqual([2, 3, 4, 5, 6]);
    const ad = run.snapshot.adapter;
    const life = run.snapshot.lifecycle;
    expect(ad.sendsForwarded).toBe(6); // warm-up + 5 frames
    expect(ad.sendsNotForwarded).toBe(6); // 5 concurrent sends + 1 send for the failed session
    expect(ad.sendsForwarded).toBe(life.counters.requestsOpened);
    expect(ad.callbacksHandled).toBe(6);
    expect(ad.consumerErrors).toBe(1);
    expect(ad.sessionsFailed).toBe(1);
    expect(life.latch).toBeNull();
    expect(life.engine).toBe("READY");
    expect(pageErrors).toEqual([]);
    expect(foreign).toEqual([]);
  });
});
