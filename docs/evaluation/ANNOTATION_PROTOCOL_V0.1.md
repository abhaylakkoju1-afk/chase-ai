# Chase AI — Freestyle Cycle Annotation Protocol

**STATUS: DRAFT / PILOT PROTOCOL**
**VERSION: v0.1**
**NOT FINAL BENCHMARK SPECIFICATION**

This document is a proposal. Nothing in it has been implemented, and nothing
in it overrides `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, or
`docs/DECISIONS.md`. Where this protocol touches a decision already recorded
in `docs/DECISIONS.md` (D6, D7, D8), it follows that decision rather than
restating or reinterpreting it. Any conflict between this document and an
existing decision record should be treated as an error in this document, not
as an implicit amendment to that record.

---

## 1. Purpose

Chase AI's freestyle stroke-cycle detector (`chaseDetectFreestyleCycles`,
`src/chase-engine/stroke-cycles.js`) has never been evaluated against
real, human-labeled video. `docs/ROADMAP.md` Phase 3 ("Evaluation
infrastructure") and `docs/DECISIONS.md` D7 both require exactly this
before any technique model is trained — this document is the first
concrete step toward that requirement, not the requirement's fulfillment.

This is **Version 0.1**, and it is a **pilot protocol**, not the final
benchmark specification. Its purpose is narrow and deliberate: produce a
small amount of independent ground truth, and use it to measure — not
assume — the temporal relationship between two candidate stroke-cycle
boundary events, before any benchmark tolerance, metric, or dataset size
is frozen. A protocol written before any real annotation has happened is
necessarily provisional; this one is designed to be revised based on what
the pilot actually shows, per the decision gate in Section 20.

Per `CLAUDE.md` §16 ("No invented biomechanical conclusions") and D6
("measured vs. inferred vs. indeterminate must remain distinct"), this
protocol is written to avoid presupposing an answer to the question it
exists to investigate.

## 2. Current Evaluation Question

The initial evaluation question this protocol serves:

> How accurately does the current freestyle cycle detector identify
> meaningful stroke-cycle boundaries in side-view, above-water freestyle
> video?

This question has **not** been scientifically validated by anything in
this repository to date. No prior evaluation, benchmark, or accuracy
figure exists for Chase's stroke-cycle detector against real video
(confirmed by inspection: `test/stroke-cycles.test.js` exercises the
detector's algorithmic logic against synthetic, hand-constructed arrays
only — a valid regression check, but not evidence of real-world
accuracy). This protocol produces the first material that could
eventually answer the question above; it does not answer it by itself.

## 3. Dataset Scope

For this pilot, and for the benchmark it leads toward, the intended
scope is:

- Freestyle only.
- Side-view camera (roughly perpendicular to the direction of swimming).
- Above-water footage only.
- Single camera (no multi-camera or synchronized-view setups).
- Reasonably stable footage (a fixed or slowly-panning camera, not
  extensive handheld motion).
- Competitive or club-level swimming, where individual stroke cycles are
  visually observable at a normal viewing distance.

**This scope does not permanently constrain the long-term Chase
architecture.** `docs/DECISIONS.md` D8 explicitly leaves open whether
Chase eventually requires multi-angle or underwater footage; this
protocol's narrow scope is a pilot-sizing choice, not a resolution of
D8. Backstroke, breaststroke, butterfly, underwater capture, and
multi-camera setups remain out of scope for this pilot specifically,
not out of scope forever.

## 4. Participant / Clip Identification

Every clip and swimmer is identified only by an anonymized identifier:

- `swimmer_id` — an opaque identifier (e.g. `SWIMMER-003`), never a real
  name, assigned once per participant and reused across all of that
  participant's clips.
- `clip_id` — an opaque identifier (e.g. `CLIP-014`), unique per clip.

No other personally identifying information is part of the evaluation
dataset itself. If a mapping from `swimmer_id` to a real identity is
ever needed (e.g. to honor a withdrawal request, or to confirm consent
is still valid), that mapping **must be stored separately** from the
evaluation dataset, access-controlled independently of it, and never
committed alongside clips, annotations, or metrics.

## 5. Privacy and Consent

These are stated as **project requirements and principles**, not as
legal conclusions. Swimmers in this dataset may include minors;
applicable institutional and legal guidance must be sought and followed
before any video is collected, and nothing below substitutes for that.

Minimum project requirements:

- **Informed consent** must be obtained from each participant (and, for
  minors, from a parent/guardian, subject to institutional/legal
  confirmation of what form that consent must take) before any footage
  of them is recorded or used for evaluation purposes.
- **Institutional considerations**: any club, school, or facility policy
  governing athlete media must be checked and followed; this protocol
  does not assume none exists.
- **Private storage only.** Raw video is stored in a private, access
  controlled location. Raw swimmer footage is **never** stored in this
  public GitHub repository, in any commit, branch, or artifact — this
  repository is public, and committing video would be an irreversible
  public disclosure.
- **No third-party AI/video processing without explicit human
  approval.** This follows `CLAUDE.md` §14 directly: athlete video is
  never transmitted to a third-party API, including any LLM or hosted
  ML provider, without explicit human approval and a documented reason.
- **Consent is scope-specific and non-transferable between scopes.**
  Consent to private evaluation/development use is a **separate**
  question from consent to public demonstration, portfolio, or
  application-material use. A participant consenting to one has not
  thereby consented to the other; both must be recorded independently,
  and only the scope actually consented to may be used.
- **Retention and deletion**: a retention period should be agreed with
  each participant at the time of consent, rather than assumed to be
  indefinite.

Where this protocol is silent or uncertain on a privacy/legal point, the
correct action is to pause and seek institutional/legal guidance before
proceeding — not to infer an answer from this document.

## 6. Annotation Events

This pilot defines **two** candidate events. Establishing which one (or
whether both, or neither, or some combination) is the right benchmark
boundary is the pilot's job — not a premise of this protocol.

**A. Hand-entry event — tentatively the literature-aligned candidate.**
Freestyle biomechanics literature commonly organizes the stroke cycle
around the moment a hand enters the water ahead of the shoulder,
beginning the catch phase. This event is included *because* it is the
more literature-grounded candidate, not because it has been confirmed
as observable, reliable, or superior in this dataset — that
confirmation is exactly what the pilot is for.

**B. Wrist-height-minimum event — the current detector's event.**
`chaseDetectFreestyleCycles` currently detects a local **minimum** in
`metricsHistory.wristMinY`. That signal is computed independently on
each frame as the minimum (i.e. highest-in-frame) y-coordinate among
whichever wrist landmarks are currently visible — it does not track a
persistently identified left or right "recovery arm" across frames,
only whichever wrist happens to be higher at that instant. A local
minimum in this signal corresponds to a wrist reaching its highest
point above the water at that instant, *not* hand entry. This protocol
does **not** assert that this event is "peak recovery" as an
established biomechanical term, and does **not** assert that it is
temporally identical to, or a reliable proxy for, hand entry. It is
simply the event the current production code actually computes,
described operationally.

Labeling these as "A" and "B" is presentational only. Neither ordering
nor naming implies that one event is more correct, more important, or
more likely to become the eventual benchmark boundary than the other —
see the pilot questions this section exists to answer, below.

The pilot exists to determine, and not to assume in advance:

- whether each event is reliably observable by a human annotator from
  the available footage;
- what temporal relationship (if any consistent one) holds between the
  two events, per cycle;
- whether one, both, or neither event is suitable as a benchmark
  boundary going forward;
- how much annotator disagreement or visual ambiguity exists for each
  event.

## 7. Cycle Boundary Definition

Annotators need an operational definition that can be applied
consistently to real footage — not an abstract biomechanical
description. The definitions below favor visible, checkable criteria.

**Event A — Hand-entry event:**
The video frame in which the leading hand first breaks the water's
surface, forward of the shoulder, at the start of the extension/catch
phase. Mark the timestamp of that frame.

*This definition is provisional pending pilot review.* It has not been
validated against this project's specific camera angle, distance, or
frame rate, and the literature review behind this protocol did not
establish a frame-level operational standard — only the general
biomechanical event. If pilot annotators find this definition
ambiguous, inconsistent, or inapplicable to the actual footage, that is
a pilot finding to record (Section 19), not a defect to silently work
around by inventing a stricter rule mid-pilot.

**Event B — Wrist-height-minimum event:**
The video frame in which whichever wrist is currently visible reaches
its highest point above the water's surface, immediately before it
begins descending — matching what `chaseDetectFreestyleCycles` actually
computes from `metricsHistory.wristMinY` (a frame-by-frame minimum
y-coordinate among visible wrists, with no persistent left/right arm
identity tracked across frames). Mark the timestamp of that frame.

*This definition is also provisional.* "Highest point" can be genuinely
ambiguous over 2-3 adjacent frames when the wrist's vertical motion is
near its peak and changing slowly; annotators should use the confidence
field (Section 8) to record this rather than force artificial precision.

Where either definition proves impossible to apply consistently during
the pilot, the correct response is to flag it as an open question
(Section 19) for protocol revision — not to redefine the event
unilaterally mid-annotation.

## 8. Annotation Label Structure

The structure below is a **proposal**, not an implemented schema. No
file format, parser, or storage mechanism exists yet for this data (a
repository-wide check confirms no evaluation/dataset code or files
currently exist). Field names, types, and nesting are all open to
revision once real annotation is attempted.

Per-event annotation, minimum fields:

- `clip_id`
- `swimmer_id`
- `stroke` (freestyle, for this pilot)
- `event_type` (`hand_entry` | `wrist_min`)
- `timestamp_ms`
- `confidence` (e.g. `clear` | `ambiguous`)
- `ambiguous` (boolean, redundant with but distinct from `confidence`
  for filtering convenience — exact relationship between these two
  fields is left open for pilot review)
- `unusable_interval` (reference to an excluded time range, if this
  event falls inside one — see Section 9)
- `annotator_id`
- `protocol_version` (e.g. `v0.1`)

Per-cycle annotation, additional fields (a cycle is defined by a pair of
same-type events bounding it):

- `cycle_id`
- `start_event` (reference to the event record marking the cycle's start)
- `end_event` (reference to the event record marking the cycle's end)

A single clip is expected to have **two independent sets** of cycle
annotations under this protocol — one built from `hand_entry` events,
one from `wrist_min` events — since the pilot's purpose is to compare
them, not to merge them into one "official" cycle list.

**This proposed schema is explicitly distinguished from any production
data structure.** It has no relationship to `metricsHistory` or to
`chaseDetectFreestyleCycles`'s current return shape (`{cycleNumber,
durationMs, strokeRatePerMin, elbowMean, elbowStdDev, sampleCount}`) —
that is production output, described and assessed separately in the
Phase 2/3 architecture research; this section describes only a proposed
human-annotation record.

## 9. Ambiguity Handling

Annotators must not invent a timestamp when an event cannot be reliably
determined. Specific cases:

- **Hand entry obscured** (e.g. by the opposite arm, by glare, or by
  camera framing): mark the event as `ambiguous`, and record a best-
  estimate timestamp only if a reasonably narrow range is visible;
  otherwise, omit the timestamp and note why.
- **Splash obscures the event**: same handling — `ambiguous` with a
  best-estimate range if one exists, omission if it doesn't.
- **Swimmer leaves the frame**: the affected interval is marked as an
  `unusable_interval` (start/end time, reason), and no events are
  annotated inside it.
- **Camera movement prevents reliable judgment**: same as above — mark
  the affected interval `unusable_interval` rather than annotating
  through it.
- **Multiple plausible timestamps for the same event**: record the
  range considered plausible (e.g. earliest and latest candidate frame)
  rather than picking one arbitrarily and presenting it as certain.
- **Partial cycle** (at a clip's start/end, or adjacent to an unusable
  interval): mark the boundary event(s) that exist, but do not
  construct a `cycle_id` for a cycle that is missing one of its two
  bounding events. Partial cycles are excluded from cycle-level
  annotation, not force-completed.

The guiding rule: an annotator recording "I could not determine this"
is a valid, useful, and expected outcome — not a failure of the
protocol.

## 10. Annotator Procedure

Proposed manual workflow for one clip:

1. View the full clip once, at normal speed, without annotating, to
   identify overall usable vs. unusable intervals (occlusion, swimmer
   out of frame, camera cuts, turns/walls).
2. Record `unusable_interval` entries for anything identified in step 1.
3. Within usable intervals, annotate **Event A (hand entry)**
   independently, frame-stepping as needed, recording `confidence` and
   `ambiguous` per event per Section 9.
4. Separately, annotate **Event B (wrist-height minimum)** independently
   — as its own pass, not interleaved with step 3, so identifying one
   event does not anchor or bias identification of the other.
5. Construct cycle-level records (`cycle_id`, `start_event`,
   `end_event`) separately for each event type, per Section 8.
6. Record `annotator_id` and `protocol_version` on the completed
   annotation set.

**Independence from Chase's predictions is required wherever
practical.** The annotator performing the primary ground-truth pass
must not have access to `chaseDetectFreestyleCycles`'s output for a
clip while annotating it. This protocol is deliberately structured so
that an annotator cannot simply confirm Chase's existing output:
annotation happens directly from raw video, both event types are
annotated on their own merits against the operational definitions in
Section 7, and nothing in this workflow involves viewing or comparing
against algorithm output before or during labeling. Any deviation from
this blinding (e.g. an annotator who has previously seen Chase's output
for a specific clip) must be recorded as a limitation of that
annotation, not silently treated as equivalent to a blinded one.

## 11. Double Annotation Pilot

Approximately **20%** of pilot material should receive independent
double annotation — a second annotator labeling the same clips, under
the same protocol, without access to the first annotator's labels.

This is useful because it is the only way to distinguish "the event is
genuinely hard to pin down" from "one annotator's personal judgment" —
without it, apparent precision in a single annotator's labels could be
consistency with themselves, not accuracy.

What should be measured from the double-annotated subset: for each
event type independently, the timing difference between the two
annotators' matched events (e.g. mean/median/spread of the offset), and
a boundary-agreement measure (such as how often the two annotators'
events fall within a shared, to-be-determined window of each other —
see Section 14, since this connects directly to tolerance selection).

**No specific acceptable-agreement threshold is defined here** — doing
so before seeing any real double-annotated data would be arbitrary.
Section 19 records this as an open question the pilot must inform.

Disagreements should be adjudicated by a third reviewer where
practical; where that isn't practical at pilot scale, a disputed event
may simply be **retained as uncertain** (flagged, both annotators'
values recorded) rather than artificially forced into agreement by
averaging, overwriting one annotator's value, or silently picking one.
Manufacturing agreement would defeat the purpose of double annotation.

## 12. Pilot Dataset Size

Two different scales are in play, and they must not be conflated:

- **Eventual benchmark target** (not this pilot): approximately 8-10
  swimmers, 25-30 clips, 200-300 cycles, with approximately 20% double
  annotation.
- **This initial protocol pilot** (Section 13): a much smaller set,
  intended only to validate the protocol itself before that larger
  effort begins.

**These numbers are directional planning figures, not statistically
validated requirements.** No power analysis or formal sample-size
justification underlies them; they reflect what is realistic for a
student-led effort while still producing a real, honestly-reported
first measurement, consistent with the dataset-size discussion in the
project's Phase 3 research review. Treat them as a starting plan to be
revisited after the pilot, not a fixed target.

## 13. Pilot Design

Recommend approximately **5 representative clips** for this first
protocol pilot, subject to human review and adjustment before use.
Five is intentionally small: the goal is to test whether the *protocol*
works — whether the event definitions are applicable, whether
annotators can follow the procedure, whether the label structure is
usable — not to produce a statistically meaningful accuracy number yet.

The pilot clips should be chosen to intentionally expose different
conditions, without overengineering the selection:

- at least one clip with clear, unobstructed visibility;
- at least one clip with noticeable splash/occlusion;
- clips spanning more than one swimmer skill level, if accessible;
- modest camera variation (e.g. slightly different distance or framing
  between clips), without deliberately seeking out extreme or unusual
  conditions.

Five clips covering these conditions is sufficient for a protocol
pilot; a larger, systematically-stratified selection belongs to the
eventual benchmark construction (Section 12), not to this step.

## 14. Tolerance Window

**No temporal tolerance value is fixed by this protocol.** The final
tolerance window used for benchmark matching must be selected only
after pilot data exists, informed by what that data actually shows
about:

- natural inter-annotator timing variability (Section 11) for each
  event type, and
- the observed temporal relationship between hand entry and the
  wrist-height minimum (Section 6's core open question).

Once pilot data exists, candidate tolerance windows should be evaluated
against it (e.g., comparing how matching results change across a few
candidate values) rather than a single value being asserted in advance.
No specific candidate values are proposed here, to avoid anchoring the
eventual decision before any real data has been seen.

## 15. Benchmark Metrics

The following are **candidate** metrics, not a final, frozen benchmark
definition. Final metric definitions are to be determined after pilot
review (Section 20).

**Primary candidate:** tolerance-window precision/recall/F1 for
one-to-one event matching between predicted and ground-truth events (or
cycles) — each predicted event matched to at most one ground-truth
event within the eventual tolerance window (Section 14), and vice
versa.

**Secondary candidates:**
- precision
- recall
- cycle-count error (predicted vs. ground-truth cycle count per clip)
- boundary timing error (the distribution of offsets between matched
  predicted and ground-truth events)
- stroke-rate error (derived from matched cycle boundaries)

No metric here is designated as the sole final measure. In particular,
per-clip and per-condition results (Section 13's varied conditions)
should always be retrievable alongside any aggregate number, so a
single score cannot obscure failure on a specific condition.

## 16. Dataset Splitting

Any future train/evaluation/test split of this data must be performed
**by swimmer**, not merely by clip. If two clips from the same swimmer
end up on both sides of a split, a system (learned or otherwise) can
appear to perform better than it would on an unseen swimmer, simply by
having implicitly captured that individual's stroke style — this is a
leakage risk regardless of whether a model is actually being trained
yet. This protocol does not implement any split; it only records the
requirement for whenever one is constructed.

## 17. Versioning and Reproducibility

The following identifiers must be recorded together whenever any
benchmark result or comparison is reported, so results remain
attributable and comparable:

- **Dataset version** — exactly which clips (by `clip_id`) are included.
- **Annotation protocol version** — this document's version (`v0.1`,
  and successors).
- **Annotation version** — which specific annotation pass(es) produced
  the ground truth used (an annotator may re-annotate; each pass is its
  own version).
- **Evaluation definition/version** — the exact tolerance window and
  metric definitions (Sections 14-15) in force at the time, once those
  are finalized past this draft stage.
- **Detector commit/version** — the exact git commit of
  `chaseDetectFreestyleCycles` (and its dependencies, e.g.
  `summariseMetric`) being evaluated.

A benchmark comparison that cannot cite all five of these for both
sides of the comparison is not a valid comparison under this protocol.

## 18. Integrity Safeguards

These safeguards apply to this protocol and to any evaluation work
built on it, including future autonomous experimentation:

- Ground truth cannot be silently rewritten. Any correction or
  relabeling produces a new annotation version (Section 17); the prior
  version is preserved, not overwritten.
- Annotation changes must be versioned — there is no "in place" edit to
  finalized ground truth.
- Clips cannot be silently removed from the dataset because they
  produce poor or inconvenient results. Removing a clip requires a
  recorded reason, reviewed by a human, not a quiet drop.
- Benchmark definitions (tolerance window, matching rule, metrics)
  cannot change without documentation — a change produces a new
  evaluation version (Section 17), and prior results remain attributed
  to the version under which they were produced.
- Experiments must record their exact configuration — the full version
  tuple in Section 17 — not just a headline score.
- Ground-truth changes require explicit human review before being
  accepted, regardless of who or what proposes them.

These safeguards exist specifically so that neither a human under
deadline pressure nor an autonomous process can improve an apparent
result by adjusting the measurement rather than the system being
measured.

## 19. Open Questions

The 5-clip pilot (Section 13) exists to answer these questions before
Annotation Protocol v1.0 is written. This list is expected to grow, not
shrink, as the pilot proceeds:

- Is hand entry consistently observable from the chosen camera view,
  distance, and typical footage quality?
- Is the current wrist-height-minimum event reliably identifiable by a
  human annotator working from video alone?
- What is the typical temporal offset between the two events, and how
  much does it vary — across cycles, across swimmers, across skill
  levels?
- How much annotator disagreement exists for each event type
  (Section 11), and does it differ meaningfully between the two events?
- Which event, if either, produces more reproducible cycle segmentation
  across annotators?
- Are certain visual conditions (e.g. heavy splash, specific camera
  angles) fundamentally unusable for one or both events, rather than
  merely difficult?
- What tolerance window is actually justified by observed annotation
  variability, once real double-annotated data exists (Section 14)?
- Does the proposed label structure (Section 8) hold up in practice, or
  does it need fields added, removed, or redefined?

## 20. Decision Gate

This protocol is explicitly gated, and the process must not skip ahead
past this gate:

```
Annotation Protocol v0.1 (this document)
        ↓
5-clip pilot (Section 13)
        ↓
Review annotation ambiguity, agreement, and timing relationship
(Section 19's open questions)
        ↓
Revise protocol based on pilot findings
        ↓
Explicit human approval of the revised protocol
        ↓
Annotation Protocol v1.0
        ↓
Construct the larger benchmark dataset (Section 12's eventual target)
```

No benchmark tolerance, ground-truth event definition, or dataset size
in this document is final. All of them are placeholders pending the
pilot, and none should be treated as settled until v1.0 is explicitly
approved through this gate.

## 21. Document Status

**STATUS: DRAFT / PILOT PROTOCOL**
**VERSION: v0.1**
**NOT FINAL BENCHMARK SPECIFICATION**

This document authorizes nothing beyond the pilot process described in
Section 20. It does not authorize collecting video, running a
benchmark, changing `chaseDetectFreestyleCycles`, or amending any
record in `docs/DECISIONS.md`. Revision to v1.0 requires explicit human
approval following pilot review, per Section 20.
