// Unit tests for src/swimmer-tracking/session.js — session creation,
// lifecycle transition legality, and target selection
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.4, §8, §9).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  TRACKING_STATUSES,
  trackingValidateSessionParams,
  trackingCreateSession,
  trackingTransition,
  trackingSelectTarget
} from "../../src/swimmer-tracking/session.js";

// ===========================================================================
// 1 — INITIAL STATE
// ===========================================================================

describe("trackingCreateSession() — initial state", () => {
  test("a new session starts in UNSELECTED", () => {
    const result = trackingCreateSession({ sessionId: "s1" });
    assert.equal(result.ok, true);
    assert.equal(result.session.status, "UNSELECTED");
  });

  test("a new session has no selection, no confirmed target, and an empty history", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });

    assert.equal(session.selection, null);
    assert.equal(session.lockEstablishedAtMs, null);
    assert.equal(session.lastConfirmedAtMs, null);
    assert.equal(session.lastConfirmedPosition, null);
    assert.equal(session.lastConfirmedVelocity, null);
    assert.deepEqual(session.observationHistory, []);
    assert.equal(session.degradedReason, null);
  });

  test("session creation is deterministic for identical params", () => {
    const a = trackingCreateSession({ sessionId: "s1" });
    const b = trackingCreateSession({ sessionId: "s1" });
    assert.deepEqual(a, b);
  });

  test("rejects missing/invalid sessionId", () => {
    for (const params of [{}, { sessionId: "" }, { sessionId: "   " }, { sessionId: 42 }, null]) {
      const result = trackingCreateSession(params);
      assert.equal(result.ok, false);
      assert.equal(result.session, null);
    }
  });

  test("TRACKING_STATUSES exposes exactly the six contracted statuses (docs/SWIMMER_TRACKING_ARCHITECTURE.md §8.2)", () => {
    assert.deepEqual(TRACKING_STATUSES, [
      "UNSELECTED", "TARGET_SELECTED", "TARGET_LOCKING", "TARGET_LOCKED", "TARGET_LOST", "ANALYSIS_DEGRADED"
    ]);
  });

  test("trackingValidateSessionParams() returns null for valid params", () => {
    assert.equal(trackingValidateSessionParams({ sessionId: "s1" }), null);
  });
});

// ===========================================================================
// 2 — TARGET SELECTION
// ===========================================================================

describe("trackingSelectTarget() — target selection", () => {
  test("a valid selection transitions UNSELECTED -> TARGET_SELECTED", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingSelectTarget(session, { atMs: 500, point: { x: 0.5, y: 0.5 } });

    assert.equal(result.ok, true);
    assert.equal(result.session.status, "TARGET_SELECTED");
  });

  test("selection does not accidentally lock the target immediately — the architecture requires observation evidence first (§10)", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingSelectTarget(session, { atMs: 500, point: { x: 0.5, y: 0.5 } });

    assert.notEqual(result.session.status, "TARGET_LOCKED");
    assert.notEqual(result.session.status, "TARGET_LOCKING");
    assert.equal(result.session.status, "TARGET_SELECTED");
  });

  test("the selection data (atMs and point) is stored exactly as supplied", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingSelectTarget(session, { atMs: 1234, point: { x: 0.25, y: 0.75 } });

    assert.deepEqual(result.session.selection, { atMs: 1234, point: { x: 0.25, y: 0.75 } });
  });

  test("point is optional — a selection with only atMs is valid, per §7.2", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingSelectTarget(session, { atMs: 1234 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.session.selection, { atMs: 1234, point: null });
  });

  test("a missing atMs is rejected deterministically", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingSelectTarget(session, { point: { x: 0.5, y: 0.5 } });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-selection");
    assert.strictEqual(result.session, session);
  });

  test("a non-finite atMs is rejected deterministically", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingSelectTarget(session, { atMs: NaN });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-selection");
  });

  test("a malformed point is rejected deterministically", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const result = trackingSelectTarget(session, { atMs: 0, point: { x: "half", y: 0.5 } });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-selection-point");
    assert.strictEqual(result.session, session);
  });

  test("selecting a target from any status other than UNSELECTED is illegal", () => {
    const { session: unselected } = trackingCreateSession({ sessionId: "s1" });
    const { session: selected } = trackingSelectTarget(unselected, { atMs: 0 });

    const result = trackingSelectTarget(selected, { atMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "illegal-transition-TARGET_SELECTED-to-TARGET_SELECTED");
  });

  test("an invalid selection attempt leaves the session completely unchanged", () => {
    const { session } = trackingCreateSession({ sessionId: "s1" });
    const before = structuredClone(session);

    trackingSelectTarget(session, { atMs: NaN });

    assert.deepEqual(session, before);
  });
});

// ===========================================================================
// STATE MACHINE — legal / illegal transitions (docs/SWIMMER_TRACKING_ARCHITECTURE.md §8.2)
// ===========================================================================

describe("trackingTransition() — legal transitions per §8.2", () => {
  const legalPairs = [
    ["UNSELECTED", "TARGET_SELECTED"],
    ["TARGET_SELECTED", "TARGET_LOCKING"],
    ["TARGET_LOCKING", "TARGET_LOCKED"],
    ["TARGET_LOCKING", "UNSELECTED"],
    ["TARGET_LOCKED", "TARGET_LOST"],
    ["TARGET_LOCKED", "ANALYSIS_DEGRADED"],
    ["TARGET_LOST", "TARGET_LOCKED"],
    ["TARGET_LOST", "ANALYSIS_DEGRADED"]
  ];

  for (const [from, to] of legalPairs) {
    test(`${from} -> ${to} is legal`, () => {
      const session = { status: from };
      const result = trackingTransition(session, to);
      assert.equal(result.ok, true);
      assert.equal(result.session.status, to);
    });
  }
});

describe("trackingTransition() — illegal transitions and terminal ANALYSIS_DEGRADED", () => {
  test("ANALYSIS_DEGRADED has no legal outgoing transition to any status", () => {
    for (const target of TRACKING_STATUSES) {
      const result = trackingTransition({ status: "ANALYSIS_DEGRADED" }, target);
      assert.equal(result.ok, false);
      assert.equal(result.reason, `illegal-transition-ANALYSIS_DEGRADED-to-${target}`);
    }
  });

  test("UNSELECTED cannot skip directly to TARGET_LOCKING, TARGET_LOCKED, TARGET_LOST, or ANALYSIS_DEGRADED", () => {
    for (const target of ["TARGET_LOCKING", "TARGET_LOCKED", "TARGET_LOST", "ANALYSIS_DEGRADED"]) {
      const result = trackingTransition({ status: "UNSELECTED" }, target);
      assert.equal(result.ok, false);
    }
  });

  test("TARGET_LOCKED cannot jump back to UNSELECTED, TARGET_SELECTED, or TARGET_LOCKING", () => {
    for (const target of ["UNSELECTED", "TARGET_SELECTED", "TARGET_LOCKING"]) {
      const result = trackingTransition({ status: "TARGET_LOCKED" }, target);
      assert.equal(result.ok, false);
    }
  });

  test("an illegal transition returns the exact original session reference, unmutated", () => {
    const session = { status: "UNSELECTED", selection: null };
    const before = structuredClone(session);

    const result = trackingTransition(session, "TARGET_LOCKED");

    assert.equal(result.ok, false);
    assert.strictEqual(result.session, session);
    assert.deepEqual(session, before);
  });

  test("an unknown target status is rejected", () => {
    const result = trackingTransition({ status: "UNSELECTED" }, "SOMETHING_ELSE");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown-target-status");
  });
});

// ===========================================================================
// 14 — SESSION ISOLATION (basic, session.js-level; fuller coverage in
// sequences.test.js exercises full observe() sequences across two sessions)
// ===========================================================================

describe("session isolation — two independently created sessions never share state", () => {
  test("two sessions with different ids are structurally independent objects", () => {
    const a = trackingCreateSession({ sessionId: "session-a" }).session;
    const b = trackingCreateSession({ sessionId: "session-b" }).session;

    assert.notEqual(a.sessionId, b.sessionId);
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.observationHistory, b.observationHistory);
  });

  test("selecting a target on one session does not affect an independently created second session", () => {
    const a = trackingCreateSession({ sessionId: "session-a" }).session;
    const b = trackingCreateSession({ sessionId: "session-b" }).session;

    const { session: selectedA } = trackingSelectTarget(a, { atMs: 0, point: { x: 0.1, y: 0.1 } });

    assert.equal(selectedA.status, "TARGET_SELECTED");
    assert.equal(b.status, "UNSELECTED");
    assert.equal(b.selection, null);
  });
});
