// Calibration click mapping (Chronos reliability, phase 3A).
//
// racePipelineMapClickToNormalizedPoint() turns one click, given in ELEMENT-LOCAL
// pixels over the <video> element's box, into a normalized point in the video's own
// frame, the same space MediaPipe landmarks use. The click handler in index.html
// supplies `clickX/Y` = clientX/Y - video.getBoundingClientRect().{left,top} and the
// box size from the same rect (see docs/RACE_PIPELINE_ARCHITECTURE.md section 7.1).
//
// These tests check the arithmetic against an INDEPENDENT forward model: they pick a
// point of the SOURCE video (fx, fy), compute where that point is drawn for a given
// box and `object-fit: contain`, and require the mapping to recover (fx, fy). They are
// pure and deterministic (a seeded generator). What they cannot show is that the real
// page supplies the right inputs; test/e2e/race-start-context.spec.js measures that
// with the page's real rendered geometry. Neither shows anything about real-world
// swimming accuracy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
    racePipelineMapClickToNormalizedPoint,
    racePipelineReferenceLaneYFromCalibrationPoint,
    racePipelineBuildRaceConfig,
    racePipelineDescribeMissingConfigFields
} from "../../src/race-pipeline/race-config.js";
import { seededRandom } from "./synthetic-race.js";

const map = racePipelineMapClickToNormalizedPoint;
const EPS = 1e-9;

// Independent forward model of `object-fit: contain; object-position: 50% 50%`:
// where the video's content sits inside a box of the given size.
function contentPlacement(box, native) {
    const scale = Math.min(box.width / native.width, box.height / native.height);
    const drawWidth = native.width * scale;
    const drawHeight = native.height * scale;
    return {
        drawWidth,
        drawHeight,
        left: (box.width - drawWidth) / 2,
        top: (box.height - drawHeight) / 2
    };
}

// Element-local click position of the source-frame fraction (fx, fy).
function clickFor(fx, fy, box, native) {
    const c = contentPlacement(box, native);
    return { clickX: c.left + fx * c.drawWidth, clickY: c.top + fy * c.drawHeight };
}

function mapSourcePoint(fx, fy, box, native) {
    return map({
        ...clickFor(fx, fy, box, native),
        containerWidth: box.width,
        containerHeight: box.height,
        videoNativeWidth: native.width,
        videoNativeHeight: native.height
    });
}

const close = (a, b, label) => assert.ok(Math.abs(a - b) <= EPS, `${label}: ${a} vs ${b}`);

const SOURCES = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 640, height: 480 },
    { width: 720, height: 720 },
    { width: 1080, height: 1920 },   // portrait
    { width: 3840, height: 2160 },
    { width: 320, height: 180 }
];
const BOXES = [
    "same aspect ratio",
    "wider than the video (pillarbox)",
    "taller than the video (letterbox)",
    "very small"
];
function boxFor(kind, native) {
    const aspect = native.width / native.height;
    switch (kind) {
        case "same aspect ratio": return { width: 700, height: 700 / aspect };
        case "wider than the video (pillarbox)": return { width: 700 * 1.6 * aspect, height: 700 };
        case "taller than the video (letterbox)": return { width: 700, height: (700 / aspect) * 1.7 };
        default: return { width: 37, height: 37 / aspect };
    }
}

describe("click mapping recovers the source-video point under every box shape", () => {
    test("round trip over source sizes, box shapes (same aspect, pillarbox, letterbox, tiny) and fractions 0..1", () => {
        let checked = 0;
        for (const native of SOURCES) {
            for (const kind of BOXES) {
                const box = boxFor(kind, native);
                for (const fx of [0, 0.1, 0.5, 0.9, 1]) {
                    for (const fy of [0, 0.25, 0.5, 0.8, 1]) {
                        const point = mapSourcePoint(fx, fy, box, native);
                        assert.notEqual(point, null, `${native.width}x${native.height} ${kind} (${fx}, ${fy})`);
                        close(point.x, fx, `${native.width}x${native.height} ${kind} x`);
                        close(point.y, fy, `${native.width}x${native.height} ${kind} y`);
                        checked += 1;
                    }
                }
            }
        }
        assert.equal(checked, SOURCES.length * BOXES.length * 25);
    });

    test("SEEDED: 500 random source sizes, box sizes and points round-trip", () => {
        const random = seededRandom(20261017);
        for (let i = 0; i < 500; i += 1) {
            const native = { width: 100 + Math.floor(random() * 3900), height: 100 + Math.floor(random() * 2900) };
            const box = { width: 20 + random() * 1500, height: 20 + random() * 1500 };
            const fx = random();
            const fy = random();
            const point = mapSourcePoint(fx, fy, box, native);
            assert.notEqual(point, null, `case ${i}`);
            close(point.x, fx, `case ${i} x`);
            close(point.y, fy, `case ${i} y`);
        }
    });
});

describe("the same source point gives the same reference however the page is laid out", () => {
    const native = { width: 1280, height: 720 };
    const fy = 0.3;
    const layouts = [
        { name: "desktop, video at the viewport origin", rect: { left: 0, top: 0, width: 800, height: 450 } },
        { name: "desktop, video offset by (291, 928)", rect: { left: 291, top: 928, width: 697, height: 392 } },
        { name: "phone width, offset by (11, 1066)", rect: { left: 11, top: 1066, width: 368, height: 207 } },
        { name: "narrow wrapper, large margin", rect: { left: 90, top: 60, width: 331, height: 186.1875 } },
        { name: "forced letterbox (box taller than the video)", rect: { left: 40, top: 30, width: 700, height: 600 } },
        { name: "forced pillarbox (box wider than the video)", rect: { left: 40, top: 30, width: 900, height: 300 } }
    ];

    test("passing the click relative to the element's own rect gives one answer for every layout", () => {
        for (const layout of layouts) {
            const local = clickFor(0.5, fy, layout.rect, native);
            // What the page does: viewport click, minus the rect's origin.
            const viewportX = layout.rect.left + local.clickX;
            const viewportY = layout.rect.top + local.clickY;
            const point = map({
                clickX: viewportX - layout.rect.left,
                clickY: viewportY - layout.rect.top,
                containerWidth: layout.rect.width,
                containerHeight: layout.rect.height,
                videoNativeWidth: native.width,
                videoNativeHeight: native.height
            });
            assert.notEqual(point, null, layout.name);
            close(point.y, fy, layout.name);
            close(point.x, 0.5, layout.name);
        }
    });

    test("giving the mapping VIEWPORT coordinates instead of element-local ones is wrong for any offset video (the reason the page subtracts the rect origin)", () => {
        const offset = layouts[1].rect;
        const local = clickFor(0.5, fy, offset, native);
        const wrong = map({
            clickX: offset.left + local.clickX,
            clickY: offset.top + local.clickY,
            containerWidth: offset.width,
            containerHeight: offset.height,
            videoNativeWidth: native.width,
            videoNativeHeight: native.height
        });
        assert.ok(wrong === null || Math.abs(wrong.y - fy) > 0.5, "an offset of this size cannot be mistaken for the right answer");
    });

    test("scaling the whole box and the click by the same factor (a uniform CSS scale or page zoom) changes nothing", () => {
        const base = { width: 640, height: 360 };
        const reference = mapSourcePoint(0.37, 0.61, base, native);
        for (const k of [0.5, 0.75, 1.5, 2, 3.25]) {
            const scaled = mapSourcePoint(0.37, 0.61, { width: base.width * k, height: base.height * k }, native);
            close(scaled.x, reference.x, `scale ${k}`);
            close(scaled.y, reference.y, `scale ${k}`);
        }
    });

    test("a different native pixel size with the same aspect ratio changes nothing (normalized, never pixels)", () => {
        const box = { width: 700, height: 700 * 720 / 1280 };
        const a = mapSourcePoint(0.2, 0.7, box, { width: 1280, height: 720 });
        const b = mapSourcePoint(0.2, 0.7, box, { width: 640, height: 360 });
        const c = mapSourcePoint(0.2, 0.7, box, { width: 3840, height: 2160 });
        close(a.y, b.y, "1280 vs 640"); close(a.y, c.y, "1280 vs 3840");
        close(a.x, b.x, "1280 vs 640"); close(a.x, c.x, "1280 vs 3840");
    });

    test("the same click in the same square box gives a different reference for sources of different aspect ratios (the box is letterboxed for one and not the other), as it must", () => {
        const click = { clickX: 350, clickY: 200, containerWidth: 700, containerHeight: 700 };
        const wide = map({ ...click, videoNativeWidth: 1280, videoNativeHeight: 720 });   // letterboxed: content is 700 x 393.75
        const square = map({ ...click, videoNativeWidth: 720, videoNativeHeight: 720 });  // fills the box
        assert.notEqual(wide, null);
        close(square.y, 200 / 700, "square source");
        close(wide.y, (200 - (700 - 393.75) / 2) / 393.75, "wide source");
        assert.ok(Math.abs(wide.y - square.y) > 0.1, `${wide.y} vs ${square.y}`);
    });
});

describe("boundary clicks and clicks outside the rendered content", () => {
    const native = { width: 1280, height: 720 };

    test("the exact corners and edges of the content map to exactly 0 and 1 (valid, not clamped)", () => {
        for (const kind of BOXES) {
            const box = boxFor(kind, native);
            const c = contentPlacement(box, native);
            const corners = [[c.left, c.top, 0, 0], [c.left + c.drawWidth, c.top, 1, 0], [c.left, c.top + c.drawHeight, 0, 1], [c.left + c.drawWidth, c.top + c.drawHeight, 1, 1]];
            for (const [clickX, clickY, ex, ey] of corners) {
                const point = map({ clickX, clickY, containerWidth: box.width, containerHeight: box.height, videoNativeWidth: native.width, videoNativeHeight: native.height });
                assert.notEqual(point, null, `${kind} corner (${ex}, ${ey})`);
                close(point.x, ex, `${kind} x`); close(point.y, ey, `${kind} y`);
            }
        }
    });

    test("just outside the content is rejected (null), never clamped to the edge", () => {
        for (const kind of BOXES) {
            const box = boxFor(kind, native);
            const c = contentPlacement(box, native);
            const base = { containerWidth: box.width, containerHeight: box.height, videoNativeWidth: native.width, videoNativeHeight: native.height };
            const mid = { x: c.left + c.drawWidth / 2, y: c.top + c.drawHeight / 2 };
            const outside = [
                { clickX: c.left - 0.01, clickY: mid.y }, { clickX: c.left + c.drawWidth + 0.01, clickY: mid.y },
                { clickX: mid.x, clickY: c.top - 0.01 }, { clickX: mid.x, clickY: c.top + c.drawHeight + 0.01 },
                { clickX: -5, clickY: -5 }, { clickX: box.width + 50, clickY: box.height + 50 }
            ];
            for (const click of outside) {
                assert.equal(map({ ...base, ...click }), null, `${kind} ${JSON.stringify(click)}`);
            }
        }
    });

    test("a letterbox bar (box taller than the video) and a pillarbox bar (box wider) are outside the content", () => {
        const tall = { width: 700, height: 600 };   // bars above and below
        const wide = { width: 900, height: 300 };   // bars left and right
        const tallC = contentPlacement(tall, native);
        const wideC = contentPlacement(wide, native);
        assert.ok(tallC.top > 50 && wideC.left > 50, "fixture sanity: the bars are real");
        assert.equal(map({ clickX: 350, clickY: tallC.top / 2, containerWidth: tall.width, containerHeight: tall.height, videoNativeWidth: 1280, videoNativeHeight: 720 }), null);
        assert.equal(map({ clickX: wideC.left / 2, clickY: 150, containerWidth: wide.width, containerHeight: wide.height, videoNativeWidth: 1280, videoNativeHeight: 720 }), null);
    });

    test("the few-pixel strip an overlay canvas has below an inline video is outside the content when the VIDEO's own box is used", () => {
        const videoBox = { width: 697.19, height: 392.16 };    // measured: the wrapper/canvas is 4 px taller than this
        const inside = map({ clickX: 300, clickY: 392, containerWidth: videoBox.width, containerHeight: videoBox.height, videoNativeWidth: 320, videoNativeHeight: 180 });
        const strip = map({ clickX: 300, clickY: 394, containerWidth: videoBox.width, containerHeight: videoBox.height, videoNativeWidth: 320, videoNativeHeight: 180 });
        assert.notEqual(inside, null);
        assert.equal(strip, null);
    });

    test("measuring against a box that is a few pixels taller than the video shifts the answer: the error the page's use of the video box avoids", () => {
        const native = { width: 320, height: 180 };
        const videoBox = { width: 167.64, height: 167.64 * 180 / 320 };   // a 390 px-wide phone layout: exactly 16:9, height 94.3
        const canvasBox = { width: videoBox.width, height: videoBox.height + 4 };   // wrapper/canvas: 4 px taller
        const clickY = 0.2 * videoBox.height;                       // the user clicks 20% down the VIDEO
        const right = map({ clickX: 80, clickY, containerWidth: videoBox.width, containerHeight: videoBox.height, videoNativeWidth: 320, videoNativeHeight: 180 });
        const biased = map({ clickX: 80, clickY, containerWidth: canvasBox.width, containerHeight: canvasBox.height, videoNativeWidth: native.width, videoNativeHeight: native.height });
        close(right.y, 0.2, "video box");
        assert.ok(Math.abs(biased.y - 0.2) > 0.015, `the canvas box would have given ${biased.y}`);
    });
});

describe("invalid input is rejected safely", () => {
    const good = { clickX: 100, clickY: 50, containerWidth: 200, containerHeight: 100, videoNativeWidth: 200, videoNativeHeight: 100 };

    test("the good fixture maps, so the rejections below are caused by the one bad field", () => {
        const point = map(good);
        assert.deepEqual([point.x, point.y], [0.5, 0.5]);
    });

    test("every field rejects NaN, Infinity, strings, null and undefined; sizes also reject zero and negatives", () => {
        const bad = [NaN, Infinity, -Infinity, "100", null, undefined, {}, true];
        for (const field of Object.keys(good)) {
            for (const value of bad) {
                assert.equal(map({ ...good, [field]: value }), null, `${field} = ${String(value)}`);
            }
        }
        for (const field of ["containerWidth", "containerHeight", "videoNativeWidth", "videoNativeHeight"]) {
            for (const value of [0, -1, -200]) {
                assert.equal(map({ ...good, [field]: value }), null, `${field} = ${value}`);
            }
        }
    });

    test("a missing or malformed argument object returns null and never throws", () => {
        for (const argument of [undefined, null, {}, [], "x", 5]) {
            assert.doesNotThrow(() => map(argument));
            assert.equal(map(argument), null);
        }
        assert.equal(map(), null);
    });

    test("the function is pure: inputs are not mutated and an invalid call leaves no trace that changes a later valid one", () => {
        const input = Object.freeze({ ...good });
        const first = map(input);
        map({ ...good, clickY: NaN });
        map({ ...good, clickX: 1e9 });
        map({ ...good, videoNativeWidth: 0 });
        const second = map(input);
        assert.deepEqual(first, second);
        assert.deepEqual(input, good);
    });
});

describe("the mapped point becomes the lane reference unchanged, and only valid points do", () => {
    const native = { width: 1280, height: 720 };

    test("referenceLaneY is exactly the mapped y: no conversion to or from pixels, no rounding", () => {
        const random = seededRandom(7);
        for (let i = 0; i < 200; i += 1) {
            const box = { width: 100 + random() * 900, height: 100 + random() * 900 };
            const point = mapSourcePoint(random(), random(), box, native);
            assert.equal(racePipelineReferenceLaneYFromCalibrationPoint(point), point.y);
        }
    });

    test("the range [0, 1] is inclusive; a point outside it, non-finite or malformed is null, never clamped", () => {
        for (const y of [0, 1, 0.5, 1e-12, 1 - 1e-12]) {
            assert.equal(racePipelineReferenceLaneYFromCalibrationPoint({ x: 0.5, y }), y);
        }
        for (const y of [-1e-12, 1 + 1e-12, -0.5, 1.5, NaN, Infinity, -Infinity, "0.5", null, undefined]) {
            assert.equal(racePipelineReferenceLaneYFromCalibrationPoint({ x: 0.5, y }), null, String(y));
        }
        for (const point of [null, undefined, 0.5, "x", [], {}]) {
            assert.equal(racePipelineReferenceLaneYFromCalibrationPoint(point), null);
        }
    });

    test("the converter does not modify the point it is given", () => {
        const point = Object.freeze({ x: 0.3, y: 0.62 });
        assert.equal(racePipelineReferenceLaneYFromCalibrationPoint(point), 0.62);
        assert.deepEqual(point, { x: 0.3, y: 0.62 });
    });

    test("end to end through the config builder: a rejected click produces no lane reference and blocks the start; a valid one produces exactly the clicked fraction", () => {
        const selection = { eventValue: "Freestyle 100m", courseValue: "Short Course", poolLengthMetersValue: 25, startReferenceMs: 4000 };
        const box = { width: 700, height: 700 * 720 / 1280 };
        const valid = mapSourcePoint(0.4, 0.62, box, native);
        const accepted = racePipelineBuildRaceConfig({ ...selection, calibrationPoint: valid });
        assert.equal(accepted.referenceLaneY, valid.y);
        close(accepted.referenceLaneY, 0.62, "clicked fraction");
        assert.deepEqual(racePipelineDescribeMissingConfigFields(accepted), []);

        const rejectedPoint = map({ clickX: 5000, clickY: 5000, containerWidth: box.width, containerHeight: box.height, videoNativeWidth: native.width, videoNativeHeight: native.height });
        assert.equal(rejectedPoint, null);
        const rejected = racePipelineBuildRaceConfig({ ...selection, calibrationPoint: rejectedPoint });
        assert.equal(rejected.referenceLaneY, null);
        assert.deepEqual(racePipelineDescribeMissingConfigFields(rejected), ["lane calibration"]);
    });
});
