-- ============================================================================
-- 012 v3 — accommodation tracking, request state machine, manual reassignment
-- APPLIED to production 2026-07-23 (migrations: v3_accommodations_and_reassign,
-- v3_requests_enter_at_assigned). Per Vicky's email, items 3 + 4 + reassign.
--
-- Request lifecycle (frontend-enforced, deliberately loose):
--   Assigned · Under Review · Awaiting Information · In Interactive Process ·
--   Monitoring · Closed
-- Requests now ENTER at 'Assigned' (see 013 / submit_case_v2); incidents still
-- enter at 'Triage' and keep their own lifecycle unchanged.
-- ============================================================================

alter table cases
  add column if not exists accommodation_status   text
      check (accommodation_status in ('Approved','Approved with Alternative','Denied','Withdrawn')),
  add column if not exists accommodation_start    date,
  add column if not exists accommodation_end      date,
  add column if not exists accommodation_duration text
      check (accommodation_duration in ('Temporary','Ongoing'));

-- ⚠️ 007 revoked table-wide SELECT on cases and granted an explicit column list.
-- New columns MUST be granted or the dashboard silently cannot read them.
grant select (accommodation_status, accommodation_start, accommodation_end, accommodation_duration)
  on cases to authenticated;

-- HR team list readable by handlers (powers the reassign dropdown)
drop policy if exists hr_team_read on hr_team;
create policy hr_team_read on hr_team for select to authenticated using (app_is_handler());
grant select on hr_team to authenticated;

-- set_accommodation(case, status, start, end, duration) — handlers only.
-- Validates the enums and rejects an end date earlier than the start date.
-- (Full body applied in production; see git history / Supabase migration list.)

-- reassign_case(case, to_employee, reason) — handlers only. Refuses targets who
-- are conflicted on the case (they would be blinded by RLS immediately after),
-- deactivates the old assignment row, moves open tasks to the new owner, writes
-- a 'routed' audit event, and emails the new owner.

-- delete_case(case) [migrations 014+015, applied 2026-08-05] — handlers only,
-- CLOSED cases only ("Cannot delete an open case"); permanently removes the case
-- and all child rows. ⚠️ Supabase FORBIDS deleting storage.objects from SQL
-- ("Use the Storage API instead") — evidence files stay in the bucket but become
-- permanently unreadable (select policy requires can_see_case, false once the
-- case row is gone).

-- close_case is now intake-aware:
--   incident -> requires substantiated true/false (unchanged)
--   request  -> requires accommodation_status to be set first
-- advance_state no longer creates investigation SLA tasks on requests.
