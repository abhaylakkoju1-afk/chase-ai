// Swimmer tracking — public API surface.
//
// docs/SWIMMER_TRACKING_ARCHITECTURE.md §16: a narrow, deterministic
// surface. This file is the module's only public entry point;
// session.js/continuity.js/tracking.js are its implementation, not
// meant to be imported directly by callers outside this module.
//
// This module is NOT wired into index.html, video, MediaPipe, the
// detectors, or Chronos in this stage — Stage 4C.2 is the pure tracking
// core only. When a later, separately approved stage needs to read a
// clock or a video element, that adapter lives OUTSIDE this module
// (§16), never inside it.
//
// No getSession(sessionId) lookup, for the same reason
// window.ChronosEngine has none (docs/CHRONOS_ARCHITECTURE.md §18): this
// module keeps no internal session registry — the caller already holds
// the TargetLockState object returned by every call and passes it back
// in on the next one.

import { trackingCreateSession, trackingSelectTarget } from "./session.js";
import { trackingObserve } from "./tracking.js";

export const SwimmerTracking = {
    createSession: trackingCreateSession,
    selectTarget: trackingSelectTarget,
    observe: trackingObserve
};

export default SwimmerTracking;
