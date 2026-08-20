-- ============================================================================
-- 015 — 8/18 HR Complaint System Sync: witness levels + reporter role
--
-- *** NOT YET APPLIED TO THE LIVE DATABASE. ***
-- Apply this in the Supabase SQL editor BEFORE (or together with) deploying the
-- matching frontend (feat/hr-sync-2026-08-18): without it, submitting a case
-- whose parties use the new role values fails the check constraint below.
--
-- Call decisions (Ernie / Lindsey / Vicky, 2026-08-18):
--   * Witness split into two levels: firsthand and secondhand.
--   * "Reporter" added as a role (someone reporting on behalf of others).
--   * Role is effectively multi-select: the frontend now inserts one
--     case_parties row per person+role, so no schema change is needed for
--     multi-role — only the widened value list.
--
-- Backward compatibility: existing rows keep 'subject' / 'victim' / plain
-- 'witness' — all still valid, no data rewrite. The frontend keeps displaying
-- legacy 'witness' as "Witness".
-- ============================================================================

alter table case_parties drop constraint if exists case_parties_role_chk;
alter table case_parties add constraint case_parties_role_chk
  check (role_in_case in ('subject','victim','witness',
                          'witness_firsthand','witness_secondhand','reporter'));
