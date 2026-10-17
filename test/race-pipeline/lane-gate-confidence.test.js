// A complete wall reversal refused by the LANE GATE must not leave distance
// "confirmed" (Chronos reliability phase 2D), THROUGH THE CONTROLLER.
//
// chronosAssessTurn() returns `rejected` / `lane-deviation` only for a COMPLETE
// reversal (apex in a wall zone, approach and sustained recovery all observed)
// whose apex lies outside the lane (|nose.y - referenceLaneY| > 0.20). Such a
// reversal never becomes a candidate, yet a real turn happened; before this
// change the next wall was then recorded one pool length too early while the
// report still said "confirmed". Now the race's distance is marked unconfirmed
// (reason "wall-reversal-refused-by-lane-gate") from the reversal's apex.
//
// ALL DATA IS SYNTHETIC with explicit ground truth from
// test/race-pipeline/synthetic-race.js (the time the swimmer reaches each wall).
// Passing proves the pipeline's logic and invariants on these inputs. It does
// NOT establish real-world accuracy, and it says nothing about lane calibration.

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
    noPoseSample
} from "./synthetic-race.js";

import {
    DISTANCE_LANE_GATE_REASON,
    DISTANCE_AMBIGUITY_REASON,
    DISTANCE_ANALYSIS_ENDED_REASON,
    racePipelineEndAnalysis
} from "../../src/race-pipeline/controller.js";
import { ChronosEngine } from "../../src/chronos-engine/index.js";
import { chronosAssessTurn, TURN_ASSESSMENT_DEFAULTS } from "../../src/chronos-engine/detectors/turn-detector.js";

const path100 = racePath({ lengths: 4 }); // walls: 25 m ~21,172; 50 m ~36,745; 75 m ~52,317; finish wall ~67,890
const cfg100 = raceConfig({ distanceMeters: 100 });
const wall = (i) => path100.turns[i].arrivalMs;

// The swimmer's y drifts slowly (gradually enough for tracking continuity) from the calibrated lane
// (0.5) to 0.5 + drift over 5 s ending 2 s before the wall, holds through the wall, and returns.
function laneDriftSamples(path, atWallMs, drift, extra = {}) {
    const ramp = (t) => {
        const up = Math.min(1, Math.max(0, (t - (atWallMs - 7000)) / 5000));
        const down = Math.min(1, Math.max(0, (t - (atWallMs + 3000)) / 5000));
        return 0.5 + drift * (up - down);
    };
    return sampleRace(path, extra).map((s) => (s.hasPose
        ? poseSample(s.atMs, s.landmarks.hip.x, { y: ramp(s.atMs), face: s.landmarks.nose.x > s.landmarks.hip.x ? 1 : -1 })
        : s));
}

// Frame by frame, recording what the turn assessment said and the confidence record when it first appeared.
function observe(samples, config = cfg100) {
    let controller = freshRaceController(config);
    const rejections = new Map();
    let firstMark = null;
    let firstLaneRefusal = null;
    for (const sample of samples) {
        controller = driveRace(controller, [sample]).controller;
        const assessment = controller.diagnostics.lastTurnAssessment;
        if (assessment && assessment.state === "rejected") {
            rejections.set(assessment.reason, (rejections.get(assessment.reason) || 0) + 1);
            if (assessment.reason === "lane-deviation" && firstLaneRefusal === null) {
                firstLaneRefusal = { evaluatedAtMs: sample.atMs, apexAtMs: assessment.apexAtMs };
            }
        }
        if (firstMark === null && controller.chronosSession.distanceConfidence) {
            firstMark = { atMs: sample.atMs, record: JSON.stringify(controller.chronosSession.distanceConfidence) };
        }
    }
    const events = controller.chronosSession.events;
    return {
        controller,
        rejections: Object.fromEntries(rejections),
        firstMark,
        firstLaneRefusal,
        turns: events.filter((e) => e.type === "turn"),
        events,
        report: ChronosEngine.buildReport(controller.chronosSession).report
    };
}

const control = observe(laneDriftSamples(path100, wall(0), 0.19));
const cleanRace = runRace({ config: cfg100, samples: sampleRace(path100) }); // no drift at all

// ===========================================================================
// 1. CONTROL AND THE TWO FAILURE DRIFTS
// ===========================================================================

describe("gradual lane drift at the first wall", () => {
    test("CONTROL, drift 0.19 (inside the 0.20 gate): accepted, correct distances, confidence untouched, no lane refusal", () => {
        assert.deepEqual(control.turns.map((t) => t.distanceMeters), [25, 50, 75]);
        control.turns.forEach((turn, i) => assert.ok(Math.abs(turn.atMs - path100.turns[i].arrivalMs) <= 400, `turn ${i + 1} at ${turn.atMs}`));
        assert.equal(control.controller.chronosSession.distanceConfidence, null);
        assert.equal(control.rejections["lane-deviation"], undefined);
        assert.equal(control.report.distanceConfidence.state, "confirmed");
    });

    for (const drift of [0.21, 0.25]) {
        test(`drift ${drift} (beyond the gate): the reversal is refused as lane-deviation AND distance is marked unconfirmed`, () => {
            const result = observe(laneDriftSamples(path100, wall(0), drift));
            assert.ok(result.rejections["lane-deviation"] > 0, "the assessment refused the reversal");

            const confidence = result.controller.chronosSession.distanceConfidence;
            assert.equal(confidence.state, "unconfirmed");
            assert.equal(confidence.reason, DISTANCE_LANE_GATE_REASON);
            assert.equal(DISTANCE_LANE_GATE_REASON, "wall-reversal-refused-by-lane-gate");
            assert.equal(confidence.resumedAtMs, null);
            assert.equal(confidence.evidence.trigger, "lane-gate-refusal");
            assert.equal(confidence.evidence.wallSide, "near-one");
            assert.ok(confidence.evidence.laneDeviation > 0.2);
            assert.equal(confidence.evidence.requiredTurns, 3);
            assert.equal(confidence.evidence.requiredTurnsKnown, true);
            assert.equal(confidence.evidence.confirmedDistanceMeters, 0);

            assert.equal(result.report.distanceConfidence.state, "unconfirmed");
            assert.equal(result.report.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
            assert.ok(result.report.dataQuality.notes.some((n) => n.includes("distance progression unconfirmed") && n.includes(DISTANCE_LANE_GATE_REASON)));
            assert.equal(result.controller.diagnostics.distanceConfidence.state, "unconfirmed");
            assert.equal(result.controller.diagnostics.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
        });
    }

    test("BEFORE/AFTER: this exact run used to record the 50 m wall as 25 m with confidence 'confirmed'", () => {
        const result = observe(laneDriftSamples(path100, wall(0), 0.21));
        assert.equal(result.turns.some((t) => t.distanceMeters === 25), false, "no wall is labelled 25 m");
        assert.notEqual(result.report.distanceConfidence.state, "confirmed");
    });
});

// ===========================================================================
// 2. NOTHING IS FABRICATED; DOWNSTREAM IS SAFE
// ===========================================================================

describe("the refused reversal is never an event, and later walls get no trusted distance", () => {
    const refused = observe(laneDriftSamples(path100, wall(0), 0.25));

    test("no trusted turn or split is recorded for it (or for anything else): only the accepted start remains", () => {
        assert.deepEqual(refused.events.map((e) => e.type), ["start"]);
        assert.deepEqual(refused.events[0], control.events[0], "the accepted start is untouched");
        assert.equal(refused.report.splits.length, 0);
        assert.equal(refused.report.confirmedDistanceMeters, 0);
        assert.equal(refused.controller.eventAdapterState.confirmedDistanceMeters, 0, "the trusted counter did not move");
        assert.equal(refused.report.finish, null);
        assert.equal(refused.report.finalTimeMs, null);
    });

    test("DOWNSTREAM: the two later genuine walls (true 50 m and 75 m) are seen but receive NO distance; neither reaches Chronos", () => {
        const observations = refused.controller.diagnostics.unconfirmedTurnObservations;
        assert.equal(observations.length, 2);
        assert.ok(Math.abs(observations[0].apexAtMs - wall(1)) <= 400);
        assert.ok(Math.abs(observations[1].apexAtMs - wall(2)) <= 400);
        for (const o of observations) assert.equal(o.distanceMeters, undefined);
        const proposals = driveRace(freshRaceController(cfg100), laneDriftSamples(path100, wall(0), 0.25)).lastEventChanges.filter((c) => c.kind === "turn");
        assert.equal(proposals.length, 2);
        assert.ok(proposals.every((c) => c.ok === false && c.reason === "distance-progression-unconfirmed"));
    });

    test("a detector finish or turn is refused by Chronos itself afterwards (existing protection holds)", () => {
        const session = refused.controller.chronosSession;
        const turn = ChronosEngine.recordEvent(session, { type: "turn", atMs: 40000, distanceMeters: 25, source: "detector", detector: "d", confidence: 0.9 });
        const finish = ChronosEngine.recordEvent(session, { type: "finish", atMs: 90000, distanceMeters: 100, source: "detector", detector: "d", confidence: 0.9 });
        assert.deepEqual([turn.ok, turn.reason, finish.ok, finish.reason], [false, "distance-progression-unconfirmed", false, "distance-progression-unconfirmed"]);
    });
});

// ===========================================================================
// 3. IDEMPOTENCE AND THE FIRST RECORD
// ===========================================================================

describe("the first ambiguity record is kept", () => {
    test("the refusal repeats on every later frame while the reversal stands, but the record never changes", () => {
        const result = observe(laneDriftSamples(path100, wall(0), 0.25));
        assert.ok(result.rejections["lane-deviation"] >= 20, `the assessment repeated (${result.rejections["lane-deviation"]}x)`);
        assert.equal(JSON.stringify(result.controller.chronosSession.distanceConfidence), result.firstMark.record);
    });

    test("a refusal at a SECOND wall does not overwrite the first record", () => {
        // drift around BOTH wall 1 and wall 2
        const ramp1 = laneDriftSamples(path100, wall(0), 0.25);
        const second = laneDriftSamples(path100, wall(1), 0.25);
        const samples = ramp1.map((s, i) => (second[i].hasPose && Math.abs(second[i].landmarks.nose.y - 0.5) > Math.abs(s.landmarks.nose.y - 0.5) ? second[i] : s));
        const result = observe(samples);
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
        assert.equal(JSON.stringify(result.controller.chronosSession.distanceConfidence), result.firstMark.record);
        assert.ok(result.controller.chronosSession.distanceConfidence.sinceAtMs < wall(1) - 5000, "the FIRST wall's apex");
    });

    test("an earlier gap record is kept when a lane refusal follows", () => {
        // wall 1 hidden (gap rule fires), then wall 2 refused by the lane gate
        const samples = laneDriftSamples(path100, wall(1), 0.25, { dropouts: [[wall(0) - 700, wall(0) + 500]] });
        const result = observe(samples);
        assert.ok(result.rejections["lane-deviation"] > 0, "the later refusal did occur");
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_AMBIGUITY_REASON);
        assert.equal(JSON.stringify(result.controller.chronosSession.distanceConfidence), result.firstMark.record);
    });

    test("a lane record is kept when tracking later degrades or the stream ends", () => {
        const samples = laneDriftSamples(path100, wall(0), 0.25, { dropouts: [[wall(1) + 3000, wall(1) + 12000]] });
        const result = observe(samples);
        assert.equal(result.controller.trackingSession.status, "ANALYSIS_DEGRADED");
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
        const ended = racePipelineEndAnalysis(result.controller);
        assert.equal(ended.marked, false);
        assert.equal(ended.controller.chronosSession.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
    });
});

// ===========================================================================
// 4. THE TIMESTAMP
// ===========================================================================

describe("sinceAtMs is the reversal's apex", () => {
    test("it equals the apex time in the assessment evidence, at the real wall, before the refusal could be known", () => {
        const result = observe(laneDriftSamples(path100, wall(0), 0.25));
        const confidence = result.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.evidence.sinceBasis, "apex");
        assert.equal(confidence.sinceAtMs, confidence.evidence.apexAtMs);
        assert.equal(confidence.sinceAtMs, result.firstLaneRefusal.apexAtMs, "the apex of the FIRST refusal");
        assert.ok(Math.abs(confidence.sinceAtMs - wall(0)) <= 400, `apex ${confidence.sinceAtMs} vs wall ${wall(0)}`);
        assert.ok(confidence.evidence.evaluatedAtMs > confidence.sinceAtMs, "the refusal was established later than the apex");
        assert.ok(confidence.sinceAtMs >= result.events[0].atMs, "never before the accepted start");
    });

    test("trusted turns recorded BEFORE the refused wall are kept, and stay at or before sinceAtMs", () => {
        const result = observe(laneDriftSamples(path100, wall(1), 0.25)); // wall 1 is fine, wall 2 is refused
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25]);
        assert.deepEqual(result.turns[0], cleanRace.turns[0], "the first turn is identical to the uninterrupted run's");
        const confidence = result.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.reason, DISTANCE_LANE_GATE_REASON);
        assert.ok(result.turns[0].atMs <= confidence.sinceAtMs);
        assert.ok(Math.abs(confidence.sinceAtMs - wall(1)) <= 400);
        assert.equal(result.report.confirmedDistanceMeters, 25);
        assert.deepEqual(result.report.splits, cleanRace.report.splits.slice(0, 1));
    });
});

// ===========================================================================
// 5. WHAT MUST NOT TRIGGER IT
// ===========================================================================

describe("only a COMPLETE reversal refused by the lane gate triggers it", () => {
    // Approach to the far wall, optionally a partial or full recovery. x in frame widths, 120 ms cadence,
    // y drifted 0.25 (beyond the gate) around the wall.
    function approach({ recovery }) {
        const samples = [];
        let t = 0;
        for (; t < 6000; t += 120) samples.push(poseSample(t, 0.06));
        const yAt = (time) => 0.5 + 0.25 * Math.min(1, Math.max(0, (time - 8000) / 4000));
        for (let k = 0; k < 140; k += 1, t += 120) {
            const x = Math.min(0.94, 0.06 + 0.058 * ((t - 6000) / 1000));
            samples.push(poseSample(t, x, { y: yAt(t) }));
        }
        const apexX = 0.94;
        for (let k = 0; k < 5; k += 1, t += 120) samples.push(poseSample(t, apexX, { y: yAt(t) }));
        for (let k = 1; k <= 25; k += 1, t += 120) {
            const x = Math.max(apexX - recovery, apexX - 0.007 * k);
            samples.push(poseSample(t, x, { y: yAt(t) }));
        }
        for (let k = 0; k < 20; k += 1, t += 120) samples.push(poseSample(t, apexX - recovery, { y: yAt(t) }));
        return samples;
    }

    test("an approach that ends AT the wall (no recovery) does not trigger it", () => {
        const result = observe(approach({ recovery: 0 }));
        assert.equal(result.rejections["lane-deviation"], undefined);
        assert.equal(result.controller.chronosSession.status, "running");
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.controller.diagnostics.lastTurnAssessment.state, "plausible");
    });

    test("an approach with only a PARTIAL recovery (0.05 < the 0.08 reversal displacement) does not trigger it", () => {
        const result = observe(approach({ recovery: 0.05 }));
        assert.equal(result.rejections["lane-deviation"], undefined);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
    });

    test("a COMPLETE reversal in the same drifted lane DOES trigger it (the contrast)", () => {
        const result = observe(approach({ recovery: 0.3 }));
        assert.ok(result.rejections["lane-deviation"] > 0);
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
    });

    test("rejections for OTHER reasons keep their behavior: duplicate frames at a wall (rejected / non-monotonic-timestamp) mark nothing", () => {
        const doubled = [];
        for (const s of sampleRace(path100)) {
            doubled.push(s);
            if (s.atMs > wall(0) - 3000 && s.atMs < wall(0) + 3000) doubled.push(s);
        }
        const result = observe(doubled);
        assert.ok(result.rejections["non-monotonic-timestamp"] > 0, "test setup: that rejection did reach the controller");
        assert.equal(result.rejections["lane-deviation"], undefined);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75]);
    });

    test("an ordinary mid-pool tracking gap is not a lane-gate refusal, even with the lane drifted (no wall reversal occurs)", () => {
        const samples = sampleRace(path100)
            .map((s) => poseSample(s.atMs, s.landmarks.hip.x, { y: 0.5 + 0.25 * Math.min(1, Math.max(0, 1 - Math.abs(s.atMs - 12000) / 3000)), face: 1 }))
            .filter((s) => !(s.atMs >= 11000 && s.atMs < 12500));
        const result = observe(samples);
        assert.equal(result.rejections["lane-deviation"], undefined);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.turns.length, 3);
    });

    test("when NO required turn is outstanding (the finish wall of a 100 m race, 75 m already trusted) a refused reversal does not downgrade confidence", () => {
        const path5 = racePath({ lengths: 5 }); // the swimmer turns back at the finish wall (the 4th wall contact)
        const result = observe(laneDriftSamples(path5, path5.turns[3].arrivalMs, 0.25));
        assert.ok(result.rejections["lane-deviation"] > 0, "test setup: the reversal was refused");
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75]);
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.controller.eventAdapterState.confirmedDistanceMeters, 75);
    });

    test("when the race distance cannot be counted, a refused reversal is marked (the answer is 'possible', never a guess)", () => {
        const odd = raceConfig({ distanceMeters: 60, event: "Freestyle 60m" });
        const result = observe(laneDriftSamples(racePath({ lengths: 3 }), racePath({ lengths: 3 }).turns[0].arrivalMs, 0.25), odd);
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
        assert.equal(result.controller.chronosSession.distanceConfidence.evidence.requiredTurnsKnown, false);
    });
});

// ===========================================================================
// 6. REPORT AND PB
// ===========================================================================

describe("report and PB for a race whose reversal was refused by the lane gate", () => {
    test("a finish keeps its exact time, the report says the distance is unverified, and the result is not a comparable PB", () => {
        const result = observe(laneDriftSamples(path100, wall(0), 0.25));
        const finishAt = result.events[0].atMs + 80000;
        const finished = ChronosEngine.recordEvent(result.controller.chronosSession, { type: "finish", atMs: finishAt, distanceMeters: 100, source: "manual" });
        assert.equal(finished.ok, true, "manual timing stays compatible");
        const report = ChronosEngine.buildReport(finished.session).report;
        assert.equal(report.finish.atMs, finishAt);
        assert.equal(report.finalTimeMs, 80000);
        assert.equal(report.distanceMeters, 100);
        assert.equal(report.confirmedDistanceMeters, 0);
        assert.ok(report.dataQuality.notes.some((n) => n.startsWith("finish time recorded") && n.includes(DISTANCE_LANE_GATE_REASON)));
        const pb = { event: report.event, course: report.course, time: "1:30.00", history: [] };
        for (const record of [pb, null]) {
            const comparison = ChronosEngine.comparePB(report, record);
            assert.equal(comparison.comparable, false);
            assert.equal(comparison.reason, "distance-unconfirmed");
            assert.equal(comparison.isNewPb, false);
        }
    });
});

// ===========================================================================
// 7. EXISTING PROTECTIONS RETAIN THEIR REASONS
// ===========================================================================

describe("the other distance-confidence paths are unchanged", () => {
    test("a concealed turn is still marked by the observation-gap rule, with its own reason", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[wall(0) - 700, wall(0) + 500]] }) });
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_AMBIGUITY_REASON);
    });

    test("terminal tracking degradation is still marked with its own reason", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100, { dropouts: [[wall(0) - 700, wall(0) + 2500]] }) });
        assert.equal(result.controller.chronosSession.distanceConfidence.reason, DISTANCE_ANALYSIS_ENDED_REASON);
    });

    test("an uninterrupted, in-lane race is untouched by this path", () => {
        const result = runRace({ config: cfg100, samples: sampleRace(path100) });
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25, 50, 75]);
    });

    test("manual events remain accepted on a lane-refused race", () => {
        const result = observe(laneDriftSamples(path100, wall(0), 0.25));
        let session = result.controller.chronosSession;
        for (const input of [{ type: "split", atMs: 30000, distanceMeters: 30, source: "manual" }, { type: "turn", atMs: 40000, distanceMeters: 50, source: "manual" }]) {
            const recorded = ChronosEngine.recordEvent(session, input);
            assert.equal(recorded.ok, true, input.type);
            session = recorded.session;
        }
        assert.equal(session.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
    });
});

// ===========================================================================
// 8. ISOLATION
// ===========================================================================

describe("race isolation", () => {
    test("a new analysis from a controller whose previous race was lane-refused starts fresh and trusted", () => {
        const refused = observe(laneDriftSamples(path100, wall(0), 0.25));
        assert.equal(refused.controller.chronosSession.distanceConfidence.reason, DISTANCE_LANE_GATE_REASON);
        const again = freshRaceController(cfg100);
        assert.equal(again.chronosSession.distanceConfidence, null);
        const rerun = runRace({ config: cfg100, samples: sampleRace(path100) });
        assert.deepEqual(rerun.turns.map((t) => t.distanceMeters), [25, 50, 75]);
    });
});

// ===========================================================================
// 8. THE GATE'S BOUNDARY IS STRICT AND EXACT (detector level)
// ===========================================================================

describe("the lane gate refuses only a deviation strictly GREATER than the threshold", () => {
    // One complete wall reversal at the near-one wall (approach 0.50 -> 0.90, retreat to 0.74), the nose held at
    // y = noseY throughout. Returns every assessment so the test can ask what the detector said at any point.
    function assessReversal(noseY, referenceLaneY, config = {}) {
        const xs = [];
        for (let k = 0; k <= 20; k += 1) xs.push(0.5 + 0.02 * k);
        for (let j = 1; j <= 8; j += 1) xs.push(0.9 - 0.02 * j);
        const history = [];
        const results = [];
        xs.forEach((x, i) => {
            const current = {
                atMs: i * 100,
                hip: { x, y: 0.5, visibility: 0.9 },
                nose: { x: x + 0.04, y: noseY, visibility: 0.9 }
            };
            results.push(chronosAssessTurn({ sample: current, recentSamples: history, config: { referenceLaneY, ...config } }));
            history.push(current);
        });
        return results;
    }
    const states = (results) => new Set(results.map((r) => `${r.state}/${r.reason}`));

    test("the shipped threshold is 0.20 and a deviation of exactly the threshold is ACCEPTED (strict >)", () => {
        assert.equal(TURN_ASSESSMENT_DEFAULTS.laneDeviationThreshold, 0.2);
        // |0.5 - 0.3| is computed in floating point; assert it IS the threshold before relying on it.
        assert.equal(Math.abs(0.5 - 0.3), TURN_ASSESSMENT_DEFAULTS.laneDeviationThreshold, "fixture sanity: the deviation equals the threshold");
        const results = assessReversal(0.5, 0.3);
        assert.ok(states(results).has("confirmed/wall-reversal"), [...states(results)].join(", "));
        assert.equal(states(results).has("rejected/lane-deviation"), false);
    });

    test("a deviation just beyond the threshold is REFUSED as lane-deviation, and no candidate is produced", () => {
        for (const reference of [0.29, 0.2999, 0.7001, 0.71]) {
            const results = assessReversal(0.5, reference);
            assert.ok(states(results).has("rejected/lane-deviation"), `reference ${reference}: ${[...states(results)].join(", ")}`);
            assert.equal(results.some((r) => r.candidate !== null), false, `reference ${reference}`);
            assert.ok(results.find((r) => r.reason === "lane-deviation").evidence.laneDeviation > TURN_ASSESSMENT_DEFAULTS.laneDeviationThreshold);
        }
    });

    test("the boundary is the same on both sides of the reference lane, and is exact for an exactly representable threshold", () => {
        // threshold 0.25 and a reference 0.25 away are all exact in binary floating point.
        for (const [noseY, reference] of [[0.5, 0.25], [0.5, 0.75]]) {
            const atBoundary = assessReversal(noseY, reference, { laneDeviationThreshold: 0.25 });
            assert.ok(states(atBoundary).has("confirmed/wall-reversal"), `at the boundary, reference ${reference}`);
            const beyond = assessReversal(noseY, reference + (reference < noseY ? -0.001 : 0.001), { laneDeviationThreshold: 0.25 });
            assert.ok(states(beyond).has("rejected/lane-deviation"), `beyond the boundary, reference ${reference}`);
        }
    });
});
