-- =========================================================
-- SWIMTICS — swimtics-test only. Profile photos (FOR REVIEW; NOT APPLIED).
-- Apply in the swimtics-test SQL editor after 001 and 002, once reviewed.
-- Never apply to swimtics-production: production photos stay off (D15)
-- until the legal / privacy review.
--
-- One private bucket, `profile-photos`, holding at most one object per
-- account at exactly `<auth.uid()>/profile.jpg`. The browser resizes the
-- chosen photo to at most 512 px and re-encodes it as JPEG (which drops
-- EXIF metadata such as GPS location) before upload, and shows it through
-- a short-lived signed URL. The bucket is not public: there is no public
-- URL for any object.
--
-- Limits enforced by the Storage API itself: 1 MiB per object, JPEG only.
-- Access enforced by Row Level Security on storage.objects (enabled by
-- Supabase): only a signed-in user, and only for their own path. Signed-out
-- (anon) callers match no policy.
-- =========================================================

begin;

-- ---------- the bucket: private, 1 MiB, JPEG only ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- ---------- the ownership rule, in one place ----------
-- true only for the signed-in user's own photo: bucket `profile-photos`,
-- name exactly '<auth.uid()>/profile.jpg'. False when signed out
-- (auth.uid() is null), for any other bucket, folder or file name.
create or replace function public.swimtics_is_own_profile_photo(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select p_bucket_id = 'profile-photos'
       and (select auth.uid()) is not null
       and p_name = (select auth.uid())::text || '/profile.jpg'
$$;

revoke all on function public.swimtics_is_own_profile_photo(text, text) from public, anon;
grant execute on function public.swimtics_is_own_profile_photo(text, text) to authenticated;

-- ---------- owner-only policies on storage.objects ----------
-- Read (needed to create a signed URL), upload, replace (upsert needs
-- read + insert + update) and delete — each only for the user's own photo.
drop policy if exists "profile-photos: read own photo"    on storage.objects;
drop policy if exists "profile-photos: upload own photo"  on storage.objects;
drop policy if exists "profile-photos: replace own photo" on storage.objects;
drop policy if exists "profile-photos: delete own photo"  on storage.objects;

create policy "profile-photos: read own photo" on storage.objects
    as permissive for select to authenticated
    using (public.swimtics_is_own_profile_photo(bucket_id, name));

create policy "profile-photos: upload own photo" on storage.objects
    as permissive for insert to authenticated
    with check (public.swimtics_is_own_profile_photo(bucket_id, name));

create policy "profile-photos: replace own photo" on storage.objects
    as permissive for update to authenticated
    using (public.swimtics_is_own_profile_photo(bucket_id, name))
    with check (public.swimtics_is_own_profile_photo(bucket_id, name));

create policy "profile-photos: delete own photo" on storage.objects
    as permissive for delete to authenticated
    using (public.swimtics_is_own_profile_photo(bucket_id, name));

commit;

-- Rollback (owner, if ever needed): empty and delete the bucket in the
-- dashboard (Storage > profile-photos), which removes the files too —
-- deleting storage rows with SQL would leave the files behind, and newer
-- Storage versions refuse it. Then:
--   drop policy "profile-photos: read own photo" on storage.objects;
--   drop policy "profile-photos: upload own photo" on storage.objects;
--   drop policy "profile-photos: replace own photo" on storage.objects;
--   drop policy "profile-photos: delete own photo" on storage.objects;
--   drop function public.swimtics_is_own_profile_photo(text, text);
