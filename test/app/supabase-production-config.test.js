// The committed production browser config and the script that writes it.
// Assertions on the key never print it: failures report only true/false.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import config from "../../src/app/data/supabase-production-config.js";
import { checkEnvConfig, projectRef, PRODUCTION_PROJECT_REF, TEST_PROJECT_REF } from "../../src/app/data/supabase-env.js";
import { checkPublicConfig, decodeJwtPayload } from "../../src/app/data/supabase-test-core.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG_FILE = join(ROOT, "src", "app", "data", "supabase-production-config.js");
const SCRIPT = join(ROOT, "scripts", "supabase-production-config.mjs");

test("the production config names swimtics-production and holds only a URL and a publishable key", () => {
    assert.deepEqual(Object.keys(config).sort(), ["publishableKey", "url"]);
    assert.equal(config.url, "https://jqyctrbzwxrpscieldif.supabase.co");
    assert.equal(projectRef(config.url), PRODUCTION_PROJECT_REF);
    const key = String(config.publishableKey);
    assert.ok(/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key), "a publishable key (sb_publishable_…)");
    assert.ok(!/sb_secret_|service_role/i.test(key), "not a secret or service_role key");
    assert.equal(decodeJwtPayload(key), null, "not a JWT (legacy anon / service_role)");
    assert.equal(checkPublicConfig(config).ok, true);
});

test("the production config is accepted for production only; test mode refuses it", () => {
    assert.equal(checkEnvConfig("production", config).ok, true);
    const asTest = checkEnvConfig("test", config);
    assert.equal(asTest.ok, false);
    assert.match(asTest.reason, /PRODUCTION project/);
    // and production refuses the test project, whatever the key
    const testProject = checkEnvConfig("production", { url: `https://${TEST_PROJECT_REF}.supabase.co`, publishableKey: config.publishableKey });
    assert.equal(testProject.ok, false);
    assert.match(testProject.reason, /TEST project/);
});

test("the config file holds nothing else secret-looking", () => {
    const text = readFileSync(CONFIG_FILE, "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");   // code, not the header comment
    assert.ok(!/sb_secret_|service_role|eyJ[A-Za-z0-9_-]{10,}\./.test(text), "no secret, service_role or JWT in the file");
    assert.equal((text.match(/sb_publishable_/g) || []).length, 1, "exactly one key");
    assert.equal((text.match(/\.supabase\.co/g) || []).length, 1, "exactly one project URL");
});

/* ---------- the generator script, run against temporary files ---------- */
function runScript(envText) {
    const dir = mkdtempSync(join(tmpdir(), "swimtics-prodcfg-"));
    const envPath = join(dir, "env");
    const outPath = join(dir, "out.js");
    if (envText !== null) writeFileSync(envPath, envText);
    let status = 0, stdout = "", stderr = "";
    try {
        stdout = execFileSync(process.execPath, [SCRIPT, "--env", envPath, "--out", outPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { status = e.status; stdout = e.stdout || ""; stderr = e.stderr || ""; }
    return { status, output: stdout + stderr, written: existsSync(outPath) ? readFileSync(outPath, "utf8") : null };
}

test("the script writes the production config from a publishable key and never prints the key", () => {
    const key = "sb_publishable_TESTONLYnotarealkey123";
    const r = runScript(`# comment\nSUPABASE_PRODUCTION_PUBLISHABLE_KEY="${key}"\n`);
    assert.equal(r.status, 0, r.output);
    assert.ok(!r.output.includes(key), "the key is not printed");
    assert.match(r.output, /jqyctrbzwxrpscieldif\.supabase\.co/);
    assert.ok(r.written.includes(`"url": "https://jqyctrbzwxrpscieldif.supabase.co"`));
    assert.ok(r.written.includes(`"publishableKey": "${key}"`));
});

test("the script refuses secret, service_role, legacy JWT and missing keys, and writes nothing", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x";
    for (const [label, text] of [
        ["secret key", "SUPABASE_PRODUCTION_PUBLISHABLE_KEY=sb_secret_abc123def456"],
        ["service_role JWT", `SUPABASE_PRODUCTION_PUBLISHABLE_KEY=${jwt}`],
        ["placeholder", "SUPABASE_PRODUCTION_PUBLISHABLE_KEY=sb_publishable_..."],
        ["empty", "SUPABASE_PRODUCTION_PUBLISHABLE_KEY="],
        ["wrong variable", "SUPABASE_PUBLISHABLE_KEY=sb_publishable_abc123def456"],
    ]) {
        const r = runScript(text);
        assert.notEqual(r.status, 0, label);
        assert.equal(r.written, null, `${label}: nothing written`);
        assert.ok(!r.output.includes("sb_secret_abc123def456") && !r.output.includes(jwt), `${label}: the value isn't printed`);
    }
    const missing = runScript(null);
    assert.notEqual(missing.status, 0);
    assert.match(missing.output, /Missing/);
});
