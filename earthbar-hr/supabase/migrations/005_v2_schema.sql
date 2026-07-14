-- ============================================================================
-- 005 v2 schema — per 2026-07-13 meeting (see UPDATE_SPEC.md)
-- APPLIED to production 2026-07-14 via Supabase MCP (migration: v2_schema)
-- ============================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---- cases: v2 fields --------------------------------------------------------
alter table cases
  add column if not exists intake_type          text not null default 'incident'
      check (intake_type in ('incident','question')),
  add column if not exists location             text,
  add column if not exists reporter_relationship text,
  add column if not exists reporter_role        text,
  add column if not exists reporter_phone       text,
  add column if not exists reporter_display     text,   -- shown to HR ONLY for named cases
  add column if not exists risk_level           text
      check (risk_level in ('Low','Medium','High')),
  add column if not exists substantiated        boolean,
  add column if not exists substantiated_note   text,
  add column if not exists policies             text,
  add column if not exists ai_summary           text,
  add column if not exists manual_entry         boolean not null default false,
  add column if not exists updated_at           timestamptz not null default now(),
  add column if not exists last_stale_reminder  timestamptz;

-- backfill reporter_display for existing named cases
update cases set reporter_display = reporter_email
 where reporter_display is null and anonymous = false and reporter_email is not null;

-- ---- case_parties: allow customers + victim/witness roles ---------------------
alter table case_parties
  add column if not exists party_type   text not null default 'employee'
      check (party_type in ('employee','customer')),
  add column if not exists display_name text;
alter table case_parties alter column subject_id drop not null;
alter table case_parties drop constraint if exists case_parties_role_chk;
alter table case_parties add constraint case_parties_role_chk
  check (role_in_case in ('subject','victim','witness'));

-- ---- fixed HR team (replaces title-matrix routing; see 006) -------------------
create table if not exists hr_team (
  employee_id text primary key references directory(employee_id),
  rank        integer not null,
  can_route   boolean not null default true,   -- eligible to be assigned cases
  is_admin    boolean not null default true    -- sees all non-conflicted cases
);
alter table hr_team enable row level security;

insert into hr_team(employee_id, rank, can_route, is_admin) values
  ('G2J4CF00C080', 1, true,  true),   -- Lindsey Freitag (default handler)
  ('G33C9M000080', 2, true,  true),   -- Vicky Chung
  ('G2J4FM00R080', 3, true,  true),   -- Ernie Zavaleta
  ('G2J4D5013080', 4, false, true),   -- Flora Lei (dashboard, not auto-routed)
  ('G55J82000080', 5, false, true)    -- Eitan Sneider (dashboard, not auto-routed)
on conflict (employee_id) do update
  set rank = excluded.rank, can_route = excluded.can_route, is_admin = excluded.is_admin;

-- Adrian (not in directory) gets access by email
insert into access_overrides(email, is_admin, note)
values ('adriangraf08@gmail.com', true, 'Adrian Graf — intern building the app')
on conflict (email) do update set is_admin = excluded.is_admin;

-- ---- email outbox (drained by the send-email edge function) -------------------
create table if not exists notifications_outbox (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid references cases(id),
  to_email   text not null,
  template   text not null default 'case',    -- 'case' = HRCaseManagement@, 'relay' = HR@
  subject    text not null,
  body       text not null,
  status     text not null default 'pending' check (status in ('pending','sent','error','skipped')),
  attempts   integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
alter table notifications_outbox enable row level security;
-- deliberately NO client grants and NO policies: server-side only.

create index if not exists idx_outbox_pending on notifications_outbox(status) where status = 'pending';
create index if not exists idx_parties_subject on case_parties(subject_id);
create index if not exists idx_cases_updated on cases(updated_at);
