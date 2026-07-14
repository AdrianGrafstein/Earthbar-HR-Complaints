# HR App v2 — Update Spec (from 2026-07-13 meeting)

> Meeting: Adrian, Eitan, Ernie, Steve, Lindsey, Vicky.
> Status: **agreed with Adrian 2026-07-14 — NOT yet built.** Review with Eitan before build.

## Decisions made (Adrian, 2026-07-14)

1. **Auth:** anyone with a valid email can sign in (email one-time code / magic link) —
   no @earthbar.com requirement. Relationship to company is **chosen by the person, never
   inferred from email**. HR dashboard visible only to: **Lindsey, Vicky, Ernie (HR team) +
   Flora + Adrian + Eitan**.
2. **Routing:** replace the title-based matrix with the **fixed HR team**. Lindsey =
   default handler and is always emailed on new cases (unless she is involved).
   Conflict-of-interest reroutes within the team; external advisor remains the fallback.
3. **Anonymity:** keep the claim code as the anonymous portal login **and** store the
   reporter's email/phone on every case (required even when anonymous). The contact info
   is used for confirmations/updates/relay and must be **technically invisible to the HR
   dashboard** (server-side only — never selectable by any client).

## Intake flow (reporter side)

After sign-in, fork: **"Question / request"** vs **"Report an incident"**.

Incident form, in order:
1. Location (store)
2. Anonymous option
3. Relationship to company (chosen, any email allowed)
4. If employee → current role at Earthbar
5. Incident category — **harassment/discrimination is NOT an option**; HR classifies
   internally after review. (Final category list: OPEN — confirm with team.)
6. Who was involved — customer or employee, each tagged **victim** or **subject**
   (schema change: `case_parties` currently only accepts directory employees)
7. Optional evidence upload — "If you have any relevant documents for this case,
   please submit (not required)"
8. Email + phone — **required even if anonymous** (hidden from HR if anonymous)
9. Submit → email confirmation of the case report

## Case lifecycle (HR side)

- **Risk triage: Low / Medium / High** (replaces Normal/High; AI-suggested, HR-editable)
- Track relevant **realms & policies** in question per case (format OPEN: free text vs
  picklist from handbook)
- **Closing requires substantiated yes/no** (was there evidence?) — blocks close until answered
- Evidence attachable by **both** reporter and HR at any time
- **Manual case entry** for reports that reach Lindsey by email first
- **Employee mention lookup:** how many times an employee appears across cases + role each time
- Keep existing: state machine, audit timeline, SLA tasks, conflict-of-interest
  visibility (a case about an HR member is invisible to them — already enforced in RLS)

## Email & messaging (all net-new)

| Trigger | Recipient | From |
|---|---|---|
| Case submitted | Reporter (confirmation) | HRCaseManagement@earthbar.com |
| Case submitted | Lindsey (unless involved) | HRCaseManagement@ |
| Any case update | Reporter (even anonymous) | HRCaseManagement@ |
| No update in 10 days | Lindsey reminder | HRCaseManagement@ |
| HR portal message → anonymous reporter | Reporter's hidden email | HR@earthbar.com relay (Graph API) |

Reporter replies stay in the portal (claim code); HR never sees the email address.

## AI triage

- Claude API from an edge function, on case submission
- Strips names before processing; has the employee handbook as context
- Suggests Low/Med/High risk + relevant policies; HR can override
- **Need: employee handbook file from Eitan/Lindsey** (not yet in hand)

## Dashboard

Filter + search by risk level, date, category, case status, etc.
Access: Lindsey, Vicky, Ernie, Flora, Adrian, Eitan only.

## Cloud infrastructure plan (the new server-side layer)

Current app = static GitHub Pages + Supabase Postgres/RLS. Nothing can act on its own.
Add three pieces:

1. **Supabase Edge Functions** (secrets live here, never in the browser):
   - `send-email` — Graph API client-credentials → HRCaseManagement@ (confirmations,
     updates, Lindsey alerts). Same Azure app-registration pattern as the store-visit
     flag-alert function (Mail.Send application permission + Eitan's admin consent).
   - `relay-message` — HR posts in portal → function looks up hidden reporter email
     with the service-role key → sends via HR@earthbar.com.
   - `ai-triage` — strips names, calls Claude API with handbook context, writes risk
     level + suggested policies.
   - DB triggers via `pg_net` fire these (gotcha from last time: body must cast `::jsonb`).
2. **pg_cron** — daily job: cases with no update in 10 days → reminder email to Lindsey.
   (Extend existing `run_sla_sweep()` pattern.)
3. **Supabase Storage** — evidence bucket. Policies: reporter can upload to own case;
   only non-conflicted handlers can view; no public access.

Secrets (Azure client secret, Claude API key, service-role key) → Supabase function
secrets only.

## Later down the line (explicitly deferred in meeting)

- Full enforcement: HR employee involved in a case can never see it anywhere
  (core visibility block already exists; audit every new surface for leaks)

## Open questions

- [ ] Final incident category list (harassment/discrimination removed as an option)
- [ ] "Realms & policies": free text or handbook-derived picklist?
- [ ] Get employee handbook file (Eitan/Lindsey)
- [ ] Who is Flora (full name/email for directory + access list)?
- [ ] HRCaseManagement@earthbar.com and HR@earthbar.com mailboxes exist? (Eitan/IT)
- [ ] Does the substantiated yes/no need a comment field with it?
- [ ] Phone number: SMS updates too, or email only? (assume email only for now)

## Suggested build order

1. Schema + intake form changes (fields, categories, parties, anonymity model)
2. Auth switch to email OTP + dashboard access list
3. Storage + evidence uploads
4. Edge function: email (Graph) — confirmations, Lindsey alert, update notices
5. Anonymous relay via HR@
6. pg_cron 10-day reminder
7. AI triage (needs handbook)
8. Dashboard filters/search + mention lookup + close-requires-substantiated
