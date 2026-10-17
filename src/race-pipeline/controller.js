// Race pipeline — race-page integration controller.
//
// This is the "controller/state" object described in Stage 4D.6 §2: it
// owns the plain-data glue between one race-page analysis run's Chronos
// session, SwimmerTracking session, detector-adapter state, and
// event-adapter state, and exposes a small set of functions index.html
// calls into. It deliberately owns NO duplicate copy of any state those
// modules already own (Stage 4D.6 §2's explicit prohibition) — it always
// reads/writes through ChronosEngine, SwimmerTracking, detector-adapter,
// and event-adapter, never reimplementing any of their rules.
//
// This file is NOT fully DOM-free the way the pure modules are — it is
// allowed to know a "race analysis" exists as a concept — but it never
// itself touches the DOM, a video element, MediaPipe, or a clock
// (Date.now()/performance.now()/video.currentTime). Every timestamp it
// ever sees arrives already resolved, on a PoseSample handed to it by the
// caller (index.html's frame driver, using src/race-pipeline/frame-timing.js
// and src/race-pipeline/pose-sample-adapter.js) — matching the exact
// same purity boundary already established for detector-adapter.js and
// event-adapter.js (docs/RACE_PIPELINE_ARCHITECTURE.md §14).
//
// TARGET SELECTION NOTE: docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.2
// explains that, given the current single-pose MediaPipe pipeline
// (docs/SWIMMER_TRACKING_ARCHITECTURE.md §3: "returns at most one
// poseLandmarks array per frame"), a TargetSelection's optional `point`
// field exists only as a future seam — "atMs alone is already sufficient
// to identify the moment/pose being confirmed in v1... there is nothing
// to disambiguate among." This controller automatically calls
// SwimmerTracking.selectTarget() with the FIRST PoseSample's own atMs the
// moment analysis begins receiving samples — there is nothing else for a
// user to select among with a single-pose source, so this is an
// application of the architecture's own stated reasoning, not an
// invented selection heuristic.
//
// CALIBRATION POINT (Stage 4D.7 decision #7): as of Stage 4D.7, `config`
// MAY carry an optional `calibrationPoint: {x,y} | null` — the exact
// TargetSelection.point shape (docs/SWIMMER_TRACKING_ARCHITECTURE.md
// §7.2) — produced by index.html's lane-calibration click interaction.
// When present, it is threaded through to the auto-selection
// selectTarget() call above INSTEAD of `point: null`, so the same click
// that calibrates referenceLaneY (see below) also supplies the optional
// selection hint the architecture already anticipated. This does not
// change SwimmerTracking's own logic in any way: session.js's
// trackingSelectTarget() already accepted an optional point and has
// never used it for anything beyond recording it on
// TargetLockState.selection (confirmed by re-reading session.js before
// making this change) — passing a real point instead of null is
// therefore purely additive, backward-compatible metadata, not a
// behavior change to tracking itself.
//
// START REFERENCE (Chronos reliability phase 1C): `config.startReferenceMs`
// is the media time of the frame the user paused on and marked BEFORE the
// start. It is REQUIRED, validated here, stored on controller.config, and
// handed to the start detector as `referenceFrameMs`, which refuses any
// departure that begins earlier. It is the start-search CONTEXT only: it is
// not the race start, not the estimated motion onset, and not a Chronos
// event. It does not touch SwimmerTracking: tracking still receives every
// sample from the start of the footage and may lock before the reference.
// Whether the marked frame really is a pre-start frame cannot be verified by
// software; see docs/RACE_PIPELINE_ARCHITECTURE.md §7.3.
//
// referenceLaneY: per docs/CHRONOS_ARCHITECTURE.md's turn detector and
// the Stage 4D.5.1 investigation, there is no legitimate derivation for
// this value anywhere in the codebase (the only prior art, index.html's
// dead laneCenterY-from-first-frame heuristic, is explicitly flagged as
// a limitation to avoid, not a pattern to copy). This controller treats
// referenceLaneY as caller-supplied, optional configuration: when finite,
// turn detection runs; when absent, turn detection is safely disabled for
// the whole race (never a fabricated/default value), with the exact
// diagnostic reason Stage 4D.6 §9 requires.
//
// RACE METADATA NOTE: docs/RACE_PIPELINE_ARCHITECTURE.md §20's own Stage
// Sequence lists "new stroke/distance/course form controls" as Stage
// 4D.7 — NOT this stage. This controller therefore never invents
// poolLengthMeters/course/event/strokeKey/distanceMeters; it requires the
// caller to supply a complete, valid config object and refuses (with a
// stable reason) to start a session otherwise. Until Stage 4D.7 exists,
// index.html has no legitimate metadata source, so automatic analysis is
// expected to stay blocked — see index.html's own comment at
// window.racePipelineConfig for how this is exposed for now.

import { ChronosEngine } from "../chronos-engine/index.js";
import { SwimmerTracking } from "../swimmer-tracking/index.js";
import {
    racePipelineCreateDetectorState,
    racePipelineDetectStartCandidate,
    racePipelineDetectTurnCandidate
} from "./detector-adapter.js";
import {
    racePipelineCreateEventAdapterState,
    racePipelineSubmitStartCandidate,
    racePipelineSubmitTurnCandidate
} from "./event-adapter.js";

export const TURN_DETECTION_UNAVAILABLE_REASON = "Turn detection unavailable: reference lane Y not configured.";

// The reason recorded when an observation gap next to a wall zone could have
// concealed a turn (Chronos reliability, phase 2C; see runTurnDetection).
export const DISTANCE_AMBIGUITY_REASON = "possible-missed-turn-during-tracking-gap-near-wall";

// The reason recorded when analysis ended (tracking degraded terminally, or the
// stream ended while the target was lost) before the race's required turns were
// all recorded (Chronos reliability, phase 2C follow-up).
export const DISTANCE_ANALYSIS_ENDED_REASON = "analysis-ended-before-distance-confirmed";

// The reason recorded when the turn assessment saw a COMPLETE wall reversal
// (approach, apex in a wall zone, sustained recovery) and refused it only
// because the apex was outside the lane (Chronos reliability, phase 2D).
export const DISTANCE_LANE_GATE_REASON = "wall-reversal-refused-by-lane-gate";

// The reason recorded when the observations contain a COMPLETE, sustained wall-
// style reversal that the wall-zone gate did not accept (its apex is outside the
// zone), so a turn may have gone unrecorded (Chronos reliability, phase 2E). It
// states a fact about the evidence, not that a turn occurred.
export const DISTANCE_OUTSIDE_ZONE_REASON = "complete-reversal-outside-wall-zone";

// How many untrusted turn observations the diagnostics keep (oldest dropped).
const MAX_UNCONFIRMED_TURN_OBSERVATIONS = 100;

function freshDistanceConfidence() {
    return { state: "confirmed", reason: null, sinceAtMs: null, resumedAtMs: null };
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value) {
    return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function freshDiagnostics() {
    return {
        lastTrackingStatus: null,
        lastObservationOutcome: null,
        lastEvent: null,
        // The most recent start assessment (state/reason from the start
        // detector and the media time of the sample it evaluated), so a
        // missed or ambiguous start is visible rather than silent. Written
        // only while the session is "armed"; once Chronos accepts a start
        // the start detector is no longer run and this keeps the confirming
        // assessment. Informational only: nothing reads it to decide what
        // Chronos accepts.
        lastStartAssessment: null,
        // The most recent turn assessment (state/reason from the turn
        // detector and the media time of the sample that was evaluated).
        // Written only while the session is "running" and turn detection is
        // available. Informational only, like lastStartAssessment.
        lastTurnAssessment: null,
        // Chronos reliability phase 2C: a read-through of the session's
        // distance confidence ("confirmed" until a turn could have been
        // concealed in an observation gap, then "unconfirmed" for the rest of
        // the race), and the turn candidates that were seen afterwards but NOT
        // recorded because their distance can no longer be trusted. Evidence,
        // not events: nothing here reaches Chronos.
        distanceConfidence: freshDistanceConfidence(),
        unconfirmedTurnObservations: [],
        turnDetectionAvailable: false,
        turnDetectionUnavailableReason: TURN_DETECTION_UNAVAILABLE_REASON
    };
}

// Creates a fresh, independent controller — the analog of
// racePipelineCreateDetectorState()/racePipelineCreateEventAdapterState()
// for this whole integration layer. No module-level state anywhere in
// this file; every value a caller needs across calls lives on the object
// this function returns.
export function racePipelineCreateController() {
    return {
        generation: 0,
        chronosSession: null,
        trackingSession: null,
        detectorState: null,
        eventAdapterState: null,
        config: null,
        blockedReason: null,
        report: null,
        diagnostics: freshDiagnostics()
    };
}

// Validates a race-metadata config object BEFORE any session is created.
// Mirrors exactly what src/chronos-engine/session.js's own
// chronosValidateSessionParams() will require (this function does not
// invent stricter or looser rules — it exists only so a bad config is
// caught with a stable reason before SwimmerTracking/detector/event-
// adapter state is created for nothing), plus one additional optional
// field this controller itself owns: referenceLaneY.
function validateConfig(config) {
    if (!config || typeof config !== "object") {
        return "missing-config";
    }
    if (!isPositiveFiniteNumber(config.poolLengthMeters)) {
        return "invalid-pool-length-meters";
    }
    if (!isNonEmptyString(config.course)) {
        return "missing-course";
    }
    if (!isNonEmptyString(config.event)) {
        return "missing-event";
    }
    if (
        config.strokeKey !== null &&
        config.strokeKey !== undefined &&
        !isNonEmptyString(config.strokeKey)
    ) {
        return "invalid-stroke-key";
    }
    if (
        config.distanceMeters !== null &&
        config.distanceMeters !== undefined &&
        !isPositiveFiniteNumber(config.distanceMeters)
    ) {
        return "invalid-distance-meters";
    }
    if (
        config.referenceLaneY !== null &&
        config.referenceLaneY !== undefined &&
        !isFiniteNumber(config.referenceLaneY)
    ) {
        return "invalid-reference-lane-y";
    }
    // The pre-start reference frame (media time, ms) is REQUIRED: it is the
    // start-search context. A missing or unusable value is refused with a
    // stable reason; it never defaults to 0 or to "unconstrained".
    if (config.startReferenceMs === null || config.startReferenceMs === undefined) {
        return "missing-start-reference";
    }
    if (!isFiniteNumber(config.startReferenceMs) || config.startReferenceMs < 0) {
        return "invalid-start-reference";
    }
    if (
        config.calibrationPoint !== null &&
        config.calibrationPoint !== undefined &&
        (
            typeof config.calibrationPoint !== "object" ||
            !isFiniteNumber(config.calibrationPoint.x) ||
            !isFiniteNumber(config.calibrationPoint.y)
        )
    ) {
        return "invalid-calibration-point";
    }
    return null;
}

// Which turns the race still requires, from the session's OWN configuration and
// the trusted counter — never guessed (the same contract the event adapter and
// the terminal-tracking treatment use). The required turns are the pool-length
// multiples strictly below the race distance, so `outstanding` is false only
// when pool length and race distance are both valid, the distance is a whole
// number of pool lengths, and the trusted counter has reached
// `distance - pool` (or the race has no turn at all). When the configuration
// cannot be counted, `outstanding` is true ("possible") and
// `requiredTurnsKnown` is false. Shared by applyTerminalTrackingTreatment()
// and the lane-gate treatment in runTurnDetection() (phase 2D) so the two cannot
// disagree about "nothing is outstanding".
function describeRequiredTurns(session, eventAdapterState) {
    const confirmedDistanceMeters = eventAdapterState ? eventAdapterState.confirmedDistanceMeters : 0;
    const poolLengthMeters = session.poolLengthMeters;
    const raceDistanceMeters = session.distanceMeters;
    const poolLengths = isPositiveFiniteNumber(poolLengthMeters) && isPositiveFiniteNumber(raceDistanceMeters)
        ? raceDistanceMeters / poolLengthMeters
        : null;
    const requiredTurnsKnown = poolLengths !== null && Math.abs(poolLengths - Math.round(poolLengths)) <= 1e-9;
    const requiredTurns = requiredTurnsKnown ? Math.max(0, Math.round(poolLengths) - 1) : null;
    const outstanding = !(requiredTurnsKnown && confirmedDistanceMeters >= raceDistanceMeters - poolLengthMeters);
    return { confirmedDistanceMeters, requiredTurns, requiredTurnsKnown, outstanding };
}

/* TERMINAL TRACKING (Chronos reliability, phase 2C follow-up).

   SwimmerTracking's ANALYSIS_DEGRADED is terminal: afterwards no sample ever
   reaches a detector, so the observation-gap rule (which needs a sample AFTER
   the gap) can never run. Without this step a race whose analysis ended just
   after a possibly concealed turn would report distance as "confirmed" while
   its turn history is incomplete. The same holds for a stream that ends while
   the target is still TARGET_LOST (a recoverable state, so only the explicit
   end-of-stream notification, racePipelineEndAnalysis(), counts it).

   When the race has an accepted start (Chronos is running), the distance is not
   already unconfirmed, and tracking is terminal, this marks distance
   unconfirmed — UNLESS no required turn can be missing:
     - the race distance and pool length are both valid and the distance is a
       whole number of pool lengths (the same contract the event adapter uses),
       so the required turns are the pool-length multiples strictly below the
       race distance; and
     - the trusted counter has already reached the last of them
       (confirmedDistanceMeters >= distance - pool): nothing is outstanding. A
       race with no turn at all (distance <= pool) is the same case.
   If the configuration cannot be counted, the answer is "possible" and the
   mark is set (evidence.requiredTurnsKnown: false) — the number of turns is
   never guessed in either direction.

   sinceAtMs is the last confirmed observation (tracking's lastConfirmedAtMs),
   never earlier than the accepted start; if that is unavailable the start time
   is used (everything after the start is then unverified — the safest
   representation, not an invented instant). resumedAtMs is null: tracking never
   resumed. Idempotent: an existing record is never replaced. Before the start
   nothing is marked (no distance had begun). No turn, split or finish is
   created. */
function applyTerminalTrackingTreatment(controller, { streamEnded = false } = {}) {
    const session = controller.chronosSession;
    const tracking = controller.trackingSession;
    if (!session || !tracking || session.status !== "running" || session.distanceConfidence) {
        return controller;
    }

    const terminal = tracking.status === "ANALYSIS_DEGRADED" || (streamEnded && tracking.status === "TARGET_LOST");
    if (!terminal) {
        return controller;
    }

    const { confirmedDistanceMeters, requiredTurns, requiredTurnsKnown, outstanding } = describeRequiredTurns(session, controller.eventAdapterState);
    if (!outstanding) {
        return controller;
    }

    const startEvent = session.events.find((event) => event.type === "start");
    const lastConfirmedAtMs = isFiniteNumber(tracking.lastConfirmedAtMs) ? tracking.lastConfirmedAtMs : null;
    const sinceAtMs = lastConfirmedAtMs !== null && lastConfirmedAtMs >= startEvent.atMs ? lastConfirmedAtMs : startEvent.atMs;

    const marked = ChronosEngine.markDistanceUnconfirmed(session, {
        reason: DISTANCE_ANALYSIS_ENDED_REASON,
        sinceAtMs,
        resumedAtMs: null,
        evidence: {
            trigger: tracking.status === "ANALYSIS_DEGRADED" ? "tracking-degraded" : "stream-ended-while-target-lost",
            trackingStatus: tracking.status,
            degradedReason: tracking.degradedReason ?? null,
            lastConfirmedAtMs,
            confirmedDistanceMeters,
            requiredTurns,
            requiredTurnsKnown
        }
    });
    if (!marked.ok) {
        return controller;
    }

    return {
        ...controller,
        chronosSession: marked.session,
        diagnostics: {
            ...controller.diagnostics,
            distanceConfidence: { state: "unconfirmed", reason: DISTANCE_ANALYSIS_ENDED_REASON, sinceAtMs, resumedAtMs: null }
        }
    };
}

function blockedController(controller, reason) {
    return {
        ...racePipelineCreateController(),
        generation: controller.generation,
        blockedReason: reason
    };
}

/**
 * Starts a fresh automatic-analysis run: creates a fresh Chronos
 * RaceSession, a fresh SwimmerTracking session, fresh detector-adapter
 * state, and fresh event-adapter state, and bumps the generation token
 * (Stage 4D.6 §13 "Analysis start"). Never invents metadata — `config`
 * must already carry real values (see the RACE METADATA NOTE above).
 *
 * @param {object} controller
 * @param {{poolLengthMeters:number, course:string, event:string, strokeKey?:string|null, distanceMeters?:number|null, referenceLaneY?:number|null, calibrationPoint?:{x:number,y:number}|null}} config
 * @returns {{ok:boolean, reason:string|null, controller:object}}
 */
export function racePipelineStartAnalysis(controller, config) {
    const configReason = validateConfig(config);
    if (configReason) {
        return { ok: false, reason: configReason, controller: blockedController(controller, configReason) };
    }

    const nextGeneration = controller.generation + 1;
    const sessionId = `race-${nextGeneration}`;

    const createdSession = ChronosEngine.createSession({
        sessionId,
        poolLengthMeters: config.poolLengthMeters,
        course: config.course,
        event: config.event,
        strokeKey: config.strokeKey ?? null,
        distanceMeters: config.distanceMeters ?? null,
        timeSource: "video"
    });
    if (!createdSession.ok) {
        return { ok: false, reason: createdSession.reason, controller: blockedController(controller, createdSession.reason) };
    }

    const armedSession = ChronosEngine.armSession(createdSession.session);
    if (!armedSession.ok) {
        return { ok: false, reason: armedSession.reason, controller: blockedController(controller, armedSession.reason) };
    }

    const trackingSession = SwimmerTracking.createSession({ sessionId });
    if (!trackingSession.ok) {
        return { ok: false, reason: trackingSession.reason, controller: blockedController(controller, trackingSession.reason) };
    }

    const referenceLaneY = isFiniteNumber(config.referenceLaneY) ? config.referenceLaneY : null;
    const calibrationPoint = (config.calibrationPoint && typeof config.calibrationPoint === "object")
        ? { x: config.calibrationPoint.x, y: config.calibrationPoint.y }
        : null;

    const nextController = {
        generation: nextGeneration,
        chronosSession: armedSession.session,
        trackingSession: trackingSession.session,
        detectorState: racePipelineCreateDetectorState(),
        eventAdapterState: racePipelineCreateEventAdapterState(),
        config: {
            poolLengthMeters: config.poolLengthMeters,
            course: config.course,
            event: config.event,
            strokeKey: config.strokeKey ?? null,
            distanceMeters: config.distanceMeters ?? null,
            referenceLaneY,
            calibrationPoint,
            startReferenceMs: config.startReferenceMs
        },
        blockedReason: null,
        report: null,
        diagnostics: {
            lastTrackingStatus: trackingSession.session.status,
            lastObservationOutcome: null,
            lastEvent: null,
            lastStartAssessment: null,
            lastTurnAssessment: null,
            distanceConfidence: freshDistanceConfidence(),
            unconfirmedTurnObservations: [],
            turnDetectionAvailable: referenceLaneY !== null,
            turnDetectionUnavailableReason: referenceLaneY !== null ? null : TURN_DETECTION_UNAVAILABLE_REASON
        }
    };

    return { ok: true, reason: null, controller: nextController };
}

// The estimated motion onset an assessment concerns, or null when it concerns
// none (nothing departed, not yet confirmed, a hard gate failed).
function startAssessmentOnsetMs(assessment) {
    if (assessment.candidate && assessment.candidate.evidence && isFiniteNumber(assessment.candidate.evidence.onsetAtMs)) {
        return assessment.candidate.evidence.onsetAtMs;
    }
    if (assessment.state === "rejected" && assessment.evidence && isFiniteNumber(assessment.evidence.onsetAtMs)) {
        return assessment.evidence.onsetAtMs;
    }
    return null;
}

// Runs the start detector ONLY while Chronos has not yet recorded a
// start (session.status === "armed") — Stage 4D.6 §10's mandatory rule,
// and the concrete fix for the Stage 4D.5.1 finding that
// startBaselineWindow must not absorb in-race motion indefinitely: once
// accepted, this controller simply stops calling the start detector at
// all for the remainder of the race, for the same session object.
function runStartDetection(controller, targetPoseSample) {
    if (controller.chronosSession.status !== "armed") {
        return controller;
    }

    const { candidate, detectorState, assessment } = racePipelineDetectStartCandidate(
        targetPoseSample,
        controller.detectorState,
        { referenceFrameMs: controller.config.startReferenceMs }
    );

    let nextController = { ...controller, detectorState };

    if (assessment) {
        nextController = {
            ...nextController,
            diagnostics: {
                ...nextController.diagnostics,
                lastStartAssessment: {
                    state: assessment.state,
                    reason: assessment.reason,
                    // The media time of the sample that was evaluated (for a
                    // confirmed start, the CONFIRMING sample — later than the onset).
                    atMs: targetPoseSample.atMs,
                    // The estimated motion onset this assessment concerns: the
                    // candidate's for a confirmed start, the refused one for
                    // "onset-before-reference-frame", otherwise null.
                    onsetAtMs: startAssessmentOnsetMs(assessment)
                }
            }
        };
    }

    if (candidate) {
        const submitResult = racePipelineSubmitStartCandidate(
            nextController.chronosSession,
            candidate,
            nextController.eventAdapterState
        );
        nextController = {
            ...nextController,
            chronosSession: submitResult.session,
            eventAdapterState: submitResult.eventAdapterState,
            diagnostics: {
                ...nextController.diagnostics,
                lastEvent: { kind: "start", ok: submitResult.ok, reason: submitResult.reason, atMs: candidate.atMs }
            }
        };
    }

    return nextController;
}

// Runs the turn detector ONLY once a start has been recorded
// (session.status === "running") AND referenceLaneY is configured
// (Stage 4D.6 §9/§11's prerequisites) — never with a fabricated
// referenceLaneY, and never before a race has actually started.
//
// CHRONOS RELIABILITY PHASE 2: the accepted start's time is handed to the
// detector as `earliestApexMs`, so a turning point at or before the race
// start can never be proposed (a swimmer walking in to the blocks, resting at
// the wall and diving away is not a turn). The candidate that comes back is
// stamped with the APEX time (the estimated wall-contact onset), not the
// later sample at which the reversal was confirmed.
function runTurnDetection(controller, targetPoseSample) {
    if (controller.chronosSession.status !== "running" || controller.config.referenceLaneY === null) {
        return controller;
    }

    const startEvent = controller.chronosSession.events.find((event) => event.type === "start") || null;

    const { candidate, detectorState, assessment, gap, outsideZone } = racePipelineDetectTurnCandidate(
        targetPoseSample,
        controller.detectorState,
        {
            referenceLaneY: controller.config.referenceLaneY,
            earliestApexMs: startEvent ? startEvent.atMs : null
        }
    );

    let nextController = { ...controller, detectorState };

    /* DISTANCE CONFIDENCE (Chronos reliability, phase 2C). If the interval
       since the previous usable observation is longer than the observation-run
       limit AND touches a wall zone, a turn could have been concealed in it. We
       do not decide whether one was, how many, or what a later wall contact
       means: we mark the session's distance progression UNCONFIRMED from the
       last observation before the gap, for the rest of the race. Chronos then
       refuses detector-sourced distance events, and the event adapter refuses
       turn candidates, without any guess. Marking is idempotent (the first
       ambiguity is kept) and runs BEFORE this sample's candidate is
       submitted. */
    if (gap && gap.ambiguous && !nextController.chronosSession.distanceConfidence) {
        const marked = ChronosEngine.markDistanceUnconfirmed(nextController.chronosSession, {
            reason: DISTANCE_AMBIGUITY_REASON,
            sinceAtMs: gap.evidence.fromAtMs,
            resumedAtMs: gap.evidence.toAtMs,
            evidence: gap.evidence
        });
        if (marked.ok) {
            nextController = {
                ...nextController,
                chronosSession: marked.session,
                diagnostics: {
                    ...nextController.diagnostics,
                    distanceConfidence: {
                        state: "unconfirmed",
                        reason: DISTANCE_AMBIGUITY_REASON,
                        sinceAtMs: gap.evidence.fromAtMs,
                        resumedAtMs: gap.evidence.toAtMs
                    }
                }
            };
        }
    }

    /* DISTANCE CONFIDENCE (Chronos reliability, phase 2D). The turn assessment
       returns `rejected` / `lane-deviation` ONLY for a COMPLETE wall reversal
       (apex inside a wall zone, approach and sustained recovery all observed)
       whose apex was outside the lane; an incomplete approach is `none` or
       `plausible` and never reaches this. Such a reversal is refused and so
       never becomes a candidate, yet a real turn happened: left alone, the next
       wall would be recorded with a distance one pool length too early. So the
       race's distance is marked UNCONFIRMED from the reversal's apex (the
       earliest point the missing turn could affect distance), exactly as for a
       concealed turn: Chronos then refuses detector-sourced turns/splits/
       finishes and the adapter refuses turn candidates. Nothing is fabricated
       and no threshold is touched. Idempotent: the assessment repeats on every
       later frame while the reversal stands, and the FIRST record (this one, a
       gap's, or a terminal-tracking one) is kept. Not done when no required turn
       is outstanding (nothing left that a label could be wrong about). If the
       evidence has no valid apex time, the accepted start is used (everything
       after it unverified), never an invented instant. */
    if (
        assessment &&
        assessment.state === "rejected" &&
        assessment.reason === "lane-deviation" &&
        startEvent &&
        !nextController.chronosSession.distanceConfidence
    ) {
        const required = describeRequiredTurns(nextController.chronosSession, nextController.eventAdapterState);
        if (required.outstanding) {
            const evidence = assessment.evidence || {};
            const apexAtMs = isFiniteNumber(evidence.apexAtMs) && evidence.apexAtMs >= startEvent.atMs ? evidence.apexAtMs : null;
            const sinceAtMs = apexAtMs !== null ? apexAtMs : startEvent.atMs;
            const marked = ChronosEngine.markDistanceUnconfirmed(nextController.chronosSession, {
                reason: DISTANCE_LANE_GATE_REASON,
                sinceAtMs,
                resumedAtMs: null,
                evidence: {
                    trigger: "lane-gate-refusal",
                    wallSide: evidence.wallSide ?? null,
                    apexAtMs,
                    sinceBasis: apexAtMs !== null ? "apex" : "start",
                    laneDeviation: isFiniteNumber(evidence.laneDeviation) ? evidence.laneDeviation : null,
                    evaluatedAtMs: targetPoseSample.atMs,
                    confirmedDistanceMeters: required.confirmedDistanceMeters,
                    requiredTurns: required.requiredTurns,
                    requiredTurnsKnown: required.requiredTurnsKnown
                }
            });
            if (marked.ok) {
                nextController = {
                    ...nextController,
                    chronosSession: marked.session,
                    diagnostics: {
                        ...nextController.diagnostics,
                        distanceConfidence: { state: "unconfirmed", reason: DISTANCE_LANE_GATE_REASON, sinceAtMs, resumedAtMs: null }
                    }
                };
            }
        }
    }

    /* DISTANCE CONFIDENCE (Chronos reliability, phase 2E). The turn assessment
       accepts a reversal only when its apex is inside a wall zone, and says
       nothing about one that is not: it reads "none". But the observations may
       contain a COMPLETE, sustained reversal (approach, apex and recovery all
       observed) whose apex falls outside the zone. The data cannot say whether
       that was a wall touch the zone missed (the camera frames more than the
       pool) or a stop-and-return that is not a wall at all — where the wall is in
       the frame is exactly what is not known — so nothing is classified and no
       turn is inferred. The conservative conclusion is the same as for a
       concealed or lane-refused turn: the race's distance progression is marked
       UNCONFIRMED from the reversal's apex (the earliest point it could affect a
       label), so the NEXT wall cannot be recorded one pool length too early.
       Chronos then refuses detector turns/splits/finishes. Idempotent (the
       assessment repeats on every later frame while the reversal stands); the
       FIRST record of any kind is kept; skipped when no required turn is
       outstanding. Ordinary motion — monotone swimming, stroke oscillation,
       jitter, outliers, an incomplete approach or recovery, a harmless gap — never
       forms a complete reversal and never reaches this. Nothing is fabricated and
       no threshold changed. */
    if (outsideZone && outsideZone.outside && startEvent && !nextController.chronosSession.distanceConfidence) {
        const required = describeRequiredTurns(nextController.chronosSession, nextController.eventAdapterState);
        if (required.outstanding) {
            const evidence = outsideZone.evidence || {};
            const apexAtMs = isFiniteNumber(evidence.apexAtMs) && evidence.apexAtMs >= startEvent.atMs ? evidence.apexAtMs : null;
            const sinceAtMs = apexAtMs !== null ? apexAtMs : startEvent.atMs;
            const marked = ChronosEngine.markDistanceUnconfirmed(nextController.chronosSession, {
                reason: DISTANCE_OUTSIDE_ZONE_REASON,
                sinceAtMs,
                resumedAtMs: null,
                evidence: {
                    trigger: "reversal-outside-wall-zone",
                    apexAtMs,
                    sinceBasis: apexAtMs !== null ? "apex" : "start",
                    apexHipX: isFiniteNumber(evidence.apexHipX) ? evidence.apexHipX : null,
                    approachedWallSide: evidence.approachedWallSide ?? null,
                    distanceOutsideZone: isFiniteNumber(evidence.distanceOutsideZone) ? evidence.distanceOutsideZone : null,
                    approachSwing: isFiniteNumber(evidence.approachSwing) ? evidence.approachSwing : null,
                    recoverySwing: isFiniteNumber(evidence.recoverySwing) ? evidence.recoverySwing : null,
                    evaluatedAtMs: targetPoseSample.atMs,
                    confirmedDistanceMeters: required.confirmedDistanceMeters,
                    requiredTurns: required.requiredTurns,
                    requiredTurnsKnown: required.requiredTurnsKnown
                }
            });
            if (marked.ok) {
                nextController = {
                    ...nextController,
                    chronosSession: marked.session,
                    diagnostics: {
                        ...nextController.diagnostics,
                        distanceConfidence: { state: "unconfirmed", reason: DISTANCE_OUTSIDE_ZONE_REASON, sinceAtMs, resumedAtMs: null }
                    }
                };
            }
        }
    }

    if (assessment) {
        nextController = {
            ...nextController,
            diagnostics: {
                ...nextController.diagnostics,
                lastTurnAssessment: {
                    state: assessment.state,
                    reason: assessment.reason,
                    // The media time of the sample that was evaluated (for a
                    // confirmed turn, the CONFIRMING sample — later than the apex).
                    atMs: targetPoseSample.atMs,
                    // The estimated wall-contact (apex) time this assessment
                    // concerns, when it concerns one; otherwise null.
                    apexAtMs: assessment.candidate
                        ? assessment.candidate.evidence.apexAtMs
                        : (assessment.evidence && isFiniteNumber(assessment.evidence.apexAtMs) ? assessment.evidence.apexAtMs : null)
                }
            }
        };
    }

    if (candidate) {
        const submitResult = racePipelineSubmitTurnCandidate(
            nextController.chronosSession,
            candidate,
            nextController.eventAdapterState
        );
        const unconfirmed = submitResult.reason === "distance-progression-unconfirmed";
        nextController = {
            ...nextController,
            chronosSession: submitResult.session,
            eventAdapterState: submitResult.eventAdapterState,
            diagnostics: {
                ...nextController.diagnostics,
                lastEvent: { kind: "turn", ok: submitResult.ok, reason: submitResult.reason, atMs: candidate.atMs },
                // A candidate seen while distance is unconfirmed is kept as an
                // observation (never an event, never a distance).
                unconfirmedTurnObservations: unconfirmed
                    ? [
                          ...(nextController.diagnostics.unconfirmedTurnObservations || []),
                          {
                              apexAtMs: candidate.atMs,
                              confirmedAtMs: candidate.evidence ? candidate.evidence.confirmedAtMs : null,
                              wallSide: candidate.evidence ? candidate.evidence.wallSide : null,
                              confidence: candidate.confidence
                          }
                      ].slice(-MAX_UNCONFIRMED_TURN_OBSERVATIONS)
                    : (nextController.diagnostics.unconfirmedTurnObservations || [])
            }
        };
    }

    return nextController;
}

/**
 * Processes exactly one PoseSample through
 * SwimmerTracking -> detector-adapter -> event-adapter -> ChronosEngine.
 * The caller (index.html's frame driver) is responsible for the
 * generation check BEFORE calling this (see
 * src/race-pipeline/frame-timing.js's racePipelineIsPendingTimingCurrent())
 * — `sampleGeneration` is re-checked here too, defensively, since this
 * function is the one place that would otherwise let a stale sample
 * corrupt live session state.
 *
 * Only a non-null targetPoseSample from SwimmerTracking.observe() ever
 * reaches a detector (docs/SWIMMER_TRACKING_ARCHITECTURE.md §13) — a raw
 * PoseSample is never passed to a detector directly.
 *
 * @param {object} controller
 * @param {object} poseSample A PoseSample (racePipelineBuildPoseSample()'s
 *   output).
 * @param {number} sampleGeneration The generation this sample was
 *   captured under (from the same pendingTiming the caller already
 *   validated).
 * @returns {{controller:object, processed:boolean, reason:string|null}}
 */
export function racePipelineProcessPoseSample(controller, poseSample, sampleGeneration) {
    if (!controller.chronosSession || !controller.trackingSession) {
        return { controller, processed: false, reason: "no-active-session" };
    }

    if (sampleGeneration !== controller.generation) {
        return { controller, processed: false, reason: "stale-generation" };
    }

    if (!poseSample || !isFiniteNumber(poseSample.atMs)) {
        return { controller, processed: false, reason: "invalid-pose-sample" };
    }

    let trackingSessionForObserve = controller.trackingSession;

    // Auto-selection on the very first sample — see the TARGET SELECTION
    // NOTE at the top of this file.
    if (trackingSessionForObserve.status === "UNSELECTED") {
        const calibrationPoint = controller.config && controller.config.calibrationPoint ? controller.config.calibrationPoint : null;
        const selected = SwimmerTracking.selectTarget(trackingSessionForObserve, { atMs: poseSample.atMs, point: calibrationPoint });
        if (!selected.ok) {
            return {
                controller: {
                    ...controller,
                    trackingSession: selected.session,
                    diagnostics: { ...controller.diagnostics, lastTrackingStatus: selected.session.status }
                },
                processed: false,
                reason: selected.reason
            };
        }
        trackingSessionForObserve = selected.session;
    }

    const trackingResult = SwimmerTracking.observe(trackingSessionForObserve, poseSample);

    if (!trackingResult.ok) {
        return {
            controller: applyTerminalTrackingTreatment({
                ...controller,
                trackingSession: trackingResult.session,
                diagnostics: { ...controller.diagnostics, lastTrackingStatus: trackingResult.session.status }
            }),
            processed: false,
            reason: trackingResult.reason
        };
    }

    let nextController = {
        ...controller,
        trackingSession: trackingResult.session,
        diagnostics: {
            ...controller.diagnostics,
            lastTrackingStatus: trackingResult.session.status,
            lastObservationOutcome: trackingResult.observation ? trackingResult.observation.outcome : null
        }
    };

    const targetPoseSample = trackingResult.targetPoseSample;
    if (!targetPoseSample) {
        // Not a confirmed target observation this frame (locking,
        // ambiguous, gap, lost, degraded) — nothing proceeds to a
        // detector, matching docs/SWIMMER_TRACKING_ARCHITECTURE.md §13
        // exactly. (If this frame left tracking terminally degraded, the
        // distance confidence is settled here: see applyTerminalTrackingTreatment.)
        return { controller: applyTerminalTrackingTreatment(nextController), processed: true, reason: null };
    }

    nextController = runStartDetection(nextController, targetPoseSample);
    nextController = runTurnDetection(nextController, targetPoseSample);

    return { controller: nextController, processed: true, reason: null };
}

/**
 * End-of-stream notification (Chronos reliability, phase 2C follow-up): tell the
 * controller that no further samples will arrive (the video ended). If tracking
 * is terminally degraded, or the target is still lost, and the race's required
 * turns are not all recorded, the race's distance is marked unconfirmed
 * (applyTerminalTrackingTreatment). Otherwise nothing changes. It never creates
 * a turn, split or finish, never stops or resets the analysis, and is
 * idempotent. A recoverable loss that RESUMED before the end is unaffected: only
 * the state at the end of the stream counts.
 *
 * The host must call it when the stream ends. The race page does: its video
 * `ended` handler (index.html, initRaceVideoEndedListener) calls it after
 * stopping the frame driver and before re-rendering, and applies the returned
 * controller. Only the genuine `ended` event does; a pause, a seek or a
 * recoverable loss does not.
 *
 * @param {object} controller
 * @returns {{controller:object, marked:boolean}}
 */
export function racePipelineEndAnalysis(controller) {
    const next = applyTerminalTrackingTreatment(controller, { streamEnded: true });
    return { controller: next, marked: next !== controller };
}

/**
 * Stops/resets the current analysis run (Stage 4D.6 §13 "Analysis
 * stop/reset"): aborts the Chronos session if it is in a state where
 * that is legal (idle/armed/running — never finished, which is already
 * terminal), bumps the generation token so any in-flight async callback
 * recognizes itself as stale, and discards every other piece of session
 * state. Never leaves state to leak into the next race.
 *
 * @param {object} controller
 * @returns {{controller:object}}
 */
export function racePipelineStopAnalysis(controller) {
    if (
        controller.chronosSession &&
        (controller.chronosSession.status === "idle" ||
            controller.chronosSession.status === "armed" ||
            controller.chronosSession.status === "running")
    ) {
        ChronosEngine.abortSession(controller.chronosSession);
    }

    return {
        controller: {
            ...racePipelineCreateController(),
            generation: controller.generation + 1
        }
    };
}

/**
 * Builds a RaceAnalysisReport for the current session via
 * ChronosEngine.buildReport() — report calculation itself always belongs
 * to src/chronos-engine/report.js, never reimplemented here (Stage 4D.6
 * §18). Safe to call at any point in the lifecycle; an unfinished session
 * produces a report with finalTimeMs: null, never a fabricated time
 * (report.js's own existing, tested behavior).
 *
 * @param {object} controller
 * @returns {{ok:boolean, reason:string|null, report:object|null}}
 */
export function racePipelineBuildReport(controller) {
    if (!controller.chronosSession) {
        return { ok: false, reason: "no-active-session", report: null };
    }
    return ChronosEngine.buildReport(controller.chronosSession);
}

// Derived, never stored — Stage 4D.6 §13's "idle / armed/running /
// finished / aborted" lifecycle, plus one controller-only pseudo-state
// ("blocked") for a start attempt that never reached Chronos at all. This
// is a read-through of chronosSession.status, never a second copy of it.
export function racePipelineControllerStatus(controller) {
    if (controller.blockedReason) {
        return "blocked";
    }
    if (!controller.chronosSession) {
        return "idle";
    }
    return controller.chronosSession.status;
}
