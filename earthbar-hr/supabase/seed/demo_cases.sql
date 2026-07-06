-- ============================================================================
-- OPTIONAL: seed four demo cases so the dashboard isn't empty while testing.
-- Safe to skip in production. Run AFTER migrations + directory.sql.
-- Watch the NOTICES for the anonymous claim code.
-- ============================================================================
create or replace function seed_demo_case(p_category text, p_desc text, p_anon boolean, p_subject_names text[])
returns text language plpgsql as $$
declare v_id uuid; v_ref text; v_code text; nm text; sid text; res record; hn text;
begin
  insert into cases(category, description, severity, anonymous, reporter_email, state)
  values (p_category, p_desc,
          case when p_category in ('Harassment / discrimination','Workplace safety') then 'High' else 'Normal' end,
          p_anon, case when p_anon then null else 'demo.reporter@earthbar.com' end, 'Submitted')
  returning id, ref into v_id, v_ref;

  foreach nm in array p_subject_names loop
    select employee_id into sid from directory where name = nm limit 1;
    if sid is not null then insert into case_parties(case_id, subject_id) values (v_id, sid); end if;
  end loop;

  if p_anon then
    v_code := gen_claim_code();
    update cases set claim_code_hash = encode(extensions.digest(v_code,'sha256'),'hex') where id = v_id;
  end if;

  select * into res from resolve_handler(v_id);
  update cases set handler_id = res.handler_id, external = res.is_external, route_reason = res.reason, state = 'Triage' where id = v_id;
  insert into assignments(case_id, handler_id, external, reason) values (v_id, res.handler_id, res.is_external, res.reason);
  if res.is_external then select coalesce(name,'External advisor') into hn from external_advisor limit 1;
  else select name into hn from directory where employee_id = res.handler_id; end if;

  insert into case_events(case_id, actor, type, note) values (v_id,'system','created','Case submitted ('||(case when p_anon then 'anonymous' else 'named' end)||')');
  insert into case_events(case_id, actor, type, note) values (v_id,'system','routed','Assigned to '||hn||' ('||res.reason||')');
  insert into tasks(case_id, title, assignee_id, due_at, sla_hours) values (v_id,'Triage & acknowledge',res.handler_id, now()+interval '24 hours',24);

  raise notice 'Seeded % -> % (%)  claim code: %', v_ref, hn, res.reason, coalesce(v_code,'(named)');
  return v_ref;
end; $$;

select seed_demo_case('Manager conduct',              'My shift lead assigns overtime unfairly and singles me out.', false, array['Alfred Gonzalez']);
select seed_demo_case('Harassment / discrimination',  'Repeated inappropriate comments from someone in the People team.', false, array['Lindsey Freitag']);
select seed_demo_case('Manager conduct',              'Concerns about how a senior People leader handles complaints.', false, array['Vicky Chung']);
select seed_demo_case('Workplace safety',             'A walk-in freezer latch is broken; reported twice, ignored.', true, array['Ernie Zavaleta']);

drop function seed_demo_case(text, text, boolean, text[]);
