-- ============================================================================
-- Earthbar HR Case Management — 001 Schema
-- Tables, indexes, sequence. Run first.
-- ============================================================================

-- pgcrypto provides digest(); on Supabase it lives in the `extensions` schema.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---- Org directory (imported from the Store Directory) ----------------------
create table if not exists directory (
  employee_id text primary key,
  name        text not null,
  email       text,                    -- lowercase; nullable (many store staff have none)
  title       text,
  store       text,
  manager_id  text references directory(employee_id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists directory_email_uidx on directory (lower(email)) where email is not null;
create index if not exists directory_manager_idx on directory(manager_id);
create index if not exists directory_title_idx   on directory(lower(title));

-- ---- Role config: which titles are handlers, their escalation order --------
-- The escalation matrix is defined by TITLE, not by person. Whoever currently
-- holds the title is the handler at that rank — so it tracks org changes.
create table if not exists handler_roles (
  title    text primary key,
  rank     int  not null,             -- 1 = first handler tried
  is_admin boolean not null default false
);

-- ---- Single-row config for the external fallback advisor --------------------
create table if not exists external_advisor (
  id    boolean primary key default true check (id),
  name  text not null,
  email text,
  note  text
);

-- ---- Cases ------------------------------------------------------------------
create sequence if not exists case_ref_seq start 105;

create table if not exists cases (
  id              uuid primary key default gen_random_uuid(),
  ref             text unique not null default ('EB-' || lpad(nextval('case_ref_seq')::text, 4, '0')),
  category        text not null,
  description     text not null,
  severity        text not null default 'Normal',
  anonymous       boolean not null default false,
  reporter_email  text,                       -- null when anonymous
  claim_code_hash text,                        -- sha256 hex when anonymous
  handler_id      text references directory(employee_id),
  external        boolean not null default false,
  route_reason    text,
  state           text not null default 'Submitted',
  created_at      timestamptz not null default now(),
  closed_at       timestamptz
);
create index if not exists cases_handler_idx  on cases(handler_id);
create index if not exists cases_reporter_idx on cases(lower(reporter_email));

-- ---- People named in a case (subjects drive conflict-of-interest routing) ---
create table if not exists case_parties (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references cases(id) on delete cascade,
  subject_id   text not null references directory(employee_id),
  role_in_case text not null default 'subject'
);
create index if not exists case_parties_case_idx    on case_parties(case_id);
create index if not exists case_parties_subject_idx on case_parties(subject_id);

-- ---- Assignment history -----------------------------------------------------
create table if not exists assignments (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references cases(id) on delete cascade,
  handler_id text references directory(employee_id),
  external   boolean not null default false,
  reason     text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists assignments_case_idx on assignments(case_id);

-- ---- Immutable-ish audit log ------------------------------------------------
create table if not exists case_events (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references cases(id) on delete cascade,
  at         timestamptz not null default now(),
  actor      text,
  type       text not null,
  note       text,
  from_state text,
  to_state   text
);
create index if not exists case_events_case_idx on case_events(case_id);

-- ---- Follow-up tasks / SLAs -------------------------------------------------
create table if not exists tasks (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references cases(id) on delete cascade,
  title      text not null,
  assignee_id text references directory(employee_id),
  due_at     timestamptz,
  sla_hours  int,
  status     text not null default 'open',
  reminded   boolean not null default false,
  escalated  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tasks_case_idx on tasks(case_id);
create index if not exists tasks_open_idx on tasks(status) where status = 'open';

-- ---- Two-way messages (named via auth, anonymous via claim code) ------------
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references cases(id) on delete cascade,
  sender_type text not null check (sender_type in ('reporter','handler')),
  sender_email text,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists messages_case_idx on messages(case_id);
