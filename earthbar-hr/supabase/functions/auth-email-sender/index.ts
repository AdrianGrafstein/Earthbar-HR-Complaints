// auth-email-sender — Supabase Auth "Send Email" hook.
// DEPLOYED 2026-08-05. Supabase generates the 6-digit OTP and calls this hook;
// WE send the email through Microsoft Graph (hrcomplaints@earthbar.com), so:
//   1. the email contains the CODE (the default template was link-only and
//      uneditable on the free/current plan), and
//   2. sign-in emails no longer depend on Supabase's rate-limited built-in mailer.
// Security: requests are signature-verified (standard-webhooks) with
// SEND_EMAIL_HOOK_SECRET — without a valid signature the request is rejected,
// so the endpoint can't be abused to send arbitrary mail.
// Dashboard wiring: Auth > Hooks > Send Email hook -> this function's URL, with
// the SAME secret set as the SEND_EMAIL_HOOK_SECRET function secret.
import { Webhook } from "npm:standardwebhooks@1.0.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const rawSecret = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
  if (!rawSecret) return json({ error: "SEND_EMAIL_HOOK_SECRET not configured" }, 500);

  const payload = await req.text();
  let evt: any;
  try {
    const wh = new Webhook(rawSecret.replace("v1,whsec_", "").replace("whsec_", ""));
    evt = wh.verify(payload, {
      "webhook-id": req.headers.get("webhook-id") ?? "",
      "webhook-timestamp": req.headers.get("webhook-timestamp") ?? "",
      "webhook-signature": req.headers.get("webhook-signature") ?? "",
    });
  } catch {
    return json({ error: "invalid signature" }, 401);
  }

  const to = evt?.user?.email;
  const token = evt?.email_data?.token;             // the 6-digit OTP
  const action = evt?.email_data?.email_action_type; // magiclink | signup | recovery | ...
  if (!to || !token) return json({ error: "missing user/token" }, 400);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: cfgRows } = await supa.from("app_config").select("key,value").eq("key", "mail_from_cases");
  const from = cfgRows?.[0]?.value;
  const tenant = Deno.env.get("AZURE_TENANT_ID");
  const clientId = Deno.env.get("AZURE_CLIENT_ID");
  const clientSecret = Deno.env.get("AZURE_CLIENT_SECRET");
  if (!from || !tenant || !clientId || !clientSecret) return json({ error: "mail not configured" }, 500);

  const tokResp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default",
    }),
  });
  const tok = await tokResp.json();
  if (!tok.access_token) return json({ error: "graph token failed" }, 500);

  const subject = action === "recovery"
    ? "Earthbar HR — your account recovery code"
    : "Your Earthbar HR sign-in code";
  const body =
    `Your one-time sign-in code is:\n\n    ${token}\n\n` +
    `Enter it on the Earthbar HR sign-in screen to continue. The code expires shortly ` +
    `and can only be used once.\n\n` +
    `If you didn't request this, you can safely ignore this email.\n\n` +
    `— Earthbar HR Case Management`;

  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
  if (resp.status !== 202) {
    const t = await resp.text();
    return json({ error: `graph send failed: ${resp.status} ${t.slice(0, 300)}` }, 500);
  }
  return json({});
});
