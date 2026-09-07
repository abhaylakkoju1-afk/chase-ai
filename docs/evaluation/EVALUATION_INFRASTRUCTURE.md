# Chase Evaluation Infrastructure

**STATUS: INFRASTRUCTURE ONLY — SYNTHETIC FIXTURES — NO REAL PILOT DATA**

This document describes `src/evaluation/` and `test/evaluation/`: the
reusable machinery for comparing human ground truth against detector
predictions. It does not describe a benchmark result, because none
exists yet.

## What this infrastructure does

- Defines plain, serializable data contracts (`src/evaluation/contracts.js`)
  for clip metadata, human ground-truth events/cycles, detector
  predictions, evaluation configuration, evaluation results, and
  experiment/version records — consistent with the field names in
  `docs/evaluation/ANNOTATION_PROTOCOL_V0.1.md` §4, §8, and §17.
- Implements a pure, deterministic one-to-one event matcher
  (`src/evaluation/matching.js`) that pairs predicted timestamps with
  ground-truth timestamps within an explicit tolerance.
- Implements independent evaluation-metric primitives
  (`src/evaluation/metrics.js`): true/false positive/negative counts,
  precision, recall, F1, cycle-count error, and boundary timing error
  (plus a distribution summary of timing error).
- Wires matching and metrics together for one clip
  (`src/evaluation/evaluate.js`) into a single `EvaluationResult`.
- Bundles multiple clips' `EvaluationResult`s into one dataset-level
  `ExperimentRun` (`createExperimentRun()`, `src/evaluation/contracts.js`)
  and pools their counts into one precision/recall/F1
  (`aggregateEvaluationResults()`, `src/evaluation/aggregate.js`) — see
  "EvaluationResult vs. ExperimentRun" below.
- Is exercised end-to-end today only by synthetic, hand-constructed
  timestamp fixtures (`test/evaluation/fixtures.js`), covering the
  matcher/metrics' mechanical edge cases.

## What this infrastructure does NOT do

- It does not collect, download, generate, or reference any real swim
  video or real swimmer data. Every clip/swimmer/annotator identifier
  anywhere in `src/evaluation/` and `test/evaluation/` is a
  `SYNTHETIC-*` placeholder string.
- It does not call MediaPipe, `chaseDetectFreestyleCycles`, the DOM, or
  Firebase. It has no dependency on the browser app or the production
  pipeline (`src/chase-engine/`) — it only consumes plain arrays of
  timestamps and plain config objects supplied by the caller.
- It does not choose, recommend, or hard-code a benchmark tolerance.
  There is currently **no approved tolerance** — see "Why no final
  tolerance is defined" below.
- It does not produce, imply, or store any claim about Chase's
  real-world detection accuracy. No benchmark has been run; none of
  this code has ever touched a real clip.
- It does not build an annotation tool, a dashboard, a database, or any
  persistence layer. `createExperiment()` and `createExperimentRun()`
  only shape a reproducibility record in memory — nothing writes either
  one to disk or a service.
- It does not modify `docs/evaluation/ANNOTATION_PROTOCOL_V0.1.md`,
  the stroke-cycle detector, or any production contract in
  `docs/ARCHITECTURE.md` §2.4.

## No real clips exist yet

As of this writing, the 5-clip pilot described in
`ANNOTATION_PROTOCOL_V0.1.md` §13 has not been collected. All tests in
`test/evaluation/` run exclusively against synthetic fixtures
(`test/evaluation/fixtures.js`), each of whose exported constants is
prefixed `SYNTHETIC_` specifically so it can never be mistaken for real
pilot data by a future reader or a future PR diff.

## How ground truth is kept independent from predictions

`src/evaluation/contracts.js` defines `createGroundTruthEvent()` and
`createDetectorPrediction()` as two entirely separate factory
functions producing two differently-shaped objects — there is no
shared mutable object, and no field on one type doubles as a field on
the other. `matchEvents()` (`src/evaluation/matching.js`) then treats
its two timestamp-array inputs symmetrically but never merges them
into one structure; the distinction between "what a human annotated"
and "what the detector predicted" survives all the way through to the
`EvaluationResult`, which reports `matches` (which prediction paired
with which ground-truth index) rather than a single unified event list.

## How predictions enter the evaluator

The evaluator receives predictions purely as data: an array of
millisecond timestamp numbers (optionally wrapped in a
`DetectorPrediction` record for provenance/metadata). `matchEvents()`
and `evaluateClip()` have no code path that calls a detector, opens a
video, or reads a file — whatever produced the timestamps (a real
detector run, a hand-written fixture, a future replay harness) is
entirely the caller's concern and is invisible to this module. This is
what lets real detector output be fed in later without changing any
evaluation code.

## EvaluationResult vs. ExperimentRun

Two distinct scopes exist, and they are represented by two distinct
contracts:

- **`EvaluationResult`** (`createEvaluationResult()`) — the outcome for
  **one clip**, produced by `evaluateClip()`. It carries that clip's
  matches, unmatched indices, TP/FP/FN counts, and precision/recall/F1.
- **`ExperimentRun`** (`createExperimentRun()`) — **one dataset run**:
  references exactly one `EvaluationConfig` (`config`) and contains an
  array of `EvaluationResult`s (`results`), one per clip evaluated
  under that config, plus `experiment_id`, `created_at`, and optional
  `notes`.

`ExperimentRun` does **not** re-declare `dataset_version`,
`annotation_version`, `evaluation_version`, `detector_commit`,
`event_type`, or `matching_tolerance_ms` as its own fields — those live
exactly once, on `config`. This is a deliberate difference from the
older `createExperiment()` contract (still present, unchanged, and not
reshaped by this addition), which does re-declare that tuple as its
own top-level fields; `createExperimentRun()` is the forward-looking
shape going forward specifically to avoid that duplication.

`src/evaluation/aggregate.js`'s `aggregateEvaluationResults()` pools
TP/FP/FN across an `ExperimentRun`'s `results` and recomputes
precision/recall/F1 from the pooled totals using the same
`precision()`/`recall()`/`f1Score()` primitives each clip already
uses — this is **micro-averaging across events**, not an average of
each clip's own F1 score, and it introduces no new metric or
weighting scheme.

Neither `ExperimentRun` nor its aggregation writes anything to disk —
no persistence layer exists yet for either contract (see "What this
infrastructure does NOT do" above).

## How versions are recorded

`createExperiment()`, `createExperimentRun()` (via its `config`), and
`createEvaluationConfig()` together capture the exact version tuple
`ANNOTATION_PROTOCOL_V0.1.md` §17 requires for any reported result to
be attributable: `dataset_version`, `annotation_version`,
`evaluation_version`, and `detector_commit`. No function in this
module infers or defaults any of these — a caller must supply all four
explicitly, every time. Specifically:

- **`evaluation_version`** is a manually-versioned string (e.g.
  `"eval-v0"`), bumped by hand whenever the matching/metrics
  *definitions* meaningfully change — the same convention already used
  for `protocol_version` in `ANNOTATION_PROTOCOL_V0.1.md`. It is not
  derived from git, and this module never shells out to git or reads
  repository state to generate it.
- **`dataset_version`** names an immutable snapshot of a clip set. A
  version string always refers to the same fixed set of clips; adding,
  removing, or replacing a clip requires a new `dataset_version`, never
  editing the meaning of an existing one in place.
- **`detector_commit`** identifies the exact commit of the detector
  code (`src/chase-engine/`) that produced the predictions being
  evaluated — supplied by the caller, not derived automatically.

## How tolerance is supplied

`matchEvents(predictedTimestampsMs, groundTruthTimestampsMs, toleranceMs)`
takes tolerance as a required, explicit parameter with no default. The
matching rule is documented in `src/evaluation/matching.js`: a
candidate pair matches if `|prediction - groundTruth| <= toleranceMs`
(inclusive at the boundary), matched globally by nearest-first greedy
assignment, one-to-one. `createEvaluationConfig()` similarly requires
`matching_tolerance_ms` as a real, validated (non-negative, finite)
number — omitting it throws, rather than silently falling back to any
value.

## Why no final tolerance is currently defined

`ANNOTATION_PROTOCOL_V0.1.md` §14 is explicit that no tolerance can be
chosen responsibly before real double-annotated pilot data exists to
show natural inter-annotator timing variability. This infrastructure
enforces that at the code level: there is no constant, default
parameter, or fallback value anywhere in `src/evaluation/` that could
be mistaken for an approved tolerance. `test/evaluation/fixtures.js`'s
`SYNTHETIC_TOLERANCE_MS` exists only to give the synthetic mechanical
tests something to check tolerance-boundary behavior against, and is
named and commented specifically to prevent it from being reused
outside tests.

## What must wait until the real pilot exists

- Choosing an actual `matching_tolerance_ms` for the benchmark.
- Populating any `ClipMetadata`, `GroundTruthEvent`, or
  `DetectorPrediction` record with real values.
- Running `evaluateClip()` against real detector output and real
  annotations, and recording the result via `createExperiment()`.
- Any claim, in this repository or elsewhere, about Chase's real-world
  stroke-cycle detection accuracy — none is authorized by this
  infrastructure existing.
- Selecting which of the candidate metrics in
  `ANNOTATION_PROTOCOL_V0.1.md` §15 (precision/recall/F1, cycle-count
  error, boundary timing error, or others) becomes part of the final
  benchmark definition — that decision happens after pilot review
  (§20), not here.
