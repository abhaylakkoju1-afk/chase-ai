-- =========================================================
-- SWIMTICS — Supabase TEST project (swimtics-test) only.
-- Status: FOR REVIEW. Not applied anywhere yet. Apply only to the
-- swimtics-test project, by pasting into its SQL editor, after review.
--
-- One table: each signed-in user's own profile text fields (the same 24
-- fields as src/app/data/user-data.js PROFILE_FIELDS; no photos).
-- Row Level Security: a user can read and change only their own row;
-- signed-out (anon) requests get nothing.
-- =========================================================

create table if not exists public.profiles (
    user_id uuid primary key references auth.users (id) on delete cascade,
    "name" text check (char_length("name") <= 200),
    "dob" text check (char_length("dob") <= 200),
    "gender" text check (char_length("gender") <= 200),
    "nationality" text check (char_length("nationality") <= 200),
    "club" text check (char_length("club") <= 200),
    "primaryStroke" text check (char_length("primaryStroke") <= 200),
    "secondaryStroke" text check (char_length("secondaryStroke") <= 200),
    "eventsPref" text check (char_length("eventsPref") <= 200),
    "distanceType" text check (char_length("distanceType") <= 200),
    "height" text check (char_length("height") <= 200),
    "weight" text check (char_length("weight") <= 200),
    "wingspan" text check (char_length("wingspan") <= 200),
    "strengths" text check (char_length("strengths") <= 200),
    "weaknesses" text check (char_length("weaknesses") <= 200),
    "level" text check (char_length("level") <= 200),
    "hours" text check (char_length("hours") <= 200),
    "coach" text check (char_length("coach") <= 200),
    "facility" text check (char_length("facility") <= 200),
    "shortGoal" text check (char_length("shortGoal") <= 200),
    "longGoal" text check (char_length("longGoal") <= 200),
    "competition" text check (char_length("competition") <= 200),
    "lastComp" text check (char_length("lastComp") <= 200),
    "bestMeet" text check (char_length("bestMeet") <= 200),
    "medals" text check (char_length("medals") <= 200),
    updated_at timestamptz not null default now()
);

comment on table public.profiles is
    'SWIMTICS test: one row per user; owner-only access via RLS.';

-- keep updated_at current on every change
create or replace function public.profiles_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
    before insert or update on public.profiles
    for each row execute function public.profiles_touch_updated_at();

-- ---------- access ----------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

-- nothing for signed-out requests; only what the policies allow for signed-in ones
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
grant select, insert, update, delete on table public.profiles to authenticated;

drop policy if exists "profiles: read own row" on public.profiles;
create policy "profiles: read own row"
    on public.profiles for select
    to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists "profiles: insert own row" on public.profiles;
create policy "profiles: insert own row"
    on public.profiles for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

drop policy if exists "profiles: update own row" on public.profiles;
create policy "profiles: update own row"
    on public.profiles for update
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

drop policy if exists "profiles: delete own row" on public.profiles;
create policy "profiles: delete own row"
    on public.profiles for delete
    to authenticated
    using ((select auth.uid()) = user_id);
