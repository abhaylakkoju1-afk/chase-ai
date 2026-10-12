// Unit tests for src/race-pipeline/frame-timing.js — the independently
// implemented (never imported from Chase) mirror of
// src/chase-engine/frame-timing.js's proven decision logic, plus the
// stricter racePipelineIsPendingTimingCurrent() discard gate this file
// adds beyond what Chase needed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineSupportsVideoFrameCallback,
    racePipelineIsSampleDue,
    racePipelineBuildPendingFrameTiming,
    racePipelineIsPendingTimingCurrent
} from "../../src/race-pipeline/frame-timing.js";

describe("racePipelineSupportsVideoFrameCallback()", () => {
    test("true when the video-like object has a requestVideoFrameCallback function", () => {
        assert.equal(racePipelineSupportsVideoFrameCallback({ requestVideoFrameCallback: () => {} }), true);
    });

    test("false when missing, not a function, or the video itself is missing", () => {
        assert.equal(racePipelineSupportsVideoFrameCallback({}), false);
        assert.equal(racePipelineSupportsVideoFrameCallback({ requestVideoFrameCallback: "nope" }), false);
        assert.equal(racePipelineSupportsVideoFrameCallback(null), false);
        assert.equal(racePipelineSupportsVideoFrameCallback(undefined), false);
    });
});

describe("racePipelineIsSampleDue()", () => {
    test("the first sample of a session (lastAnalyzedMediaTimeMs: null) is always due", () => {
        assert.equal(
            racePipelineIsSampleDue({ lastAnalyzedMediaTimeMs: null, currentMediaTimeMs: 0, sampleIntervalMs: 120 }),
            true
        );
    });

    test("due once elapsed time reaches or exceeds sampleIntervalMs", () => {
        assert.equal(
            racePipelineIsSampleDue({ lastAnalyzedMediaTimeMs: 1000, currentMediaTimeMs: 1120, sampleIntervalMs: 120 }),
            true
        );
        assert.equal(
            racePipelineIsSampleDue({ lastAnalyzedMediaTimeMs: 1000, currentMediaTimeMs: 1119, sampleIntervalMs: 120 }),
            false
        );
    });

    test("a backward jump relative to the last analyzed sample is treated as due immediately", () => {
        assert.equal(
            racePipelineIsSampleDue({ lastAnalyzedMediaTimeMs: 5000, currentMediaTimeMs: 100, sampleIntervalMs: 120 }),
            true
        );
    });

    test("a non-finite currentMediaTimeMs is never due", () => {
        assert.equal(
            racePipelineIsSampleDue({ lastAnalyzedMediaTimeMs: null, currentMediaTimeMs: NaN, sampleIntervalMs: 120 }),
            false
        );
        assert.equal(
            racePipelineIsSampleDue({ lastAnalyzedMediaTimeMs: null, currentMediaTimeMs: undefined, sampleIntervalMs: 120 }),
            false
        );
    });
});

describe("racePipelineBuildPendingFrameTiming()", () => {
    test("a valid rVFC-supported candidate is used as mediaTimeMs, marked frame-accurate", () => {
        const result = racePipelineBuildPendingFrameTiming({
            candidateMediaTimeMs: 4200,
            supportsVideoFrameCallback: true,
            generation: 3,
            fallbackVideoTimeMs: 4100
        });
        assert.deepEqual(result, { mediaTimeMs: 4200, isFrameAccurate: true, generation: 3 });
    });

    test("falls back to fallbackVideoTimeMs when rVFC is unsupported", () => {
        const result = racePipelineBuildPendingFrameTiming({
            candidateMediaTimeMs: 4200,
            supportsVideoFrameCallback: false,
            generation: 3,
            fallbackVideoTimeMs: 4100
        });
        assert.deepEqual(result, { mediaTimeMs: 4100, isFrameAccurate: false, generation: 3 });
    });

    test("falls back when the candidate is non-finite even though rVFC is supported", () => {
        const result = racePipelineBuildPendingFrameTiming({
            candidateMediaTimeMs: NaN,
            supportsVideoFrameCallback: true,
            generation: 3,
            fallbackVideoTimeMs: 4100
        });
        assert.deepEqual(result, { mediaTimeMs: 4100, isFrameAccurate: false, generation: 3 });
    });
});

describe("racePipelineIsPendingTimingCurrent() — the strict discard gate", () => {
    test("true when the pending record's generation matches the current one and mediaTimeMs is finite", () => {
        const pendingTiming = { mediaTimeMs: 4200, isFrameAccurate: true, generation: 5 };
        assert.equal(racePipelineIsPendingTimingCurrent({ pendingTiming, currentGeneration: 5 }), true);
    });

    test("false when the generation has moved on (a stale async result)", () => {
        const pendingTiming = { mediaTimeMs: 4200, isFrameAccurate: true, generation: 5 };
        assert.equal(racePipelineIsPendingTimingCurrent({ pendingTiming, currentGeneration: 6 }), false);
    });

    test("false when pendingTiming itself is missing", () => {
        assert.equal(racePipelineIsPendingTimingCurrent({ pendingTiming: null, currentGeneration: 5 }), false);
        assert.equal(racePipelineIsPendingTimingCurrent({ currentGeneration: 5 }), false);
    });

    test("false when mediaTimeMs on the pending record is non-finite, even under the current generation", () => {
        const pendingTiming = { mediaTimeMs: NaN, isFrameAccurate: false, generation: 5 };
        assert.equal(racePipelineIsPendingTimingCurrent({ pendingTiming, currentGeneration: 5 }), false);
    });
});

describe("frame-timing purity", () => {
    test("no Date.now()/performance.now() access anywhere in this module", () => {
        const originalDateNow = Date.now;
        const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

        Date.now = () => { throw new Error("frame-timing.js must never call Date.now()"); };
        if (typeof performance !== "undefined") {
            performance.now = () => { throw new Error("frame-timing.js must never call performance.now()"); };
        }

        try {
            racePipelineSupportsVideoFrameCallback({ requestVideoFrameCallback: () => {} });
            racePipelineIsSampleDue({ lastAnalyzedMediaTimeMs: null, currentMediaTimeMs: 0, sampleIntervalMs: 120 });
            const pendingTiming = racePipelineBuildPendingFrameTiming({
                candidateMediaTimeMs: 100,
                supportsVideoFrameCallback: true,
                generation: 1,
                fallbackVideoTimeMs: 100
            });
            racePipelineIsPendingTimingCurrent({ pendingTiming, currentGeneration: 1 });
        } finally {
            Date.now = originalDateNow;
            if (typeof performance !== "undefined") {
                performance.now = originalPerformanceNow;
            }
        }
    });
});
