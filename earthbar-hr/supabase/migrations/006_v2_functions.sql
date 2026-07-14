-- ============================================================================
-- 006 v2 functions — fixed-team routing, v2 RPC contract, email queueing
-- APPLIED to production 2026-07-14 via Supabase MCP (migration: v2_functions)
-- ============================================================================

-- ---- app config (portal link used in emails) ---------------------------------
create table if not exists app_config (key text primary key, value text);
alter table app_config enable row level security;
insert into app_config(key, value) values
  ('portal_url', 'https://adriangrafstein.github.io/Earthbar-HR-Complaints/')
on conflict (key) do nothing;

create or replace function cfg(p_key text) returns text
  language sql stable security definer set search_path = public as
$$ select value from app_config where key = p_key $$;

-- ---- access helpers: fixed team + email overrides -----------------------------
create or replace function app_is_admin() returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (select 1 from hr_team t where t.employee_id = app_current_dir_id() and t.is_admin)
      or exists (select 1 from access_overrides o where lower(o.email) = app_current_email() and o.is_admin)
$$;

create or replace function app_is_handler() returns boolean
  language sql stable security definer set search_path = public as
$$
  select exists (select 1 from hr_team t where t.employee_id = app_current_dir_id())
      or exists (select 1 from access_overrides o where lower(o.email) = app_current_email())
$$;

-- ---- routing: walk the fixed team by rank, skip conflicts ---------------------
create or replace function resolve_handler(p_case_id uuid)
  returns table(handler_id text, is_external boolean, reason text)
  language plpgsql stable security definer set search_path = public as
$$
declare r record; evaluated int := 0;
begin
  for r in select employee_id from hr_team where can_route order by rank asc loop
    evaluated := evaluated + 1;
    if not is_conflicted(r.employee_id, p_case_id) then
      handler_id := r.employee_id; is_external := false;
      reason := case when evaluated = 1 then 'default' else 'conflict_reroute' end;
      return next; return;
    end if;
  end loop;
  handler_id := null; is_external := true; reason := 'external_fallback';
  return next;
end;
$$;

-- ---- email queue helper --------------------------------------------------------
create or replace function queue_email(p_case_id uuid, p_to text, p_subject text, p_body text, p_template text default 'case')
  returns void language plpgsql security definer set search_path = public as
$$
begin
  if p_to is null or p_to = '' then return; end if;
  insert into notifications_outbox(case_id, to_email, template, subject, body)
  values (p_case_id, p_to, p_template, p_subject, p_body);
end;
$$;

-- first non-conflicted routable HR member's email (Lindsey unless she's involved)
create or replace function hr_notify_email(p_case_id uuid) returns text
  language sql stable security definer set search_path = public as
$$
  select d.email from hr_team t join directory d on d.employee_id = t.employee_id
  where t.can_route and not is_conflicted(t.employee_id, p_case_id)
  order by t.rank asc limit 1
$$;

-- ---- submit_case_v2 ------------------------------------------------------------
create or replace function submit_case_v2(
  p_intake_type text, p_category text, p_description text, p_anonymous boolean,
  p_location text, p_relationship text, p_role text,
  p_contact_email text, p_contact_phone text, p_parties jsonb,
  p_manual boolean default false, p_incident_date date default null
) returns json
  language plpgsql security definer set search_path = public as
$$
declare
  v_case cases%rowtype;
  v_email text := app_current_email();
  v_code text; v_hash text; v_res record; v_handler_name text;
  v_party jsonb; v_notify text;
begin
  if v_email is null then raise exception 'Not authenticated'; end if;
  if p_intake_type not in ('incident','question') then raise exception 'Bad intake type'; end if;
  if p_manual and not app_is_handler() then raise exception 'Only the HR team can add cases manually'; end if;
  if not p_manual and (p_contact_email is null or p_contact_email !~ '^\S+@\S+\.\S+$') then
    raise exception 'A contact email is required';
  end if;

  insert into cases(intake_type, category, description, anonymous, location,
                    reporter_relationship, reporter_role,
                    reporter_email, reporter_phone, reporter_display,
                    manual_entry, incident_date, state)
  values (p_intake_type, p_category, p_description, coalesce(p_anonymous,false), p_location,
          p_relationship, p_role,
          nullif(p_contact_email,''), nullif(p_contact_phone,''),
          case when coalesce(p_anonymous,false) then null else nullif(p_contact_email,'') end,
          p_manual, p_incident_date, 'Submitted')
  returning * into v_case;

  -- parties: employees (validated against directory) or customers (free text)
  if p_parties is not null then
    for v_party in select * from jsonb_array_elements(p_parties) loop
      if v_party->>'type' = 'employee'
         and exists (select 1 from directory where employee_id = v_party->>'id') then
        insert into case_parties(case_id, subject_id, party_type, role_in_case)
        values (v_case.id, v_party->>'id', 'employee',
                coalesce(nullif(v_party->>'role_in_case',''),'subject'));
      elsif v_party->>'type' = 'customer' and coalesce(v_party->>'name','') <> '' then
        insert into case_parties(case_id, subject_id, party_type, display_name, role_in_case)
        values (v_case.id, null, 'customer', v_party->>'name',
                coalesce(nullif(v_party->>'role_in_case',''),'subject'));
      end if;
    end loop;
  end if;

  if coalesce(p_anonymous,false) then
    v_code := gen_claim_code();
    v_hash := encode(extensions.digest(v_code, 'sha256'), 'hex');
    update cases set claim_code_hash = v_hash where id = v_case.id;
  end if;

  select * into v_res from resolve_handler(v_case.id);
  update cases set handler_id = v_res.handler_id, external = v_res.is_external,
                   route_reason = v_res.reason, state = 'Triage', updated_at = now()
  where id = v_case.id;
  insert into assignments(case_id, handler_id, external, reason)
  values (v_case.id, v_res.handler_id, v_res.is_external, v_res.reason);

  if v_res.is_external then
    select coalesce(name,'External advisor') into v_handler_name from external_advisor limit 1;
  else
    select name into v_handler_name from directory where employee_id = v_res.handler_id;
  end if;

  insert into case_events(case_id, actor, type, note) values
    (v_case.id, 'system', 'created',
     initcap(p_intake_type) || ' submitted (' || (case when coalesce(p_anonymous,false) then 'anonymous' else 'named' end)
     || case when p_manual then ', manual entry' else '' end || ')'),
    (v_case.id, 'system', 'routed',
     case v_res.reason
       when 'default' then 'Auto-assigned to ' || v_handler_name || ' (default handler, no conflict)'
       when 'conflict_reroute' then 'Rerouted to ' || v_handler_name || ' — earlier handler(s) had a conflict of interest'
       else 'Escalated to ' || v_handler_name || ' — all internal handlers conflicted' end);

  if p_intake_type = 'incident' then
    insert into tasks(case_id, title, assignee_id, due_at, sla_hours, status)
    values (v_case.id, 'Triage & acknowledge', v_res.handler_id, now() + interval '24 hours', 24, 'open');
  end if;

  -- confirmation to the reporter (even if anonymous)
  perform queue_email(v_case.id, v_case.reporter_email,
    '[' || v_case.ref || '] Your report has been received',
    'Hi,' || E'\n\n' ||
    'This confirms Earthbar HR received your ' || p_intake_type || ' (reference ' || v_case.ref || ').' || E'\n' ||
    case when coalesce(p_anonymous,false)
      then 'You submitted anonymously — the HR team cannot see this email address. Use your claim code at the portal to check status or message HR.'
      else 'The assigned handler may follow up with you directly.' end || E'\n\n' ||
    'Portal: ' || coalesce(cfg('portal_url'),'') || E'\n\n' || '— Earthbar HR Case Management');

  -- alert the HR team (Lindsey unless she is involved)
  v_notify := hr_notify_email(v_case.id);
  perform queue_email(v_case.id, v_notify,
    '[' || v_case.ref || '] New ' || p_intake_type || ' submitted',
    'A new ' || p_intake_type || ' was submitted' ||
    case when p_location is not null then ' for ' || p_location else '' end || '.' || E'\n' ||
    'Category: ' || p_category || E'\n' ||
    'Reporter: ' || case when coalesce(p_anonymous,false) then 'Anonymous' else coalesce(v_case.reporter_display,'Named') end || E'\n\n' ||
    'Open the dashboard: ' || coalesce(cfg('portal_url'),''));

  return json_build_object(
    'case_id', v_case.id, 'ref', v_case.ref, 'anonymous', coalesce(p_anonymous,false),
    'claim_code', v_code, 'handler', v_handler_name,
    'external', v_res.is_external, 'route_reason', v_res.reason);
end;
$$;

-- ---- advance_state: no direct Closed; emails reporter on every change ---------
create or replace function advance_state(p_case_id uuid, p_to text) returns void
  language plpgsql security definer set search_path = public as
$$
declare v_from text; v_handler text; v_email text := app_current_email(); v_c cases%rowtype;
begin
  select * into v_c from cases where id = p_case_id;
  if not found then raise exception 'Case not found'; end if;
  v_from := v_c.state; v_handler := v_c.handler_id;
  if not can_see_case(p_case_id) then raise exception 'Not authorized'; end if;
  if not (app_is_admin() or v_handler = app_current_dir_id()) then raise exception 'Not authorized'; end if;
  if p_to = 'Closed' then raise exception 'Use close_case — closing requires recording whether the report was substantiated'; end if;

  update cases set state = p_to, updated_at = now() where id = p_case_id;
  insert into case_events(case_id, actor, type, note, from_state, to_state)
  values (p_case_id, v_email, 'state', v_from || ' → ' || p_to, v_from, p_to);

  if p_to = 'Assigned' then
    insert into tasks(case_id, title, assignee_id, due_at, sla_hours, status)
    values (p_case_id, 'Begin review / investigation', v_handler, now() + interval '72 hours', 72, 'open');
  elsif p_to = 'UnderReview' then
    update tasks set status = 'done' where case_id = p_case_id and status = 'open' and title like 'Begin%';
  elsif p_to = 'Resolved' then
    update tasks set status = 'done' where case_id = p_case_id and status = 'open';
    insert into tasks(case_id, title, assignee_id, due_at, sla_hours, status)
    values (p_case_id, '30-day retaliation check-in', v_handler, now() + interval '720 hours', 720, 'open');
  end if;

  perform queue_email(p_case_id, v_c.reporter_email,
    '[' || v_c.ref || '] Update on your report',
    'Your report ' || v_c.ref || ' status changed: ' || v_from || ' → ' || p_to || '.' || E'\n\n' ||
    'Check details: ' || coalesce(cfg('portal_url'),'') || E'\n\n' || '— Earthbar HR Case Management');
end;
$$;

-- ---- close_case: substantiated yes/no is REQUIRED ------------------------------
create or replace function close_case(p_case_id uuid, p_substantiated boolean, p_note text default null)
  returns void language plpgsql security definer set search_path = public as
$$
declare v_email text := app_current_email(); v_c cases%rowtype;
begin
  if p_substantiated is null then raise exception 'You must record whether the report was substantiated'; end if;
  select * into v_c from cases where id = p_case_id;
  if not found then raise exception 'Case not found'; end if;
  if not can_see_case(p_case_id) then raise exception 'Not authorized'; end if;
  if not (app_is_admin() or v_c.handler_id = app_current_dir_id()) then raise exception 'Not authorized'; end if;

  update cases set state = 'Closed', closed_at = now(), updated_at = now(),
                   substantiated = p_substantiated, substantiated_note = nullif(p_note,'')
  where id = p_case_id;
  update tasks set status = 'done' where case_id = p_case_id and status = 'open' and title not like '30-day%';
  insert into case_events(case_id, actor, type, note, from_state, to_state)
  values (p_case_id, v_email, 'state',
          'Closed — ' || case when p_substantiated then 'substantiated' else 'not substantiated' end ||
          coalesce('. ' || nullif(p_note,''), ''), v_c.state, 'Closed');

  perform queue_email(p_case_id, v_c.reporter_email,
    '[' || v_c.ref || '] Your report has been closed',
    'Your report ' || v_c.ref || ' has been closed.' || E'\n\n' ||
    'Check details: ' || coalesce(cfg('portal_url'),'') || E'\n\n' || '— Earthbar HR Case Management');
end;
$$;

-- ---- set_risk_level / set_policies ---------------------------------------------
create or replace function set_risk_level(p_case_id uuid, p_risk text) returns void
  language plpgsql security definer set search_path = public as
$$
begin
  if p_risk not in ('Low','Medium','High') then raise exception 'Risk must be Low, Medium or High'; end if;
  if not (can_see_case(p_case_id) and app_is_handler()) then raise exception 'Not authorized'; end if;
  update cases set risk_level = p_risk, updated_at = now() where id = p_case_id;
  insert into case_events(case_id, actor, type, note)
  values (p_case_id, app_current_email(), 'risk', 'Risk level set to ' || p_risk);
end;
$$;

create or replace function set_policies(p_case_id uuid, p_policies text) returns void
  language plpgsql security definer set search_path = public as
$$
begin
  if not (can_see_case(p_case_id) and app_is_handler()) then raise exception 'Not authorized'; end if;
  update cases set policies = nullif(p_policies,''), updated_at = now() where id = p_case_id;
  insert into case_events(case_id, actor, type, note)
  values (p_case_id, app_current_email(), 'policy', 'Realms/policies updated');
end;
$$;

-- ---- messaging: relay email without exposing the address ----------------------
create or replace function post_handler_message(p_case_id uuid, p_body text) returns void
  language plpgsql security definer set search_path = public as
$$
declare v_email text := app_current_email(); v_c cases%rowtype;
begin
  select * into v_c from cases where id = p_case_id;
  if not can_see_case(p_case_id) then raise exception 'Not authorized'; end if;
  if not (app_is_admin() or v_c.handler_id = app_current_dir_id()) then raise exception 'Not authorized'; end if;
  insert into messages(case_id, sender_type, sender_email, body) values (p_case_id, 'handler', v_email, p_body);
  update cases set updated_at = now() where id = p_case_id;
  insert into case_events(case_id, actor, type, note)
  values (p_case_id, v_email, 'notify', 'Handler sent a message to the reporter');
  perform queue_email(p_case_id, v_c.reporter_email,
    '[' || v_c.ref || '] New message from Earthbar HR',
    'HR sent you a message about report ' || v_c.ref || ':' || E'\n\n' || p_body || E'\n\n' ||
    'Reply in the portal: ' || coalesce(cfg('portal_url'),''), 'relay');
end;
$$;

create or replace function reporter_reply(p_claim_code text, p_body text) returns void
  language plpgsql security definer set search_path = public as
$$
declare v_hash text := encode(extensions.digest(p_claim_code, 'sha256'), 'hex'); v_c cases%rowtype; v_h text;
begin
  select * into v_c from cases where claim_code_hash = v_hash;
  if v_c.id is null then raise exception 'Invalid code'; end if;
  insert into messages(case_id, sender_type, body) values (v_c.id, 'reporter', p_body);
  update cases set updated_at = now() where id = v_c.id;
  insert into case_events(case_id, actor, type, note)
  values (v_c.id, 'anonymous', 'notify', 'Reporter replied via claim code');
  select d.email into v_h from directory d where d.employee_id = v_c.handler_id;
  perform queue_email(v_c.id, v_h, '[' || v_c.ref || '] Reporter replied',
    'The reporter replied on case ' || v_c.ref || '. Read it in the dashboard: ' || coalesce(cfg('portal_url'),''));
end;
$$;

-- ---- employee mention lookup ----------------------------------------------------
create or replace function mention_lookup(p_employee_id text) returns json
  language plpgsql stable security definer set search_path = public as
$$
declare v json;
begin
  if not app_is_handler() then raise exception 'Not authorized'; end if;
  select coalesce(json_agg(json_build_object(
           'ref', c.ref, 'state', c.state, 'role_in_case', p.role_in_case,
           'created_at', c.created_at) order by c.created_at desc), '[]'::json)
    into v
  from case_parties p join cases c on c.id = p.case_id
  where p.subject_id = p_employee_id and can_see_case(c.id);
  return v;
end;
$$;

-- ---- stale-case sweep: no update in 10 days → remind the HR team ---------------
create or replace function stale_case_sweep() returns void
  language plpgsql security definer set search_path = public as
$$
declare c record; v_to text;
begin
  for c in select * from cases
           where state not in ('Closed') and intake_type = 'incident'
             and updated_at < now() - interval '10 days'
             and (last_stale_reminder is null or last_stale_reminder < now() - interval '10 days') loop
    v_to := hr_notify_email(c.id);
    perform queue_email(c.id, v_to, '[' || c.ref || '] Reminder: no update in 10 days',
      'Case ' || c.ref || ' (' || c.category || ') has not been updated since ' || to_char(c.updated_at,'Mon DD') ||
      '. Please review it: ' || coalesce(cfg('portal_url'),''));
    update cases set last_stale_reminder = now() where id = c.id;
    insert into case_events(case_id, actor, type, note)
    values (c.id, 'system', 'reminder', '10-day stale reminder sent to HR');
  end loop;
end;
$$;

-- ---- grants ---------------------------------------------------------------------
grant execute on function submit_case_v2(text,text,text,boolean,text,text,text,text,text,jsonb,boolean,date) to authenticated;
grant execute on function close_case(uuid,boolean,text)   to authenticated;
grant execute on function set_risk_level(uuid,text)       to authenticated;
grant execute on function set_policies(uuid,text)         to authenticated;
grant execute on function mention_lookup(text)            to authenticated;
