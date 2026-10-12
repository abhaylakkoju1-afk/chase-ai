# Swimmer Tracking Architecture

This document establishes the authoritative v1 architecture and contracts
for the swimmer-tracking/target-locking subsystem. It is the sibling of
`docs/CHRONOS_ARCHITECTURE.md` (which covers the Chronos timing engine)
and `docs/ARCHITECTURE.md` (Chase AI) — scoped **only** to swimmer
identity/tracking. It does not authorize any change to Chronos, the
detectors, Chase AI, Firebase/auth, or the PB system.

Status: **Stage 4C.1 — contracts and documentation only.** No
`src/swimmer-tracking/` implementation exists yet. No tracking tests
exist yet. This document defines what Stage 4C.2+ will build against; it
does not itself change any application behavior.

---

## 1. Purpose

Real race videos frequently contain multiple swimmers in the same frame.
Race Analysis needs to compute the race of exactly **one** selected
swimmer. This subsystem's job is to determine, for every incoming pose
observation, whether it plausibly belongs to that one selected swimmer —
and to refuse to guess when it cannot tell. It sits between raw pose
output and the Chronos start/turn detectors (Stage 4B), supplying them
with a stream that contains only observations already confirmed to
belong to the locked target.

**Incorrect analysis of the wrong swimmer is worse than refusing to
produce an analysis.** Every design choice in this document follows from
that single priority — the subsystem is deliberately conservative.

## 2. Problem Definition

Four distinct questions get asked at four distinct points in the
pipeline, and this document exists because conflating them is exactly
how a wrong-swimmer analysis would happen silently:

| Question | Answered by |
|---|---|
| "Is there a pose in this frame?" | Pose detection (upstream, already exists — MediaPipe Pose) |
| "Is this pose a plausible continuation of the previously locked swimmer?" | **Tracking** (this document) |
| "Which swimmer did the user choose?" | **Target selection** (this document) |
| "Do we have enough temporal evidence to trust this identity?" | **Target locking** (this document) |
| "What are the authoritative race events and elapsed times for this already-selected participant?" | Chronos (already built, Stages 1–3) |

Tracking, selection, and locking are three related but distinct
responsibilities inside one subsystem; timing is a completely separate
subsystem downstream of it. This document is careful not to let any of
the first three bleed into each other, and structurally prevents any of
them from bleeding into Chronos.

## 3. Current Repository Constraints (confirmed facts)

Carried forward from the Stage 4A.1 reconnaissance, re-confirmed here as
the fixed ground truth this design must work within:

- The application uses `@mediapipe/pose@0.5.1675469404` — the legacy
  MediaPipe **Solutions** Pose API, not MediaPipe Tasks' `PoseLandmarker`
  (`index.html:7`, `index.html:7652-7664`). This API returns **at most
  one** `poseLandmarks` array per frame, selected by an internal,
  undocumented, uncontrollable heuristic when multiple people are
  visible.
- There is currently **no** multi-person pose implementation, bounding-
  box infrastructure, tracking ID, person ID, appearance embedding,
  multi-object tracker, explicit target-selection system, or swimmer
  identity persistence system anywhere in this repository. Exhaustive
  repo-wide search confirmed zero production-code matches for
  `multiPerson`, `numPoses`, `PoseLandmarker`, `BoundingBox`/`bbox`,
  `trackId`, `personId`, `ObjectDetector`, or `detectForVideo`, and no
  TensorFlow.js/COCO-SSD/YOLO/OpenCV.js/face-api/blazeface dependency
  anywhere.
- One directly relevant precedent: Chase AI's own `TrackedSequence`
  contract explicitly and deliberately excludes tracking identity from
  its v1 shape — `test/tracked-sequence.test.js:340`
  (`assert.strictEqual(sequence.trackId, undefined)`) and
  `src/chase-engine/tracked-sequence.js`'s header comment both state
  that tracking identity is "DERIVED data... and belongs to a separate,
  later layer... never inside it." This is independent confirmation,
  from the other active workstream, of the same layering principle this
  document formalizes for Chronos.
- A migration to MediaPipe Tasks, or any other multi-person detector, is
  a **separate**, larger architectural decision this document does not
  make and this stage does not authorize.

## 4. Architectural Boundary

```
VIDEO
  ↓
PERSON / POSE DETECTION        (existing — MediaPipe Pose, single-person, unchanged)
  ↓
SWIMMER TRACKING / IDENTITY    (NEW — this document, src/swimmer-tracking/)
  ↓
TARGET SELECTION + LOCK        (same module)
  ↓
TARGET POSE STREAM             (this module's output — see §13)
  ↓
START / TURN DETECTORS          (Stage 4B, UNCHANGED — still just consumes samples)
  ↓
CHRONOS                          (Stages 1-3, UNCHANGED — still swimmer-agnostic)
  ↓
RACE ANALYSIS                    (future stage)
  ↓
PB COMPARISON                    (future stage)
  ↓
UI                                (future stage)
```

**Chronos remains completely swimmer-agnostic.** It has no field, no
parameter, and no code path that references swimmer identity, tracking,
or selection — nothing in `src/chronos-engine/session.js` or `events.js`
changes as a result of this document.

**Detectors remain swimmer-identity-agnostic.** `chronosDetectStart()`
and `chronosDetectTurn()` (Stage 4B) already accept plain
`{atMs, landmarks}`-shaped samples with no notion of whose pose it is —
this design was already correctly decoupled before this document existed,
and nothing about it needs to change for tracking to sit in front of it.

### Module boundary: `src/swimmer-tracking/`, a top-level sibling

**Recommendation confirmed: `src/swimmer-tracking/`, sibling to
`src/chronos-engine/` and `src/chase-engine/` — not nested inside
`chronos-engine` at all** (neither `src/chronos-engine/tracking/` nor
`src/chronos-engine/target-tracking/`).

No repository evidence was found that contradicts this. The reasoning:
`chronos-engine` has consistently meant, across every prior stage of this
workstream, "the timing state machine and the detectors that directly
feed it" — nothing about identity, pose acquisition, or video. Tracking
produces no `TimingEvent`, knows nothing about races/splits/starts, and
sits one full layer *upstream* of the detectors (it feeds detectors, the
same way detectors feed Chronos — a supplier of a supplier, not a
sibling of the detectors themselves). Nesting it under `chronos-engine`
would blur a boundary this workstream has been careful and consistent
about since Stage 1.

## 5. V1 Strategy

**Recommended, and re-confirmed here: user-selected target with
deterministic tracking/lock, not fully automatic swimmer selection.**

```
USER SELECTED TARGET
        ↓
DETERMINISTIC TRACKING
        ↓
TARGET LOCK
        ↓
TARGET POSE STREAM
```

Why fully automatic selection is not the v1 path: it would require, on
top of everything below, (a) an actual multi-person detection capability
this pipeline does not have (§3), (b) a real multi-object tracker
maintaining several simultaneous identities, and (c) a selection
heuristic guessing which tracked person the user meant. Each of those
three is independently unvalidated, there is no evaluation harness or
labeled multi-swimmer dataset anywhere in this repository to validate
any of them against (consistent with Chase's own `docs/DECISIONS.md` D7
precedent — no technique model ships without an evaluation dataset — the
same discipline applies here), and stacking three unvalidated systems
compounds risk rather than dividing it. User-selection sidesteps (a)–(c)
entirely: it needs no new detection capability, no multi-object tracker,
and no selection heuristic, because the user *is* the selection
heuristic. This is the only v1 path buildable without a separate,
explicitly-approved decision to add new detection capability (§17).

## 6. Responsibilities

| Responsibility | Owner | Explicitly NOT owned by tracking |
|---|---|---|
| Producing a pose per frame | Pose detection (existing) | — |
| Deciding if a pose continues the locked target | Tracking | Deciding *which* swimmer to select (that's the user, via selection) |
| Recording the user's initial choice | Target selection | Rendering any UI for that choice |
| Deciding when enough evidence exists to trust an identity | Target locking | Timing math of any kind |
| Turning a confirmed pose stream into candidate timing events | Detectors (Stage 4B, unchanged) | Identity of any kind |
| Authoritative race timeline | Chronos (Stages 1-3, unchanged) | Identity, pose, video, DOM |

Tracking must never: access the DOM, mouse/canvas/video-element events,
`Date.now()`/`performance.now()`, `localStorage`, Firebase, MediaPipe
directly, or a Chronos session. Every value it needs — including every
timestamp — is supplied by the caller, exactly the same discipline
`docs/CHRONOS_ARCHITECTURE.md` §14 already established for Chronos
itself.

## 7. Data Contracts

All contracts below are plain, JSON-serializable data — no classes, no
DOM/browser object references, no methods. This is a deliberate,
consistent choice with Chronos's own contracts (§5 of this document
mirrors the reasoning already validated there).

### 7.1 `PoseSample` (input, from the pose/video layer)

```js
PoseSample = {
  atMs: number,          // caller-supplied — this layer never reads a clock itself
  hasPose: boolean,       // whether the upstream pose engine found ANY pose this frame
  landmarks: { [name: string]: { x: number, y: number, visibility: number } } | null
                           // null when hasPose is false; a small NAMED subset
                           // (e.g. nose, hip), not the full 33-point MediaPipe
                           // array — this decouples the contract from
                           // MediaPipe's specific topology, so a future
                           // pose-engine change touches only the adapter
                           // that builds this shape, not tracking itself
}
```

This is deliberately **not** a blind copy of the example in the Stage
4C.1 brief — landmarks are a named map, not a flat `landmarks` array,
because tracking and the downstream detectors only ever need specific,
named points, and a named map keeps both consumers decoupled from
MediaPipe's raw index numbering.

### 7.2 `TargetSelection` (the user's initial choice — UI-independent)

```js
TargetSelection = {
  atMs: number,                          // required: which pose-stream moment the user is confirming as the target
  point: { x: number, y: number } | null  // optional: a normalized image-space hint for where the user indicated
}
```

**Why `point` is optional rather than required, unlike the brief's
example:** because the current single-pose pipeline (§3) returns at most
one candidate pose regardless of where the user clicks, `atMs` alone is
already sufficient to identify the moment/pose being confirmed in v1 —
there is nothing to disambiguate *among*. `point` is retained as an
optional sanity cross-check (does the returned pose's position roughly
agree with where the user pointed?) and as a forward-compatible seam:
once a true multi-candidate pose source exists, `point` becomes load-
bearing for disambiguating among several simultaneous candidates without
this contract needing to change shape.

A bounding region, a direct landmark reference, or a "representative
body center" were all considered per the brief's prompt and rejected for
v1: a region/landmark reference implies there is something to select
*among* (there isn't, per §3), and would be premature structure for a
capability that doesn't exist yet.

### 7.3 `TrackingObservation` (internal — one evaluated sample)

```js
TrackingObservation = {
  atMs: number,
  hasPose: boolean,
  representativePosition: { x: number, y: number } | null,  // tracking's own derived stable point (see §11)
  visibility: number | null,
  projectedPosition: { x: number, y: number } | null,        // the target's expected position at atMs, per its established trajectory
  continuityError: number | null,                              // distance between representativePosition and projectedPosition
  velocity: { x: number, y: number, magnitudePerSecond: number } | null,
  outcome: "confirmed" | "ambiguous" | "gap"                   // see §11-§12 for exact meaning of each
}
```

This is internal, audit-oriented data (analogous to a `TimingEvent`,
but never itself a `TimingEvent` and never seen by Chronos) — it exists
so `TargetLockState.observationHistory` (below) can explain *why* the
tracker is in its current state, and so a future data-quality report
(§14) has something concrete to summarize.

### 7.4 `TargetLockState` (the tracking layer's output — plain data)

```js
TargetLockState = {
  sessionId: string,                    // caller-supplied, same philosophy as Chronos's RaceSession.sessionId (docs/CHRONOS_ARCHITECTURE.md §5)
  status: "UNSELECTED" | "TARGET_SELECTED" | "TARGET_LOCKING" | "TARGET_LOCKED" | "TARGET_LOST" | "ANALYSIS_DEGRADED",
  selection: TargetSelection | null,
  lockEstablishedAtMs: number | null,    // when TARGET_LOCKED was first reached
  lastConfirmedAtMs: number | null,
  lastConfirmedPosition: { x: number, y: number } | null,
  lastConfirmedVelocity: { x: number, y: number, magnitudePerSecond: number } | null,
  observationHistory: TrackingObservation[],   // append-only, mirrors Chronos's events[] design
  degradedReason: string | null          // populated only when status === "ANALYSIS_DEGRADED"; a stable reason string, mirroring Chronos's reject-reason convention
}
```

## 8. State Machine

The brief's proposed model was evaluated, **not accepted as-is** — one
change was made, explained below.

### 8.1 Evaluation of the proposed model

The brief proposes `TARGET_REACQUIRED` as a distinct status between
`TARGET_LOST` and `TARGET_LOCKED`. **Recommendation: do not make this a
persisted `status` value.** Reasoning: `status` should describe the
tracker's *current* condition, and "reacquired" describes *how a past
transition happened*, not a condition the tracker rests in — the moment
reacquisition evidence is satisfied, the tracker's actual condition is
indistinguishable from any other `TARGET_LOCKED` state. Chronos already
established the right pattern for this distinction: a `TimingEvent`'s
`type`/`source` describe how something happened without needing a
dedicated session `status` for it. Here, "this lock was established via
reacquisition rather than initial locking" is recorded as an
`outcome`/tag on the relevant `TrackingObservation` entry in
`observationHistory`, not as a seventh status value. This keeps the
status vocabulary the same size as Chronos's own (Chronos has 5
statuses; tracking has 6, one more only because `ANALYSIS_DEGRADED` has
no Chronos equivalent) and avoids one more state needing its own
transition-legality rules for no behavioral benefit.

A second refinement beyond the brief: the brief's diagram does not show
what happens when `TARGET_LOCKING`'s confirmation window fails
(insufficient/inconsistent evidence, or the window simply times out).
**Recommendation: `TARGET_LOCKING → UNSELECTED`** — a failed lock attempt
returns to the starting point so the caller can retry selection, rather
than being silently treated as `ANALYSIS_DEGRADED` (which should mean "a
lock was believed trustworthy and no longer is," not "a lock was never
established in the first place").

### 8.2 Final state model

```
UNSELECTED
    │ selectTarget()
    ▼
TARGET_SELECTED
    │ observe() — first observation
    ▼
TARGET_LOCKING ──(confirmation window fails/times out)──▶ UNSELECTED
    │ (confirmation window satisfied — §10)
    ▼
TARGET_LOCKED ──(loss condition — §12)──▶ TARGET_LOST
    │                                          │
    │ (sustained ambiguity — §12)              │ (reacquisition evidence satisfied — §12)
    ▼                                          ▼
ANALYSIS_DEGRADED ◀──(window/attempts exhausted, or insufficient evidence)── TARGET_LOST
```

`ANALYSIS_DEGRADED` is terminal for the session — no automatic transition
leads back out of it. A genuinely fresh attempt is a new
`UNSELECTED → ...` cycle (a new session), not a recovery path out of an
existing one, mirroring Chronos's own terminal-state philosophy
(`docs/CHRONOS_ARCHITECTURE.md` §9: "no automatic transition leads back
out"). `UNSELECTED → ABORTED`-style cancellation is deliberately not
modeled here, same reasoning as the equivalent decision already made and
documented for Chronos's own state machine: it is a UI-layer concern
(the caller simply discards the session object), not a tracking-state
concern.

### 8.3 What data each state permits, and target-pose-stream output per state

| Status | Observations accepted | Target pose stream output (§13) |
|---|---|---|
| `UNSELECTED` | none (no selection yet) | nothing |
| `TARGET_SELECTED` | the confirming observation that moves to `TARGET_LOCKING` | nothing |
| `TARGET_LOCKING` | confirmation-window observations (§10) | nothing — not yet trusted |
| `TARGET_LOCKED` | steady-state observations (§11) | **the confirmed sample, every accepted call** |
| `TARGET_LOST` | reacquisition-candidate observations (§12) | nothing |
| `ANALYSIS_DEGRADED` | none (terminal) | nothing |

## 9. Target Selection

`selectTarget(session, selection: TargetSelection)` is the only entry
point for the user's choice, and it knows nothing about DOM, mouse
events, canvas, buttons, or video elements — the caller (a future UI
layer, not built in this stage) is entirely responsible for translating
a click/drag into a `TargetSelection` value. See §7.2 for exactly why the
contract is `{atMs, point?}` and not richer.

`selectTarget()` is legal only from `UNSELECTED`, and transitions the
session to `TARGET_SELECTED`, recording the `selection` on
`TargetLockState.selection`. It does not itself evaluate any pose data —
that begins with the first `observe()` call afterward.

## 10. Target Locking

The question this section answers: **how many observations, over how
much time, before a selected target becomes trusted?**

All values below are **named, overridable, provisional configuration —
not validated thresholds**, exactly the same posture already established
for every threshold in `docs/CHRONOS_ARCHITECTURE.md` and the Stage 4B
detectors. Defaults are chosen for internal consistency with the
already-shipped detectors (§7 of this document deliberately reuses
`minVisibility: 0.5`, matching `start-detector.js`/`turn-detector.js`'s
own default, rather than inventing a different number for no reason).

| Config | Meaning | Provisional default |
|---|---|---|
| `selectionConfirmationSamples` | Minimum consecutive qualifying observations required during `TARGET_LOCKING` | 5 (matches `start-detector.js`'s `minBaselineSamples`) |
| `lockingWindowMs` | Maximum elapsed time allowed for confirmation before the attempt fails (`TARGET_LOCKING → UNSELECTED`) | 3000 |
| `minVisibility` | Minimum landmark visibility for any observation to count toward locking | 0.5 |
| `maxLockingPositionError` | Maximum allowed drift (normalized units) between consecutive locking-phase observations' representative positions | 0.05 |
| `maxVelocityDeltaPerSecond` | Maximum allowed change in implied velocity between consecutive confirmed observations, once a velocity estimate exists | (named, no default proposed — needs real fixture data before a placeholder is meaningful; flagged, not invented) |

**Selection confirmation:** the sample at `selection.atMs` (or the first
observation on/after it) is the seed; it does not itself confirm
anything, but starts the running representative-position average the
same way `start-detector.js`'s `baselineWindow` does (§7.1 of
`docs/CHRONOS_ARCHITECTURE.md`'s detector design — reused deliberately
for consistency, not reinvented).

**Ambiguity, defined precisely:** an observation is **ambiguous** when a
pose is present but visibility is below `minVisibility`, OR — once a
provisional trajectory/reference exists — its representative position
deviates from that reference beyond the phase-appropriate error bound.
An observation with `hasPose: false` is a **gap**, a distinct outcome
from *ambiguous* — a gap carries no signal at all (neither confirming
nor contradicting), whereas an ambiguous observation carries a signal
that fails to clear the bar. Both count toward the same grace/exhaustion
budget (§12), but are recorded with different `outcome` tags in
`TrackingObservation` (§7.3) since they mean different things for future
debugging and data-quality reporting (§14).

## 11. Identity Continuity

**The tracker must not use "nearest current pose to last position."**
That rule fails exactly in the case that matters most: another swimmer
occupying the target's *previous* position after the real target has
moved on (§12, scenario 8).

Instead:

```
target's established trajectory (lastConfirmedPosition + lastConfirmedVelocity)
        ↓
project expected position at the new observation's atMs
        ↓
compare the new observation's representativePosition to the projection
        ↓
continuityError = distance(representativePosition, projectedPosition)
        ↓
accept if continuityError <= the phase-appropriate maximum, else ambiguous/reject
```

- `representativePosition`: tracking's own derived, stable point for a
  sample — not necessarily a single raw landmark. A reasonable v1
  candidate (to be finalized in Stage 4C.2, not this document) is a
  centroid of the same landmarks the detectors already use (hip + nose),
  since a centroid is more robust to any single landmark's transient
  occlusion/noise than trusting one point alone.
- `projectedPosition = lastConfirmedPosition + lastConfirmedVelocity × elapsedSecondsSinceLastConfirmed` —
  a simple linear projection, not a Kalman filter or any higher-order
  model; deliberately the simplest thing that satisfies the actual
  requirement (distinguish "plausible continuation" from "implausible
  jump"), consistent with this repository's repeated "no premature
  abstraction" convention.
- `continuityError` is a plain Euclidean distance in normalized x/y
  space — not an x-only metric, even though swimming motion is
  predominantly horizontal, so the formula does not silently encode a
  camera-orientation assumption it doesn't need to.

This is defined precisely enough to become deterministic code in Stage
4C.2; no implementation is written here.

## 12. Identity Loss & Reacquisition

### 12.1 Critical scenarios, addressed explicitly

| # | Scenario | Required behavior |
|---|---|---|
| 1 | Two swimmers in parallel | Target stays `TARGET_LOCKED`; continuity math never needs to know a second swimmer exists |
| 2 | Three swimmers | Same as #1 — continuity is always evaluated against the target's *own* projected position only, never an n-way comparison against other trajectories, so adding more swimmers changes nothing structurally |
| 3 | Non-target reaches wall first | No target turn event — the non-target's samples never enter the target pose stream (§13) in the first place, so there is nothing to filter after the fact |
| 4 | Target reaches wall first | Target's confirmed samples flow into the detector layer exactly as normal |
| 5 | Swimmers overlap | No guessing. Ambiguous/low-visibility observations accumulate against the grace budget; sustained overlap routes to `TARGET_LOST` or `ANALYSIS_DEGRADED` depending on duration (§12.2) |
| 6 | Target temporarily disappears | A bounded grace period (§12.2) tolerates a gap with **no** status change — identity is never switched over a brief absence |
| 7 | Target leaves frame | Eventually becomes `TARGET_LOST` once the grace period is exceeded — same mechanism as #6, just a longer gap |
| 8 | Another swimmer occupies target's previous location | Rejected: compared against the target's **projected** current position (§11), not the last-known one — this is the scenario the whole projection design exists to prevent |
| 9 | Target changes direction at a turn | Expected behavior, not identity loss — continuity math bounds implausible *magnitude*/jump, never velocity *direction* change, since a turn is a normal, anticipated reversal |
| 10 | Camera pans | **Not solvable with the current single-pose pipeline** — there is no second reference point to distinguish "the swimmer moved" from "the camera moved." This is an accepted, documented v1 limitation, not attempted to be fixed. A pan may cause a false `TARGET_LOST`, or in the worst case an undetected false continuity match; no camera-motion compensation is proposed |
| 11 | Ambiguous reacquisition | Never silently switch — see §12.3 |

### 12.2 Loss conditions

`TARGET_LOCKED → TARGET_LOST` when a gap or run of ambiguous
observations exceeds a named `lossGraceMs`/`lossGraceObservations`
budget (both provisional, no default proposed here — pending Stage
4C.2/real-fixture tuning, same as `maxVelocityDeltaPerSecond` in §10).

`TARGET_LOCKED → ANALYSIS_DEGRADED` directly (skipping `TARGET_LOST`)
when ambiguity is *sustained* rather than a clean gap — e.g., poses
keep appearing but are repeatedly flagged ambiguous (the overlap
scenario, #5) — since this is functionally different from "the target
vanished" and its own named budget should govern it (also provisional,
not defaulted here).

### 12.3 Reacquisition rules

```
TARGET_LOST
      ↓ a candidate observation reappears
      ↓
  is elapsed time since loss <= maxReacquisitionWindowMs?          — no → stay TARGET_LOST (or degrade if attempts exhausted)
      ↓ yes
  is continuityError, against the position PROJECTED across the     — no → stay TARGET_LOST
  whole gap, <= maxReacquisitionPositionError?
      ↓ yes
  is visibility >= minVisibility?                                   — no → stay TARGET_LOST
      ↓ yes
  TARGET_LOCKED (tagged "reacquired" in observationHistory — §8.1)
```

Reacquisition is **never** based on "nearest pose," "same x," "same y,"
or appearance similarity (appearance embeddings are explicitly out of
scope for this entire subsystem — no supporting infrastructure exists,
§3). It requires the same kind of evidence steady-state continuity
requires — projected-position agreement plus visibility — just evaluated
across a longer, explicitly bounded gap. If the window or attempt budget
is exhausted, or evidence is insufficient at any point:

```
TARGET_LOST → ANALYSIS_DEGRADED
```

No silent identity switch is possible by construction: every path either
satisfies the same projected-position test that steady-state tracking
uses, or the session moves to a state (`TARGET_LOST`/`ANALYSIS_DEGRADED`)
whose target-pose-stream output is nothing (§8.3, §13) — there is no
third path where an unverified pose reaches the detectors. **This claim
is scoped to the loss/reacquisition paths described in §12.1–§12.3 — see
§12.4 immediately below for the one case it does not cover.**

### 12.4 V1 identity limitation — steady-state single-pose-source contamination

§12.1–§12.3 describe how identity is protected across a temporary loss
and its bounded reacquisition, using projected-position continuity as
the evidence. That same continuity check is also the *only* identity
signal this v1 design has anywhere, at any stage — including ordinary
observations while already `TARGET_LOCKED` (§11) and while still
establishing a lock (§10).

This has one honest, currently-unaddressed consequence, distinct from
loss/reacquisition: **while a session remains continuously
`TARGET_LOCKED` (never dropping to `TARGET_LOST` at all), if the
upstream single-pose source (§3) hands the tracker a *different*
swimmer's landmarks for one frame, and that swimmer's position happens
to fall within `maxSteadyStatePositionError` of the target's own
projected position, the tracker has no way to tell the two apart.**
Position-only continuity cannot distinguish "the target kept moving
normally" from "a different, spatially-coincident swimmer was handed to
the tracker instead" — both produce an identical, acceptable
`continuityError`. The same narrower version of this applies while
still `TARGET_LOCKING` (§10), via `maxLockingPositionError`.

This is not a bug and not a deviation from §10–§12.3 — those rules are
followed exactly as written in every case. It is a **limit of what
position-only continuity can ever prove**, inherent to the v1 approach
chosen in §5, not something more careful implementation could close.
`session.status` gives no signal when this happens — status remains
`TARGET_LOCKED` throughout, since nothing about the observation is
otherwise distinguishable from a legitimate one.

**This means §1's stated invariant — "the system must never silently
switch from the selected swimmer to another swimmer" — is, in v1,
precise only with respect to the identity signal actually available to
it: position and velocity plausibility. It is not, and cannot yet be, a
guarantee against a spatially-coincident different swimmer during
ordinary steady-state tracking. The tracker must not be read as
claiming a stronger identity guarantee than its available signal
supports, and this document does not promise one for this specific
case.**

Closing this gap — via appearance embeddings, re-identification, a
multi-person detector, or any other technique — is explicitly deferred
(§17): it requires new detection/tracking capability, an evaluation
harness, and labeled multi-swimmer data, none of which exist today
(§3). No such technique is proposed or approximated here. Camera-pan
compensation (§12.1 #10) remains a separate, already-documented v1
limitation with the same not-attempted, not-approximated posture.

## 13. Timing Integrity Invariant

**This is the most important contract in the entire subsystem.** The
tracking layer's `observe()` call is the *only* place a `PoseSample`
either becomes part of the target pose stream or does not:

```
CONFIRMED TARGET POSE  →  emitted as the call's targetPoseSample
UNKNOWN / AMBIGUOUS POSE  →  targetPoseSample is null — never reaches a detector
```

During `TARGET_LOST` and `ANALYSIS_DEGRADED`, `observe()` always returns
`targetPoseSample: null` — structurally, not by convention. There is no
"emit anyway, marked low-confidence" path in this design (unlike
detector candidates, which *do* carry confidence forward — see
`docs/CHRONOS_ARCHITECTURE.md` §15 — tracking's output is binary:
confirmed-belongs-to-target, or nothing). This asymmetry is deliberate:
a detector candidate with low confidence is still evidence about a known
subject; an unconfirmed pose during `TARGET_LOST` is not even known to
be evidence *about the target* at all, so there is nothing honest to
attach a confidence number to.

This is what makes the earlier worked example (non-target reaches the
wall first, §12.1 scenario #3) automatic rather than something a future
glue layer has to remember to implement: the non-target's samples are
never confirmed, so `targetPoseSample` is `null` for every one of them,
so a detector never runs on them, so Chronos never sees them.

## 14. Data Quality / Future Reporting

`RaceAnalysisReport` (`docs/CHRONOS_ARCHITECTURE.md` §7) is **not**
modified in this stage. Documented here only as a known future need:
once tracking exists, a completed analysis will need to summarize, from
`TargetLockState.observationHistory`, things like lock gaps, lost-target
intervals, degraded intervals, reacquisition events, and a confidence/
visibility history over the race — most naturally as an additive
`lockQuality`-shaped field alongside the existing `dataQuality` field.
The exact shape is deferred until `src/swimmer-tracking/`'s real output
exists to shape it around — inventing the field now would risk exactly
the kind of premature contract this repository has consistently avoided.

## 15. Deterministic Test Strategy (design only — no tests written this stage)

Because the current pipeline produces only one pose per frame (§3),
"multiple swimmers" fixtures are built the same way Stage 4A.1 designed
them for detectors: independently-authored trajectories, spliced into a
single one-pose-per-frame stream that simulates what the underlying
engine's opaque internal selection could hand the tracker — including,
deliberately, simulated identity switches.

| # | Scenario | Expected behavior asserted |
|---|---|---|
| 1 | Two swimmers, same direction | Lock stays on the target's own trajectory throughout |
| 2 | Three swimmers | No behavior change vs. #1 — confirms no accidental n-way comparison crept in |
| 3 | Correct target selection | `UNSELECTED → TARGET_SELECTED → TARGET_LOCKING` from a `TargetSelection` matching the target's early samples |
| 4 | Target locking | `TARGET_LOCKING → TARGET_LOCKED` after `selectionConfirmationSamples` consistent observations |
| 5 | Non-target wall contact | Target pose stream at that timestamp still reflects the target, not the non-target — nothing wall-related for the non-target ever appears |
| 6 | Target wall contact | Target's own trajectory flows through to a `targetPoseSample` normally |
| 7 | Temporary pose loss | Gap within grace budget → status unchanged, no switch |
| 8 | Target overlap | Ambiguous/low-visibility spliced frames → no switch, ambiguity accumulates |
| 9 | Non-target entering target's previous location | Rejected via projected-position mismatch (§11), not accepted via last-known-position proximity |
| 10 | Target direction reversal | Tolerated, not treated as a jump (§12.1 #9) |
| 11 | Target leaving frame | Eventual `TARGET_LOST` once grace is exceeded |
| 12 | Correct reacquisition | `TARGET_LOST → TARGET_LOCKED` (tagged reacquired) when bounded time + projected-position evidence is satisfied |
| 13 | Incorrect reacquisition | Evidence insufficient → stays `TARGET_LOST` or moves to `ANALYSIS_DEGRADED`, never switches |
| 14 | Sustained ambiguity | `ANALYSIS_DEGRADED`, not a forced decision |
| 15 | **Identity switch attempt** | The single most safety-critical case — a plausible-looking but actually-wrong candidate must be refused, never silently accepted. **Must become a required regression test in Stage 4C.3**, no exceptions |
| 16 | Left-to-right | Symmetry check |
| 17 | Right-to-left | Symmetry check |
| 18 | Irregular timestamps | Non-uniform sampling intervals must not corrupt velocity/projection math — mirrors the Stage 4B turn-detector's time-normalization test |
| 19 | Missing landmarks | Excluded, not corrupting, exactly the pattern already established in Stage 4B detectors and Chronos's own event validation |
| 20 | Low visibility | Same exclusion pattern |

All fixtures are synthetic, hand-built, deterministic — no real video, no
real MediaPipe, matching every prior stage of this workstream.

## 16. Future API

```js
SwimmerTracking.createSession({ sessionId, timeSource }) -> { ok, session }
SwimmerTracking.selectTarget(session, selection) -> { ok, session, reason? }
SwimmerTracking.observe(session, sample) -> { ok, session, observation, targetPoseSample, reason? }
SwimmerTracking.abort(session) -> { ok, session }
```

No `getState()`/`getSession(id)` lookup — mirroring the exact reasoning
already validated for `window.ChronosEngine`
(`docs/CHRONOS_ARCHITECTURE.md` §18): the module keeps no internal
session registry, since the caller already holds the `TargetLockState`
object returned by every call and passes it back in on the next one.
Adding a lookup would introduce hidden state this design has otherwise
been careful to avoid everywhere else in this workstream.

`observe()`'s `targetPoseSample` field is the literal implementation of
the §13 invariant — non-null only when the sample is confirmed to belong
to the locked target.

The module must remain deterministic, pure where practical, and
independent of the clock, DOM, video elements, and MediaPipe — if a
future integration stage needs an adapter (e.g., something that reads
`video.currentTime` and calls `observe()` with the result), that adapter
lives **outside** this core module, exactly mirroring how Chronos's own
video-timing discipline was structured (`docs/CHRONOS_ARCHITECTURE.md`
§14, §19).

## 17. Deferred Capabilities

Explicitly out of scope for this document and for Stage 4C as a whole:

- **Fully automatic multi-person swimmer selection** — deferred pending
  all of: a technology decision (MediaPipe Tasks migration or another
  multi-person detector), a real multi-swimmer evaluation dataset, an
  evaluation harness, identity-switch metrics, false-lock metrics, and
  agreed acceptable-confidence thresholds. None of these exist today.
- **Steady-state / mid-lock re-identification** — closing the §12.4 gap
  (rejecting a spatially-coincident different swimmer while already
  `TARGET_LOCKED`) requires the same missing capability as fully
  automatic selection above (multi-person detection, an evaluation
  harness, labeled data) — deferred for the identical reasons, not
  approximated with a heuristic in the meantime.
- Appearance-embedding-based identity — no supporting infrastructure,
  explicitly rejected per the brief.
- Camera-motion compensation (§12.1 #10).
- Any new dependency — none is added in this stage, and none is proposed
  for Stage 4C.2/4C.3 either; the tracking core is designed to need
  nothing beyond plain JavaScript, the same way Chronos's core does.
- Video/MediaPipe/DOM integration, target-selection UI, detector
  integration, Chronos integration, Race Analysis — all future,
  separately-scoped stages (§18).

## 18. Implementation Sequence

1. **Stage 4C.1** (this document) — contracts and architecture.
2. **Stage 4C.2** — the core `src/swimmer-tracking/` state machine +
   continuity/locking/reacquisition logic, pure, no DOM/video/MediaPipe —
   same purity bar Chronos's core met in Stage 2.
3. **Stage 4C.3** — the deterministic test suite from §15, with scenario
   15 (identity switch attempt) as a mandatory regression test.
4. **Stage 4C.4** — a review pass (no new code) confirming the module
   satisfies every purity constraint in §6/§16, mirroring the review step
   already used after Stage 4B's detectors.
5. **Later, separately scoped:** integration with the real pose/video
   layer (an adapter outside the core module, §16); the target-selection
   UI; wiring the tracking layer's `targetPoseSample` output into the
   detector layer's `sample` input; any `RaceAnalysisReport` contract
   change for lock-quality data (§14); Race Analysis integration.

No stage after 4C.1 is authorized by this document — each requires its
own explicit approval, consistent with how every prior stage of this
workstream has proceeded.

## 19. Non-Goals

This document does not:

- Decide whether/when automatic multi-person detection is ever built.
- Specify exact numeric values for any provisional threshold beyond the
  handful of illustrative defaults given in §10 (deliberately not
  invented where no honest starting point exists, e.g.
  `maxVelocityDeltaPerSecond`, `lossGraceMs`) — real values are a Stage
  4C.2/4C.3 concern, tuned against fixtures, not asserted here as
  correct.
- Change `RaceAnalysisReport`, Chronos, the detectors, Chase AI, Firebase/
  auth, or the PB system in any way.
- Authorize any implementation. Stage 4C.2 requires its own explicit
  approval before any code is written.
