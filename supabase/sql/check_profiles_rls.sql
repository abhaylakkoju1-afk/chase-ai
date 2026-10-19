-- =========================================================
-- SWIMTICS — swimtics-test only. OPTIONAL, READ-ONLY checks of the
-- profiles table's Row Level Security, run in the SQL editor AFTER
-- 001_profiles.sql has been reviewed and applied (the table must exist).
--
-- Uses TWO test users. Before running, replace the two placeholder ids
-- below (marked >>> <<<) with two different users' ids from
-- Authentication > Users. Each user should already have a profile row
-- (sign in as that user in test mode and choose Save Profile); without a
-- row for both users, isolation can't be demonstrated and the summary
-- says so.
--
-- Policy definitions are read from pg_policies and compared, not just
-- counted: each expected policy must exist with the right command, apply
-- only to `authenticated`, be permissive, and use exactly the owner-only
-- condition auth.uid() = user_id in the right clause(s). Any other policy
-- on the table is reported as a FAIL, since an extra permissive policy
-- would widen access.
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
    set_config('swimtics.a_own', (select count(*) from public.profiles
        where user_id = current_setting('swimtics.user_a')::uuid)::text, true),
    set_config('swimtics.a_sees_b', (select count(*) from public.profiles
        where user_id = current_setting('swimtics.user_b')::uuid)::text, true),
    set_config('swimtics.a_sees_others', (select count(*) from public.profiles
        where user_id <> current_setting('swimtics.user_a')::uuid)::text, true);
reset role;

-- ---------- as user B (signed in) ----------
set local role authenticated;
select set_config('request.jwt.claims',
    json_build_object('sub', current_setting('swimtics.user_b'), 'role', 'authenticated')::text, true);
select
    set_config('swimtics.b_own', (select count(*) from public.profiles
        where user_id = current_setting('swimtics.user_b')::uuid)::text, true),
    set_config('swimtics.b_sees_a', (select count(*) from public.profiles
        where user_id = current_setting('swimtics.user_a')::uuid)::text, true),
    set_config('swimtics.b_sees_others', (select count(*) from public.profiles
        where user_id <> current_setting('swimtics.user_b')::uuid)::text, true);
reset role;

-- ---------- summary of every check ----------
with s as (
    select
        current_setting('swimtics.user_a')             as user_a,
        current_setting('swimtics.user_b')             as user_b,
        current_setting('swimtics.a_own')::int         as a_own,
        current_setting('swimtics.a_sees_b')::int      as a_sees_b,
        current_setting('swimtics.a_sees_others')::int as a_sees_others,
        current_setting('swimtics.b_own')::int         as b_own,
        current_setting('swimtics.b_sees_a')::int      as b_sees_a,
        current_setting('swimtics.b_sees_others')::int as b_sees_others
),
t as (
    select relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
    from pg_class where oid = 'public.profiles'::regclass
),
-- the policies actually defined on the table, with their conditions
-- normalised for comparison: lower case, no whitespace or parentheses,
-- no "AS uid" alias and no "profiles." prefix. So the stored form
-- "(( SELECT auth.uid() AS uid) = user_id)" becomes "selectauth.uid=user_id".
pol as (
    select policyname, permissive, roles, cmd, qual, with_check,
        replace(replace(regexp_replace(lower(qual), '[[:space:]()]', '', 'g'), 'asuid', ''), 'profiles.', '') as qual_n,
        replace(replace(regexp_replace(lower(with_check), '[[:space:]()]', '', 'g'), 'asuid', ''), 'profiles.', '') as check_n
    from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
),
-- what each policy must be: name, command, and which clause(s) must hold
-- the owner-only condition (the other clause must be empty)
expected (step, policyname, cmd, needs_using, needs_check) as (
    values
        (3, 'profiles: read own row',   'SELECT', true,  false),
        (4, 'profiles: insert own row', 'INSERT', false, true),
        (5, 'profiles: update own row', 'UPDATE', true,  true),
        (6, 'profiles: delete own row', 'DELETE', true,  false)
),
-- accepted spellings of auth.uid() = user_id (with or without the
-- "(select ...)" wrapper, either side of the "=")
owner_only (form) as (
    values ('selectauth.uid=user_id'), ('auth.uid=user_id'),
           ('user_id=selectauth.uid'), ('user_id=auth.uid')
),
policy_checks as (
    select e.step,
        'Policy "' || e.policyname || '": ' || e.cmd || ' to authenticated, '
            || case when e.needs_using and e.needs_check then 'USING and WITH CHECK'
                    when e.needs_using then 'USING'
                    else 'WITH CHECK' end
            || ' auth.uid() = user_id' as check_name,
        case
            when p.policyname is null then 'FAIL: policy not found'
            when p.cmd <> e.cmd then 'FAIL: command is ' || p.cmd || ', expected ' || e.cmd
            when p.roles <> array['authenticated']::name[] then 'FAIL: applies to ' || array_to_string(p.roles, ', ') || ', expected authenticated only'
            when p.permissive <> 'PERMISSIVE' then 'FAIL: policy is ' || p.permissive || ', expected PERMISSIVE'
            when e.needs_using and (p.qual_n is null or p.qual_n not in (select form from owner_only))
                then 'FAIL: USING is ' || coalesce(p.qual, '(none)') || ', expected auth.uid() = user_id'
            when not e.needs_using and p.qual is not null
                then 'FAIL: unexpected USING ' || p.qual
            when e.needs_check and (p.check_n is null or p.check_n not in (select form from owner_only))
                then 'FAIL: WITH CHECK is ' || coalesce(p.with_check, '(none)') || ', expected auth.uid() = user_id'
            when not e.needs_check and p.with_check is not null
                then 'FAIL: unexpected WITH CHECK ' || p.with_check
            else 'PASS'
        end as result
    from expected e
    left join pol p on p.policyname = e.policyname
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
    select 2, 'Row Level Security is enabled and forced on public.profiles',
        case when t.rls_enabled and t.rls_forced then 'PASS'
             else 'FAIL: enabled=' || t.rls_enabled || ', forced=' || t.rls_forced end
    from t
    union all
    select step, check_name, result from policy_checks
    union all
    select 7, 'No other policies on public.profiles',
        case when count(*) = 0 then 'PASS'
             else 'FAIL: unexpected policies: ' || string_agg(policyname || ' (' || permissive || ' ' || cmd || ')', ', ') end
    from pol
    where policyname not in (select policyname from expected)
    union all
    select 8, 'Signed-out (anon) has no select/insert/update/delete privilege',
        case when not (has_table_privilege('anon', 'public.profiles', 'select')
                    or has_table_privilege('anon', 'public.profiles', 'insert')
                    or has_table_privilege('anon', 'public.profiles', 'update')
                    or has_table_privilege('anon', 'public.profiles', 'delete'))
             then 'PASS' else 'FAIL: anon still has a table privilege' end
    union all
    select 9, 'User A has a profile row (needed to test isolation)',
        case when s.a_own = 1 then 'PASS'
             else 'MISSING ROW: sign in as user A in test mode and choose Save Profile' end
    from s
    union all
    select 10, 'User B has a profile row (needed to test isolation)',
        case when s.b_own = 1 then 'PASS'
             else 'MISSING ROW: sign in as user B in test mode and choose Save Profile' end
    from s
    union all
    select 11, 'User A cannot see user B''s profile',
        case when s.b_own = 0 then 'CANNOT TEST: user B has no profile row'
             when s.a_sees_b = 0 then 'PASS'
             else 'FAIL: user A can see user B''s row' end
    from s
    union all
    select 12, 'User B cannot see user A''s profile',
        case when s.a_own = 0 then 'CANNOT TEST: user A has no profile row'
             when s.b_sees_a = 0 then 'PASS'
             else 'FAIL: user B can see user A''s row' end
    from s
    union all
    select 13, 'User A sees no other user''s rows at all',
        case when s.a_sees_others = 0 then 'PASS'
             else 'FAIL: user A can see ' || s.a_sees_others || ' other row(s)' end
    from s
    union all
    select 14, 'User B sees no other user''s rows at all',
        case when s.b_sees_others = 0 then 'PASS'
             else 'FAIL: user B can see ' || s.b_sees_others || ' other row(s)' end
    from s
) checks
order by step;

-- Note: a MISSING ROW result can also mean a policy hides a user's own
-- row. If you did save a profile as that user, check Table Editor > profiles.

rollback;
