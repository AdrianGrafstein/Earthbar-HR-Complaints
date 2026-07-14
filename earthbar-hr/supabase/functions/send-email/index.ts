// send-email — drains notifications_outbox via Microsoft Graph.
// DEPLOYED 2026-07-14 v9 (verify_jwt=false). Called by pg_net triggers + a
// pg_cron sweep; safe because it takes no payload and only sends already-queued mail.
// Secrets required: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET.
// Sender addresses come from app_config keys mail_from_cases / mail_from_relay
// (change with SQL, no redeploy needed). Currently both = hrcomplaints@earthbar.com.
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (_req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: rows, error } = await supa
    .from("notifications_outbox")
    .select("*")
    .eq("status", "pending")
    .lt("attempts", 5)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) return json({ error: error.message }, 500);
  if (!rows?.length) return json({ sent: 0, note: "queue empty" });

  const tenant = Deno.env.get("AZURE_TENANT_ID");
  const clientId = Deno.env.get("AZURE_CLIENT_ID");
  const clientSecret = Deno.env.get("AZURE_CLIENT_SECRET");
  if (!tenant || !clientId || !clientSecret) {
    return json({ sent: 0, pending: rows.length, note: "Azure secrets not configured — emails stay queued" });
  }

  const { data: cfgRows } = await supa.from("app_config").select("key,value")
    .in("key", ["mail_from_cases", "mail_from_relay"]);
  const cfg = Object.fromEntries((cfgRows ?? []).map((r) => [r.key, r.value]));
  const fromCases = cfg.mail_from_cases;
  const fromRelay = cfg.mail_from_relay ?? fromCases;
  if (!fromCases) return json({ sent: 0, pending: rows.length, note: "mail_from_cases not set in app_config" });

  const tokResp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const tok = await tokResp.json();
  if (!tok.access_token) return json({ error: "graph token failed", detail: tok.error_description ?? tok.error }, 500);

  let sent = 0;
  for (const r of rows) {
    const from = r.template === "relay" ? fromRelay : fromCases;
    try {
      const resp = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject: r.subject,
              body: { contentType: "Text", content: r.body },
              toRecipients: [{ emailAddress: { address: r.to_email } }],
            },
            saveToSentItems: false,
          }),
        },
      );
      if (resp.status === 202) {
        await supa.from("notifications_outbox")
          .update({ status: "sent", sent_at: new Date().toISOString(), attempts: r.attempts + 1 })
          .eq("id", r.id);
        sent++;
      } else {
        const t = await resp.text();
        await supa.from("notifications_outbox")
          .update({
            status: r.attempts + 1 >= 5 ? "error" : "pending",
            attempts: r.attempts + 1,
            last_error: `from=${from} ${resp.status}: ${t.slice(0, 450)}`,
          })
          .eq("id", r.id);
      }
    } catch (e) {
      await supa.from("notifications_outbox")
        .update({ status: r.attempts + 1 >= 5 ? "error" : "pending", attempts: r.attempts + 1, last_error: String(e).slice(0, 500) })
        .eq("id", r.id);
    }
  }
  return json({ sent, of: rows.length });
});
