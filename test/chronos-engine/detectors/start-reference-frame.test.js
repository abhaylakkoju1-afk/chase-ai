// Detector-level tests for the pre-start reference frame in
// chronosAssessStart() (Chronos reliability phase 1C).
//
// Every fixture is a hand-built or seeded-random SYNTHETIC nose-position
// series — never real video, never real MediaPipe output. They pin the
// documented behavior of `config.referenceFrameMs`; they do not establish
// accuracy on real footage and assume the caller passes a genuine pre-start
// frame (which software cannot verify).
//
// Defaults: displacementThreshold 0.08, minBaselineSamples 5,
// confirmationSamples 3, noise band 0.02, window 4000 ms.

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

// `restCount` samples at rest, then a departure of `perSample` per sample.
function departure({ perSample = 0.007, restCount = 12, departCount = 24 } = {}) {
    const series = [];
    for (let i = 0; i < restCount + departCount; i += 1) {
        series.push(nose(i * STEP, i < restCount ? REST : REST + perSample * (i - restCount + 1)));
    }
    return series;
}

// First confirmed result, or null.
function firstConfirmed(results) {
    const index = results.findIndex((r) => r.state === "confirmed");
    return index < 0 ? null : { index, result: results[index] };
}

// With the default series the first sample beyond the 0.02 envelope is index 14 (0.021).
const ONSET_MS = 14 * STEP;

describe("referenceFrameMs — the departure must begin at or after it", () => {
    test("with no reference the search is unconstrained (the detector's standalone behavior)", () => {
        for (const config of [undefined, {}, { referenceFrameMs: undefined }, { referenceFrameMs: null }]) {
            const confirmed = firstConfirmed(replay(departure(), config));
            assert.notEqual(confirmed, null);
            assert.equal(confirmed.result.candidate.atMs, ONSET_MS);
            assert.equal(confirmed.result.candidate.evidence.referenceFrameMs, null);
        }
    });

    test("a reference BEFORE the onset leaves the result unchanged and is recorded in the evidence", () => {
        const confirmed = firstConfirmed(replay(departure(), { referenceFrameMs: 5 * STEP }));
        assert.equal(confirmed.result.candidate.atMs, ONSET_MS);
        assert.equal(confirmed.result.candidate.evidence.referenceFrameMs, 5 * STEP);
    });

    test("the boundary is inclusive: reference == onset is accepted, one millisecond later is not", () => {
        assert.notEqual(firstConfirmed(replay(departure(), { referenceFrameMs: ONSET_MS })), null);
        assert.equal(firstConfirmed(replay(departure(), { referenceFrameMs: ONSET_MS + 1 })), null);
    });

    test("a refused departure is reported as rejected / onset-before-reference-frame with BOTH timestamps, and no candidate", () => {
        const reference = ONSET_MS + 5 * STEP;
        const results = replay(departure(), { referenceFrameMs: reference });
        const refused = results.filter((r) => r.reason === "onset-before-reference-frame");

        assert.ok(refused.length > 0);
        for (const r of refused) {
            assert.equal(r.state, "rejected");
            assert.equal(r.candidate, null);
            assert.equal(r.evidence.onsetAtMs, ONSET_MS);
            assert.equal(r.evidence.referenceFrameMs, reference);
        }
        assert.ok(results.every((r) => r.candidate === null));
    });

    test("a departure that begins before the reference and CONTINUES past it is refused as a whole — it is not truncated to the reference", () => {
        // The reference sits in the middle of a long departure. A truncated
        // departure would start at the reference and be confirmed with an onset
        // the swimmer never had.
        const reference = 20 * STEP;
        const results = replay(departure({ departCount: 40 }), { referenceFrameMs: reference });

        assert.equal(firstConfirmed(results), null, "never confirmed, at any sample");
        // While the rest the departure began from is still in the 4 s window
        // (samples 20-29 here), each sample past the reference reports WHY it is refused;
        // later the rest ages out and the reason becomes no-stationary-baseline —
        // still no candidate.
        assert.ok(results.slice(20, 30).every((r) => r.reason === "onset-before-reference-frame"));
        assert.ok(results.every((r) => r.candidate === null));
    });

    test("stationary samples BEFORE the reference are a valid baseline (a frame marked right before the motion has none after it)", () => {
        // Reference only one sample before the onset: nothing stationary follows it.
        const confirmed = firstConfirmed(replay(departure(), { referenceFrameMs: ONSET_MS - STEP }));
        assert.notEqual(confirmed, null);
        assert.equal(confirmed.result.candidate.atMs, ONSET_MS);
    });

    test("a movement that ends before the reference, then rest, then a later departure: only the later onset is proposed", () => {
        const series = [];
        for (let i = 0; i < 10; i += 1) series.push(nose(i * STEP, REST));
        for (let i = 10; i < 20; i += 1) series.push(nose(i * STEP, REST + 0.05 * (i - 9))); // early walk to 0.7
        for (let i = 20; i < 34; i += 1) series.push(nose(i * STEP, REST + 0.5));             // rest at the new place
        for (let i = 34; i < 60; i += 1) series.push(nose(i * STEP, REST + 0.5 + 0.007 * (i - 33))); // the real departure
        const reference = 28 * STEP;
        const results = replay(series, { referenceFrameMs: reference });
        const confirmed = firstConfirmed(results);

        assert.ok(results.some((r) => r.reason === "onset-before-reference-frame"), "the early walk was seen and refused");
        assert.notEqual(confirmed, null);
        assert.equal(confirmed.result.candidate.atMs, 36 * STEP, "the later departure's first sample past the envelope");
        assert.ok(confirmed.result.candidate.atMs >= reference);
    });
});

describe("referenceFrameMs — an unusable reference is refused, never treated as 'no constraint'", () => {
    const series = departure();
    const last = series.length - 1;

    for (const bad of [NaN, Infinity, -Infinity, -1, -0.001, "2800", true, {}, []]) {
        test(`reference ${JSON.stringify(bad) ?? String(bad)} -> rejected / invalid-reference-frame, for every sample`, () => {
            const results = replay(series, { referenceFrameMs: bad });
            assert.ok(results.every((r) => r.state === "rejected" && r.reason === "invalid-reference-frame" && r.candidate === null));
            assert.equal(chronosAssessStart({ sample: series[last], baselineWindow: series.slice(0, last), config: { referenceFrameMs: bad } }).candidate, null);
        });
    }

    test("0 is a valid reference and excludes nothing", () => {
        assert.equal(firstConfirmed(replay(series, { referenceFrameMs: 0 })).result.candidate.atMs, ONSET_MS);
    });
});

describe("referenceFrameMs — interaction with the existing contract", () => {
    test("duplicate and out-of-order samples are still rejected as non-monotonic, with a reference supplied", () => {
        const series = departure();
        const r = chronosAssessStart({ sample: nose(series[10].atMs, 0.9), baselineWindow: series.slice(0, 20), config: { referenceFrameMs: 0 } });
        assert.equal(r.state, "rejected");
        assert.equal(r.reason, "non-monotonic-timestamp");
    });

    test("the reference never changes outlier handling: a spike before the onset is still ignored", () => {
        const series = departure();
        series[11] = nose(11 * STEP, REST + 0.03);
        const confirmed = firstConfirmed(replay(series, { referenceFrameMs: 0 }));
        assert.equal(confirmed.result.candidate.atMs, ONSET_MS);
    });

    test("config is not mutated and results are deterministic", () => {
        const config = Object.freeze({ referenceFrameMs: 5 * STEP });
        const series = departure();
        assert.deepEqual(replay(series, config), replay(series, config));
    });
});

// ---------------------------------------------------------------------------
// Seeded property: for ANY series and ANY reference, a confirmed candidate's
// onset is never earlier than the reference.
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

describe("referenceFrameMs — seeded property (1,500 random series)", () => {
    test("a confirmed onset is never earlier than the reference, and a candidate exists iff the state is confirmed", () => {
        const rnd = rng(20261013);
        let confirmedCount = 0;
        for (let run = 0; run < 1500; run += 1) {
            const n = 10 + Math.floor(rnd() * 40);
            const series = [];
            let x = 0.1 + rnd() * 0.5;
            const speed = [0, 0.01, 0.03, 0.06, 0.1][Math.floor(rnd() * 5)] * (rnd() < 0.5 ? 1 : -1);
            const departAt = Math.floor(rnd() * n);
            const jitter = [0, 0.003, 0.008][Math.floor(rnd() * 3)];
            for (let i = 0; i < n; i += 1) {
                if (i >= departAt) x += speed * 0.12;
                series.push(nose(i * STEP, x + (rnd() * 2 - 1) * jitter));
            }
            const reference = Math.floor(rnd() * n * STEP * 1.2);
            for (let i = 0; i < series.length; i += 1) {
                const r = chronosAssessStart({ sample: series[i], baselineWindow: series.slice(0, i), config: { referenceFrameMs: reference } });
                assert.equal(r.candidate !== null, r.state === "confirmed");
                if (r.candidate) {
                    confirmedCount += 1;
                    assert.ok(r.candidate.atMs >= reference, `run ${run}: onset ${r.candidate.atMs} < reference ${reference}`);
                    assert.equal(r.candidate.evidence.referenceFrameMs, reference);
                }
            }
        }
        assert.ok(confirmedCount > 100, `the property must actually be exercised (confirmed ${confirmedCount} times)`);
    });
});
