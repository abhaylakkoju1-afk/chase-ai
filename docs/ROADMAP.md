# Roadmap

This is a phased roadmap, not a schedule with dates. Phases are ordered
by dependency — each one is a prerequisite for the ones after it being
trustworthy, not just a nice-to-have sequence. Do not skip ahead to a
later phase (e.g. training a technique model) without the phases it
depends on (e.g. evaluation infrastructure) being in place — see
`docs/DECISIONS.md`.

Each phase should be broken into task branches and PRs scoped per
`docs/DEVELOPMENT_WORKFLOW.md` — a phase is not one PR.

## Phase 0 — Infrastructure (current)

Establish the documentation and process foundation before any code
changes: `CLAUDE.md`, `docs/ARCHITECTURE.md`, this roadmap,
`docs/DEVELOPMENT_WORKFLOW.md`, `docs/DECISIONS.md`, and an updated
`README.md`. Branch protection on `main`. No application code changes.

## Phase 1 — Testing foundation

Write unit tests for the pure functions that already exist in
`index.html` (geometry helpers, `summariseMetric`,
`chaseDetectFreestyleCycles`, `calculateStrokeScore`, the War Room
scoring logic) without moving or rewriting them yet. Stand up minimal
CI (build/lint/test on every PR). Add smoke-test coverage for the
existing shell (navigation, PB tracker, profile, theme toggle) so later
refactors have a safety net.

## Phase 2 — Modularization

Introduce a minimal build step (e.g. Vite) and extract the inline JS
into real files/modules with **zero behavior change**, verified against
the Phase 1 test suite and manual in-browser checks at each step.
Establish the app-shell / Chase-engine boundary described in
`docs/ARCHITECTURE.md` §2.1. GitHub Pages continues serving a static
build output — the deploy model does not change.

## Phase 3 — Evaluation infrastructure

Before any technique model is trained, build the means to know whether
it's right: collect a small set of real swim clips, get expert-labeled
ground truth for stroke phases/cycles on them, and build a harness that
can score a pipeline stage's output against that ground truth. This
phase exists explicitly to prevent Phase 6+ from shipping unvalidated
model output — see `docs/DECISIONS.md`.

## Phase 4 — Pose & tracking improvements

Add temporal filtering/smoothing beyond MediaPipe's built-in
`smoothLandmarks` (e.g. occlusion-aware interpolation), and measure
pose-estimation reliability specifically on swimming footage
(splashing, refraction, partial submersion) against the Phase 3
evaluation set — not just the existing frame-presence "reliability %."

## Phase 5 — Stroke-phase detection

Replace the coarse up/down heuristic with a real labeled phase model
(catch / pull / push / recovery / entry), evaluated against Phase 3
ground truth, starting with freestyle.

## Phase 6 — Stroke-cycle segmentation

Generalize cycle segmentation beyond the current freestyle-only
wrist-height heuristic, add a confidence score to detected cycles, and
extend coverage to additional strokes only once each has evaluation
data to validate against.

## Phase 7 — Biomechanical measurements

Expand the measurement set beyond the current 7 metrics, keeping every
new measurement explicitly tagged with its camera-angle assumption and
its measured/inferred/indeterminate status (`CLAUDE.md` §15). Decide
deliberately here whether single-camera 2D remains the supported input,
or whether multi-angle/underwater footage becomes a requirement (see
`docs/DECISIONS.md`).

## Phase 8 — Technique models

Only after Phase 3–7 exist: train/introduce a technique model on top of
tracked, phase-labeled, cycle-segmented measurements, evaluated against
the Phase 3 ground truth before it informs any coaching output.

## Phase 9 — Evidence-based coaching

Generalize the existing threshold-rule coaching pattern
(`CHASE_COACHING_RULES`) to consume technique-model output, preserving
the observed → interpretation → context → recommendation structure and
the measured/inferred/indeterminate disclosure, for every stroke with
sufficient evaluation coverage.

## Phase 10 — ATLAS integration

Connect the Coach ATLAS chat layer to real pipeline output
(`TechniqueReport`) instead of today's disconnected keyword-matching.
If an LLM is used here, its role is restricted to phrasing/summarizing
structured pipeline output — never originating a technique judgment
from raw video (`CLAUDE.md` §6).

## Phase 11 — Autonomous experimentation

Once the pipeline, evaluation harness, and CI are mature, allow
autonomous Claude Code sessions to run bounded experiments (e.g.
trying an alternative cycle-detection method, comparing measurement
approaches) and report results via PR, still subject to every rule in
`CLAUDE.md` — human approval to merge, no production pushes, no
unvalidated technique claims shipped.

## Known deferred items

Carried from the baseline audit, intentionally not scheduled into a
numbered phase yet — each needs its own scoping decision before work
begins:

- Fixing or removing the dead login/sign-up flow.
- Deciding whether Firebase becomes a real data layer, and if so, its
  data model, security rules, and privacy/consent posture.
- Repo hygiene (LICENSE, Git LFS or external hosting for the ~34 MB of
  committed media, pinning `Chart.js`).
