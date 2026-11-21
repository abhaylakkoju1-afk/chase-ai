/* Pose adapter around the pure inference request lifecycle.
   Used by the Chase analyzer only (index.html, initialiseChasePose()):
   every Chase frame send, callback and settlement goes through it. The
   Race page still creates and calls its own MediaPipe Pose, unchanged.

   Classic script (no import/export), like src/inference/request-lifecycle.js,
   which it requires to be loaded first. It uses no browser API, clock,
   timer or randomness. The only engine it touches is the one returned by
   the injected `createEngine()`, so the logic can be driven by a fake.

   WHAT IT DOES
   ------------
   - Owns the engine. The adapter never exposes it, so callers cannot call
     engine.send() themselves: warm-up and frame sends go through
     warmUp() and sendFrame() only.
   - Asks the lifecycle core before every send. If the core refuses
     (request already open, engine not ready, WARMUP_FAILED, latched, no
     active session), the send is NOT forwarded to the engine.
   - Releases the single request slot only when the engine's send settles
     (the core's settle()). There is no timeout: a send that never settles
     keeps the slot for the life of this adapter.
   - Handles the engine's results callback with as little as possible:
     it records the callback in the core FIRST (so nothing below can hide
     a callback from the integrity rules), copies the landmark lists, and
     reads the caller's optional `readArrivalTime()` hook, each guarded.
     All decisions (readiness, callback counts, session validity and
     INT-1 frame outcomes) are the core's.
   - Calls the caller's `onEligibleResult` consumer only for an ELIGIBLE
     frame outcome, after the send has settled and outside the engine's
     callback.

   SESSION FAILURE (reviewed integration decisions 1 and 2)
   -------------------------------------------------------
   An ELIGIBLE frame result whose capture failed (copying the landmarks,
   or reading the arrival time, threw inside the callback) is withheld:
   the consumer is NOT called. A consumer that throws is caught. In both
   cases the adapter ends that request's session (core endSession) and
   returns `failure` on the send's result with `reportWithheld: true`:
   the caller must not produce an analysis report for that session.
   The engine is left available: no latch, no recreation, no close(), no
   timer. A later beginSession() and sendFrame() work as normal. These
   are adapter (page-level) policies, not INT-1 anomalies; the core's
   frame outcome is still reported unchanged on `outcome`.

   TIMESTAMPS (reviewed integration decision 3)
   --------------------------------------------
   Each frame carries two times, both opaque to the adapter:
   - `dispatchTime`: the caller's `meta.dispatchTime`, recorded when the
     frame was dispatched (the time of the frame that was sent);
   - `arrivalTime`: the value `readArrivalTime()` returned when the
     callback arrived (what Chase's metrics use today). Null when no hook
     is given.
   Which one a page uses for which metric is the page's choice; the
   adapter switches nothing.

   INTEGRITY-LATCH NOTIFICATION (optional)
   ---------------------------------------
   If the caller passes `onIntegrityLatch`, the adapter notifies it once
   when the lifecycle core first latches (any INT-1 code), whether the
   latch was set by an unsolicited or extra callback or discovered when a
   send settled. The notification is scheduled as a microtask (no timer),
   so it never runs inside the engine's callback or inside the code that
   recorded the latch. It receives a copy of the core's latch record.
   It is not called for WARMUP_FAILED (not a latch). A throwing or
   rejecting notification is caught and counted: it cannot change the
   lifecycle, the latch or later results, and cannot produce an unhandled
   rejection. It changes no INT-1 rule: the core decides and refuses
   exactly as without it. Its order relative to the send's own returned
   result is not specified.

   WHAT IT DOES NOT DO
   -------------------
   No engine recreation, no close() or reset(), no retained-engine pool,
   no reload, no timers, no UI, and no request identity: the legacy
   onResults callback carries no request ID, so a foreign callback alone
   in a window is indistinguishable from the request's own (the core's
   documented limit).

   RESULT COPY
   -----------
   Only `poseLandmarks` and `poseWorldLandmarks` are copied (each point
   shallow-copied), because they are the only fields either page reads.
   Image, segmentation mask and any other field are not carried. */

const INFERENCE_SESSION_FAILURES = Object.freeze({
    CONSUMER_ERROR: "CONSUMER_ERROR",
    RESULT_COPY_FAILED: "RESULT_COPY_FAILED",
    ARRIVAL_TIME_FAILED: "ARRIVAL_TIME_FAILED"
});

function chaseInferenceSnapshotLandmarkList(list) {
    if (!Array.isArray(list)) return list === undefined ? undefined : null;
    const copy = [];
    for (let i = 0; i < list.length; i++) {
        const point = list[i];
        copy.push(point !== null && typeof point === "object" ? { ...point } : point);
    }
    return copy;
}

function createInferencePoseAdapter(options) {
    const opts = options || {};
    if (typeof opts.createEngine !== "function") {
        throw new TypeError("createInferencePoseAdapter: createEngine must be a function");
    }
    if (opts.onEligibleResult !== undefined && typeof opts.onEligibleResult !== "function") {
        throw new TypeError("createInferencePoseAdapter: onEligibleResult must be a function when given");
    }
    if (opts.readArrivalTime !== undefined && typeof opts.readArrivalTime !== "function") {
        throw new TypeError("createInferencePoseAdapter: readArrivalTime must be a function when given");
    }
    if (opts.onIntegrityLatch !== undefined && typeof opts.onIntegrityLatch !== "function") {
        throw new TypeError("createInferencePoseAdapter: onIntegrityLatch must be a function when given");
    }

    const R = INFERENCE_REQUEST_STATES;
    const F = INFERENCE_SESSION_FAILURES;
    const lifecycle = createInferenceRequestLifecycle();
    const consumer = opts.onEligibleResult || null;
    const readArrivalTime = opts.readArrivalTime || null;
    const onIntegrityLatch = opts.onIntegrityLatch || null;
    let latchNotified = false;
    const failedSessions = new Map(); // session token -> frozen failure

    const counters = {
        sendsForwarded: 0,
        sendsNotForwarded: 0,
        sendsResolved: 0,
        sendsRejected: 0,
        sendsThrewSynchronously: 0,
        callbacksHandled: 0,
        snapshotErrors: 0,
        arrivalTimeErrors: 0,
        consumerCalls: 0,
        consumerErrors: 0,
        resultsWithheld: 0,
        sessionsFailed: 0,
        latchNotificationsScheduled: 0,
        latchNotificationErrors: 0
    };

    function errorText(error) {
        return String(error && error.message ? error.message : error);
    }

    // Schedules the optional latch notification, at most once, the first
    // time the core reports a latch. Only reads the core; the call itself
    // happens later in a microtask, and anything it throws is contained.
    function noteLatch() {
        if (onIntegrityLatch === null || latchNotified) return;
        const latch = lifecycle.snapshot().latch;
        if (latch === null) return;
        latchNotified = true;
        counters.latchNotificationsScheduled++;
        const record = Object.freeze({ ...latch });
        Promise.resolve().then(() => onIntegrityLatch(record)).then(undefined, () => {
            counters.latchNotificationErrors++;
        });
    }

    // Called by the engine for every result. The callback is counted in
    // the core BEFORE anything else, so a failure below can never hide a
    // callback from the integrity rules. Nothing here can throw out.
    function handleEngineResults(results) {
        counters.callbacksHandled++;
        const held = { results: null, arrivalTime: null, captureFailure: null };
        const recorded = lifecycle.recordCallback(held);
        if (recorded.latchReason !== null) noteLatch();
        try {
            held.results = {
                poseLandmarks: chaseInferenceSnapshotLandmarkList(results ? results.poseLandmarks : undefined),
                poseWorldLandmarks: chaseInferenceSnapshotLandmarkList(results ? results.poseWorldLandmarks : undefined)
            };
        } catch (error) {
            counters.snapshotErrors++;
            held.results = null;
            held.captureFailure = { reason: F.RESULT_COPY_FAILED, message: errorText(error) };
            return;
        }
        if (readArrivalTime !== null) {
            try {
                const t = readArrivalTime();
                held.arrivalTime = t === undefined ? null : t;
            } catch (error) {
                counters.arrivalTimeErrors++;
                held.captureFailure = { reason: F.ARRIVAL_TIME_FAILED, message: errorText(error) };
            }
        }
    }

    // The engine is created once, here. If creation throws, the error
    // reaches the caller synchronously (never through a callback).
    const engine = opts.createEngine();
    if (!engine || typeof engine.send !== "function" || typeof engine.onResults !== "function") {
        throw new TypeError("createInferencePoseAdapter: createEngine() must return an object with send() and onResults()");
    }
    engine.onResults(handleEngineResults);

    // Forwards one accepted request to the engine and settles it in the
    // core when the engine's send settles. Never rejects.
    function forward(request, input) {
        counters.sendsForwarded++;
        let pending;
        try {
            pending = Promise.resolve(engine.send(input));
        } catch (error) {
            // A synchronous throw from send() is a rejected send.
            counters.sendsThrewSynchronously++;
            pending = Promise.reject(error);
        }
        return pending.then(
            () => {
                counters.sendsResolved++;
                const outcome = lifecycle.settle(request.requestId, "resolved");
                noteLatch();
                return { outcome, sendError: null };
            },
            (error) => {
                counters.sendsRejected++;
                const outcome = lifecycle.settle(request.requestId, "rejected");
                noteLatch();
                return { outcome, sendError: errorText(error) };
            }
        );
    }

    function result(accepted, refusal, outcome, sendError, failure) {
        return Object.freeze({ accepted, refusal, outcome, sendError, failure });
    }

    function notForwarded(refusal) {
        counters.sendsNotForwarded++;
        return Promise.resolve(result(false, refusal.reason, null, null, null));
    }

    // Ends the outcome's session and records why. The engine is untouched.
    function failSession(outcome, reason, message) {
        const sessionEnded = lifecycle.endSession(outcome.sessionToken, reason);
        counters.sessionsFailed++;
        const failure = Object.freeze({
            kind: "SESSION_FAILED",
            reason,
            message,
            requestId: outcome.requestId,
            sessionToken: outcome.sessionToken,
            sessionEnded,
            reportWithheld: true
        });
        if (!failedSessions.has(outcome.sessionToken)) failedSessions.set(outcome.sessionToken, failure);
        return failure;
    }

    // Sends the dedicated warm-up input. Resolves with the warm-up
    // outcome: WARMUP_COMPLETE (engine READY), REJECTED_WITHOUT_RESULT
    // (engine WARMUP_FAILED) or FAILED_CLOSED (integrity latch).
    function warmUp(input) {
        const begun = lifecycle.beginWarmup({ kind: "warmup" });
        if (!begun.accepted) return notForwarded(begun);
        return forward(begun.request, input).then(({ outcome, sendError }) =>
            result(true, null, outcome, sendError, null));
    }

    // Sends one frame for `sessionToken`. `meta` is the caller's
    // dispatch-time record; `meta.dispatchTime`, if present, is carried
    // to the consumer as the frame's dispatch time. Never read otherwise.
    function sendFrame(sessionToken, input, meta) {
        const begun = lifecycle.dispatchFrame(sessionToken, meta);
        if (!begun.accepted) return notForwarded(begun);
        return forward(begun.request, input).then(({ outcome, sendError }) => {
            if (outcome.state !== R.ELIGIBLE) return result(true, null, outcome, sendError, null);
            const held = outcome.payload;
            if (held.captureFailure !== null) {
                counters.resultsWithheld++;
                return result(true, null, outcome, sendError,
                    failSession(outcome, held.captureFailure.reason, held.captureFailure.message));
            }
            if (consumer === null) return result(true, null, outcome, sendError, null);
            const frameMeta = outcome.meta;
            counters.consumerCalls++;
            try {
                consumer(Object.freeze({
                    requestId: outcome.requestId,
                    sessionToken: outcome.sessionToken,
                    meta: frameMeta,
                    results: held.results,
                    timing: Object.freeze({
                        dispatchTime: frameMeta && frameMeta.dispatchTime !== undefined ? frameMeta.dispatchTime : null,
                        arrivalTime: held.arrivalTime
                    })
                }));
            } catch (error) {
                counters.consumerErrors++;
                return result(true, null, outcome, sendError,
                    failSession(outcome, F.CONSUMER_ERROR, errorText(error)));
            }
            return result(true, null, outcome, sendError, null);
        });
    }

    // The failure that ended `sessionToken`, or null. A caller checks this
    // before producing that session's report.
    function sessionFailure(sessionToken) {
        return failedSessions.has(sessionToken) ? failedSessions.get(sessionToken) : null;
    }

    function snapshot() {
        return {
            lifecycle: lifecycle.snapshot(),
            adapter: { ...counters },
            failedSessions: [...failedSessions.values()].map((f) => ({ ...f }))
        };
    }

    return Object.freeze({
        warmUp,
        sendFrame,
        beginSession: () => lifecycle.beginSession(),
        endSession: (token, reason) => lifecycle.endSession(token, reason),
        canSendFrame: (token) => lifecycle.canDispatchFrame(token),
        hasOpenSend: () => lifecycle.hasOpenRequest(),
        sessionFailure,
        snapshot
    });
}
