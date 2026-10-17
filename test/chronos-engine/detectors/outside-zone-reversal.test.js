// chronosAssessReversalOutsideWallZone() tests — Chronos reliability phase 2E.
//
// DETECTOR LAYER ONLY: pure inputs, no Chronos, tracking or pipeline. All data is
// synthetic with analytically known ground truth. The function reports a plain
// FACT — "the newest observations contain a COMPLETE, sustained reversal whose
// apex is outside the wall zone, which chronosAssessTurn() cannot accept" — and
// never that a turn occurred or where the wall is. It introduces no threshold:
// the reversal evidence, floor and run are chronosAssessTurn()'s own.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    chronosAssessTurn,
    chronosAssessReversalOutsideWallZone,
    TURN_ASSESSMENT_DEFAULTS
} from "../../../src/chronos-engine/detectors/turn-detector.js";

const LANE = 0.5;

function sample(atMs, x, { y = LANE, hipVisibility = 0.9, noseVisibility = 0.9 } = {}) {
    return { atMs, hip: { x, y, visibility: hipVisibility }, nose: { x: x + 0.04, y, visibility: noseVisibility } };
}

// piecewise-linear path at a fixed cadence: waypoints [{x, holdMs?}], constant speed (frame-widths/s)
function trajectory(waypoints, { speed = 0.1, dt = 100, tailMs = 0 } = {}) {
    const segments = [];
    const arrivals = [0];
    let t = waypoints[0].holdMs || 0;
    segments.push({ from: 0, to: t, x0: waypoints[0].x, x1: waypoints[0].x });
    for (let i = 1; i < waypoints.length; i += 1) {
        const travelMs = (Math.abs(waypoints[i].x - waypoints[i - 1].x) / speed) * 1000;
        segments.push({ from: t, to: t + travelMs, x0: waypoints[i - 1].x, x1: waypoints[i].x });
        t += travelMs;
        arrivals.push(t);
        segments.push({ from: t, to: t + (waypoints[i].holdMs || 0), x0: waypoints[i].x, x1: waypoints[i].x });
        t += waypoints[i].holdMs || 0;
    }
    const endMs = t + tailMs;
    const last = waypoints[waypoints.length - 1].x;
    const xAt = (time) => {
        for (const s of segments) {
            if (time >= s.from && time < s.to) return s.to === s.from ? s.x1 : s.x0 + ((s.x1 - s.x0) * (time - s.from)) / (s.to - s.from);
        }
        return last;
    };
    const samples = [];
    for (let time = 0; time <= endMs; time += dt) samples.push({ atMs: time, x: xAt(time) });
    return { samples, arrivals };
}

// Feeds samples as the detector adapter does (full prior history, floor = the last candidate's apex), and
// returns every outside-zone result plus the turn assessments, so the two can be compared.
function drive(points, { config = {} } = {}) {
    const history = [];
    const outside = [];
    const turns = [];
    let floor = null;
    for (const point of points) {
        const current = point.hip ? point : sample(point.atMs, point.x, point.options || {});
        const args = { sample: current, recentSamples: history, previousCandidateAtMs: floor, config: { referenceLaneY: LANE, ...config } };
        const out = chronosAssessReversalOutsideWallZone(args);
        const turn = chronosAssessTurn(args);
        outside.push({ atMs: current.atMs, result: out });
        turns.push({ atMs: current.atMs, result: turn });
        if (turn.candidate) floor = turn.candidate.atMs;
        history.push(current);
    }
    const hits = outside.filter((o) => o.result.outside);
    return { outside, turns, hits, apexes: [...new Set(hits.map((h) => h.result.evidence.apexAtMs))] };
}

// ===========================================================================
// THE FACT IT REPORTS
// ===========================================================================

describe("a complete reversal whose apex is outside the wall zone", () => {
    test("near-one side: reported, with the apex time (plateau start), the side approached and how far outside the zone", () => {
        const { samples, arrivals } = trajectory([{ x: 0.3 }, { x: 0.7, holdMs: 400 }, { x: 0.3 }], { speed: 0.1 });
        const { hits, apexes, turns } = drive(samples);

        assert.ok(hits.length > 0);
        assert.equal(apexes.length, 1, "one reversal, one apex time, however many frames re-report it");
        assert.ok(Math.abs(apexes[0] - arrivals[1]) <= 100, `apex ${apexes[0]} vs arrival ${arrivals[1]}`);
        const evidence = hits[0].result.evidence;
        assert.equal(hits[0].result.reason, "complete-reversal-outside-wall-zone");
        assert.equal(evidence.apexType, "max");
        assert.equal(evidence.approachedWallSide, "near-one");
        assert.equal(evidence.zoneEdgeX, 0.75);
        assert.ok(Math.abs(evidence.distanceOutsideZone - 0.05) < 0.011, `0.75 - 0.70 = 0.05 (got ${evidence.distanceOutsideZone})`);
        assert.ok(evidence.approachSwing >= 0.08 && evidence.recoverySwing >= 0.08);
        assert.ok(evidence.confirmedAtMs > evidence.apexAtMs);
        assert.ok(turns.every((t) => t.result.state !== "confirmed"), "the turn assessment does NOT accept it");
        assert.ok(turns.every((t) => t.result.reason !== "lane-deviation"));
    });

    test("near-zero side: the mirror image", () => {
        const { samples, arrivals } = trajectory([{ x: 0.7 }, { x: 0.3, holdMs: 400 }, { x: 0.7 }], { speed: 0.1 });
        const { hits, apexes } = drive(samples);
        assert.equal(apexes.length, 1);
        assert.ok(Math.abs(apexes[0] - arrivals[1]) <= 100);
        assert.equal(hits[0].result.evidence.apexType, "min");
        assert.equal(hits[0].result.evidence.approachedWallSide, "near-zero");
        assert.equal(hits[0].result.evidence.zoneEdgeX, 0.25);
        assert.ok(Math.abs(hits[0].result.evidence.distanceOutsideZone - 0.05) < 0.011);
    });

    test("BOUNDARY (strict, exactly as chronosAssessTurn's zone): inside is the turn assessment's; at and beyond the edge is reported here", () => {
        const cases = [
            // [apex x, wall side, expect outside]
            [0.76, "right", false], [0.7501, "right", false], [0.75, "right", true], [0.7499, "right", true], [0.74, "right", true],
            [0.24, "left", false], [0.2499, "left", false], [0.25, "left", true], [0.2501, "left", true], [0.26, "left", true]
        ];
        for (const [apex, side, expectOutside] of cases) {
            const from = side === "right" ? 0.4 : 0.6;
            const { samples } = trajectory([{ x: from }, { x: apex, holdMs: 400 }, { x: from }], { speed: 0.1, dt: 20 });
            const { hits, turns } = drive(samples);
            assert.equal(hits.length > 0, expectOutside, `apex ${apex} (${side})`);
            const confirmed = turns.some((t) => t.result.state === "confirmed");
            assert.equal(confirmed, !expectOutside, `apex ${apex}: the turn assessment accepts exactly the inside cases`);
        }
    });

    test("it is not claimed to be a wall: a mid-pool stop-and-return is reported identically (the observations cannot tell them apart)", () => {
        const wall = drive(trajectory([{ x: 0.3 }, { x: 0.72, holdMs: 400 }, { x: 0.3 }], { speed: 0.1 }).samples);
        const mid = drive(trajectory([{ x: 0.2 }, { x: 0.5, holdMs: 400 }, { x: 0.2 }], { speed: 0.1 }).samples);
        assert.equal(wall.hits[0].result.reason, mid.hits[0].result.reason);
        assert.ok(mid.hits[0].result.evidence.distanceOutsideZone > wall.hits[0].result.evidence.distanceOutsideZone, "the only difference is how far outside the zone");
    });
});

// ===========================================================================
// WHAT IT NEVER REPORTS
// ===========================================================================

describe("ordinary motion and incomplete reversals are never reported", () => {
    const expectNone = (points, label, config) => {
        const { hits } = drive(points, { config });
        assert.equal(hits.length, 0, label);
    };

    test("monotone swimming, however slow or fast, and a swimmer who stops", () => {
        for (const speed of [0.02, 0.058, 0.15]) {
            expectNone(trajectory([{ x: 0.1 }, { x: 0.9, holdMs: 3000 }], { speed, dt: 120 }).samples, `speed ${speed}`);
        }
        expectNone(trajectory([{ x: 0.3, holdMs: 5000 }, { x: 0.6, holdMs: 5000 }], { speed: 0.05 }).samples, "stops mid-pool");
    });

    test("stroke-cycle oscillation and hip jitter on a monotone swim", () => {
        const points = [];
        let state = 99;
        for (let t = 0; t <= 14000; t += 120) {
            state = (state * 1664525 + 1013904223) >>> 0;
            const jitter = ((state / 4294967296) * 2 - 1) * 0.004;
            points.push({ atMs: t, x: 0.1 + 0.058 * (t / 1000) + 0.015 * Math.sin(t / 380) + jitter });
        }
        expectNone(points, "oscillation + jitter");
    });

    test("a single-sample outlier, and an approach without a completed recovery", () => {
        const base = trajectory([{ x: 0.2 }, { x: 0.7, holdMs: 200 }, { x: 0.3 }], { speed: 0.1 }).samples;
        const noRecovery = trajectory([{ x: 0.2 }, { x: 0.7, holdMs: 3000 }], { speed: 0.1 }).samples;
        expectNone(noRecovery, "approach, no recovery");
        const partial = trajectory([{ x: 0.2 }, { x: 0.7, holdMs: 200 }, { x: 0.65, holdMs: 3000 }], { speed: 0.1 }).samples;
        expectNone(partial, "recovery 0.05 < 0.08");

        const monotone = trajectory([{ x: 0.1 }, { x: 0.9 }], { speed: 0.1 }).samples;
        const spiked = monotone.map((s, i) => (i === 30 ? { atMs: s.atMs, x: s.x + 0.07 } : s));
        expectNone(spiked, "single outlier");
        assert.ok(base.length > 0);
    });

    test("a recovery that is not yet HELD (fewer than 3 samples) is not reported; the third held sample reports it; and an approach shorter than the reversal displacement is never reported", () => {
        // 0.3 -> 0.7 in 0.1 steps, then a retreat in 0.1 steps (each retreat sample is >= 0.1 below the apex)
        const xs = [0.3, 0.4, 0.5, 0.6, 0.7, 0.7, 0.6, 0.5, 0.4, 0.3];
        const points = xs.map((x, i) => ({ atMs: i * 100, x }));
        const apexIndex = 4;
        for (const [retreatSamples, expectHit] of [[1, false], [2, false], [3, true], [4, true]]) {
            const upTo = points.slice(0, apexIndex + 2 + retreatSamples); // up to the plateau's 2nd sample, then N retreat samples
            const hit = drive(upTo).hits.length > 0;
            assert.equal(hit, expectHit, `${retreatSamples} retreat sample(s)`);
        }
        expectNone(trajectory([{ x: 0.64 }, { x: 0.7, holdMs: 200 }, { x: 0.4 }], { speed: 0.1 }).samples, "approach 0.06 < 0.08");
    });

    test("a reversal whose apex IS inside the wall zone belongs to chronosAssessTurn(), not to this", () => {
        const { hits, turns } = drive(trajectory([{ x: 0.4 }, { x: 0.9, holdMs: 400 }, { x: 0.4 }], { speed: 0.1 }).samples);
        assert.equal(hits.length, 0);
        assert.ok(turns.some((t) => t.result.state === "confirmed"));
    });

    test("nothing is reported across an observation gap or from before the floor", () => {
        const { samples, arrivals } = trajectory([{ x: 0.3 }, { x: 0.7, holdMs: 600 }, { x: 0.3 }], { speed: 0.1 });
        const gapped = samples.filter((s) => !(s.atMs >= arrivals[1] - 500 && s.atMs < arrivals[1] + 900));
        expectNone(gapped, "gap at the apex ends the run");

        const apexAt = drive(samples).apexes[0];
        // the floor (the previous candidate's apex / the accepted start) after the apex excludes it
        expectNone(samples, "earliestApexMs after the apex", { earliestApexMs: apexAt + 1 });
        // and replaying with the previous candidate recorded at the apex re-examines nothing at or before it
        const history = samples.slice(0, -1).map((s) => sample(s.atMs, s.x));
        const last = samples[samples.length - 1];
        const result = chronosAssessReversalOutsideWallZone({ sample: sample(last.atMs, last.x), recentSamples: history, previousCandidateAtMs: apexAt, config: {} });
        assert.equal(result.outside, false);
    });
});

// ===========================================================================
// CONTRACT
// ===========================================================================

describe("input contract and purity", () => {
    test("malformed input never throws and is never 'outside'", () => {
        for (const bad of [undefined, null, {}, { atMs: NaN }, { atMs: 1000 }, { atMs: 1000, hip: null, nose: null }]) {
            const result = chronosAssessReversalOutsideWallZone({ sample: bad, recentSamples: [], config: {} });
            assert.equal(result.outside, false);
        }
        assert.doesNotThrow(() => chronosAssessReversalOutsideWallZone());
        assert.equal(chronosAssessReversalOutsideWallZone({ sample: sample(1000, 0.5, { hipVisibility: 0.1 }), recentSamples: [] }).reason, "low-visibility-sample");
        for (const bad of [NaN, -1, "3"]) {
            assert.equal(chronosAssessReversalOutsideWallZone({ sample: sample(1000, 0.5), recentSamples: [], config: { earliestApexMs: bad } }).reason, "invalid-earliest-apex");
        }
        assert.equal(chronosAssessReversalOutsideWallZone({ sample: sample(1000, 0.5), recentSamples: [] }).reason, "insufficient-history");
    });

    test("referenceLaneY is not required, and the lane is irrelevant here", () => {
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.7, holdMs: 400 }, { x: 0.3 }], { speed: 0.1 });
        const inLane = drive(samples.map((s) => ({ atMs: s.atMs, x: s.x, options: { y: 0.5 } })));
        const offLane = drive(samples.map((s) => ({ atMs: s.atMs, x: s.x, options: { y: 0.9 } })));
        assert.deepEqual(inLane.apexes, offLane.apexes);
        assert.ok(inLane.apexes.length === 1);
    });

    test("identical inputs give identical results; inputs are not mutated; history order and duplicates are irrelevant", () => {
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.7, holdMs: 400 }, { x: 0.3 }], { speed: 0.1 });
        const points = samples.map((s) => sample(s.atMs, s.x));
        const history = points.slice(0, -1);
        const current = points[points.length - 1];
        const snapshot = JSON.stringify(history);
        const first = chronosAssessReversalOutsideWallZone({ sample: current, recentSamples: history, config: {} });
        assert.deepEqual(chronosAssessReversalOutsideWallZone({ sample: current, recentSamples: history, config: {} }), first);
        assert.equal(JSON.stringify(history), snapshot);
        const shuffled = [...history].reverse().concat(history.slice(5, 15));
        assert.deepEqual(chronosAssessReversalOutsideWallZone({ sample: current, recentSamples: shuffled, config: {} }), first);
    });

    test("it uses the turn assessment's own thresholds (no new ones): changing them changes both together", () => {
        assert.equal(TURN_ASSESSMENT_DEFAULTS.wallThreshold, 0.25);
        // a swimmer reversing at 0.68: outside the default zone, inside a 0.35-wide zone
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.68, holdMs: 400 }, { x: 0.3 }], { speed: 0.1 });
        assert.ok(drive(samples).hits.length > 0);
        const widened = drive(samples, { config: { wallThreshold: 0.35 } });
        assert.equal(widened.hits.length, 0);
        assert.ok(widened.turns.some((t) => t.result.state === "confirmed"));
    });
});

// ===========================================================================
// PARTITION AND ORACLE (seeded fuzz over synthetic paths)
// ===========================================================================

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

describe("seeded fuzz: the two assessments partition complete reversals, checked against an independent oracle", () => {
    test("150 random multi-leg paths: a reversal is confirmed/lane-refused OR reported outside the zone — never both, never neither", () => {
        let inZone = 0;
        let outsideZone = 0;
        for (let seed = 1; seed <= 150; seed += 1) {
            const random = seeded(seed * 7919);
            const waypoints = [{ x: 0.1 + random() * 0.8, holdMs: 500 }];
            let direction = random() < 0.5 ? 1 : -1;
            for (let leg = 0, legs = 3 + Math.floor(random() * 4); leg < legs; leg += 1) {
                const previous = waypoints[waypoints.length - 1].x;
                const room = direction > 0 ? 0.97 - previous : previous - 0.03;
                if (room < 0.12) { direction = -direction; continue; }
                const nextX = previous + direction * (0.12 + random() * (room - 0.12));
                if (Math.abs(nextX - 0.25) < 0.03 || Math.abs(nextX - 0.75) < 0.03) continue; // keep off the strict edge
                waypoints.push({ x: nextX, holdMs: random() < 0.5 ? 0 : 200 + Math.floor(random() * 600) });
                direction = -direction;
            }
            waypoints[waypoints.length - 1].holdMs = 1500;
            if (waypoints.length < 3) continue;

            const { samples, arrivals } = trajectory(waypoints, { speed: 0.04 + random() * 0.1, dt: [100, 150, 200][Math.floor(random() * 3)] });
            const { outside, turns, apexes } = drive(samples);

            // 1. partition: the same input is never both
            outside.forEach((o, i) => {
                if (o.result.outside) {
                    assert.notEqual(turns[i].result.state, "confirmed", `seed ${seed} @${o.atMs}`);
                    assert.notEqual(turns[i].result.reason, "lane-deviation", `seed ${seed} @${o.atMs}`);
                }
            });

            // 2. oracle: interior waypoints that reverse direction; wall-bound in the zone (turn assessment's) or not (this one's)
            const expectedInZone = [];
            const expectedOutside = [];
            for (let i = 1; i < waypoints.length - 1; i += 1) {
                const before = waypoints[i].x - waypoints[i - 1].x;
                const after = waypoints[i + 1].x - waypoints[i].x;
                if (before * after >= 0) continue;
                const x = waypoints[i].x;
                const inItsZone = (before > 0 && x > 0.75) || (before < 0 && x < 0.25);
                (inItsZone ? expectedInZone : expectedOutside).push(i);
            }
            inZone += expectedInZone.length;
            outsideZone += expectedOutside.length;

            const confirmedApexes = turns.filter((t) => t.result.candidate).map((t) => t.result.candidate.atMs);
            const distinct = [...new Set(confirmedApexes)];
            assert.equal(distinct.length, expectedInZone.length, `seed ${seed}: in-zone reversals confirmed`);
            assert.equal(apexes.length, expectedOutside.length, `seed ${seed}: outside-zone reversals reported (${JSON.stringify(waypoints.map((w) => +w.x.toFixed(2)))})`);
            expectedOutside.forEach((index, k) => {
                const speed = 0.04; // loose bound: within 0.5 s of the waypoint arrival, whatever the speed or hold
                assert.ok(Math.abs(apexes[k] - arrivals[index]) <= 2500 + (waypoints[index].holdMs || 0), `seed ${seed}: apex ${apexes[k]} vs arrival ${arrivals[index]} ${speed}`);
            });
        }
        assert.ok(inZone > 50, `fuzz exercised in-zone reversals (${inZone})`);
        assert.ok(outsideZone > 50, `fuzz exercised outside-zone reversals (${outsideZone})`);
    });
});
