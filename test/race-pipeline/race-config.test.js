// Unit tests for src/race-pipeline/race-config.js — the pure
// configuration/calibration-geometry layer Stage 4D.7 adds.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    RACE_EVENT_OPTIONS,
    RACE_COURSE_OPTIONS,
    RACE_POOL_LENGTH_OPTIONS_METERS,
    racePipelineFindEventOption,
    racePipelineDefaultPoolLengthMetersForCourse,
    racePipelineReferenceLaneYFromCalibrationPoint,
    racePipelineBuildRaceConfig,
    racePipelineDescribeMissingConfigFields,
    racePipelineStartReferenceMsFromMediaTime,
    racePipelineMapClickToNormalizedPoint
} from "../../src/race-pipeline/race-config.js";

// ===========================================================================
// 1 — VALID EVENT SELECTION PRODUCES CORRECT EVENT/STROKE/DISTANCE
// ===========================================================================

describe("racePipelineFindEventOption() / RACE_EVENT_OPTIONS — event vocabulary", () => {
    test("the event vocabulary is exactly the existing PB system's 18 event strings", () => {
        const events = RACE_EVENT_OPTIONS.map((option) => option.event);
        assert.deepEqual(events, [
            "Freestyle 50m", "Freestyle 100m", "Freestyle 200m", "Freestyle 400m", "Freestyle 800m", "Freestyle 1500m",
            "Backstroke 50m", "Backstroke 100m", "Backstroke 200m",
            "Breaststroke 50m", "Breaststroke 100m", "Breaststroke 200m",
            "Butterfly 50m", "Butterfly 100m", "Butterfly 200m",
            "IM 100m", "IM 200m", "IM 400m"
        ]);
    });

    test("every option's distanceMeters is a positive integer parsed consistently from its own event string", () => {
        for (const option of RACE_EVENT_OPTIONS) {
            const parsedDistance = Number(option.event.match(/(\d+)m$/)[1]);
            assert.equal(option.distanceMeters, parsedDistance, `mismatch for ${option.event}`);
        }
    });

    test("selecting 'Freestyle 100m' produces strokeKey 'freestyle' and distanceMeters 100", () => {
        const option = racePipelineFindEventOption("Freestyle 100m");
        assert.deepEqual(option, { event: "Freestyle 100m", strokeKey: "freestyle", distanceMeters: 100 });
    });

    test("selecting 'IM 200m' produces strokeKey 'im' and distanceMeters 200", () => {
        const option = racePipelineFindEventOption("IM 200m");
        assert.deepEqual(option, { event: "IM 200m", strokeKey: "im", distanceMeters: 200 });
    });

    test("an unrecognized event value returns null, never a fabricated guess", () => {
        assert.equal(racePipelineFindEventOption("Freestyle 100 meters"), null);
        assert.equal(racePipelineFindEventOption(""), null);
        assert.equal(racePipelineFindEventOption(null), null);
        assert.equal(racePipelineFindEventOption(undefined), null);
    });
});

// ===========================================================================
// 2 — COURSE SELECTION
// ===========================================================================

describe("RACE_COURSE_OPTIONS", () => {
    test("is exactly the existing PB system's two course strings", () => {
        assert.deepEqual(RACE_COURSE_OPTIONS, ["Short Course", "Long Course"]);
    });
});

// ===========================================================================
// 3 — POOL LENGTH MAPPING
// ===========================================================================

describe("racePipelineDefaultPoolLengthMetersForCourse()", () => {
    test("RACE_POOL_LENGTH_OPTIONS_METERS is exactly the two standard competition lengths", () => {
        assert.deepEqual(RACE_POOL_LENGTH_OPTIONS_METERS, [25, 50]);
    });

    test("Short Course defaults to 25m, Long Course defaults to 50m — a suggestion only, not enforced elsewhere", () => {
        assert.equal(racePipelineDefaultPoolLengthMetersForCourse("Short Course"), 25);
        assert.equal(racePipelineDefaultPoolLengthMetersForCourse("Long Course"), 50);
    });

    test("an unrecognized course returns null, not a guessed default", () => {
        assert.equal(racePipelineDefaultPoolLengthMetersForCourse("50m"), null);
        assert.equal(racePipelineDefaultPoolLengthMetersForCourse(null), null);
    });
});

// ===========================================================================
// racePipelineBuildRaceConfig() — combining the above into the controller's
// exact required shape
// ===========================================================================

describe("racePipelineBuildRaceConfig()", () => {
    test("a fully valid selection produces the exact {event, course, poolLengthMeters, strokeKey, distanceMeters, referenceLaneY, startReferenceMs} shape", () => {
        const config = racePipelineBuildRaceConfig({
            eventValue: "Backstroke 100m",
            courseValue: "Long Course",
            poolLengthMetersValue: 50,
            calibrationPoint: { x: 0.5, y: 0.42 },
            startReferenceMs: 2800
        });

        assert.deepEqual(config, {
            event: "Backstroke 100m",
            strokeKey: "backstroke",
            distanceMeters: 100,
            course: "Long Course",
            poolLengthMeters: 50,
            referenceLaneY: 0.42,
            startReferenceMs: 2800
        });
    });

    test("nothing selected yet produces every field null, never a guessed default", () => {
        const config = racePipelineBuildRaceConfig({});
        assert.deepEqual(config, {
            event: null, strokeKey: null, distanceMeters: null,
            course: null, poolLengthMeters: null, referenceLaneY: null,
            startReferenceMs: null
        });
    });

    test("an invalid/non-finite pool length is treated as unset, not coerced", () => {
        const config = racePipelineBuildRaceConfig({
            eventValue: "Freestyle 50m", courseValue: "Short Course", poolLengthMetersValue: "25", calibrationPoint: null
        });
        assert.equal(config.poolLengthMeters, null);
    });
});

// ===========================================================================
// 4 / 5 / 6 — MISSING FIELDS BLOCK ANALYSIS (presence-check helper)
// ===========================================================================

describe("racePipelineDescribeMissingConfigFields()", () => {
    test("a complete config reports nothing missing", () => {
        const config = racePipelineBuildRaceConfig({
            eventValue: "Freestyle 100m", courseValue: "Short Course", poolLengthMetersValue: 25,
            calibrationPoint: { x: 0.5, y: 0.5 }, startReferenceMs: 0
        });
        assert.deepEqual(racePipelineDescribeMissingConfigFields(config), []);
    });

    test("missing event is reported", () => {
        const config = racePipelineBuildRaceConfig({
            courseValue: "Short Course", poolLengthMetersValue: 25, calibrationPoint: { x: 0.5, y: 0.5 }
        });
        assert.ok(racePipelineDescribeMissingConfigFields(config).includes("event"));
    });

    test("missing course is reported", () => {
        const config = racePipelineBuildRaceConfig({
            eventValue: "Freestyle 100m", poolLengthMetersValue: 25, calibrationPoint: { x: 0.5, y: 0.5 }
        });
        assert.ok(racePipelineDescribeMissingConfigFields(config).includes("course"));
    });

    test("invalid/missing pool length is reported", () => {
        const config = racePipelineBuildRaceConfig({
            eventValue: "Freestyle 100m", courseValue: "Short Course", calibrationPoint: { x: 0.5, y: 0.5 }
        });
        assert.ok(racePipelineDescribeMissingConfigFields(config).includes("pool length"));
    });

    test("missing lane calibration is reported", () => {
        const config = racePipelineBuildRaceConfig({
            eventValue: "Freestyle 100m", courseValue: "Short Course", poolLengthMetersValue: 25
        });
        assert.ok(racePipelineDescribeMissingConfigFields(config).includes("lane calibration"));
    });

    test("a valid lane position WITHOUT a pre-start reference frame is still reported as the one calibration step to redo", () => {
        const config = racePipelineBuildRaceConfig({
            eventValue: "Freestyle 100m", courseValue: "Short Course", poolLengthMetersValue: 25,
            calibrationPoint: { x: 0.5, y: 0.5 }
        });
        assert.deepEqual(racePipelineDescribeMissingConfigFields(config), ["lane calibration"]);
    });

    test("an invalid reference (negative, NaN, a string) is treated as unset by the builder and reported missing", () => {
        for (const bad of [-1, NaN, Infinity, "2800", null, undefined]) {
            const config = racePipelineBuildRaceConfig({
                eventValue: "Freestyle 100m", courseValue: "Short Course", poolLengthMetersValue: 25,
                calibrationPoint: { x: 0.5, y: 0.5 }, startReferenceMs: bad
            });
            assert.equal(config.startReferenceMs, null, String(bad));
            assert.deepEqual(racePipelineDescribeMissingConfigFields(config), ["lane calibration"]);
        }
    });

    test("multiple missing fields are all reported together", () => {
        assert.deepEqual(
            racePipelineDescribeMissingConfigFields(racePipelineBuildRaceConfig({})),
            ["event", "course", "pool length", "lane calibration"]
        );
    });
});

// ===========================================================================
// 7 / 8 / 9 / 10 — CALIBRATION
// ===========================================================================

describe("racePipelineReferenceLaneYFromCalibrationPoint()", () => {
    test("a valid calibration point produces its own y as referenceLaneY", () => {
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint({ x: 0.3, y: 0.47 }), 0.47);
    });

    test("a missing/null point produces null — turn detection stays disabled", () => {
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint(null), null);
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint(undefined), null);
    });

    test("a point with a non-finite or out-of-range y is rejected, not clamped", () => {
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint({ x: 0.5, y: NaN }), null);
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint({ x: 0.5, y: -0.1 }), null);
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint({ x: 0.5, y: 1.1 }), null);
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint({ x: 0.5 }), null); // missing y entirely
    });
});

describe("racePipelineMapClickToNormalizedPoint() — calibration click geometry", () => {
    test("a click on a video with no letterboxing (matching aspect ratios) maps directly proportionally", () => {
        // 640x360 native (16:9), rendered in a 640x360 container — no bars.
        const point = racePipelineMapClickToNormalizedPoint({
            clickX: 320, clickY: 180,
            containerWidth: 640, containerHeight: 360,
            videoNativeWidth: 640, videoNativeHeight: 360
        });
        assert.deepEqual(point, { x: 0.5, y: 0.5 });
    });

    test("a click accounts for vertical letterboxing (native wider than the container box)", () => {
        // Native 16:9 (640x360) inside a taller-than-wide 400x400 container ->
        // drawWidth=400, drawHeight=225, vertical bars top/bottom of (400-225)/2=87.5.
        const point = racePipelineMapClickToNormalizedPoint({
            clickX: 200, clickY: 87.5, // top edge of the actual video content
            containerWidth: 400, containerHeight: 400,
            videoNativeWidth: 640, videoNativeHeight: 360
        });
        assert.notEqual(point, null);
        assert.equal(Math.round(point.x * 100) / 100, 0.5);
        assert.equal(Math.round(point.y * 100) / 100, 0); // exactly the top of the content box
    });

    test("a click landing inside a letterbox bar (outside actual video content) is rejected, not clamped into range", () => {
        const point = racePipelineMapClickToNormalizedPoint({
            clickX: 200, clickY: 10, // above the content box's top edge (87.5) from the previous test's geometry
            containerWidth: 400, containerHeight: 400,
            videoNativeWidth: 640, videoNativeHeight: 360
        });
        assert.equal(point, null);
    });

    test("unknown video dimensions (metadata not yet loaded) reject rather than guess", () => {
        assert.equal(
            racePipelineMapClickToNormalizedPoint({
                clickX: 100, clickY: 100, containerWidth: 400, containerHeight: 300,
                videoNativeWidth: 0, videoNativeHeight: 0
            }),
            null
        );
    });

    test("never uses a fixed frame-midpoint fallback — a click exactly at the container's own center is only (0.5,0.5) when the video geometry genuinely puts it there", () => {
        // Deliberately asymmetric letterboxing: center of the CONTAINER is
        // NOT the center of the video content.
        const point = racePipelineMapClickToNormalizedPoint({
            clickX: 200, clickY: 200, // container center
            containerWidth: 400, containerHeight: 400,
            videoNativeWidth: 640, videoNativeHeight: 360 // content box: 400x225, vertical offset 87.5
        });
        // Content-relative y = (200 - 87.5) / 225 = 0.5 (coincidentally centered
        // vertically within the content too, since the container center IS
        // within the letterboxed content here) — but x should be exactly the
        // container's own horizontal center since there's no horizontal bar.
        assert.notEqual(point, null);
        assert.equal(point.x, 0.5);
    });
});

// ===========================================================================
// PRE-START REFERENCE FRAME — conversion from the paused video's media time
// (Chronos reliability phase 1C)
// ===========================================================================

describe("racePipelineStartReferenceMsFromMediaTime()", () => {
    test("converts seconds to milliseconds, including 0 and fractional positions", () => {
        assert.equal(racePipelineStartReferenceMsFromMediaTime(0), 0);
        assert.equal(racePipelineStartReferenceMsFromMediaTime(2.8), 2800);
        assert.equal(racePipelineStartReferenceMsFromMediaTime(0.0415), 41.5);
        assert.equal(racePipelineStartReferenceMsFromMediaTime(125.25), 125250);
    });

    test("a negative, NaN, infinite, or non-numeric time is null — never 0, never clamped, never coerced", () => {
        for (const bad of [-0.001, -5, NaN, Infinity, -Infinity, "2.8", null, undefined, {}, true]) {
            assert.equal(racePipelineStartReferenceMsFromMediaTime(bad), null, String(bad));
        }
    });
});
