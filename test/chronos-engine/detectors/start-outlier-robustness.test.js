// Detector-level tests for the outlier-robust onset logic in
// chronosAssessStart() (Chronos reliability phase 1B).
//
// Every fixture is a hand-built or seeded-random synthetic nose-position
// series — never real video, never real MediaPipe output. These tests pin
// down the documented behavior of the despike + envelope + contiguous-
// suffix logic; they do not establish accuracy on real footage.
//
// Defaults relied on: displacementThreshold 0.08, minBaselineSamples 5,
// confirmationSamples 3, noise band 0.02 (= 0.25 * 0.08), window 4000 ms.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosAssessStart } from "../../../src/chronos-engine/detectors/start-detector.js";

const STEP = 120;
const REST = 0.2;

function nose(atMs, x, visibility = 0.9) {
    return { atMs, nose: { x, y: 0.5, visibility } };
}

function replay(series, config) {
    return series.map((sample, i) => chronosAssessStart({ sample, baselineWindow: series.slice(0, i), config }));
}

// 12 samples at rest, then a constant-speed departure of `perSample` per sample.
// `overrides` maps a sample index to an x value (to inject outliers).
function departureSeries({ perSample = 0.007, restCount = 12, departCount = 24, overrides = new Map() } = {}) {
    const series = [];
    for (let i = 0; i < restCount + departCount; i += 1) {
        const x = i < restCount ? REST : REST + perSample * (i - restCount + 1);
        series.push(nose(i * STEP, overrides.has(i) ? overrides.get(i) : x));
    }
    return series;
}

function firstConfirmed(results) {
    const i = results.findIndex((r) => r.state === "confirmed");
    return i < 0 ? null : { index: i, result: results[i] };
}

// With perSample 0.007 the first sample beyond the 0.02 envelope is departure
// sample #3 (0.021): index restCount + 2 = 14.
const CLEAN_ONSET_INDEX = 14;

describe("outlier robustness — isolated single-sample outliers", () => {
    const clean = firstConfirmed(replay(departureSeries()));

    test("fixture sanity: a clean departure confirms with the onset at the first sample past the envelope", () => {
        assert.notEqual(clean, null);
        assert.equal(clean.result.candidate.atMs, CLEAN_ONSET_INDEX * STEP);
    });

    for (const [label, delta] of [["same-side", +0.03], ["opposite-side", -0.03]]) {
        for (const spikeIndex of [4 + 7, 12 - 1, 12 - 2]) {
            test(`a ${label} spike at sample ${spikeIndex} (before the departure) leaves the confirmed onset unchanged`, () => {
                const overrides = new Map([[spikeIndex, REST + delta]]);
                const confirmed = firstConfirmed(replay(departureSeries({ overrides })));

                assert.notEqual(confirmed, null, "a single outlier must not suppress the start");
                assert.equal(confirmed.result.candidate.atMs, CLEAN_ONSET_INDEX * STEP);
                assert.ok(confirmed.result.candidate.atMs >= 12 * STEP, "the onset must not precede the true departure");
            });
        }
    }

    test("an isolated dropout back to rest INSIDE the departure leaves the onset unchanged", () => {
        const overrides = new Map([[12 + 7, REST]]);
        const confirmed = firstConfirmed(replay(departureSeries({ overrides })));

        assert.notEqual(confirmed, null);
        assert.equal(confirmed.result.candidate.atMs, CLEAN_ONSET_INDEX * STEP);
    });

    test("an isolated overshoot INSIDE the departure leaves the onset unchanged", () => {
        const overrides = new Map([[12 + 7, REST + 0.5]]);
        const confirmed = firstConfirmed(replay(departureSeries({ overrides })));

        assert.notEqual(confirmed, null);
        assert.equal(confirmed.result.candidate.atMs, CLEAN_ONSET_INDEX * STEP);
    });

    test("regression: a short reference run that includes the first tiny steps of the departure still places the onset at the first sample past the envelope", () => {
        // Spike 3 samples before the departure leaves only a 5-sample run after
        // it, and that run includes two slightly-departed samples. Its MEAN is
        // therefore shifted; the onset must be judged against the run's envelope,
        // not against that shifted mean.
        const overrides = new Map([[12 - 3, REST + 0.03]]);
        const confirmed = firstConfirmed(replay(departureSeries({ overrides })));

        assert.notEqual(confirmed, null);
        assert.equal(confirmed.result.candidate.atMs, CLEAN_ONSET_INDEX * STEP);
    });
});

describe("outlier robustness — conservative rules that remain", () => {
    test("opposite-side samples IMMEDIATELY before the departure (no rest-consistent sample between) are still direction-reversal, never a start", () => {
        const series = [];
        for (let i = 0; i < 10; i += 1) series.push(nose(i * STEP, REST));
        series.push(nose(10 * STEP, REST + 0.1), nose(11 * STEP, REST + 0.1));
        series.push(nose(12 * STEP, REST - 0.1), nose(13 * STEP, REST - 0.1), nose(14 * STEP, REST - 0.1), nose(15 * STEP, REST - 0.1));
        const results = replay(series);

        assert.ok(results.some((r) => r.reason === "direction-reversal"));
        assert.equal(firstConfirmed(results), null);
    });

    test("LIMITATION: a same-side outlier directly ADJACENT to a fast departure is indistinguishable from the departure and pulls the onset earlier", () => {
        // 0.025 per sample: the first departing sample is already beyond the
        // 0.02 envelope, so NO rest-consistent sample separates a preceding
        // outlier from the departure. An adjacent outlier (here +0.03, next to
        // a first departing sample of +0.025) is consistent with being part of
        // the departure, and a median of three cannot tell them apart. The
        // onset estimate is then earlier than the true departure by the number
        // of adjacent outlier samples. Documented in
        // docs/RACE_PIPELINE_ARCHITECTURE.md §7.2.
        const fast = { perSample: 0.025 };
        const cleanOnsetIndex = 12; // first departing sample (0.025) is beyond the envelope immediately
        const clean = firstConfirmed(replay(departureSeries(fast)));
        assert.equal(clean.result.candidate.atMs, cleanOnsetIndex * STEP);

        const single = firstConfirmed(replay(departureSeries({ ...fast, overrides: new Map([[11, REST + 0.03]]) })));
        const burst = firstConfirmed(replay(departureSeries({ ...fast, overrides: new Map([[10, REST + 0.03], [11, REST + 0.03]]) })));

        assert.equal(single.result.candidate.atMs, 11 * STEP, "one adjacent outlier: one sample interval early");
        assert.equal(burst.result.candidate.atMs, 10 * STEP, "two adjacent outliers: two sample intervals early");
        assert.ok(burst.result.candidate.atMs >= 10 * STEP, "never earlier than the first outlier");
    });

    test("documented bounds of the dropout tolerance (docs §7.2): a single dropout delays the onset by 1 or 2 samples at departing samples #3 / #4 and not at all from #5; two CONSECUTIVE dropouts move the onset to after them", () => {
        const onsetIndexWithDropouts = (indices) => {
            const overrides = new Map(indices.map((i) => [i, REST]));
            const confirmed = firstConfirmed(replay(departureSeries({ overrides })));
            return confirmed === null ? null : confirmed.result.candidate.atMs / STEP;
        };
        const departingIndex = (k) => 12 + k - 1; // k = 1 is the first departing sample

        assert.equal(onsetIndexWithDropouts([]), CLEAN_ONSET_INDEX);
        assert.equal(onsetIndexWithDropouts([departingIndex(3)]), CLEAN_ONSET_INDEX + 1);
        assert.equal(onsetIndexWithDropouts([departingIndex(4)]), CLEAN_ONSET_INDEX + 2);
        for (const k of [5, 8, 15]) {
            assert.equal(onsetIndexWithDropouts([departingIndex(k)]), CLEAN_ONSET_INDEX, `a single dropout at departing sample #${k}`);
        }

        // Two consecutive dropouts are not bridged: the onset becomes the first
        // beyond-envelope sample AFTER them.
        assert.equal(onsetIndexWithDropouts([departingIndex(6), departingIndex(7)]), CLEAN_ONSET_INDEX + 5);
        assert.equal(onsetIndexWithDropouts([departingIndex(10), departingIndex(11)]), CLEAN_ONSET_INDEX + 9);
    });

    test("the same outliers are removed when even ONE rest-consistent sample separates them from the departure (slower departure)", () => {
        // 0.012 per sample: the first departing sample (0.012) is inside the
        // envelope, so it separates a preceding outlier from the departure.
        const slow = { perSample: 0.012 };
        const clean = firstConfirmed(replay(departureSeries(slow)));
        const withOutlier = firstConfirmed(replay(departureSeries({ ...slow, overrides: new Map([[11, REST + 0.03]]) })));

        assert.equal(withOutlier.result.candidate.atMs, clean.result.candidate.atMs);
    });
});

describe("outlier robustness — evidence and states", () => {
    test("departureSampleCount is the length of the contiguous departure, not everything after the reference run", () => {
        const overrides = new Map([[12 - 1, REST + 0.03]]);
        const series = departureSeries({ overrides });
        const results = replay(series);
        const confirmed = firstConfirmed(results);

        assert.equal(confirmed.result.candidate.evidence.departureSampleCount, confirmed.index - CLEAN_ONSET_INDEX + 1);
    });

    test("returning inside the reference envelope after an excursion reports none/stationary (the excursion is forgotten)", () => {
        const series = [];
        for (let i = 0; i < 10; i += 1) series.push(nose(i * STEP, REST));
        series.push(nose(10 * STEP, REST + 0.15), nose(11 * STEP, REST));
        const results = replay(series);

        assert.equal(results[10].state, "plausible");
        assert.equal(results[11].state, "none");
        assert.equal(results[11].reason, "stationary");
    });
});

// ---------------------------------------------------------------------------
// Seeded property tests: deterministic pseudo-random series, asserting
// invariants that must hold for ANY input — not a comparison against a
// second implementation.
// ---------------------------------------------------------------------------
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

function randomCase(rnd) {
    const n = 8 + Math.floor(rnd() * 28);
    const history = [];
    let t = Math.floor(rnd() * 3000);
    let x = 0.1 + rnd() * 0.5;
    const jitter = [0, 0.002, 0.006, 0.012][Math.floor(rnd() * 4)];
    const speed = [0, 0, 0.01, 0.03, 0.06, 0.1][Math.floor(rnd() * 6)] * (rnd() < 0.5 ? 1 : -1);
    const departAt = Math.floor(rnd() * n);
    const spikes = rnd() < 0.4;
    for (let i = 0; i < n; i += 1) {
        t += [60, 100, 120, 120, 120, 150, 200, 400][Math.floor(rnd() * 8)];
        if (i >= departAt) x += speed * 0.12;
        let value = x + (rnd() * 2 - 1) * jitter;
        if (spikes && rnd() < 0.1) value += (rnd() < 0.5 ? 1 : -1) * 0.03;
        const visibility = rnd() < 0.1 ? 0.3 : 0.9;
        history.push(nose(t, value, visibility));
    }
    const current = nose(t + [60, 120, 120, 200][Math.floor(rnd() * 4)], x + (rnd() * 2 - 1) * jitter);
    return { history, current };
}

describe("chronosAssessStart() — seeded property tests (2,500 random series)", () => {
    const rnd = rng(20261013);
    const cases = Array.from({ length: 2500 }, () => randomCase(rnd));

    test("a candidate exists if and only if the state is confirmed", () => {
        for (const { history, current } of cases) {
            const r = chronosAssessStart({ sample: current, baselineWindow: history });
            assert.equal(r.candidate !== null, r.state === "confirmed");
        }
    });

    test("a confirmed onset lies between the earliest windowed sample and the confirming sample, after at least 5 earlier samples, and is never negative", () => {
        for (const { history, current } of cases) {
            const r = chronosAssessStart({ sample: current, baselineWindow: history });
            if (r.state !== "confirmed") continue;
            const usable = history.filter((h) => h.nose.visibility >= 0.5 && h.atMs >= current.atMs - 4000);
            const earliest = Math.min(...usable.map((h) => h.atMs));
            const onset = r.candidate.atMs;
            assert.ok(Number.isFinite(onset) && onset >= 0);
            assert.ok(onset >= earliest && onset <= current.atMs);
            assert.equal(r.candidate.evidence.onsetAtMs, onset);
            assert.equal(r.candidate.evidence.confirmedAtMs, current.atMs);
            assert.ok(onset <= r.candidate.evidence.confirmedAtMs);
            assert.ok(usable.filter((h) => h.atMs < onset).length >= 5, "at least minBaselineSamples samples precede the onset");
            assert.ok(r.candidate.confidence >= 0 && r.candidate.confidence <= 1);
        }
    });

    test("a confirmed start always has its confirming samples beyond the threshold, on ONE side, as observed", () => {
        for (const { history, current } of cases) {
            const r = chronosAssessStart({ sample: current, baselineWindow: history });
            if (r.state !== "confirmed") continue;
            const baseline = r.candidate.evidence.baselinePositionX;
            const series = [...history.filter((h) => h.nose.visibility >= 0.5 && h.atMs >= current.atMs - 4000), current].sort((a, b) => a.atMs - b.atMs);
            const tail = series.slice(-3);
            const signs = new Set(tail.map((s) => Math.sign(s.nose.x - baseline)));
            assert.equal(signs.size, 1);
            for (const s of tail) assert.ok(Math.abs(s.nose.x - baseline) >= 0.08);
        }
    });

    test("results are deterministic and independent of the order the history is supplied in", () => {
        for (const { history, current } of cases.slice(0, 800)) {
            const a = chronosAssessStart({ sample: current, baselineWindow: history });
            const b = chronosAssessStart({ sample: current, baselineWindow: history });
            const reversed = chronosAssessStart({ sample: current, baselineWindow: [...history].reverse() });
            assert.deepEqual(a, b);
            assert.deepEqual(reversed, a);
        }
    });

    test("a sample not strictly later than the newest history entry is rejected as non-monotonic", () => {
        for (const { history } of cases.slice(0, 400)) {
            const newest = Math.max(...history.filter((h) => h.nose.visibility >= 0.5).map((h) => h.atMs), -Infinity);
            if (!Number.isFinite(newest)) continue;
            const r = chronosAssessStart({ sample: nose(newest, 0.5), baselineWindow: history });
            assert.equal(r.state, "rejected");
            assert.equal(r.reason, "non-monotonic-timestamp");
        }
    });
});
