// Distance confidence THROUGH THE CONTROLLER (Chronos reliability phase 2C).
//
// Every scenario drives the REAL SwimmerTracking -> detector adapter -> event
// adapter -> ChronosEngine chain. ALL DATA IS SYNTHETIC, with explicit ground
// truth from test/race-pipeline/synthetic-race.js (the time the swimmer reaches
// each wall). Passing proves the pipeline's logic and invariants on these
// inputs; it does NOT establish accuracy on real swimming footage, and it does
// not show that the wall-zone rule catches every concealed turn in real video.
//
// RULE UNDER TEST (docs/RACE_PIPELINE_ARCHITECTURE.md §9.1): when the interval
// between two consecutive usable target observations is longer than 600 ms AND
// either bounding observation lies in a wall zone (x < 0.25 or x > 0.75), a
// turn could have been concealed: the race's distance progression is marked
// UNCONFIRMED from the last observation before the gap, for the rest of the
// race. Nothing is inferred; later wall contacts are diagnostics only.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePath,
    sampleRace,
    raceConfig,
    runRace,
    driveRace,
    freshRaceController,
    summarize,
    poseSample,
    seededRandom
} from "./synthetic-race.js";

import {
    racePipelineStartAnalysis,
    racePipelineCreateController,
    racePipelineStopAnalysis,
    DISTANCE_AMBIGUITY_REASON
} from "../../src/race-pipeline/controller.js";
import { ChronosEngine } from "../../src/chronos-engine/index.js";

const DT = 120;
const config100 = raceConfig({ distanceMeters: 100 });
const path100 = racePath({ lengths: 4 }); // wall contacts: 25 m @ ~21,172; 50 m @ ~36,745; 75 m @ ~52,317
const arrival1 = path100.turns[0].arrivalMs;

const lastSampleBefore = (ms) => Math.ceil(ms / DT) * DT - DT;
const firstSampleAtOrAfter = (ms) => Math.ceil(ms / DT) * DT;

function race(options = {}, { path = path100, config = config100 } = {}) {
    return runRace({ config, samples: sampleRace(path, options) });
}

function trustedLabels(result) {
    return result.turns.map((turn) => [turn.distanceMeters, turn.atMs]);
}

const control = race();

// ===========================================================================
// 1. CONTROL: uninterrupted tracking is unchanged
// ===========================================================================

describe("control: uninterrupted tracking preserves the phase-2 distance and split behavior", () => {
    test("every wall is a trusted turn at the right distance; confidence stays 'confirmed'; nothing is unconfirmed", () => {
        assert.deepEqual(control.turns.map((t) => t.distanceMeters), [25, 50, 75]);
        assert.equal(control.controller.chronosSession.distanceConfidence, null);
        assert.deepEqual(control.report.distanceConfidence, { state: "confirmed", reason: null, sinceAtMs: null, resumedAtMs: null });
        assert.deepEqual(control.controller.diagnostics.distanceConfidence, { state: "confirmed", reason: null, sinceAtMs: null, resumedAtMs: null });
        assert.deepEqual(control.controller.diagnostics.unconfirmedTurnObservations, []);
        assert.equal(control.confirmedDistanceMeters, 75);
        assert.equal(control.report.splits.length, 3);
        assert.equal(control.status, "running");
        assert.equal(control.finish, null);
    });

    test("ordinary jitter and slower sampling cadences (gaps well under 600 ms) never trigger it", () => {
        for (const dt of [120, 200, 300]) {
            for (const jitter of [0, 0.004]) {
                const result = race({ dt, jitter, seed: 3 });
                assert.equal(result.controller.chronosSession.distanceConfidence, null, `dt=${dt} jitter=${jitter}`);
                assert.equal(result.turns.length, 3);
            }
        }
    });
});

// ===========================================================================
// 2. HARMLESS GAPS
// ===========================================================================

describe("harmless gaps do not invalidate distance confidence", () => {
    test("a long dropout with both bounding observations mid-pool (target lost and reacquired) leaves distance confirmed and later turns identical to the control", () => {
        for (const [from, to] of [[12000, 13000], [11000, 14000], [10000, 13500]]) {
            const result = race({ dropouts: [[from, to]] });
            const before = path100.xAt(lastSampleBefore(from)).x;
            const after = path100.xAt(firstSampleAtOrAfter(to)).x;
            assert.ok(before > 0.25 && before < 0.75 && after > 0.25 && after < 0.75, `test setup: ends mid-pool (${before.toFixed(2)}, ${after.toFixed(2)})`);
            assert.equal(result.controller.chronosSession.distanceConfidence, null, `${from}-${to}`);
            assert.deepEqual(trustedLabels(result), trustedLabels(control), `${from}-${to}`);
        }
    });

    test("intermittent short dropouts AT the wall (every gap <= 600 ms) never trigger it", () => {
        const dropouts = [];
        for (let t = arrival1 - 1500; t < arrival1 + 1500; t += 480) dropouts.push([t, t + 240]); // a 240 ms hole every 480 ms
        const result = race({ dropouts });
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
    });

    test("a gap of exactly the limit at the wall is continuous; one sample longer is not", () => {
        // grid samples every 120 ms: a hole of 4 samples = gap 600 ms; 5 samples = 720 ms
        const base = firstSampleAtOrAfter(arrival1 - 2000);
        const exact = race({ dropouts: [[base + 1, base + 3 * DT + 1]] }); // removes samples base+120..base+360 -> gap 480
        const edge = race({ dropouts: [[base + 1, base + 4 * DT + 1]] }); // removes 4 samples -> gap 600
        const over = race({ dropouts: [[base + 1, base + 5 * DT + 1]] }); // removes 5 samples -> gap 720
        assert.equal(exact.controller.chronosSession.distanceConfidence, null);
        assert.equal(edge.controller.chronosSession.distanceConfidence, null);
        assert.equal(over.controller.chronosSession.distanceConfidence.state, "unconfirmed");
    });
});

// ===========================================================================
// 3 / 4. AMBIGUOUS APPROACH GAP, AND THE MISSED TURN
// ===========================================================================

describe("a gap next to a wall that could hide a turn marks distance unconfirmed", () => {
    test("approach gap: the swimmer is hidden on the way in and seen again at the wall", () => {
        const from = arrival1 - 1500;
        const to = arrival1 - 100;
        const result = race({ dropouts: [[from, to]] });
        const confidence = result.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.state, "unconfirmed");
        assert.equal(confidence.reason, DISTANCE_AMBIGUITY_REASON);
        assert.equal(confidence.sinceAtMs, lastSampleBefore(from), "from the last observation BEFORE the gap");
        assert.equal(confidence.resumedAtMs, firstSampleAtOrAfter(to));
        assert.equal(confidence.evidence.afterWallSide, "near-one");
    });

    test("MISSED TURN: pose hidden around a real turn, then resumed — later wall contacts get NO trusted distance (they were labelled one length too early before phase 2C)", () => {
        const from = arrival1 - 700;
        const to = arrival1 + 500;
        const result = race({ dropouts: [[from, to]] });

        assert.equal(result.controller.chronosSession.distanceConfidence.state, "unconfirmed");
        assert.equal(result.controller.chronosSession.distanceConfidence.sinceAtMs, lastSampleBefore(from));
        assert.equal(result.turns.length, 0, "no turn carries a (wrong) trusted distance");
        assert.equal(result.confirmedDistanceMeters, 0, "the confirmed distance is not advanced");

        // The later physical walls (true 50 m and 75 m) were SEEN: they are kept as observations only.
        const observations = result.controller.diagnostics.unconfirmedTurnObservations;
        assert.equal(observations.length, 2);
        assert.ok(Math.abs(observations[0].apexAtMs - path100.turns[1].arrivalMs) < 600);
        assert.ok(Math.abs(observations[1].apexAtMs - path100.turns[2].arrivalMs) < 600);
        assert.ok(observations.every((o) => o.wallSide === "near-zero" || o.wallSide === "near-one"));
        for (const o of observations) assert.equal(o.distanceMeters, undefined, "an observation carries no distance at all");

        // ...and none of them reached Chronos.
        assert.ok(result.lastEventChanges.filter((c) => c.kind === "turn").every((c) => c.ok === false && c.reason === "distance-progression-unconfirmed"));
        assert.deepEqual(result.events.map((e) => e.type), ["start"]);
    });

    test("BEFORE/AFTER: the same scenario run on the previous behavior would have recorded [25 m, 50 m]; the confirmed sequence is now empty", () => {
        const result = race({ dropouts: [[arrival1 - 700, arrival1 + 500]] });
        assert.notDeepEqual(result.turns.map((t) => t.distanceMeters), [25, 50]);
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), []);
    });

    test("a gap that begins AFTER a turn was already confirmed keeps that turn trusted and flags only what follows", () => {
        const secondArrival = path100.turns[1].arrivalMs;
        const result = race({ dropouts: [[secondArrival - 700, secondArrival + 500]] });
        assert.deepEqual(result.turns.map((t) => t.distanceMeters), [25], "the first turn, confirmed long before the gap, is untouched");
        assert.equal(result.turns[0].atMs, control.turns[0].atMs);
        assert.ok(result.turns[0].atMs <= result.controller.chronosSession.distanceConfidence.sinceAtMs);
        assert.equal(result.confirmedDistanceMeters, 25);
        assert.deepEqual(result.report.splits.map((s) => s.distanceMeters), [25]);
        assert.equal(result.start.atMs, control.start.atMs, "the accepted start is preserved");
    });
});

// ===========================================================================
// 5 / 6 / 7. NO LATER TURN RESTORES CONFIDENCE; SPLITS; FINISH
// ===========================================================================

describe("after ambiguity nothing silently restores confirmed progression", () => {
    const path200 = racePath({ lengths: 8 });
    const config200 = raceConfig({ distanceMeters: 200 });
    const firstWall = path200.turns[0].arrivalMs;
    const result = runRace({ config: config200, samples: sampleRace(path200, { dropouts: [[firstWall - 700, firstWall + 500]] }) });

    test("MULTIPLE DOWNSTREAM TURNS: every later wall contact in a 200 m race stays unconfirmed", () => {
        assert.equal(result.turns.length, 0);
        assert.equal(result.confirmedDistanceMeters, 0);
        assert.ok(result.controller.diagnostics.unconfirmedTurnObservations.length >= 5, "the later walls were seen");
        assert.equal(result.controller.chronosSession.distanceConfidence.state, "unconfirmed");
        assert.equal(result.controller.diagnostics.distanceConfidence.state, "unconfirmed");
        const proposals = result.lastEventChanges.filter((c) => c.kind === "turn");
        assert.ok(proposals.length >= 5 && proposals.every((c) => !c.ok && c.reason === "distance-progression-unconfirmed"));
    });

    test("tracking resuming, and a second clean-looking wall contact, do not reset it (recovery is not possible with the available evidence)", () => {
        const confidence = result.controller.chronosSession.distanceConfidence;
        assert.equal(confidence.state, "unconfirmed");
        assert.equal(confidence.sinceAtMs, lastSampleBefore(firstWall - 700));
        assert.equal(result.report.distanceConfidence.state, "unconfirmed");
        assert.ok(result.report.dataQuality.notes.some((n) => n.includes("distance progression unconfirmed")));
    });

    test("SPLIT INTEGRITY: only the splits trusted BEFORE the gap are emitted, identical to the control run's; none downstream", () => {
        const thirdWall = path200.turns[2].arrivalMs;
        const lateGap = runRace({ config: config200, samples: sampleRace(path200, { dropouts: [[thirdWall - 700, thirdWall + 500]] }) });
        const clean = runRace({ config: config200, samples: sampleRace(path200) });
        assert.deepEqual(lateGap.report.splits.map((s) => s.distanceMeters), [25, 50]);
        assert.deepEqual(lateGap.report.splits, clean.report.splits.slice(0, 2), "the trusted splits are byte-identical to the uninterrupted run's");
        assert.equal(lateGap.report.splits.length, 2);
        assert.ok(lateGap.controller.diagnostics.unconfirmedTurnObservations.length >= 4);
        assert.equal(lateGap.report.finalTimeMs, null);
    });

    test("FINISH INTEGRITY: the pipeline produces no finish, a detector finish is refused by Chronos, and no trusted final time/distance exists", () => {
        assert.equal(result.finish, null);
        assert.equal(result.report.finalTimeMs, null);
        const refused = ChronosEngine.recordEvent(result.controller.chronosSession, { type: "finish", atMs: 200000, distanceMeters: 200, source: "detector", detector: "finish-detector-v0", confidence: 0.99 });
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, "distance-progression-unconfirmed");
        assert.equal(refused.session, result.controller.chronosSession);
        assert.equal(result.controller.chronosSession.finalTimeMs, null);
    });
});

// ===========================================================================
// 8. DIAGNOSTICS
// ===========================================================================

describe("diagnostics: the degraded state and reason are observable and stay coherent across frames", () => {
    test("frame by frame: confirmed, then unconfirmed at exactly the first usable observation after the gap, then identical for the rest of the race", () => {
        const from = arrival1 - 700;
        const to = arrival1 + 500;
        const samples = sampleRace(path100, { dropouts: [[from, to]] });
        let controller = freshRaceController(config100);
        let firstUnconfirmedAt = null;
        let snapshot = null;
        for (const sample of samples) {
            controller = driveRace(controller, [sample]).controller;
            const state = controller.diagnostics.distanceConfidence;
            if (state.state === "unconfirmed" && firstUnconfirmedAt === null) {
                firstUnconfirmedAt = sample.atMs;
                snapshot = JSON.stringify(state);
            }
            if (firstUnconfirmedAt === null) {
                assert.equal(state.state, "confirmed");
            } else {
                assert.equal(JSON.stringify(controller.diagnostics.distanceConfidence), snapshot, `unchanged at ${sample.atMs}`);
                assert.equal(controller.chronosSession.distanceConfidence.state, "unconfirmed");
                assert.equal(controller.chronosSession.distanceConfidence.reason, DISTANCE_AMBIGUITY_REASON);
            }
        }
        // "Resumed" is the first observation SwimmerTracking actually delivered after the gap: it may withhold
        // frames that do not match the pre-gap motion (a reversal), so it is not necessarily the first frame
        // after the hole.
        assert.ok(firstUnconfirmedAt >= firstSampleAtOrAfter(to));
        const state = JSON.parse(snapshot);
        assert.deepEqual(state, { state: "unconfirmed", reason: DISTANCE_AMBIGUITY_REASON, sinceAtMs: lastSampleBefore(from), resumedAtMs: firstUnconfirmedAt });
    });

    test("a SECOND ambiguous gap later does not overwrite the first record", () => {
        const second = path100.turns[1].arrivalMs;
        const result = race({ dropouts: [[arrival1 - 700, arrival1 + 500], [second - 700, second + 500]] });
        assert.equal(result.controller.chronosSession.distanceConfidence.sinceAtMs, lastSampleBefore(arrival1 - 700));
    });

    test("the raw observation record keeps working: lastTurnAssessment keeps being updated while distance is unconfirmed", () => {
        const result = race({ dropouts: [[arrival1 - 700, arrival1 + 500]] });
        assert.notEqual(result.controller.diagnostics.lastTurnAssessment, null);
        assert.ok(result.controller.diagnostics.lastTurnAssessment.atMs > arrival1 + 1000);
    });
});

// ===========================================================================
// 9. RACE ISOLATION
// ===========================================================================

describe("race isolation: ambiguity never leaks into another race", () => {
    test("starting a new analysis from a controller whose previous race was unconfirmed begins fresh", () => {
        const ambiguous = race({ dropouts: [[arrival1 - 700, arrival1 + 500]] });
        assert.equal(ambiguous.controller.chronosSession.distanceConfidence.state, "unconfirmed");

        const restarted = racePipelineStartAnalysis(ambiguous.controller, config100);
        assert.equal(restarted.ok, true);
        assert.equal(restarted.controller.chronosSession.distanceConfidence, null);
        assert.deepEqual(restarted.controller.diagnostics.distanceConfidence, { state: "confirmed", reason: null, sinceAtMs: null, resumedAtMs: null });
        assert.deepEqual(restarted.controller.diagnostics.unconfirmedTurnObservations, []);
        assert.equal(restarted.controller.eventAdapterState.confirmedDistanceMeters, 0);

        const rerun = summarize(driveRace(restarted.controller, sampleRace(path100)).controller);
        assert.deepEqual(rerun.turns.map((t) => [t.distanceMeters, t.atMs]), trustedLabels(control));
        assert.equal(rerun.controller.chronosSession.distanceConfidence, null);
    });

    test("stopping the analysis discards the state; a new race after it is trusted again", () => {
        const ambiguous = race({ dropouts: [[arrival1 - 700, arrival1 + 500]] });
        const stopped = racePipelineStopAnalysis(ambiguous.controller).controller;
        assert.equal(stopped.chronosSession, null);
        assert.deepEqual(stopped.diagnostics.distanceConfidence, { state: "confirmed", reason: null, sinceAtMs: null, resumedAtMs: null });
        const next = racePipelineStartAnalysis(stopped, config100);
        assert.equal(driveRace(next.controller, sampleRace(path100)).controller.chronosSession.distanceConfidence, null);
    });

    test("two controllers advanced in alternation (one ambiguous, one clean) never influence each other", () => {
        const samplesBad = sampleRace(path100, { dropouts: [[arrival1 - 700, arrival1 + 500]] });
        const samplesGood = sampleRace(path100);
        let bad = freshRaceController(config100);
        let good = freshRaceController(config100);
        for (let i = 0; i < samplesGood.length; i += 1) {
            bad = driveRace(bad, [samplesBad[i]]).controller;
            good = driveRace(good, [samplesGood[i]]).controller;
        }
        assert.equal(bad.chronosSession.distanceConfidence.state, "unconfirmed");
        assert.equal(good.chronosSession.distanceConfidence, null);
        assert.deepEqual(summarize(good).turns.map((t) => t.distanceMeters), [25, 50, 75]);
    });
});

// ===========================================================================
// 10. MANUAL COMPATIBILITY (through the pipeline's session)
// ===========================================================================

describe("manual timing keeps working on an unconfirmed pipeline session", () => {
    test("manual splits, turns and a finish are accepted; the accepted start and earlier events remain", () => {
        const ambiguous = race({ dropouts: [[arrival1 - 700, arrival1 + 500]] });
        let session = ambiguous.controller.chronosSession;
        for (const input of [
            { type: "split", atMs: 30000, distanceMeters: 30, source: "manual" },
            { type: "turn", atMs: 40000, distanceMeters: 50, source: "manual" },
            { type: "finish", atMs: 90000, distanceMeters: 100, source: "manual" }
        ]) {
            const result = ChronosEngine.recordEvent(session, input);
            assert.equal(result.ok, true, input.type);
            session = result.session;
        }
        assert.equal(session.status, "finished");
        assert.equal(session.finalTimeMs, 90000 - ambiguous.start.atMs);
        assert.equal(session.events[0].atMs, ambiguous.start.atMs);
    });
});

// ===========================================================================
// 11. BOUNDARIES: DUPLICATES / OUT-OF-ORDER, INTERMITTENT LOSS, ZONE EDGE
// ===========================================================================

describe("boundary behavior is deterministic", () => {
    const hidden = { dropouts: [[arrival1 - 700, arrival1 + 500]] };

    test("duplicate and out-of-order samples neither create nor hide an ambiguity: the record equals the clean run's", () => {
        const clean = race(hidden);
        const noisy = [];
        for (const s of sampleRace(path100, hidden)) {
            noisy.push(s);
            if (s.atMs % 1200 === 0) noisy.push(s);
        }
        for (let i = 100; i < noisy.length - 1; i += 37) {
            const tmp = noisy[i];
            noisy[i] = noisy[i + 1];
            noisy[i + 1] = tmp;
        }
        const result = runRace({ config: config100, samples: noisy });
        assert.deepEqual(result.controller.chronosSession.distanceConfidence, clean.controller.chronosSession.distanceConfidence);
        assert.deepEqual(result.events, clean.events);
    });

    test("duplicates and swaps in an UNINTERRUPTED race never produce an ambiguity (a refused sample is not an observation)", () => {
        const noisy = [];
        for (const s of sampleRace(path100)) {
            noisy.push(s);
            if (s.atMs % 600 === 0) noisy.push(s);
        }
        for (let i = 100; i < noisy.length - 1; i += 29) {
            const tmp = noisy[i];
            noisy[i] = noisy[i + 1];
            noisy[i + 1] = tmp;
        }
        const result = runRace({ config: config100, samples: noisy });
        assert.equal(result.controller.chronosSession.distanceConfidence, null);
        assert.equal(result.turns.length, 3);
    });

    test("replaying the same frames through the same controller leaves the record and the events unchanged", () => {
        const samples = sampleRace(path100, hidden);
        const first = driveRace(freshRaceController(config100), samples);
        const second = driveRace(first.controller, samples);
        assert.deepEqual(second.controller.chronosSession.distanceConfidence, first.controller.chronosSession.distanceConfidence);
        assert.deepEqual(second.controller.chronosSession.events, first.controller.chronosSession.events);
    });

    test("ZONE EDGE at the pipeline level: a long gap whose first observation after it is just inside the zone is flagged; just outside is not", () => {
        // The swimmer crosses x=0.75 at ~17.9 s (0.06 + 0.058 * (t - 6000) / 1000).
        const crossing = 6000 + ((0.75 - 0.06) / 0.058) * 1000;
        const grid = (t) => Math.ceil(t / DT) * DT;
        const pick = (insideZone) => {
            // choose a hole ending so that the first observation after it is the grid sample at t_after
            for (let t = grid(crossing - 600); t < grid(crossing + 600); t += DT) {
                const x = path100.xAt(t).x;
                if ((x > 0.75) === insideZone && Math.abs(x - 0.75) < 0.012) return t;
            }
            throw new Error("test setup: no grid sample near the zone edge");
        };
        const tOutside = pick(false);
        const tInside = pick(true);
        const outside = race({ dropouts: [[tOutside - 1000, tOutside - 1]] });
        const inside = race({ dropouts: [[tInside - 1000, tInside - 1]] });
        assert.ok(path100.xAt(tOutside - 1000 - DT).x < 0.75 && path100.xAt(tOutside).x <= 0.75);
        assert.equal(outside.controller.chronosSession.distanceConfidence, null, "after-gap observation just outside the zone");
        assert.equal(inside.controller.chronosSession.distanceConfidence.state, "unconfirmed", "after-gap observation just inside the zone");
        assert.equal(inside.controller.chronosSession.distanceConfidence.evidence.afterWallSide, "near-one");
    });

    test("a pose that is present but low-visibility counts as unobserved, so a low-visibility stretch at the wall (long enough to be a gap, short enough that tracking keeps the target) is ambiguous", () => {
        const samples = sampleRace(path100).map((s) => {
            if (s.atMs >= arrival1 - 500 && s.atMs < arrival1 + 300) {
                return { ...s, landmarks: { hip: { ...s.landmarks.hip, visibility: 0.2 }, nose: { ...s.landmarks.nose, visibility: 0.2 } } };
            }
            return s;
        });
        const result = runRace({ config: config100, samples });
        // Low-visibility frames never reach the detectors as usable observations (tracking treats them as ambiguous).
        assert.equal(result.controller.chronosSession.distanceConfidence.state, "unconfirmed");
        assert.equal(result.turns.length, 0);
    });
});

// ===========================================================================
// 12. SEEDED MULTI-RACE FUZZ: NO TRUSTED DISTANCE IS EVER WRONG
// ===========================================================================

describe("seeded fuzz over random synthetic races with random pose dropouts (invariants against ground truth)", () => {
    test("200 races: every TRUSTED turn is the right wall with the right distance; nothing is trusted after the ambiguity; mid-pool-only dropouts never flag", () => {
        let flagged = 0;
        let trusted = 0;
        let harmlessChecked = 0;
        for (let seed = 1; seed <= 200; seed += 1) {
            const random = seededRandom(seed * 7919);
            const pool = random() < 0.5 ? 25 : 50;
            const lengths = 2 + Math.floor(random() * 5);
            const speed = 0.06 + random() * 0.06;
            const dt = seed % 2 === 0 ? 120 : 160;
            const path = racePath({ lengths, speed, poolLengthMeters: pool });
            const dropouts = [];
            for (let k = 0, n = Math.floor(random() * 4); k < n; k += 1) {
                const from = 8000 + random() * (path.endMs - 11000);
                dropouts.push([from, from + 100 + random() * 2400]);
            }
            const result = runRace({ config: raceConfig({ distanceMeters: lengths * pool, poolLengthMeters: pool }), samples: sampleRace(path, { dt, dropouts }) });
            const confidence = result.controller.chronosSession.distanceConfidence;
            if (confidence) flagged += 1;

            result.turns.forEach((turn, index) => {
                trusted += 1;
                const truth = path.turns[index];
                assert.ok(truth, `seed ${seed}: a trusted turn exists only for a real wall`);
                assert.equal(turn.distanceMeters, truth.distanceMeters, `seed ${seed}: trusted turn ${index + 1} has the right distance`);
                assert.ok(Math.abs(turn.atMs - truth.arrivalMs) <= 700, `seed ${seed}: trusted turn ${index + 1} is at the right wall (${turn.atMs} vs ${truth.arrivalMs})`);
                if (confidence) assert.ok(turn.atMs <= confidence.sinceAtMs, `seed ${seed}: nothing trusted after the ambiguity`);
            });
            assert.equal(result.confirmedDistanceMeters, result.turns.length === 0 ? 0 : result.turns[result.turns.length - 1].distanceMeters);
            assert.equal(result.finish, null);
            if (confidence) {
                assert.deepEqual(result.report.distanceConfidence.state, "unconfirmed");
                // After the ambiguity: from the resumed observation on (a gap mark), or after the last
                // trusted observation (a terminal-tracking mark, which has no resumed observation).
                const boundary = confidence.resumedAtMs ?? confidence.sinceAtMs + 1;
                assert.ok(result.lastEventChanges.filter((c) => c.kind === "turn" && c.processedAtMs >= boundary).every((c) => !c.ok));
            }

            // Harmless: if EVERY dropout (with a margin on each side) lies entirely mid-pool, nothing may be flagged.
            const everyDropoutMidPool = dropouts.length > 0 && dropouts.every(([from, to]) => {
                for (let t = from - 2 * dt; t <= to + 2 * dt; t += 40) {
                    const x = path.xAt(t).x;
                    if (x < 0.3 || x > 0.7) return false;
                }
                return true;
            });
            if (everyDropoutMidPool && result.controller.trackingSession.status !== "ANALYSIS_DEGRADED") {
                harmlessChecked += 1;
                assert.equal(confidence, null, `seed ${seed}: mid-pool-only dropouts do not flag`);
            }
        }
        assert.ok(flagged > 40, `fuzz flagged real ambiguities (${flagged})`);
        assert.ok(trusted > 150, `fuzz kept real trusted turns (${trusted})`);
        assert.ok(harmlessChecked >= 3, `fuzz exercised mid-pool-only dropouts (${harmlessChecked})`);
    });
});
