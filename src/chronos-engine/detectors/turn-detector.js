// Chronos engine — turn detector (pure, deterministic).
//
// Detects a candidate "turn" observation (wall proximity + a time-
// normalized velocity drop + lane agreement + visibility) from a
// caller-managed rolling window of hip/nose samples. This is a PURE
// function: it never touches DOM, video, a clock, localStorage,
// Firebase, or a Chronos session — every value it needs, including all
// history, is supplied by the caller on every call. It holds no
// module-level mutable state.
//
// This is prior-art-informed, not a port: index.html's dead
// onRaceResults() heuristic (docs/CHRONOS_ARCHITECTURE.md §23 — never
// wired to anything, so it never ran on real footage) computed velocity
// as a raw, un-normalized `hip.x - lastHipX` positional delta between
// two consecutive callback invocations. That value's meaning silently
// changes with sampling cadence, which the Stage 4A reconnaissance
// flagged as a real correctness bug, not just an unvalidated threshold —
// this detector computes an actual distance/time velocity instead (see
// timeNormalizedVelocity() below). wallThreshold/laneDeviationThreshold
// default to the legacy 0.25/0.20 values only because they are documented
// existing starting points; velocityThreshold has NO honest legacy
// equivalent to convert (the old code's sampling cadence was never fixed
// or documented, since it never ran), so it is a fresh, clearly
// provisional placeholder. None of these defaults are claimed to be
// biomechanically or scientifically validated.
//
// This detector does not produce a TimingEvent — it returns a small,
// detector-local candidate shape. A future glue layer (not built in this
// stage) is responsible for turning an accepted candidate into a
// TimingEvent and calling ChronosEngine.recordEvent(). It also has no
// concept of swimmer identity: per the Stage 4A.1 reconnaissance, its
// input is assumed to already be the selected target's pose stream —
// this file performs no tracking/selection logic of its own.
//
// Detector-local suppression (`detectorSuppressionMs`, driven by the
// caller-supplied `previousCandidateAtMs`) exists ONLY to stop one
// physical wall contact from producing a candidate on every qualifying
// frame — a signal-processing concern. It is deliberately independent
// from, and much smaller than, Chronos's own MIN_EVENT_GAP_MS
// (src/chronos-engine/events.js), which is a race-timing-domain rule
// applied across manual+detector events combined, after candidates
// reach Chronos. This file never reads or reasons about that constant.

const DEFAULT_CONFIG = Object.freeze({
    // How close to a horizontal frame edge (normalized hip.x) counts as
    // "near a wall" — legacy-inspired value, not validated.
    wallThreshold: 0.25,

    // Maximum time-normalized horizontal velocity, in normalized-x units
    // per SECOND, still considered "slow enough" to be a wall contact.
    // No honest legacy equivalent exists to convert (see header note) —
    // fresh, clearly provisional placeholder.
    velocityThreshold: 0.12,

    // Maximum allowed |nose.y - config.referenceLaneY| — legacy-inspired
    // value, not validated.
    laneDeviationThreshold: 0.20,

    // Minimum MediaPipe landmark visibility for both hip and nose on the
    // current sample, and for any sample admitted from recentSamples.
    minVisibility: 0.5,

    // Detector-local re-fire suppression window, in ms. Intentionally
    // small and independent of Chronos's MIN_EVENT_GAP_MS (2500ms) — see
    // header note. Provisional placeholder.
    detectorSuppressionMs: 500,

    // Confidence weights (see "Confidence" below). Provisional, not a
    // claimed-optimal calibration. referenceLaneY has no default here —
    // it must be supplied by the caller; see chronosDetectTurn().
    wallProximityWeight: 0.3,
    velocityDropWeight: 0.3,
    visibilityWeight: 0.2,
    laneAgreementWeight: 0.2
});

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

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

function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

// Finds the most recent USABLE prior sample strictly before
// currentAtMs — the reference point for a time-normalized velocity.
// A sample is usable only if it is well-formed and its hip visibility
// meets minVisibility; unusable entries are excluded, not zero-filled.
function mostRecentUsableSample(recentSamples, currentAtMs, minVisibility) {
    if (!Array.isArray(recentSamples)) {
        return null;
    }

    let best = null;

    for (const entry of recentSamples) {
        if (!entry || !isFiniteNumber(entry.atMs) || entry.atMs >= currentAtMs) {
            continue;
        }
        const hip = extractLandmark(entry.hip);
        if (!hip || hip.visibility < minVisibility) {
            continue;
        }
        if (best === null || entry.atMs > best.atMs) {
            best = { atMs: entry.atMs, hipX: hip.x };
        }
    }

    return best;
}

// Distance/time velocity, in normalized-x units per second — the
// deliberate replacement for the legacy raw per-callback delta (see
// header note).
function timeNormalizedVelocity(currentX, currentAtMs, previous) {
    const deltaTMs = currentAtMs - previous.atMs;
    if (deltaTMs <= 0) {
        return null;
    }
    const deltaX = currentX - previous.hipX;
    return Math.abs(deltaX) / (deltaTMs / 1000);
}

/**
 * Detects a candidate "turn" observation.
 *
 * @param {object} args
 * @param {{atMs:number, hip:{x:number,y:number,visibility:number}, nose:{x:number,y:number,visibility:number}}} args.sample
 *   The current frame's sample. Must belong to the already-selected
 *   target's pose stream — this function has no way to know, and does
 *   not attempt to determine, whose pose this is.
 * @param {Array<{atMs:number, hip:{x:number,y:number,visibility:number}}>} args.recentSamples
 *   Caller-managed rolling window used to compute a time-normalized
 *   velocity — NOT a single previous-frame delta.
 * @param {number|null} [args.previousCandidateAtMs]
 *   This detector's own last emitted candidate atMs, for detector-local
 *   suppression (see header note). null/undefined means "no prior
 *   candidate" — no suppression is applied.
 * @param {object} args.config
 *   Overrides for DEFAULT_CONFIG. config.referenceLaneY is REQUIRED (a
 *   finite number) — there is no default, since defaulting it would
 *   silently reproduce the legacy fragile "first frame" baseline this
 *   detector deliberately avoids; the caller is expected to derive it
 *   from a stable window, the same way the start detector's
 *   baselineWindow works.
 * @returns {{atMs:number, confidence:number, evidence:object}|null}
 *   A candidate, or null when a hard gate fails. Never throws for
 *   ordinary malformed/insufficient input.
 */
export function chronosDetectTurn({ sample, recentSamples, previousCandidateAtMs, config } = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

    if (!isFiniteNumber(cfg.referenceLaneY)) {
        return null;
    }

    if (!sample || !isFiniteNumber(sample.atMs)) {
        return null;
    }

    const hip = extractLandmark(sample.hip);
    const nose = extractLandmark(sample.nose);
    if (!hip || !nose) {
        return null;
    }

    const visibilityScore = Math.min(hip.visibility, nose.visibility);
    if (visibilityScore < cfg.minVisibility) {
        return null;
    }

    const nearZeroEdge = hip.x < cfg.wallThreshold;
    const nearOneEdge = hip.x > 1 - cfg.wallThreshold;
    if (!nearZeroEdge && !nearOneEdge) {
        return null;
    }

    const previous = mostRecentUsableSample(recentSamples, sample.atMs, cfg.minVisibility);
    if (!previous) {
        return null;
    }

    const velocityPerSecond = timeNormalizedVelocity(hip.x, sample.atMs, previous);
    if (velocityPerSecond === null || velocityPerSecond > cfg.velocityThreshold) {
        return null;
    }

    const laneDeviation = Math.abs(nose.y - cfg.referenceLaneY);
    if (laneDeviation > cfg.laneDeviationThreshold) {
        return null;
    }

    if (
        isFiniteNumber(previousCandidateAtMs) &&
        sample.atMs - previousCandidateAtMs < cfg.detectorSuppressionMs
    ) {
        return null;
    }

    const distanceIntoZone = nearZeroEdge
        ? cfg.wallThreshold - hip.x
        : hip.x - (1 - cfg.wallThreshold);
    const wallProximityScore = clamp01(distanceIntoZone / cfg.wallThreshold);
    const velocityDropScore = clamp01(1 - velocityPerSecond / cfg.velocityThreshold);
    const laneAgreementScore = clamp01(1 - laneDeviation / cfg.laneDeviationThreshold);

    const confidence = clamp01(
        cfg.wallProximityWeight * wallProximityScore +
        cfg.velocityDropWeight * velocityDropScore +
        cfg.visibilityWeight * visibilityScore +
        cfg.laneAgreementWeight * laneAgreementScore
    );

    return {
        atMs: sample.atMs,
        confidence,
        evidence: {
            hipX: hip.x,
            wallSide: nearZeroEdge ? "near-zero" : "near-one",
            velocityPerSecond,
            laneDeviation,
            visibility: visibilityScore,
            wallProximityScore,
            velocityDropScore,
            laneAgreementScore
        }
    };
}
