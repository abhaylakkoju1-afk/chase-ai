// Chronos engine — start detector (pure, deterministic).
//
// Detects a candidate "start" observation from a caller-managed rolling
// baseline window of nose-position samples plus the current sample. This
// is a PURE function: it never touches DOM, video, a clock, localStorage,
// Firebase, or a Chronos session — every value it needs, including all
// history, is supplied by the caller on every call. It holds no module-
// level mutable state.
//
// This is prior-art-informed, not a port: index.html's dead
// onRaceResults() heuristic (docs/CHRONOS_ARCHITECTURE.md §23 — never
// wired to anything, so it never ran on real footage) compared the
// current frame's nose.x to a SINGLE first-frame baseline with a bare
// 0.08 threshold and no confidence, no visibility gating, and no
// debounce. Per the Stage 4A reconnaissance, that single-frame baseline
// is a real risk (one bad frame poisons the whole session), so this
// detector requires a genuine rolling window instead — see
// chronosDetectStart() below. displacementThreshold defaults to the
// legacy 0.08 value only because it is a documented, already-existing
// starting point, not because it has been validated against real swim
// footage; treat it, and every other default here, as provisional.
//
// This detector does not produce a TimingEvent — it returns a small,
// detector-local candidate shape. A future glue layer (not built in this
// stage) is responsible for turning an accepted candidate into a
// TimingEvent and calling ChronosEngine.recordEvent(). It also has no
// concept of swimmer identity: per the Stage 4A.1 reconnaissance, its
// input is assumed to already be the selected target's pose stream —
// this file performs no tracking/selection logic of its own.

const DEFAULT_CONFIG = Object.freeze({
    // Minimum |displacement| (normalized nose.x units) from the rolling
    // baseline required to even consider a candidate. Legacy-inspired
    // value, not a validated threshold — see the header note above.
    displacementThreshold: 0.08,

    // Minimum number of usable (sufficiently visible) baseline samples
    // required before ANY candidate can be produced — this is what
    // replaces the legacy single-first-frame baseline.
    minBaselineSamples: 5,

    // Minimum MediaPipe landmark visibility, for both the current sample
    // and any sample admitted into the baseline window.
    minVisibility: 0.5,

    // The normalized-x spread (population standard deviation) of the
    // baseline window at which baselineStability bottoms out at 0. A
    // window with stddev 0 scores 1 (perfectly stable); a window with
    // stddev >= this scale scores 0. Provisional placeholder, not a
    // validated value.
    baselineStabilityScale: 0.05,

    // Confidence weights (see "Confidence" below). Provisional, not a
    // claimed-optimal calibration.
    displacementWeight: 0.4,
    visibilityWeight: 0.3,
    baselineStabilityWeight: 0.3
});

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

// Extracts {x, y, visibility} from a landmark-shaped object, or null if
// any required field is missing/non-finite. Never coerces a bad/missing
// value into a plausible-looking number — an unusable landmark is
// treated as absent, not as evidence.
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

// Filters a caller-supplied baseline window down to samples that are
// individually well-formed and sufficiently visible. A sample that fails
// this check is excluded from the baseline entirely — it neither
// contributes to nor corrupts the computed baseline position/stability.
function usableBaselineSamples(baselineWindow, minVisibility) {
    if (!Array.isArray(baselineWindow)) {
        return [];
    }

    const usable = [];
    for (const entry of baselineWindow) {
        if (!entry || !isFiniteNumber(entry.atMs)) {
            continue;
        }
        const nose = extractLandmark(entry.nose);
        if (!nose || nose.visibility < minVisibility) {
            continue;
        }
        usable.push({ atMs: entry.atMs, x: nose.x });
    }
    return usable;
}

function meanOf(values) {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function populationStdDev(values, mean) {
    const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
    return Math.sqrt(variance);
}

/**
 * Detects a candidate "start" observation.
 *
 * @param {object} args
 * @param {{atMs:number, nose:{x:number,y:number,visibility:number}}} args.sample
 *   The current frame's sample. Must belong to the already-selected
 *   target's pose stream — this function has no way to know, and does
 *   not attempt to determine, whose pose this is.
 * @param {Array<{atMs:number, nose:{x:number,y:number,visibility:number}}>} args.baselineWindow
 *   Caller-accumulated prior samples used to establish a stable baseline
 *   position — NOT a single first frame.
 * @param {object} [args.config] Overrides for DEFAULT_CONFIG.
 * @returns {{atMs:number, confidence:number, evidence:object}|null}
 *   A candidate, or null when a hard gate fails. Never throws for
 *   ordinary malformed/insufficient input.
 */
export function chronosDetectStart({ sample, baselineWindow, config } = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

    if (!sample || !isFiniteNumber(sample.atMs)) {
        return null;
    }

    const nose = extractLandmark(sample.nose);
    if (!nose) {
        return null;
    }

    // Rule: low-visibility samples must not independently trigger a
    // start — gated on the CURRENT sample here.
    if (nose.visibility < cfg.minVisibility) {
        return null;
    }

    const baseline = usableBaselineSamples(baselineWindow, cfg.minVisibility);

    // Rule: a candidate cannot be produced until enough baseline samples
    // exist. This is the structural replacement for the legacy
    // single-first-frame baseline.
    if (baseline.length < cfg.minBaselineSamples) {
        return null;
    }

    const baselinePositionX = meanOf(baseline.map((entry) => entry.x));
    const baselineSpread = populationStdDev(baseline.map((entry) => entry.x), baselinePositionX);
    const baselineStability = clamp01(1 - baselineSpread / cfg.baselineStabilityScale);

    // Rule: displacement is direction-agnostic and time-independent (a
    // position difference, not a rate — unlike the turn detector's
    // velocity, this signal is never divided by elapsed time).
    const displacement = nose.x - baselinePositionX;
    const absDisplacement = Math.abs(displacement);

    if (absDisplacement < cfg.displacementThreshold) {
        return null;
    }

    const displacementStrength = clamp01(absDisplacement / (2 * cfg.displacementThreshold));
    const visibilityScore = clamp01(nose.visibility);

    const confidence = clamp01(
        cfg.displacementWeight * displacementStrength +
        cfg.visibilityWeight * visibilityScore +
        cfg.baselineStabilityWeight * baselineStability
    );

    return {
        atMs: sample.atMs,
        confidence,
        evidence: {
            displacement,
            absDisplacement,
            baselinePositionX,
            baselineSampleCount: baseline.length,
            baselineStability,
            visibility: nose.visibility
        }
    };
}
