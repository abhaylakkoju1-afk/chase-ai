// A small in-memory stand-in for a Supabase project (Auth + the `profiles`
// REST endpoint), installed with Playwright routes so Supabase test mode
// can be exercised with the real supabase-js client without contacting any
// real project or using real credentials. It mimics the owner-only Row
// Level Security policies in supabase/sql/001_profiles.sql. Mail is kept in
// `fake.mailbox` instead of being sent.

import { createHash, randomUUID } from "node:crypto";

export const FAKE_URL = "https://fake-swimtics-test.supabase.co";
export const FAKE_KEY = "sb_publishable_fakeTestKey123";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt(payload) {
    return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.${b64url("fake-signature")}`;
}

export function createFakeSupabase() {
    const users = new Map();          // email -> user record
    const sessions = new Map();       // access token -> user id
    const refresh = new Map();        // refresh token -> user id
    const codes = new Map();          // auth code -> { userId, challenge, type }
    const profiles = new Map();       // user id -> row
    const mailbox = [];
    const requests = [];

    const publicUser = (u) => ({
        id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
        email_confirmed_at: u.confirmedAt, confirmed_at: u.confirmedAt,
        created_at: u.createdAt, updated_at: u.createdAt,
        app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [],
    });

    function issueSession(u) {
        const now = Math.floor(Date.now() / 1000);
        const access = jwt({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, iat: now, exp: now + 3600, session_id: randomUUID() });
        const rt = randomUUID();
        sessions.set(access, u.id);
        refresh.set(rt, u.id);
        return { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user: publicUser(u) };
    }

    const byId = (id) => [...users.values()].find((u) => u.id === id);
    const tokenUser = (headers) => {
        const auth = headers["authorization"] || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        const id = sessions.get(token);
        return id ? byId(id) : null;
    };

    function newCode(userId, challenge, type) {
        const code = randomUUID();
        codes.set(code, { userId, challenge, type });
        return code;
    }

    const json = (route, status, body, extra = {}) => route.fulfill({
        status,
        contentType: "application/json",
        headers: { "x-supabase-api-version": "2024-01-01", "access-control-allow-origin": "*", ...extra },
        body: body === undefined ? "" : JSON.stringify(body),
    });
    const authError = (route, status, error_code, msg) => json(route, status, { code: status, error_code, msg });

    async function handle(route) {
        const req = route.request();
        const url = new URL(req.url());
        const headers = req.headers();
        const method = req.method();
        if (method === "OPTIONS") {
            return route.fulfill({ status: 200, headers: {
                "access-control-allow-origin": "*", "access-control-allow-headers": "*",
                "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
            } });
        }
        requests.push({ method, path: url.pathname, search: url.search, apikey: headers["apikey"], authorization: headers["authorization"] || "", body: req.postData() || "" });
        if (headers["apikey"] !== FAKE_KEY) return json(route, 401, { message: "Invalid API key" });
        const body = req.postData() ? JSON.parse(req.postData()) : {};
        const path = url.pathname;

        /* ----- Auth ----- */
        if (path === "/auth/v1/signup" && method === "POST") {
            const email = String(body.email || "").toLowerCase();
            if (String(body.password || "").length < 6) return authError(route, 422, "weak_password", "Password should be at least 6 characters.");
            if (!users.has(email)) {
                users.set(email, { id: randomUUID(), email, password: body.password, confirmedAt: null, createdAt: new Date().toISOString() });
            }
            const u = users.get(email);
            if (!u.confirmedAt) {
                const code = newCode(u.id, body.code_challenge, "signup");
                const to = new URL(url.searchParams.get("redirect_to"));
                to.searchParams.set("code", code);
                mailbox.push({ to: email, kind: "confirm", link: to.toString(), code });
            }
            return json(route, 200, publicUser(u));                      // no session until confirmed
        }
        if (path === "/auth/v1/token" && method === "POST") {
            const grant = url.searchParams.get("grant_type");
            if (grant === "password") {
                const u = users.get(String(body.email || "").toLowerCase());
                if (!u || u.password !== body.password) return authError(route, 400, "invalid_credentials", "Invalid login credentials");
                if (!u.confirmedAt) return authError(route, 400, "email_not_confirmed", "Email not confirmed");
                return json(route, 200, issueSession(u));
            }
            if (grant === "pkce") {
                const entry = codes.get(body.auth_code);
                if (!entry) return authError(route, 400, "bad_code_verifier", "invalid flow state, no valid flow state found");
                const challenge = b64url(createHash("sha256").update(String(body.code_verifier || "")).digest());
                if (entry.challenge && entry.challenge !== challenge) return authError(route, 400, "bad_code_verifier", "code challenge does not match previously saved code verifier");
                codes.delete(body.auth_code);
                const u = byId(entry.userId);
                if (entry.type === "signup") u.confirmedAt = new Date().toISOString();
                return json(route, 200, issueSession(u));
            }
            if (grant === "refresh_token") {
                const id = refresh.get(body.refresh_token);
                if (!id) return authError(route, 400, "refresh_token_not_found", "Invalid Refresh Token");
                refresh.delete(body.refresh_token);
                return json(route, 200, issueSession(byId(id)));
            }
        }
        if (path === "/auth/v1/user" && method === "GET") {
            const u = tokenUser(headers);
            return u ? json(route, 200, publicUser(u)) : authError(route, 401, "bad_jwt", "invalid JWT");
        }
        if (path === "/auth/v1/user" && method === "PUT") {
            const u = tokenUser(headers);
            if (!u) return authError(route, 401, "bad_jwt", "invalid JWT");
            if (body.password) u.password = body.password;
            return json(route, 200, publicUser(u));
        }
        if (path === "/auth/v1/logout" && method === "POST") {
            const token = (headers["authorization"] || "").replace(/^Bearer\s+/i, "");
            sessions.delete(token);
            return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
        }
        if (path === "/auth/v1/recover" && method === "POST") {
            const u = users.get(String(body.email || "").toLowerCase());
            if (u) {
                const code = newCode(u.id, body.code_challenge, "recovery");
                const to = new URL(url.searchParams.get("redirect_to"));
                to.searchParams.set("code", code);
                mailbox.push({ to: u.email, kind: "reset", link: to.toString(), code });
            }
            return json(route, 200, {});                                  // same answer whether or not the email exists
        }

        /* ----- REST: public.profiles with owner-only RLS ----- */
        if (path === "/rest/v1/profiles") {
            const u = tokenUser(headers);
            const wantsObject = /vnd\.pgrst\.object/.test(headers["accept"] || "");
            if (method === "GET") {
                const filter = url.searchParams.get("user_id");               // e.g. "eq.<uuid>"
                let rows = u ? [profiles.get(u.id)].filter(Boolean) : [];   // RLS: only your own row is visible
                if (filter) rows = rows.filter((r) => `eq.${r.user_id}` === filter);
                if (wantsObject) return rows.length === 1 ? json(route, 200, rows[0]) : json(route, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
                return json(route, 200, rows);
            }
            if (method === "POST") {
                const rows = Array.isArray(body) ? body : [body];
                if (!u || rows.some((r) => r.user_id !== u.id)) {
                    return json(route, u ? 403 : 401, { code: "42501", message: "new row violates row-level security policy for table \"profiles\"" });
                }
                const saved = rows.map((r) => {
                    const row = { ...(profiles.get(u.id) || {}), ...r, updated_at: new Date().toISOString() };
                    profiles.set(u.id, row);
                    return row;
                });
                if (wantsObject) return json(route, 201, saved[0]);
                return json(route, 201, saved);
            }
        }
        return json(route, 404, { message: `fake Supabase: no handler for ${method} ${path}` });
    }

    return {
        users, profiles, mailbox, requests,
        tokenOwner: (authorization) => sessions.get(String(authorization || "").replace(/^Bearer\s+/i, "")) || null,
        lastMail: (to, kind) => [...mailbox].reverse().find((m) => m.to === to.toLowerCase() && m.kind === kind),
        async install(context, { config = { url: FAKE_URL, publishableKey: FAKE_KEY } } = {}) {
            await context.route(`${FAKE_URL}/**`, handle);
            await context.route("**/src/app/data/supabase-config.local.js", (route) => route.fulfill({
                status: 200, contentType: "text/javascript", body: `export default ${JSON.stringify(config)};`,
            }));
        },
    };
}
