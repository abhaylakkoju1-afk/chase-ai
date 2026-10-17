// Chronos engine — distance confidence (Chronos reliability phase 2C).
//
// ENGINE + REPORT LAYER ONLY: sessions are driven through the public
// ChronosEngine API, so a failure localises to session.js / events.js /
// report.js. All data is synthetic.
//
// CONTRACT UNDER TEST. markDistanceUnconfirmed(session, {...}) records, once and
// permanently, that a detector's distance count can no longer be trusted. From
// then on Chronos refuses every DETECTOR-sourced split/turn/finish
// ("distance-progression-unconfirmed") and the report says so; MANUAL events are
// unaffected; events already accepted are untouched; nothing clears the mark.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChronosEngine } from "../../src/chronos-engine/index.js";

function created(extra = {}) {
    const result = ChronosEngine.createSession({ sessionId: "distance-confidence", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 100m", distanceMeters: 100, timeSource: "video", ...extra });
    assert.equal(result.ok, true);
    return result.session;
}

function running(startAtMs = 1000) {
    const armed = ChronosEngine.armSession(created()).session;
    return ChronosEngine.recordEvent(armed, { type: "start", atMs: startAtMs, source: "detector", detector: "start-detector-v1", confidence: 0.8 }).session;
}

const turn = (atMs, distanceMeters, source = "detector") =>
    source === "detector"
        ? { type: "turn", atMs, distanceMeters, source, detector: "turn-detector-v1", confidence: 0.7 }
        : { type: "turn", atMs, distanceMeters, source };

const MARK = { reason: "possible-missed-turn-during-tracking-gap-near-wall", sinceAtMs: 20000, resumedAtMs: 21500, evidence: { gapMs: 1500 } };

describe("session: distanceConfidence field and markDistanceUnconfirmed()", () => {
    test("a fresh session carries distanceConfidence: null (trusted), and the report says 'confirmed'", () => {
        const session = created();
        assert.equal(session.distanceConfidence, null);
        const report = ChronosEngine.buildReport(session).report;
        assert.deepEqual(report.distanceConfidence, { state: "confirmed", reason: null, sinceAtMs: null, resumedAtMs: null });
        assert.equal(report.dataQuality.notes.some((n) => n.includes("unconfirmed")), false);
    });

    test("marking a running session returns a NEW session with an unconfirmed record, never mutating the input", () => {
        const session = running();
        const snapshot = JSON.stringify(session);
        const result = ChronosEngine.markDistanceUnconfirmed(session, MARK);
        assert.equal(result.ok, true);
        assert.equal(result.alreadyUnconfirmed, false);
        assert.notEqual(result.session, session);
        assert.equal(JSON.stringify(session), snapshot);
        assert.deepEqual(result.session.distanceConfidence, { state: "unconfirmed", reason: MARK.reason, sinceAtMs: 20000, resumedAtMs: 21500, evidence: { gapMs: 1500 } });
        assert.equal(result.session.status, "running", "marking never changes status");
        assert.equal(result.session.events.length, session.events.length, "...or adds an event");
    });

    test("it is legal only while the race is running", () => {
        const idle = created();
        const armed = ChronosEngine.armSession(idle).session;
        const finished = ChronosEngine.recordEvent(running(), { type: "finish", atMs: 60000, distanceMeters: 100, source: "manual" }).session;
        const aborted = ChronosEngine.abortSession(running()).session;
        for (const [session, status] of [[idle, "idle"], [armed, "armed"], [finished, "finished"], [aborted, "aborted"]]) {
            const result = ChronosEngine.markDistanceUnconfirmed(session, MARK);
            assert.equal(result.ok, false, status);
            assert.equal(result.reason, `distance-confidence-illegal-in-status-${status}`);
            assert.equal(result.session, session);
        }
        assert.equal(ChronosEngine.markDistanceUnconfirmed(null, MARK).reason, "missing-session");
    });

    test("parameters are validated: a reason is required, the instant must be finite and not before the start, resumed not before since", () => {
        const session = running(1000);
        const cases = [
            [{ ...MARK, reason: "" }, "missing-distance-confidence-reason"],
            [{ ...MARK, reason: 5 }, "missing-distance-confidence-reason"],
            [null, "missing-distance-confidence-reason"],
            [{ ...MARK, sinceAtMs: NaN }, "invalid-distance-confidence-since"],
            [{ ...MARK, sinceAtMs: "20000" }, "invalid-distance-confidence-since"],
            [{ ...MARK, sinceAtMs: 999 }, "invalid-distance-confidence-since"],
            [{ ...MARK, resumedAtMs: 19999 }, "invalid-distance-confidence-resumed"],
            [{ ...MARK, resumedAtMs: Infinity }, "invalid-distance-confidence-resumed"]
        ];
        for (const [params, reason] of cases) {
            const result = ChronosEngine.markDistanceUnconfirmed(session, params);
            assert.equal(result.ok, false, JSON.stringify(params));
            assert.equal(result.reason, reason);
            assert.equal(result.session, session);
        }
        assert.equal(ChronosEngine.markDistanceUnconfirmed(session, { reason: "x", sinceAtMs: 1000 }).ok, true);
    });

    test("marking is idempotent and keeps the FIRST record (the earliest point distance could have been affected)", () => {
        const first = ChronosEngine.markDistanceUnconfirmed(running(), MARK).session;
        const second = ChronosEngine.markDistanceUnconfirmed(first, { reason: "another-gap", sinceAtMs: 40000, resumedAtMs: 42000 });
        assert.equal(second.ok, true);
        assert.equal(second.alreadyUnconfirmed, true);
        assert.equal(second.session, first);
        assert.equal(second.session.distanceConfidence.sinceAtMs, 20000);
        assert.equal(second.session.distanceConfidence.reason, MARK.reason);
    });

    test("there is no way to clear it: no API, and later events do not touch it", () => {
        let session = ChronosEngine.markDistanceUnconfirmed(running(), MARK).session;
        for (const [index, input] of [turn(30000, 25, "manual"), { type: "split", atMs: 40000, distanceMeters: 30, source: "manual" }, turn(50000, 50, "manual")].entries()) {
            const result = ChronosEngine.recordEvent(session, input);
            assert.equal(result.ok, true, `manual event ${index}`);
            session = result.session;
            assert.equal(session.distanceConfidence.state, "unconfirmed");
            assert.equal(session.distanceConfidence.sinceAtMs, 20000);
        }
        assert.equal(ChronosEngine.clearDistanceConfidence, undefined);
        assert.equal(ChronosEngine.markDistanceConfirmed, undefined);
    });
});

describe("events: detector-sourced distance events are refused once unconfirmed; manual events are not", () => {
    const unconfirmed = () => ChronosEngine.markDistanceUnconfirmed(running(), MARK).session;

    test("a detector turn, split or finish is rejected with the specific reason and the ORIGINAL session is returned", () => {
        const session = unconfirmed();
        const detector = { source: "detector", detector: "d", confidence: 0.9 };
        for (const input of [
            turn(30000, 25),
            { type: "split", atMs: 30000, distanceMeters: 30, ...detector },
            { type: "finish", atMs: 90000, distanceMeters: 100, ...detector }
        ]) {
            const result = ChronosEngine.recordEvent(session, input);
            assert.equal(result.ok, false, input.type);
            assert.equal(result.reason, "distance-progression-unconfirmed");
            assert.equal(result.event, null);
            assert.equal(result.session, session);
        }
    });

    test("FINISH INTEGRITY: a detector finish cannot produce a final time or distance; the session stays running", () => {
        const session = unconfirmed();
        const result = ChronosEngine.recordEvent(session, { type: "finish", atMs: 90000, distanceMeters: 100, source: "detector", detector: "d", confidence: 1 });
        assert.equal(result.ok, false);
        assert.equal(session.status, "running");
        assert.equal(session.finalTimeMs, null);
        assert.equal(ChronosEngine.buildReport(session).report.finalTimeMs, null);
    });

    test("MANUAL COMPATIBILITY: manual turn, split and finish are accepted exactly as before, and a manual finish sets the final time", () => {
        let session = unconfirmed();
        for (const input of [turn(30000, 25, "manual"), { type: "split", atMs: 40000, distanceMeters: 40, source: "manual" }, turn(50000, 50, "manual"), { type: "finish", atMs: 90000, distanceMeters: 100, source: "manual" }]) {
            const result = ChronosEngine.recordEvent(session, input);
            assert.equal(result.ok, true, `${input.type} (manual)`);
            session = result.session;
        }
        assert.equal(session.status, "finished");
        assert.equal(session.finalTimeMs, 89000);
        // The report still says the DETECTOR's distance progression was unconfirmed.
        assert.equal(ChronosEngine.buildReport(session).report.distanceConfidence.state, "unconfirmed");
    });

    test("events accepted BEFORE the mark stay accepted and in the report; nothing is deleted", () => {
        let session = running(1000);
        session = ChronosEngine.recordEvent(session, turn(20000, 25)).session;
        session = ChronosEngine.markDistanceUnconfirmed(session, { ...MARK, sinceAtMs: 21000, resumedAtMs: 23000 }).session;
        assert.deepEqual(session.events.map((e) => e.type), ["start", "turn"]);
        const report = ChronosEngine.buildReport(session).report;
        assert.deepEqual(report.splits.map((s) => s.distanceMeters), [25]);
        assert.deepEqual(report.distanceConfidence, { state: "unconfirmed", reason: MARK.reason, sinceAtMs: 21000, resumedAtMs: 23000 });
    });

    test("detector events that were never submitted cannot appear in the report's splits: no downstream split is trusted", () => {
        let session = running(1000);
        session = ChronosEngine.recordEvent(session, turn(20000, 25)).session;
        session = ChronosEngine.markDistanceUnconfirmed(session, { ...MARK, sinceAtMs: 21000 }).session;
        for (const [atMs, distance] of [[36000, 50], [52000, 75]]) session = ChronosEngine.recordEvent(session, turn(atMs, distance)).session;
        assert.deepEqual(ChronosEngine.buildReport(session).report.splits.map((s) => s.distanceMeters), [25]);
    });

    test("an unmarked session behaves exactly as before: detector events are accepted", () => {
        const session = running();
        assert.equal(ChronosEngine.recordEvent(session, turn(20000, 25)).ok, true);
    });
});

describe("report: the state is always present, and surfaced as a data-quality note", () => {
    test("an unconfirmed race reports state, reason and instants, plus a note", () => {
        const session = ChronosEngine.markDistanceUnconfirmed(running(), MARK).session;
        const report = ChronosEngine.buildReport(session).report;
        assert.equal(report.distanceConfidence.state, "unconfirmed");
        assert.equal(report.distanceConfidence.reason, MARK.reason);
        assert.equal(report.distanceConfidence.sinceAtMs, 20000);
        assert.equal(report.distanceConfidence.resumedAtMs, 21500);
        assert.ok(report.dataQuality.notes.some((n) => n.includes("distance progression unconfirmed after 20000ms") && n.includes(MARK.reason)));
    });

    test("an unfinished, unconfirmed race cannot be compared to a PB", () => {
        const session = ChronosEngine.markDistanceUnconfirmed(running(), MARK).session;
        const comparison = ChronosEngine.comparePB(ChronosEngine.buildReport(session).report, { event: "Freestyle 100m", course: "Short Course", time: "1:05.00", history: [] });
        assert.equal(comparison.comparable, false);
        assert.equal(comparison.isNewPb, false);
    });

    test("the report summary is a copy: mutating it cannot change the session", () => {
        const session = ChronosEngine.markDistanceUnconfirmed(running(), MARK).session;
        const report = ChronosEngine.buildReport(session).report;
        report.distanceConfidence.state = "confirmed";
        assert.equal(session.distanceConfidence.state, "unconfirmed");
    });
});

function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("property: once unconfirmed, no detector-sourced distance event is ever accepted (synthetic fuzz)", () => {
    test("300 random streams with a mark at a random point", () => {
        let detectorRefusals = 0;
        let manualAccepted = 0;
        for (let seed = 1; seed <= 300; seed += 1) {
            const random = seeded(seed * 40503);
            let session = running(1000);
            let markedAtStep = Math.floor(random() * 15);
            for (let step = 0; step < 30; step += 1) {
                if (step === markedAtStep) {
                    const marked = ChronosEngine.markDistanceUnconfirmed(session, { reason: "fuzz", sinceAtMs: 1000 + step * 3000 });
                    assert.equal(marked.ok, true);
                    session = marked.session;
                }
                const source = random() < 0.5 ? "detector" : "manual";
                const type = ["turn", "split", "finish"][Math.floor(random() * 3)];
                const input = { type, atMs: 1000 + step * 3000 + Math.floor(random() * 500), distanceMeters: 25 * Math.floor(random() * 4), source, ...(source === "detector" ? { detector: "d", confidence: 0.5 } : {}) };
                const before = session;
                const result = ChronosEngine.recordEvent(session, input);
                if (result.ok) {
                    session = result.session;
                    if (before.distanceConfidence && before.distanceConfidence.state === "unconfirmed") {
                        assert.equal(source, "manual", `seed ${seed} step ${step}: only manual events are accepted after the mark`);
                        manualAccepted += 1;
                    }
                } else {
                    assert.equal(result.session, before);
                    if (before.distanceConfidence && source === "detector") {
                        assert.equal(result.reason, "distance-progression-unconfirmed");
                        detectorRefusals += 1;
                    }
                }
                assert.equal(session.distanceConfidence === null, before.distanceConfidence === null || false, `seed ${seed}: the mark is never added or cleared by events`);
                if (session.status === "finished") break;
            }
        }
        assert.ok(detectorRefusals > 300, `fuzz refused detector events (${detectorRefusals})`);
        assert.ok(manualAccepted > 50, `fuzz accepted manual events (${manualAccepted})`);
    });
});
