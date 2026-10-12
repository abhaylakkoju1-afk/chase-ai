// Swimmer tracking — session creation, target selection, and lifecycle
// transition legality.
//
// Pure, deterministic, browser-independent — see
// docs/SWIMMER_TRACKING_ARCHITECTURE.md §6 for the full purity contract.
// This module never reads Date.now(), video.currentTime,
// performance.now(), or any other clock, never touches the DOM,
// localStorage, Firebase, or MediaPipe, and does not import Chronos or
// any detector. It does not import from src/chronos-engine/* or
// src/chase-engine/*.
//
// A real ES module (this repo's package.json already declares
// "type": "module"), matching src/chronos-engine/*'s own convention.

export const TRACKING_STATUSES = Object.freeze([
    "UNSELECTED",
    "TARGET_SELECTED",
    "TARGET_LOCKING",
    "TARGET_LOCKED",
    "TARGET_LOST",
    "ANALYSIS_DEGRADED"
]);

// Legal status transitions (docs/SWIMMER_TRACKING_ARCHITECTURE.md §8.2).
// ANALYSIS_DEGRADED is terminal — no outgoing transition. A transition
// not listed here is rejected, never silently applied — same discipline
// as src/chronos-engine/session.js's LEGAL_TRANSITIONS.
const LEGAL_TRANSITIONS = Object.freeze({
    UNSELECTED: Object.freeze(["TARGET_SELECTED"]),
    TARGET_SELECTED: Object.freeze(["TARGET_LOCKING"]),
    TARGET_LOCKING: Object.freeze(["TARGET_LOCKED", "UNSELECTED"]),
    TARGET_LOCKED: Object.freeze(["TARGET_LOST", "ANALYSIS_DEGRADED"]),
    TARGET_LOST: Object.freeze(["TARGET_LOCKED", "ANALYSIS_DEGRADED"]),
    ANALYSIS_DEGRADED: Object.freeze([])
});

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

export function trackingValidateSessionParams(params) {
    if (!params || typeof params !== "object") {
        return "missing-params";
    }
    if (!isNonEmptyString(params.sessionId)) {
        return "missing-session-id";
    }
    return null;
}

// Creates a new TargetLockState (docs/SWIMMER_TRACKING_ARCHITECTURE.md
// §7.4) in "UNSELECTED" status. sessionId is required and
// caller-supplied — this module never invents a session identity, same
// philosophy as src/chronos-engine/session.js's chronosCreateSession().
//
// Fields prefixed with "_" are internal bookkeeping used by tracking.js
// (locking-streak progress, loss/reacquisition timers) — carried on the
// same plain-data session object rather than as hidden module state
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §6: "no hidden global
// singleton, no module-level mutable target state"). They are not part
// of the public TargetLockState contract in §7.4 and should not be
// relied on by callers outside this module.
export function trackingCreateSession(params) {
    const invalidReason = trackingValidateSessionParams(params);
    if (invalidReason) {
        return { ok: false, reason: invalidReason, session: null };
    }

    const session = {
        sessionId: params.sessionId,
        status: "UNSELECTED",
        selection: null,
        lockEstablishedAtMs: null,
        lastConfirmedAtMs: null,
        lastConfirmedPosition: null,
        lastConfirmedVelocity: null,
        observationHistory: [],
        degradedReason: null,

        _lockingWindowStartAtMs: null,
        _lockingStreak: 0,
        _lockingLastPosition: null,
        _lockingLastAtMs: null,
        _lostAtMs: null,
        _ambiguousStreakStartAtMs: null
    };

    return { ok: true, reason: null, session };
}

// Applies a single lifecycle transition. Never mutates the session
// passed in — returns a new session object on success. An illegal
// transition is rejected with a structured reason rather than silently
// applied — same discipline as src/chronos-engine/session.js's
// chronosTransition().
export function trackingTransition(session, targetStatus) {
    if (!session || typeof session !== "object") {
        return { ok: false, reason: "missing-session", session: null };
    }
    if (!TRACKING_STATUSES.includes(targetStatus)) {
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

    return { ok: true, reason: null, session: { ...session, status: targetStatus } };
}

// Records the user's initial target selection
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §9). Legal only from
// "UNSELECTED". Does not evaluate any pose data itself — that begins
// with the first trackingObserve() call (tracking.js).
export function trackingSelectTarget(session, selection) {
    if (!session || typeof session !== "object") {
        return { ok: false, reason: "missing-session", session: null };
    }
    if (!selection || typeof selection !== "object" || !isFiniteNumber(selection.atMs)) {
        return { ok: false, reason: "invalid-selection", session };
    }
    if (
        selection.point !== null &&
        selection.point !== undefined &&
        (
            typeof selection.point !== "object" ||
            !isFiniteNumber(selection.point.x) ||
            !isFiniteNumber(selection.point.y)
        )
    ) {
        return { ok: false, reason: "invalid-selection-point", session };
    }

    const transitionResult = trackingTransition(session, "TARGET_SELECTED");
    if (!transitionResult.ok) {
        return transitionResult;
    }

    const recordedSelection = {
        atMs: selection.atMs,
        point: selection.point ?? null
    };

    return {
        ok: true,
        reason: null,
        session: { ...transitionResult.session, selection: recordedSelection }
    };
}
