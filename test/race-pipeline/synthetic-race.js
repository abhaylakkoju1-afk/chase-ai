// SYNTHETIC full-pool race generator and runner for the Chronos turn tests
// (Chronos reliability phase 2). Not a test file itself (no `.test.js`
// suffix), so `npm test` does not execute it on its own.
//
// EVERYTHING produced here is hand-built synthetic data with EXPLICIT ground
// truth: no real footage, no MediaPipe output, no annotated race exists in
// this repository. Tests built on it prove that the pipeline's LOGIC behaves
// as documented on these trajectories; they do not establish how well turns
// are detected on real video.
//
// Geometry (normalized frame x in [0, 1], a static side-on camera framing the
// whole pool width, which is the assumption docs/CHRONOS_ARCHITECTURE.md §22
// records): the swimmer rests at the near wall (x = X_NEAR), starts at
// `startMs`, swims one pool length at a constant `speed` (frame-widths per
// second) to the far wall (x = X_FAR), pauses `wallPauseMs` there, pushes
// off and swims back, and so on. Ordinary freestyle speed in the earlier
// phase-2 reproduction was about 0.058 frame-widths/s.

import {
    racePipelineCreateController,
    racePipelineStartAnalysis,
    racePipelineProcessPoseSample,
    racePipelineBuildReport
} from "../../src/race-pipeline/controller.js";

export const X_NEAR = 0.06;
export const X_FAR = 0.94;
export const SAMPLE_DT_MS = 120;

export function poseSample(atMs, hipX, { y = 0.5, face = 1, visibility = 0.9, noseY = null } = {}) {
    return {
        atMs,
        hasPose: true,
        landmarks: {
            hip: { x: hipX, y, visibility },
            nose: { x: hipX + 0.04 * face, y: noseY === null ? y : noseY, visibility }
        }
    };
}

export function noPoseSample(atMs) {
    return { atMs, hasPose: false, landmarks: null };
}

// A tiny deterministic PRNG (mulberry32) for seeded jitter / fuzzing.
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Builds a full-pool path with explicit ground truth.
 *
 * @param {object} p
 * @param {number} [p.lengths=2]        pool lengths swum (a 50 m race in a 25 m pool = 2)
 * @param {number} [p.speed=0.058]      frame-widths per second while swimming
 * @param {number} [p.startMs=6000]     when the swimmer starts moving (ground truth)
 * @param {number} [p.wallPauseMs=400]  dwell at each INTERMEDIATE wall before pushing off
 * @param {number} [p.finalHoldMs=6000] rest at the final wall after arriving
 * @param {number} [p.poolLengthMeters=25]
 * @returns {{xAt:(t:number)=>{x:number,face:number}, endMs:number, startMs:number, legMs:number,
 *   turns:Array<{arrivalMs:number, distanceMeters:number, side:string}>, finishArrivalMs:number}}
 */
export function racePath({
    lengths = 2,
    speed = 0.058,
    startMs = 6000,
    wallPauseMs = 400,
    finalHoldMs = 6000,
    poolLengthMeters = 25
} = {}) {
    const legMs = ((X_FAR - X_NEAR) / speed) * 1000;
    const segments = [];
    const turns = [];
    let t = startMs;
    for (let i = 0; i < lengths; i += 1) {
        const outward = i % 2 === 0;
        segments.push({ from: t, to: t + legMs, x0: outward ? X_NEAR : X_FAR, x1: outward ? X_FAR : X_NEAR, face: outward ? 1 : -1 });
        t += legMs;
        if (i < lengths - 1) {
            turns.push({ arrivalMs: t, distanceMeters: (i + 1) * poolLengthMeters, side: outward ? "near-one" : "near-zero" });
            segments.push({ from: t, to: t + wallPauseMs, x0: outward ? X_FAR : X_NEAR, x1: outward ? X_FAR : X_NEAR, face: outward ? 1 : -1 });
            t += wallPauseMs;
        }
    }
    const finishArrivalMs = segments[segments.length - 1].to;
    const endMs = t + finalHoldMs;
    const lastSegment = segments[segments.length - 1];
    const xAt = (time) => {
        if (time < startMs) return { x: X_NEAR, face: 1 };
        for (const s of segments) {
            if (time >= s.from && time < s.to) {
                return { x: s.x0 + ((s.x1 - s.x0) * (time - s.from)) / (s.to - s.from), face: s.face };
            }
        }
        return { x: lastSegment.x1, face: lastSegment.face };
    };
    return { xAt, endMs, startMs, legMs, turns, finishArrivalMs };
}

/**
 * Samples a path at a fixed cadence.
 * @param {object} path from racePath()
 * @param {object} [o]
 * @param {number} [o.dt=SAMPLE_DT_MS]
 * @param {number} [o.jitter=0]        +/- uniform jitter on hip x (seeded)
 * @param {number} [o.seed=1]
 * @param {Array<[number,number]>} [o.dropouts]  [fromMs, toMs) ranges with no pose at all
 * @param {number} [o.endMs]           truncate the clip here (video ends)
 */
export function sampleRace(path, { dt = SAMPLE_DT_MS, jitter = 0, seed = 1, dropouts = [], endMs = path.endMs } = {}) {
    const random = seededRandom(seed);
    const out = [];
    for (let t = 0; t <= endMs; t += dt) {
        if (dropouts.some(([from, to]) => t >= from && t < to)) {
            out.push(noPoseSample(t));
            continue;
        }
        const { x, face } = path.xAt(t);
        const noise = jitter > 0 ? (random() * 2 - 1) * jitter : 0;
        out.push(poseSample(t, x + noise, { face }));
    }
    return out;
}

export function raceConfig({ poolLengthMeters = 25, distanceMeters = 50, startReferenceMs = 3000, referenceLaneY = 0.5, event = null } = {}) {
    return {
        poolLengthMeters,
        course: poolLengthMeters === 50 ? "Long Course" : "Short Course",
        event: event || `Freestyle ${distanceMeters}m`,
        strokeKey: "freestyle",
        distanceMeters,
        referenceLaneY,
        startReferenceMs
    };
}

export function freshRaceController(config) {
    const started = racePipelineStartAnalysis(racePipelineCreateController(), config);
    if (!started.ok) {
        throw new Error(`synthetic race could not start: ${started.reason}`);
    }
    return started.controller;
}

/**
 * Drives samples through the REAL controller (tracking -> detector adapter ->
 * event adapter -> Chronos) and records what happened. `samples` may contain
 * anything the caller wants to test (duplicates, out-of-order, intruders).
 */
export function driveRace(controller, samples) {
    let current = controller;
    const lastEventChanges = [];
    for (const sample of samples) {
        const before = current.diagnostics.lastEvent;
        current = racePipelineProcessPoseSample(current, sample, current.generation).controller;
        if (current.diagnostics.lastEvent !== before && current.diagnostics.lastEvent) {
            lastEventChanges.push({ processedAtMs: sample.atMs, ...current.diagnostics.lastEvent });
        }
    }
    return { controller: current, lastEventChanges };
}

export function runRace({ config, samples }) {
    const { controller, lastEventChanges } = driveRace(freshRaceController(config), samples);
    return summarize(controller, lastEventChanges);
}

export function summarize(controller, lastEventChanges = []) {
    const events = controller.chronosSession.events;
    return {
        controller,
        lastEventChanges,
        events,
        turns: events.filter((e) => e.type === "turn"),
        start: events.find((e) => e.type === "start") || null,
        finish: events.find((e) => e.type === "finish") || null,
        status: controller.chronosSession.status,
        confirmedDistanceMeters: controller.eventAdapterState.confirmedDistanceMeters,
        report: racePipelineBuildReport(controller).report
    };
}
