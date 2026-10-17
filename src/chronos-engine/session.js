// Chronos engine — session creation and lifecycle.
//
// Pure, deterministic, browser-independent. Implements the RaceSession
// contract (docs/CHRONOS_ARCHITECTURE.md §5) and state machine (§9).
//
// This module never reads Date.now(), video.currentTime, performance.now(),
// or any other browser/system clock — every timestamp is supplied by the
// caller. It does not touch the DOM, localStorage, Firebase, or MediaPipe,
// and it does not import from src/chase-engine/*.
//
// A real ES module (this repo's package.json already declares
// "type": "module"), not a classic script — see the index.js header for
// why that's the deliberate choice for src/chronos-engine/*
// (docs/CHRONOS_ARCHITECTURE.md §18).

export const SESSION_STATUSES = Object.freeze([
    "idle",
    "armed",
    "running",
    "finished",
    "aborted"
]);

export const TIME_SOURCES = Object.freeze(["video", "manual", "wallclock"]);

// Legal status transitions (docs/CHRONOS_ARCHITECTURE.md §9). A transition
// not listed here is rejected by chronosTransition(), never silently
// applied.
const LEGAL_TRANSITIONS = Object.freeze({
    idle: Object.freeze(["armed", "aborted"]),
    armed: Object.freeze(["running", "aborted"]),
    running: Object.freeze(["finished", "aborted"]),
    finished: Object.freeze([]),
    aborted: Object.freeze([])
});

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Validates the parameters chronosCreateSession() was called with, before
// any RaceSession object is built. Returns a stable reason string
// identifying exactly which parameter failed, or null when every required
// parameter is valid.
export function chronosValidateSessionParams(params) {
    if (!params || typeof params !== "object") {
        return "missing-params";
    }

    if (!isNonEmptyString(params.sessionId)) {
        return "missing-session-id";
    }

    if (!isPositiveFiniteNumber(params.poolLengthMeters)) {
        return "invalid-pool-length-meters";
    }

    if (!isNonEmptyString(params.course)) {
        return "missing-course";
    }

    if (!isNonEmptyString(params.event)) {
        return "missing-event";
    }

    if (!TIME_SOURCES.includes(params.timeSource)) {
        return "invalid-time-source";
    }

    if (
        params.strokeKey !== null &&
        params.strokeKey !== undefined &&
        !isNonEmptyString(params.strokeKey)
    ) {
        return "invalid-stroke-key";
    }

    if (
        params.distanceMeters !== null &&
        params.distanceMeters !== undefined &&
        !isPositiveFiniteNumber(params.distanceMeters)
    ) {
        return "invalid-distance-meters";
    }

    if (
        params.createdAtMs !== null &&
        params.createdAtMs !== undefined &&
        (typeof params.createdAtMs !== "number" || !Number.isFinite(params.createdAtMs))
    ) {
        return "invalid-created-at-ms";
    }

    return null;
}

// Creates a new RaceSession (docs/CHRONOS_ARCHITECTURE.md §5) in "idle"
// status. sessionId, poolLengthMeters, course, event, and timeSource are
// required and caller-supplied — Chronos never invents a session identity
// and never stamps a clock reading itself. strokeKey, distanceMeters, and
// createdAtMs are optional and default to null; if a caller wants
// createdAtMs populated, it reads its own clock and passes the value in.
export function chronosCreateSession(params) {
    const invalidReason = chronosValidateSessionParams(params);

    if (invalidReason) {
        return { ok: false, reason: invalidReason, session: null };
    }

    const session = {
        sessionId: params.sessionId,
        createdAtMs: params.createdAtMs ?? null,

        status: "idle",

        poolLengthMeters: params.poolLengthMeters,
        course: params.course,
        event: params.event,
        strokeKey: params.strokeKey ?? null,
        distanceMeters: params.distanceMeters ?? null,

        timeSource: params.timeSource,

        events: [],
        finalTimeMs: null,

        // Chronos reliability phase 2C: null while the race's distance
        // progression is trusted; an "unconfirmed" record once it cannot be
        // (see chronosMarkDistanceUnconfirmed). Never cleared.
        distanceConfidence: null
    };

    return { ok: true, reason: null, session };
}

// Applies a single lifecycle transition (docs/CHRONOS_ARCHITECTURE.md §9).
// Never mutates the session passed in — returns a new session object on
// success. An illegal transition (not listed in LEGAL_TRANSITIONS) is
// rejected with a structured reason rather than silently applied.
export function chronosTransition(session, targetStatus) {
    if (!session || typeof session !== "object") {
        return { ok: false, reason: "missing-session", session: null };
    }

    if (!SESSION_STATUSES.includes(targetStatus)) {
        return { ok: false, reason: "unknown-target-status", session };
    }

    const legalTargets = LEGAL_TRANSITIONS[session.status] || [];

    if (!legalTargets.includes(targetStatus)) {
        return {
            ok: false,
            reason: `illegal-transition-${session.status}-to-${targetStatus}`,
            session
        };
    }

    return {
        ok: true,
        reason: null,
        session: { ...session, status: targetStatus }
    };
}

// DISTANCE CONFIDENCE (Chronos reliability, phase 2C).
//
// A detector assigns distances by COUNTING turns, so a turn the detector never
// saw (the swimmer was hidden at a wall) silently shifts every later label. When
// the caller finds that a turn COULD have been concealed, it marks the race's
// distance progression UNCONFIRMED here. From then on Chronos refuses every
// DETECTOR-sourced split/turn/finish (src/chronos-engine/events.js,
// "distance-progression-unconfirmed"); manual events are unaffected (a person
// supplies the distance). Events already accepted are untouched: they were
// validated before the gap.
//
// Chronos does not decide WHETHER a turn was concealed — the caller does, from
// evidence Chronos never sees — and it never infers which turns are missing or
// what a later wall contact represents. There is deliberately no way to clear
// the mark: nothing in the event model can establish a missing turn count
// without guessing, so the degraded state lasts for the rest of the session.
// Idempotent: a second call keeps the FIRST record (the earliest point at which
// distance could have been affected).
//
// params: {reason: non-empty string, sinceAtMs: finite, >= the start event's
// time (the earliest point a concealed turn could affect distance — normally the
// last observation before the gap), resumedAtMs?: finite or null (the first
// observation after it), evidence?: plain object (diagnostics only)}.
export function chronosMarkDistanceUnconfirmed(session, params) {
    if (!session || typeof session !== "object") {
        return { ok: false, reason: "missing-session", session: null };
    }
    if (session.status !== "running") {
        return { ok: false, reason: `distance-confidence-illegal-in-status-${session.status}`, session };
    }
    if (!params || typeof params !== "object" || !isNonEmptyString(params.reason)) {
        return { ok: false, reason: "missing-distance-confidence-reason", session };
    }
    const startEvent = Array.isArray(session.events) ? session.events.find((event) => event.type === "start") : null;
    if (
        typeof params.sinceAtMs !== "number" ||
        !Number.isFinite(params.sinceAtMs) ||
        (startEvent && params.sinceAtMs < startEvent.atMs)
    ) {
        return { ok: false, reason: "invalid-distance-confidence-since", session };
    }
    if (
        params.resumedAtMs !== undefined &&
        params.resumedAtMs !== null &&
        (typeof params.resumedAtMs !== "number" || !Number.isFinite(params.resumedAtMs) || params.resumedAtMs < params.sinceAtMs)
    ) {
        return { ok: false, reason: "invalid-distance-confidence-resumed", session };
    }

    if (session.distanceConfidence && session.distanceConfidence.state === "unconfirmed") {
        return { ok: true, reason: null, session, alreadyUnconfirmed: true };
    }

    return {
        ok: true,
        reason: null,
        session: {
            ...session,
            distanceConfidence: {
                state: "unconfirmed",
                reason: params.reason,
                sinceAtMs: params.sinceAtMs,
                resumedAtMs: params.resumedAtMs ?? null,
                evidence: params.evidence && typeof params.evidence === "object" ? { ...params.evidence } : null
            }
        },
        alreadyUnconfirmed: false
    };
}

// Convenience wrapper: idle -> armed. Called by the caller once it's ready
// to accept a start event (e.g. video/detectors initialized). Chronos does
// not decide readiness itself — the caller decides when to arm.
export function chronosArmSession(session) {
    return chronosTransition(session, "armed");
}

// Convenience wrapper: armed|running -> aborted. Used when the caller
// discards a session outright (e.g. a new video is loaded mid-session).
export function chronosAbortSession(session) {
    return chronosTransition(session, "aborted");
}
