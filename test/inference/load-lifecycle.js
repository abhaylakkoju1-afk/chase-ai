// Test-only loader for src/inference/request-lifecycle.js (a classic
// script that defines globals). Each call evaluates the file in a fresh,
// EMPTY Node `vm` context: no window, document, timers, performance,
// Date mocking or MediaPipe exist there, so a test passing here also shows
// the module needs none of them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LIFECYCLE_PATH = join(ROOT, "src", "inference", "request-lifecycle.js");
export const LIFECYCLE_SOURCE = readFileSync(LIFECYCLE_PATH, "utf8");

export function loadLifecycle() {
  const sandbox = vm.createContext({});
  vm.runInContext(LIFECYCLE_SOURCE, sandbox, { filename: LIFECYCLE_PATH });
  return vm.runInContext(`({
    create: createInferenceRequestLifecycle,
    ENGINE: INFERENCE_ENGINE_STATES,
    SESSION: INFERENCE_SESSION_STATES,
    KIND: INFERENCE_REQUEST_KINDS,
    STATE: INFERENCE_REQUEST_STATES,
    LATCH: INFERENCE_LATCH_REASONS,
    REFUSAL: INFERENCE_REFUSALS
  })`, sandbox);
}

export const ADAPTER_PATH = join(ROOT, "src", "inference", "pose-adapter.js");
export const ADAPTER_SOURCE = readFileSync(ADAPTER_PATH, "utf8");

// The Pose adapter, loaded after the lifecycle in the same EMPTY context
// (its only dependency), exactly as a page would load the two scripts.
export function loadAdapter() {
  const sandbox = vm.createContext({});
  vm.runInContext(LIFECYCLE_SOURCE, sandbox, { filename: LIFECYCLE_PATH });
  vm.runInContext(ADAPTER_SOURCE, sandbox, { filename: ADAPTER_PATH });
  return vm.runInContext(`({
    createAdapter: createInferencePoseAdapter,
    FAILURE: INFERENCE_SESSION_FAILURES,
    ENGINE: INFERENCE_ENGINE_STATES,
    STATE: INFERENCE_REQUEST_STATES,
    LATCH: INFERENCE_LATCH_REASONS,
    REFUSAL: INFERENCE_REFUSALS
  })`, sandbox);
}

// Merged INT-1 (src/chase-engine/inference-integrity.js), loaded the same
// way, for equivalence checks. It is only read.
export function loadInt1() {
  const sandbox = vm.createContext({});
  const path = join(ROOT, "src", "chase-engine", "inference-integrity.js");
  vm.runInContext(readFileSync(path, "utf8"), sandbox, { filename: path });
  return vm.runInContext(`({ create: chaseCreateInferenceIntegrityState, canDispatch: chaseInferenceCanDispatch,
    open: chaseOpenInferenceWindow, callback: chaseRecordInferenceCallback, close: chaseCloseInferenceWindow,
    V: CHASE_INFERENCE_VIOLATIONS })`, sandbox);
}

// A lifecycle whose warm-up already completed with exactly one callback.
export function readyLifecycle(m) {
  const life = m.create();
  const w = life.beginWarmup();
  life.recordCallback("warmup-callback");
  life.settle(w.request.requestId, "resolved");
  return life;
}

// Small deterministic PRNG (mulberry32) for the property tests.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const plain = (value) => JSON.parse(JSON.stringify(value));
