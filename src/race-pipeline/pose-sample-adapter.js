// Race pipeline — pose sample adapter.
//
// Pure, deterministic, stateless. Converts a raw MediaPipe Pose `results`
// object plus a caller-supplied timestamp into the exact PoseSample
// shape SwimmerTracking.observe() requires
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1), implementing the hip-
// midpoint mapping decision from docs/RACE_PIPELINE_ARCHITECTURE.md §5.
//
// This file never reads Date.now(), performance.now(), video.currentTime,
// requestAnimationFrame, or requestVideoFrameCallback — timestamp
// acquisition is entirely the caller's responsibility
// (docs/RACE_PIPELINE_ARCHITECTURE.md §4). It never touches the DOM. It
// does not import SwimmerTracking, Chronos, or the detectors — this
// file's only job is MediaPipe result -> PoseSample; the dependency
// direction is race-pipeline -> SwimmerTracking, never the reverse.
//
// CONTRACT NOTE (resolves a genuine contradiction found before any code
// was written): the Stage 4D.4 prompt's own wording described the output
// hip/nose shape as {x, y, z}. That wording was superseded by the
// established PoseSample {x, y, visibility} contract, because the
// actual SwimmerTracking consumer (src/swimmer-tracking/continuity.js's
// extractLandmark()) requires a finite `visibility` on every landmark —
// treating a landmark without one as entirely invalid — and never reads
// `z` at all. This file outputs {x, y, visibility} only. `z`, if present
// on an input landmark, is read nowhere in this file and never appears
// on any output object.
//
// MediaPipe BlazePose landmark indices used here (confirmed against
// CHASE_LANDMARK_INDEX in index.html — prior art only, not imported):
// NOSE = 0, LEFT_HIP = 23, RIGHT_HIP = 24.

const NOSE_INDEX = 0;
const LEFT_HIP_INDEX = 23;
const RIGHT_HIP_INDEX = 24;

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

// Extracts {x, y, visibility} from a raw MediaPipe landmark object, or
// null if the landmark is missing, malformed, or has a non-finite x/y/
// visibility. `z`, if present, is never read. Never coerces a bad/
// missing value into a plausible-looking number — an unusable landmark
// is treated as absent, not as evidence, mirroring the exact discipline
// src/swimmer-tracking/continuity.js's own extractLandmark() already
// applies (this is an independent, non-imported implementation of the
// same rule, not a shared function — see this file's header note on the
// required dependency direction).
function extractValidLandmark(landmark) {
    if (!landmark || typeof landmark !== "object") {
        return null;
    }
    if (
        !isFiniteNumber(landmark.x) ||
        !isFiniteNumber(landmark.y) ||
        !isFiniteNumber(landmark.visibility)
    ) {
        return null;
    }
    return { x: landmark.x, y: landmark.y, visibility: landmark.visibility };
}

// docs/RACE_PIPELINE_ARCHITECTURE.md §5 (Decision 1): the midpoint of
// LEFT_HIP/RIGHT_HIP when both are valid; the single valid hip's own
// values when only one side is valid; null when neither is valid — never
// a fabricated coordinate, and never a fallback to any other landmark
// (no shoulder midpoint, no nose substitution, no previous-frame value —
// this function has no previous-frame state to fall back to in the
// first place).
function mapHip(poseLandmarks) {
    const left = extractValidLandmark(poseLandmarks[LEFT_HIP_INDEX]);
    const right = extractValidLandmark(poseLandmarks[RIGHT_HIP_INDEX]);

    if (left && right) {
        return {
            x: (left.x + right.x) / 2,
            y: (left.y + right.y) / 2,
            // A midpoint is only as trustworthy as its least visible
            // input — the same principle
            // computeRepresentativePosition() applies one layer up for
            // hip+nose, applied here one layer earlier for left+right
            // hip (docs/RACE_PIPELINE_ARCHITECTURE.md §5).
            visibility: Math.min(left.visibility, right.visibility)
        };
    }

    if (left) {
        return left;
    }

    if (right) {
        return right;
    }

    return null;
}

// NOSE = MediaPipe landmark 0. Mapped directly when valid; null
// otherwise. No substitute landmark is ever used.
function mapNose(poseLandmarks) {
    return extractValidLandmark(poseLandmarks[NOSE_INDEX]);
}

/**
 * Builds a PoseSample from a raw MediaPipe Pose `results` object and a
 * caller-supplied timestamp.
 *
 * @param {object} results A MediaPipe Pose results object, expected to
 *   carry `poseLandmarks` (an array of `{x, y, z, visibility}` objects,
 *   or absent/empty when no pose was found this frame).
 * @param {number} atMs The authoritative timestamp for this sample,
 *   already resolved by the caller (docs/RACE_PIPELINE_ARCHITECTURE.md
 *   §4) — this function never reads a clock of its own and never
 *   transforms this value.
 * @returns {{atMs: number, hasPose: boolean, landmarks: {hip: object|null, nose: object|null}|null}}
 *   A PoseSample exactly matching
 *   docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1 — `landmarks` is `null`
 *   when `hasPose` is false (per that contract's own stated shape), and
 *   `landmarks.hip`/`landmarks.nose` are each independently `null` when
 *   that specific target landmark is unusable, even while `hasPose` is
 *   `true` (docs/SWIMMER_TRACKING_ARCHITECTURE.md §10's "gap" handling
 *   for this exact case).
 */
export function racePipelineBuildPoseSample(results, atMs) {
    const hasPose = !!(
        results &&
        Array.isArray(results.poseLandmarks) &&
        results.poseLandmarks.length > 0
    );

    if (!hasPose) {
        return { atMs, hasPose: false, landmarks: null };
    }

    const poseLandmarks = results.poseLandmarks;

    return {
        atMs,
        hasPose: true,
        landmarks: {
            hip: mapHip(poseLandmarks),
            nose: mapNose(poseLandmarks)
        }
    };
}
