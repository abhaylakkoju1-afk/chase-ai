// Split / report / PB-comparison integrity (Chronos reliability phase 2).
//
// REPORT LAYER: every session here is built ONLY through
// ChronosEngine.recordEvent() (never hand-assembled), so these tests prove what
// the existing report derives from ACCEPTED events — including that rejected,
// duplicate, out-of-order or over-distance events never reach it. The report
// code itself (src/chronos-engine/report.js, pb-comparison.js) is unchanged in
// phase 2; these tests pin that it is already correct given the engine's
// guarantees. All data is synthetic.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChronosEngine } from "../../src/chronos-engine/index.js";
import { MIN_EVENT_GAP_MS } from "../../src/chronos-engine/events.js";

function session100m({ startAtMs = 6000 } = {}) {
    const created = ChronosEngine.createSession({ sessionId: "split-integrity", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 100m", strokeKey: "freestyle", distanceMeters: 100, timeSource: "video" });
    const armed = ChronosEngine.armSession(created.session).session;
    return ChronosEngine.recordEvent(armed, { type: "start", atMs: startAtMs, source: "detector", detector: "start-detector-v1", confidence: 0.8 }).session;
}

function turn(atMs, distanceMeters) {
    return { type: "turn", atMs, distanceMeters, source: "detector", detector: "turn-detector-v1", confidence: 0.7 };
}

// Applies each input; returns the final session and the per-input outcomes.
function apply(session, inputs) {
    let current = session;
    const outcomes = [];
    for (const input of inputs) {
        const result = ChronosEngine.recordEvent(current, input);
        outcomes.push({ ok: result.ok, reason: result.reason });
        if (result.ok) current = result.session;
    }
    return { session: current, outcomes };
}

function report(session) {
    const built = ChronosEngine.buildReport(session);
    assert.equal(built.ok, true);
    return built.report;
}

describe("report splits derive only from ACCEPTED events", () => {
    test("rejected turns produce no distance marker", () => {
        const { session, outcomes } = apply(session100m(), [
            turn(20000, 25), // accepted
            turn(21000, 50), // too soon
            turn(40000, 100), // at the race distance
            turn(41000, 125), // beyond it
            turn(42000, 25), // duplicate distance / too soon
            turn(NaN, 50) // invalid timestamp
        ]);
        assert.deepEqual(outcomes.map((o) => o.ok), [true, false, false, false, false, false]);
        const splits = report(session).splits;
        assert.equal(splits.length, 1);
        assert.deepEqual(splits.map((s) => s.distanceMeters), [25]);
    });

    test("a duplicate turn produces no duplicate split, even when it clears the minimum gap", () => {
        const { session } = apply(session100m(), [turn(20000, 25), turn(20000 + MIN_EVENT_GAP_MS * 4, 25)]);
        assert.equal(report(session).splits.length, 1);
    });

    test("out-of-order events cannot corrupt elapsed time: splits stay in time order with non-negative durations", () => {
        const { session } = apply(session100m(), [
            turn(40000, 50),
            turn(20000, 25), // earlier time, lower distance: out of order
            turn(60000, 75),
            turn(55000, 75), // earlier than accepted
            turn(30000, 60) // earlier than accepted
        ]);
        const splits = report(session).splits;
        assert.deepEqual(splits.map((s) => s.distanceMeters), [50, 75]);
        for (let i = 0; i < splits.length; i += 1) {
            assert.ok(splits[i].splitTimeMs > 0);
            if (i > 0) assert.ok(splits[i].cumulativeTimeMs > splits[i - 1].cumulativeTimeMs);
        }
    });

    test("cumulative distance never exceeds the configured race distance, and no 'turn' marker sits at it", () => {
        const { session } = apply(session100m(), [turn(20000, 25), turn(40000, 50), turn(60000, 75), turn(80000, 100), turn(100000, 125), turn(120000, 150)]);
        const built = report(session);
        for (const split of built.splits) {
            assert.ok(split.distanceMeters <= built.distanceMeters);
            if (split.kind === "turn") assert.ok(split.distanceMeters < built.distanceMeters);
        }
        assert.deepEqual(built.splits.map((s) => s.distanceMeters), [25, 50, 75]);
    });

    test("missing turns do not silently create synthetic splits: only what Chronos accepted appears", () => {
        // The 50 m turn was never detected.
        const { session } = apply(session100m(), [turn(20000, 25), turn(60000, 75)]);
        const splits = report(session).splits;
        assert.deepEqual(splits.map((s) => s.distanceMeters), [25, 75]);
        assert.equal(splits.length, 2);
    });

    test("end of video: turns recorded, but no finish, no final time and no completed final split", () => {
        const { session } = apply(session100m(), [turn(20000, 25), turn(40000, 50), turn(60000, 75)]);
        const built = report(session);
        assert.equal(built.status, "running");
        assert.equal(built.finish, null);
        assert.equal(built.finalTimeMs, null);
        assert.equal(built.splits.length, 3);
        assert.ok(built.splits.every((s) => s.distanceMeters < built.distanceMeters));
        assert.ok(built.dataQuality.notes.includes("no finish event recorded"));
    });
});

describe("split arithmetic is consistent with the accepted timestamps", () => {
    test("each split duration is the difference of consecutive accepted times, and the durations sum to the cumulative time", () => {
        const startAtMs = 6000;
        const times = [21000, 37000, 53500];
        const { session } = apply(session100m({ startAtMs }), times.map((t, i) => turn(t, (i + 1) * 25)));
        const splits = report(session).splits;

        let sum = 0;
        let previous = startAtMs;
        splits.forEach((split, i) => {
            assert.equal(split.cumulativeTimeMs, times[i] - startAtMs);
            assert.equal(split.splitTimeMs, times[i] - previous);
            sum += split.splitTimeMs;
            assert.equal(sum, split.cumulativeTimeMs);
            previous = times[i];
        });
    });

    test("the first split is measured from the accepted start, whatever the video time of the start", () => {
        for (const startAtMs of [0, 1234, 6000, 90000]) {
            const { session } = apply(session100m({ startAtMs }), [turn(startAtMs + 15000, 25)]);
            assert.equal(report(session).splits[0].splitTimeMs, 15000);
            assert.equal(report(session).splits[0].cumulativeTimeMs, 15000);
        }
    });

    test("a turn is reported as a turn and a checkpoint as a checkpoint; neither is relabelled", () => {
        const { session } = apply(session100m(), [turn(20000, 25), { type: "split", atMs: 30000, distanceMeters: 40, source: "manual" }]);
        assert.deepEqual(report(session).splits.map((s) => s.kind), ["turn", "checkpoint"]);
    });
});

describe("PB comparison only compares valid, comparable results", () => {
    const pb100 = { event: "Freestyle 100m", course: "Short Course", time: "1:05.00", history: [] };

    test("a race with turns but no finish has no final time, so it cannot be compared to a PB or declared a new one", () => {
        const { session } = apply(session100m(), [turn(20000, 25), turn(40000, 50), turn(60000, 75)]);
        const comparison = ChronosEngine.comparePB(report(session), pb100);
        assert.equal(comparison.comparable, false);
        assert.equal(comparison.reason, "race-not-finished");
        assert.equal(comparison.isNewPb, false);
        assert.equal(comparison.deltaMs, null);
    });

    test("with no PB on record, an unfinished race still is not a PB", () => {
        const { session } = apply(session100m(), [turn(20000, 25)]);
        const comparison = ChronosEngine.comparePB(report(session), null);
        assert.equal(comparison.isNewPb, false);
        assert.equal(comparison.comparable, false);
    });

    test("a finished race compares only against a PB for the same event and course", () => {
        const finished = apply(session100m({ startAtMs: 0 }), [turn(20000, 25), turn(40000, 50), turn(60000, 75), { type: "finish", atMs: 63000, distanceMeters: 100, source: "manual" }]);
        const built = report(finished.session);
        assert.equal(built.finalTimeMs, 63000);

        const same = ChronosEngine.comparePB(built, pb100);
        assert.equal(same.comparable, true);
        assert.equal(same.result, "faster");
        assert.equal(same.deltaMs, 63000 - 65000);

        assert.equal(ChronosEngine.comparePB(built, { ...pb100, event: "Freestyle 50m" }).reason, "incompatible-event");
        assert.equal(ChronosEngine.comparePB(built, { ...pb100, course: "Long Course" }).reason, "incompatible-course");
        assert.equal(ChronosEngine.comparePB(built, { ...pb100, time: "fast" }).reason, "invalid-pb-record");
    });

    test("rejected over-distance events cannot produce a finish, so they cannot produce a PB", () => {
        const { session, outcomes } = apply(session100m({ startAtMs: 0 }), [
            turn(20000, 25),
            { type: "finish", atMs: 30000, distanceMeters: 125, source: "manual" }, // beyond the race distance
            turn(40000, 100)
        ]);
        assert.deepEqual(outcomes.map((o) => o.ok), [true, false, false]);
        const built = report(session);
        assert.equal(built.finalTimeMs, null);
        assert.equal(ChronosEngine.comparePB(built, pb100).comparable, false);
    });
});
