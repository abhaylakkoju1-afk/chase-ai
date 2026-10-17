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
//
// TWO ENTRY POINTS (Chronos reliability, phase 2):
//
//   chronosDetectTurn()  — the original SINGLE-SAMPLE primitive described
//     above: "the swimmer is inside the wall zone AND slow AND in lane". It
//     is kept unchanged and is NOT sufficient evidence of a turn: any
//     swimmer who rests at, starts from, or glides near a wall satisfies it,
//     on every frame, and its velocity gate (0.12 frame-widths/s) is above
//     ordinary swimming speed (~0.06), so it is not even selective about
//     speed. Nothing in the live pipeline calls it any more.
//
//   chronosAssessTurn()  — the decision the live pipeline uses (see the
//     "TURN ASSESSMENT" section at the bottom of this file). It requires a
//     directional reversal at a wall: travel toward a frame edge, a
//     turning point inside the wall zone, and sustained travel back away.

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

// ---------------------------------------------------------------------
// TURN ASSESSMENT (Chronos reliability, phase 2)
// ---------------------------------------------------------------------
//
// WHY THE SINGLE-SAMPLE PRIMITIVE IS NOT ENOUGH. chronosDetectTurn() answers
// "is the swimmer in the wall zone, slow, and in lane right now?". That is
// true of a swimmer standing at the start wall, of a swimmer who has just
// pushed off, of one who touches the finish wall and stops, and — because
// its velocity gate (0.12 frame-widths/s) is about twice ordinary swimming
// speed — of any swimmer simply swimming through the outer quarter of the
// frame. Fed every frame it proposed a "turn" ~0.1 s after the start, then
// every ~0.5 s for as long as the swimmer stayed in a wall zone, so a single
// physical wall approach produced several accepted turns (Chronos's 2.5 s
// gap only thinned them out).
//
// WHAT A TURN IS HERE (docs/CHRONOS_ARCHITECTURE.md §12: "wall proximity +
// direction reversal"). All three, in one contiguous observation run:
//
//   1. APPROACH   — the swimmer travelled at least `reversalDisplacement`
//                   (frame-widths, horizontal) TOWARD a frame edge, ending at
//   2. APEX       — a turning point (a local extreme of hip x) that lies
//                   inside that edge's wall zone (`wallThreshold`), followed by
//   3. RECOVERY   — travel back AWAY from the edge of at least
//                   `reversalDisplacement`, held by the last
//                   `confirmationSamples` samples (not one sample).
//
// Being near a wall, being slow, pausing, or one noisy observation are none
// of them sufficient. The wall zone is only the LOCATION gate for the apex.
//
// WHICH SIGNALS ARE AVAILABLE. The input is a stream of {atMs, hip, nose}
// for the already-tracked target: hip.x (horizontal position), nose.x/y,
// per-landmark visibility, and time. That supports approach / apex /
// recovery from hip.x history, lane agreement from nose.y, and visibility.
// It does NOT contain: wall position (the frame edge is only a proxy for it
// and assumes a static side-on camera framing the whole pool width, §22),
// body rotation or a flip (a tumble turn is visible only as hip.x history
// when the pose survives it, and underwater pose is often lost), foot or
// hand contact, or any 3D information. `nose.x - hip.x` (facing direction)
// IS available but is not used as evidence: it is unreliable through a
// flip/tumble and a turn must not depend on it.
//
// CANDIDATE TIME. `candidate.atMs` is the APEX: the first sample of the
// plateau at the turning point (an estimate of the wall-contact onset). Its
// error against the true arrival is bounded, in the synthetic runs, by: EARLY
// by up to `apexPlateauTolerance / speed` plus one sampling interval (the
// approach samples that are still within the plateau tolerance of the
// turning point — about 0.12 s at 0.04 frame-widths/s, 0.25 s at 0.02) and LATE
// by up to the dwell at the wall plus one sampling interval (when jitter hides
// the plateau); around a pose dropout the surrounding gap also counts — see
// `maxSampleGapMs`. These are properties of synthetic paths, not measured
// accuracy. It is NOT the time the evidence was
// confirmed: `evidence.confirmedAtMs` is the later sample at which the
// recovery had been held for `confirmationSamples` samples. The event the
// pipeline hands Chronos carries the apex time. Both are inferred, not
// measured, and the apex is not an official wall touch.
//
// OBSERVATION CONTINUITY. Approach, apex and recovery must lie in ONE run of
// consecutive usable samples no more than `maxSampleGapMs` apart. A longer
// gap (the pose was lost, or tracking dropped and reacquired — possibly a
// different swimmer) ends the run: evidence before it cannot be joined to
// evidence after it, and an apex whose timing straddles such a gap would be
// a guess. The result is no candidate (an indeterminate turn), never a
// fabricated one. Low-visibility and malformed samples are not usable.
//
// SINGLE-SAMPLE OUTLIERS. A sample that departs from BOTH neighbours, on the
// same side, by more than `spikeThreshold` is ignored. Two consecutive
// outlier samples are not recognised (documented limitation).
//
// ONE WALL INTERACTION = ONE CANDIDATE. `previousCandidateAtMs` (the apex
// time of this detector's last candidate) and the optional
// `config.earliestApexMs` (the accepted start time, so no apex before the
// race began) form a FLOOR: only samples strictly later than it are
// examined. A reported apex therefore cannot be reported again, and the next
// turn needs its own fresh approach after the previous one.
//
// STATES — same vocabulary as chronosAssessStart():
//   none       nothing wall-related to report (including "reversal away from
//              a wall that was never approached", e.g. the start, and
//              reversals in mid-pool)
//   plausible  an approach to a wall zone is under way (or a recovery has
//              begun) but has not been confirmed — it may or may not become
//              a turn. Never a candidate.
//   confirmed  approach + apex + sustained recovery. The only state with a
//              candidate.
//   rejected   a hard gate failed: invalid-sample, low-visibility-sample,
//              missing-reference-lane-y, invalid-earliest-apex,
//              lane-deviation. (`non-monotonic-timestamp` is reported by the
//              detector adapter, which refuses duplicate/out-of-order
//              samples before they reach this function.)
//
// Every threshold is provisional, in frame-widths (horizontal) or ms, and
// NONE has been validated against annotated real footage. This function is
// pure: no clock, DOM, session or module state.

export const TURN_ASSESSMENT_DEFAULTS = Object.freeze({
    // Same location gate the primitive uses: apex within this distance of a
    // frame edge (hip.x < wallThreshold or hip.x > 1 - wallThreshold).
    wallThreshold: 0.25,

    // Maximum |apex nose.y - referenceLaneY|. Same value as the primitive.
    laneDeviationThreshold: 0.20,

    // Minimum landmark visibility (hip AND nose) for a sample to count.
    minVisibility: 0.5,

    // Horizontal travel, in frame-widths, required both toward the wall
    // (approach) and back away from it (recovery). 0.08 matches the start
    // detector's displacement threshold and the legacy heuristic's figure;
    // it is well above stroke-cycle hip oscillation and the start noise band
    // (0.02). Unvalidated.
    reversalDisplacement: 0.08,

    // Consecutive latest samples that must all be beyond the recovery
    // displacement.
    confirmationSamples: 3,

    // Largest time between consecutive usable samples inside one run. Bounds
    // the apex-time uncertainty and ends a run at a pose dropout. About five
    // times the 120 ms minimum sampling interval; below tracking's 1500 ms
    // loss grace.
    maxSampleGapMs: 600,

    // A sample deviating from both neighbours (same side) by more than this
    // is an outlier and is ignored.
    spikeThreshold: 0.04,

    // Samples within this of the turning-point position, contiguous before
    // it, belong to the apex plateau; the apex time is the plateau's first.
    apexPlateauTolerance: 0.005,

    // History the caller should keep (the adapter prunes to it). Not used by
    // this function itself — it examines whatever it is handed. The approach,
    // the dwell at the wall and the sustained recovery must all fit inside it:
    // 12 s covers a wall dwell of roughly 8 s at ordinary swimming speed
    // (approach ~1.4 s + recovery ~1.7 s at 0.058 frame-widths/s). A pause at
    // the wall longer than that is not a racing turn, and yields no candidate.
    windowMs: 12000,

    // Confidence weights. Provisional, not calibrated; the score is a
    // summary of evidence quality, never a probability of correctness.
    wallProximityWeight: 0.3,
    reversalWeight: 0.3,
    visibilityWeight: 0.2,
    laneAgreementWeight: 0.2
});

function turnAssessment(state, reason, candidate, evidence) {
    return { state, reason, candidate, evidence };
}

// Ignores single-sample outliers: an interior sample on one side of BOTH
// neighbours by more than `threshold`. The first and last samples are never
// removed (a lone newest sample cannot be judged yet; it simply cannot be
// "held" for several samples).
function removeTurnOutliers(series, threshold) {
    return series.filter((entry, index) => {
        if (index === 0 || index === series.length - 1) {
            return true;
        }
        const before = series[index - 1].x;
        const after = series[index + 1].x;
        const aboveBoth = entry.x - before > threshold && entry.x - after > threshold;
        const belowBoth = before - entry.x > threshold && after - entry.x > threshold;
        return !(aboveBoth || belowBoth);
    });
}

// Hysteresis ("zigzag") extremum finder over x. A pivot is a turning point
// confirmed only once x has moved at least `delta` away from it. Returns
// {pivots, direction, pendingLow, pendingHigh}:
//   pivots     [{index, type: "min"|"max", approach}] — `approach` is how far
//              x travelled INTO the pivot from the previous opposite pivot
//              (or, for the first pivot, from the opposite extreme seen so
//              far in the run);
//   direction  -1 falling / +1 rising / 0 undecided since the last pivot;
//   pendingLow / pendingHigh  the running (unconfirmed) extremes since the
//              last pivot, with their `approach` so far.
function findReversalPivots(xs, delta) {
    const pivots = [];
    let direction = 0;
    let high = 0;
    let low = 0;
    let anchorIndex = null; // the previous pivot, once there is one

    const runningMaxUpTo = (index) => {
        let max = xs[0];
        for (let i = 1; i <= index; i += 1) if (xs[i] > max) max = xs[i];
        return max;
    };
    const runningMinUpTo = (index) => {
        let min = xs[0];
        for (let i = 1; i <= index; i += 1) if (xs[i] < min) min = xs[i];
        return min;
    };
    const approachInto = (index, type) => {
        if (anchorIndex !== null) {
            return Math.abs(xs[index] - xs[anchorIndex]);
        }
        return type === "min" ? runningMaxUpTo(index) - xs[index] : xs[index] - runningMinUpTo(index);
    };

    for (let i = 1; i < xs.length; i += 1) {
        if (xs[i] > xs[high]) high = i;
        if (xs[i] < xs[low]) low = i;

        if (direction === 0) {
            const droppedFromHigh = xs[high] - xs[i] >= delta;
            const roseFromLow = xs[i] - xs[low] >= delta;
            if (droppedFromHigh && (!roseFromLow || high < low)) {
                pivots.push({ index: high, type: "max", approach: approachInto(high, "max") });
                anchorIndex = high;
                direction = -1;
                low = i;
            } else if (roseFromLow) {
                pivots.push({ index: low, type: "min", approach: approachInto(low, "min") });
                anchorIndex = low;
                direction = 1;
                high = i;
            }
        } else if (direction === -1) {
            if (xs[i] - xs[low] >= delta) {
                pivots.push({ index: low, type: "min", approach: approachInto(low, "min") });
                anchorIndex = low;
                direction = 1;
                high = i;
            }
        } else if (xs[high] - xs[i] >= delta) {
            pivots.push({ index: high, type: "max", approach: approachInto(high, "max") });
            anchorIndex = high;
            direction = -1;
            low = i;
        }
    }

    return {
        pivots,
        direction,
        pendingLow: { index: low, approach: approachInto(low, "min") },
        pendingHigh: { index: high, approach: approachInto(high, "max") }
    };
}

/**
 * Assesses whether the newest sample completes a wall turn.
 *
 * @param {object} args
 * @param {{atMs:number, hip:object, nose:object}} args.sample The newest sample
 *   (already-tracked target only).
 * @param {Array<{atMs:number, hip:object, nose:object}>} args.recentSamples
 *   Prior samples of the SAME target, caller-managed, oldest first. Entries
 *   at or after `sample.atMs`, unusable entries and duplicate timestamps are
 *   ignored, never repaired.
 * @param {number|null} [args.previousCandidateAtMs] Apex time of this
 *   detector's last candidate; only samples strictly later are examined.
 * @param {object} args.config Overrides for TURN_ASSESSMENT_DEFAULTS.
 *   `referenceLaneY` is REQUIRED (finite). `earliestApexMs` is optional;
 *   when present it must be finite and non-negative, and only samples
 *   strictly later are examined.
 * @returns {{state:string, reason:string, candidate:object|null, evidence:object|null}}
 */
export function chronosAssessTurn({ sample, recentSamples, previousCandidateAtMs, config } = {}) {
    const cfg = { ...TURN_ASSESSMENT_DEFAULTS, ...(config || {}) };

    if (!isFiniteNumber(cfg.referenceLaneY)) {
        return turnAssessment("rejected", "missing-reference-lane-y", null, null);
    }

    const earliestApexPresent = config && config.earliestApexMs !== undefined && config.earliestApexMs !== null;
    if (earliestApexPresent && (!isFiniteNumber(config.earliestApexMs) || config.earliestApexMs < 0)) {
        return turnAssessment("rejected", "invalid-earliest-apex", null, null);
    }

    if (!sample || !isFiniteNumber(sample.atMs)) {
        return turnAssessment("rejected", "invalid-sample", null, null);
    }
    const hip = extractLandmark(sample.hip);
    const nose = extractLandmark(sample.nose);
    if (!hip || !nose) {
        return turnAssessment("rejected", "invalid-sample", null, null);
    }
    const currentVisibility = Math.min(hip.visibility, nose.visibility);
    if (currentVisibility < cfg.minVisibility) {
        return turnAssessment("rejected", "low-visibility-sample", null, { visibility: currentVisibility });
    }

    // Usable history, oldest first, strictly increasing in time, then the
    // current sample.
    const history = [];
    if (Array.isArray(recentSamples)) {
        for (const entry of recentSamples) {
            if (!entry || !isFiniteNumber(entry.atMs) || entry.atMs >= sample.atMs) {
                continue;
            }
            const entryHip = extractLandmark(entry.hip);
            const entryNose = extractLandmark(entry.nose);
            if (!entryHip || !entryNose) {
                continue;
            }
            const visibility = Math.min(entryHip.visibility, entryNose.visibility);
            if (visibility < cfg.minVisibility) {
                continue;
            }
            history.push({ atMs: entry.atMs, x: entryHip.x, noseY: entryNose.y, visibility });
        }
    }
    history.sort((a, b) => a.atMs - b.atMs);
    const ordered = history.filter((entry, index) => index === 0 || entry.atMs > history[index - 1].atMs);
    ordered.push({ atMs: sample.atMs, x: hip.x, noseY: nose.y, visibility: currentVisibility });

    // Only samples strictly after the floor are examined.
    let floorMs = -Infinity;
    if (isFiniteNumber(previousCandidateAtMs)) floorMs = Math.max(floorMs, previousCandidateAtMs);
    if (earliestApexPresent) floorMs = Math.max(floorMs, config.earliestApexMs);
    const afterFloor = ordered.filter((entry) => entry.atMs > floorMs);

    // The newest run of consecutive usable samples (no gap above the limit).
    let runStart = afterFloor.length - 1;
    while (runStart > 0 && afterFloor[runStart].atMs - afterFloor[runStart - 1].atMs <= cfg.maxSampleGapMs) {
        runStart -= 1;
    }
    const run = removeTurnOutliers(afterFloor.slice(Math.max(runStart, 0)), cfg.spikeThreshold);

    const baseEvidence = { runSampleCount: run.length, runStartAtMs: run.length > 0 ? run[0].atMs : null };

    if (run.length < cfg.confirmationSamples + 1) {
        return turnAssessment("none", "insufficient-history", null, baseEvidence);
    }

    const xs = run.map((entry) => entry.x);
    const found = findReversalPivots(xs, cfg.reversalDisplacement);
    const nearZeroZone = (x) => x < cfg.wallThreshold;
    const nearOneZone = (x) => x > 1 - cfg.wallThreshold;
    const delta = cfg.reversalDisplacement;
    const last = run.length - 1;

    // A confirmed turn can only be the MOST RECENT reversal.
    const latestPivot = found.pivots.length > 0 ? found.pivots[found.pivots.length - 1] : null;
    if (latestPivot) {
        const atWall = latestPivot.type === "min" ? nearZeroZone(xs[latestPivot.index]) : nearOneZone(xs[latestPivot.index]);
        if (atWall && latestPivot.approach >= delta) {
            const apexX = xs[latestPivot.index];
            const wallSide = latestPivot.type === "min" ? "near-zero" : "near-one";
            const away = (x) => (latestPivot.type === "min" ? x - apexX : apexX - x);

            const trailing = xs.slice(last - cfg.confirmationSamples + 1);
            const trailingStartsAfterApex = last - cfg.confirmationSamples + 1 > latestPivot.index;
            const recoverySwing = Math.min(...trailing.map(away));

            if (trailingStartsAfterApex && recoverySwing >= delta) {
                // The apex plateau: contiguous samples before the pivot that
                // are still within the plateau tolerance of its position.
                let apexIndex = latestPivot.index;
                while (apexIndex > 0 && Math.abs(xs[apexIndex - 1] - apexX) <= cfg.apexPlateauTolerance) {
                    apexIndex -= 1;
                }
                const apex = run[apexIndex];

                const laneDeviation = Math.abs(apex.noseY - cfg.referenceLaneY);
                if (laneDeviation > cfg.laneDeviationThreshold) {
                    return turnAssessment("rejected", "lane-deviation", null, {
                        ...baseEvidence, wallSide, apexAtMs: apex.atMs, laneDeviation
                    });
                }

                const depthIntoZone = wallSide === "near-zero" ? cfg.wallThreshold - apexX : apexX - (1 - cfg.wallThreshold);
                const wallProximityScore = clamp01(depthIntoZone / cfg.wallThreshold);
                const reversalScore = clamp01(Math.min(latestPivot.approach, recoverySwing) / (2 * delta));
                const visibilityScore = Math.min(...run.slice(apexIndex).map((entry) => entry.visibility));
                const laneAgreementScore = clamp01(1 - laneDeviation / cfg.laneDeviationThreshold);
                const confidence = clamp01(
                    cfg.wallProximityWeight * wallProximityScore +
                    cfg.reversalWeight * reversalScore +
                    cfg.visibilityWeight * visibilityScore +
                    cfg.laneAgreementWeight * laneAgreementScore
                );

                return turnAssessment("confirmed", "wall-reversal", {
                    atMs: apex.atMs,
                    confidence,
                    evidence: {
                        apexAtMs: apex.atMs,
                        confirmedAtMs: sample.atMs,
                        wallSide,
                        apexHipX: apexX,
                        approachSwing: latestPivot.approach,
                        recoverySwing,
                        laneDeviation,
                        visibility: visibilityScore,
                        wallProximityScore,
                        reversalScore,
                        laneAgreementScore,
                        runSampleCount: run.length
                    }
                }, null);
            }

            return turnAssessment("plausible", "recovery-not-sustained", null, {
                ...baseEvidence, wallSide, apexAtMs: run[latestPivot.index].atMs, approachSwing: latestPivot.approach
            });
        }
    }

    // No confirmed reversal. Is a wall approach under way (an unconfirmed
    // extreme in a wall zone that the swimmer travelled into)?
    const pending = [];
    if (found.direction <= 0) {
        const lowX = xs[found.pendingLow.index];
        if (nearZeroZone(lowX) && found.pendingLow.approach >= delta) {
            pending.push({ wallSide: "near-zero", index: found.pendingLow.index, approach: found.pendingLow.approach });
        }
    }
    if (found.direction >= 0) {
        const highX = xs[found.pendingHigh.index];
        if (nearOneZone(highX) && found.pendingHigh.approach >= delta) {
            pending.push({ wallSide: "near-one", index: found.pendingHigh.index, approach: found.pendingHigh.approach });
        }
    }
    if (pending.length > 0) {
        const nearest = pending[0];
        return turnAssessment("plausible", "awaiting-recovery", null, {
            ...baseEvidence,
            wallSide: nearest.wallSide,
            apexAtMs: run[nearest.index].atMs,
            approachSwing: nearest.approach
        });
    }

    return turnAssessment("none", "no-wall-reversal", null, baseEvidence);
}

// ---------------------------------------------------------------------
// OBSERVATION-GAP ASSESSMENT (Chronos reliability, phase 2C)
// ---------------------------------------------------------------------
//
// PURPOSE. A wall turn the pose never shows (it is lost around a tumble, or
// tracking drops) is simply not detected, and the distance label is a COUNT,
// so every later turn would be labelled one pool length too early. This
// function answers one narrow question about the interval between two
// consecutive usable observations: COULD A TURN HAVE BEEN CONCEALED IN IT?
// It never answers whether one WAS, how many, or what distance a later wall
// contact represents — it does not use elapsed time, speed, the race distance
// or an expected turn count to reason about that, and nothing here invents a
// turn.
//
// THE RULE (exact). Given the newest usable sample and the most recent usable
// sample before it, the interval is AMBIGUOUS when BOTH hold:
//   1. the gap between them is longer than `maxSampleGapMs` (600 ms) — the
//      very limit at which chronosAssessTurn() ends an observation run and
//      refuses to join evidence across it; and
//   2. at least one of the two bounding observations lies inside a wall zone
//      (hip.x < wallThreshold or hip.x > 1 - wallThreshold, the SAME zone and
//      strict comparison the turn assessment uses).
// A gap with BOTH ends outside both zones is "harmless" for this purpose.
// Samples that are not usable (malformed, low visibility, hip or nose
// missing) are not observations: they make the gap longer, never shorter.
//
// WHY THIS IS CONSERVATIVE, AND WHERE IT IS NOT. A turn needs a wall visit. A
// wall visit hidden between two observations that are both mid-pool would need
// an excursion of at least twice the distance to the zone edge; SwimmerTracking
// forwards a post-gap sample only if it matches the pre-gap motion (continuity
// error <= 0.08) and gives the target up after 1.5 s (loss) and 5 s
// (reacquisition), so a gap that long ends the analysis (ANALYSIS_DEGRADED)
// rather than resuming. The zone (0.25) is wider than the ~0.09-0.15
// frame-widths an ordinary swimmer covers in tracking's loss grace, so a turn
// concealed by a gap tracking still bridges has an endpoint inside it. This is
// a heuristic argument about the existing evidence, NOT a proof: it fails for
// framing in which the zone is narrower than that distance (a zoomed camera),
// and a mid-pool/mid-pool gap that hides a full excursion is not flagged. It
// also flags harmless gaps next to a wall (for example the swimmer already
// counted as having turned, pushing off underwater): by design, when the
// evidence cannot tell a harmless gap from a concealed turn, it says
// "possible".
//
// RESULT. { ambiguous, reason, evidence }:
//   reason "gap-adjacent-to-wall-zone"  — ambiguous: true
//   reason "gap-away-from-wall-zones"   — a long gap, both ends outside the zones
//   reason "continuous"                 — no gap above the limit
//   reason "no-previous-observation"    — nothing before this sample
//   reason "current-sample-unusable" / "invalid-sample" — not an observation
// `evidence.fromAtMs` is the last observation BEFORE the gap: the earliest
// point at which a concealed turn could affect distance assignment.
// Pure: no clock, DOM, session or module state.

function wallZoneOf(x, wallThreshold) {
    if (x < wallThreshold) return "near-zero";
    if (x > 1 - wallThreshold) return "near-one";
    return null;
}

/**
 * @param {object} args
 * @param {{atMs:number, hip:object, nose:object}} args.sample The newest sample.
 * @param {Array<{atMs:number, hip:object, nose:object}>} args.recentSamples Prior
 *   samples of the same target (any order; unusable and not-earlier entries ignored).
 * @param {object} [args.config] Overrides for TURN_ASSESSMENT_DEFAULTS
 *   (wallThreshold, maxSampleGapMs, minVisibility).
 * @returns {{ambiguous:boolean, reason:string, evidence:object|null}}
 */
export function chronosAssessObservationGap({ sample, recentSamples, config } = {}) {
    const cfg = { ...TURN_ASSESSMENT_DEFAULTS, ...(config || {}) };

    if (!sample || !isFiniteNumber(sample.atMs)) {
        return { ambiguous: false, reason: "invalid-sample", evidence: null };
    }
    const hip = extractLandmark(sample.hip);
    const nose = extractLandmark(sample.nose);
    if (!hip || !nose || Math.min(hip.visibility, nose.visibility) < cfg.minVisibility) {
        return { ambiguous: false, reason: "current-sample-unusable", evidence: null };
    }

    let previous = null;
    if (Array.isArray(recentSamples)) {
        for (const entry of recentSamples) {
            if (!entry || !isFiniteNumber(entry.atMs) || entry.atMs >= sample.atMs) continue;
            const entryHip = extractLandmark(entry.hip);
            const entryNose = extractLandmark(entry.nose);
            if (!entryHip || !entryNose || Math.min(entryHip.visibility, entryNose.visibility) < cfg.minVisibility) continue;
            if (previous === null || entry.atMs > previous.atMs) {
                previous = { atMs: entry.atMs, x: entryHip.x };
            }
        }
    }
    if (previous === null) {
        return { ambiguous: false, reason: "no-previous-observation", evidence: null };
    }

    const gapMs = sample.atMs - previous.atMs;
    const beforeWallSide = wallZoneOf(previous.x, cfg.wallThreshold);
    const afterWallSide = wallZoneOf(hip.x, cfg.wallThreshold);
    const evidence = {
        gapMs,
        fromAtMs: previous.atMs,
        toAtMs: sample.atMs,
        beforeHipX: previous.x,
        afterHipX: hip.x,
        beforeWallSide,
        afterWallSide
    };

    if (gapMs <= cfg.maxSampleGapMs) {
        return { ambiguous: false, reason: "continuous", evidence };
    }
    if (beforeWallSide !== null || afterWallSide !== null) {
        return { ambiguous: true, reason: "gap-adjacent-to-wall-zone", evidence };
    }
    return { ambiguous: false, reason: "gap-away-from-wall-zones", evidence };
}

// ---------------------------------------------------------------------
// COMPLETE REVERSAL OUTSIDE THE WALL ZONE (Chronos reliability, phase 2E)
// ---------------------------------------------------------------------
//
// THE GAP. chronosAssessTurn() accepts a reversal only when its APEX lies inside
// a wall zone (x < wallThreshold or x > 1 - wallThreshold). A real wall touch
// whose apex falls just OUTSIDE the zone (the camera frames more than the pool,
// the zone is narrower than the real margin to the wall) is therefore not a
// turn, is not a gap, is not refused by any gate, and reads "none /
// no-wall-reversal": distance stays "confirmed" and the NEXT wall is recorded one
// pool length too early. The public assessment does not even say that a
// reversal happened.
//
// WHAT THE EVIDENCE CAN AND CANNOT SAY. The observations contain a COMPLETE,
// SUSTAINED reversal — travel of at least `reversalDisplacement` toward an
// extreme, an apex, and travel of at least `reversalDisplacement` back that the
// last `confirmationSamples` samples hold — which ordinary motion (monotone
// swimming, stroke-cycle oscillation, jitter, single-sample outliers) never
// produces. They do NOT say whether that reversal was a wall: where the wall is
// in the frame is exactly what the observations lack (it would come from
// calibration). A genuine wall touch just outside the zone and a swimmer who stops
// mid-pool and returns look identical. So this function does NOT classify and
// does NOT claim a turn occurred: it reports, as a plain fact, "a complete
// reversal happened and the zone gate did not accept it". Whether that is a
// concealed wall turn or movement that is not a wall at all, the race's distance
// can no longer be trusted, which is the controller's conservative conclusion.
// It introduces NO new threshold: it is the same reversal evidence, the same
// floor and the same run as chronosAssessTurn(), with the zone test inverted.
//
// WHAT IT NEVER REPORTS: an approach without a completed reversal; a recovery
// that is not held; a reversal whose apex IS inside the zone (that is
// chronosAssessTurn()'s: confirmed, or refused by the lane gate); anything across
// an observation gap or from before the floor (the previous candidate's apex and
// the accepted start).
//
// PARTITION. For one input, a complete reversal is exactly one of: confirmed or
// lane-refused by chronosAssessTurn() (apex in a zone), or reported here (apex
// outside the zone for its type). A test pins that they never overlap.
//
// RESULT. { outside, reason, evidence }; `outside` true only with reason
// "complete-reversal-outside-wall-zone". `evidence.apexAtMs` is the plateau's
// first sample (the same apex timing as a turn candidate, with the same error
// bounds). `evidence.distanceOutsideZone` is how far the apex lies beyond the
// zone edge the swimmer was travelling toward (0 exactly at the strict boundary,
// which counts as outside). Pure: no clock, DOM, session or module state.

/**
 * @param {object} args Same inputs as chronosAssessTurn() (sample, recentSamples,
 *   previousCandidateAtMs, config with optional earliestApexMs). referenceLaneY
 *   is NOT required: the lane is irrelevant here.
 * @returns {{outside:boolean, reason:string, evidence:object|null}}
 */
export function chronosAssessReversalOutsideWallZone({ sample, recentSamples, previousCandidateAtMs, config } = {}) {
    const cfg = { ...TURN_ASSESSMENT_DEFAULTS, ...(config || {}) };
    const no = (reason, evidence = null) => ({ outside: false, reason, evidence });

    const earliestApexPresent = config && config.earliestApexMs !== undefined && config.earliestApexMs !== null;
    if (earliestApexPresent && (!isFiniteNumber(config.earliestApexMs) || config.earliestApexMs < 0)) {
        return no("invalid-earliest-apex");
    }
    if (!sample || !isFiniteNumber(sample.atMs)) {
        return no("invalid-sample");
    }
    const hip = extractLandmark(sample.hip);
    const nose = extractLandmark(sample.nose);
    if (!hip || !nose) {
        return no("invalid-sample");
    }
    const currentVisibility = Math.min(hip.visibility, nose.visibility);
    if (currentVisibility < cfg.minVisibility) {
        return no("low-visibility-sample");
    }

    const history = [];
    if (Array.isArray(recentSamples)) {
        for (const entry of recentSamples) {
            if (!entry || !isFiniteNumber(entry.atMs) || entry.atMs >= sample.atMs) {
                continue;
            }
            const entryHip = extractLandmark(entry.hip);
            const entryNose = extractLandmark(entry.nose);
            if (!entryHip || !entryNose) {
                continue;
            }
            const visibility = Math.min(entryHip.visibility, entryNose.visibility);
            if (visibility < cfg.minVisibility) {
                continue;
            }
            history.push({ atMs: entry.atMs, x: entryHip.x, noseY: entryNose.y, visibility });
        }
    }
    history.sort((a, b) => a.atMs - b.atMs);
    const ordered = history.filter((entry, index) => index === 0 || entry.atMs > history[index - 1].atMs);
    ordered.push({ atMs: sample.atMs, x: hip.x, noseY: nose.y, visibility: currentVisibility });

    let floorMs = -Infinity;
    if (isFiniteNumber(previousCandidateAtMs)) floorMs = Math.max(floorMs, previousCandidateAtMs);
    if (earliestApexPresent) floorMs = Math.max(floorMs, config.earliestApexMs);
    const afterFloor = ordered.filter((entry) => entry.atMs > floorMs);

    let runStart = afterFloor.length - 1;
    while (runStart > 0 && afterFloor[runStart].atMs - afterFloor[runStart - 1].atMs <= cfg.maxSampleGapMs) {
        runStart -= 1;
    }
    const run = removeTurnOutliers(afterFloor.slice(Math.max(runStart, 0)), cfg.spikeThreshold);
    if (run.length < cfg.confirmationSamples + 1) {
        return no("insufficient-history");
    }

    const xs = run.map((entry) => entry.x);
    const found = findReversalPivots(xs, cfg.reversalDisplacement);
    const latestPivot = found.pivots.length > 0 ? found.pivots[found.pivots.length - 1] : null;
    if (!latestPivot) {
        return no("no-complete-reversal");
    }

    const delta = cfg.reversalDisplacement;
    const apexX = xs[latestPivot.index];
    const isMax = latestPivot.type === "max";
    // the zone edge the swimmer was travelling TOWARD (a max pivot approached the near-one wall; a min, the near-zero wall)
    const zoneEdgeX = isMax ? 1 - cfg.wallThreshold : cfg.wallThreshold;
    const insideItsZone = isMax ? apexX > zoneEdgeX : apexX < zoneEdgeX;
    if (insideItsZone) {
        return no("apex-inside-wall-zone"); // chronosAssessTurn()'s: confirmed, plausible, or refused by the lane gate
    }
    if (latestPivot.approach < delta) {
        return no("no-complete-reversal");
    }

    const last = run.length - 1;
    const away = (x) => (isMax ? apexX - x : x - apexX);
    const trailingStart = last - cfg.confirmationSamples + 1;
    const recoverySwing = Math.min(...xs.slice(trailingStart).map(away));
    if (!(trailingStart > latestPivot.index) || recoverySwing < delta) {
        return no("no-complete-reversal");
    }

    let apexIndex = latestPivot.index;
    while (apexIndex > 0 && Math.abs(xs[apexIndex - 1] - apexX) <= cfg.apexPlateauTolerance) {
        apexIndex -= 1;
    }

    return {
        outside: true,
        reason: "complete-reversal-outside-wall-zone",
        evidence: {
            apexAtMs: run[apexIndex].atMs,
            confirmedAtMs: sample.atMs,
            apexHipX: apexX,
            apexType: latestPivot.type,
            approachedWallSide: isMax ? "near-one" : "near-zero",
            zoneEdgeX,
            distanceOutsideZone: isMax ? zoneEdgeX - apexX : apexX - zoneEdgeX,
            approachSwing: latestPivot.approach,
            recoverySwing,
            runSampleCount: run.length
        }
    };
}
