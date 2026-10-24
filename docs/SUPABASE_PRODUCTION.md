# Production Supabase accounts (swimtics-production) — OFF

**Status: proposed (D15), behind a flag that is off.** Nothing about
Supabase runs on swimtics.com today. Firebase (`account.js`, D10) keeps
the account card ("Accounts aren't available yet"). The production
**public** config (project URL + publishable key) is committed but is
never fetched while the flag is off; no secret key or production SQL is
in this repository.

## Design
One account controller, two environments:

| | test (`swimtics-test`) | production (`swimtics-production`) |
|---|---|---|
| Entry point | `src/app/data/supabase-test-account.js` | `src/app/data/production-accounts.js` |
| Runs on | `?supabase` on `localhost` / `127.0.0.1` / a `swimtics-web` preview URL | `swimtics.com`, `www.swimtics.com` only |
| Switch | the URL | `PRODUCTION_SUPABASE_ACCOUNTS` in `src/app/data/accounts-flags.js` (**false**) |
| Config | `supabase-config.local.js` / `/api/supabase-test-config` (Preview only) | `src/app/data/supabase-production-config.js` — committed, public (URL + publishable key); written by `npm run supabase:production-config` from the git-ignored `.env.supabase.production.local` |
| Project check | must **not** be the production project | must be `PRODUCTION_PROJECT_REF` (`jqyctrbzwxrpscieldif`) and never `TEST_PROJECT_REF` |
| Auth session key | `swimtics-test-auth` | `swimtics-auth` |
| Other browser keys | `swimtics-test:*` | `swimtics:sb:*` |
| Sign Up | offered | only if `PRODUCTION_PUBLIC_SIGNUPS` (**false**): otherwise hidden, and "invite-only" if called |
| Profile photo | per account in the private `profile-photos` bucket (`photoSync: true`; `003_profile_photos.sql`) | `photoSync: false` — the photo module isn't loaded; stays off until the legal / privacy review |

- `src/app/data/supabase-env.js` (pure, unit-tested) holds the two
  environments, the host resolver (`resolveSupabaseEnv`: a host is test,
  production or neither — never both) and the per-environment config
  check (`checkEnvConfig`, on top of `checkPublicConfig`, which refuses
  secret / `service_role` keys). Project reference ids are public
  identifiers (the project URL's subdomain), not keys; both are in the
  code: test `kcnedhhrjlyuxwapjojv`, production `jqyctrbzwxrpscieldif`.
- The publishable key is public by design (anyone can read it from the
  site once it is fetched) and allows only what Row Level Security
  allows; it is committed like any other static file. The secret /
  `service_role` key never is: the config script, the page and the tests
  all refuse it. To replace the key: put the new publishable key in
  `.env.supabase.production.local` (see `.env.supabase.production.example`),
  run `npm run supabase:production-config` (it never prints the key), and
  commit the regenerated file in its own PR.
- `src/app/data/supabase-accounts-core.js` is the controller extracted
  unchanged from test mode (sign-in modal, sessions, profile row, PB sync,
  first-sign-in import, per-account working copy). Entry points load it
  only once their environment applies.
- **With the flag off**, `production-accounts.js` imports only
  `accounts-flags.js` (which also holds the production host list) and
  checks the host first: on any other host it stops there. On
  swimtics.com / www.swimtics.com, one exception, local only: if a
  production account's data is still shown on the device (an earlier
  flag-on period), it puts the device's own data back — no config,
  library, auth or project request.
- **With the flag on**, before any request to Supabase: the host must be a
  production host, the production config must exist and name the
  production project with a publishable key. Otherwise the account card
  says why and nothing is contacted.
- Production uses the same tables, functions and RLS as test
  (`supabase/sql/001_profiles.sql`, `002_personal_bests.sql`).

Tests: `test/app/supabase-env.test.js` (resolver, keys, the
project-separation matrix), `test/app/supabase-production-config.test.js`
(the committed config: production project, publishable key only, refused
by test mode; the config script refuses secret / JWT keys and never prints
the key) and `test/e2e/supabase-production.spec.js` (flag off with the
real config: nothing loaded or requested; flag forced on in the browser
only: the real config is accepted on swimtics.com / www.swimtics.com and
nowhere else, the test project and look-alikes are refused; test mode
refuses the production project; sign-ups closed and production-only keys
against the stand-in). Every request to the real production project is
aborted in these tests, and each test fails if one was attempted.

## Launch checklist (each step is its own approved PR or owner action)
1. Owner: confirm `swimtics-production` settings (sign-ups **off**, email
   confirmation on, MFA on the owner account, Resend SMTP, redirect URLs
   for swimtics.com only). Not done by Claude.
2. Owner applies the schema to production after re-review — see
   "Applying the schema to production" below — and
   `check_production_schema.sql` reports every check PASS.
3. PR: set `PRODUCTION_PROJECT_REF` and add
   `supabase-production-config.js` (URL + **publishable** key only) —
   done (PR #39).
4. Backups / export and account deletion plan (`docs/ACCOUNTS.md` §5–7).
5. PR: `PRODUCTION_SUPABASE_ACCOUNTS = true` — invite-only accounts
   (owner-created users); what happens to the unused Firebase account path
   is decided in that PR.
6. **Public sign-ups** (`PRODUCTION_PUBLIC_SIGNUPS = true` and enabling
   sign-ups in the dashboard) only after: qualified Indian legal advice on
   the under-18 / parental-consent approach, and the privacy policy
   reviewed and published.
7. **Production photos** only after the same legal and privacy review,
   using the private per-account storage design proven in test.

Never: a secret / `service_role` key in the website, testing against
`swimtics-production`, or production SQL / settings changes without the
owner.

## Applying the schema to production (owner; not done by Claude)
The same two files as on swimtics-test, unchanged in effect: each runs as
one transaction (an error part-way leaves nothing behind) and is safe to
re-run.
1. **Rehearse on swimtics-test first**: open `check_production_schema.sql`,
   set the environment line at the top to `'test'`, run it in the
   swimtics-test SQL editor → every check PASS (step 49, photos, shows
   N/A there).
2. In the **swimtics-production** SQL editor (check the project name in
   the dashboard header), paste and run `supabase/sql/001_profiles.sql`,
   then `supabase/sql/002_personal_bests.sql`.
3. Run `check_production_schema.sql` as shipped (environment
   `'production'`) → every check PASS.
4. Do **not** run `003_profile_photos.sql` on production (photos stay off;
   step 49 fails if it was). Do not run `check_profiles_rls.sql`,
   `check_pbs_rls.sql` or `check_photos_rls.sql` there either: they need
   test users with saved data, and production is never used for testing.

`check_production_schema.sql` needs no user ids and reads no user rows. It
checks the four tables, their columns, keys and cascading foreign keys,
RLS enabled and forced, the exact twelve owner-only policies and no
others, the privileges of `anon` (none) and `authenticated` (exactly what
the app needs; swims and imports not editable), the PB functions (caller's
rights, fixed `search_path`, no overloads, no SECURITY DEFINER function in
`public`), the triggers, that every `public` table has RLS, and that the
photo bucket is absent. Its probes change nothing: signed out, every table
and `add_pb_entries()` are refused; signed in as an id that is no real
user, every table shows 0 rows; `add_pb_entries()` without a user is
refused before it writes. Not checkable in SQL — confirm in the dashboard:
sign-ups off, email confirmation, SMTP, redirect URLs, MFA.

**The RLS auto-enable hook.** One SECURITY DEFINER function is allowed:
Supabase's "enable RLS on new tables" hook, only as the version the owner
verified on swimtics-test (step 54):
- `public.rls_auto_enable()`, body (`prosrc`) md5
  `c44fb229ea8a6b0afd04a0a33261c16c`;
- owned by `postgres`, SECURITY DEFINER, `search_path=pg_catalog`, returns
  `event_trigger`;
- used only by the enabled event trigger `ensure_rls` on
  `ddl_command_end` for `CREATE TABLE`, `CREATE TABLE AS` and
  `SELECT INTO`.

Absent is fine too. Any other version — a different body, owner,
settings, trigger, event or tags — fails step 54, and then step 28, which
still fails every other SECURITY DEFINER function in `public`. The hook
**logs rather than aborts** if enabling RLS on a new table fails (reviewed
by the owner in its definition on swimtics-test), so a table can still end
up without RLS: step 48 keeps checking every existing `public` table
directly. If Supabase updates the hook, step 54 fails until the new
definition has been reviewed and its md5 updated in the checker.

### Rehearsal record
- **2026-10-24, swimtics-test** (owner, SQL editor, environment `'test'`):
  `check_production_schema.sql` — every check PASS; step 49 (profile
  photos) N/A, as expected on the test project. The RLS auto-enable hook
  there was reviewed first (read-only queries): body md5
  `c44fb229ea8a6b0afd04a0a33261c16c`, owner `postgres`, SECURITY
  DEFINER, `search_path=pg_catalog`, returns `event_trigger`, enabled
  event trigger `ensure_rls` on `ddl_command_end` for `CREATE TABLE`,
  `CREATE TABLE AS`, `SELECT INTO`.
- **swimtics-production**: not run yet — 001 / 002 not applied
  (launch-checklist step 2).
