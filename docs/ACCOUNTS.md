# Accounts and user data — Stage 1

Status: **implemented and tested against the Firebase Emulator Suite
only.** Nothing in this repository has been deployed, and accounts stay
**off in production**: the production `firebaseConfig` has no
`databaseURL`, so account features don't load. Decision: D10 in
`DECISIONS.md`.

## 1. What syncs, and what doesn't

| Data | Signed out | Signed in (once accounts are enabled) |
|---|---|---|
| Profile text fields (name … medals — the 24 existing fields) | This device (`localStorage.profile`) | **Account** (`/users/{uid}/profile`), mirrored on the device while signed in |
| Personal bests + full time history | This device (`localStorage.pbs`) | **Account** (`/users/{uid}/pbs`), mirrored on the device while signed in |
| Profile photo, stroke-card photos | This device | **This device only**, kept per account (see §6) |
| Theme | This device | This device |
| Analyzer results / reports | Not saved (Save/View buttons not implemented) | Not saved |
| Uploaded videos | Not saved (in-memory link only) | Not saved |
| Chronos race reports | Not saved | Not saved |
| War Room plans, soreness map | Not saved | Not saved |

If a change can't reach the account (offline, error), it is backed up on
the device under that account's uid **before** the network call and sent
the next time that same account opens SWIMTICS. The status line under
**Save Profile** and under the PB list says whether a change reached the
account; after ~8 s without a reply it says so.

## 2. How it works

- **Auth** (`src/app/data/account.js`): Firebase Auth, email + password —
  sign up (sends a verification email), sign in, sign out, password reset
  (neutral message, so it doesn't reveal which emails have accounts),
  resend/refresh verification. Passwords go only to Firebase Auth; they are
  never stored in `localStorage`, the database, or app code. Client-side
  minimum 8 characters (Firebase's own minimum is 6). Sessions persist in
  `localStorage` (`browserLocalPersistence`, set at initialisation).
- **Working copy**: the existing UI still reads `localStorage.profile`,
  `.pbs`, `.strokeData`. On sign-in this device's own data is snapshotted
  (`swimtics:guest:*`) and the working copy is replaced by the account's
  data; leaving the account restores the device's data. Nothing on the
  device is deleted by sign-in, import or sign-out.
- **Repository** (`src/app/data/user-data.js`): pure conversion/merge logic
  plus a repository that takes the Firebase Database functions as
  arguments (browser: CDN SDK 10.12.2; tests: npm `firebase`).
- **First sign-in import**: if the device has data the account doesn't, a
  dialog previews it (profile fields that would be filled, PB times per
  event, which account values are kept). Import fills only *empty* profile
  fields and adds PB times by union — nothing in the account is overwritten
  or removed. Imported entries have deterministic ids and the import is
  recorded under `meta/imports/{fingerprint}`, so the same data is never
  imported twice. "Not now" is remembered per account on this device; the
  import stays available from the Profile account card.
- **PB merging**: each time is a history entry; a save is a transaction
  that adds entries and keeps `time` as the fastest. Entry ids are
  deterministic per device, PB, position and time, so retrying a partly
  failed sync never duplicates a swim, while two devices adding times both
  keep theirs. Deleting a PB on any device deletes that event/course.
- **Profile**: last write wins (a later save from another device replaces
  the earlier one).

### Shared browsers and switching accounts

- Every account operation is tied to the uid and auth session it started
  in and re-checked after each network call; results from an earlier
  session are never shown or written locally.
- Signing out (or another tab signing out / in as someone else, or an
  expired session) restores this device's data and **reloads the page**,
  so nothing from that session stays in memory (analysis results, race
  reports, War Room output, form fields). A sign-out from another tab is
  confirmed for ~1 s first, so a momentary blip can't clear the page.
- If the page was closed while signed in, the account's copy is hidden
  before the page renders and only reloaded if Firebase confirms the same
  user is still signed in.
- Each account's photos stay on this device under its uid and are shown
  only while that account is signed in; the device's own photos are never
  shown in someone's account. Unsynced changes are kept only for, and only
  replayed into, the account that made them.
### Staying signed in (decided)

**Decision:** users stay signed in by default. Firebase
`browserLocalPersistence` is kept: a session survives reloads, other tabs
and browser restarts until the user logs out (or Firebase ends the
session). There is no "Keep me signed in" checkbox and no session-only
mode.

- The sign-in dialog says "You'll stay signed in on this browser until you
  log out", and the Profile account card shows a highlighted reminder to
  log out on a shared device, directly above the **Log Out** button. The
  nav's "Sign In" reads "Account" while signed in and opens that card.
- **Accepted risk on shared family/team devices:** someone who closes the
  tab without logging out leaves the next person signed in to their
  account. The reminders above are the mitigation.

### What stays on this device after sign-out

Sign-out removes the account's profile and PBs from the visible app and
puts this device's own data back. Two kinds of account-specific data are
**deliberately kept** on the device so that the user's work isn't lost:

| Kept under | What | Why it's kept | When it's used again |
|---|---|---|---|
| `swimtics:localPhotos:{uid}` | That account's profile photo and stroke-card photos | Photos aren't synced (§6), so this is the only copy | Shown again only when that same account signs in on this browser |
| `swimtics:pendingData:{uid}` | Profile/PB changes that hadn't reached the account yet (offline, error, sign-out mid-save) | Deleting them would lose the user's changes | Sent to that same account the next time it signs in here, then removed |

- Both are stored in this browser's `localStorage` only, under that
  account's uid. They are never shown to, or sent for, another account or
  the device's own signed-out view.
- They are **not cloud backups**: they exist only on this one device and
  are lost if the browser's site data is cleared, the browser profile is
  removed or the device is lost. Pending changes that never reach the
  account (because that account never signs in here again) stay on the
  device indefinitely; nothing removes them automatically.
- Anyone with access to this browser profile can read `localStorage`
  directly (e.g. developer tools), so a shared device still holds those
  photos and unsynced changes after sign-out.
- The Firebase session itself (`firebase:authUser:…`) is removed on
  sign-out.

### Database shape (`/users/{uid}`)

```
profile:  { name, dob, …, medals: string (≤200), updatedAt: number }
pbs:      { [eventKey]: { event, course, time, history: { [id]: { s: seconds, n: order } } } }
meta:     { imports: { [fingerprint]: { at, pbEntries, profileFields } } }
```

### Security rules (`database.rules.json`, **not deployed**)

Deny by default at the root. `/users/{uid}` is readable and writable only
when `auth.uid === uid`; nobody can read the root or list `/users`, and a
multi-path update that touches another user fails as a whole. Writes are
validated at every level: each section must be an object (a primitive
can't replace a section to skip child validation), only the known profile
fields as strings ≤200 chars (so no photos/base64), well-formed PBs and
history entries, bounded key lengths, and only the `profile`, `pbs` and
`meta` sections. Owners can delete their own data. Email verification is
**not** required to read/write your own data (open decision, §7).

Known limit: rules can't cap how many PBs or history entries an account
stores; the Spark plan's database storage/download quotas are the
backstop (§4, "Spark capacity").

## 3. Testing locally (no real Firebase project is ever used)

Requires Java 21 (`winget install Microsoft.OpenJDK.21`) and `npm install`.

```
npm test                    # unit tests, including user-data merge logic
npm run test:emulator       # security rules + repository vs Auth/Database emulators
npm run test:e2e:emulator   # browser: sign-up/verify, import/merge, reload, cross-device,
                            # sign-out, shared browser, password reset, cross-user denial
npm run test:e2e            # existing browser suite (production mode: accounts unavailable)
```

All emulator runs use the project ID `demo-swimtics`; Firebase guarantees
demo projects can't reach real resources. The page uses the emulators only
on `localhost`/`127.0.0.1` **and** with `?emulator` in the URL. CI runs
`npm test` and `npm run test:e2e`; the emulator suites need Java and are
not in CI yet.

## 4. Live Firebase project — current state and remaining steps

Confirmed by the project owner (not changed from this repository):

- Project `chase-ai-2bef7` is on the **Spark** (free) plan.
- **Email/Password sign-in is already enabled.**
- A **Realtime Database already exists** (Singapore region) and is empty.
- Its **temporary rules expired on 14 June 2026 and deny all reads and
  writes** — so nothing can use it until secure rules are deployed.
- Cloud Firestore exists but is empty and deny-all (not used by SWIMTICS).
- Firebase Storage and automatic Realtime Database backups require
  upgrading to **Blaze**.
- **Plan decision: stay on Spark for now**, and reconsider Blaze as
  database usage grows (see "Spark capacity" below). Not upgraded.
- Authorized domains: `localhost`, `chase-ai-2bef7.firebaseapp.com`,
  `chase-ai-2bef7.web.app` — **`swimtics.com` is not listed.**

Still to do, each as a separate reviewed step (none done here):

1. **Review and deploy `database.rules.json`** to the existing database,
   then confirm in the console that the deployed rules match the file
   before any user data exists (e.g. `firebase deploy --only database` by
   a human with project access; optionally re-run the rules tests first).
2. **Add `swimtics.com`** (and `www.swimtics.com` if used) to Auth's
   authorized domains, and review the verification / password-reset email
   templates and sender. (Email/password sign-in itself doesn't use
   redirects; authorized domains matter for email-action continue URLs
   and any future redirect/popup sign-in — confirm before launch.)
3. **Reviewed production `databaseURL` change**: add the existing
   Singapore instance's URL (copy it from the console; Singapore instances
   use the `…asia-southeast1.firebasedatabase.app` form) to the production
   `firebaseConfig` in `index.html`. This is the switch that turns
   accounts on in production, so it must come after steps 1–2.
4. Optional: enable App Check / Auth abuse protection.
5. Backups (§5) before accounts are announced.

### Spark capacity: simultaneous connections, not accounts

- Spark's Realtime Database limit is **100 simultaneous connections**. It
  is **not** a limit on registered accounts: any number of people can
  have accounts; what's limited is how many are connected to the database
  at the same moment.
- Each connected browser tab or device counts as one connection. The same
  person with SWIMTICS open in two tabs and on a phone uses three. In
  SWIMTICS a page connects once it reads or writes account data (i.e.
  while signed in) and stays connected while it's open; signed-out
  visitors don't connect.
- When the limit is reached, further connections are refused until others
  close, so additional signed-in pages can't load or save account data.
- **Review point (our own threshold, not a Firebase limit): 80
  simultaneous connections.** When the peak in the Realtime Database
  console's **Usage** tab (connections graph) reaches about 80, start
  planning — upgrade to Blaze or otherwise reduce connections — so there
  is time to act before the 100-connection limit. Check the peak
  regularly once accounts launch.
- Spark also has storage and download quotas for the database; the same
  Usage tab shows them.

## 5. Backup, export and restore (required before launch)

User data is **not** guaranteed safe until this exists and a restore has
been rehearsed.

### Spark backup plan (current plan — manual)

Spark has **no automatic backups**. Until that changes, backups are a
**manual** task done by a person with access to the Firebase console.
Nothing in this repository creates, stores or schedules them.

1. **Export**: in the Firebase console, open Realtime Database → **Data**,
   select the root of the database, open the ⋮ menu and choose **Export
   JSON**. This downloads the whole database as one JSON file. (If the
   database grows too large for the console export, the alternative is
   `firebase database:get / --project chase-ai-2bef7` run by the same
   person.)
2. **Store securely, outside the repository**: the export **contains user
   data** (emails aren't in it, but names, dates of birth, clubs and other
   profile fields and PBs are, keyed by user id; athletes may be minors).
   - Never commit it, attach it to an issue/PR, or put it in a shared
     folder.
   - Keep it in private, access-controlled storage with encryption (e.g.
     an encrypted drive or a private, encrypted cloud folder only the
     owner can open).
   - Name files by date, keep a small number of recent copies, and delete
     older ones on a schedule (e.g. keep the last 4 weekly and 3 monthly
     exports). Write down where they are and who can access them.
   - A user's data deleted from the live database remains in older exports
     until those exports are deleted — keep that in mind for deletion
     requests and the privacy policy.
3. **Frequency**: before accounts are announced, then on a fixed schedule
   (e.g. weekly) and before any risky change such as a rules deployment.
   Each export counts against Spark's download quota.
4. **Restore rehearsal** (at least once before launch, then occasionally):
   restore an export somewhere that is **not** the production database —
   the local Database Emulator under the `demo-swimtics` project (start it
   with `firebase emulators:start --only database --project demo-swimtics`,
   then load the file with an HTTP `PUT` of the JSON to
   `http://127.0.0.1:9000/.json?ns=demo-swimtics-default-rtdb` with the
   emulator-only admin header `Authorization: Bearer owner`) or a
   separate test Firebase project — and check the number of users, a
   sample of profiles and PBs, and that the rules still allow each owner
   to read their data. Record the steps and how
   long it took. Treat the restored copy as user data too and delete it
   afterwards. (Spark allows only one database per project, so a test
   copy can't live alongside production.)
5. **Real restore**: the console's **Import JSON** *replaces* the data at
   the chosen location. Use it on production only to recover from data
   loss, after taking a fresh export of the current state first.

Until the first export and rehearsal are done, user data must not be
described as backed up.

### Later options

- **Blaze (future option, not adopted)**: automatic daily Realtime
  Database backups, and Firebase Storage (needed for cloud photos, §6).
  Reconsider as database usage grows — in particular at the 80-connection
  review point above.
- **Scheduled export** (possible on either plan): e.g. a GitHub Action
  using a service account stored only as a CI secret — never in client
  code — writing to private storage with retention. Not set up; needs its
  own approval because it adds a credential and copies user data.
- **Per-user export / deletion**: "Download my data" (JSON of
  `/users/{uid}`) and "Delete my account and data" — not built yet.
- **Device copies** (`swimtics:guest:*`, `swimtics:pendingData:*`) are a
  convenience, not a backup.

## 6. Later stages (not implemented)

- **Supabase for production accounts** (D15, proposed): the code path
  exists behind `PRODUCTION_SUPABASE_ACCOUNTS`, which is off; while off,
  this Firebase path keeps the account card. Launch steps, and the
  conditions for public sign-ups and photos (under-18 legal advice, a
  published privacy policy): `docs/SUPABASE_PRODUCTION.md`.

- **Photos**: Firebase Storage needs the **Blaze** plan for this project.
  Until a decision is made, photos stay on each device (per account while
  signed in). Plan if adopted: resize client-side, upload to
  `/users/{uid}/photos/…` with owner-only Storage rules, store only the
  path in the database, keep the device copy until the upload succeeds.
  Alternative without Blaze: no cloud photos.
- **Analyzer reports**: to reopen a report later it needs, per analysis —
  stroke selected and support status; summary statistics of
  `metricsHistory` (elbow, alignment, rotation, armSymmetry, hipAlignment,
  kneeAngle, lateralX) with sample counts; detected stroke cycles and their
  timing basis (`videoTimestampMode`); the coaching rule results
  (`chaseRunCoachingRules()`: title, observed, interpretation,
  recommendation, evidence) and the Measured / Inferred / Indeterminate
  disclosure; engine version and the video's duration / fps / resolution
  (not the video). Raw per-frame pose data (`lastTrackedSequence`) is large;
  storing it is a separate decision.
- **Chronos race reports, War Room plans**: same pattern once their
  structured outputs are fixed.
- **Videos**: only with explicit approval and a retention/deletion policy
  (CLAUDE.md §14).

## 7. Privacy notes and open decisions

1. **Data minimisation**: existing profile fields include date of birth,
   gender, nationality, height, weight and wingspan; War Room collects
   soreness/body-map information (health-related; not synced). The sign-up
   form asks for name, gender, club and nationality — all optional; they go
   into the account profile. Athletes may be minors.
2. **Analytics** (D12): Microsoft Clarity session recording is paused and
   not loaded. Google Analytics (gtag, default config) is optional and loads
   only after the visitor accepts in the consent notice; the choice can be
   changed in Tools → Privacy & cookies. If Clarity is ever re-enabled it
   needs its own consent and masking review first: page text such as the
   Profile overview card, the PB list, the signed-in email and the import
   preview would otherwise be recordable. Still open: the privacy policy
   (not written yet) and Google Analytics' own settings.
3. Should cloud reads/writes require a verified email?
4. ~~"Keep me signed in" choice for shared devices?~~ Decided: stay signed
   in by default, no checkbox (§2, "Staying signed in").
5. Minimum age / parental consent; privacy policy and terms.
6. Account deletion and data export before launch?
7. Photos: upgrade to Blaze for Storage, or keep photos device-only? (For
   now the project stays on Spark, so photos stay device-only.)
