// Logic tests for the Pose adapter (src/inference/pose-adapter.js) on its
// own, outside the Chase page that uses it.
//
// FAKE ENGINE: every test here drives the adapter with a scripted stand-in
// for MediaPipe Pose. It computes nothing, reads no pixels, and delivers
// exactly the callbacks and settlements each test asks for. These are
// LOGIC TESTS of the adapter's routing and bookkeeping. They are NOT
// evidence about which orderings real MediaPipe produces or how it
// behaves. The opt-in real-engine smoke test is
// test/e2e/pose-adapter-real-engine.spec.js.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_SOURCE, loadAdapter, plain } from "./load-lifecycle.js";

const m = loadAdapter();
const { ENGINE, STATE, LATCH, REFUSAL, FAILURE } = m;

// Scripted fake engine (NOT MediaPipe). Each send() returns a promise the
// test settles by hand; emit() invokes the registered results callback.
function fakeEngine({ onSend } = {}) {
  const eng = { sends: [], callback: null, registrations: 0 };
  eng.onResults = (cb) => { eng.callback = cb; eng.registrations++; };
  eng.send = (input) => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    const s = {
      input,
      settled: false,
      resolve: () => { s.settled = true; resolve(); },
      reject: (error) => { s.settled = true; reject(error || new Error("fake rejection")); }
    };
    eng.sends.push(s);
    if (onSend) onSend(s, eng);
    return promise;
  };
  eng.emit = (results) => eng.callback(results);
  eng.last = () => eng.sends[eng.sends.length - 1];
  return eng;
}

const LM = (x) => ({ poseLandmarks: [{ x, y: 0.5, z: 0, visibility: 0.9 }], poseWorldLandmarks: [{ x, y: 0, z: 0 }] });

function newAdapter(opts = {}, engineOpts) {
  const eng = fakeEngine(engineOpts);
  let created = 0;
  const consumed = [];
  const adapter = m.createAdapter({
    createEngine: () => { created++; return eng; },
    onEligibleResult: opts.consumer || ((r) => consumed.push(r)),
    readArrivalTime: opts.readArrivalTime,
    onIntegrityLatch: opts.onIntegrityLatch,
  });
  return { adapter, eng, consumed, created: () => created };
}

async function readyAdapter(opts) {
  const t = newAdapter(opts);
  const p = t.adapter.warmUp("synthetic-grey");
  t.eng.emit({});
  t.eng.last().resolve();
  const w = await p;
  assert.equal(w.outcome.state, STATE.WARMUP_COMPLETE);
  return t;
}

// One frame through the fake engine: one callback, then the send resolves.
async function frame(t, token, x, meta = { x }) {
  const p = t.adapter.sendFrame(token, `frame-${x}`, meta);
  t.eng.emit(LM(x));
  t.eng.last().resolve();
  return p;
}

const snap = (t) => t.adapter.snapshot();

describe("adapter boundary", () => {
  test("references no browser API, clock, timer, randomness or MediaPipe global", () => {
    const code = ADAPTER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const name of ["window", "document", "navigator", "performance", "Date", "setTimeout", "setInterval",
      "requestAnimationFrame", "requestVideoFrameCallback", "Math.random", "Pose", "mediapipe", "location", "localStorage", "fetch"]) {
      assert.equal(new RegExp(`\\b${name.replace(".", "\\.")}\\b`).test(code), false, `unexpected reference to ${name}`);
    }
  });

  test("creates the engine once, registers one callback, and never exposes the engine", () => {
    const t = newAdapter();
    assert.equal(t.created(), 1);
    assert.equal(t.eng.registrations, 1);
    assert.deepEqual(Object.keys(t.adapter).sort(),
      ["beginSession", "canSendFrame", "endSession", "hasOpenSend", "sendFrame", "sessionFailure", "snapshot", "warmUp"]);
    assert.ok(Object.isFrozen(t.adapter));
    for (const key of Object.keys(t.adapter)) assert.notEqual(t.adapter[key], t.eng);
    assert.deepEqual(Object.keys(snap(t)).sort(), ["adapter", "failedSessions", "lifecycle"]);
    assert.ok(Object.values(snap(t).adapter).every((v) => typeof v === "number"), "adapter snapshot holds counters only");
  });

  test("engine creation is injectable; creation errors and invalid engines surface synchronously", () => {
    assert.throws(() => m.createAdapter({}), /createEngine must be a function/);
    assert.throws(() => m.createAdapter({ createEngine: () => { throw new Error("no engine"); } }), /no engine/);
    assert.throws(() => m.createAdapter({ createEngine: () => ({ send() {} }) }), /send\(\) and onResults\(\)/);
    assert.throws(() => m.createAdapter({ createEngine: () => fakeEngine(), onEligibleResult: 5 }), /onEligibleResult/);
  });
});

describe("warm-up through the adapter (fake engine)", () => {
  test("frames are refused, and not forwarded, before and during the warm-up", async () => {
    const t = newAdapter();
    const token = t.adapter.beginSession().token;
    const early = await t.adapter.sendFrame(token, "f0");
    assert.equal(early.accepted, false);
    assert.equal(early.refusal, REFUSAL.NOT_READY);
    assert.equal(t.eng.sends.length, 0);
    const w = t.adapter.warmUp("synthetic-grey");
    assert.equal(t.eng.sends.length, 1);
    assert.equal(t.eng.sends[0].input, "synthetic-grey");
    assert.equal((await t.adapter.sendFrame(token, "f1")).refusal, REFUSAL.REQUEST_OPEN);
    assert.equal((await t.adapter.warmUp("again")).refusal, REFUSAL.REQUEST_OPEN);
    assert.equal(t.eng.sends.length, 1, "nothing forwarded while the warm-up is open");
    t.eng.emit({});
    t.eng.last().resolve();
    const out = await w;
    assert.equal(out.outcome.state, STATE.WARMUP_COMPLETE);
    assert.equal(snap(t).lifecycle.engine, ENGINE.READY);
    assert.equal(t.consumed.length, 0, "warm-up results never reach the consumer");
    assert.equal((await t.adapter.warmUp("third")).refusal, REFUSAL.ALREADY_WARMED);
  });

  test("a rejected warm-up is WARMUP_FAILED (not a latch); later frames, warm-ups and sessions are refused and not forwarded", async () => {
    const t = newAdapter();
    const w = t.adapter.warmUp("synthetic-grey");
    t.eng.last().reject(new Error("graph fetch failed"));
    const out = await w;
    assert.equal(out.outcome.state, STATE.REJECTED_WITHOUT_RESULT);
    assert.equal(out.outcome.latchReason, null);
    assert.equal(out.sendError, "graph fetch failed");
    const s = snap(t).lifecycle;
    assert.equal(s.engine, ENGINE.WARMUP_FAILED);
    assert.equal(s.latch, null);
    assert.equal(s.requiresReload, true);
    assert.equal(t.adapter.beginSession().reason, REFUSAL.WARMUP_FAILED);
    for (const token of [null, 1]) assert.equal((await t.adapter.sendFrame(token, "f")).refusal, REFUSAL.WARMUP_FAILED);
    assert.equal((await t.adapter.warmUp("retry")).refusal, REFUSAL.WARMUP_FAILED);
    assert.equal(t.eng.sends.length, 1, "only the warm-up was ever forwarded");
  });

  test("a warm-up that resolves without a callback latches (core rule), and nothing more is forwarded", async () => {
    const t = newAdapter();
    const w = t.adapter.warmUp("synthetic-grey");
    t.eng.last().resolve();
    assert.equal((await w).outcome.latchReason, LATCH.RESOLVED_WITHOUT_CALLBACK);
    assert.equal(snap(t).lifecycle.engine, ENGINE.LATCHED);
    assert.equal((await t.adapter.sendFrame(1, "f")).refusal, REFUSAL.LATCHED);
    assert.equal(t.eng.sends.length, 1);
  });
});

describe("sequential sends (fake engine)", () => {
  test("five frames, one at a time: each forwarded once, each ELIGIBLE, consumed in order with its meta", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    for (let i = 1; i <= 5; i++) {
      const r = await frame(t, token, i / 10, { mediaTimeMs: i * 40 });
      assert.equal(r.accepted, true);
      assert.equal(r.outcome.state, STATE.ELIGIBLE);
      assert.equal(r.failure, null);
      assert.equal(t.eng.last().input, `frame-${i / 10}`);
    }
    assert.deepEqual(t.consumed.map((c) => c.meta.mediaTimeMs), [40, 80, 120, 160, 200]);
    assert.deepEqual(t.consumed.map((c) => c.results.poseLandmarks[0].x), [0.1, 0.2, 0.3, 0.4, 0.5]);
    assert.ok(t.consumed.every((c) => c.sessionToken === token));
    const s = snap(t);
    assert.equal(s.adapter.sendsForwarded, 6);
    assert.equal(s.adapter.sendsForwarded, s.lifecycle.counters.requestsOpened);
    assert.equal(s.lifecycle.counters.resultsEligible, 5);
  });
});

describe("concurrent-send refusal (fake engine)", () => {
  test("a second send while one is open is refused and never reaches the engine; the slot frees only on settle", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const a = t.adapter.sendFrame(token, "A");
    const forwarded = t.eng.sends.length;
    const b = await t.adapter.sendFrame(token, "B");
    assert.equal(b.accepted, false);
    assert.equal(b.refusal, REFUSAL.REQUEST_OPEN);
    assert.equal(t.eng.sends.length, forwarded, "B was not forwarded");
    // A callback alone does not free the slot.
    t.eng.emit(LM(1));
    assert.equal((await t.adapter.sendFrame(token, "C")).refusal, REFUSAL.REQUEST_OPEN);
    assert.equal(t.adapter.hasOpenSend(), true);
    t.eng.last().resolve();
    assert.equal((await a).outcome.state, STATE.ELIGIBLE);
    assert.equal(t.adapter.hasOpenSend(), false);
    const d = await frame(t, token, 2);
    assert.equal(d.accepted, true);
    assert.equal(snap(t).adapter.sendsNotForwarded, 2);
  });

  test("a send that never settles holds the slot: sessions and attempts do not release it (no timeout exists)", async () => {
    const t = await readyAdapter();
    let token = t.adapter.beginSession().token;
    t.adapter.sendFrame(token, "hung"); // never settled
    const forwarded = t.eng.sends.length;
    for (let i = 0; i < 50; i++) {
      if (i % 10 === 0) token = t.adapter.beginSession().token;
      assert.equal((await t.adapter.sendFrame(token, `x${i}`)).refusal, REFUSAL.REQUEST_OPEN);
    }
    assert.equal(t.eng.sends.length, forwarded);
    assert.equal(t.adapter.hasOpenSend(), true);
    assert.equal(t.adapter.canSendFrame(token), false);
  });
});

describe("callback-before-settle ordering (fake engine)", () => {
  test("the result is held at the callback and consumed only after the send settles", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    const raw = LM(0.3);
    t.eng.emit(raw);
    await Promise.resolve();
    assert.equal(t.consumed.length, 0, "not consumed at the callback");
    raw.poseLandmarks[0].x = 99; // the engine mutating its own result after the callback
    t.eng.last().resolve();
    const r = await p;
    assert.equal(r.outcome.state, STATE.ELIGIBLE);
    assert.equal(t.consumed.length, 1);
    assert.equal(t.consumed[0].results.poseLandmarks[0].x, 0.3, "the copy taken at the callback is consumed");
  });

  test("a callback delivered synchronously inside send() is counted for that send", async () => {
    const t = newAdapter({}, { onSend: (s, eng) => { eng.emit(LM(0.7)); queueMicrotask(s.resolve); } });
    await t.adapter.warmUp("grey");
    const token = t.adapter.beginSession().token;
    const r = await t.adapter.sendFrame(token, "A");
    assert.equal(r.outcome.state, STATE.ELIGIBLE);
    assert.equal(t.consumed[0].results.poseLandmarks[0].x, 0.7);
  });

  test("a callback after the send settled is unsolicited: latch, nothing consumed, nothing more forwarded", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.last().resolve();
    const r = await p;
    assert.equal(r.outcome.latchReason, LATCH.RESOLVED_WITHOUT_CALLBACK);
    t.eng.emit(LM(1)); // late result
    assert.equal(snap(t).lifecycle.latch.reason, LATCH.RESOLVED_WITHOUT_CALLBACK, "first latch reason kept");
    assert.equal(t.consumed.length, 0);
    const forwarded = t.eng.sends.length;
    assert.equal((await t.adapter.sendFrame(token, "B")).refusal, REFUSAL.LATCHED);
    assert.equal(t.eng.sends.length, forwarded);
  });

  test("two callbacks in one window: dropped, latched, nothing consumed", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.emit(LM(1));
    t.eng.emit(LM(2));
    t.eng.last().resolve();
    const r = await p;
    assert.equal(r.outcome.state, STATE.FAILED_CLOSED);
    assert.equal(snap(t).lifecycle.latch.reason, LATCH.MULTIPLE_CALLBACKS_FOR_SEND);
    assert.equal(t.consumed.length, 0);
  });
});

describe("stale-session results (fake engine)", () => {
  for (const [label, retire] of [
    ["a new session began", (a) => { a.beginSession(); }],
    ["the session ended", (a, token) => { a.endSession(token, "ended"); }],
  ]) {
    test(`a result whose session ${label} before settle is DISCARDED_STALE and not consumed`, async () => {
      const t = await readyAdapter();
      const token = t.adapter.beginSession().token;
      const p = t.adapter.sendFrame(token, "A");
      t.eng.emit(LM(1));
      retire(t.adapter, token);
      t.eng.last().resolve();
      const r = await p;
      assert.equal(r.outcome.state, STATE.DISCARDED_STALE);
      assert.equal(r.outcome.payload, null);
      assert.equal(t.consumed.length, 0);
      assert.equal(snap(t).lifecycle.latch, null);
    });
  }
});

describe("rejected sends (fake engine)", () => {
  test("a frame send rejected without a callback: no result, slot released, engine still READY", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.last().reject(new Error("frame read failed"));
    const r = await p;
    assert.equal(r.outcome.state, STATE.REJECTED_WITHOUT_RESULT);
    assert.equal(r.sendError, "frame read failed");
    assert.equal(snap(t).lifecycle.engine, ENGINE.READY);
    assert.equal((await frame(t, token, 1)).outcome.state, STATE.ELIGIBLE);
  });

  test("a frame send rejected after a callback latches CALLBACK_FOR_REJECTED_SEND; nothing consumed", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.emit(LM(1));
    t.eng.last().reject();
    assert.equal((await p).outcome.latchReason, LATCH.CALLBACK_FOR_REJECTED_SEND);
    assert.equal(t.consumed.length, 0);
  });

  test("send() throwing synchronously is a rejected send; the returned promise still resolves", async () => {
    let throwNext = false;
    const t = newAdapter({}, {});
    const realSend = t.eng.send;
    t.eng.send = (input) => { if (throwNext) throw new Error("sync boom"); return realSend(input); };
    const w = t.adapter.warmUp("grey"); t.eng.emit({}); t.eng.last().resolve(); await w;
    const token = t.adapter.beginSession().token;
    throwNext = true;
    const r = await t.adapter.sendFrame(token, "A");
    assert.equal(r.outcome.state, STATE.REJECTED_WITHOUT_RESULT);
    assert.equal(r.sendError, "sync boom");
    assert.equal(snap(t).adapter.sendsThrewSynchronously, 1);
    assert.equal(t.adapter.hasOpenSend(), false);
  });
});

// Reviewed integration decisions 1 and 2: a consumer error or a failed
// result capture ends the session and withholds its report; the engine
// stays available (no latch, no recreation).
function assertSessionFailed(t, r, token, reason) {
  assert.equal(r.accepted, true);
  assert.equal(r.outcome.state, STATE.ELIGIBLE, "the core's INT-1 outcome is reported unchanged");
  assert.equal(r.failure.kind, "SESSION_FAILED");
  assert.equal(r.failure.reason, reason);
  assert.equal(r.failure.sessionToken, token);
  assert.equal(r.failure.sessionEnded, true);
  assert.equal(r.failure.reportWithheld, true);
  assert.equal(t.adapter.sessionFailure(token), r.failure);
  const s = snap(t);
  assert.equal(s.lifecycle.session.token, token);
  assert.equal(s.lifecycle.session.state, "ENDED");
  assert.equal(s.lifecycle.session.endReason, reason);
  // The engine is untouched and still available.
  assert.equal(s.lifecycle.engine, ENGINE.READY);
  assert.equal(s.lifecycle.latch, null);
  assert.equal(s.lifecycle.requiresReload, false);
  assert.equal(t.adapter.hasOpenSend(), false);
  assert.equal(t.adapter.canSendFrame(token), false);
}

// After a failed session: the old session is refused without forwarding,
// and a new session analyses normally and is not marked failed.
async function assertLaterSessionWorks(t, oldToken) {
  const forwarded = t.eng.sends.length;
  const old = await t.adapter.sendFrame(oldToken, "late");
  assert.equal(old.refusal, REFUSAL.NO_ACTIVE_SESSION);
  assert.equal(t.eng.sends.length, forwarded, "nothing forwarded for the failed session");
  const next = t.adapter.beginSession();
  assert.equal(next.accepted, true);
  for (let i = 1; i <= 3; i++) {
    const r = await frame(t, next.token, i);
    assert.equal(r.outcome.state, STATE.ELIGIBLE);
    assert.equal(r.failure, null);
  }
  assert.equal(t.adapter.sessionFailure(next.token), null);
  assert.equal(snap(t).adapter.sendsForwarded, forwarded + 3);
  return next.token;
}

describe("consumer throws: session ended, report withheld, engine kept (fake engine)", () => {
  test("the throw is caught after settle, outside the engine callback, and ends only that session", async () => {
    let calls = 0;
    let insideCallback = false;
    let consumedInsideCallback = false;
    const delivered = [];
    const t = await readyAdapter({
      consumer: (r) => {
        calls++;
        if (insideCallback) consumedInsideCallback = true;
        if (calls === 2) throw new Error("render failed");
        delivered.push(r.sessionToken);
      }
    });
    const token = t.adapter.beginSession().token;
    assert.equal((await frame(t, token, 1)).failure, null);
    const p = t.adapter.sendFrame(token, "A");
    insideCallback = true;
    const returned = t.eng.emit(LM(2)); // must not throw
    insideCallback = false;
    assert.equal(returned, undefined);
    assert.equal(calls, 1, "the consumer never runs inside the engine callback");
    t.eng.last().resolve();
    const r = await p; // must not reject
    assertSessionFailed(t, r, token, FAILURE.CONSUMER_ERROR);
    assert.equal(r.failure.message, "render failed");
    assert.equal(consumedInsideCallback, false);
    const c = snap(t).adapter;
    assert.equal(c.consumerErrors, 1);
    assert.equal(c.sessionsFailed, 1);
    assert.equal(c.resultsWithheld, 0, "the consumer was called; nothing was withheld from it");
    const next = await assertLaterSessionWorks(t, token);
    assert.deepEqual(delivered, [token, next, next, next]);
  });

  test("a non-Error throw is reported as text", async () => {
    const t = await readyAdapter({ consumer: () => { throw "not an Error"; } });
    const token = t.adapter.beginSession().token;
    const r = await frame(t, token, 1);
    assertSessionFailed(t, r, token, FAILURE.CONSUMER_ERROR);
    assert.equal(r.failure.message, "not an Error");
  });

  test("a failed session stays recorded after later sessions", async () => {
    let fail = true;
    const t = await readyAdapter({ consumer: () => { if (fail) throw new Error("first"); } });
    const token = t.adapter.beginSession().token;
    const r = await frame(t, token, 1);
    fail = false;
    await assertLaterSessionWorks(t, token);
    assert.equal(t.adapter.sessionFailure(token), r.failure);
    assert.deepEqual(plain(snap(t).failedSessions).map((f) => [f.sessionToken, f.reason]), [[token, FAILURE.CONSUMER_ERROR]]);
  });
});

describe("result copy fails: result withheld, session ended, engine kept (fake engine)", () => {
  test("the consumer is not called with results: null; the session ends and later sessions work", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    const hostile = { get poseLandmarks() { throw new Error("detached"); } };
    assert.doesNotThrow(() => t.eng.emit(hostile));
    t.eng.last().resolve();
    const r = await p;
    assertSessionFailed(t, r, token, FAILURE.RESULT_COPY_FAILED);
    assert.equal(r.failure.message, "detached");
    assert.equal(t.consumed.length, 0, "withheld: the consumer never saw it");
    const c = snap(t).adapter;
    assert.equal(c.snapshotErrors, 1);
    assert.equal(c.resultsWithheld, 1);
    assert.equal(c.consumerCalls, 0);
    assert.equal(c.callbacksHandled, snap(t).lifecycle.counters.callbacksObserved, "the callback was still counted");
    await assertLaterSessionWorks(t, token);
    assert.equal(t.consumed.length, 3);
  });

  test("a copy failure on a result that is not eligible changes nothing beyond the core's own outcome", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.emit({ get poseLandmarks() { throw new Error("detached"); } });
    t.adapter.beginSession(); // the result is now stale
    t.eng.last().resolve();
    const r = await p;
    assert.equal(r.outcome.state, STATE.DISCARDED_STALE);
    assert.equal(r.failure, null);
    assert.equal(t.adapter.sessionFailure(token), null);
    assert.equal(snap(t).adapter.sessionsFailed, 0);
  });

  test("a copy failure is not an integrity latch: duplicate callbacks still latch as INT-1 says", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.emit({ get poseLandmarks() { throw new Error("detached"); } });
    t.eng.emit(LM(1));
    t.eng.last().resolve();
    const r = await p;
    assert.equal(r.outcome.state, STATE.FAILED_CLOSED);
    assert.equal(r.failure, null);
    assert.equal(snap(t).lifecycle.latch.reason, LATCH.MULTIPLE_CALLBACKS_FOR_SEND);
  });
});

describe("timestamps: dispatch time and callback-arrival time both carried (fake engine)", () => {
  test("each consumed frame carries the caller's dispatch time and the arrival time read at the callback", async () => {
    let clock = 10;
    const t = await readyAdapter({ readArrivalTime: () => clock });
    const token = t.adapter.beginSession().token;
    for (let i = 1; i <= 3; i++) {
      const p = t.adapter.sendFrame(token, `f${i}`, { dispatchTime: i * 0.04, i });
      clock = 10 + i;       // arrival is read when the callback arrives...
      t.eng.emit(LM(i));
      clock = 99;           // ...not when the send settles
      t.eng.last().resolve();
      assert.equal((await p).failure, null);
    }
    assert.deepEqual(t.consumed.map((c) => plain(c.timing)), [
      { dispatchTime: 0.04, arrivalTime: 11 },
      { dispatchTime: 0.08, arrivalTime: 12 },
      { dispatchTime: 0.12, arrivalTime: 13 },
    ]);
    assert.deepEqual(t.consumed.map((c) => c.meta.i), [1, 2, 3], "the caller's meta is passed through unchanged");
  });

  test("without a hook or a dispatch time, both are null", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    await frame(t, token, 1, undefined);
    assert.deepEqual(plain(t.consumed[0].timing), { dispatchTime: null, arrivalTime: null });
  });

  test("an arrival-time hook that throws never escapes the callback; the result is withheld and the session ends", async () => {
    let throwNow = false;
    const t = await readyAdapter({ readArrivalTime: () => { if (throwNow) throw new Error("no video"); return 1; } });
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A", { dispatchTime: 0.5 });
    throwNow = true;
    assert.doesNotThrow(() => t.eng.emit(LM(1)));
    throwNow = false;
    t.eng.last().resolve();
    const r = await p;
    assertSessionFailed(t, r, token, FAILURE.ARRIVAL_TIME_FAILED);
    assert.equal(t.consumed.length, 0);
    assert.equal(snap(t).adapter.arrivalTimeErrors, 1);
    await assertLaterSessionWorks(t, token);
  });

  test("readArrivalTime must be a function when given", () => {
    assert.throws(() => m.createAdapter({ createEngine: () => fakeEngine(), readArrivalTime: 3 }), /readArrivalTime/);
  });
});

describe("bookkeeping (fake engine)", () => {
  test("every forwarded send is a lifecycle request; every refusal was not forwarded; snapshots are copies", async () => {
    const t = await readyAdapter();
    const token = t.adapter.beginSession().token;
    await frame(t, token, 1);
    const open = t.adapter.sendFrame(token, "B");
    await t.adapter.sendFrame(token, "C");
    t.eng.emit(LM(2)); t.eng.last().resolve(); await open;
    const s = plain(snap(t));
    assert.equal(s.adapter.sendsForwarded, t.eng.sends.length);
    assert.equal(s.adapter.sendsForwarded, s.lifecycle.counters.requestsOpened);
    assert.equal(s.adapter.sendsNotForwarded, 1);
    assert.equal(s.adapter.callbacksHandled, s.lifecycle.counters.callbacksObserved);
    const copy = snap(t);
    copy.adapter.sendsForwarded = 999;
    assert.equal(snap(t).adapter.sendsForwarded, s.adapter.sendsForwarded);
  });
});

describe("optional integrity-latch notification (fake engine)", () => {
  // Lets every pending microtask (and the notification's own catch) run.
  const flush = () => new Promise((r) => setImmediate(r));

  // Records each notification and whether it ran inside the engine's
  // results callback. emit() is wrapped so "inside" is observable.
  async function latchHarness({ notify, ready = true } = {}) {
    const calls = [];
    const box = { inCallback: false };
    let t = null;
    const opts = {
      onIntegrityLatch: (latch) => {
        calls.push({ latch, inCallback: box.inCallback, lifecycleLatch: t.adapter.snapshot().lifecycle.latch });
        if (notify) return notify(latch);
      },
    };
    t = ready ? await readyAdapter(opts) : newAdapter(opts);
    const emit = t.eng.emit;
    t.eng.emit = (results) => {
      box.inCallback = true;
      try { return emit(results); } finally { box.inCallback = false; }
    };
    return { t, calls };
  }

  function assertOneNotification(t, calls, reason) {
    assert.equal(calls.length, 1, "exactly one notification");
    assert.equal(calls[0].inCallback, false, "never inside the engine callback");
    assert.equal(calls[0].latch.reason, reason);
    assert.deepEqual(plain(calls[0].latch), plain(snap(t).lifecycle.latch), "receives the core's latch record");
    assert.ok(Object.isFrozen(calls[0].latch));
    assert.notEqual(calls[0].lifecycleLatch, null, "the core had already latched when it ran");
    assert.equal(snap(t).adapter.latchNotificationsScheduled, 1);
    assert.equal(snap(t).adapter.latchNotificationErrors, 0);
  }

  test("unsolicited callback (no open send): deferred, fires once, never inside the callback", async () => {
    const { t, calls } = await latchHarness();
    t.eng.emit(LM(1));
    assert.equal(calls.length, 0, "not called synchronously from the callback");
    assert.equal(snap(t).lifecycle.latch.reason, LATCH.CALLBACK_WITHOUT_OPEN_SEND);
    await flush();
    assertOneNotification(t, calls, LATCH.CALLBACK_WITHOUT_OPEN_SEND);
    t.eng.emit(LM(2)); // further anomalies after the latch
    t.eng.emit(LM(3));
    const begun = t.adapter.beginSession();
    await flush();
    assert.equal(calls.length, 1, "no second notification for the same lifecycle latch");
    assert.equal(begun.accepted, false);
  });

  test("extra callback in one window (latched at the callback): fires once", async () => {
    const { t, calls } = await latchHarness();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.emit(LM(1));
    t.eng.emit(LM(2));
    assert.equal(calls.length, 0);
    t.eng.last().resolve();
    const r = await p;
    assert.equal(r.outcome.state, STATE.FAILED_CLOSED);
    await flush();
    assertOneNotification(t, calls, LATCH.MULTIPLE_CALLBACKS_FOR_SEND);
    assert.equal(t.consumed.length, 0);
  });

  test("resolved send without a callback (latch discovered at settlement): fires once", async () => {
    const { t, calls } = await latchHarness();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.last().resolve();
    const r = await p;
    assert.equal(r.outcome.latchReason, LATCH.RESOLVED_WITHOUT_CALLBACK);
    await flush();
    assertOneNotification(t, calls, LATCH.RESOLVED_WITHOUT_CALLBACK);
    t.eng.emit(LM(1)); // the late result: still no second notification
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(snap(t).lifecycle.latch.reason, LATCH.RESOLVED_WITHOUT_CALLBACK);
  });

  test("callback for a rejected send (latch discovered at settlement): fires once", async () => {
    const { t, calls } = await latchHarness();
    const token = t.adapter.beginSession().token;
    const p = t.adapter.sendFrame(token, "A");
    t.eng.emit(LM(1));
    t.eng.last().reject(new Error("boom"));
    const r = await p;
    assert.equal(r.outcome.latchReason, LATCH.CALLBACK_FOR_REJECTED_SEND);
    await flush();
    assertOneNotification(t, calls, LATCH.CALLBACK_FOR_REJECTED_SEND);
  });

  test("warm-up resolved without a callback (latched at settlement): fires once", async () => {
    const { t, calls } = await latchHarness({ ready: false });
    const w = t.adapter.warmUp("synthetic-grey");
    t.eng.last().resolve();
    assert.equal((await w).outcome.latchReason, LATCH.RESOLVED_WITHOUT_CALLBACK);
    await flush();
    assertOneNotification(t, calls, LATCH.RESOLVED_WITHOUT_CALLBACK);
  });

  test("WARMUP_FAILED is not a latch: no notification", async () => {
    const { t, calls } = await latchHarness({ ready: false });
    const w = t.adapter.warmUp("synthetic-grey");
    t.eng.last().reject(new Error("assets failed"));
    const out = await w;
    assert.equal(out.outcome.state, STATE.REJECTED_WITHOUT_RESULT);
    assert.equal(snap(t).lifecycle.engine, ENGINE.WARMUP_FAILED);
    assert.equal((await t.adapter.warmUp("again")).refusal, REFUSAL.WARMUP_FAILED);
    assert.equal(t.adapter.beginSession().accepted, false);
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(snap(t).lifecycle.latch, null);
    assert.equal(snap(t).adapter.latchNotificationsScheduled, 0);
  });

  test("no notification for clean frames, refusals, stale results or rejected sends without a callback", async () => {
    const { t, calls } = await latchHarness();
    const token = t.adapter.beginSession().token;
    await frame(t, token, 1);
    const open = t.adapter.sendFrame(token, "B");
    assert.equal((await t.adapter.sendFrame(token, "C")).refusal, REFUSAL.REQUEST_OPEN);
    t.adapter.endSession(token);
    t.eng.emit(LM(2)); t.eng.last().resolve();
    assert.equal((await open).outcome.state, STATE.DISCARDED_STALE);
    const p = t.adapter.sendFrame(t.adapter.beginSession().token, "D");
    t.eng.last().reject(new Error("no result"));
    assert.equal((await p).outcome.state, STATE.REJECTED_WITHOUT_RESULT);
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(snap(t).lifecycle.latch, null);
  });

  test("no notification for a session failure (consumer error is not a latch)", async () => {
    const calls = [];
    const t = await readyAdapter({
      consumer: () => { throw new Error("consumer failed"); },
      onIntegrityLatch: (l) => calls.push(l),
    });
    const token = t.adapter.beginSession().token;
    const r = await frame(t, token, 1);
    assert.equal(r.failure.reason, FAILURE.CONSUMER_ERROR);
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(snap(t).lifecycle.latch, null);
  });

  for (const [label, notify] of [
    ["throws synchronously", () => { throw new Error("page handler failed"); }],
    ["returns a rejected promise", () => Promise.reject(new Error("async page handler failed"))],
  ]) {
    test(`a notification that ${label} is contained: latch unchanged, later observations intact, no unhandled rejection`, async () => {
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const { t, calls } = await latchHarness({ notify });
        const token = t.adapter.beginSession().token;
        const p = t.adapter.sendFrame(token, "A");
        t.eng.last().resolve();
        await p;
        await flush();
        assert.equal(calls.length, 1);
        assert.equal(snap(t).adapter.latchNotificationErrors, 1);
        const before = plain(snap(t).lifecycle);
        assert.equal(before.latch.reason, LATCH.RESOLVED_WITHOUT_CALLBACK);
        assert.equal(before.engine, ENGINE.LATCHED);
        // Later observations: callbacks still counted, sends still refused.
        t.eng.emit(LM(1));
        const refused = await t.adapter.sendFrame(token, "B");
        await flush();
        const after = plain(snap(t).lifecycle);
        assert.deepEqual(after.latch, before.latch, "latch record unchanged");
        assert.equal(after.engine, ENGINE.LATCHED);
        assert.equal(after.counters.callbacksObserved, before.counters.callbacksObserved + 1);
        assert.equal(refused.refusal, REFUSAL.LATCHED);
        assert.equal(calls.length, 1);
        assert.equal(snap(t).adapter.latchNotificationErrors, 1);
        await new Promise((r) => setTimeout(r, 10));
        assert.deepEqual(unhandled, []);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }

  test("without onIntegrityLatch the latch is unchanged and nothing is scheduled; a non-function is refused", async () => {
    const t = await readyAdapter();
    t.eng.emit(LM(1));
    await flush();
    assert.equal(snap(t).lifecycle.latch.reason, LATCH.CALLBACK_WITHOUT_OPEN_SEND);
    assert.equal(snap(t).adapter.latchNotificationsScheduled, 0);
    assert.throws(() => m.createAdapter({ createEngine: () => fakeEngine(), onIntegrityLatch: "x" }), /onIntegrityLatch/);
  });
});
