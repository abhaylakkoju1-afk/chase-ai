# Chase AI (Swimtics)

Chase is the swimming-analysis engine inside **Swimtics**
(swimtics.com) — it turns raw swim video into technique feedback. The
long-term goal is evidence-based coaching, not an LLM guessing at a
video:

```
Video → Pose estimation → Temporal tracking → Stroke-phase detection
→ Stroke-cycle segmentation → Biomechanical measurements
→ Technique model → Evidence-based coaching layer → Coach ATLAS
```

**Start here if you're new:** read [`CLAUDE.md`](CLAUDE.md) — it's the
operating contract for anyone (human or Claude Code) working on this
project, and everything below is a summary of what it and `docs/`
cover in full.

## Current state

Chase AI's video-analysis feature is real and working today: upload a
swim clip, and MediaPipe Pose runs entirely in your browser to extract
joint-angle and alignment metrics, detect freestyle stroke cycles, and
generate rule-based coaching observations — all client-side, nothing
uploaded to a server. Alongside it, Swimtics has a personal-best
tracker, a race-timer ("Chronos Engine"), an athlete profile page, and
a training-readiness planner ("War Room").

Two things are **not** what they look like:

- **"Coach ATLAS"** (the floating chat widget) is currently a
  keyword-matching FAQ responder, not connected to any video analysis
  and not an LLM.
- **Login/Sign-up** is currently non-functional — the buttons call
  functions that don't exist in the codebase yet.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full current
architecture and pipeline, and [`docs/DECISIONS.md`](docs/DECISIONS.md)
for why these are tracked as known issues rather than fixed silently.

## How the repository is organized

```
chase-ai/
├── index.html          # the entire application today: markup, CSS,
│                        # and JS all inline — no build step, no backend
├── CNAME                # GitHub Pages custom domain (swimtics.com)
├── bg.mp4, entry-bg.png, fire.gif, favicon.png   # media assets
├── CLAUDE.md            # operating contract for Claude Code sessions
└── docs/
    ├── ARCHITECTURE.md          # current + target architecture, pipeline
    ├── ROADMAP.md               # phased build-out plan
    ├── DEVELOPMENT_WORKFLOW.md  # branches, commits, PRs, CI, review
    └── DECISIONS.md             # architectural decisions + rationale
```

There is currently one file doing everything (`index.html`) —
modularizing it is a planned, explicitly-scoped future task (see
`docs/ROADMAP.md`, Phase 2), not something to do incidentally while
working on something else.

## Current limitations

- Single 12,000+ line HTML file: no modules, no build tooling, no
  automated tests, no CI.
- All measurements are 2D, single-camera proxies — not 3D, not force
  measurements, and not validated against any labeled ground truth yet.
- Stroke-cycle detection only exists for freestyle.
- Firebase (Auth + Realtime Database) is configured but not wired to
  any working feature; real data lives only in browser `localStorage`.
- No evaluation dataset or harness exists yet for any detection or
  measurement logic.

Full detail: the baseline audit referenced throughout `docs/`.

## Development workflow

Work happens on task branches, goes through PR review, and requires
explicit human approval before merging to `main` — `main` is protected
and is what GitHub Pages serves live. See
[`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md) for the
full process, and [`CLAUDE.md`](CLAUDE.md) for what an autonomous
Claude Code session may and may not do without asking first.

## Roadmap

Infrastructure → Testing → Modularization → Evaluation infrastructure →
Pose/tracking improvements → Stroke-phase detection → Cycle
segmentation → Biomechanical measurements → Technique models →
Evidence-based coaching → ATLAS integration → Autonomous
experimentation.

Full detail, including why the order matters, is in
[`docs/ROADMAP.md`](docs/ROADMAP.md).
