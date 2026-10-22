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
2. Owner applies `001_profiles.sql` and `002_personal_bests.sql` to
   production after re-review, and runs both RLS checkers (all PASS).
3. PR: set `PRODUCTION_PROJECT_REF` and add
   `supabase-production-config.js` (URL + **publishable** key only) — this
   PR (`feat/supabase-production-config`).
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
