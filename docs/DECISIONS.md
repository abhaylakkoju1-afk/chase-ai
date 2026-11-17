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

---

## D10 — Firebase is the initial provider for accounts and user data

**Decision:** Stage 1 of account access uses the Firebase project already
initialised in the app: Firebase Auth (email/password) and the Realtime
Database. Only profile text fields and personal bests are stored, under
`/users/{uid}`, protected by deny-by-default security rules
(`database.rules.json`). Photos, analysis/race reports, War Room plans and
videos are not stored in this stage. No other provider is added.

**Why:** Firebase Auth and the Realtime Database were already initialised
and loaded from the CDN, so this is the shortest path to working accounts
without a new external service. The data model is small and per-user.

**Consequences:**
- Rules are tested only in the Firebase Emulator Suite (project ID
  `demo-swimtics`); nothing is deployed from this repository.
- Production accounts stay off until the remaining steps in
  `docs/ACCOUNTS.md` §4 are done. Email/Password sign-in is already
  enabled and the (Singapore) Realtime Database already exists, but its
  temporary rules have expired and deny all access; a reviewed deployment
  of these rules and a reviewed production `databaseURL` change are still
  required.
- The project is on the Spark plan: Storage (photos) and automatic
  database backups need Blaze, so photos stay on the device and backups
  need a separate plan before launch.
- Backups and a rehearsed restore (`docs/ACCOUNTS.md` §5) are required
  before accounts are announced; until then user data must not be
  described as backed up.
- Sessions persist until the user logs out (`browserLocalPersistence`,
  no "keep me signed in" choice); the UI reminds users to log out on shared
  devices. After sign-out, that account's local-only photos and unsynced
  changes stay on the device for its next sign-in — device-local, not a
  backup (`docs/ACCOUNTS.md` §2).
- Data minimisation, analytics masking/consent and the minimum-age
  question (`docs/ACCOUNTS.md` §7) remain open and must be decided before
  launch.

---

## D11 — Stay on the Spark plan for now; manual backups

**Decision:** The Firebase project stays on the free Spark plan for now.
Blaze is kept as a future option (automatic Realtime Database backups and
Firebase Storage) and reconsidered as database usage grows. Not upgraded.

**Why:** Stage 1 stores only profile text fields and personal bests, and
production accounts aren't enabled yet, so expected usage is small. The
owner chose to defer billing until usage justifies it.

**Consequences:**
- Spark's Realtime Database limit is 100 *simultaneous connections* (each
  connected tab/device), not 100 accounts. We review the plan when the
  peak reaches about 80 connections — our own review point, not a Firebase
  limit (`docs/ACCOUNTS.md` §4).
- Backups are manual: a full JSON export from the Realtime Database
  console, stored securely outside the repository (it contains user
  data), plus a restore rehearsal away from production
  (`docs/ACCOUNTS.md` §5). D10's backup requirement before launch still
  applies.
- Photos stay device-only while there is no Storage.

---

## D12 — Optional analytics only after consent; Clarity paused

**Decision:** Microsoft Clarity session recording is paused and not
loaded anywhere. Google Analytics is optional: it loads only after a
visitor explicitly accepts it, for every visitor on every device. Accept
and Decline are presented equally. The choice is saved in the browser
with a consent version and timestamp, and can be reviewed or withdrawn
from Tools → Privacy & cookies.

**Why:** Both tools previously loaded on every page before any choice.
Session recording on a site that minors may use, showing profile and PB
data, was the largest privacy risk found in the pre-launch review; the
owner chose to pause it and make the remaining analytics opt-in.

**Consequences:**
- `src/app/privacy/consent.js` is the only place Google Analytics may be
  loaded. Analytics tags must not be added to `index.html` directly.
- A saved choice lasts 12 calendar months; after that it counts as no
  choice, so nothing loads and the visitor is asked again. The notice and
  dialog wording was approved by the owner.
- Changing the notice's wording or what it covers means bumping
  `CONSENT_VERSION` (`src/app/privacy/consent-store.js`), so every visitor
  is asked again.
- Withdrawal sets gtag's `ga-disable` flag and, because gtag's automatic
  events can still be sent after that flag is set, also refuses requests
  to Google's analytics hosts from that page made through `sendBeacon`,
  `fetch`, `XMLHttpRequest` (checked again at `send()`, so a request opened
  before the withdrawal can't go out after it), or the `src` of `<img>`/`<script>` elements
  (refused sends report success, so gtag doesn't fall back). Not covered:
  `setAttribute("src")`, iframes, CSS and `<link>` hints — gtag wasn't
  seen using them. Analytics cookies the site can reach are removed;
  cookies on Google's own domains can't be removed by this site.
- Without a current "accept" (no choice, a corrupt or outdated record,
  or "decline"), startup loads nothing and removes first-party Google
  Analytics and Clarity cookies left from earlier visits.
- Re-enabling Clarity needs a new decision, its own consent and a
  masking review.
- No privacy policy is published yet; its commitments need owner review
  (`docs/ACCOUNTS.md` §7).

---

## D14 — Test-only Supabase account prototype (not a migration)

**Decision:** Build a test-only Supabase account flow against the hosted
`swimtics-test` project (Mumbai) to try sign-up, email confirmation,
login/logout, session persistence, password reset and owner-only data
access. Firebase stays the production account provider (D10) and is not
changed.

**Why:** To learn what Supabase Auth and Row Level Security need in this
codebase before any decision to move providers.

**Consequences:**
- Test mode runs only with `?supabase`, on `localhost`/`127.0.0.1` or a
  login-protected Vercel preview URL of `swimtics-web`
  (`swimtics-web-…-swim-tics.vercel.app`); never on swimtics.com or
  `swimtics-web.vercel.app`.
- Only the project URL and publishable key are used: locally from
  git-ignored files; on previews from Vercel environment variables scoped
  to Preview only, served by `api/supabase-test-config.js`, which answers
  only on Preview deployments. Secret / `service_role` keys are refused in
  code.
- SQL in `supabase/sql/` is applied to the test project only by the
  owner, after review (`001_profiles.sql`, then `002_personal_bests.sql`
  for personal bests and the first-sign-in import, which reuse the
  existing pure logic in `user-data.js`).
- Pushing a preview branch, the Vercel/Supabase dashboard settings,
  custom SMTP and any production use each need separate approval. See
  `docs/SUPABASE_TEST.md`.

---

## D15 — Migrate production accounts to Supabase; proposed, flag off

**Status:** proposed. The code path exists behind
`PRODUCTION_SUPABASE_ACCOUNTS` (`src/app/data/accounts-flags.js`), which
is **false**; swimtics.com is unchanged and Firebase (D10) still owns the
account card until the flag is turned on in its own approved PR.

**Decision (proposed):** Production accounts, profiles and personal bests
move to the Supabase project `swimtics-production`, reusing the account
controller proven in test mode (D14) and the same SQL and RLS.

**Why:** The test prototype covers sign-up, sessions, password reset,
owner-only profile and PB data and the device import, with RLS checked on
the hosted test project; Firebase accounts were never switched on.

**Consequences:**
- One controller (`supabase-accounts-core.js`), two environments
  (`supabase-env.js`): a host is test, production or neither, never both.
  Each has its own auth session key and browser keys, and its config must
  name its own project — test refuses the production project; production
  accepts only `PRODUCTION_PROJECT_REF` (`jqyctrbzwxrpscieldif`,
  swimtics-production) and never the test project. Project reference ids
  are public and may be committed; keys other than publishable keys never
  are. The production public config (URL + publishable key,
  `src/app/data/supabase-production-config.js`) is committed but not
  fetched while the flag is off.
- `PRODUCTION_PUBLIC_SIGNUPS` stays **false** (and sign-ups stay off in
  the dashboard) until the under-18 consent approach has qualified Indian
  legal advice and the privacy policy is reviewed and published. Until
  then production would be invite-only.
- Production profile photos stay off until the same legal and privacy
  review; photo storage is built and tested against `swimtics-test` first.
- Each step — production config, applying SQL to production, turning a
  flag on, Supabase / Vercel settings — needs separate owner approval.
  `swimtics-production` is never used for testing. See
  `docs/SUPABASE_PRODUCTION.md`.


---

## INT-1 — Contain detectable Chase inference-result integrity failures

**Decision:** The Chase analyzer uses a page-wide inference window for
each `pose.send()`. It does not dispatch another send while one remains
outstanding. It commits a result only after that send resolves, exactly
one callback was observed during its window, and the analysis session
is still active. A detected integrity violation withholds the current
report and requires a page reload before another analysis.

**Why:** The legacy callback carries no verified request identifier,
while stopping and restarting analysis can leave asynchronous work from
an earlier session outstanding. Containment prevents detected stale,
missing, duplicate and unsolicited callback patterns from silently
entering analysis histories.

**Limits:** This does not establish which request produced a callback.
A foreign callback observed alone during a send window while that send's
own result is missing or delayed can still be committed. The state
machine is tested with scripted callbacks; real MediaPipe and real-video
behavior have not been validated by those tests. The availability cost
is that a detected anomaly blocks analysis until reload.

**Scope:** Shared by all stroke selections. It changes no stroke
capability, detector, sampling cadence or coaching rule. The three
research-only strokes remain research-only. This scoped `INT-1` identifier
is independent of the repository's numbered D1–D15 decisions.

---

## EVAL-1 — Stroke validation gate for stroke-specific detectors

**Recorded:** 2026-11-17.

**Decision:** This gate covers any stroke-specific phase detector or
cycle detector (including a segmenter or phase model) for freestyle,
backstroke, butterfly or breaststroke.

- **Expert labels first.** No such detector may be described as
  reliable, or enabled for users, until it has been evaluated against
  expert-labelled data for that stroke and for each camera view it will
  run on.
- **The contract and harness to use.** The evaluation uses the
  four-stroke contract and harness (`chase.stroke-labels.v0.1`,
  `chase.stroke-evaluation-report.v0.1`, specified in
  `docs/evaluation/STROKE_LABEL_CONTRACT_V0.1.md`), or a reviewed
  successor version.
- **No carry-over.** Evidence for one stroke or view does not carry
  over to another. Existing freestyle capability does not validate any
  other stroke.

**What the evaluation must report:**

- For each stroke and each camera view, separately:
  - event errors, including timing error;
  - cycle errors;
  - coverage;
  - abstentions;
  - inter-annotator agreement.
- A single pooled score is not enough.
- **How the labels are made:** blind to candidate output, and
  evaluated on a held-out split by swimmer. Matching tolerances come
  from measured annotator agreement; they are never asserted in
  advance.
- **Unsupported views:** a view without adequate evidence stays
  unsupported, and the detector abstains there.
- **Synthetic data:** synthetic fixtures test the harness's mechanics
  only. They are never evidence of accuracy, for any stroke. Every
  harness report carries an `evidence_status`, and no status means
  "validated".

**What this decision does not authorize:** filming, collecting,
uploading, storing or retaining athlete footage or personal data. The
contract and harness do not authorize any of these. Before any real
data is collected, a separate decision must be recorded in this file
(`CLAUDE.md` §14). It must document:

- the consent basis, including parents or guardians of minors;
- privacy and access control;
- storage;
- retention and deletion.

Footage never enters this repository. It is never sent to a
third-party service without explicit approval.

**Enablement is a separate approval.** Passing the gate is necessary
but not sufficient. Each of these needs its own explicit human review
and approval, recorded in this file (`CLAUDE.md` §10):

- enabling a detector for users;
- changing a stroke's research-only status;
- changing any user-facing claim.

**How an enabled detector reports:**

- Its phases and cycles are reported as **inferred**, never as measured
  (D6, `CLAUDE.md` §15).
- It states its camera assumption and what that assumption cannot
  determine (D8).
- Coaching built on its output stays traceable to measurements and
  fires only when they have data (D4, `CLAUDE.md` §6). It abstains
  rather than filling gaps (`CLAUDE.md` §16).

**No numeric limits:** this decision sets no acceptance thresholds,
tolerances or dataset sizes. They are to be set in a later decision,
based on real labelled evidence and measured agreement.

**Why:**

- Chase has only a freestyle cycle heuristic.
- D7 already requires evaluation before technique models; it does not
  say how stroke-specific detectors are judged.
- The owner-provided *Elite Competitive Swimming* research paper
  (Chapters 9, 10 and 17) explains that event definitions, error and
  observability differ by stroke and camera view, and that freestyle
  capability does not validate other strokes.
- The harness now exists, but only with synthetic data. Recording this
  gate prevents a passing synthetic run, or the static per-stroke report
  guidance, from being read as validation.

**Consequence:**

- Nothing changes in the app today. Backstroke, butterfly and
  breaststroke remain research-only (`supported: false`). The static
  per-stroke report notes remain viewing guidance, not detection.
- The "Stroke validation gate" in `docs/ROADMAP.md` Phase 3 is the
  working checklist for this decision, and roadmap Phases 5 and 6
  depend on it.
- This extends D7 to stroke-specific phase and cycle detectors without
  amending D7. It is consistent with `CLAUDE.md` §7.
- Identifier: numbered decision IDs are being allocated in parallel on
  unmerged branches (D13 and D16–D22 are already in use there), so this
  entry uses the scoped identifier `EVAL-1`, like `INT-1`, independent
  of the numbered D-series.
