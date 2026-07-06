-- ============================================================================
-- Earthbar HR Case Management — 002 Functions
-- Routing engine, conflict detection, state machine, and RPCs.
-- All privileged writes happen here (SECURITY DEFINER) so RLS can lock tables.
-- ============================================================================

-- ---- Current-user helpers ---------------------------------------------------
create or replace function app_current_email() returns text
  language sql stable as
$$ select lower(nullif(auth.jwt() ->> 'email', '')) $$;

create or replace function app_current_dir_id() returns text
  language sql stable security definer set search_path = public as
$$ select employee_id from directory where lower(email) = app_current_email() limit 1 $$;

create or replace function app_is_admin() returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from directory d
    join handler_roles r on lower(d.title) = lower(r.title)
    where d.employee_id = app_current_dir_id() and r.is_admin
  )
$$;

create or replace function app_is_handler() returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from directory d
    join handler_roles r on lower(d.title) = lower(r.title)
    where d.employee_id = app_current_dir_id()
  )
$$;

-- ---- Management-chain check: is `ancestor` above `candidate`? ----------------
create or replace function reports_up_to(candidate text, ancestor text) returns boolean
  language sql stable security definer set search_path = public as
$$
  with recursive chain as (
    select employee_id, manager_id, 1 as depth
    from directory where employee_id = candidate
    union all
    select d.employee_id, d.manager_id, c.depth + 1
    from directory d
    join chain c on d.employee_id = c.manager_id
    where c.depth < 25                      -- cycle / depth guard
  )
  select exists (select 1 from chain where manager_id = ancestor)
$$;

-- ---- Conflict of interest: candidate is a subject, or reports up to one ------
create or replace function is_conflicted(candidate text, p_case_id uuid) returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from case_parties p
    where p.case_id = p_case_id
      and (p.subject_id = candidate or reports_up_to(candidate, p.subject_id))
  )
$$;

-- ---- Case visibility (used by RLS and by RPC authorization) ------------------
-- A viewer sees a case only if NOT conflicted on it, AND they are the assigned
-- handler or an HR admin. Reporters always see their own named case.
create or replace function can_see_case(p_case_id uuid) returns boolean
  language plpgsql stable security definer set search_path = public as
$$
declare
  v_me       text := app_current_dir_id();
  v_email    text := app_current_email();
  v_handler  text;
  v_reporter text;
begin
  select handler_id, reporter_email into v_handler, v_reporter from cases where id = p_case_id;
  if not found then return false; end if;
  if v_reporter is not null and lower(v_reporter) = v_email then return true; end if;
  if v_me is not null and is_conflicted(v_me, p_case_id) then return false; end if;   -- hidden even from admins
  if v_handler is not null and v_handler = v_me then return true; end if;
  if app_is_admin() then return true; end if;
  return false;
end;
$$;

-- ---- Routing: walk the title-based escalation matrix, skip conflicts --------
create or replace function resolve_handler(p_case_id uuid)
  returns table(handler_id text, is_external boolean, reason text)
  language plpgsql stable security definer set search_path = public as
$$
declare
  r         record;
  cand      text;
  evaluated int := 0;
begin
  for r in select title, rank from handler_roles order by rank asc loop
    select d.employee_id into cand
    from directory d
    where lower(d.title) = lower(r.title)
    order by d.employee_id
    limit 1;
    if cand is null then continue; end if;         -- no one holds this title
    evaluated := evaluated + 1;
    if not is_conflicted(cand, p_case_id) then
      handler_id  := cand;
      is_external := false;
      reason      := case when evaluated = 1 then 'default' else 'conflict_reroute' end;
      return next; return;
    end if;
  end loop;
  handler_id := null; is_external := true; reason := 'external_fallback';
  return next;
end;
$$;

-- ---- Random claim code (shown once; only its hash is stored) -----------------
create or replace function gen_claim_code() returns text
  language plpgsql as
$$
declare
  alphabet text := 'ACDEFHJKLMNPRTUVWXY34679';
  s text := '';
  i int;
begin
  for i in 1..8 loop
    if i = 5 then s := s || '-'; end if;
    s := s || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return s;
end;
$$;

-- ---- Submit a case (the one entry point that creates a case) ----------------
create or replace function submit_case(
  p_category text, p_description text, p_anonymous boolean, p_subject_ids text[]
) returns json
  language plpgsql security definer set search_path = public as
$$
declare
  v_case         cases%rowtype;
  v_email        text := app_current_email();
  v_code         text;
  v_hash         text;
  v_sev          text := case when p_category in ('Harassment / discrimination','Workplace safety')
                              then 'High' else 'Normal' end;
  v_res          record;
  v_handler_name text;
begin
  if v_email is null then raise exception 'Not authenticated'; end if;

  insert into cases(category, description, severity, anonymous, reporter_email, state)
  values (p_category, p_description, v_sev, coalesce(p_anonymous, false),
          case when p_anonymous then null else v_email end, 'Submitted')
  returning * into v_case;

  if p_subject_ids is not null then
    insert into case_parties(case_id, subject_id, role_in_case)
    select v_case.id, sid, 'subject'
    from unnest(p_subject_ids) as sid
    where exists (select 1 from directory where employee_id = sid);
  end if;

  if p_anonymous then
    v_code := gen_claim_code();
    v_hash := encode(extensions.digest(v_code, 'sha256'), 'hex');
    update cases set claim_code_hash = v_hash where id = v_case.id;
  end if;

  select * into v_res from resolve_handler(v_case.id);
  update cases set handler_id = v_res.handler_id, external = v_res.is_external,
                   route_reason = v_res.reason, state = 'Triage'
  where id = v_case.id;

  insert into assignments(case_id, handler_id, external, reason)
  values (v_case.id, v_res.handler_id, v_res.is_external, v_res.reason);

  if v_res.is_external then
    select coalesce(name, 'External advisor') into v_handler_name from external_advisor limit 1;
  else
    select name into v_handler_name from directory where employee_id = v_res.handler_id;
  end if;

  insert into case_events(case_id, actor, type, note)
  values (v_case.id, 'system', 'created',
          'Case submitted (' || (case when p_anonymous then 'anonymous' else 'named' end) || ')');

  insert into case_events(case_id, actor, type, note)
  values (v_case.id, 'system', 'routed',
          case v_res.reason
            when 'default'          then 'Auto-assigned to ' || v_handler_name || ' (default handler, no conflict)'
            when 'conflict_reroute' then 'Rerouted to ' || v_handler_name || ' — earlier handler(s) had a conflict of interest'
            else 'Escalated to ' || v_handler_name || ' — all internal handlers conflicted' end);

  insert into tasks(case_id, title, assignee_id, due_at, sla_hours, status)
  values (v_case.id, 'Triage & acknowledge', v_res.handler_id, now() + interval '24 hours', 24, 'open');
  insert into case_events(case_id, actor, type, note)
  values (v_case.id, 'system', 'task', 'Follow-up created: triage within 24h (SLA)');

  return json_build_object(
    'ref', v_case.ref, 'anonymous', coalesce(p_anonymous,false),
    'claim_code', v_code, 'handler', v_handler_name,
    'external', v_res.is_external, 'route_reason', v_res.reason);
end;
$$;

-- ---- Advance case state (handlers / admins) ---------------------------------
create or replace function advance_state(p_case_id uuid, p_to text) returns void
  language plpgsql security definer set search_path = public as
$$
declare
  v_from    text;
  v_handler text;
  v_email   text := app_current_email();
begin
  select state, handler_id into v_from, v_handler from cases where id = p_case_id;
  if not found then raise exception 'Case not found'; end if;
  if not can_see_case(p_case_id) then raise exception 'Not authorized'; end if;
  if not (app_is_admin() or v_handler = app_current_dir_id()) then raise exception 'Not authorized'; end if;

  update cases set state = p_to,
                   closed_at = case when p_to = 'Closed' then now() else closed_at end
  where id = p_case_id;

  insert into case_events(case_id, actor, type, note, from_state, to_state)
  values (p_case_id, v_email, 'state', v_from || ' → ' || p_to, v_from, p_to);

  if p_to = 'Assigned' then
    insert into tasks(case_id, title, assignee_id, due_at, sla_hours, status)
    values (p_case_id, 'Begin review / investigation', v_handler, now() + interval '72 hours', 72, 'open');
    insert into case_events(case_id, actor, type, note)
    values (p_case_id, 'system', 'task', 'Follow-up created: begin review within 72h');
  elsif p_to = 'UnderReview' then
    update tasks set status = 'done' where case_id = p_case_id and status = 'open' and title like 'Begin%';
  elsif p_to = 'Resolved' then
    update tasks set status = 'done' where case_id = p_case_id and status = 'open';
    insert into case_events(case_id, actor, type, note)
    values (p_case_id, 'system', 'notify', 'Reporter notified of outcome');
    insert into tasks(case_id, title, assignee_id, due_at, sla_hours, status)
    values (p_case_id, '30-day retaliation check-in', v_handler, now() + interval '720 hours', 720, 'open');
  elsif p_to = 'Closed' then
    update tasks set status = 'done' where case_id = p_case_id and status = 'open' and title not like '30-day%';
  end if;
end;
$$;

-- ---- Handler → reporter message ---------------------------------------------
create or replace function post_handler_message(p_case_id uuid, p_body text) returns void
  language plpgsql security definer set search_path = public as
$$
declare v_email text := app_current_email();
begin
  if not can_see_case(p_case_id) then raise exception 'Not authorized'; end if;
  if not (app_is_admin() or (select handler_id from cases where id = p_case_id) = app_current_dir_id())
    then raise exception 'Not authorized'; end if;
  insert into messages(case_id, sender_type, sender_email, body) values (p_case_id, 'handler', v_email, p_body);
  insert into case_events(case_id, actor, type, note)
  values (p_case_id, v_email, 'notify', 'Handler sent a message to the reporter');
end;
$$;

-- ---- Anonymous status lookup + reply (by claim code; no login needed) --------
create or replace function check_status(p_claim_code text) returns json
  language plpgsql security definer set search_path = public as
$$
declare
  v_hash    text := encode(extensions.digest(p_claim_code, 'sha256'), 'hex');
  v_case    cases%rowtype;
  v_handler text;
  v_msgs    json;
begin
  select * into v_case from cases where claim_code_hash = v_hash;
  if not found then return json_build_object('found', false); end if;
  if v_case.external then v_handler := 'An external advisor';
  else select name into v_handler from directory where employee_id = v_case.handler_id; end if;
  select coalesce(json_agg(json_build_object('sender', sender_type, 'body', body, 'at', created_at)
                           order by created_at), '[]'::json)
    into v_msgs from messages where case_id = v_case.id;
  return json_build_object('found', true, 'ref', v_case.ref, 'state', v_case.state,
                           'handler', v_handler, 'created_at', v_case.created_at, 'messages', v_msgs);
end;
$$;

create or replace function reporter_reply(p_claim_code text, p_body text) returns void
  language plpgsql security definer set search_path = public as
$$
declare v_hash text := encode(extensions.digest(p_claim_code, 'sha256'), 'hex'); v_id uuid;
begin
  select id into v_id from cases where claim_code_hash = v_hash;
  if v_id is null then raise exception 'Invalid code'; end if;
  insert into messages(case_id, sender_type, body) values (v_id, 'reporter', p_body);
  insert into case_events(case_id, actor, type, note)
  values (v_id, 'anonymous', 'notify', 'Reporter replied via claim code');
end;
$$;

-- ---- SLA sweep (call on a schedule via pg_cron or an Edge Function) ---------
create or replace function run_sla_sweep() returns void
  language plpgsql security definer set search_path = public as
$$
declare t record;
begin
  for t in select * from tasks where status = 'open' and due_at < now() and not reminded loop
    update tasks set reminded = true where id = t.id;
    insert into case_events(case_id, actor, type, note)
    values (t.case_id, 'system', 'reminder', 'SLA reminder: "' || t.title || '" is overdue');
  end loop;
  for t in select * from tasks where status = 'open' and due_at < now() - interval '48 hours' and not escalated loop
    update tasks set escalated = true where id = t.id;
    insert into case_events(case_id, actor, type, note)
    values (t.case_id, 'system', 'escalation', 'SLA breached >48h — flagged and escalated');
  end loop;
end;
$$;

-- ---- Grants: RPCs callable by the right roles -------------------------------
grant execute on function submit_case(text, text, boolean, text[]) to authenticated;
grant execute on function advance_state(uuid, text)                to authenticated;
grant execute on function post_handler_message(uuid, text)         to authenticated;
grant execute on function check_status(text)                       to anon, authenticated;
grant execute on function reporter_reply(text, text)               to anon, authenticated;
grant execute on function app_is_admin()                           to authenticated;
grant execute on function app_is_handler()                         to authenticated;
grant execute on function can_see_case(uuid)                       to authenticated;
