// A COMPLETE reversal whose apex is OUTSIDE the wall zone must not leave distance
// "confirmed" (Chronos reliability phase 2E), THROUGH THE CONTROLLER.
//
// chronosAssessTurn() accepts a reversal only when its apex is inside a wall zone
// (x < 0.25 or x > 0.75, strict) and otherwise reads "none". A wall touch whose
// apex falls just outside the zone was therefore invisible: confidence stayed
// "confirmed" and the NEXT wall was recorded one pool length too early. Now a
// complete, sustained reversal outside the zone marks distance unconfirmed (reason
// "complete-reversal-outside-wall-zone") from its apex.
//
// WHAT THIS DOES AND DOES NOT CLAIM. The observations cannot say whether such a
// reversal is a wall the zone missed or a stop-and-return that is not a wall (the
// wall's position in the frame is exactly what is unknown), so the rule classifies
// nothing and infers no turn; it records that distance can no longer be trusted.
// A mid-pool stop-and-return is therefore marked too, by design; ordinary motion
// (monotone swimming, stroke oscillation, jitter, outliers, incomplete approaches,
// harmless gaps) is not.
//
// ALL DATA IS SYNTHETIC with explicit ground truth (the time each wall is reached).
// Passing proves the pipeline's logic on these inputs; it does NOT establish
// real-world accuracy and says nothing about lane calibration.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { raceConfig, runRace, driveRace, freshRaceController, poseSample, seededRandom, racePath, sampleRace } from "./synthetic-race.js";

import {
    DISTANCE_OUTSIDE_ZONE_REASON,
    DISTANCE_LANE_GATE_REASON,
    DISTANCE_AMBIGUITY_REASON,
    DISTANCE_ANALYSIS_ENDED_REASON
} from "../../src/race-pipeline/controller.js";
import { ChronosEngine } from "../../src/chronos-engine/index.js";

const SPEED = 0.058;
const cfg100 = raceConfig({ distanceMeters: 100 });

// A race as legs between wall apexes: [[fromX, toX], ...]. The swimmer rests at legs[0][0] until 6 s, then
// swims each leg at constant speed, dwelling `dwellMs` at each apex. Returns the samples and the time each
// apex is reached (the ground-truth wall times).
function legsRace(legs, { speed = SPEED, dwellMs = 480, tailMs = 7200, jitter = 0, oscillation = 0, seed = 1 } = {}) {
    const random = seededRandom(seed);
    const samples = [];
    const arrivals = [];
    let t = 0;
    const push = (x, face) => {
        const noise = jitter > 0 ? (random() * 2 - 1) * jitter : 0;
        samples.push(poseSample(t, x + noise + (oscillation ? oscillation * Math.sin(t / 380) : 0), { face }));
    };
    for (; t < 6000; t += 120) push(legs[0][0], 1);
    for (const [a, b] of legs) {
        const duration = (Math.abs(b - a) / speed) * 1000;
        const t0 = t;
        for (; t < t0 + duration; t += 120) push(a + (b - a) * ((t - t0) / duration), b > a ? 1 : -1);
        arrivals.push(Math.round(t0 + duration));
        for (let k = 0; k < dwellMs / 120; k += 1, t += 120) push(b, b > a ? 1 : -1);
    }
    for (let end = t + tailMs; t < end; t += 120) push(legs[legs.length - 1][1], 1);
    return { samples, arrivals };
}

// 100 m race, wall 1 (25 m) with the given apex on the given side, then the usual walls 2 and 3.
const rightFirst = (apex) => [[0.06, apex], [apex, 0.06], [0.06, 0.94], [0.94, 0.06]];
const leftFirst = (apex) => [[0.94, apex], [apex, 0.94], [0.94, 0.06], [0.06, 0.94]];

function observe(samples, config = cfg100) {
    let controller = freshRaceController(config);
    const assessments = new Map();
    let firstMark = null;
    for (const sample of samples) {
        controller = driveRace(controller, [sample]).controller;
        const a = controller.diagnostics.lastTurnAssessment;
        if (a) assessments.set(`${a.state}/${a.reason}`, (assessments.get(`${a.state}/${a.reason}`) || 0) + 1);
        if (firstMark === null && controller.chronosSession.distanceConfidence) {
            firstMark = JSON.stringify(controller.chronosSession.distanceConfidence);
        }
    }
    const events = controller.chronosSession.events;
    return {
        controller,
        assessments: Object.fromEntries(assessments),
        firstMark,
        events,
        turns: events.filter((e) => e.type === "turn"),
        report: ChronosEngine.buildReport(controller.chronosSession).report
    };
}

const labels = (result) => result.turns.map((t) => t.distanceMeters);

// ===========================================================================
// 1. CONTROL AND BOTH SIDES OF THE STRICT BOUNDARY
// ===========================================================================

describe("a clean race, and reversals just inside / just outside the strict zone edge", () => {
    test("CONTROL: a clean uninterrupted race keeps correct trusted distances and confirmed confidence", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(racePath({ lengths: 4 })) });
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75]);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
    });

    for (const [side, build, inside, outside] of [
        ["right (near-one)", rightFirst, [0.76, 0.8], [0.75, 0.7499, 0.74, 0.72, 0.6]],
        ["left (near-zero)", leftFirst, [0.24, 0.2], [0.25, 0.2501, 0.26, 0.28, 0.4]]
    ]) {
        test(`${side}: apex just INSIDE the zone is detected correctly and confidence is untouched`, () => {
            for (const apex of inside) {
                const { samples, arrivals } = legsRace(build(apex));
                const result = observe(samples);
                assert.deepEqual(labels(result), [25, 50, 75], `apex ${apex}`); // the 4-leg race: walls 1-3 are turns, wall 4 is the finish
                result.turns.forEach((turn, i) => assert.ok(Math.abs(turn.atMs - arrivals[i]) <= 400, `apex ${apex} turn ${i + 1}`));
                assert.equal(result.controller.chronosSession.distanceConfidence, null, `apex ${apex}`);
            }
        });

        test(`${side}: apex AT or OUTSIDE the zone is marked unconfirmed, with no trusted turn`, () => {
            for (const apex of outside) {
                const { samples } = legsRace(build(apex));
                const result = observe(samples);
                const confidence = result.controller.chronosSession.distanceConfidence;
                assert.ok(confidence, `apex ${apex} must be marked`);
                assert.equal(confidence.state, "unconfirmed");
                assert.equal(confidence.reason, DISTANCE_OUTSIDE_ZONE_REASON, `apex ${apex}`);
                assert.deepEqual(labels(result), [], `apex ${apex}: no trusted turn, in particular none labelled 25 m for the 50 m wall`);
            }
        });
    }

    test("BEFORE/AFTER (the audit's case, apex 0.74): the 50 m wall used to be recorded as 25 m with confidence 'confirmed'", () => {
        const { samples } = legsRace(rightFirst(0.74));
        const result = observe(samples);
        assert.equal(result.turns.some((t) => t.distanceMeters === 25), false);
        assert.notEqual(result.report.distanceConfidence.state, "confirmed");
    });
});

// ===========================================================================
// 2. NOTHING FABRICATED; DOWNSTREAM; TIMESTAMP; REASON; IDEMPOTENCE
// ===========================================================================

describe("the mark: no fabricated events, a safe downstream, the apex, the reason, the first record", () => {
    const apex = 0.74;
    const { samples, arrivals } = legsRace(rightFirst(apex));
    const result = observe(samples);
    const confidence = result.controller.chronosSession.distanceConfidence;

    test("no turn, split or finish is recorded: only the accepted start; the counter and report confirm nothing", () => {
        assert.deepEqual(result.events.map((e) => e.type), ["start"]);
        assert.equal(result.controller.eventAdapterState.confirmedDistanceMeters, 0);
        assert.equal(result.report.splits.length, 0);
        assert.equal(result.report.confirmedDistanceMeters, 0);
        assert.equal(result.report.finish, null);
        assert.equal(result.report.finalTimeMs, null);
    });

    test("DOWNSTREAM: the later genuine walls (true 50 m, 75 m) are seen but get NO distance; Chronos refuses them", () => {
        const observations = result.controller.diagnostics.unconfirmedTurnObservations;
        assert.equal(observations.length, 2);
        assert.ok(Math.abs(observations[0].apexAtMs - arrivals[1]) <= 400);
        assert.ok(Math.abs(observations[1].apexAtMs - arrivals[2]) <= 400);
        for (const o of observations) assert.equal(o.distanceMeters, undefined);
        const proposals = driveRace(freshRaceController(cfg100), samples).lastEventChanges.filter((c) => c.kind === "turn");
        assert.ok(proposals.length >= 2 && proposals.every((c) => c.ok === false && c.reason === "distance-progression-unconfirmed"));
        const refused = ChronosEngine.recordEvent(result.controller.chronosSession, { type: "turn", atMs: 40000, distanceMeters: 25, source: "detector", detector: "d", confidence: 0.9 });
        assert.deepEqual([refused.ok, refused.reason], [false, "distance-progression-unconfirmed"]);
    });

    test("the stable reason, the apex timestamp (at the wall, before the reversal could be known), and the evidence", () => {
        assert.equal(DISTANCE_OUTSIDE_ZONE_REASON, "complete-reversal-outside-wall-zone");
        assert.equal(confidence.reason, DISTANCE_OUTSIDE_ZONE_REASON);
        assert.equal(confidence.resumedAtMs, null);
        assert.equal(confidence.evidence.trigger, "reversal-outside-wall-zone");
        assert.equal(confidence.evidence.sinceBasis, "apex");
        assert.equal(confidence.sinceAtMs, confidence.evidence.apexAtMs);
        assert.ok(Math.abs(confidence.sinceAtMs - arrivals[0]) <= 400, `since ${confidence.sinceAtMs} vs wall ${arrivals[0]}`);
        assert.ok(confidence.evidence.evaluatedAtMs > confidence.sinceAtMs);
        assert.equal(confidence.evidence.approachedWallSide, "near-one");
        assert.ok(Math.abs(confidence.evidence.apexHipX - apex) < 0.01);
        assert.ok(confidence.evidence.distanceOutsideZone > 0 && confidence.evidence.distanceOutsideZone < 0.02);
        assert.equal(confidence.evidence.requiredTurns, 3);
        assert.equal(confidence.evidence.requiredTurnsKnown, true);
        assert.ok(confidence.sinceAtMs >= result.events[0].atMs);
    });

    test("the report and diagnostics reflect it", () => {
        assert.equal(result.report.distanceConfidence.state, "unconfirmed");
        assert.equal(result.report.distanceConfidence.reason, DISTANCE_OUTSIDE_ZONE_REASON);
        assert.ok(result.report.dataQuality.notes.some((n) => n.includes("distance progression unconfirmed") && n.includes(DISTANCE_OUTSIDE_ZONE_REASON)));
        assert.equal(result.controller.diagnostics.distanceConfidence.reason, DISTANCE_OUTSIDE_ZONE_REASON);
    });

    test("IDEMPOTENCE: the evidence repeats on every later frame while the reversal stands, but the record never changes", () => {
        assert.equal(JSON.stringify(confidence), result.firstMark);
    });

    test("an earlier gap record is kept; a later lane-gate or terminal record does not replace this one", () => {
        // wall 1 hidden by a gap (2C) -> the 2E reversal at wall 2 does not overwrite it
        const hidden = legsRace([[0.06, 0.94], [0.94, 0.5 + 0.0], [0.5, 0.94], [0.94, 0.06]]);
        const gap = observe(hidden.samples.filter((s) => !(s.atMs >= hidden.arrivals[0] - 700 && s.atMs < hidden.arrivals[0] + 500)));
        assert.equal(gap.controller.chronosSession.distanceConfidence.reason, DISTANCE_AMBIGUITY_REASON);
        assert.equal(JSON.stringify(gap.controller.chronosSession.distanceConfidence), gap.firstMark);

        // this record is kept when tracking later degrades
        const long = legsRace(rightFirst(0.74));
        const degraded = observe(long.samples.filter((s) => !(s.atMs >= long.arrivals[1] - 4000 && s.atMs < long.arrivals[1] + 4000)));
        assert.equal(degraded.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.equal(degraded.controller.chronosSession.distanceConfidence.reason, DISTANCE_OUTSIDE_ZONE_REASON);
        assert.equal(JSON.stringify(degraded.controller.chronosSession.distanceConfidence), degraded.firstMark);
        assert.notEqual(DISTANCE_ANALYSIS_ENDED_REASON, DISTANCE_OUTSIDE_ZONE_REASON);
    });
});

// ===========================================================================
// 3. WHAT MUST NOT TRIGGER IT (controls that keep the rule narrow)
// ===========================================================================

describe("ordinary motion, incomplete reversals and harmless gaps do not mark distance", () => {
    const clean = legsRace([[0.06, 0.94], [0.94, 0.06], [0.06, 0.94], [0.94, 0.06]]);

    test("an approach to a near-zone apex WITHOUT a completed reversal does not trigger it", () => {
        const approachOnly = legsRace([[0.06, 0.74]], { tailMs: 12000 });
        const result = observe(approachOnly.samples);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.notEqual(result.controller.diagnostics.lastTurnAssessment.state, "confirmed");
        assert.deepEqual(result.events.map((e) => e.type), ["start"]);
    });

    test("an approach followed by only a PARTIAL retreat (0.05 < the 0.08 reversal displacement) does not trigger it", () => {
        const partial = legsRace([[0.06, 0.74], [0.74, 0.69]], { tailMs: 12000 });
        assert.equal(observe(partial.samples).controller.chronosSession.distanceConfidence, null);
    });

    test("monotone swimming with stroke-cycle oscillation (±0.015) and hip jitter (±0.004) never triggers it, and the trusted turns are correct", () => {
        const result = observe(legsRace([[0.06, 0.94], [0.94, 0.06], [0.06, 0.94], [0.94, 0.06]], { oscillation: 0.015, jitter: 0.004, seed: 5 }).samples);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.deepEqual(labels(result), [25, 50, 75]);
    });

    test("single-sample position outliers (admitted by tracking or not) never trigger it", () => {
        for (const [at, mag] of [[10080, 0.081], [14040, 0.12], [30000, -0.2]]) {
            const samples = clean.samples.map((s) => (s.atMs === at ? poseSample(s.atMs, s.landmarks.hip.x - mag) : s));
            const result = observe(samples);
            assert.notEqual(result.controller.chronosSession.distanceConfidence && result.controller.chronosSession.distanceConfidence.reason, DISTANCE_OUTSIDE_ZONE_REASON, `outlier ${mag} at ${at}`);
        }
    });

    test("an ordinary mid-pool tracking gap (both ends outside the wall zones) marks nothing", () => {
        const samples = clean.samples.filter((s) => !(s.atMs >= 11000 && s.atMs < 13500));
        const result = observe(samples);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.deepEqual(labels(result), [25, 50, 75]);
    });

    test("when NO required turn is outstanding (after the 75 m turn of a 100 m race) a reversal outside the zone does not downgrade confidence", () => {
        // wall 1-3 normal (turns 25/50/75), finish wall at 0.06, then the swimmer swims 0.06 -> 0.55 and back to 0.2
        const after = legsRace([[0.06, 0.94], [0.94, 0.06], [0.06, 0.94], [0.94, 0.06], [0.06, 0.55], [0.55, 0.2]]);
        const result = observe(after.samples);
        assert.deepEqual(labels(result), [25, 50, 75]);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.controller.eventAdapterState.confirmedDistanceMeters, 75);
    });

    test("a mid-pool stop-and-return IS marked (the observations cannot tell it from a missed wall touch) — stated, not hidden", () => {
        const stopAndReturn = legsRace([[0.06, 0.5], [0.5, 0.3], [0.3, 0.94], [0.94, 0.06]]);
        const result = observe(stopAndReturn.samples);
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_OUTSIDE_ZONE_REASON);
        assert.ok(result.controller.chronosSession.distanceConfidence.evidence.distanceOutsideZone > 0.2, "the evidence says how far from the zone it was");
    });
});

// ===========================================================================
// 4. EXISTING PROTECTIONS RETAIN THEIR BEHAVIOR AND REASONS
// ===========================================================================

describe("the other distance-confidence paths are unchanged", () => {
    const path100 = racePath({ lengths: 4 });
    const wall1 = path100.turns[0].arrivalMs;

    test("a concealed turn is still marked by the observation-gap rule (2C)", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[wall1 - 700, wall1 + 500]] }) });
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_AMBIGUITY_REASON);
    });

    test("a complete reversal refused by the lane gate is still marked with the lane-gate reason (2D), not this one", () => {
        const ramp = (t) => {
            const up = Math.min(1, Math.max(0, (t - (wall1 - 7000)) / 5000));
            const down = Math.min(1, Math.max(0, (t - (wall1 + 3000)) / 5000));
            return 0.5 + 0.25 * (up - down);
        };
        const samples = sampleRace(path100).map((s) => poseSample(s.atMs, s.landmarks.hip.x, { y: ramp(s.atMs), face: s.landmarks.nose.x > s.landmarks.hip.x ? 1 : -1 }));
        assert.equal(observe(samples).controller.chronosSession.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
    });

    test("terminal tracking degradation is still marked with its own reason (2C follow-up)", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[wall1 - 700, wall1 + 2500]] }) });
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
    });

    test("a race whose distance cannot be counted is marked, with requiredTurnsKnown: false", () => {
        const odd = raceConfig({ distanceMeters: 60, event: "Freestyle 60m" });
        const { samples } = legsRace([[0.06, 0.74], [0.74, 0.06], [0.06, 0.94]]);
        const result = observe(samples, odd);
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_OUTSIDE_ZONE_REASON);
        assert.equal(result.controller.chronosSession.distanceConfidence.evidence.requiredTurnsKnown, false);
    });
});

// ===========================================================================
// 5. REPORT, PB, MANUAL TIMING, ISOLATION
// ===========================================================================

describe("report, PB, manual timing and isolation", () => {
    test("a manual finish keeps its time; the report says the distance is unverified; it is not a comparable PB", () => {
        const result = observe(legsRace(rightFirst(0.74)).samples);
        const finishAt = result.events[0].atMs + 80000;
        const finished = ChronosEngine.recordEvent(result.controller.chronosSession, { type: "finish", atMs: finishAt, distanceMeters: 100, source: "manual" });
        assert.equal(finished.ok, true, "manual timing stays compatible");
        const report = ChronosEngine.buildReport(finished.session).report;
        assert.equal(report.finalTimeMs, 80000);
        assert.equal(report.confirmedDistanceMeters, 0);
        assert.equal(report.distanceMeters, 100);
        assert.ok(report.dataQuality.notes.some((n) => n.startsWith("finish time recorded") && n.includes(DISTANCE_OUTSIDE_ZONE_REASON)));
        for (const pb of [{ event: report.event, course: report.course, time: "1:30.00", history: [] }, null]) {
            const comparison = ChronosEngine.comparePB(report, pb);
            assert.deepEqual([comparison.comparable, comparison.reason, comparison.isNewPb], [false, "distance-unconfirmed", false]);
        }
        // manual events remain accepted
        assert.equal(ChronosEngine.recordEvent(result.controller.chronosSession, { type: "split", atMs: 30000, distanceMeters: 30, source: "manual" }).ok, true);
    });

    test("a new analysis starts with fresh distance confidence", () => {
        const marked = observe(legsRace(rightFirst(0.74)).samples);
        assert.equal(marked.controller.chronosSession.distanceConfidence.reason, DISTANCE_OUTSIDE_ZONE_REASON);
        const fresh = freshRaceController(cfg100);
        assert.equal(fresh.chronosSession.distanceConfidence, null);
        assert.equal(fresh.diagnostics.distanceConfidence.state, "confirmed");
        const rerun = runRace({ config: cfg100, samples: sampleRace(racePath({ lengths: 4 })) });
        assert.deepEqual(rerun.turns.map((t) => t.distanceMeters), [25, 50, 75]);
    });
});

// ===========================================================================
// 6. SEEDED MULTI-RACE ORACLE
// ===========================================================================

describe("seeded fuzz: no trusted distance is ever wrong when some wall apex falls outside the zone", () => {
    test("150 random races with random apex positions: the first required wall outside the zone marks distance and nothing after it is trusted; every trusted turn is the right wall", () => {
        let withOutside = 0;
        let allInside = 0;
        for (let seed = 1; seed <= 150; seed += 1) {
            const random = seededRandom(seed * 31337);
            const lengths = 2 + Math.floor(random() * 5); // 2..6 lengths of a 25 m pool
            const apexes = [];
            for (let wall = 0; wall < lengths; wall += 1) {
                const rightSide = wall % 2 === 0; // the swimmer starts at the near (left) wall
                const outside = random() < 0.3;
                const apex = rightSide
                    ? (outside ? 0.58 + random() * 0.14 : 0.8 + random() * 0.16)
                    : (outside ? 0.28 + random() * 0.14 : 0.04 + random() * 0.16);
                apexes.push({ apex, outside });
            }
            const legs = [];
            let from = 0.06;
            for (const { apex } of apexes) { legs.push([from, apex]); from = apex; }
            const { samples, arrivals } = legsRace(legs, { speed: 0.06 + random() * 0.05, dwellMs: 480, seed });
            const distance = lengths * 25;
            const result = observe(samples, raceConfig({ distanceMeters: distance }));
            const confidence = result.controller.chronosSession.distanceConfidence;

            // the first wall that REQUIRES a turn (all but the last) whose apex is outside the zone
            const k = apexes.slice(0, lengths - 1).findIndex((w) => w.outside);

            result.turns.forEach((turn, index) => {
                assert.equal(turn.distanceMeters, (index + 1) * 25, `seed ${seed}: trusted label`);
                assert.ok(Math.abs(turn.atMs - arrivals[index]) <= 700, `seed ${seed}: trusted turn ${index + 1} is wall ${index + 1} (${turn.atMs} vs ${arrivals[index]})`);
            });
            if (k === -1) {
                allInside += 1;
                assert.equal(confidence, null, `seed ${seed}: every required wall is inside the zone -> nothing marked`);
                assert.equal(result.turns.length, lengths - 1, `seed ${seed}: every required turn is trusted`);
            } else {
                withOutside += 1;
                assert.ok(confidence, `seed ${seed}: wall ${k + 1} apex ${apexes[k].apex.toFixed(2)} is outside the zone -> marked`);
                assert.equal(confidence.reason, DISTANCE_OUTSIDE_ZONE_REASON, `seed ${seed}`);
                assert.ok(result.turns.length <= k, `seed ${seed}: at most the walls before ${k + 1} are trusted`);
                assert.ok(Math.abs(confidence.sinceAtMs - arrivals[k]) <= 700, `seed ${seed}: since ${confidence.sinceAtMs} vs wall ${arrivals[k]}`);
                result.turns.forEach((turn) => assert.ok(turn.atMs <= confidence.sinceAtMs, `seed ${seed}: nothing trusted after the mark`));
            }
            assert.equal(result.events.some((e) => e.type === "finish"), false);
        }
        assert.ok(withOutside >= 40, `fuzz exercised outside-zone apexes (${withOutside})`);
        assert.ok(allInside >= 15, `fuzz exercised all-inside races (${allInside})`);
    });
});
