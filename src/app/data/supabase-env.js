/* =========================================================
   SUPABASE ENVIRONMENTS — test and production, strictly separate (pure).
   - test       (swimtics-test): only with ?supabase on localhost /
                127.0.0.1 or a swimtics-web Vercel preview URL
                (isSupabaseTestMode in supabase-test-core.js).
   - production (swimtics-production): only on swimtics.com /
                www.swimtics.com, and only when the production flag is on.
   A host can never resolve to both. Each environment has its own browser
   storage keys and auth session key, and its config is checked against
   the project reference ids below, so test mode can't use the production
   project and production can't use the test project. Project reference
   ids are public identifiers (the subdomain of the project URL), not keys.
   ========================================================= */

import { checkPublicConfig, isSupabaseTestMode } from "./supabase-test-core.js";
import { PRODUCTION_HOSTS } from "./accounts-flags.js";

export { PRODUCTION_HOSTS };

export const TEST_PROJECT_REF = "kcnedhhrjlyuxwapjojv";          // swimtics-test
export const PRODUCTION_PROJECT_REF = null;                      // swimtics-production: set in the production-config PR

export const ENVIRONMENTS = Object.freeze({
    test: Object.freeze({
        name: "test",
        stateAttr: "supabaseTest",              // <html data-supabase-test="…">
        storageKey: "swimtics-test-auth",
        keyPrefix: "swimtics-test:",
        accountLabel: "test account",           // "Saved to your test account."
        notSignedIn: "You're not signed in to a test account.",
        noticeLabel: "Supabase test mode",
        showProjectBanner: true,
        photoSync: true,                        // profile photo in the private bucket (003_profile_photos.sql)
        importAction: "testImportDeviceData",   // global onclick names of the import offer
        dismissAction: "testDismissImport",
        debugGlobal: "swimticsSupabaseTest",
    }),
    production: Object.freeze({
        name: "production",
        stateAttr: "supabaseAccounts",          // <html data-supabase-accounts="…">
        storageKey: "swimtics-auth",
        keyPrefix: "swimtics:sb:",
        accountLabel: "account",
        notSignedIn: "You're not signed in.",
        noticeLabel: "Accounts",
        showProjectBanner: false,
        photoSync: false,                       // production photos stay off until the legal / privacy review (D15)
        importAction: "importDeviceData",
        dismissAction: "dismissImport",
        debugGlobal: "swimticsAccounts",
    }),
});

/* The per-environment browser storage keys used by the accounts core. */
export function storageKeys(env) {
    const p = env.keyPrefix;
    return {
        active: `${p}activeUid`,
        guest: `${p}guestProfile`,
        guestPbs: `${p}guestPbs`,
        device: `${p}deviceId`,
        dismissed: (uid, fingerprint) => `${p}importDismissed:${uid}:${fingerprint}`,
    };
}

/* "test", "production" or null. Test mode wins only where it is allowed
   (local / preview hosts), which never include the production hosts. */
export function resolveSupabaseEnv(hostname, search, flags = {}) {
    if (isSupabaseTestMode(hostname, search)) return "test";
    const host = String(hostname || "").toLowerCase();
    if (flags.productionAccounts === true && PRODUCTION_HOSTS.includes(host)) return "production";
    return null;
}

/* The project reference id of a Supabase project URL, or null. */
export function projectRef(url) {
    try {
        const m = new URL(url).hostname.toLowerCase().match(/^([a-z0-9-]+)\.supabase\.co$/);
        return m ? m[1] : null;
    } catch { return null; }
}

/* Publishable key only (checkPublicConfig), plus project separation:
   test mode refuses the production project; production refuses anything
   but the production project — and refuses everything while
   PRODUCTION_PROJECT_REF isn't set. */
export function checkEnvConfig(envName, config, refs = { test: TEST_PROJECT_REF, production: PRODUCTION_PROJECT_REF }) {
    const base = checkPublicConfig(config);
    if (!base.ok) return base;
    const ref = projectRef(config.url);
    if (envName === "test") {
        if (refs.production && ref === refs.production) {
            return { ok: false, reason: "That is the PRODUCTION project. Test mode only uses swimtics-test." };
        }
        return { ok: true };
    }
    if (envName === "production") {
        if (!refs.production) return { ok: false, reason: "The production project isn't set in the code yet (PRODUCTION_PROJECT_REF)." };
        if (refs.test && ref === refs.test) return { ok: false, reason: "That is the TEST project (swimtics-test); production never uses it." };
        if (ref !== refs.production) return { ok: false, reason: "That isn't the production project." };
        return { ok: true };
    }
    return { ok: false, reason: "Unknown environment." };
}
