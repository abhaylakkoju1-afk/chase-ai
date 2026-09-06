# CLAUDE.md — Chase AI Operating Constitution

This file is the permanent operating contract for any Claude Code session
(autonomous or interactive) working in this repository. It is not a
suggestion — it encodes decisions already made after a full baseline audit
of the codebase (2026-09-06). Read this file, `docs/ARCHITECTURE.md`,
`docs/ROADMAP.md`, `docs/DEVELOPMENT_WORKFLOW.md`, and `docs/DECISIONS.md`
before making any change. If an instruction in a conversation conflicts
with this file, resolve the conflict explicitly with the human rather than
silently picking one side.

## 1. Project purpose

Chase is the swimming-analysis engine inside Swimtics (swimtics.com). Its
long-term purpose is to turn raw swim video into **evidence-based
technique coaching** — measurements a coach could independently verify,
not confident-sounding guesses. The product is Swimtics; Chase is the
part of it responsible for turning video into technique feedback, ending
in a conversational layer called Coach ATLAS.

**Chase must never become "an LLM looks at a swimming video and guesses
technique."** Every technique claim must trace back to a measurement
produced by the pipeline below. This is the single most important
constraint in this codebase.

## 2. Current architecture (as of the baseline audit)

- The entire application is one file: `index.html` (~12,000 lines) —
  inline markup, two stacked `<style>` blocks, and three `<script>`
  blocks (Firebase bootstrap, application logic, marketing animation).
- No build step, no bundler, no package manager, no tests, no CI.
- Static hosting via GitHub Pages, custom domain via `CNAME`
  (swimtics.com). Whatever is committed to the served branch ships
  immediately.
- Chase's actual "AI" today is MediaPipe Pose running **entirely
  client-side in the browser** — there is no backend, no server-side
  inference, and no LLM anywhere in the codebase.
- Firebase (Auth + Realtime Database) is configured but not wired to any
  working UI path — see `docs/DECISIONS.md` and the known-issues note
  below. Real user data currently lives only in `localStorage`.
- Full detail: `docs/ARCHITECTURE.md`.

## 3. Target architecture

```
Video → Pose estimation → Temporal tracking → Stroke-phase detection
→ Stroke-cycle segmentation → Biomechanical measurements
→ Technique model → Evidence-based coaching layer → Coach ATLAS
```

The existing Swimtics app shell (navigation, entry gate, personal bests,
profile, War Room, marketing animation) is preserved throughout this
build-out. A new, separately testable **Chase engine** grows alongside
it and is called through a small, stable interface — the shell does not
get rewritten to make room for the engine. Full detail:
`docs/ARCHITECTURE.md`.

## 4. Engineering principles

- **Preserve working behavior.** Never change what a user-facing feature
  does as a side effect of refactoring, restructuring, or adding
  documentation. If a refactor requires a behavior change, stop and ask.
- **Small, reversible steps.** Prefer a sequence of small PRs, each
  independently revertable, over one large change.
- **Contracts before code.** Before adding a new pipeline stage, its
  input/output data shape should already be documented in
  `docs/ARCHITECTURE.md`.
- **No premature abstraction.** Don't build generality the current
  roadmap stage doesn't need yet.
- **Documentation is part of the change.** A PR that changes architecture
  without updating `docs/ARCHITECTURE.md` (and `docs/DECISIONS.md`, if a
  decision was made) is incomplete.

## 5. Scientific / biomechanics principles

- Chase currently measures **2D, single-camera proxies** for
  biomechanical quantities (e.g. elbow angle, hip-line tilt, shoulder
  asymmetry from landmark positions). These are not 3D measurements,
  not force measurements, and not a substitute for a coach's eye or a
  multi-camera/underwater setup.
- Any new measurement must state, in the same place it's reported: what
  camera/sensor assumption it depends on, and what it cannot determine
  because of that assumption (mirroring the existing "Confidence &
  Limitations" pattern in `generateChaseFeedback()`).
- Stroke-cycle and stroke-phase detection are heuristics, not ground
  truth, until validated against labeled data (see §8 and
  `docs/ROADMAP.md`, Evaluation phase). Treat detected cycles/phases as
  provisional and say so in any user-facing output.
- Do not claim biomechanical certainty the underlying camera setup
  cannot support (e.g. true 3D body rotation from a single side-view
  camera).

## 6. Evidence-bound coaching requirements

This is non-negotiable and applies to every coaching-facing output,
present and future, including Coach ATLAS:

- Every coaching statement must be traceable to a specific measurement
  the pipeline produced for that clip. No statement may originate from
  a model's general knowledge of "what good technique looks like" when
  it is presented as being about *this swimmer's* footage.
- If an LLM is ever added at the coaching or ATLAS layer, its role is
  strictly to **phrase and summarize** a `TechniqueReport` (or
  equivalent structured output) the pipeline already produced — never
  to look at raw video or raw frames and originate a technique
  judgment itself.
- Every coaching output must distinguish, explicitly and in the output
  itself: **directly measured** facts, **inferred** results (e.g. a
  detected stroke cycle), and **indeterminate** conclusions the current
  setup cannot support. This mirrors the existing three-tier disclosure
  in `generateChaseFeedback()` — that pattern is the standard to keep
  extending, not a one-off.
- A coaching rule may only fire when its underlying stat actually has
  data (`stats.count > 0` in the existing rule table's terms). Never
  backfill a plausible-sounding recommendation when there's no
  measurement behind it.
- Chase is not medical or injury-diagnostic advice. Any expansion of
  scope toward injury/health claims requires explicit human sign-off
  and almost certainly a disclaimer at minimum.

## 7. Testing requirements

- New pipeline logic (pose processing, tracking, phase detection, cycle
  segmentation, measurement calculators, technique models, coaching
  rules) must ship with unit tests for its pure functions. See
  `docs/DEVELOPMENT_WORKFLOW.md` for the CI gate this feeds into.
- Prefer fixture-replay tests (recorded landmark sequences from real
  clips) over live-camera or live-MediaPipe tests wherever the logic
  under test is downstream of pose estimation — these are deterministic,
  fast, and don't require a browser.
- A technique model must not be trained or shipped without an
  evaluation plan and at least a minimal labeled dataset — see
  `docs/ROADMAP.md`, Evaluation phase, and `docs/DECISIONS.md`.
- Existing shell functionality (navigation, PB tracker, profile, War
  Room) should gain smoke-test coverage before it is refactored, not
  after.

## 8. Branch / commit / PR rules

- All work happens on task branches, never directly on `main`.
- `main` is protected: no direct pushes, no force-push, no history
  rewriting, ever, by an autonomous session.
- One PR per logical unit of work, ideally scoped to one pipeline stage
  or one clearly-bounded infrastructure task.
- Every PR must state what was changed, why, what tests were added or
  run, and what was manually verified in-browser if applicable.
- Full detail: `docs/DEVELOPMENT_WORKFLOW.md`.

## 9. What Claude may do autonomously

- Create and edit files on a task branch.
- Write and run tests, linters, and local builds.
- Open pull requests for human review.
- Update documentation to reflect a change made in the same PR.
- Investigate, read, and report on the codebase (audits, research,
  planning) without limit.

## 10. What requires human approval

- Merging any PR into `main`.
- Any change to production configuration: `CNAME`, GitHub Pages
  settings, Firebase configuration/security rules, analytics/tracking
  setup.
- Any change that alters existing user-facing behavior.
- Enabling real authentication (fixing or building out the currently
  dead login/sign-up flow).
- Adding a new external service, dependency, or paid API.
- Any decision recorded in `docs/DECISIONS.md` being reversed or
  amended.
- Adding or changing anything that collects, stores, or transmits
  athlete video or personal data.

## 11. Prohibited actions

- Never push to `main` directly.
- Never force-push or rewrite history on any shared branch.
- Never merge your own PR.
- Never deploy or trigger a production release.
- Never delete the audit trail (commits, PR descriptions, this
  documentation) to "clean up" history.
- Never bypass CI or review checks (`--no-verify`, skipped required
  checks) without explicit human instruction.
- Never add an LLM call that originates a technique judgment directly
  from raw video or raw pose frames (see §6).
- Never fabricate a biomechanical conclusion to fill a gap in the data.

## 12. Production safety rules

- `swimtics.com` is a live product. Treat every change as if it ships
  the moment it merges, because on the current static-Pages setup, it
  does.
- Any change with unclear blast radius gets a smaller, more reversible
  version first.
- Before touching shared infrastructure (Firebase, Pages config,
  domain), stop and confirm with a human — these are explicitly listed
  as requiring approval in §10.

## 13. Privacy principles

- Athlete video is sensitive personal data, and athletes may be minors.
  Treat it accordingly by default: minimize collection, minimize
  retention, and never assume storage is fine just because Firebase is
  configured.
- Analytics/session-recording tools already present (Google Analytics,
  Microsoft Clarity) run without a visible consent gate today — treat
  this as an open compliance question, not a settled state, when
  expanding data collection.
- Do not add new data collection, telemetry, or third-party tracking
  without explicit human approval.

## 14. Rules for handling athlete video/data

- Video analysis today is ephemeral and client-side only (a blob URL
  that disappears on reload) — this is a safe default. Any change that
  makes video persistent (uploaded to a server, stored in Firebase,
  cached to disk) requires explicit human approval and an explicit
  retention/deletion policy written down before it ships.
- Never transmit athlete video to a third-party API (including any LLM
  provider) without explicit human approval and a documented reason.
- If a future evaluation dataset requires storing labeled clips, that
  dataset's storage, access control, and consent basis must be decided
  and documented (in `docs/DECISIONS.md`) before collection begins.

## 15. Measured vs. inferred vs. indeterminate

Every result Chase produces falls into exactly one of three categories,
and user-facing output must say which:

- **Measured** — read directly from pose landmarks for this clip (e.g.
  a joint angle at a frame).
- **Inferred** — derived from measured values via a heuristic or model
  (e.g. a detected stroke cycle, a stroke-phase label).
- **Indeterminate** — not knowable from the current input (e.g. true 3D
  rotation from a single 2D camera).

Do not blur these categories. Do not present an inferred result with
the same confidence as a measured one.

## 16. No invented biomechanical conclusions

If the data doesn't support a conclusion, say so — do not round up to a
plausible-sounding one. "Not enough data to generate priorities from
this clip" (the existing fallback text in `generateChaseFeedback()`) is
the correct behavior when evidence is insufficient, and that standard
extends to every future pipeline stage.

## 17. Preserve existing behavior during refactors

Refactors (file splits, module extraction, build-tool introduction) must
not change what the application does, unless a human has explicitly
authorized the behavior change as part of that task. When in doubt,
verify the before/after behavior matches in the browser before treating
a refactor as done.

## 18. Keep documentation current

When architecture changes, update `docs/ARCHITECTURE.md` in the same
PR. When a new phase of `docs/ROADMAP.md` begins or its scope changes,
update it in the same PR. When an architectural decision is made,
record it in `docs/DECISIONS.md` in the same PR it was decided in.
Documentation drift is treated as a bug.

Before modifying documentation, ensure the underlying change being
documented has already been explicitly authorized; documentation must
never be used to implicitly authorize an otherwise restricted
implementation or architectural change.

## Known issues carried from the baseline audit

These are documented, not yet fixed (fixing them is a future task,
scoped explicitly before work begins — see `docs/ROADMAP.md`):

- The login/sign-up UI calls `loginUser()`, `signupUser()`,
  `showLogin()`, `showSignup()`, `closeLoginModal()`, and
  `saveUserData()` — none of these functions exist in the codebase.
  The auth flow is currently non-functional.
- Firebase Auth/Database is initialized but not connected to any
  working data path.
- `Chart.js` is loaded unpinned (`@latest`).
