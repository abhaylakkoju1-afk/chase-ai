// Chase engine — TrackedSequence v1: an additive, session-scoped
// snapshot of raw PoseFrame observations.
//
// This is a plain classic script, not an ES module — see the
// loading-order comment at the top of src/chase-engine/geometry.js for
// why (loaded via <script src="...">, same as geometry.js/stats.js/
// stroke-cycles.js/pose-frame.js/frame-timing.js).
//
// WHAT THIS IS
// ------------
// TrackedSequence wraps an already-captured chasePoseFrameHistory
// array (see index.html) plus a small amount of session-level
// identity/provenance, into one addressable object. It does not
// replace chasePoseFrameHistory, metricsHistory, or anything they
// feed (stroke-cycle detection, coaching, displayed metrics) — see
// docs/ARCHITECTURE.md §2.4 for the corrected TrackedSequence concept
// this implements, and CLAUDE.md §15 for the measured/inferred/
// indeterminate distinction this file is careful not to blur.
//
// WHAT IT DELIBERATELY DOES NOT CONTAIN (v1)
// -------------------------------------------
// - Busy-skip / gap accounting. A video frame that was due to be
//   sampled but skipped because inference was still busy (see
//   chaseStartVideoFrameTicker in index.html) leaves no PoseFrame —
//   TrackedSequence contains sampled/inference observations, NOT
//   every decoded video frame, and today has no way to represent "a
//   sample was skipped here." This is a known, intentionally deferred
//   limitation, not an oversight — closing it requires a live-capture
//   change (recording skip events at the point they happen), which is
//   a separately-scoped follow-up, not part of v1.
// - Smoothing, interpolation, confidence/quality scores, biomechanical
//   measurements, stroke phases, cycles, or tracking identities. All
//   of these are DERIVED data (see CLAUDE.md §15) and belong to a
//   separate, later layer built on top of a TrackedSequence — never
//   inside it. A TrackedSequence is raw evidence, exactly like the
//   PoseFrames it contains.
// - Any persistence/serialization concern. A TrackedSequence is
//   in-memory and ephemeral, scoped to one analysis session, exactly
//   like chasePoseFrameHistory already is (see index.html's upload()
//   reset). Nothing here writes to Firebase, localStorage, or any
//   other store.
//
// PURE, NO GLOBAL STATE
// ----------------------
// chaseBuildTrackedSequence() takes every value it needs as an
// argument — no DOM, no video element, no MediaPipe, no Firebase, no
// dependency on chasePoseFrameHistory/chaseAnalysisGeneration/
// window.chaseAI as globals. The caller (index.html) is responsible
// for supplying the live values; this function only shapes them.
//
// FRAMES ARE NEVER REINTERPRETED
// --------------------------------
// The supplied `frames` array is copied (see the defensive-copy note
// below) but never sorted, filtered, deduplicated, or checked for
// timestamp monotonicity. A frame with `hasPose: false` is preserved
// exactly like any other — TrackedSequence records what was captured,
// it does not judge it. Consumers that need ordering/continuity
// guarantees are responsible for checking them; PoseFrame's own
// `frameIndex` (always monotonic, since it is push order) and
// `videoTimestampMs` (which can behave non-monotonically under a
// seek/loop) are the tools already available for that — see the
// TrackedSequence architecture assessment for why both are kept on
// PoseFrame rather than collapsed into one.

// Deterministic sequence-id helper. `generation` (chaseAnalysisGeneration
// in index.html) already strictly increases once per analysis session
// within one page load, so a sequenceId derived purely from it is
// deterministic (same generation -> same id, useful for tests) and
// practically unique for the current single-tab usage pattern. This is
// NOT a durable, cross-page-load identity — same caveat as `generation`
// itself; do not treat it as a persistent clip/session identifier.
function chaseGenerateSequenceId(generation) {
    return `chase-sequence-gen-${generation}`;
}

// Builds one TrackedSequence snapshot from caller-supplied values.
//
// Required: sequenceId, generation, timestampMode, modelSource, frames.
// Optional (default null): clipId, startedAt, endedAt.
//
// `frames` is defensively shallow-copied (not held as a live reference
// to the caller's array) so that a later push onto the caller's
// original array — for example a straggling, late-resolving
// pose.send() result that arrives after this snapshot was taken —
// cannot silently grow or otherwise mutate an already-built sequence.
// The individual PoseFrame objects inside are not deep-cloned; they
// are already independently constructed, immutable-in-practice
// objects (chaseBuildPoseFrame() builds a fresh object per frame, and
// nothing in this codebase mutates a PoseFrame after it is pushed).
function chaseBuildTrackedSequence({
    sequenceId,
    generation,
    timestampMode,
    modelSource,
    frames,
    clipId = null,
    startedAt = null,
    endedAt = null
} = {}) {

    return {
        sequenceId,
        generation,
        timestampMode,
        modelSource,
        frames: Array.isArray(frames) ? frames.slice() : [],
        clipId,
        startedAt,
        endedAt
    };
}
