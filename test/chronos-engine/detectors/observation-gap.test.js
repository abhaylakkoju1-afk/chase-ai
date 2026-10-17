// Observation-gap assessment (chronosAssessObservationGap) tests — Chronos
// reliability phase 2C.
//
// DETECTOR LAYER ONLY: pure inputs, no Chronos, tracking or pipeline. All data
// is synthetic. The function answers whether a turn COULD have been concealed
// between two usable observations; it never says one WAS. Rule under test:
// ambiguous <=> gap > maxSampleGapMs (600 ms) AND at least one bounding
// observation is inside a wall zone (hip.x < 0.25 or > 0.75, strict).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chronosAssessObservationGap, TURN_ASSESSMENT_DEFAULTS } from "../../../src/chronos-engine/detectors/turn-detector.js";

function sample(atMs, x, { hipVisibility = 0.9, noseVisibility = 0.9 } = {}) {
    return { atMs, hip: { x, y: 0.5, visibility: hipVisibility }, nose: { x: x + 0.04, y: 0.5, visibility: noseVisibility } };
}

function gap(beforeX, afterX, gapMs, config) {
    return chronosAssessObservationGap({ sample: sample(1000 + gapMs, afterX), recentSamples: [sample(1000, beforeX)], config });
}

describe("chronosAssessObservationGap() — the rule", () => {
    test("defaults come from the turn assessment (same zone, same gap limit)", () => {
        assert.equal(TURN_ASSESSMENT_DEFAULTS.maxSampleGapMs, 600);
        assert.equal(TURN_ASSESSMENT_DEFAULTS.wallThreshold, 0.25);
    });

    test("a long gap with a bounding observation in a wall zone is ambiguous; the evidence names the last observation BEFORE the gap", () => {
        const result = gap(0.88, 0.9, 1200);
        assert.equal(result.ambiguous, true);
        assert.equal(result.reason, "gap-adjacent-to-wall-zone");
        assert.equal(result.evidence.fromAtMs, 1000);
        assert.equal(result.evidence.toAtMs, 2200);
        assert.equal(result.evidence.gapMs, 1200);
        assert.equal(result.evidence.beforeWallSide, "near-one");
        assert.equal(result.evidence.afterWallSide, "near-one");
    });

    test("EITHER end suffices: only the observation before, or only the one after", () => {
        assert.equal(gap(0.9, 0.5, 1500).ambiguous, true);
        assert.equal(gap(0.5, 0.1, 1500).ambiguous, true);
        assert.equal(gap(0.9, 0.5, 1500).evidence.afterWallSide, null);
        assert.equal(gap(0.5, 0.1, 1500).evidence.beforeWallSide, null);
    });

    test("a long gap with BOTH ends outside both zones is harmless", () => {
        const result = gap(0.4, 0.6, 3000);
        assert.equal(result.ambiguous, false);
        assert.equal(result.reason, "gap-away-from-wall-zones");
    });

    test("BOUNDARY, gap length: exactly the limit (600 ms) is continuous; one millisecond more is a gap", () => {
        assert.deepEqual([gap(0.9, 0.9, 600).ambiguous, gap(0.9, 0.9, 600).reason], [false, "continuous"]);
        assert.deepEqual([gap(0.9, 0.9, 601).ambiguous, gap(0.9, 0.9, 601).reason], [true, "gap-adjacent-to-wall-zone"]);
    });

    test("BOUNDARY, zone edge (strict, as in the turn assessment): 0.25 and 0.75 are outside, just inside is in", () => {
        for (const [x, inside] of [[0.2499, true], [0.25, false], [0.7501, true], [0.75, false], [0.3, false], [0.7, false]]) {
            assert.equal(gap(x, 0.5, 2000).ambiguous, inside, `before x=${x}`);
            assert.equal(gap(0.5, x, 2000).ambiguous, inside, `after x=${x}`);
        }
    });

    test("the zone width and gap limit come from config (no hard-coded constants in the rule)", () => {
        assert.equal(gap(0.3, 0.5, 2000, { wallThreshold: 0.35 }).ambiguous, true);
        assert.equal(gap(0.9, 0.9, 700, { maxSampleGapMs: 800 }).ambiguous, false);
    });

    test("it does not use elapsed time, speed or position change beyond the two tests: a 60 s gap mid-pool is still harmless, a 0.7 s gap at the wall is not", () => {
        assert.equal(gap(0.5, 0.5, 60000).ambiguous, false);
        assert.equal(gap(0.05, 0.05, 700).ambiguous, true);
    });
});

describe("chronosAssessObservationGap() — what counts as an observation", () => {
    test("an unusable sample is not an observation: it makes the gap longer, never shorter", () => {
        // usable at t=1000 (x=0.1); an unusable (low-visibility) sample at 1400; usable at 1700
        const recent = [sample(1000, 0.1), sample(1400, 0.1, { hipVisibility: 0.1 })];
        const result = chronosAssessObservationGap({ sample: sample(1700, 0.1), recentSamples: recent });
        assert.equal(result.evidence.fromAtMs, 1000);
        assert.equal(result.evidence.gapMs, 700);
        assert.equal(result.ambiguous, true);
    });

    test("an unusable CURRENT sample is not an observation and flags nothing (the next usable sample is judged against the last usable one)", () => {
        const recent = [sample(1000, 0.1)];
        for (const bad of [sample(5000, 0.1, { hipVisibility: 0.2 }), sample(5000, 0.1, { noseVisibility: 0.2 }), { atMs: 5000, hip: null, nose: null }]) {
            const result = chronosAssessObservationGap({ sample: bad, recentSamples: recent });
            assert.equal(result.ambiguous, false);
            assert.equal(result.reason, "current-sample-unusable");
        }
        assert.equal(chronosAssessObservationGap({ sample: sample(5000, 0.1), recentSamples: recent }).ambiguous, true);
    });

    test("no previous observation means nothing to compare against: not ambiguous", () => {
        for (const recent of [[], undefined, null, "x", [null, {}, { atMs: NaN }], [sample(9000, 0.1)]]) {
            const result = chronosAssessObservationGap({ sample: sample(5000, 0.1), recentSamples: recent });
            assert.equal(result.ambiguous, false);
            assert.equal(result.reason, "no-previous-observation");
        }
    });

    test("malformed input never throws", () => {
        assert.doesNotThrow(() => chronosAssessObservationGap());
        assert.equal(chronosAssessObservationGap({ sample: { atMs: NaN } }).reason, "invalid-sample");
        assert.equal(chronosAssessObservationGap({}).ambiguous, false);
    });

    test("history order, duplicates and later-than-current entries do not change the answer; inputs are not mutated", () => {
        const recent = [sample(300, 0.5), sample(1000, 0.1), sample(1000, 0.1), sample(200, 0.5), sample(9000, 0.5)];
        const snapshot = JSON.stringify(recent);
        const result = chronosAssessObservationGap({ sample: sample(2500, 0.5), recentSamples: recent });
        assert.equal(result.ambiguous, true);
        assert.equal(result.evidence.fromAtMs, 1000);
        assert.equal(JSON.stringify(recent), snapshot);
        assert.deepEqual(chronosAssessObservationGap({ sample: sample(2500, 0.5), recentSamples: recent }), result);
    });
});
