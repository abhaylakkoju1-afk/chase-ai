-- =========================================================
-- SWIMTICS — READ-ONLY schema and RLS checks for the account tables, made
-- for swimtics-production (D15), run in its SQL editor AFTER
-- 001_profiles.sql and 002_personal_bests.sql have been applied. It can
-- (and should first) be run on swimtics-test too: set the environment
-- below to 'test' there.
--
-- Unlike check_profiles_rls.sql / check_pbs_rls.sql it needs NO user ids
-- and reads NO user rows: swimtics-production is never used for testing.
-- It checks structure (tables, columns, keys, RLS enabled + forced, the
-- exact policies and nothing else, privileges, functions, triggers) and
-- runs probes that change nothing:
--   - signed out (anon): every table and add_pb_entries() are refused;
--   - signed in as a random id that is no real user: every table shows 0
--     rows (only counts are read, and only under RLS);
--   - add_pb_entries() with no signed-in user is refused before it writes.
-- Production must NOT have the profile-photo bucket, its policies or its
-- function (photos stay off until the legal / privacy review).
-- Supabase's optional "enable RLS on new tables" hook is accepted only as
-- the version verified on swimtics-test (step 54): public.rls_auto_enable()
-- with body (prosrc) md5 c44fb229ea8a6b0afd04a0a33261c16c, owned by
-- postgres, SECURITY DEFINER with search_path=pg_catalog, returning
-- event_trigger, used only by the enabled event trigger ensure_rls on
-- ddl_command_end for CREATE TABLE, CREATE TABLE AS and SELECT INTO. Absent
-- is fine; any other version fails step 54, and then (like every other
-- SECURITY DEFINER function in public) step 28. The hook LOGS rather than
-- aborts when enabling RLS on a new table fails (as reviewed by the owner
-- on swimtics-test), so it is no guarantee: step 48 still checks that
-- every existing public table has RLS.
-- Not checkable in SQL (check in the dashboard): sign-ups off, email
-- confirmation, SMTP, redirect URLs, MFA.
--
-- Read-only: results are kept in transaction-local settings, everything
-- runs in one transaction, and it is rolled back at the end.
-- =========================================================
begin;

-- >>> 'production' on swimtics-production; 'test' on swimtics-test <<<
select set_config('swimtics.environment', 'production', true);

-- the verified RLS auto-enable hook (step 54); not to be edited when running
select set_config('swimtics.hook_md5', 'c44fb229ea8a6b0afd04a0a33261c16c', true);

-- ---------- probe: signed out (anon) ----------
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
do $$
declare
    t text;
    allowed text := '';
begin
    foreach t in array array['profiles', 'personal_bests', 'pb_entries', 'device_imports'] loop
        begin
            execute format('select count(*) from public.%I', t);
            allowed := allowed || t || ' ';
        exception when insufficient_privilege then null;
                  when undefined_table then null;             -- reported by step 3
        end;
    end loop;
    perform set_config('swimtics.anon_tables', trim(allowed), true);
    -- (the function's own "not signed in" also uses SQLSTATE 42501, so the
    -- message tells "may not call it" from "called it and was refused inside")
    begin
        perform public.add_pb_entries('probe', 'probe', 'probe', '1', '[]'::jsonb);
        perform set_config('swimtics.anon_rpc', 'allowed', true);
    exception when insufficient_privilege then
        perform set_config('swimtics.anon_rpc',
            case when sqlerrm like 'permission denied%' then 'refused' else 'reached the function (' || sqlerrm || ')' end, true);
    end;
end $$;
reset role;

-- ---------- probe: signed in as an id that is no real user ----------
select set_config('swimtics.probe_uid', gen_random_uuid()::text, true);
set local role authenticated;
select set_config('request.jwt.claims',
    json_build_object('sub', current_setting('swimtics.probe_uid'), 'role', 'authenticated')::text, true);
do $$
declare
    t text;
    n bigint;
    seen text := '';
begin
    foreach t in array array['profiles', 'personal_bests', 'pb_entries', 'device_imports'] loop
        begin
            execute format('select count(*) from public.%I', t) into n;
            if n > 0 then seen := seen || t || '=' || n || ' '; end if;
        exception when others then
            seen := seen || t || '=error(' || sqlstate || ') ';
        end;
    end loop;
    perform set_config('swimtics.stranger_sees', trim(seen), true);
end $$;
-- ... and with no signed-in user at all
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
do $$
begin
    perform public.add_pb_entries('probe', 'probe', 'probe', '1', '[]'::jsonb);
    perform set_config('swimtics.nouser_rpc', 'allowed', true);
exception when sqlstate '42501' then
    perform set_config('swimtics.nouser_rpc', case when sqlerrm = 'not signed in' then 'refused' else 'error: ' || sqlerrm end, true);
when others then
    perform set_config('swimtics.nouser_rpc', 'error ' || sqlstate, true);
end $$;
reset role;

-- ---------- summary of every check ----------
with env as (select current_setting('swimtics.environment') as name),
tbl (tablename) as (
    values ('profiles'), ('personal_bests'), ('pb_entries'), ('device_imports')
),
present as (
    select tablename, to_regclass('public.' || tablename) as oid from tbl
),
rls as (
    select p.tablename, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from present p left join pg_class c on c.oid = p.oid
),
-- conditions normalised for comparison: lower case, no whitespace or
-- parentheses, no "AS uid" alias, no table-name prefix
pol as (
    select tablename, policyname, permissive, roles, cmd, qual, with_check,
        replace(replace(replace(replace(replace(regexp_replace(lower(qual), '[[:space:]()]', '', 'g'), 'asuid', ''),
            'profiles.', ''), 'personal_bests.', ''), 'pb_entries.', ''), 'device_imports.', '') as qual_n,
        replace(replace(replace(replace(replace(regexp_replace(lower(with_check), '[[:space:]()]', '', 'g'), 'asuid', ''),
            'profiles.', ''), 'personal_bests.', ''), 'pb_entries.', ''), 'device_imports.', '') as check_n
    from pg_policies
    where schemaname = 'public' and tablename in (select tablename from tbl)
),
expected (step, tablename, policyname, cmd, needs_using, needs_check) as (
    values
        (10, 'profiles',       'profiles: read own row',          'SELECT', true,  false),
        (11, 'profiles',       'profiles: insert own row',        'INSERT', false, true),
        (12, 'profiles',       'profiles: update own row',        'UPDATE', true,  true),
        (13, 'profiles',       'profiles: delete own row',        'DELETE', true,  false),
        (14, 'personal_bests', 'personal_bests: read own rows',   'SELECT', true,  false),
        (15, 'personal_bests', 'personal_bests: insert own rows', 'INSERT', false, true),
        (16, 'personal_bests', 'personal_bests: update own rows', 'UPDATE', true,  true),
        (17, 'personal_bests', 'personal_bests: delete own rows', 'DELETE', true,  false),
        (18, 'pb_entries',     'pb_entries: read own rows',       'SELECT', true,  false),
        (19, 'pb_entries',     'pb_entries: insert own rows',     'INSERT', false, true),
        (20, 'device_imports', 'device_imports: read own rows',   'SELECT', true,  false),
        (21, 'device_imports', 'device_imports: insert own rows', 'INSERT', false, true)
),
owner_only (form) as (
    values ('selectauth.uid=user_id'), ('auth.uid=user_id'),
           ('user_id=selectauth.uid'), ('user_id=auth.uid')
),
policy_checks as (
    select e.step,
        'Policy "' || e.policyname || '": ' || e.cmd || ' to authenticated, '
            || case when e.needs_using and e.needs_check then 'USING and WITH CHECK'
                    when e.needs_using then 'USING' else 'WITH CHECK' end
            || ' auth.uid() = user_id' as check_name,
        case
            when p.policyname is null then 'FAIL: policy not found'
            when p.cmd <> e.cmd then 'FAIL: command is ' || p.cmd || ', expected ' || e.cmd
            when p.roles <> array['authenticated']::name[] then 'FAIL: applies to ' || array_to_string(p.roles, ', ') || ', expected authenticated only'
            when p.permissive <> 'PERMISSIVE' then 'FAIL: policy is ' || p.permissive || ', expected PERMISSIVE'
            when e.needs_using and (p.qual_n is null or p.qual_n not in (select form from owner_only))
                then 'FAIL: USING is ' || coalesce(p.qual, '(none)') || ', expected auth.uid() = user_id'
            when not e.needs_using and p.qual is not null then 'FAIL: unexpected USING ' || p.qual
            when e.needs_check and (p.check_n is null or p.check_n not in (select form from owner_only))
                then 'FAIL: WITH CHECK is ' || coalesce(p.with_check, '(none)') || ', expected auth.uid() = user_id'
            when not e.needs_check and p.with_check is not null then 'FAIL: unexpected WITH CHECK ' || p.with_check
            else 'PASS'
        end as result
    from expected e
    left join pol p on p.tablename = e.tablename and p.policyname = e.policyname
),
-- what `authenticated` may do on each table: exactly this, nothing more
privs (tablename, priv, wanted) as (
    select t.tablename, p.priv,
        case when p.priv in ('SELECT', 'INSERT') then true
             when p.priv in ('UPDATE', 'DELETE') then t.tablename in ('profiles', 'personal_bests')
             else false end
    from tbl t
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p (priv)
),
priv_state as (
    select pr.tablename, pr.priv, pr.wanted,
        p.oid is not null and has_table_privilege('authenticated', p.oid, pr.priv) as auth_has,
        p.oid is not null and has_table_privilege('anon', p.oid, pr.priv) as anon_has
    from privs pr join present p using (tablename)
),
fns (signature) as (
    values ('public.add_pb_entries(text, text, text, text, jsonb)'), ('public.swimtics_time_to_seconds(text)')
),
fn as (
    select f.signature, to_regprocedure(f.signature) as oid, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config
    from fns f left join pg_proc p on p.oid = to_regprocedure(f.signature)
),
-- Supabase's optional "enable RLS on new tables" hook: allowed only as the
-- version verified on swimtics-test (body md5 in swimtics.hook_md5, owner,
-- SECURITY DEFINER, search_path, return type, and its one event trigger
-- with its event and tags). It is the only SECURITY DEFINER function step
-- 28 accepts, and only while step 54 passes.
hook_fn as (
    select p.oid, p.prosecdef, coalesce(p.proconfig, '{}') as config,
        pg_get_userbyid(p.proowner) as owner,
        p.prorettype = 'event_trigger'::regtype as returns_event_trigger,
        md5(p.prosrc) as body_md5
    from pg_proc p
    where p.oid = to_regprocedure('public.rls_auto_enable()')
),
hook_triggers as (
    select e.evtname::text as evtname, e.evtevent::text as evtevent, e.evtenabled::text as evtenabled,
        coalesce((select array_agg(t order by t) from unnest(e.evttags) as t), '{}') as tags
    from pg_event_trigger e
    where e.evtfoid = (select oid from hook_fn)
),
hook_others as (
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
      and p.oid <> coalesce((select oid from hook_fn), 0::oid)
),
hook as (
    select case
        when exists (select 1 from hook_others) then 'FAIL: other rls_auto_enable function(s): ' || (select string_agg(signature, ', ') from hook_others)
        when not exists (select 1 from hook_fn) then 'PASS (not installed)'
        when h.body_md5 <> current_setting('swimtics.hook_md5')
            then 'FAIL: rls_auto_enable() is not the verified version (body md5 ' || h.body_md5 || ', expected ' || current_setting('swimtics.hook_md5') || ')'
        when not h.returns_event_trigger then 'FAIL: rls_auto_enable() does not return event_trigger'
        when h.owner <> 'postgres' then 'FAIL: rls_auto_enable() is owned by ' || h.owner || ', expected postgres'
        when not h.prosecdef then 'FAIL: rls_auto_enable() is not SECURITY DEFINER (the verified version is)'
        when h.config <> array['search_path=pg_catalog'] then 'FAIL: rls_auto_enable() settings are ' || array_to_string(h.config, ', ') || ', expected search_path=pg_catalog'
        when (select count(*) from hook_triggers) <> 1
            then 'FAIL: rls_auto_enable() is used by ' || (select count(*) from hook_triggers) || ' event trigger(s), expected only ensure_rls'
        when not exists (select 1 from hook_triggers
                         where evtname = 'ensure_rls' and evtevent = 'ddl_command_end' and evtenabled <> 'D'
                           and tags = array['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO'])
            then 'FAIL: rls_auto_enable() is not used by an enabled event trigger ensure_rls on ddl_command_end for CREATE TABLE, CREATE TABLE AS, SELECT INTO ('
                 || (select string_agg(evtname || ' ' || evtevent || ' enabled=' || evtenabled || ' tags=' || array_to_string(tags, '/'), ', ') from hook_triggers) || ')'
        else 'PASS (verified rls_auto_enable() via ensure_rls on ddl_command_end; body md5 ' || h.body_md5 || ')'
    end as result
    from (select 1) one left join hook_fn h on true
),
definer_fns as (
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not (p.oid = coalesce((select oid from hook_fn), 0::oid) and (select result from hook) like 'PASS%')
),
other_pb_fns as (
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('add_pb_entries', 'swimtics_time_to_seconds')
      and p.oid not in (select oid from fn where oid is not null)
),
-- foreign keys: (table, columns) -> (referenced table, columns), cascading on delete
fk_expected (step, tablename, cols, ref, refcols) as (
    values
        (40, 'profiles',       array['user_id'],           'auth.users',            array['id']),
        (41, 'personal_bests', array['user_id'],           'auth.users',            array['id']),
        (42, 'device_imports', array['user_id'],           'auth.users',            array['id']),
        (43, 'pb_entries',     array['pb_id', 'user_id'], 'public.personal_bests', array['id', 'user_id'])
),
fk_found as (
    select e.step, e.tablename, e.ref, exists (
        select 1 from pg_constraint c
        where c.conrelid = to_regclass('public.' || e.tablename) and c.contype = 'f'
          and c.confrelid = to_regclass(e.ref) and c.confdeltype = 'c'
          and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.conkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = e.cols
          and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.confkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) = e.refcols
    ) as ok
    from fk_expected e
),
key_expected (step, tablename, contype, cols) as (
    values
        (44, 'profiles',       'p', array['user_id']),
        (45, 'personal_bests', 'u', array['user_id', 'pb_key']),
        (46, 'pb_entries',     'p', array['pb_id', 'entry_id']),
        (47, 'device_imports', 'p', array['user_id', 'fingerprint'])
),
key_found as (
    select e.step, e.tablename, e.contype, e.cols, exists (
        select 1 from pg_constraint c
        where c.conrelid = to_regclass('public.' || e.tablename) and c.contype = e.contype
          and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.conkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = e.cols
    ) as ok
    from key_expected e
),
profile_cols as (
    select coalesce(array_agg(a.attname::text order by a.attnum), '{}') as cols
    from pg_attribute a
    where a.attrelid = to_regclass('public.profiles') and a.attnum > 0 and not a.attisdropped
),
triggers (tablename, tgname) as (
    values ('profiles', 'profiles_touch_updated_at'), ('personal_bests', 'personal_bests_touch_updated_at')
),
trigger_state as (
    select t.tablename, t.tgname, exists (
        select 1 from pg_trigger g
        where g.tgrelid = to_regclass('public.' || t.tablename) and g.tgname = t.tgname and g.tgenabled <> 'D'
    ) as ok
    from triggers t
),
unprotected as (
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
),
photos as (
    select
        (to_regclass('storage.buckets') is not null
            and exists (select 1 from storage.buckets where id = 'profile-photos')) as bucket,
        exists (select 1 from pg_policies where schemaname = 'storage' and policyname like 'profile-photos:%') as policies,
        to_regprocedure('public.swimtics_is_own_profile_photo(text, text)') is not null as fn
)
select * from (
    select 1 as step, 'Environment is set to production or test' as check_name,
        case when (select name from env) in ('production', 'test') then 'PASS (' || (select name from env) || ')'
             else 'FAIL: set swimtics.environment to production or test at the top' end as result
    union all
    select 2, 'PostgreSQL 13 or later (add_pb_entries uses trim_scale)',
        case when current_setting('server_version_num')::int >= 130000 then 'PASS'
             else 'FAIL: server is ' || current_setting('server_version') end
    union all
    select 3, 'Tables profiles, personal_bests, pb_entries and device_imports exist',
        case when bool_and(oid is not null) then 'PASS'
             else 'FAIL: missing ' || string_agg(case when oid is null then tablename end, ', ') end
    from present
    union all
    select 4, 'Row Level Security is enabled and forced on all four tables',
        case when bool_and(coalesce(enabled and forced, false)) then 'PASS'
             else 'FAIL: not enabled+forced on ' || string_agg(case when not coalesce(enabled and forced, false) then tablename end, ', ') end
    from rls
    union all
    select 5, 'profiles has exactly user_id, the 24 profile fields and updated_at',
        case when (select cols from profile_cols) = array['user_id', 'name', 'dob', 'gender', 'nationality', 'club',
                'primaryStroke', 'secondaryStroke', 'eventsPref', 'distanceType', 'height', 'weight', 'wingspan',
                'strengths', 'weaknesses', 'level', 'hours', 'coach', 'facility', 'shortGoal', 'longGoal',
                'competition', 'lastComp', 'bestMeet', 'medals', 'updated_at']
             then 'PASS' else 'FAIL: columns are ' || array_to_string((select cols from profile_cols), ', ') end
    union all
    select step, check_name, result from policy_checks
    union all
    select 22, 'No other policies on these tables',
        case when count(*) = 0 then 'PASS'
             else 'FAIL: unexpected policies: ' || string_agg(tablename || '.' || policyname || ' (' || permissive || ' ' || cmd || ')', ', ') end
    from pol
    where (tablename, policyname) not in (select tablename, policyname from expected)
    union all
    select 23, 'Signed-out (anon) has no privilege at all on these tables',
        case when not bool_or(anon_has) then 'PASS'
             else 'FAIL: anon has ' || string_agg(case when anon_has then tablename || ' ' || priv end, ', ') end
    from priv_state
    union all
    select 24, 'Signed-in (authenticated) has exactly the needed privileges (swims and imports are not editable; no TRUNCATE / REFERENCES / TRIGGER)',
        case when bool_and(auth_has = wanted) then 'PASS'
             else 'FAIL: ' || string_agg(case when auth_has <> wanted then tablename || ' ' || priv || (case when auth_has then ' granted' else ' missing' end) end, ', ') end
    from priv_state
    union all
    select 25, 'add_pb_entries and swimtics_time_to_seconds exist, run with the caller''s rights and a fixed search_path',
        case when bool_and(oid is not null and not prosecdef and config like '%search_path=%') then 'PASS'
             else 'FAIL: ' || string_agg(case when not (oid is not null and not coalesce(prosecdef, false) and config like '%search_path=%')
                 then signature || (case when oid is null then ' missing' when prosecdef then ' is SECURITY DEFINER' else ' has no fixed search_path' end) end, ', ') end
    from fn
    union all
    select 26, 'anon cannot execute add_pb_entries or swimtics_time_to_seconds; authenticated can execute add_pb_entries',
        case when (select oid from fn where signature like '%add_pb_entries%') is null then 'FAIL: add_pb_entries missing'
             when exists (select 1 from fn where oid is not null and has_function_privilege('anon', oid, 'execute')) then 'FAIL: anon can execute a PB function'
             when not has_function_privilege('authenticated', (select oid from fn where signature like '%add_pb_entries%'), 'execute') then 'FAIL: authenticated cannot execute add_pb_entries'
             else 'PASS' end
    union all
    select 27, 'No other add_pb_entries / swimtics_time_to_seconds functions (overloads)',
        case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(signature, ', ') end
    from other_pb_fns
    union all
    select 28, 'No SECURITY DEFINER functions in schema public (they would bypass RLS), apart from the RLS auto-enable hook when step 54 passes',
        case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(signature, ', ') end
    from definer_fns
    union all
    select 54, 'Supabase RLS auto-enable hook: absent, or exactly the version verified on swimtics-test (body md5, owner postgres, SECURITY DEFINER, search_path=pg_catalog, event_trigger, only ensure_rls on ddl_command_end for CREATE TABLE / CREATE TABLE AS / SELECT INTO)',
        result
    from hook
    union all
    select 29, 'updated_at triggers are present and enabled on profiles and personal_bests',
        case when bool_and(ok) then 'PASS' else 'FAIL: missing ' || string_agg(case when not ok then tgname end, ', ') end
    from trigger_state
    union all
    select 30, 'pb_entries.seconds allows at most millisecond precision (check constraint)',
        case when exists (
                select 1 from pg_constraint c
                where c.conrelid = to_regclass('public.pb_entries') and c.contype = 'c'
                  and regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]()]', '', 'g') like '%seconds=round%seconds,3%')
             then 'PASS' else 'FAIL: the seconds = round(seconds, 3) check is missing' end
    union all
    select step, 'Foreign key ' || tablename || ' -> ' || ref || ', cascading on delete',
        case when ok then 'PASS' else 'FAIL: not found' end
    from fk_found
    union all
    select step, case contype when 'p' then 'Primary key ' else 'Unique key ' end || tablename || ' (' || array_to_string(cols, ', ') || ')',
        case when ok then 'PASS' else 'FAIL: not found' end
    from key_found
    union all
    select 48, 'Every table in schema public has Row Level Security enabled (checked directly: the auto-enable hook only logs if it fails)',
        case when count(*) = 0 then 'PASS' else 'FAIL: no RLS on ' || string_agg(relname::text, ', ') end
    from unprotected
    union all
    select 49, 'Profile photos: absent on production (bucket, policies, function); on test, use check_photos_rls.sql',
        case when (select name from env) = 'test' then 'N/A (test project)'
             when not (select bucket or policies or fn from photos) then 'PASS'
             else 'FAIL: production has photo ' || concat_ws(', ',
                 case when (select bucket from photos) then 'bucket profile-photos' end,
                 case when (select policies from photos) then 'storage policies' end,
                 case when (select fn from photos) then 'function swimtics_is_own_profile_photo' end)
                 || ' — 003_profile_photos.sql must not be applied to production yet' end
    union all
    select 50, 'Probe: signed out, every table is refused',
        case when current_setting('swimtics.anon_tables') = '' then 'PASS'
             else 'FAIL: anon can read ' || current_setting('swimtics.anon_tables') end
    union all
    select 51, 'Probe: signed out, add_pb_entries is refused',
        case when current_setting('swimtics.anon_rpc') = 'refused' then 'PASS'
             else 'FAIL: anon can call add_pb_entries: ' || current_setting('swimtics.anon_rpc') end
    union all
    select 52, 'Probe: signed in as an id that is no real user, every table shows 0 rows',
        case when current_setting('swimtics.stranger_sees') = '' then 'PASS'
             else 'FAIL: ' || current_setting('swimtics.stranger_sees') end
    union all
    select 53, 'Probe: add_pb_entries with no signed-in user is refused before writing',
        case when current_setting('swimtics.nouser_rpc') = 'refused' then 'PASS'
             else 'FAIL: ' || current_setting('swimtics.nouser_rpc') end
) checks
order by step;

rollback;
