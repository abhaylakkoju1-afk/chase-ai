// Start-context (pre-start reference frame) regression tests
// (Chronos reliability phase 1C).
//
// CONTRACT UNDER TEST (docs/RACE_PIPELINE_ARCHITECTURE.md §7.3): the user
// pauses the race video on a frame BEFORE the start, with the swimmer at
// rest, and marks the swimmer. The paused frame's media time is the
// "pre-start reference frame" (`startReferenceMs`). The start detector may
// only propose an estimated motion onset that is NOT EARLIER than that
// reference frame. Samples before it still reach SwimmerTracking and may
// still serve as the stationary baseline; they just cannot be where the
// departure begins.
//
// EVERY trajectory here is hand-built and SYNTHETIC, driven through the real
// SwimmerTracking -> detector-adapter -> event-adapter -> ChronosEngine chain
// via racePipelineProcessPoseSample(). Passing proves the logic behaves as
// documented on synthetic input; it does NOT establish accuracy on real
// footage (none exists in this repository), and it assumes the user really
// did mark a genuine pre-start frame, which software cannot verify.
//
// Geometry: normalized frame x in [0,1], swimmer facing +x (nose 0.04 ahead
// of the hip), samples 120 ms apart. Noise band 0.02; displacement threshold
// 0.08; departure speed 0.06 frame-widths/s unless stated.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineCreateController,
    racePipelineStartAnalysis,
    racePipelineProcessPoseSample,
    racePipelineBuildReport
} from "../../src/race-pipeline/controller.js";

const DT = 120;
const BASE_CONFIG = {
    poolLengthMeters: 25,
    course: "Short Course",
    event: "Freestyle 50m",
    strokeKey: "freestyle",
    distanceMeters: 50
};

function pose(atMs, hipX, { noseOffset = 0.04 } = {}) {
    return {
        atMs,
        hasPose: true,
        landmarks: {
            hip: { x: hipX, y: 0.5, visibility: 0.9 },
            nose: { x: hipX + noseOffset, y: 0.5, visibility: 0.9 }
        }
    };
}

function times(durationMs) {
    const out = [];
    for (let t = 0; t <= durationMs; t += DT) out.push(t);
    return out;
}

function start(referenceMs, extra = {}) {
    const config = referenceMs === undefined ? { ...BASE_CONFIG, ...extra } : { ...BASE_CONFIG, startReferenceMs: referenceMs, ...extra };
    return racePipelineStartAnalysis(racePipelineCreateController(), config);
}

function freshController(referenceMs) {
    const started = start(referenceMs);
    assert.equal(started.ok, true, `start with reference ${String(referenceMs)} should be accepted`);
    return started.controller;
}

// Drives samples; returns the controller plus a per-frame log of the last
// start assessment and tracking status, for inspecting what happened WHEN.
function drive(controller, samples) {
    const frames = [];
    let current = controller;
    for (const sample of samples) {
        current = racePipelineProcessPoseSample(current, sample, current.generation).controller;
        frames.push({
            t: sample.atMs,
            status: current.chronosSession.status,
            tracking: JSON.stringify(current.trackingSession),
            trackingStatus: current.trackingSession.status,
            assessment: current.diagnostics.lastStartAssessment ? { ...current.diagnostics.lastStartAssessment } : null
        });
    }
    return { controller: current, frames };
}

function startEvents(controller) {
    return controller.chronosSession.events.filter((e) => e.type === "start");
}

// ---- trajectories (frame x of the HIP as a function of media time) --------

// Stands behind the blocks at 0.10, walks to 0.25 between 1.0 s and 2.0 s,
// stands, then dives at 6.0 s (0.06 w/s).
function walkRestDive(t) {
    if (t < 1000) return 0.10;
    if (t < 2000) return 0.10 + (0.15 * (t - 1000)) / 1000;
    if (t < 6000) return 0.25;
    return 0.25 + (0.06 * (t - 6000)) / 1000;
}
const WALK_RESTDIVE_DIVE_ONSET = 6360; // first sample > 0.02 beyond the 0.25 rest

// A clip that begins mid-race: swims right until 6.0 s, pauses at the wall for
// 0.7 s, pushes off to the left, glides back to 0.15 and stops, rests, and then
// (a second, later rest-then-motion) departs at 14.0 s.
function wallPushOffThenRealStart(t) {
    const swim = 0.0576;
    const wallX = 0.15 + (swim * 6000) / 1000;
    if (t <= 6000) return 0.15 + (swim * t) / 1000;
    if (t <= 6700) return wallX;
    const back = wallX - (0.07 * (t - 6700)) / 1000;
    if (back > 0.15 && t < 14000) return back;
    if (t < 14000) return 0.15;
    return 0.15 + (0.06 * (t - 14000)) / 1000;
}

// Rest at 0.15, one short step of +0.10 over 0.24 s at 1.0 s, rest, then a
// dive at 6.0 s.
function stepThenRestThenDive(t) {
    const base = t < 1000 ? 0.15 : t < 1240 ? 0.15 + (0.1 * (t - 1000)) / 240 : 0.25;
    return base + (t > 6000 ? (0.06 * (t - 6000)) / 1000 : 0);
}

const flat = (x) => () => x;

describe("start reference — configuration contract (missing and invalid values never become a valid context)", () => {
    test("a missing reference blocks the analysis with a stable reason and creates no session", () => {
        for (const missing of [undefined, null]) {
            const result = racePipelineStartAnalysis(racePipelineCreateController(), { ...BASE_CONFIG, startReferenceMs: missing });
            assert.equal(result.ok, false);
            assert.equal(result.reason, "missing-start-reference");
            assert.equal(result.controller.chronosSession, null);
            assert.equal(result.controller.trackingSession, null);
            assert.equal(result.controller.blockedReason, "missing-start-reference");
        }
        const absent = racePipelineStartAnalysis(racePipelineCreateController(), BASE_CONFIG);
        assert.equal(absent.reason, "missing-start-reference");
    });

    test("non-finite, negative, and non-numeric references are rejected as invalid, never coerced", () => {
        for (const bad of [NaN, Infinity, -Infinity, -1, -0.001, "3000", true, {}, [], () => 0]) {
            const result = racePipelineStartAnalysis(racePipelineCreateController(), { ...BASE_CONFIG, startReferenceMs: bad });
            assert.equal(result.ok, false, `startReferenceMs=${String(bad)} must be rejected`);
            assert.equal(result.reason, "invalid-start-reference");
            assert.equal(result.controller.chronosSession, null);
        }
    });

    test("0 and a nonzero video position are valid and are stored exactly as given on the controller config", () => {
        for (const ok of [0, 2800, 2800.5]) {
            const result = start(ok);
            assert.equal(result.ok, true);
            assert.equal(result.controller.config.startReferenceMs, ok);
        }
    });
});

describe("start reference — false-start prevention (synthetic)", () => {
    const ts = times(14000);

    test("CONTROL: with the reference at 0 the pre-race walk IS accepted as the start (what the reference exists to prevent)", () => {
        const { controller } = drive(freshController(0), ts.map((t) => pose(t, walkRestDive(t))));
        const starts = startEvents(controller);
        assert.equal(starts.length, 1);
        assert.ok(starts[0].atMs < 2000, `the walk (onset ${starts[0].atMs} ms) is taken as the start when no pre-start frame excludes it`);
    });

    test("pre-race walking before the reference is not the start; the real departure after it is, at its own estimated onset", () => {
        const { controller, frames } = drive(freshController(3000), ts.map((t) => pose(t, walkRestDive(t))));

        const starts = startEvents(controller);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].atMs, WALK_RESTDIVE_DIVE_ONSET);
        assert.ok(starts[0].atMs >= 3000, "the onset cannot precede the reference");

        // The walk was SEEN and refused, visibly: a rejected assessment with the
        // would-be onset, which precedes the reference.
        const refused = frames.filter((f) => f.assessment && f.assessment.reason === "onset-before-reference-frame");
        assert.ok(refused.length > 0, "the refused walk is surfaced in diagnostics");
        for (const f of refused) {
            assert.equal(f.assessment.state, "rejected");
            assert.ok(f.assessment.onsetAtMs < 3000);
        }
    });

    test("a movement that begins AND ends before the reference is not the start", () => {
        const { controller } = drive(freshController(3000), ts.map((t) => pose(t, stepThenRestThenDive(t))));
        const starts = startEvents(controller);
        assert.equal(starts.length, 1);
        assert.ok(starts[0].atMs > 6000, `accepted onset ${starts[0].atMs} must be the dive, not the step at 1000-1240`);
    });

    test("a mid-race wall pause and push-off before the reference is not the start; the later rest-then-departure is", () => {
        const samples = times(18000).map((t) => pose(t, wallPushOffThenRealStart(t)));

        const control = drive(freshController(0), samples).controller;
        assert.ok(startEvents(control)[0].atMs < 9000, "CONTROL: with no reference the push-off is taken as the start");

        const { controller } = drive(freshController(12500), samples);
        const starts = startEvents(controller);
        assert.equal(starts.length, 1);
        assert.ok(starts[0].atMs >= 14000 && starts[0].atMs <= 14600, `accepted onset ${starts[0].atMs} must be the 14.0 s departure`);
    });

    test("a valid movement candidate before the reference, followed by a valid departure after it, yields only the later one", () => {
        const { controller } = drive(freshController(4000), ts.map((t) => pose(t, walkRestDive(t))));
        assert.deepEqual(startEvents(controller).map((e) => e.atMs), [WALK_RESTDIVE_DIVE_ONSET]);
    });

    test("motion that begins before the reference and CONTINUES past it is not the start; with no later departure there is no start", () => {
        const walkOnly = (t) => (t < 1000 ? 0.10 : t < 2000 ? 0.10 + (0.15 * (t - 1000)) / 1000 : 0.25);
        const { controller, frames } = drive(freshController(1600), times(9000).map((t) => pose(t, walkOnly(t))));

        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(startEvents(controller), []);
        assert.ok(frames.some((f) => f.assessment && f.assessment.reason === "onset-before-reference-frame"));
    });
});

describe("start reference — valid use (synthetic)", () => {
    const hipAt = (t) => 0.15 + (t > 6000 ? (0.06 * (t - 6000)) / 1000 : 0);
    const ts = times(14000);

    test("a reference at a nonzero video position (2.8 s) with a later departure: one start, onset after the reference", () => {
        const { controller } = drive(freshController(2800), ts.map((t) => pose(t, hipAt(t))));
        assert.deepEqual(startEvents(controller).map((e) => e.atMs), [6360]);
    });

    test("a reference marked just before the motion uses the stationary samples BEFORE it as the baseline", () => {
        // Reference 120 ms before the true onset: no footage after it is stationary,
        // so the baseline must come from the rest immediately before it.
        const { controller } = drive(freshController(5880), ts.map((t) => pose(t, hipAt(t))));
        assert.deepEqual(startEvents(controller).map((e) => e.atMs), [6360]);
    });

    test("the reference boundary is inclusive: onset == reference is accepted; reference one millisecond later is not", () => {
        const accepted = drive(freshController(6360), ts.map((t) => pose(t, hipAt(t)))).controller;
        assert.deepEqual(startEvents(accepted).map((e) => e.atMs), [6360]);

        const refused = drive(freshController(6361), ts.map((t) => pose(t, hipAt(t))));
        assert.deepEqual(startEvents(refused.controller), []);
        assert.ok(refused.frames.some((f) => f.assessment && f.assessment.reason === "onset-before-reference-frame" && f.assessment.onsetAtMs === 6360));
    });

    test("a reference marked AFTER the motion has already begun beyond the noise band yields no start (the marked frame must precede the motion)", () => {
        const { controller } = drive(freshController(6600), ts.map((t) => pose(t, hipAt(t))));
        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(startEvents(controller), []);
    });

    test("the accepted start event IS the estimated onset; confirmation time is separate and later", () => {
        const { controller, frames } = drive(freshController(2800), ts.map((t) => pose(t, hipAt(t))));
        const [event] = startEvents(controller);
        const confirmingFrame = frames.find((f) => f.assessment && f.assessment.state === "confirmed");

        assert.equal(event.atMs, 6360);
        assert.equal(confirmingFrame.assessment.onsetAtMs, event.atMs, "diagnostics report the same onset the event carries");
        assert.equal(confirmingFrame.assessment.atMs, 7680, "the assessment time is the CONFIRMING sample");
        assert.ok(confirmingFrame.assessment.atMs > event.atMs);
        assert.equal(confirmingFrame.t, confirmingFrame.assessment.atMs);
        assert.equal(confirmingFrame.status, "running");
    });
});

describe("start reference — insufficient or absent stationary footage (synthetic)", () => {
    test("a clip in which the swimmer is already moving when it begins produces no start, whatever the reference", () => {
        for (const reference of [0, 2000]) {
            const { controller } = drive(freshController(reference), times(12000).map((t) => pose(t, 0.15 + (0.06 * t) / 1000)));
            assert.equal(controller.chronosSession.status, "armed", `reference ${reference}`);
            assert.deepEqual(startEvents(controller), []);
        }
    });

    test("motion that begins within the first ~half second (too little stationary footage) produces no start, not a fabricated one", () => {
        const { controller, frames } = drive(freshController(0), times(10000).map((t) => pose(t, 0.15 + (t > 300 ? (0.06 * (t - 300)) / 1000 : 0))));
        assert.deepEqual(startEvents(controller), []);
        assert.ok(frames.some((f) => f.assessment && f.assessment.reason === "no-stationary-baseline"));
    });

    test("a reference beyond the end of the footage yields no start", () => {
        const hipAt = (t) => 0.15 + (t > 6000 ? (0.06 * (t - 6000)) / 1000 : 0);
        const { controller } = drive(freshController(60000), times(14000).map((t) => pose(t, hipAt(t))));
        assert.deepEqual(startEvents(controller), []);
    });

    test("video termination before any accepted start fabricates no start, finish, split, or time", () => {
        const { controller } = drive(freshController(3000), times(5000).map((t) => pose(t, 0.15)));
        const report = racePipelineBuildReport(controller).report;
        assert.equal(report.start, null);
        assert.equal(report.finish, null);
        assert.equal(report.finalTimeMs, null);
        assert.deepEqual(report.splits, []);
    });
});

describe("start reference — tracking is not reset or altered by the reference (synthetic)", () => {
    test("the SwimmerTracking session is identical, frame by frame, with and without a reference; the lock happens BEFORE the reference", () => {
        const samples = times(12000).map((t) => pose(t, walkRestDive(t)));
        const withoutReference = drive(freshController(0), samples);
        const withReference = drive(freshController(5000), samples);

        assert.equal(withReference.frames.length, withoutReference.frames.length);
        for (let i = 0; i < withReference.frames.length; i += 1) {
            assert.equal(withReference.frames[i].tracking, withoutReference.frames[i].tracking, `tracking diverged at ${withReference.frames[i].t} ms`);
        }

        const lockedAt = withReference.controller.trackingSession.lockEstablishedAtMs;
        assert.ok(lockedAt < 5000, `tracking locks (${lockedAt} ms) before the reference (5000 ms) and is not re-established at it`);
        assert.equal(withReference.frames.find((f) => f.t === 4920).trackingStatus, "TARGET_LOCKED");
    });
});

describe("start reference — invariants (synthetic)", () => {
    const hipAt = (t) => 0.15 + (t > 6000 ? (0.06 * (t - 6000)) / 1000 : 0);
    const ts = times(14000);

    test("feeding every observation twice, or an earlier frame again, never creates another start or moves the accepted one", () => {
        const once = drive(freshController(2800), ts.map((t) => pose(t, hipAt(t)))).controller;

        const doubled = [];
        for (const t of ts) { doubled.push(pose(t, hipAt(t)), pose(t, hipAt(t))); }
        const twice = drive(freshController(2800), doubled).controller;
        assert.deepEqual(startEvents(twice), startEvents(once));

        const snapshot = JSON.stringify(once.chronosSession);
        const replay = drive(once, [pose(1000, hipAt(1000)), pose(6360, hipAt(6360)), pose(7440, hipAt(7440))]).controller;
        assert.equal(JSON.stringify(replay.chronosSession), snapshot);
    });

    test("a rejected or ambiguous candidate never starts the session", () => {
        // Walk (rejected: before the reference) then an oscillation (ambiguous).
        const samples = times(9000).map((t) => {
            if (t >= 5000 && t < 5240) return pose(t, 0.25, { noseOffset: 0.04 + 0.1 });
            if (t >= 5240 && t < 5480) return pose(t, 0.25, { noseOffset: 0.04 - 0.1 });
            return pose(t, walkRestDive(Math.min(t, 5999)));
        });
        const { controller } = drive(freshController(3000), samples);
        assert.equal(controller.chronosSession.status, "armed");
        assert.deepEqual(startEvents(controller), []);
    });

    test("SEEDED FUZZ (150 random rest/walk/dive scripts, random references): any accepted start has onset >= the reference, there is at most one, and the diagnostics onset equals the event time", () => {
        let seed = 20261013;
        const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
        let accepted = 0;
        for (let run = 0; run < 150; run += 1) {
            const walkAt = Math.floor(rnd() * 4000) + 500;
            const walkSpeed = 0.04 + rnd() * 0.12;
            const diveAt = walkAt + 2000 + Math.floor(rnd() * 5000);
            const diveSpeed = 0.05 + rnd() * 0.1;
            const reference = Math.floor(rnd() * (diveAt + 1500));
            const x = (t) => 0.1 + (t > walkAt ? Math.min(0.2, (walkSpeed * (t - walkAt)) / 1000) : 0) + (t > diveAt ? (diveSpeed * (t - diveAt)) / 1000 : 0);
            const { controller, frames } = drive(freshController(reference), times(diveAt + 6000).map((t) => pose(t, x(t))));

            const starts = startEvents(controller);
            assert.ok(starts.length <= 1);
            if (starts.length === 1) {
                accepted += 1;
                assert.ok(starts[0].atMs >= reference, `run ${run}: onset ${starts[0].atMs} < reference ${reference}`);
                const confirming = frames.find((f) => f.assessment && f.assessment.state === "confirmed");
                assert.equal(confirming.assessment.onsetAtMs, starts[0].atMs);
                assert.ok(confirming.assessment.atMs >= starts[0].atMs);
            }
        }
        assert.ok(accepted > 20, `the fuzz must actually exercise accepted starts (got ${accepted})`);
    });
});
