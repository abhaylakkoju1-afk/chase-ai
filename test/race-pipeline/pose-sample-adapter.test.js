// Unit tests for src/race-pipeline/pose-sample-adapter.js —
// racePipelineBuildPoseSample(): raw MediaPipe results + atMs ->
// PoseSample (docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1,
// docs/RACE_PIPELINE_ARCHITECTURE.md §5).
//
// Every fixture below is a hand-built, synthetic MediaPipe-shaped
// landmarks array — never real video, never real MediaPipe output.
//
// IMPORTANT: the {x,y,visibility} contract asserted throughout this file
// (not {x,y,z}) is deliberate — see the adapter's own header comment.
// 4D.4 prompt-level {x,y,z} wording was superseded by the established
// PoseSample {x,y,visibility} contract because the actual SwimmerTracking
// consumer requires visibility and does not consume z.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { racePipelineBuildPoseSample } from "../../src/race-pipeline/pose-sample-adapter.js";
import { computeRepresentativePosition } from "../../src/swimmer-tracking/continuity.js";

const NOSE_INDEX = 0;
const LEFT_HIP_INDEX = 23;
const RIGHT_HIP_INDEX = 24;

// Builds a 33-length MediaPipe-shaped landmark array with every entry
// defaulted to a bland, valid landmark, so a test only needs to override
// the specific index(es) it cares about.
function landmarkArray(overrides = {}) {
    const arr = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
    for (const [index, value] of Object.entries(overrides)) {
        arr[Number(index)] = value;
    }
    return arr;
}

function mediaPipeResults(overrides = {}) {
    return { poseLandmarks: landmarkArray(overrides) };
}

// ===========================================================================
// 1 / 2 — VALID POSE WITH BOTH HIPS, CORRECT MIDPOINT
// ===========================================================================

describe("racePipelineBuildPoseSample() — valid pose, both hips", () => {
    test("both hips valid produces the correct midpoint x/y and Math.min visibility", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.40, y: 0.60, z: 0.1, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.60, y: 0.40, z: -0.1, visibility: 0.7 }
        });

        const sample = racePipelineBuildPoseSample(results, 1000);

        assert.deepEqual(sample.landmarks.hip, { x: 0.5, y: 0.5, visibility: 0.7 });
    });

    test("hasPose is true whenever poseLandmarks is a non-empty array", () => {
        const sample = racePipelineBuildPoseSample(mediaPipeResults(), 0);
        assert.equal(sample.hasPose, true);
    });
});

// ===========================================================================
// 21 — z IS IGNORED, NEVER APPEARS IN OUTPUT
// ===========================================================================

describe("racePipelineBuildPoseSample() — z is ignored", () => {
    test("z on the input landmarks is never read and never appears on the output hip/nose objects", () => {
        const results = mediaPipeResults({
            [NOSE_INDEX]: { x: 0.5, y: 0.2, z: 12345, visibility: 0.9 },
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: -999, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.6, y: 0.4, z: 777, visibility: 0.9 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.equal("z" in sample.landmarks.nose, false);
        assert.equal("z" in sample.landmarks.hip, false);
        assert.deepEqual(Object.keys(sample.landmarks.nose).sort(), ["visibility", "x", "y"]);
        assert.deepEqual(Object.keys(sample.landmarks.hip).sort(), ["visibility", "x", "y"]);
    });

    test("an extreme/invalid z value never affects the computed hip midpoint", () => {
        const resultsA = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.6, y: 0.4, z: 0, visibility: 0.9 }
        });
        const resultsB = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: NaN, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.6, y: 0.4, z: Infinity, visibility: 0.9 }
        });

        const sampleA = racePipelineBuildPoseSample(resultsA, 0);
        const sampleB = racePipelineBuildPoseSample(resultsB, 0);

        assert.deepEqual(sampleA.landmarks.hip, sampleB.landmarks.hip);
    });
});

// ===========================================================================
// 3 — VALID NOSE MAPPING
// ===========================================================================

describe("racePipelineBuildPoseSample() — nose mapping", () => {
    test("a valid nose landmark maps directly to {x, y, visibility}", () => {
        const results = mediaPipeResults({
            [NOSE_INDEX]: { x: 0.51, y: 0.22, z: 0.03, visibility: 0.88 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.deepEqual(sample.landmarks.nose, { x: 0.51, y: 0.22, visibility: 0.88 });
    });
});

// ===========================================================================
// 4 / 5 / 22 / 23 — SINGLE-HIP VALIDITY, VISIBILITY PRESERVATION
// ===========================================================================

describe("racePipelineBuildPoseSample() — single-hip validity", () => {
    test("only left hip valid: hip uses left hip's own x/y/visibility directly", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.35, y: 0.65, z: 0, visibility: 0.77 },
            [RIGHT_HIP_INDEX]: { x: NaN, y: 0.4, z: 0, visibility: 0.9 } // invalid
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.deepEqual(sample.landmarks.hip, { x: 0.35, y: 0.65, visibility: 0.77 });
    });

    test("only right hip valid: hip uses right hip's own x/y/visibility directly", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: 0, visibility: NaN }, // invalid
            [RIGHT_HIP_INDEX]: { x: 0.62, y: 0.38, z: 0, visibility: 0.81 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.deepEqual(sample.landmarks.hip, { x: 0.62, y: 0.38, visibility: 0.81 });
    });

    test("single-hip visibility is preserved exactly, not averaged or altered", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: 0, visibility: 0.123456 },
            [RIGHT_HIP_INDEX]: null
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.equal(sample.landmarks.hip.visibility, 0.123456);
    });
});

// ===========================================================================
// 6 — NEITHER HIP VALID
// ===========================================================================

describe("racePipelineBuildPoseSample() — neither hip valid", () => {
    test("both hips invalid: hip is null, not fabricated", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: NaN, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.6, y: NaN, z: 0, visibility: 0.9 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.equal(sample.landmarks.hip, null);
    });

    test("both hip entries entirely missing (sparse array): hip is null", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: undefined,
            [RIGHT_HIP_INDEX]: undefined
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.equal(sample.landmarks.hip, null);
    });
});

// ===========================================================================
// 7 — MISSING NOSE
// ===========================================================================

describe("racePipelineBuildPoseSample() — missing nose", () => {
    test("an invalid nose landmark produces landmarks.nose === null, not a substitute", () => {
        const results = mediaPipeResults({
            [NOSE_INDEX]: { x: 0.5, y: Infinity, z: 0, visibility: 0.9 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.equal(sample.landmarks.nose, null);
        // Confirms no fallback landmark (e.g. hip) was substituted for nose.
        assert.notDeepEqual(sample.landmarks.nose, sample.landmarks.hip);
    });
});

// ===========================================================================
// 8 / 9 — MISSING / EMPTY poseLandmarks
// ===========================================================================

describe("racePipelineBuildPoseSample() — missing/empty poseLandmarks", () => {
    test("results with no poseLandmarks property at all: hasPose false, landmarks null", () => {
        const sample = racePipelineBuildPoseSample({}, 500);

        assert.equal(sample.hasPose, false);
        assert.equal(sample.landmarks, null);
    });

    test("results with poseLandmarks: [] (empty array): hasPose false, landmarks null", () => {
        const sample = racePipelineBuildPoseSample({ poseLandmarks: [] }, 500);

        assert.equal(sample.hasPose, false);
        assert.equal(sample.landmarks, null);
    });

    test("results itself is null or undefined: hasPose false, no throw", () => {
        assert.doesNotThrow(() => racePipelineBuildPoseSample(null, 0));
        assert.doesNotThrow(() => racePipelineBuildPoseSample(undefined, 0));

        assert.equal(racePipelineBuildPoseSample(null, 0).hasPose, false);
        assert.equal(racePipelineBuildPoseSample(undefined, 0).hasPose, false);
    });

    test("poseLandmarks that is not an array (malformed results object): hasPose false", () => {
        const sample = racePipelineBuildPoseSample({ poseLandmarks: "not-an-array" }, 0);
        assert.equal(sample.hasPose, false);
    });
});

// ===========================================================================
// 10 / 11 / 12 — MALFORMED LANDMARK, NON-FINITE COORDINATES, UNUSABLE VISIBILITY
// ===========================================================================

describe("racePipelineBuildPoseSample() — malformed/invalid individual landmarks", () => {
    test("a landmark that is not an object (e.g. null) is treated as unusable", () => {
        const results = mediaPipeResults({ [NOSE_INDEX]: null });
        const sample = racePipelineBuildPoseSample(results, 0);
        assert.equal(sample.landmarks.nose, null);
    });

    test("a landmark that is a primitive (e.g. a string) is treated as unusable", () => {
        const results = mediaPipeResults({ [NOSE_INDEX]: "not-a-landmark" });
        const sample = racePipelineBuildPoseSample(results, 0);
        assert.equal(sample.landmarks.nose, null);
    });

    for (const badValue of [NaN, Infinity, -Infinity, "0.5", null, undefined]) {
        test(`a non-finite/non-numeric x (${JSON.stringify(badValue)}) makes the landmark unusable`, () => {
            const results = mediaPipeResults({ [NOSE_INDEX]: { x: badValue, y: 0.5, z: 0, visibility: 0.9 } });
            assert.equal(racePipelineBuildPoseSample(results, 0).landmarks.nose, null);
        });

        test(`a non-finite/non-numeric y (${JSON.stringify(badValue)}) makes the landmark unusable`, () => {
            const results = mediaPipeResults({ [NOSE_INDEX]: { x: 0.5, y: badValue, z: 0, visibility: 0.9 } });
            assert.equal(racePipelineBuildPoseSample(results, 0).landmarks.nose, null);
        });

        test(`a non-finite/non-numeric visibility (${JSON.stringify(badValue)}) makes the landmark unusable`, () => {
            const results = mediaPipeResults({ [NOSE_INDEX]: { x: 0.5, y: 0.5, z: 0, visibility: badValue } });
            assert.equal(racePipelineBuildPoseSample(results, 0).landmarks.nose, null);
        });
    }

    test("a missing visibility field entirely (undefined) makes the landmark unusable — never defaulted to a number", () => {
        const results = mediaPipeResults({ [NOSE_INDEX]: { x: 0.5, y: 0.5 } }); // no visibility key at all
        assert.equal(racePipelineBuildPoseSample(results, 0).landmarks.nose, null);
    });
});

// ===========================================================================
// 13 / 14 — TIMESTAMP PASS-THROUGH, NEVER GENERATED INTERNALLY
// ===========================================================================

describe("racePipelineBuildPoseSample() — timestamp handling", () => {
    test("atMs is passed through exactly, including fractional milliseconds", () => {
        const sample = racePipelineBuildPoseSample(mediaPipeResults(), 12345.678);
        assert.equal(sample.atMs, 12345.678);
    });

    test("atMs is passed through exactly even for a no-pose sample", () => {
        const sample = racePipelineBuildPoseSample({}, 999);
        assert.equal(sample.atMs, 999);
    });

    test("no timestamp is ever generated internally — Date.now()/performance.now() patched to throw across many calls", () => {
        const originalDateNow = Date.now;
        const originalPerformanceNow = typeof performance !== "undefined" ? performance.now : undefined;

        Date.now = () => { throw new Error("pose-sample-adapter.js must never call Date.now()"); };
        if (typeof performance !== "undefined") {
            performance.now = () => { throw new Error("pose-sample-adapter.js must never call performance.now()"); };
        }

        try {
            racePipelineBuildPoseSample(mediaPipeResults(), 0);
            racePipelineBuildPoseSample({}, 100);
            racePipelineBuildPoseSample({ poseLandmarks: [] }, 200);
        } finally {
            Date.now = originalDateNow;
            if (typeof performance !== "undefined") {
                performance.now = originalPerformanceNow;
            }
        }
    });

    test("this Node environment genuinely has no requestAnimationFrame/requestVideoFrameCallback to accidentally depend on", () => {
        assert.equal(typeof requestAnimationFrame, "undefined");
    });
});

// ===========================================================================
// 15 / 16 / 17 — DETERMINISM, NO MUTATION, NO STATE
// ===========================================================================

describe("racePipelineBuildPoseSample() — determinism, purity, statelessness", () => {
    test("identical inputs produce identical output across repeated calls", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: 0, visibility: 0.8 },
            [RIGHT_HIP_INDEX]: { x: 0.6, y: 0.4, z: 0, visibility: 0.6 }
        });

        const first = racePipelineBuildPoseSample(results, 1000);
        const second = racePipelineBuildPoseSample(results, 1000);

        assert.deepEqual(first, second);
    });

    test("the input results object is never mutated", () => {
        const results = mediaPipeResults();
        const before = structuredClone(results);

        racePipelineBuildPoseSample(results, 0);

        assert.deepEqual(results, before);
    });

    test("no previous-frame state leaks between unrelated calls — a valid call followed by an invalid one is unaffected, and vice versa", () => {
        const validResults = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.6, y: 0.4, z: 0, visibility: 0.9 }
        });
        const invalidResults = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: NaN, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: NaN, y: 0.4, z: 0, visibility: 0.9 }
        });

        const first = racePipelineBuildPoseSample(validResults, 0);
        const second = racePipelineBuildPoseSample(invalidResults, 100);
        const third = racePipelineBuildPoseSample(validResults, 200);

        assert.notEqual(first.landmarks.hip, null);
        assert.equal(second.landmarks.hip, null); // not influenced by the first call's valid hip
        assert.notEqual(third.landmarks.hip, null); // not influenced by the second call's invalid hip
        assert.deepEqual(first.landmarks.hip, third.landmarks.hip);
    });

    test("calling with two completely independent result objects back-to-back never cross-contaminates", () => {
        const resultsA = mediaPipeResults({ [NOSE_INDEX]: { x: 0.1, y: 0.1, z: 0, visibility: 0.9 } });
        const resultsB = mediaPipeResults({ [NOSE_INDEX]: { x: 0.9, y: 0.9, z: 0, visibility: 0.9 } });

        const sampleA = racePipelineBuildPoseSample(resultsA, 0);
        const sampleB = racePipelineBuildPoseSample(resultsB, 1);

        assert.equal(sampleA.landmarks.nose.x, 0.1);
        assert.equal(sampleB.landmarks.nose.x, 0.9);
    });
});

// ===========================================================================
// 18 — NO FALLBACK LANDMARK SUBSTITUTION
// ===========================================================================

describe("racePipelineBuildPoseSample() — no fallback landmark substitution", () => {
    test("when both hips are invalid, hip is null — never a shoulder midpoint, torso center, or nose position", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: NaN, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: NaN, y: 0.4, z: 0, visibility: 0.9 },
            [NOSE_INDEX]: { x: 0.5, y: 0.1, z: 0, visibility: 0.9 } // a plausible but WRONG substitute if one were used
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.equal(sample.landmarks.hip, null);
        // Explicitly confirms the nose's own coordinates never leaked into hip.
        assert.notDeepEqual(sample.landmarks.hip, sample.landmarks.nose);
    });
});

// ===========================================================================
// 19 / 26 — OUTPUT SHAPE MATCHES / IS DIRECTLY CONSUMABLE BY SwimmerTracking
// ===========================================================================

describe("racePipelineBuildPoseSample() — output shape matches the SwimmerTracking PoseSample contract", () => {
    test("the output has exactly {atMs, hasPose, landmarks} as its top-level shape", () => {
        const sample = racePipelineBuildPoseSample(mediaPipeResults(), 0);
        assert.deepEqual(Object.keys(sample).sort(), ["atMs", "hasPose", "landmarks"]);
    });

    test("landmarks is exactly {hip, nose} when hasPose is true, with no extra keys", () => {
        const sample = racePipelineBuildPoseSample(mediaPipeResults(), 0);
        assert.deepEqual(Object.keys(sample.landmarks).sort(), ["hip", "nose"]);
    });

    test("the output is directly consumable by SwimmerTracking's own computeRepresentativePosition() with zero transformation", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.40, y: 0.60, z: 0.1, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.60, y: 0.40, z: -0.1, visibility: 0.7 },
            [NOSE_INDEX]: { x: 0.50, y: 0.20, z: 0.0, visibility: 0.85 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        // Fed directly, unmodified, into the real SwimmerTracking pure
        // function — this is the strongest possible proof of contract
        // compatibility: not a shape assertion, but an actual successful
        // call into the real downstream consumer.
        const representativePosition = computeRepresentativePosition(sample.landmarks);

        assert.notEqual(representativePosition, null);
        assert.equal(representativePosition.x, (0.5 + 0.5) / 2); // hip.x=0.5, nose.x=0.5
        assert.equal(representativePosition.visibility, Math.min(0.7, 0.85));
    });

    test("an unusable-landmarks sample (hasPose true, hip/nose null) is also handled correctly by SwimmerTracking — produces no representative position, not a crash", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: NaN, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: NaN, y: 0.4, z: 0, visibility: 0.9 },
            [NOSE_INDEX]: { x: NaN, y: 0.2, z: 0, visibility: 0.9 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        assert.equal(sample.hasPose, true);
        assert.equal(sample.landmarks.hip, null);
        assert.equal(sample.landmarks.nose, null);

        assert.equal(computeRepresentativePosition(sample.landmarks), null);
    });
});

// ===========================================================================
// 20 / 25 — hasPose SEMANTICS MATCH THE ARCHITECTURE EXACTLY
// ===========================================================================

describe("racePipelineBuildPoseSample() — hasPose semantics", () => {
    test("hasPose is true whenever the pose engine found ANY pose, regardless of target-landmark usability", () => {
        const results = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: NaN, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: NaN, y: 0.4, z: 0, visibility: 0.9 },
            [NOSE_INDEX]: { x: NaN, y: 0.2, z: 0, visibility: 0.9 }
        });

        const sample = racePipelineBuildPoseSample(results, 0);

        // A pose WAS found (poseLandmarks is a non-empty array) — hasPose
        // reflects that raw fact, NOT whether hip/nose specifically came
        // out usable. docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1: hasPose
        // means "the upstream pose engine found ANY pose this frame" —
        // nothing more.
        assert.equal(sample.hasPose, true);
        assert.equal(sample.landmarks.hip, null);
        assert.equal(sample.landmarks.nose, null);
    });

    test("hasPose is false only when poseLandmarks itself is missing/empty/non-array — never because of landmark quality", () => {
        assert.equal(racePipelineBuildPoseSample({}, 0).hasPose, false);
        assert.equal(racePipelineBuildPoseSample({ poseLandmarks: [] }, 0).hasPose, false);
        assert.equal(racePipelineBuildPoseSample({ poseLandmarks: "x" }, 0).hasPose, false);
    });

    test("hasPose does NOT redefine itself as poseLandmarks.length > 0 AND usable target landmarks — it is exactly poseLandmarks.length > 0", () => {
        const usableResults = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: 0.4, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: 0.6, y: 0.4, z: 0, visibility: 0.9 }
        });
        const unusableResults = mediaPipeResults({
            [LEFT_HIP_INDEX]: { x: NaN, y: 0.6, z: 0, visibility: 0.9 },
            [RIGHT_HIP_INDEX]: { x: NaN, y: 0.4, z: 0, visibility: 0.9 }
        });

        assert.equal(racePipelineBuildPoseSample(usableResults, 0).hasPose, true);
        assert.equal(racePipelineBuildPoseSample(unusableResults, 0).hasPose, true); // still true
    });
});
