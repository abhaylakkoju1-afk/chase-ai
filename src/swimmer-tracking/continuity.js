// Swimmer tracking — pure continuity/projection math.
//
// Implements the representative-position, trajectory-projection, and
// continuity-error concepts from docs/SWIMMER_TRACKING_ARCHITECTURE.md
// §11. Every function here is pure: no DOM, no clock, no video, no
// MediaPipe, no Chronos, no detector imports, no module-level mutable
// state. Every value (including every timestamp) is supplied by the
// caller.

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

// Extracts {x, y, visibility} from a landmark-shaped object, or null if
// any required field is missing/non-finite. Never coerces a bad/missing
// value into a plausible-looking number — an unusable landmark is
// treated as absent, not as evidence (docs/SWIMMER_TRACKING_ARCHITECTURE.md
// §10: "Bad observations must not be silently converted into valid
// target observations").
function extractLandmark(landmark) {
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

// docs/SWIMMER_TRACKING_ARCHITECTURE.md §11: the representative position
// is a centroid of hip + nose — the same two landmarks the Stage 4B
// detectors already use — not a single raw landmark, since a centroid is
// more robust to any one landmark's transient occlusion/noise. Visibility
// is the minimum of the two, since a centroid is only as trustworthy as
// its least visible input. Returns null if either landmark is missing or
// invalid — this is deliberately NOT the legacy analyzer's single
// nose.x/hip.x approach (docs/CHRONOS_ARCHITECTURE.md §22-23).
export function computeRepresentativePosition(landmarks) {
    if (!landmarks || typeof landmarks !== "object") {
        return null;
    }

    const hip = extractLandmark(landmarks.hip);
    const nose = extractLandmark(landmarks.nose);
    if (!hip || !nose) {
        return null;
    }

    return {
        x: (hip.x + nose.x) / 2,
        y: (hip.y + nose.y) / 2,
        visibility: Math.min(hip.visibility, nose.visibility)
    };
}

// Simple linear velocity estimate between two confirmed representative
// positions, TIME-NORMALIZED — never a raw frame-to-frame delta. Mirrors
// the exact discipline already established for
// src/chronos-engine/detectors/turn-detector.js's timeNormalizedVelocity().
// Returns null if elapsed time is not strictly positive (out-of-order or
// duplicate timestamps carry no usable velocity information).
export function estimateVelocity(fromPosition, fromAtMs, toPosition, toAtMs) {
    if (!isFiniteNumber(fromAtMs) || !isFiniteNumber(toAtMs)) {
        return null;
    }
    const deltaTMs = toAtMs - fromAtMs;
    if (deltaTMs <= 0) {
        return null;
    }

    const deltaSeconds = deltaTMs / 1000;
    const x = (toPosition.x - fromPosition.x) / deltaSeconds;
    const y = (toPosition.y - fromPosition.y) / deltaSeconds;

    return { x, y, magnitudePerSecond: Math.sqrt(x * x + y * y) };
}

// Projects an expected position forward from a known position/velocity —
// a simple linear projection, deliberately not a Kalman filter or any
// higher-order model (docs/SWIMMER_TRACKING_ARCHITECTURE.md §11: "the
// simplest thing that satisfies the actual requirement"). elapsedMs may
// be any non-negative value, including a long reacquisition gap (§12.3
// projects "across the whole gap").
export function projectPosition(fromPosition, velocity, elapsedMs) {
    if (!isFiniteNumber(elapsedMs) || elapsedMs < 0) {
        return null;
    }
    const elapsedSeconds = elapsedMs / 1000;
    return {
        x: fromPosition.x + velocity.x * elapsedSeconds,
        y: fromPosition.y + velocity.y * elapsedSeconds
    };
}

// Plain Euclidean distance in normalized x/y space — deliberately not an
// x-only metric, even though swimming motion is predominantly horizontal
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §11: "does not silently encode a
// camera-orientation assumption it doesn't need to").
export function continuityError(observedPosition, projectedPosition) {
    const dx = observedPosition.x - projectedPosition.x;
    const dy = observedPosition.y - projectedPosition.y;
    return Math.sqrt(dx * dx + dy * dy);
}
