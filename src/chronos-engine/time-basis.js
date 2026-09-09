// Chronos engine — timestamp validation and time-basis resolution.
//
// Pure, deterministic, browser-independent. Implements the timestamp
// rules in docs/CHRONOS_ARCHITECTURE.md §14. This module never reads
// Date.now(), video.currentTime, performance.now(), or any other clock —
// every atMs value it validates is supplied by the caller, already
// resolved on whatever basis the session's timeSource declares (for a
// "video" session, that basis is video.currentTime * 1000, read by the
// caller — never by this file).

import { TIME_SOURCES } from "./session.js";

export function chronosValidateTimeSource(timeSource) {
    return TIME_SOURCES.includes(timeSource);
}

// Validates a single caller-supplied timestamp against the session's
// declared time source. All three time sources (video, manual, wallclock)
// apply the same finiteness/non-negativity rule in v1 — this function is
// the one place that rule lives, and the seam for a future basis-specific
// rule without events.js needing to know about it.
export function chronosResolveTimestamp({ timeSource, atMs } = {}) {
    if (!chronosValidateTimeSource(timeSource)) {
        return { ok: false, reason: "unknown-time-source", atMs: null };
    }

    if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
        return { ok: false, reason: "timestamp-not-finite", atMs: null };
    }

    if (atMs < 0) {
        return { ok: false, reason: "timestamp-negative", atMs: null };
    }

    return { ok: true, reason: null, atMs };
}
