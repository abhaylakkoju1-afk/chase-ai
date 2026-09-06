# Decisions

A running log of architectural and process decisions, in the order they
were made. Each entry records the decision, the reasoning, and any
consequence it places on future work. Append new decisions here — do
not delete or silently edit old ones; if a decision is reversed, add a
new entry that supersedes it and say so explicitly.

Entries below are dated to the infrastructure phase kickoff
(2026-09-06), following the read-only baseline audit of
`chase/infrastructure` @ `5c456c0`.

---

## D1 — `main` is protected

**Decision:** No direct pushes to `main`. All changes land via PR from a
task branch, reviewed and approved by a human before merge.

**Why:** Prior history is a single author committing directly to
`main`, which is served live by GitHub Pages — every commit shipped to
production immediately with no review gate. That's an acceptable risk
for a solo hobby project; it is not acceptable once autonomous sessions
are contributing code.

**Consequence:** Branch protection must be enabled on `main` in GitHub
settings (a human/repo-admin action, not something this repo's files
can enforce alone). See `docs/DEVELOPMENT_WORKFLOW.md`.

---

## D2 — No direct autonomous production pushes

**Decision:** An autonomous Claude Code session never merges its own PR
and never pushes to `main`, regardless of confidence level or how small
the change appears.

**Why:** swimtics.com is a live product. The cost of a bad autonomous
merge (broken page, exposed misconfiguration, regressed feature) is
asymmetric with the cost of waiting for a human to click merge.

**Consequence:** Every PR, including documentation-only ones like this
task, waits for explicit human approval before merging.

---

## D3 — Chase becomes a separately testable engine

**Decision:** Split the codebase into an app shell (existing product
surface, behavior preserved) and a Chase engine (biomechanics pipeline,
new) connected by a stable interface, rather than growing the pipeline
inside the current monolithic `index.html`.

**Why:** The baseline audit found the entire application in one
~12,000-line file with no module boundaries and no tests. Continuing to
add roadmap phases (pose tracking, phase detection, cycle segmentation,
technique models) directly into that file would make it unreviewable
well before reaching a technique model, let alone Coach ATLAS.

**Consequence:** See `docs/ARCHITECTURE.md` §2.1 for the shape of the
split, and `docs/ROADMAP.md` Phase 2 for when it happens. This decision
does not, by itself, authorize starting the refactor — that's a
separate, explicitly scoped task.

---

## D4 — Coaching must remain evidence-bound

**Decision:** Every coaching statement Chase produces, now and in every
future phase, must be traceable to a specific measurement produced by
the pipeline for that clip. A coaching rule may only fire when its
underlying stat actually has data.

**Why:** The existing `CHASE_COACHING_RULES` / `generateChaseFeedback()`
pattern already does this well and is unusually disciplined for the
codebase's current maturity — it's worth locking in as a permanent
requirement rather than something that erodes as the system grows more
"AI-like."

**Consequence:** See `CLAUDE.md` §6. This applies to Coach ATLAS too,
once it's connected to real pipeline output (Roadmap Phase 10).

---

## D5 — LLMs must not originate technique judgments from raw video

**Decision:** If an LLM is ever added anywhere in Chase (including
Coach ATLAS), its role is restricted to phrasing/summarizing structured
output the pipeline already produced (`TechniqueReport`). It must never
be given raw video or raw pose frames and asked to judge technique
directly.

**Why:** This is the explicit, stated purpose of building a real
pipeline at all — the roadmap exists specifically so Chase does not
become "an LLM looks at a swimming video and guesses technique." The
existing ATLAS chat widget (keyword-matched canned coaching text) is a
small-scale preview of the failure mode this decision prevents: text
that sounds like grounded coaching advice but isn't tied to any
measurement of the athlete in question.

**Consequence:** Any future ATLAS/LLM integration PR must show, in its
description, exactly which structured pipeline output it consumes and
confirm it never receives raw video/frames.

---

## D6 — Measured vs. inferred vs. indeterminate must remain distinct

**Decision:** Every result Chase surfaces is tagged as one of: measured
(read directly from pose data), inferred (derived via a heuristic or
model), or indeterminate (not knowable from the current input). This
distinction must be visible in user-facing output, not just internal
comments.

**Why:** `generateChaseFeedback()` already does this in its "Confidence
& Limitations" section. It's a genuinely good pattern found in the
audit and worth codifying so it survives refactors and new
contributors rather than eroding over time.

**Consequence:** See `CLAUDE.md` §15 and the `BiomechMeasurement`
contract in `docs/ARCHITECTURE.md` §2.4, which carries this tag
explicitly.

---

## D7 — Evaluation infrastructure must exist before training technique models

**Decision:** No technique model is trained or shipped until a labeled
evaluation dataset and scoring harness exist (`docs/ROADMAP.md` Phase
3), even a small one.

**Why:** The baseline audit found zero labeled ground truth and zero
evaluation harness anywhere in the project. Training or shipping a
model before that exists risks confident-sounding but unvalidated
technique feedback — a credibility and safety risk for a coaching
product.

**Consequence:** Roadmap Phase 8 (technique models) explicitly depends
on Phase 3. A PR proposing a technique model without referencing an
evaluation result is out of process.

---

## D8 — Single-camera limitations must be explicitly represented

**Decision:** Every current and future measurement must state, in its
own output, what camera/sensor assumption it depends on and what it
cannot determine as a result (e.g. true 3D rotation from one side-view
camera).

**Why:** Today's 7 metrics are 2D single-camera proxies, and the
existing code already discloses this ("cannot be determined from this
camera angle..."). This is a real, structural limitation of the current
input, not a temporary gap — it must stay visible rather than get
smoothed over as the system appears more sophisticated.

**Consequence:** Whether to require multi-angle/underwater footage
instead of single-camera 2D is a separate, still-open decision (flagged
in `docs/ROADMAP.md` Phase 7) — this decision only requires that
whichever assumption is in force be stated explicitly.

---

## D9 — Existing working functionality must be preserved during refactoring

**Decision:** Modularization, build-tool introduction, and any other
structural refactor must not change what the application does, unless a
human has explicitly authorized that specific behavior change as part
of the task.

**Why:** The product is live and in use. Refactoring is infrastructure
work with zero user-visible benefit if it also silently breaks
something — the value of a refactor is entirely in what it enables
later, not in anything a user can see today.

**Consequence:** Refactor PRs must show before/after parity (tests
where they exist, manual in-browser verification otherwise) rather than
just "the new structure works."
