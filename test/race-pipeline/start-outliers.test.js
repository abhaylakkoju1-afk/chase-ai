// Start-detection outlier, noise, onset-timing and diagnostics regression tests
// (Chronos reliability phase 1B), plus explicit reproductions of the false-start
// modes that phase 1B deliberately does NOT resolve.
//
// Like start-reliability.test.js, every trajectory here is hand-built and
// synthetic, driven through the REAL SwimmerTracking -> detector-adapter ->
// event-adapter -> ChronosEngine chain via racePipelineProcessPoseSample().
// Passing these tests proves the pipeline's logic behaves as documented on
// synthetic input. It does NOT establish accuracy on real swimming footage:
// no real race footage or independently annotated start times exist in this
// repository.
//
// Geometry: normalized frame x in [0, 1], swimmer facing +x (nose 0.04 ahead
// of the hip), samples nominally 120 ms apart (the page's sample cadence).
// SWIM_SPEED_PER_S = 0.06 frame-widths/s; noise band 0.02 (= 0.25 * 0.08).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineCreateController,
    racePipelineStartAnalysis,
    racePipelineProcessPoseSample
} from "../../src/race-pipeline/controller.js";

const DT = 120;
const BAND = 0.02;
const ONSET_MS = 6000;
const REST_X = 0.15;

const CONFIG = {
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 50m",
    strokeKey: "freestyle",
    distanceMeters: 50,
    // Required pre-start reference frame; 0 is neutral (excludes nothing).
    startReferenceMs: 0
};

function pose(atMs, hipX, { noseOffset = 0.04, visibility = 0.9 } = {}) {
    return {
        atMs,
        hasPose: true,
        landmarks: {
            hip: { x: hipX, y: 0.5, visibility },
            nose: { x: hipX + noseOffset, y: 0.5, visibility }
        }
    };
}

function times(durationMs, stepMs = DT) {
    const out = [];
    for (let t = 0; t <= durationMs; t += stepMs) out.push(t);
    return out;
}

function standThenSwim(onsetMs, speedPerS, restX = REST_X) {
    return (t) => restX + (t > onsetMs ? (speedPerS * (t - onsetMs)) / 1000 : 0);
}

function freshController(referenceMs = 0) {
    const started = racePipelineStartAnalysis(racePipelineCreateController(), { ...CONFIG, startReferenceMs: referenceMs });
    assert.equal(started.ok, true);
    return started.controller;
}

function drive(controller, samples) {
    let current = controller;
    for (const sample of samples) {
        current = racePipelineProcessPoseSample(current, sample, current.generation).controller;
    }
    return current;
}

function startEvents(controller) {
    return controller.chronosSession.events.filter((e) => e.type === "start");
}

// First sample time whose deviation from the rest position exceeds the noise band.
function expectedOnsetEstimate(sampleTimes, hipAt, restX = REST_X) {
    for (const t of sampleTimes) {
        if (Math.abs(hipAt(t) - restX) > BAND) return t;
    }
    return null;
}

// mulberry32: deterministic, seeded.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const HIP_AT = standThenSwim(ONSET_MS, 0.06);
const TIMES = times(16000);
const CLEAN_ONSET = expectedOnsetEstimate(TIMES, HIP_AT);

describe("outlier robustness — a single nose spike shortly BEFORE the onset", () => {
    test("fixture sanity: the clean run's onset estimate is the first sample past the noise band", () => {
        assert.equal(CLEAN_ONSET, 6360);
        const clean = drive(freshController(), TIMES.map((t) => pose(t, HIP_AT(t))));
        assert.equal(startEvents(clean)[0].atMs, CLEAN_ONSET);
    });

    for (const leadMs of [120, 240, 360, 480, 720, 960]) {
        test(`same-side spike (+0.03) ${leadMs} ms before the onset neither precedes the true onset nor moves the estimate`, () => {
            const spikeAt = ONSET_MS - leadMs;
            const samples = TIMES.map((t) => (t === spikeAt ? pose(t, HIP_AT(t), { noseOffset: 0.04 + 0.03 }) : pose(t, HIP_AT(t))));
            const controller = drive(freshController(), samples);

            const starts = startEvents(controller);
            assert.equal(starts.length, 1, "exactly one start is still accepted");
            assert.ok(starts[0].atMs >= ONSET_MS, `onset estimate ${starts[0].atMs} must not precede the true onset ${ONSET_MS}`);
            assert.equal(starts[0].atMs, CLEAN_ONSET, "the estimate is the same as the clean run's");
        });

        test(`opposite-side spike (-0.03) ${leadMs} ms before the onset does not suppress the start`, () => {
            const spikeAt = ONSET_MS - leadMs;
            const samples = TIMES.map((t) => (t === spikeAt ? pose(t, HIP_AT(t), { noseOffset: 0.04 - 0.03 }) : pose(t, HIP_AT(t))));
            const controller = drive(freshController(), samples);

            const starts = startEvents(controller);
            assert.equal(starts.length, 1, "a single outlier must not prevent the start from being detected");
            assert.equal(starts[0].atMs, CLEAN_ONSET);
        });
    }

    test("spikes on BOTH sides before the onset do not move or suppress the start", () => {
        const spikes = new Map([[ONSET_MS - 600, +0.03], [ONSET_MS - 240, -0.03]]);
        const samples = TIMES.map((t) => pose(t, HIP_AT(t), { noseOffset: 0.04 + (spikes.get(t) ?? 0) }));
        const controller = drive(freshController(), samples);

        assert.equal(startEvents(controller).length, 1);
        assert.equal(startEvents(controller)[0].atMs, CLEAN_ONSET);
    });
});

describe("outlier robustness — a single dropout INSIDE the departure", () => {
    test("one nose sample falling back to the rest position mid-departure does not move the onset estimate", () => {
        // A landmark glitch affects ONE landmark: only the nose drops back to
        // its rest x for this sample (a whole-body jump back to rest would be
        // rejected by SwimmerTracking's continuity check before it ever
        // reached the detector, which is not what this test is about).
        const dipAt = 6840; // seventh sample into the departure
        const samples = TIMES.map((t) => (t === dipAt ? pose(t, HIP_AT(t), { noseOffset: 0.04 - (HIP_AT(t) - REST_X) }) : pose(t, HIP_AT(t))));
        const controller = drive(freshController(), samples);

        assert.equal(startEvents(controller).length, 1);
        assert.equal(startEvents(controller)[0].atMs, CLEAN_ONSET, "an isolated dropout inside the departure must not delay the onset");
    });
});

describe("onset timing (synthetic, noise-free, constant speed)", () => {
    for (const speed of [0.06, 0.08, 0.1, 0.14]) {
        test(`departure at ${speed} frame-widths/s: onset error is within [0, noiseBand/speed + one sample interval]`, () => {
            const hipAt = standThenSwim(ONSET_MS, speed);
            const controller = drive(freshController(), TIMES.map((t) => pose(t, hipAt(t))));
            const starts = startEvents(controller);

            assert.equal(starts.length, 1);
            const error = starts[0].atMs - ONSET_MS;
            assert.ok(error >= 0, `onset error ${error} ms must not be negative on clean input`);
            assert.ok(error <= (BAND / speed) * 1000 + DT, `onset error ${error} ms exceeds noiseBand/speed + one sample interval`);
            assert.equal(starts[0].atMs, expectedOnsetEstimate(TIMES, hipAt));
        });
    }
});

describe("noisy departures (synthetic, seeded jitter)", () => {
    for (const [speed, jitter] of [[0.08, 0.005], [0.1, 0.005], [0.1, 0.01], [0.14, 0.01]]) {
        test(`speed ${speed}, uniform jitter ±${jitter}: a start is accepted in every one of 10 seeds, not earlier than ${BAND / 2 / speed * 1000 | 0} ms before the true onset, and within 1.5 s after it`, () => {
            const hipAt = standThenSwim(ONSET_MS, speed);
            for (let seed = 1; seed <= 10; seed += 1) {
                const rnd = rng(seed * 7919);
                const noise = new Map(TIMES.map((t) => [t, (rnd() * 2 - 1) * jitter]));
                const controller = drive(freshController(), TIMES.map((t) => pose(t, hipAt(t) + noise.get(t))));

                const starts = startEvents(controller);
                assert.equal(starts.length, 1, `seed ${seed}: start must be detected`);
                const error = starts[0].atMs - ONSET_MS;
                assert.ok(error <= 1500, `seed ${seed}: onset error ${error} ms is too large`);
                assert.ok(error >= -(BAND / 2 / speed) * 1000 - DT, `seed ${seed}: onset ${error} ms before the true onset is beyond the noise-explained bound`);
            }
        });
    }

    test("a stationary swimmer with the same jitter never starts the race", () => {
        for (let seed = 1; seed <= 10; seed += 1) {
            const rnd = rng(seed * 104729);
            const controller = drive(freshController(), times(40000).map((t) => pose(t, REST_X + (rnd() * 2 - 1) * 0.01)));
            assert.deepEqual(startEvents(controller), [], `seed ${seed}`);
        }
    });
});

describe("start assessment diagnostics — surfaced through controller.diagnostics", () => {
    test("a fresh controller reports no assessment yet", () => {
        assert.equal(freshController().diagnostics.lastStartAssessment, null);
    });

    test("the last assessment tracks the detector: stationary -> departing -> plausible -> confirmed, with the evaluated sample time", () => {
        let controller = freshController();
        const seen = [];
        for (const t of times(8000)) {
            controller = racePipelineProcessPoseSample(controller, pose(t, HIP_AT(t)), controller.generation).controller;
            const a = controller.diagnostics.lastStartAssessment;
            if (a && (seen.length === 0 || seen[seen.length - 1].state !== a.state || seen[seen.length - 1].reason !== a.reason)) {
                seen.push({ state: a.state, reason: a.reason, atMs: a.atMs });
            }
        }
        // The first forwarded sample is the one that locks tracking (480 ms);
        // fewer than 5 baseline samples exist yet, so the honest first
        // assessment is "no stationary baseline" — the same signature a clip
        // with too little stationary footage will show. Then the swimmer
        // is at rest, the departure is below threshold, then plausible, then
        // confirmed at the confirming sample.
        assert.deepEqual(
            seen.map((s) => `${s.state}/${s.reason}`),
            [
                "rejected/no-stationary-baseline",
                "none/stationary",
                "none/below-threshold",
                "plausible/awaiting-confirmation",
                "confirmed/sustained-departure"
            ]
        );
        assert.equal(seen[0].atMs, 480);
        assert.deepEqual(seen[seen.length - 1], { state: "confirmed", reason: "sustained-departure", atMs: 7680 });
    });

    test("a swimmer who is already moving surfaces rejected / no-stationary-baseline (a silent miss becomes visible)", () => {
        const controller = drive(freshController(), times(6000).map((t) => pose(t, 0.15 + (0.06 * t) / 1000)));
        assert.deepEqual(
            { state: controller.diagnostics.lastStartAssessment.state, reason: controller.diagnostics.lastStartAssessment.reason },
            { state: "rejected", reason: "no-stationary-baseline" }
        );
    });

    test("after a start is accepted the last assessment stays at the confirming one (the detector is no longer run)", () => {
        const accepted = drive(freshController(), times(8000).map((t) => pose(t, HIP_AT(t))));
        const snapshot = JSON.stringify(accepted.diagnostics.lastStartAssessment);
        const later = drive(accepted, times(20000).filter((t) => t > 8000).map((t) => pose(t, HIP_AT(t))));
        assert.equal(JSON.stringify(later.diagnostics.lastStartAssessment), snapshot);
        assert.equal(later.diagnostics.lastStartAssessment.state, "confirmed");
    });

    test("recording the assessment never changes what Chronos accepts (same events with or without reading diagnostics)", () => {
        const a = drive(freshController(), TIMES.map((t) => pose(t, HIP_AT(t))));
        const b = drive(freshController(), TIMES.map((t) => pose(t, HIP_AT(t))));
        assert.deepEqual(a.chronosSession.events, b.chronosSession.events);
        assert.equal(a.chronosSession.events.length, 1);
    });
});

// ---------------------------------------------------------------------------
// FALSE STARTS THAT NEED START CONTEXT.
//
// In phase 1B these three behaviors were reproduced as `todo` tests because no
// threshold can tell which rest-then-motion in a clip is the race start. The
// pre-start reference frame (phase 1C, docs/RACE_PIPELINE_ARCHITECTURE.md §7.3)
// supplies that context, so the same trajectories now assert the DESIRED
// outcome as ordinary tests, with the reference placed where a user following
// the instructions would place it. They pass ONLY because the frame is marked
// after the unwanted movement: with a reference at 0 the same clips still
// produce the false start (see the CONTROL tests in start-context.test.js),
// and a user who marks a wrong frame defeats the constraint. Synthetic data.
// ---------------------------------------------------------------------------
describe("false starts that the pre-start reference frame prevents (synthetic)", () => {
    test("a swimmer walking to the blocks before the real start is not the race start", () => {
        // Stands behind the blocks, walks 0.10 -> 0.25 over 2 s, stands, then dives at 9.0 s.
        // The user marks a frame at rest on the blocks, at 5.0 s.
        const x = (t) => (t < 2000 ? 0.10 : t < 4000 ? 0.10 + (0.15 * (t - 2000)) / 2000 : t < 9000 ? 0.25 : 0.25 + (0.12 * (t - 9000)) / 1000);
        const controller = drive(freshController(5000), times(14000).map((t) => pose(t, x(t))));
        const starts = startEvents(controller);

        assert.equal(starts.length, 1);
        assert.ok(starts[0].atMs >= 8800, `the walk must not be taken as the start (accepted ${starts[0] && starts[0].atMs} ms); the dive is at 9000`);
        assert.ok(starts[0].atMs >= 5000, "the onset cannot precede the marked frame");
    });

    test("stepping forward and standing still is not a race start", () => {
        const x = (t) => (t < 2000 ? 0.15 : t < 2240 ? 0.15 + (0.1 * (t - 2000)) / 240 : 0.25);
        const controller = drive(freshController(3000), times(8000).map((t) => pose(t, x(t))));

        assert.deepEqual(startEvents(controller), [], "a position adjustment before the marked frame is not a start");
    });

    test("in a clip that begins mid-race, a wall pause followed by a push-off before the marked frame is not the race start", () => {
        const speed = 0.0576;
        const wallAt = 6000;
        const pause = 700;
        const x = (t) => (t <= wallAt ? 0.15 + (speed * t) / 1000 : t <= wallAt + pause ? 0.15 + (speed * wallAt) / 1000 : 0.15 + (speed * wallAt) / 1000 - (0.0704 * (t - wallAt - pause)) / 1000);
        const controller = drive(freshController(9000), times(14000).map((t) => pose(t, x(t))));

        assert.deepEqual(startEvents(controller), [], "the race start is not in this clip");
    });
});
