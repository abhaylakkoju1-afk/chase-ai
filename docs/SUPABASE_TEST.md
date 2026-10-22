# Supabase test mode (swimtics-test)

**Status: test-only prototype.** It is not a decision to migrate from
Firebase (see D14 in `DECISIONS.md`). Production, Firebase and `main`
are unchanged: test mode runs only with `?supabase` in the URL on
`localhost` / `127.0.0.1` or on a login-protected Vercel **preview** URL
of the `swimtics-web` project (`swimtics-web-…-swim-tics.vercel.app`) —
never on swimtics.com or the public Vercel alias `swimtics-web.vercel.app`
— and makes no network request anywhere else.

## What it covers
Sign up with email confirmation, log in, log out, staying signed in across
reloads (and a logout in one tab clearing the others), password reset via
an emailed link, the signed-in user's own `profiles` row (the 24
profile text fields; no photos) and **personal bests** (every recorded
swim, synced as it is saved or deleted), and a **first-sign-in import**
of this device's own profile and PBs (previewed, never overwriting the
account, never offered or imported twice), all protected by Row Level
Security. The **profile photo** on the overview card is kept per account
in a private Storage bucket (see "Profile photo" below).

Not covered yet: stroke-card photos, custom SMTP, backups, production
(production photos stay off — D15).

## Files
| File | Role |
|---|---|
| `src/app/data/supabase-test-core.js` | Pure helpers: the test-mode gate, key checks, redirect URLs, row mapping |
| `src/app/data/supabase-test-account.js` | Test-mode entry point: the gate and where the config comes from; loads the controller only when test mode applies |
| `src/app/data/supabase-accounts-core.js` | The account controller shared with production mode (supabase-js 2.117.2 from jsDelivr, PKCE flow) |
| `src/app/data/supabase-env.js` | The test and production environments: hosts, browser keys, and the project check (test mode refuses the production project) |
| `supabase/sql/001_profiles.sql` | The `profiles` table and RLS policies — **for review; not applied** |
| `supabase/sql/check_profiles_rls.sql` | Optional read-only RLS checks (rolled back) |
| `supabase/sql/002_personal_bests.sql` | `personal_bests`, `pb_entries`, `device_imports`, `add_pb_entries()` and their RLS — **for review; not applied** |
| `supabase/sql/check_pbs_rls.sql` | Optional read-only RLS checks for the PB tables and function (rolled back) |
| `src/app/data/supabase-test-pbs.js` | PB mapping, sync plan and import, reusing `user-data.js` (`pbKey`, `cleanLocalPb`, `deviceEntryId`, `planImport`) |
| `supabase/sql/003_profile_photos.sql` | The private `profile-photos` bucket (1 MiB, JPEG only), `swimtics_is_own_profile_photo()` and owner-only `storage.objects` policies — **for review; not applied** |
| `supabase/sql/check_photos_rls.sql` | Optional read-only checks of the bucket, its policies and photo isolation (rolled back) |
| `src/app/data/supabase-test-photos.js` | Profile photo: resize + re-encode (drops EXIF), metadata check, upload, short-lived signed URL, remove |
| `test/e2e/supabase-test-photos.spec.js`, `test/app/supabase-test-photos.test.js` | Photo browser tests (EXIF removed, owner-only, nothing left on the device) and unit tests |
| `scripts/supabase-test-config.mjs` | Writes the local browser config from `.env.supabase.local` |
| `api/supabase-test-config.js` | Vercel Function: hands the config to **Preview** deployments only, from Preview-only environment variables |
| `.env.supabase.example` | Template for the local, git-ignored `.env.supabase.local` |
| `test/e2e/supabase-test-mode.spec.js`, `test/e2e/support/fake-supabase.js` | Browser tests against an in-memory stand-in (no real project) |
| `test/e2e/supabase-preview.spec.js`, `test/app/supabase-preview-config.test.js` | The preview host gate and the preview config endpoint (missing / refused / valid) |

## Keys
Only the **project URL** and the **publishable key** (`sb_publishable_…`,
or the legacy `anon` key) are used. Locally they live in
`.env.supabase.local` and the generated
`src/app/data/supabase-config.local.js`, both git-ignored. On a preview
they come from two Vercel environment variables scoped to **Preview
only**, read at request time by `api/supabase-test-config.js`; no value is
committed or written into any deployed file. The config script and the page both refuse a secret
(`sb_secret_…`) or `service_role` key: those bypass RLS and must never
be used in the website.

## Setting up the test project (owner, in the Supabase dashboard)
1. **Review** `supabase/sql/001_profiles.sql`, then paste it into the
   swimtics-test **SQL editor** and run it. Then the same for
   `supabase/sql/002_personal_bests.sql` (it needs 001 first), and for
   `supabase/sql/003_profile_photos.sql` (creates the private bucket and
   its policies; check Storage → profile-photos shows it as private). (Not
   done by Claude.)
2. **Authentication → URL Configuration**: Site URL
   `http://127.0.0.1:4173`; Redirect URLs `http://127.0.0.1:4173/**` and
   `http://localhost:4173/**`.
3. **Authentication → Sign In / Providers → Email**: keep *Confirm email*
   on. Optionally set the minimum password length to 8 (the page already
   asks for 8).
4. Supabase's built-in email sender only delivers to the project
   organisation's **team members**, about 2 emails an hour, so test with
   your own address. A second test user for the RLS check can be added
   under Authentication → Users → Add user (auto-confirm).

## Running it locally
```
cp .env.supabase.example .env.supabase.local   # then fill in the two values
npm run supabase:test-config
node test/e2e/static-server.js                 # serves http://127.0.0.1:4173
```
Open `http://127.0.0.1:4173/?supabase`. The Profile account card shows
"Supabase test mode — <project>.supabase.co".

## Vercel preview (owner, dashboard steps — not done by Claude)
How it works: on a preview URL with `?supabase`, the page asks
`/api/supabase-test-config` for the config. That function answers only
when Vercel reports the deployment as a **Preview** (`VERCEL_ENV=preview`);
on Production it is always 404, even if the variables were set there. It
refuses a secret or `service_role` key (500, key not echoed). The page
checks the key type again before using it.

**Vercel — project `swimtics-web` (team `swim-tics`):**
1. Settings → **Environment Variables** → Add:
   - Key `SUPABASE_URL`, value: the swimtics-test Project URL
     (`https://<project-ref>.supabase.co`).
   - Key `SUPABASE_PUBLISHABLE_KEY`, value: the swimtics-test
     **publishable** key (`sb_publishable_…`). Never the secret /
     `service_role` key.
   - For both: Environments → tick **Preview** only (untick Production
     and Development). Preferably limit them to the branch
     `feat/supabase-auth-test`.
2. Settings → **Deployment Protection** → keep **Vercel Authentication**
   on for preview URLs (Standard Protection). Previews, including the
   config endpoint, then need a Vercel login.
3. Environment variables apply to new deployments only: a branch push
   (which needs approval) builds the preview. No build command or
   `vercel.json` change is needed.

**Supabase — swimtics-test:**
4. Authentication → **URL Configuration** → Redirect URLs → add
   `https://swimtics-web-*-swim-tics.vercel.app/**` (keep the two local
   ones). The Site URL can stay `http://127.0.0.1:4173`.
5. Email: the built-in sender still delivers only to team members, about
   2 per hour. Open each email link in the same browser, already logged in
   to Vercel.

**Checks on the first preview (after an approved push):**
- `https://swimtics-web-git-feat-supabase-auth-test-swim-tics.vercel.app/?supabase`
  → the Profile card shows "Supabase test mode — <project>.supabase.co".
- `…/api/supabase-test-config` on that preview returns JSON (if it shows
  JavaScript source instead, Vercel didn't deploy it as a function — stop).
- `https://swimtics-web.vercel.app/?supabase` and
  `https://swimtics-web.vercel.app/api/supabase-test-config` → Firebase's
  "Accounts aren't available yet" notice, and 404 respectively.
- Then the manual checklist below, on the preview URL.

## Manual checklist against swimtics-test
1. Sign Up with your email → "Check your email for a confirmation link".
2. Log in before confirming → "Please confirm your email first".
3. Open the confirmation email **in the same browser** (PKCE) → you're
   signed in; the address bar returns to `/?supabase`.
4. Reload → still signed in. Open a second tab → signed in there too.
5. Fill in name/club → Save Profile → "Saved to your test account"; the
   row appears in Table Editor → profiles with your user id.
6. Log Out → the page reloads → "You're not signed in"; the other tab
   reloads too; reload again → still signed out.
7. Forgot password → open the email in the same browser → "Set a new
   password" → new password works, old one doesn't.
8. Profile isolation (see below).
9. Personal bests and import (see below).
10. Profile photo (see below).
11. Optional, only after both test users have saved a profile row: run
    `check_profiles_rls.sql` with their two user ids; after both have
    saved at least one PB: run `check_pbs_rls.sql` with the same ids;
    after both have chosen a photo: run `check_photos_rls.sql`.

### Profile isolation (two users, one browser)
While a test account is signed in, the Profile form shows **that
account's** profile; this device's own (signed-out) profile is set aside
and put back when the account logs out or another account signs in, and
the page reloads so nothing of the previous account stays on screen.
1. Signed out: type a recognisable name (e.g. "Device Owner") → Save
   Profile → it saves on this device only.
2. Sign in as A → the form is empty (not "Device Owner") until A's own
   row loads; enter a fake name (e.g. "Alpha Test") → Save Profile.
3. Log Out → the page reloads → the form shows "Device Owner"; "Alpha
   Test" appears nowhere.
4. Sign in as B → the form is empty (or B's own saved name) — never
   "Alpha Test" or "Device Owner". Save a fake name for B (e.g. "Bravo
   Test") so both users have rows for the RLS checker.
5. Log Out → "Device Owner" again.
6. Sign in as A → "Alpha Test" comes back from A's row.

### Personal bests and import
1. Signed out: add a PB (e.g. Butterfly 100m, 1:10.00) — it stays on this
   device only.
2. Sign up / in as A → the PB list is **empty** (the device's PB isn't
   shown as A's). The Profile card offers to import this device's data,
   listing the PB times and empty profile fields it would add.
3. Choose **Not now** → the offer goes and doesn't come back for A on this
   device. (Or **Import** → "Imported into your test account: …"; the PB
   appears in A's list and in Table Editor → personal_bests / pb_entries;
   the offer doesn't come back.)
4. Add a PB as A → "Saved to your test account." Reload → it's still
   there. Sign in as A in another browser → it's there too; add a faster
   time there → both browsers show the faster time after a reload.
5. Delete a PB → it's gone from the account (and its swims).
6. Log Out → the device's own PBs (step 1) are back; A's are nowhere.
7. Sign in as B → B sees only B's PBs, never A's or the device's.

### Profile photo
How it works: while signed in, choosing the overview card's image resizes
the picture in the browser to at most 512 px and re-encodes it as JPEG,
which drops EXIF and other metadata (GPS location, camera, time); the
result is checked for metadata before upload. It is stored at
`profile-photos/<user id>/profile.jpg` (private bucket, owner-only
policies) and shown through a signed URL valid for 60 seconds, fetched
without caching into an in-memory `blob:` URL — nothing of it is written
to this device's storage. Signed out, the photo stays on this device as
before and is never uploaded.
1. Signed out: choose a photo → it shows, and stays on this device only.
2. Sign in as A → the card shows "Upload Image" (not the device's photo);
   the account card says "No photo in your test account".
3. Choose a phone photo that has a location (if available) → "Photo saved
   to your test account". In Storage → profile-photos there is one object,
   `<A's id>/profile.jpg`, at most 512 px on its longest side. Download it
   from the dashboard and check its properties / an EXIF viewer: no
   location or camera details.
4. Reload → A's photo comes back. Log Out → the device's photo (step 1) is
   back; A's photo is nowhere.
5. Sign in as B → "Upload Image"; never A's photo. Choose a photo for B.
6. As A: **Remove photo** → it's gone from the card and from Storage.

## Known limits
- Email links must be opened in the browser that requested them (PKCE).
- Free projects pause after about 7 days of low activity and have no
  automatic backups; the test project holds test data only.
- Profile rows are last-write-wins. While signed in, the form shows only
  the account's own profile; if a save to the account fails, that change
  is lost when you log out (the message says so).
- The profile text fields, personal bests and the profile photo are per
  account in test mode. The device's own (signed-out) profile photo is
  hidden while a test account is signed in, comes back after logout, and
  is never uploaded or offered for import — it stays exactly as before,
  including whatever metadata the original file had. **Stroke-card
  photos** are still this device's data and are shown whoever is signed in.
- The account photo is downloaded again on each page load (one signed URL
  per load; nothing is cached). One photo per account; choosing another
  replaces it. File size (1 MiB) and type (JPEG) are enforced by the
  Storage API; the browser keeps uploads well under that.
- HEIC photos (some iPhones) can't be decoded by most browsers: the page
  asks for JPEG, PNG or WebP. EXIF orientation is applied before
  re-encoding, so the photo keeps its correct rotation without the tag.
- A PB change that fails to reach the account (offline, error) says so
  and is lost on logout; there is no offline queue in test mode.
- Swim times are stored and compared at millisecond precision (the app's
  own time parsing leaves float noise, e.g. 68.03999999999999 for
  "1:08.04"); a best time shown as a typed string such as "1:08.04" is
  kept as typed. Times that aren't `ss.xx` or `m:ss.xx` (e.g. "31.2s")
  are treated as unknown, so the fastest swim's seconds are shown instead.
  `002_personal_bests.sql` needs PostgreSQL 13+ (`trim_scale`).
- Deleting a PB deletes that event/course (with all its swims) for the
  account on every device. Recorded swims can't be edited, only added or
  deleted with their PB.
