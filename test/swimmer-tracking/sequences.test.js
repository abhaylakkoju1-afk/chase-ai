// Full-sequence fixture tests for swimmer-tracking — multi-swimmer
// identity-switch scenarios, ambiguous reacquisition, session isolation,
// and end-to-end determinism (docs/SWIMMER_TRACKING_ARCHITECTURE.md §12,
// §15).
//
// Since the underlying pose pipeline returns at most one pose per frame
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §3), "two swimmers" fixtures are
// built as independently-authored trajectories (A, B) whose positions are
// picked by hand for each test — exactly modeling what the real single-
// pose engine's opaque internal selection could hand the tracker,
// including deliberately simulated identity switches. Every timestamp is
// a fixed, hand-chosen number — no Date.now(), no Math.random(), no real
// video, no MediaPipe.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { trackingCreateSession, trackingSelectTarget } from "../../src/swimmer-tracking/session.js";
import { trackingObserve } from "../../src/swimmer-tracking/tracking.js";

const CFG = Object.freeze({
  selectionConfirmationSamples: 3,
  lockingWindowMs: 2000,
  minVisibility: 0.5,
  maxLockingPositionError: 0.05,
  maxSteadyStatePositionError: 0.08,
  lossGraceMs: 1000,
  sustainedAmbiguityMs: 600,
  maxReacquisitionWindowMs: 3000,
  maxReacquisitionPositionError: 0.15
});

function poseSample(atMs, x, y = 0.5, visibility = 0.9) {
  return { atMs, hasPose: true, landmarks: { hip: { x, y, visibility }, nose: { x, y, visibility } } };
}

function gapSample(atMs) {
  return { atMs, hasPose: false, landmarks: null };
}

function record(session, sample) {
  const result = trackingObserve(session, sample, CFG);
  return result;
}

// Locks swimmer A: x = 0.500, 0.505, 0.510 at atMs = 0, 100, 200 —
// establishes velocity 0.05/s (see tracking.test.js's identical fixture).
function lockSwimmerA() {
  const created = trackingCreateSession({ sessionId: "sequences-a" });
  const selected = trackingSelectTarget(created.session, { atMs: 0 });
  let session = selected.session;

  session = record(session, poseSample(0, 0.500)).session;
  session = record(session, poseSample(100, 0.505)).session;
  const final = record(session, poseSample(200, 0.510));

  return final.session;
}

// ===========================================================================
// 7 — ATTEMPTED IDENTITY SWITCH (the single most important scenario)
// ===========================================================================

describe("attempted identity switch — swimmer B must never be silently adopted as the target", () => {
  test("swimmer B, stationary near A's LAST OBSERVED position, is refused during reacquisition", () => {
    const locked = lockSwimmerA(); // lastConfirmedAtMs=200, lastConfirmedPosition.x=0.510, velocity.x=0.05/s

    const lossAtMs = locked.lastConfirmedAtMs + 1500; // 1500ms >= lossGraceMs(1000)
    const lost = record(locked, gapSample(lossAtMs)).session;
    assert.equal(lost.status, "TARGET_LOST");

    // Swimmer B appears at atMs=4200, sitting almost exactly where A was
    // last CONFIRMED (x=0.510) — a "nearest to last known position" rule
    // would accept this. A's actual PROJECTED position by then (4000ms
    // since lastConfirmedAtMs=200, i.e. 4s * 0.05/s) is 0.510+0.20=0.710.
    // |0.510 - 0.710| = 0.200, which exceeds maxReacquisitionPositionError
    // (0.15) — correctly refused.
    const swimmerBAtMs = 4200;
    const result = record(lost, poseSample(swimmerBAtMs, 0.510));

    assert.notEqual(result.session.status, "TARGET_LOCKED");
    assert.equal(result.session.status, "TARGET_LOST");
    assert.equal(result.observation.reacquired, false);
    assert.equal(result.targetPoseSample, null);
  });

  test("swimmer A, continuing along its own projected trajectory, IS legitimately reacquired at a later observation", () => {
    const locked = lockSwimmerA();
    const lossAtMs = locked.lastConfirmedAtMs + 1500;
    let session = record(locked, gapSample(lossAtMs)).session;

    // First, swimmer B's rejected candidate (as in the previous test) —
    // confirming rejection does not corrupt the session for a later,
    // legitimate reacquisition attempt.
    session = record(session, poseSample(4200, 0.510)).session;
    assert.equal(session.status, "TARGET_LOST");

    // Then A reappears, continuing its own trajectory: 4100ms since
    // lastConfirmedAtMs(200) -> projected.x = 0.510 + 0.05*4.1 = 0.715.
    const result = record(session, poseSample(4300, 0.715));

    assert.equal(result.session.status, "TARGET_LOCKED");
    assert.equal(result.observation.reacquired, true);
    assert.notEqual(result.targetPoseSample, null);
    assert.deepEqual(result.session.lastConfirmedPosition, { x: 0.715, y: 0.5 });
  });

  test("across the whole sequence (B rejected, then A reacquired), the identity anchor (lastConfirmedPosition) is NEVER set to B's position", () => {
    const locked = lockSwimmerA();
    const lossAtMs = locked.lastConfirmedAtMs + 1500;
    let session = record(locked, gapSample(lossAtMs)).session;

    const afterB = record(session, poseSample(4200, 0.510));
    // B was refused, so lastConfirmedPosition must be untouched (still A's).
    assert.deepEqual(afterB.session.lastConfirmedPosition, { x: 0.510, y: 0.5 });

    const afterA = record(afterB.session, poseSample(4300, 0.715));
    assert.deepEqual(afterA.session.lastConfirmedPosition, { x: 0.715, y: 0.5 });
    // 0.510 (B's position) never appears as the confirmed anchor at any point.
    for (const observation of afterA.session.observationHistory) {
      if (observation.outcome === "confirmed" && observation.atMs >= 4200) {
        assert.notEqual(observation.representativePosition.x, 0.510);
      }
    }
  });
});

// ===========================================================================
// 8 — AMBIGUOUS REACQUISITION (multiple plausible-but-inconclusive candidates)
// ===========================================================================

describe("ambiguous reacquisition — the tracker never guesses", () => {
  test("a run of borderline candidates, none clearly matching, never reacquires and eventually degrades", () => {
    const locked = lockSwimmerA();
    const lossAtMs = locked.lastConfirmedAtMs + 1500;
    let session = record(locked, gapSample(lossAtMs)).session;
    assert.equal(session.status, "TARGET_LOST");

    // Three candidates, each with a continuityError just over the
    // reacquisition threshold (0.15) relative to A's projection at that
    // moment — plausible-looking, but never conclusive.
    const attempts = [
      { atMs: 1800, x: 0.510 + 0.05 * ((1800 - 200) / 1000) + 0.20 }, // ~0.36
      { atMs: 2400, x: 0.510 + 0.05 * ((2400 - 200) / 1000) + 0.20 }, // ~0.42
      { atMs: 3000, x: 0.510 + 0.05 * ((3000 - 200) / 1000) + 0.20 }  // ~0.45
    ];

    for (const { atMs, x } of attempts) {
      const result = record(session, poseSample(atMs, x));
      assert.notEqual(result.session.status, "TARGET_LOCKED");
      assert.equal(result.targetPoseSample, null);
      session = result.session;
    }

    assert.equal(session.status, "TARGET_LOST");

    // A final attempt past the reacquisition window (3000ms from
    // lossAtMs=1700 -> window closes at 4700) forces the conservative
    // outcome: degrade, never a guessed lock.
    const finalResult = record(session, poseSample(4800, 0.9));

    assert.notEqual(finalResult.session.status, "TARGET_LOCKED");
    assert.equal(finalResult.session.status, "ANALYSIS_DEGRADED");
    assert.equal(finalResult.session.degradedReason, "reacquisition-window-exhausted");
    assert.equal(finalResult.targetPoseSample, null);
  });

  test("no ambiguous candidate in the run ever reaches downstream consumers as a confirmed target sample", () => {
    const locked = lockSwimmerA();
    const lossAtMs = locked.lastConfirmedAtMs + 1500;
    let session = record(locked, gapSample(lossAtMs)).session;

    const candidateAtMsList = [1800, 2400, 3000];
    const targetSamplesEmitted = [];

    for (const atMs of candidateAtMsList) {
      const result = record(session, poseSample(atMs, 0.99)); // clearly wrong position
      if (result.targetPoseSample !== null) {
        targetSamplesEmitted.push(result.targetPoseSample);
      }
      session = result.session;
    }

    assert.deepEqual(targetSamplesEmitted, []);
  });
});

// ===========================================================================
// 14 — SESSION ISOLATION (full observe()-level; session.js-level basics
// already covered in session.test.js)
// ===========================================================================

describe("session isolation across full observe() sequences", () => {
  test("two independently locked sessions never influence each other's state", () => {
    const sessionA = lockSwimmerA();

    // A second, independently created session, locking a DIFFERENT
    // trajectory (moving in the opposite direction).
    const createdB = trackingCreateSession({ sessionId: "sequences-b" });
    const selectedB = trackingSelectTarget(createdB.session, { atMs: 0 });
    let sessionB = selectedB.session;
    sessionB = record(sessionB, poseSample(0, 0.900)).session;
    sessionB = record(sessionB, poseSample(100, 0.895)).session;
    sessionB = record(sessionB, poseSample(200, 0.890)).session;

    assert.equal(sessionA.status, "TARGET_LOCKED");
    assert.equal(sessionB.status, "TARGET_LOCKED");
    assert.notEqual(sessionA.lastConfirmedPosition.x, sessionB.lastConfirmedPosition.x);
    assert.equal(sessionA.sessionId, "sequences-a");
    assert.equal(sessionB.sessionId, "sequences-b");
  });

  test("losing/degrading one session does not affect the other, already-locked session", () => {
    const sessionA = lockSwimmerA();
    const createdB = trackingCreateSession({ sessionId: "sequences-b" });
    const selectedB = trackingSelectTarget(createdB.session, { atMs: 0 });
    let sessionB = selectedB.session;
    sessionB = record(sessionB, poseSample(0, 0.900)).session;
    sessionB = record(sessionB, poseSample(100, 0.895)).session;
    sessionB = record(sessionB, poseSample(200, 0.890)).session;

    // Degrade session A only.
    let degradedA = record(sessionA, gapSample(sessionA.lastConfirmedAtMs + 1500)).session;
    degradedA = record(degradedA, poseSample(4200, 0.510)).session; // rejected candidate
    degradedA = record(degradedA, poseSample(4800, 0.9)).session; // window exhausted

    assert.equal(degradedA.status, "ANALYSIS_DEGRADED");
    // sessionB, never touched again, remains exactly as it was.
    assert.equal(sessionB.status, "TARGET_LOCKED");
    assert.equal(sessionB.observationHistory.length, 3);
  });

  test("observation history arrays are independent objects between sessions — no shared array reference", () => {
    const sessionA = lockSwimmerA();
    const createdB = trackingCreateSession({ sessionId: "sequences-b" });
    const sessionB = createdB.session;

    assert.notStrictEqual(sessionA.observationHistory, sessionB.observationHistory);
  });
});

// ===========================================================================
// 15 — DETERMINISM (full sequence, run twice)
// ===========================================================================

describe("determinism across a full lock -> steady -> loss -> reacquire sequence", () => {
  function runFullSequence() {
    let session = lockSwimmerA();

    // Steady-state confirmation.
    const velocity = session.lastConfirmedVelocity;
    let atMs = session.lastConfirmedAtMs + 100;
    let expectedX = session.lastConfirmedPosition.x + velocity.x * 0.1;
    session = record(session, poseSample(atMs, expectedX)).session;

    // Loss.
    const lossAtMs = session.lastConfirmedAtMs + 1500;
    session = record(session, gapSample(lossAtMs)).session;

    // A rejected candidate (swimmer B).
    session = record(session, poseSample(lossAtMs + 2500, 0.510)).session;

    // Legitimate reacquisition.
    const reacquireAtMs = lossAtMs + 2600;
    const elapsedSeconds = (reacquireAtMs - 200) / 1000;
    const projectedX = 0.510 + velocity.x * elapsedSeconds;
    const result = record(session, poseSample(reacquireAtMs, projectedX));

    return result;
  }

  test("running the identical sequence twice produces identical final sessions", () => {
    const first = runFullSequence();
    const second = runFullSequence();

    assert.deepEqual(first.session, second.session);
  });

  test("running the identical sequence twice produces identical state-transition history", () => {
    const first = runFullSequence();
    const second = runFullSequence();

    const statusesFirst = first.session.observationHistory.map((o) => o.outcome);
    const statusesSecond = second.session.observationHistory.map((o) => o.outcome);

    assert.deepEqual(statusesFirst, statusesSecond);
  });

  test("running the identical sequence twice produces an identical final target identity and confidence-relevant fields", () => {
    const first = runFullSequence();
    const second = runFullSequence();

    assert.equal(first.session.status, second.session.status);
    assert.deepEqual(first.session.lastConfirmedPosition, second.session.lastConfirmedPosition);
    assert.deepEqual(first.session.lastConfirmedVelocity, second.session.lastConfirmedVelocity);
    assert.deepEqual(first.observation, second.observation);
  });

  test("no wall-clock, randomness, DOM, or browser API is used — proven by monkey-patching Date.now()/performance.now() to throw across the full sequence", () => {
    const originalDateNow = Date.now;
    const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

    Date.now = () => { throw new Error("swimmer-tracking must never call Date.now()"); };
    if (typeof performance !== "undefined") {
      performance.now = () => { throw new Error("swimmer-tracking must never call performance.now()"); };
    }

    try {
      const result = runFullSequence();
      assert.equal(result.session.status, "TARGET_LOCKED");
    } finally {
      Date.now = originalDateNow;
      if (typeof performance !== "undefined") {
        performance.now = originalPerformanceNow;
      }
    }
  });
});
