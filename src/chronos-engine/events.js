// Chronos engine — authoritative timing-event ingestion.
//
// Pure, deterministic, browser-independent. Implements the TimingEvent
// contract (docs/CHRONOS_ARCHITECTURE.md §6), the state machine (§9), and
// the validation/dedup/split-turn rules (§10-§13). Every value this module
// operates on — including every timestamp — is supplied by the caller;
// this file never reads Date.now(), video.currentTime, performance.now(),
// or any other clock, and never touches the DOM, localStorage, Firebase,
// or MediaPipe. It does not import from src/chase-engine/*.

import { chronosTransition } from "./session.js";
import { chronosResolveTimestamp } from "./time-basis.js";

// Minimum time gap required between two consecutive distance-bearing
// events (split/turn/finish) recorded in the same session
// (docs/CHRONOS_ARCHITECTURE.md §13).
//
// Value provenance: this is the existing v1 debounce already used by the
// (currently dead — docs/CHRONOS_ARCHITECTURE.md §23) automatic turn
// detector in index.html (`currentTime - lastTurnTime > 2.5`, in seconds,
// at index.html around line 9207). docs/CHRONOS_ARCHITECTURE.md §13 left
// the exact value unresolved and asked that this existing value be reused
// only if clearly appropriate, not silently replaced.
//
// It is reused here as the v1 default because: (a) it was tuned
// specifically to stop a single noisy wall-contact detection from firing
// more than once, which is exactly the failure mode this constant guards
// against; (b) 2.5s is comfortably below any physically realistic split
// interval for a pool length Swimtics currently supports, so it cannot
// reject a legitimate detected turn. It has NOT been validated against the
// *manual* event path, which docs/CHRONOS_ARCHITECTURE.md §13 also
// subjects to this same constant ("applied regardless of source") — that
// is a flagged assumption to revisit with real fixture data in Stage 3,
// not a blocking issue for Stage 2 (see the Stage 2 report).
export const MIN_EVENT_GAP_MS = 2500;

const EVENT_TYPES = Object.freeze(["start", "split", "turn", "finish"]);
const EVENT_SOURCES = Object.freeze(["manual", "detector"]);

// Event types legal to record while the session is in a given status
// (docs/CHRONOS_ARCHITECTURE.md §9, §11). A type not listed for the
// session's current status is rejected before any other validation runs.
const LEGAL_EVENT_TYPES_BY_STATUS = Object.freeze({
    idle: Object.freeze([]),
    armed: Object.freeze(["start"]),
    running: Object.freeze(["split", "turn", "finish"]),
    finished: Object.freeze([]),
    aborted: Object.freeze([])
});

function reject(session, reason) {
    return { ok: false, reason, session, event: null };
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

// Distance-bearing event types, per docs/CHRONOS_ARCHITECTURE.md §10 rule
// 4 and §12 — "start" is deliberately excluded: its distance is implicitly
// 0, and it is not part of the split/turn distance-ordering chain.
function isDistanceBearingType(type) {
    return type === "split" || type === "turn" || type === "finish";
}

function findEvent(session, type) {
    return session.events.find((event) => event.type === type) || null;
}

function lastDistanceBearingEvent(session) {
    for (let i = session.events.length - 1; i >= 0; i -= 1) {
        if (isDistanceBearingType(session.events[i].type)) {
            return session.events[i];
        }
    }
    return null;
}

function nextEventId(session) {
    return `${session.sessionId}-evt-${session.events.length + 1}`;
}

// Validates the shape of an incoming event input, independent of session
// state. Returns a stable reason string, or null when the shape is valid.
//
// This is also where the "detector confidence must never be silently
// converted into manual certainty" rule (docs/CHRONOS_ARCHITECTURE.md §15)
// is enforced structurally: a manual event may not carry a confidence or a
// detector name at all, and a detector event must carry both.
function validateEventShape(input) {
    if (!input || typeof input !== "object") {
        return "missing-event-input";
    }

    if (!EVENT_TYPES.includes(input.type)) {
        return "unknown-event-type";
    }

    if (!EVENT_SOURCES.includes(input.source)) {
        return "unknown-event-source";
    }

    if (input.source === "manual") {
        if (input.confidence !== null && input.confidence !== undefined) {
            return "manual-event-must-not-carry-confidence";
        }
        if (input.detector !== null && input.detector !== undefined) {
            return "manual-event-must-not-carry-detector";
        }
    }

    if (input.source === "detector") {
        if (
            typeof input.confidence !== "number" ||
            !Number.isFinite(input.confidence) ||
            input.confidence < 0 ||
            input.confidence > 1
        ) {
            return "detector-event-requires-confidence";
        }
        if (typeof input.detector !== "string" || input.detector.trim().length === 0) {
            return "detector-event-requires-detector-name";
        }
    }

    if (isDistanceBearingType(input.type)) {
        if (!isFiniteNumber(input.distanceMeters)) {
            return "missing-distance-meters";
        }
        if (input.distanceMeters < 0) {
            return "negative-distance-meters";
        }
    } else if (
        input.distanceMeters !== null &&
        input.distanceMeters !== undefined &&
        !isFiniteNumber(input.distanceMeters)
    ) {
        return "invalid-distance-meters";
    }

    return null;
}

// Enforces MIN_EVENT_GAP_MS between consecutive distance-bearing events
// (docs/CHRONOS_ARCHITECTURE.md §13). Returns a rejection reason, or null
// when there is no previous distance-bearing event to gap against — the
// first split/turn/finish of a session is never gap-rejected.
function checkMinimumGap(previousDistanceEvent, atMs) {
    if (!previousDistanceEvent) {
        return null;
    }
    if (atMs - previousDistanceEvent.atMs < MIN_EVENT_GAP_MS) {
        return "event-too-soon-after-previous";
    }
    return null;
}

function appendEvent(session, event) {
    return { ...session, events: [...session.events, event] };
}

function buildEvent(session, input, atMs) {
    return {
        id: nextEventId(session),
        type: input.type,
        atMs,
        distanceMeters: isDistanceBearingType(input.type)
            ? input.distanceMeters
            : (isFiniteNumber(input.distanceMeters) ? input.distanceMeters : 0),
        source: input.source,
        detector: input.source === "detector" ? input.detector : null,
        confidence: input.source === "detector" ? input.confidence : null,
        supersedes: input.supersedes ?? null
    };
}

function recordStart(session, input, atMs) {
    // Unreachable via chronosRecordEvent(), which now checks this same
    // condition earlier (see the "start-already-recorded" short-circuit
    // above) so the specific reason isn't masked by the generic
    // status-legality rejection. Kept here as a defensive backstop rather
    // than removed, since recordStart() is only ever reached in a state
    // where this can no longer fire.
    if (findEvent(session, "start")) {
        return reject(session, "start-already-recorded");
    }

    const event = buildEvent(session, input, atMs);
    const sessionWithEvent = appendEvent(session, event);

    // "start" is the one event type whose acceptance also drives a status
    // transition (armed -> running, docs/CHRONOS_ARCHITECTURE.md §9, §11).
    const transitionResult = chronosTransition(sessionWithEvent, "running");
    if (!transitionResult.ok) {
        // Unreachable given LEGAL_EVENT_TYPES_BY_STATUS already restricts
        // "start" to the "armed" status — but an event is never applied
        // without its required transition actually succeeding.
        return reject(session, transitionResult.reason);
    }

    return { ok: true, reason: null, session: transitionResult.session, event };
}

function recordFinish(session, input, atMs) {
    const startEvent = findEvent(session, "start");
    if (!startEvent) {
        // Unreachable given LEGAL_EVENT_TYPES_BY_STATUS (see recordStart),
        // kept as an explicit, correctly-worded defensive check rather
        // than relying solely on that invariant holding elsewhere.
        return reject(session, "finish-before-start");
    }

    // Unreachable via chronosRecordEvent(), which now checks this same
    // condition earlier (see the "finish-already-recorded" short-circuit
    // above) so the specific reason isn't masked by the generic
    // status-legality rejection. Kept here as a defensive backstop rather
    // than removed, for the same reason recordStart()'s analogous check
    // is kept.
    if (findEvent(session, "finish")) {
        return reject(session, "finish-already-recorded");
    }

    if (atMs <= startEvent.atMs) {
        return reject(session, "finish-before-start-time");
    }

    const previousDistanceEvent = lastDistanceBearingEvent(session);

    if (previousDistanceEvent && input.distanceMeters < previousDistanceEvent.distanceMeters) {
        return reject(session, "distance-out-of-order");
    }

    if (previousDistanceEvent && atMs <= previousDistanceEvent.atMs) {
        return reject(session, "non-monotonic-timestamp");
    }

    const gapReason = checkMinimumGap(previousDistanceEvent, atMs);
    if (gapReason) {
        return reject(session, gapReason);
    }

    const event = buildEvent(session, input, atMs);
    const sessionWithEvent = appendEvent(session, event);

    const transitionResult = chronosTransition(sessionWithEvent, "finished");
    if (!transitionResult.ok) {
        return reject(session, transitionResult.reason);
    }

    const finishedSession = {
        ...transitionResult.session,
        finalTimeMs: atMs - startEvent.atMs
    };

    return { ok: true, reason: null, session: finishedSession, event };
}

function recordSplitOrTurn(session, input, atMs) {
    const startEvent = findEvent(session, "start");
    if (!startEvent) {
        // Unreachable given LEGAL_EVENT_TYPES_BY_STATUS (split/turn are
        // only legal while status === "running", which requires a
        // recorded start) — kept explicit rather than assumed.
        return reject(session, "no-start-recorded");
    }

    if (atMs <= startEvent.atMs) {
        return reject(session, "event-before-start-time");
    }

    const previousDistanceEvent = lastDistanceBearingEvent(session);

    if (previousDistanceEvent && input.distanceMeters < previousDistanceEvent.distanceMeters) {
        return reject(session, "distance-out-of-order");
    }

    if (previousDistanceEvent && atMs <= previousDistanceEvent.atMs) {
        return reject(session, "non-monotonic-timestamp");
    }

    const gapReason = checkMinimumGap(previousDistanceEvent, atMs);
    if (gapReason) {
        return reject(session, gapReason);
    }

    const event = buildEvent(session, input, atMs);
    return { ok: true, reason: null, session: appendEvent(session, event), event };
}

// Records a single TimingEvent against a session, applying every rule in
// docs/CHRONOS_ARCHITECTURE.md §10-§13. Never mutates the session passed
// in — no synthetic event is ever generated, and no event is applied
// without every applicable rule passing first. On success, returns the
// new session (with the event appended, and for start/finish, the
// resulting status transition already applied) and the recorded event. On
// rejection, returns the ORIGINAL session unchanged plus a stable reason
// string — the caller decides what, if anything, to show the user.
export function chronosRecordEvent(session, input) {
    if (!session || typeof session !== "object") {
        return { ok: false, reason: "missing-session", session: null, event: null };
    }

    const shapeReason = validateEventShape(input);
    if (shapeReason) {
        return reject(session, shapeReason);
    }

    // Duplicate start must surface its own specific, documented reason
    // (docs/CHRONOS_ARCHITECTURE.md §11: "start-already-recorded") rather
    // than the generic status-legality rejection below — checked first
    // because by the time a second "start" candidate arrives, the first
    // one has already moved status from "armed" to "running", which would
    // otherwise mask the more specific reason behind
    // "event-type-illegal-in-status-running".
    if (input.type === "start" && findEvent(session, "start")) {
        return reject(session, "start-already-recorded");
    }

    // Same reasoning as duplicate start above, mirrored for finish: once
    // the first "finish" is accepted, status moves to "finished", whose
    // LEGAL_EVENT_TYPES_BY_STATUS entry is empty — which would otherwise
    // mask a second finish attempt behind the generic
    // "event-type-illegal-in-status-finished" rather than the specific,
    // consistent "finish-already-recorded".
    if (input.type === "finish" && findEvent(session, "finish")) {
        return reject(session, "finish-already-recorded");
    }

    const legalTypes = LEGAL_EVENT_TYPES_BY_STATUS[session.status] || [];
    if (!legalTypes.includes(input.type)) {
        return reject(session, `event-type-illegal-in-status-${session.status}`);
    }

    const timestampResult = chronosResolveTimestamp({
        timeSource: session.timeSource,
        atMs: input.atMs
    });
    if (!timestampResult.ok) {
        return reject(session, timestampResult.reason);
    }
    const atMs = timestampResult.atMs;

    if (input.type === "start") {
        return recordStart(session, input, atMs);
    }

    if (input.type === "finish") {
        return recordFinish(session, input, atMs);
    }

    return recordSplitOrTurn(session, input, atMs);
}
