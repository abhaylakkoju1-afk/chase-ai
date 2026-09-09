// Unit tests for src/swimmer-tracking/tracking.js — trackingObserve():
// locking (docs/SWIMMER_TRACKING_ARCHITECTURE.md §10), steady-state
// continuity (§11), loss and reacquisition (§12), and the
// confirmed-target-only output invariant (§13).
//
// Multi-swimmer identity-switch fixtures, session isolation, and
// full-sequence determinism live in sequences.test.js — this file covers
// single-session mechanics.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { trackingCreateSession, trackingSelectTarget } from "../../src/swimmer-tracking/session.js";
import { trackingObserve } from "../../src/swimmer-tracking/tracking.js";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
//
// An explicit config, passed to every observe() call, rather than relying
// on tracking.js's internal DEFAULT_CONFIG values — this decouples the
// tests from whatever the implementation's current defaults happen to
// be, and keeps every threshold self-documenting at the point of use.
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

// hip and nose share the same x/y here so the representative-position
// centroid (computeRepresentativePosition() averages the two) equals
// exactly (x, y) with no offset — keeps every assertion below in this
// file arithmetically direct.
function poseSample(atMs, x, y = 0.5, visibility = 0.9) {
  return { atMs, hasPose: true, landmarks: { hip: { x, y, visibility }, nose: { x, y, visibility } } };
}

function gapSample(atMs) {
  return { atMs, hasPose: false, landmarks: null };
}

function newSelectedSession(atMs = 0) {
  const created = trackingCreateSession({ sessionId: "tracking-test" });
  assert.equal(created.ok, true);
  const selected = trackingSelectTarget(created.session, { atMs });
  assert.equal(selected.ok, true);
  return selected.session;
}

// Locks a target using three tight, consistent observations
// (x = 0.500, 0.505, 0.510 at atMs = 0, 100, 200 — drift of 0.005 per
// step, comfortably under maxLockingPositionError). Returns the locked
// session plus the exact lastConfirmedPosition/Velocity it establishes,
// so later tests can build deterministic follow-on fixtures from it.
function lockTarget() {
  let session = newSelectedSession(0);
  let result;

  result = trackingObserve(session, poseSample(0, 0.500), CFG);
  assert.equal(result.session.status, "TARGET_LOCKING");
  session = result.session;

  result = trackingObserve(session, poseSample(100, 0.505), CFG);
  assert.equal(result.session.status, "TARGET_LOCKING");
  session = result.session;

  result = trackingObserve(session, poseSample(200, 0.510), CFG);
  assert.equal(result.session.status, "TARGET_LOCKED");
  session = result.session;

  return { session, lockResult: result };
}

// ===========================================================================
// 3 / 9 — LOCK ACQUISITION (success and TARGET_LOCKING -> UNSELECTED failure)
// ===========================================================================

describe("lock acquisition — UNSELECTED -> TARGET_SELECTED -> TARGET_LOCKING -> TARGET_LOCKED", () => {
  test("three consistent, visible observations establish a lock", () => {
    const { session, lockResult } = lockTarget();

    assert.equal(session.status, "TARGET_LOCKED");
    assert.equal(session.lockEstablishedAtMs, 200);
    assert.deepEqual(session.lastConfirmedPosition, { x: 0.510, y: 0.5 });
    assert.notEqual(session.lastConfirmedVelocity, null);
    assert.equal(lockResult.targetPoseSample.atMs, 200);
  });

  test("no targetPoseSample is emitted for any observation before the lock is established", () => {
    let session = newSelectedSession(0);

    let result = trackingObserve(session, poseSample(0, 0.500), CFG);
    assert.equal(result.targetPoseSample, null);
    session = result.session;

    result = trackingObserve(session, poseSample(100, 0.505), CFG);
    assert.equal(result.targetPoseSample, null);
  });

  test("a locking attempt that never accumulates enough evidence within lockingWindowMs fails back to UNSELECTED (§8.2's explicit refinement)", () => {
    let session = newSelectedSession(0);

    // The locking window starts at the FIRST OBSERVATION's atMs (this is
    // when locking evidence actually begins accumulating), not at the
    // selection's atMs — so the first observe() call here (atMs=0) is
    // what seeds the window.
    let result = trackingObserve(session, gapSample(0), CFG);
    assert.equal(result.session.status, "TARGET_LOCKING");
    session = result.session;

    result = trackingObserve(session, gapSample(1000), CFG);
    assert.equal(result.session.status, "TARGET_LOCKING");
    session = result.session;

    // 2100ms since the window started at atMs=0 — exceeds lockingWindowMs (2000).
    result = trackingObserve(session, gapSample(2100), CFG);

    assert.equal(result.session.status, "UNSELECTED");
    assert.equal(result.session.selection, null);
    assert.equal(result.targetPoseSample, null);
  });

  test("the session never falsely reports TARGET_LOCKED when a locking attempt fails", () => {
    let session = newSelectedSession(0);
    const statusesSeen = [session.status];

    for (const atMs of [0, 1000, 1500, 2100]) {
      const result = trackingObserve(session, gapSample(atMs), CFG);
      statusesSeen.push(result.session.status);
      session = result.session;
    }

    assert.ok(!statusesSeen.includes("TARGET_LOCKED"));
    assert.equal(session.status, "UNSELECTED");
  });

  test("determinism: locking the same fixture twice from scratch produces identical results", () => {
    const first = lockTarget();
    const second = lockTarget();
    assert.deepEqual(first.session, second.session);
  });
});

// ===========================================================================
// 4 — STABLE LOCKED TRACKING
// ===========================================================================

describe("stable locked tracking", () => {
  test("a target moving consistently along its established velocity remains locked and confirmed", () => {
    let { session } = lockTarget();
    const velocity = session.lastConfirmedVelocity;

    let atMs = 200;
    for (let i = 0; i < 4; i++) {
      atMs += 100;
      const elapsedSeconds = (atMs - session.lastConfirmedAtMs) / 1000;
      const expectedX = session.lastConfirmedPosition.x + velocity.x * elapsedSeconds;

      const result = trackingObserve(session, poseSample(atMs, expectedX), CFG);

      assert.equal(result.ok, true);
      assert.equal(result.session.status, "TARGET_LOCKED");
      assert.equal(result.observation.outcome, "confirmed");
      assert.notEqual(result.targetPoseSample, null);
      assert.equal(result.targetPoseSample.atMs, atMs);

      session = result.session;
    }

    assert.equal(session.status, "TARGET_LOCKED");
  });

  test("projected position is computed from the established trajectory, exposed on the observation", () => {
    const { session } = lockTarget();
    const velocity = session.lastConfirmedVelocity;
    const atMs = session.lastConfirmedAtMs + 200;
    const expectedX = session.lastConfirmedPosition.x + velocity.x * 0.2;

    const result = trackingObserve(session, poseSample(atMs, expectedX), CFG);

    assert.notEqual(result.observation.projectedPosition, null);
    assert.equal(Math.round(result.observation.projectedPosition.x * 1000) / 1000, Math.round(expectedX * 1000) / 1000);
  });

  test("observations remain associated with the same session's target throughout (no target field ever changes identity)", () => {
    let { session } = lockTarget();
    const sessionId = session.sessionId;

    for (let i = 0; i < 3; i++) {
      const atMs = session.lastConfirmedAtMs + 100;
      const result = trackingObserve(session, poseSample(atMs, session.lastConfirmedPosition.x), CFG);
      session = result.session;
      assert.equal(session.sessionId, sessionId);
    }
  });
});

// ===========================================================================
// 5 — TEMPORARY POSE LOSS
// ===========================================================================

describe("temporary pose loss", () => {
  test("a brief gap within lossGraceMs does not change status and does not emit a confirmed target sample", () => {
    const { session } = lockTarget();

    const result = trackingObserve(session, gapSample(session.lastConfirmedAtMs + 400), CFG); // 400ms < lossGraceMs (1000)

    assert.equal(result.session.status, "TARGET_LOCKED");
    assert.equal(result.observation.outcome, "gap");
    assert.equal(result.targetPoseSample, null);
  });

  test("tracking recovers seamlessly after a brief gap, without ever leaving TARGET_LOCKED", () => {
    let { session } = lockTarget();
    const velocity = session.lastConfirmedVelocity;
    const lastConfirmedBeforeGap = session.lastConfirmedAtMs;

    let result = trackingObserve(session, gapSample(lastConfirmedBeforeGap + 400), CFG);
    assert.equal(result.session.status, "TARGET_LOCKED");
    session = result.session;

    // lastConfirmedPosition/Velocity are untouched by the gap, so the
    // projection still originates from the pre-gap confirmed sample.
    const atMs = lastConfirmedBeforeGap + 500;
    const elapsedSeconds = (atMs - session.lastConfirmedAtMs) / 1000;
    const expectedX = session.lastConfirmedPosition.x + velocity.x * elapsedSeconds;

    result = trackingObserve(session, poseSample(atMs, expectedX), CFG);

    assert.equal(result.session.status, "TARGET_LOCKED");
    assert.equal(result.observation.outcome, "confirmed");
    assert.notEqual(result.targetPoseSample, null);
  });

  test("a gap exceeding lossGraceMs transitions TARGET_LOCKED -> TARGET_LOST, with no target sample emitted", () => {
    const { session } = lockTarget();

    // 1500ms since lastConfirmedAtMs(200) exceeds lossGraceMs (1000).
    const result = trackingObserve(session, gapSample(session.lastConfirmedAtMs + 1500), CFG);

    assert.equal(result.session.status, "TARGET_LOST");
    assert.equal(result.targetPoseSample, null);
  });

  test("identity is never switched to a different swimmer merely because of a temporary loss — the session simply reports TARGET_LOST, not a new lock", () => {
    const { session } = lockTarget();
    const originalPosition = session.lastConfirmedPosition;

    const result = trackingObserve(session, gapSample(session.lastConfirmedAtMs + 1500), CFG);

    assert.equal(result.session.status, "TARGET_LOST");
    // lastConfirmedPosition (the identity anchor) is preserved exactly —
    // nothing has silently replaced it.
    assert.deepEqual(result.session.lastConfirmedPosition, originalPosition);
  });
});

// ===========================================================================
// 6 — VALID REACQUISITION
// ===========================================================================

describe("valid reacquisition", () => {
  test("a candidate matching the projected position, within the window, reacquires the original target", () => {
    const { session: locked } = lockTarget();
    const lossAtMs = locked.lastConfirmedAtMs + 1500; // exceeds lossGraceMs (1000)
    const lost = trackingObserve(locked, gapSample(lossAtMs), CFG).session;
    assert.equal(lost.status, "TARGET_LOST");

    // 2000ms since lastConfirmedAtMs(200) -> projected.x = 0.510 + 0.05*2 = 0.610.
    const candidateAtMs = 2200;
    const result = trackingObserve(lost, poseSample(candidateAtMs, 0.610), CFG);

    assert.equal(result.session.status, "TARGET_LOCKED");
    assert.equal(result.observation.outcome, "confirmed");
    assert.equal(result.observation.reacquired, true);
    assert.notEqual(result.targetPoseSample, null);
    assert.deepEqual(result.session.lastConfirmedPosition, { x: 0.610, y: 0.5 });
  });

  test("TARGET_REACQUIRED is NOT a persisted status — the architecture (§8.1) records it as a tag on the observation, and the session status is plain TARGET_LOCKED", () => {
    const { session: locked } = lockTarget();
    const lossAtMs = locked.lastConfirmedAtMs + 1500;
    const lost = trackingObserve(locked, gapSample(lossAtMs), CFG).session;

    const result = trackingObserve(lost, poseSample(2200, 0.610), CFG);

    assert.equal(result.session.status, "TARGET_LOCKED");
    assert.notEqual(result.session.status, "TARGET_REACQUIRED"); // this status does not exist in the contract at all
    const lastHistoryEntry = result.session.observationHistory[result.session.observationHistory.length - 1];
    assert.equal(lastHistoryEntry.reacquired, true);
  });

  test("identity remains continuous after reacquisition — tracking resumes normally along the same trajectory", () => {
    const { session: locked } = lockTarget();
    const lossAtMs = locked.lastConfirmedAtMs + 1500;
    const lost = trackingObserve(locked, gapSample(lossAtMs), CFG).session;
    const reacquired = trackingObserve(lost, poseSample(2200, 0.610), CFG).session;

    assert.equal(reacquired.status, "TARGET_LOCKED");

    const velocity = reacquired.lastConfirmedVelocity;
    const atMs = reacquired.lastConfirmedAtMs + 100;
    const expectedX = reacquired.lastConfirmedPosition.x + velocity.x * 0.1;

    const followUp = trackingObserve(reacquired, poseSample(atMs, expectedX), CFG);

    assert.equal(followUp.observation.outcome, "confirmed");
    assert.equal(followUp.session.status, "TARGET_LOCKED");
  });

  test("REGRESSION (§12.3): a well-matched candidate arriving AFTER maxReacquisitionWindowMs has elapsed is refused, regardless of how well it matches the projected position", () => {
    // docs/SWIMMER_TRACKING_ARCHITECTURE.md §12.3's diagram checks
    // "is elapsed time since loss <= maxReacquisitionWindowMs?" FIRST,
    // unconditionally, before continuity/visibility are even evaluated —
    // a late candidate must be refused regardless of how well it matches
    // the projected position. src/swimmer-tracking/tracking.js's
    // observeWhileTargetLost() gates its "confirmed" outcome on
    // `!windowExhausted` for exactly this reason. This test locks in that
    // behavior as a permanent regression test.
    const { session: locked } = lockTarget();
    const lossAtMs = locked.lastConfirmedAtMs + 1500;
    const lost = trackingObserve(locked, gapSample(lossAtMs), CFG).session;

    // 3500ms after lossAtMs — exceeds maxReacquisitionWindowMs (3000).
    const lateCandidateAtMs = lossAtMs + 3500;
    // Elapsed since lastConfirmedAtMs(200) is 5000ms=5s -> projected.x = 0.510 + 0.05*5 = 0.760.
    // The candidate matches this projection exactly — a "perfect" match, arriving too late.
    const result = trackingObserve(lost, poseSample(lateCandidateAtMs, 0.760), CFG);

    assert.notEqual(
      result.session.status,
      "TARGET_LOCKED",
      "docs/SWIMMER_TRACKING_ARCHITECTURE.md §12.3 requires the elapsed-time window to be checked " +
      "before continuity/visibility, so a late candidate must never reacquire regardless of position " +
      "match — see tracking.js's observeWhileTargetLost()"
    );
  });
});

// ===========================================================================
// 10 — TIME-NORMALIZED MOTION (end-to-end through observe(), not just the
// isolated continuity.js math already covered in continuity.test.js)
// ===========================================================================

describe("time-normalized motion through observe()", () => {
  test("the same physical speed is confirmed identically whether sampled at a short or a long interval", () => {
    // Short-interval scenario: 0.01 units per 100ms step while locking.
    const shortInterval = lockTarget(); // uses 100ms steps, 0.005/step -> 0.05/s established

    // Long-interval scenario: same 0.05/s physical speed, but the
    // locking samples are spaced 400ms apart (0.020 per step instead of
    // 0.005) — a raw, un-normalized implementation would treat these as
    // wildly different "velocities" even though the physical speed is
    // identical.
    let longSession = newSelectedSession(0);
    let r = trackingObserve(longSession, poseSample(0, 0.500), CFG);
    longSession = r.session;
    r = trackingObserve(longSession, poseSample(400, 0.520), CFG);
    longSession = r.session;
    r = trackingObserve(longSession, poseSample(800, 0.540), CFG);
    longSession = r.session;

    assert.equal(longSession.status, "TARGET_LOCKED");
    assert.equal(
      Math.round(shortInterval.session.lastConfirmedVelocity.magnitudePerSecond * 100) / 100,
      Math.round(longSession.lastConfirmedVelocity.magnitudePerSecond * 100) / 100
    );
  });

  test("a candidate consistent with time-normalized velocity is confirmed even when the sampling interval changes mid-stream", () => {
    let { session } = lockTarget(); // established at 100ms cadence
    const velocity = session.lastConfirmedVelocity;

    // Switch to a much longer 900ms interval for the next observation —
    // the expected position must still be computed via elapsed time, not
    // a per-frame assumption.
    const atMs = session.lastConfirmedAtMs + 900;
    const expectedX = session.lastConfirmedPosition.x + velocity.x * 0.9;

    const result = trackingObserve(session, poseSample(atMs, expectedX), CFG);

    assert.equal(result.observation.outcome, "confirmed");
    assert.notEqual(result.targetPoseSample, null);
  });
});

// ===========================================================================
// 11 — DIRECTION REVERSAL (a turn) is NOT treated as identity loss
// ===========================================================================

describe("direction reversal", () => {
  test("a legitimate, slow direction reversal is confirmed, not flagged ambiguous — tracking has no race-turn semantics, it only bounds implausible jumps", () => {
    const { session } = lockTarget(); // established velocity ~+0.05/s
    const atMs = session.lastConfirmedAtMs + 100;

    // Reverses direction: moves BACKWARD by the same small magnitude the
    // forward velocity would have covered, rather than continuing
    // forward. At this slow speed/short interval, the resulting
    // continuityError stays within maxSteadyStatePositionError, so the
    // architecture's claim (docs/SWIMMER_TRACKING_ARCHITECTURE.md §12.1
    // #9: "a turn is a normal, anticipated reversal") holds under these
    // realistic values without inventing turn-specific logic anywhere in
    // tracking.js.
    const reversedX = session.lastConfirmedPosition.x - 0.005;

    const result = trackingObserve(session, poseSample(atMs, reversedX), CFG);

    assert.equal(result.observation.outcome, "confirmed");
    assert.equal(result.session.status, "TARGET_LOCKED");
    assert.notEqual(result.targetPoseSample, null);
  });

  test("the velocity recorded after a reversal reflects the new direction, not the old one", () => {
    const { session } = lockTarget();
    const atMs = session.lastConfirmedAtMs + 100;
    const reversedX = session.lastConfirmedPosition.x - 0.005;

    const result = trackingObserve(session, poseSample(atMs, reversedX), CFG);

    assert.ok(result.observation.velocity.x < 0, "velocity.x should now be negative after reversal");
  });
});

// ===========================================================================
// 12 — CAMERA-PAN LIMITATION: no test applicable (documented, not manufactured)
// ===========================================================================

describe("camera-pan compensation", () => {
  test.todo(
    "docs/SWIMMER_TRACKING_ARCHITECTURE.md §12.1 #10 explicitly states camera-pan " +
    "compensation is NOT solved in v1, and the public API (createSession/selectTarget/" +
    "observe) exposes no camera-motion-related parameter, state, or output to test. " +
    "There is no meaningful behavior to assert here without inventing an algorithm the " +
    "architecture document explicitly declines to specify — documented as not applicable " +
    "per the Stage 4C.3 instructions, rather than manufacturing a test."
  );
});

// ===========================================================================
// 13 — CONFIRMED-TARGET-ONLY OUTPUT (the central invariant, §13)
// ===========================================================================

describe("confirmed-target-only output invariant", () => {
  test("UNSELECTED: observe() is illegal and never emits a target sample", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingObserve(session, poseSample(0, 0.5), CFG);

    assert.equal(result.ok, false);
    assert.equal(result.targetPoseSample, null);
  });

  test("TARGET_SELECTED/TARGET_LOCKING: no target sample is emitted before the lock is confirmed", () => {
    let session = newSelectedSession(0);
    let result = trackingObserve(session, poseSample(0, 0.5), CFG);
    assert.equal(result.session.status, "TARGET_LOCKING");
    assert.equal(result.targetPoseSample, null);
  });

  test("TARGET_LOCKED: an ambiguous observation (low visibility) does not emit a target sample", () => {
    const { session } = lockTarget();
    const atMs = session.lastConfirmedAtMs + 100;
    const expectedX = session.lastConfirmedPosition.x + session.lastConfirmedVelocity.x * 0.1;

    const result = trackingObserve(session, poseSample(atMs, expectedX, 0.5, 0.2), CFG); // visibility 0.2 < 0.5

    assert.equal(result.observation.outcome, "ambiguous");
    assert.equal(result.targetPoseSample, null);
  });

  test("TARGET_LOCKED: a gap does not emit a target sample", () => {
    const { session } = lockTarget();
    const result = trackingObserve(session, gapSample(session.lastConfirmedAtMs + 100), CFG);

    assert.equal(result.observation.outcome, "gap");
    assert.equal(result.targetPoseSample, null);
  });

  test("TARGET_LOCKED: hasPose:true with unusable/missing landmarks (no nose) is treated as a gap, not a crash or a false confirmation", () => {
    // tracking.js's own header comment on extractPositionFacts()
    // documents this exact case: hasPose can be true while the specific
    // landmarks tracking needs (hip+nose) are missing or unusable — this
    // is treated the same as no usable signal at all. Verified here at
    // the public trackingObserve() boundary, not just at the underlying
    // computeRepresentativePosition() pure-function level (already
    // covered in continuity.test.js).
    const { session } = lockTarget();
    const atMs = session.lastConfirmedAtMs + 100;
    const sampleWithMissingNose = {
      atMs,
      hasPose: true,
      landmarks: { hip: { x: 0.510, y: 0.5, visibility: 0.9 } } // nose entirely absent
    };

    const result = trackingObserve(session, sampleWithMissingNose, CFG);

    assert.equal(result.ok, true); // not a caller-error rejection — a normal, handled outcome
    assert.equal(result.observation.outcome, "gap");
    assert.equal(result.observation.representativePosition, null);
    assert.equal(result.targetPoseSample, null);
    assert.equal(result.session.status, "TARGET_LOCKED"); // a single unusable sample does not lose or degrade the lock
  });

  test("TARGET_LOST: a non-matching candidate never emits a target sample", () => {
    const { session: locked } = lockTarget();
    const lossAtMs = locked.lastConfirmedAtMs + 1500; // known, explicit — loss is declared exactly here
    const lost = trackingObserve(locked, gapSample(lossAtMs), CFG).session;
    assert.equal(lost.status, "TARGET_LOST");

    // Far from the projected position.
    const result = trackingObserve(lost, poseSample(lossAtMs + 200, 0.99), CFG);

    assert.equal(result.targetPoseSample, null);
  });

  test("ANALYSIS_DEGRADED: observe() is illegal and never emits a target sample", () => {
    const { session: locked } = lockTarget();
    const lossAtMs = locked.lastConfirmedAtMs + 1500; // known, explicit — loss is declared exactly here
    let session = trackingObserve(locked, gapSample(lossAtMs), CFG).session;
    assert.equal(session.status, "TARGET_LOST");

    // Exhaust the reacquisition window (3000ms from lossAtMs) with a non-matching candidate.
    const result1 = trackingObserve(session, poseSample(lossAtMs + 3500, 0.99), CFG);
    assert.equal(result1.session.status, "ANALYSIS_DEGRADED");

    const result2 = trackingObserve(result1.session, poseSample(lossAtMs + 4000, 0.5), CFG);
    assert.equal(result2.ok, false);
    assert.equal(result2.targetPoseSample, null);
  });

  test("only a TARGET_LOCKED-confirmed or a TARGET_LOST-reacquired-confirmed call ever emits a non-null targetPoseSample", () => {
    const { session } = lockTarget();
    // The final locking call itself already proved this once (section 3);
    // this test asserts the positive case explicitly for steady-state too.
    const atMs = session.lastConfirmedAtMs + 100;
    const expectedX = session.lastConfirmedPosition.x + session.lastConfirmedVelocity.x * 0.1;

    const result = trackingObserve(session, poseSample(atMs, expectedX), CFG);

    assert.equal(result.observation.outcome, "confirmed");
    assert.notEqual(result.targetPoseSample, null);
    assert.deepEqual(result.targetPoseSample, poseSample(atMs, expectedX));
  });
});
