// Test-only harness: runs the REAL Chase analyzer script from index.html
// (the inline <script> after navigation.js) in an isolated Node `vm`
// context, with a scripted stand-in for MediaPipe Pose and minimal DOM
// stubs. Nothing here is real MediaPipe, a real video or a browser: the
// stand-in delivers exactly the callbacks and settlements a test asks
// for, which is the point — the eight inference-integrity cases are
// callback/settlement orderings that real MediaPipe cannot be made to
// produce on demand.
//
// index.html and the engine files are only read, never written.
//
// Chase now routes inference through the Pose adapter
// (src/inference/pose-adapter.js over src/inference/request-lifecycle.js),
// which sends one synthetic warm-up frame on the first upload() of each
// page load. HARNESS-ONLY accommodations: those two scripts are loaded
// when index.html loads them; h.upload() completes a pending warm-up (one
// no-pose callback, then the send resolves); warm-up sends are kept in
// h.warmupSends, so h.sends and its indices are frame sends only; and
// h.state().integrity reads the page's live adapter diagnostics.
//
// The pre-integrity analyzer can be loaded from Git by its blob id
// (PRE_INTEGRITY_INDEX_BLOB, the index.html at the pre-integrity main baseline) to compare
// behaviour on identical scripted input.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PRE_INTEGRITY_INDEX_BLOB = "19d32c86049f5180518b95b0da71fa2ed73511f8";

const ENGINE_FILES = [
  "geometry.js", "stats.js", "stroke-cycles.js", "pose-frame.js", "frame-timing.js", "tracked-sequence.js", "stroke-report-context.js",
];

export function currentIndexHtml() {
  return readFileSync(join(ROOT, "index.html"), "utf8");
}

// Returns the pre-integrity index.html, or null when Git or the blob is
// unavailable (callers skip with that reason).
export function preIntegrityIndexHtml() {
  try {
    return execFileSync("git", ["cat-file", "blob", PRE_INTEGRITY_INDEX_BLOB], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export function analyzerScript(html) {
  const marker = '<script src="src/app/pages/navigation.js"></script>';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error("analyzer script anchor (navigation.js tag) not found in index.html");
  const open = html.indexOf("<script>", at + marker.length) + "<script>".length;
  const close = html.indexOf("</script>", open);
  const body = html.slice(open, close);
  if (!body.includes("function chaseDispatchPoseInference(")) throw new Error("analyzer script block not where expected");
  return body;
}

// 33 landmarks whose geometry depends on `seed`, all visible, so every
// metric is finite and different seeds give different values.
export function poseResult(seed) {
  const landmarks = [];
  for (let i = 0; i < 33; i++) {
    landmarks.push({
      x: 0.2 + ((i * 7 + seed * 13) % 60) / 100,
      y: 0.15 + ((i * 11 + seed * 5) % 70) / 100,
      z: 0,
      visibility: 0.9,
    });
  }
  return { poseLandmarks: landmarks, poseWorldLandmarks: landmarks.map((p) => ({ ...p })), image: { seed } };
}

export function noPoseResult() {
  return { poseLandmarks: undefined, image: {} };
}

export function createAnalyzer({ html = currentIndexHtml(), stroke = "freestyle", extraScripts = [], search = "" } = {}) {
  const h = {
    sends: [],          // every frame pose.send() call: { settled, resolve(), reject() }
    warmupSends: [],    // the adapter's warm-up send(s), kept apart from frame sends
    events: [],         // analysis-canvas draws/resizes, with whether a send was outstanding
    timeouts: [],       // any setTimeout the analyzer schedules
    errors: [],
    alerts: [],
    windowListeners: [],
    rvfc: null,
    playGate: null,
  };
  const outstanding = () => h.sends.some((s) => !s.settled) || h.warmupSends.some((s) => !s.settled);

  const plainCtx = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });

  function makeCanvas(name) {
    let width = 0;
    let height = 0;
    const ctx = plainCtx();
    if (name === "analysis") {
      ctx.drawImage = () => h.events.push({ type: "draw", outstanding: outstanding(), sendIndex: h.sends.length });
    }
    return {
      style: {},
      get width() { return width; },
      set width(v) { if (name === "analysis") h.events.push({ type: "resize", outstanding: outstanding() }); width = v; },
      get height() { return height; },
      set height(v) { if (name === "analysis") h.events.push({ type: "resize", outstanding: outstanding() }); height = v; },
      getContext: () => ctx,
    };
  }

  const video = {
    src: "blob:fixture",
    currentTime: 0,
    readyState: 4,
    ended: false,
    videoWidth: 640,
    videoHeight: 360,
    clientWidth: 640,
    clientHeight: 360,
    duration: 30,
    play: () => (h.playGate ? h.playGate.promise : Promise.resolve()),
    load() {},
    addEventListener() {},
    requestVideoFrameCallback(cb) { h.rvfc = cb; return 1; },
    cancelVideoFrameCallback() { h.rvfc = null; },
  };

  const listeners = {};
  const element = (extra = {}) => ({
    innerHTML: "", textContent: "", value: "", style: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    ...extra,
  });
  const elements = {
    analyzerPlayer: video,
    canvas: makeCanvas("display"),
    stroke: element({ value: stroke }),
    metrics: element(),
    feedback: element(),
    chaseStatus: element({ dataset: {} }),
    fileName: element(),
    videoUpload: element(),
  };

  class Pose {
    constructor() { h.pose = this; this.cb = null; }
    setOptions(options) { this.options = options; }
    onResults(cb) { this.cb = cb; }
    send({ image }) {
      let resolve;
      let reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      const record = {
        image,
        settled: false,
        resolve() { record.settled = true; resolve(); },
        reject(error) { record.settled = true; reject(error || new Error("scripted rejection")); },
      };
      const warming = h.run && h.run('typeof chaseInferenceIntegrityDiagnostics === "function" && chaseInferenceIntegrityDiagnostics() !== null && chaseInferenceIntegrityDiagnostics().engine === "WARMING"');
      (warming ? h.warmupSends : h.sends).push(record);
      return promise;
    }
  }

  const sandbox = {
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => makeCanvas("analysis"),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    Pose,
    alert: (m) => h.alerts.push(String(m)),
    console: { log() {}, info() {}, warn() {}, error: (...a) => h.errors.push(a.map(String).join(" ")) },
    performance: { now: () => 1000 },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn, ms) => { h.timeouts.push(ms); return 1; },
    clearTimeout() {},
    URL: { createObjectURL: () => "blob:replacement", revokeObjectURL() {} },
    localStorage: { getItem: () => null, setItem() {} },
    location: { search },
    URLSearchParams,
    devicePixelRatio: 1,
    addEventListener: (type, fn) => h.windowListeners.push({ type, fn }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const file of ENGINE_FILES) {
    vm.runInContext(readFileSync(join(ROOT, "src", "chase-engine", file), "utf8"), sandbox, { filename: file });
  }
  if (html.includes('src="src/chase-engine/inference-integrity.js"')) {
    vm.runInContext(readFileSync(join(ROOT, "src", "chase-engine", "inference-integrity.js"), "utf8"), sandbox, { filename: "inference-integrity.js" });
  }
  for (const file of ["src/inference/request-lifecycle.js", "src/inference/pose-adapter.js"]) {
    if (html.includes(`src="${file}"`)) {
      vm.runInContext(readFileSync(join(ROOT, file), "utf8"), sandbox, { filename: file });
    }
  }
  for (const file of extraScripts) {
    vm.runInContext(readFileSync(join(ROOT, file), "utf8"), sandbox, { filename: file });
  }
  vm.runInContext(analyzerScript(html), sandbox, { filename: "index.html analyzer script" });

  h.run = (code) => vm.runInContext(code, sandbox);
  h.video = video;
  h.elements = elements;
  h.listeners = listeners;
  h.flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  h.upload = async () => {
    const p = h.run("upload()");
    await h.flush();
    const warm = h.warmupSends[h.warmupSends.length - 1];
    if (warm && !warm.settled) {
      h.pose.cb(noPoseResult());
      warm.resolve();
      await h.flush();
    }
    return p;
  };
  h.holdPlayback = () => { let release; const promise = new Promise((r) => { release = r; }); h.playGate = { promise, release: () => { h.playGate = null; release(); } }; return h.playGate; };
  // Presents a frame at `seconds`; a due frame is dispatched by the real rVFC ticker.
  h.frame = (seconds) => { video.currentTime = seconds; const cb = h.rvfc; h.rvfc = null; if (cb) cb(0, { mediaTime: seconds }); };
  h.callback = (results) => h.pose.cb(results);
  h.resolve = async (i) => { h.sends[i].resolve(); await h.flush(); };
  h.reject = async (i) => { h.sends[i].reject(); await h.flush(); };
  h.finish = () => h.run("finishChaseAnalysis()");
  h.fireDOMContentLoaded = () => { for (const l of h.windowListeners) if (l.type === "DOMContentLoaded") { try { l.fn(); } catch (e) { h.errors.push("DOMContentLoaded: " + e.message); } } };
  h.replaceVideo = () => { for (const fn of listeners.change || []) fn({ target: { files: [{ name: "replacement.webm" }] } }); };
  h.state = () => JSON.parse(h.run(`JSON.stringify({
    metrics: metricsHistory,
    poseFrames: chasePoseFrameHistory,
    analysis: currentAnalysis,
    analyzing,
    busy: chaseAnalysisBusy,
    generation: chaseAnalysisGeneration,
    integrity: typeof chaseInferenceIntegrityDiagnostics === "function" ? chaseInferenceIntegrityDiagnostics() : (window.chaseAI.inferenceIntegrity || null),
    tracked: window.chaseAI.lastTrackedSequence,
    lastMetrics: window.lastMetrics
  })`));
  h.feedback = () => elements.feedback.innerHTML;
  h.status = () => elements.chaseStatus.textContent;
  return h;
}
