-- ============================================================================
-- 008 storage — evidence bucket (case-scoped) + handbook bucket (server-only)
-- APPLIED to production 2026-07-14 (migration: v2_storage)
-- Evidence paths are <case_id>/<filename>; access follows can_see_case().
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 26214400)   -- 25 MB per file
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('handbook', 'handbook', false)
on conflict (id) do nothing;

-- upload: signed-in users who can see the case (reporter incl. anonymous-by-email,
-- assigned handler, admins) may add files; nobody can overwrite or delete via API
drop policy if exists evidence_insert on storage.objects;
create policy evidence_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and can_see_case(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists evidence_select on storage.objects;
create policy evidence_select on storage.objects for select to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and can_see_case(((storage.foldername(name))[1])::uuid)
  );
-- no update/delete policies: files are immutable once submitted (audit integrity)
-- handbook bucket: no policies at all — service-role (edge functions) only
