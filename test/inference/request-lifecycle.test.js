// Unit, property and INT-1 equivalence tests for the pure inference
// request lifecycle (src/inference/request-lifecycle.js). The Chase page
// uses it through src/inference/pose-adapter.js (Race does not); these
// tests drive the core directly, without the adapter or a page.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { LIFECYCLE_SOURCE, loadLifecycle, loadInt1, readyLifecycle, prng, plain } from "./load-lifecycle.js";

const m = loadLifecycle();
const { ENGINE, SESSION, KIND, STATE, LATCH, REFUSAL } = m;

// Opens a FRAME request in a fresh active session on a ready lifecycle.
function frameInFlight(meta = { mediaTimeMs: 40 }) {
  const life = readyLifecycle(m);
  const token = life.beginSession().token;
  const d = life.dispatchFrame(token, meta);
  assert.equal(d.accepted, true);
  return { life, token, request: d.request };
}

describe("module boundary", () => {
  test("loads in an empty context and references no browser API, clock, timer, randomness or MediaPipe", () => {
    const code = LIFECYCLE_SOURCE.replace(/\/\/.*$/gm, "");
    for (const name of ["window", "document", "navigator", "performance", "Date", "setTimeout", "setInterval",
      "requestAnimationFrame", "requestVideoFrameCallback", "Math.random", "Pose", "mediapipe", "location", "localStorage", "fetch"]) {
      assert.equal(new RegExp(`\\b${name.replace(".", "\\.")}\\b`).test(code), false, `unexpected reference to ${name}`);
    }
    assert.equal(typeof m.create, "function");
  });

  test("each lifecycle is independent", () => {
    const a = readyLifecycle(m);
    const b = m.create();
    a.beginSession();
    assert.equal(b.snapshot().engine, ENGINE.CREATED);
    assert.equal(b.snapshot().session, null);
  });
});

describe("engine readiness: the dedicated warm-up request", () => {
  test("starts CREATED; frames are refused until the warm-up completes", () => {
    const life = m.create();
    const token = life.beginSession().token;
    assert.equal(life.snapshot().engine, ENGINE.CREATED);
    assert.equal(life.dispatchFrame(token).reason, REFUSAL.NOT_READY);
    const w = life.beginWarmup({ synthetic: "grey" });
    assert.equal(w.accepted, true);
    assert.equal(w.request.kind, KIND.WARMUP);
    assert.equal(w.request.sessionToken, null);
    assert.equal(life.snapshot().engine, ENGINE.WARMING);
    assert.equal(life.dispatchFrame(token).reason, REFUSAL.REQUEST_OPEN, "warm-up holds the single request lock");
  });

  test("warm-up resolved with exactly one callback makes the engine READY; its result is never eligible", () => {
    const life = m.create();
    const w = life.beginWarmup();
    assert.equal(life.recordCallback("warm").action, "HELD");
    const out = life.settle(w.request.requestId, "resolved");
    assert.equal(out.state, STATE.WARMUP_COMPLETE);
    assert.equal(out.payload, null, "warm-up results are discarded by kind");
    assert.equal(life.snapshot().engine, ENGINE.READY);
    assert.equal(life.beginWarmup().reason, REFUSAL.ALREADY_WARMED);
    assert.equal(life.snapshot().counters.resultsEligible, 0);
  });

  test("warm-up is refused while a request is open or when latched", () => {
    const life = m.create();
    life.beginWarmup();
    assert.equal(life.beginWarmup().reason, REFUSAL.REQUEST_OPEN);
    const t = m.create();
    t.recordCallback("stray");
    assert.equal(t.beginWarmup().reason, REFUSAL.LATCHED);
  });

  // Callback anomalies during the warm-up use the same detection and codes
  // as frame requests. This is the core's own choice (INT-1 has no warm-up).
  for (const [label, callbacks, result, latch] of [
    ["resolves without a callback", 0, "resolved", LATCH.RESOLVED_WITHOUT_CALLBACK],
    ["gets two callbacks", 2, "resolved", LATCH.MULTIPLE_CALLBACKS_FOR_SEND],
    ["is rejected with a callback", 1, "rejected", LATCH.CALLBACK_FOR_REJECTED_SEND],
  ]) {
    test(`a warm-up callback anomaly (${label}) is an integrity latch: LATCHED (${latch}), reload required`, () => {
      const life = m.create();
      const w = life.beginWarmup();
      for (let i = 0; i < callbacks; i++) life.recordCallback(`cb${i}`);
      const out = life.settle(w.request.requestId, result);
      assert.equal(out.state, STATE.FAILED_CLOSED);
      const snap = life.snapshot();
      assert.equal(snap.engine, ENGINE.LATCHED);
      assert.equal(snap.requiresReload, true);
      assert.equal(snap.latch.reason, latch);
      assert.equal(snap.latch.kind, KIND.WARMUP);
      assert.equal(snap.warmupFailure, null, "an integrity latch is not a warm-up failure");
      assert.equal(life.beginSession().reason, REFUSAL.LATCHED);
      assert.equal(life.beginWarmup().reason, REFUSAL.LATCHED);
    });
  }
});

describe("WARMUP_FAILED: a rejected warm-up (core readiness state, not an INT-1 latch)", () => {
  // A warm-up send rejected with no callback.
  function failedWarmup() {
    const life = m.create();
    const w = life.beginWarmup({ synthetic: "grey" });
    const out = life.settle(w.request.requestId, "rejected");
    return { life, w, out };
  }

  test("a rejected warm-up prevents every frame dispatch until reload", () => {
    const { life } = failedWarmup();
    // A session cannot even be started, so try both ways a frame could be
    // dispatched: with a session begun before the failure and without one.
    const before = m.create();
    const token = before.beginSession().token;
    const w = before.beginWarmup();
    before.settle(w.request.requestId, "rejected");
    for (const [l, t] of [[before, token], [life, null], [life, 1]]) {
      assert.equal(l.canDispatchFrame(t), false);
      for (let i = 0; i < 5; i++) {
        const d = l.dispatchFrame(t, { attempt: i });
        assert.equal(d.accepted, false);
        assert.equal(d.reason, REFUSAL.WARMUP_FAILED);
        assert.equal(d.request, null);
      }
      assert.equal(l.hasOpenRequest(), false);
      assert.equal(l.snapshot().counters.requestsOpened, 1, "only the warm-up was ever opened");
    }
    assert.equal(before.snapshot().session.state, SESSION.ACTIVE, "the earlier session stays, but cannot dispatch");
  });

  test("the warm-up request ends REJECTED_WITHOUT_RESULT with no latch reason; the engine is WARMUP_FAILED", () => {
    const { life, w, out } = failedWarmup();
    assert.equal(out.requestId, w.request.requestId);
    assert.equal(out.kind, KIND.WARMUP);
    assert.equal(out.state, STATE.REJECTED_WITHOUT_RESULT);
    assert.equal(out.reason, "WARMUP_REJECTED");
    assert.equal(out.latchReason, null);
    assert.equal(out.payload, null);
    const snap = life.snapshot();
    assert.equal(snap.engine, ENGINE.WARMUP_FAILED);
    assert.equal(snap.requiresReload, true);
    assert.deepEqual(plain(snap.warmupFailure), { reason: "WARMUP_REJECTED", requestId: w.request.requestId });
    assert.equal(snap.counters.warmupsFailed, 1);
    assert.equal(snap.counters.sendsRejectedWithoutResult, 1);
  });

  test("it is distinct from an INT-1 latch: no latch, no latch code, latches counter unchanged", () => {
    const { life } = failedWarmup();
    const snap = life.snapshot();
    assert.notEqual(snap.engine, ENGINE.LATCHED);
    assert.equal(snap.latch, null);
    assert.equal(snap.counters.latches, 0);
    assert.equal(Object.values(LATCH).includes("WARMUP_REJECTED"), false);
    assert.equal(Object.values(LATCH).includes(ENGINE.WARMUP_FAILED), false);
    // And the refusals name the state, not LATCHED.
    assert.equal(life.beginSession().reason, REFUSAL.WARMUP_FAILED);
    assert.equal(life.beginWarmup().reason, REFUSAL.WARMUP_FAILED);
    assert.notEqual(REFUSAL.WARMUP_FAILED, REFUSAL.LATCHED);
    const counters = life.snapshot().counters;
    assert.equal(counters.sessionsRefused, 1);
    assert.equal(counters.sessionsBegun, 0);
  });

  test("the latch codes are exactly INT-1's violation codes", () => {
    const { V } = loadInt1();
    assert.deepEqual(Object.values(LATCH).sort(), Object.values(V).sort());
  });

  test("an integrity anomaly after a warm-up failure still latches; both facts are kept", () => {
    const { life, w } = failedWarmup();
    const r = life.recordCallback("stray-after-rejection");
    assert.equal(r.action, "DROPPED");
    assert.equal(r.latchReason, LATCH.CALLBACK_WITHOUT_OPEN_SEND);
    const snap = life.snapshot();
    assert.equal(snap.engine, ENGINE.LATCHED, "a detected anomaly takes precedence");
    assert.equal(snap.latch.reason, LATCH.CALLBACK_WITHOUT_OPEN_SEND);
    assert.deepEqual(plain(snap.warmupFailure), { reason: "WARMUP_REJECTED", requestId: w.request.requestId });
    assert.equal(snap.requiresReload, true);
    assert.equal(life.dispatchFrame(null).reason, REFUSAL.LATCHED);
  });

  test("a frame send rejected without a callback does NOT fail the engine (contrast)", () => {
    const { life, token, request } = frameInFlight();
    life.settle(request.requestId, "rejected");
    const snap = life.snapshot();
    assert.equal(snap.engine, ENGINE.READY);
    assert.equal(snap.warmupFailure, null);
    assert.equal(snap.requiresReload, false);
    assert.equal(life.canDispatchFrame(token), true);
  });

  test("a new lifecycle (page reload) starts CREATED and can warm up", () => {
    failedWarmup();
    const life = m.create();
    assert.equal(life.snapshot().engine, ENGINE.CREATED);
    assert.equal(life.beginWarmup().accepted, true);
  });
});

describe("sessions", () => {
  test("beginSession retires the previous session; tokens increase", () => {
    const life = readyLifecycle(m);
    const a = life.beginSession().token;
    const b = life.beginSession().token;
    assert.ok(b > a);
    assert.deepEqual(plain(life.snapshot().session), { token: b, state: SESSION.ACTIVE, endReason: null });
    assert.equal(life.dispatchFrame(a).reason, REFUSAL.NO_ACTIVE_SESSION);
    assert.equal(life.endSession(a, "stop"), false, "a retired token cannot end the current session");
    assert.equal(life.snapshot().session.state, SESSION.ACTIVE);
  });

  test("endSession ends only the current active session, once", () => {
    const life = readyLifecycle(m);
    const t = life.beginSession().token;
    assert.equal(life.endSession(t, "new-video"), true);
    assert.equal(life.endSession(t, "again"), false);
    assert.deepEqual(plain(life.snapshot().session), { token: t, state: SESSION.ENDED, endReason: "new-video" });
    assert.equal(life.dispatchFrame(t).reason, REFUSAL.NO_ACTIVE_SESSION);
  });

  test("a session may begin while a request is open (core session rule); no frame is dispatched until that request settles", () => {
    const { life, request } = frameInFlight();
    const next = life.beginSession();
    assert.equal(next.accepted, true);
    assert.equal(life.hasOpenRequest(), true);
    assert.equal(life.dispatchFrame(next.token).reason, REFUSAL.REQUEST_OPEN);
    life.recordCallback("old");
    assert.equal(life.settle(request.requestId, "resolved").state, STATE.DISCARDED_STALE);
    assert.equal(life.dispatchFrame(next.token).accepted, true);
  });
});

describe("single open request, released only on settle", () => {
  test("a second dispatch is refused while a request is open, for any session", () => {
    const { life, token } = frameInFlight();
    assert.equal(life.dispatchFrame(token).reason, REFUSAL.REQUEST_OPEN);
    assert.equal(life.canDispatchFrame(token), false);
    const other = life.beginSession().token;
    assert.equal(life.dispatchFrame(other).reason, REFUSAL.REQUEST_OPEN);
    assert.equal(life.snapshot().counters.dispatchesRefused, 2);
    assert.equal(life.snapshot().counters.requestsOpened, 2, "warm-up + one frame");
  });

  test("a request that never settles keeps the lock: no number of attempts, sessions or callbacks releases it", () => {
    const { life, token, request } = frameInFlight();
    for (let i = 0; i < 1000; i++) assert.equal(life.dispatchFrame(token).accepted, false);
    life.endSession(token, "stop");
    const t2 = life.beginSession().token;
    assert.equal(life.dispatchFrame(t2).accepted, false);
    const snap = life.snapshot();
    assert.equal(snap.openRequest.requestId, request.requestId);
    assert.equal(snap.engine, ENGINE.READY);
    assert.equal(snap.requiresReload, false, "a hung request is not a detected anomaly");
    assert.equal(typeof life.release, "undefined");
    assert.equal(typeof life.timeout, "undefined");
  });

  test("settling releases the lock", () => {
    const { life, token, request } = frameInFlight();
    life.recordCallback("A");
    life.settle(request.requestId, "resolved");
    assert.equal(life.canDispatchFrame(token), true);
  });
});

describe("eligibility: settled, exactly one callback, session still active", () => {
  test("eligible result carries the dispatch-time record and the held payload", () => {
    const meta = { mediaTimeMs: 120, isFrameAccurate: true };
    const { life, token, request } = frameInFlight(meta);
    assert.equal(life.recordCallback("landmarks-A").action, "HELD");
    const out = life.settle(request.requestId, "resolved");
    assert.equal(out.state, STATE.ELIGIBLE);
    assert.equal(out.payload, "landmarks-A");
    assert.equal(out.meta, meta);
    assert.equal(out.sessionToken, token);
    assert.equal(out.requestId, request.requestId);
    assert.equal(life.snapshot().counters.resultsEligible, 1);
  });

  test("nothing is eligible before settlement: the callback is only held", () => {
    const { life } = frameInFlight();
    assert.equal(life.recordCallback("A").action, "HELD");
    assert.equal(life.snapshot().counters.resultsEligible, 0);
  });

  for (const [label, act] of [
    ["ended", (life, token) => life.endSession(token, "stop")],
    ["replaced", (life) => life.beginSession()],
  ]) {
    test(`a single-callback result for a session that ${label} is DISCARDED_STALE, not a latch`, () => {
      const { life, token, request } = frameInFlight();
      life.recordCallback("A");
      act(life, token);
      const out = life.settle(request.requestId, "resolved");
      assert.equal(out.state, STATE.DISCARDED_STALE);
      assert.equal(out.payload, null);
      assert.equal(life.snapshot().latch, null);
      assert.equal(life.snapshot().counters.resultsDiscardedStale, 1);
    });
  }

  test("a frame is refused without an active session", () => {
    const life = readyLifecycle(m);
    assert.equal(life.dispatchFrame(undefined).reason, REFUSAL.NO_ACTIVE_SESSION);
    assert.equal(life.dispatchFrame(1).reason, REFUSAL.NO_ACTIVE_SESSION);
  });
});

describe("frame-request integrity anomalies (INT-1 rules and codes) fail closed and require reload", () => {
  const latched = (life, reason) => {
    const snap = life.snapshot();
    assert.equal(snap.engine, ENGINE.LATCHED);
    assert.equal(snap.requiresReload, true);
    assert.equal(snap.latch.reason, reason);
    assert.equal(life.beginSession().reason, REFUSAL.LATCHED);
    assert.equal(life.beginWarmup().reason, REFUSAL.LATCHED);
  };

  test("missing: a send that resolves with no callback", () => {
    const { life, token, request } = frameInFlight();
    const out = life.settle(request.requestId, "resolved");
    assert.equal(out.state, STATE.FAILED_CLOSED);
    assert.equal(out.latchReason, LATCH.RESOLVED_WITHOUT_CALLBACK);
    latched(life, LATCH.RESOLVED_WITHOUT_CALLBACK);
    assert.equal(life.dispatchFrame(token).reason, REFUSAL.LATCHED);
  });

  test("duplicate: two callbacks in one window, both dropped at the second, latched at once", () => {
    const { life, request } = frameInFlight();
    life.recordCallback("first");
    const second = life.recordCallback("second");
    assert.equal(second.action, "DROPPED");
    assert.equal(second.latchReason, LATCH.MULTIPLE_CALLBACKS_FOR_SEND);
    latched(life, LATCH.MULTIPLE_CALLBACKS_FOR_SEND);
    const out = life.settle(request.requestId, "resolved");
    assert.equal(out.state, STATE.FAILED_CLOSED);
    assert.equal(out.payload, null);
    assert.equal(life.snapshot().counters.callbacksDropped, 2);
    assert.equal(life.snapshot().counters.latches, 1);
  });

  test("unsolicited: a callback with no open request", () => {
    const life = readyLifecycle(m);
    const r = life.recordCallback("stray");
    assert.equal(r.action, "DROPPED");
    latched(life, LATCH.CALLBACK_WITHOUT_OPEN_SEND);
  });

  test("rejected-send callback: a callback inside a rejected send's window", () => {
    const { life, request } = frameInFlight();
    life.recordCallback("A");
    const out = life.settle(request.requestId, "rejected");
    assert.equal(out.latchReason, LATCH.CALLBACK_FOR_REJECTED_SEND);
    assert.equal(out.payload, null);
    latched(life, LATCH.CALLBACK_FOR_REJECTED_SEND);
  });

  test("a rejected frame send without a callback is not a violation (INT-1)", () => {
    const { life, token, request } = frameInFlight();
    const out = life.settle(request.requestId, "rejected");
    assert.equal(out.state, STATE.REJECTED_WITHOUT_RESULT);
    assert.equal(life.snapshot().latch, null);
    assert.equal(life.canDispatchFrame(token), true);
  });

  test("settling a request that is not the open one latches WINDOW_MISMATCH and leaves the open request open", () => {
    const { life, request } = frameInFlight();
    const out = life.settle(request.requestId + 99, "resolved");
    assert.equal(out.latchReason, LATCH.WINDOW_MISMATCH);
    assert.equal(life.snapshot().openRequest.requestId, request.requestId);
    latched(life, LATCH.WINDOW_MISMATCH);
  });

  test("settling the same request twice latches WINDOW_MISMATCH; the first outcome stands", () => {
    const { life, request } = frameInFlight();
    life.recordCallback("A");
    assert.equal(life.settle(request.requestId, "resolved").state, STATE.ELIGIBLE);
    assert.equal(life.settle(request.requestId, "resolved").latchReason, LATCH.WINDOW_MISMATCH);
    assert.equal(life.snapshot().counters.resultsEligible, 1);
  });

  test("an unknown settle outcome never becomes eligible", () => {
    const { life, request } = frameInFlight();
    life.recordCallback("A");
    const out = life.settle(request.requestId, "weird");
    assert.equal(out.state, STATE.FAILED_CLOSED);
    assert.equal(out.latchReason, LATCH.WINDOW_MISMATCH);
  });

  test("after a latch, a clean-looking open request still settles but is never eligible", () => {
    const { life, request } = frameInFlight();
    life.recordCallback("A");
    // Open a mismatch latch while the request stays open.
    life.settle(request.requestId + 1, "resolved");
    const out = life.settle(request.requestId, "resolved");
    assert.equal(out.state, STATE.FAILED_CLOSED);
    assert.equal(out.reason, "INTEGRITY_LATCHED");
    assert.equal(out.payload, null);
    assert.equal(life.snapshot().latch.reason, LATCH.WINDOW_MISMATCH, "the first latch reason is kept");
  });

  test("documented limit: a foreign callback alone in a window IS eligible (no request identity)", () => {
    const { life, request } = frameInFlight();
    life.recordCallback("duplicate-of-previous-frame");
    assert.equal(life.settle(request.requestId, "resolved").state, STATE.ELIGIBLE);
    life.recordCallback("own-result-late");
    assert.equal(life.snapshot().latch.reason, LATCH.CALLBACK_WITHOUT_OPEN_SEND);
    assert.match(life.snapshot().identity, /not established/);
  });
});

describe("immutability", () => {
  test("request records and outcomes are frozen; snapshots are copies", () => {
    const { life, request } = frameInFlight({ mediaTimeMs: 1 });
    assert.ok(Object.isFrozen(request));
    life.recordCallback("A");
    const out = life.settle(request.requestId, "resolved");
    assert.ok(Object.isFrozen(out));
    const snap = life.snapshot();
    snap.counters.resultsEligible = 999;
    snap.engine = "HACKED";
    assert.equal(life.snapshot().counters.resultsEligible, 1);
    assert.equal(life.snapshot().engine, ENGINE.READY);
  });
});

// Next random operation, deterministic by seed. Mostly protocol-shaped
// (dispatch, one callback, settle), with low-rate anomalies, so sequences
// reach eligible, stale and rejected outcomes before any latch.
function nextOp(rand, snap) {
  const r = rand();
  const open = snap.openRequest;
  if (open === null) {
    if (r < 0.70) return ["dispatch"];
    if (r < 0.80) return ["start"];
    if (r < 0.86) return ["end"];
    if (r < 0.875) return ["callback"];       // unsolicited
    if (r < 0.88) return ["settleWrong"];
    return ["noop"];
  }
  if (open.callbacks === 0) {
    if (r < 0.78) return ["callback"];
    if (r < 0.82) return ["settle", "resolved"]; // missing callback
    if (r < 0.88) return ["settle", "rejected"];
    if (r < 0.92) return ["start"];
    if (r < 0.96) return ["end"];
    return ["dispatch"];                      // refused
  }
  if (r < 0.76) return ["settle", "resolved"];
  if (r < 0.79) return ["settle", "rejected"];  // callback for rejected send
  if (r < 0.82) return ["callback"];            // duplicate
  if (r < 0.89) return ["start"];
  if (r < 0.95) return ["end"];
  if (r < 0.99) return ["dispatch"];            // refused
  return ["settleWrong"];
}

// Tallies what the generated sequences reached, so the tests can assert
// they exercised every outcome (not just early latches).
function tally(map, key) { map[key] = (map[key] || 0) + 1; }

describe("properties over random sequences (500 seeds x 200 operations)", () => {
  test("invariants hold", () => {
    const reached = {};
    for (let seed = 1; seed <= 500; seed++) {
      const rand = prng(seed);
      const life = readyLifecycle(m);
      let token = null;
      let openId = null;
      let everLatched = false;
      const outcomes = new Map();
      for (let step = 0; step < 200; step++) {
        const before = life.snapshot();
        const [op, arg] = nextOp(rand, before);
        if (op === "start") { const s = life.beginSession(); if (s.accepted) token = s.token; }
        else if (op === "end") life.endSession(token, "end");
        else if (op === "dispatch") {
          const d = life.dispatchFrame(token, { seed });
          // I1: never a second open request.
          if (before.openRequest !== null) assert.equal(d.accepted, false, `seed ${seed}: dispatch accepted while a request was open`);
          if (d.accepted) openId = d.request.requestId;
        } else if (op === "callback") life.recordCallback({ seed });
        else if (op === "settle" && openId !== null) {
          const sessionWasCurrent = before.session && before.session.state === SESSION.ACTIVE && before.openRequest && before.session.token === before.openRequest.sessionToken;
          const out = life.settle(openId, arg);
          // I4: one outcome per request.
          assert.equal(outcomes.has(openId), false, `seed ${seed}: second outcome for ${openId}`);
          outcomes.set(openId, out.state);
          tally(reached, out.state);
          // Eligibility needs: resolved, exactly one callback, no latch, current active session.
          if (out.state === STATE.ELIGIBLE) {
            assert.equal(arg, "resolved");
            assert.equal(before.openRequest.callbacks, 1);
            assert.equal(before.latch, null);
            assert.ok(sessionWasCurrent, `seed ${seed}: eligible for a non-current session`);
          }
          openId = null;
        } else if (op === "settleWrong") life.settle(-1, "resolved");
        const after = life.snapshot();
        // Latches are permanent and block everything.
        if (everLatched) {
          assert.equal(after.engine, ENGINE.LATCHED);
          assert.equal(life.canDispatchFrame(token), false);
        }
        everLatched = everLatched || after.latch !== null;
        // I10: every opened request is terminal or the single open one (warm-up included).
        const c = after.counters;
        assert.equal(c.requestsOpened, 1 + outcomes.size + (after.openRequest ? 1 : 0), `seed ${seed}: counters do not reconcile`);
      }
      tally(reached, `latch:${life.snapshot().latch ? life.snapshot().latch.reason : "none"}`);
    }
    // The sequences must actually reach every outcome and every frame latch.
    // (Long unlatched runs are covered by the Stage 3.2 replay fixtures.)
    for (const key of [STATE.ELIGIBLE, STATE.DISCARDED_STALE, STATE.REJECTED_WITHOUT_RESULT, STATE.FAILED_CLOSED,
      `latch:${LATCH.CALLBACK_WITHOUT_OPEN_SEND}`, `latch:${LATCH.MULTIPLE_CALLBACKS_FOR_SEND}`,
      `latch:${LATCH.RESOLVED_WITHOUT_CALLBACK}`, `latch:${LATCH.CALLBACK_FOR_REJECTED_SEND}`, `latch:${LATCH.WINDOW_MISMATCH}`]) {
      assert.ok(reached[key] > 0, `random sequences never reached ${key}: ${JSON.stringify(reached)}`);
    }
    assert.ok(reached[STATE.ELIGIBLE] > 1000, `too few eligible outcomes: ${JSON.stringify(reached)}`);
  });
});

describe("equivalence with merged INT-1: frame-request decisions only", () => {
  // Same frame operations through INT-1's state machine
  // (src/chase-engine/inference-integrity.js) and through the lifecycle,
  // which is warmed up first because INT-1 has no warm-up. Dispatches are
  // only attempted with an active session, because INT-1 leaves that check
  // to the page.
  //
  // COMPARED, per step: dispatch accepted/refused, callback action and
  // violation code, settle commit/discard and violation code, the payload,
  // whether a request is open, the latch code, and the eligible/stale/
  // dropped/violation counters.
  //
  // NOT COMPARED, because INT-1 does not define them: the warm-up and its
  // outcomes, engine readiness, WARMUP_FAILED, session begin/end and its
  // refusals, refusal reasons, and request states other than eligible.
  // Matching here says nothing about INT-1 requiring the core's behaviour
  // in those areas.
  const int1 = loadInt1();
  const decision = {
    COMMIT: STATE.ELIGIBLE,
  };

  test("frame dispatch, callback and settle decisions match on 500 random sequences", () => {
    let commits = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const rand = prng(10_000 + seed);
      const life = readyLifecycle(m);
      const s = int1.create();
      let token = null;
      let active = false;
      let openReq = null;
      let openWin = null;
      for (let step = 0; step < 200; step++) {
        const [op, arg] = nextOp(rand, life.snapshot());
        const at = `seed ${seed}, step ${step}, op ${op}`;
        if (op === "start") {
          // Session handling is the core's, not INT-1's; not compared.
          const r = life.beginSession();
          if (r.accepted) { token = r.token; active = true; }
        } else if (op === "end") {
          life.endSession(token, "end");
          active = false;
        } else if (op === "dispatch") {
          if (!active) continue;
          const d = life.dispatchFrame(token, { seed });
          const w = int1.open(s, { generation: token, pendingTiming: { seed } });
          assert.equal(d.accepted, w !== null, at);
          if (d.accepted) { openReq = d.request.requestId; openWin = w; }
        } else if (op === "callback") {
          const a = life.recordCallback(seed);
          const b = int1.callback(s, seed);
          assert.equal(a.action, b.action, at);
          assert.equal(a.latchReason, b.violation, at);
        } else if (op === "settle" && openReq !== null) {
          const a = life.settle(openReq, arg);
          const b = int1.close(s, openWin, { outcome: arg, currentGeneration: token, sessionActive: active });
          assert.equal(a.state === STATE.ELIGIBLE, b.action === "COMMIT", at);
          if (b.action === "COMMIT") { assert.equal(a.state, decision.COMMIT, at); commits++; }
          assert.equal(a.latchReason, b.violation, at);
          assert.equal(a.payload, b.payload, at);
          openReq = null; openWin = null;
        } else if (op === "settleWrong") {
          const a = life.settle(-1, "resolved");
          const b = int1.close(s, { id: -1 }, { outcome: "resolved", currentGeneration: token, sessionActive: active });
          assert.equal(a.latchReason, b.violation, at);
        }
        const snap = life.snapshot();
        assert.equal(snap.latch ? snap.latch.reason : null, s.latched ? s.latched.violation : null, at);
        assert.equal(snap.openRequest !== null, s.open !== null, at);
        assert.equal(snap.counters.resultsEligible, s.counters.resultsCommitted, at);
        assert.equal(snap.counters.resultsDiscardedStale, s.counters.resultsDiscardedStale, at);
        assert.equal(snap.counters.callbacksDropped, s.counters.callbacksDropped, at);
        assert.equal(snap.counters.latches, s.counters.violations, at);
      }
    }
    assert.ok(commits > 1000, `equivalence sequences committed too rarely (${commits})`);
  });
});
