/* =========================================================
   PRODUCTION ACCOUNTS — Supabase accounts on swimtics.com (OFF)
   Proposed in D15; behind PRODUCTION_SUPABASE_ACCOUNTS (accounts-flags.js),
   which is false. While it is false this file loads nothing else and makes
   no network request, and Firebase (account.js) keeps the account card.
   When it is turned on, three gates still apply, in order, before any
   request to Supabase:
   1. host  — only swimtics.com / www.swimtics.com (resolveSupabaseEnv);
              local and preview hosts never run production mode.
   2. config — the production project URL + publishable key, which must
              be the swimtics-production project (checkEnvConfig refuses
              everything while PRODUCTION_PROJECT_REF is unset, and always
              refuses swimtics-test and secret / service_role keys).
   3. sign-ups — Sign Up is offered only if PRODUCTION_PUBLIC_SIGNUPS.
   The production config file does not exist yet; adding it is its own PR.
   ========================================================= */

import { PRODUCTION_SUPABASE_ACCOUNTS, PRODUCTION_PUBLIC_SIGNUPS, PRODUCTION_HOSTS } from "./accounts-flags.js";

const ACTIVE_KEY = "swimtics:sb:activeUid";      // storageKeys(production).active

function lsHas(key) { try { return localStorage.getItem(key) !== null; } catch { return false; } }

/* Checked first, before anything else is loaded: on every other host
   (local, preview, the Vercel alias) this file does nothing at all. */
const onProductionHost = PRODUCTION_HOSTS.includes(String(location.hostname || "").toLowerCase());

async function loadConfig() {
    try {
        return { config: (await import("./supabase-production-config.js")).default };
    } catch {
        return { missing: "accounts aren't configured on this site yet." };
    }
}

async function start() {
    const { resolveSupabaseEnv, ENVIRONMENTS } = await import("./supabase-env.js");
    if (resolveSupabaseEnv(location.hostname, location.search, { productionAccounts: true }) !== "production") return;
    const core = await import("./supabase-accounts-core.js");
    await core.startSupabaseAccounts({ ...ENVIRONMENTS.production, loadConfig, signupsOpen: PRODUCTION_PUBLIC_SIGNUPS === true });
}

/* Flag off: nothing — except, on a production host, if production accounts
   were on before and an account's data is still shown on this device, put
   the device's own data back (local only; no network request to Supabase). */
async function restoreOnly() {
    const [{ ENVIRONMENTS }, core] = await Promise.all([import("./supabase-env.js"), import("./supabase-accounts-core.js")]);
    core.restoreDeviceDataFor(ENVIRONMENTS.production);
}

if (!onProductionHost) { /* not a production host: nothing */ }
else if (PRODUCTION_SUPABASE_ACCOUNTS === true) start().catch(() => { /* stays off */ });
else if (lsHas(ACTIVE_KEY)) restoreOnly().catch(() => { /* ignore */ });
