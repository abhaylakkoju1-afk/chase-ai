// Swimmer tracking — observation ingestion: locking, steady-state
// continuity, loss, and reacquisition.
//
// Pure, deterministic, browser-independent. Implements the PoseSample
// contract (docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1), the
// TrackingObservation contract (§7.3), the state machine (§8), target
// locking (§10), identity continuity (§11), and identity loss/
// reacquisition (§12). Every value this module operates on — including
// every timestamp — is supplied by the caller; this file never reads
// Date.now(), video.currentTime, performance.now(), or any other clock,
// and never touches the DOM, localStorage, Firebase, or MediaPipe. It
// does not import from src/chronos-engine/* (Chronos or the detectors)
// or src/chase-engine/* — tracking has no idea a Chronos session or a
// detector will ever exist (§13, §16 of the architecture document).

import { trackingTransition } from "./session.js";
import {
    computeRepresentativePosition,
    estimateVelocity,
    projectPosition,
    continuityError as computeContinuityError
} from "./continuity.js";

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------
//
// Every value below is named, overridable, provisional configuration —
// not a validated threshold (docs/SWIMMER_TRACKING_ARCHITECTURE.md §10,
// §19: "real values are a Stage 4C.2/4C.3 concern, tuned against
// fixtures, not asserted here as correct"). The four values the
// architecture document itself defaults (selectionConfirmationSamples,
// lockingWindowMs, minVisibility, maxLockingPositionError) use exactly
// its stated defaults. Every other value here is a Stage 4C.2 choice the
// document explicitly deferred to this stage, documented individually
// below. `maxVelocityDeltaPerSecond` intentionally has NO default — the
// architecture document singles it out as needing real fixture data
// before any placeholder would be meaningful, so the velocity-
// consistency check it would govern is simply skipped unless a caller
// supplies a value.
const DEFAULT_CONFIG = Object.freeze({
    // --- Locking (docs/SWIMMER_TRACKING_ARCHITECTURE.md §10 table) ---
    selectionConfirmationSamples: 5,
    lockingWindowMs: 3000,
    minVisibility: 0.5,
    maxLockingPositionError: 0.05,

    // --- Steady-state continuity (§11) ---
    // Maximum continuityError, once TARGET_LOCKED, for an observation to
    // be confirmed rather than ambiguous. Deliberately larger than
    // maxLockingPositionError: once locked and moving, normal
    // stride-to-stride variation should be tolerated that a
    // still-establishing lock should not yet trust.
    maxSteadyStatePositionError: 0.08,

    // --- Loss (§12.2) ---
    // Elapsed ms since lastConfirmedAtMs, for a run of gap/ambiguous
    // observations, before TARGET_LOCKED -> TARGET_LOST.
    lossGraceMs: 1500,
    // Elapsed ms of a SUSTAINED (gap-free) run of specifically
    // "ambiguous" (pose present, continuity/visibility failed)
    // observations before TARGET_LOCKED -> ANALYSIS_DEGRADED directly,
    // skipping TARGET_LOST (§12.2's "sustained ambiguity... e.g. the
    // overlap scenario"). Deliberately checked, and reachable, BEFORE
    // lossGraceMs — see observeWhileTargetLocked() below for why this
    // ordering is what makes both budgets independently reachable
    // rather than lossGraceMs always firing first.
    sustainedAmbiguityMs: 1000,

    // --- Reacquisition (§12.3) ---
    maxReacquisitionWindowMs: 5000,
    // Deliberately larger than maxSteadyStatePositionError: more elapsed
    // time since the last confirmed observation means more accumulated
    // projection uncertainty, so a wider agreement band is tolerated.
    maxReacquisitionPositionError: 0.15
});

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function mergeConfig(config) {
    return { ...DEFAULT_CONFIG, ...(config || {}) };
}

// ---------------------------------------------------------------------
// PoseSample validation (docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1)
// ---------------------------------------------------------------------

// A malformed sample (missing/non-finite atMs, non-boolean hasPose, a
// landmarks value that is neither null nor a plain object) is a
// caller/programmer-level input error — distinct from a well-formed
// PoseSample that legitimately reports hasPose:false. It is rejected
// outright, never silently reinterpreted as a "gap" observation.
function validateSampleShape(sample) {
    if (!sample || typeof sample !== "object") {
        return "missing-sample";
    }
    if (!isFiniteNumber(sample.atMs)) {
        return "invalid-sample-timestamp";
    }
    if (typeof sample.hasPose !== "boolean") {
        return "invalid-sample-has-pose";
    }
    if (sample.landmarks !== null && typeof sample.landmarks !== "object") {
        return "invalid-sample-landmarks";
    }
    return null;
}

// ---------------------------------------------------------------------
// Observation classification
// ---------------------------------------------------------------------
//
// Builds the position/visibility facts for one sample, independent of
// which state the session is in — the per-state handlers below decide
// what those facts MEAN for that state's own thresholds.
function extractPositionFacts(sample) {
    if (!sample.hasPose) {
        return { representativePosition: null, visibility: null };
    }
    const representativePosition = computeRepresentativePosition(sample.landmarks);
    if (!representativePosition) {
        // hasPose:true but the specific landmarks tracking needs
        // (hip+nose) are missing/unusable — treated the same as no
        // usable signal at all (a "gap" in this module's sense), even
        // though hasPose was technically true. The architecture
        // document ties "gap" to hasPose:false explicitly; this is a
        // Stage 4C.2 extension to the identical, undiscussed edge case
        // of "pose present but the needed landmarks are not" — the
        // document's own reasoning ("a gap carries no signal at all")
        // applies equally here.
        return { representativePosition: null, visibility: null };
    }
    return {
        representativePosition: { x: representativePosition.x, y: representativePosition.y },
        visibility: representativePosition.visibility
    };
}

function buildObservation({ atMs, hasPose, representativePosition, visibility, projectedPosition, velocity, outcome, reacquired = false }) {
    return {
        atMs,
        hasPose,
        representativePosition,
        visibility,
        projectedPosition,
        continuityError: (representativePosition && projectedPosition)
            ? computeContinuityError(representativePosition, projectedPosition)
            : null,
        velocity,
        outcome,
        // Extends the illustrative §7.3 shape by exactly this one field,
        // as the concrete implementation of §8.1's explicit instruction
        // that a reacquired lock be "recorded as an outcome/tag on the
        // relevant TrackingObservation entry" — §7.3's `outcome` enum
        // itself has no room for a fourth value, so this is a separate,
        // additive boolean rather than a redefinition of `outcome`.
        reacquired
    };
}

function appendObservation(session, observation) {
    return { ...session, observationHistory: [...session.observationHistory, observation] };
}

// ---------------------------------------------------------------------
// TARGET_SELECTED — the single seeding observation
// ---------------------------------------------------------------------
//
// Per §8.3: "the confirming observation that moves to TARGET_LOCKING" —
// ANY first observation, regardless of its own quality, moves status
// forward; that same sample is then evaluated by the TARGET_LOCKING
// handler in the same call, so it is not wasted.
function observeWhileTargetSelected(session, sample, cfg) {
    const transitionResult = trackingTransition(session, "TARGET_LOCKING");
    if (!transitionResult.ok) {
        return { ok: false, reason: transitionResult.reason, session, observation: null, targetPoseSample: null };
    }

    const seeded = {
        ...transitionResult.session,
        _lockingWindowStartAtMs: sample.atMs
    };

    return observeWhileTargetLocking(seeded, sample, cfg);
}

// ---------------------------------------------------------------------
// TARGET_LOCKING — accumulating consecutive qualifying observations
// ---------------------------------------------------------------------
function observeWhileTargetLocking(session, sample, cfg) {
    const { representativePosition, visibility } = extractPositionFacts(sample);

    const windowElapsedMs = sample.atMs - session._lockingWindowStartAtMs;

    // Hard gate: no usable position (gap), or visibility too low
    // (ambiguous) — breaks the current streak but does not fail the
    // whole attempt outright; only the window ceiling below can do that.
    if (!representativePosition) {
        const observation = buildObservation({
            atMs: sample.atMs, hasPose: sample.hasPose, representativePosition: null,
            visibility: null, projectedPosition: null, velocity: null, outcome: "gap"
        });
        return finishLockingAttempt(session, sample, observation, windowElapsedMs, cfg, /* streakBroken */ true);
    }

    if (visibility < cfg.minVisibility) {
        const observation = buildObservation({
            atMs: sample.atMs, hasPose: sample.hasPose, representativePosition,
            visibility, projectedPosition: null, velocity: null, outcome: "ambiguous"
        });
        return finishLockingAttempt(session, sample, observation, windowElapsedMs, cfg, /* streakBroken */ true);
    }

    let streak = session._lockingStreak;
    let anchorPosition = session._lockingLastPosition;
    let anchorAtMs = session._lockingLastAtMs;

    if (anchorPosition === null) {
        // First qualifying sample of a new streak.
        streak = 1;
    } else {
        const drift = computeContinuityError(representativePosition, anchorPosition);
        if (drift > cfg.maxLockingPositionError) {
            // Drift too large to be the same streak — restart the
            // streak from THIS sample rather than zeroing it entirely,
            // since this sample itself is still a valid, visible
            // observation (only its relationship to the PREVIOUS one is
            // suspect). A single outlier should not force the whole
            // window to be spent recovering from scratch.
            streak = 1;
        } else {
            streak = streak + 1;
        }
    }

    const observation = buildObservation({
        atMs: sample.atMs, hasPose: sample.hasPose, representativePosition,
        visibility, projectedPosition: null, velocity: null, outcome: "confirmed"
    });

    let nextSession = appendObservation(session, observation);
    nextSession = {
        ...nextSession,
        _lockingStreak: streak,
        _lockingLastPosition: representativePosition,
        _lockingLastAtMs: sample.atMs
    };

    if (streak >= cfg.selectionConfirmationSamples) {
        const velocity = (anchorPosition && isFiniteNumber(anchorAtMs))
            ? estimateVelocity(anchorPosition, anchorAtMs, representativePosition, sample.atMs)
            : null;

        const transitionResult = trackingTransition(nextSession, "TARGET_LOCKED");
        if (!transitionResult.ok) {
            return { ok: false, reason: transitionResult.reason, session, observation, targetPoseSample: null };
        }

        const lockedSession = {
            ...transitionResult.session,
            lockEstablishedAtMs: sample.atMs,
            lastConfirmedAtMs: sample.atMs,
            lastConfirmedPosition: representativePosition,
            lastConfirmedVelocity: velocity ?? { x: 0, y: 0, magnitudePerSecond: 0 }
        };

        return { ok: true, reason: null, session: lockedSession, observation, targetPoseSample: sample };
    }

    if (windowElapsedMs > cfg.lockingWindowMs) {
        return failLockingAttempt(nextSession, observation);
    }

    return { ok: true, reason: null, session: nextSession, observation, targetPoseSample: null };
}

// Shared tail for a gap/ambiguous locking-phase observation: breaks the
// streak, then checks the window ceiling.
function finishLockingAttempt(session, sample, observation, windowElapsedMs, cfg, streakBroken) {
    let nextSession = appendObservation(session, observation);
    if (streakBroken) {
        nextSession = { ...nextSession, _lockingStreak: 0, _lockingLastPosition: null, _lockingLastAtMs: null };
    }

    if (windowElapsedMs > cfg.lockingWindowMs) {
        return failLockingAttempt(nextSession, observation);
    }

    return { ok: true, reason: null, session: nextSession, observation, targetPoseSample: null };
}

function failLockingAttempt(session, observation) {
    const transitionResult = trackingTransition(session, "UNSELECTED");
    if (!transitionResult.ok) {
        return { ok: false, reason: transitionResult.reason, session, observation, targetPoseSample: null };
    }

    const resetSession = {
        ...transitionResult.session,
        selection: null,
        _lockingWindowStartAtMs: null,
        _lockingStreak: 0,
        _lockingLastPosition: null,
        _lockingLastAtMs: null
    };

    return { ok: true, reason: null, session: resetSession, observation, targetPoseSample: null };
}

// ---------------------------------------------------------------------
// TARGET_LOCKED — steady-state continuity
// ---------------------------------------------------------------------
function observeWhileTargetLocked(session, sample, cfg) {
    const { representativePosition, visibility } = extractPositionFacts(sample);

    const elapsedSinceConfirmedMs = sample.atMs - session.lastConfirmedAtMs;
    const projectedPosition = (elapsedSinceConfirmedMs >= 0)
        ? projectPosition(session.lastConfirmedPosition, session.lastConfirmedVelocity, elapsedSinceConfirmedMs)
        : null;

    let outcome;
    let velocityForObservation = null;

    if (!representativePosition) {
        outcome = "gap";
    } else if (visibility < cfg.minVisibility) {
        outcome = "ambiguous";
    } else if (!projectedPosition) {
        // Non-monotonic timestamp relative to the last confirmed sample
        // — cannot honestly project or compare; treated as ambiguous
        // rather than guessed at.
        outcome = "ambiguous";
    } else {
        const error = computeContinuityError(representativePosition, projectedPosition);
        if (error > cfg.maxSteadyStatePositionError) {
            outcome = "ambiguous";
        } else {
            const candidateVelocity = estimateVelocity(
                session.lastConfirmedPosition, session.lastConfirmedAtMs, representativePosition, sample.atMs
            );
            const velocityInconsistent =
                isFiniteNumber(cfg.maxVelocityDeltaPerSecond) &&
                candidateVelocity &&
                Math.abs(candidateVelocity.magnitudePerSecond - session.lastConfirmedVelocity.magnitudePerSecond) > cfg.maxVelocityDeltaPerSecond;

            if (velocityInconsistent) {
                outcome = "ambiguous";
            } else {
                outcome = "confirmed";
                velocityForObservation = candidateVelocity;
            }
        }
    }

    const observation = buildObservation({
        atMs: sample.atMs, hasPose: sample.hasPose, representativePosition, visibility,
        projectedPosition, velocity: velocityForObservation, outcome
    });

    if (outcome === "confirmed") {
        const confirmedSession = {
            ...appendObservation(session, observation),
            lastConfirmedAtMs: sample.atMs,
            lastConfirmedPosition: representativePosition,
            lastConfirmedVelocity: velocityForObservation ?? session.lastConfirmedVelocity,
            _ambiguousStreakStartAtMs: null
        };
        return { ok: true, reason: null, session: confirmedSession, observation, targetPoseSample: sample };
    }

    // Not confirmed: evaluate the two independent loss budgets
    // (docs/SWIMMER_TRACKING_ARCHITECTURE.md §12.2). "ambiguous"
    // (pose present, failed a check) accumulates toward
    // sustainedAmbiguityMs — checked FIRST — while both "ambiguous" and
    // "gap" also count toward the general lossGraceMs budget via elapsed
    // time since the last confirmed observation. sustainedAmbiguityMs
    // defaults smaller than lossGraceMs specifically so a purely
    // ambiguous (non-gap) run can reach it before the general budget
    // would otherwise claim the outcome first — without that ordering,
    // the "direct to ANALYSIS_DEGRADED" path described in §12.2 could
    // never actually be reached.
    let nextSession = appendObservation(session, observation);

    if (outcome === "ambiguous") {
        const streakStart = nextSession._ambiguousStreakStartAtMs ?? sample.atMs;
        nextSession = { ...nextSession, _ambiguousStreakStartAtMs: streakStart };

        const ambiguousElapsedMs = sample.atMs - streakStart;
        if (ambiguousElapsedMs >= cfg.sustainedAmbiguityMs) {
            return degradeSession(nextSession, observation, "sustained-ambiguity");
        }
    } else {
        // outcome === "gap" breaks a running ambiguity streak — a gap is
        // a qualitatively different signal (no evidence at all) than
        // ambiguous evidence (§10: "gap... a distinct outcome from
        // ambiguous").
        nextSession = { ...nextSession, _ambiguousStreakStartAtMs: null };
    }

    if (elapsedSinceConfirmedMs >= cfg.lossGraceMs) {
        return loseTarget(nextSession, observation, sample.atMs);
    }

    return { ok: true, reason: null, session: nextSession, observation, targetPoseSample: null };
}

function loseTarget(session, observation, atMs) {
    const transitionResult = trackingTransition(session, "TARGET_LOST");
    if (!transitionResult.ok) {
        return { ok: false, reason: transitionResult.reason, session, observation, targetPoseSample: null };
    }
    const lostSession = { ...transitionResult.session, _lostAtMs: atMs, _ambiguousStreakStartAtMs: null };
    return { ok: true, reason: null, session: lostSession, observation, targetPoseSample: null };
}

function degradeSession(session, observation, reason) {
    const transitionResult = trackingTransition(session, "ANALYSIS_DEGRADED");
    if (!transitionResult.ok) {
        return { ok: false, reason: transitionResult.reason, session, observation, targetPoseSample: null };
    }
    const degradedSession = { ...transitionResult.session, degradedReason: reason };
    return { ok: true, reason: null, session: degradedSession, observation, targetPoseSample: null };
}

// ---------------------------------------------------------------------
// TARGET_LOST — conservative reacquisition (§12.3)
// ---------------------------------------------------------------------
function observeWhileTargetLost(session, sample, cfg) {
    const { representativePosition, visibility } = extractPositionFacts(sample);

    const windowElapsedMs = sample.atMs - session._lostAtMs;
    const windowExhausted = windowElapsedMs > cfg.maxReacquisitionWindowMs;

    const elapsedSinceConfirmedMs = sample.atMs - session.lastConfirmedAtMs;
    const projectedPosition = (elapsedSinceConfirmedMs >= 0)
        ? projectPosition(session.lastConfirmedPosition, session.lastConfirmedVelocity, elapsedSinceConfirmedMs)
        : null;

    let outcome;
    let reacquired = false;
    let velocityForObservation = null;

    if (!representativePosition) {
        outcome = "gap";
    } else if (visibility < cfg.minVisibility) {
        outcome = "ambiguous";
    } else if (!projectedPosition) {
        outcome = "ambiguous";
    } else {
        const error = computeContinuityError(representativePosition, projectedPosition);
        // docs/SWIMMER_TRACKING_ARCHITECTURE.md §12.3: the elapsed-time
        // reacquisition window is checked BEFORE continuity/visibility can
        // succeed — a candidate arriving after maxReacquisitionWindowMs
        // has elapsed must never reacquire, regardless of how well it
        // matches the projected position. `windowExhausted` is computed
        // above; gating it into this same condition (rather than only
        // checking it later, on the already-not-confirmed path) is what
        // makes that ordering hold.
        if (windowExhausted || error > cfg.maxReacquisitionPositionError) {
            outcome = "ambiguous";
        } else {
            outcome = "confirmed";
            reacquired = true;
            velocityForObservation = estimateVelocity(
                session.lastConfirmedPosition, session.lastConfirmedAtMs, representativePosition, sample.atMs
            );
        }
    }

    const observation = buildObservation({
        atMs: sample.atMs, hasPose: sample.hasPose, representativePosition, visibility,
        projectedPosition, velocity: velocityForObservation, outcome, reacquired
    });

    if (outcome === "confirmed") {
        const transitionResult = trackingTransition(session, "TARGET_LOCKED");
        if (!transitionResult.ok) {
            return { ok: false, reason: transitionResult.reason, session, observation, targetPoseSample: null };
        }
        const reacquiredSession = {
            ...appendObservation(transitionResult.session, observation),
            lastConfirmedAtMs: sample.atMs,
            lastConfirmedPosition: representativePosition,
            lastConfirmedVelocity: velocityForObservation ?? session.lastConfirmedVelocity,
            _lostAtMs: null,
            _ambiguousStreakStartAtMs: null
        };
        return { ok: true, reason: null, session: reacquiredSession, observation, targetPoseSample: sample };
    }

    const nextSession = appendObservation(session, observation);

    // Evidence insufficient this call. Per §12.3: "If the window or
    // attempt budget is exhausted, or evidence is insufficient at any
    // point [beyond the window]" -> ANALYSIS_DEGRADED. This module
    // treats window exhaustion as the sole "exhausted" trigger (no
    // separate attempts counter is named anywhere in the architecture
    // document's config table) — every individual failed reacquisition
    // candidate within the window simply stays TARGET_LOST.
    if (windowExhausted) {
        return degradeSession(nextSession, observation, "reacquisition-window-exhausted");
    }

    return { ok: true, reason: null, session: nextSession, observation, targetPoseSample: null };
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

// Evaluates a single PoseSample against the session's current state,
// applying every rule in docs/SWIMMER_TRACKING_ARCHITECTURE.md §8-§12.
// Never mutates the session passed in — no synthetic observation is
// ever generated, and the returned targetPoseSample is non-null ONLY
// when the sample is confirmed to belong to the locked target (§13). On
// rejection (an illegal call, not a normal ambiguous/gap outcome), the
// ORIGINAL session is returned unchanged plus a stable reason string.
export function trackingObserve(session, sample, config) {
    if (!session || typeof session !== "object") {
        return { ok: false, reason: "missing-session", session: null, observation: null, targetPoseSample: null };
    }

    const shapeReason = validateSampleShape(sample);
    if (shapeReason) {
        return { ok: false, reason: shapeReason, session, observation: null, targetPoseSample: null };
    }

    const cfg = mergeConfig(config);

    switch (session.status) {
        case "TARGET_SELECTED":
            return observeWhileTargetSelected(session, sample, cfg);
        case "TARGET_LOCKING":
            return observeWhileTargetLocking(session, sample, cfg);
        case "TARGET_LOCKED":
            return observeWhileTargetLocked(session, sample, cfg);
        case "TARGET_LOST":
            return observeWhileTargetLost(session, sample, cfg);
        case "UNSELECTED":
        case "ANALYSIS_DEGRADED":
        default:
            return {
                ok: false,
                reason: `observation-illegal-in-status-${session.status}`,
                session,
                observation: null,
                targetPoseSample: null
            };
    }
}
