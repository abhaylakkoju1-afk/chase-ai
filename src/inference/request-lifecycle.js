// Inference request lifecycle — pure state machine (Stage 3, step 1).
//
// Used by the Chase analyzer only, through src/inference/pose-adapter.js
// (index.html loads both). The Race page does not use it and is
// unchanged. src/chase-engine/inference-integrity.js (merged INT-1) is no
// longer loaded by the page; it remains the reference this core's frame
// decisions are tested against.
//
// Plain classic script, like src/chase-engine/*.js: it defines globals,
// reads none at load time, and uses no browser API, timer, clock or
// randomness, so it can be evaluated on its own in a Node `vm` sandbox
// (test/inference/request-lifecycle.test.js). Which module format the
// pages will finally load it with is an integration decision, not made
// here.
//
// WHAT IT MODELS
// --------------
// Engine readiness   CREATED -> WARMING -> READY. Two terminal states for
//                    this page load, kept distinct on purpose:
//                    WARMUP_FAILED (the warm-up send was rejected, so the
//                    engine never became ready) and LATCHED (an integrity
//                    anomaly was detected). Only a page reload, i.e. a new
//                    lifecycle object, starts again from either.
// Sessions           at most one ACTIVE session; beginSession() retires
//                    (ENDS) the previous one; endSession() ends it.
// Requests           one OPEN request at a time, of kind WARMUP or FRAME.
//                    Every request reaches exactly one terminal state:
//                    ELIGIBLE, WARMUP_COMPLETE, DISCARDED_STALE,
//                    REJECTED_WITHOUT_RESULT or FAILED_CLOSED.
//
// RULES
// -----
// For FRAME requests these are decision INT-1's rules on main, and the
// tests check this core's frame decisions against
// src/chase-engine/inference-integrity.js. Everything about the warm-up,
// readiness and session state is this core's own design (Stage 3), not
// something INT-1 specifies or requires.
//
// - One open pose.send() request at a time, page-wide. The lock is
//   released only by settle() for that request. There is no timeout and
//   no other way to release it; a request that never settles stays OPEN.
// - A callback observed while a request is open is counted and the
//   first one is held. Its origin is NOT known: the legacy onResults
//   callback carries no request ID.
// - A FRAME result is ELIGIBLE only when its send resolved, exactly one
//   callback was observed during its window, no latch is set, and the
//   session that dispatched it is still the current, ACTIVE session.
// - Detected anomalies fail closed and LATCH, with INT-1's codes:
//   a callback with no open request, two or more callbacks in one window,
//   a send that resolves with no callback, a callback for a rejected
//   send, and settling a request that is not the open one (or with an
//   unknown outcome). A latch refuses every later dispatch and session
//   until reload. Nothing clears it. Applying the same detection to the
//   WARMUP request is this core's choice; INT-1 has no warm-up.
// - A rejected FRAME send with no callback is not an anomaly (as in
//   INT-1): it ends REJECTED_WITHOUT_RESULT and frames may continue.
// - A rejected WARMUP send with no callback is not an integrity anomaly
//   either, but the engine never became ready. The core moves to
//   WARMUP_FAILED and stays fail-closed: no frame request, warm-up or
//   session is accepted until reload. This is a readiness decision of
//   this core (no engine recreation exists in this step), not an INT-1
//   latch, and INT-1 does not require it.
// - WARMUP results never become eligible; they are decided by kind.
//
// Deliberately absent (later steps, each needing review): engine
// recreation, a retired-instance graveyard, close()/reset() handling,
// reload or waiting UI, blocking Start/Analyze/new-video while a request
// is open (beginSession() is allowed then, as in INT-1; hasOpenRequest()
// lets a caller see it), and any media-time frontier.

const INFERENCE_ENGINE_STATES = Object.freeze({
    CREATED: "CREATED",
    WARMING: "WARMING",
    READY: "READY",
    WARMUP_FAILED: "WARMUP_FAILED",
    LATCHED: "LATCHED"
});

const INFERENCE_SESSION_STATES = Object.freeze({
    ACTIVE: "ACTIVE",
    ENDED: "ENDED"
});

const INFERENCE_REQUEST_KINDS = Object.freeze({
    WARMUP: "WARMUP",
    FRAME: "FRAME"
});

const INFERENCE_REQUEST_STATES = Object.freeze({
    OPEN: "OPEN",
    ELIGIBLE: "ELIGIBLE",
    WARMUP_COMPLETE: "WARMUP_COMPLETE",
    DISCARDED_STALE: "DISCARDED_STALE",
    REJECTED_WITHOUT_RESULT: "REJECTED_WITHOUT_RESULT",
    FAILED_CLOSED: "FAILED_CLOSED"
});

// Integrity latch codes: exactly INT-1's violation codes
// (src/chase-engine/inference-integrity.js), same names and meanings.
// A failed warm-up is NOT one of these; see WARMUP_FAILED.
const INFERENCE_LATCH_REASONS = Object.freeze({
    CALLBACK_WITHOUT_OPEN_SEND: "CALLBACK_WITHOUT_OPEN_SEND",
    MULTIPLE_CALLBACKS_FOR_SEND: "MULTIPLE_CALLBACKS_FOR_SEND",
    RESOLVED_WITHOUT_CALLBACK: "RESOLVED_WITHOUT_CALLBACK",
    CALLBACK_FOR_REJECTED_SEND: "CALLBACK_FOR_REJECTED_SEND",
    WINDOW_MISMATCH: "WINDOW_MISMATCH"
});

// Why a dispatch or beginSession() was refused. A refusal changes no
// state other than a counter; the caller must not call pose.send().
const INFERENCE_REFUSALS = Object.freeze({
    LATCHED: "LATCHED",
    WARMUP_FAILED: "WARMUP_FAILED",
    REQUEST_OPEN: "REQUEST_OPEN",
    NOT_READY: "NOT_READY",
    ALREADY_WARMED: "ALREADY_WARMED",
    NO_ACTIVE_SESSION: "NO_ACTIVE_SESSION"
});

function createInferenceRequestLifecycle() {
    const S = INFERENCE_ENGINE_STATES;
    const K = INFERENCE_REQUEST_KINDS;
    const R = INFERENCE_REQUEST_STATES;
    const L = INFERENCE_LATCH_REASONS;
    const X = INFERENCE_REFUSALS;

    let engine = S.CREATED;
    let latch = null;          // { reason, requestId, kind, sessionToken } once latched
    let warmupFailure = null;  // { reason, requestId } once the warm-up send was rejected
    let session = null;        // { token, state, endReason }
    let open = null;           // { record, callbacks, held }
    let nextRequestId = 1;
    let nextSessionToken = 1;

    const counters = {
        requestsOpened: 0,
        warmupsOpened: 0,
        resultsEligible: 0,
        resultsDiscardedStale: 0,
        sendsRejectedWithoutResult: 0,
        callbacksObserved: 0,
        callbacksDropped: 0,
        dispatchesRefused: 0,
        sessionsBegun: 0,
        sessionsRefused: 0,
        warmupsFailed: 0,
        latches: 0
    };

    function setLatch(reason, record) {
        counters.latches++;
        if (latch === null) {
            latch = Object.freeze({
                reason,
                requestId: record ? record.requestId : null,
                kind: record ? record.kind : null,
                sessionToken: record ? record.sessionToken : null
            });
            engine = S.LATCHED;
        }
    }

    function refuse(reason) {
        counters.dispatchesRefused++;
        return Object.freeze({ accepted: false, reason, request: null });
    }

    function openRequest(kind, sessionToken, meta) {
        const record = Object.freeze({
            requestId: nextRequestId++,
            kind,
            sessionToken,
            meta: meta === undefined ? null : meta
        });
        open = { record, callbacks: 0, held: null };
        counters.requestsOpened++;
        if (kind === K.WARMUP) counters.warmupsOpened++;
        return Object.freeze({ accepted: true, reason: null, request: record });
    }

    function sessionIsCurrent(token) {
        return session !== null && session.token === token && session.state === INFERENCE_SESSION_STATES.ACTIVE;
    }

    function outcome(record, state, reason, latchReason, payload) {
        return Object.freeze({
            requestId: record ? record.requestId : null,
            kind: record ? record.kind : null,
            sessionToken: record ? record.sessionToken : null,
            meta: record ? record.meta : null,
            state,
            reason,
            latchReason: latchReason || null,
            payload: state === R.ELIGIBLE ? payload : null
        });
    }

    // ---- engine readiness -------------------------------------------------

    // Opens the dedicated WARMUP request. Allowed once, from CREATED, with
    // nothing open. The caller sends a warm-up frame only if accepted.
    function beginWarmup(meta) {
        if (latch !== null) return refuse(X.LATCHED);
        if (engine === S.WARMUP_FAILED) return refuse(X.WARMUP_FAILED);
        if (open !== null) return refuse(X.REQUEST_OPEN);
        if (engine !== S.CREATED) return refuse(X.ALREADY_WARMED);
        engine = S.WARMING;
        return openRequest(K.WARMUP, null, meta);
    }

    // ---- sessions ---------------------------------------------------------

    // Starts a new analysis session and retires the previous one. Refused
    // when latched, or when the warm-up failed (this core's readiness rule:
    // no analysis until reload). Allowed while a
    // request is open: that request belongs to the retired session and
    // will be DISCARDED_STALE when it settles, and no FRAME can be
    // dispatched until it does.
    function beginSession() {
        if (latch !== null) {
            counters.sessionsRefused++;
            return Object.freeze({ accepted: false, reason: X.LATCHED, token: null });
        }
        if (engine === S.WARMUP_FAILED) {
            counters.sessionsRefused++;
            return Object.freeze({ accepted: false, reason: X.WARMUP_FAILED, token: null });
        }
        if (session !== null && session.state === INFERENCE_SESSION_STATES.ACTIVE) {
            session = { token: session.token, state: INFERENCE_SESSION_STATES.ENDED, endReason: "replaced" };
        }
        session = { token: nextSessionToken++, state: INFERENCE_SESSION_STATES.ACTIVE, endReason: null };
        counters.sessionsBegun++;
        return Object.freeze({ accepted: true, reason: null, token: session.token });
    }

    // Ends the given session if it is the current, active one. Returns
    // whether anything changed. It never touches an open request.
    function endSession(token, reason) {
        if (!sessionIsCurrent(token)) return false;
        session = { token: session.token, state: INFERENCE_SESSION_STATES.ENDED, endReason: reason === undefined ? null : String(reason) };
        return true;
    }

    // ---- requests ---------------------------------------------------------

    // Opens a FRAME request for the given session. `meta` is the caller's
    // dispatch-time record (for example the frame's media time); it is
    // frozen into the request and returned with its outcome, never read.
    function dispatchFrame(sessionToken, meta) {
        if (latch !== null) return refuse(X.LATCHED);
        if (engine === S.WARMUP_FAILED) return refuse(X.WARMUP_FAILED);
        if (open !== null) return refuse(X.REQUEST_OPEN);
        if (engine !== S.READY) return refuse(X.NOT_READY);
        if (!sessionIsCurrent(sessionToken)) return refuse(X.NO_ACTIVE_SESSION);
        return openRequest(K.FRAME, sessionToken, meta);
    }

    // Called for EVERY engine callback, before anything else uses it.
    // `payload` is the caller's snapshot; it is stored, never read.
    function recordCallback(payload) {
        counters.callbacksObserved++;

        if (open === null) {
            counters.callbacksDropped++;
            setLatch(L.CALLBACK_WITHOUT_OPEN_SEND, null);
            return Object.freeze({ action: "DROPPED", latchReason: L.CALLBACK_WITHOUT_OPEN_SEND, requestId: null });
        }

        open.callbacks++;

        if (open.callbacks === 1) {
            open.held = payload;
            return Object.freeze({ action: "HELD", latchReason: null, requestId: open.record.requestId });
        }

        // Two or more callbacks while one request is open: at least one
        // is not this request's, and nothing says which. Drop them all.
        counters.callbacksDropped += open.callbacks === 2 ? 2 : 1;
        open.held = null;
        setLatch(L.MULTIPLE_CALLBACKS_FOR_SEND, open.record);
        return Object.freeze({ action: "DROPPED", latchReason: L.MULTIPLE_CALLBACKS_FOR_SEND, requestId: open.record.requestId });
    }

    // Called when the pose.send() promise for `requestId` settles.
    // `result` is "resolved" or "rejected". This is the only place the
    // request lock is released. Returns the request's single outcome.
    function settle(requestId, result) {
        if (open === null || open.record.requestId !== requestId) {
            setLatch(L.WINDOW_MISMATCH, open === null ? null : open.record);
            return outcome(null, R.FAILED_CLOSED, "REQUEST_NOT_OPEN", L.WINDOW_MISMATCH, null);
        }

        const { record, callbacks } = open;
        const held = open.held;
        open = null;

        const isWarmup = record.kind === K.WARMUP;
        const failClosed = (reason, latchReason) => {
            if (latchReason) setLatch(latchReason, record);
            return outcome(record, R.FAILED_CLOSED, reason, latchReason || null, null);
        };

        if (callbacks > 1) {
            // Already dropped, counted and latched at the second callback.
            return failClosed("MULTIPLE_CALLBACKS_FOR_SEND", null);
        }

        if (result === "rejected") {
            if (callbacks === 0) {
                counters.sendsRejectedWithoutResult++;
                if (isWarmup) {
                    // Not an integrity anomaly and not a latch: the engine
                    // simply never became ready. Fail closed via the
                    // separate WARMUP_FAILED readiness state.
                    engine = S.WARMUP_FAILED;
                    warmupFailure = Object.freeze({ reason: "WARMUP_REJECTED", requestId: record.requestId });
                    counters.warmupsFailed++;
                    return outcome(record, R.REJECTED_WITHOUT_RESULT, "WARMUP_REJECTED", null, null);
                }
                return outcome(record, R.REJECTED_WITHOUT_RESULT, "REJECTED_WITHOUT_RESULT", null, null);
            }
            counters.callbacksDropped++;
            return failClosed("CALLBACK_FOR_REJECTED_SEND", L.CALLBACK_FOR_REJECTED_SEND);
        }

        if (result !== "resolved") {
            if (callbacks === 1) counters.callbacksDropped++;
            return failClosed("UNKNOWN_OUTCOME", L.WINDOW_MISMATCH);
        }

        if (callbacks === 0) {
            return failClosed("RESOLVED_WITHOUT_CALLBACK", L.RESOLVED_WITHOUT_CALLBACK);
        }

        if (latch !== null) {
            counters.callbacksDropped++;
            return failClosed("INTEGRITY_LATCHED", null);
        }

        if (isWarmup) {
            engine = S.READY;
            return outcome(record, R.WARMUP_COMPLETE, "WARMUP_SINGLE_CALLBACK_RESOLVED", null, null);
        }

        if (!sessionIsCurrent(record.sessionToken)) {
            counters.resultsDiscardedStale++;
            return outcome(record, R.DISCARDED_STALE, "SESSION_ENDED_OR_REPLACED", null, null);
        }

        counters.resultsEligible++;
        return outcome(record, R.ELIGIBLE, "SINGLE_CALLBACK_RESOLVED", null, held);
    }

    // ---- queries ----------------------------------------------------------

    function canDispatchFrame(sessionToken) {
        return latch === null && open === null && engine === S.READY && sessionIsCurrent(sessionToken);
    }

    function hasOpenRequest() {
        return open !== null;
    }

    // Plain, JSON-safe copy for diagnostics and tests.
    function snapshot() {
        return {
            engine,
            requiresReload: latch !== null || warmupFailure !== null,
            latch: latch === null ? null : { ...latch },
            warmupFailure: warmupFailure === null ? null : { ...warmupFailure },
            session: session === null ? null : { ...session },
            openRequest: open === null ? null : {
                requestId: open.record.requestId,
                kind: open.record.kind,
                sessionToken: open.record.sessionToken,
                callbacks: open.callbacks
            },
            counters: { ...counters },
            identity: "not established: the legacy onResults callback carries no request ID"
        };
    }

    return Object.freeze({
        beginWarmup,
        beginSession,
        endSession,
        dispatchFrame,
        recordCallback,
        settle,
        canDispatchFrame,
        hasOpenRequest,
        snapshot
    });
}
