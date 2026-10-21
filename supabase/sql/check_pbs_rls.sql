-- =========================================================
-- SWIMTICS — swimtics-test only. OPTIONAL, READ-ONLY checks of Row Level
-- Security on personal_bests, pb_entries and device_imports, run in the
-- SQL editor AFTER 002_personal_bests.sql has been reviewed and applied.
--
-- Uses TWO test users. Before running, replace the two placeholder ids
-- below (marked >>> <<<) with two different users' ids from
-- Authentication > Users. Each user should already have saved at least one
-- personal best in test mode; without PBs for both users, isolation can't
-- be demonstrated and the summary says so.
--
-- Policies are read from pg_policies and compared, not just counted: each
-- expected policy must exist with the right command, apply only to
-- `authenticated`, be permissive and use exactly auth.uid() = user_id in
-- the right clause(s). Any other policy on these tables is a FAIL.
--
-- Read-only: nothing is inserted, updated or deleted. Results are kept in
-- transaction-local settings (set_config(..., true)), everything runs in
-- one transaction, and it is rolled back at the end. The summary query
-- just before the rollback reports every check in one table.
-- =========================================================
begin;

-- >>> Replace these two placeholders with two test users' ids <<<
select set_config('swimtics.user_a', '00000000-0000-0000-0000-00000000000a', true);
select set_config('swimtics.user_b', '00000000-0000-0000-0000-00000000000b', true);

-- ---------- as user A (signed in) ----------
set local role authenticated;
select set_config('request.jwt.claims',
    json_build_object('sub', current_setting('swimtics.user_a'), 'role', 'authenticated')::text, true);
select
    set_config('swimtics.a_own_pbs', (select count(*) from public.personal_bests
        where user_id = current_setting('swimtics.user_a')::uuid)::text, true),
    set_config('swimtics.a_sees_b', ((select count(*) from public.personal_bests where user_id = current_setting('swimtics.user_b')::uuid)
        + (select count(*) from public.pb_entries where user_id = current_setting('swimtics.user_b')::uuid)
        + (select count(*) from public.device_imports where user_id = current_setting('swimtics.user_b')::uuid))::text, true),
    set_config('swimtics.a_sees_others', ((select count(*) from public.personal_bests where user_id <> current_setting('swimtics.user_a')::uuid)
        + (select count(*) from public.pb_entries where user_id <> current_setting('swimtics.user_a')::uuid)
        + (select count(*) from public.device_imports where user_id <> current_setting('swimtics.user_a')::uuid))::text, true);
reset role;

-- ---------- as user B (signed in) ----------
set local role authenticated;
select set_config('request.jwt.claims',
    json_build_object('sub', current_setting('swimtics.user_b'), 'role', 'authenticated')::text, true);
select
    set_config('swimtics.b_own_pbs', (select count(*) from public.personal_bests
        where user_id = current_setting('swimtics.user_b')::uuid)::text, true),
    set_config('swimtics.b_sees_a', ((select count(*) from public.personal_bests where user_id = current_setting('swimtics.user_a')::uuid)
        + (select count(*) from public.pb_entries where user_id = current_setting('swimtics.user_a')::uuid)
        + (select count(*) from public.device_imports where user_id = current_setting('swimtics.user_a')::uuid))::text, true),
    set_config('swimtics.b_sees_others', ((select count(*) from public.personal_bests where user_id <> current_setting('swimtics.user_b')::uuid)
        + (select count(*) from public.pb_entries where user_id <> current_setting('swimtics.user_b')::uuid)
        + (select count(*) from public.device_imports where user_id <> current_setting('swimtics.user_b')::uuid))::text, true);
reset role;

-- ---------- summary of every check ----------
with s as (
    select
        current_setting('swimtics.user_a')              as user_a,
        current_setting('swimtics.user_b')              as user_b,
        current_setting('swimtics.a_own_pbs')::int      as a_own,
        current_setting('swimtics.a_sees_b')::int       as a_sees_b,
        current_setting('swimtics.a_sees_others')::int  as a_sees_others,
        current_setting('swimtics.b_own_pbs')::int      as b_own,
        current_setting('swimtics.b_sees_a')::int       as b_sees_a,
        current_setting('swimtics.b_sees_others')::int  as b_sees_others
),
tbl (tablename) as (
    values ('personal_bests'), ('pb_entries'), ('device_imports')
),
rls as (
    select tbl.tablename, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
    from tbl join pg_class c on c.oid = ('public.' || tbl.tablename)::regclass
),
-- conditions normalised for comparison: lower case, no whitespace or
-- parentheses, no "AS uid" alias, no table-name prefix
pol as (
    select tablename, policyname, permissive, roles, cmd, qual, with_check,
        replace(replace(replace(replace(regexp_replace(lower(qual), '[[:space:]()]', '', 'g'), 'asuid', ''),
            'personal_bests.', ''), 'pb_entries.', ''), 'device_imports.', '') as qual_n,
        replace(replace(replace(replace(regexp_replace(lower(with_check), '[[:space:]()]', '', 'g'), 'asuid', ''),
            'personal_bests.', ''), 'pb_entries.', ''), 'device_imports.', '') as check_n
    from pg_policies
    where schemaname = 'public' and tablename in (select tablename from tbl)
),
expected (step, tablename, policyname, cmd, needs_using, needs_check) as (
    values
        (10, 'personal_bests', 'personal_bests: read own rows',   'SELECT', true,  false),
        (11, 'personal_bests', 'personal_bests: insert own rows', 'INSERT', false, true),
        (12, 'personal_bests', 'personal_bests: update own rows', 'UPDATE', true,  true),
        (13, 'personal_bests', 'personal_bests: delete own rows', 'DELETE', true,  false),
        (14, 'pb_entries',     'pb_entries: read own rows',       'SELECT', true,  false),
        (15, 'pb_entries',     'pb_entries: insert own rows',     'INSERT', false, true),
        (16, 'device_imports', 'device_imports: read own rows',   'SELECT', true,  false),
        (17, 'device_imports', 'device_imports: insert own rows', 'INSERT', false, true)
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
-- the function by its exact signature (an overload with the same name
-- must not be mistaken for it)
fn as (
    select p.prosecdef as security_definer, coalesce(array_to_string(p.proconfig, ','), '') as config
    from pg_proc p
    where p.oid = to_regprocedure('public.add_pb_entries(text, text, text, text, jsonb)')
),
-- any other public function with the PB function's name, or any of these
-- helpers running as SECURITY DEFINER (which would bypass RLS)
other_fns as (
    select p.oid::regprocedure::text as signature, p.prosecdef as security_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname = 'add_pb_entries' or p.proname like 'swimtics\_%')
      and (p.oid <> coalesce(to_regprocedure('public.add_pb_entries(text, text, text, text, jsonb)'), 0::oid)
           or p.prosecdef)
      and not (p.proname like 'swimtics\_%' and not p.prosecdef)
),
-- the owner-consistent foreign key: exactly (pb_id, user_id) ->
-- personal_bests (id, user_id), cascading on delete
fk as (
    select count(*) as n
    from pg_constraint c
    where c.conrelid = 'public.pb_entries'::regclass and c.contype = 'f'
      and c.confrelid = 'public.personal_bests'::regclass
      and c.confdeltype = 'c'
      and (select array_agg(a.attname::text order by k.ord)
           from unnest(c.conkey) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = array['pb_id', 'user_id']
      and (select array_agg(a.attname::text order by k.ord)
           from unnest(c.confkey) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) = array['id', 'user_id']
)
select * from (
    select 1 as step, 'Two different real test-user ids were entered' as check_name,
        case when s.user_a in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')
               or s.user_b in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')
             then 'FAIL: replace the placeholder ids at the top'
             when s.user_a = s.user_b then 'FAIL: user A and user B are the same id'
             else 'PASS' end as result
    from s
    union all
    select 2, 'Row Level Security is enabled and forced on personal_bests, pb_entries and device_imports',
        case when bool_and(enabled and forced) then 'PASS'
             else 'FAIL: not enabled+forced on ' || string_agg(case when not (enabled and forced) then tablename end, ', ') end
    from rls
    union all
    select step, check_name, result from policy_checks
    union all
    select 18, 'No other policies on these tables',
        case when count(*) = 0 then 'PASS'
             else 'FAIL: unexpected policies: ' || string_agg(tablename || '.' || policyname || ' (' || permissive || ' ' || cmd || ')', ', ') end
    from pol
    where (tablename, policyname) not in (select tablename, policyname from expected)
    union all
    select 19, 'Signed-out (anon) has no privilege on these tables or on add_pb_entries',
        case when not exists (
                select 1 from tbl
                where has_table_privilege('anon', 'public.' || tablename, 'select')
                   or has_table_privilege('anon', 'public.' || tablename, 'insert')
                   or has_table_privilege('anon', 'public.' || tablename, 'update')
                   or has_table_privilege('anon', 'public.' || tablename, 'delete'))
             and not has_function_privilege('anon', 'public.add_pb_entries(text, text, text, text, jsonb)', 'execute')
             then 'PASS' else 'FAIL: anon still has a privilege' end
    union all
    select 20, 'Recorded swims and imports cannot be edited or deleted directly',
        case when not (has_table_privilege('authenticated', 'public.pb_entries', 'update')
                    or has_table_privilege('authenticated', 'public.pb_entries', 'delete')
                    or has_table_privilege('authenticated', 'public.device_imports', 'update')
                    or has_table_privilege('authenticated', 'public.device_imports', 'delete'))
             then 'PASS' else 'FAIL: authenticated can update or delete pb_entries / device_imports' end
    union all
    select 21, 'add_pb_entries runs with the caller''s rights and a fixed search_path',
        case when not exists (select 1 from fn) then 'FAIL: function not found'
             when (select security_definer from fn) then 'FAIL: function is SECURITY DEFINER (bypasses RLS)'
             when (select config from fn) not like '%search_path=%' then 'FAIL: search_path not set'
             else 'PASS' end
    union all
    select 22, 'pb_entries can only belong to a PB of the same user: foreign key (pb_id, user_id) -> personal_bests (id, user_id), cascade delete',
        case when (select n from fk) >= 1 then 'PASS' else 'FAIL: owner-consistent foreign key not found' end
    union all
    select 29, 'No other add_pb_entries function, and no SECURITY DEFINER PB helper functions',
        case when count(*) = 0 then 'PASS'
             else 'FAIL: unexpected function(s): ' || string_agg(signature || case when security_definer then ' (SECURITY DEFINER)' else '' end, ', ') end
    from other_fns
    union all
    select 23, 'User A has at least one personal best (needed to test isolation)',
        case when s.a_own >= 1 then 'PASS'
             else 'MISSING ROW: sign in as user A in test mode and add a personal best' end
    from s
    union all
    select 24, 'User B has at least one personal best (needed to test isolation)',
        case when s.b_own >= 1 then 'PASS'
             else 'MISSING ROW: sign in as user B in test mode and add a personal best' end
    from s
    union all
    select 25, 'User A cannot see any of user B''s PBs, swims or imports',
        case when s.b_own = 0 then 'CANNOT TEST: user B has no personal best'
             when s.a_sees_b = 0 then 'PASS'
             else 'FAIL: user A can see ' || s.a_sees_b || ' of user B''s row(s)' end
    from s
    union all
    select 26, 'User B cannot see any of user A''s PBs, swims or imports',
        case when s.a_own = 0 then 'CANNOT TEST: user A has no personal best'
             when s.b_sees_a = 0 then 'PASS'
             else 'FAIL: user B can see ' || s.b_sees_a || ' of user A''s row(s)' end
    from s
    union all
    select 27, 'User A sees no other user''s rows at all',
        case when s.a_sees_others = 0 then 'PASS'
             else 'FAIL: user A can see ' || s.a_sees_others || ' other row(s)' end
    from s
    union all
    select 28, 'User B sees no other user''s rows at all',
        case when s.b_sees_others = 0 then 'PASS'
             else 'FAIL: user B can see ' || s.b_sees_others || ' other row(s)' end
    from s
) checks
order by step;

-- Note: a MISSING ROW result can also mean a policy hides a user's own
-- rows. If you did add a PB as that user, check Table Editor > personal_bests.

rollback;
