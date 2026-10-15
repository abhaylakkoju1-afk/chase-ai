// Turn assessment (chronosAssessTurn) tests — Chronos reliability phase 2.
//
// DETECTOR LAYER ONLY: nothing here touches Chronos, tracking, or the race
// pipeline, so a failure localises to turn-detector.js.
//
// EVERY trajectory is hand-built and SYNTHETIC with explicit, analytically
// known ground truth (the time the swimmer reaches the wall). Passing proves
// the detector's logic on these inputs; it does NOT establish accuracy on real
// footage — no real race footage or independently annotated turn times exist
// in this repository.
//
// Geometry: normalized frame x in [0, 1]; walls at the frame edges; the
// detector's wall zones are x < 0.25 and x > 0.75; reversal displacement 0.08.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosAssessTurn, chronosDetectTurn, TURN_ASSESSMENT_DEFAULTS } from "../../../src/chronos-engine/detectors/turn-detector.js";

const LANE = 0.5;

function sample(atMs, x, { y = LANE, hipVisibility = 0.9, noseVisibility = 0.9 } = {}) {
    return {
        atMs,
        hip: { x, y, visibility: hipVisibility },
        nose: { x: x + 0.04, y, visibility: noseVisibility }
    };
}

// Builds samples for a piecewise-linear path at a fixed cadence.
//   waypoints: [{x, holdMs?}]  — start at waypoints[0].x at t = 0 and (after holding),
//   move to each next waypoint at constant `speed` (frame-widths/s), holding there.
// Returns {samples, arrivals} where arrivals[i] is the time the path REACHES waypoint i
// (ground truth for a turn at waypoint i).
function trajectory(waypoints, { speed = 0.1, dt = 100, tailMs = 0 } = {}) {
    const segments = [];
    const arrivals = [];
    let t = 0;
    arrivals.push(0);
    t += waypoints[0].holdMs || 0;
    segments.push({ from: 0, to: t, x0: waypoints[0].x, x1: waypoints[0].x });
    for (let i = 1; i < waypoints.length; i += 1) {
        const travelMs = (Math.abs(waypoints[i].x - waypoints[i - 1].x) / speed) * 1000;
        segments.push({ from: t, to: t + travelMs, x0: waypoints[i - 1].x, x1: waypoints[i].x });
        t += travelMs;
        arrivals.push(t);
        const hold = waypoints[i].holdMs || 0;
        segments.push({ from: t, to: t + hold, x0: waypoints[i].x, x1: waypoints[i].x });
        t += hold;
    }
    const endMs = t + tailMs;
    const last = waypoints[waypoints.length - 1].x;
    const xAt = (time) => {
        for (const s of segments) {
            if (time >= s.from && time < s.to) {
                return s.to === s.from ? s.x1 : s.x0 + ((s.x1 - s.x0) * (time - s.from)) / (s.to - s.from);
            }
        }
        return last;
    };
    const samples = [];
    for (let time = 0; time <= endMs; time += dt) {
        samples.push({ atMs: time, x: xAt(time) });
    }
    return { samples, arrivals, endMs };
}

// Feeds samples exactly as the detector adapter does: full prior history, plus the
// apex time of the last candidate as the floor. Returns every result and the candidates.
function drive(points, { config = {}, previousCandidateAtMs = null } = {}) {
    const history = [];
    const results = [];
    const candidates = [];
    let previous = previousCandidateAtMs;
    for (const point of points) {
        const current = point.hip ? point : sample(point.atMs, point.x, point.options || {});
        const result = chronosAssessTurn({
            sample: current,
            recentSamples: history,
            previousCandidateAtMs: previous,
            config: { referenceLaneY: LANE, ...config }
        });
        results.push({ atMs: current.atMs, result });
        if (result.candidate) {
            candidates.push({ ...result.candidate, evaluatedAtMs: current.atMs });
            previous = result.candidate.atMs;
        }
        history.push(current);
    }
    return { results, candidates, last: results[results.length - 1].result };
}

// ===========================================================================
// 1. CONTRACT / VALIDATION
// ===========================================================================

describe("chronosAssessTurn() — input contract", () => {
    const validSample = sample(1000, 0.5);

    test("referenceLaneY is required: missing or non-finite is rejected, never defaulted", () => {
        for (const bad of [undefined, null, NaN, Infinity, "0.5"]) {
            const result = chronosAssessTurn({ sample: validSample, recentSamples: [], config: { referenceLaneY: bad } });
            assert.equal(result.state, "rejected");
            assert.equal(result.reason, "missing-reference-lane-y");
            assert.equal(result.candidate, null);
        }
        assert.equal(chronosAssessTurn({ sample: validSample, recentSamples: [] }).reason, "missing-reference-lane-y");
    });

    test("earliestApexMs, when present, must be a finite non-negative number; null/undefined mean 'unconstrained'", () => {
        for (const bad of [NaN, Infinity, -1, "3000", {}]) {
            const result = chronosAssessTurn({ sample: validSample, recentSamples: [], config: { referenceLaneY: LANE, earliestApexMs: bad } });
            assert.equal(result.state, "rejected", `earliestApexMs=${String(bad)}`);
            assert.equal(result.reason, "invalid-earliest-apex");
        }
        for (const ok of [undefined, null, 0, 5000]) {
            const result = chronosAssessTurn({ sample: validSample, recentSamples: [], config: { referenceLaneY: LANE, earliestApexMs: ok } });
            assert.notEqual(result.reason, "invalid-earliest-apex");
        }
    });

    test("a malformed current sample is rejected, never thrown on", () => {
        const config = { referenceLaneY: LANE };
        for (const bad of [undefined, null, {}, { atMs: NaN }, { atMs: 1000 }, { atMs: 1000, hip: null, nose: sample(0, 0).nose }, { atMs: 1000, hip: sample(0, 0.5).hip, nose: { x: NaN, y: 0.5, visibility: 0.9 } }]) {
            const result = chronosAssessTurn({ sample: bad, recentSamples: [], config });
            assert.equal(result.state, "rejected");
            assert.equal(result.reason, "invalid-sample");
            assert.equal(result.candidate, null);
        }
        assert.doesNotThrow(() => chronosAssessTurn());
    });

    test("a low-visibility current sample is rejected, not used", () => {
        for (const options of [{ hipVisibility: 0.4 }, { noseVisibility: 0.1 }]) {
            const result = chronosAssessTurn({ sample: sample(1000, 0.1, options), recentSamples: [], config: { referenceLaneY: LANE } });
            assert.equal(result.state, "rejected");
            assert.equal(result.reason, "low-visibility-sample");
        }
    });

    test("malformed history entries are ignored, never repaired or thrown on", () => {
        const history = [null, undefined, {}, { atMs: NaN }, { atMs: 10, hip: null }, sample(20, 0.5), "x", sample(NaN, 0.5)];
        assert.doesNotThrow(() => chronosAssessTurn({ sample: sample(1000, 0.5), recentSamples: history, config: { referenceLaneY: LANE } }));
        assert.doesNotThrow(() => chronosAssessTurn({ sample: sample(1000, 0.5), recentSamples: "nope", config: { referenceLaneY: LANE } }));
    });
});

// ===========================================================================
// 2. A VALID TURN
// ===========================================================================

describe("chronosAssessTurn() — a valid wall turn (synthetic ground truth)", () => {
    test("near-one wall: exactly one candidate, timed at the apex, confirmed LATER than the apex", () => {
        const { samples, arrivals } = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 400 }, { x: 0.5 }], { speed: 0.1 });
        const { candidates } = drive(samples);

        assert.equal(candidates.length, 1);
        const candidate = candidates[0];
        assert.ok(Math.abs(candidate.atMs - arrivals[1]) <= 100, `apex ${candidate.atMs} within one sample of arrival ${arrivals[1]}`);
        assert.equal(candidate.evidence.apexAtMs, candidate.atMs);
        assert.equal(candidate.evidence.confirmedAtMs, candidate.evaluatedAtMs);
        assert.ok(candidate.evidence.confirmedAtMs > candidate.atMs, "confirmation is later than the apex");
        assert.equal(candidate.evidence.wallSide, "near-one");
        assert.ok(candidate.evidence.approachSwing >= 0.08);
        assert.ok(candidate.evidence.recoverySwing >= 0.08);
        assert.ok(candidate.confidence >= 0 && candidate.confidence <= 1);
    });

    test("near-zero wall: exactly one candidate, mirror image", () => {
        const { samples, arrivals } = trajectory([{ x: 0.7 }, { x: 0.08, holdMs: 400 }, { x: 0.5 }], { speed: 0.1 });
        const { candidates } = drive(samples);

        assert.equal(candidates.length, 1);
        assert.ok(Math.abs(candidates[0].atMs - arrivals[1]) <= 100);
        assert.equal(candidates[0].evidence.wallSide, "near-zero");
    });

    test("a turn is found across swim speeds, sampling cadences, hip jitter and both walls (not tuned to one trajectory)", () => {
        let checked = 0;
        for (const speed of [0.03, 0.058, 0.1, 0.15]) {
            for (const dt of [120, 200, 300]) {
                for (const [from, wall, side] of [[0.4, 0.92, "near-one"], [0.6, 0.05, "near-zero"]]) {
                    for (const jitter of [0, 0.004]) {
                        const { samples, arrivals } = trajectory([{ x: from }, { x: wall, holdMs: 300 }, { x: from }], { speed, dt });
                        let state = 12345;
                        const noisy = samples.map((s) => {
                            state = (state * 1664525 + 1013904223) >>> 0;
                            const noise = jitter > 0 ? ((state / 4294967296) * 2 - 1) * jitter : 0;
                            return { atMs: s.atMs, x: s.x + noise };
                        });
                        const { candidates } = drive(noisy);
                        const label = `speed=${speed} dt=${dt} wall=${side} jitter=${jitter}`;
                        assert.equal(candidates.length, 1, label);
                        assert.equal(candidates[0].evidence.wallSide, side, label);
                        // Documented apex-time error bound: the apex can PRECEDE the true arrival by up to
                        // apexPlateauTolerance / speed (the approach samples still within the tolerance of the
                        // turning point) plus one sampling interval, and FOLLOW it by up to the dwell plus one
                        // interval (when jitter hides the plateau).
                        const early = TURN_ASSESSMENT_DEFAULTS.apexPlateauTolerance / speed * 1000 + dt;
                        assert.ok(candidates[0].atMs >= arrivals[1] - early, `${label}: apex ${candidates[0].atMs} not earlier than arrival ${arrivals[1]} - ${early}`);
                        assert.ok(candidates[0].atMs <= arrivals[1] + 300 + dt, `${label}: apex not later than arrival + dwell + one sample`);
                        checked += 1;
                    }
                }
            }
        }
        assert.equal(checked, 4 * 3 * 2 * 2);
    });

    test("the apex is the FIRST sample of the plateau at the turning point (arrival), not the middle or last", () => {
        // 0.30 -> 0.90 at 0.1/s, hold 0.8 s at 0.90, back to 0.50. Cadence 100 ms: arrival at exactly 6000 ms.
        const { samples, arrivals } = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 800 }, { x: 0.5 }], { speed: 0.1, dt: 100 });
        assert.ok(Math.abs(arrivals[1] - 6000) < 1e-6);
        const { candidates } = drive(samples);
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].atMs, 6000);
    });
});

// ===========================================================================
// 3. WHAT IS NOT A TURN
// ===========================================================================

describe("chronosAssessTurn() — wall proximity, low velocity, pauses and noise are not turns", () => {
    test("REGRESSION: the old single-sample primitive fires on slow swimming inside the wall zone; the assessment does not", () => {
        // A swimmer drifting at 0.058 frame-widths/s from 0.60 to 0.92 — inside the wall zone and below the
        // primitive's 0.12 velocity gate — that never reverses.
        const { samples } = trajectory([{ x: 0.6 }, { x: 0.92, holdMs: 3000 }], { speed: 0.058, dt: 120 });

        let primitiveCandidates = 0;
        const history = [];
        for (const s of samples) {
            const current = sample(s.atMs, s.x);
            if (chronosDetectTurn({ sample: current, recentSamples: history, config: { referenceLaneY: LANE } })) primitiveCandidates += 1;
            history.push(current);
        }
        assert.ok(primitiveCandidates > 10, `the primitive proposes a "turn" on many frames (${primitiveCandidates})`);

        const { candidates, results } = drive(samples);
        assert.equal(candidates.length, 0);
        assert.ok(results.every((r) => r.result.state !== "confirmed"));
    });

    test("ordinary swimming through a wall zone (no reversal) never produces a candidate, wherever it stops", () => {
        for (const stop of [0.5, 0.76, 0.85, 0.95]) {
            const { samples } = trajectory([{ x: 0.1 }, { x: stop, holdMs: 4000 }], { speed: 0.058, dt: 120 });
            assert.equal(drive(samples).candidates.length, 0, `stop=${stop}`);
        }
    });

    test("a wall approach without a turn is reported 'plausible' (awaiting recovery), never confirmed", () => {
        const { samples } = trajectory([{ x: 0.4 }, { x: 0.9, holdMs: 2000 }], { speed: 0.1, dt: 100 });
        const { last, candidates } = drive(samples);
        assert.equal(candidates.length, 0);
        assert.equal(last.state, "plausible");
        assert.equal(last.reason, "awaiting-recovery");
        assert.equal(last.candidate, null);
        assert.equal(last.evidence.wallSide, "near-one");
    });

    test("a swimmer who rests in the wall zone and then moves away is NOT a turn (the start: no approach)", () => {
        // Rest at 0.06, then swim away to 0.6.
        const { samples } = trajectory([{ x: 0.06, holdMs: 3000 }, { x: 0.6 }], { speed: 0.058, dt: 120 });
        assert.equal(drive(samples).candidates.length, 0);
        // Same from the far wall.
        const mirrored = trajectory([{ x: 0.94, holdMs: 3000 }, { x: 0.4 }], { speed: 0.058, dt: 120 });
        assert.equal(drive(mirrored.samples).candidates.length, 0);
    });

    test("an approach shorter than the reversal displacement is not a turn", () => {
        // Starts 0.05 away from the wall, touches, recovers 0.3: approach 0.05 < 0.08.
        const { samples } = trajectory([{ x: 0.11 }, { x: 0.06, holdMs: 300 }, { x: 0.4 }], { speed: 0.1, dt: 100 });
        assert.equal(drive(samples).candidates.length, 0);
    });

    test("a recovery shorter than the reversal displacement, or not sustained, is not a turn", () => {
        // Approach to 0.9 then back only 0.06.
        const short = trajectory([{ x: 0.4 }, { x: 0.9, holdMs: 200 }, { x: 0.84, holdMs: 3000 }], { speed: 0.1, dt: 100 });
        const shortRun = drive(short.samples);
        assert.equal(shortRun.candidates.length, 0);

        // Recovers 0.2 for only two samples, then returns to the wall and stays: never three samples held.
        const points = [];
        let t = 0;
        for (const x of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.9, 0.9, 0.7, 0.7, 0.9, 0.9, 0.9, 0.9]) {
            points.push({ atMs: t, x });
            t += 100;
        }
        assert.equal(drive(points).candidates.length, 0);
    });

    test("a reversal in mid-pool is not a turn", () => {
        const { samples } = trajectory([{ x: 0.6 }, { x: 0.4 }, { x: 0.6 }, { x: 0.4 }, { x: 0.6 }], { speed: 0.1, dt: 100 });
        assert.equal(drive(samples).candidates.length, 0);
    });

    test("a reversal at a wall that the swimmer was moving AWAY from is not a turn (wrong direction for that wall)", () => {
        // Swimming left, reversing at 0.8 (near-one zone) and going back right: a 'max' pivot is only a
        // turn when the swimmer travelled INTO the near-one wall; this one travelled into 0.8 from the left
        // and returned to the left — that IS an approach to the near-one wall. Mirror it: a MIN pivot inside the
        // near-one zone must not count.
        const { samples } = trajectory([{ x: 0.95 }, { x: 0.8 }, { x: 0.95 }], { speed: 0.1, dt: 100 });
        assert.equal(drive(samples).candidates.length, 0);
    });

    test("a sample deep in the wall zone for a single frame, in the middle of the pool, is not a turn (one noisy observation)", () => {
        const { samples } = trajectory([{ x: 0.5, holdMs: 6000 }], { dt: 100 });
        const points = samples.map((s) => ({ atMs: s.atMs, x: s.atMs === 3000 ? 0.05 : s.x }));
        const { candidates, results } = drive(points);
        assert.equal(candidates.length, 0);
        assert.ok(results.every((r) => r.result.state !== "confirmed"));
    });

    test("a single-sample outlier at the end of an approach does not create, move or duplicate the apex", () => {
        const clean = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 400 }, { x: 0.5 }], { speed: 0.1, dt: 100 });
        const cleanCandidates = drive(clean.samples).candidates;
        assert.equal(cleanCandidates.length, 1);

        // Inject +0.08 spikes at several single samples around (not on) the apex and along the path.
        for (const injectAt of [2500, 4000, 5000, 7500, 8500]) {
            const spiked = clean.samples.map((s) => ({ atMs: s.atMs, x: s.atMs === injectAt ? s.x + 0.08 : s.x }));
            const { candidates } = drive(spiked);
            assert.equal(candidates.length, 1, `spike at ${injectAt}`);
            assert.equal(candidates[0].atMs, cleanCandidates[0].atMs, `apex unchanged by a spike at ${injectAt}`);
        }
    });

    test("a single-sample outlier far from the wall approach cannot supply the approach for a swimmer who started at the wall", () => {
        // Rest at 0.12 (zone), one sample spikes to 0.4, then the swimmer swims away. No real approach.
        const points = [];
        for (let i = 0; i < 40; i += 1) {
            const t = i * 100;
            let x = i < 20 ? 0.12 : 0.12 + 0.01 * (i - 20) * 1.5;
            if (i === 10) x = 0.4;
            points.push({ atMs: t, x });
        }
        assert.equal(drive(points).candidates.length, 0);
    });

    test("LIMITATION: two CONSECUTIVE outlier samples are not recognised as outliers (tracking, not this detector, is the guard)", () => {
        // 0.5 -> a 2-sample excursion to 0.1 -> back to 0.5. At the detector level this is an apex with approach
        // and recovery, so it is reported. In the pipeline, SwimmerTracking's continuity check rejects a jump this
        // large before it reaches the detector (see test/race-pipeline/turn-reliability.test.js).
        const points = [];
        for (let i = 0; i < 30; i += 1) points.push({ atMs: i * 100, x: i === 10 || i === 11 ? 0.1 : 0.5 });
        assert.equal(drive(points).candidates.length, 1);
    });

    test("lane agreement: an apex outside the lane is rejected with lane-deviation, not reported", () => {
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 400 }, { x: 0.5 }], { speed: 0.1, dt: 100 });
        const points = samples.map((s) => ({ atMs: s.atMs, x: s.x, options: { y: 0.85 } }));
        const { candidates, results } = drive(points);
        assert.equal(candidates.length, 0);
        const rejected = results.filter((r) => r.result.reason === "lane-deviation");
        assert.ok(rejected.length > 0);
        assert.equal(rejected[0].result.state, "rejected");
        assert.ok(rejected[0].result.evidence.laneDeviation > TURN_ASSESSMENT_DEFAULTS.laneDeviationThreshold);
    });
});

// ===========================================================================
// 4. OBSERVATION CONTINUITY (pose loss / tracking loss around a turn)
// ===========================================================================

describe("chronosAssessTurn() — observation continuity", () => {
    const base = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 600 }, { x: 0.5 }], { speed: 0.1, dt: 100 });
    const arrival = base.arrivals[1]; // 6000

    function without(from, to) {
        return base.samples.filter((s) => !(s.atMs >= from && s.atMs < to));
    }

    test("a short dropout (within the maximum sample gap) around the apex still yields one candidate", () => {
        const { candidates } = drive(without(arrival - 200, arrival + 300)); // ~500 ms hole, gaps <= 600
        assert.equal(candidates.length, 1);
    });

    test("a gap longer than the maximum sample gap AT THE APEX produces no candidate (the apex time would be a guess)", () => {
        const { candidates } = drive(without(arrival - 500, arrival + 900));
        assert.equal(candidates.length, 0);
    });

    test("a gap between the approach and the apex breaks the run: no approach evidence can be joined across it", () => {
        const { candidates } = drive(without(arrival - 1800, arrival - 200));
        assert.equal(candidates.length, 0);
    });

    test("a gap in the recovery restarts the run: the recovery alone has no approach", () => {
        const { candidates } = drive(without(arrival + 700, arrival + 2200));
        assert.equal(candidates.length, 0);
    });

    test("low-visibility samples are excluded as missing — never zero-filled and never used", () => {
        const points = base.samples.map((s) => {
            const lost = s.atMs >= arrival - 500 && s.atMs < arrival + 900;
            return { atMs: s.atMs, x: s.x, options: lost ? { hipVisibility: 0.2 } : {} };
        });
        const { candidates, results } = drive(points);
        assert.equal(candidates.length, 0); // same as the equivalent gap
        assert.ok(results.some((r) => r.result.reason === "low-visibility-sample"));
    });
});

// ===========================================================================
// 5. ONE PHYSICAL WALL INTERACTION -> ONE CANDIDATE (floor semantics)
// ===========================================================================

describe("chronosAssessTurn() — one wall interaction, one candidate", () => {
    test("repeated observations of the same wall contact (a long dwell) produce exactly one candidate", () => {
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 5000 }, { x: 0.3 }], { speed: 0.1, dt: 100 });
        assert.equal(drive(samples).candidates.length, 1);
    });

    test("REGRESSION: with the floor honoured, evaluating every later sample never re-reports the same apex", () => {
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 400 }, { x: 0.3 }, { x: 0.3, holdMs: 6000 }], { speed: 0.1, dt: 100 });
        const { candidates } = drive(samples);
        assert.equal(candidates.length, 1);
        const apex = candidates[0].atMs;

        // Same observations, replayed against the recorded floor: nothing at or before the apex is re-examined.
        const replay = drive(samples, { previousCandidateAtMs: apex });
        assert.equal(replay.candidates.length, 0);
    });

    test("a second wall interaction needs its OWN fresh approach and recovery after the first, and produces its own candidate", () => {
        const { samples, arrivals } = trajectory([{ x: 0.3 }, { x: 0.92, holdMs: 400 }, { x: 0.08, holdMs: 400 }, { x: 0.4 }], { speed: 0.1, dt: 100 });
        const { candidates } = drive(samples);
        assert.equal(candidates.length, 2);
        assert.equal(candidates[0].evidence.wallSide, "near-one");
        assert.equal(candidates[1].evidence.wallSide, "near-zero");
        assert.ok(candidates[1].atMs > candidates[0].atMs);
        assert.ok(Math.abs(candidates[0].atMs - arrivals[1]) <= 100);
        assert.ok(Math.abs(candidates[1].atMs - arrivals[2]) <= 100);
    });

    test("earliestApexMs excludes a turning point at or before it: walking in to the blocks, resting, then diving is not a turn", () => {
        // 0.40 -> 0.06 (walk to the blocks), rest 3 s, then swim away to 0.6: approach + apex + recovery.
        const walkIn = trajectory([{ x: 0.4 }, { x: 0.06, holdMs: 3000 }, { x: 0.6 }], { speed: 0.1, dt: 100 });
        const unconstrained = drive(walkIn.samples);
        assert.equal(unconstrained.candidates.length, 1, "without a floor this IS an approach-apex-recovery");

        // The race is accepted as started AFTER the apex.
        const startedAt = walkIn.arrivals[1] + 500;
        const constrained = drive(walkIn.samples, { config: { earliestApexMs: startedAt } });
        assert.equal(constrained.candidates.length, 0);

        // An apex strictly after the start is allowed.
        const early = drive(walkIn.samples, { config: { earliestApexMs: walkIn.arrivals[1] - 1000 } });
        assert.equal(early.candidates.length, 1);
    });
});

// ===========================================================================
// 6. PURITY AND DETERMINISM
// ===========================================================================

describe("chronosAssessTurn() — purity and determinism", () => {
    test("identical inputs give identical results, and inputs are never mutated", () => {
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 400 }, { x: 0.5 }], { speed: 0.1, dt: 100 });
        const points = samples.map((s) => sample(s.atMs, s.x));
        const history = points.slice(0, -1);
        const current = points[points.length - 1];
        const config = Object.freeze({ referenceLaneY: LANE });
        const frozenHistory = Object.freeze(history.map((entry) => Object.freeze({ ...entry, hip: Object.freeze({ ...entry.hip }), nose: Object.freeze({ ...entry.nose }) })));

        const first = chronosAssessTurn({ sample: current, recentSamples: frozenHistory, config });
        const second = chronosAssessTurn({ sample: current, recentSamples: frozenHistory, config });
        assert.deepEqual(first, second);
        assert.deepEqual(history, points.slice(0, -1));
    });

    test("history order, duplicate timestamps and 'future' entries do not change the result", () => {
        const { samples } = trajectory([{ x: 0.3 }, { x: 0.9, holdMs: 400 }, { x: 0.5 }], { speed: 0.1, dt: 100 });
        const points = samples.map((s) => sample(s.atMs, s.x));
        const history = points.slice(0, -1);
        const current = points[points.length - 1];
        const baseline = chronosAssessTurn({ sample: current, recentSamples: history, config: { referenceLaneY: LANE } });

        const shuffled = [...history].reverse();
        const duplicated = [...history, ...history.slice(10, 20)];
        const withFuture = [...history, sample(current.atMs + 5000, 0.1), sample(current.atMs, 0.1)];
        for (const variant of [shuffled, duplicated, withFuture]) {
            assert.deepEqual(chronosAssessTurn({ sample: current, recentSamples: variant, config: { referenceLaneY: LANE } }), baseline);
        }
    });

    test("confidence is always within [0, 1] and every candidate carries the documented evidence", () => {
        for (const speed of [0.03, 0.1, 0.2]) {
            const { samples } = trajectory([{ x: 0.35 }, { x: 0.95, holdMs: 200 }, { x: 0.4 }], { speed, dt: 100 });
            for (const candidate of drive(samples).candidates) {
                assert.ok(candidate.confidence >= 0 && candidate.confidence <= 1);
                for (const key of ["apexAtMs", "confirmedAtMs", "wallSide", "apexHipX", "approachSwing", "recoverySwing", "laneDeviation", "visibility"]) {
                    assert.notEqual(candidate.evidence[key], undefined, key);
                }
            }
        }
    });
});

// ===========================================================================
// 7. SEEDED FUZZ AGAINST AN INDEPENDENT ORACLE (synthetic)
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

// Independent oracle: for a path made only of long legs (>= 0.12 frame-widths) between waypoints, the
// turns are EXACTLY the interior waypoints that reverse direction inside a wall zone at the
// end of the leg that travelled INTO that wall. (Mid-pool reversals are not turns.)
function oracleTurns(waypoints) {
    const turns = [];
    for (let i = 1; i < waypoints.length - 1; i += 1) {
        const before = waypoints[i].x - waypoints[i - 1].x;
        const after = waypoints[i + 1].x - waypoints[i].x;
        if (before * after >= 0) continue; // not a reversal
        const x = waypoints[i].x;
        const peakIsWallBound = before > 0 && x > 0.75; // travelled up into the near-one zone, then back
        const troughIsWallBound = before < 0 && x < 0.25; // travelled down into the near-zero zone, then back
        if (peakIsWallBound || troughIsWallBound) turns.push(i);
    }
    return turns;
}

describe("chronosAssessTurn() — seeded fuzz against an independent oracle (synthetic paths)", () => {
    test("150 random multi-leg paths: the detector reports exactly the wall reversals, once each, at the right time", () => {
        let totalTurns = 0;
        let totalMidPoolReversals = 0;
        for (let seed = 1; seed <= 150; seed += 1) {
            const random = seeded(seed * 7919);
            // Waypoints alternate direction; each leg is >= 0.12 long. Some reversals are at walls, some mid-pool.
            const waypoints = [{ x: 0.1 + random() * 0.8, holdMs: 500 }];
            let direction = random() < 0.5 ? 1 : -1;
            const legs = 3 + Math.floor(random() * 4);
            for (let leg = 0; leg < legs; leg += 1) {
                const previous = waypoints[waypoints.length - 1].x;
                const room = direction > 0 ? 0.97 - previous : previous - 0.03;
                if (room < 0.12) {
                    direction = -direction;
                    continue;
                }
                const length = 0.12 + random() * (room - 0.12);
                const nextX = previous + direction * length;
                // Keep turning points off the zone boundaries (0.25 / 0.75): whether a sampled apex lands just
                // inside or just outside the zone is a sampling artefact the oracle must not adjudicate.
                if (Math.abs(nextX - 0.25) < 0.03 || Math.abs(nextX - 0.75) < 0.03) {
                    continue;
                }
                waypoints.push({ x: nextX, holdMs: random() < 0.5 ? 0 : 200 + Math.floor(random() * 600) });
                direction = -direction;
            }
            waypoints[waypoints.length - 1].holdMs = 1500;
            if (waypoints.length < 3) continue;

            const speed = 0.04 + random() * 0.1; // 0.04 .. 0.14 frame-widths/s
            const dt = [100, 150, 200][Math.floor(random() * 3)];
            const { samples, arrivals } = trajectory(waypoints, { speed, dt });

            // Single-sample outliers away from every waypoint (at least 5 samples from an arrival).
            const withSpikes = samples.map((s, index) => {
                const nearWaypoint = arrivals.some((a) => Math.abs(a - s.atMs) < 5 * dt + 800);
                if (!nearWaypoint && index > 2 && index < samples.length - 3 && random() < 0.02) {
                    return { atMs: s.atMs, x: Math.min(1, Math.max(0, s.x + (random() < 0.5 ? 0.07 : -0.07))) };
                }
                return s;
            });

            const expected = oracleTurns(waypoints);
            totalTurns += expected.length;
            totalMidPoolReversals += waypoints.slice(1, -1).filter((w, i) => (w.x - waypoints[i].x) * (waypoints[i + 2].x - w.x) < 0).length - expected.length;

            const { candidates } = drive(withSpikes);
            assert.equal(candidates.length, expected.length, `seed ${seed}: expected ${expected.length} turns, got ${candidates.length} (waypoints ${JSON.stringify(waypoints.map((w) => +w.x.toFixed(2)))})`);
            candidates.forEach((candidate, index) => {
                const arrival = arrivals[expected[index]];
                const holdMs = waypoints[expected[index]].holdMs || 0;
                // Documented bound: early by <= tolerance/speed + one sample, late by <= dwell + one sample.
                const early = TURN_ASSESSMENT_DEFAULTS.apexPlateauTolerance / speed * 1000 + dt;
                assert.ok(candidate.atMs >= arrival - early && candidate.atMs <= arrival + holdMs + dt, `seed ${seed}: apex ${candidate.atMs} vs arrival ${arrival} (-${early.toFixed(0)}, +hold ${holdMs})`);
            });
        }
        assert.ok(totalTurns > 100, `the fuzz exercised real turns (${totalTurns})`);
        assert.ok(totalMidPoolReversals > 20, `the fuzz exercised mid-pool reversals (${totalMidPoolReversals})`);
    });
});
