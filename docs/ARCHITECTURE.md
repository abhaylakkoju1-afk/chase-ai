# Architecture

This document describes Chase/Swimtics's architecture as it exists today,
and the target architecture the infrastructure phase is building toward.
It is derived from the read-only baseline audit performed on
2026-09-06 against `chase/infrastructure` (commit `5c456c0`). Update this
file in the same PR whenever architecture actually changes — do not let
it drift from the code.

## 1. Current architecture

The entire application is one static file, `index.html` (~12,000 lines),
served as-is by GitHub Pages with no build step. There is no backend.

```
index.html
├── <head>
│   ├── third-party <script> tags (GSAP, MediaPipe, Chart.js, GA, Clarity)
│   └── <style> — GLOBAL block (~2,700 lines)
├── <style id="swimticsPremiumMergedCSS"> (~3,300 lines)
├── <body>
│   ├── entry gate (cinematic intro overlay)
│   ├── nav + auth modal (non-functional, see docs/DECISIONS.md)
│   ├── page sections (div.page, shown/hidden by showPage()):
│   │   home · analyzer (Chase AI) · pb (Wall of Records)
│   │   · race (Chronos Engine) · profile · dashboard (War Room)
│   ├── <script type="module"> — Firebase bootstrap
│   ├── <script> — application logic (~3,500 lines)
│   └── <script> — marketing/scroll animation (GSAP)
```

Three JS blocks share one global scope; there are no ES modules for
application logic (the Firebase block is a module only to use `import`
for the Firebase SDK).

### 1.1 Current Chase pipeline

The Chase AI analyzer page implements a real, working, in-browser slice
of the target pipeline:

```
Video file (user upload)
  → <video> element, object URL
  → offscreen canvas frame grab, every 120ms (setInterval)
  → MediaPipe Pose (client-side WASM inference)
  → onChasePoseResults(): landmark → metric calculators
      (elbow angle, body alignment, shoulder asymmetry, arm symmetry,
       hip-line tilt, knee angle, lateral drift)
  → metricsHistory (timestamp-aligned arrays)
  → chaseDetectFreestyleCycles() — wrist-height local-minima heuristic
      (freestyle only; other strokes get generic metrics + disclaimer)
  → CHASE_COACHING_RULES — fixed threshold rules → observation/
      interpretation/context/recommendation text
  → displayChaseMetrics() / generateChaseFeedback() — DOM render,
      including an explicit "measured vs inferred vs indeterminate"
      section
```

The Chronos Engine (race timer) runs a second, independent MediaPipe
Pose instance for motion-triggered start/split timing and a coarse
stroke-count heuristic. It does not share code or state with the
analyzer above.

The "Coach ATLAS" chat widget is **not** part of this pipeline: it is
keyword-matched canned text with no access to `metricsHistory` or any
analysis output. Wiring it into the pipeline is future work (see
`docs/ROADMAP.md`).

### 1.2 Current data flow

- **Video/pose/metrics**: in-memory only, per page load; nothing is
  uploaded to a server or persisted. Reloading the page discards it.
- **Personal bests, profile, stroke data, soreness map, theme**:
  `localStorage` only, per-browser, per-device, never synced.
- **Firebase (Auth + Realtime Database)**: initialized on load
  (`window.auth`, `window.db`) but not on the critical path of any
  working feature — see `docs/DECISIONS.md` for why this is treated as
  a known issue rather than fixed silently.

### 1.3 Current deployment

Static GitHub Pages, custom domain via `CNAME` (swimtics.com), no build
step, no CI. Whatever is committed to the served branch ships
immediately on merge.

## 2. Target architecture

### 2.1 Two domains, one deploy

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│         App shell            │        │         Chase engine          │
│  (existing product surface,  │◄──────►│   (biomechanics pipeline,     │
│   behavior preserved)        │  calls │    new, separately tested)    │
│                               │        │                               │
│  nav · entry gate · PB       │        │  ingest → pose → tracking     │
│  tracker · profile ·          │        │  → phases → cycles →          │
│  War Room · marketing         │        │  measurements → technique     │
│  animation · ATLAS chat UI    │        │  → coaching                   │
└─────────────────────────────┘        └──────────────────────────────┘
```

The shell keeps doing exactly what it does today. The engine is new and
grows independently, called through a small stable interface (for
example, conceptually: `ChaseEngine.analyze(video, strokeKey) →
TechniqueReport`). The shell's existing UI code
(`upload()`/`runChaseAnalysis()`/`displayChaseMetrics()`) becomes a
*caller* of that interface rather than the implementation of the
pipeline itself. This split is what lets the engine be rebuilt
incrementally without rewriting the product around it.

Both still deploy as one static site initially — introducing this
boundary is a code-organization change, not a hosting change. A build
step (not yet installed — see `docs/ROADMAP.md`) is what will make the
split into real files practical without changing the GitHub Pages
deploy model.

### 2.2 Target pipeline

```
Video
  → Pose estimation
  → Temporal tracking
  → Stroke-phase detection
  → Stroke-cycle segmentation
  → Biomechanical measurements
  → Technique model
  → Evidence-based coaching layer
  → Coach ATLAS
```

| Stage | Status today | Notes |
|---|---|---|
| Video ingest | Working | File upload, offscreen canvas frame grab |
| Pose estimation | Working | MediaPipe Pose (BlazePose), client-side |
| Temporal tracking | Partial | Timestamp-aligned arrays exist; no trajectory filtering beyond MediaPipe's built-in smoothing |
| Stroke-phase detection | Partial | Only a coarse up/down flag for stroke counting, not a labeled phase model |
| Stroke-cycle segmentation | Partial | Wrist-height local-minima heuristic, freestyle only, no confidence score |
| Biomechanical measurements | Partial | 7 legitimate 2D single-camera proxy metrics |
| Technique model | Not started | No trained/learned model; only fixed threshold rules |
| Coaching layer | Partial | Evidence-bound text generator exists and is the pattern to keep |
| Coach ATLAS | Not started (as pipeline output) | Current widget is disconnected keyword-matching |

### 2.3 Boundaries between pipeline stages

Each stage is a pure function from one data contract to the next (see
§2.4). This is what makes a stage independently testable and
independently replaceable — for example, swapping the wrist-height
cycle heuristic for a learned segmenter later should only touch the
cycles stage, not tracking or measurements. A stage may run client-side
(as everything does today) or, later, be backed by a server call
without changing the contract at its boundary — that seam should be
designed in, not bolted on later.

### 2.4 Proposed shared data contracts

These are illustrative shapes, not final types — they exist so every
future stage targets the same vocabulary. Refine them in the PR that
first implements each stage, and update this section when they change.

- **`PoseFrame`** — one video frame's pose result: timestamp, per-landmark
  `{x, y, z, visibility}`, and the frame's own quality/validity flag.
- **`TrackedSequence`** — an ordered sequence of `PoseFrame`s with
  temporal smoothing/interpolation applied, plus per-frame confidence.
- **`StrokePhaseLabel`** — a labeled span of a `TrackedSequence` (e.g.
  catch / pull / push / recovery / entry) with a confidence score and
  the camera-angle assumption it depends on.
- **`StrokeCycle`** — a start/end time pair over a `TrackedSequence`,
  the stroke type it was detected under, and the detection method's
  confidence.
- **`BiomechMeasurement`** — one named measurement (e.g. elbow angle)
  with its value, units, the stage/method that produced it, and an
  explicit tag: measured / inferred / indeterminate (see `CLAUDE.md`
  §15).
- **`TechniqueReport`** — the full structured output for one analyzed
  clip: measurements, cycles, phases, and any technique-model output,
  bundled with confidence/limitations metadata. This is the only thing
  a coaching layer (including any future LLM phrasing step) is allowed
  to read from — never raw video or raw frames.
- **`CoachingObservation`** — one coaching statement, always carrying a
  pointer back to the `BiomechMeasurement`(s) it was derived from.

## 3. Non-goals for this document

This file describes architecture, not a schedule. Phased sequencing and
priority live in `docs/ROADMAP.md`. Specific decisions and their
rationale live in `docs/DECISIONS.md`.
