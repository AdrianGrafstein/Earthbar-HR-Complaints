-- ============================================================================
-- 007 v2 privileges — reporter contact info is SERVER-SIDE ONLY
-- APPLIED to production 2026-07-14 (migration: v2_policies_hide_contact)
-- Clients (any role, any login) can never select reporter_email, reporter_phone
-- or claim_code_hash. Only SECURITY DEFINER functions and the service role read
-- them. This is what makes "anonymous to HR" technical, not honor-system.
-- NOTE: because of column grants, the frontend must NEVER use select("*") on
-- cases — it must request explicit columns (see CASE_COLS in web/app.js).
-- ============================================================================

revoke select on cases from authenticated;
grant select (id, ref, category, description, severity, anonymous,
              handler_id, external, route_reason, state, created_at, closed_at,
              incident_date, intake_type, location, reporter_relationship,
              reporter_role, reporter_display, risk_level, substantiated,
              substantiated_note, policies, ai_summary, manual_entry, updated_at)
  on cases to authenticated;

-- case_parties gained columns after 003's table-level grant; re-assert (harmless)
grant select on case_parties to authenticated;
