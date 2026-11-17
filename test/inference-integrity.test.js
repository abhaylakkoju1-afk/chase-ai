// Unit tests for src/chase-engine/inference-integrity.js, the pure state
// machine behind Chase's inference-result containment (see
// docs/CHASE_INFERENCE_INTEGRITY.md). The analyzer wiring is tested
// separately against the real index.html script in
// test/inference-integrity-analyzer.test.js.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "src", "chase-engine", "inference-integrity.js"), "utf8"), sandbox);
const m = vm.runInContext(`({ create: chaseCreateInferenceIntegrityState, canDispatch: chaseInferenceCanDispatch,
  open: chaseOpenInferenceWindow, callback: chaseRecordInferenceCallback, close: chaseCloseInferenceWindow,
  summary: chaseInferenceIntegritySummary, V: CHASE_INFERENCE_VIOLATIONS })`, sandbox);

const ACTIVE = { currentGeneration: 1, sessionActive: true };
const timing = (ms) => ({ mediaTimeMs: ms, isFrameAccurate: true, generation: 1 });

describe("one send, one callback", () => {
  test("a callback before settlement is held, then committed with that send's own record", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1, pendingTiming: timing(40) });
    assert.equal(m.callback(s, "A").action, "HELD");
    const d = m.close(s, w, { outcome: "resolved", ...ACTIVE });
    assert.equal(d.action, "COMMIT");
    assert.equal(d.payload, "A");
    assert.equal(d.pendingTiming.mediaTimeMs, 40);
    assert.equal(s.latched, null);
    assert.ok(m.canDispatch(s));
  });

  test("a held result for a session that ended or was replaced is discarded, not a violation", () => {
    for (const ctx of [{ currentGeneration: 2, sessionActive: true }, { currentGeneration: 1, sessionActive: false }]) {
      const s = m.create();
      const w = m.open(s, { generation: 1, pendingTiming: timing(0) });
      m.callback(s, "A");
      const d = m.close(s, w, { outcome: "resolved", ...ctx });
      assert.equal(d.action, "DISCARD");
      assert.equal(d.payload, null);
      assert.equal(s.latched, null);
      assert.equal(s.counters.resultsDiscardedStale, 1);
    }
  });
});

describe("dispatch gating", () => {
  test("no second window while one is open, from any generation", () => {
    const s = m.create();
    m.open(s, { generation: 1 });
    assert.equal(m.canDispatch(s), false);
    assert.equal(m.open(s, { generation: 2 }), null);
    assert.equal(s.counters.dispatchesRefused, 1);
  });

  test("a latch refuses every later dispatch and nothing clears it", () => {
    const s = m.create();
    m.callback(s, "stray");
    assert.equal(s.latched.violation, m.V.CALLBACK_WITHOUT_OPEN_SEND);
    for (let i = 0; i < 3; i++) assert.equal(m.open(s, { generation: i }), null);
  });
});

describe("violations latch and never commit", () => {
  test("resolved without a callback", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1 });
    const d = m.close(s, w, { outcome: "resolved", ...ACTIVE });
    assert.equal(d.violation, m.V.RESOLVED_WITHOUT_CALLBACK);
    assert.notEqual(d.action, "COMMIT");
    assert.equal(s.latched.violation, m.V.RESOLVED_WITHOUT_CALLBACK);
  });

  test("two callbacks in one window: both dropped at the second, latched immediately", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1 });
    m.callback(s, "first");
    const second = m.callback(s, "second");
    assert.equal(second.violation, m.V.MULTIPLE_CALLBACKS_FOR_SEND);
    assert.equal(s.latched.violation, m.V.MULTIPLE_CALLBACKS_FOR_SEND);
    const d = m.close(s, w, { outcome: "resolved", ...ACTIVE });
    assert.equal(d.action, "DISCARD");
    assert.equal(d.payload, null);
    assert.equal(s.counters.callbacksDropped, 2);
    assert.equal(s.counters.violations, 1);
  });

  test("a callback inside a rejected send's window", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1 });
    m.callback(s, "A");
    const d = m.close(s, w, { outcome: "rejected", ...ACTIVE });
    assert.equal(d.violation, m.V.CALLBACK_FOR_REJECTED_SEND);
    assert.equal(d.payload, null);
  });

  test("a rejected send without a callback is clean", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1 });
    const d = m.close(s, w, { outcome: "rejected", ...ACTIVE });
    assert.equal(d.violation, null);
    assert.equal(s.latched, null);
    assert.equal(s.counters.sendsRejectedWithoutResult, 1);
    assert.ok(m.canDispatch(s));
  });

  test("a window that is not the open one, or an unknown outcome, never commits", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1 });
    m.callback(s, "A");
    assert.equal(m.close(s, { id: 99 }, { outcome: "resolved", ...ACTIVE }).violation, m.V.WINDOW_MISMATCH);
    const t = m.create();
    const w2 = m.open(t, { generation: 1 });
    m.callback(t, "A");
    assert.notEqual(m.close(t, w2, { outcome: "weird", ...ACTIVE }).action, "COMMIT");
    assert.ok(w);
  });

  test("after a latch, a later clean-looking window still does not commit", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1 });
    m.callback(s, "A");
    s.latched = { violation: "TEST", windowId: null, generation: null };
    assert.equal(m.close(s, w, { outcome: "resolved", ...ACTIVE }).action, "DISCARD");
  });
});

describe("documented limit: no request identity", () => {
  test("a foreign callback alone in a window whose own result never comes IS committed (undetectable residual)", () => {
    const s = m.create();
    const w = m.open(s, { generation: 1, pendingTiming: timing(130) });
    m.callback(s, "duplicate-of-previous-frame");
    const d = m.close(s, w, { outcome: "resolved", ...ACTIVE });
    assert.equal(d.action, "COMMIT", "the state machine cannot tell a foreign callback from the send's own");
    assert.equal(d.payload, "duplicate-of-previous-frame");
    // If the own result turns up later, it is caught, but only from then on.
    m.callback(s, "own-result-late");
    assert.equal(s.latched.violation, m.V.CALLBACK_WITHOUT_OPEN_SEND);
  });

  test("the summary says identity is not established", () => {
    assert.match(m.summary(m.create()).identity, /not established/);
  });
});
