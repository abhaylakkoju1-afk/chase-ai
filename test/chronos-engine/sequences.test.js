// Full-sequence fixture tests for the Chronos core engine — readable,
// end-to-end scenarios exercising session.js + events.js together the way
// a real caller eventually will (docs/CHRONOS_ARCHITECTURE.md §21-§23).
//
// Every timestamp below is a fixed, hand-chosen number. No Date.now(), no
// Math.random(), no real video, no MediaPipe, no browser API — these are
// exactly the kind of deterministic fixture-replay scenarios
// docs/DEVELOPMENT_WORKFLOW.md's stated testing preference calls for.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosCreateSession, chronosArmSession, chronosAbortSession, chronosTransition } from "../../src/chronos-engine/session.js";
import { chronosRecordEvent } from "../../src/chronos-engine/events.js";

function newArmedSession(overrides = {}) {
  const created = chronosCreateSession({
    sessionId: "fixture-race",
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 100m",
    timeSource: "video",
    ...overrides
  });
  assert.equal(created.ok, true);
  const armed = chronosArmSession(created.session);
  assert.equal(armed.ok, true);
  return armed.session;
}

function record(session, input) {
  const result = chronosRecordEvent(session, input);
  assert.equal(result.ok, true, `expected acceptance of ${JSON.stringify(input)} but got: ${result.reason}`);
  return result.session;
}

// ===========================================================================
// FIXTURE 1 — SIMPLE MANUAL RACE
// armed -> manual start -> manual split -> manual turn -> manual split -> manual finish
// ===========================================================================

describe("fixture 1 — simple manual race", () => {
  test("a fully manual 100m race produces the expected event log and final time", () => {
    let session = newArmedSession();

    session = record(session, { type: "start", atMs: 0, source: "manual" });
    session = record(session, { type: "split", atMs: 15000, distanceMeters: 25, source: "manual" });
    session = record(session, { type: "turn", atMs: 32000, distanceMeters: 50, source: "manual" });
    session = record(session, { type: "split", atMs: 48000, distanceMeters: 75, source: "manual" });
    session = record(session, { type: "finish", atMs: 63000, distanceMeters: 100, source: "manual" });

    assert.equal(session.status, "finished");
    assert.equal(session.finalTimeMs, 63000);
    assert.deepEqual(
      session.events.map((e) => e.type),
      ["start", "split", "turn", "split", "finish"]
    );
    assert.ok(session.events.every((e) => e.source === "manual"));
    assert.ok(session.events.every((e) => e.confidence === null && e.detector === null));
  });
});

// ===========================================================================
// FIXTURE 2 — DETECTOR RACE
// armed -> detector start -> detector turn(s) -> detector finish
// ===========================================================================

describe("fixture 2 — fully automatic (detector) race", () => {
  test("a fully detector-driven 50m race preserves confidence/detector metadata throughout", () => {
    let session = newArmedSession({ event: "Freestyle 50m" });

    session = record(session, { type: "start", atMs: 0, source: "detector", confidence: 0.85, detector: "start-detector-v1" });
    session = record(session, { type: "turn", atMs: 20000, distanceMeters: 25, source: "detector", confidence: 0.8, detector: "turn-detector-v1" });
    session = record(session, { type: "finish", atMs: 41000, distanceMeters: 50, source: "detector", confidence: 0.9, detector: "wall-contact-detector-v1" });

    assert.equal(session.status, "finished");
    assert.equal(session.finalTimeMs, 41000);
    assert.ok(session.events.every((e) => e.source === "detector"));
    assert.ok(session.events.every((e) => typeof e.confidence === "number"));

    const [start, turn, finish] = session.events;
    assert.equal(start.confidence, 0.85);
    assert.equal(turn.detector, "turn-detector-v1");
    assert.equal(finish.detector, "wall-contact-detector-v1");
  });
});

// ===========================================================================
// FIXTURE 3 — MIXED RACE
// manual start -> detector turn -> manual split -> detector finish
// ===========================================================================

describe("fixture 3 — mixed manual/detector race", () => {
  test("manual and detector events coexist in one session, each keeping its own trust metadata", () => {
    let session = newArmedSession({ event: "Freestyle 50m" });

    session = record(session, { type: "start", atMs: 0, source: "manual" });
    session = record(session, { type: "turn", atMs: 20000, distanceMeters: 25, source: "detector", confidence: 0.77, detector: "turn-detector-v1" });
    session = record(session, { type: "split", atMs: 40000, distanceMeters: 40, source: "manual" });
    session = record(session, { type: "finish", atMs: 60000, distanceMeters: 50, source: "detector", confidence: 0.88, detector: "wall-contact-detector-v1" });

    assert.equal(session.status, "finished");
    assert.equal(session.finalTimeMs, 60000);

    const [start, turn, split, finish] = session.events;
    assert.equal(start.source, "manual");
    assert.equal(start.confidence, null);

    assert.equal(turn.source, "detector");
    assert.equal(turn.confidence, 0.77);

    assert.equal(split.source, "manual");
    assert.equal(split.confidence, null);

    assert.equal(finish.source, "detector");
    assert.equal(finish.confidence, 0.88);
  });
});

// ===========================================================================
// FIXTURE 4 — INVALID DUPLICATES
// ===========================================================================

describe("fixture 4 — invalid duplicate events", () => {
  test("duplicate start, duplicate finish, and a noisy duplicate split are all rejected without corrupting the race", () => {
    let session = newArmedSession();

    session = record(session, { type: "start", atMs: 0, source: "manual" });

    const dupStart = chronosRecordEvent(session, { type: "start", atMs: 500, source: "manual" });
    assert.equal(dupStart.ok, false);
    assert.equal(dupStart.reason, "start-already-recorded");

    session = record(session, { type: "split", atMs: 15000, distanceMeters: 25, source: "detector", confidence: 0.7, detector: "turn-detector-v1" });

    // A noisy re-trigger of the same wall contact 400ms later — exactly
    // the failure mode MIN_EVENT_GAP_MS exists to prevent.
    const noisyDuplicateSplit = chronosRecordEvent(session, {
      type: "split",
      atMs: 15400,
      distanceMeters: 25,
      source: "detector",
      confidence: 0.65,
      detector: "turn-detector-v1"
    });
    assert.equal(noisyDuplicateSplit.ok, false);
    assert.equal(noisyDuplicateSplit.reason, "event-too-soon-after-previous");

    session = record(session, { type: "finish", atMs: 40000, distanceMeters: 50, source: "manual" });

    const dupFinish = chronosRecordEvent(session, { type: "finish", atMs: 41000, distanceMeters: 50, source: "manual" });
    assert.equal(dupFinish.ok, false);
    assert.equal(dupFinish.reason, "finish-already-recorded");

    // The race itself is exactly as clean as if the invalid attempts had
    // never happened: start, one split, finish.
    assert.deepEqual(session.events.map((e) => e.type), ["start", "split", "finish"]);
    assert.equal(session.finalTimeMs, 40000);
  });
});

// ===========================================================================
// FIXTURE 5 — OUT-OF-ORDER EVENTS
// ===========================================================================

describe("fixture 5 — out-of-order events", () => {
  test("an event before the start timestamp is rejected", () => {
    let session = newArmedSession();
    session = record(session, { type: "start", atMs: 5000, source: "manual" });

    const beforeStart = chronosRecordEvent(session, {
      type: "split",
      atMs: 3000,
      distanceMeters: 25,
      source: "manual"
    });
    assert.equal(beforeStart.ok, false);
    assert.equal(beforeStart.reason, "event-before-start-time");
  });

  test("a negative timestamp is rejected by time-basis validation before any ordering rule runs", () => {
    let session = newArmedSession();
    session = record(session, { type: "start", atMs: 0, source: "manual" });

    const negative = chronosRecordEvent(session, {
      type: "split",
      atMs: -5,
      distanceMeters: 25,
      source: "manual"
    });
    assert.equal(negative.ok, false);
    assert.equal(negative.reason, "timestamp-negative");
  });

  test("distance regressing while time advances is rejected as distance-out-of-order", () => {
    let session = newArmedSession();
    session = record(session, { type: "start", atMs: 0, source: "manual" });
    session = record(session, { type: "split", atMs: 20000, distanceMeters: 50, source: "manual" });

    const distanceRegresses = chronosRecordEvent(session, {
      type: "split",
      atMs: 30000,
      distanceMeters: 25,
      source: "manual"
    });
    assert.equal(distanceRegresses.ok, false);
    assert.equal(distanceRegresses.reason, "distance-out-of-order");
  });

  test("time regressing while distance advances is rejected as non-monotonic-timestamp", () => {
    let session = newArmedSession();
    session = record(session, { type: "start", atMs: 0, source: "manual" });
    session = record(session, { type: "split", atMs: 20000, distanceMeters: 50, source: "manual" });

    const timeRegresses = chronosRecordEvent(session, {
      type: "split",
      atMs: 19000,
      distanceMeters: 60,
      source: "manual"
    });
    assert.equal(timeRegresses.ok, false);
    assert.equal(timeRegresses.reason, "non-monotonic-timestamp");
  });

  test("none of the rejected out-of-order attempts altered the session's real event log", () => {
    let session = newArmedSession();
    session = record(session, { type: "start", atMs: 0, source: "manual" });
    session = record(session, { type: "split", atMs: 20000, distanceMeters: 50, source: "manual" });

    chronosRecordEvent(session, { type: "split", atMs: 30000, distanceMeters: 25, source: "manual" });
    chronosRecordEvent(session, { type: "split", atMs: 19000, distanceMeters: 60, source: "manual" });

    assert.deepEqual(session.events.map((e) => [e.type, e.atMs, e.distanceMeters]), [
      ["start", 0, 0],
      ["split", 20000, 50]
    ]);
  });
});

// ===========================================================================
// FIXTURE 6 — ABORTED RACE
// ===========================================================================

describe("fixture 6 — aborted race", () => {
  test("an armed session can be aborted before any timing event is recorded", () => {
    const session = newArmedSession();
    const aborted = chronosAbortSession(session);

    assert.equal(aborted.ok, true);
    assert.equal(aborted.session.status, "aborted");
    assert.deepEqual(aborted.session.events, []);
  });

  test("a running session can be aborted mid-race, preserving whatever was already recorded", () => {
    let session = newArmedSession();
    session = record(session, { type: "start", atMs: 0, source: "manual" });
    session = record(session, { type: "split", atMs: 15000, distanceMeters: 25, source: "manual" });

    const aborted = chronosAbortSession(session);

    assert.equal(aborted.ok, true);
    assert.equal(aborted.session.status, "aborted");
    assert.equal(aborted.session.finalTimeMs, null);
    assert.equal(aborted.session.events.length, 2);
  });

  test("an aborted session accepts no further events", () => {
    const session = newArmedSession();
    const { session: aborted } = chronosAbortSession(session);

    const attempt = chronosRecordEvent(aborted, { type: "start", atMs: 0, source: "manual" });

    assert.equal(attempt.ok, false);
    assert.equal(attempt.reason, "event-type-illegal-in-status-aborted");
  });

  test("a finished session cannot be aborted — abort is not a legal transition out of a terminal status", () => {
    let session = newArmedSession();
    session = record(session, { type: "start", atMs: 0, source: "manual" });
    session = record(session, { type: "finish", atMs: 30000, distanceMeters: 25, source: "manual" });

    const abortAttempt = chronosAbortSession(session);

    assert.equal(abortAttempt.ok, false);
    assert.equal(abortAttempt.reason, "illegal-transition-finished-to-aborted");
    // The finished session itself is returned completely unchanged.
    assert.strictEqual(abortAttempt.session, session);
    assert.equal(session.finalTimeMs, 30000);
    assert.equal(session.status, "finished");
  });

  test("chronosTransition() confirms \"aborted\" has no legal outgoing transitions at all", () => {
    const { session: aborted } = chronosAbortSession(newArmedSession());

    for (const target of ["idle", "armed", "running", "finished", "aborted"]) {
      assert.equal(chronosTransition(aborted, target).ok, false);
    }
  });
});
