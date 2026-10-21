import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resolveSupabaseEnv, checkEnvConfig, projectRef, storageKeys, ENVIRONMENTS,
    TEST_PROJECT_REF, PRODUCTION_PROJECT_REF, PRODUCTION_HOSTS,
} from "../../src/app/data/supabase-env.js";
import { PRODUCTION_SUPABASE_ACCOUNTS, PRODUCTION_PUBLIC_SIGNUPS, PRODUCTION_HOSTS as FLAG_HOSTS } from "../../src/app/data/accounts-flags.js";

const PREVIEW = "swimtics-web-git-feat-x-swim-tics.vercel.app";
const KEY = "sb_publishable_abc123";
const url = (ref) => `https://${ref}.supabase.co`;
const PROD_REF = "prodrefexample000000";                 // a stand-in: the real one isn't in the code yet
const REFS = { test: TEST_PROJECT_REF, production: PROD_REF };

test("both production flags are off, and the production project isn't set yet", () => {
    assert.equal(PRODUCTION_SUPABASE_ACCOUNTS, false);
    assert.equal(PRODUCTION_PUBLIC_SIGNUPS, false);
    assert.equal(PRODUCTION_PROJECT_REF, null);
    assert.equal(TEST_PROJECT_REF, "kcnedhhrjlyuxwapjojv");
    assert.deepEqual([...PRODUCTION_HOSTS], ["swimtics.com", "www.swimtics.com"]);
    assert.equal(FLAG_HOSTS, PRODUCTION_HOSTS, "one host list, used by the entry point and the resolver");
});

test("a host resolves to test, production or nothing — never both", () => {
    const on = { productionAccounts: true };
    const hosts = ["localhost", "127.0.0.1", PREVIEW, "swimtics.com", "www.swimtics.com", "SWIMTICS.COM",
        "swimtics-web.vercel.app", "evil.swimtics.com", "swimtics.com.evil.test", "example.com", ""];
    for (const host of hosts) {
        for (const search of ["", "?supabase", "?supabase=1&x=2"]) {
            for (const flags of [{}, on, { productionAccounts: "true" }]) {
                const r = resolveSupabaseEnv(host, search, flags);
                assert.ok([null, "test", "production"].includes(r), `${host}${search}`);
                const isTestHost = ["localhost", "127.0.0.1", PREVIEW].includes(host);
                const isProdHost = PRODUCTION_HOSTS.includes(host.toLowerCase());
                if (r === "test") assert.ok(isTestHost && search, `${host}${search}: test only on a test host with ?supabase`);
                if (r === "production") {
                    assert.ok(isProdHost, `${host}: production only on swimtics.com`);
                    assert.equal(flags.productionAccounts, true, "production only with the flag strictly true");
                }
                if (isProdHost) assert.notEqual(r, "test", `${host} never runs test mode`);
                if (isTestHost) assert.notEqual(r, "production", `${host} never runs production mode`);
            }
        }
    }
    assert.equal(resolveSupabaseEnv("swimtics.com", "", {}), null, "flag off: nothing");
    assert.equal(resolveSupabaseEnv("swimtics.com", "?supabase", on), "production");
    assert.equal(resolveSupabaseEnv("localhost", "?supabase", on), "test");
    assert.equal(resolveSupabaseEnv("localhost", "", on), null);
});

test("each environment has its own storage keys and auth session key", () => {
    const t = storageKeys(ENVIRONMENTS.test);
    const p = storageKeys(ENVIRONMENTS.production);
    assert.deepEqual(
        { active: t.active, guest: t.guest, guestPbs: t.guestPbs, device: t.device, dismissed: t.dismissed("u", "f") },
        {
            active: "swimtics-test:activeUid", guest: "swimtics-test:guestProfile", guestPbs: "swimtics-test:guestPbs",
            device: "swimtics-test:deviceId", dismissed: "swimtics-test:importDismissed:u:f",
        },
        "test mode keeps the keys it already used",
    );
    assert.equal(ENVIRONMENTS.test.storageKey, "swimtics-test-auth");
    const all = (k) => [k.active, k.guest, k.guestPbs, k.device, k.dismissed("u", "f")];
    for (const key of all(p)) assert.ok(!all(t).includes(key) && key.startsWith("swimtics:sb:"), key);
    assert.notEqual(ENVIRONMENTS.production.storageKey, ENVIRONMENTS.test.storageKey);
    assert.notEqual(ENVIRONMENTS.production.stateAttr, ENVIRONMENTS.test.stateAttr);
    assert.notEqual(ENVIRONMENTS.production.importAction, ENVIRONMENTS.test.importAction);
});

test("projectRef reads the project reference id from a project URL only", () => {
    assert.equal(projectRef(url("kcnedhhrjlyuxwapjojv")), "kcnedhhrjlyuxwapjojv");
    assert.equal(projectRef("https://KCNEDHHRJLYUXWAPJOJV.supabase.co/"), "kcnedhhrjlyuxwapjojv");
    assert.equal(projectRef("https://a.b.supabase.co"), null);
    assert.equal(projectRef("https://supabase.co"), null);
    assert.equal(projectRef("not a url"), null);
});

test("config separation: test refuses production, production accepts only production", () => {
    const cases = [
        // [env, project ref, refs, ok?]
        ["test", TEST_PROJECT_REF, REFS, true],
        ["test", "fake-swimtics-test", REFS, true],           // the e2e stand-in
        ["test", PROD_REF, REFS, false],
        ["production", PROD_REF, REFS, true],
        ["production", TEST_PROJECT_REF, REFS, false],
        ["production", "someotherproject0000", REFS, false],
        ["production", "fake-swimtics-test", REFS, false],
        // as shipped: no production ref, so production refuses everything
        ["production", PROD_REF, undefined, false],
        ["production", TEST_PROJECT_REF, undefined, false],
        ["test", TEST_PROJECT_REF, undefined, true],
        ["staging", TEST_PROJECT_REF, REFS, false],
    ];
    for (const [env, ref, refs, ok] of cases) {
        const r = checkEnvConfig(env, { url: url(ref), publishableKey: KEY }, refs);
        assert.equal(r.ok, ok, `${env} with ${ref}: ${r.reason || "ok"}`);
        if (!ok) assert.ok(r.reason);
    }
    assert.match(checkEnvConfig("production", { url: url(PROD_REF), publishableKey: KEY }).reason, /PRODUCTION_PROJECT_REF/);
    assert.match(checkEnvConfig("test", { url: url(PROD_REF), publishableKey: KEY }, REFS).reason, /PRODUCTION/);
});

test("secret and service_role keys are refused in either environment, before the project check", () => {
    const serviceRole = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x";
    for (const env of ["test", "production"]) {
        for (const key of ["sb_secret_abc", serviceRole, ""]) {
            const r = checkEnvConfig(env, { url: url(env === "test" ? TEST_PROJECT_REF : PROD_REF), publishableKey: key }, REFS);
            assert.equal(r.ok, false, `${env} ${key}`);
        }
        assert.equal(checkEnvConfig(env, { url: "http://x.supabase.co", publishableKey: KEY }, REFS).ok, false);
    }
});
