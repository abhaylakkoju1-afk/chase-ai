// A small in-memory stand-in for a Supabase project (Auth, the REST
// endpoints and Storage for the profile-photos bucket), installed with
// Playwright routes so Supabase test mode can be exercised with the real
// supabase-js client without contacting any real project or using real
// credentials. It mimics the owner-only Row Level Security policies and
// limits in supabase/sql/001–003. Mail is kept in `fake.mailbox` instead
// of being sent.

import { createHash, randomUUID } from "node:crypto";
import { bestTimeAfterMerge } from "../../../src/app/data/supabase-test-pbs.js";

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
    const personalBests = new Map();  // pb id -> { id, user_id, pb_key, event, course, best_time }
    const pbEntries = [];             // { pb_id, user_id, entry_id, seconds, ord }
    const deviceImports = [];         // { user_id, fingerprint, pb_entries, profile_fields }
    const storageObjects = new Map(); // "bucket/name" -> { bytes: Buffer, contentType, cacheControl }
    const signTokens = new Map();     // token -> { key, expiresAt }
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
        const isJson = /json/.test(headers["content-type"] || "");
        const raw = req.postDataBuffer();
        requests.push({
            method, path: url.pathname, search: url.search, apikey: headers["apikey"], authorization: headers["authorization"] || "",
            body: raw && isJson ? raw.toString("utf8") : "", bytes: raw && !isJson ? raw : null,
            contentType: headers["content-type"] || "", upsert: headers["x-upsert"] || "", cacheControl: headers["cache-control"] || "",
        });
        const path = url.pathname;

        /* ----- Storage: a signed URL needs no API key or session, only its token ----- */
        const signed = path.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
        if (signed && method === "GET") {
            const t = signTokens.get(url.searchParams.get("token") || "");
            const key = `${signed[1]}/${decodeURIComponent(signed[2])}`;
            const obj = storageObjects.get(key);
            if (!t || t.key !== key || t.expiresAt < Date.now() || !obj) {
                return json(route, 400, { statusCode: "400", error: "InvalidJWT", message: "invalid signature" });
            }
            return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": obj.contentType, "cache-control": obj.cacheControl }, body: obj.bytes });
        }

        if (headers["apikey"] !== FAKE_KEY) return json(route, 401, { message: "Invalid API key" });
        const body = raw && isJson ? JSON.parse(raw.toString("utf8")) : {};

        /* ----- Storage: bucket profile-photos with the limits and owner-only
           policies of supabase/sql/003_profile_photos.sql ----- */
        const PHOTO_BUCKET = "profile-photos";
        const storageDenied = () => json(route, 403, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
        const notFound = () => json(route, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
        const ownsPhoto = (u, name) => !!u && name === `${u.id}/profile.jpg`;
        const upload = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
        if (upload && !path.startsWith("/storage/v1/object/sign/") && (method === "POST" || method === "PUT")) {
            const [, bucket, encoded] = upload;
            const name = decodeURIComponent(encoded);
            const u = tokenUser(headers);
            if (bucket !== PHOTO_BUCKET) return json(route, 400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
            if (!ownsPhoto(u, name)) return storageDenied();
            const type = String(headers["content-type"] || "").split(";")[0].trim();
            if (type !== "image/jpeg") return json(route, 400, { statusCode: "415", error: "invalid_mime_type", message: `mime type ${type} is not supported` });
            if (!raw || raw.length > 1048576) return json(route, 400, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
            const key = `${bucket}/${name}`;
            if (storageObjects.has(key) && method === "POST" && headers["x-upsert"] !== "true") {
                return json(route, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
            }
            storageObjects.set(key, { bytes: Buffer.from(raw), contentType: type, cacheControl: headers["cache-control"] || "" });
            return json(route, 200, { Id: randomUUID(), Key: key });
        }
        const sign = path.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
        if (sign && method === "POST") {
            const [, bucket, encoded] = sign;
            const name = decodeURIComponent(encoded);
            const key = `${bucket}/${name}`;
            if (bucket !== PHOTO_BUCKET || !ownsPhoto(tokenUser(headers), name) || !storageObjects.has(key)) return notFound();   // RLS hides others' objects
            const token = randomUUID();
            signTokens.set(token, { key, expiresAt: Date.now() + Number(body.expiresIn) * 1000 });
            return json(route, 200, { signedURL: `/object/sign/${bucket}/${encoded}?token=${token}` });
        }
        const removeObjects = path.match(/^\/storage\/v1\/object\/([^/]+)$/);
        if (removeObjects && method === "DELETE") {
            const u = tokenUser(headers);
            const removed = [];
            for (const name of body.prefixes || []) {
                const key = `${removeObjects[1]}/${name}`;
                if (removeObjects[1] === PHOTO_BUCKET && ownsPhoto(u, name) && storageObjects.delete(key)) removed.push({ name });
            }
            return json(route, 200, removed);
        }

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
        /* ----- REST: personal bests (mirrors supabase/sql/002_personal_bests.sql) ----- */
        const rlsDenied = (table) => json(route, 401, { code: "42501", message: `permission denied for table ${table}` });
        const eqParam = (name) => { const v = url.searchParams.get(name); return v && v.startsWith("eq.") ? v.slice(3) : null; };
        const withEntries = (pb) => ({
            pb_key: pb.pb_key, event: pb.event, course: pb.course, best_time: pb.best_time,
            pb_entries: pbEntries.filter((e) => e.pb_id === pb.id).map(({ entry_id, seconds, ord }) => ({ entry_id, seconds, ord })),
        });

        if (path === "/rest/v1/personal_bests") {
            const u = tokenUser(headers);
            if (method === "GET") {
                if (!u) return json(route, 200, []);                       // RLS: signed out sees nothing
                const wantUser = eqParam("user_id");
                const rows = [...personalBests.values()]
                    .filter((pb) => pb.user_id === u.id && (!wantUser || pb.user_id === wantUser));
                return json(route, 200, rows.map(withEntries));
            }
            if (method === "DELETE") {
                if (!u) return rlsDenied("personal_bests");
                const wantUser = eqParam("user_id");
                const wantKey = eqParam("pb_key");
                for (const pb of [...personalBests.values()]) {
                    if (pb.user_id !== u.id) continue;                        // RLS: only your own rows
                    if (wantUser && pb.user_id !== wantUser) continue;
                    if (wantKey && pb.pb_key !== wantKey) continue;
                    personalBests.delete(pb.id);
                    for (let i = pbEntries.length - 1; i >= 0; i--) if (pbEntries[i].pb_id === pb.id) pbEntries.splice(i, 1);
                }
                return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
            }
        }

        if (path === "/rest/v1/rpc/add_pb_entries" && method === "POST") {
            const u = tokenUser(headers);
            if (!u) return json(route, 401, { code: "42501", message: "not signed in" });
            if (!Array.isArray(body.p_entries) || body.p_entries.length > 500) {
                return json(route, 400, { code: "22023", message: "p_entries must be a JSON array of at most 500 entries" });
            }
            let pb = [...personalBests.values()].find((x) => x.user_id === u.id && x.pb_key === body.p_pb_key);
            if (!pb) {
                pb = { id: randomUUID(), user_id: u.id, pb_key: body.p_pb_key, event: body.p_event, course: body.p_course, best_time: body.p_time };
                personalBests.set(pb.id, pb);
            }
            for (const e of body.p_entries) {
                if (!pbEntries.some((x) => x.pb_id === pb.id && x.entry_id === e.entry_id)) {
                    pbEntries.push({ pb_id: pb.id, user_id: u.id, entry_id: e.entry_id, seconds: Number(e.seconds), ord: Number(e.ord) });
                }
            }
            pb.best_time = bestTimeAfterMerge(pb.best_time, body.p_time,
                pbEntries.filter((x) => x.pb_id === pb.id).map((x) => x.seconds));
            const out = withEntries(pb);
            out.pb_entries.sort((a, b) => (a.ord - b.ord) || a.entry_id.localeCompare(b.entry_id));
            return json(route, 200, out);
        }

        if (path === "/rest/v1/device_imports") {
            const u = tokenUser(headers);
            if (method === "GET") {
                if (!u) return json(route, 200, []);
                return json(route, 200, deviceImports.filter((r) => r.user_id === u.id).map((r) => ({ fingerprint: r.fingerprint })));
            }
            if (method === "POST") {
                const rows = Array.isArray(body) ? body : [body];
                if (!u || rows.some((r) => r.user_id !== u.id)) {
                    return json(route, u ? 403 : 401, { code: "42501", message: "new row violates row-level security policy for table \"device_imports\"" });
                }
                for (const r of rows) {
                    if (!deviceImports.some((x) => x.user_id === r.user_id && x.fingerprint === r.fingerprint)) deviceImports.push({ ...r });
                }
                return json(route, 201, []);
            }
        }

        return json(route, 404, { message: `fake Supabase: no handler for ${method} ${path}` });
    }

    return {
        users, profiles, mailbox, requests, personalBests, pbEntries, deviceImports, storageObjects, signTokens,
        /* a user's stored profile photo (Buffer) or null */
        photoOf: (userId) => (storageObjects.get(`profile-photos/${userId}/profile.jpg`) || {}).bytes || null,
        /* a user's PBs as { event, course, best_time, seconds[] } for assertions */
        pbsOf: (userId) => [...personalBests.values()].filter((pb) => pb.user_id === userId).map((pb) => ({
            event: pb.event, course: pb.course, best_time: pb.best_time,
            seconds: pbEntries.filter((e) => e.pb_id === pb.id).sort((a, b) => a.ord - b.ord).map((e) => e.seconds),
        })),
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
