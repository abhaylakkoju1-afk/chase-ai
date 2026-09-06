# Development Workflow

This document defines how work gets done in this repository, for both
human contributors and Claude Code sessions. It implements the rules in
`CLAUDE.md` §8–12 — read that file first.

## Branch strategy

- `main` is the protected, production branch. It is served directly by
  GitHub Pages, so anything merged into it is live on swimtics.com.
- `chase/infrastructure` is the current integration branch for this
  infrastructure phase. Work during this phase happens on task branches
  off `chase/infrastructure` (or off `main`, once this phase merges).
- Task branches are named by what they do, scoped to a single roadmap
  phase or a single clearly-bounded task, e.g.:
  - `chase/docs-foundation`
  - `chase/testing-unit-geometry`
  - `chase/modularize-pose-module`
  - `chase/eval-harness-v1`
- No autonomous session pushes directly to `main`, ever, under any
  circumstance.

## Commits

- Commits should be small and describe *why*, not just *what* — the
  diff already shows what changed.
- Never use `--no-verify`, `--no-gpg-sign`, or otherwise bypass
  configured hooks without explicit human instruction.
- Never force-push or rewrite history on a shared branch.
- Never amend a commit that has already been pushed and reviewed;
  create a new commit instead.

## Pull requests

Every PR should state:

- **What changed** and **why** (link back to the relevant roadmap phase
  or decision if applicable).
- **What tests were added or run**, and their result.
- **What was manually verified in-browser**, if the change touches
  anything a human can observe (UI, pipeline output, coaching text).
- **What was explicitly NOT changed**, when that's non-obvious (e.g. "no
  application behavior changed — this is documentation only").

Scope: one PR per logical unit of work, ideally one pipeline stage or
one infrastructure task. A PR that spans multiple roadmap phases should
be split.

## CI

Once Phase 1 (testing foundation) lands, every PR must pass CI before
it can be merged:

- Build succeeds.
- Lint passes.
- Unit tests pass.
- (Later) fixture-replay pipeline tests pass.

Until CI exists, PRs are reviewed manually with the same bar — a human
runs and verifies the change before approving.

## Code review

- Every PR gets human review before merge, regardless of who or what
  opened it.
- Reviewers check: does this match the scope it claims, does it touch
  only what it says it touches, does it preserve existing behavior
  (unless the PR explicitly says otherwise and that was pre-approved),
  and does it update documentation if it changed architecture.

## Human approval

Per `CLAUDE.md` §10, the following always require explicit human
approval, regardless of how confident an autonomous session is:

- Merging any PR into `main`.
- Any change to production configuration (Pages settings, `CNAME`,
  Firebase config/rules, analytics/tracking setup).
- Any change to existing user-facing behavior.
- Enabling or fixing authentication.
- Adding a new dependency, external service, or paid API.
- Anything touching athlete video/personal data collection or storage.

## Production releases

- A "release" here is simply a merge to `main`, since GitHub Pages
  deploys directly from it. There is no separate release/tag process
  today.
- Before merging to `main`, confirm: CI is green (once it exists),
  human review is complete, and the change has been manually verified
  in-browser if it touches anything user-visible.
- If a merge to `main` turns out to be wrong, the fastest safe recovery
  is a revert PR through the same review process — not a force-push or
  history rewrite.

## Autonomous development boundaries

An autonomous Claude Code session may, without asking first:

- Read, search, and analyze the codebase.
- Create/edit files on a task branch.
- Write and run tests, linters, and local builds.
- Open a PR describing the change.

An autonomous session must stop and ask before:

- Merging anything into `main`.
- Touching production configuration or dependencies.
- Changing existing user-facing behavior.
- Doing anything listed in `CLAUDE.md` §10 or §11.

When in doubt about whether something needs approval, treat it as if it
does.
