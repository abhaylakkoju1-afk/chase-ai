// Unit tests for chronosAssessStart() in
// src/chronos-engine/detectors/start-detector.js (Chronos reliability
// phase 1).
//
// Every fixture is a hand-built, synthetic nose-position series — never real
// video, never real MediaPipe output. These tests establish that the
// assessment is deterministic and that each documented state/reason is
// reachable for the documented cause. They do NOT establish accuracy on real
// swimming footage: every default here is provisional and unvalidated (see
// the header of start-detector.js and docs/RACE_PIPELINE_ARCHITECTURE.md
// §7.2).
//
// Defaults relied on (START_ASSESSMENT_DEFAULTS + DEFAULT_CONFIG):
//   displacementThreshold 0.08, minBaselineSamples 5, confirmationSamples 3,
//   baselineNoiseBandFraction 0.25  => noise band 0.02,
//   maxConfirmationSpanMs 1000, baselineWindowMs 4000.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    chronosAssessStart,
    chronosDetectStart,
    START_ASSESSMENT_DEFAULTS
} from "../../../src/chronos-engine/detectors/start-detector.js";

const STEP = 120;

function nose(atMs, x, visibility = 0.9) {
    return { atMs, nose: { x, y: 0.5, visibility } };
}

// Replays a series through chronosAssessStart() the same way the adapter
// does (current sample assessed against everything strictly before it), and
// returns one result per sample.
function replay(series, config) {
    const results = [];
    for (let i = 0; i < series.length; i += 1) {
        results.push(chronosAssessStart({ sample: series[i], baselineWindow: series.slice(0, i), config }));
    }
    return results;
}

// 8 stationary samples at rest, then a departure of `step` per sample.
function restThenDepart({ rest = 0.2, restCount = 8, step = 0.03, departCount = 8 } = {}) {
    const series = [];
    for (let i = 0; i < restCount; i += 1) series.push(nose(i * STEP, rest));
    for (let j = 1; j <= departCount; j += 1) series.push(nose((restCount - 1 + j) * STEP, rest + step * j));
    return series;
}

describe("chronosAssessStart() — state progression on a sustained departure", () => {
    test("none -> none -> plausible -> plausible -> confirmed, with the candidate at the ONSET and the confirmation time exposed", () => {
        // rest 0.2; departs +0.03 per sample: dev .03 .06 .09 .12 .15 ...
        const series = restThenDepart({ step: 0.03, departCount: 6 });
        const results = replay(series);

        const afterRest = results.slice(0, 8).map((r) => r.state);
        assert.deepEqual(afterRest.slice(5), ["none", "none", "none"], "stationary samples report none once a baseline exists");

        // sample index 8 (dev 0.03 > band 0.02, < threshold 0.08): departure begun but below threshold
        assert.equal(results[8].state, "none");
        assert.equal(results[8].reason, "below-threshold");
        // index 9: dev 0.06, still below threshold
        assert.equal(results[9].state, "none");
        // index 10: dev 0.09 >= 0.08 -> plausible (1 of 3)
        assert.equal(results[10].state, "plausible");
        assert.equal(results[10].reason, "awaiting-confirmation");
        // index 11: dev 0.12 -> plausible (2 of 3)
        assert.equal(results[11].state, "plausible");
        // index 12: dev 0.15 -> third consecutive sample past threshold: confirmed
        assert.equal(results[12].state, "confirmed");
        assert.equal(results[12].reason, "sustained-departure");

        const candidate = results[12].candidate;
        assert.equal(candidate.atMs, series[8].atMs, "candidate time is the first departing sample (onset), not the confirmation sample");
        assert.equal(candidate.evidence.onsetAtMs, series[8].atMs);
        assert.equal(candidate.evidence.confirmedAtMs, series[12].atMs);
        assert.ok(candidate.evidence.onsetAtMs < candidate.evidence.confirmedAtMs);
        assert.equal(candidate.evidence.confirmationSamples, 3);
        assert.ok(candidate.confidence >= 0 && candidate.confidence <= 1);

        // No candidate exists before the confirming sample...
        assert.ok(results.slice(0, 12).every((r) => r.candidate === null));
        // ...and while the departure continues, every later confirming sample
        // reports the SAME onset: the onset estimate does not drift forward as
        // more of the departure is observed. (The controller stops calling the
        // detector once Chronos accepts the first one.)
        for (const later of results.slice(12)) {
            assert.equal(later.state, "confirmed");
            assert.equal(later.candidate.atMs, series[8].atMs);
        }
    });

    test("the displacement/confidence evidence is the chronosDetectStart() primitive's, not a reimplementation", () => {
        const series = restThenDepart({ step: 0.03, departCount: 6 });
        const confirming = chronosAssessStart({ sample: series[12], baselineWindow: series.slice(0, 12) });
        const primitive = chronosDetectStart({ sample: series[12], baselineWindow: series.slice(0, 8) });

        assert.equal(confirming.candidate.evidence.displacement, primitive.evidence.displacement);
        assert.equal(confirming.candidate.evidence.baselinePositionX, primitive.evidence.baselinePositionX);
        assert.equal(confirming.candidate.evidence.baselineStability, primitive.evidence.baselineStability);
    });

    test("the candidate confidence is the LEAST confident of the confirming samples", () => {
        const series = restThenDepart({ step: 0.03, departCount: 6 });
        const confirming = chronosAssessStart({ sample: series[12], baselineWindow: series.slice(0, 12) });
        const baseline = series.slice(0, 8);
        const each = [10, 11, 12].map((i) => chronosDetectStart({ sample: series[i], baselineWindow: baseline }).confidence);

        assert.equal(confirming.candidate.confidence, Math.min(...each));
    });

    test("a stationary swimmer never leaves state none and never produces a candidate", () => {
        const series = Array.from({ length: 40 }, (_, i) => nose(i * STEP, 0.4 + 0.003 * Math.sin(i)));
        const results = replay(series);

        assert.ok(results.every((r) => r.candidate === null));
        assert.ok(results.slice(5).every((r) => r.state === "none"), "after the baseline forms, stationary is state none");
    });
});

describe("chronosAssessStart() — rejected (hard gates)", () => {
    const base = Array.from({ length: 8 }, (_, i) => nose(i * STEP, 0.3));

    test("a missing, non-finite, or noseless sample is rejected as invalid-sample", () => {
        for (const sample of [null, undefined, { atMs: NaN, nose: { x: 0.3, y: 0.5, visibility: 0.9 } }, { atMs: 5000 }, { atMs: 5000, nose: { x: Infinity, y: 0.5, visibility: 0.9 } }]) {
            const result = chronosAssessStart({ sample, baselineWindow: base });
            assert.equal(result.state, "rejected");
            assert.equal(result.reason, "invalid-sample");
            assert.equal(result.candidate, null);
        }
    });

    test("a low-visibility current sample is rejected, however far it has moved", () => {
        const result = chronosAssessStart({ sample: nose(2000, 0.9, 0.2), baselineWindow: base });
        assert.equal(result.state, "rejected");
        assert.equal(result.reason, "low-visibility-sample");
    });

    test("a duplicate timestamp is rejected as non-monotonic and cannot alter the decision", () => {
        const result = chronosAssessStart({ sample: nose(base[7].atMs, 0.9), baselineWindow: base });
        assert.equal(result.state, "rejected");
        assert.equal(result.reason, "non-monotonic-timestamp");
        assert.equal(result.candidate, null);
    });

    test("an out-of-order (earlier) timestamp is rejected as non-monotonic", () => {
        const result = chronosAssessStart({ sample: nose(base[3].atMs, 0.9), baselineWindow: base });
        assert.equal(result.state, "rejected");
        assert.equal(result.reason, "non-monotonic-timestamp");
    });

    test("S2: a swimmer already moving has no stationary reference, so no start can be established", () => {
        const moving = Array.from({ length: 30 }, (_, i) => nose(i * STEP, 0.1 + 0.01 * i)); // 0.01 per sample, never stationary
        const results = replay(moving);
        const last = results[results.length - 1];

        assert.equal(last.state, "rejected");
        assert.equal(last.reason, "no-stationary-baseline");
        assert.ok(results.every((r) => r.candidate === null));
    });

    test("fewer than minBaselineSamples stationary samples is no baseline", () => {
        const four = Array.from({ length: 4 }, (_, i) => nose(i * STEP, 0.3));
        const result = chronosAssessStart({ sample: nose(4 * STEP, 0.9), baselineWindow: four });
        assert.equal(result.state, "rejected");
        assert.equal(result.reason, "no-stationary-baseline");
    });

    test("low-visibility and malformed history entries are excluded, never counted as baseline", () => {
        const polluted = [
            ...base,
            { atMs: 8 * STEP, nose: { x: 0.9, y: 0.5, visibility: 0.1 } },
            { atMs: 9 * STEP },
            null
        ];
        const result = chronosAssessStart({ sample: nose(10 * STEP, 0.3), baselineWindow: polluted });
        assert.equal(result.state, "none");
        assert.equal(result.evidence.baselineSampleCount, 9, "8 good history samples + the current stationary one");
    });
});

describe("chronosAssessStart() — ambiguous", () => {
    function withDeparture(offsets) {
        const series = Array.from({ length: 8 }, (_, i) => nose(i * STEP, 0.4));
        offsets.forEach((dx, j) => series.push(nose((8 + j) * STEP, 0.4 + dx)));
        return series;
    }

    test("a departure that reverses direction is ambiguous (direction-reversal), never confirmed", () => {
        const results = replay(withDeparture([0.1, 0.1, -0.1, -0.1, -0.1]));
        const reversed = results.find((r) => r.reason === "direction-reversal");

        assert.notEqual(reversed, undefined);
        assert.equal(reversed.state, "ambiguous");
        assert.ok(results.every((r) => r.candidate === null));
    });

    test("a departure that crosses the threshold and then falls back below it is ambiguous (departure-not-sustained)", () => {
        const results = replay(withDeparture([0.1, 0.1, 0.05]));
        const last = results[results.length - 1];

        assert.equal(last.state, "ambiguous");
        assert.equal(last.reason, "departure-not-sustained");
        assert.equal(last.candidate, null);
    });

    test("confirming samples too far apart in time are ambiguous (confirmation-span-exceeded), not confirmed", () => {
        const series = Array.from({ length: 8 }, (_, i) => nose(i * STEP, 0.4));
        series.push(nose(2000, 0.5), nose(3000, 0.5), nose(4000, 0.5)); // 3 samples past threshold, 2 s apart overall
        const last = replay(series)[series.length - 1];

        assert.equal(last.state, "ambiguous");
        assert.equal(last.reason, "confirmation-span-exceeded");
        assert.equal(last.candidate, null);
    });

    test("the same departure with samples inside maxConfirmationSpanMs IS confirmed (the span is the only difference)", () => {
        const series = Array.from({ length: 8 }, (_, i) => nose(i * STEP, 0.4));
        series.push(nose(1100, 0.5), nose(1500, 0.5), nose(1900, 0.5));
        const last = replay(series)[series.length - 1];

        assert.equal(last.state, "confirmed");
        assert.equal(last.candidate.atMs, 1100);
    });

    test("a single-sample excursion is only plausible, and is forgotten once the swimmer settles again", () => {
        const series = [
            ...Array.from({ length: 8 }, (_, i) => nose(i * STEP, 0.4)),
            nose(8 * STEP, 0.55),
            ...Array.from({ length: 8 }, (_, i) => nose((9 + i) * STEP, 0.4))
        ];
        const results = replay(series);

        assert.equal(results[8].state, "plausible");
        assert.ok(results.every((r) => r.candidate === null));
        assert.equal(results[results.length - 1].state, "none");
    });
});

describe("chronosAssessStart() — rolling window, irregular sampling, and reference selection", () => {
    test("S3: samples older than baselineWindowMs are ignored, so a slow drift never accumulates into a start", () => {
        // 0.003 frame-widths per second for 150 s (1250 samples).
        const series = Array.from({ length: 1250 }, (_, i) => nose(i * STEP, 0.2 + (0.003 * i * STEP) / 1000));
        const results = replay(series);

        assert.ok(results.every((r) => r.candidate === null));
        assert.ok(results.slice(5).every((r) => r.state === "none"));
    });

    test("history outside the window cannot influence the decision (same result with or without it)", () => {
        const recent = restThenDepart({ step: 0.03, departCount: 6 }).map((s) => ({ ...s, atMs: s.atMs + 100000 }));
        const ancient = Array.from({ length: 50 }, (_, i) => nose(i * STEP, 0.9)); // far away, far older than the window
        const lastIndex = recent.length - 1;

        const withAncient = chronosAssessStart({ sample: recent[lastIndex], baselineWindow: [...ancient, ...recent.slice(0, lastIndex)] });
        const without = chronosAssessStart({ sample: recent[lastIndex], baselineWindow: recent.slice(0, lastIndex) });

        assert.deepEqual(withAncient, without);
    });

    test("the reference is the swimmer's MOST RECENT resting position: pacing, then standing still, then leaving is a start", () => {
        const pacing = Array.from({ length: 10 }, (_, i) => nose(i * STEP, 0.1 + 0.04 * i)); // walking onto the blocks
        const standing = Array.from({ length: 8 }, (_, i) => nose((10 + i) * STEP, 0.5));
        const leaving = [0.53, 0.62, 0.71, 0.8].map((x, j) => nose((18 + j) * STEP, x));
        const results = replay([...pacing, ...standing, ...leaving]);
        const confirmed = results.filter((r) => r.state === "confirmed");

        assert.ok(confirmed.length >= 1);
        assert.equal(confirmed[0].candidate.atMs, 18 * STEP, "onset is the first departure sample after the final resting position");
    });

    test("irregular frame intervals: the onset is still the first departing sample and the confirmation span is measured in ms", () => {
        const steps = [100, 140, 120, 90, 150, 110, 130, 120, 100, 140, 120, 90, 150];
        const series = [];
        let t = 0;
        for (let i = 0; i < 8; i += 1) { series.push(nose(t, 0.3)); t += steps[i]; }
        for (let j = 0; j < 5; j += 1) { series.push(nose(t, 0.3 + 0.05 * (j + 1))); t += steps[8 + j]; }
        const results = replay(series);
        const confirmed = results.find((r) => r.state === "confirmed");

        assert.notEqual(confirmed, undefined);
        assert.equal(confirmed.candidate.atMs, series[8].atMs);
        assert.ok(confirmed.candidate.evidence.confirmationSpanMs <= START_ASSESSMENT_DEFAULTS.maxConfirmationSpanMs);
    });

    test("unsorted caller history is handled deterministically (same result as sorted history)", () => {
        const series = restThenDepart({ step: 0.03, departCount: 6 });
        const history = series.slice(0, 12);
        const shuffled = [history[5], history[0], history[11], history[3], history[8], history[1], history[10], history[2], history[7], history[4], history[9], history[6]];

        assert.deepEqual(
            chronosAssessStart({ sample: series[12], baselineWindow: shuffled }),
            chronosAssessStart({ sample: series[12], baselineWindow: history })
        );
    });
});

describe("chronosAssessStart() — determinism, purity, and configuration", () => {
    test("identical inputs produce identical output, and neither inputs nor config are mutated", () => {
        const series = restThenDepart({ step: 0.03, departCount: 6 });
        const history = Object.freeze(series.slice(0, 12).map((s) => Object.freeze({ ...s, nose: Object.freeze({ ...s.nose }) })));
        const config = Object.freeze({ displacementThreshold: 0.08 });

        const first = chronosAssessStart({ sample: series[12], baselineWindow: history, config });
        const second = chronosAssessStart({ sample: series[12], baselineWindow: history, config });

        assert.deepEqual(first, second);
        assert.equal(history.length, 12);
    });

    test("never throws on malformed input", () => {
        for (const args of [undefined, {}, { sample: {} }, { sample: nose(1, 0.5), baselineWindow: "nope" }, { sample: nose(1, 0.5), baselineWindow: [undefined, 3, "x"] }]) {
            assert.doesNotThrow(() => chronosAssessStart(args));
        }
    });

    test("confirmationSamples: 1 restores single-sample confirmation (documents what the default replaced)", () => {
        const series = restThenDepart({ step: 0.03, departCount: 6 });
        const results = replay(series, { confirmationSamples: 1 });
        const first = results.findIndex((r) => r.state === "confirmed");

        assert.equal(first, 10, "with confirmationSamples 1 the first sample past threshold confirms immediately");
        assert.equal(results[first].candidate.atMs, series[8].atMs, "the onset time is unchanged by the confirmation count");
    });

    test("every confirmed candidate has onset <= confirmation, confidence in [0,1], and a finite atMs", () => {
        for (const step of [0.02, 0.03, 0.05, 0.1, 0.2]) {
            const series = restThenDepart({ step, departCount: 8 });
            for (const r of replay(series)) {
                if (r.candidate) {
                    assert.ok(Number.isFinite(r.candidate.atMs));
                    assert.ok(r.candidate.evidence.onsetAtMs <= r.candidate.evidence.confirmedAtMs);
                    assert.ok(r.candidate.confidence >= 0 && r.candidate.confidence <= 1);
                }
            }
        }
    });
});
