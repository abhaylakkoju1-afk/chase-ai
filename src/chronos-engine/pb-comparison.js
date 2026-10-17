// Chronos engine — PB comparison.
//
// Pure, deterministic, browser-independent. Implements the PBComparison
// contract (docs/CHRONOS_ARCHITECTURE.md §8), first concretely
// implemented here (Stage 4D.3) — see the header note below on where
// this file's exact signature/shape refines that document's original
// illustrative sketch, per that document's own §2.4 policy.
//
// This module never reads Date.now(), video.currentTime,
// performance.now(), or any other clock, never touches the DOM, and —
// critically — never accesses localStorage and never calls getPB(),
// savePB(), deletePB(), or editPB(). It does not know how a PB was
// found, and it never mutates the PB record it is handed. The caller
// (a future race-pipeline/UI stage) is responsible for obtaining the PB
// record and passing it in.
//
// SIGNATURE REFINEMENT: docs/CHRONOS_ARCHITECTURE.md §7/§8's original
// sketch was `chronosComparePB(finalTimeMs, existingPbTimeString) ->
// PBComparison` — a bare number and a bare string, with no way to check
// event/course compatibility. This task explicitly requires accepting
// "the race result/report" and a PB record shaped
// `{event, course, time, history}`, and explicitly requires enforcing
// event/course compatibility ("do not silently compare mismatched
// event/course data"). Since pb-comparison.js was never previously
// implemented, this is a first-implementation refinement of an
// illustrative sketch, not a change to already-shipped behavior — see
// docs/CHRONOS_ARCHITECTURE.md §2.4. `PBComparison`'s shape is extended
// ADDITIVELY: hasPb, existingPbTimeMs, deltaMs, isNewPb, and formatted
// all keep their original §8 meaning unchanged; `comparable`, `reason`,
// and `result` are new fields needed to honestly represent "we could not
// compare" as a distinct, explicit outcome from every numeric result.
//
// FORWARD NOTE for the race-pipeline stage that will call this: the
// existing getPB(eventName) (index.html) returns only pb.time (a bare
// string), not the full {event, course, time, history} record this
// function's `pb` parameter expects. Obtaining a full record will need
// a small lookup against the existing `pbs` array directly (mirroring
// getPB()'s own search, but returning the whole matching entry) — not a
// change to getPB() itself, and not something this file does.

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

// Parses an existing PB time string into whole milliseconds. Supports
// "ss.ss", "mm:ss.ss", and "h:mm:ss.ss" (colon-separated, ascending
// significance, last segment may carry a decimal) — a fresh, independent
// parser, not a reuse of index.html's own timeToSeconds() (which this
// module must not import, and which has a documented existing
// limitation with h:mm:ss inputs that this independent parser does not
// need to reproduce). Returns null for anything unparsable, never NaN
// and never a coerced guess.
function parsePbTimeToMs(timeString) {
    if (!isNonEmptyString(timeString)) {
        return null;
    }

    const segments = timeString.trim().split(":");
    if (segments.length === 0 || segments.length > 3) {
        return null;
    }

    const numericSegments = segments.map((segment) => Number(segment));
    if (numericSegments.some((value) => !Number.isFinite(value) || value < 0)) {
        return null;
    }

    // Ascending significance from the LAST segment backward: seconds,
    // then minutes, then hours.
    const reversed = [...numericSegments].reverse();
    const seconds = reversed[0] ?? 0;
    const minutes = reversed[1] ?? 0;
    const hours = reversed[2] ?? 0;

    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    return Math.round(totalSeconds * 1000);
}

function formatSecondsDelta(deltaMs) {
    const seconds = Math.abs(deltaMs) / 1000;
    return seconds.toFixed(2);
}

function buildUnavailableResult(reason, hasPb) {
    return {
        comparable: false,
        reason,
        hasPb,
        existingPbTimeMs: null,
        deltaMs: null,
        result: null,
        // Never claim "new PB" without a valid, comparable result —
        // except the one case this function DOES consider a genuine new
        // PB even without a numeric comparison: no prior PB existed at
        // all (see chronosComparePB's own doc comment below).
        isNewPb: false,
        formatted: reason === "no-existing-pb" ? "No existing PB on record" : `PB comparison unavailable (${reason})`
    };
}

/**
 * Compares a finished race's result against an existing PB record.
 *
 * @param {object} report A RaceAnalysisReport-shaped object (or any
 *   object exposing at least `finalTimeMs`, `event`, `course`) — as
 *   produced by chronosBuildReport(). Never mutated.
 * @param {object|null|undefined} pb The existing PB record, shaped
 *   `{event, course, time, history}` (the existing pbs[] entry shape,
 *   unchanged), or null/undefined when no PB exists for this
 *   event/course yet. Never mutated.
 * @returns {object} A PBComparison — see docs/CHRONOS_ARCHITECTURE.md
 *   §8 and this file's header note for the exact (additively refined)
 *   shape.
 */
export function chronosComparePB(report, pb) {
    if (!report || typeof report !== "object" || !isFiniteNumber(report.finalTimeMs)) {
        return buildUnavailableResult("race-not-finished", !!pb);
    }

    // A finished result whose distance progression is UNCONFIRMED (a turn may
    // have been concealed, or analysis ended before the required turns were
    // recorded — docs/RACE_PIPELINE_ARCHITECTURE.md §9.1) is not a verified
    // race-distance result, so it is never compared and never declared a PB,
    // not even the first one for the event. The recorded time is untouched (it
    // stays in the report); only the comparison is withheld. Checked BEFORE the
    // no-PB branch below precisely because that branch would otherwise call an
    // unverified time a new PB.
    if (report.distanceConfidence && report.distanceConfidence.state === "unconfirmed") {
        return buildUnavailableResult("distance-unconfirmed", !!pb);
    }

    if (pb === null || pb === undefined) {
        // No prior record for this event/course — a genuine, deterministic
        // "first PB" outcome, not an error. This is the one case where
        // isNewPb is true without a numeric comparison: there is nothing
        // to have been slower than, and the finished time is, by
        // definition, now the standard for this event/course.
        return {
            comparable: false,
            reason: "no-existing-pb",
            hasPb: false,
            existingPbTimeMs: null,
            deltaMs: null,
            result: null,
            isNewPb: true,
            formatted: "No existing PB on record"
        };
    }

    if (typeof pb !== "object") {
        return buildUnavailableResult("invalid-pb-record", false);
    }

    if (report.event !== undefined && pb.event !== undefined && pb.event !== report.event) {
        return buildUnavailableResult("incompatible-event", true);
    }

    if (report.course !== undefined && pb.course !== undefined && pb.course !== report.course) {
        return buildUnavailableResult("incompatible-course", true);
    }

    const existingPbTimeMs = parsePbTimeToMs(pb.time);
    if (existingPbTimeMs === null) {
        return buildUnavailableResult("invalid-pb-record", true);
    }

    const deltaMs = report.finalTimeMs - existingPbTimeMs;

    let result;
    let isNewPb;
    if (deltaMs < 0) {
        result = "faster";
        isNewPb = true;
    } else if (deltaMs === 0) {
        result = "equal";
        isNewPb = false;
    } else {
        result = "slower";
        isNewPb = false;
    }

    const formatted =
        result === "equal"
            ? "Matches existing PB"
            : `${result === "faster" ? "-" : "+"}${formatSecondsDelta(deltaMs)}s vs PB`;

    return {
        comparable: true,
        reason: null,
        hasPb: true,
        existingPbTimeMs,
        deltaMs,
        result,
        isNewPb,
        formatted
    };
}
