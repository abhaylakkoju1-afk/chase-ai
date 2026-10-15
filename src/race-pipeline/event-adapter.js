// Race pipeline — event adapter.
//
// Pure with respect to browser/DOM/clock concerns, but — unlike every
// other race-pipeline adapter — genuinely STATEFUL: it owns cumulative
// race-distance bookkeeping (docs/RACE_PIPELINE_ARCHITECTURE.md §9,
// "the only adapter-owned piece of state that is more than a rolling
// window"). This is the sole authoritative bridge between a detector
// candidate and ChronosEngine.recordEvent() — a candidate is never
// authoritative until Chronos says so (§17 invariant 3/6).
//
// This file never reads Date.now(), video.currentTime, performance.now(),
// or any other clock; never touches the DOM, localStorage, or Firebase;
// and does not import SwimmerTracking or the detectors directly — it only
// ever sees an already-produced detector candidate (from
// detector-adapter.js) and a caller-held Chronos RaceSession. It imports
// ONLY src/chronos-engine/index.js (ChronosEngine) and, for the two
// detector-name constants, its sibling detector-adapter.js — never
// session.js/events.js directly, keeping the same "use the public
// surface" discipline docs/CHRONOS_ARCHITECTURE.md §18 establishes for
// every other caller of Chronos.
//
// DISTANCE BOOKKEEPING (docs/RACE_PIPELINE_ARCHITECTURE.md §9, Decision
// 2 — the critical rule this file exists to enforce): for a turn
// candidate, the tentative next distance
// (confirmedDistanceMeters + session.poolLengthMeters) is computed and
// submitted to Chronos BEFORE this file's own counter is touched.
// confirmedDistanceMeters is advanced to that tentative value ONLY if
// ChronosEngine.recordEvent() reports acceptance (result.ok === true). A
// rejected candidate leaves confirmedDistanceMeters exactly as it was —
// the next candidate (whenever it arrives) is computed against that same,
// un-advanced base, never against a value that moved on without Chronos's
// agreement.
//
// RACE-DISTANCE PRECONDITIONS (Chronos reliability, phase 2). This file
// ASSIGNS a turn's distance (confirmed + one pool length), so it must know
// what the legal progression is, from the session's own configuration and
// nowhere else: session.poolLengthMeters and session.distanceMeters (the race
// distance derived from the selected event). It refuses to guess:
//   - race distance absent/invalid        -> "race-distance-unknown"
//   - race distance not a whole number of
//     pool lengths (e.g. 60 m in a 25 m pool) -> "race-distance-not-multiple-of-pool-length"
// With a valid configuration the legal turns are exactly the pool-length
// multiples strictly below the race distance (a 50 m race in a 25 m pool has
// ONE turn, at 25 m; a 50 m race in a 50 m pool has none). The upper bound
// itself — no turn at or beyond the race distance, no event past it — is
// enforced by ChronosEngine.recordEvent() (src/chronos-engine/events.js), the
// authoritative layer; its reason is propagated verbatim. This file never
// clamps an over-distance turn down to the race distance and never relabels
// it as a finish.
//
// KNOWN LIMITATION — MISSED TURNS. The distance label is a COUNT: the Nth
// accepted turn is labelled N pool lengths. If a real wall contact is never
// detected (the pose is lost around a tumble turn, tracking drops, the
// recovery is not observed), nothing here can know it was missed, and every
// later turn is labelled one pool length too EARLY (the next wall is reported
// as 25 m when it is really 50 m). A measured synthetic example and the
// options considered are in docs/RACE_PIPELINE_ARCHITECTURE.md §9.1. Neither
// this file nor Chronos invents the missing turn or its split.
//
// START DISTANCE: deliberately excluded from confirmedDistanceMeters
// entirely (docs/RACE_PIPELINE_ARCHITECTURE.md §9: "start is deliberately
// excluded from this counter... its distanceMeters defaults to 0 inside
// Chronos itself"). This file does not pass a distanceMeters for a start
// TimingEventInput at all — Chronos's own existing default (0, via
// events.js's buildEvent()) is what applies, so this file never invents
// its own interpretation of what a start's distance means.
//
// ACCEPTANCE: ChronosEngine.recordEvent()'s real, already-tested
// {ok, reason, session, event} result is trusted verbatim, in both
// directions — never retried, never overridden, never second-guessed.
// Every Chronos rejection reason (duplicate start, finish-before-start,
// out-of-order distance, too-soon-after-previous, illegal event type for
// the session's current status, etc.) propagates through this file's own
// return value unchanged.

import { ChronosEngine } from "../chronos-engine/index.js";
import { START_DETECTOR_NAME, TURN_DETECTOR_NAME } from "./detector-adapter.js";

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value) {
    return isFiniteNumber(value) && value > 0;
}

// Creates a fresh, independent event-adapter state object —
// confirmedDistanceMeters always starts at 0
// (docs/RACE_PIPELINE_ARCHITECTURE.md §9, §10). This IS the adapter's
// reset/initialization mechanism (Stage 4D.5 §11): call it again for a
// new race/session rather than reusing an old instance. There is no
// module-level mutable state anywhere in this file for a stale value to
// hide in.
export function racePipelineCreateEventAdapterState() {
    return { confirmedDistanceMeters: 0 };
}

// Validates a detector candidate's shape before it is ever turned into a
// TimingEventInput, independent of Chronos. Returns a stable reason
// string, or null when the shape is valid and its `detector` field
// matches the one this specific submission function expects (a start
// candidate handed to the turn submission function, or vice versa, is
// exactly the "unknown detector" case — this function is only ever
// called with one fixed expectedDetectorName per call site below).
function validateCandidateShape(candidate, expectedDetectorName) {
    if (!candidate || typeof candidate !== "object") {
        return "missing-candidate";
    }
    if (!isFiniteNumber(candidate.atMs)) {
        return "invalid-candidate-timestamp";
    }
    if (
        typeof candidate.confidence !== "number" ||
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence < 0 ||
        candidate.confidence > 1
    ) {
        return "invalid-candidate-confidence";
    }
    if (candidate.detector !== expectedDetectorName) {
        return "unknown-detector";
    }
    return null;
}

function rejectBeforeChronos(session, eventAdapterState, reason) {
    return { ok: false, reason, session: session ?? null, event: null, eventAdapterState };
}

/**
 * Submits a start-detector candidate as a Chronos "start" TimingEvent.
 * Never touches confirmedDistanceMeters — start is not part of the
 * distance-bookkeeping chain (see header note).
 *
 * @param {object} session The caller-held Chronos RaceSession.
 * @param {{atMs:number, confidence:number, evidence:object, detector:string}} candidate
 *   A candidate as produced by detector-adapter.js's
 *   racePipelineDetectStartCandidate() — must carry
 *   detector === "start-detector-v1".
 * @param {{confirmedDistanceMeters:number}} eventAdapterState
 * @returns {{ok:boolean, reason:string|null, session:object|null, event:object|null, eventAdapterState:object}}
 */
export function racePipelineSubmitStartCandidate(session, candidate, eventAdapterState) {
    const shapeReason = validateCandidateShape(candidate, START_DETECTOR_NAME);
    if (shapeReason) {
        return rejectBeforeChronos(session, eventAdapterState, shapeReason);
    }

    const input = {
        type: "start",
        atMs: candidate.atMs,
        source: "detector",
        detector: candidate.detector,
        confidence: candidate.confidence
    };

    const result = ChronosEngine.recordEvent(session, input);

    return {
        ok: result.ok,
        reason: result.reason,
        session: result.session,
        event: result.event,
        // Unchanged regardless of acceptance — start never advances
        // confirmedDistanceMeters (header note).
        eventAdapterState
    };
}

/**
 * Submits a turn-detector candidate as a Chronos "turn" TimingEvent,
 * applying the mandatory tentative-then-commit distance ordering
 * (docs/RACE_PIPELINE_ARCHITECTURE.md §9, Decision 2 — see header note).
 *
 * @param {object} session The caller-held Chronos RaceSession. Must carry
 *   a valid session.poolLengthMeters (a positive finite number) — this is
 *   normally guaranteed by chronosCreateSession()'s own validation, but is
 *   re-checked defensively here since this function trusts nothing about
 *   its caller.
 * @param {{atMs:number, confidence:number, evidence:object, detector:string}} candidate
 *   A candidate as produced by detector-adapter.js's
 *   racePipelineDetectTurnCandidate() — must carry
 *   detector === "turn-detector-v1".
 * @param {{confirmedDistanceMeters:number}} eventAdapterState
 * @returns {{ok:boolean, reason:string|null, session:object|null, event:object|null, eventAdapterState:object}}
 *   eventAdapterState.confirmedDistanceMeters advances to the tentative
 *   distance ONLY when ok === true; otherwise it is byte-for-byte the
 *   same object that was passed in.
 */
export function racePipelineSubmitTurnCandidate(session, candidate, eventAdapterState) {
    const shapeReason = validateCandidateShape(candidate, TURN_DETECTOR_NAME);
    if (shapeReason) {
        return rejectBeforeChronos(session, eventAdapterState, shapeReason);
    }

    if (!session || !isPositiveFiniteNumber(session.poolLengthMeters)) {
        return rejectBeforeChronos(session, eventAdapterState, "invalid-pool-length-meters");
    }

    if (!isPositiveFiniteNumber(session.distanceMeters)) {
        return rejectBeforeChronos(session, eventAdapterState, "race-distance-unknown");
    }
    const poolLengthsInRace = session.distanceMeters / session.poolLengthMeters;
    if (Math.abs(poolLengthsInRace - Math.round(poolLengthsInRace)) > 1e-9) {
        return rejectBeforeChronos(session, eventAdapterState, "race-distance-not-multiple-of-pool-length");
    }

    // Tentative — not yet persisted to eventAdapterState. Computed against
    // the CURRENT confirmedDistanceMeters, before Chronos's decision is
    // known (docs/RACE_PIPELINE_ARCHITECTURE.md §9 step 1).
    const tentativeDistanceMeters = eventAdapterState.confirmedDistanceMeters + session.poolLengthMeters;

    const input = {
        type: "turn",
        atMs: candidate.atMs,
        distanceMeters: tentativeDistanceMeters,
        source: "detector",
        detector: candidate.detector,
        confidence: candidate.confidence
    };

    const result = ChronosEngine.recordEvent(session, input);

    const nextEventAdapterState = result.ok
        ? { ...eventAdapterState, confirmedDistanceMeters: tentativeDistanceMeters }
        : eventAdapterState;

    return {
        ok: result.ok,
        reason: result.reason,
        session: result.session,
        event: result.event,
        eventAdapterState: nextEventAdapterState
    };
}
