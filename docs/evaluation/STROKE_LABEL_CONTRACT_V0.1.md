# Four-Stroke Label Contract and Evaluation Harness

**STATUS: DRAFT CONTRACT v0.1 — SYNTHETIC FIXTURES ONLY — NO REAL LABELS**

| Item | Version string | Code |
|---|---|---|
| Expert label set | `chase.stroke-labels.v0.1` | `src/evaluation/stroke-labels.js` |
| Candidate output set | `chase.stroke-candidates.v0.1` | `src/evaluation/stroke-labels.js` |
| Evaluation config | `chase.stroke-evaluation-config.v0.1` | `src/evaluation/stroke-evaluation.js` |
| Evaluation report | `chase.stroke-evaluation-report.v0.1` | `src/evaluation/stroke-evaluation.js` |

Tests: `test/evaluation/stroke-labels.test.js`,
`test/evaluation/stroke-evaluation.test.js`, fixtures in
`test/evaluation/stroke-fixtures.js` (all `SYNTHETIC-`).

## 1. Purpose

Chase only has a freestyle cycle heuristic today. Backstroke,
butterfly and breaststroke are **research-only**: the analyzer marks
them unsupported and runs no stroke-specific detector for them. This
contract is the next safe step toward stroke-specific analysis. It
defines how expert labels for all four strokes are recorded, and a
deterministic harness that scores any future candidate detector against
those labels per stroke and per camera view. It enables nothing in the
app.

It is additive. It does not change
`docs/evaluation/ANNOTATION_PROTOCOL_V0.1.md` (the freestyle pilot
protocol) or `src/evaluation/contracts.js`, and it reuses the v0.1
matcher (`matchEvents`) and metric primitives unchanged.

## 2. Sources

The required context fields and the per-stroke vocabulary follow the
owner-provided *Elite Competitive Swimming* research paper:

- Chapters 2–5: each stroke's broad phase sequence and what a view can
  and cannot show.
- Chapter 9: the capture protocol (stroke, event, course, pace, camera
  view and position, above/underwater, frame rate), per-frame
  confidence, abstention for occlusion or identity uncertainty, and
  validation against blinded expert annotation with subgroup error.
- Chapter 10: the staged release gates and the rule that freestyle
  capability does not validate other strokes.
- Chapter 15.3: label stroke, distance, course, pace, start/turn
  status and view, and keep an "unknown" state instead of guessing.
- Chapter 17: a separate phase model and confidence rubric per
  stroke, and "not visible" kept distinct from "incorrect".

The vocabulary organizes labels. It does not claim that these events
can be reliably seen in ordinary footage, or that any detector finds
them.

## 3. Privacy rules (CLAUDE.md §13–§14)

- **No footage, frames or media references.** No field holds video,
  images, file paths or URLs, and validation rejects any field that is
  not in the contract.
- **No personal data or free text.** There are no names, contact
  details, ages, dates of birth, sex, team or free-text notes.
  Subgroup attributes that the paper recommends for fairness testing
  (sex, age, level, morphology, skin tone) are **deliberately
  excluded**. Adding any of them needs explicit human approval and a
  consent basis recorded in `docs/DECISIONS.md` first.
- **Opaque references only.** `clip_ref`, `subject_ref`,
  `annotator_ref`, `label_set_id`, `annotation_id` and
  `candidate_id` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Any
  mapping to a real person or file lives outside this repository
  (Protocol v0.1 §4). `subject_ref` exists only so a future split can
  be done by swimmer (Protocol v0.1 §16).
- **Synthetic versus real is enforced.** `data_status: "synthetic"`
  requires the `SYNTHETIC-` prefix on every reference;
  `"expert_labelled"` forbids it. The harness refuses to evaluate the
  two together.
- The harness only reads in-memory objects. It does not collect,
  upload, store or transmit anything. Athlete video stays ephemeral in
  the browser, as today.

## 4. StrokeLabelSet: one clip, all its annotations

```
{
  schema_version: "chase.stroke-labels.v0.1",
  label_set_id, data_status: "synthetic" | "expert_labelled",
  clip: {
    clip_ref, subject_ref,
    stroke: freestyle | backstroke | butterfly | breaststroke,
    duration_ms (> 0), frame_rate_fps (> 0),
    camera: { view, medium, placement, side, motion, distance_m | null },
    pool: { course: SCM | SCY | LCM | unknown, pool_length_m | null },
    segment: { race_segment, pace, event_distance_m | null, lap_index | null }
  },
  annotations: [ {
    annotation_id, protocol_version,
    annotator: { annotator_ref, role, blinded_to_candidates },
    events:  [ { event_id, event_type, side, timestamp_ms | null,
                 timestamp_range_ms | null, certainty,
                 visibility: { status, occluded_landmarks[] } } ],
    phases:  [ { phase_id, phase_label, side, start_ms, end_ms, certainty } ],
    cycles:  [ { cycle_id, start_event_id, end_event_id } ],
    unusable_intervals: [ { start_ms, end_ms, reason } ]
  } ]
}
```

Enumerations:

- `camera.view`: side, front, front_oblique, end_on, overhead, other.
- `camera.medium`: above_water, underwater, split_waterline.
- `camera.placement`: pool_deck, end_wall, in_water, elevated, unknown.
- `camera.side`: swimmer_left, swimmer_right, head_on, behind, above,
  unknown.
- `camera.motion`: static, panning, tracking, handheld, unknown.
- `segment.race_segment`: start, underwater, breakout, clean_swim,
  approach, turn, post_turn, finish, drill, unknown.
- `segment.pace`: easy, moderate, threshold, race_pace, sprint,
  unknown.
- `annotator.role`: coach, biomechanist, trained_annotator,
  adjudicator.
- `certainty`: certain, probable, uncertain.
- `visibility.status`: visible, partially_occluded, occluded,
  out_of_frame.
- `occluded_landmarks`: MediaPipe Pose landmark names.
- `unusable_intervals[].reason`: occlusion, out_of_frame,
  splash_or_bubbles, camera_motion, identity_uncertain, low_light,
  other.

Rules the validator enforces:

- Event types, phase labels and sides must belong to the clip's
  stroke.
- Times must lie within the clip.
- A point timestamp must lie inside its own `timestamp_range_ms`.
- An event with `timestamp_ms: null` is a valid **indeterminate**
  label, but cannot be `certain`.
- A `visible` label lists no occluded landmarks.
- A cycle references two timed events of the same type and side in
  the same annotation, in order.
- IDs are unique.
- There is at least one annotation and at most one adjudicator.
- A known course fixes the pool length (SCM 25 m, SCY 22.86 m,
  LCM 50 m).

**Disagreement and uncertainty** are captured four ways:

- several annotations per clip (with an optional adjudicator);
- per-label `certainty`;
- plausible `timestamp_range_ms`;
- `unusable_intervals` where the annotator declines to label.

## 5. Provisional vocabulary (per stroke)

Sides use `left` or `right` for alternating arm actions, `both` for
simultaneous bilateral actions, and `none` for head or whole-body
events.

| Stroke | Events | Phases |
|---|---|---|
| Freestyle | hand_entry, hand_exit, breath_start (L/R); wrist_height_minimum (none, the current detector's event, Protocol v0.1 §6B); wall_touch | entry_extension, catch, pull, push, recovery (L/R) |
| Backstroke | hand_entry, hand_exit (L/R); wall_touch | entry_extension, catch, pull, push, recovery (L/R) |
| Butterfly | hand_entry, hand_exit, kick_1_downbeat, kick_2_downbeat (both); breath_start (none); wall_touch (both) | entry, catch_pull, push, recovery (both) |
| Breaststroke | arm_outsweep_start, arm_insweep_start, leg_recovery_start, kick_propulsion_start, glide_start (both); head_emergence (none); wall_touch (both) | outsweep_catch, insweep_breath, kick_propulsion, glide (both) |

`wall_touch` records contact timing only. Nothing here judges stroke or
turn legality.

These names are **not** operational definitions. Before real labelling
for a stroke, an approved annotation protocol for that stroke must
define each event's visual criterion, its suitable views, and when to
abstain (see §9).

## 6. StrokeCandidateSet: what a detector claims for one clip

```
{
  schema_version: "chase.stroke-candidates.v0.1",
  candidate_id, data_status, clip_ref, stroke,
  source: { kind: detector | baseline | synthetic, name, commit | null },
  events:      [ { event_type, side, timestamp_ms } ],
  cycles:      [ { side, start_ms, end_ms } ],
  abstentions: [ { start_ms, end_ms, reason } ]
}
```

Abstention reasons are low_confidence, occlusion, view_unsupported,
stroke_uncertain, identity_uncertain, integrity_withheld and other.

- An abstention covering the whole clip is a whole-clip refusal.
- An event may not sit inside the candidate's own abstention.
- `stroke` is what the candidate believes the stroke is. A mismatch
  with the label is counted, not scored.

## 7. Evaluation harness rules

Configuration (`createStrokeEvaluationConfig`):

- `tolerance_ms_by_event_type` gives an explicit tolerance per event
  type. Event types without one are **not evaluated**; they are listed
  in `inputs.event_types_not_evaluated` and never defaulted.
- `cycle_start_tolerance_ms` is required, and is a number or `null` (to
  skip cycles).
- There is no approved tolerance for any stroke yet.

Per clip (`evaluateStrokeCandidates`), in this order:

1. **Missing candidate** → status `missing_candidate`.
   **Stroke mismatch** → `stroke_mismatch`.
2. **Reference choice:**
   - the adjudicator's annotation (`adjudicated`); otherwise
   - the only annotation (`single_annotation`); otherwise
   - status `unresolved_disagreement`, and the clip is not scored.
   Pairwise annotator agreement is always computed for non-adjudicator
   annotations, using the same tolerances.
3. **Each reference label** of an evaluated type falls into exactly one
   bucket, checked in order:
   - **indeterminate** (no timestamp);
   - **in unusable** (inside the reference's unusable intervals);
   - **abstained** (inside a candidate abstention);
   - **evaluable**.
   Predictions inside unusable intervals are counted and not scored.
4. **Matching:** evaluable labels are matched one-to-one with scored
   predictions, per event type and side, by `matchEvents` (inclusive
   tolerance, nearest first, deterministic tie-breaks).
5. **Cycles:** reference cycles come from their boundary events.
   - Cycles of either side that overlap an unusable interval or an
     abstention are excluded.
   - Cycle starts are matched per side with `cycle_start_tolerance_ms`.
   - For matched pairs, start offset and duration error are reported.

Per group (overall, `by_stroke`, `by_view` keyed `view/medium`, and
`by_stroke_and_view`):

- **Event errors:** TP, FP and FN; precision, recall and F1 (`null`
  when undefined, as in v0.1); signed timing-error summary; plus
  `by_event` broken down by event type and side.
- **Abstentions and coverage:**
  - `abstention_rate` = abstained ÷ (evaluable + abstained);
  - `event_coverage` = 1 − `abstention_rate`;
  - `time_coverage` = usable time not abstained ÷ usable time, where
    overlap with unusable time is counted once.
- **Clip accounting:** counts of evaluated, missing-candidate,
  unresolved and stroke-mismatch clips, and distinct subjects.
- **Cycles:** cycle count error, cycle precision/recall/F1, and start
  and duration error summaries.
- **Annotator agreement:** matched and unmatched counts, agreement
  rate, and an offset summary.

All four strokes always appear in `by_stroke`. A stroke with no
labelled clips shows `clips: 0` and `null` metrics instead of
disappearing.

The report is plain JSON and a pure function of its inputs: input order
does not change it, and it uses no clock, randomness, I/O or detector
calls.

## 8. Evidence status

Every report carries `evidence_status` and a matching `disclaimer`:

- `no_data`: nothing was evaluated.
- `synthetic_test_data_not_evidence`: harness exercise only.
- `expert_labelled_not_validated`: real labels, not yet reviewed
  against the validation gate.

No status means "validated". Validation is a human decision made at the
stroke validation gate: decision EVAL-1 in `docs/DECISIONS.md`, with its
checklist in `docs/ROADMAP.md` Phase 3. Passing the gate does not by
itself enable a detector or change user-facing claims; each of those
needs its own explicit approval.

## 9. What must exist before real use

These are the prerequisites set by decision EVAL-1. No numeric acceptance
limits are set yet.

- **A per-stroke annotation protocol:**
  - operational event definitions, suitable views and abstention
    rules;
  - a double-annotation pilot;
  - explicit human approval (the Protocol v0.1 §20 process, repeated
    per stroke).
- **A separate dataset decision recorded in `docs/DECISIONS.md` before
  any collection** (CLAUDE.md §14). This contract and its harness do
  not authorize filming, collecting, uploading or retaining footage.
  The decision must cover:
  - consent basis, including guardians of minors;
  - private storage and access control;
  - retention and deletion.
- **Tolerances per event type**, chosen from measured inter-annotator
  agreement and not asserted in advance.
- **Real expert labels** spanning the views each stroke needs, with
  by-subject held-out splits.

## 10. Versioning

Any change to a field, enumeration, vocabulary entry or harness rule
bumps the relevant version string and updates this document in the same
change. Reports from different versions are not comparable.
