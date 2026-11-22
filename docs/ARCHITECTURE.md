# Architecture

This document describes Chase/Swimtics's architecture as it exists today,
and the target architecture the infrastructure phase is building toward.
It is derived from the read-only baseline audit performed on
2026-09-06 against `chase/infrastructure` (commit `5c456c0`). Update this
file in the same PR whenever architecture actually changes — do not let
it drift from the code.

## 1. Current architecture

The entire application is one static file, `index.html` (~12,000 lines),
served as-is by GitHub Pages with no build step. There is no backend.

```
index.html
├── <head>
│   ├── third-party <script> tags (GSAP, MediaPipe, Chart.js) — no analytics
│   │   tags: Google Analytics is loaded later, only after consent
│   └── <style> — GLOBAL block (~2,700 lines)
├── <style id="swimticsPremiumMergedCSS"> (~3,300 lines)
├── <body>
│   ├── entry gate (cinematic intro overlay)
│   ├── nav + auth modal (non-functional, see docs/DECISIONS.md)
│   ├── page sections (div.page, shown/hidden by showPage()):
│   │   home · analyzer (Chase AI) · pb (Wall of Records)
│   │   · race (Chronos Engine) · profile · dashboard (War Room)
│   ├── <script type="module"> — Firebase bootstrap
│   ├── <script> — application logic (~3,500 lines)
│   └── <script> — marketing/scroll animation (GSAP)
```

Three JS blocks share one global scope; there are no ES modules for
application logic (the Firebase block is a module only to use `import`
for the Firebase SDK).

### 1.1 Current Chase pipeline

The Chase AI analyzer page implements a real, working, in-browser slice
of the target pipeline:

```
Video file (user upload)
  → <video> element, object URL
  → offscreen canvas frame grab, every 120ms (setInterval)
  → MediaPipe Pose (client-side WASM inference)
  → onChasePoseResults(): landmark → metric calculators
      (elbow angle, body alignment, shoulder asymmetry, arm symmetry,
       hip-line tilt, knee angle, lateral drift)
  → metricsHistory (timestamp-aligned arrays)
  → chaseDetectFreestyleCycles() — wrist-height local-minima heuristic
      (freestyle only; other strokes get generic metrics + disclaimer)
  → CHASE_COACHING_RULES — fixed threshold rules → observation/
      interpretation/context/recommendation text
  → displayChaseMetrics() / generateChaseFeedback() — DOM render,
      including an explicit "measured vs inferred vs indeterminate"
      section
```

The feedback report also includes static, research-informed camera-view
and interpretation notes for freestyle, backstroke, butterfly, and
breaststroke (`src/chase-engine/stroke-report-context.js`). These notes
are guidance for reviewing footage, not measurements or detected phases.
Backstroke, butterfly, and breaststroke remain without stroke-specific
cycle or phase detectors; their numeric output is still generic pose data.
Any future detector must be evaluated against stroke-specific expert
labels before it is described as reliable (decision EVAL-1,
`docs/DECISIONS.md`; see §2.5).

The view notes synthesize the owner-provided *Elite Competitive Swimming*
research paper (Chapters 2–5, 9, and 15). Representative primary work
describes pace-sensitive coordination in backstroke
([Chollet et al., 2008](https://pubmed.ncbi.nlm.nih.gov/18409098/)),
butterfly ([Seifert et al., 2008](https://pubmed.ncbi.nlm.nih.gov/17935810/)),
and breaststroke
([Chollet et al., 2004](https://pubmed.ncbi.nlm.nih.gov/15459828/)).
Those studies inform which visible events merit review; they do not
validate Chase's pose estimates or these camera-view notes as detectors.

The Chronos Engine (race timer) runs a second, independent MediaPipe
Pose instance for motion-triggered start/split timing and a coarse
stroke-count heuristic. It does not share code or state with the
analyzer above.

The "Coach ATLAS" chat widget is **not** part of this pipeline: it is
keyword-matched canned text with no access to `metricsHistory` or any
analysis output. Wiring it into the pipeline is future work (see
`docs/ROADMAP.md`).

### 1.2 Current data flow

- **Video/pose/metrics**: in-memory only, per page load; nothing is
  uploaded to a server or persisted. Reloading the page discards it.
- **Personal bests, profile, stroke data, soreness map, theme**:
  `localStorage` on the device (the working copy the UI reads).
  The saved PBs (`"pbs"`) and profile (`"profile"`) are checked on read
  by `src/app/data/saved-data-check.js`: a value that isn't valid JSON,
  or isn't the shape the app writes, is never changed on load. The Wall
  of Records / Profile show a recovery message (download or copy a
  backup; "Start fresh" removes only that key after confirmation) and
  hold back writes that would replace it. Start fresh never calls
  account sync and isn't offered while the working copy belongs to a
  signed-in account. With accounts (Firebase `account.js`, Supabase
  `supabase-accounts-core.js`): this device's own `"pbs"` / `"profile"`
  text is set aside and put back exactly as saved, never re-encoded; PB
  sync and the account profile save refuse to send anything while the
  local copy can't be read; and before account code replaces an account
  working copy that can't be read (reload, log out, switching account),
  its exact text is kept under a key for that account only
  (`…unreadableCopy:<uid>:pbs|profile:<time>`), offered on Profile for
  backup or Discard only while that account is signed in. Discard removes
  only that local key and sends nothing. Nothing replaces a working copy
  until the text it holds has been preserved: each set-aside value and
  per-account copy is written and read back exactly
  (`writeSavedText` / `preserveUnreadableCopies`). If browser storage
  refuses (quota exceeded, blocked, unavailable), the sign-in, log-out,
  account switch or restore stops: the original text is left untouched,
  the account isn't loaded (and so nothing is synced from that page),
  the set-aside copy and the account mark are kept, and a page-level
  message (`showStorageProblem`, under the main navigation) says what was
  left in place, that nothing was deleted or backed up, and to free up
  storage and reload. Start-up retries the unfinished step, so the
  message persists until storage accepts the writes. Log Out puts this
  device's data back before signing out, so if that is refused the user
  stays signed in and is told to free up storage and log out again; only
  a sign-out from elsewhere (another tab, an expired session) can leave
  the previous account's data shown while signed out.
- **Accounts (Stage 1, D10)**: Firebase Auth (email/password) +
  Realtime Database under `/users/{uid}` with deny-by-default rules
  (`database.rules.json`). When signed in, profile text fields and PBs
  sync to the account (`src/app/data/user-data.js`,
  `src/app/data/account.js`); photos, Analyzer/Chronos/War Room output
  and videos do not. Accounts are **off in production** until the
  console setup in `docs/ACCOUNTS.md` is done (no `databaseURL` yet);
  they are exercised with the Firebase Emulator Suite (`?emulator` on
  localhost, project `demo-swimtics`). Full detail: `docs/ACCOUNTS.md`.
- **Analytics (D12)**: Google Analytics (`G-VSLDBW2PYM`) is optional and
  loaded only by `src/app/privacy/consent.js`, after the visitor accepts
  in the consent notice (shown after the entry gate) or from a saved,
  current-version "accept" less than 12 months old
  (`localStorage["swimtics:analyticsConsent"]`: `{ choice, version, at }`;
  pure logic in
  `src/app/privacy/consent-store.js`). Tools → Privacy & cookies reviews
  or changes the choice; withdrawing sets gtag's `ga-disable` flag,
  refuses further requests to Google's analytics hosts from that page,
  and removes the analytics cookies the site can reach; without a current
  "accept", startup removes them too. Microsoft Clarity is paused and not
  loaded anywhere.
- **Supabase test mode (D14, test-only)**: `src/app/data/supabase-test-account.js`
  runs only with `?supabase` on `localhost`/`127.0.0.1` or a
  login-protected Vercel preview URL of `swimtics-web`, against the hosted
  `swimtics-test` project, using the project URL and publishable key from
  git-ignored local files (locally) or Preview-only Vercel environment
  variables served by `api/supabase-test-config.js` (previews). It covers sign-up/confirmation,
  login/logout, password reset, the user's own `profiles` row, personal
  bests (`src/app/data/supabase-test-pbs.js`), a first-sign-in import
  of the device's data (RLS: `supabase/sql/001_profiles.sql`,
  `002_personal_bests.sql`) and the profile photo
  (`src/app/data/supabase-test-photos.js`: resized and re-encoded in the
  browser to drop EXIF, stored in the private `profile-photos` bucket with
  owner-only policies from `003_profile_photos.sql`, shown via a
  short-lived signed URL as an in-memory `blob:` URL). Firebase remains the production
  provider. Full detail: `docs/SUPABASE_TEST.md`. The account controller
  itself is `src/app/data/supabase-accounts-core.js`, shared with
  production mode; `src/app/data/supabase-env.js` keeps the two
  environments apart (hosts, browser keys, project check).
- **Production Supabase accounts (D15, proposed, OFF)**:
  `src/app/data/production-accounts.js` does nothing while
  `PRODUCTION_SUPABASE_ACCOUNTS` (`src/app/data/accounts-flags.js`) is
  false. When on, it runs only on swimtics.com / www.swimtics.com, only
  with the committed public config for the production project
  (`src/app/data/supabase-production-config.js`, never fetched while the
  flag is off), and offers
  Sign Up only if `PRODUCTION_PUBLIC_SIGNUPS` (false). Full detail:
  `docs/SUPABASE_PRODUCTION.md`.

### 1.2.1 Inference-result integrity

The Chase analyzer's shared result path is guarded for every stroke
selection by INT-1's rules. Since the Chase integration of the Pose
adapter (below), those rules are applied by
`src/inference/request-lifecycle.js` through `src/inference/pose-adapter.js`,
both loaded from `index.html`; `src/chase-engine/inference-integrity.js`
is no longer loaded by the page and is kept as the reference the
lifecycle's frame decisions are tested against. It permits one
outstanding `pose.send()` window page-wide,
including across stop, restart and video replacement. A result is held
until that send settles and is committed only when exactly one callback
was observed in the window and the originating analysis session remains
active. Detected violations fail closed: the current report is withheld,
and further analysis requires a page reload.

This is containment, not request/result identity. The legacy MediaPipe
callback has no verified request ID. A foreign callback observed alone
in a send window while that send's own result is missing or delayed can
still be committed as that frame's result. The Node tests and browser
spec use a scripted MediaPipe stand-in; real-MediaPipe, real-video and
real-browser validation remain separate gates. Backstroke, butterfly and
breaststroke remain research-only. See
`docs/CHASE_INFERENCE_INTEGRITY.md` and decision INT-1.

`src/inference/request-lifecycle.js` is a pure, browser-free and
MediaPipe-free request lifecycle. It is **loaded by the Chase analyzer
only**, through the Pose adapter below; the Race page does not use it. For frame requests it applies INT-1's
rules and codes (one open request, released only on settlement, no
timeout; eligibility only after a resolved send with exactly one
callback for a still-active session; detected anomalies latch until
reload). Everything else is this core's own design, not something
INT-1 specifies: explicit engine readiness through a dedicated warm-up
request (`CREATED` → `WARMING` → `READY`), and explicit session state
(one `ACTIVE` session; a new session retires the previous one). It has
two terminal states per page load, kept separate. `LATCHED` is an
integrity latch with one of INT-1's five codes. `WARMUP_FAILED` means
the warm-up send was rejected without a callback: that is not an
integrity anomaly, but the engine never became ready, so the core stays
fail-closed and refuses every frame request, warm-up and session until
reload. It is not an INT-1 latch, and INT-1 does not require it. (A
rejected *frame* send without a callback stays a non-event, as in
INT-1.) The core does not recreate engines or call `close()` or
`reset()`. It has no UI and cannot visibly block page controls, but its
state machine does refuse operations: after `WARMUP_FAILED` (as after a
latch) it refuses every session, frame request and warm-up, and only a
fresh lifecycle object (a page reload) starts again. Its tests replay
event orders recorded in the Stage 3.2 lifecycle validation runs
(`test/fixtures/inference-lifecycle/`) and compare its frame-request
decisions with `inference-integrity.js` on random sequences; warm-up,
readiness and session behaviour are not part of that comparison.

`src/inference/pose-adapter.js` is a Pose adapter built on that core.
Chase routes all of its inference through it (see "Chase integration"
below). Race still creates its own MediaPipe Pose and calls
`pose.send()` itself, unchanged and outside INT-1.

- **What it owns.** It creates the engine once, through an injected
  `createEngine()` (so tests can supply a fake), registers the engine's
  results callback, and never exposes the engine. Callers can only send
  through `warmUp()` and `sendFrame()`.
- **Single flight.** Before every send it asks the core. A refused send
  (a request already open, engine not ready, `WARMUP_FAILED`, latched,
  no active session) is not forwarded to the engine. The slot is
  released only when the engine's send settles; there is no timeout, so
  a send that never settles holds the slot for the adapter's lifetime. A
  synchronous throw from `send()` counts as a rejected send.
- **Warm-up.** `warmUp()` sends the caller's warm-up input as the core's
  dedicated warm-up request. One callback and a resolved send make the
  engine `READY`. A rejected warm-up with no callback leaves it
  `WARMUP_FAILED` (not an INT-1 latch): every later frame, warm-up and
  session is refused and nothing more is forwarded.
- **INT-1 for frame requests.** The callback handler records the
  callback in the core first, then copies `poseLandmarks` and
  `poseWorldLandmarks` (the only fields either page reads) and reads the
  caller's optional `readArrivalTime()` hook, each guarded so nothing
  escapes through MediaPipe's callback. Counting comes first, so a
  failure afterwards cannot hide a callback. Missing, duplicate,
  unsolicited and rejected-send callbacks are decided by the core with
  INT-1's rules and codes, and a result is eligible only after a
  resolved send with exactly one callback for a still-active session.
  The adapter policies below never change those decisions.
- **Session failure (consumer error or failed capture).** The caller's
  `onEligibleResult` consumer runs only for an eligible frame, after its
  send has settled and outside the engine's callback. If the consumer
  throws, or if copying the landmarks or reading the arrival time threw
  inside the callback (in which case the consumer is not called at all
  and the result is withheld), the adapter ends that request's session
  and returns a `failure` on the send's result (`kind:
  "SESSION_FAILED"`, reason `CONSUMER_ERROR`, `RESULT_COPY_FAILED` or
  `ARRIVAL_TIME_FAILED`, `reportWithheld: true`). The caller must not
  produce that session's analysis report; `sessionFailure(token)`
  returns the recorded failure. The core's outcome is still reported
  unchanged. The engine stays `READY`: no latch, no recreation, no
  `close()`, no timer, and a later session analyses normally. Treating
  a failed arrival-time read the same way as a failed copy is this
  adapter's choice.
- **Timestamps.** Each consumed frame carries two times, both opaque to
  the adapter: `dispatchTime` (the caller's `meta.dispatchTime`, recorded
  when the frame was dispatched) and `arrivalTime` (what
  `readArrivalTime()` returned when the callback arrived; Chase's
  metrics use arrival time today). The adapter switches no metric to
  dispatch time; which time feeds which metric stays the page's choice.
- **Optional integrity-latch notification.** A caller may pass
  `onIntegrityLatch`. When the core first latches (any INT-1 code),
  the adapter schedules one call to it in a microtask, never inside
  MediaPipe's callback, with a copy of the core's latch record. It
  fires whether the latch came from a callback with no open send, an
  extra callback in one window, or was found when a send settled
  (resolved without a callback, or a callback for a rejected send,
  including during warm-up). It fires at most once per adapter, because
  the core's latch lasts for the lifecycle; later anomalies do not fire
  it again. It does not fire for `WARMUP_FAILED`, a session failure, a
  stale result or a refused send, none of which is a latch. Anything
  the notification throws or rejects with is caught and counted
  (`latchNotificationErrors`): it cannot change the latch, the
  lifecycle or later results, and cannot cause an unhandled rejection.
  It changes no INT-1 rule; the core refuses later sends whether or not
  a notification is given or succeeds. Limits: it is only a prompt to
  the caller, not a guarantee of timing (it runs after the current
  synchronous code, and its order relative to the send's returned
  result is not specified); it carries no request identity beyond the
  core's record. Chase uses it (below).
- **What the tests establish.** `test/inference/pose-adapter.test.js`
  drives the adapter with a scripted fake engine, including each
  session-failure path, the session state afterwards, withheld results,
  a later successful session, both timestamps and the latch
  notification (each latch path, its deferral, once-only firing, no
  firing for `WARMUP_FAILED`, and containment of a throwing handler). These are logic tests
  of routing and bookkeeping, not evidence of how real MediaPipe
  behaves. `test/e2e/pose-adapter-real-engine.spec.js` is an opt-in
  smoke test (skipped unless `CHASE_POSE_MIRROR_DIR` names a local copy
  of the pinned runtime, checked by sha256): one short headless-Chromium
  run with a flat grey synthetic canvas, all network requests answered
  locally. In its latest run the warm-up completed; five sequential
  frames were eligible; five concurrent sends were refused without
  being forwarded; a deliberately throwing consumer ended the first
  session, whose next send was refused; a second session on the same
  engine then produced eligible results; there was no page error.
- **Not established.** The adapter-only real-engine runs were short
  synthetic-input runs of the adapter on its own (not of the Chase page),
  with no person, no real footage, one browser and one machine. Reload after a hung send,
  recovery by engine recreation, long sessions and other browsers or
  GPUs were not validated. The legacy callback still carries no request
  ID, so a foreign callback alone in a window remains indistinguishable
  from the request's own.

**Chase integration (Chase only; Race unchanged).** `index.html` loads
the lifecycle core and the adapter in place of
`src/chase-engine/inference-integrity.js`. `initialiseChasePose()`
builds the adapter at page load; its `createEngine()` constructs the
same Pose with the same options. MediaPipe's callback is still
`onChasePoseResults`, which only forwards each result to the adapter's
handler, so every Chase callback is counted by the core before anything
else. Page code never calls `pose.send()`: every frame goes through
`sendFrame()`, the warm-up through `warmUp()`.

- **Warm-up.** Once per page load, on the first Analyze click, after
  the existing input checks and before playback starts. The status line
  shows "Preparing the analysis engine… The page may not respond for
  several seconds while it starts. Please wait." while it runs; another
  Analyze click meanwhile is ignored. The message deliberately promises
  no maximum duration. The warm-up input is a synthetic 256×256 flat-grey canvas, not
  a video frame. If the warm-up send is rejected (`WARMUP_FAILED`),
  Analyze is refused until reload with "The analysis engine couldn't
  start. Reload the page before trying again." No retry. A warm-up
  that shows an integrity anomaly is latched by the lifecycle core with
  INT-1's codes, as a frame would be; this is a lifecycle-core rule, as
  INT-1 itself governs frame requests only. Nothing is sent at page load. The first Analyze now waits for the engine's
  cold start before playback, instead of that cost falling on the first
  frame during playback. In the offline real-engine validation
  (`test/e2e/chase-real-engine.spec.js`: pinned runtime from a local
  mirror, synthetic input, headless Chromium, one machine, five recorded
  runs over two days) the status was painted before the main thread
  blocked in every run, the warm-up took about 6.8–8.0 s from the click,
  and the page was unresponsive (its longest single task) for about
  6.3–7.4 s of that. The latest run, after the branch was updated onto
  the current `main`, was the slowest: about 8.0 s, with about 7.4 s
  unresponsive. These are samples from one machine, not a bound for any
  device: they exclude download time (the runtime was local), and other
  devices and browsers were not measured.
- **Unresolved: a warm-up that never settles.** If the engine's warm-up
  send neither resolves nor rejects, the page stays on the preparing
  message indefinitely: no error is shown, Analyze stays ignored (a
  warm-up is still in progress), and reloading the page is the only
  action available to the user. Recovery by reload after a hung warm-up
  has not been tested, and a persistent asset failure may recur after
  the reload. The validation reproduced this by answering
  `pose_solution_packed_assets.data` with 404: the legacy runtime raised
  a page error ("Not Found : …pose_solution_packed_assets.data") but the
  warm-up stayed pending for the whole 60 s observed. (A 404 for the
  wasm, model or graph file instead made the warm-up reject within
  about 0.3–1.5 s, which shows the documented `WARMUP_FAILED` message.)
  There is deliberately no timeout, retry, engine recreation or reload
  control; detecting and messaging this case would be a separate,
  reviewed decision.
- **Frames.** The rVFC ticker and the no-rVFC fallback are unchanged
  and still skip while `chaseAnalysisBusy`. A dispatch draws and sends
  only when nothing is open, nothing is latched and the warm-up has not
  failed (INT-1's dispatch rule, plus the lifecycle core's own
  `WARMUP_FAILED` refusal, which is not an INT-1 rule); the adapter
  additionally requires a ready engine and the current analysis's
  session. Each `upload()` begins one adapter session (retiring the
  previous one); stop, finish, video replacement (via stop), a latch
  (via finish) and a session failure end it.
- **Timestamps.** Each frame carries its dispatch record
  (`pendingTiming`, and `dispatchTime` = its media time) and the video
  time read when the callback arrived. Metrics (`metricsHistory.timestamps`,
  `window.lastMetrics.timestamp`) still use the arrival time; PoseFrames
  still use the dispatch record through `chaseSelectFrameTimestamp()`.
  No metric moved to dispatch time.
- **Integrity latch.** The page's existing response
  (`chaseHandleInferenceIntegrityViolation()`: finish and withhold a
  running analysis, or show the reload message) is triggered by the
  adapter's deferred `onIntegrityLatch` notification, in a microtask
  after the callback or settlement that latched, never inside
  MediaPipe's callback. It runs once per page load. Messages,
  reference codes, the withheld report and `lastTrackedSequence = null`
  are as before.
- **Session failure.** When the adapter ends an analysis with
  `CONSUMER_ERROR`, `RESULT_COPY_FAILED` or `ARRIVAL_TIME_FAILED`, the
  page stops that analysis's frame drivers, discards everything it
  produced so far (metrics, PoseFrames, live metrics, overlay,
  `window.lastMetrics`), shows "Analysis Stopped" with the reference
  code, and produces no report when the video ends. The video keeps
  playing. `window.chaseAI.lastTrackedSequence` from the previous
  completed analysis is left as it was. The engine stays ready: the next
  Analyze works without reload and without a new warm-up.
- **Diagnostics.** `window.chaseAI.inferenceIntegrity` keeps INT-1's
  summary fields (`status`, `latched.violation`, `openWindow`,
  `counters`, `identity`) from the adapter's snapshot, plus `engine`,
  `warmupFailure`, `session`, adapter counters and `sessionFailures`.
  Frame counters exclude the warm-up.
- **No shared lock with Race.** Chase and Race each own a Pose
  instance and callback. Nothing stops both from running if a user
  starts one, switches page and starts the other; whether that
  interferes inside MediaPipe is unknown. No engine recreation,
  `close()`, retry or timeout was added.
- **Tests.** `test/e2e/chase-inference-adapter.spec.js` (scripted Pose
  stand-in, scripted video) covers the warm-up, no frame before
  readiness, the ignored second click, warm-up failure, the latch
  notification, each session-failure reason with discarded results, the
  kept prior sequence, no report at video end and a later analysis on
  the same engine, and the two timestamps.
  `test/e2e/inference-integrity.spec.js` keeps its behavioural
  assertions, including equality with the pre-integrity analyzer on
  clean serial input; its harness completes the warm-up and reads the
  adapter diagnostics. The Race baseline spec runs unchanged.
- **Not established.** Beyond the scripted stand-in, the integration
  has run on the real pinned engine only offline, with synthetic input
  (no person, so the pose-found metrics and coaching report were not
  exercised), in headless Chromium on one machine. It has not been run
  with real footage, on other browsers or devices, with the runtime
  downloaded from the CDN, or with both pages analysing at once.

### 1.3 Current deployment

Static GitHub Pages, custom domain via `CNAME` (swimtics.com), no build
step. CI runs Node and Playwright checks on pull requests and pushes to
`main`; whatever is merged to the served branch ships immediately.

## 2. Target architecture

### 2.1 Two domains, one deploy

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│         App shell            │        │         Chase engine          │
│  (existing product surface,  │◄──────►│   (biomechanics pipeline,     │
│   behavior preserved)        │  calls │    new, separately tested)    │
│                               │        │                               │
│  nav · entry gate · PB       │        │  ingest → pose → tracking     │
│  tracker · profile ·          │        │  → phases → cycles →          │
│  War Room · marketing         │        │  measurements → technique     │
│  animation · ATLAS chat UI    │        │  → coaching                   │
└─────────────────────────────┘        └──────────────────────────────┘
```

The shell keeps doing exactly what it does today. The engine is new and
grows independently, called through a small stable interface (for
example, conceptually: `ChaseEngine.analyze(video, strokeKey) →
TechniqueReport`). The shell's existing UI code
(`upload()`/`runChaseAnalysis()`/`displayChaseMetrics()`) becomes a
*caller* of that interface rather than the implementation of the
pipeline itself. This split is what lets the engine be rebuilt
incrementally without rewriting the product around it.

Both still deploy as one static site initially — introducing this
boundary is a code-organization change, not a hosting change. A build
step (not yet installed — see `docs/ROADMAP.md`) is what will make the
split into real files practical without changing the GitHub Pages
deploy model.

### 2.2 Target pipeline

```
Video
  → Pose estimation
  → Temporal tracking
  → Stroke-phase detection
  → Stroke-cycle segmentation
  → Biomechanical measurements
  → Technique model
  → Evidence-based coaching layer
  → Coach ATLAS
```

| Stage | Status today | Notes |
|---|---|---|
| Video ingest | Working | File upload, offscreen canvas frame grab |
| Pose estimation | Working | MediaPipe Pose (BlazePose), client-side |
| Temporal tracking | Partial | Timestamp-aligned arrays exist; no trajectory filtering beyond MediaPipe's built-in smoothing |
| Stroke-phase detection | Partial | Only a coarse up/down flag for stroke counting, not a labeled phase model |
| Stroke-cycle segmentation | Partial | Wrist-height local-minima heuristic, freestyle only, no confidence score |
| Biomechanical measurements | Partial | 7 legitimate 2D single-camera proxy metrics |
| Technique model | Not started | No trained/learned model; only fixed threshold rules |
| Coaching layer | Partial | Evidence-bound text generator exists and is the pattern to keep |
| Coach ATLAS | Not started (as pipeline output) | Current widget is disconnected keyword-matching |

### 2.3 Boundaries between pipeline stages

Each stage is a pure function from one data contract to the next (see
§2.4). This is what makes a stage independently testable and
independently replaceable — for example, swapping the wrist-height
cycle heuristic for a learned segmenter later should only touch the
cycles stage, not tracking or measurements. A stage may run client-side
(as everything does today) or, later, be backed by a server call
without changing the contract at its boundary — that seam should be
designed in, not bolted on later.

### 2.4 Proposed shared data contracts

These are illustrative shapes, not final types — they exist so every
future stage targets the same vocabulary. Refine them in the PR that
first implements each stage, and update this section when they change.

- **`PoseFrame`** — one video frame's pose result: timestamp, per-landmark
  `{x, y, z, visibility}`, and the frame's own pose-found flag
  (`hasPose`). It does not carry a quality/confidence score — that
  remains a future derived layer, not a `PoseFrame` field.
- **`TrackedSequence`** — an ordered, session-scoped collection of raw
  `PoseFrame`s (sampled/inference observations, not necessarily every
  decoded video frame), plus session-level identity and provenance
  (timing mode, model source, generation). It does not apply smoothing
  or interpolation and does not carry a confidence score. Those are
  derived data and belong to a separate, later layer built on top of
  `TrackedSequence`, never inside it.
- **`StrokePhaseLabel`** — a labeled span of a `TrackedSequence` (e.g.
  catch / pull / push / recovery / entry) with a confidence score and
  the camera-angle assumption it depends on.
- **`StrokeCycle`** — a start/end time pair over a `TrackedSequence`,
  the stroke type it was detected under, and the detection method's
  confidence.
- **`BiomechMeasurement`** — one named measurement (e.g. elbow angle)
  with its value, units, the stage/method that produced it, and an
  explicit tag: measured / inferred / indeterminate (see `CLAUDE.md`
  §15).
- **`TechniqueReport`** — the full structured output for one analyzed
  clip: measurements, cycles, phases, and any technique-model output,
  bundled with confidence/limitations metadata. This is the only thing
  a coaching layer (including any future LLM phrasing step) is allowed
  to read from — never raw video or raw frames.
- **`CoachingObservation`** — one coaching statement, always carrying a
  pointer back to the `BiomechMeasurement`(s) it was derived from.

### 2.5 Evaluation contracts (not pipeline contracts)

Evaluation contracts describe how pipeline output is checked against
expert ground truth. They are separate from the §2.4 pipeline
contracts:

- They live in `src/evaluation/` as Node-only ES modules.
- `index.html` does not load them.
- They do not call MediaPipe, the DOM, storage or the network.

Two generations exist:

- **Freestyle pilot (v0.1)**: `src/evaluation/contracts.js`, which
  follows `docs/evaluation/ANNOTATION_PROTOCOL_V0.1.md`.
- **Four-stroke foundation (v0.1 draft)**:
  `src/evaluation/stroke-labels.js` and
  `src/evaluation/stroke-evaluation.js`, specified in
  `docs/evaluation/STROKE_LABEL_CONTRACT_V0.1.md`. It has three
  shapes:
  - **`StrokeLabelSet`**: one clip's expert annotations — events,
    phases, cycles, unusable intervals, and certainty and visibility
    per label. It also records camera view and position, frame rate,
    pool course, race segment and pace, and the annotator's opaque
    reference, role and blinding.
  - **`StrokeCandidateSet`**: a candidate's events, cycles and
    abstentions for one clip.
  - **`StrokeEvaluationReport`**: errors, coverage, abstentions and
    annotator agreement, grouped per stroke, per view, and per stroke
    and view. Each report carries an `evidence_status`, and none says
    "validated".

The four-stroke contract cannot carry footage, file references,
personal data or free text: unknown fields are rejected, and
references must be opaque codes.

A future stroke-specific detector would be scored by converting its
`StrokeCycle` / `StrokePhaseLabel` output into a `StrokeCandidateSet`
in evaluation code. Its enablement is governed by the stroke validation
gate, decision EVAL-1 in `docs/DECISIONS.md`, with its checklist in
`docs/ROADMAP.md` Phase 3. The static per-stroke report notes
(§1.1) are viewing guidance only, not a candidate output.

## 3. Non-goals for this document

This file describes architecture, not a schedule. Phased sequencing and
priority live in `docs/ROADMAP.md`. Specific decisions and their
rationale live in `docs/DECISIONS.md`.
