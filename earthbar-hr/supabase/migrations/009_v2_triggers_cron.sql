-- ============================================================================
-- 009 triggers + schedules
-- APPLIED to production 2026-07-14 (migration: v2_triggers_and_cron)
--  * new outbox row  -> ping send-email (fire-and-forget via pg_net)
--  * new incident    -> ping ai-triage with the case id
--  * every 10 min    -> retry sweep of the outbox
--  * daily 16:00 UTC (9am PT) -> stale_case_sweep + run_sla_sweep, then drain
-- pg_net gotcha (learned on the store-visit app): body must be jsonb, not text.
-- ============================================================================

create or replace function fn_notify_send_email() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  perform net.http_post(
    url := 'https://kocslkcomltzfzlttvhx.supabase.co/functions/v1/send-email',
    body := '{}'::jsonb);
  return null;
end;
$$;
drop trigger if exists trg_outbox_send on notifications_outbox;
create trigger trg_outbox_send
  after insert on notifications_outbox
  for each statement execute function fn_notify_send_email();

create or replace function fn_notify_ai_triage() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if new.intake_type = 'incident' then
    perform net.http_post(
      url := 'https://kocslkcomltzfzlttvhx.supabase.co/functions/v1/ai-triage',
      body := jsonb_build_object('case_id', new.id));
  end if;
  return null;
end;
$$;
drop trigger if exists trg_case_ai_triage on cases;
create trigger trg_case_ai_triage
  after insert on cases
  for each row execute function fn_notify_ai_triage();

-- schedules (idempotent: unschedule if they already exist)
do $$
begin
  perform cron.unschedule('outbox-retry');
exception when others then null;
end $$;
select cron.schedule('outbox-retry', '*/10 * * * *',
  $$select net.http_post(url := 'https://kocslkcomltzfzlttvhx.supabase.co/functions/v1/send-email', body := '{}'::jsonb)$$);

do $$
begin
  perform cron.unschedule('daily-sweeps');
exception when others then null;
end $$;
select cron.schedule('daily-sweeps', '0 16 * * *',
  $$select stale_case_sweep(); select run_sla_sweep(); select net.http_post(url := 'https://kocslkcomltzfzlttvhx.supabase.co/functions/v1/send-email', body := '{}'::jsonb)$$);
