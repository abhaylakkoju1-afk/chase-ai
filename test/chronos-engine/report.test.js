// Unit tests for src/chronos-engine/report.js — chronosBuildReport():
// RaceSession -> RaceAnalysisReport (docs/CHRONOS_ARCHITECTURE.md §7,
// first concretely implemented in Stage 4D.3 — see report.js's own
// header comment for the additive refinements/omissions this
// implementation makes relative to that document's original
// illustrative sketch).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosCreateSession, chronosArmSession } from "../../src/chronos-engine/session.js";
import { chronosRecordEvent } from "../../src/chronos-engine/events.js";
import { chronosBuildReport } from "../../src/chronos-engine/report.js";

// ---------------------------------------------------------------------
// Fixtures — real Chronos sessions built through the actual public
// functions, mirroring the fixture-replay convention already
// established in this file's sibling tests (session.test.js,
// events.test.js, sequences.test.js).
// ---------------------------------------------------------------------

function baseSessionParams(overrides = {}) {
  return {
    sessionId: "report-test-race",
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 100m",
    timeSource: "video",
    ...overrides
  };
}

function newArmedSession(overrides = {}) {
  const created = chronosCreateSession(baseSessionParams(overrides));
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

function manualEvent(type, atMs, distanceMeters) {
  const input = { type, atMs, source: "manual" };
  if (distanceMeters !== undefined) input.distanceMeters = distanceMeters;
  return input;
}

function detectorEvent(type, atMs, distanceMeters, { confidence = 0.8, detector = "turn-detector-v1" } = {}) {
  return { type, atMs, distanceMeters, source: "detector", detector, confidence };
}

// A fully completed race: manual start, one detector turn, one manual
// split, one detector finish — deliberately mixing sources so every
// provenance-related assertion has real, varied data to check.
function completedRaceSession() {
  let session = newArmedSession();
  session = record(session, manualEvent("start", 0));
  session = record(session, detectorEvent("turn", 15000, 25, { confidence: 0.85, detector: "turn-detector-v1" }));
  session = record(session, manualEvent("split", 32000, 50));
  session = record(session, detectorEvent("finish", 60000, 100, { confidence: 0.9, detector: "finish-detector-v1" }));
  return session;
}

// ===========================================================================
// 1 — MINIMAL VALID COMPLETED RACE
// ===========================================================================

describe("chronosBuildReport() — minimal valid completed race", () => {
  test("a start + finish only race produces a complete, correct report", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, manualEvent("finish", 30000, 50));

    const result = chronosBuildReport(session);

    assert.equal(result.ok, true);
    assert.equal(result.report.sessionId, "report-test-race");
    assert.equal(result.report.event, "Freestyle 100m");
    assert.equal(result.report.course, "Short Course");
    assert.equal(result.report.poolLengthMeters, 25);
    assert.equal(result.report.status, "finished");
    assert.equal(result.report.finalTimeMs, 30000);
    assert.deepEqual(result.report.splits, []);
  });
});

// ===========================================================================
// 2 — START + TURN + FINISH
// ===========================================================================

describe("chronosBuildReport() — start + turn + finish", () => {
  test("all three event summaries are populated and internally consistent", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, detectorEvent("turn", 15000, 25));
    session = record(session, manualEvent("finish", 30000, 50));

    const { report } = chronosBuildReport(session);

    assert.notEqual(report.start, null);
    assert.equal(report.start.atMs, 0);
    assert.equal(report.splits.length, 1);
    assert.equal(report.splits[0].kind, "turn");
    assert.notEqual(report.finish, null);
    assert.equal(report.finish.atMs, 30000);
    assert.equal(report.finalTimeMs, 30000);
  });
});

// ===========================================================================
// 3 — MULTIPLE TURNS
// ===========================================================================

describe("chronosBuildReport() — multiple turns", () => {
  test("every accepted turn appears as its own split entry, in order", () => {
    const session = completedRaceSession();
    const { report } = chronosBuildReport(session);

    const turnKinds = report.splits.filter((s) => s.kind === "turn");
    assert.equal(turnKinds.length, 1); // completedRaceSession has 1 turn + 1 split
    assert.equal(report.splits.length, 2);
  });

  test("three turns in one race all appear, each with correct cumulative distance", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, detectorEvent("turn", 15000, 25));
    session = record(session, detectorEvent("turn", 32000, 50));
    session = record(session, detectorEvent("turn", 50000, 75));
    session = record(session, manualEvent("finish", 65000, 100));

    const { report } = chronosBuildReport(session);

    assert.equal(report.splits.length, 3);
    assert.deepEqual(report.splits.map((s) => s.distanceMeters), [25, 50, 75]);
    assert.ok(report.splits.every((s) => s.kind === "turn"));
  });
});

// ===========================================================================
// 4 / 5 — CHECKPOINT SPLIT vs. TURN KIND
// ===========================================================================

describe("chronosBuildReport() — split (checkpoint) vs. turn kind distinction", () => {
  test("a \"split\" TimingEvent is reported with kind:\"checkpoint\"", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, manualEvent("split", 15000, 25));
    session = record(session, manualEvent("finish", 30000, 50));

    const { report } = chronosBuildReport(session);

    assert.equal(report.splits.length, 1);
    assert.equal(report.splits[0].kind, "checkpoint");
  });

  test("a \"turn\" TimingEvent is reported with kind:\"turn\", never relabeled as a generic checkpoint", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, detectorEvent("turn", 15000, 25));
    session = record(session, manualEvent("finish", 30000, 50));

    const { report } = chronosBuildReport(session);

    assert.equal(report.splits[0].kind, "turn");
    assert.notEqual(report.splits[0].kind, "checkpoint");
  });

  test("a mixed split+turn race keeps both kinds distinguishable in the same splits array", () => {
    const session = completedRaceSession(); // 1 turn (detector) + 1 split (manual)
    const { report } = chronosBuildReport(session);

    assert.deepEqual(report.splits.map((s) => s.kind), ["turn", "checkpoint"]);
  });
});

// ===========================================================================
// 6 — EVENT ORDERING
// ===========================================================================

describe("chronosBuildReport() — event ordering", () => {
  test("splits are reported in exactly the order they appear in session.events, never re-sorted", () => {
    const session = completedRaceSession();
    const { report } = chronosBuildReport(session);

    assert.deepEqual(report.splits.map((s) => s.distanceMeters), [25, 50]);
    assert.equal(report.splits[0].index, 0);
    assert.equal(report.splits[1].index, 1);
  });
});

// ===========================================================================
// 7 — TIMING INTERVAL CALCULATIONS
// ===========================================================================

describe("chronosBuildReport() — timing interval calculations", () => {
  test("splitTimeMs is the delta from the previous split (or start, for the first); cumulativeTimeMs is always from start", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 1000));
    session = record(session, detectorEvent("turn", 16000, 25)); // +15000 from start
    session = record(session, detectorEvent("turn", 34000, 50)); // +18000 from previous split
    session = record(session, manualEvent("finish", 61000, 100));

    const { report } = chronosBuildReport(session);

    assert.equal(report.splits[0].splitTimeMs, 15000);
    assert.equal(report.splits[0].cumulativeTimeMs, 15000);

    assert.equal(report.splits[1].splitTimeMs, 18000);
    assert.equal(report.splits[1].cumulativeTimeMs, 33000);

    assert.equal(report.finalTimeMs, 60000); // 61000 - 1000, exactly session.finalTimeMs
  });

  test("without a recorded start, splitTimeMs/cumulativeTimeMs are null rather than guessed", () => {
    // A session with no start recorded has no legal way to reach
    // "running", so splits/finish cannot exist either — this test
    // documents that an idle/armed session's (nonexistent) splits array
    // is simply empty, not that timing fields are ever fabricated.
    const session = newArmedSession();
    const { report } = chronosBuildReport(session);

    assert.deepEqual(report.splits, []);
    assert.equal(report.start, null);
  });
});

// ===========================================================================
// 8 — DISTANCE-BEARING EVENTS
// ===========================================================================

describe("chronosBuildReport() — distance-bearing events", () => {
  test("each split's distanceMeters is exactly the TimingEvent's own distanceMeters, never recomputed", () => {
    const session = completedRaceSession();
    const { report } = chronosBuildReport(session);

    assert.equal(report.splits[0].distanceMeters, 25);
    assert.equal(report.splits[1].distanceMeters, 50);
  });

  test("finish's distanceMeters is exposed via report.finish, not fabricated from poolLengthMeters", () => {
    const session = completedRaceSession();
    const { report } = chronosBuildReport(session);

    assert.equal(report.finish.distanceMeters, 100);
  });

  test("start's distanceMeters (implicitly 0, per Chronos's own contract) is exposed via report.start", () => {
    const session = completedRaceSession();
    const { report } = chronosBuildReport(session);

    assert.equal(report.start.distanceMeters, 0);
  });
});

// ===========================================================================
// 9 — MANUAL EVENT PROVENANCE
// ===========================================================================

describe("chronosBuildReport() — manual event provenance", () => {
  test("a manual event's source is \"manual\" with detector/confidence null throughout", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, manualEvent("split", 15000, 25));
    session = record(session, manualEvent("finish", 30000, 50));

    const { report } = chronosBuildReport(session);

    assert.equal(report.start.source, "manual");
    assert.equal(report.start.detector, null);
    assert.equal(report.start.confidence, null);

    assert.equal(report.splits[0].source, "manual");
    assert.equal(report.splits[0].detector, null);
    assert.equal(report.splits[0].confidence, null);

    assert.equal(report.finish.source, "manual");
  });

  test("dataQuality.manualEventCount counts exactly the manual events", () => {
    const session = completedRaceSession(); // manual start + manual split = 2 manual
    const { report } = chronosBuildReport(session);

    assert.equal(report.dataQuality.manualEventCount, 2);
  });
});

// ===========================================================================
// 10 — DETECTOR EVENT PROVENANCE / CONFIDENCE
// ===========================================================================

describe("chronosBuildReport() — detector event provenance/confidence", () => {
  test("a detector event's source, detector name, and confidence are all preserved exactly", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, detectorEvent("turn", 15000, 25, { confidence: 0.73, detector: "turn-detector-v1" }));
    session = record(session, manualEvent("finish", 30000, 50));

    const { report } = chronosBuildReport(session);

    assert.equal(report.splits[0].source, "detector");
    assert.equal(report.splits[0].detector, "turn-detector-v1");
    assert.equal(report.splits[0].confidence, 0.73);
  });

  test("dataQuality.detectorEventCount and lowConfidenceEventCount are computed correctly against the (documented, provisional) threshold", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, detectorEvent("turn", 15000, 25, { confidence: 0.9 })); // above default 0.5 threshold
    session = record(session, detectorEvent("turn", 32000, 50, { confidence: 0.2 })); // below default 0.5 threshold
    session = record(session, manualEvent("finish", 60000, 100));

    const { report } = chronosBuildReport(session);

    assert.equal(report.dataQuality.detectorEventCount, 2);
    assert.equal(report.dataQuality.lowConfidenceEventCount, 1);
    assert.ok(report.dataQuality.notes.some((note) => note.includes("below the confidence threshold")));
  });

  test("the low-confidence threshold is explicitly configurable, not hardcoded", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, detectorEvent("turn", 15000, 25, { confidence: 0.6 }));
    session = record(session, manualEvent("finish", 30000, 50));

    const defaultResult = chronosBuildReport(session);
    assert.equal(defaultResult.report.dataQuality.lowConfidenceEventCount, 0); // 0.6 is not below default 0.5

    const strictResult = chronosBuildReport(session, { lowConfidenceThreshold: 0.7 });
    assert.equal(strictResult.report.dataQuality.lowConfidenceEventCount, 1); // 0.6 IS below 0.7
    assert.equal(strictResult.report.dataQuality.lowConfidenceThreshold, 0.7);
  });
});

// ===========================================================================
// 11 / 12 / 13 / 14 — INCOMPLETE SESSIONS
// ===========================================================================

describe("chronosBuildReport() — incomplete sessions", () => {
  test("an idle session (no events at all) produces a valid, empty report — never a rejection", () => {
    const { session } = chronosCreateSession(baseSessionParams());
    const result = chronosBuildReport(session);

    assert.equal(result.ok, true);
    assert.equal(result.report.status, "idle");
    assert.equal(result.report.start, null);
    assert.equal(result.report.finish, null);
    assert.equal(result.report.finalTimeMs, null);
    assert.deepEqual(result.report.splits, []);
  });

  test("missing finish: a running session with start+turns but no finish reports finalTimeMs:null, never a fabricated value", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, detectorEvent("turn", 15000, 25));

    const { report } = chronosBuildReport(session);

    assert.equal(report.status, "running");
    assert.equal(report.finish, null);
    assert.equal(report.finalTimeMs, null);
    assert.equal(report.splits.length, 1);
    assert.ok(report.dataQuality.notes.includes("no finish event recorded"));
  });

  test("missing turns: a race with only start+finish reports an empty splits array, never a synthesized split", () => {
    let session = newArmedSession();
    session = record(session, manualEvent("start", 0));
    session = record(session, manualEvent("finish", 30000, 50));

    const { report } = chronosBuildReport(session);

    assert.deepEqual(report.splits, []);
    assert.equal(report.finalTimeMs, 30000);
  });

  test("empty events array (armed, not yet started) produces a report with every event-derived field null/empty", () => {
    const session = newArmedSession();
    const { report } = chronosBuildReport(session);

    assert.equal(report.status, "armed");
    assert.deepEqual(report.splits, []);
    assert.equal(report.start, null);
    assert.equal(report.finish, null);
    assert.equal(report.finalTimeMs, null);
    assert.equal(report.dataQuality.totalEvents, 0);
  });
});

// ===========================================================================
// 15 — INVALID / IMPOSSIBLE REPORT INPUT
// ===========================================================================

describe("chronosBuildReport() — invalid input", () => {
  test("null session is rejected deterministically, not thrown", () => {
    const result = chronosBuildReport(null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-session");
    assert.equal(result.report, null);
  });

  test("a non-object session is rejected", () => {
    assert.equal(chronosBuildReport("not a session").ok, false);
    assert.equal(chronosBuildReport(42).ok, false);
    assert.equal(chronosBuildReport(undefined).ok, false);
  });

  test("a session-shaped object missing the events array is rejected rather than crashing", () => {
    const result = chronosBuildReport({ sessionId: "x", status: "idle" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-session");
  });
});

// ===========================================================================
// 16 — REPORT DOES NOT MUTATE THE INPUT SESSION
// ===========================================================================

describe("chronosBuildReport() — does not mutate its input", () => {
  test("the session object and its events array are byte-for-byte unchanged after report generation", () => {
    const session = completedRaceSession();
    const before = structuredClone(session);

    chronosBuildReport(session);

    assert.deepEqual(session, before);
  });

  test("repeated calls against the same session produce identical reports (determinism)", () => {
    const session = completedRaceSession();

    const first = chronosBuildReport(session);
    const second = chronosBuildReport(session);

    assert.deepEqual(first, second);
  });

  test("mutating a returned report does not affect a session's own events array (no shared references)", () => {
    const session = completedRaceSession();
    const { report } = chronosBuildReport(session);

    report.splits.push({ fabricated: true });

    const { report: freshReport } = chronosBuildReport(session);
    assert.equal(freshReport.splits.length, 2); // unaffected by the mutation above
  });
});
