// Chase engine — frame/timestamp association for PoseFrame capture.
//
// This is a plain classic script, not an ES module — see the
// loading-order comment at the top of src/chase-engine/geometry.js for
// why (loaded via <script src="...">, same as geometry.js/stats.js/
// stroke-cycles.js/pose-frame.js).
//
// PROBLEM THIS SOLVES
// --------------------
// chaseCaptureAdditivePoseFrame() previously stamped a PoseFrame with
// `video.currentTime * 1000` read AFTER MediaPipe's asynchronous
// pose.send() had already resolved — i.e. the timestamp described
// whatever frame the video had moved on to by the time inference
// finished, not the frame whose pixels were actually sent to MediaPipe.
//
// A first attempt fixed this by caching requestVideoFrameCallback's
// mediaTime continuously and having a separate setInterval-driven
// sampling loop read that cache when it decided to draw a frame. That
// does not strictly guarantee the cached value belongs to the exact
// frame drawImage() captures — the cache could be one or more
// presented frames stale by the time the interval fires.
//
// The corrected model makes requestVideoFrameCallback() ITSELF the
// frame-selection clock: every function here is called from data
// available in a single rVFC callback invocation, for the single frame
// that invocation describes — never from a value cached across
// callbacks. index.html's rVFC callback:
//   1. receives metadata.mediaTime for the frame just presented,
//   2. asks chaseIsSampleDue() whether ~120ms has elapsed since the
//      last analyzed sample (preserving the existing sampling cadence
//      without running inference on every displayed frame),
//   3. if due, draws THAT frame and calls chaseBuildPendingFrameTiming()
//      with THIS SAME metadata.mediaTime to build the record that
//      travels with the dispatched inference request,
//   4. on result, chaseSelectFrameTimestamp() returns the frozen value
//      from that record — never a fresh, later read of video.currentTime.
//
// What this claims, precisely: the sampled frame, the drawImage() call,
// and the mediaTime attached to the inference request all originate
// from the same requestVideoFrameCallback invocation — not that this
// is mathematically perfect frame synchronization (browser compositing
// and rVFC scheduling are outside this code's control).
//
// All three decision functions below are pure (no DOM, no MediaPipe,
// no globals) so they can be unit-tested without a browser. rVFC
// registration/cancellation, canvas drawing, and pose.send() dispatch
// stay in index.html, which only calls these functions with plain data.
//
// VALIDATION STATUS
// ------------------
// test/frame-timing.test.js validates this file's decision logic in
// isolation, and test/e2e/frame-timing-lifecycle.spec.js validates the
// index.html wiring (chaseStartVideoFrameTicker/chaseStopVideoFrameTicker/
// chaseDispatchPoseInference) against a synthetic, fully-scripted
// requestVideoFrameCallback stand-in — never a real video fixture. That
// covers the state machine and lifecycle (sampling cadence, busy-skip,
// generation handling, cancellation) but does not exercise real
// browser-native rVFC firing against actually-decoded video frames, or
// real MediaPipe inference. That native, real-video validation has not
// been performed and is deferred until the evaluation pilot clips
// described in docs/evaluation/EVALUATION_INFRASTRUCTURE.md are
// available — no swimmer footage or video fixture is being added here
// to work around that gap.

// Feature-detects requestVideoFrameCallback on a given video-like
// object. A plain typeof check, not a browser/version sniff — some
// browsers (older Firefox, in particular) do not implement it, and
// feature detection is the only reliable way to know at runtime.
function chaseSupportsVideoFrameCallback(video) {
    return !!(video && typeof video.requestVideoFrameCallback === "function");
}

// Sampling-cadence decision: given the mediaTime of the frame the
// current rVFC callback is looking at, and the mediaTime of the last
// frame actually analyzed, decide whether this frame is due to be
// analyzed too. This is what lets rVFC (which fires once per displayed
// video frame, i.e. potentially 30-60 times/sec) drive analysis at the
// existing, much coarser ~120ms cadence instead of running MediaPipe on
// every displayed frame.
//
// - `lastAnalyzedMediaTimeMs` is null before the first sample of an
//   analysis session (or after a reset) -> always due; this is what
//   handles "first frame of an analysis".
// - A negative elapsed time (currentMediaTimeMs < lastAnalyzedMediaTimeMs)
//   means playback jumped backward relative to the last analyzed
//   sample — a seek, a loop, or a restarted video. Waiting for
//   `sampleIntervalMs` to re-accumulate from a baseline now ahead of
//   current playback would silently stall sampling, so this is treated
//   as due immediately rather than as "not yet due".
// - A non-finite `currentMediaTimeMs` (should not happen in practice,
//   but rVFC/currentTime values are numbers of unknown provenance) is
//   never due — there is nothing meaningful to sample.
function chaseIsSampleDue({
    lastAnalyzedMediaTimeMs,
    currentMediaTimeMs,
    sampleIntervalMs
} = {}) {

    if (typeof currentMediaTimeMs !== "number" || !Number.isFinite(currentMediaTimeMs)) {
        return false;
    }

    if (
        lastAnalyzedMediaTimeMs === null ||
        typeof lastAnalyzedMediaTimeMs !== "number" ||
        !Number.isFinite(lastAnalyzedMediaTimeMs)
    ) {
        return true;
    }

    const elapsedMs = currentMediaTimeMs - lastAnalyzedMediaTimeMs;

    return elapsedMs < 0 || elapsedMs >= sampleIntervalMs;
}

// Called once per dispatched inference request — i.e. once per rVFC
// callback (or fallback timer tick) that decided a sample was due —
// BEFORE pose.send() is awaited. Builds the small pending record that
// travels alongside the in-flight inference request.
//
// `candidateMediaTimeMs` must be the mediaTime read from THE SAME rVFC
// callback that selected this frame for analysis (not a value cached
// from an earlier callback) — that is what associates the timestamp
// this function produces with the same rVFC invocation that selected
// the frame drawImage() captures, rather than a separately-cached
// value. When requestVideoFrameCallback is unsupported, the caller
// passes `supportsVideoFrameCallback: false` and this always falls
// back to `fallbackVideoTimeMs` (video.currentTime * 1000, read at the
// same moment the frame was captured — still "now", not "whenever
// inference finishes").
//
// A non-finite `candidateMediaTimeMs` (a malformed/missing rVFC
// metadata value) is treated the same as unsupported: fall back rather
// than trust it.
function chaseBuildPendingFrameTiming({
    candidateMediaTimeMs,
    supportsVideoFrameCallback,
    generation,
    fallbackVideoTimeMs
} = {}) {

    const candidateIsValid =
        !!supportsVideoFrameCallback &&
        typeof candidateMediaTimeMs === "number" &&
        Number.isFinite(candidateMediaTimeMs);

    return {
        mediaTimeMs: candidateIsValid ? candidateMediaTimeMs : fallbackVideoTimeMs,
        isFrameAccurate: candidateIsValid,
        generation
    };
}

// Called once per inference RESULT (inside chaseCaptureAdditivePoseFrame,
// when MediaPipe's onResults fires), to decide what videoTimestampMs a
// PoseFrame should actually carry.
//
// This does not re-read "now" — it returns the frozen value captured
// at dispatch time (`pendingTiming.mediaTimeMs`), which is the whole
// point: inference completion must never overwrite the video timestamp
// with a later moment.
//
// The one case where the pending record is intentionally distrusted is
// a generation mismatch: `pendingTiming.generation` was stamped with
// whatever analysis session was active when the frame was dispatched,
// and `currentGeneration` reflects the session active right now. These
// differ only when a new analysis session has started (new upload,
// analyzer reset) while this particular inference was still in flight
// — an unavoidable byproduct of pose.send() being asynchronous and only
// one inference running at a time. In that case the pending mediaTime
// belongs to a video/session that no longer exists, so this falls back
// to `fallbackVideoTimeMs` (read fresh, at result time) rather than
// attributing a stale or foreign timestamp to the current session.
function chaseSelectFrameTimestamp({
    pendingTiming,
    currentGeneration,
    fallbackVideoTimeMs
} = {}) {

    const pendingIsCurrent = !!(
        pendingTiming &&
        pendingTiming.generation === currentGeneration &&
        typeof pendingTiming.mediaTimeMs === "number" &&
        Number.isFinite(pendingTiming.mediaTimeMs)
    );

    return {
        videoTimestampMs: pendingIsCurrent ? pendingTiming.mediaTimeMs : fallbackVideoTimeMs,
        isFrameAccurate: pendingIsCurrent ? !!pendingTiming.isFrameAccurate : false
    };
}
