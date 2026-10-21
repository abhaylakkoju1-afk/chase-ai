# Production Supabase accounts (swimtics-production) — OFF

**Status: proposed (D15), behind a flag that is off.** Nothing about
Supabase runs on swimtics.com today. Firebase (`account.js`, D10) keeps
the account card ("Accounts aren't available yet"), and no production
credentials, production config file or production SQL exist in this
repository.

## Design
One account controller, two environments:

| | test (`swimtics-test`) | production (`swimtics-production`) |
|---|---|---|
| Entry point | `src/app/data/supabase-test-account.js` | `src/app/data/production-accounts.js` |
| Runs on | `?supabase` on `localhost` / `127.0.0.1` / a `swimtics-web` preview URL | `swimtics.com`, `www.swimtics.com` only |
| Switch | the URL | `PRODUCTION_SUPABASE_ACCOUNTS` in `src/app/data/accounts-flags.js` (**false**) |
| Config | `supabase-config.local.js` / `/api/supabase-test-config` (Preview only) | `src/app/data/supabase-production-config.js` — **does not exist yet** |
| Project check | must **not** be the production project | must be `PRODUCTION_PROJECT_REF` (**null** — so everything is refused) and never `TEST_PROJECT_REF` |
| Auth session key | `swimtics-test-auth` | `swimtics-auth` |
| Other browser keys | `swimtics-test:*` | `swimtics:sb:*` |
| Sign Up | offered | only if `PRODUCTION_PUBLIC_SIGNUPS` (**false**): otherwise hidden, and "invite-only" if called |
| Photos | not synced (test photo sync is the next PR) | not synced; stays off until the legal / privacy review |

- `src/app/data/supabase-env.js` (pure, unit-tested) holds the two
  environments, the host resolver (`resolveSupabaseEnv`: a host is test,
  production or neither — never both) and the per-environment config
  check (`checkEnvConfig`, on top of `checkPublicConfig`, which refuses
  secret / `service_role` keys). Project reference ids are public
  identifiers (the project URL's subdomain), not keys; the test one,
  `kcnedhhrjlyuxwapjojv`, is in the code.
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
project-separation matrix) and `test/e2e/supabase-production.spec.js`
(flag off loads nothing; flag forced on in the browser only: missing /
wrong-project / secret config fails closed; never on local or preview
hosts; sign-ups closed and production-only keys against the stand-in).

## Launch checklist (each step is its own approved PR or owner action)
1. Owner: confirm `swimtics-production` settings (sign-ups **off**, email
   confirmation on, MFA on the owner account, Resend SMTP, redirect URLs
   for swimtics.com only). Not done by Claude.
2. Owner applies `001_profiles.sql` and `002_personal_bests.sql` to
   production after re-review, and runs both RLS checkers (all PASS).
3. PR: set `PRODUCTION_PROJECT_REF` and add
   `supabase-production-config.js` (URL + **publishable** key only).
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
