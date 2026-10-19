/* =========================================================
   SUPABASE TEST MODE — pure helpers (no DOM, no network)
   Test-only account prototype against the hosted swimtics-test project.
   It is never active on swimtics.com or the public Vercel alias
   swimtics-web.vercel.app: only on a local development host or a
   (login-protected) Vercel preview URL of the swimtics-web project, and
   only with ?supabase in the URL.
   Browser side: supabase-test-account.js. Preview config:
   api/supabase-test-config.js. Docs: docs/SUPABASE_TEST.md.
   ========================================================= */

import { PROFILE_FIELDS, sanitizeProfile } from "./user-data.js";

export const TEST_MODE_PARAM = "supabase";
export const LOCAL_HOSTS = Object.freeze(["localhost", "127.0.0.1"]);

/* Vercel preview URLs of the swimtics-web project in the swim-tics team:
   swimtics-web-git-<branch>-swim-tics.vercel.app and
   swimtics-web-<deployment-id>-swim-tics.vercel.app. The production alias
   swimtics-web.vercel.app (no "-…-swim-tics" part) does not match. A
   production deployment's own URL has the same shape, but there the config
   endpoint answers 404 (it serves Preview deployments only), so test mode
   stays off. */
export const PREVIEW_HOST = /^swimtics-web-[a-z0-9]+(?:-[a-z0-9]+)*-swim-tics\.vercel\.app$/;

/* "local", "preview", or null for every other host. */
export function testModeHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (LOCAL_HOSTS.includes(host)) return "local";
    if (PREVIEW_HOST.test(host)) return "preview";
    return null;
}

/* Supabase test mode runs only on a local or preview host, and only when
   the URL asks for it. */
export function isSupabaseTestMode(hostname, search) {
    if (!testModeHost(hostname)) return false;
    try { return new URLSearchParams(search || "").has(TEST_MODE_PARAM); } catch { return false; }
}

/* ---------- connection details: only a project URL and a publishable key ---------- */

export function decodeJwtPayload(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const json = typeof atob === "function"
            ? atob(b64 + "===".slice((b64.length + 3) % 4))
            : Buffer.from(b64, "base64").toString("utf8");
        return JSON.parse(json);
    } catch { return null; }
}

/* Returns { ok: true } or { ok: false, reason }. A secret / service_role
   key is always refused: it bypasses Row Level Security and must never
   reach browser code. */
export function checkPublicConfig({ url, publishableKey } = {}) {
    const key = String(publishableKey || "").trim();
    if (!url) return { ok: false, reason: "SUPABASE_URL is missing." };
    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, reason: "SUPABASE_URL is not a valid URL." }; }
    if (parsed.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname) || (parsed.pathname !== "/" && parsed.pathname !== "")) {
        return { ok: false, reason: "SUPABASE_URL must look like https://<project-ref>.supabase.co" };
    }
    if (!key) return { ok: false, reason: "SUPABASE_PUBLISHABLE_KEY is missing." };
    if (/^sb_secret_/i.test(key)) return { ok: false, reason: "That is a SECRET key. Use the publishable key (sb_publishable_…); a secret key must never be used in the website." };
    if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return { ok: true };
    const claims = decodeJwtPayload(key);
    if (claims && claims.role === "anon") return { ok: true };            // legacy "anon" key
    if (claims && claims.role === "service_role") return { ok: false, reason: "That is the service_role key. Use the publishable (or legacy anon) key; service_role must never be used in the website." };
    return { ok: false, reason: "SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_…) or the legacy anon key." };
}

/* ---------- auth URLs ---------- */

/* Where confirmation and reset emails send the visitor back to: this page
   in test mode, with a marker for the reset flow. */
export function redirectUrl(origin, pathname, { reset = false } = {}) {
    return `${origin}${pathname}?${TEST_MODE_PARAM}${reset ? "&reset=1" : ""}`;
}

/* The query string after Supabase's own parameters have been handled. */
export function cleanedSearch(search) {
    const params = new URLSearchParams(search || "");
    for (const key of ["code", "reset", "error", "error_code", "error_description", "type"]) params.delete(key);
    const rest = params.toString().replace(/=(&|$)/g, "$1");
    return rest ? `?${rest}` : "";
}

/* ---------- the protected profile row ---------- */

/* The `profiles` table row for this user: only the existing text fields
   (the photo stays on the device). */
export function profileToRow(userId, profile) {
    const clean = sanitizeProfile(profile || {});
    const row = { user_id: userId };
    for (const field of PROFILE_FIELDS) row[field] = clean[field] ?? null;
    return row;
}

export function rowToProfile(row) {
    const out = {};
    if (!row) return out;
    for (const field of PROFILE_FIELDS) {
        if (typeof row[field] === "string" && row[field] !== "") out[field] = row[field];
    }
    return out;
}

export function friendlyError(error) {
    const code = (error && (error.code || error.error_code)) || "";
    const msg = String((error && error.message) || "");
    if (code === "email_not_confirmed" || /email not confirmed/i.test(msg)) return "Please confirm your email first — check your inbox for the link.";
    if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return "Email or password is incorrect.";
    if (code === "user_already_exists" || /already registered/i.test(msg)) return "An account with this email already exists. Try logging in.";
    if (code === "weak_password" || /password should be/i.test(msg)) return "Please choose a stronger password (at least 8 characters).";
    if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || /rate limit/i.test(msg)) return "Too many emails or attempts right now. Please wait and try again.";
    if (/failed to fetch|network/i.test(msg)) return "Couldn't reach the test server. Check your connection and try again.";
    return "Something went wrong. Please try again.";
}
