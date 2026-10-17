// Chronos engine — RaceAnalysisReport generation.
//
// Pure, deterministic, browser-independent. Implements the
// RaceAnalysisReport contract (docs/CHRONOS_ARCHITECTURE.md §7), first
// concretely implemented here (Stage 4D.3) — see the header note below
// on where this file's exact shape refines that document's original
// illustrative sketch, per that document's own §2.4 policy ("these are
// illustrative shapes, not final types... refine them in the PR that
// first implements each stage").
//
// This module never reads Date.now(), video.currentTime,
// performance.now(), or any other clock, never touches the DOM,
// localStorage, Firebase, or MediaPipe, and does not import from
// src/chase-engine/* or src/swimmer-tracking/*. It does not import
// session.js or events.js either — it treats RaceSession/TimingEvent as
// plain data per their own documented shapes, with no need to
// re-validate rules events.js already enforced when the session was
// built. Chronos's own event acceptance is authoritative: this module
// only ever reads session.events (already-accepted events), never a
// detector candidate, and never recomputes or second-guesses anything
// Chronos itself already decided (session.finalTimeMs is used exactly
// as Chronos set it, never independently derived).
//
// DELIBERATE OMISSION: the original §7 sketch's RaceAnalysisReport
// included a `paceTrend` field ("even"|"positive"|"negative"|
// "indeterminate"). It is NOT implemented here. No approved document
// anywhere specifies the algorithm or threshold that would compute it,
// this task's own explicit required-field list does not ask for it, and
// inventing an undocumented pace-classification algorithm is exactly
// the kind of new semantic contract Stage 4D.3's instructions say to
// stop and report rather than silently invent. Flagged, not built.
//
// ADDITIVE REFINEMENTS beyond the original §7 sketch (each directly
// requested by this task's own explicit required-field list — "start
// event information", "finish event information", "event provenance",
// "detector/confidence information"): `start`, `finish`, `status`,
// `distanceMeters`, and each split's `detector` name. `pbComparison` is
// deliberately NOT part of this shape — Stage 4D.3's own task
// description builds PB comparison as a separate function
// (pb-comparison.js) taking "the race result/report" as an input,
// which only makes sense if report-building and PB-comparison are two
// separate steps a caller composes, not one step where report.js
// reaches into PB data it has no business knowing about.

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

// Provisional, named, overridable — same posture as every other
// not-yet-validated threshold in this codebase (MIN_EVENT_GAP_MS,
// src/swimmer-tracking/tracking.js's DEFAULT_CONFIG, etc.). Not asserted
// as scientifically correct; a real value is a future, fixture-driven
// concern.
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;

function mergeConfig(config) {
    const merged = {
        lowConfidenceThreshold: DEFAULT_LOW_CONFIDENCE_THRESHOLD,
        ...(config || {})
    };
    return merged;
}

function findEventByType(events, type) {
    return events.find((event) => event.type === type) || null;
}

// Builds the small, provenance-only view of a start/finish TimingEvent
// this report exposes — never re-deriving atMs or any other field
// Chronos already computed, only selecting which existing fields are
// relevant to report consumers.
function summarizeEvent(event) {
    if (!event) {
        return null;
    }
    return {
        atMs: event.atMs,
        distanceMeters: event.distanceMeters,
        source: event.source,
        detector: event.detector,
        confidence: event.confidence
    };
}

// Builds the splits[] array from the session's own accepted split/turn
// events, in the exact order they already appear in session.events —
// never re-sorted. session.events is append-only and Chronos's own
// distance/timestamp ordering rules (docs/CHRONOS_ARCHITECTURE.md §10)
// already guarantee this order is the authoritative one; re-sorting here
// would be redefining semantics Chronos already owns.
function buildSplits(events, startEvent) {
    const splitEvents = events.filter((event) => event.type === "split" || event.type === "turn");

    let previousAtMs = startEvent ? startEvent.atMs : null;

    return splitEvents.map((event, index) => {
        const cumulativeTimeMs = startEvent ? event.atMs - startEvent.atMs : null;
        const splitTimeMs = previousAtMs !== null ? event.atMs - previousAtMs : null;
        previousAtMs = event.atMs;

        return {
            index,
            // docs/CHRONOS_ARCHITECTURE.md §12: a "turn" is a physical
            // wall-contact event; a "split" is a generic checkpoint. Both
            // are reported here as checkpoints for report-consumption
            // purposes, but the physical distinction is preserved via
            // `kind` — a turn is never relabeled as indistinguishable
            // from a generic split.
            kind: event.type === "turn" ? "turn" : "checkpoint",
            distanceMeters: event.distanceMeters,
            splitTimeMs,
            cumulativeTimeMs,
            source: event.source,
            detector: event.detector,
            confidence: event.confidence
        };
    });
}

// Chronos reliability phase 2C: the race's distance-confidence state, always
// present so a consumer never has to infer it from absence. "confirmed" means
// no concealed turn has been suspected; "unconfirmed" means distances assigned
// by a detector after `sinceAtMs` cannot be trusted and none were recorded
// (docs/RACE_PIPELINE_ARCHITECTURE.md §9.1). Copied from the session, never
// recomputed.
function summarizeDistanceConfidence(session) {
    const confidence = session.distanceConfidence;
    if (confidence && confidence.state === "unconfirmed") {
        return {
            state: "unconfirmed",
            reason: confidence.reason ?? null,
            sinceAtMs: confidence.sinceAtMs ?? null,
            resumedAtMs: confidence.resumedAtMs ?? null
        };
    }
    return { state: "confirmed", reason: null, sinceAtMs: null, resumedAtMs: null };
}

// The distance established by ACCEPTED turn/split events — never by a finish,
// and never by the configured race distance (`report.distanceMeters`). When
// the distance progression is unconfirmed, only events at or before the point
// it was last trusted (`sinceAtMs`) count: anything a person records after
// that is an assertion, not something the pipeline established. 0 when no such
// event exists. (Chronos reliability, phase 2C follow-up.)
function summarizeConfirmedDistance(events, distanceConfidence) {
    let confirmed = 0;
    for (const event of events) {
        if (event.type !== "turn" && event.type !== "split") {
            continue;
        }
        if (distanceConfidence.state === "unconfirmed" && isFiniteNumber(distanceConfidence.sinceAtMs) && event.atMs > distanceConfidence.sinceAtMs) {
            continue;
        }
        if (isFiniteNumber(event.distanceMeters) && event.distanceMeters > confirmed) {
            confirmed = event.distanceMeters;
        }
    }
    return confirmed;
}

function buildDataQuality(events, cfg, distanceConfidence, finishEvent, finalTimeMs) {
    const manualEventCount = events.filter((event) => event.source === "manual").length;
    const detectorEventCount = events.filter((event) => event.source === "detector").length;
    const lowConfidenceEventCount = events.filter(
        (event) =>
            event.source === "detector" &&
            isFiniteNumber(event.confidence) &&
            event.confidence < cfg.lowConfidenceThreshold
    ).length;

    const notes = [];

    if (!findEventByType(events, "start")) {
        notes.push("no start event recorded");
    }
    if (!findEventByType(events, "finish")) {
        notes.push("no finish event recorded");
    }
    if (distanceConfidence.state === "unconfirmed") {
        notes.push(`distance progression unconfirmed after ${distanceConfidence.sinceAtMs}ms: ${distanceConfidence.reason}`);
        // A finish exists: its TIME is recorded exactly as supplied, but nothing
        // verifies that the swimmer covered the race distance (the finish
        // event's own distance is an assertion, not an observation).
        if (finishEvent) {
            notes.push(`finish time recorded (finish at ${finishEvent.atMs}ms, final time ${finalTimeMs}ms) but the distance sequence is unverified: ${distanceConfidence.reason}`);
        }
    }
    if (lowConfidenceEventCount > 0) {
        notes.push(`${lowConfidenceEventCount} detector event(s) below the confidence threshold (${cfg.lowConfidenceThreshold})`);
    }

    return {
        totalEvents: events.length,
        manualEventCount,
        detectorEventCount,
        lowConfidenceEventCount,
        lowConfidenceThreshold: cfg.lowConfidenceThreshold,
        notes
    };
}

/**
 * Builds a RaceAnalysisReport from a RaceSession.
 *
 * @param {object} session A RaceSession as produced by
 *   src/chronos-engine/session.js / events.js (caller-supplied — this
 *   function never creates or mutates a session).
 * @param {object} [config] Optional overrides, currently only
 *   `lowConfidenceThreshold`.
 * @returns {{ok: boolean, reason: string|null, report: object|null}}
 *   `report` is null only when `session` itself is not a usable
 *   RaceSession-shaped object (missing/malformed `events`). An
 *   incomplete-but-real session (no start yet, no finish yet, zero
 *   events) always produces a valid report with null/empty fields —
 *   never a rejection.
 */
export function chronosBuildReport(session, config) {
    if (!session || typeof session !== "object" || !Array.isArray(session.events)) {
        return { ok: false, reason: "missing-session", report: null };
    }

    const cfg = mergeConfig(config);
    const distanceConfidence = summarizeDistanceConfidence(session);

    const startEvent = findEventByType(session.events, "start");
    const finishEvent = findEventByType(session.events, "finish");

    const report = {
        sessionId: session.sessionId ?? null,
        event: session.event ?? null,
        course: session.course ?? null,
        poolLengthMeters: session.poolLengthMeters ?? null,
        strokeKey: session.strokeKey ?? null,
        // The CONFIGURED race distance (from the selected event). It says what
        // the race is, never how far the swimmer was shown to have gone: see
        // `confirmedDistanceMeters` and `distanceConfidence` for that.
        distanceMeters: session.distanceMeters ?? null,
        // Distance established by accepted turn/split events (see
        // summarizeConfirmedDistance); excludes the finish and the configured
        // distance.
        confirmedDistanceMeters: summarizeConfirmedDistance(session.events, distanceConfidence),
        status: session.status ?? null,

        start: summarizeEvent(startEvent),
        finish: summarizeEvent(finishEvent),

        // Never independently recomputed — session.finalTimeMs is
        // exactly what Chronos itself set (or null, if no finish has
        // been recorded yet). This report never manufactures a finish
        // time, split, turn, or distance that Chronos did not already
        // accept.
        finalTimeMs: session.finalTimeMs ?? null,

        splits: buildSplits(session.events, startEvent),

        distanceConfidence,

        dataQuality: buildDataQuality(session.events, cfg, distanceConfidence, finishEvent, session.finalTimeMs ?? null)
    };

    return { ok: true, reason: null, report };
}
