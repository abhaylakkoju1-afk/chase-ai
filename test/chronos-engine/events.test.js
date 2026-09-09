// Unit tests for src/chronos-engine/events.js — authoritative TimingEvent
// ingestion: validation, the start/finish rules, split/turn distance and
// timestamp ordering, the minimum-gap dedup rule, and the manual/detector
// trust model (docs/CHRONOS_ARCHITECTURE.md §6, §10-§13, §15).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosCreateSession, chronosArmSession } from "../../src/chronos-engine/session.js";
import { chronosRecordEvent, MIN_EVENT_GAP_MS } from "../../src/chronos-engine/events.js";

// ---------------------------------------------------------------------
// Fixture helpers — deliberately small and local rather than a shared
// fixtures module, per the Stage 3 instruction to avoid unnecessary test
// abstractions. Every timestamp used anywhere in this file is a fixed,
// hand-chosen number — never Date.now(), never Math.random().
// ---------------------------------------------------------------------

function armedSession(overrides = {}) {
  const created = chronosCreateSession({
    sessionId: "events-test-race",
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 100m",
    timeSource: "video",
    ...overrides
  });
  assert.equal(created.ok, true, "fixture setup: session creation must succeed");
  const armed = chronosArmSession(created.session);
  assert.equal(armed.ok, true, "fixture setup: arming must succeed");
  return armed.session;
}

function runningSession({ startAtMs = 0, startSource = "manual" } = {}) {
  const session = armedSession();
  const started = chronosRecordEvent(session, startInput({ atMs: startAtMs, source: startSource }));
  assert.equal(started.ok, true, "fixture setup: start must succeed");
  return started.session;
}

function startInput({ atMs = 0, source = "manual", confidence, detector } = {}) {
  const input = { type: "start", atMs, source };
  if (source === "detector") {
    input.confidence = confidence ?? 0.9;
    input.detector = detector ?? "start-detector-v1";
  }
  return input;
}

function finishInput({ atMs, distanceMeters, source = "manual", confidence, detector } = {}) {
  const input = { type: "finish", atMs, distanceMeters, source };
  if (source === "detector") {
    input.confidence = confidence ?? 0.9;
    input.detector = detector ?? "finish-detector-v1";
  }
  return input;
}

function distanceEventInput(type, { atMs, distanceMeters, source = "manual", confidence, detector } = {}) {
  const input = { type, atMs, distanceMeters, source };
  if (source === "detector") {
    input.confidence = confidence ?? 0.9;
    input.detector = detector ?? "turn-detector-v1";
  }
  return input;
}

// Records a single event that is expected to be REJECTED, and asserts the
// full immutability contract (docs/CHRONOS_ARCHITECTURE.md §13, §16):
// the exact original session reference comes back, with the expected
// reason, and no event/status leak through.
function assertRejected(session, input, expectedReason) {
  const result = chronosRecordEvent(session, input);
  assert.equal(result.ok, false, `expected rejection (${expectedReason}) but got ok:true`);
  assert.equal(result.reason, expectedReason);
  assert.equal(result.event, null);
  assert.strictEqual(
    result.session,
    session,
    "a rejected event must return the exact original session reference — no clone, no partial mutation"
  );
  return result;
}

function assertAccepted(session, input) {
  const result = chronosRecordEvent(session, input);
  assert.equal(result.ok, true, `expected acceptance but got: ${result.reason}`);
  return result;
}

// ===========================================================================
// A/B — START EVENTS
// ===========================================================================

describe("start events", () => {
  test("a valid manual start is accepted and moves armed -> running", () => {
    const session = armedSession();
    const result = assertAccepted(session, startInput({ atMs: 0 }));

    assert.equal(result.session.status, "running");
    assert.equal(result.event.type, "start");
  });

  test("the start timestamp is preserved exactly, not rounded or recomputed", () => {
    const session = armedSession();
    const result = assertAccepted(session, startInput({ atMs: 1234.75 }));

    assert.equal(result.event.atMs, 1234.75);
  });

  test("exactly one start is allowed per session", () => {
    const session = runningSession({ startAtMs: 0 });
    assert.equal(session.events.filter((event) => event.type === "start").length, 1);
  });

  test("a duplicate start is rejected with the documented reason \"start-already-recorded\" (docs/CHRONOS_ARCHITECTURE.md §11)", () => {
    const session = runningSession({ startAtMs: 0 });
    assertRejected(session, startInput({ atMs: 500 }), "start-already-recorded");
  });

  test("a rejected duplicate start leaves the session's single start event untouched", () => {
    const session = runningSession({ startAtMs: 0 });
    const originalStartEvent = session.events[0];

    assertRejected(session, startInput({ atMs: 500 }), "start-already-recorded");

    assert.equal(session.events.length, 1);
    assert.strictEqual(session.events[0], originalStartEvent);
  });

  test("a start recorded on an idle (not armed) session is rejected", () => {
    const created = chronosCreateSession({
      sessionId: "idle-start-attempt",
      poolLengthMeters: 25,
      course: "Short Course",
      event: "Freestyle 100m",
      timeSource: "video"
    });
    assertRejected(created.session, startInput({ atMs: 0 }), "event-type-illegal-in-status-idle");
  });

  test("a start with an invalid timestamp is rejected", () => {
    const session = armedSession();
    assertRejected(session, startInput({ atMs: NaN }), "timestamp-not-finite");
    assertRejected(session, startInput({ atMs: -1 }), "timestamp-negative");
  });
});

// ===========================================================================
// C — FINISH EVENTS
// ===========================================================================

describe("finish events", () => {
  test("a valid finish after start is accepted and moves running -> finished", () => {
    const session = runningSession({ startAtMs: 0 });
    const result = assertAccepted(session, finishInput({ atMs: 60000, distanceMeters: 100 }));

    assert.equal(result.session.status, "finished");
  });

  test("finalTimeMs = finish.atMs - start.atMs", () => {
    const session = runningSession({ startAtMs: 500 });
    const result = assertAccepted(session, finishInput({ atMs: 60500, distanceMeters: 100 }));

    assert.equal(result.session.finalTimeMs, 60000);
  });

  test("a finish without a prior start is rejected as \"finish-before-start\"", () => {
    // status "running" is unreachable without a start already recorded, so
    // this exercises the only realistic route to a start-less finish
    // attempt: idle/armed statuses reject "finish" before it ever reaches
    // the start-existence check, which is exactly what is being asserted.
    const armed = armedSession();
    assertRejected(armed, finishInput({ atMs: 100, distanceMeters: 25 }), "event-type-illegal-in-status-armed");
  });

  test("a finish while idle is rejected", () => {
    const created = chronosCreateSession({
      sessionId: "idle-finish-attempt",
      poolLengthMeters: 25,
      course: "Short Course",
      event: "Freestyle 100m",
      timeSource: "video"
    });
    assertRejected(created.session, finishInput({ atMs: 100, distanceMeters: 25 }), "event-type-illegal-in-status-idle");
  });

  test("a finish timestamp equal to the start timestamp is rejected", () => {
    const session = runningSession({ startAtMs: 1000 });
    assertRejected(session, finishInput({ atMs: 1000, distanceMeters: 25 }), "finish-before-start-time");
  });

  test("a finish timestamp before the start timestamp is rejected", () => {
    const session = runningSession({ startAtMs: 1000 });
    assertRejected(session, finishInput({ atMs: 999, distanceMeters: 25 }), "finish-before-start-time");
  });

  test("a duplicate finish is rejected with the specific reason \"finish-already-recorded\", mirroring duplicate start (§11)", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: finished } = chronosRecordEvent(session, finishInput({ atMs: 60000, distanceMeters: 100 }));

    // Checked in chronosRecordEvent() before the generic status-legality
    // gate — otherwise, once finished, LEGAL_EVENT_TYPES_BY_STATUS for
    // "finished" is empty and would mask this behind the less specific
    // "event-type-illegal-in-status-finished", exactly the asymmetry with
    // duplicate start that this check was added to remove.
    assertRejected(finished, finishInput({ atMs: 61000, distanceMeters: 100 }), "finish-already-recorded");
  });

  test("a rejected finish does not mutate the session or its finalTimeMs", () => {
    const session = runningSession({ startAtMs: 0 });
    assertRejected(session, finishInput({ atMs: 0, distanceMeters: 25 }), "finish-before-start-time");

    assert.equal(session.finalTimeMs, null);
    assert.equal(session.status, "running");
  });

  test("finalTimeMs remains stable and is not recomputed by later, rejected calls", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: finished } = chronosRecordEvent(session, finishInput({ atMs: 60000, distanceMeters: 100 }));

    assertRejected(finished, finishInput({ atMs: 61000, distanceMeters: 100 }), "finish-already-recorded");

    assert.equal(finished.finalTimeMs, 60000);
  });

  test("finish distance must be non-decreasing relative to the last distance-bearing event", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterSplit } = chronosRecordEvent(
      session,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 50 })
    );

    assertRejected(afterSplit, finishInput({ atMs: 30000, distanceMeters: 25 }), "distance-out-of-order");
  });
});

// ===========================================================================
// D — SPLIT EVENTS
// ===========================================================================

describe("split events", () => {
  test("a valid split after start is accepted", () => {
    const session = runningSession({ startAtMs: 0 });
    const result = assertAccepted(session, distanceEventInput("split", { atMs: 15000, distanceMeters: 25 }));

    assert.equal(result.event.type, "split");
    assert.equal(result.event.distanceMeters, 25);
  });

  test("multiple valid chronological splits accumulate in order", () => {
    let session = runningSession({ startAtMs: 0 });
    ({ session } = chronosRecordEvent(session, distanceEventInput("split", { atMs: 15000, distanceMeters: 25 })));
    ({ session } = chronosRecordEvent(session, distanceEventInput("split", { atMs: 32000, distanceMeters: 50 })));
    ({ session } = chronosRecordEvent(session, distanceEventInput("split", { atMs: 48000, distanceMeters: 75 })));

    const splitDistances = session.events.filter((event) => event.type === "split").map((event) => event.distanceMeters);
    assert.deepEqual(splitDistances, [25, 50, 75]);
  });

  test("split timestamps must be strictly increasing relative to the previous distance-bearing event", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterFirst } = chronosRecordEvent(
      session,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 25 })
    );

    // distance is fine (60 > 25) but the timestamp regresses.
    assertRejected(
      afterFirst,
      distanceEventInput("split", { atMs: 14000, distanceMeters: 60 }),
      "non-monotonic-timestamp"
    );
  });

  test("decreasing distance is rejected as \"distance-out-of-order\"", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterFirst } = chronosRecordEvent(
      session,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 50 })
    );

    assertRejected(
      afterFirst,
      distanceEventInput("split", { atMs: 20000, distanceMeters: 25 }),
      "distance-out-of-order"
    );
  });

  test("equal distance to the previous split is accepted — the contract requires \"not less than\", not strictly increasing", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterFirst } = chronosRecordEvent(
      session,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 50 })
    );

    const result = assertAccepted(
      afterFirst,
      distanceEventInput("split", { atMs: 15000 + MIN_EVENT_GAP_MS + 1, distanceMeters: 50 })
    );
    assert.equal(result.event.distanceMeters, 50);
  });

  test("a negative timestamp on a split is rejected by time-basis validation", () => {
    const session = runningSession({ startAtMs: 0 });
    assertRejected(session, distanceEventInput("split", { atMs: -100, distanceMeters: 25 }), "timestamp-negative");
  });

  test("a non-finite timestamp on a split is rejected", () => {
    const session = runningSession({ startAtMs: 0 });
    assertRejected(session, distanceEventInput("split", { atMs: Infinity, distanceMeters: 25 }), "timestamp-not-finite");
  });

  test("a missing distanceMeters on a split is rejected as \"missing-distance-meters\"", () => {
    const session = runningSession({ startAtMs: 0 });
    const input = { type: "split", atMs: 15000, source: "manual" };
    assertRejected(session, input, "missing-distance-meters");
  });

  test("a negative distanceMeters on a split is rejected as \"negative-distance-meters\"", () => {
    const session = runningSession({ startAtMs: 0 });
    assertRejected(session, distanceEventInput("split", { atMs: 15000, distanceMeters: -5 }), "negative-distance-meters");
  });

  test("a non-numeric distanceMeters on a split is rejected as \"missing-distance-meters\"", () => {
    const session = runningSession({ startAtMs: 0 });
    assertRejected(session, distanceEventInput("split", { atMs: 15000, distanceMeters: "25" }), "missing-distance-meters");
  });

  test("the recorded split's source is preserved exactly", () => {
    const session = runningSession({ startAtMs: 0 });
    const manualResult = assertAccepted(session, distanceEventInput("split", { atMs: 15000, distanceMeters: 25, source: "manual" }));
    assert.equal(manualResult.event.source, "manual");

    const detectorSession = runningSession({ startAtMs: 0 });
    const detectorResult = assertAccepted(
      detectorSession,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 25, source: "detector", confidence: 0.6, detector: "turn-detector-v1" })
    );
    assert.equal(detectorResult.event.source, "detector");
  });

  test("confidence/detector fields obey the source rules (§15): null for manual, populated for detector", () => {
    const manualSession = runningSession({ startAtMs: 0 });
    const manual = assertAccepted(manualSession, distanceEventInput("split", { atMs: 15000, distanceMeters: 25, source: "manual" }));
    assert.equal(manual.event.confidence, null);
    assert.equal(manual.event.detector, null);

    const detectorSession = runningSession({ startAtMs: 0 });
    const detector = assertAccepted(
      detectorSession,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 25, source: "detector", confidence: 0.73, detector: "turn-detector-v1" })
    );
    assert.equal(detector.event.confidence, 0.73);
    assert.equal(detector.event.detector, "turn-detector-v1");
  });

  test("a rejected split leaves prior events and session state completely unchanged", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterFirst } = chronosRecordEvent(
      session,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 25 })
    );
    const beforeAttempt = structuredClone(afterFirst);

    assertRejected(afterFirst, distanceEventInput("split", { atMs: 15000, distanceMeters: 10 }), "distance-out-of-order");

    assert.deepEqual(afterFirst, beforeAttempt);
  });
});

// ===========================================================================
// E / L — TURN EVENTS AND TURN/SPLIT SEMANTICS
// ===========================================================================

describe("turn events", () => {
  test("a valid turn is accepted", () => {
    const session = runningSession({ startAtMs: 0 });
    const result = assertAccepted(session, distanceEventInput("turn", { atMs: 15000, distanceMeters: 25 }));

    assert.equal(result.event.type, "turn");
  });

  test("multiple valid turns accumulate in chronological/distance order", () => {
    let session = runningSession({ startAtMs: 0 });
    ({ session } = chronosRecordEvent(session, distanceEventInput("turn", { atMs: 15000, distanceMeters: 25 })));
    ({ session } = chronosRecordEvent(session, distanceEventInput("turn", { atMs: 32000, distanceMeters: 50 })));

    const turns = session.events.filter((event) => event.type === "turn");
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => t.distanceMeters), [25, 50]);
  });

  test("decreasing turn distance is rejected exactly like a decreasing split distance", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterFirst } = chronosRecordEvent(
      session,
      distanceEventInput("turn", { atMs: 15000, distanceMeters: 50 })
    );

    assertRejected(afterFirst, distanceEventInput("turn", { atMs: 20000, distanceMeters: 25 }), "distance-out-of-order");
  });

  for (const type of ["split", "turn"]) {
    test(`"${type}" goes through the identical core validation pipeline as its sibling type (same rejection reasons for the same bad input)`, () => {
      const session = runningSession({ startAtMs: 0 });
      assertRejected(session, distanceEventInput(type, { atMs: -1, distanceMeters: 25 }), "timestamp-negative");
      assertRejected(session, distanceEventInput(type, { atMs: 15000, distanceMeters: -1 }), "negative-distance-meters");
    });
  }

  test("a turn's type is never coerced to \"split\" merely because they share the TimingEvent shape", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: withTurn, event } = chronosRecordEvent(
      session,
      distanceEventInput("turn", { atMs: 15000, distanceMeters: 25 })
    );

    assert.equal(event.type, "turn");
    assert.equal(withTurn.events[withTurn.events.length - 1].type, "turn");
  });

  test("a mixed split+turn session keeps the two types distinguishable by filtering on TimingEvent.type", () => {
    let session = runningSession({ startAtMs: 0 });
    ({ session } = chronosRecordEvent(session, distanceEventInput("split", { atMs: 15000, distanceMeters: 20 })));
    ({ session } = chronosRecordEvent(session, distanceEventInput("turn", { atMs: 32000, distanceMeters: 25 })));
    ({ session } = chronosRecordEvent(session, distanceEventInput("split", { atMs: 48000, distanceMeters: 40 })));
    ({ session } = chronosRecordEvent(session, distanceEventInput("turn", { atMs: 65000, distanceMeters: 50 })));

    assert.equal(session.events.filter((e) => e.type === "split").length, 2);
    assert.equal(session.events.filter((e) => e.type === "turn").length, 2);

    // docs/CHRONOS_ARCHITECTURE.md §12: a turn is a physical wall-contact
    // event; a split is a generic checkpoint. Both flow through identical
    // TimingEvent storage/validation (asserted above and in the shared
    // pipeline test), but the event log itself must never blur which is
    // which — that distinction is the only thing a later Race Analysis
    // report layer (not built in this stage) would have to work with.
    assert.deepEqual(
      session.events.map((e) => e.type),
      ["start", "split", "turn", "split", "turn"]
    );
  });
});

// ===========================================================================
// F / N — MINIMUM EVENT GAP
// ===========================================================================

describe("minimum event gap (MIN_EVENT_GAP_MS)", () => {
  test("MIN_EVENT_GAP_MS is exactly the provisional 2500ms default carried over from the existing detector debounce", () => {
    // docs/CHRONOS_ARCHITECTURE.md §13 / the Stage 2 report: this value is
    // a provisional engineering default, not scientifically validated —
    // this test locks in the CURRENT value, it does not endorse it as
    // correct. Tuning happens later against real fixtures (§13, §N of the
    // Stage 3 instructions).
    assert.equal(MIN_EVENT_GAP_MS, 2500);
  });

  function twoSplitSession(gapMs, { firstSource = "manual", secondSource = "manual" } = {}) {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterFirst } = chronosRecordEvent(
      session,
      distanceEventInput("split", { atMs: 15000, distanceMeters: 25, source: firstSource })
    );
    const secondInput = distanceEventInput("split", {
      atMs: 15000 + gapMs,
      distanceMeters: 50,
      source: secondSource
    });
    return { afterFirst, secondInput };
  }

  test("a gap of 2499ms (less than MIN_EVENT_GAP_MS) is rejected", () => {
    const { afterFirst, secondInput } = twoSplitSession(MIN_EVENT_GAP_MS - 1);
    assertRejected(afterFirst, secondInput, "event-too-soon-after-previous");
  });

  test("a gap of exactly MIN_EVENT_GAP_MS is ACCEPTED — the current comparison is strict-less-than (\"<\"), so the boundary itself is inclusive of acceptance", () => {
    const { afterFirst, secondInput } = twoSplitSession(MIN_EVENT_GAP_MS);
    const result = assertAccepted(afterFirst, secondInput);
    assert.equal(result.event.distanceMeters, 50);
  });

  test("a gap of 2501ms (more than MIN_EVENT_GAP_MS) is accepted", () => {
    const { afterFirst, secondInput } = twoSplitSession(MIN_EVENT_GAP_MS + 1);
    assertAccepted(afterFirst, secondInput);
  });

  const sourceCombinations = [
    ["manual", "manual"],
    ["detector", "detector"],
    ["manual", "detector"],
    ["detector", "manual"]
  ];

  for (const [firstSource, secondSource] of sourceCombinations) {
    test(`the gap rule is source-agnostic: ${firstSource} -> ${secondSource} too-soon is rejected identically`, () => {
      const { afterFirst, secondInput } = twoSplitSession(MIN_EVENT_GAP_MS - 1, { firstSource, secondSource });
      assertRejected(afterFirst, secondInput, "event-too-soon-after-previous");
    });

    test(`the gap rule is source-agnostic: ${firstSource} -> ${secondSource} beyond the gap is accepted identically`, () => {
      const { afterFirst, secondInput } = twoSplitSession(MIN_EVENT_GAP_MS + 1, { firstSource, secondSource });
      assertAccepted(afterFirst, secondInput);
    });
  }

  test("a gap-rejected event leaves the session's event count and existing events unchanged", () => {
    const { afterFirst, secondInput } = twoSplitSession(1000);
    const eventsBefore = afterFirst.events;

    assertRejected(afterFirst, secondInput, "event-too-soon-after-previous");

    assert.strictEqual(afterFirst.events, eventsBefore);
    assert.equal(afterFirst.events.length, 2); // start + first split only
  });
});

// ===========================================================================
// M — FIRST SPLIT/TURN AFTER START IS NOT GAP-CHECKED
// ===========================================================================

describe("first split/turn after start (no gap check against start itself)", () => {
  test("a split just 1ms after start is ACCEPTED — start has no distance-bearing predecessor to gap against (docs/CHRONOS_ARCHITECTURE.md §13)", () => {
    const session = runningSession({ startAtMs: 0 });

    const result = assertAccepted(session, distanceEventInput("split", { atMs: 1, distanceMeters: 25 }));

    assert.equal(result.event.atMs, 1);
    // This is documented, intentional v1 behavior, not a bug: §13's
    // "consecutive distance-bearing events" language and §10 rule 4's
    // distance-bearing type list both deliberately exclude "start". A
    // second, real minimum-gap rule between start and the first
    // split/turn would be a NEW rule beyond what the architecture
    // document specifies, and is intentionally not added here.
  });

  test("this behavior applies identically whether the first distance-bearing event is a split or a turn", () => {
    const splitSession = runningSession({ startAtMs: 0 });
    assertAccepted(splitSession, distanceEventInput("split", { atMs: 1, distanceMeters: 25 }));

    const turnSession = runningSession({ startAtMs: 0 });
    assertAccepted(turnSession, distanceEventInput("turn", { atMs: 1, distanceMeters: 25 }));
  });

  test("the SECOND distance-bearing event IS gap-checked, even though the first was not", () => {
    const session = runningSession({ startAtMs: 0 });
    const { session: afterFirst } = chronosRecordEvent(
      session,
      distanceEventInput("split", { atMs: 1, distanceMeters: 25 })
    );

    assertRejected(
      afterFirst,
      distanceEventInput("split", { atMs: 1 + MIN_EVENT_GAP_MS - 1, distanceMeters: 50 }),
      "event-too-soon-after-previous"
    );
  });
});

// ===========================================================================
// G — MANUAL VS DETECTOR VALIDATION
// ===========================================================================

describe("manual vs. detector source validation (§15)", () => {
  test("a manual event with confidence: null and detector: null is accepted", () => {
    const session = armedSession();
    assertAccepted(session, { type: "start", atMs: 0, source: "manual", confidence: null, detector: null });
  });

  test("a detector event with valid confidence and a detector name is accepted", () => {
    const session = armedSession();
    assertAccepted(session, { type: "start", atMs: 0, source: "detector", confidence: 0.5, detector: "start-detector-v1" });
  });

  test("manual + non-null confidence is rejected", () => {
    const session = armedSession();
    assertRejected(
      session,
      { type: "start", atMs: 0, source: "manual", confidence: 0.9 },
      "manual-event-must-not-carry-confidence"
    );
  });

  test("manual + non-null detector is rejected", () => {
    const session = armedSession();
    assertRejected(
      session,
      { type: "start", atMs: 0, source: "manual", detector: "start-detector-v1" },
      "manual-event-must-not-carry-detector"
    );
  });

  test("detector + missing confidence is rejected", () => {
    const session = armedSession();
    assertRejected(
      session,
      { type: "start", atMs: 0, source: "detector", detector: "start-detector-v1" },
      "detector-event-requires-confidence"
    );
  });

  test("detector + confidence below 0 is rejected", () => {
    const session = armedSession();
    assertRejected(
      session,
      { type: "start", atMs: 0, source: "detector", confidence: -0.01, detector: "start-detector-v1" },
      "detector-event-requires-confidence"
    );
  });

  test("detector + confidence above 1 is rejected", () => {
    const session = armedSession();
    assertRejected(
      session,
      { type: "start", atMs: 0, source: "detector", confidence: 1.01, detector: "start-detector-v1" },
      "detector-event-requires-confidence"
    );
  });

  test("confidence exactly 0 and exactly 1 are both accepted (closed interval [0,1])", () => {
    const zeroSession = armedSession();
    assertAccepted(zeroSession, { type: "start", atMs: 0, source: "detector", confidence: 0, detector: "start-detector-v1" });

    const oneSession = armedSession();
    assertAccepted(oneSession, { type: "start", atMs: 0, source: "detector", confidence: 1, detector: "start-detector-v1" });
  });

  test("detector + empty detector name is rejected", () => {
    const session = armedSession();
    assertRejected(
      session,
      { type: "start", atMs: 0, source: "detector", confidence: 0.5, detector: "   " },
      "detector-event-requires-detector-name"
    );
  });

  test("an invalid source value is rejected as \"unknown-event-source\"", () => {
    const session = armedSession();
    for (const badSource of ["ai", "", null, undefined, 123]) {
      assertRejected(session, { type: "start", atMs: 0, source: badSource }, "unknown-event-source");
    }
  });

  test("every invalid manual/detector combination leaves the session unchanged", () => {
    const session = runningSession({ startAtMs: 0 });
    const before = structuredClone(session);

    // Built as a raw object literal, not via distanceEventInput() — that
    // helper deliberately strips confidence/detector for non-"detector"
    // sources when building VALID fixtures, which would silently defeat
    // the very violation this test needs to send.
    assertRejected(
      session,
      { type: "split", atMs: 15000, distanceMeters: 25, source: "manual", confidence: 0.5 },
      "manual-event-must-not-carry-confidence"
    );

    assert.deepEqual(session, before);
  });
});

// ===========================================================================
// H — EVENT REJECTION / IMMUTABILITY (cross-cutting; every reachable
// rejection reason gets at least one dedicated proof here, even where a
// more specific test already exists above).
// ===========================================================================

describe("rejection / immutability guarantees across every reachable rejection reason", () => {
  test("chronosRecordEvent(null, ...) is rejected as \"missing-session\" without touching any session", () => {
    const result = chronosRecordEvent(null, startInput({ atMs: 0 }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-session");
    assert.equal(result.session, null);
    assert.equal(result.event, null);
  });

  test("a missing/malformed event input is rejected as \"missing-event-input\"", () => {
    const session = armedSession();
    assertRejected(session, null, "missing-event-input");
    assertRejected(session, "start", "missing-event-input");
  });

  test("an unrecognized event type is rejected as \"unknown-event-type\"", () => {
    const session = armedSession();
    assertRejected(session, { type: "false-start", atMs: 0, source: "manual" }, "unknown-event-type");
  });

  test("a full accumulated race survives a burst of varied rejected attempts with zero drift", () => {
    // Builds a real multi-event session, then fires a battery of invalid
    // events at it (using structuredClone as the proof-of-immutability
    // mechanism, per the Stage 3 instruction to use snapshots/clones
    // where appropriate) and confirms the session is byte-for-byte
    // identical to the snapshot after every single one.
    let session = runningSession({ startAtMs: 0 });
    ({ session } = chronosRecordEvent(session, distanceEventInput("split", { atMs: 15000, distanceMeters: 25 })));
    ({ session } = chronosRecordEvent(session, distanceEventInput("turn", { atMs: 32000, distanceMeters: 50 })));

    const snapshot = structuredClone(session);

    const rejectedAttempts = [
      startInput({ atMs: 40000 }),
      distanceEventInput("split", { atMs: 33000, distanceMeters: 40 }), // distance-out-of-order
      distanceEventInput("split", { atMs: 32500, distanceMeters: 75 }), // too soon
      { type: "split", atMs: 40000, distanceMeters: 75, source: "manual", confidence: 0.5 }, // manual+confidence
      finishInput({ atMs: 32000, distanceMeters: 100 }) // finish before/equal previous distance event time
    ];

    for (const input of rejectedAttempts) {
      const result = chronosRecordEvent(session, input);
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}, got ok:true`);
    }

    assert.deepEqual(session, snapshot);
  });
});
