// The Vercel function that hands Supabase test mode its config on PREVIEW
// deployments only (api/supabase-test-config.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import handler, { previewConfigResponse } from "../../api/supabase-test-config.js";

const URL_OK = "https://abcdefghijklmnop.supabase.co";
const KEY_OK = "sb_publishable_AbC123_test";
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

test("outside Preview it is always 404 and never returns a key, even if the variables are set", () => {
    for (const VERCEL_ENV of ["production", "development", undefined, "", "Preview", "PREVIEW"]) {
        const r = previewConfigResponse({ VERCEL_ENV, SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: KEY_OK });
        assert.equal(r.status, 404, String(VERCEL_ENV));
        assert.ok(!JSON.stringify(r.body).includes(KEY_OK));
        assert.ok(!JSON.stringify(r.body).includes(URL_OK));
    }
});

test("on Preview without the variables it is 404 (test mode reports it isn't configured)", () => {
    assert.equal(previewConfigResponse({ VERCEL_ENV: "preview" }).status, 404);
    assert.equal(previewConfigResponse({ VERCEL_ENV: "preview", SUPABASE_URL: "  ", SUPABASE_PUBLISHABLE_KEY: "" }).status, 404);
});

test("on Preview a partial, malformed, secret or service_role config is refused without echoing it", () => {
    const cases = [
        [{ SUPABASE_URL: URL_OK }, /SUPABASE_PUBLISHABLE_KEY is missing/],
        [{ SUPABASE_PUBLISHABLE_KEY: KEY_OK }, /SUPABASE_URL is missing/],
        [{ SUPABASE_URL: "https://evil.example.com", SUPABASE_PUBLISHABLE_KEY: KEY_OK }, /supabase\.co/],
        [{ SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: "sb_secret_DoNotShipThis" }, /SECRET key/],
        [{ SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: jwt({ role: "service_role" }) }, /service_role/],
        [{ SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: "random-string" }, /publishable key/],
    ];
    for (const [vars, reason] of cases) {
        const r = previewConfigResponse({ VERCEL_ENV: "preview", ...vars });
        assert.equal(r.status, 500, JSON.stringify(vars));
        assert.match(r.body.error, reason);
        assert.ok(!("publishableKey" in r.body) && !("url" in r.body));
        if (vars.SUPABASE_PUBLISHABLE_KEY) assert.ok(!r.body.error.includes(vars.SUPABASE_PUBLISHABLE_KEY), "key not echoed");
    }
});

test("on Preview a valid URL and publishable key are returned, trimmed", () => {
    const r = previewConfigResponse({ VERCEL_ENV: "preview", SUPABASE_URL: ` ${URL_OK}/ `, SUPABASE_PUBLISHABLE_KEY: ` ${KEY_OK} ` });
    assert.deepEqual(r, { status: 200, body: { url: URL_OK, publishableKey: KEY_OK } });
    const legacy = previewConfigResponse({ VERCEL_ENV: "preview", SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: jwt({ role: "anon" }) });
    assert.equal(legacy.status, 200);
});

test("the handler sends JSON that is never cached", () => {
    const saved = { ...process.env };
    try {
        Object.assign(process.env, { VERCEL_ENV: "preview", SUPABASE_URL: URL_OK, SUPABASE_PUBLISHABLE_KEY: KEY_OK });
        const headers = {}; let body = ""; const res = { statusCode: 0, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, end: (b) => { body = b; } };
        handler({}, res);
        assert.equal(res.statusCode, 200);
        assert.equal(headers["cache-control"], "no-store");
        assert.match(headers["content-type"], /application\/json/);
        assert.deepEqual(JSON.parse(body), { url: URL_OK, publishableKey: KEY_OK });

        process.env.VERCEL_ENV = "production";
        handler({}, res);
        assert.equal(res.statusCode, 404);
        assert.ok(!body.includes(KEY_OK) && !body.includes(URL_OK), "production response holds no config");
    } finally {
        for (const k of ["VERCEL_ENV", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]) {
            if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
        }
    }
});
