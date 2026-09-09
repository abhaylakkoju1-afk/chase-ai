// Unit tests for src/chronos-engine/session.js — RaceSession creation and
// the Chronos lifecycle state machine (docs/CHRONOS_ARCHITECTURE.md §5,
// §9). Also covers the public window.ChronosEngine surface exposed by
// src/chronos-engine/index.js (§18), since that surface is thin enough
// (a straight re-export of session.js/events.js functions) that it does
// not warrant its own file.
//
// Chronos's session/events/time-basis modules are real ES modules (this
// repo's package.json already declares "type": "module"), so they are
// imported directly — no vm-sandbox extraction harness, unlike the
// src/chase-engine/* tests, which exist only because that code is still
// trapped inside index.html.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_STATUSES,
  TIME_SOURCES,
  chronosValidateSessionParams,
  chronosCreateSession,
  chronosTransition,
  chronosArmSession,
  chronosAbortSession
} from "../../src/chronos-engine/session.js";

import { chronosRecordEvent } from "../../src/chronos-engine/events.js";

import ChronosEngine, {
  ChronosEngine as ChronosEngineNamed
} from "../../src/chronos-engine/index.js";

function validSessionParams(overrides = {}) {
  return {
    sessionId: "session-test-race",
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 100m",
    timeSource: "video",
    ...overrides
  };
}

describe("chronosCreateSession() — valid creation", () => {
  test("creates a session in \"idle\" status with an empty event log", () => {
    const result = chronosCreateSession(validSessionParams());

    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.equal(result.session.status, "idle");
    assert.deepEqual(result.session.events, []);
    assert.equal(result.session.finalTimeMs, null);
  });

  test("stores every required and optional field exactly as supplied", () => {
    const result = chronosCreateSession(
      validSessionParams({
        sessionId: "race-42",
        createdAtMs: 1000,
        event: "Backstroke 200m",
        strokeKey: "backstroke",
        distanceMeters: 200,
        course: "Long Course",
        poolLengthMeters: 50,
        timeSource: "wallclock"
      })
    );

    assert.equal(result.ok, true);
    assert.equal(result.session.sessionId, "race-42");
    assert.equal(result.session.createdAtMs, 1000);
    assert.equal(result.session.event, "Backstroke 200m");
    assert.equal(result.session.strokeKey, "backstroke");
    assert.equal(result.session.distanceMeters, 200);
    assert.equal(result.session.course, "Long Course");
    assert.equal(result.session.poolLengthMeters, 50);
    assert.equal(result.session.timeSource, "wallclock");
  });

  test("optional fields (strokeKey, distanceMeters, createdAtMs) default to null when omitted", () => {
    const result = chronosCreateSession(validSessionParams());

    assert.equal(result.session.strokeKey, null);
    assert.equal(result.session.distanceMeters, null);
    assert.equal(result.session.createdAtMs, null);
  });

  test("SESSION_STATUSES and TIME_SOURCES expose the exact contracted vocabularies", () => {
    assert.deepEqual(SESSION_STATUSES, ["idle", "armed", "running", "finished", "aborted"]);
    assert.deepEqual(TIME_SOURCES, ["video", "manual", "wallclock"]);
  });
});

describe("chronosValidateSessionParams() / chronosCreateSession() — required parameter validation", () => {
  const cases = [
    ["missing sessionId", { sessionId: undefined }, "missing-session-id"],
    ["empty sessionId", { sessionId: "   " }, "missing-session-id"],
    ["non-string sessionId", { sessionId: 42 }, "missing-session-id"],
    ["missing poolLengthMeters", { poolLengthMeters: undefined }, "invalid-pool-length-meters"],
    ["zero poolLengthMeters", { poolLengthMeters: 0 }, "invalid-pool-length-meters"],
    ["negative poolLengthMeters", { poolLengthMeters: -25 }, "invalid-pool-length-meters"],
    ["non-finite poolLengthMeters", { poolLengthMeters: Infinity }, "invalid-pool-length-meters"],
    ["non-number poolLengthMeters", { poolLengthMeters: "25" }, "invalid-pool-length-meters"],
    ["missing course", { course: undefined }, "missing-course"],
    ["empty course", { course: "" }, "missing-course"],
    ["missing event", { event: undefined }, "missing-event"],
    ["empty event", { event: "  " }, "missing-event"],
    ["missing timeSource", { timeSource: undefined }, "invalid-time-source"],
    ["unknown timeSource", { timeSource: "webcam" }, "invalid-time-source"]
  ];

  for (const [label, overrides, expectedReason] of cases) {
    test(`rejects ${label}`, () => {
      const result = chronosCreateSession(validSessionParams(overrides));
      assert.equal(result.ok, false);
      assert.equal(result.reason, expectedReason);
      assert.equal(result.session, null);
    });
  }

  test("chronosValidateSessionParams() returns null for fully valid params", () => {
    assert.equal(chronosValidateSessionParams(validSessionParams()), null);
  });

  test("rejects a non-object params argument", () => {
    const result = chronosCreateSession(null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-params");
  });
});

describe("chronosCreateSession() — optional parameter validation", () => {
  test("rejects a non-string, non-null strokeKey", () => {
    const result = chronosCreateSession(validSessionParams({ strokeKey: 7 }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-stroke-key");
  });

  test("rejects a non-positive distanceMeters", () => {
    const result = chronosCreateSession(validSessionParams({ distanceMeters: -1 }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-distance-meters");
  });

  test("rejects a non-finite createdAtMs", () => {
    const result = chronosCreateSession(validSessionParams({ createdAtMs: NaN }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-created-at-ms");
  });

  test("accepts an explicit null for every optional field", () => {
    const result = chronosCreateSession(
      validSessionParams({ strokeKey: null, distanceMeters: null, createdAtMs: null })
    );
    assert.equal(result.ok, true);
  });
});

describe("session lifecycle — legal transitions", () => {
  test("idle -> armed via chronosArmSession()", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const armed = chronosArmSession(session);

    assert.equal(armed.ok, true);
    assert.equal(armed.session.status, "armed");
  });

  test("armed -> running only through a valid \"start\" event, never a bare transition", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const { session: armed } = chronosArmSession(session);

    const started = chronosRecordEvent(armed, { type: "start", atMs: 0, source: "manual" });

    assert.equal(started.ok, true);
    assert.equal(started.session.status, "running");
    assert.equal(started.session.events.length, 1);
    assert.equal(started.session.events[0].type, "start");
  });

  test("running -> finished only through a valid \"finish\" event", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const { session: armed } = chronosArmSession(session);
    const { session: running } = chronosRecordEvent(armed, { type: "start", atMs: 0, source: "manual" });

    const finished = chronosRecordEvent(running, {
      type: "finish",
      atMs: 60000,
      distanceMeters: 100,
      source: "manual"
    });

    assert.equal(finished.ok, true);
    assert.equal(finished.session.status, "finished");
    assert.equal(finished.session.finalTimeMs, 60000);
  });

  test("idle -> aborted", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const aborted = chronosAbortSession(session);

    assert.equal(aborted.ok, true);
    assert.equal(aborted.session.status, "aborted");
  });

  test("armed -> aborted", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const { session: armed } = chronosArmSession(session);
    const aborted = chronosAbortSession(armed);

    assert.equal(aborted.ok, true);
    assert.equal(aborted.session.status, "aborted");
  });

  test("running -> aborted", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const { session: armed } = chronosArmSession(session);
    const { session: running } = chronosRecordEvent(armed, { type: "start", atMs: 0, source: "manual" });
    const aborted = chronosAbortSession(running);

    assert.equal(aborted.ok, true);
    assert.equal(aborted.session.status, "aborted");
    // Abort is a pure status change — it does not erase the events already
    // recorded before the abort (docs/CHRONOS_ARCHITECTURE.md §9).
    assert.equal(aborted.session.events.length, 1);
  });
});

describe("session lifecycle — illegal transitions", () => {
  const illegalFromIdle = ["running", "finished"];
  const illegalFromArmed = ["idle", "finished"];
  const illegalFromRunning = ["idle", "armed"];
  const illegalFromTerminal = ["idle", "armed", "running", "finished", "aborted"];

  test("idle cannot jump directly to running or finished", () => {
    const { session } = chronosCreateSession(validSessionParams());

    for (const target of illegalFromIdle) {
      const result = chronosTransition(session, target);
      assert.equal(result.ok, false);
      assert.equal(result.reason, `illegal-transition-idle-to-${target}`);
    }
  });

  test("armed cannot jump to idle or finished", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const { session: armed } = chronosArmSession(session);

    for (const target of illegalFromArmed) {
      const result = chronosTransition(armed, target);
      assert.equal(result.ok, false);
      assert.equal(result.reason, `illegal-transition-armed-to-${target}`);
    }
  });

  test("running cannot jump back to idle or armed", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const { session: armed } = chronosArmSession(session);
    const { session: running } = chronosRecordEvent(armed, { type: "start", atMs: 0, source: "manual" });

    for (const target of illegalFromRunning) {
      const result = chronosTransition(running, target);
      assert.equal(result.ok, false);
      assert.equal(result.reason, `illegal-transition-running-to-${target}`);
    }
  });

  test("finished and aborted are terminal — no transition out is legal", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const { session: armed } = chronosArmSession(session);
    const { session: running } = chronosRecordEvent(armed, { type: "start", atMs: 0, source: "manual" });
    const { session: finished } = chronosRecordEvent(running, {
      type: "finish",
      atMs: 1000,
      distanceMeters: 25,
      source: "manual"
    });
    const { session: aborted } = chronosAbortSession(armed);

    for (const target of illegalFromTerminal) {
      assert.equal(chronosTransition(finished, target).ok, false);
      assert.equal(chronosTransition(aborted, target).ok, false);
    }
  });

  test("an illegal transition returns the exact original session, unmutated", () => {
    const { session } = chronosCreateSession(validSessionParams());
    const before = structuredClone(session);

    const result = chronosTransition(session, "running");

    assert.equal(result.ok, false);
    assert.strictEqual(result.session, session);
    assert.deepEqual(session, before);
  });

  test("an unknown target status is rejected without mutation", () => {
    const { session } = chronosCreateSession(validSessionParams());

    const result = chronosTransition(session, "cancelled");

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown-target-status");
    assert.strictEqual(result.session, session);
  });
});

describe("public API surface — window.ChronosEngine (src/chronos-engine/index.js)", () => {
  test("exposes exactly the intended methods — no getSession, no raw transition", () => {
    const exposedNames = Object.keys(ChronosEngine).sort();
    assert.deepEqual(exposedNames, ["abortSession", "armSession", "createSession", "recordEvent"]);
    assert.equal(ChronosEngine.getSession, undefined);
    assert.equal(ChronosEngine.transition, undefined);
  });

  test("the default export and the named export are the same object", () => {
    assert.strictEqual(ChronosEngine, ChronosEngineNamed);
  });

  test("does not throw or require window/document to be defined at import time", () => {
    // This test file is running under plain Node, which has neither
    // `window` nor `document` — successfully reaching this assertion
    // after importing src/chronos-engine/index.js already proves the
    // module tolerates their absence (docs/CHRONOS_ARCHITECTURE.md §18's
    // `if (typeof window !== "undefined")` guard did its job).
    assert.equal(typeof window, "undefined");
    assert.equal(typeof document, "undefined");
  });

  test("ChronosEngine.createSession()/armSession()/recordEvent()/abortSession() behave identically to the direct module functions", () => {
    const viaEngine = ChronosEngine.createSession(validSessionParams({ sessionId: "via-engine" }));
    const viaModule = chronosCreateSession(validSessionParams({ sessionId: "via-engine" }));
    assert.deepEqual(viaEngine, viaModule);

    const armedViaEngine = ChronosEngine.armSession(viaEngine.session);
    const armedViaModule = chronosArmSession(viaModule.session);
    assert.deepEqual(armedViaEngine, armedViaModule);

    const startedViaEngine = ChronosEngine.recordEvent(armedViaEngine.session, {
      type: "start",
      atMs: 0,
      source: "manual"
    });
    const startedViaModule = chronosRecordEvent(armedViaModule.session, {
      type: "start",
      atMs: 0,
      source: "manual"
    });
    assert.deepEqual(startedViaEngine, startedViaModule);

    const abortedViaEngine = ChronosEngine.abortSession(startedViaEngine.session);
    const abortedViaModule = chronosAbortSession(startedViaModule.session);
    assert.deepEqual(abortedViaEngine, abortedViaModule);
  });
});
