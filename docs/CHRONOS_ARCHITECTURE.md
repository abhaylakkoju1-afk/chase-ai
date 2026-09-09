# Chronos Architecture

This document establishes the authoritative v1 architecture and data
contracts for the Chronos race-timing engine. It is the Chronos
equivalent of `docs/ARCHITECTURE.md` (which covers Chase AI) and is
scoped **only** to Chronos / Race Analysis. It does not describe, and
must not be read as authorizing changes to, Chase AI, Firebase/auth, or
the PB system — those are documented elsewhere and are out of scope
here.

Status: **Stage 1 — contracts and documentation only.** No
`src/chronos-engine/` implementation exists yet. No wiring into
`index.html` exists yet. This document defines what Stage 2+ will build
against; it does not itself change any application behavior.

---

## 1. Purpose and scope

Chronos is the race-timing engine for Swimtics' Race Analysis feature.
Its job is to turn a sequence of timing signals — manual button
presses and/or automatically detected events from race video — into an
authoritative, unambiguous race timeline: one start, zero or more
splits/turns, one finish, and the derived elapsed/split times built
from them.

In scope for this document:

- The `RaceSession`, `TimingEvent`, `RaceAnalysisReport`, and
  `PBComparison` data contracts.
- The Chronos state machine and event-validation/deduplication rules.
- The layer boundary between video/pose processing, detectors,
  Chronos itself, Race Analysis, PB comparison, and the UI.
- The proposed `src/chronos-engine/` module structure and the
  `window.ChronosEngine` public API surface.
- What is reusable from the existing (currently dead) `onRaceResults()`
  code as detector prior art, and what is not.

## 2. Non-goals

- Chronos does not do pose estimation, video decoding, canvas frame
  capture, or any DOM manipulation. Those stay in the video/detection
  layer and the UI layer respectively.
- Chronos does not read or write `localStorage`, Firebase, or the
  `pbs` array. It never persists anything itself.
- Chronos does not decide whether a completed race becomes a new PB.
  That is an explicit, user-confirmed UI action, never automatic (see
  §20).
- Chronos does not produce biomechanical/technique judgments. That is
  Chase AI's domain and is explicitly out of scope for this engine.
- This document does not authorize any change to `src/chase-engine/*`,
  Firebase/auth, the PB implementation, or existing race-page code.
  Those remain untouched until an explicitly scoped, separately
  approved task.

## 3. Layer architecture

```
VIDEO
  │  (existing pattern: <video> element, canvas frame grab)
  ▼
FRAME / POSE PROCESSING
  │  (drives a MediaPipe Pose instance, produces {landmarks, timestamp} per frame)
  ▼
DETECTORS
  │  (pure functions: landmark window + config → candidate TimingEvent + confidence)
  ▼
CHRONOS
  │  (authoritative session/event state machine — this document's subject)
  ▼
RACE ANALYSIS
  │  (builds a RaceAnalysisReport from a RaceSession)
  ▼
PB COMPARISON
  │  (compares RaceAnalysisReport.finalTimeMs against an existing PB, read-only)
  ▼
UI
   (renders the report into the #race page; wires buttons/detectors into Chronos)
```

## 4. Layer responsibilities and non-responsibilities

| Layer | Owns | Does NOT own |
|---|---|---|
| Video/frame processing | Video element state, canvas frame extraction, running pose inference, per-frame `{landmarks, timestamp}` | What a pose means for timing; race state; DOM beyond an optional skeleton overlay |
| Detectors | Turning a landmark window into a **candidate** `TimingEvent` + confidence | Deciding which candidates are authoritative; session/clock state; DOM; PB data |
| **Chronos** | Session lifecycle, event ingestion (manual + detector, one API), validation/dedup/state-machine rules, elapsed-time derivation, the canonical event log | Pose estimation; video/canvas/DOM; PB storage; coaching/technique interpretation |
| Race Analysis | Turning a `RaceSession` into a structured, presentational `RaceAnalysisReport` | Timing correctness itself (trusts Chronos); PB storage |
| PB comparison | Comparing a final time against an existing PB (read-only) | Timing logic; deciding to save a new PB |
| UI | Wiring buttons/detector callbacks to Chronos calls; rendering the report | Any timing math, dedup, or state-machine logic |

Chronos itself must remain independent of: DOM, video elements,
MediaPipe, Firebase, `localStorage`, PB persistence, and
coaching/technique interpretation. Every value Chronos operates on is
supplied by its caller as plain data.

## 5. `RaceSession` contract

```js
RaceSession = {
  sessionId: string,
  createdAtMs: number,

  status: "idle" | "armed" | "running" | "finished" | "aborted",

  // Race metadata — see §12 for the PB-vocabulary compatibility requirement.
  poolLengthMeters: number,
  course: string,          // must match the existing pb.course vocabulary exactly
  event: string,            // e.g. "Freestyle 100m" — must match getPB()'s expected key format
  strokeKey: string | null,
  distanceMeters: number | null,

  timeSource: "video" | "manual" | "wallclock",

  events: TimingEvent[],
  finalTimeMs: number | null
}
```

`RaceSession` is plain, JSON-serializable data. No methods, no
DOM/browser object references, no class instances.

## 6. `TimingEvent` contract

```js
TimingEvent = {
  id: string,
  type: "start" | "split" | "turn" | "finish",
  atMs: number,                 // resolved timestamp on the session's timeSource basis — see §14
  distanceMeters: number | null, // see §12 for how this differs between "split" and "turn"
  source: "manual" | "detector",
  detector: string | null,       // e.g. "wall-proximity-v1"; null when source === "manual"
  confidence: number | null,     // 0..1 for detector events; null for manual — see §15
  supersedes: string | null      // id of an earlier event this corrects, if any
}
```

## 7. `RaceAnalysisReport` contract

```js
RaceAnalysisReport = {
  sessionId: string,
  event: string,
  course: string,
  poolLengthMeters: number,
  strokeKey: string | null,

  finalTimeMs: number | null,
  finalTimeFormatted: string | null,

  splits: [
    {
      index: number,
      kind: "turn" | "checkpoint",   // see §12 — derived from the source event's type
      distanceMeters: number,
      splitTimeMs: number,            // time since the previous split/start
      cumulativeTimeMs: number,       // time since start
      source: "manual" | "detector",
      confidence: number | null
    }
  ],

  paceTrend: "even" | "positive" | "negative" | "indeterminate", // derived, tagged as inferred

  pbComparison: PBComparison | null,

  dataQuality: {
    detectorEventCount: number,
    manualEventCount: number,
    lowConfidenceEventCount: number,
    notes: string[]
  }
}
```

The UI renders only from this object. It never re-derives timing math
itself.

## 8. `PBComparison` contract

```js
PBComparison = {
  hasPb: boolean,
  existingPbTimeMs: number | null,
  deltaMs: number | null,   // negative = faster than PB
  isNewPb: boolean,
  formatted: string          // e.g. "-0.42s vs PB" or "No existing PB on record"
}
```

Produced by a pure function that takes `finalTimeMs` and an
already-fetched existing-PB time string (from the existing `getPB()`)
as plain inputs. It never touches `localStorage` itself (§20).

## 9. Chronos state machine

```
idle ──(armed by caller, e.g. video/detectors ready)──▶ armed
armed ──(first accepted "start" event)──▶ running
running ──(accepted "finish" event)──▶ finished
running/armed ──(caller aborts, e.g. new video loaded)──▶ aborted
```

- `idle` — session created, not yet ready to accept timing events other
  than being armed.
- `armed` — ready to accept a `start` event (manual or detector).
- `running` — a `start` has been accepted; `split`/`turn` events are
  accepted; a `finish` event transitions to `finished`.
- `finished` — terminal; `finalTimeMs` is set; no further events are
  accepted (a caller wanting to record a correction uses `supersedes`
  on a new session, not by mutating a finished one — see §16, §23
  known-limitation note on corrections being out of v1 scope).
- `aborted` — terminal; session discarded (e.g. user re-uploads a
  video mid-session). No `finalTimeMs`.

## 10. Event validation rules

An incoming event is validated before being accepted into
`session.events`:

1. `atMs` must be a finite number.
2. `atMs` must be resolvable on the session's configured `timeSource`
   (see §14) — an event whose timestamp cannot be trusted is rejected,
   not silently coerced.
3. The event's `type` must be legal for the session's current `status`
   (e.g. a `split` cannot be accepted while `status === "idle"`).
4. Distance-bearing events (`split`, `turn`, `finish`) must have a
   `distanceMeters` that is not less than the previous accepted
   distance-bearing event's `distanceMeters` (strictly increasing is
   preferred; see §13 for how ties/near-ties are handled).

## 11. Start/finish rules

- Exactly one `start` event per session. The first accepted `start`
  (manual or detector, whichever arrives first) transitions
  `armed → running` and becomes the session's t=0 reference. Any
  further `start` candidate is rejected with reason
  `"start-already-recorded"`.
- Exactly one `finish` event per session, only accepted while
  `status === "running"`. It transitions `running → finished` and sets
  `finalTimeMs = finish.atMs - start.atMs`. A `finish` candidate
  arriving before any `start` is rejected with reason
  `"finish-before-start"`.

## 12. Split/turn semantics

`split` and `turn` share the same `TimingEvent` shape, but they are
**not semantically interchangeable**, and Race Analysis must not treat
them as such:

- **A `turn` is a physical event**: the swimmer made wall contact (or
  a detector inferred wall proximity + direction reversal) and changed
  direction. A turn always occurs at a cumulative distance that is a
  multiple of `poolLengthMeters` (25m, 50m, 75m, …), because it is
  tied to the physical structure of the pool.
- **A `split` is a timing checkpoint**: a moment at which elapsed time
  and cumulative distance were recorded, for reporting purposes. A
  split does *not* imply a wall was touched — it exists so that
  distance/time markers that are not turns (a mid-length manual
  checkpoint, a future non-turn detector such as an electronic timing
  pad or a lap-counter tap) have a place in the model without being
  mischaracterized as a physical turn.
- **Every recorded `turn` also functions as a split/checkpoint** for
  the purposes of building `RaceAnalysisReport.splits` — a turn's
  `distanceMeters`/`atMs` are exactly the information a split needs.
  Chronos does not require a separate, duplicate `split` event to be
  recorded alongside a `turn`; the Race Analysis report layer builds
  its `splits[]` array from **both** `split` and `turn` events
  combined, sorted by `atMs`.
- **The reverse is not true**: not every `split` is a `turn`. A
  mid-length checkpoint recorded without a wall-contact signal must
  stay typed `split`, never be upgraded to `turn`.
- **`distanceMeters` interpretation**: for a `turn`, it is the
  cumulative distance swum at the moment of wall contact (expected —
  though not hard-enforced, see §8 of the architecture proposal — to
  be a multiple of `poolLengthMeters`). For a `split`, it is simply the
  cumulative distance at the checkpoint moment, with no such
  expectation.
- **How Race Analysis distinguishes them**: each entry in
  `RaceAnalysisReport.splits[]` carries `kind: "turn" | "checkpoint"`,
  derived directly from the source event's `type` (`turn` → `"turn"`,
  `split` → `"checkpoint"`). This lets the UI render a distinct marker
  for a physical turn (e.g. a wall icon, and potentially reset
  stroke-count-since-last-turn in a future stage) versus a plain timing
  checkpoint, while both flow through identical split-time/cumulative-
  time arithmetic.

The internal `TimingEvent` representation stays unified (one shape,
`type` as discriminant) — this section defines the semantic contract
Race Analysis and any future detector must honor on top of that shared
shape, not a second data structure.

## 13. Event deduplication / conflict handling

- A minimum time gap between consecutive distance-bearing events
  (`split`/`turn`), a named configurable constant (default informed by,
  but not copied verbatim from, the existing heuristic's `2.5s`
  debounce), applied regardless of source.
- A candidate event that fails validation (§10) or collides with an
  existing rule (duplicate start, finish-before-start, out-of-order
  distance, too-soon-after-previous) is **rejected, not dropped
  silently** — `chronosRecordEvent` returns
  `{ ok: false, reason, session }` so the caller (UI or detector
  pipeline) can surface why an event didn't count.
- Manual and detector-sourced events are validated against the exact
  same rules — there is no separate "trust the human, ignore the
  detector" bypass in the validation logic itself. Trust is expressed
  through `confidence` and `source` in the data (§15), not through
  different acceptance rules.

## 14. Timestamp / time-basis rules

- Chronos never reads `Date.now()`, `video.currentTime`, or any DOM
  state itself. Every `atMs` is supplied by the caller.
- For a `timeSource: "video"` session, the intended time basis is
  video media time in milliseconds (`video.currentTime * 1000`),
  supplied by the caller at the moment an event occurs — for **both**
  detector-sourced and manual (button-press) events.
- **This is a deliberate behavior change from the current manual
  timer**, which today mixes a wall-clock-adjacent baseline with
  `video.currentTime` reads in a way that does not hold up under
  pause/seek/non-1x playback. Unifying manual and automatic events on
  one time basis is what allows them to coexist correctly in one
  session (§6 of the approved decisions). **This change must be
  explicitly documented (this section) and tested (§21) before any UI
  integration — it is listed again in §24 as requiring approval before
  Stage 2's UI-facing work.**
- `timeSource: "wallclock"` remains available for a possible future
  live/webcam mode where no recorded video exists; Chronos's
  validation/dedup logic does not care which basis is configured, only
  that the session is internally consistent.
- `timeSource: "manual"` is reserved for a session with no video at
  all (pure stopwatch use), where the caller supplies wall-clock-based
  `atMs` values throughout.

## 15. Manual vs. detector event trust/confidence model

- Manual (`source: "manual"`) events carry `confidence: null` — they
  are treated as the "measured"/highest-trust tier, consistent with
  this repository's existing measured/inferred/indeterminate
  convention (see `CLAUDE.md` §15, which is a Chase-specific document
  but whose disclosure pattern is worth reusing here).
- Detector (`source: "detector"`) events always carry a `confidence`
  in `[0, 1]`. Chronos does not reject a low-confidence detector event
  outright (that is a Race Analysis / UI presentation concern, §12 of
  the approved decisions, item §13) — it still applies the same
  validation/dedup rules, but the resulting `RaceAnalysisReport`
  surfaces confidence per split so the UI never presents an inferred
  event with the same certainty as a manual one.
- Manual and detector events coexist in the same session's `events[]`
  array — there is no session-level "mode switch" between manual-only
  and automatic-only timing (decision §6).

## 16. Error / rejection model

- Expected rejections (duplicate start, finish-before-start,
  out-of-order distance, too-soon-after-previous, unresolvable
  timestamp) are returned as typed results:
  `{ ok: false, reason: string, session }` — never thrown.
- Exceptions are reserved for genuine programming errors: missing
  required parameters to `chronosCreateSession`/`chronosRecordEvent`,
  or an invalid `type`/`status` combination that indicates a caller
  bug rather than a real-world timing ambiguity.
- Every rejection reason is a stable, documented string (not a free-
  text message) so the UI layer can map reasons to user-facing
  explanations without string-matching brittle text.
- Correcting a mistaken event (e.g. an accidental double-tap on
  "Split") is out of v1 scope beyond the `supersedes` field existing in
  the data model (§6) — no correction UI or Chronos-side correction
  logic is being built in Stage 1 or its immediate following stages.
  This is a known limitation, not an oversight (see §22).

## 17. Proposed `src/chronos-engine/` module structure

```
src/chronos-engine/
  session.js              chronosCreateSession, status transitions (§9) — pure
  events.js               chronosRecordEvent + validation/dedup rules (§10, §11, §13) — pure
  time-basis.js            timestamp validation/normalization per session.timeSource (§14) — pure,
                           implemented independently of src/chase-engine/frame-timing.js
                           (no import/dependency — see decision §4 and §10 of the approved plan)
  report.js                chronosBuildReport(session) -> RaceAnalysisReport (§7, §12)
  pb-comparison.js          chronosComparePB(finalTimeMs, existingPbTimeString) -> PBComparison (§8, §20)
  detectors/
    start-detector.js         pure, confidence-scored version of the nose.x displacement heuristic
    turn-detector.js          pure, confidence-scored version of the wall-proximity/velocity heuristic
    stroke-rate-detector.js   pure, confidence-scored version of the wrist-oscillation SPM heuristic
                              (optional for the first detector-integration stage; may be deferred)
  index.js                  public surface; exposes window.ChronosEngine = {...} (§18)
```

No implementation files exist yet. This structure is the target for
Stage 2 onward.

## 18. Public `window.ChronosEngine` API boundary

The browser-facing surface is a single namespaced object,
`window.ChronosEngine`, exposing (names indicative, finalized at
Stage 2):

```js
window.ChronosEngine = {
  createSession,   // chronosCreateSession
  recordEvent,     // chronosRecordEvent
  buildReport,     // chronosBuildReport
  comparePB        // chronosComparePB
};
```

This is a deliberate departure from `src/chase-engine/*`'s convention
of attaching bare global functions via classic `<script src>` tags —
namespacing under one object avoids any risk of name collision with
Chase's globals and keeps the two engines visibly and mechanically
separate, per decision §3.

## 19. Race Analysis integration boundary

Race Analysis is not a separate running system — it is the
`report.js` module's `chronosBuildReport(session)` function, called by
the UI layer after (or during) a session, and the `splits[]` semantics
defined in §12. It reads only a `RaceSession`; it never reads DOM,
video, or detector internals directly. Once implemented, `index.html`'s
race-page script will call `window.ChronosEngine.buildReport(session)`
and render the result — no timing math will live in `index.html`
after that integration stage.

## 20. PB integration boundary

- Race Analysis reads an existing PB via the existing, unmodified
  `getPB(eventName)` function (confirmed safe to reuse — see the Part 1
  PB investigation from the prior planning turn) and passes the result
  into `chronosComparePB()`.
- `chronosComparePB()` never calls `getPB()`, `savePB()`, or touches
  `localStorage` itself — the caller (UI layer) is responsible for the
  `getPB()` call, keeping `pb-comparison.js` pure and Node-testable.
- **PBs are never automatically written by Race Analysis** (decision
  §7). A future "Save as PB" action, if built, will be an explicit,
  user-confirmed UI action that calls the existing `savePB()` — that
  wiring is out of scope for this document and for Stage 1.
- Race metadata (`event`, `course`, `strokeKey`, `distanceMeters` on
  `RaceSession`, §5) must use vocabulary compatible with the existing
  PB system: `course` must match the string values already used in
  `pb.course`, and `event` must match the exact key format `getPB()`
  expects (`${capitalize(stroke)} ${distance}m`, confirmed from its
  existing call sites). This is a hard integration constraint, not a
  stylistic preference (decision §8).

## 21. Testing strategy

- Chronos (`session.js`, `events.js`, `time-basis.js`, `report.js`,
  `pb-comparison.js`) is pure, DOM-free, browser-free data-in/data-out
  code — testable directly under Node's built-in test runner
  (`node --test`), the same tool already used for `src/chase-engine/*`,
  with **no extraction-hack required** (unlike
  `test/extract-chase-functions.js`, which exists only because Chase's
  equivalent logic is still trapped inside `index.html`).
- Fixture-replay unit tests: scripted sequences of
  `chronosRecordEvent()` calls with fixed, hand-chosen timestamps,
  asserting on the resulting `RaceSession`/`RaceAnalysisReport` —
  particularly every rule in §10, §11, §13 (duplicate start, finish-
  before-start, out-of-order distance, too-soon debounce).
  Deterministic, fast, no browser.
  - Every deduplication/state-machine rule must have both a
    "rejected" case and an "accepted" case asserted explicitly.
- Detector unit tests (once `detectors/` exists, a later stage):
  scripted landmark-window fixtures, no real video, no real MediaPipe
  — mirrors the existing `test/frame-timing.test.js` /
  `test/stroke-cycles.test.js` pattern.
- Time-basis tests (§14): synthetic frame-sequence fixtures proving
  the video-media-time behavior change before any UI wiring, mirroring
  how `test/e2e/frame-timing-lifecycle.spec.js` validates Chase's rVFC
  wiring against a synthetic stand-in rather than real video.
- E2E (Playwright) coverage of the actual `#race` page wiring is a
  later-stage concern (post Stage 1), analogous to the existing
  `test/e2e/shell.spec.js` pattern — not part of this documentation
  stage.

## 22. Known limitations of the existing detector heuristics

The existing (currently dead — see §23) `onRaceResults()` code in
`index.html` is the source of the start/turn/stroke-rate heuristics
that will seed `detectors/`. Its known limitations, carried forward
explicitly rather than silently inherited:

- Assumes a fixed, side-on camera framing the full pool width, with
  the swim direction horizontal in frame. Does not generalize to other
  camera placements (behind-the-blocks, overhead, handheld/moving).
- `laneCenterY`/`startX` are captured from the *first* detected pose
  after analysis starts and never re-validated — a bad or partial
  first-frame detection poisons the session's entire baseline with no
  correction path.
- All thresholds (`WALL_THRESHOLD = 0.25`, velocity `0.015`,
  displacement `0.08`) are unitless, normalized-coordinate constants
  that implicitly assume a specific framing/zoom, and are not validated
  against any real swim footage — consistent with this repository
  having no evaluation dataset or harness anywhere yet (see the
  repository reconnaissance findings).
- The original code produces no confidence score at all — a heuristic
  either fires or it doesn't. Confidence-scoring these signals for
  `TimingEvent.confidence` is new work, not a straightforward port.
- The original code holds module-level mutable `let` state
  (`splitCount`, `wallContactActive`, `lastTurnTime`, etc.), making it
  untestable in isolation as written — the ported detector functions
  must be pure (explicit rolling-window/state argument in, candidate
  event argument out).

## 23. Prior art, not the engine

**The existing `onRaceResults()` implementation in `index.html` is
prior art only. It is not the Chronos engine, does not become the
Chronos engine by being wired up, and is not being reconnected as
part of this or any currently-approved stage.** It is dead code today
(the `racePose` instance that would invoke it is never assigned, and
`initRaceAI()`/`processRaceFrame()`/`startTimer()` are called but
never defined anywhere in `index.html` — confirmed during the
repository reconnaissance that preceded this document). Its heuristic
logic is a candidate source for future `detectors/` modules, subject to
the evaluation and confidence-scoring described in §22, not a system to
be resurrected as-is.

## 24. Behavior changes requiring approval before UI integration

The following are explicitly flagged as user-facing behavior changes
relative to the current (dead) race-page code, and must be confirmed
before any Stage that wires Chronos into `index.html`:

1. **Manual timing moves to a video-media-time basis** (§14) — today's
   manual Start/Split/Reset buttons are wall-clock/`video.currentTime`
   read at click time with a separate baseline; Chronos's model instead
   requires every manual event's `atMs` to be `video.currentTime * 1000`
   for a `timeSource: "video"` session, so it can coexist with detector
   events on one consistent timeline.
2. **A single authority now arbitrates start/split/finish events** —
   today, a manual `split()` and the (dead, unreachable) automatic
   split detector both write independently into `#splits` with no
   conflict resolution; once integrated, only Chronos-accepted events
   will appear, and rejected candidates will not silently disappear but
   will be reportable as rejected (§13, §16). This changes what a user
   sees if they trigger conflicting manual/automatic input.
3. **PBs are never auto-saved from a race result** (§20, decision §7)
   — confirmed already as a hard requirement, listed here again because
   it is a user-facing capability decision, not just an implementation
   detail.
4. **A stroke/distance selector must exist on the race page** (§20,
   decision §8) to supply the `event` metadata `RaceSession` and
   `getPB()` require — the race page has no such control today. Adding
   it is new UI, not pure refactor, and needs confirmation as in-scope
   for whichever stage first wires metadata collection.

No implementation stage should proceed past documentation without your
explicit sign-off on the items above, per decision item 5 in the
approved architecture proposal.
