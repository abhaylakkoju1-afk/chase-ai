// Chase engine — inference-result integrity state machine.
//
// Plain classic script, like the rest of src/chase-engine/ (see
// geometry.js for the loading-order reasoning). It defines globals and
// reads none at load time, so it can be evaluated on its own in a Node
// `vm` sandbox (test/inference-integrity.test.js).
//
// WHY
// ---
// The legacy MediaPipe Pose API delivers results through one
// onResults(results) callback that carries no request ID. index.html
// therefore cannot know which pose.send() produced a callback. This file
// does NOT solve that; it decides, from what CAN be observed (when a
// send is outstanding, how many callbacks arrive while it is, and how
// it settles), whether a callback may be committed to analysis data,
// and fails closed when the observable pattern is anything other than
// "exactly one callback while exactly one send is outstanding, and that
// send resolved".
//
// See docs/CHASE_INFERENCE_INTEGRITY.md for the full state machine, the
// eight cases it was designed against, and its limits. In short:
// - one inference WINDOW per pose.send(), opened just before the call
//   and closed when its promise settles; at most one window page-wide;
// - a callback OBSERVED while a window is open is HELD, and COMMITTED
//   only when the window resolves with exactly that one callback
//   observed, for the session that dispatched it, while that session is
//   still active. Being observed during a window does not mean the
//   callback originated from that window's send;
// - any other pattern is an integrity VIOLATION: the data is dropped
//   and the state LATCHES, refusing every later dispatch until reload.
//   Nothing here ever times out or clears a latch or an open window.
//
// It never inspects landmark contents and never claims request/result
// identity. Known residual (docs/CHASE_INFERENCE_INTEGRITY.md §4): a
// foreign callback that is the only one observed during a window, because
// that send's own result is missing or delayed, is committed.

const CHASE_INFERENCE_VIOLATIONS = Object.freeze({
    CALLBACK_WITHOUT_OPEN_SEND: "CALLBACK_WITHOUT_OPEN_SEND",
    MULTIPLE_CALLBACKS_FOR_SEND: "MULTIPLE_CALLBACKS_FOR_SEND",
    RESOLVED_WITHOUT_CALLBACK: "RESOLVED_WITHOUT_CALLBACK",
    CALLBACK_FOR_REJECTED_SEND: "CALLBACK_FOR_REJECTED_SEND",
    WINDOW_MISMATCH: "WINDOW_MISMATCH"
});

function chaseCreateInferenceIntegrityState() {
    return {
        open: null,
        latched: null,
        nextWindowId: 1,
        counters: {
            windowsOpened: 0,
            resultsCommitted: 0,
            resultsDiscardedStale: 0,
            sendsRejectedWithoutResult: 0,
            callbacksDropped: 0,
            dispatchesRefused: 0,
            violations: 0
        }
    };
}

function chaseInferenceCanDispatch(state) {
    return !!state && state.open === null && state.latched === null;
}

function chaseLatchInferenceIntegrity(state, violation, detail) {
    state.counters.violations++;
    if (state.latched === null) {
        state.latched = {
            violation,
            windowId: detail && Number.isFinite(detail.windowId) ? detail.windowId : null,
            generation: detail && Number.isFinite(detail.generation) ? detail.generation : null
        };
    }
}

// Opens the window for one pose.send() call. Returns null (and opens
// nothing) when a window is already open or the state is latched; the
// caller must then not call pose.send().
function chaseOpenInferenceWindow(state, { generation, pendingTiming } = {}) {
    if (!chaseInferenceCanDispatch(state)) {
        state.counters.dispatchesRefused++;
        return null;
    }
    const inferenceWindow = {
        id: state.nextWindowId++,
        generation,
        pendingTiming: pendingTiming === undefined ? null : pendingTiming,
        callbacks: 0,
        heldPayload: null
    };
    state.open = inferenceWindow;
    state.counters.windowsOpened++;
    return inferenceWindow;
}

// Called for EVERY MediaPipe callback, before anything else uses it. It
// records that a callback was observed now, not which send produced it.
// `payload` is the caller's snapshot of the callback; it is only stored,
// never read.
function chaseRecordInferenceCallback(state, payload) {
    const inferenceWindow = state.open;

    if (inferenceWindow === null) {
        state.counters.callbacksDropped++;
        chaseLatchInferenceIntegrity(state, CHASE_INFERENCE_VIOLATIONS.CALLBACK_WITHOUT_OPEN_SEND, null);
        return { action: "DROPPED", violation: CHASE_INFERENCE_VIOLATIONS.CALLBACK_WITHOUT_OPEN_SEND };
    }

    inferenceWindow.callbacks++;

    if (inferenceWindow.callbacks === 1) {
        inferenceWindow.heldPayload = payload;
        return { action: "HELD", violation: null };
    }

    // Two or more callbacks while one send is outstanding: at least one
    // is not this send's, and nothing says which. Drop them all.
    state.counters.callbacksDropped += inferenceWindow.callbacks === 2 ? 2 : 1;
    inferenceWindow.heldPayload = null;
    chaseLatchInferenceIntegrity(state, CHASE_INFERENCE_VIOLATIONS.MULTIPLE_CALLBACKS_FOR_SEND, inferenceWindow);
    return { action: "DROPPED", violation: CHASE_INFERENCE_VIOLATIONS.MULTIPLE_CALLBACKS_FOR_SEND };
}

// Closes `inferenceWindow` when its pose.send() promise settles.
// `outcome` is "resolved" or "rejected". `currentGeneration` and
// `sessionActive` describe the analysis session at settlement time.
// Returns { action: "COMMIT" | "DISCARD" | "NONE", reason, violation,
// payload, pendingTiming }. Only COMMIT carries a payload.
function chaseCloseInferenceWindow(state, inferenceWindow, { outcome, currentGeneration, sessionActive } = {}) {
    if (!inferenceWindow || state.open !== inferenceWindow) {
        chaseLatchInferenceIntegrity(state, CHASE_INFERENCE_VIOLATIONS.WINDOW_MISMATCH, inferenceWindow);
        return { action: "NONE", reason: "WINDOW_NOT_OPEN", violation: CHASE_INFERENCE_VIOLATIONS.WINDOW_MISMATCH, payload: null, pendingTiming: null };
    }

    state.open = null;
    const callbacks = inferenceWindow.callbacks;
    const held = inferenceWindow.heldPayload;
    inferenceWindow.heldPayload = null;

    const discard = (reason, violation) => ({ action: callbacks > 0 ? "DISCARD" : "NONE", reason, violation, payload: null, pendingTiming: null });

    if (callbacks > 1) {
        // Already dropped, counted and latched when the second callback arrived.
        return discard("MULTIPLE_CALLBACKS_FOR_SEND", null);
    }

    if (outcome === "rejected") {
        if (callbacks === 0) {
            state.counters.sendsRejectedWithoutResult++;
            return discard("REJECTED_WITHOUT_RESULT", null);
        }
        state.counters.callbacksDropped++;
        chaseLatchInferenceIntegrity(state, CHASE_INFERENCE_VIOLATIONS.CALLBACK_FOR_REJECTED_SEND, inferenceWindow);
        return discard("CALLBACK_FOR_REJECTED_SEND", CHASE_INFERENCE_VIOLATIONS.CALLBACK_FOR_REJECTED_SEND);
    }

    if (outcome !== "resolved") {
        // Unknown outcome: treat as unverifiable, never commit.
        if (callbacks === 1) state.counters.callbacksDropped++;
        chaseLatchInferenceIntegrity(state, CHASE_INFERENCE_VIOLATIONS.WINDOW_MISMATCH, inferenceWindow);
        return discard("UNKNOWN_OUTCOME", CHASE_INFERENCE_VIOLATIONS.WINDOW_MISMATCH);
    }

    if (callbacks === 0) {
        chaseLatchInferenceIntegrity(state, CHASE_INFERENCE_VIOLATIONS.RESOLVED_WITHOUT_CALLBACK, inferenceWindow);
        return discard("RESOLVED_WITHOUT_CALLBACK", CHASE_INFERENCE_VIOLATIONS.RESOLVED_WITHOUT_CALLBACK);
    }

    if (state.latched !== null) {
        state.counters.callbacksDropped++;
        return discard("INTEGRITY_LATCHED", null);
    }

    if (inferenceWindow.generation !== currentGeneration || !sessionActive) {
        state.counters.resultsDiscardedStale++;
        return discard("SESSION_ENDED_OR_REPLACED", null);
    }

    state.counters.resultsCommitted++;
    return { action: "COMMIT", reason: "SINGLE_CALLBACK_RESOLVED", violation: null, payload: held, pendingTiming: inferenceWindow.pendingTiming };
}

// Plain, JSON-safe copy for diagnostics (window.chaseAI.inferenceIntegrity).
function chaseInferenceIntegritySummary(state) {
    return {
        status: state.latched === null ? (state.open === null ? "IDLE" : "SEND_OUTSTANDING") : "LATCHED",
        latched: state.latched === null ? null : { ...state.latched },
        openWindow: state.open === null ? null : { id: state.open.id, generation: state.open.generation, callbacks: state.open.callbacks },
        counters: { ...state.counters },
        identity: "not established: the legacy onResults callback carries no request ID"
    };
}
