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

// ---------------------------------------------------------------------
// Windowed start assessment (Chronos reliability, phases 1 and 1B)
// ---------------------------------------------------------------------
//
// chronosDetectStart() above answers ONE question about ONE sample: "does
// this sample depart from the baseline I was handed by at least
// displacementThreshold?". That is a displacement primitive, not a start
// decision. Used alone as one it had these defects, reproduced against the
// real pipeline with SYNTHETIC trajectories (docs/RACE_PIPELINE_ARCHITECTURE.md
// §7.2):
//
//   - the caller's baseline was the mean of ALL history, so a swimmer who
//     was already moving, or a slow drift, still produced a "start";
//   - one sample over threshold was enough, with no notion of a candidate
//     that is merely plausible or ambiguous;
//   - the time of the threshold crossing was reported as the start, later
//     than the onset of motion by however long the swimmer needs to cover
//     the threshold distance.
//
// chronosAssessStart() is the hardened decision built ON TOP of that
// primitive (it calls chronosDetectStart() for the displacement/confidence
// evidence rather than reimplementing it). Same file, same inputs
// (sample + caller-held history), still pure and stateless.
//
// States returned:
//   "none"       the current sample is inside the reference run's envelope
//                ("stationary", including returning to rest after an
//                excursion), or is departing but still below the
//                displacement threshold ("below-threshold").
//   "plausible"  the current sample is past the displacement threshold on
//                one side but the departure has not yet been confirmed.
//   "ambiguous"  conflicting evidence: the departure begins immediately
//                after beyond-envelope samples on the opposite side
//                ("direction-reversal"), it was not sustained, or the
//                confirming samples are too far apart in time.
//   "confirmed"  eligible to become a candidate Chronos may accept.
//   "rejected"   a hard gate failed: invalid or low-visibility sample, a
//                non-monotonic timestamp, a departure that begins before the
//                pre-start reference frame ("onset-before-reference-frame"),
//                an unusable reference ("invalid-reference-frame"), or
//                "no-stationary-baseline" (this
//                reason covers BOTH "fewer than minBaselineSamples usable
//                samples in the window yet" and "no such run within the
//                noise band", e.g. a swimmer who is already moving).
// Only "confirmed" carries a `candidate`. A candidate is still a proposal:
// Chronos alone decides acceptance.
//
// REFERENCE RUN: the most recent run of at least minBaselineSamples
// consecutive usable samples whose total spread (max - min of nose.x) stays
// within a noise band. noiseBand = baselineNoiseBandFraction *
// displacementThreshold: the reference may not itself wobble by more than a
// quarter of the movement the detector is trying to detect (a 4:1 signal-to-
// noise requirement). The history considered is a rolling window of
// baselineWindowMs, so the reference cannot lag arbitrarily old data.
//
// PRE-START REFERENCE FRAME (optional `config.referenceFrameMs`, media time in
// ms): the user marks a frame BEFORE the start. A departure whose FIRST sample
// is earlier than it is refused ("rejected", "onset-before-reference-frame"),
// so pre-race walking, a position adjustment, or a mid-race wall push-off
// that precedes the marked frame can never be proposed as the start. Samples
// before the reference are NOT discarded: stationary samples just before it
// are a legitimate baseline (a frame marked right before the motion has no
// stationary footage after it). The constraint is on where the DEPARTURE
// BEGINS, not on which samples exist. A departure that begins before the
// reference and continues past it is refused as a whole (it is not truncated
// to the reference, which would invent an onset the swimmer did not have).
// A reference that is present but not a finite, non-negative number is
// refused outright ("rejected", "invalid-reference-frame"); it never degrades
// into "no constraint". Absent (undefined/null) means the caller supplied no
// context and the search is unconstrained — the race pipeline's controller
// never does that (it requires a reference). The reference is where the
// swimmer is marked at rest; it is NOT the race start and NOT the onset.
//
// "AT REST" for later samples is judged against the run's ENVELOPE, exactly
// as the run was formed (a sample is rest-consistent when adding it would not
// widen the run's spread beyond the noise band), NOT against the run's mean:
// a short run can include the first, still-tiny steps of the departure,
// which shifts its mean. The mean is used only for displacement magnitudes.
//
// DEPARTURE: the contiguous run of samples, ending at the current one, that
// lie beyond the envelope on the current sample's side. A stray sample
// separated from it by at least one rest-consistent sample is not part of it
// (so a lone spike before the onset can neither move the onset earlier nor
// veto the start). One tolerance: a SINGLE glitch sample (back inside the
// envelope, or on the opposite side) with two or more same-side samples to
// its left is bridged as a dropout inside an established departure.
// Demonstrated limits (synthetic): an outlier directly ADJACENT to a fast
// departure (one whose first departing sample is already beyond the
// envelope, roughly 0.17 frame-widths/s at the page's 120 ms cadence) is
// indistinguishable from it and pulls the onset earlier by the number of
// adjacent samples; a dropout among the first few departing samples delays
// the onset by 1-2 samples; two or more CONSECUTIVE dropouts before
// confirmation delay the onset to after them.
//
// CANDIDATE TIME: candidate.atMs is the first sample of the departure — an
// ESTIMATE of when motion began, NOT the later instant at which the
// displacement threshold was crossed or confirmation completed
// (evidence.confirmedAtMs). It is not an official starter's signal. What has
// been DEMONSTRATED, on synthetic trajectories only: for a clean,
// constant-speed, gap-free departure the estimate is the first sample more
// than noiseBand beyond rest: measured errors of +240 to +440 ms at 0.058 to
// 0.096 frame-widths/s, and between 0 and noiseBand/speed + one sampling
// interval across 0.06-0.14 (never negative in those runs). It is later than
// that for accelerating
// starts (+1,080 ms at 0.05 frame-widths/s^2), for a tracking gap that covers
// the onset (the first sample after the gap), and under pose jitter
// (median +1,440 ms and up to +4,920 ms at +/-0.01 jitter). It has not been
// validated against real footage. See docs/RACE_PIPELINE_ARCHITECTURE.md
// §7.2 for the measured tables and the limitations, including the false-
// start modes that need start context rather than thresholds.
//
// All defaults below are provisional, documented, and NOT validated against
// real swim footage.
export const START_ASSESSMENT_DEFAULTS = Object.freeze({
    // Rolling history length considered for the reference, in ms. It must
    // cover the stationary reference (minBaselineSamples at the page's 120 ms
    // cadence = 0.6 s), the time to cross the displacement threshold, and
    // the confirmation span. It is NOT a guarantee that slow departures are
    // detected: departures slower than roughly 0.04 frame-widths/s are not
    // detected at all (their recent samples look stationary), and with
    // +/-0.005 pose jitter detection is unreliable up to about 0.06
    // (measured on synthetic data; docs §7.2).
    baselineWindowMs: 4000,

    // Consecutive usable samples, all at or beyond displacementThreshold on
    // one side of the reference, required to confirm a departure. 1 would
    // reproduce the old single-sample behavior; 2 would let two coincident
    // pose glitches confirm; 3 is the smallest count that requires the
    // displacement to persist across more than one sampling interval and not
    // be created by one or two glitch samples. A glitch inside the three
    // confirming samples delays confirmation; it does not tolerate it.
    // Unitless.
    confirmationSamples: 3,

    // The confirming samples must fall within this span, in ms: they must
    // look like one continuous departure, not three sparse sightings.
    maxConfirmationSpanMs: 1000,

    // Fraction of displacementThreshold the reference run's own spread may
    // occupy (see REFERENCE RUN above). Unitless.
    baselineNoiseBandFraction: 0.25
});

function assessment(state, reason, candidate = null, evidence = null) {
    return { state, reason, candidate, evidence };
}

// Usable history, ordered by time: finite atMs, a well-formed nose, and
// visibility at or above minVisibility. Unusable entries are dropped, never
// repaired. Returns a fresh array; never mutates the caller's.
function usableSeries(baselineWindow, minVisibility) {
    if (!Array.isArray(baselineWindow)) {
        return [];
    }
    const series = [];
    for (const entry of baselineWindow) {
        if (!entry || !isFiniteNumber(entry.atMs)) {
            continue;
        }
        const nose = extractLandmark(entry.nose);
        if (!nose || nose.visibility < minVisibility) {
            continue;
        }
        series.push({ atMs: entry.atMs, nose });
    }
    return series.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Assesses whether the current sample completes a confirmed start.
 *
 * @param {object} args
 * @param {{atMs:number, nose:{x:number,y:number,visibility:number}}} args.sample
 *   The current frame's sample (already the confirmed target's pose).
 * @param {Array<{atMs:number, nose:object}>} args.baselineWindow
 *   Caller-held history of PRIOR samples (strictly earlier than `sample`).
 * @param {object} [args.config] Overrides for DEFAULT_CONFIG and
 *   START_ASSESSMENT_DEFAULTS.
 * @returns {{state:string, reason:string, candidate:object|null, evidence:object|null}}
 */
export function chronosAssessStart({ sample, baselineWindow, config } = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...START_ASSESSMENT_DEFAULTS, ...(config || {}) };

    const hasReference = cfg.referenceFrameMs !== undefined && cfg.referenceFrameMs !== null;
    if (hasReference && (!isFiniteNumber(cfg.referenceFrameMs) || cfg.referenceFrameMs < 0)) {
        return assessment("rejected", "invalid-reference-frame");
    }

    if (!sample || !isFiniteNumber(sample.atMs)) {
        return assessment("rejected", "invalid-sample");
    }

    const nose = extractLandmark(sample.nose);
    if (!nose) {
        return assessment("rejected", "invalid-sample");
    }
    if (nose.visibility < cfg.minVisibility) {
        return assessment("rejected", "low-visibility-sample");
    }

    const history = usableSeries(baselineWindow, cfg.minVisibility);

    // A duplicate or out-of-order observation carries no new information
    // and must not be allowed to alter a decision.
    if (history.length > 0 && history[history.length - 1].atMs >= sample.atMs) {
        return assessment("rejected", "non-monotonic-timestamp");
    }

    const windowStartMs = sample.atMs - cfg.baselineWindowMs;
    const series = history.filter((entry) => entry.atMs >= windowStartMs);
    series.push({ atMs: sample.atMs, nose });

    const noiseBand = cfg.baselineNoiseBandFraction * cfg.displacementThreshold;

    // Latest run of >= minBaselineSamples consecutive samples whose spread
    // stays within the noise band. Search newest-first so the reference is
    // the swimmer's most recent resting position.
    let runStart = -1;
    let runEnd = -1;
    for (let end = series.length - 1; end >= cfg.minBaselineSamples - 1; end -= 1) {
        let low = series[end].nose.x;
        let high = low;
        let start = end;
        while (start > 0) {
            const x = series[start - 1].nose.x;
            if (Math.max(high, x) - Math.min(low, x) > noiseBand) {
                break;
            }
            low = Math.min(low, x);
            high = Math.max(high, x);
            start -= 1;
        }
        if (end - start + 1 >= cfg.minBaselineSamples) {
            runStart = start;
            runEnd = end;
            break;
        }
    }

    if (runEnd === -1) {
        return assessment("rejected", "no-stationary-baseline", null, {
            windowSampleCount: series.length,
            noiseBand
        });
    }

    // The current sample is inside the stationary run: nothing has departed.
    if (runEnd === series.length - 1) {
        return assessment("none", "stationary", null, { baselineSampleCount: runEnd - runStart + 1, noiseBand });
    }

    const baseline = series.slice(runStart, runEnd + 1);
    const afterRun = series.slice(runEnd + 1);
    const baselineX = meanOf(baseline.map((entry) => entry.nose.x));

    // Deviations from the reference, as observed.
    const deviations = afterRun.map((entry) => entry.nose.x - baselineX);
    const currentDeviation = deviations[deviations.length - 1];

    const baseEvidence = {
        baselinePositionX: baselineX,
        baselineSampleCount: baseline.length,
        noiseBand,
        currentDeviation
    };

    // "At rest" is judged against the reference run's own ENVELOPE, exactly
    // as the run itself was formed: a sample is rest-consistent when adding
    // it to the run would not widen the run's spread beyond the noise band.
    // (Not "within the band of the run's mean": a short run can include the
    // first, still-tiny steps of a departure, which shifts its mean and
    // would make the true first departing sample look like rest.) Expressed
    // as deviations from the mean, the run spans [lowEdge, highEdge].
    const referenceXs = baseline.map((entry) => entry.nose.x);
    const lowEdge = Math.min(...referenceXs) - baselineX;
    const highEdge = Math.max(...referenceXs) - baselineX;
    const beyondUp = (d) => d - lowEdge > noiseBand;
    const beyondDown = (d) => highEdge - d > noiseBand;

    // Back inside the reference envelope: at rest, nothing departed (an
    // earlier excursion that has since returned is forgotten).
    if (!beyondUp(currentDeviation) && !beyondDown(currentDeviation)) {
        return assessment("none", "stationary", null, baseEvidence);
    }

    // The departure is the CONTIGUOUS run of samples, ending at the current
    // one, that sit beyond the envelope on the current sample's side.
    // Scanning back from the newest sample (rather than taking everything
    // after the reference run) keeps a stray sample that is separated from
    // the departure by rest-consistent samples OUT of it, so a lone spike
    // before the onset can neither move the onset earlier nor veto the start.
    //
    // One tolerance: a SINGLE glitch sample (back inside the envelope, or on
    // the opposite side) that sits between the current departure and TWO OR
    // MORE same-side samples to its left is bridged, i.e. treated as a
    // dropout inside an established departure. A lone spike is a run of one
    // and is never bridged. Two or more consecutive glitch samples are not
    // bridged either (documented limitation).
    const side = beyondUp(currentDeviation) ? 1 : -1;
    const beyondOnSide = side > 0 ? beyondUp : beyondDown;
    const beyondOpposite = side > 0 ? beyondDown : beyondUp;
    let suffixStart = deviations.length - 1;
    while (suffixStart > 0) {
        const previous = suffixStart - 1;
        if (beyondOnSide(deviations[previous])) {
            suffixStart = previous;
        } else if (
            previous >= 2 &&
            beyondOnSide(deviations[previous - 1]) &&
            beyondOnSide(deviations[previous - 2])
        ) {
            suffixStart = previous;
        } else {
            break;
        }
    }
    const departure = afterRun.slice(suffixStart);
    const departureDeviations = deviations.slice(suffixStart);
    const departureEvidence = { ...baseEvidence, departureSampleCount: departure.length };

    // Context: the departure must begin at or after the pre-start reference
    // frame. Checked before everything else about the departure so the
    // diagnostics say WHY it was refused and which onset was refused.
    if (hasReference && departure[0].atMs < cfg.referenceFrameMs) {
        return assessment("rejected", "onset-before-reference-frame", null, {
            ...departureEvidence,
            onsetAtMs: departure[0].atMs,
            referenceFrameMs: cfg.referenceFrameMs
        });
    }

    // A departure that begins IMMEDIATELY after beyond-band samples on the
    // opposite side (no rest-consistent sample between them) is an
    // oscillation, not a start.
    if (suffixStart > 0 && beyondOpposite(deviations[suffixStart - 1])) {
        return assessment("ambiguous", "direction-reversal", null, departureEvidence);
    }

    if (Math.abs(currentDeviation) < cfg.displacementThreshold) {
        return departureDeviations.some((d) => Math.abs(d) >= cfg.displacementThreshold)
            ? assessment("ambiguous", "departure-not-sustained", null, departureEvidence)
            : assessment("none", "below-threshold", null, departureEvidence);
    }

    const needed = cfg.confirmationSamples;
    if (departure.length < needed) {
        return assessment("plausible", "awaiting-confirmation", null, departureEvidence);
    }

    const tail = departure.slice(-needed);
    const tailPast = tail.every((entry) => Math.abs(entry.nose.x - baselineX) >= cfg.displacementThreshold);
    if (!tailPast) {
        return assessment("plausible", "awaiting-confirmation", null, departureEvidence);
    }

    const spanMs = tail[tail.length - 1].atMs - tail[0].atMs;
    if (spanMs > cfg.maxConfirmationSpanMs) {
        return assessment("ambiguous", "confirmation-span-exceeded", null, { ...departureEvidence, confirmationSpanMs: spanMs });
    }

    // Displacement/confidence evidence comes from the primitive itself,
    // evaluated for each confirming sample against the stationary reference.
    // The candidate takes the LEAST confident of them: a departure is only
    // as convincing as its weakest confirming sample.
    const referenceWindow = baseline.map((entry) => ({ atMs: entry.atMs, nose: entry.nose }));
    const tailCandidates = tail.map((entry) =>
        chronosDetectStart({ sample: { atMs: entry.atMs, nose: entry.nose }, baselineWindow: referenceWindow, config: cfg })
    );
    if (tailCandidates.some((candidate) => candidate === null)) {
        return assessment("plausible", "awaiting-confirmation", null, departureEvidence);
    }

    const weakest = tailCandidates.reduce((min, candidate) => (candidate.confidence < min.confidence ? candidate : min));
    const current = tailCandidates[tailCandidates.length - 1];
    const onsetAtMs = departure[0].atMs;

    return assessment("confirmed", "sustained-departure", {
        atMs: onsetAtMs,
        confidence: weakest.confidence,
        evidence: {
            ...current.evidence,
            onsetAtMs,
            confirmedAtMs: sample.atMs,
            confirmationSamples: needed,
            confirmationSpanMs: spanMs,
            departureSampleCount: departure.length,
            noiseBand,
            referenceFrameMs: hasReference ? cfg.referenceFrameMs : null
        }
    }, departureEvidence);
}
