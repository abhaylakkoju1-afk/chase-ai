// Unit/integration tests for src/race-pipeline/pb-adapter.js (Stage 4D.8).
//
// racePipelineFindPbRecord()/racePipelineReadStoredPbs() are tested in
// isolation here. The FULL comparison-outcome matrix (faster/equal/
// slower/no-PB/incompatible-event/incompatible-course/invalid-time/
// race-not-finished) is already exhaustively covered by
// test/chronos-engine/pb-comparison.test.js against the real
// chronosComparePB() — this file does not re-test that logic. Instead,
// a small set of end-to-end tests here feed this adapter's own output
// into the REAL chronosComparePB() (never mocked) to prove the wiring
// between the two is correct, alongside dedicated tests for the
// adapter's own find/read behavior and its read-only guarantees.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineFindPbRecord,
    racePipelineReadStoredPbs,
    racePipelineFindExistingPb
} from "../../src/race-pipeline/pb-adapter.js";

import { chronosComparePB } from "../../src/chronos-engine/pb-comparison.js";

function samplePbs() {
    return [
        { event: "Freestyle 100m", course: "Short Course", time: "59.10", history: [60.2, 59.10] },
        { event: "Freestyle 100m", course: "Long Course", time: "62.40", history: [62.40] },
        { event: "Backstroke 50m", course: "Short Course", time: "28.50", history: [28.50] },
        { event: "Freestyle 200m", course: "Short Course", time: "not-a-valid-time", history: [] }
    ];
}

function finishedReport({ event = "Freestyle 100m", course = "Short Course", finalTimeMs = 58420 } = {}) {
    return { sessionId: "pb-adapter-test", event, course, poolLengthMeters: 25, strokeKey: "freestyle", distanceMeters: 100, status: "running", finalTimeMs };
}

// ===========================================================================
// 1 / 5 — EXISTING PB FOUND (MATCHING EVENT/COURSE)
// ===========================================================================

describe("racePipelineFindPbRecord() — matching event/course", () => {
    test("an exact event+course match is returned", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Short Course");
        assert.deepEqual(pb, { event: "Freestyle 100m", course: "Short Course", time: "59.10", history: [60.2, 59.10] });
    });

    test("a different course for the same event returns that OTHER course's record, not the matching one", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Long Course");
        assert.deepEqual(pb, { event: "Freestyle 100m", course: "Long Course", time: "62.40", history: [62.40] });
    });
});

// ===========================================================================
// 2 / 6 — NO PB FOUND / INCOMPATIBLE EVENT-COURSE
// ===========================================================================

describe("racePipelineFindPbRecord() — no PB / incompatible course fallback", () => {
    test("no record at all for an unrecorded event returns null", () => {
        assert.equal(racePipelineFindPbRecord(samplePbs(), "Butterfly 200m", "Short Course"), null);
    });

    test("a PB exists for the event but only under a DIFFERENT course: the mismatched record is still returned (not null) so chronosComparePB() can report incompatible-course itself", () => {
        const onlyLongCoursePbs = [{ event: "Breaststroke 100m", course: "Long Course", time: "70.00", history: [] }];
        const pb = racePipelineFindPbRecord(onlyLongCoursePbs, "Breaststroke 100m", "Short Course");
        assert.deepEqual(pb, { event: "Breaststroke 100m", course: "Long Course", time: "70.00", history: [] });
    });

    test("malformed input (non-array pbs, missing event) is handled without throwing", () => {
        assert.doesNotThrow(() => racePipelineFindPbRecord(null, "Freestyle 100m", "Short Course"));
        assert.equal(racePipelineFindPbRecord(null, "Freestyle 100m", "Short Course"), null);
        assert.equal(racePipelineFindPbRecord(samplePbs(), "", "Short Course"), null);
        assert.equal(racePipelineFindPbRecord(samplePbs(), null, "Short Course"), null);
    });
});

// ===========================================================================
// 3 / 4 / 7 / 8 / 9 / 10 / 11 / 12 — END-TO-END WIRING INTO THE REAL chronosComparePB()
// ===========================================================================

describe("adapter output fed into the real chronosComparePB() — end-to-end wiring", () => {
    test("a faster completed race against a valid PB time is parsed and compared correctly (faster, new PB)", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Short Course");
        const result = chronosComparePB(finishedReport({ finalTimeMs: 58420 }), pb); // 58.42s vs 59.10s PB

        assert.equal(result.comparable, true);
        assert.equal(result.result, "faster");
        assert.equal(result.isNewPb, true);
        assert.equal(result.existingPbTimeMs, 59100);
        assert.equal(result.deltaMs, -680);
    });

    test("an equal-time completed race reports 'equal', not a new PB", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Short Course");
        const result = chronosComparePB(finishedReport({ finalTimeMs: 59100 }), pb);

        assert.equal(result.comparable, true);
        assert.equal(result.result, "equal");
        assert.equal(result.isNewPb, false);
    });

    test("a slower completed race reports 'slower', not a new PB", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Short Course");
        const result = chronosComparePB(finishedReport({ finalTimeMs: 61000 }), pb);

        assert.equal(result.comparable, true);
        assert.equal(result.result, "slower");
        assert.equal(result.isNewPb, false);
        assert.equal(result.deltaMs, 1900);
    });

    test("no existing PB for the event is a genuine new-PB outcome, not an error", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Butterfly 200m", "Short Course");
        const result = chronosComparePB(finishedReport({ event: "Butterfly 200m", finalTimeMs: 130000 }), pb);

        assert.equal(pb, null);
        assert.equal(result.comparable, false);
        assert.equal(result.reason, "no-existing-pb");
        assert.equal(result.isNewPb, true);
        assert.equal(result.hasPb, false);
    });

    test("an incompatible-course record (adapter's own fallback) is correctly rejected by chronosComparePB(), not silently compared", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Long Course"); // real record, wrong course for this race
        const report = finishedReport({ course: "Short Course" }); // racing Short Course
        const result = chronosComparePB(report, pb);

        assert.equal(result.comparable, false);
        assert.equal(result.reason, "incompatible-course");
        assert.equal(result.hasPb, true); // a PB DID exist — just not the right one
    });

    test("an invalid/unparsable PB time is rejected safely, never silently coerced into a number", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 200m", "Short Course");
        const result = chronosComparePB(finishedReport({ event: "Freestyle 200m", finalTimeMs: 130000 }), pb);

        assert.equal(result.comparable, false);
        assert.equal(result.reason, "invalid-pb-record");
    });

    test("an unfinished race (finalTimeMs: null) is never compared as if it were a valid result", () => {
        const pb = racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Short Course");
        const result = chronosComparePB(finishedReport({ finalTimeMs: null }), pb);

        assert.equal(result.comparable, false);
        assert.equal(result.reason, "race-not-finished");
    });
});

// ===========================================================================
// racePipelineReadStoredPbs() / racePipelineFindExistingPb()
// ===========================================================================

describe("racePipelineReadStoredPbs()", () => {
    test("returns an empty array (never throws) when localStorage is unavailable — this Node test environment genuinely has none", () => {
        assert.equal(typeof localStorage, "undefined");
        assert.doesNotThrow(() => racePipelineReadStoredPbs());
        assert.deepEqual(racePipelineReadStoredPbs(), []);
    });

    test("reads and parses a real localStorage-backed pbs array when one is present", () => {
        global.localStorage = {
            store: { pbs: JSON.stringify(samplePbs()) },
            getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
            setItem(key, value) { throw new Error("racePipelineReadStoredPbs() must never call localStorage.setItem()"); }
        };
        try {
            const pbs = racePipelineReadStoredPbs();
            assert.deepEqual(pbs, samplePbs());
        } finally {
            delete global.localStorage;
        }
    });

    test("a malformed stored value (invalid JSON, or JSON that isn't an array) degrades to an empty array rather than throwing", () => {
        global.localStorage = {
            getItem() { return "{not valid json"; },
            setItem() { throw new Error("must never write"); }
        };
        try {
            assert.doesNotThrow(() => racePipelineReadStoredPbs());
            assert.deepEqual(racePipelineReadStoredPbs(), []);
        } finally {
            delete global.localStorage;
        }

        global.localStorage = {
            getItem() { return JSON.stringify({ not: "an array" }); },
            setItem() { throw new Error("must never write"); }
        };
        try {
            assert.deepEqual(racePipelineReadStoredPbs(), []);
        } finally {
            delete global.localStorage;
        }
    });

    test("racePipelineFindExistingPb() composes read + find correctly against a real localStorage-backed store", () => {
        global.localStorage = {
            getItem() { return JSON.stringify(samplePbs()); },
            setItem() { throw new Error("must never write"); }
        };
        try {
            const pb = racePipelineFindExistingPb("Backstroke 50m", "Short Course");
            assert.deepEqual(pb, { event: "Backstroke 50m", course: "Short Course", time: "28.50", history: [28.50] });
        } finally {
            delete global.localStorage;
        }
    });
});

// ===========================================================================
// 13 / 14 / 15 — READ-ONLY GUARANTEES
// ===========================================================================

describe("pb-adapter.js — read-only guarantees (Stage 4D.8's central constraint)", () => {
    test("racePipelineFindPbRecord() never mutates the pbs array or any entry within it", () => {
        const pbs = samplePbs();
        const before = structuredClone(pbs);

        racePipelineFindPbRecord(pbs, "Freestyle 100m", "Short Course");
        racePipelineFindPbRecord(pbs, "Butterfly 200m", "Long Course"); // no-match path too

        assert.deepEqual(pbs, before);
    });

    test("racePipelineReadStoredPbs()/racePipelineFindExistingPb() never call localStorage.setItem", () => {
        let setItemCalled = false;
        global.localStorage = {
            getItem() { return JSON.stringify(samplePbs()); },
            setItem() { setItemCalled = true; }
        };
        try {
            racePipelineReadStoredPbs();
            racePipelineFindExistingPb("Freestyle 100m", "Short Course");
            racePipelineFindExistingPb("Nonexistent Event 999m", "Short Course");
        } finally {
            delete global.localStorage;
        }
        assert.equal(setItemCalled, false);
    });

    test("this module never references any PB mutation function by name (savePB/editPB/deletePB) — static source check", async () => {
        const fs = await import("node:fs");
        const source = fs.readFileSync(new URL("../../src/race-pipeline/pb-adapter.js", import.meta.url), "utf8");

        // Strip block and line comments first — this file's own doc
        // comments deliberately EXPLAIN, using real call syntax like
        // "savePB()", that those functions are never called; checking the
        // raw source would false-positive on that documentation. Only
        // actual code (outside comments) is checked below.
        const codeOnly = source
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "");

        assert.equal(/\bsavePB\s*\(/.test(codeOnly), false);
        assert.equal(/\beditPB\s*\(/.test(codeOnly), false);
        assert.equal(/\bdeletePB\s*\(/.test(codeOnly), false);
        assert.equal(/localStorage\.setItem\s*\(/.test(codeOnly), false);
    });
});

// ===========================================================================
// PURITY / DETERMINISM
// ===========================================================================

describe("pb-adapter.js — purity and determinism", () => {
    test("racePipelineFindPbRecord() is deterministic: identical inputs produce identical output", () => {
        const pbs = samplePbs();
        const first = racePipelineFindPbRecord(pbs, "Freestyle 100m", "Short Course");
        const second = racePipelineFindPbRecord(pbs, "Freestyle 100m", "Short Course");
        assert.deepEqual(first, second);
    });

    test("no Date.now()/performance.now() access in racePipelineFindPbRecord()", () => {
        const originalDateNow = Date.now;
        const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

        Date.now = () => { throw new Error("pb-adapter.js must never call Date.now()"); };
        if (typeof performance !== "undefined") {
            performance.now = () => { throw new Error("pb-adapter.js must never call performance.now()"); };
        }

        try {
            racePipelineFindPbRecord(samplePbs(), "Freestyle 100m", "Short Course");
        } finally {
            Date.now = originalDateNow;
            if (typeof performance !== "undefined") {
                performance.now = originalPerformanceNow;
            }
        }
    });
});
