-- ============================================================================
-- 010 flat HR team (per Adrian, 2026-07-15)
-- SEE + HANDLE = exactly four people: Lindsey, Vicky, Ernie, Flora.
-- No hierarchy: all four can see and work EVERY case (minus conflict-of-interest,
-- which blinds anyone named in a case or reporting up to someone named).
-- Rank now means ONLY the auto-assignment fallback order for new cases:
-- Lindsey is the default handler; if she's conflicted, next non-conflicted.
-- Adrian and Eitan are REMOVED from all case access (re-add for testing with a
-- one-line insert into access_overrides if ever needed).
-- ============================================================================

insert into hr_team(employee_id, rank, can_route, is_admin) values
  ('G2J4CF00C080', 1, true, true),   -- Lindsey Freitag (default handler)
  ('G33C9M000080', 2, true, true),   -- Vicky Chung
  ('G2J4FM00R080', 3, true, true),   -- Ernie Zavaleta
  ('G2J4D5013080', 4, true, true)    -- Flora Lei
on conflict (employee_id) do update
  set rank = excluded.rank, can_route = excluded.can_route, is_admin = excluded.is_admin;

delete from hr_team where employee_id = 'G55J82000080';               -- Eitan out
delete from access_overrides where email = 'adriangraf08@gmail.com';  -- Adrian out

-- verify
select d.name, t.rank, t.can_route, t.is_admin
from hr_team t join directory d on d.employee_id = t.employee_id
order by t.rank;
