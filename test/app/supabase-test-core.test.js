import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isSupabaseTestMode, testModeHost, checkPublicConfig, redirectUrl, cleanedSearch,
    profileToRow, rowToProfile, friendlyError,
} from "../../src/app/data/supabase-test-core.js";
import { PROFILE_FIELDS } from "../../src/app/data/user-data.js";

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

test("test mode needs ?supabase on a local host or a swimtics-web preview URL", () => {
    assert.equal(isSupabaseTestMode("127.0.0.1", "?supabase"), true);
    assert.equal(isSupabaseTestMode("localhost", "?supabase&code=abc"), true);
    assert.equal(isSupabaseTestMode("swimtics-web-git-feat-supabase-auth-test-swim-tics.vercel.app", "?supabase"), true);
    assert.equal(isSupabaseTestMode("swimtics-web-a1b2c3d4e-swim-tics.vercel.app", "?supabase"), true);
    // never without ?supabase, even on an allowed host
    assert.equal(isSupabaseTestMode("127.0.0.1", ""), false);
    assert.equal(isSupabaseTestMode("127.0.0.1", "?emulator"), false);
    assert.equal(isSupabaseTestMode("swimtics-web-git-main-swim-tics.vercel.app", ""), false);
});

test("production, the public Vercel alias and look-alike hosts never enable test mode", () => {
    for (const host of [
        "swimtics.com", "www.swimtics.com", "SWIMTICS.COM",
        "swimtics-web.vercel.app",                                  // public production alias
        "abhaylakkoju1-afk.github.io",
        "swimtics-web-git-main-other-team.vercel.app",              // another team
        "other-project-git-main-swim-tics.vercel.app",              // another project
        "evil-swimtics-web-git-x-swim-tics.vercel.app",             // prefix look-alike
        "swimtics-web-git-x-swim-tics.vercel.app.evil.com",         // suffix look-alike
        "swimtics-web--swim-tics.vercel.app",                       // empty middle part
        "swimtics-web-git-x-swim-tics.vercel.app:443",
        "127.0.0.1.evil.com", "",
    ]) {
        assert.equal(testModeHost(host), null, host);
        assert.equal(isSupabaseTestMode(host, "?supabase"), false, host);
    }
    assert.equal(testModeHost("127.0.0.1"), "local");
    assert.equal(testModeHost("swimtics-web-git-feat-x-swim-tics.vercel.app"), "preview");
});

test("only a project URL and a publishable (or legacy anon) key are accepted", () => {
    const url = "https://abcdefghijklmnop.supabase.co";
    assert.deepEqual(checkPublicConfig({ url, publishableKey: "sb_publishable_AbC123_x-y" }), { ok: true });
    assert.deepEqual(checkPublicConfig({ url, publishableKey: jwt({ role: "anon" }) }), { ok: true });

    const refused = (cfg) => { const r = checkPublicConfig(cfg); assert.equal(r.ok, false); return r.reason; };
    assert.match(refused({ url, publishableKey: "sb_secret_abc" }), /SECRET key/);
    assert.match(refused({ url, publishableKey: jwt({ role: "service_role" }) }), /service_role/);
    assert.match(refused({ url, publishableKey: "some-random-string" }), /publishable key/);
    assert.match(refused({ url, publishableKey: "" }), /missing/);
    assert.match(refused({ url: "", publishableKey: "sb_publishable_x" }), /missing/);
    for (const bad of ["http://abc.supabase.co", "https://abc.supabase.co.evil.com", "https://evil.com", "https://abc.supabase.co/rest/v1"]) {
        assert.match(refused({ url: bad, publishableKey: "sb_publishable_x" }), /supabase\.co/, bad);
    }
});

test("emails send the visitor back to this page in test mode", () => {
    assert.equal(redirectUrl("http://127.0.0.1:4173", "/"), "http://127.0.0.1:4173/?supabase");
    assert.equal(redirectUrl("http://localhost:4173", "/index.html", { reset: true }), "http://localhost:4173/index.html?supabase&reset=1");
});

test("Supabase's link parameters are removed from the address bar, test mode stays", () => {
    assert.equal(cleanedSearch("?supabase&code=abc"), "?supabase");
    assert.equal(cleanedSearch("?supabase&reset=1&code=abc"), "?supabase");
    assert.equal(cleanedSearch("?supabase&error=access_denied&error_code=otp_expired&error_description=Link+expired"), "?supabase");
    assert.equal(cleanedSearch("?code=abc"), "");
});

test("the profiles row holds only the known text fields (no photo), capped like the Firebase rules", () => {
    const row = profileToRow("u-1", { name: "  Alpha  ", club: "C".repeat(250), photo: "data:image/png;base64,AAAA", unknown: "x" });
    assert.equal(row.user_id, "u-1");
    assert.equal(row.name, "Alpha");
    assert.equal(row.club.length, 200);
    assert.equal(row.dob, null);
    assert.ok(!("photo" in row) && !("unknown" in row));
    assert.deepEqual(Object.keys(row).sort(), ["user_id", ...PROFILE_FIELDS].sort());

    assert.deepEqual(rowToProfile({ user_id: "u-1", name: "Alpha", club: null, dob: "", updated_at: "x" }), { name: "Alpha" });
    assert.deepEqual(rowToProfile(null), {});
});

test("auth errors become plain messages", () => {
    assert.match(friendlyError({ code: "email_not_confirmed" }), /confirm your email/);
    assert.match(friendlyError({ code: "invalid_credentials" }), /incorrect/);
    assert.match(friendlyError({ message: "Email rate limit exceeded" }), /wait/);
    assert.match(friendlyError({ message: "Failed to fetch" }), /Couldn't reach/);
    assert.match(friendlyError({}), /Something went wrong/);
});
