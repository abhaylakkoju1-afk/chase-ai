# Race Pipeline Architecture

This document establishes the authoritative v1 architecture and contracts
for `src/race-pipeline/` — the integration/adapter layer that connects
the existing video/MediaPipe layer to the three already-built pure
modules (`src/swimmer-tracking/*`, `src/chronos-engine/*` including
`detectors/*`) and, ultimately, to the Race Analysis UI. It is the
sibling of `docs/CHRONOS_ARCHITECTURE.md` and
`docs/SWIMMER_TRACKING_ARCHITECTURE.md`, scoped only to the integration
boundary between them. It does not authorize any change to Chronos,
swimmer tracking, the detectors, Chase AI, Firebase/auth, or the PB
implementation.

Status: **Stage 4D.2 — contracts and documentation only.** No
`src/race-pipeline/` implementation exists yet. `index.html` is
untouched. This document defines what Stage 4D.3+ will build against.

---

## 1. Purpose and Scope

`race-pipeline` is an **integration/adapter layer**, not a fourth pure
module. Its entire reason to exist is to know about the things the pure
modules are explicitly forbidden from knowing about, and to translate
between the browser/video world and the pure-data world those modules
operate in.

`race-pipeline` **may** know about:

- the video element, `requestVideoFrameCallback`, `video.currentTime`
- MediaPipe (`results.poseLandmarks`)
- browser APIs and the DOM
- `SwimmerTracking` (`src/swimmer-tracking/index.js`)
- `ChronosEngine` and the detectors (`src/chronos-engine/*`)
- the existing PB read function, `getPB(eventName)` (read-only)

**The reverse must never be true.** `src/swimmer-tracking/*`,
`src/chronos-engine/*` (including `detectors/*`), and the eventual
`src/chronos-engine/report.js`/`pb-comparison.js` must never import from
`src/race-pipeline/*`, must never read a clock or the DOM, and must
never know `race-pipeline` exists. This is not a new rule — it is the
same purity boundary those modules' own architecture documents already
established (`docs/CHRONOS_ARCHITECTURE.md` §6/§14,
`docs/SWIMMER_TRACKING_ARCHITECTURE.md` §6/§16) — `race-pipeline` is the
first consumer that is *allowed* to cross it, not a reason to weaken it.

## 2. Pipeline Overview

```
VIDEO
  ↓
FRAME / TIMESTAMP CAPTURE          (race-pipeline, browser-bound)
  ↓
POSE SAMPLE ADAPTER                (race-pipeline, stateless per call)
  ↓
SWIMMER TRACKING                   (pure, unchanged — stateful via caller-held session)
  ↓
TARGET POSE ADAPTER                (race-pipeline, stateless per call)
  ↓
START / TURN DETECTORS             (pure, unchanged — stateless; rolling state held by caller)
  ↓
EVENT ADAPTER                      (race-pipeline, stateful — owns distance bookkeeping)
  ↓
CHRONOS                            (pure, unchanged — stateful via caller-held session)
  ↓
RACE ANALYSIS REPORT               (pure, src/chronos-engine/report.js — not yet built)
  ↓
PB COMPARISON                      (pure, src/chronos-engine/pb-comparison.js — not yet built)
  ↓
UI                                 (race-pipeline / index.html, browser-bound)
```

| Layer | Purity |
|---|---|
| Frame/timestamp capture | Browser-bound |
| Pose sample adapter | Race-pipeline, but internally a pure mapping function — no state of its own beyond the call arguments |
| SwimmerTracking | Pure — unchanged |
| Target pose adapter | Race-pipeline, pure mapping function |
| Detectors | Pure — unchanged; **stateless as functions**, but the rolling windows/`previousCandidateAtMs` they need are real state, owned by the detector adapter, not by the detectors themselves (confirmed by Stage 4B's design: `chronosDetectStart`/`chronosDetectTurn` take history as an argument, they don't remember it) |
| Event adapter | Race-pipeline, **stateful** — owns cumulative distance (§9) |
| Chronos | Pure — unchanged |
| RaceAnalysisReport / PB comparison | Pure — `chronos-engine`'s own responsibility (§11, §12), not yet built |
| UI | Browser-bound |

## 3. Module Responsibilities

### `pose-sample-adapter.js`

**Responsible for:**
- Converting a raw MediaPipe `results` object (plus a caller-supplied
  timestamp) into a `PoseSample` (`docs/SWIMMER_TRACKING_ARCHITECTURE.md`
  §7.1).
- Timestamp injection — the multiplication/selection described in §4
  happens here, nowhere else.
- Hip midpoint mapping (§5, Decision 1).
- Nose mapping.
- Visibility handling per the explicit rule in §5.
- `hasPose` semantics.

**Must NOT:**
- Detect starts or turns.
- Track identity.
- Write to the DOM.
- Access PB data.
- Call Chronos or `SwimmerTracking` itself — it only *produces* the
  `PoseSample` a caller then passes to `SwimmerTracking.observe()`.

### `detector-adapter.js`

**Responsible for:**
- Consuming the **confirmed** target `PoseSample` (`targetPoseSample`
  from `SwimmerTracking.observe()`) — never anything else.
- Reshaping that `PoseSample` into each detector's own expected input
  shape (§7).
- Maintaining the detector rolling state (`baselineWindow` for start;
  `recentSamples`/`previousCandidateAtMs` for turn) across calls, since
  neither detector remembers its own history.
- Passing timestamps through unchanged — no re-reading, no
  recomputation.
- Collecting whatever candidates the detectors produce (which may be
  `null`) and handing them to the event adapter.

**Must NOT:**
- Own authoritative race state — a detector candidate is not a race
  event.
- Write to the DOM.
- Modify PB data.
- Bypass Chronos — a candidate never directly becomes a `TimingEvent`.
- Independently decide whether an event is authoritative — that
  decision belongs to Chronos alone (§17 invariant 3).

### `event-adapter.js`

**Responsible for:**
- Converting a detector candidate into a `TimingEvent` input shape
  (§8).
- Assigning `source: "detector"` and the correct `detector` name string.
- Carrying the candidate's `confidence` through unchanged.
- Maintaining cumulative distance bookkeeping (§9) — the **only**
  adapter-owned piece of state that is more than a rolling window.
- Calling `ChronosEngine.recordEvent()` and reading its result.

**Critical rule (Decision 2):** distance advances **only after** Chronos
accepts the corresponding turn event. A candidate's tentative distance
is computed and submitted *before* Chronos's decision is known; the
adapter's own running counter is updated *only if* `recordEvent()`
reports acceptance. Rejected candidates never advance distance, and
adapter-local state must never be allowed to say something different
from what `session.events[]` (Chronos's own authoritative log) says
happened — see the worked example in §9 and invariant 7 in §17.

### `ui-bindings.js`

**Responsible only for:**
- Receiving a `RaceAnalysisReport` (or a `PBComparison`, or a raw
  `RaceSession`/`TargetLockState` for status display) and formatting
  values for presentation.
- Writing race-page DOM (`#timer`, `#splits`, `#raceMetrics`, and
  whatever new elements Stage 4D.7 adds).

**Must NOT:**
- Perform timing calculations of any kind — every number it displays
  must already exist on the object it was handed.
- Detect events.
- Modify Chronos state, tracking state, or PB state.

## 4. Timestamp Contract

**One authoritative rule for recorded video:**

```
video media timestamp (video.currentTime, or rVFC's metadata.mediaTime, both in SECONDS)
        ↓  × 1000, performed exactly once, inside pose-sample-adapter.js's caller
PoseSample.atMs  (MILLISECONDS)
```

The adapter may obtain the source timestamp from either:
- `requestVideoFrameCallback`'s `metadata.mediaTime`, when supported — the
  proven, frame-accurate mechanism Chase's own `frame-timing.js` already
  validates (see `docs/CHRONOS_ARCHITECTURE.md` §22's "prior art"
  framing and Stage 4D.1 §1's reconnaissance of
  `chaseStartVideoFrameTicker`/`chaseBuildPendingFrameTiming`), or
- `video.currentTime`, read at the same moment a frame is captured, as
  the fallback when `requestVideoFrameCallback` is unsupported.

**No new clock abstraction is introduced.** This is the same two-mode
pattern (rVFC-preferred, `video.currentTime`-fallback) Chase's
`frame-timing.js` already proved out — `race-pipeline` should mirror
that *pattern*, not import Chase's code (Chase AI remains untouched,
§17 invariant 10).

**This multiplication/selection must happen exactly once, inside
`race-pipeline`, before a `PoseSample` is ever constructed.** Chronos,
`SwimmerTracking`, and the detectors must never read `video.currentTime`
or any clock — confirmed unchanged in both sibling architecture
documents and in the actual implementation (grep-verified in Stage
4C.4's review: zero real references anywhere in `src/chronos-engine/*`
or `src/swimmer-tracking/*`).

- **Units:** milliseconds, end to end, from `PoseSample.atMs` through
  `TrackingObservation.atMs`, the detector's `sample.atMs`, and
  `TimingEvent.atMs` — no unit changes at any adapter boundary.
- **Monotonicity:** not assumed or enforced by `race-pipeline` itself —
  both `SwimmerTracking` and Chronos already have their own explicit,
  tested non-monotonic-timestamp handling (treating an out-of-order
  sample as ambiguous/rejected rather than crashing or guessing,
  confirmed in Stage 4C's review). `race-pipeline` passes whatever
  timestamp it captured straight through and trusts the pure modules'
  own rules.
- **Behavior during seeking:** not specially handled by the adapters
  themselves — a seek simply produces a `PoseSample` whose `atMs` may
  jump forward or backward relative to the previous one, and the pure
  modules' existing rules apply. **Whether a large backward seek should
  instead trigger a full pipeline reset (new sessions, fresh generation
  token) is an open question for Stage 4D.6 (§8 of Stage 4D.1's
  reconnaissance), not resolved here.**
- **Duplicate timestamps:** already handled by the pure modules
  (`estimateVelocity`'s `deltaTMs <= 0 → null` guard, confirmed in
  `src/swimmer-tracking/continuity.js`) — no adapter-side deduplication
  is added.
- **Stale asynchronous results / analysis-session identity:**
  `race-pipeline` must adopt the same **generation-token** pattern Chase
  already proved (`chaseAnalysisGeneration`, confirmed in Stage 4D.1
  §1) — a monotonically-incrementing counter, bumped on every reset/new
  upload, captured at dispatch time, and checked at result time so a
  MediaPipe result that resolves after a reset is recognized as stale
  and discarded before it ever becomes a `PoseSample`. This generation
  check happens in `race-pipeline`, upstream of `pose-sample-adapter.js`
  — the adapter itself does not need to know about generations, only
  about whether it was called at all for a given frame.

## 5. PoseSample Contract

```js
PoseSample = {
  atMs: number,                                    // see §4
  hasPose: boolean,                                 // per docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1
  landmarks: { hip: {x,y,visibility}, nose: {x,y,visibility} } | null
}
```

**`hasPose`:** `!!(results && Array.isArray(results.poseLandmarks) &&
results.poseLandmarks.length > 0)` — the exact same check Chase's own
`chaseBuildPoseFrame()` already uses (confirmed,
`src/chase-engine/pose-frame.js`), reproduced independently here (never
imported — Chase AI stays untouched).

**`nose`:** `results.poseLandmarks[0]` (BlazePose index `NOSE = 0`,
confirmed against `CHASE_LANDMARK_INDEX` in `index.html`), mapped
directly: `{x: lm[0].x, y: lm[0].y, visibility: lm[0].visibility ?? null}`.

**`hip` — Decision 1 (approved):** the midpoint of `LEFT_HIP = 23` and
`RIGHT_HIP = 24`, **not** the old dead race-page's right-hip-only
heuristic (`lm[24]` alone, confirmed dead in Stage 4D.1 §3).

```js
function mapHip(lm) {
  const left = lm[23];
  const right = lm[24];

  const leftValid = left && isFiniteNumber(left.x) && isFiniteNumber(left.y);
  const rightValid = right && isFiniteNumber(right.x) && isFiniteNumber(right.y);

  if (!leftValid && !rightValid) {
    return null; // no fabricated point — see below
  }

  if (leftValid && rightValid) {
    return {
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
      // z is carried for completeness but is not part of the
      // PoseSample.landmarks.hip contract, which is 2D-only
      // (docs/SWIMMER_TRACKING_ARCHITECTURE.md §7.1 has no z field) —
      // computed here only if a future contract needs it, not exposed.
      visibility: combineVisibility(left.visibility, right.visibility)
    };
  }

  // Exactly one side valid — see the explicit single-side rule below.
  const only = leftValid ? left : right;
  return { x: only.x, y: only.y, visibility: only.visibility ?? null };
}
```

**Visibility rule — explicit, not a hidden fallback:**
- **Both hips valid:** `visibility = Math.min(left.visibility ?? 0, right.visibility ?? 0)` —
  the same "a centroid is only as trustworthy as its least visible
  input" rule `computeRepresentativePosition()` already applies to
  `hip`+`nose` one layer up (`src/swimmer-tracking/continuity.js`,
  confirmed). Applying the identical rule one layer earlier, to the two
  raw hip landmarks that feed the midpoint, is a direct, consistent
  extension of that same principle — not a new one.
- **Exactly one hip valid:** use that single hip's own `x`/`y`/`visibility`
  directly — this is a midpoint of one point, which is just that point.
  Not a silent right-hip preference: it is symmetric, and would use the
  left hip alone under the mirror-image condition just as readily.
- **Neither hip valid:** `hip: null` on the returned landmarks map — see
  below.

**`z` (depth):** MediaPipe provides it, and the midpoint math above shows
how it *would* be averaged, but it is **not part of the `hip`/`nose`
shape `PoseSample.landmarks` actually needs** — `docs/SWIMMER_TRACKING_ARCHITECTURE.md`
§7.1's `landmarks` shape is `{x, y, visibility}` only, matching what
`computeRepresentativePosition()` actually reads. `z` is not populated
in the adapter's output, to avoid a field that exists but nothing
downstream is contracted to use.

**When one or both required landmarks are unavailable/unusable:**
**follow `SwimmerTracking`'s own existing validity semantics rather than
fabricating a point** — per Decision 1's explicit instruction. Concretely:
- If `nose` is unusable, or `hip` is unusable (both sides invalid per
  the rule above), the adapter must **not** invent a placeholder
  coordinate. It should build the `PoseSample` with `landmarks` either
  `null` (if `hasPose` is already false) or an object whose `hip`/`nose`
  field is `null` for whichever side is missing.
- `SwimmerTracking`'s own `extractPositionFacts()`/`computeRepresentativePosition()`
  already treat a missing `hip` or `nose` (or a `landmarks` object that
  doesn't have them) as "no usable representative position" — the exact
  same `"gap"` outcome `hasPose: false` produces (confirmed,
  `docs/SWIMMER_TRACKING_ARCHITECTURE.md` §7.3's `outcome` field and the
  Stage 4C.4 regression test proving this exact behavior at the
  `trackingObserve()` boundary). **The adapter does not need its own
  "what if a landmark is missing" branch beyond simply passing through
  whatever it has** — `SwimmerTracking` already does the right thing
  with an incomplete `landmarks` object. This is a case of *reusing* an
  existing, tested contract rather than inventing new adapter-side logic.

## 6. Tracking Contract

```
PoseSample
        ↓
SwimmerTracking.observe(session, sample, config?)
        ↓
{ ok, session, observation, targetPoseSample, reason? }
```

`SwimmerTracking` (`src/swimmer-tracking/index.js`) remains completely
unchanged. `race-pipeline` may read, from the result of every `observe()`
call:

- `session.status` — for UI status display and for deciding whether to
  proceed to the detector adapter at all.
- `targetPoseSample` — the **only** thing ever allowed to proceed
  downstream to the detector adapter.
- `observation.outcome` (`"confirmed" | "ambiguous" | "gap"`) and
  `observation.reacquired` — for diagnostics/data-quality reporting
  (§11's future `RaceAnalysisReport` needs), not for making its own
  identity decisions.

**Only a non-null `targetPoseSample` may proceed to the detectors.**
Every other case — `TARGET_SELECTED`/`TARGET_LOCKING` in progress,
`TARGET_LOST`, `ANALYSIS_DEGRADED`, or a rejected/illegal `observe()`
call (`ok: false`) — stops at this boundary. This is not a new rule
`race-pipeline` invents; it is the literal, already-proven §13 invariant
of `docs/SWIMMER_TRACKING_ARCHITECTURE.md` ("Timing Integrity
Invariant"), and `race-pipeline`'s job here is simply to *respect* it —
checking `targetPoseSample !== null` before calling the detector
adapter, nothing more.

## 7. Detector Contract

```
targetPoseSample.landmarks.nose  → chronosDetectStart({ sample: {atMs, nose}, baselineWindow, config })
targetPoseSample.landmarks.hip,
targetPoseSample.landmarks.nose  → chronosDetectTurn({ sample: {atMs, hip, nose}, recentSamples, previousCandidateAtMs, config })
```

Confirmed exact shapes from `src/chronos-engine/detectors/*.js`
(unchanged, Stage 4B):
- `chronosDetectStart`'s `sample` is `{atMs, nose: {x,y,visibility}}` —
  flat, `nose` at the top level, not nested under `landmarks`.
- `chronosDetectTurn`'s `sample` is `{atMs, hip: {...}, nose: {...}}` —
  same flattening.

Since `targetPoseSample` is a `PoseSample` (`{atMs, hasPose, landmarks:
{hip, nose}}`), the detector adapter's entire job for shape purposes is
a **trivial reshape**: `{atMs: targetPoseSample.atMs, nose:
targetPoseSample.landmarks.nose}` (start) and `{atMs:
targetPoseSample.atMs, hip: targetPoseSample.landmarks.hip, nose:
targetPoseSample.landmarks.nose}` (turn). No data is transformed, only
regrouped.

**Adapter-owned rolling state** (neither detector keeps its own):
- Start: `baselineWindow` — an array of recent samples, appended to on
  every call, per `docs/CHRONOS_ARCHITECTURE.md`'s detector design
  (Stage 4A/4B).
- Turn: `recentSamples` (a short window for time-normalized velocity)
  and `previousCandidateAtMs` (this detector's own last emitted
  candidate, for its local suppression window — confirmed independent
  of Chronos's `MIN_EVENT_GAP_MS`, Stage 4B's own test suite proves
  this explicitly).

**Detector candidates are not authoritative race events.** A non-null
return from `chronosDetectStart`/`chronosDetectTurn` is a **candidate**
— `{atMs, confidence, evidence}` — that must still pass through
`event-adapter.js` and `ChronosEngine.recordEvent()` before it can ever
become part of `session.events[]`. The detector adapter's job ends at
"collect whatever candidate(s) the detectors produced this call" — it
never decides acceptance itself (§17 invariant 3).

### 7.1 `referenceLaneY` source (decided, Stage 4D.7)

`chronosDetectTurn`'s `config.referenceLaneY` has no default and no
legitimate first-frame derivation (Stage 4D.5.1 investigation; the
legacy `laneCenterY`-from-first-frame heuristic in dead pre-Stage-4D.6
code is explicitly rejected as a pattern, not reused). Stage 4D.7
resolves this with **explicit user calibration**, reusing the
already-defined `SwimmerTracking` `TargetSelection.point` concept
(`docs/SWIMMER_TRACKING_ARCHITECTURE.md` §7.2) rather than inventing a
new calibration primitive:

- **Interaction:** the user pauses the loaded race video on a clear
  frame, activates calibration, and clicks once on the swimmer's lane
  reference position in the video. `src/race-pipeline/race-config.js`'s
  `racePipelineMapClickToNormalizedPoint()` converts that click (a CSS
  pixel position over the rendered, possibly letterboxed video) into a
  normalized `{x, y}` point in the same `[0,1]` coordinate space
  MediaPipe landmarks already use — independently re-deriving the exact
  letterbox math Chase's own `syncChaseCanvasToVideo()` already proved,
  never importing it.
- **`referenceLaneY` value:** exactly `calibrationPoint.y` —
  `racePipelineReferenceLaneYFromCalibrationPoint()` in the same file.
  No averaging, no smoothing, no first-frame heuristic of any kind.
- **Reuse of `TargetSelection.point`:** the same click's full `{x, y}`
  point is also threaded through, unchanged, as the `point` field of the
  `TargetSelection` `SwimmerTracking.selectTarget()` is called with at
  the start of analysis (`src/race-pipeline/controller.js`, "CALIBRATION
  POINT" note) — one user interaction serves both purposes. This does
  not change `SwimmerTracking`'s own logic: `trackingSelectTarget()`
  already accepted an optional `point` and only ever stores it on
  `TargetLockState.selection`; passing a real point instead of `null` is
  additive, backward-compatible metadata, not a behavior change.
- **Failure mode:** a click landing outside the actual video content
  (a letterbox bar) or before the video's native dimensions are known
  produces `null`, never a clamped or guessed point — calibration is
  rejected and must be retried, and turn detection stays disabled with a
  stable reason (`TURN_DETECTION_UNAVAILABLE_REASON`,
  `src/race-pipeline/controller.js`).
- **Lifetime:** a calibration belongs to the current page/analysis
  configuration only — it is not persisted to Firebase, `localStorage`,
  or any other store (Stage 4D.7 §10), and is cleared whenever a new
  video is selected (the pixel position almost certainly no longer
  corresponds to the same lane framing). Event/course/pool-length
  selections are **not** cleared on a new video, since those describe
  the race, not the footage.
- **Determinism:** the mapping itself is a pure function of the click
  position and the video's known geometry — fully deterministic given
  the same inputs; the calibration *value* is whatever the user clicked,
  which is inherently a one-time human input, not a re-derivable
  computation.

## 8. Event Contract

```
DetectorCandidate {atMs, confidence, evidence}
        ↓  [event-adapter.js]
TimingEventInput {
  type: "start" | "turn",
  atMs: candidate.atMs,
  distanceMeters: <see §9>,
  source: "detector",
  detector: "start-detector-v1" | "turn-detector-v1",
  confidence: candidate.confidence
}
        ↓
ChronosEngine.recordEvent(session, TimingEventInput)
        ↓
{ ok, reason, session, event }
```

- `type`: `"start"` for a start-detector candidate, `"turn"` for a
  turn-detector candidate (never `"split"` or `"finish"` from this path
  in v1 — those remain manual-only or deferred, §13).
- `atMs`: the candidate's own `atMs`, passed through unchanged.
- `distanceMeters`: **not** carried on the detector candidate itself
  (detectors don't count laps) — computed by the event adapter, per §9.
- `source: "detector"`, `detector: <name>`, `confidence: <candidate's
  own value>` — assigned here, nowhere else.

**Rejection behavior:** `ChronosEngine.recordEvent()` returns `{ok:
false, reason, session}` for a rejected candidate (duplicate start,
out-of-order distance, too-soon-after-previous, etc. — the full,
already-tested rule set in `src/chronos-engine/events.js`). **The event
adapter must trust this result verbatim** — no retry, no override, no
local reinterpretation of "well, it was close enough." **Chronos is the
authoritative event-acceptance layer; nothing in `race-pipeline` second-guesses
it.**

## 9. Distance Contract

**Adapter-owned state:** `confirmedDistanceMeters`, initialized to `0`
when the event adapter's session-scoped state is created (§10).

**Algorithm, per accepted-turn-candidate:**

```
1. candidateDistance = confirmedDistanceMeters + poolLengthMeters   (tentative — not yet persisted)
2. result = ChronosEngine.recordEvent(session, {
     type: "turn", atMs: candidate.atMs, distanceMeters: candidateDistance,
     source: "detector", detector: "turn-detector-v1", confidence: candidate.confidence
   })
3. if result.ok === true:
     confirmedDistanceMeters = candidateDistance   // commit
   else:
     // confirmedDistanceMeters is untouched — the NEXT candidate is
     // still computed against the same, un-advanced base.
```

**This is exactly Decision 2, made concrete.** A rejected candidate
never consumes a "distance slot" — the very next candidate (whenever it
arrives) is computed against the same `confirmedDistanceMeters` as the
rejected one was, not against a value that silently moved on without
Chronos's agreement.

**Deterministic worked example** (25m pool, matching the approved
example exactly):

| Event | Tentative distance submitted | Chronos result | `confirmedDistanceMeters` after |
|---|---|---|---|
| Session created | — | — | `0` |
| `start` recorded | *(not part of this counter — see below)* | accepted | `0` |
| 1st turn candidate | `0 + 25 = 25` | accepted | `25` |
| *(a noisy duplicate candidate, too soon)* | `25 + 25 = 50` | **rejected** (Chronos gap rule) | `25` (unchanged) |
| 2nd turn candidate | `25 + 25 = 50` | accepted | `50` |
| `finish` | *(session's total race distance — see below)* | accepted | `50` |

**`start` is deliberately excluded from this counter.** Per
`docs/CHRONOS_ARCHITECTURE.md` §12/§16, `start` is not a distance-bearing
event at all — its `distanceMeters` defaults to `0` inside Chronos
itself and is never compared against the turn-distance chain. The event
adapter does not need to, and must not, touch `confirmedDistanceMeters`
when submitting a `start` event.

**`finish`'s distance does not come from this counter.** A finish's
distance is the race's own **configured total distance** — already
known from the `RaceSession`'s own `event`/`distanceMeters` fields at
session-creation time (e.g. "Freestyle 100m" → `100`) — not an
increment of `confirmedDistanceMeters` by another pool length, since a
finish does not necessarily land on an exact multiple of pool length in
every race format. This is a deliberate distinction: **turn distance is
adapter-computed and incremental; finish distance is session-configured
and fixed.** Chronos's own rule (finish distance must be non-decreasing
relative to the last distance-bearing event) is satisfied either way, as
long as the configured total is `>= confirmedDistanceMeters` at the
moment finish is recorded — a race whose total distance is inconsistent
with its own turn count is a data-quality concern for a later stage
(§16's "invalid video"/configuration-mismatch category), not something
the event adapter silently corrects.

## 10. Race Session Lifecycle

`race-pipeline` creates and holds **four independent, explicitly-named**
pieces of state per analysis run — never one blended object:

| State | Owner | Created by |
|---|---|---|
| `TargetLockState` (tracking) | `SwimmerTracking`'s own contract; held by `race-pipeline` between calls | `SwimmerTracking.createSession({sessionId})` |
| `RaceSession` (Chronos) | Chronos's own contract; held by `race-pipeline` between calls | `ChronosEngine.createSession({sessionId, poolLengthMeters, course, event, timeSource})` |
| Detector rolling state (`baselineWindow`, `recentSamples`, `previousCandidateAtMs`) | `race-pipeline`, plain data, no contract of its own | Initialized empty at analysis start |
| Event-adapter distance state (`confirmedDistanceMeters`) | `race-pipeline` (§9) | Initialized to `0` at analysis start |

**No duplicate authoritative state.** `race-pipeline` never maintains
its own "is the race started," "what's the current split," or "is the
target locked" flag that could disagree with `session.status`
(Chronos's) or `TargetLockState.status` (tracking's) — it only ever
*reads* those, never shadows them (§17 invariant 4/9).

**Reset/abort behavior:** a reset (new video upload, explicit
"Reset"/"Clear" action) must recreate **all four** pieces of state
together, atomically, alongside bumping the generation token (§4) —
never reset one without the others, since a stale detector window or a
non-zero `confirmedDistanceMeters` paired with a fresh Chronos session
would itself be a form of duplicated/contradictory state. `SwimmerTracking`
has no `abort()` (confirmed, `docs/SWIMMER_TRACKING_ARCHITECTURE.md` §8.2
— the caller simply discards the session object); `race-pipeline`
simply stops holding a reference to the old `TargetLockState` and
creates a new one, the same pattern applied to all four.

### 10.1 Race configuration UI contract (decided, Stage 4D.7)

The `RaceSession` fields `ChronosEngine.createSession()` requires
(`poolLengthMeters`, `course`, `event`) plus the optional
`strokeKey`/`distanceMeters` are collected by a Race page configuration
UI (`index.html`, backed by `src/race-pipeline/race-config.js`) rather
than a devtools-only global — the Stage 4D.6 `window.racePipelineConfig`
console hook no longer exists.

**Single source of truth, no conflicting representations:** the UI
exposes exactly one interactive `event` selection, whose options are
copied verbatim from the existing PB system's own `<select id="event">`
vocabulary in `index.html` (`RACE_EVENT_OPTIONS`,
`src/race-pipeline/race-config.js`) — the same 18 strings
`docs/CHRONOS_ARCHITECTURE.md` §12/§20 already requires `RaceSession.event`
to match for future PB integration (Stage 4D.8). `strokeKey` and
`distanceMeters` are never independently entered — they are always
*derived* from the selected `event` string via the same canonical table
(`racePipelineFindEventOption()`) and merely displayed to the user, so
`event`/`strokeKey`/`distanceMeters` can never disagree with one
another. `course` is similarly a fixed two-option choice
(`RACE_COURSE_OPTIONS`: `"Short Course"`, `"Long Course"`) copied from
the same PB system's `<select id="course">`.

**Pool length:** a fixed two-option choice in meters
(`RACE_POOL_LENGTH_OPTIONS_METERS`: `25`, `50` — the two
internationally standard competition lengths), never free numeric entry.
Selecting a course pre-fills the conventionally-paired pool length as a
**default suggestion only** (Short Course → 25, Long Course → 50,
`racePipelineDefaultPoolLengthMetersForCourse()`) — this pairing is not
enforced as a hard rule anywhere, because no existing architecture
document asserts it, and "short course" denotes 25 **yards** rather than
25 meters in some regions. This is flagged as an open product question
(§20 amendment list), not silently resolved by this document.

## 11. RaceAnalysisReport Boundary

```
Chronos RaceSession
        ↓
chronosBuildReport(session)      — src/chronos-engine/report.js, NOT YET BUILT
        ↓
RaceAnalysisReport
        ↓
UI (via ui-bindings.js)
```

**Report generation belongs inside `src/chronos-engine/report.js`, not
`race-pipeline`.** This is not a new decision — `docs/CHRONOS_ARCHITECTURE.md`
§7/§17 already designed `report.js` (`chronosBuildReport(session) ->
RaceAnalysisReport`) as part of `chronos-engine` itself, reasoning that
report-building is pure `RaceSession → RaceAnalysisReport` data
transformation with no browser/adapter concerns of its own. **Confirmed
via Stage 4D.1's reconnaissance: `report.js` does not exist yet anywhere
in `src/chronos-engine/`** — it is a real, unbuilt prerequisite, already
correctly scheduled as Stage 4D.3 in the approved sequence (§20).

`race-pipeline` must not duplicate report-building logic — its only
role here is to **call** `chronosBuildReport(session)` (once it exists)
and hand the result to `ui-bindings.js`. The report module remains pure:
no DOM, no clock, no video, exactly like every other `chronos-engine`
file.

## 12. PB Comparison Boundary (implemented, Stage 4D.8)

```
RaceAnalysisReport (event, course, finalTimeMs)
        ↓
racePipelineFindExistingPb(event, course)   — src/race-pipeline/pb-adapter.js, READ-ONLY
        ↓
existing PB record | null
        ↓
ChronosEngine.comparePB(report, pb)          — src/chronos-engine/pb-comparison.js, pure
        ↓
PBComparison
        ↓
Race page UI (index.html, renderPbComparison())
```

**Race Analysis may READ existing PB data. It may never write it.** This
section documents what Stage 4D.8 actually built, replacing the earlier
"not yet built" sketch this section previously contained.

**Why `getPB(eventName)` alone is insufficient (confirmed by direct
inspection, Stage 4D.8 Step 1):** it returns only `pb.time` — a bare
string, never the full `{event, course, time, history}` record — and it
matches by `event` alone, **never checking `course`**. A swimmer with
separate Short Course and Long Course PBs for the same event would have
`getPB()` silently return whichever happens to appear first in the
array, regardless of which course was actually raced. `chronosComparePB()`
needs the full record (to run its own event/course compatibility check)
and needs the correct course specifically — `getPB()` cannot supply
either. **`getPB()` itself is untouched; a small, read-only adapter
supplies what it cannot:**

- `src/race-pipeline/pb-adapter.js`'s `racePipelineFindPbRecord(pbs, event, course)`
  (pure, no I/O) prefers an exact `event`+`course` match; if none exists
  but a record for the same event exists under a *different* course, it
  returns that record anyway (never `null`) so `chronosComparePB()`'s own
  existing course-compatibility check produces its accurate
  `"incompatible-course"` result, rather than this adapter silently
  downgrading a real-but-wrong-course PB into "no PB recorded."
- `racePipelineReadStoredPbs()` reads `localStorage.getItem("pbs")`
  directly — the ONE place in that file touching a browser global,
  isolated from the pure matching logic above. This is safe and
  equivalent to reading the live `pbs` array: `pbs` is kept in sync with
  that same localStorage key on every existing mutation, and `pbs`
  itself is never exposed on `window` (a classic-script top-level `let`
  is scoped to that script, unreachable from an ES module) — reading the
  same key directly is the only way an ES module can see this data at
  all without modifying the existing PB code to expose it.
- `racePipelineFindExistingPb(event, course)` composes the two above —
  the one call the Race page UI actually uses.

**Time parsing:** `pb.time` (a free-text string, never validated at
entry by the existing `<input id="time">`) is handed to
`chronosComparePB()` **unchanged** — the adapter does not parse it.
`chronosComparePB()`'s own `parsePbTimeToMs()` (already built, Stage
4D.3, independently tested) already supports every format the existing
PB input produces (`ss.ss` / `mm:ss.ss` / `h:mm:ss.ss`) and is a
strict superset of index.html's own `timeToSeconds()` (which has a
narrower, undocumented `h:mm:ss` limitation, confirmed in
`pb-comparison.js`'s own header note) — reusing `parsePbTimeToMs()`
rather than `timeToSeconds()` is not a new decision, it was already made
when `pb-comparison.js` was built.

**Comparison authority:** `ChronosEngine.comparePB(report, pb)` (already
built, Stage 4D.3) is the SOLE place comparison math happens.
`index.html` never independently computes faster/slower/delta/new-PB —
it only reads `comparable`/`reason`/`result`/`isNewPb`/`formatted`/
`existingPbTimeMs` off the returned `PBComparison` and formats them for
display. An unfinished race (`report.finalTimeMs === null`) is never
treated as comparable — `chronosComparePB()`'s own existing
`"race-not-finished"` check (built before this stage, Stage 4D.3)
already handles this; no new incomplete-race check was added anywhere in
this stage.

**No PB mutation occurs during Race Analysis, anywhere in this boundary.**
`getPB()`/`savePB()`/`deletePB()`/`editPB()` are never called by any
Stage 4D.8 code (grep-verified against `src/race-pipeline/pb-adapter.js`
and the new `index.html` code). No new `localStorage.setItem` call for
the `"pbs"` key exists anywhere in this stage's diff. **"Save as PB" is
explicitly deferred to a future, separately-designed stage** — matching
the decision already recorded in `docs/CHRONOS_ARCHITECTURE.md` §20; this
stage answers only "how does this race compare with the existing PB?",
never "should this race become the new PB?".

## 13. Manual Timing Boundary

**Not implemented in this stage.** Documented for forward reference only,
consistent with `docs/CHRONOS_ARCHITECTURE.md`'s own already-approved
design:

```
UI manual action (Start/Split/Finish button click)
        ↓
race-pipeline (captures the current video timestamp at click time)
        ↓
ChronosEngine.recordEvent(session, {..., source: "manual", atMs: video.currentTime * 1000})
```

**Recorded-video manual timing must still use the video timeline, not
wall-clock time** — a manual click's `atMs` is `video.currentTime *
1000` at the moment of the click, exactly the same timestamp contract
as an automatic/detector event (§4), never `Date.now()`. This is the
deliberate behavior change from the legacy manual timer already
identified and approved in `docs/CHRONOS_ARCHITECTURE.md` §14/§24 item
1 — restated here, not re-decided.

**No automatic finish detector exists, and none is authorized by this
document (confirmed, Stage 4D.7.1 investigation).** `docs/CHRONOS_ARCHITECTURE.md`
§17's detector module list names only `start-detector.js`/
`turn-detector.js`/`stroke-rate-detector.js` — never a finish detector —
and this document's own §16 failure-handling table already states that
whether video-ended should auto-trigger a finish is "a manual-timing-
adjacent question, deferred with §13," not resolved. Stage 4D.6/4D.7's
automatic pipeline implements this deferral literally: video-ended stops
the frame driver and nothing else; `confirmedDistanceMeters` reaching
the session's configured `distanceMeters` also never auto-triggers a
finish (no existing contract authorizes treating a distance match as a
race-end condition, and a turn-vs-finish wall-contact disambiguation
rule would need to be designed first, which no document does). **A race
without an accepted `finish` event remains incomplete —
`ChronosEngine.buildReport()`'s existing, tested behavior already
produces `finalTimeMs: null` for such a session, and the Race page's
report UI displays that state explicitly rather than implying
completion.** The only currently-authorized way to close a race remains
the manual `source: "manual"` path described above, itself not yet
built.

## 14. Browser/UI Boundary

Only `race-pipeline`/browser-adapter code (the frame/timestamp-capture
layer of §2, and `ui-bindings.js`) may directly access:

- the video element and its events (`loadedmetadata`, `ended`,
  `timeupdate`, etc.)
- MediaPipe and `pose.onResults`
- `requestVideoFrameCallback`
- the DOM, including file inputs

`pose-sample-adapter.js`, `detector-adapter.js`, and `event-adapter.js`
themselves should be written as plain functions over plain data (the
same discipline as every pure module in this codebase) — even though
they live inside `race-pipeline` and are *permitted* to know about
browser concepts, keeping their own function bodies free of direct
DOM/video access (receiving already-extracted values as arguments
instead) keeps them independently unit-testable, matching §18's testing
strategy. `SwimmerTracking`, Chronos, and the detectors remain fully
browser-independent, unchanged.

## 15. Legacy Race-Page Replacement Policy

**The current race-page implementation is not a second authoritative
pipeline — it is dead code plus a few disconnected buttons (confirmed
exhaustively in Stage 4D.1 §2/§3).** During Stage 4D.6:

- The dead automatic heuristic (`onRaceResults()`, `startMetrics()`,
  `initRaceAI`/`processRaceFrame` references) must **not** be revived
  or left coexisting alongside the new detectors — it is prior art that
  already fed into the detectors' own design (`docs/CHRONOS_ARCHITECTURE.md`
  §22-23), not a system to run in parallel.
- Old timing math (`video.currentTime - startTime` inline in `split()`/the
  `"ended"` handler) must not coexist with Chronos's own timing — once
  the new pipeline is wired in, Chronos is the sole source of elapsed/split
  times.
- `#splits` must have exactly **one** authoritative writer after 4D.6 —
  today it has two uncoordinated ones (manual `split()` and the dead
  `onRaceResults()`, confirmed in Stage 4D.1 §14); this must become
  `ui-bindings.js` alone, rendering from `RaceAnalysisReport.splits[]`.
- The new pipeline becomes the **sole** automatic race-analysis path.
  Manual controls (Start/Split/Finish becoming Chronos `source:"manual"`
  events) are explicitly **separately scoped** (§13) — Stage 4D.6's job
  is the automatic detector-driven path, not a manual-timing rebuild in
  the same PR.

## 16. Failure Handling

Pipeline-level semantics only — no UI behavior is invented here beyond
what naturally follows from the pure modules' own already-documented
rules:

| Condition | Pipeline semantics |
|---|---|
| Invalid video (fails to load) | Never reaches `pose-sample-adapter.js` at all — gated by the video-layer's own load-error handling, a browser-adapter concern outside this contract's scope |
| Missing pose (`hasPose: false`) | Passed through as a normal, valid `PoseSample` — `SwimmerTracking` already defines this as a `"gap"` outcome (§6); no adapter-side special case |
| Unusable landmarks (`hasPose: true`, hip/nose missing) | Same — passed through with `landmarks.hip`/`landmarks.nose` as `null`; `SwimmerTracking` already treats this identically to a gap (§5, confirmed by the Stage 4C.4 regression test) |
| Target not selected (`UNSELECTED`) | `SwimmerTracking.observe()` returns `ok: false` — the frame is skipped for tracking/detector purposes; no candidate, no event |
| Target lost / degraded (`TARGET_LOST`/`ANALYSIS_DEGRADED`) | `targetPoseSample` is `null` (or `observe()` itself is `ok: false` for `ANALYSIS_DEGRADED`) — nothing proceeds to the detector adapter for that frame; `status` remains available for the UI to reflect (a UI concern, not a pipeline-semantics one) |
| Detector candidate rejected by Chronos | No `TimingEvent` is added; per §9, distance does not advance; the adapter does not retry or reinterpret |
| Chronos event rejected for any other reason | Same as above — `recordEvent()`'s result is trusted verbatim (§8, §17 invariant 6) |
| Video seek | No special-case handling by the adapters themselves (§4); a large backward seek possibly warranting a full reset is an **open question for Stage 4D.6**, not resolved here |
| Stale async MediaPipe result | Discarded via the generation-token check (§4), before a `PoseSample` is ever built |
| Analysis reset | All four state objects (§10) recreated together, generation bumped |
| Video ended | The natural point to stop the frame driver (mirrors Chase's `"ended"` → `finishChaseAnalysis()` pattern); whether this should auto-trigger a Chronos `finish` event is a manual-timing-adjacent question, deferred with §13 |

## 17. Integration Safety Invariants

1. **Chronos owns the authoritative race timeline.** No other layer's
   idea of "what happened" is trusted over `session.events[]`.
2. **`SwimmerTracking` owns target identity state.** No other layer
   decides whether an observation belongs to the target.
3. **Detectors produce candidates, not authoritative events.** A
   non-null detector return is a proposal, never a fact until Chronos
   accepts it.
4. **`race-pipeline` translates but does not redefine pure-module
   semantics.** Every adapter is a reshape/pass-through; none of them
   re-implements a rule that already exists in `SwimmerTracking` or
   Chronos.
5. **Only confirmed target poses reach the detectors** (§6).
6. **Only Chronos-accepted events affect authoritative event history**
   (§8).
7. **Rejected turn candidates never advance distance** (§9, Decision 2).
8. **PB storage is never automatically mutated** (§12).
9. **UI never performs authoritative timing math** — `ui-bindings.js` is
   presentation-only (§3).
10. **Chase AI remains completely isolated.** No file under
    `src/chase-engine/*` is imported, modified, or depended upon by
    `race-pipeline`, `SwimmerTracking`, or Chronos, at any point in this
    architecture.

## 18. Testing Strategy

| Module | Test approach |
|---|---|
| `pose-sample-adapter.js` | Deterministic unit tests, synthetic MediaPipe-shaped fixtures (fixed landmark arrays, no real video/MediaPipe) — mirrors the fixture-replay pattern already used throughout `test/chronos-engine/` and `test/swimmer-tracking/`. Must cover: both-hips-valid, one-hip-valid (both sides), neither-hip-valid, missing nose, `hasPose:false`. |
| `detector-adapter.js` | Unit tests with synthetic `targetPoseSample` sequences and hand-verified expected detector-input shapes; rolling-state accumulation tested the same way Stage 4B tested the detectors' own rolling windows. |
| `event-adapter.js` | Unit tests directly exercising the distance-bookkeeping algorithm (§9) against a **real** (or a minimal fixture) Chronos session — including the "rejected candidate does not advance distance" case as a first-class, explicitly named test, given it is the specific rule Decision 2 exists to enforce. |
| `report.js` / `pb-comparison.js` | Unit tests, `chronos-engine`'s own responsibility, following the exact same pattern as its existing `session.js`/`events.js` tests (`test/chronos-engine/`). |
| `ui-bindings.js` | Unit tests for pure formatting functions (given a `RaceAnalysisReport`, produce the expected display strings) plus lightweight DOM-assertion tests; no timing logic to test here by design (§3). |
| Race-page integration | Playwright E2E, reserved for genuine browser/video/DOM behavior (file upload, `requestVideoFrameCallback` wiring, real button clicks) — mirrors `test/e2e/frame-timing-lifecycle.spec.js`'s pattern of a synthetic, fully-scripted stand-in rather than real video fixtures, consistent with this repository's established preference (`docs/DEVELOPMENT_WORKFLOW.md`). |

**Prefer deterministic unit tests wherever possible** — only the
frame-driver wiring and actual DOM writes need a real browser.

## 19. Deferred Capabilities

Carried forward unchanged from `docs/SWIMMER_TRACKING_ARCHITECTURE.md`
§17 and §12.4, and `docs/CHRONOS_ARCHITECTURE.md`:

- Automatic multi-person target selection.
- Full re-identification / appearance-based identity.
- Steady-state single-pose-source identity disambiguation (the HIGH
  finding from Stage 4C.4's review — still an accepted v1 limitation,
  not solved by anything in this document).
- Camera-pan compensation.
- Automatic "Save as PB" (§12 — explicit user action only, whenever it
  is eventually built).
- Advanced manual timing workflow beyond the simple `source:"manual"`
  event pattern sketched in §13.

None of these are designed into v1 by anything in this document.

## 20. Stage Sequence

```
4D.2  Architecture contract (this document)                          — done
  ↓
4D.3  src/chronos-engine/report.js AND src/chronos-engine/pb-comparison.js — done
  ↓
4D.4  src/race-pipeline/pose-sample-adapter.js                        — done
  ↓
4D.5  src/race-pipeline/detector-adapter.js + src/race-pipeline/event-adapter.js — done
  ↓
4D.6  Race-page integration (index.html) — first stage touching the live site;
      removes dead legacy code per §15, wires the real frame driver     — done
  ↓
4D.7  Race configuration UI, lane calibration (§7.1, §10.1),
      and a basic report/status UI                                     — done
  ↓
4D.8  PB comparison wired into the UI (read-only, §12)                — done
```

Manual timing (§13) remains separately scoped, after 4D.8 — not yet
started. "Save as PB" is a distinct, separately-scoped future stage,
not part of 4D.8 (§12). Automatic
finish detection is not scheduled anywhere in this sequence — §13's own
amendment states why, and manual timing is the sanctioned way to close
that gap once built.

Each stage through 4D.5 was pure-module/adapter work with zero live-site
impact — `index.html` was untouched until 4D.6, matching this
workstream's established pattern from every prior stage.

**Open product questions carried out of Stage 4D.7 (not resolved by
this document, for explicit human decision):**
- Whether Short Course/Long Course should ever *enforce* a specific
  pool length rather than merely default-suggest one (§10.1) — regional
  yards-vs-meters short-course conventions make this ambiguous from the
  codebase alone.
- The exact calibration UI interaction pattern (a plain click, as built,
  vs. a more guided marker/crosshair tool) was chosen as the simplest
  option satisfying §7.1's constraints, not because richer alternatives
  were ruled out architecturally.
- Whether `distanceMeters` should ever be free-entry (e.g. for
  non-standard race formats) rather than always derived from the fixed
  `event` vocabulary — the current 18-entry table cannot represent a
  race outside it.
