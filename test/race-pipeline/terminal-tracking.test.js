// Terminal tracking and distance confidence THROUGH THE CONTROLLER (Chronos
// reliability phase 2C follow-up).
//
// SwimmerTracking's ANALYSIS_DEGRADED is terminal: afterwards no sample reaches a
// detector, so the observation-gap rule (which needs a sample AFTER a gap) can
// never run. Before this change such a race still reported distance as
// "confirmed" with an incomplete turn history. Now, when tracking is terminally
// degraded — or the stream ends (racePipelineEndAnalysis) while the target is
// still lost — and the race's required turns are not all recorded, the distance
// is marked unconfirmed, with reason "analysis-ended-before-distance-confirmed".
//
// ALL DATA IS SYNTHETIC with explicit ground truth from
// test/race-pipeline/synthetic-race.js. Passing proves the logic and invariants
// on these inputs; it does NOT establish real-world accuracy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePath,
    sampleRace,
    raceConfig,
    runRace,
    driveRace,
    freshRaceController,
    poseSample,
    noPoseSample,
    seededRandom
} from "./synthetic-race.js";

import {
    racePipelineEndAnalysis,
    DISTANCE_ANALYSIS_ENDED_REASON,
    DISTANCE_AMBIGUITY_REASON
} from "../../src/race-pipeline/controller.js";
import { ChronosEngine } from "../../src/chronos-engine/index.js";

const path100 = racePath({ lengths: 4 }); // 100 m / 25 m pool: walls ~21,172 / 36,745 / 52,317, final wall ~67,890
const cfg100 = raceConfig({ distanceMeters: 100 });
const arrival1 = path100.turns[0].arrivalMs;
const control = runRace({ config: cfg100, samples: sampleRace(path100) });

const withoutConfidence = (session) => JSON.stringify({ ...session, distanceConfidence: null });

function degradedAtWall1() {
    // The pose is hidden from 700 ms before the first wall for 3.2 s: tracking cannot recover.
    return runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[arrival1 - 700, arrival1 + 2500]] }) });
}

// ===========================================================================
// 1 / 6 / 7 / 9. TERMINAL DEGRADATION WITH REQUIRED TURNS OUTSTANDING
// ===========================================================================

describe("terminal tracking degradation with required turns outstanding marks distance unconfirmed", () => {
    test("wall-adjacent: degraded after the accepted start, three turns required and none recorded", () => {
        const result = degradedAtWall1();
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        const confidence = result.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.state, "unconfirmed");
        assert.equal(confidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
        assert.equal(DISTANCE_ANALYSIS_ENDED_REASON, "analysis-ended-before-distance-confirmed");
        assert.equal(confidence.sinceAtMs, result.controller.trackingSession.lastConfirmedAtMs, "from the last confirmed observation");
        assert.equal(confidence.resumedAtMs, null, "tracking never resumed");
        assert.equal(confidence.evidence.trigger, "tracking-degraded");
        assert.equal(confidence.evidence.requiredTurns, 3);
        assert.equal(confidence.evidence.requiredTurnsKnown, true);
        assert.equal(confidence.evidence.confirmedDistanceMeters, 0);
        assert.equal(confidence.evidence.degradedReason, result.controller.trackingSession.degradedReason);
    });

    test("mid-pool: the same treatment (the last observation need not be near a wall)", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[10000, 17000]] }) });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.ok(path100.xAt(result.controller.trackingSession.lastConfirmedAtMs).x > 0.25, "test setup: last observation is outside the wall zone");
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
    });

    test("the REPORT reflects it: unconfirmed, with the reason, the instant and a data-quality note (no longer 'confirmed')", () => {
        const result = degradedAtWall1();
        assert.equal(result.report.distanceConfidence.state, "unconfirmed");
        assert.equal(result.report.distanceConfidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
        assert.equal(result.report.distanceConfidence.sinceAtMs, result.controller.trackingSession.lastConfirmedAtMs);
        assert.ok(result.report.dataQuality.notes.some((n) => n.includes("distance progression unconfirmed") && n.includes(DISTANCE_ANALYSIS_ENDED_REASON)));
        assert.equal(result.controller.diagnostics.distanceConfidence.state, "unconfirmed");
        assert.equal(result.controller.diagnostics.distanceConfidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
    });

    test("BEFORE/AFTER: this exact run used to report 'confirmed' (the audit's A1 finding)", () => {
        const result = degradedAtWall1();
        assert.notEqual(result.report.distanceConfidence.state, "confirmed");
    });

    test("nothing is fabricated: no turn, split or finish appears, the accepted start is untouched, the counter does not move", () => {
        const result = degradedAtWall1();
        assert.deepEqual(result.events.map((e) => e.type), ["start"]);
        assert.deepEqual(result.events[0], control.events[0]);
        assert.equal(result.report.splits.length, 0);
        assert.equal(result.confirmedDistanceMeters, 0);
        assert.equal(result.finish, null);
        assert.equal(result.report.finalTimeMs, null);
        assert.equal(result.status, "running");
    });

    test("trusted turns recorded BEFORE the degradation are kept, byte-identical to the uninterrupted run's", () => {
        // Degrade after the first turn is confirmed but before the second: required turns remain.
        const second = path100.turns[1].arrivalMs;
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[second - 700, second + 2500]] }) });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.deepEqual(result.turns, control.turns.slice(0, 1));
        assert.deepEqual(result.report.splits, control.report.splits.slice(0, 1));
        assert.equal(result.controller.chronosSession.distanceConfidence.evidence.confirmedDistanceMeters, 25);
        assert.ok(result.turns[0].atMs <= result.controller.chronosSession.distanceConfidence.sinceAtMs);
        assert.equal(result.report.confirmedDistanceMeters, 25);
    });
});

// ===========================================================================
// 3. NOTHING OUTSTANDING; 4. BEFORE THE START
// ===========================================================================

describe("terminal degradation that cannot have lost a required turn does not downgrade confidence", () => {
    test("after ALL required turns are recorded (75 m of a 100 m race, 25 m pool) degradation leaves confidence confirmed", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[58000, 64500]] }) });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75]);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.report.distanceConfidence.state, "confirmed");
        assert.equal(racePipelineEndAnalysis(result.controller).marked, false);
    });

    test("a race with no turn at all (distance <= pool length) is never downgraded by degradation", () => {
        const path25 = racePath({ lengths: 1 });
        const result = runRace({ config: raceConfig({ distanceMeters: 25, event: "Freestyle 25m" }), samples: sampleRace(path25, { dropouts: [[9000, 16000]] }) });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
    });

    test("degradation BEFORE the accepted start does not mark anything (no distance had begun)", () => {
        // 1.2 s of low visibility while the swimmer is at rest, before the start: sustained ambiguity.
        const samples = sampleRace(path100).map((s) => (s.atMs >= 3000 && s.atMs < 4200
            ? { ...s, landmarks: { hip: { ...s.landmarks.hip, visibility: 0.2 }, nose: { ...s.landmarks.nose, visibility: 0.2 } } }
            : s));
        const result = runRace({ config: cfg100, samples });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.equal(result.status, "armed", "the race never started");
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(racePipelineEndAnalysis(result.controller).marked, false);
        assert.equal(result.report.distanceConfidence.state, "confirmed");
    });
});

// ===========================================================================
// 2 / 5. END OF STREAM WHILE LOST; RECOVERABLE LOSS STAYS RECOVERABLE
// ===========================================================================

describe("a stream that ends while the target is lost, and recoverable loss", () => {
    const lostAtWall = () => runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[arrival1 - 700, 1e9]], endMs: arrival1 + 1500 }) });

    test("TARGET_LOST is recoverable: it is NOT marked until the stream actually ends", () => {
        const result = lostAtWall();
        assert.equal(result.controller.trackingSession.status, "TARGET_LOST");
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.report.distanceConfidence.state, "confirmed");
    });

    test("racePipelineEndAnalysis() on a stream that ended while lost marks distance unconfirmed (and reports that it did)", () => {
        const result = lostAtWall();
        const ended = racePipelineEndAnalysis(result.controller);
        assert.equal(ended.marked, true);
        const confidence = ended.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
        assert.equal(confidence.evidence.trigger, "stream-ended-while-target-lost");
        assert.equal(confidence.sinceAtMs, result.controller.trackingSession.lastConfirmedAtMs);
        assert.equal(confidence.resumedAtMs, null);
        assert.equal(ended.controller.diagnostics.distanceConfidence.state, "unconfirmed");
        assert.deepEqual(ended.controller.chronosSession.events, result.controller.chronosSession.events, "no event is created");
        // pure: the input controller is not changed
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
    });

    test("a loss that RECOVERED mid-stream is unaffected, including at the end of the stream", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[10000, 13500]] }) });
        assert.equal(result.controller.trackingSession.status, "TARGET_LOCKED");
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(racePipelineEndAnalysis(result.controller).marked, false);
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75]);
    });

    test("at the moment of a recoverable loss, mid-stream, no terminal handling happens", () => {
        let controller = freshRaceController(cfg100);
        let sawLost = false;
        for (const sample of sampleRace(path100, { dropouts: [[10000, 13500]] })) {
            controller = driveRace(controller, [sample]).controller;
            if (controller.trackingSession.status === "TARGET_LOST") {
                sawLost = true;
                assert.equal(controller.chronosSession.distanceConfidence, null, `at ${sample.atMs}`);
            }
        }
        assert.equal(sawLost, true, "test setup: the target was lost at some point");
    });

    test("a clean, uninterrupted stream is unaffected by the end-of-stream notification", () => {
        const ended = racePipelineEndAnalysis(control.controller);
        assert.equal(ended.marked, false);
        assert.equal(ended.controller, control.controller);
    });

    test("end-of-stream before the race has started, or with no session, does nothing", () => {
        const armed = freshRaceController(cfg100);
        assert.equal(racePipelineEndAnalysis(armed).marked, false);
        assert.equal(racePipelineEndAnalysis({ chronosSession: null, trackingSession: null }).marked, false);
    });
});

// ===========================================================================
// 8. IDEMPOTENCE; THE FIRST RECORD IS KEPT
// ===========================================================================

describe("repeated terminal notifications never overwrite the first ambiguity record", () => {
    test("more frames after degradation, and repeated end-of-stream calls, leave the record unchanged", () => {
        const first = degradedAtWall1();
        const record = JSON.stringify(first.controller.chronosSession.distanceConfidence);
        let controller = first.controller;
        for (let i = 0; i < 4; i += 1) {
            controller = driveRace(controller, sampleRace(path100, { endMs: 30000 }).slice(-40)).controller;
            const ended = racePipelineEndAnalysis(controller);
            assert.equal(ended.marked, false);
            controller = ended.controller;
            assert.equal(JSON.stringify(controller.chronosSession.distanceConfidence), record);
        }
        assert.deepEqual(controller.chronosSession.events, first.controller.chronosSession.events);
    });

    test("an observation-gap record made FIRST is kept when tracking later degrades", () => {
        const second = path100.turns[1].arrivalMs;
        const result = runRace({
            config: cfg100,
            samples: sampleRace(path100, { dropouts: [[arrival1 - 700, arrival1 + 500], [second + 3000, second + 12000]] })
        });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        const confidence = result.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.reason, DISTANCE_AMBIGUITY_REASON, "the gap record, not the terminal one");
        assert.equal(confidence.sinceAtMs, 20400);
        assert.equal(racePipelineEndAnalysis(result.controller).marked, false);
    });
});

// ===========================================================================
// REQUIRED-TURN COUNTING: ONLY WITH A VALID CONFIGURATION; NEVER GUESSED
// ===========================================================================

describe("counting required turns uses only a valid race configuration and never guesses", () => {
    test("a race distance that is not a whole number of pool lengths cannot be counted: marked, with requiredTurnsKnown: false", () => {
        const path = racePath({ lengths: 3 });
        const result = runRace({ config: raceConfig({ distanceMeters: 60, event: "Freestyle 60m" }), samples: sampleRace(path, { dropouts: [[12000, 20000]] }) });
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        const confidence = result.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
        assert.equal(confidence.evidence.requiredTurnsKnown, false);
        assert.equal(confidence.evidence.requiredTurns, null);
    });

    test("no race distance at all: marked, requiredTurnsKnown: false", () => {
        const result = runRace({ config: { ...raceConfig({ distanceMeters: 100 }), distanceMeters: null }, samples: sampleRace(path100, { dropouts: [[12000, 20000]] }) });
        assert.equal(result.controller.chronosSession.distanceConfidence.evidence.requiredTurnsKnown, false);
    });

    test("fractional pool lengths that divide the race distance are counted (floating-point tolerant)", () => {
        // 37.5 m race in a 12.5 m pool: required turns at 12.5 and 25. Nothing recorded -> outstanding.
        const config = raceConfig({ distanceMeters: 37.5, poolLengthMeters: 12.5, event: "Freestyle 37.5m" });
        const result = runRace({ config, samples: sampleRace(racePath({ lengths: 3, poolLengthMeters: 12.5 }), { dropouts: [[12000, 20000]] }) });
        assert.equal(result.controller.chronosSession.distanceConfidence.evidence.requiredTurns, 2);
    });

    test("sinceAtMs falls back to the accepted start when no usable last-confirmed observation exists (never an invented instant)", () => {
        const startEventAt = control.start.atMs;
        for (const lastConfirmedAtMs of [null, NaN, startEventAt - 100]) {
            const controller = {
                ...control.controller,
                chronosSession: { ...control.controller.chronosSession, events: control.controller.chronosSession.events.slice(0, 1), distanceConfidence: null },
                eventAdapterState: { confirmedDistanceMeters: 0 },
                trackingSession: { ...control.controller.trackingSession, status: "ANALYSIS_DEGRADED", lastConfirmedAtMs }
            };
            const ended = racePipelineEndAnalysis(controller);
            assert.equal(ended.marked, true, String(lastConfirmedAtMs));
            assert.equal(ended.controller.chronosSession.distanceConfidence.sinceAtMs, startEventAt, String(lastConfirmedAtMs));
        }
    });
});

// ===========================================================================
// SEEDED MULTI-RACE FUZZ
// ===========================================================================

describe("seeded fuzz: terminal tracking never leaves an incomplete race marked confirmed", () => {
    test("300 random races with random dropouts, each also ended with the end-of-stream notification", () => {
        let degraded = 0;
        let markedTerminal = 0;
        let notDowngraded = 0;
        let lostEnded = 0;
        for (let seed = 1; seed <= 300; seed += 1) {
            const random = seededRandom(seed * 7919);
            const pool = random() < 0.5 ? 25 : 50;
            const lengths = 2 + Math.floor(random() * 5);
            const speed = 0.06 + random() * 0.06;
            const path = racePath({ lengths, speed, poolLengthMeters: pool });
            const dropouts = [];
            for (let k = 0, n = Math.floor(random() * 4); k < n; k += 1) {
                const from = 8000 + random() * (path.endMs - 11000);
                dropouts.push([from, from + 100 + random() * 2400]);
            }
            const distance = lengths * pool;
            const result = runRace({ config: raceConfig({ distanceMeters: distance, poolLengthMeters: pool }), samples: sampleRace(path, { dt: seed % 2 === 0 ? 120 : 160, dropouts }) });
            const ended = racePipelineEndAnalysis(result.controller).controller;
            const confidence = ended.chronosSession.distanceConfidence;
            const status = ended.trackingSession.status;
            const outstanding = ended.eventAdapterState.confirmedDistanceMeters < distance - pool;
            const started = ended.chronosSession.status === "running";

            if (started && (status === "ANALYSIS_DEGRADED" || status === "TARGET_LOST") && outstanding) {
                assert.ok(confidence, `seed ${seed}: terminal/lost at the end with required turns outstanding must not read as confirmed`);
                if (status === "ANALYSIS_DEGRADED") degraded += 1;
                if (status === "TARGET_LOST") lostEnded += 1;
                if (confidence.reason === DISTANCE_ANALYSIS_ENDED_REASON) markedTerminal += 1;
            }
            if (started && status === "ANALYSIS_DEGRADED" && !outstanding && !result.controller.chronosSession.distanceConfidence) {
                assert.equal(confidence, null, `seed ${seed}: nothing outstanding -> not downgraded by degradation alone`);
                notDowngraded += 1;
            }
            // trusted turns remain exactly the right walls, whatever happened
            ended.chronosSession.events.filter((e) => e.type === "turn").forEach((turn, index) => {
                assert.equal(turn.distanceMeters, path.turns[index].distanceMeters, `seed ${seed}`);
                assert.ok(Math.abs(turn.atMs - path.turns[index].arrivalMs) <= 700, `seed ${seed}`);
                if (confidence) assert.ok(turn.atMs <= confidence.sinceAtMs, `seed ${seed}: nothing trusted after the ambiguity`);
            });
            assert.equal(ended.chronosSession.events.some((e) => e.type === "finish"), false, `seed ${seed}`);
        }
        assert.ok(degraded >= 20, `fuzz exercised terminal degradation (${degraded})`);
        assert.ok(markedTerminal >= 15, `fuzz produced terminal marks (${markedTerminal})`);
        assert.ok(notDowngraded >= 1, `fuzz exercised the nothing-outstanding case (${notDowngraded})`);
        assert.ok(lostEnded >= 0);
    });
});
