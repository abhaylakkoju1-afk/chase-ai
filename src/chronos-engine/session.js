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
        finalTimeMs: null
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
