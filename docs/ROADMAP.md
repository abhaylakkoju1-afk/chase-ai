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

**Four-stroke foundation (in progress).** Two parts exist so far, both
exercised only by synthetic fixtures:

- a versioned label contract for expert-labelled events, phases and
  cycles in all four strokes (`chase.stroke-labels.v0.1`);
- a deterministic harness that scores candidate outputs per stroke and
  per camera view (`docs/evaluation/STROKE_LABEL_CONTRACT_V0.1.md`).

No real clips or labels have been collected. The freestyle pilot
protocol (`docs/evaluation/ANNOTATION_PROTOCOL_V0.1.md`) is unchanged.

### Stroke validation gate

This gate is recorded as decision **EVAL-1** in `docs/DECISIONS.md`; this
section is its working checklist. It applies, separately for each
stroke and camera view, before
any of the following is enabled for that stroke:

- a stroke-specific detector, phase model, cycle segmenter,
  measurement or technique claim;
- any change to backstroke, butterfly or breaststroke's current
  research-only status.

All of the following must hold:

1. **Approved protocol.** An annotation protocol for that stroke is
   approved after a double-annotation pilot. It defines each event
   visually, says which views can show it, and says when to abstain.
2. **Dataset decision first.** A dataset decision is recorded in
   `docs/DECISIONS.md` before any footage is collected (`CLAUDE.md`
   §14). It covers the consent basis (including guardians of minors),
   private storage and access control, and retention and deletion.
   Footage never enters this repository.
3. **Real labels.** Real expert labels exist, made blind to candidate
   output, covering the views the stroke's events need, with a
   held-out evaluation split by swimmer.
4. **Tolerances from agreement.** Matching tolerances are chosen from
   measured inter-annotator agreement and recorded with the evaluation
   version.
5. **Report per stroke and view.** A harness report on the held-out
   labels (`expert_labelled_not_validated`) shows, for each stroke and
   view:
   - event and timing errors;
   - cycle errors;
   - coverage and abstention rate;
   - annotator agreement.
   Views that do not meet the agreed limits stay unsupported, and the
   detector abstains there.
6. **Human sign-off.** A human sign-off is recorded in
   `docs/DECISIONS.md`, naming:
   - the stroke and views;
   - the contract, protocol, evaluation and detector versions;
   - the acceptance limits used;
   - the remaining limitations.
   Passing the gate does not by itself enable a detector or change
   user-facing wording; each needs its own explicit approval (EVAL-1).

Constraints on the gate:

- A synthetic report can never satisfy the gate.
- Passing for one stroke or view does not carry over to another.
- No acceptance limits are set yet. They are set at sign-off, from
  agreement data.

## Phase 4 — Pose & tracking improvements

Add temporal filtering/smoothing beyond MediaPipe's built-in
`smoothLandmarks` (e.g. occlusion-aware interpolation), and measure
pose-estimation reliability specifically on swimming footage
(splashing, refraction, partial submersion) against the Phase 3
evaluation set — not just the existing frame-presence "reliability %."

## Phase 5 — Stroke-phase detection

Replace the coarse up/down heuristic with a real labeled phase model
(catch / pull / push / recovery / entry), evaluated against Phase 3
ground truth, starting with freestyle. No phase model is enabled for a
stroke until it passes the stroke validation gate (Phase 3, decision
EVAL-1).

## Phase 6 — Stroke-cycle segmentation

Generalize cycle segmentation beyond the current freestyle-only
wrist-height heuristic, add a confidence score to detected cycles, and
extend coverage to additional strokes only once each has evaluation
data to validate against and has passed the stroke validation gate
(Phase 3, decision EVAL-1) for the views it will run on.

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
