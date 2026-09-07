// Chase engine — raw pose-frame capture.
//
// This is a plain classic script, not an ES module (no export/import).
// It is loaded via a normal <script src="..."> tag, exactly like
// geometry.js and stats.js — see the loading-order comment at the top
// of src/chase-engine/geometry.js for why (a `type="module"` script
// here would execute AFTER the giant classic application script that
// calls this function, silently breaking it).
//
// chaseBuildPoseFrame() is an ADDITIVE, PARALLEL representation. It
// does not replace, read, or write metricsHistory, and existing metric
// calculation in onChasePoseResults() is unchanged by its presence —
// see the PoseFrame / TrackedSequence research report this function
// implements the first, narrowest slice of.
//
// It stores RAW EVIDENCE, never interpretation: no elbow angle, no
// body alignment, no stroke phase, no stroke rate, no coaching
// findings, and no derived quality/confidence score. Per-landmark
// `visibility` is preserved exactly as MediaPipe returned it (or
// `null` if MediaPipe did not provide one for that landmark — a
// documented real-world occurrence, not assumed never to happen) —
// this function does not threshold, weight, or otherwise judge it.
//
// `videoTimestampMs` is PROVISIONAL. It is whatever timestamp value
// the caller currently has available — today, `video.currentTime *
// 1000`, read inside onChasePoseResults() after MediaPipe's
// asynchronous inference has completed, which is a known, disclosed
// approximation (see the research report's Finding A / Section E).
// This function makes no assumption about, and does not validate,
// where its timestamp came from — a future, separately-scoped task
// may change how the caller produces this value (e.g. via
// requestVideoFrameCallback) without requiring any change here.
//
// Function bodies are original to this file — there is no prior inline
// definition being extracted, unlike geometry.js/stats.js/
// stroke-cycles.js.

function chaseBuildPoseFrame({
    results,
    frameIndex,
    videoTimestampMs,
    imageWidth,
    imageHeight,
    modelSource
} = {}) {

    const hasPose = !!(
        results &&
        Array.isArray(results.poseLandmarks) &&
        results.poseLandmarks.length > 0
    );

    return {
        frameIndex,
        videoTimestampMs,
        imageWidth: imageWidth ?? null,
        imageHeight: imageHeight ?? null,
        modelSource: modelSource ?? null,
        hasPose,
        landmarks: hasPose ? chaseCopyPoseLandmarks(results.poseLandmarks) : null,
        worldLandmarks: hasPose ? chaseCopyPoseLandmarks(results.poseWorldLandmarks) : null
    };
}

// Copies one MediaPipe landmark array into new, plain objects —
// preserving x/y/z exactly as received (no rounding, clamping, or
// derivation) and normalizing a missing `visibility` to `null` rather
// than leaving it `undefined` (a consistent, inspectable shape; not a
// judgment about what a missing visibility means). Never mutates the
// landmark objects MediaPipe returned.
function chaseCopyPoseLandmarks(rawLandmarks) {

    if (!Array.isArray(rawLandmarks)) return null;

    return rawLandmarks.map((landmark) => ({
        x: landmark.x,
        y: landmark.y,
        z: landmark.z,
        visibility: typeof landmark.visibility === "number" ? landmark.visibility : null
    }));
}
