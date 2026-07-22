-- ============================================================================
-- 011 HR notes + requests (per HR team meeting, 2026-07-21)
-- APPLIED to production 2026-07-21 (migrations: v2_notes_and_requests,
-- v2_submit_accepts_request)
--  * case_notes: internal HR-only notes on a case. RLS = handlers who can see
--    the case; reporters can NEVER read these.
--  * intake_type 'question' renamed to 'request' (homepage is requests-only;
--    request type e.g. "Accommodation — Religious/Medical" stored in category).
--  * submit_case_v2 re-created accepting ('incident','request') — body otherwise
--    identical to 006 (see git history of that file).
-- ============================================================================

create table if not exists case_notes (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references cases(id),
  author_email text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);
alter table case_notes enable row level security;
drop policy if exists notes_select on case_notes;
create policy notes_select on case_notes for select to authenticated
  using (app_is_handler() and can_see_case(case_id));
grant select on case_notes to authenticated;

create or replace function add_case_note(p_case_id uuid, p_body text) returns void
  language plpgsql security definer set search_path = public as
$$
begin
  if not (app_is_handler() and can_see_case(p_case_id)) then raise exception 'Not authorized'; end if;
  if coalesce(trim(p_body),'') = '' then raise exception 'Note is empty'; end if;
  insert into case_notes(case_id, author_email, body) values (p_case_id, app_current_email(), trim(p_body));
  update cases set updated_at = now() where id = p_case_id;
end;
$$;
grant execute on function add_case_note(uuid, text) to authenticated;

alter table cases drop constraint if exists cases_intake_type_check;
update cases set intake_type = 'request' where intake_type = 'question';
alter table cases add constraint cases_intake_type_check
  check (intake_type in ('incident','request'));

-- submit_case_v2: validation line now `p_intake_type not in ('incident','request')`;
-- full body maintained in 006_v2_functions.sql pattern (re-applied in prod).