// Turn-detection and race-distance integrity tests THROUGH THE CONTROLLER
// (Chronos reliability phase 2).
//
// Every scenario drives the REAL SwimmerTracking -> detector adapter ->
// event adapter -> ChronosEngine chain via racePipelineProcessPoseSample().
//
// ALL DATA IS SYNTHETIC, with explicit ground truth from
// test/race-pipeline/synthetic-race.js (the time the swimmer reaches each
// wall). Passing proves the pipeline's logic and invariants on these inputs.
// It does NOT establish accuracy on real swimming footage: no real footage or
// independently annotated turn times exist in this repository.

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
    noPoseSample,
    seededRandom,
    SAMPLE_DT_MS
} from "./synthetic-race.js";

import { MIN_EVENT_GAP_MS } from "../../src/chronos-engine/events.js";
import { TURN_ASSESSMENT_DEFAULTS } from "../../src/chronos-engine/detectors/turn-detector.js";

// Documented apex-time bound for a clean synthetic run: early by <= plateauTolerance/speed + dt,
// late by <= the dwell at the wall + dt.
function apexWithinBound(apexMs, arrivalMs, { speed, dt = SAMPLE_DT_MS, dwellMs = 400 }) {
    const early = (TURN_ASSESSMENT_DEFAULTS.apexPlateauTolerance / speed) * 1000 + dt;
    return apexMs >= arrivalMs - early && apexMs <= arrivalMs + dwellMs + dt;
}

function expectTurns(result, path, count, { speed = 0.058 } = {}) {
    assert.equal(result.turns.length, count, `accepted turns: ${JSON.stringify(result.turns.map((e) => [e.distanceMeters, e.atMs]))}`);
    result.turns.forEach((event, index) => {
        assert.equal(event.distanceMeters, path.turns[index].distanceMeters);
        assert.ok(apexWithinBound(event.atMs, path.turns[index].arrivalMs, { speed }), `turn ${index + 1} at ${event.atMs} vs wall arrival ${path.turns[index].arrivalMs}`);
    });
}

// ===========================================================================
// 1. THE KNOWN FAILURES (reported for the previous implementation) — REGRESSION
// ===========================================================================

describe("REGRESSION — the previously reported full-pool failures (synthetic 50 m race in a 25 m pool, ~0.058 frame-widths/s)", () => {
    const path = racePath({ lengths: 2 });
    const result = runRace({ config: raceConfig({ distanceMeters: 50 }), samples: sampleRace(path) });

    test("no phantom turn shortly after the accepted start", () => {
        assert.notEqual(result.start, null);
        const earlyTurns = result.lastEventChanges.filter((change) => change.kind === "turn" && change.atMs < result.start.atMs + 10000);
        assert.deepEqual(earlyTurns, [], "no turn candidate of ANY outcome in the first 10 s after the start");
    });

    test("a 50 m race has exactly ONE accepted turn (25 m), timed at the far wall", () => {
        expectTurns(result, path, 1);
        assert.equal(result.turns[0].distanceMeters, 25);
    });

    test("the same wall is never counted more than once: no candidate is even PROPOSED a second time", () => {
        const proposals = result.lastEventChanges.filter((change) => change.kind === "turn");
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0].ok, true);
    });

    test("confirmed distance never reaches the race distance (it was 125 m for a 50 m race)", () => {
        assert.equal(result.confirmedDistanceMeters, 25);
        assert.ok(Math.max(...result.events.map((e) => e.distanceMeters)) < 50);
        assert.equal(result.status, "running");
        assert.equal(result.finish, null);
        assert.equal(result.report.finalTimeMs, null);
    });

    test("swimming near a wall slowly is not selected by velocity: the swimmer's ordinary speed is below the old 0.12 gate and still produced no turn before the wall", () => {
        // At ~0.058 frame-widths/s every sample inside a wall zone is "slow" by the old gate (0.12); the first
        // 'turn' used to be proposed ~120 ms after the start accepted, while still inside the start zone.
        const firstProposal = result.lastEventChanges.find((change) => change.kind === "turn");
        assert.ok(firstProposal.atMs > path.turns[0].arrivalMs - 1000, "the first turn proposal is at the far wall, not at the start");
    });
});

// ===========================================================================
// 2. VALID TURNS ACROSS RACE LENGTHS AND POOLS (config-driven, nothing hard-coded)
// ===========================================================================

describe("valid turns across configured race distances and pool lengths", () => {
    const cases = [
        { name: "25 m race, 25 m pool: no turn", distance: 25, pool: 25, lengths: 1, turns: 0 },
        { name: "50 m race, 25 m pool: one turn", distance: 50, pool: 25, lengths: 2, turns: 1 },
        { name: "50 m race, 50 m pool: no turn", distance: 50, pool: 50, lengths: 1, turns: 0 },
        { name: "100 m race, 25 m pool: three turns", distance: 100, pool: 25, lengths: 4, turns: 3 },
        { name: "100 m race, 50 m pool: one turn", distance: 100, pool: 50, lengths: 2, turns: 1 },
        { name: "200 m race, 25 m pool: seven turns", distance: 200, pool: 25, lengths: 8, turns: 7 }
    ];

    for (const c of cases) {
        test(`${c.name}`, () => {
            const path = racePath({ lengths: c.lengths, poolLengthMeters: c.pool });
            const result = runRace({
                config: raceConfig({ distanceMeters: c.distance, poolLengthMeters: c.pool }),
                samples: sampleRace(path)
            });

            expectTurns(result, path, c.turns);
            assert.equal(result.confirmedDistanceMeters, c.turns * c.pool);
            assert.equal(result.status, "running"); // arriving at the final wall is NOT a finish
            assert.equal(result.finish, null);
            assert.equal(result.report.finalTimeMs, null);
            assert.equal(result.report.splits.length, c.turns);
        });
    }

    test("accepted turns are strictly increasing in time and distance, all after the start, with the Chronos minimum gap", () => {
        const path = racePath({ lengths: 8 });
        const result = runRace({ config: raceConfig({ distanceMeters: 200 }), samples: sampleRace(path) });
        let previous = result.start;
        for (const turn of result.turns) {
            assert.ok(turn.atMs > previous.atMs);
            if (previous.type === "turn") {
                assert.ok(turn.atMs - previous.atMs >= MIN_EVENT_GAP_MS);
                assert.equal(turn.distanceMeters, previous.distanceMeters + 25);
            }
            previous = turn;
        }
    });

    test("a race that starts at the FAR wall (mirrored geometry) is handled identically", () => {
        const path = racePath({ lengths: 2 });
        const mirrored = sampleRace(path).map((s) => poseSample(s.atMs, 1 - s.landmarks.hip.x, { face: -1 }));
        const result = runRace({ config: raceConfig({ distanceMeters: 50 }), samples: mirrored });
        expectTurns(result, path, 1);
    });

    test("the result is identical across swim speeds and sampling cadences (not tuned to one trajectory)", () => {
        for (const speed of [0.06, 0.08, 0.12]) {
            for (const dt of [120, 160, 240]) {
                const path = racePath({ lengths: 4, speed });
                const result = runRace({ config: raceConfig({ distanceMeters: 100 }), samples: sampleRace(path, { dt }) });
                assert.equal(result.turns.length, 3, `speed=${speed} dt=${dt}`);
                result.turns.forEach((turn, i) => {
                    assert.equal(turn.distanceMeters, path.turns[i].distanceMeters);
                    assert.ok(apexWithinBound(turn.atMs, path.turns[i].arrivalMs, { speed, dt }), `speed=${speed} dt=${dt} turn ${i + 1}: ${turn.atMs} vs ${path.turns[i].arrivalMs}`);
                });
            }
        }
    });
});

// ===========================================================================
// 3. NOT-A-TURN SCENARIOS
// ===========================================================================

describe("scenarios that must NOT produce a turn", () => {
    const config = raceConfig({ distanceMeters: 50 });

    test("ordinary swimming near a wall that never reverses (the clip ends or the swimmer stops at the wall) is not a turn", () => {
        const path = racePath({ lengths: 1, finalHoldMs: 20000 });
        const result = runRace({ config, samples: sampleRace(path) });
        assert.equal(result.turns.length, 0);
        assert.equal(result.confirmedDistanceMeters, 0);
        assert.notEqual(result.controller.diagnostics.lastTurnAssessment.state, "confirmed");
    });

    test("a wall approach that is still in progress when the clip ends is reported 'plausible', never confirmed", () => {
        const path = racePath({ lengths: 1, finalHoldMs: 0 });
        const result = runRace({ config, samples: sampleRace(path, { endMs: path.finishArrivalMs + 1000 }) });
        assert.equal(result.turns.length, 0);
        assert.equal(result.controller.diagnostics.lastTurnAssessment.state, "plausible");
        assert.equal(result.controller.diagnostics.lastTurnAssessment.reason, "awaiting-recovery");
    });

    test("a start immediately followed by slow swimming inside the start wall zone is not a turn", () => {
        const samples = [];
        for (let t = 0; t <= 40000; t += 120) {
            let x = 0.06;
            if (t >= 6000 && t < 7000) x = 0.06 + 0.14 * ((t - 6000) / 1000);
            else if (t >= 7000) x = Math.min(0.2 + 0.02 * ((t - 7000) / 1000), 0.24);
            samples.push(poseSample(t, x));
        }
        const result = runRace({ config, samples });
        assert.notEqual(result.start, null);
        assert.equal(result.turns.length, 0);
        assert.equal(result.lastEventChanges.filter((c) => c.kind === "turn").length, 0);
    });

    test("walking in to the start wall, resting, then starting is not a turn when the pre-start frame is marked after the walk", () => {
        const path = racePath({ lengths: 2 });
        const samples = sampleRace(path).map((s) => {
            if (s.atMs < 1000) return poseSample(s.atMs, 0.35);
            if (s.atMs < 4000) return poseSample(s.atMs, 0.35 + ((0.06 - 0.35) * (s.atMs - 1000)) / 3000);
            return s;
        });
        const result = runRace({ config: raceConfig({ distanceMeters: 50, startReferenceMs: 5000 }), samples });
        expectTurns(result, path, 1); // only the real turn at the far wall
        assert.ok(result.start.atMs >= 5000);
    });

    test("LIMITATION (start context, not turn detection): if the marked 'pre-start' frame is BEFORE the walk, the walk becomes the start and its arrival at the blocks looks like a turn", () => {
        const path = racePath({ lengths: 2 });
        const samples = sampleRace(path).map((s) => {
            if (s.atMs < 1000) return poseSample(s.atMs, 0.35);
            if (s.atMs < 4000) return poseSample(s.atMs, 0.35 + ((0.06 - 0.35) * (s.atMs - 1000)) / 3000);
            return s;
        });
        const result = runRace({ config: raceConfig({ distanceMeters: 50, startReferenceMs: 0 }), samples });
        assert.ok(result.start.atMs < 3000, "the walk was accepted as the start");
        assert.ok(result.turns.length >= 1 && result.turns[0].atMs < 6000, "its arrival at the start wall was then proposed as a turn");
    });

    test("one noisy pose observation (a single frame jumping into the wall zone) never produces a turn", () => {
        const path = racePath({ lengths: 1, finalHoldMs: 4000 });
        const clean = sampleRace(path);
        for (const glitchAt of [10080, 14040, 18000, 22080]) {
            const samples = clean.map((s) => (s.atMs === glitchAt ? poseSample(s.atMs, 0.95) : s));
            const result = runRace({ config, samples });
            assert.equal(result.turns.length, 0, `glitch at ${glitchAt}`);
        }
    });

    test("a two-frame excursion into the wall zone is rejected by tracking continuity and never reaches the detector", () => {
        const path = racePath({ lengths: 2 });
        const clean = sampleRace(path);
        const glitched = clean.map((s) => (s.atMs === 14040 || s.atMs === 14160 ? poseSample(s.atMs, 0.1) : s));
        const result = runRace({ config, samples: glitched });
        expectTurns(result, path, 1); // only the genuine wall; no phantom at the glitch
        assert.ok(result.lastEventChanges.every((c) => c.kind !== "turn" || c.atMs > 20000));
    });
});

// ===========================================================================
// 4. REPEATED OBSERVATIONS OF ONE WALL CONTACT
// ===========================================================================

describe("one physical wall contact is one turn", () => {
    test("a long dwell at the wall (many repeated wall observations) produces exactly one accepted turn and one proposal", () => {
        const path = racePath({ lengths: 4, wallPauseMs: 6000 });
        const result = runRace({ config: raceConfig({ distanceMeters: 100 }), samples: sampleRace(path) });
        assert.equal(result.turns.length, 3);
        assert.equal(result.lastEventChanges.filter((c) => c.kind === "turn").length, 3, "one proposal per physical contact");
        assert.ok(result.lastEventChanges.every((c) => c.ok));
    });

    test("LIMITATION: a pause at the wall longer than the history window (12 s) yields no turn at all, rather than a guessed one", () => {
        const path = racePath({ lengths: 4, wallPauseMs: 14000 });
        const result = runRace({ config: raceConfig({ distanceMeters: 100 }), samples: sampleRace(path) });
        assert.equal(result.turns.length, 0);
        assert.equal(result.confirmedDistanceMeters, 0);
    });

    test("repeated observations of the wall via duplicate frames add nothing", () => {
        const path = racePath({ lengths: 2 });
        const clean = sampleRace(path);
        const doubled = clean.flatMap((s) => [s, s]);
        const result = runRace({ config: raceConfig({ distanceMeters: 50 }), samples: doubled });
        const reference = runRace({ config: raceConfig({ distanceMeters: 50 }), samples: clean });
        assert.deepEqual(result.events, reference.events);
    });
});

// ===========================================================================
// 5. RACE-DISTANCE LIMITS ENFORCED THROUGH THE EXISTING CONFIGURATION
// ===========================================================================

describe("the configured race distance bounds the accepted progression", () => {
    test("video that continues past the race distance: later wall contacts are REJECTED by Chronos with its own reason, and nothing changes", () => {
        // A 50 m race (one turn, at 25 m), but the clip carries on for two more lengths.
        const path = racePath({ lengths: 4 });
        const result = runRace({ config: raceConfig({ distanceMeters: 50 }), samples: sampleRace(path) });

        assert.equal(result.turns.length, 1);
        assert.equal(result.turns[0].distanceMeters, 25);
        assert.equal(result.confirmedDistanceMeters, 25);
        assert.equal(result.status, "running");
        assert.equal(result.finish, null);

        const proposals = result.lastEventChanges.filter((c) => c.kind === "turn");
        assert.equal(proposals.length, 3); // the genuine turn + the next two wall contacts
        assert.deepEqual(proposals.map((c) => c.ok), [true, false, false]);
        assert.deepEqual(proposals.slice(1).map((c) => c.reason), ["turn-at-or-beyond-race-distance", "turn-at-or-beyond-race-distance"]);
        for (const event of result.events) assert.ok(event.distanceMeters < 50);
    });

    test("a swimmer who touches and pushes off the finish wall of a 25 m race produces no turn and no finish", () => {
        const path = racePath({ lengths: 2 });
        const result = runRace({ config: raceConfig({ distanceMeters: 25, event: "Freestyle 25m" }), samples: sampleRace(path) });
        assert.equal(result.turns.length, 0);
        assert.equal(result.finish, null);
        assert.equal(result.confirmedDistanceMeters, 0);
        const proposals = result.lastEventChanges.filter((c) => c.kind === "turn");
        assert.equal(proposals.length, 1);
        assert.equal(proposals[0].reason, "turn-at-or-beyond-race-distance");
    });

    test("a race distance that is not a whole number of pool lengths accepts NO turn (the progression is ambiguous), and says why", () => {
        const path = racePath({ lengths: 3 });
        const result = runRace({ config: raceConfig({ distanceMeters: 60, event: "Freestyle 60m" }), samples: sampleRace(path) });
        assert.equal(result.turns.length, 0);
        assert.equal(result.confirmedDistanceMeters, 0);
        const proposals = result.lastEventChanges.filter((c) => c.kind === "turn");
        assert.ok(proposals.length >= 1);
        assert.ok(proposals.every((c) => c.ok === false && c.reason === "race-distance-not-multiple-of-pool-length"));
    });

    test("a controller started without a race distance accepts NO turn (it will not guess one)", () => {
        const path = racePath({ lengths: 2 });
        const config = { ...raceConfig({ distanceMeters: 50 }), distanceMeters: null };
        const result = runRace({ config, samples: sampleRace(path) });
        assert.equal(result.turns.length, 0);
        assert.ok(result.lastEventChanges.filter((c) => c.kind === "turn").every((c) => c.ok === false && c.reason === "race-distance-unknown"));
        assert.equal(result.confirmedDistanceMeters, 0);
    });
});

// ===========================================================================
// 6. INVALID, DUPLICATE AND OUT-OF-ORDER TIMESTAMPS; REPROCESSING
// ===========================================================================

describe("timestamps and reprocessing", () => {
    const config = raceConfig({ distanceMeters: 100 });
    const path = racePath({ lengths: 4 });
    const clean = sampleRace(path);
    const reference = runRace({ config, samples: clean });

    test("the clean reference run is the expected one", () => {
        expectTurns(reference, path, 3);
    });

    test("duplicate timestamps, out-of-order swaps and invalid timestamps do not change the accepted events", () => {
        const noisy = [];
        for (const s of clean) {
            noisy.push(s);
            if (s.atMs % 1200 === 0) noisy.push(s); // duplicates
            if (s.atMs % 5000 === 0) {
                noisy.push(poseSample(NaN, 0.5), poseSample(-100, 0.5), poseSample(Infinity, 0.5), { atMs: "1000", hasPose: true, landmarks: s.landmarks });
            }
        }
        for (let i = 100; i < noisy.length - 1; i += 37) {
            const tmp = noisy[i];
            noisy[i] = noisy[i + 1];
            noisy[i + 1] = tmp;
        }
        const result = runRace({ config, samples: noisy });
        assert.deepEqual(result.events.map((e) => [e.type, e.atMs, e.distanceMeters]), reference.events.map((e) => [e.type, e.atMs, e.distanceMeters]));
        for (const event of result.events) {
            assert.ok(Number.isFinite(event.atMs) && event.atMs >= 0);
        }
    });

    test("REPROCESSING: running the same observations through the same controller a second time cannot advance race state", () => {
        const controller = freshRaceController(config);
        const first = driveRace(controller, clean);
        const eventsAfterFirst = JSON.stringify(first.controller.chronosSession.events);
        const distanceAfterFirst = first.controller.eventAdapterState.confirmedDistanceMeters;

        const second = driveRace(first.controller, clean);
        assert.equal(JSON.stringify(second.controller.chronosSession.events), eventsAfterFirst);
        assert.equal(second.controller.eventAdapterState.confirmedDistanceMeters, distanceAfterFirst);
        assert.equal(second.controller.chronosSession.events.length, first.controller.chronosSession.events.length);
        assert.equal(second.controller.chronosSession.status, "running");
    });

    test("determinism: two fresh controllers over the same samples produce identical sessions", () => {
        const again = runRace({ config, samples: clean });
        assert.deepEqual(again.events, reference.events);
        assert.deepEqual(again.report, reference.report);
    });

    test("online consistency: the events after any prefix of the video are a prefix of the full run's events (nothing is revised)", () => {
        const fullEvents = reference.events.map((e) => `${e.type}|${e.atMs}|${e.distanceMeters}`);
        for (let cut = 3000; cut <= path.endMs; cut += 1830) {
            const prefix = runRace({ config, samples: sampleRace(path, { endMs: cut }) });
            const prefixEvents = prefix.events.map((e) => `${e.type}|${e.atMs}|${e.distanceMeters}`);
            assert.deepEqual(prefixEvents, fullEvents.slice(0, prefixEvents.length), `cut at ${cut}`);
        }
    });
});

// ===========================================================================
// 7. END OF VIDEO
// ===========================================================================

describe("end of video near a wall", () => {
    const config = raceConfig({ distanceMeters: 50 });
    const path = racePath({ lengths: 2 });
    const arrival = path.turns[0].arrivalMs;

    test("a clip that ends while the swimmer is at the wall, before the recovery is observed, yields no turn", () => {
        for (const end of [arrival - 2000, arrival, arrival + 300, arrival + 1200, arrival + 1700]) {
            const result = runRace({ config, samples: sampleRace(path, { endMs: end }) });
            assert.equal(result.turns.length, 0, `end=${end}`);
            assert.equal(result.confirmedDistanceMeters, 0);
            assert.equal(result.status, "running");
            assert.equal(result.finish, null);
        }
    });

    test("the turn appears only once the recovery has been held, and its time does not move afterwards", () => {
        let appearedAt = null;
        let apex = null;
        for (let end = arrival - 500; end <= arrival + 5000; end += 120) {
            const result = runRace({ config, samples: sampleRace(path, { endMs: end }) });
            assert.ok(result.turns.length <= 1);
            if (result.turns.length === 1) {
                if (appearedAt === null) {
                    appearedAt = end;
                    apex = result.turns[0].atMs;
                }
                assert.equal(result.turns[0].atMs, apex, `the accepted turn time is stable (end=${end})`);
            } else {
                assert.equal(appearedAt, null, "once accepted a turn never disappears");
            }
        }
        assert.notEqual(appearedAt, null);
        assert.ok(appearedAt > arrival + 1000, `confirmation (${appearedAt}) is well after the arrival (${arrival})`);
        assert.ok(apex < appearedAt);
    });

    test("end of video at the FINAL wall creates no finish, no final time and no extra distance", () => {
        const result = runRace({ config, samples: sampleRace(path, { endMs: path.finishArrivalMs + 8000 }) });
        assert.equal(result.finish, null);
        assert.equal(result.report.finalTimeMs, null);
        assert.equal(result.report.finish, null);
        assert.equal(result.status, "running");
        assert.equal(result.confirmedDistanceMeters, 25);
    });
});

// ===========================================================================
// 8. TRACKING LOSS, MULTIPLE SWIMMERS, REACQUISITION
// ===========================================================================

describe("tracking loss around a turn", () => {
    const config = raceConfig({ distanceMeters: 100 });
    const path = racePath({ lengths: 4 });
    const arrival = path.turns[0].arrivalMs; // ~21172

    test("a short pose dropout around the apex still yields the turn, timed within the dropout-widened bound", () => {
        const result = runRace({ config, samples: sampleRace(path, { dropouts: [[arrival - 300, arrival + 100]] }) });
        assert.equal(result.turns.length, 3);
        assert.ok(Math.abs(result.turns[0].atMs - arrival) <= 600);
    });

    test("a dropout longer than the maximum sample gap AT the apex yields NO turn at that wall (indeterminate, not guessed)", () => {
        const result = runRace({ config, samples: sampleRace(path, { dropouts: [[arrival - 700, arrival + 500]] }) });
        assert.ok(result.turns.every((turn) => Math.abs(turn.atMs - arrival) > 1500), "no turn was fabricated at the dropout wall");
        for (const event of result.events) assert.ok(Number.isFinite(event.atMs));
    });

    test("a long loss that tracking cannot recover (ANALYSIS_DEGRADED) yields no turn and leaves the session consistent", () => {
        const result = runRace({ config, samples: sampleRace(path, { dropouts: [[arrival - 1500, arrival + 1400]] }) });
        assert.equal(result.turns.length, 0);
        assert.equal(result.confirmedDistanceMeters, 0);
        assert.equal(result.status, "running");
        assert.equal(result.finish, null);
    });

    test("LIMITATION (documented, UNRESOLVED): a MISSED turn is not detected as missed, so the next wall contact is labelled one pool length too early", () => {
        // The dropout hides the first wall contact (25 m). The next wall contact — physically 50 m — is then
        // accepted as the FIRST turn and labelled 25 m, the one after it 50 m. The pipeline cannot know a turn
        // was missed: the label is a count. See docs/RACE_PIPELINE_ARCHITECTURE.md §9.1.
        const result = runRace({ config, samples: sampleRace(path, { dropouts: [[arrival - 700, arrival + 500]] }) });
        assert.deepEqual(
            result.turns.map((turn) => turn.distanceMeters),
            [25, 50],
            "labels are one pool length too early (physical walls are 50 m and 75 m)"
        );
        assert.ok(Math.abs(result.turns[0].atMs - path.turns[1].arrivalMs) < 600, "the first accepted turn is the SECOND physical wall contact");
    });

    test("a pose dropout mid-pool (target lost and reacquired) does not disturb later turns", () => {
        for (const [from, to] of [[10000, 11000], [10000, 12500], [10000, 14000]]) {
            const result = runRace({ config, samples: sampleRace(path, { dropouts: [[from, to]] }) });
            expectTurns(result, path, 3);
        }
    });
});

describe("multiple swimmers and target reacquisition", () => {
    const config = raceConfig({ distanceMeters: 100 });
    const path = racePath({ lengths: 4 });
    const clean = sampleRace(path);

    test("a second swimmer in another lane (different y), interleaved every other frame, is never attributed turns", () => {
        const samples = clean.map((s, i) => (s.atMs > 6000 && i % 2 === 0 ? poseSample(s.atMs, 0.05, { y: 0.9 }) : s));
        const result = runRace({ config, samples });
        expectTurns(result, path, 3);
    });

    test("a second swimmer repeatedly appearing in the wall zone of the target's lane never creates or moves a turn", () => {
        const arrival = path.turns[0].arrivalMs;
        const samples = clean.map((s, i) => (s.atMs > arrival - 4000 && s.atMs < arrival + 5000 && i % 3 === 0 ? poseSample(s.atMs, 0.9) : s));
        const result = runRace({ config, samples });
        // Whatever tracking decides (it degrades after sustained ambiguity), no turn may be attributed to the intruder.
        const intruderTimes = new Set(samples.filter((s, i) => clean[i] !== s).map((s) => s.atMs));
        for (const turn of result.turns) {
            assert.ok(!intruderTimes.has(turn.atMs), `turn at ${turn.atMs} falls on an intruder frame`);
        }
        assert.equal(result.confirmedDistanceMeters, result.turns.length === 0 ? 0 : result.turns[result.turns.length - 1].distanceMeters);
    });

    test("an intruder that appears only AFTER the target is lost cannot be 'reacquired' into a turn: a far-off pose is ambiguous, not the target", () => {
        const arrival = path.turns[0].arrivalMs;
        const samples = clean.map((s) => {
            if (s.atMs >= arrival - 1500 && s.atMs < arrival + 1500) return noPoseSample(s.atMs);
            if (s.atMs >= arrival + 1500 && s.atMs < arrival + 4000) return poseSample(s.atMs, 0.2, { y: 0.52 });
            return s;
        });
        const result = runRace({ config, samples });
        assert.equal(result.turns.length, 0);
        assert.equal(result.confirmedDistanceMeters, 0);
    });
});

// ===========================================================================
// 9. SEEDED FUZZ: INVARIANTS HOLD FOR EVERY RANDOM SYNTHETIC RACE
// ===========================================================================

describe("seeded fuzz over random synthetic races (invariants)", () => {
    test("60 random races, with dropouts, duplicates, swaps and intruders: every Chronos/race-distance invariant holds; clean runs are complete", () => {
        let completeRuns = 0;
        let noisyRuns = 0;
        let acceptedTotal = 0;
        for (let seed = 1; seed <= 60; seed += 1) {
            const random = seededRandom(seed * 104729);
            const poolLengthMeters = random() < 0.5 ? 25 : 50;
            const raceLengths = 1 + Math.floor(random() * 6); // 1..6 lengths
            const extraLengths = random() < 0.4 ? 1 + Math.floor(random() * 2) : 0; // the video may run past the race
            const distanceMeters = raceLengths * poolLengthMeters;
            const speed = 0.06 + random() * 0.06;
            const dt = [120, 150, 200][Math.floor(random() * 3)];
            const jitter = random() < 0.5 ? 0 : 0.003;
            const noisy = random() < 0.6;

            const path = racePath({ lengths: raceLengths + extraLengths, speed, poolLengthMeters });
            const dropouts = [];
            if (noisy) {
                for (let k = 0, n = Math.floor(random() * 3); k < n; k += 1) {
                    const from = 9000 + random() * (path.endMs - 12000);
                    dropouts.push([from, from + 120 + random() * 500]);
                }
            }
            let samples = sampleRace(path, { dt, jitter, seed, dropouts });
            if (noisy) {
                const mutated = [];
                for (const s of samples) {
                    mutated.push(s);
                    if (random() < 0.03) mutated.push(s); // duplicate
                }
                for (let i = 50; i < mutated.length - 1; i += 53) {
                    if (random() < 0.5) {
                        const tmp = mutated[i];
                        mutated[i] = mutated[i + 1];
                        mutated[i + 1] = tmp;
                    }
                }
                samples = mutated.map((s) => (s.hasPose && random() < 0.01 ? poseSample(s.atMs, 0.5, { y: 0.9 }) : s));
            }

            const result = runRace({ config: raceConfig({ distanceMeters, poolLengthMeters }), samples });
            const label = `seed ${seed} (pool ${poolLengthMeters}, race ${distanceMeters} m, +${extraLengths} lengths, speed ${speed.toFixed(3)}, dt ${dt}, noisy ${noisy})`;
            acceptedTotal += result.turns.length;

            // --- invariants, for EVERY run ---
            assert.ok(result.turns.length <= raceLengths - 1, `${label}: at most (race lengths - 1) turns`);
            let previous = result.start;
            result.turns.forEach((turn, index) => {
                assert.equal(turn.distanceMeters, (index + 1) * poolLengthMeters, `${label}: distances are consecutive pool-length multiples`);
                assert.ok(turn.distanceMeters < distanceMeters, `${label}: strictly below the race distance`);
                assert.ok(Number.isFinite(turn.atMs) && turn.atMs > result.start.atMs, `${label}: after the start`);
                assert.ok(turn.atMs - previous.atMs >= (previous.type === "turn" ? MIN_EVENT_GAP_MS : 0), `${label}: minimum gap`);
                previous = turn;
            });
            assert.equal(result.confirmedDistanceMeters, result.turns.length === 0 ? 0 : result.turns[result.turns.length - 1].distanceMeters, `${label}: counter equals the last accepted turn`);
            assert.equal(result.finish, null, `${label}: no finish is ever fabricated`);
            assert.equal(result.report.finalTimeMs, null, `${label}: no final time`);
            assert.equal(result.status, "running", `${label}: end of video does not end the race`);

            // report splits agree with the accepted events
            assert.equal(result.report.splits.length, result.turns.length, label);
            let cumulativeCheck = 0;
            result.report.splits.forEach((split, index) => {
                assert.equal(split.distanceMeters, result.turns[index].distanceMeters, label);
                assert.equal(split.cumulativeTimeMs, result.turns[index].atMs - result.start.atMs, label);
                cumulativeCheck += split.splitTimeMs;
                assert.equal(cumulativeCheck, split.cumulativeTimeMs, `${label}: split durations sum to cumulative time`);
                assert.ok(split.splitTimeMs > 0, label);
            });

            // --- completeness, only for clean (no dropouts/dupes/intruders) runs ---
            if (!noisy) {
                completeRuns += 1;
                assert.equal(result.turns.length, raceLengths - 1, `${label}: clean run finds every turn`);
                result.turns.forEach((turn, index) => {
                    assert.ok(apexWithinBound(turn.atMs, path.turns[index].arrivalMs, { speed, dt, dwellMs: 400 }), `${label}: turn ${index + 1} ${turn.atMs} vs ${path.turns[index].arrivalMs}`);
                });
            } else {
                noisyRuns += 1;
            }
        }
        assert.ok(completeRuns >= 15, `fuzz covered clean runs (${completeRuns})`);
        assert.ok(noisyRuns >= 15, `fuzz covered noisy runs (${noisyRuns})`);
        assert.ok(acceptedTotal > 40, `fuzz accepted real turns (${acceptedTotal})`);
    });
});
