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
targetPoseSample.landmarks.nose  → chronosAssessStart({ sample: {atMs, nose}, baselineWindow, config })   (§7.2; built on the chronosDetectStart displacement primitive)
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
- Start: `baselineWindow` — a **bounded rolling window** of recent
  samples (`START_ASSESSMENT_DEFAULTS.baselineWindowMs`, 4000 ms by
  default; see §7.2). It was previously appended to on every call and
  never pruned. Duplicate and out-of-order samples are refused before
  they reach the detector and are never admitted to the window.
- Turn: `recentSamples` (a short window for time-normalized velocity)
  and `previousCandidateAtMs` (this detector's own last emitted
  candidate, for its local suppression window — confirmed independent
  of Chronos's `MIN_EVENT_GAP_MS`, Stage 4B's own test suite proves
  this explicitly).

**Detector candidates are not authoritative race events.** A non-null
return from `chronosAssessStart`/`chronosDetectTurn` is a **candidate**
— `{atMs, confidence, evidence}` — that must still pass through
`event-adapter.js` and `ChronosEngine.recordEvent()` before it can ever
become part of `session.events[]`. The detector adapter's job ends at
"collect whatever candidate(s) the detectors produced this call" — it
never decides acceptance itself (§17 invariant 3).

### 7.2 Start assessment (Chronos reliability, phases 1 and 1B)

**Evidence labelling.** Every number in this section comes from
deterministic **synthetic** trajectories driven through the real
pipeline, with ground truth known by construction. None of it is a
measurement on real swimming footage: no real race footage or
independently annotated start times exist in this repository, so
**real-world start accuracy is unverified.**

**Why this changed.** The original start path accepted the first single
sample whose nose position differed from the mean of *all* prior samples
by at least `displacementThreshold` (0.08):

| Defect | Observed (original code, synthetic) |
|---|---|
| S1 — start time was the *detection* instant, not the motion onset | accepted start 1,560 ms after true onset at 1.8 m/s (960 ms at 3.0 m/s; 2,360 ms when the clip began 1 s before the start) |
| S2 — no stationary reference required | a swimmer already swimming when the footage began (no start in the clip) produced an accepted start at 3.24 s |
| S3 — baseline was the mean of all history, never pruned | slow drift of 0.2–0.6 % of frame width per second produced a false start at 27–80 s (none at 0.1 %); state grew without bound |
| S4 — no confirmation stage | a single sample (including a nose-only jump with the hip still) started the race |
| S5 — duplicate/out-of-order samples admitted to the baseline | duplicated timestamps entered the window |
| S6 — one stray sample could change the answer (found in review) | a nose spike of 0.03 within 240 ms before the onset suppressed the start entirely (opposite side) or moved the onset 120–240 ms *before* the true onset (same side) |

**Contract.** `chronosAssessStart({sample, baselineWindow, config})`
(`src/chronos-engine/detectors/start-detector.js`) is built *on top of*
`chronosDetectStart()`, which remains the unchanged per-sample
displacement primitive and supplies the displacement/confidence evidence.
It returns `{state, reason, candidate, evidence}`; only `confirmed`
carries a candidate:

| state | reasons | meaning |
|---|---|---|
| `none` | `stationary`, `below-threshold` | inside the reference run's envelope (including having returned to rest after an excursion), or departing but still below the 0.08 displacement threshold |
| `plausible` | `awaiting-confirmation` | past the threshold on one side but not yet confirmed |
| `ambiguous` | `direction-reversal`, `departure-not-sustained`, `confirmation-span-exceeded` | conflicting evidence |
| `confirmed` | `sustained-departure` | eligible to become a candidate |
| `rejected` | `invalid-sample`, `low-visibility-sample`, `non-monotonic-timestamp`, `no-stationary-baseline`, `onset-before-reference-frame`, `invalid-reference-frame` | a hard gate failed. `no-stationary-baseline` covers **both** "fewer than 5 usable samples in the window yet" and "no 5-sample run within the noise band" (e.g. a swimmer already moving). `onset-before-reference-frame` and `invalid-reference-frame` are the start-context gates (§7.3) |

- **Reference run:** the most recent run of ≥ `minBaselineSamples` (5)
  consecutive usable samples whose total spread stays within a noise band
  of `baselineNoiseBandFraction × displacementThreshold` (0.25 × 0.08 =
  0.02), i.e. the resting position may not itself wobble by more than a
  quarter of the movement being detected.
- **"At rest" is judged against the run's envelope, not its mean:** a
  later sample is rest-consistent if adding it would not widen the run's
  spread beyond the band. (A short run can contain the first, still-tiny
  steps of the departure, which shifts its mean, so judging against the mean
  would make the true first departing sample look like rest.) The mean is
  used only for displacement magnitudes.
- **Departure:** the contiguous run of samples, ending at the current one,
  beyond the envelope on the current sample's side. A stray sample that is
  separated from it by at least one rest-consistent sample is not part of
  it. A **single** glitch sample (back inside the envelope, or on the
  opposite side) with two or more same-side samples to its left is bridged
  as a dropout. A departure that begins immediately after beyond-envelope
  samples on the *opposite* side (no rest-consistent sample between) is
  `direction-reversal` and is never confirmed.
- **Confirmation:** the last `confirmationSamples` (3) departure samples
  must each be ≥ 0.08 from the reference mean *as observed* and fall within
  `maxConfirmationSpanMs` (1000 ms). The unchanged primitive re-checks the
  same threshold for each of them; the two cannot disagree toward
  acceptance.
- **Candidate time = estimated motion onset:** `candidate.atMs` is the
  first sample of the departure, **not** the later instant confirmation
  completed (`evidence.confirmedAtMs`; both are in the evidence). It is
  not an official starter's signal. Chronos validates it only as a finite,
  non-negative video time, and every later event must be strictly after it.
- **Rolling window:** only samples within `baselineWindowMs` (4000 ms) of
  the newest are held.
- **Duplicates / out-of-order:** a sample whose timestamp is not strictly
  later than the newest held sample is refused by
  `racePipelineDetectStartCandidate()` before the detector (the same
  `detectorState` object is returned; assessment `non-monotonic-timestamp`).
- **Diagnostics:** the controller records the last assessment as
  `controller.diagnostics.lastStartAssessment = {state, reason, atMs,
  onsetAtMs}`: `atMs` is the media time of the sample just assessed (for a
  confirmed start, the **confirming** sample, later than the onset) and
  `onsetAtMs` is the estimated motion onset the assessment concerns (the
  candidate's, or the refused one for `onset-before-reference-frame`; `null`
  otherwise). The existing Developer Diagnostics panel shows them (§7.3). The
  field is written only while the session is `armed`; once Chronos accepts a
  start the start detector is no longer run and the field keeps the
  confirming assessment. It is informational: nothing reads it to decide what
  Chronos accepts. A missed start therefore shows as e.g.
  `rejected (no-stationary-baseline)` rather than nothing.
- **Controller behavior is unchanged:** the start detector is called only
  while the Chronos session is `armed`; once Chronos accepts a start it is
  never called again, and a second start is rejected with
  `start-already-recorded`.

**Demonstrated behavior (synthetic).** Nose `x` in frame-widths; samples
every 120 ms; "w/s" = frame-widths per second. For a 25 m pool spanning 80 %
of the frame width, 0.04 w/s ≈ 1.25 m/s and 0.058 w/s ≈ 1.8 m/s; these
values depend entirely on camera framing.

| Scenario | Result |
|---|---|
| clean constant-speed departure, 0.058–0.096 w/s | onset error +240 to +440 ms (equals the first sample > 0.02 beyond rest); never negative; bound 0 … noiseBand/speed + one sample interval held across 0.06–0.14 w/s |
| isolated nose spike ±0.03, 120 … 960 ms before the onset | no effect on the onset (+360 ms in every case), start still detected (before: suppressed or −120/−240 ms) |
| isolated dropout inside the departure | delays the onset by 1 sample (dropout at departing sample #3) or 2 samples (#4); no effect from #5 on (the first two departing samples are still inside the envelope) |
| two **consecutive** dropouts inside the departure, before confirmation | onset moves to after them (+3, +5, +9 samples measured at departing samples #4, #6, #10) |
| outlier directly adjacent to a fast departure (first departing sample already beyond the envelope; > ≈ 0.17 w/s) | indistinguishable from the departure: onset earlier than the true departure by the number of adjacent samples |
| accelerating start, 0.05 w/s² | onset +1,080 ms |
| 2 s tracking gap covering the onset | onset = first sample after the gap (+1,440 ms) |
| uniform pose jitter ±0.002 / ±0.005 / ±0.01 at 0.058 w/s (20 seeds each) | median lag 360 / 480 / 1,440 ms; max 480 / 2,400 / 4,920 ms; all detected |
| motion begins this long after the first frame (0.058 w/s departure) | detected from ≈ 0.64 s; at ≤ 0.56 s there is no baseline and no start |
| constant-speed departure, no noise | not detected ≤ 0.04 w/s; detected ≥ 0.045 w/s |
| constant-speed departure, ±0.005 jitter (10 seeds) | not detected ≤ 0.045 w/s; 0.05 w/s detected in 5/10 runs (median lag 4,560 ms); ≥ 0.06 w/s 10/10 |

The slow-departure and jitter rows share a cause that phase 1B did **not**
change: while a swimmer departs slowly, a transient 5-sample run can re-form
at the new position (jitter can cancel the motion over five samples), the
reference re-anchors there, and the departure is measured from the wrong
place. **A measured trade-off, not adopted:** on a scratch variant that
selected the *longest* run instead of the latest one, departures at
0.03–0.06 w/s with ±0.005 jitter were detected in 10/10 runs with median
lags of 240–600 ms (current code: 0/10 at 0.03–0.04, 5/10 at 0.05 with a
4,560 ms median lag), **but** steady slow drift at 0.025–0.04 w/s, with no
start in the clip, produced a false start about 1.1–1.3 s into the clip
(current code: none). Which side to favor is a decision, so the reference
selection rule was left unchanged.

**Provisional values, not validated on real footage:** `baselineWindowMs`,
`confirmationSamples`, `maxConfirmationSpanMs`, `baselineNoiseBandFraction`
(and the pre-existing `displacementThreshold`, `minBaselineSamples`,
`minVisibility`).

**Known limitations (start) — not resolved.**
- **False starts and start context.** The detector stays armed for the whole
  video and treats *any* rest followed by a sustained departure as the
  estimate. Without context that accepts a pre-race walk, a position
  adjustment, or a mid-race wall push-off (phase 1B reproduced these). Phase
  1C adds the user-marked pre-start reference frame (§7.3): with a frame
  marked after the unwanted movement, they are refused (synthetic results in
  §7.3). It depends on the user marking a genuine pre-start frame, which
  software cannot verify; motion after the marked frame but before the real
  start is still accepted; and a mark that precedes the unwanted movement
  gives no protection.
- Detection sensitivity and onset lag degrade with slow departures, pose
  jitter, tracking gaps, and slowly accelerating starts (table above).
- Start evidence is `nose.x` only; sustained nose-only movement with a
  still body can satisfy it.
- Detectors only receive samples SwimmerTracking has confirmed, so a start
  needs the target to have locked (≈ 5 samples) and enough stationary
  footage after that (≈ 0.64 s from the first frame in the synthetic case).
- Direction-agnostic and camera-framing dependent (all thresholds are in
  frame-widths).
- The visual onset of motion is not the official start (starter's signal,
  reaction time); the footage may not contain that information.
- The analysis report line reads `Estimated motion onset: X s — visual
  estimate, not an official start`. X is the **estimated onset**, which
  precedes the moment the status flips to "Motion onset estimated" by the
  confirmation delay (about 0.8 s at 0.096 w/s and 1.3–1.4 s at 0.058 w/s in
  the synthetic runs).
- The on-page `#timer` and the legacy manual Start/Split/Reset controls are
  **not** driven by Chronos (the manual `startTimer()` is undefined). The
  only official start is the Chronos `start` event shown in the analysis
  report. Wiring a live timer to Chronos is a UI behavior change that
  `docs/CHRONOS_ARCHITECTURE.md` §24 requires approval for.
- Pre-existing, outside the start detector: SwimmerTracking can lock from
  duplicate or descending timestamps; a sustained rewind drives tracking
  into the terminal `ANALYSIS_DEGRADED` state.

### 7.3 Start context: the pre-start reference frame (Chronos reliability, phase 1C)

**Evidence labelling.** Every number below comes from deterministic
**synthetic** trajectories driven through the real pipeline (and, for the
browser rows, a real page with a generated video and a scripted stand-in for
MediaPipe). None of it is a measurement on real footage: no real race footage
or independently annotated start times exist in this repository.

**What the detector measures.** The start detector estimates the **visual
onset of motion** of the tracked swimmer from pose landmarks. Everything the
UI and diagnostics call "estimated motion onset" is that, and nothing else:
it is not the starter's signal, not an official start, and not a reaction
time, and the footage may not contain that information. No code here
identifies an official start.

**Why context is needed.** The detector stays armed for the whole video and
treats any rest followed by a sustained departure as the estimate. A swimmer
walking to the blocks, stepping to adjust, or pushing off a wall in a clip
that begins mid-race all look like that. No threshold can tell which
rest-then-motion is the one the user cares about; the user has to say.

**The interaction (the existing calibration pause, extended).** Race page
step 3, *Mark the Pre-Start Frame and Lane Reference*:

1. The user pauses the video on a frame **before the start**, with the
   swimmer at rest, then presses *Mark Pre-Start Frame & Lane Position*
   (this also pauses the video and arms the click).
2. The user may scrub to the exact frame, then clicks the swimmer.
3. At the click, `racePipelineStartReferenceMsFromMediaTime(video.currentTime)`
   converts the paused frame's media time to milliseconds. The lane position
   and the reference are recorded **together or not at all**.

Refused (the click is ignored, an explanatory message is shown, the lane
position and reference stay unset): the video is **playing** when clicked
(the button stays armed), the click lands outside the video content, or the
media time cannot be read as a finite, non-negative number. Loading another
video clears both. Changing the mark while an analysis is running does not
affect that analysis (the configuration is copied at *Start*). The video is
still analysed from media time 0.

**Contract, and where each part is enforced.**

| Where | What |
|---|---|
| `index.html` | requires a paused video at the click; both-or-neither; *Start* is blocked with "lane calibration" until set |
| `race-config.js` | `racePipelineStartReferenceMsFromMediaTime()` (null for negative, NaN, infinite, non-numeric input — never 0 or clamped); `racePipelineBuildRaceConfig()` carries `startReferenceMs`; missing/invalid is reported as "lane calibration" |
| `controller.js` `validateConfig()` | `startReferenceMs` is **required**: absent → `missing-start-reference`; non-finite, negative or non-numeric → `invalid-start-reference`; no session is created. It never defaults to 0 or to "no constraint" |
| `controller.js` `runStartDetection()` | hands it to the detector as `referenceFrameMs` |
| `start-detector.js` | a departure whose **first sample** is earlier than `referenceFrameMs` is refused (`rejected` / `onset-before-reference-frame`, evidence carries the refused onset and the reference); an unusable reference is `rejected` / `invalid-reference-frame`; absent means the caller gave no context and the search is unconstrained (the controller never does that) |

**Semantics.**
- The estimated onset is never earlier than the reference; the boundary is
  inclusive.
- Samples before the reference are **not discarded**. Stationary samples just
  before it are a legitimate baseline, so a frame marked right before the
  motion (with no stationary footage after it) still works. The constraint is
  on where the *departure begins*.
- A departure that begins before the reference and continues past it is
  refused **as a whole**. It is not truncated to the reference, which would
  invent an onset the swimmer did not have.
- The reference only has to precede the *estimated* onset, which trails the
  true onset (≈ 0.24–0.44 s in the clean synthetic case). A frame marked
  slightly after the motion truly began still works; one marked after the
  estimated onset yields no start, with `rejected (onset-before-reference-frame)`
  and the refused onset in diagnostics.
- **SwimmerTracking is untouched.** It receives every sample from the start of
  the footage and may lock before the reference. A synthetic test shows the
  tracking session identical frame by frame with and without a reference.
  Chronos events, the analysis start position, and the legacy `#timer` are
  also unchanged; the timer is **not** connected to Chronos.

**Four timestamps, never conflated.** The Developer Diagnostics panel shows,
only when each exists: *Reference frame (marked pre-start)* (the marked
frame); *Estimated motion onset … (confirmed at …)* (the onset, and the
later sample at which detection was confirmed); *Start assessment … evaluated
at …* (the sample just assessed); and *Chronos start event (estimated motion
onset, not an official start)* (the accepted event, whose time **is** the
onset). A refused departure appears as *Refused motion onset … (it begins
before the reference frame)*. The analysis report shows *Estimated motion
onset: X s — visual estimate, not an official start* and the reference frame.
The user-facing status reads "Motion onset estimated".

**Demonstrated behavior (synthetic).** Reference 0 excludes nothing (the
control); the other reference is placed after the unwanted movement.

| Scenario | Reference 0 | Reference after the movement |
|---|---|---|
| walk 1.0–2.0 s, true departure 6.0 s | onset 1,200 ms (confirmed 1,800) | **6,360 ms** (confirmed 7,680); the walk's onset 1,200 ms refused |
| 0.24 s step at 1.0 s, departure 6.0 s | onset 1,080 ms | **6,360 ms** |
| step only, no start in the clip | **false start**, onset 2,160 ms | none |
| clip begins mid-race, wall pause + push-off, no start in the clip | **false start**, onset 7,080 ms | none |
| same, with a real departure at 14.0 s | onset 7,080 ms | **14,400 ms** (push-off's 7,080 ms refused) |
| valid departure (estimate 6,360 ms) | 6,360 ms | 6,360 ms for references 2,800 / 5,880 / 6,000 / 6,360; **none** for 6,361 / 6,600 / 60,000 |
| spikes ±0.03 at 120 / 240 / 480 ms before the onset | — | unchanged, 6,360 ms |
| no stationary footage / already moving | none | none |
| slow or noisy departures | unchanged | unchanged (the reference does not affect detection sensitivity) |
| missing, null, NaN, −1, "3000", Infinity | analysis blocked (`missing-start-reference` / `invalid-start-reference`), no session | — |

**Browser integration (synthetic video, scripted pose).** On the real race
page, with the frame driver, calibration handler, controller and detector
running unmodified: pausing and seeking to 4.0 s then clicking records
"Pre-start reference frame: 4.0x s"; the controller receives it; the scripted
walk (2.4–3.4 s) is refused and visible in the diagnostics history; the
estimated onset is the departure at about 6.4 s and is not earlier than the
reference; confirmation is later than the onset; the page never says "Start
detected" or claims an official start; the legacy `#timer` stays "0.00 s". A
reference marked at 0 s produces the walk as the estimate (control). A click
on a playing video records nothing and *Start* stays blocked; loading another
video clears the mark.

**Assumptions and limitations of the context.**
- **Software cannot verify that the marked frame is a genuine pre-start
  frame.** The contract assumes the user paused before any movement, with the
  swimmer at rest.
- Motion **after** the reference but before the real start (a position
  adjustment after marking) is still accepted as the estimate.
- A mark that precedes the unwanted movement gives no protection (the
  reference-0 column).
- A clip that has no genuine pre-start frame (it begins mid-race) cannot
  satisfy the instruction. Marking a frame after a push-off prevents that
  push-off from being taken as the start, but that frame is not a pre-start
  frame; no start can be estimated from such a clip.
- Tracking must still lock and hold the target through to the departure. If
  tracking is lost or degraded first (for example the swimmer is out of
  frame for several seconds), no start is estimated; the *Tracking:* line
  shows the status.
- The paused frame's `currentTime` can exceed that frame's timestamp by up
  to one frame interval. This does not matter in practice because the
  reference only has to precede the estimated onset.
- Slow-departure, jitter, tracking-gap and accelerating-start limitations
  (§7.2) are unchanged.

### 7.1 `referenceLaneY` source (decided, Stage 4D.7)

`chronosDetectTurn`'s `config.referenceLaneY` has no default and no
legitimate first-frame derivation (Stage 4D.5.1 investigation; the
legacy `laneCenterY`-from-first-frame heuristic in dead pre-Stage-4D.6
code is explicitly rejected as a pattern, not reused). Stage 4D.7
resolves this with **explicit user calibration**, reusing the
already-defined `SwimmerTracking` `TargetSelection.point` concept
(`docs/SWIMMER_TRACKING_ARCHITECTURE.md` §7.2) rather than inventing a
new calibration primitive:

- **Interaction:** the user pauses the loaded race video on a frame
  **before the start** (swimmer at rest), activates calibration, and clicks
  once on the swimmer in the video. The same click also records the paused
  frame's media time as the pre-start reference frame (§7.3), and the lane
  position is set together with it or not at all. `src/race-pipeline/race-config.js`'s
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
