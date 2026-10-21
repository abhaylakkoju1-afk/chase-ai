/* =========================================================
   SUPABASE TEST MODE — test-only accounts against swimtics-test
   Active only with ?supabase in the URL on a local development host or a
   login-protected Vercel preview URL of swimtics-web (see
   isSupabaseTestMode); everywhere else — swimtics.com and the public
   swimtics-web.vercel.app included — this file does nothing and makes no
   network request. The account controller itself is the shared
   supabase-accounts-core.js, loaded only once test mode applies, with the
   test environment (supabase-env.js: test-only storage keys and session
   key, a config that must not be the production project).
   Uses only the project URL and publishable key: locally from the
   untracked src/app/data/supabase-config.local.js (npm run
   supabase:test-config); on a preview from /api/supabase-test-config,
   which reads Vercel Preview-only environment variables.
   ========================================================= */

import { isSupabaseTestMode, testModeHost } from "./supabase-test-core.js";

const PREVIEW_CONFIG_URL = "/api/supabase-test-config";

if (isSupabaseTestMode(location.hostname, location.search)) start();

/* The project URL and publishable key: { config } when found,
   { missing } when there is none, { bad } when it was refused. */
async function loadConfig() {
    if (testModeHost(location.hostname) === "local") {
        try {
            return { config: (await import("./supabase-config.local.js")).default };
        } catch {
            return { missing: "no local test configuration. Create .env.supabase.local and run npm run supabase:test-config." };
        }
    }
    let res;
    try {
        res = await fetch(PREVIEW_CONFIG_URL, { cache: "no-store", credentials: "same-origin" });
    } catch {
        return { missing: "couldn't reach this preview's test configuration." };
    }
    if (res.status === 404) {
        return { missing: "not configured for this preview. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY for the Preview environment in Vercel." };
    }
    if (!res.ok) {
        let reason = "";
        try { reason = (await res.json()).error || ""; } catch { /* ignore */ }
        return { bad: reason || "this preview's test configuration was refused." };
    }
    try { return { config: await res.json() }; } catch { return { bad: "this preview's test configuration couldn't be read." }; }
}

async function start() {
    document.documentElement.dataset.supabaseTest = "starting";
    let env, core;
    try {
        [{ ENVIRONMENTS: { test: env } }, core] = await Promise.all([import("./supabase-env.js"), import("./supabase-accounts-core.js")]);
    } catch {
        document.documentElement.dataset.supabaseTest = "no-library";
        return;
    }
    await core.startSupabaseAccounts({ ...env, loadConfig, signupsOpen: true });
}
