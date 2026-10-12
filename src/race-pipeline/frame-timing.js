// Race pipeline — frame/timestamp association for the race-page frame
// driver.
//
// Pure, deterministic, browser-independent. Independently implements the
// SAME decision logic already proven by src/chase-engine/frame-timing.js
// (requestVideoFrameCallback as the frame-selection clock, a sampling-
// cadence gate, and a generation token guarding against stale async
// results) — per Stage 4D.6's explicit instruction to mirror proven Chase
// behavior WITHOUT importing Chase or modifying it. This file does not
// import anything from src/chase-engine/*, and Chase's own frame-timing.js
// is untouched.
//
// docs/RACE_PIPELINE_ARCHITECTURE.md §4 (Timestamp Contract): "requestVideoFrameCallback's
// metadata.mediaTime, when supported... or video.currentTime, read at the
// same moment a frame is captured, as the fallback" — converted to
// milliseconds exactly once, here, before a PoseSample is ever built.
//
// ONE DELIBERATE DIFFERENCE FROM CHASE: Chase's chaseSelectFrameTimestamp()
// falls back to a freshly-read timestamp for a stale-generation result
// (it still keeps and processes that frame, just with a less-trusted
// timestamp) — a reasonable choice for Chase's own use (every frame's
// pose data is worth keeping for the coaching history). Race-pipeline's
// correctness stakes are different: a stale result belongs to a
// superseded analysis session and must never be allowed to update the
// CURRENT session's tracking/detector/Chronos state at all — not "update
// it with a less-accurate timestamp". racePipelineIsPendingTimingCurrent()
// below is therefore a strict yes/no gate ("process this result at all,
// or discard it entirely"), not a fallback-timestamp selector — the
// caller (index.html) must discard the whole result when this returns
// false, never attempt to re-timestamp and keep it.

// Feature-detects requestVideoFrameCallback on a given video-like object.
// Same reasoning as Chase's own chaseSupportsVideoFrameCallback(): a
// plain typeof check, not a browser/version sniff.
export function racePipelineSupportsVideoFrameCallback(video) {
    return !!(video && typeof video.requestVideoFrameCallback === "function");
}

// Sampling-cadence decision: given the mediaTime of the frame the current
// rVFC callback is looking at, and the mediaTime of the last frame
// actually analyzed, decide whether this frame is due to be analyzed too.
// Identical decision rules to Chase's chaseIsSampleDue() (first sample of
// a session is always due; a backward jump relative to the last analyzed
// sample is treated as due immediately rather than silently stalling
// sampling; a non-finite currentMediaTimeMs is never due) — an
// independent implementation of the same, already-proven logic.
export function racePipelineIsSampleDue({
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

// Builds the small pending-timing record carried alongside one dispatched
// MediaPipe inference request, BEFORE that request is awaited — mirrors
// Chase's chaseBuildPendingFrameTiming(). `candidateMediaTimeMs` must be
// read from the SAME rVFC callback that selected this frame (never a
// value cached from an earlier callback); when unsupported, or when the
// candidate is non-finite, this always falls back to
// `fallbackVideoTimeMs` (video.currentTime * 1000, read at the same
// moment the frame was captured).
export function racePipelineBuildPendingFrameTiming({
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

// The strict discard gate described in the header note above: true only
// when `pendingTiming` exists and was built for the CURRENT generation.
// The caller must treat `false` as "discard this entire pose result —
// do not feed it to tracking/detectors/Chronos", not as "use a fallback
// timestamp and keep going" (that weaker policy is Chase's, not this
// file's).
export function racePipelineIsPendingTimingCurrent({ pendingTiming, currentGeneration } = {}) {
    return !!(
        pendingTiming &&
        typeof pendingTiming === "object" &&
        pendingTiming.generation === currentGeneration &&
        typeof pendingTiming.mediaTimeMs === "number" &&
        Number.isFinite(pendingTiming.mediaTimeMs)
    );
}
