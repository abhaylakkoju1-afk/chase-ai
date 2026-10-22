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
