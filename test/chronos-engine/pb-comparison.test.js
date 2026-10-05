// Unit tests for src/chronos-engine/pb-comparison.js — chronosComparePB():
// RaceAnalysisReport + existing PB record -> PBComparison
// (docs/CHRONOS_ARCHITECTURE.md §8, first concretely implemented in
// Stage 4D.3 — see pb-comparison.js's own header comment for the
// signature/shape refinements this implementation makes relative to
// that document's original illustrative sketch).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosComparePB } from "../../src/chronos-engine/pb-comparison.js";

function report(overrides = {}) {
  return {
    sessionId: "pb-test-race",
    event: "Freestyle 100m",
    course: "Short Course",
    finalTimeMs: 60000, // 1:00.00
    ...overrides
  };
}

function pbRecord(overrides = {}) {
  return {
    event: "Freestyle 100m",
    course: "Short Course",
    time: "1:00.00",
    history: [60],
    ...overrides
  };
}

// ===========================================================================
// 17 — FASTER THAN PB
// ===========================================================================

describe("chronosComparePB() — faster than PB", () => {
  test("a finalTimeMs below the existing PB is reported as faster, with a negative deltaMs and isNewPb:true", () => {
    const result = chronosComparePB(report({ finalTimeMs: 58500 }), pbRecord({ time: "1:00.00" }));

    assert.equal(result.comparable, true);
    assert.equal(result.result, "faster");
    assert.equal(result.deltaMs, -1500);
    assert.equal(result.isNewPb, true);
    assert.equal(result.formatted, "-1.50s vs PB");
  });
});

// ===========================================================================
// 18 — EQUAL TO PB
// ===========================================================================

describe("chronosComparePB() — equal to PB", () => {
  test("an exactly matching finalTimeMs is reported as equal, with deltaMs:0 and isNewPb:false", () => {
    const result = chronosComparePB(report({ finalTimeMs: 60000 }), pbRecord({ time: "1:00.00" }));

    assert.equal(result.comparable, true);
    assert.equal(result.result, "equal");
    assert.equal(result.deltaMs, 0);
    assert.equal(result.isNewPb, false);
    assert.equal(result.formatted, "Matches existing PB");
  });
});

// ===========================================================================
// 19 — SLOWER THAN PB
// ===========================================================================

describe("chronosComparePB() — slower than PB", () => {
  test("a finalTimeMs above the existing PB is reported as slower, with a positive deltaMs and isNewPb:false", () => {
    const result = chronosComparePB(report({ finalTimeMs: 61200 }), pbRecord({ time: "1:00.00" }));

    assert.equal(result.comparable, true);
    assert.equal(result.result, "slower");
    assert.equal(result.deltaMs, 1200);
    assert.equal(result.isNewPb, false);
    assert.equal(result.formatted, "+1.20s vs PB");
  });
});

// ===========================================================================
// 20 — COMPATIBLE EVENT/COURSE
// ===========================================================================

describe("chronosComparePB() — compatible event/course", () => {
  test("matching event and course allows a full numeric comparison", () => {
    const result = chronosComparePB(
      report({ event: "Butterfly 50m", course: "Long Course", finalTimeMs: 25000 }),
      pbRecord({ event: "Butterfly 50m", course: "Long Course", time: "26.00" })
    );

    assert.equal(result.comparable, true);
    assert.equal(result.hasPb, true);
  });
});

// ===========================================================================
// 21 — INCOMPATIBLE EVENT
// ===========================================================================

describe("chronosComparePB() — incompatible event", () => {
  test("a PB for a different event is never silently compared", () => {
    const result = chronosComparePB(
      report({ event: "Freestyle 100m" }),
      pbRecord({ event: "Backstroke 100m" })
    );

    assert.equal(result.comparable, false);
    assert.equal(result.reason, "incompatible-event");
    assert.equal(result.hasPb, true); // a PB DID exist — just not the right one
    assert.equal(result.existingPbTimeMs, null);
    assert.equal(result.deltaMs, null);
    assert.equal(result.result, null);
    assert.equal(result.isNewPb, false);
  });
});

// ===========================================================================
// 22 — INCOMPATIBLE COURSE
// ===========================================================================

describe("chronosComparePB() — incompatible course", () => {
  test("a PB for a different course is never silently compared", () => {
    const result = chronosComparePB(
      report({ course: "Short Course" }),
      pbRecord({ course: "Long Course" })
    );

    assert.equal(result.comparable, false);
    assert.equal(result.reason, "incompatible-course");
    assert.equal(result.hasPb, true);
    assert.equal(result.existingPbTimeMs, null);
  });
});

// ===========================================================================
// 23 — MISSING PB
// ===========================================================================

describe("chronosComparePB() — missing PB", () => {
  test("null pb produces a deterministic \"no existing PB\" result, treated as a first-time new PB", () => {
    const result = chronosComparePB(report(), null);

    assert.equal(result.comparable, false);
    assert.equal(result.reason, "no-existing-pb");
    assert.equal(result.hasPb, false);
    assert.equal(result.existingPbTimeMs, null);
    assert.equal(result.deltaMs, null);
    assert.equal(result.isNewPb, true); // nothing to have been slower than
    assert.equal(result.formatted, "No existing PB on record");
  });

  test("undefined pb behaves identically to null", () => {
    const withNull = chronosComparePB(report(), null);
    const withUndefined = chronosComparePB(report(), undefined);

    assert.deepEqual(withNull, withUndefined);
  });
});

// ===========================================================================
// 24 — INVALID PB
// ===========================================================================

describe("chronosComparePB() — invalid PB", () => {
  test("a pb that is not an object at all is rejected as invalid, not silently coerced", () => {
    const result = chronosComparePB(report(), "1:00.00");

    assert.equal(result.comparable, false);
    assert.equal(result.reason, "invalid-pb-record");
  });

  test("a pb object with an unparsable time string is rejected as invalid", () => {
    const result = chronosComparePB(report(), pbRecord({ time: "not-a-time" }));

    assert.equal(result.comparable, false);
    assert.equal(result.reason, "invalid-pb-record");
    assert.equal(result.existingPbTimeMs, null);
  });

  test("a pb object with a missing time field is rejected as invalid", () => {
    const result = chronosComparePB(report(), { event: "Freestyle 100m", course: "Short Course" });

    assert.equal(result.comparable, false);
    assert.equal(result.reason, "invalid-pb-record");
  });

  test("a race with no finalTimeMs (unfinished) is reported as unavailable, never compared", () => {
    const result = chronosComparePB(report({ finalTimeMs: null }), pbRecord());

    assert.equal(result.comparable, false);
    assert.equal(result.reason, "race-not-finished");
    assert.equal(result.hasPb, true);
  });

  test("PB time parsing supports ss.ss, mm:ss.ss, and h:mm:ss.ss formats", () => {
    assert.equal(chronosComparePB(report({ finalTimeMs: 0 }), pbRecord({ time: "28.50" })).existingPbTimeMs, 28500);
    assert.equal(chronosComparePB(report({ finalTimeMs: 0 }), pbRecord({ time: "1:52.23" })).existingPbTimeMs, 112230);
    assert.equal(chronosComparePB(report({ finalTimeMs: 0 }), pbRecord({ time: "1:15:20.48" })).existingPbTimeMs, 4520480);
  });
});

// ===========================================================================
// 25 — DETERMINISTIC OUTPUT
// ===========================================================================

describe("chronosComparePB() — deterministic output", () => {
  test("identical inputs produce identical output across repeated calls", () => {
    const r = report({ finalTimeMs: 59000 });
    const pb = pbRecord({ time: "1:00.00" });

    const first = chronosComparePB(r, pb);
    const second = chronosComparePB(r, pb);

    assert.deepEqual(first, second);
  });

  test("no randomness, wall-clock, or environment dependence across many fixtures", () => {
    const fixtures = [
      [report({ finalTimeMs: 30000 }), pbRecord({ time: "30.00" })],
      [report({ finalTimeMs: 29999 }), pbRecord({ time: "30.00" })],
      [report({ finalTimeMs: 30001 }), pbRecord({ time: "30.00" })]
    ];

    for (const [r, pb] of fixtures) {
      const a = chronosComparePB(r, pb);
      const b = chronosComparePB(r, pb);
      assert.deepEqual(a, b);
    }
  });
});

// ===========================================================================
// 26 — COMPARISON DOES NOT MUTATE PB
// ===========================================================================

describe("chronosComparePB() — does not mutate its inputs", () => {
  test("the pb record is byte-for-byte unchanged after comparison", () => {
    const pb = pbRecord({ history: [61, 60.5, 60] });
    const pbBefore = structuredClone(pb);

    chronosComparePB(report({ finalTimeMs: 59000 }), pb);

    assert.deepEqual(pb, pbBefore);
  });

  test("the report is byte-for-byte unchanged after comparison", () => {
    const r = report({ finalTimeMs: 59000 });
    const rBefore = structuredClone(r);

    chronosComparePB(r, pbRecord());

    assert.deepEqual(r, rBefore);
  });
});

// ===========================================================================
// 27 — NO LOCALSTORAGE / BROWSER DEPENDENCY
// ===========================================================================

describe("chronosComparePB() — no localStorage/browser dependency", () => {
  test("runs correctly with localStorage undefined (this Node test environment genuinely has none)", () => {
    assert.equal(typeof localStorage, "undefined");

    const result = chronosComparePB(report({ finalTimeMs: 59000 }), pbRecord());
    assert.equal(result.comparable, true);
  });

  test("no wall-clock access: Date.now()/performance.now() patched to throw across a full comparison call", () => {
    const originalDateNow = Date.now;
    const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

    Date.now = () => { throw new Error("pb-comparison.js must never call Date.now()"); };
    if (typeof performance !== "undefined") {
      performance.now = () => { throw new Error("pb-comparison.js must never call performance.now()"); };
    }

    try {
      const result = chronosComparePB(report({ finalTimeMs: 59000 }), pbRecord());
      assert.equal(result.comparable, true);
    } finally {
      Date.now = originalDateNow;
      if (typeof performance !== "undefined") {
        performance.now = originalPerformanceNow;
      }
    }
  });
});
