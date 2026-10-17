// Race pipeline — race configuration + lane calibration (pure, UI-facing
// data layer for Stage 4D.7).
//
// This file owns exactly two concerns, both pure functions over plain
// data (no DOM, no clock, no MediaPipe, no Chronos/SwimmerTracking
// imports):
//
// 1. The canonical event/course/pool-length vocabulary the Race page's
//    configuration UI offers, and how a selected event maps to
//    {strokeKey, distanceMeters} — a single source of truth so
//    index.html never invents a second, possibly-conflicting
//    representation of the same race (Stage 4D.7 §2).
// 2. The geometry for turning one calibration click (a CSS pixel
//    position over the rendered video) into a normalized [0,1] point in
//    the SAME coordinate space as MediaPipe's own landmark output —
//    independently re-deriving the letterbox-aware math Chase's own
//    syncChaseCanvasToVideo() already proved, never importing it
//    (Stage 4D.6's established "mirror proven Chase behavior, never
//    import Chase" rule extends to this stage).
//
// EVENT/COURSE VOCABULARY PROVENANCE: RACE_EVENT_OPTIONS and
// RACE_COURSE_OPTIONS below are copied verbatim from the existing PB
// system's own <select id="event">/<select id="course"> option lists in
// index.html (confirmed by direct inspection before writing this file,
// Stage 4D.7.1) — this is the exact, pre-existing vocabulary
// docs/CHRONOS_ARCHITECTURE.md §12/§20 already requires RaceSession's
// `event`/`course` fields to match for future PB integration (Stage
// 4D.8). Nothing here invents a new string. `strokeKey` values mirror
// the existing Chase analyzer's own #stroke <select> vocabulary
// (freestyle/backstroke/breaststroke/butterfly, lowercase); "im" is the
// same lowercase convention applied to the one PB event group
// (Individual Medley) Chase's own selector does not offer.
//
// POOL LENGTH: exposed as a small, fixed choice of the two
// internationally standard competition lengths (25m, 50m) rather than
// free numeric entry, matching Stage 4D.7 §1's "pool length must map to
// a positive finite number" with no possible invalid input. The
// Short Course/Long Course -> 25m/50m pairing below is offered ONLY as a
// pre-selected DEFAULT, never enforced: no existing architecture
// document asserts that pairing as a hard rule (grep-confirmed against
// docs/CHRONOS_ARCHITECTURE.md and docs/RACE_PIPELINE_ARCHITECTURE.md
// during the Stage 4D.7.1 investigation), and some real-world "short
// course" pools are 25 YARDS, not 25 meters — an ambiguity this module
// does not attempt to resolve by fiat. See this stage's final report for
// the explicit flag on this open question.

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value) {
    return isFiniteNumber(value) && value > 0;
}

export const RACE_EVENT_OPTIONS = Object.freeze([
    Object.freeze({ event: "Freestyle 50m", strokeKey: "freestyle", distanceMeters: 50 }),
    Object.freeze({ event: "Freestyle 100m", strokeKey: "freestyle", distanceMeters: 100 }),
    Object.freeze({ event: "Freestyle 200m", strokeKey: "freestyle", distanceMeters: 200 }),
    Object.freeze({ event: "Freestyle 400m", strokeKey: "freestyle", distanceMeters: 400 }),
    Object.freeze({ event: "Freestyle 800m", strokeKey: "freestyle", distanceMeters: 800 }),
    Object.freeze({ event: "Freestyle 1500m", strokeKey: "freestyle", distanceMeters: 1500 }),
    Object.freeze({ event: "Backstroke 50m", strokeKey: "backstroke", distanceMeters: 50 }),
    Object.freeze({ event: "Backstroke 100m", strokeKey: "backstroke", distanceMeters: 100 }),
    Object.freeze({ event: "Backstroke 200m", strokeKey: "backstroke", distanceMeters: 200 }),
    Object.freeze({ event: "Breaststroke 50m", strokeKey: "breaststroke", distanceMeters: 50 }),
    Object.freeze({ event: "Breaststroke 100m", strokeKey: "breaststroke", distanceMeters: 100 }),
    Object.freeze({ event: "Breaststroke 200m", strokeKey: "breaststroke", distanceMeters: 200 }),
    Object.freeze({ event: "Butterfly 50m", strokeKey: "butterfly", distanceMeters: 50 }),
    Object.freeze({ event: "Butterfly 100m", strokeKey: "butterfly", distanceMeters: 100 }),
    Object.freeze({ event: "Butterfly 200m", strokeKey: "butterfly", distanceMeters: 200 }),
    Object.freeze({ event: "IM 100m", strokeKey: "im", distanceMeters: 100 }),
    Object.freeze({ event: "IM 200m", strokeKey: "im", distanceMeters: 200 }),
    Object.freeze({ event: "IM 400m", strokeKey: "im", distanceMeters: 400 })
]);

export const RACE_COURSE_OPTIONS = Object.freeze(["Short Course", "Long Course"]);

export const RACE_POOL_LENGTH_OPTIONS_METERS = Object.freeze([25, 50]);

const DEFAULT_POOL_LENGTH_METERS_BY_COURSE = Object.freeze({
    "Short Course": 25,
    "Long Course": 50
});

// Looks up the canonical {event, strokeKey, distanceMeters} entry for a
// selected event string, or null if it doesn't match the known
// vocabulary (e.g. nothing selected yet, or a tampered value).
export function racePipelineFindEventOption(eventValue) {
    return RACE_EVENT_OPTIONS.find((option) => option.event === eventValue) ?? null;
}

// A UI convenience default only — see the header note above on why this
// is never treated as an enforced rule.
export function racePipelineDefaultPoolLengthMetersForCourse(courseValue) {
    return DEFAULT_POOL_LENGTH_METERS_BY_COURSE[courseValue] ?? null;
}

// Derives referenceLaneY from a calibration point's own y — the concrete
// implementation of Stage 4D.7 decision #7 ("prefer the already-defined
// SwimmerTracking TargetSelection.point concept"). A malformed/missing
// point produces null, never a fabricated fallback value (Stage 4D.7
// §4: "do not fabricate a value").
export function racePipelineReferenceLaneYFromCalibrationPoint(point) {
    if (!point || typeof point !== "object" || !isFiniteNumber(point.y) || point.y < 0 || point.y > 1) {
        return null;
    }
    return point.y;
}

// Converts the media time of the PAUSED video (seconds, as read from
// video.currentTime at the moment the swimmer is marked) into the pre-start
// reference frame, in milliseconds (docs/RACE_PIPELINE_ARCHITECTURE.md §7.3).
// A non-numeric, non-finite, or negative time produces null, never 0 or a
// clamped value: an unreadable position must not become a valid start
// context. The result is a media TIMESTAMP only — it is not the race start
// and not the estimated motion onset.
export function racePipelineStartReferenceMsFromMediaTime(currentTimeSeconds) {
    if (!isFiniteNumber(currentTimeSeconds) || currentTimeSeconds < 0) {
        return null;
    }
    return currentTimeSeconds * 1000;
}

// Builds the exact {event, course, poolLengthMeters, strokeKey,
// distanceMeters, referenceLaneY, startReferenceMs} shape Stage 4D.7 §1
// requires (plus the phase 1C pre-start reference frame), from raw UI
// selection values plus the current calibration point. strokeKey and
// distanceMeters are ALWAYS derived from the same canonical event table
// used to populate the event <select> — never independently entered or
// computed a second way (Stage 4D.7 §2). Any field that cannot yet be
// determined is null; this function never guesses or defaults a missing
// value.
export function racePipelineBuildRaceConfig({ eventValue, courseValue, poolLengthMetersValue, calibrationPoint, startReferenceMs } = {}) {
    const eventOption = racePipelineFindEventOption(eventValue);

    return {
        event: eventOption ? eventOption.event : null,
        strokeKey: eventOption ? eventOption.strokeKey : null,
        distanceMeters: eventOption ? eventOption.distanceMeters : null,
        course: RACE_COURSE_OPTIONS.includes(courseValue) ? courseValue : null,
        poolLengthMeters: isPositiveFiniteNumber(poolLengthMetersValue) ? poolLengthMetersValue : null,
        referenceLaneY: racePipelineReferenceLaneYFromCalibrationPoint(calibrationPoint),
        // Validated, never defaulted: anything but a finite, non-negative
        // number is null (and the controller then refuses to start).
        startReferenceMs: isFiniteNumber(startReferenceMs) && startReferenceMs >= 0 ? startReferenceMs : null
    };
}

// Presence-only check for exactly the fields the UI is responsible for
// collecting (Stage 4D.7 §6's minimum required list). Deliberately does
// NOT re-validate types/ranges already-covered by
// controller.js's own validateConfig() (Stage 4D.7 §7: "do not duplicate
// validation logic unnecessarily") — this exists only so index.html can
// show a friendly, specific "what's still missing" message before even
// attempting to start a session.
export function racePipelineDescribeMissingConfigFields(config) {
    const missing = [];
    if (!config || !config.event) missing.push("event");
    if (!config || !config.course) missing.push("course");
    if (!config || !isPositiveFiniteNumber(config.poolLengthMeters)) missing.push("pool length");
    // The lane position and the pre-start reference frame come from the SAME
    // calibration step (one pause, one click), so either one missing is
    // reported as the one thing the user has to do again.
    if (
        !config ||
        !isFiniteNumber(config.referenceLaneY) ||
        !isFiniteNumber(config.startReferenceMs) ||
        config.startReferenceMs < 0
    ) {
        missing.push("lane calibration");
    }
    return missing;
}

// Maps one calibration click's CSS pixel position (relative to the
// video's rendered CONTAINER box — not necessarily the video's own
// content box, since a video without a forced aspect-ratio-breaking CSS
// height letterboxes/pillarboxes exactly like Chase's own analyzer
// video does) into a normalized [0,1] point in the video's native frame
// space — the same space MediaPipe landmarks (and therefore
// PoseSample.landmarks.nose/hip) already use.
//
// Independently re-derives the exact letterbox math Chase's own
// syncChaseCanvasToVideo() (index.html) already proved correct — never
// imported, per this workstream's "mirror proven Chase behavior, never
// import Chase" rule (Chase AI remains completely isolated,
// docs/RACE_PIPELINE_ARCHITECTURE.md §17 invariant 10).
//
// Returns null — never a clamped/guessed point — when: the click landed
// outside the actual video content (inside a letterbox bar), or the
// video's native/container dimensions are not yet known (e.g. metadata
// hasn't loaded). Stage 4D.7 §4: "if calibration cannot produce a valid
// finite normalized Y value: reject calibration... do not fabricate a
// value."
export function racePipelineMapClickToNormalizedPoint(args) {
    // Total over its input: a missing or non-object argument (null included, which
    // a destructuring default would not catch) is "no usable click", never a throw.
    const {
        clickX,
        clickY,
        containerWidth,
        containerHeight,
        videoNativeWidth,
        videoNativeHeight
    } = args !== null && typeof args === "object" ? args : {};

    if (
        !isPositiveFiniteNumber(containerWidth) ||
        !isPositiveFiniteNumber(containerHeight) ||
        !isPositiveFiniteNumber(videoNativeWidth) ||
        !isPositiveFiniteNumber(videoNativeHeight) ||
        !isFiniteNumber(clickX) ||
        !isFiniteNumber(clickY)
    ) {
        return null;
    }

    const nativeRatio = videoNativeWidth / videoNativeHeight;
    const boxRatio = containerWidth / containerHeight;

    let drawWidth = containerWidth;
    let drawHeight = containerHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (nativeRatio > boxRatio) {
        drawHeight = containerWidth / nativeRatio;
        offsetY = (containerHeight - drawHeight) / 2;
    } else if (nativeRatio < boxRatio) {
        drawWidth = containerHeight * nativeRatio;
        offsetX = (containerWidth - drawWidth) / 2;
    }

    const withinContent =
        clickX >= offsetX && clickX <= offsetX + drawWidth &&
        clickY >= offsetY && clickY <= offsetY + drawHeight;

    if (!withinContent || drawWidth <= 0 || drawHeight <= 0) {
        return null;
    }

    const x = (clickX - offsetX) / drawWidth;
    const y = (clickY - offsetY) / drawHeight;

    if (!isFiniteNumber(x) || !isFiniteNumber(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return null;
    }

    return { x, y };
}
