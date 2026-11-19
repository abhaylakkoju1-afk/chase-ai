// Fixture-replay tests: Stage 3.2 lifecycle validation runs, reduced to
// lifecycle operations (test/fixtures/inference-lifecycle/, produced by
// convert-stage3-2-ledgers.mjs from the recorded ledgers), replayed
// through the pure request lifecycle.
//
// What the replay shows: for the event ORDER each real run recorded
// (handlers, sends, callbacks, settlements on the real pinned engine),
// which requests the lifecycle would have accepted or refused, and which
// results would have been eligible, stale or failed closed. What it does
// not show: what the real engine would have done had a refused send not
// been made. Page runs are therefore cut at the first settlement after an
// overlapping send (see each fixture's `truncated`), and anything after
// that point in a test below is labelled synthetic.
//
// Page ledgers come from the committed pages, which issue no warm-up
// request; their replays start from an already-ready lifecycle
// (`engineReadyBeforeReplay`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadLifecycle, readyLifecycle } from "./load-lifecycle.js";

const m = loadLifecycle();
const { ENGINE, SESSION, STATE, LATCH, REFUSAL } = m;
const DIR = join(ROOT, "test", "fixtures", "inference-lifecycle");

function fixture(name) {
  return JSON.parse(readFileSync(join(DIR, `stage3-2-${name}.json`), "utf8"));
}

// Replays one fixture. Returns, per phase (document), the lifecycle, every
// decision, and the outcomes, plus checks that hold for every replay.
function replay(fx) {
  const phases = [];
  for (const ops of fx.phases) {
    const life = fx.engineReadyBeforeReplay ? readyLifecycle(m) : m.create();
    const toRequest = new Map();     // ledger send id -> lifecycle request id
    const refused = new Map();       // ledger send id -> refusal reason
    const outcomes = [];
    const sessions = [];             // tokens in order
    let token = null;
    for (const op of ops) {
      const [kind, id, result] = op;
      if (kind === "start") {
        const r = life.beginSession();
        sessions.push(r.accepted ? r.token : `refused:${r.reason}`);
        if (r.accepted) token = r.token;
      } else if (kind === "newVideo" || kind === "ended") {
        life.endSession(token, kind);
      } else if (kind === "warmup") {
        const r = life.beginWarmup({ ledgerSend: id });
        if (r.accepted) toRequest.set(id, r.request.requestId); else refused.set(id, r.reason);
      } else if (kind === "dispatch") {
        const r = life.dispatchFrame(token, { ledgerSend: id });
        if (r.accepted) toRequest.set(id, r.request.requestId); else refused.set(id, r.reason);
      } else if (kind === "callback") {
        life.recordCallback({ ledgerCallback: true });
      } else if (kind === "settle") {
        // A send the lifecycle refused was never made: its recorded
        // settlement does not apply.
        if (!toRequest.has(id)) continue;
        outcomes.push({ ledgerSend: id, ...life.settle(toRequest.get(id), result) });
      } else if (kind === "reload") {
        // The document ends here; the next phase is a new lifecycle.
      } else {
        throw new Error(`unknown fixture operation ${kind}`);
      }
    }
    // Every replay: every opened request is terminal or the single open one.
    const snap = life.snapshot();
    const warmups = fx.engineReadyBeforeReplay ? 1 : 0;
    assert.equal(snap.counters.requestsOpened, warmups + outcomes.length + (snap.openRequest ? 1 : 0), `${fx.name}: counters do not reconcile`);
    // An eligible result always belongs to a session that was current when it settled.
    for (const o of outcomes.filter((x) => x.state === STATE.ELIGIBLE)) assert.ok(sessions.includes(o.sessionToken));
    phases.push({ life, snap, outcomes, refused, sessions, toRequest });
  }
  return phases;
}

const states = (outcomes) => outcomes.map((o) => o.state);
const count = (outcomes, state) => outcomes.filter((o) => o.state === state).length;

describe("fixtures are intact", () => {
  test("every fixture names its source ledger, its sha256 and Stage 3.2", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 21);
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      assert.equal(fx.source.stage, "3.2", f);
      assert.match(fx.source.sha256, /^[0-9a-f]{64}$/, f);
      assert.match(fx.source.ledger, /\.ndjson$/, f);
      assert.ok(Array.isArray(fx.phases) && fx.phases.length >= 1, f);
    }
  });
});

describe("Stage 3.2 §5 new video, no new session (C1, C3): the old result is discarded", () => {
  for (const name of ["c1-chase", "c1-race", "c3-chase", "c3-race"]) {
    test(name, () => {
      const [p] = replay(fixture(name));
      // The page observed: old request resolved, callback discarded.
      assert.deepEqual(states(p.outcomes), [STATE.DISCARDED_STALE]);
      assert.equal(p.snap.latch, null);
      assert.equal(p.snap.openRequest, null);
      assert.equal(p.snap.session.state, SESSION.ENDED);
      assert.equal(p.snap.session.endReason, "newVideo");
    });
  }
});

describe("Stage 3.2 §5 new video after the request settled (C2): nothing to discard", () => {
  for (const name of ["c2-chase", "c2-race"]) {
    test(name, () => {
      const [p] = replay(fixture(name));
      assert.equal(p.outcomes.length, 8);
      assert.equal(count(p.outcomes, STATE.ELIGIBLE), 8);
      assert.equal(p.refused.size, 0);
      assert.equal(p.snap.latch, null);
      assert.equal(p.snap.session.state, SESSION.ENDED);
    });
  }
});

describe("Stage 3.2 §5 new video then new session after settle (C5): two clean sessions", () => {
  for (const name of ["c5-chase", "c5-race"]) {
    test(name, () => {
      const fx = fixture(name);
      const [p] = replay(fx);
      const dispatched = fx.phases[0].filter((o) => o[0] === "dispatch").length;
      assert.equal(p.refused.size, 0, "no send was refused: every send in the run was sequential");
      assert.equal(count(p.outcomes, STATE.ELIGIBLE), dispatched, "every result eligible");
      const [first, second] = p.sessions;
      assert.ok(p.outcomes.some((o) => o.sessionToken === first));
      assert.ok(p.outcomes.some((o) => o.sessionToken === second));
      // Results never cross sessions: every result of the first session settles before the second begins.
      const lastFirst = Math.max(...p.outcomes.filter((o) => o.sessionToken === first).map((o) => o.requestId));
      const firstSecond = Math.min(...p.outcomes.filter((o) => o.sessionToken === second).map((o) => o.requestId));
      assert.ok(lastFirst < firstSecond);
      assert.equal(p.snap.latch, null);
      assert.equal(p.snap.session.endReason, "ended");
    });
  }
});

// C4, C6, and the E late-overlap runs: the page sent a second request
// while the first was open. The lifecycle refuses that send, so the old
// request stays the only open one, owned by the retired session.
function assertOverlapRefused(name, { callbackHeld }) {
  const fx = fixture(name);
  assert.ok(fx.truncated, `${name} should be cut after the overlap`);
  const [p] = replay(fx);
  const { life, snap, refused, sessions } = p;
  const [oldToken, newToken] = sessions;
  assert.equal(refused.size, 1);
  assert.equal([...refused.values()][0], REFUSAL.REQUEST_OPEN);
  assert.equal(snap.openRequest.sessionToken, oldToken, "the open request belongs to the retired session");
  assert.deepEqual({ token: snap.session.token, state: snap.session.state }, { token: newToken, state: SESSION.ACTIVE });
  assert.equal(snap.openRequest.callbacks, callbackHeld ? 1 : 0);
  assert.equal(snap.counters.resultsEligible, 0, "nothing reached the new session");
  assert.equal(snap.latch, null);

  // Synthetic continuation (not recorded): the old request settles.
  if (!callbackHeld) life.recordCallback({ synthetic: true });
  const out = life.settle(snap.openRequest.requestId, "resolved");
  assert.equal(out.state, STATE.DISCARDED_STALE, "the old result never reaches the new session");
  assert.equal(life.dispatchFrame(newToken).accepted, true, "the new session dispatches once the lock is released");
}

describe("Stage 3.2 §5 new video then new session while a request is open (C4, C6): second send refused", () => {
  test("c4-chase", () => assertOverlapRefused("c4-chase", { callbackHeld: false }));
  test("c4-race", () => assertOverlapRefused("c4-race", { callbackHeld: false }));
  // C6: the page consumed the one callback in the NEW session (report §5.2).
  // Here it is held for the old request and discarded.
  test("c6-chase", () => assertOverlapRefused("c6-chase", { callbackHeld: true }));
  test("c6-race", () => assertOverlapRefused("c6-race", { callbackHeld: true }));
});

describe("Stage 3.2 §7 late overlap: a second Start/Analyze during the open first request", () => {
  // Default network, Race: the page's second dispatch overlapped (report: 1/4).
  test("e0-race-overlap", () => assertOverlapRefused("e0-race-overlap", { callbackHeld: true }));
  // 3 s model-fetch hold: both pages overlapped (report: 12/12).
  test("e1-chase", () => assertOverlapRefused("e1-chase", { callbackHeld: true }));
  test("e1-race", () => assertOverlapRefused("e1-race", { callbackHeld: true }));

  test("e0-chase: the second Analyze ran while the request was open but the page's dispatch waited; the old result is stale", () => {
    const fx = fixture("e0-chase");
    const [p] = replay(fx);
    assert.equal(fx.truncated, null);
    assert.equal(p.refused.size, 0);
    assert.equal(p.outcomes[0].state, STATE.DISCARDED_STALE, "first send's result belongs to the replaced session");
    assert.equal(p.outcomes[0].sessionToken, p.sessions[0]);
    assert.ok(p.outcomes.slice(1).every((o) => o.state === STATE.ELIGIBLE && o.sessionToken === p.sessions[1]));
    assert.equal(p.snap.latch, null);
  });
});

describe("Stage 3.2 §4 reload after a graph-fetch failure", () => {
  // A rejected warm-up is the core's WARMUP_FAILED readiness state, not an
  // INT-1 integrity latch: no latch, no latch code, fail-closed until reload.
  const assertWarmupFailedNotLatched = (snap) => {
    assert.equal(snap.engine, ENGINE.WARMUP_FAILED);
    assert.equal(snap.latch, null);
    assert.equal(snap.counters.latches, 0);
    assert.equal(snap.warmupFailure.reason, "WARMUP_REJECTED");
    assert.equal(snap.requiresReload, true);
  };

  test("reload-fault-init: warm-up rejected -> WARMUP_FAILED (no latch); after reload, warm-up with one callback, then 3 eligible frames", () => {
    const [p0, p1] = replay(fixture("reload-fault-init"));
    assert.deepEqual(states(p0.outcomes), [STATE.REJECTED_WITHOUT_RESULT]);
    assert.equal(p0.outcomes[0].latchReason, null);
    assertWarmupFailedNotLatched(p0.snap);
    // SYNTHETIC (not in the recorded ledger, which reloads right away):
    // frame dispatch attempts on the failed document are refused.
    assert.equal(p0.life.beginSession().reason, REFUSAL.WARMUP_FAILED);
    for (const token of [null, 1]) assert.equal(p0.life.dispatchFrame(token, { synthetic: true }).reason, REFUSAL.WARMUP_FAILED);
    assert.equal(p0.life.snapshot().counters.requestsOpened, 1);
    assert.deepEqual(states(p1.outcomes), [STATE.WARMUP_COMPLETE, STATE.ELIGIBLE, STATE.ELIGIBLE, STATE.ELIGIBLE]);
    assert.equal(p1.snap.engine, ENGINE.READY);
    assert.equal(p1.snap.latch, null);
    assert.equal(p1.snap.warmupFailure, null);
  });

  test("reload-fault-send: warm-up rejected -> WARMUP_FAILED; the recorded session and frame send are refused; after reload, clean", () => {
    const [p0, p1] = replay(fixture("reload-fault-send"));
    assert.deepEqual(states(p0.outcomes), [STATE.REJECTED_WITHOUT_RESULT], "the refused frame send was never made");
    assertWarmupFailedNotLatched(p0.snap);
    assert.deepEqual(p0.sessions, [`refused:${REFUSAL.WARMUP_FAILED}`]);
    assert.equal(p0.refused.size, 1);
    assert.equal([...p0.refused.values()][0], REFUSAL.WARMUP_FAILED);
    assert.equal(p0.snap.counters.requestsOpened, 1, "no frame request was opened");
    assert.deepEqual(states(p1.outcomes), [STATE.WARMUP_COMPLETE, STATE.ELIGIBLE, STATE.ELIGIBLE, STATE.ELIGIBLE]);
    assert.equal(p1.snap.warmupFailure, null);
  });

  test("reload-control: clean warm-up and 2 frames, reload, clean warm-up and 3 frames", () => {
    const [p0, p1] = replay(fixture("reload-control"));
    assert.deepEqual(states(p0.outcomes), [STATE.WARMUP_COMPLETE, STATE.ELIGIBLE, STATE.ELIGIBLE]);
    assert.deepEqual(states(p1.outcomes), [STATE.WARMUP_COMPLETE, STATE.ELIGIBLE, STATE.ELIGIBLE, STATE.ELIGIBLE]);
    assert.equal(p0.snap.latch, null);
    assert.equal(p1.snap.latch, null);
  });
});

describe("Stage 3.2 §6 warm-up readiness (Chrome 157, Edge 157)", () => {
  for (const name of ["warmup-chrome", "warmup-edge"]) {
    test(`${name}: warm-up settles with exactly one callback, engine READY, every later frame eligible`, () => {
      const [p] = replay(fixture(name));
      assert.equal(p.outcomes[0].state, STATE.WARMUP_COMPLETE);
      assert.equal(p.outcomes[0].payload, null);
      assert.ok(p.outcomes.slice(1).length >= 3);
      assert.ok(p.outcomes.slice(1).every((o) => o.state === STATE.ELIGIBLE));
      assert.equal(p.snap.engine, ENGINE.READY);
    });
  }
});
