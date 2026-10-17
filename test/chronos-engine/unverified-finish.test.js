// Report and PB integrity for a finish with UNCONFIRMED distance progression
// (Chronos reliability phase 2C follow-up).
//
// A finish records a TIME. When the race's distance progression is unconfirmed,
// that time is still recorded exactly, but nothing verifies that the swimmer
// covered the race distance, so (1) the report says so in a data-quality note,
// keeping the CONFIGURED distance distinct from the distance actually
// established by accepted turn/split events, and (2) chronosComparePB() declines
// to compare it ("distance-unconfirmed") — not even to call it a first PB.
//
// Engine + report + PB layer; sessions are built only through the public
// ChronosEngine API (plus the pipeline for the integration cases). All data is
// synthetic. Finish-distance equality is deliberately NOT enforced here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChronosEngine } from "../../src/chronos-engine/index.js";
import { racePath, sampleRace, raceConfig, runRace } from "../race-pipeline/synthetic-race.js";

const PB = { event: "Freestyle 100m", course: "Short Course", time: "1:30.00", history: [] }; // 90,000 ms

function runningSession(startAtMs = 1000) {
    const created = ChronosEngine.createSession({ sessionId: "unverified-finish", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 100m", distanceMeters: 100, timeSource: "video" });
    const armed = ChronosEngine.armSession(created.session).session;
    return ChronosEngine.recordEvent(armed, { type: "start", atMs: startAtMs, source: "detector", detector: "start-detector-v1", confidence: 0.8 }).session;
}

const turn = (atMs, distanceMeters, source = "detector") =>
    source === "detector"
        ? { type: "turn", atMs, distanceMeters, source, detector: "turn-detector-v1", confidence: 0.7 }
        : { type: "turn", atMs, distanceMeters, source };

function mark(session, sinceAtMs, reason = "possible-missed-turn-during-tracking-gap-near-wall") {
    return ChronosEngine.markDistanceUnconfirmed(session, { reason, sinceAtMs, resumedAtMs: null }).session;
}

const record = (session, input) => {
    const result = ChronosEngine.recordEvent(session, input);
    assert.equal(result.ok, true, `${input.type} must be accepted: ${result.reason}`);
    return result.session;
};

// 1000 start; trusted turn at 25 m (20,000); distance unconfirmed from 21,000; manual finish at 86,000.
function unconfirmedFinished() {
    let session = runningSession(1000);
    session = record(session, turn(20000, 25));
    session = mark(session, 21000);
    return record(session, { type: "finish", atMs: 86000, distanceMeters: 100, source: "manual" });
}

const report = (session) => ChronosEngine.buildReport(session).report;

// ===========================================================================
// REPORT
// ===========================================================================

describe("report: a finish with unconfirmed distance keeps its exact time and says the distance is unverified", () => {
    test("the finish timestamp and final time are exactly as recorded", () => {
        const built = report(unconfirmedFinished());
        assert.equal(built.status, "finished");
        assert.equal(built.finish.atMs, 86000);
        assert.equal(built.finalTimeMs, 85000);
        assert.equal(built.finish.source, "manual");
        assert.equal(built.finish.detector, null);
        assert.equal(built.finish.confidence, null);
    });

    test("it carries an explicit note: finish time recorded, distance sequence unverified (with the reason)", () => {
        const notes = report(unconfirmedFinished()).dataQuality.notes;
        const note = notes.find((n) => n.startsWith("finish time recorded"));
        assert.ok(note, JSON.stringify(notes));
        assert.ok(note.includes("finish at 86000ms") && note.includes("final time 85000ms"));
        assert.ok(note.includes("distance sequence is unverified"));
        assert.ok(note.includes("possible-missed-turn-during-tracking-gap-near-wall"));
    });

    test("notes are not duplicated or overwritten: the earlier unconfirmed note and the finish note each appear exactly once; 'no finish' is absent", () => {
        const notes = report(unconfirmedFinished()).dataQuality.notes;
        assert.equal(notes.filter((n) => n.startsWith("distance progression unconfirmed after 21000ms")).length, 1);
        assert.equal(notes.filter((n) => n.startsWith("finish time recorded")).length, 1);
        assert.equal(notes.includes("no finish event recorded"), false);
        assert.equal(new Set(notes).size, notes.length);
        const again = report(unconfirmedFinished()).dataQuality.notes;
        assert.deepEqual(again, notes, "building the report twice gives the same notes");
    });

    test("no such note without a finish, nor when distance is confirmed", () => {
        let unfinished = mark(record(runningSession(), turn(20000, 25)), 21000);
        assert.equal(report(unfinished).dataQuality.notes.some((n) => n.startsWith("finish time recorded")), false);
        assert.ok(report(unfinished).dataQuality.notes.includes("no finish event recorded"));

        let confirmed = record(record(runningSession(), turn(20000, 25)), { type: "finish", atMs: 86000, distanceMeters: 100, source: "manual" });
        assert.equal(report(confirmed).dataQuality.notes.some((n) => n.includes("unverified") || n.includes("unconfirmed")), false);
    });
});

describe("report: the CONFIGURED distance is never presented as distance confirmed", () => {
    test("unconfirmed finished race: configured 100, finish event says 100, but only 25 m was established by accepted events", () => {
        const built = report(unconfirmedFinished());
        assert.equal(built.distanceMeters, 100, "configured race distance");
        assert.equal(built.finish.distanceMeters, 100, "the finish event's own (asserted) distance");
        assert.equal(built.confirmedDistanceMeters, 25, "established by the accepted turn only");
        assert.equal(built.distanceConfidence.state, "unconfirmed");
    });

    test("with no accepted turn or split the confirmed distance is 0, whatever the configured distance or the finish says", () => {
        const session = record(mark(runningSession(), 5000), { type: "finish", atMs: 86000, distanceMeters: 100, source: "manual" });
        const built = report(session);
        assert.equal(built.distanceMeters, 100);
        assert.equal(built.confirmedDistanceMeters, 0);
    });

    test("anything a person records AFTER the point distance was last trusted is an assertion, not confirmed distance", () => {
        let session = mark(record(runningSession(), turn(20000, 25)), 21000);
        session = record(session, { type: "split", atMs: 40000, distanceMeters: 60, source: "manual" });
        session = record(session, turn(50000, 75, "manual"));
        const built = report(session);
        assert.equal(built.splits.length, 3, "the manual events are still reported as splits");
        assert.equal(built.confirmedDistanceMeters, 25);
    });

    test("a confirmed race: confirmed distance is the last accepted turn/split (75), not the configured 100 and not the finish's", () => {
        let session = runningSession();
        for (const [atMs, d] of [[20000, 25], [36000, 50], [52000, 75]]) session = record(session, turn(atMs, d));
        session = record(session, { type: "finish", atMs: 70000, distanceMeters: 100, source: "manual" });
        const built = report(session);
        assert.equal(built.confirmedDistanceMeters, 75);
        assert.equal(built.distanceMeters, 100);
        assert.equal(built.distanceConfidence.state, "confirmed");
    });

    test("a fresh session reports 0 confirmed and keeps the configured distance", () => {
        const built = report(ChronosEngine.createSession({ sessionId: "x", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 100m", distanceMeters: 100, timeSource: "video" }).session);
        assert.equal(built.confirmedDistanceMeters, 0);
        assert.equal(built.distanceMeters, 100);
    });
});

// ===========================================================================
// PB COMPARISON
// ===========================================================================

describe("chronosComparePB(): an unconfirmed finish is not a comparable race-distance result", () => {
    test("with a PB on record: not comparable, stable reason, no verdict, no new PB; the recorded time is untouched", () => {
        const built = report(unconfirmedFinished());
        const snapshot = JSON.stringify(built);
        const comparison = ChronosEngine.comparePB(built, PB);
        assert.equal(comparison.comparable, false);
        assert.equal(comparison.reason, "distance-unconfirmed");
        assert.equal(comparison.result, null);
        assert.equal(comparison.deltaMs, null);
        assert.equal(comparison.existingPbTimeMs, null);
        assert.equal(comparison.isNewPb, false);
        assert.equal(comparison.hasPb, true);
        assert.equal(comparison.formatted, "PB comparison unavailable (distance-unconfirmed)");
        assert.equal(JSON.stringify(built), snapshot, "the report is not modified");
        assert.equal(built.finalTimeMs, 85000, "the time is still there");
    });

    test("with NO PB on record it is still not a (first) PB: the 'no existing PB' branch must not bless an unverified time", () => {
        const comparison = ChronosEngine.comparePB(report(unconfirmedFinished()), null);
        assert.equal(comparison.comparable, false);
        assert.equal(comparison.reason, "distance-unconfirmed");
        assert.equal(comparison.isNewPb, false);
        assert.equal(comparison.hasPb, false);
    });

    test("it takes precedence over event/course compatibility (the verdict is withheld either way)", () => {
        const built = report(unconfirmedFinished());
        assert.equal(ChronosEngine.comparePB(built, { ...PB, event: "Freestyle 50m" }).reason, "distance-unconfirmed");
        assert.equal(ChronosEngine.comparePB(built, { ...PB, course: "Long Course" }).reason, "distance-unconfirmed");
    });

    test("a faster-than-PB time, a slower one and a tie are all withheld alike", () => {
        for (const finishAt of [30000, 91000, 91000 - 1000 + 0]) {
            let session = mark(record(runningSession(1000), turn(20000, 25)), 21000);
            session = record(session, { type: "finish", atMs: finishAt, distanceMeters: 100, source: "manual" });
            assert.equal(ChronosEngine.comparePB(report(session), PB).reason, "distance-unconfirmed");
        }
    });

    test("an UNFINISHED unconfirmed race keeps its established reason: race-not-finished", () => {
        const unfinished = mark(record(runningSession(), turn(20000, 25)), 21000);
        const comparison = ChronosEngine.comparePB(report(unfinished), PB);
        assert.equal(comparison.reason, "race-not-finished");
        assert.equal(comparison.isNewPb, false);
        assert.equal(ChronosEngine.comparePB(report(unfinished), null).reason, "race-not-finished");
    });

    test("PB behavior is unchanged for completed results whose distance progression is CONFIRMED", () => {
        const finished = (finishAt) => {
            let session = runningSession(0);
            for (const [atMs, d] of [[20000, 25], [36000, 50], [52000, 75]]) session = record(session, turn(atMs, d));
            return report(record(session, { type: "finish", atMs: finishAt, distanceMeters: 100, source: "manual" }));
        };
        const faster = ChronosEngine.comparePB(finished(88000), PB);
        assert.deepEqual([faster.comparable, faster.result, faster.deltaMs, faster.isNewPb, faster.formatted], [true, "faster", -2000, true, "-2.00s vs PB"]);
        const equal = ChronosEngine.comparePB(finished(90000), PB);
        assert.deepEqual([equal.comparable, equal.result, equal.isNewPb, equal.formatted], [true, "equal", false, "Matches existing PB"]);
        const slower = ChronosEngine.comparePB(finished(93000), PB);
        assert.deepEqual([slower.comparable, slower.result, slower.deltaMs, slower.isNewPb], [true, "slower", 3000, false]);
        const first = ChronosEngine.comparePB(finished(88000), null);
        assert.deepEqual([first.reason, first.isNewPb], ["no-existing-pb", true]);
        assert.equal(ChronosEngine.comparePB(finished(88000), { ...PB, event: "Freestyle 50m" }).reason, "incompatible-event");
    });

    test("a report object WITHOUT a distanceConfidence field (any older shape) compares exactly as before", () => {
        const comparison = ChronosEngine.comparePB({ finalTimeMs: 85000, event: "Freestyle 100m", course: "Short Course" }, PB);
        assert.deepEqual([comparison.comparable, comparison.result, comparison.isNewPb], [true, "faster", true]);
        assert.equal(ChronosEngine.comparePB({ finalTimeMs: 85000, distanceConfidence: { state: "confirmed" } }, null).reason, "no-existing-pb");
    });
});

// ===========================================================================
// MANUAL COMPATIBILITY
// ===========================================================================

describe("manual timing compatibility is unchanged", () => {
    test("a purely manual race (no detector, no mark) reports and compares as before", () => {
        let session = ChronosEngine.armSession(ChronosEngine.createSession({ sessionId: "m", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 100m", distanceMeters: 100, timeSource: "manual" }).session).session;
        session = record(session, { type: "start", atMs: 0, source: "manual" });
        session = record(session, { type: "split", atMs: 20000, distanceMeters: 25, source: "manual" });
        session = record(session, { type: "finish", atMs: 88000, distanceMeters: 100, source: "manual" });
        const built = report(session);
        assert.equal(built.finalTimeMs, 88000);
        assert.equal(built.confirmedDistanceMeters, 25);
        assert.equal(built.dataQuality.notes.length, 0);
        assert.equal(ChronosEngine.comparePB(built, PB).result, "faster");
    });

    test("manual events remain accepted after the mark, and a manual finish records its time (it just is not compared)", () => {
        const session = unconfirmedFinished();
        assert.equal(session.status, "finished");
        assert.equal(session.finalTimeMs, 85000);
        assert.equal(report(session).dataQuality.manualEventCount, 1);
    });
});

// ===========================================================================
// INTEGRATION: terminal tracking + manual finish through the pipeline
// ===========================================================================

describe("integration: a race whose analysis ended early, then a manual finish", () => {
    test("the time is kept, the report is explicit, and no PB verdict is produced", () => {
        const path = racePath({ lengths: 4 });
        const arrival = path.turns[0].arrivalMs;
        const result = runRace({ config: raceConfig({ distanceMeters: 100 }), samples: sampleRace(path, { dropouts: [[arrival - 700, arrival + 2500]] }) });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, "analysis-ended-before-distance-confirmed");

        const finishAt = result.start.atMs + 80000;
        const finished = ChronosEngine.recordEvent(result.controller.chronosSession, { type: "finish", atMs: finishAt, distanceMeters: 100, source: "manual" });
        assert.equal(finished.ok, true);
        const built = report(finished.session);
        assert.equal(built.finalTimeMs, 80000);
        assert.equal(built.finish.atMs, finishAt);
        assert.equal(built.confirmedDistanceMeters, 0);
        assert.equal(built.distanceMeters, 100);
        assert.ok(built.dataQuality.notes.some((n) => n.startsWith("finish time recorded") && n.includes("analysis-ended-before-distance-confirmed")));
        assert.equal(ChronosEngine.comparePB(built, PB).reason, "distance-unconfirmed");
        assert.equal(ChronosEngine.comparePB(built, null).isNewPb, false);
    });
});
