-- ============================================================================
-- Earthbar HR Case Management — 003 Row-Level Security
-- Visibility is enforced HERE, in the database. A case a viewer may not see is
-- never sent to their browser. All writes go through the SECURITY DEFINER RPCs
-- in 002 (there are deliberately no INSERT/UPDATE/DELETE policies).
-- ============================================================================

alter table directory       enable row level security;
alter table cases           enable row level security;
alter table case_parties    enable row level security;
alter table assignments     enable row level security;
alter table case_events     enable row level security;
alter table tasks           enable row level security;
alter table messages        enable row level security;
alter table handler_roles   enable row level security;
alter table external_advisor enable row level security;

-- Directory + config: any signed-in employee may read (internal org chart / labels)
drop policy if exists directory_read on directory;
create policy directory_read on directory for select to authenticated using (true);

drop policy if exists handler_roles_read on handler_roles;
create policy handler_roles_read on handler_roles for select to authenticated using (true);

drop policy if exists external_advisor_read on external_advisor;
create policy external_advisor_read on external_advisor for select to authenticated using (true);

-- Cases: only those the viewer is allowed to see (see can_see_case in 002)
drop policy if exists cases_select on cases;
create policy cases_select on cases for select to authenticated using (can_see_case(id));

-- Child records inherit the parent case's visibility
drop policy if exists parties_select on case_parties;
create policy parties_select on case_parties for select to authenticated using (can_see_case(case_id));

drop policy if exists assignments_select on assignments;
create policy assignments_select on assignments for select to authenticated using (can_see_case(case_id));

drop policy if exists events_select on case_events;
create policy events_select on case_events for select to authenticated using (can_see_case(case_id));

drop policy if exists tasks_select on tasks;
create policy tasks_select on tasks for select to authenticated using (can_see_case(case_id));

drop policy if exists messages_select on messages;
create policy messages_select on messages for select to authenticated using (can_see_case(case_id));

-- Table privileges: authenticated may SELECT (rows still filtered by RLS above).
-- Writes are not granted — they only happen inside SECURITY DEFINER functions.
grant usage on schema public to anon, authenticated;
grant select on directory, handler_roles, external_advisor,
                cases, case_parties, assignments, case_events, tasks, messages
  to authenticated;
