// ai-triage — light AI review of a newly submitted incident.
// DEPLOYED 2026-07-14 (verify_jwt=false; idempotent — only acts on cases whose
// risk_level is still null). Strips employee names, reads the handbook (storage
// bucket 'handbook'), asks Claude for a Low/Medium/High risk level + relevant
// policies, and writes the suggestion where HR hasn't already set values.
// Called by a pg_net trigger on case insert.
// Secrets: ANTHROPIC_API_KEY (required to act), ANTHROPIC_MODEL (optional).
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  let case_id: string | undefined;
  try { ({ case_id } = await req.json()); } catch { /* no body */ }
  if (!case_id) return json({ error: "case_id required" }, 400);

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: c } = await supa.from("cases")
    .select("id,ref,category,description,location,incident_date,intake_type,risk_level")
    .eq("id", case_id).maybeSingle();
  if (!c) return json({ error: "case not found" }, 404);
  if (c.intake_type !== "incident" || c.risk_level) return json({ skipped: true });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    await supa.from("case_events").insert({ case_id, actor: "system", type: "ai", note: "AI triage skipped — no API key configured yet" });
    return json({ skipped: true, note: "no ANTHROPIC_API_KEY" });
  }

  // strip names: replace every directory name with a neutral token
  const { data: dir } = await supa.from("directory").select("name");
  let text = `Category: ${c.category}\nLocation: ${c.location ?? "unknown"}\nDate: ${c.incident_date ?? "unknown"}\nDescription: ${c.description}`;
  for (const d of dir ?? []) {
    if (!d.name || d.name.length < 4) continue;
    text = text.replaceAll(new RegExp(d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[employee]");
  }

  // handbook context (first file in the private 'handbook' bucket, if any)
  let handbook = "";
  const { data: files } = await supa.storage.from("handbook").list();
  if (files?.length) {
    const { data: blob } = await supa.storage.from("handbook").download(files[0].name);
    if (blob) handbook = (await blob.text()).slice(0, 150000);
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5",
      max_tokens: 500,
      system:
        "You are an HR case triage assistant for Earthbar. You receive an anonymized incident report" +
        (handbook ? " and the employee handbook" : "") +
        ". Respond with ONLY a JSON object: {\"risk\":\"Low\"|\"Medium\"|\"High\",\"policies\":\"short list of the handbook realms/policies plausibly implicated\",\"summary\":\"2-3 sentence neutral summary and why this risk level\"}. Risk guidance: High = safety, violence, potential harassment/discrimination, legal exposure, minors; Medium = conduct/pay/policy disputes needing timely review; Low = routine questions or minor issues.",
      messages: [{ role: "user", content: (handbook ? `EMPLOYEE HANDBOOK:\n${handbook}\n\n---\n\n` : "") + `INCIDENT REPORT:\n${text}` }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    await supa.from("case_events").insert({ case_id, actor: "system", type: "ai", note: `AI triage failed: ${resp.status} ${t.slice(0, 200)}` });
    return json({ error: `anthropic ${resp.status}` }, 500);
  }
  const out = await resp.json();
  let parsed: { risk?: string; policies?: string; summary?: string } = {};
  try {
    const raw = (out.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim();
    parsed = JSON.parse(raw);
  } catch { /* leave empty */ }
  const risk = ["Low", "Medium", "High"].includes(parsed.risk ?? "") ? parsed.risk : null;

  const upd: Record<string, unknown> = {};
  if (risk) upd.risk_level = risk;
  if (parsed.summary) upd.ai_summary = parsed.summary.slice(0, 2000);
  const { data: fresh } = await supa.from("cases").select("risk_level,policies").eq("id", case_id).maybeSingle();
  if (fresh?.risk_level) delete upd.risk_level;               // HR got there first
  if (!fresh?.policies && parsed.policies) upd.policies = parsed.policies.slice(0, 1000);
  if (Object.keys(upd).length) await supa.from("cases").update(upd).eq("id", case_id);

  await supa.from("case_events").insert({
    case_id, actor: "system", type: "ai",
    note: risk ? `AI triage suggested risk: ${risk}${handbook ? " (handbook consulted)" : " (no handbook uploaded yet)"}` : "AI triage ran but returned no usable risk level",
  });
  return json({ ok: true, risk });
});
