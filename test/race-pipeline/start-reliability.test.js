// Start-detection and automatic-start reliability regression tests
// (Chronos reliability phase 1).
//
// These tests drive the REAL SwimmerTracking -> detector-adapter ->
// event-adapter -> ChronosEngine chain through racePipelineProcessPoseSample()
// with hand-built, deterministic synthetic trajectories — never real video,
// never real MediaPipe. They assert STATE TRANSITIONS and EVENT TIMESTAMPS
// (not merely that something "returned true"), and they say so plainly where
// a result is a property of the synthetic trajectory rather than evidence of
// real-world accuracy: passing these tests proves the pipeline's logic is
// deterministic and self-consistent, NOT that start detection is accurate on
// real swimming footage (no such footage or independent ground truth exists
// in this repository).
//
// Geometry used by every trajectory below: normalized frame x in [0, 1],
// swimmer facing +x (nose 0.04 ahead of the hip), samples nominally 120 ms
// apart (the page's own RACE_SAMPLE_INTERVAL_MS).
//
// Each test names the defect it is a regression test for (S1..S5), matching
// the Phase 0 audit findings:
//   S1 systematic late start (detection instant used as the time origin)
//   S2 false start from a swimmer who is already moving (no start in footage)
//   S3 non-rolling baseline: slow drift produces a false start; unbounded state
//   S4 no confirmation stage: a single sample was accepted as a start
//   S5 duplicate / out-of-order timestamps admitted into detector state

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineCreateController,
    racePipelineStartAnalysis,
    racePipelineProcessPoseSample,
    racePipelineStopAnalysis,
    racePipelineBuildReport
} from "../../src/race-pipeline/controller.js";
import { racePipelineSubmitStartCandidate, racePipelineCreateEventAdapterState } from "../../src/race-pipeline/event-adapter.js";
import { ChronosEngine } from "../../src/chronos-engine/index.js";

const DT = 120;
const SWIM_SPEED_PER_S = 0.06;        // frame-widths per second (synthetic, round number for exact arithmetic)
const BAND = 0.02;                    // baselineNoiseBandFraction (0.25) * displacementThreshold (0.08)
const THRESHOLD = 0.08;

const CONFIG = {
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 50m",
    strokeKey: "freestyle",
    distanceMeters: 50,
    // Required pre-start reference frame (media time, ms); 0 is neutral and
    // excludes nothing. The reference itself is tested in start-context.test.js.
    startReferenceMs: 0
    // referenceLaneY deliberately absent: turn detection is disabled so these
    // tests isolate START behavior (turn behavior is Phase 2).
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

function gap(atMs) {
    return { atMs, hasPose: false, landmarks: null };
}

function times(durationMs, stepMs = DT) {
    const out = [];
    for (let t = 0; t <= durationMs; t += stepMs) out.push(t);
    return out;
}

// Stationary at `restX` until `onsetMs`, then moving at SWIM_SPEED_PER_S.
function standThenSwim(onsetMs, restX = 0.15) {
    return (t) => restX + (t > onsetMs ? (SWIM_SPEED_PER_S * (t - onsetMs)) / 1000 : 0);
}

function freshController() {
    const started = racePipelineStartAnalysis(racePipelineCreateController(), CONFIG);
    assert.equal(started.ok, true);
    return started.controller;
}

// Feeds samples through the controller in order; records every Chronos
// status transition (with the sample time at which it happened).
function drive(controller, samples) {
    const transitions = [];
    let current = controller;
    let lastStatus = current.chronosSession.status;
    for (const sample of samples) {
        const result = racePipelineProcessPoseSample(current, sample, current.generation);
        current = result.controller;
        const status = current.chronosSession.status;
        if (status !== lastStatus) {
            transitions.push({ atMs: sample.atMs, from: lastStatus, to: status });
            lastStatus = status;
        }
    }
    return { controller: current, transitions };
}

function startEvents(controller) {
    return controller.chronosSession.events.filter((e) => e.type === "start");
}

// First sample time (strictly after the true onset) whose deviation from the
// stationary rest position exceeds the noise band — the onset estimate the
// detector is documented to report. Computed from the fixture's own
// geometry, independently of the detector's code.
function expectedOnsetEstimate(sampleTimes, hipAt, restX) {
    for (const t of sampleTimes) {
        if (Math.abs(hipAt(t) - restX) > BAND) return t;
    }
    return null;
}

describe("start reliability — a valid start (regression for S1, S4)", () => {
    test("one accepted start, armed -> running at the confirmation sample, with atMs at the estimated motion ONSET (not the detection instant)", () => {
        const onsetMs = 6000;
        const hipAt = standThenSwim(onsetMs);
        const ts = times(12000);
        const { controller, transitions } = drive(freshController(), ts.map((t) => pose(t, hipAt(t))));

        const starts = startEvents(controller);
        assert.equal(starts.length, 1, "exactly one accepted start");
        assert.equal(controller.chronosSession.status, "running");
        assert.deepEqual(transitions.map((x) => [x.from, x.to]), [["armed", "running"]]);

        const expectedOnset = expectedOnsetEstimate(ts, hipAt, 0.15);
        assert.equal(expectedOnset, 6360, "fixture sanity: first sample > band beyond rest");
        assert.equal(starts[0].atMs, expectedOnset, "official time origin is the estimated onset, not the later detection instant");

        // The status flips only once the departure has been SUSTAINED for
        // confirmationSamples (3) samples at/over the displacement threshold:
        // dev >= 0.08 first at t=7440 (0.0864), so the confirming sample is 7680.
        assert.equal(transitions[0].atMs, 7680);
        assert.ok(starts[0].atMs < transitions[0].atMs, "onset precedes confirmation");

        // Documented bias bound: onset estimate lags the true onset by at
        // most band/speed + one sample interval.
        const lag = starts[0].atMs - onsetMs;
        assert.ok(lag >= 0 && lag <= (BAND / SWIM_SPEED_PER_S) * 1000 + DT, `onset lag ${lag}ms exceeds the documented bound`);
        assert.equal(starts[0].source, "detector");
        assert.equal(starts[0].detector, "start-detector-v1");
    });

    test("the old behavior is gone: the detection instant (threshold crossing) is no longer used as the time origin", () => {
        const onsetMs = 6000;
        const hipAt = standThenSwim(onsetMs);
        const { controller } = drive(freshController(), times(12000).map((t) => pose(t, hipAt(t))));
        const lagVsOldBehaviour = 7560 - controller.chronosSession.events[0].atMs; // old accepted start was @7560 for this fixture
        assert.ok(lagVsOldBehaviour > 1000, "the official time origin moved earlier by more than 1 s versus the old detection-instant behavior");
    });
});

describe("start reliability — no start present (regression for S2, S3)", () => {
    test("a stationary swimmer with pose jitter never starts the race; status stays armed and no event is fabricated", () => {
        const jitter = (t) => 0.004 * Math.sin(t / 97);
        const { controller, transitions } = drive(freshController(), times(60000).map((t) => pose(t, 0.15 + jitter(t))));

        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(controller.chronosSession.events, []);
        assert.deepEqual(transitions, []);
    });

    test("S2: a swimmer who is ALREADY MOVING when the footage begins (no start in the clip) never produces a start", () => {
        const hipAt = (t) => 0.15 + (SWIM_SPEED_PER_S * t) / 1000;
        const { controller } = drive(freshController(), times(12000).map((t) => pose(t, hipAt(t))));

        assert.equal(controller.chronosSession.status, "armed", "no stationary baseline exists, so no start can be established");
        assert.deepEqual(startEvents(controller), []);
    });

    test("S3: slow drift (0.3% of frame width per second) over 120 s never produces a false start, and detector state stays bounded", () => {
        const drift = 0.003;
        const { controller } = drive(freshController(), times(120000).map((t) => pose(t, 0.15 + (drift * t) / 1000)));

        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(startEvents(controller), []);
        // 4000 ms rolling window at 120 ms spacing => at most ~34 samples, not ~1000.
        assert.ok(
            controller.detectorState.startBaselineWindow.length <= 40,
            `start baseline window must be bounded; got ${controller.detectorState.startBaselineWindow.length}`
        );
    });
});

describe("start reliability — false start-like movement and ambiguity (regression for S4)", () => {
    function stationaryPrefix(untilMs) {
        return times(untilMs).map((t) => pose(t, 0.15));
    }

    test("a SINGLE-sample nose-only displacement (hip still) is not a start", () => {
        const samples = [...stationaryPrefix(1200)];
        samples.push(pose(1320, 0.15, { noseOffset: 0.04 + 0.12 })); // one frame: nose jumps 0.12, hip does not move
        for (let t = 1440; t <= 3600; t += DT) samples.push(pose(t, 0.15));

        const { controller } = drive(freshController(), samples);

        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(startEvents(controller), []);
    });

    test("a brief two-sample excursion that returns to the rest position is not a start", () => {
        const samples = [...stationaryPrefix(1200)];
        samples.push(pose(1320, 0.15, { noseOffset: 0.04 + 0.12 }));
        samples.push(pose(1440, 0.15, { noseOffset: 0.04 + 0.12 }));
        for (let t = 1560; t <= 4200; t += DT) samples.push(pose(t, 0.15));

        const { controller } = drive(freshController(), samples);

        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(startEvents(controller), []);
    });

    test("a departure that reverses direction before it is sustained is not a start", () => {
        // Moves right past the threshold for two samples, then far left: ambiguous, never confirmed.
        const samples = [...stationaryPrefix(1200)];
        samples.push(pose(1320, 0.15, { noseOffset: 0.04 + 0.1 }));
        samples.push(pose(1440, 0.15, { noseOffset: 0.04 + 0.1 }));
        samples.push(pose(1560, 0.15, { noseOffset: 0.04 - 0.1 }));
        samples.push(pose(1680, 0.15, { noseOffset: 0.04 - 0.1 }));
        for (let t = 1800; t <= 3600; t += DT) samples.push(pose(t, 0.15));

        const { controller } = drive(freshController(), samples);

        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(startEvents(controller), []);
    });
});

describe("start reliability — irregular and incomplete sampling", () => {
    const onsetMs = 6000;
    const hipAt = standThenSwim(onsetMs);

    function irregularTimes(durationMs) {
        const steps = [100, 140, 120, 90, 150, 110, 130, 120];
        const out = [0];
        let i = 0;
        while (out[out.length - 1] < durationMs) out.push(out[out.length - 1] + steps[i++ % steps.length]);
        return out;
    }

    test("irregular frame intervals still produce exactly one start, at the estimated onset of THAT sampling", () => {
        const ts = irregularTimes(12000);
        const { controller } = drive(freshController(), ts.map((t) => pose(t, hipAt(t))));

        const starts = startEvents(controller);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].atMs, expectedOnsetEstimate(ts, hipAt, 0.15));
    });

    test("dropped frames (pose lost on every 3rd frame during the departure) do not move or duplicate the start", () => {
        const ts = times(14000);
        const samples = ts.map((t, i) => (t > onsetMs && i % 3 === 0 ? gap(t) : pose(t, hipAt(t))));
        const kept = ts.filter((t, i) => !(t > onsetMs && i % 3 === 0));
        const { controller } = drive(freshController(), samples);

        const starts = startEvents(controller);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].atMs, expectedOnsetEstimate(kept, hipAt, 0.15));
    });
});

describe("start reliability — duplicate and out-of-order observations (regression for S5)", () => {
    const hipAt = standThenSwim(6000);
    const ts = times(12000);

    test("feeding EVERY observation twice yields the identical single start, and duplicates never enter the baseline", () => {
        const once = drive(freshController(), ts.map((t) => pose(t, hipAt(t)))).controller;

        const doubled = [];
        for (const t of ts) {
            doubled.push(pose(t, hipAt(t)));
            doubled.push(pose(t, hipAt(t)));
        }
        const twice = drive(freshController(), doubled).controller;

        assert.equal(startEvents(twice).length, 1);
        assert.equal(startEvents(twice)[0].atMs, startEvents(once)[0].atMs);

        const times_ = twice.detectorState.startBaselineWindow.map((s) => s.atMs);
        assert.equal(new Set(times_).size, times_.length, "no duplicate timestamps in the baseline window");
    });

    test("an out-of-order observation (earlier than one already processed) never creates, moves, or removes a start", () => {
        const samples = ts.map((t) => pose(t, hipAt(t)));
        const withLateArrival = [...samples.slice(0, 40), pose(1000, hipAt(1000)), ...samples.slice(40)];
        const clean = drive(freshController(), samples).controller;
        const noisy = drive(freshController(), withLateArrival).controller;

        assert.equal(startEvents(noisy).length, 1);
        assert.equal(startEvents(noisy)[0].atMs, startEvents(clean)[0].atMs);
    });

    test("S5 (detector adapter level): a duplicate timestamp is refused before the detector and leaves the state object untouched", async () => {
        const { racePipelineCreateDetectorState, racePipelineDetectStartCandidate } = await import("../../src/race-pipeline/detector-adapter.js");
        let state = racePipelineCreateDetectorState();
        const p = (t) => ({ atMs: t, hasPose: true, landmarks: { hip: { x: 0.15, y: 0.5, visibility: 0.9 }, nose: { x: 0.19, y: 0.5, visibility: 0.9 } } });
        state = racePipelineDetectStartCandidate(p(0), state, {}).detectorState;
        state = racePipelineDetectStartCandidate(p(120), state, {}).detectorState;

        const before = state;
        const dup = racePipelineDetectStartCandidate(p(120), state, {});
        const back = racePipelineDetectStartCandidate(p(60), state, {});

        assert.equal(dup.candidate, null);
        assert.equal(back.candidate, null);
        assert.equal(dup.detectorState, before, "duplicate: same state object returned, nothing appended");
        assert.equal(back.detectorState, before, "out-of-order: same state object returned, nothing appended");
        assert.equal(state.startBaselineWindow.length, 2);
    });
});

describe("start reliability — one accepted start, no re-initialization", () => {
    const hipAt = standThenSwim(6000);

    test("after acceptance, continued swimming produces no further start events, and the start detector is no longer fed", () => {
        const ts = times(20000);
        const mid = drive(freshController(), ts.filter((t) => t <= 8000).map((t) => pose(t, hipAt(t)))).controller;
        assert.equal(mid.chronosSession.status, "running");
        const windowLengthAtStart = mid.detectorState.startBaselineWindow.length;
        const eventsAtStart = mid.chronosSession.events;

        const end = drive(mid, ts.filter((t) => t > 8000).map((t) => pose(t, hipAt(t)))).controller;

        assert.equal(startEvents(end).length, 1);
        assert.deepEqual(end.chronosSession.events[0], eventsAtStart[0], "the accepted start event is byte-for-byte unchanged");
        assert.equal(end.detectorState.startBaselineWindow.length, windowLengthAtStart);
    });

    test("re-processing an already-processed earlier frame after acceptance cannot alter the accepted start", () => {
        const ts = times(12000);
        const accepted = drive(freshController(), ts.map((t) => pose(t, hipAt(t)))).controller;
        const snapshot = JSON.stringify(accepted.chronosSession);

        const replay = drive(accepted, [pose(6360, hipAt(6360)), pose(7440, hipAt(7440))]).controller;

        assert.equal(JSON.stringify(replay.chronosSession), snapshot);
    });

    test("losing the target right AFTER the start does not retroactively invalidate or alter the accepted start", () => {
        const ts = times(8000);
        const accepted = drive(freshController(), ts.map((t) => pose(t, hipAt(t)))).controller;
        assert.equal(accepted.chronosSession.status, "running");
        const startBefore = { ...startEvents(accepted)[0] };

        const lostFrames = [];
        for (let t = 8120; t <= 14000; t += DT) lostFrames.push(gap(t));
        const afterLoss = drive(accepted, lostFrames).controller;

        assert.equal(afterLoss.chronosSession.status, "running");
        assert.deepEqual(startEvents(afterLoss), [startBefore]);
    });

    test("a second start candidate submitted directly to Chronos is rejected and leaves the session byte-for-byte unchanged", () => {
        const accepted = drive(freshController(), times(12000).map((t) => pose(t, hipAt(t)))).controller;
        const before = JSON.stringify(accepted.chronosSession);

        const second = racePipelineSubmitStartCandidate(
            accepted.chronosSession,
            { atMs: 9000, confidence: 0.9, evidence: {}, detector: "start-detector-v1" },
            racePipelineCreateEventAdapterState()
        );

        assert.equal(second.ok, false);
        assert.equal(second.reason, "start-already-recorded");
        assert.equal(JSON.stringify(second.session), before);
    });
});

describe("start reliability — rejected candidates and invalid timestamps never start the official timer", () => {
    function armed() {
        const created = ChronosEngine.createSession({ sessionId: "r", poolLengthMeters: 25, course: "Short Course", event: "Freestyle 50m", timeSource: "video" });
        return ChronosEngine.armSession(created.session).session;
    }
    const candidate = (atMs) => ({ atMs, confidence: 0.8, evidence: {}, detector: "start-detector-v1" });

    test("negative, NaN, Infinity and missing timestamps are all rejected; the session stays armed with no events", () => {
        for (const bad of [-1, NaN, Infinity, -Infinity, undefined, "6000"]) {
            const session = armed();
            const result = racePipelineSubmitStartCandidate(session, candidate(bad), racePipelineCreateEventAdapterState());
            assert.equal(result.ok, false, `atMs=${String(bad)} must be rejected`);
            assert.equal(result.session.status, "armed");
            assert.deepEqual(result.session.events, []);
            assert.equal(result.session.finalTimeMs, null);
        }
    });

    test("a rejected candidate does not prevent a later valid start from being accepted exactly once", () => {
        let session = armed();
        const rejected = racePipelineSubmitStartCandidate(session, candidate(-5), racePipelineCreateEventAdapterState());
        session = rejected.session;
        const accepted = racePipelineSubmitStartCandidate(session, candidate(6360), racePipelineCreateEventAdapterState());
        assert.equal(accepted.ok, true);
        assert.equal(accepted.session.status, "running");
        assert.equal(accepted.session.events.length, 1);
        assert.equal(accepted.session.events[0].atMs, 6360);
    });
});

describe("start reliability — target identity", () => {
    test("a second swimmer (a distant static pose spliced into the stream) never contaminates the baseline or moves the start", () => {
        const hipAt = standThenSwim(6000);
        const ts = times(12000);
        const clean = drive(freshController(), ts.map((t) => pose(t, hipAt(t)))).controller;

        const intruderTimes = new Set([2040, 2160, 3600, 7080]);
        const withIntruder = ts.map((t) => (intruderTimes.has(t) ? pose(t, 0.85) : pose(t, hipAt(t))));
        const noisy = drive(freshController(), withIntruder);

        assert.equal(startEvents(noisy.controller).length, 1);
        assert.equal(startEvents(noisy.controller)[0].atMs, startEvents(clean)[0].atMs);
        for (const sample of noisy.controller.detectorState.startBaselineWindow) {
            assert.ok(sample.nose.x < 0.5, "an intruder position must never be present in the baseline");
        }
    });
});

describe("start reliability — end of video before any accepted start", () => {
    test("no start, no finish, no splits, and no fabricated time are reported", () => {
        const { controller } = drive(freshController(), times(5000).map((t) => pose(t, 0.15)));

        const report = racePipelineBuildReport(controller);
        assert.equal(report.ok, true);
        assert.equal(report.report.status, "armed");
        assert.equal(report.report.start, null);
        assert.equal(report.report.finish, null);
        assert.equal(report.report.finalTimeMs, null);
        assert.deepEqual(report.report.splits, []);
    });

    test("stopping before any start aborts the session without recording any event", () => {
        const { controller } = drive(freshController(), times(3000).map((t) => pose(t, 0.15)));
        const stopped = racePipelineStopAnalysis(controller).controller;
        assert.equal(stopped.chronosSession, null);
    });
});
