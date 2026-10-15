// Race pipeline — detector adapter.
//
// Pure, deterministic. Reshapes a confirmed target PoseSample
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §13's targetPoseSample — the
// ONLY thing this file ever consumes) into the exact input shapes the
// existing, unmodified start/turn detectors require
// (src/chronos-engine/detectors/start-detector.js,
// src/chronos-engine/detectors/turn-detector.js), calls them, and
// collects whatever candidate(s) they produce
// (docs/RACE_PIPELINE_ARCHITECTURE.md §7).
//
// This file never reimplements start/turn heuristics — chronosAssessStart
// (built on the chronosDetectStart primitive) and chronosDetectTurn remain
// the sole source of detection logic. Its
// only two jobs are (1) reshape {atMs, hasPose, landmarks:{hip,nose}} into
// each detector's own flat {atMs, nose}/{atMs, hip, nose} sample shape,
// and (2) hold the rolling history (baselineWindow / recentSamples /
// previousCandidateAtMs) neither detector remembers on its own
// (docs/RACE_PIPELINE_ARCHITECTURE.md §7: "Adapter-owned rolling state...
// neither detector keeps its own").
//
// A non-null detector return is a CANDIDATE, never an authoritative race
// event — this file never calls ChronosEngine, never decides acceptance,
// and never mutates race distance (docs/RACE_PIPELINE_ARCHITECTURE.md §17
// invariant 3). It does not import src/chronos-engine/index.js,
// session.js, or events.js at all.
//
// CANDIDATE CONTRACT NOTE: chronosAssessStart()/chronosDetectTurn()
// themselves return a bare {atMs, confidence, evidence} — they have no
// notion of their own name (docs/RACE_PIPELINE_ARCHITECTURE.md §7). The
// Stage 4D.5 candidate contract explicitly requires the candidate this
// file hands upward to also retain "detector identity". This file adds
// exactly one field, `detector`, tagging which detector function produced
// the candidate (START_DETECTOR_NAME / TURN_DETECTOR_NAME below) — this
// is pure provenance labeling, not new detection logic, and does not
// conflict with docs/RACE_PIPELINE_ARCHITECTURE.md §8's "source: 'detector',
// detector: <name>... assigned here [event-adapter.js], nowhere else":
// that sentence describes where the TimingEventInput's own `detector`
// field is constructed (event-adapter.js, §8) — event-adapter.js sources
// that value from this file's candidate.detector rather than
// re-deriving it, the same way it carries candidate.confidence through
// unchanged rather than recomputing it.
//
// OPEN CONFIGURATION NOTE (flagged, not resolved here): chronosDetectTurn
// requires a finite config.referenceLaneY with NO default (by the
// detector's own explicit design — see turn-detector.js's own header:
// "there is no default, since defaulting it would silently reproduce the
// legacy fragile 'first frame' baseline this detector deliberately
// avoids... the caller is expected to derive it from a stable window").
// Neither docs/RACE_PIPELINE_ARCHITECTURE.md nor this stage's task
// describes how race-pipeline should derive referenceLaneY. Rather than
// inventing an undocumented heuristic to compute it, this file treats
// `config` as an opaque, caller-supplied pass-through, exactly as it
// already does for every other detector config override — deriving
// referenceLaneY (from a stable early-window average, mirroring how the
// start detector's own baseline works, or otherwise) is left to whatever
// future stage owns the frame driver. Until a caller supplies it, turn
// detection simply returns no candidate, which is the detector's own
// already-tested, already-correct hard-gate behavior — not a gap this
// file needs to patch.

import { chronosAssessStart, START_ASSESSMENT_DEFAULTS } from "../chronos-engine/detectors/start-detector.js";
import { chronosDetectTurn } from "../chronos-engine/detectors/turn-detector.js";

export const START_DETECTOR_NAME = "start-detector-v1";
export const TURN_DETECTOR_NAME = "turn-detector-v1";

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

// Creates a fresh, independent detector-adapter state object. Call this
// once per analysis run (docs/RACE_PIPELINE_ARCHITECTURE.md §10) — never
// share one instance across two races/sessions. There is no module-level
// state anywhere in this file; every value the detectors need across
// calls lives on the object this function returns and the caller holds
// between calls.
export function racePipelineCreateDetectorState() {
    return {
        startBaselineWindow: [],
        turnRecentSamples: [],
        turnPreviousCandidateAtMs: null
    };
}

// Reshapes a targetPoseSample into chronosAssessStart()'s (and the
// chronosDetectStart() primitive's) exact sample
// shape: {atMs, nose}. Returns null only when there is no usable
// timestamp to work from at all (missing/malformed targetPoseSample) —
// a targetPoseSample with a valid atMs but an unusable/missing nose still
// produces {atMs, nose: null}, which the detector's own, already-tested
// landmark validation (extractLandmark()) correctly treats as unusable,
// without this file needing to duplicate that check.
export function racePipelineBuildStartDetectorSample(targetPoseSample) {
    if (!targetPoseSample || !isFiniteNumber(targetPoseSample.atMs)) {
        return null;
    }
    const nose = targetPoseSample.landmarks ? (targetPoseSample.landmarks.nose ?? null) : null;
    return { atMs: targetPoseSample.atMs, nose };
}

// Reshapes a targetPoseSample into chronosDetectTurn()'s exact sample
// shape: {atMs, hip, nose}. Same missing-landmark handling as the start
// mapping above — never fabricates a landmark, never substitutes another
// one.
export function racePipelineBuildTurnDetectorSample(targetPoseSample) {
    if (!targetPoseSample || !isFiniteNumber(targetPoseSample.atMs)) {
        return null;
    }
    const hip = targetPoseSample.landmarks ? (targetPoseSample.landmarks.hip ?? null) : null;
    const nose = targetPoseSample.landmarks ? (targetPoseSample.landmarks.nose ?? null) : null;
    return { atMs: targetPoseSample.atMs, hip, nose };
}

// Runs the start assessment for one targetPoseSample against the caller-held
// detectorState, and returns the (possibly null) candidate, the next
// detectorState, and the full assessment (state + reason) for diagnostics.
//
// The sample used for THIS call is evaluated against the history
// accumulated so far, then appended to that history for future calls —
// mirroring exactly how the detector's own test suite builds a baselineWindow
// disjoint from the current sample.
//
// HISTORY IS A BOUNDED ROLLING WINDOW (Chronos reliability phase 1). It used
// to be appended to unconditionally and never pruned (docs/
// RACE_PIPELINE_ARCHITECTURE.md §7 gave no maximum), which both grew without
// bound and let the baseline lag arbitrarily old data. It now keeps only
// samples within baselineWindowMs of the newest one
// (START_ASSESSMENT_DEFAULTS.baselineWindowMs, overridable via config).
//
// DUPLICATE / OUT-OF-ORDER SAMPLES are refused here, before the detector: a
// sample whose timestamp is not strictly later than the newest one already
// held carries no new information, must not be admitted to the history, and
// must not alter any decision. The very same detectorState object is
// returned (nothing was appended), and the assessment reports
// "non-monotonic-timestamp".
export function racePipelineDetectStartCandidate(targetPoseSample, detectorState, config) {
    const sample = racePipelineBuildStartDetectorSample(targetPoseSample);
    if (!sample) {
        return { candidate: null, detectorState, assessment: null };
    }

    const history = detectorState.startBaselineWindow;
    const newestAtMs = history.length > 0 ? history[history.length - 1].atMs : null;
    if (isFiniteNumber(newestAtMs) && sample.atMs <= newestAtMs) {
        return {
            candidate: null,
            detectorState,
            assessment: { state: "rejected", reason: "non-monotonic-timestamp", candidate: null, evidence: null }
        };
    }

    const result = chronosAssessStart({
        sample,
        baselineWindow: history,
        config
    });

    const candidate = result.candidate
        ? {
              atMs: result.candidate.atMs,
              confidence: result.candidate.confidence,
              evidence: result.candidate.evidence,
              detector: START_DETECTOR_NAME
          }
        : null;

    const windowMs = config && isFiniteNumber(config.baselineWindowMs) && config.baselineWindowMs > 0
        ? config.baselineWindowMs
        : START_ASSESSMENT_DEFAULTS.baselineWindowMs;
    const oldestKeptAtMs = sample.atMs - windowMs;

    const nextDetectorState = {
        ...detectorState,
        startBaselineWindow: [...history.filter((entry) => entry.atMs >= oldestKeptAtMs), sample]
    };

    return { candidate, detectorState: nextDetectorState, assessment: result };
}

// Runs the turn detector for one targetPoseSample against the caller-held
// detectorState. Same evaluate-then-append ordering as the start detector
// above; additionally threads previousCandidateAtMs through for the turn
// detector's own local re-fire suppression
// (src/chronos-engine/detectors/turn-detector.js's detectorSuppressionMs),
// updating it only when this call actually produces a candidate.
export function racePipelineDetectTurnCandidate(targetPoseSample, detectorState, config) {
    const sample = racePipelineBuildTurnDetectorSample(targetPoseSample);
    if (!sample) {
        return { candidate: null, detectorState };
    }

    const rawCandidate = chronosDetectTurn({
        sample,
        recentSamples: detectorState.turnRecentSamples,
        previousCandidateAtMs: detectorState.turnPreviousCandidateAtMs,
        config
    });

    const candidate = rawCandidate
        ? {
              atMs: rawCandidate.atMs,
              confidence: rawCandidate.confidence,
              evidence: rawCandidate.evidence,
              detector: TURN_DETECTOR_NAME
          }
        : null;

    const nextDetectorState = {
        ...detectorState,
        turnRecentSamples: [...detectorState.turnRecentSamples, sample],
        turnPreviousCandidateAtMs: candidate ? candidate.atMs : detectorState.turnPreviousCandidateAtMs
    };

    return { candidate, detectorState: nextDetectorState };
}
