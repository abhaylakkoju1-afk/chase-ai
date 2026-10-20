-- =========================================================
-- SWIMTICS — Supabase TEST project (swimtics-test) only.
-- Status: FOR REVIEW. Not applied anywhere yet. Apply only to the
-- swimtics-test project, by pasting into its SQL editor, after review,
-- and only after 001_profiles.sql (profiles are used by the import).
--
-- Personal bests for signed-in test users, mirroring the shapes the app
-- already uses (src/app/data/user-data.js):
--   personal_bests  one row per (user, event, course); pb_key = pbKey(event, course)
--   pb_entries      every recorded swim (history entry); entry_id is the
--                   existing deterministic id (deviceEntryId / import id),
--                   so retrying a sync or re-importing never duplicates a swim
--   device_imports  which device data sets (fingerprintLocal) were imported
-- add_pb_entries() adds swims to one PB atomically and keeps best_time
-- consistent, with the same rule as mergeIntoCloudPb() in user-data.js.
--
-- Row Level Security: a signed-in user can read and change only their own
-- rows; signed-out (anon) requests get nothing. No photos are stored here.
-- =========================================================

-- ---------- tables ----------
create table if not exists public.personal_bests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    pb_key text not null check (char_length(pb_key) between 1 and 400),
    event text not null check (char_length(event) between 1 and 80),
    course text not null check (char_length(course) between 1 and 40),
    best_time text not null check (char_length(best_time) between 1 and 16),
    updated_at timestamptz not null default now(),
    unique (user_id, pb_key),
    unique (id, user_id)                      -- target of pb_entries' owner-consistent foreign key
);

create table if not exists public.pb_entries (
    pb_id uuid not null,
    user_id uuid not null,
    entry_id text not null check (char_length(entry_id) between 1 and 120),
    -- at most millisecond precision (the app sends seconds rounded to 3 decimals)
    seconds numeric not null check (seconds > 0 and seconds < 100000 and seconds = round(seconds, 3)),
    ord bigint not null,
    created_at timestamptz not null default now(),
    primary key (pb_id, entry_id),
    -- an entry can only belong to a PB owned by the same user; deleting the
    -- PB (or the user, via personal_bests) deletes its entries
    foreign key (pb_id, user_id) references public.personal_bests (id, user_id) on delete cascade
);

create index if not exists pb_entries_user_id_idx on public.pb_entries (user_id);

create table if not exists public.device_imports (
    user_id uuid not null references auth.users (id) on delete cascade,
    fingerprint text not null check (char_length(fingerprint) between 1 and 64),
    imported_at timestamptz not null default now(),
    pb_entries integer not null check (pb_entries >= 0),
    profile_fields integer not null check (profile_fields >= 0),
    primary key (user_id, fingerprint)
);

comment on table public.personal_bests is 'SWIMTICS test: one row per user, event and course; owner-only via RLS.';
comment on table public.pb_entries is 'SWIMTICS test: every recorded swim of a personal best; owner-only via RLS; not editable.';
comment on table public.device_imports is 'SWIMTICS test: device data sets already imported into an account; owner-only via RLS.';

-- ---------- updated_at ----------
create or replace function public.swimtics_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists personal_bests_touch_updated_at on public.personal_bests;
create trigger personal_bests_touch_updated_at
    before insert or update on public.personal_bests
    for each row execute function public.swimtics_touch_updated_at();

-- ---------- time strings -> seconds (same as timeToSeconds in user-data.js) ----------
-- "31.20" -> 31.20, "1:02.33" -> 62.33; anything else -> null
create or replace function public.swimtics_time_to_seconds(t text)
returns numeric
language sql
immutable
set search_path = ''
as $$
    select case
        when t ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
            then trim(t)::numeric
        when t ~ '^\s*[0-9]+:[0-9]+(\.[0-9]+)?\s*$'
            then split_part(trim(t), ':', 1)::numeric * 60 + split_part(trim(t), ':', 2)::numeric
        else null
    end;
$$;

-- ---------- add swims to one PB, keeping best_time consistent ----------
-- Runs with the caller's own rights (security invoker), so Row Level
-- Security applies to every statement inside it. p_entries is a JSON array
-- of {entry_id, seconds, ord}. Existing entries are never changed: an
-- entry_id that already exists is skipped. best_time follows
-- mergeIntoCloudPb(): the better of the stored and the incoming time; if
-- that is still slower than the fastest recorded swim, the fastest swim's
-- seconds. Times are compared at millisecond precision (the app's own
-- parsing gives e.g. 68.03999999999999 for "1:08.04"; exact comparison
-- would wrongly replace "1:08.04"). Returns the PB with all its entries.
-- Mirrored in JavaScript by bestTimeAfterMerge() (src/app/data/supabase-test-pbs.js).
create or replace function public.add_pb_entries(
    p_pb_key text,
    p_event text,
    p_course text,
    p_time text,
    p_entries jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_pb public.personal_bests;
    v_min numeric;
    v_best text;
    v_stored numeric;
    v_incoming numeric;
begin
    if v_uid is null then
        raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 500 then
        raise exception 'p_entries must be a JSON array of at most 500 entries' using errcode = '22023';
    end if;

    insert into public.personal_bests (user_id, pb_key, event, course, best_time)
    values (v_uid, p_pb_key, p_event, p_course, p_time)
    on conflict (user_id, pb_key) do nothing;

    select * into v_pb
    from public.personal_bests
    where user_id = v_uid and pb_key = p_pb_key
    for update;                                   -- serialise concurrent adds to the same PB
    if v_pb.id is null then
        raise exception 'personal best not found' using errcode = 'P0002';
    end if;

    insert into public.pb_entries (pb_id, user_id, entry_id, seconds, ord)
    select v_pb.id, v_uid, e ->> 'entry_id', (e ->> 'seconds')::numeric, (e ->> 'ord')::bigint
    from jsonb_array_elements(p_entries) as e
    on conflict (pb_id, entry_id) do nothing;

    select round(min(seconds), 3) into v_min from public.pb_entries where pb_id = v_pb.id;

    v_stored := public.swimtics_time_to_seconds(v_pb.best_time);
    v_incoming := public.swimtics_time_to_seconds(p_time);
    v_best := case
        when v_stored is null then coalesce(p_time, v_pb.best_time)
        when v_incoming is not null and v_incoming < v_stored then p_time
        else v_pb.best_time
    end;
    if v_min is not null and coalesce(round(public.swimtics_time_to_seconds(v_best), 3), v_min + 1) > v_min then
        v_best := trim_scale(v_min)::text;        -- e.g. 68.040 -> '68.04', 30.000 -> '30' (at most 9 characters)
    end if;

    update public.personal_bests set best_time = v_best where id = v_pb.id;

    return jsonb_build_object(
        'pb_key', v_pb.pb_key,
        'event', v_pb.event,
        'course', v_pb.course,
        'best_time', v_best,
        'pb_entries', coalesce((
            select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'seconds', x.seconds, 'ord', x.ord)
                             order by x.ord, x.entry_id)
            from public.pb_entries as x
            where x.pb_id = v_pb.id
        ), '[]'::jsonb)
    );
end;
$$;

-- ---------- access ----------
alter table public.personal_bests enable row level security;
alter table public.personal_bests force row level security;
alter table public.pb_entries enable row level security;
alter table public.pb_entries force row level security;
alter table public.device_imports enable row level security;
alter table public.device_imports force row level security;

-- nothing for signed-out requests; only what the policies allow for signed-in ones
revoke all on table public.personal_bests, public.pb_entries, public.device_imports from anon;
revoke all on table public.personal_bests, public.pb_entries, public.device_imports from authenticated;
grant select, insert, update, delete on table public.personal_bests to authenticated;
grant select, insert on table public.pb_entries to authenticated;          -- recorded swims are not edited
grant select, insert on table public.device_imports to authenticated;

revoke all on function public.add_pb_entries(text, text, text, text, jsonb) from public;
revoke all on function public.add_pb_entries(text, text, text, text, jsonb) from anon;
grant execute on function public.add_pb_entries(text, text, text, text, jsonb) to authenticated;
revoke all on function public.swimtics_time_to_seconds(text) from public;
revoke all on function public.swimtics_time_to_seconds(text) from anon;
grant execute on function public.swimtics_time_to_seconds(text) to authenticated;

-- personal_bests: owner-only
drop policy if exists "personal_bests: read own rows" on public.personal_bests;
create policy "personal_bests: read own rows"
    on public.personal_bests for select
    to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists "personal_bests: insert own rows" on public.personal_bests;
create policy "personal_bests: insert own rows"
    on public.personal_bests for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

drop policy if exists "personal_bests: update own rows" on public.personal_bests;
create policy "personal_bests: update own rows"
    on public.personal_bests for update
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

drop policy if exists "personal_bests: delete own rows" on public.personal_bests;
create policy "personal_bests: delete own rows"
    on public.personal_bests for delete
    to authenticated
    using ((select auth.uid()) = user_id);

-- pb_entries: owner-only read and insert (the foreign key also ties each
-- entry to a PB of the same user)
drop policy if exists "pb_entries: read own rows" on public.pb_entries;
create policy "pb_entries: read own rows"
    on public.pb_entries for select
    to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists "pb_entries: insert own rows" on public.pb_entries;
create policy "pb_entries: insert own rows"
    on public.pb_entries for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

-- device_imports: owner-only read and insert
drop policy if exists "device_imports: read own rows" on public.device_imports;
create policy "device_imports: read own rows"
    on public.device_imports for select
    to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists "device_imports: insert own rows" on public.device_imports;
create policy "device_imports: insert own rows"
    on public.device_imports for insert
    to authenticated
    with check ((select auth.uid()) = user_id);
