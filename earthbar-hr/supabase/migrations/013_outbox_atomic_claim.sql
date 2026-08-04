-- ============================================================================
-- 016 (repo file 013) — fix duplicate email sends
-- APPLIED to production 2026-08-05 (migration: v3_outbox_atomic_claim)
--
-- BUG: every outbox insert pings send-email, and each invocation drained ALL
-- pending rows with no locking. Rapid activity (submit → state changes → close)
-- fired overlapping invocations that each saw the same rows still 'pending'
-- and re-sent them → reporters received the same email up to 4x.
--
-- FIX: workers claim rows atomically (pending -> 'sending' via UPDATE ...
-- FOR UPDATE SKIP LOCKED) before sending; a claimed row is invisible to every
-- other invocation. Stale 'sending' rows (worker died mid-send) are rescued
-- back to 'pending' by the 10-minute cron. send-email v10 uses this.
-- ============================================================================

alter table notifications_outbox drop constraint if exists notifications_outbox_status_check;
alter table notifications_outbox add constraint notifications_outbox_status_check
  check (status in ('pending','sending','sent','error','skipped'));
alter table notifications_outbox add column if not exists claimed_at timestamptz;

create or replace function claim_pending_emails(p_limit int default 20)
  returns setof notifications_outbox
  language sql security definer set search_path = public as
$$
  update notifications_outbox o
     set status = 'sending', claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from notifications_outbox
      where status = 'pending' and attempts < 5
      order by created_at
      limit p_limit
      for update skip locked)
  returning o.*;
$$;
revoke execute on function claim_pending_emails(int) from public, anon, authenticated;
grant execute on function claim_pending_emails(int) to service_role;

create or replace function rescue_stuck_emails() returns void
  language sql security definer set search_path = public as
$$
  update notifications_outbox
     set status = 'pending'
   where status = 'sending' and claimed_at < now() - interval '10 minutes';
$$;
revoke execute on function rescue_stuck_emails() from public, anon, authenticated;

do $$ begin perform cron.unschedule('outbox-retry'); exception when others then null; end $$;
select cron.schedule('outbox-retry', '*/10 * * * *',
  $$select rescue_stuck_emails(); select net.http_post(url := 'https://kocslkcomltzfzlttvhx.supabase.co/functions/v1/send-email', body := '{}'::jsonb)$$);

-- VERIFIED: 1 queued email + 3 simultaneous pings -> attempts = 1, one delivery.
