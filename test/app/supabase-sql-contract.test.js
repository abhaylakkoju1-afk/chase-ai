// The SQL in supabase/sql/ and the app code that uses it must agree. These
// read the SQL files as text (no database) and compare them with the
// field lists, selects and RPC arguments the app actually sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROFILE_FIELDS } from "../../src/app/data/user-data.js";
import { PB_SELECT } from "../../src/app/data/supabase-test-pbs.js";

const read = (f) => readFileSync(new URL(`../../supabase/sql/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SQL001 = read("001_profiles.sql");
const SQL002 = read("002_personal_bests.sql");
const CHECK = read("check_production_schema.sql");
const PB_JS = readFileSync(new URL("../../src/app/data/supabase-test-pbs.js", import.meta.url), "utf8");

/* column names of `create table if not exists public.<name> ( ... );` */
function columns(sql, table) {
    const m = sql.match(new RegExp(`create table if not exists public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`));
    assert.ok(m, `table ${table} not found`);
    return m[1].split("\n").map((l) => l.trim())
        .filter((l) => l && !l.startsWith("--") && !/^(primary key|unique|foreign key|constraint|check)\b/.test(l))
        .map((l) => l.match(/^"?([A-Za-z_]+)"?\s/)[1]);
}

test("profiles has exactly user_id, PROFILE_FIELDS and updated_at — in 001 and in the production checker", () => {
    const expected = ["user_id", ...PROFILE_FIELDS, "updated_at"];
    assert.deepEqual(columns(SQL001, "profiles"), expected);
    const step5 = CHECK.match(/select 5, [\s\S]*?array\[([\s\S]*?)\]\s*then/);
    assert.ok(step5, "checker step 5 not found");
    assert.deepEqual(step5[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)), expected);
});

test("every column the PB code selects exists in 002", () => {
    // "pb_key,event,course,best_time,pb_entries(entry_id,seconds,ord)"
    const [, outer, inner] = PB_SELECT.match(/^(.*),pb_entries\((.*)\)$/);
    const pbCols = columns(SQL002, "personal_bests");
    const entryCols = columns(SQL002, "pb_entries");
    for (const c of outer.split(",")) assert.ok(pbCols.includes(c), `personal_bests.${c}`);
    for (const c of inner.split(",")) assert.ok(entryCols.includes(c), `pb_entries.${c}`);
    for (const c of ["user_id", "fingerprint", "pb_entries", "profile_fields"]) {
        assert.ok(columns(SQL002, "device_imports").includes(c), `device_imports.${c}`);
    }
});

test("the add_pb_entries arguments the app sends are the function's parameters, in order", () => {
    const params = SQL002.match(/create or replace function public\.add_pb_entries\(([\s\S]*?)\)\nreturns jsonb/)[1]
        .split(",").map((p) => p.trim().split(/\s+/)[0]);
    assert.deepEqual(params, ["p_pb_key", "p_event", "p_course", "p_time", "p_entries"]);
    const sent = PB_JS.match(/rpc\("add_pb_entries", \{([\s\S]*?)\}\)/)[1].match(/p_[a-z_]+/g);
    assert.deepEqual([...new Set(sent)].sort(), [...params].sort());
    assert.match(CHECK, /public\.add_pb_entries\(text, text, text, text, jsonb\)/);
});

test("001 and 002 are each one transaction and say they're for both projects", () => {
    for (const [name, sql] of [["001", SQL001], ["002", SQL002]]) {
        const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
        assert.ok(code.startsWith("begin;"), `${name} starts with begin;`);
        assert.ok(code.endsWith("commit;"), `${name} ends with commit;`);
        assert.equal((code.match(/^\s*(begin|commit|rollback);/gm) || []).length, 2, `${name}: exactly one begin and one commit`);
        assert.match(sql, /swimtics-production/);
        assert.doesNotMatch(sql, /TEST project \(swimtics-test\) only|Not applied anywhere yet|SWIMTICS test:/);
    }
});

test("the production checker is read-only and expects every policy 001/002 create", () => {
    const code = CHECK.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.match(code.trim(), /^begin;[\s\S]*rollback;$/);
    assert.doesNotMatch(code, /\bcommit\b/i);
    const statements = code.replace(/'(?:[^']|'')*'/g, "''");      // string literals (messages, tag names) aren't statements
    assert.doesNotMatch(statements, /\b(insert into|update public|delete from|create table|drop table|alter table|grant |revoke )/i);
    const created = [...(SQL001 + SQL002).matchAll(/create policy "([^"]+)"/g)].map((m) => m[1]).sort();
    const expected = [...CHECK.matchAll(/\(\d+, '[a-z_]+', +'([^']+)', +'(?:SELECT|INSERT|UPDATE|DELETE)'/g)].map((m) => m[1]).sort();
    assert.equal(created.length, 12);
    assert.deepEqual(expected, created);
    assert.match(CHECK, /set_config\('swimtics\.environment', 'production', true\)/, "ships set for production");
});

test("the production checker allows only the RLS auto-enable hook verified on swimtics-test", () => {
    // verified by the owner on swimtics-test: prosrc md5, owner, SECURITY DEFINER,
    // search_path=pg_catalog, event_trigger, ensure_rls on ddl_command_end with these tags
    assert.match(CHECK, /set_config\('swimtics\.hook_md5', 'c44fb229ea8a6b0afd04a0a33261c16c', true\)/);
    assert.match(CHECK, /to_regprocedure\('public\.rls_auto_enable\(\)'\)/);
    assert.match(CHECK, /h\.owner <> 'postgres'/);
    assert.match(CHECK, /not h\.prosecdef/);
    assert.match(CHECK, /h\.config <> array\['search_path=pg_catalog'\]/);
    assert.match(CHECK, /evtname = 'ensure_rls' and evtevent = 'ddl_command_end' and evtenabled <> 'D'/);
    assert.match(CHECK, /tags = array\['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO'\]/);
    // the exemption from "no SECURITY DEFINER in public" applies only while that check passes
    assert.match(CHECK, /and not \(p\.oid = coalesce\(\(select oid from hook_fn\), 0::oid\) and \(select result from hook\) like 'PASS%'\)/);
    // and every public table is still checked directly
    assert.match(CHECK, /select 48, 'Every table in schema public has Row Level Security enabled/);
});
