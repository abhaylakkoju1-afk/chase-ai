-- =========================================================
-- SWIMTICS — swimtics-test only. OPTIONAL, READ-ONLY checks of the
-- profile-photo bucket and its Storage policies, run in the SQL editor
-- AFTER 003_profile_photos.sql has been reviewed and applied.
--
-- Uses TWO test users. Before running, replace the two placeholder ids
-- below (marked >>> <<<) with two different users' ids from
-- Authentication > Users. Each user should already have chosen a profile
-- photo in test mode; without a photo for both users, isolation can't be
-- demonstrated and the summary says so.
--
-- Checked: the bucket is private with a 1 MiB / JPEG-only limit; RLS is
-- on for storage.objects; the four expected policies exist, apply only to
-- `authenticated`, are permissive and use exactly the ownership function;
-- no other storage.objects policy could reach this bucket; the ownership
-- function runs with the caller's rights, and gives the right answer for
-- the user's own path, another user's path, other names and buckets, and
-- when signed out; and, as each user, only their own photo is visible.
-- File size and type limits are enforced by the Storage API (not SQL), so
-- only their configuration is checked here.
--
-- Read-only: nothing is inserted, updated or deleted. Results are kept in
-- transaction-local settings (set_config(..., true)), everything runs in
-- one transaction, and it is rolled back at the end.
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
    set_config('swimtics.a_own', (select count(*) from storage.objects
        where bucket_id = 'profile-photos' and name = current_setting('swimtics.user_a') || '/profile.jpg')::text, true),
    set_config('swimtics.a_sees_b', (select count(*) from storage.objects
        where bucket_id = 'profile-photos' and name like current_setting('swimtics.user_b') || '/%')::text, true),
    set_config('swimtics.a_sees_others', (select count(*) from storage.objects
        where bucket_id = 'profile-photos' and name not like current_setting('swimtics.user_a') || '/%')::text, true),
    set_config('swimtics.fn_a_own', public.swimtics_is_own_profile_photo('profile-photos', current_setting('swimtics.user_a') || '/profile.jpg')::text, true),
    set_config('swimtics.fn_a_b', public.swimtics_is_own_profile_photo('profile-photos', current_setting('swimtics.user_b') || '/profile.jpg')::text, true),
    set_config('swimtics.fn_a_other_name', (public.swimtics_is_own_profile_photo('profile-photos', current_setting('swimtics.user_a') || '/other.jpg')
        or public.swimtics_is_own_profile_photo('profile-photos', current_setting('swimtics.user_a') || '/x/profile.jpg')
        or public.swimtics_is_own_profile_photo('profile-photos', current_setting('swimtics.user_a'))
        or public.swimtics_is_own_profile_photo('profile-photos', 'x/' || current_setting('swimtics.user_a') || '/profile.jpg'))::text, true),
    set_config('swimtics.fn_a_other_bucket', public.swimtics_is_own_profile_photo('avatars', current_setting('swimtics.user_a') || '/profile.jpg')::text, true);
reset role;

-- ---------- as user B (signed in) ----------
set local role authenticated;
select set_config('request.jwt.claims',
    json_build_object('sub', current_setting('swimtics.user_b'), 'role', 'authenticated')::text, true);
select
    set_config('swimtics.b_own', (select count(*) from storage.objects
        where bucket_id = 'profile-photos' and name = current_setting('swimtics.user_b') || '/profile.jpg')::text, true),
    set_config('swimtics.b_sees_a', (select count(*) from storage.objects
        where bucket_id = 'profile-photos' and name like current_setting('swimtics.user_a') || '/%')::text, true),
    set_config('swimtics.b_sees_others', (select count(*) from storage.objects
        where bucket_id = 'profile-photos' and name not like current_setting('swimtics.user_b') || '/%')::text, true);
reset role;

-- ---------- signed out (anon) ----------
-- (-1 = the query hit a policy that calls the ownership function, which
-- anon may not execute: some photo policy applies to anon / public)
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
do $$
begin
    perform set_config('swimtics.anon_sees', (select count(*) from storage.objects where bucket_id = 'profile-photos')::text, true);
exception when insufficient_privilege then
    perform set_config('swimtics.anon_sees', '-1', true);
end $$;
reset role;
-- the ownership function with no signed-in user (auth.uid() is null)
select set_config('swimtics.fn_signed_out', coalesce(public.swimtics_is_own_profile_photo('profile-photos', current_setting('swimtics.user_a') || '/profile.jpg'), false)::text, true);

-- ---------- summary of every check ----------
with s as (
    select
        current_setting('swimtics.user_a')                    as user_a,
        current_setting('swimtics.user_b')                    as user_b,
        current_setting('swimtics.a_own')::int                as a_own,
        current_setting('swimtics.a_sees_b')::int             as a_sees_b,
        current_setting('swimtics.a_sees_others')::int        as a_sees_others,
        current_setting('swimtics.b_own')::int                as b_own,
        current_setting('swimtics.b_sees_a')::int             as b_sees_a,
        current_setting('swimtics.b_sees_others')::int        as b_sees_others,
        current_setting('swimtics.anon_sees')::int            as anon_sees,
        current_setting('swimtics.fn_a_own')::boolean         as fn_a_own,
        current_setting('swimtics.fn_a_b')::boolean           as fn_a_b,
        current_setting('swimtics.fn_a_other_name')::boolean  as fn_a_other_name,
        current_setting('swimtics.fn_a_other_bucket')::boolean as fn_a_other_bucket,
        current_setting('swimtics.fn_signed_out')::boolean    as fn_signed_out
),
b as (
    select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'profile-photos'
),
-- conditions normalised for comparison: lower case, no whitespace or
-- parentheses, no schema / table prefixes
pol as (
    select policyname, permissive, roles, cmd, qual, with_check,
        replace(replace(regexp_replace(lower(qual), '[[:space:]()]', '', 'g'), 'public.', ''), 'objects.', '') as qual_n,
        replace(replace(regexp_replace(lower(with_check), '[[:space:]()]', '', 'g'), 'public.', ''), 'objects.', '') as check_n
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
),
expected (step, policyname, cmd, needs_using, needs_check) as (
    values
        (10, 'profile-photos: read own photo',    'SELECT', true,  false),
        (11, 'profile-photos: upload own photo',  'INSERT', false, true),
        (12, 'profile-photos: replace own photo', 'UPDATE', true,  true),
        (13, 'profile-photos: delete own photo',  'DELETE', true,  false)
),
policy_checks as (
    select e.step,
        'Policy "' || e.policyname || '": ' || e.cmd || ' to authenticated, '
            || case when e.needs_using and e.needs_check then 'USING and WITH CHECK'
                    when e.needs_using then 'USING' else 'WITH CHECK' end
            || ' swimtics_is_own_profile_photo(bucket_id, name)' as check_name,
        case
            when p.policyname is null then 'FAIL: policy not found'
            when p.cmd <> e.cmd then 'FAIL: command is ' || p.cmd || ', expected ' || e.cmd
            when p.roles <> array['authenticated']::name[] then 'FAIL: applies to ' || array_to_string(p.roles, ', ') || ', expected authenticated only'
            when p.permissive <> 'PERMISSIVE' then 'FAIL: policy is ' || p.permissive || ', expected PERMISSIVE'
            when e.needs_using and coalesce(p.qual_n, '') <> 'swimtics_is_own_profile_photobucket_id,name'
                then 'FAIL: USING is ' || coalesce(p.qual, '(none)')
            when not e.needs_using and p.qual is not null then 'FAIL: unexpected USING ' || p.qual
            when e.needs_check and coalesce(p.check_n, '') <> 'swimtics_is_own_profile_photobucket_id,name'
                then 'FAIL: WITH CHECK is ' || coalesce(p.with_check, '(none)')
            when not e.needs_check and p.with_check is not null then 'FAIL: unexpected WITH CHECK ' || p.with_check
            else 'PASS'
        end as result
    from expected e
    left join pol p on p.policyname = e.policyname
),
-- other storage.objects policies (for other buckets) are allowed, but not
-- one that could reach this bucket: no bucket_id condition at all, or one
-- that names profile-photos
other_pol as (
    select policyname, permissive, cmd from pol
    where policyname not in (select policyname from expected)
      and (coalesce(qual, '') || coalesce(with_check, '') not like '%bucket_id%'
           or coalesce(qual, '') || coalesce(with_check, '') like '%profile-photos%')
),
fn as (
    select p.prosecdef as security_definer, coalesce(array_to_string(p.proconfig, ','), '') as config
    from pg_proc p
    where p.oid = to_regprocedure('public.swimtics_is_own_profile_photo(text, text)')
),
other_fns as (
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'swimtics_is_own_profile_photo'
      and p.oid <> coalesce(to_regprocedure('public.swimtics_is_own_profile_photo(text, text)'), 0::oid)
),
odd_names as (
    select count(*) as n from storage.objects
    where bucket_id = 'profile-photos'
      and name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/profile\.jpg$'
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
    select 2, 'Bucket profile-photos exists and is private (no public URLs)',
        case when not exists (select 1 from b) then 'FAIL: bucket not found'
             when (select public from b) then 'FAIL: bucket is PUBLIC'
             else 'PASS' end
    union all
    select 3, 'Bucket upload limit is 1 MiB (1048576 bytes)',
        case when (select file_size_limit from b) = 1048576 then 'PASS'
             else 'FAIL: limit is ' || coalesce((select file_size_limit from b)::text, 'not set') end
    union all
    select 4, 'Bucket accepts JPEG only (image/jpeg)',
        case when (select allowed_mime_types from b) = array['image/jpeg'] then 'PASS'
             else 'FAIL: allowed types are ' || coalesce(array_to_string((select allowed_mime_types from b), ', '), 'any') end
    union all
    select 5, 'Row Level Security is enabled on storage.objects',
        case when (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then 'PASS'
             else 'FAIL: RLS is not enabled on storage.objects' end
    union all
    select step, check_name, result from policy_checks
    union all
    select 14, 'No other storage.objects policy can reach profile-photos (each names its own bucket)',
        case when count(*) = 0 then 'PASS'
             else 'FAIL: policies without a bucket condition, or naming profile-photos: '
                  || string_agg(policyname || ' (' || permissive || ' ' || cmd || ')', ', ') end
    from other_pol
    union all
    select 15, 'swimtics_is_own_profile_photo runs with the caller''s rights and a fixed search_path; no overloads',
        case when not exists (select 1 from fn) then 'FAIL: function not found'
             when (select security_definer from fn) then 'FAIL: function is SECURITY DEFINER'
             when (select config from fn) not like '%search_path=%' then 'FAIL: search_path not set'
             when exists (select 1 from other_fns) then 'FAIL: other overload(s): ' || (select string_agg(signature, ', ') from other_fns)
             else 'PASS' end
    union all
    select 16, 'Signed-out (anon) cannot execute the ownership function',
        case when has_function_privilege('anon', 'public.swimtics_is_own_profile_photo(text, text)', 'execute')
             then 'FAIL: anon can execute it' else 'PASS' end
    union all
    select 17, 'Ownership: user A''s own path <A>/profile.jpg is allowed',
        case when s.fn_a_own then 'PASS' else 'FAIL: user A''s own path is refused' end from s
    union all
    select 18, 'Ownership: user A is refused for user B''s path',
        case when not s.fn_a_b then 'PASS' else 'FAIL: user A is allowed user B''s path' end from s
    union all
    select 19, 'Ownership: other names in A''s folder, nested paths, a bare folder and a path under another folder are refused',
        case when not s.fn_a_other_name then 'PASS' else 'FAIL: a name other than <A>/profile.jpg is allowed' end from s
    union all
    select 20, 'Ownership: the same name in another bucket is refused',
        case when not s.fn_a_other_bucket then 'PASS' else 'FAIL: another bucket is allowed' end from s
    union all
    select 21, 'Ownership: refused when signed out (no auth.uid())',
        case when not s.fn_signed_out then 'PASS' else 'FAIL: allowed with no signed-in user' end from s
    union all
    select 22, 'Every object in profile-photos is named <uuid>/profile.jpg',
        case when (select n from odd_names) = 0 then 'PASS'
             else 'FAIL: ' || (select n from odd_names) || ' object(s) with another name' end
    union all
    select 23, 'User A has a profile photo (needed to test isolation)',
        case when s.a_own = 1 then 'PASS'
             else 'MISSING PHOTO: sign in as user A in test mode and choose a profile photo' end
    from s
    union all
    select 24, 'User B has a profile photo (needed to test isolation)',
        case when s.b_own = 1 then 'PASS'
             else 'MISSING PHOTO: sign in as user B in test mode and choose a profile photo' end
    from s
    union all
    select 25, 'User A cannot see user B''s photo',
        case when s.b_own = 0 then 'CANNOT TEST: user B has no photo'
             when s.a_sees_b = 0 then 'PASS'
             else 'FAIL: user A can see ' || s.a_sees_b || ' of user B''s object(s)' end
    from s
    union all
    select 26, 'User B cannot see user A''s photo',
        case when s.a_own = 0 then 'CANNOT TEST: user A has no photo'
             when s.b_sees_a = 0 then 'PASS'
             else 'FAIL: user B can see ' || s.b_sees_a || ' of user A''s object(s)' end
    from s
    union all
    select 27, 'User A sees no other user''s photo at all',
        case when s.a_sees_others = 0 then 'PASS'
             else 'FAIL: user A can see ' || s.a_sees_others || ' other object(s)' end
    from s
    union all
    select 28, 'User B sees no other user''s photo at all',
        case when s.b_sees_others = 0 then 'PASS'
             else 'FAIL: user B can see ' || s.b_sees_others || ' other object(s)' end
    from s
    union all
    select 29, 'Signed out (anon) sees no profile photo',
        case when s.anon_sees = 0 then 'PASS'
             when s.anon_sees = -1 then 'FAIL: a photo policy applies to signed-out (anon / public) requests'
             else 'FAIL: anon can see ' || s.anon_sees || ' object(s)' end
    from s
) checks
order by step;

-- Note: a MISSING PHOTO result can also mean a policy hides a user's own
-- photo. If you did choose a photo as that user, check Storage > profile-photos.

rollback;
