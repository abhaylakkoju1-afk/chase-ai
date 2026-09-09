// Chronos engine — public API surface.
//
// docs/CHRONOS_ARCHITECTURE.md §18: the browser-facing surface is a
// single namespaced object, window.ChronosEngine, kept deliberately
// separate from src/chase-engine/*'s bare-global-function convention.
// This file is the only place in src/chronos-engine/* that touches
// `window` — session.js, events.js, and time-basis.js remain plain,
// browser-free ES modules.
//
// This module is NOT wired into index.html at this stage (Stage 2 is
// core-engine implementation only — see the status note at the top of
// docs/CHRONOS_ARCHITECTURE.md). When a later, separately approved stage
// does load it in the browser, it loads as a native ES module
// (<script type="module" src="src/chronos-engine/index.js">), not a
// classic script — this repo's package.json already declares
// "type": "module", and native ES modules need no bundler in a modern
// browser, so this does not require introducing build tooling.
//
// API surface is intentionally narrow: only createSession, recordEvent,
// armSession, and abortSession are exposed. A raw, unrestricted
// transition(session, targetStatus) is deliberately NOT exposed here —
// that would let a caller jump straight to "finished" without a validated
// finish event, bypassing every rule in events.js. armSession/
// abortSession are the only transitions safe to trigger directly from
// outside; the "armed -> running" and "running -> finished" transitions
// only ever happen as a side effect of a validated recordEvent() call.
// There is also no getSession(sessionId) lookup: Chronos keeps no
// internal session registry (that would be hidden, non-caller-supplied
// state, contradicting the "deterministic, caller-supplied data" design
// rule) — the caller already holds the RaceSession object returned by
// each call and passes it back in on the next one.

import {
    chronosCreateSession,
    chronosArmSession,
    chronosAbortSession
} from "./session.js";

import { chronosRecordEvent } from "./events.js";

export const ChronosEngine = {
    createSession: chronosCreateSession,
    armSession: chronosArmSession,
    recordEvent: chronosRecordEvent,
    abortSession: chronosAbortSession
};

if (typeof window !== "undefined") {
    window.ChronosEngine = ChronosEngine;
}

export default ChronosEngine;
