# Earthbar HR Case Management

A real, private HR case-management system: employees submit reports (named **or** anonymous),
cases route automatically **away from anyone they're about**, move through a tracked lifecycle,
and generate follow-up tasks with SLAs — all enforced in the database.

- **Auth:** Microsoft 365 (Azure) SSO via Supabase — only verified `@earthbar.com` accounts get in.
- **Data + security:** Supabase Postgres with Row-Level Security. A case you're not allowed to
  see is *never sent to your browser*.
- **Frontend:** a static site (`web/`) hosted on GitHub Pages.
- **Routing / state / SLA logic:** Postgres functions, so it's authoritative and can't be bypassed.

---

## Architecture at a glance

```
Employee ─▶ GitHub Pages site (web/) ─▶ Supabase Auth (Microsoft SSO)
                                     └▶ Supabase Postgres
                                          • RLS decides what each person can read
                                          • submit_case()  → routes + creates tasks
                                          • advance_state() → state machine + SLAs
                                          • check_status()  → anonymous claim-code lookup
```

There is **no custom server to run** — Supabase is the backend, GitHub Pages serves the frontend.

---

## Repo layout

```
supabase/
  migrations/
    001_schema.sql      tables, indexes, sequence
    002_functions.sql   routing engine, conflict detection, state machine, RPCs
    003_policies.sql    Row-Level Security (server-side visibility)
    004_config.sql      escalation matrix (by title) + external advisor
  seed/
    directory.sql       511 employees imported from the Store Directory
    demo_cases.sql      OPTIONAL: 4 sample cases so the dashboard isn't empty
web/
  index.html            UI shell + styles
  app.js                the app (Supabase + Microsoft SSO)
  config.js             SUPABASE_URL + anon key (anon key is public/safe)
.github/workflows/
  deploy-pages.yml      auto-deploys web/ to GitHub Pages on push to main
```

---

## Setup

### 1. Create the Supabase project
1. Create a new project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run the files **in order**:
   `001_schema.sql` → `002_functions.sql` → `003_policies.sql` → `004_config.sql`
   → `seed/directory.sql` → *(optional)* `seed/demo_cases.sql`.
   (Or use the Supabase CLI: `supabase db push`.)

### 2. Turn on Microsoft (Azure) sign-in
This is what makes the email **verified**.

1. In the **Azure Portal** → *App registrations* → **New registration**.
   - Supported account types: *Accounts in this organizational directory only* (Earthbar tenant) — this restricts sign-in to `@earthbar.com`.
   - Redirect URI (Web): `https://<your-project-ref>.supabase.co/auth/v1/callback`
2. Create a **client secret** (Certificates & secrets).
3. In **Supabase** → *Authentication → Providers → Azure*: paste the **Application (client) ID**, **secret**, and set the **Azure tenant URL** to your tenant (`https://login.microsoftonline.com/<TENANT_ID>`).
4. In **Supabase** → *Authentication → URL Configuration*: add your GitHub Pages URL (below) to **Site URL / Redirect URLs**.

> Restricting the Azure app to the Earthbar tenant means only real Earthbar Microsoft accounts can authenticate — no separate allow-list to maintain.

### 3. Configure & deploy the frontend
1. Edit `web/config.js` with your project's **URL** and **anon (public) key** (Supabase → *Settings → API*). The anon key is safe to commit; RLS is what protects the data.
2. Push this repo to GitHub, then in **Settings → Pages** set **Source = GitHub Actions**.
3. On push to `main`, the included workflow publishes `web/` and prints the site URL.
4. Add that Pages URL to the Azure **Redirect URIs** and to Supabase **Redirect URLs**.

### 4. Designate the external advisor
Edit `004_config.sql` (or the `external_advisor` row) to replace the placeholder with your real
outside counsel / board contact / ethics-hotline. This is the fallback handler for cases where
every internal HR person is conflicted (e.g. a complaint about the VP of People).

---

## How the rules work

**Escalation matrix is by _title_, not person** (`handler_roles`): whoever currently holds the
title is the handler at that rank, so routing follows org changes automatically.

| Rank | Title | Admin? |
|-----:|-------|:------:|
| 1 | HR Generalist | no |
| 2 | HR Coordinator | no |
| 3 | Director of HR | yes |
| 4 | VP of People and Culture | yes |
| — | External advisor (fallback) | — |

**Conflict of interest:** a handler is skipped for a case if they **are named** in it, or they
**report up to** someone named in it (walked via the directory's manager chain). The first
non-conflicted handler in the matrix gets it; if all are conflicted, it goes to the external advisor.

**Visibility (RLS):** the same conflict check governs *who can read a case*. A handler — even an
admin — can never see (or open) a case they're the subject of, or one about someone above them.
Anonymous reports store no identity; a hashed claim code enables two-way messaging without ever
revealing the reporter.

**State machine:** `Submitted → Triage → Assigned → Under Review → Action → Resolved → Closed`
(plus `On Hold`, `Escalated`, `Reopened`). Each transition is logged and can spawn SLA tasks.

**Follow-ups / SLAs:** entering a state creates tasks with due dates. `run_sla_sweep()` flags
overdue tasks and escalations — schedule it with Supabase **pg_cron** (e.g. hourly) when you're ready.

---

## Access model

| Role (derived from directory title) | Submit | Check status | HR dashboard |
|---|:---:|:---:|:---:|
| Any verified `@earthbar.com` employee | ✅ | ✅ (own) | — |
| Handler (HR Generalist / Coordinator) | ✅ | ✅ | ✅ own assigned cases |
| Admin (Director of HR / VP People) | ✅ | ✅ | ✅ all, minus self-involved |

An employee who signs in but isn't in the directory can still submit and check status; they just
have no handler access.

---

## Notifications

Notifications and SLA reminders are currently **logged to each case's timeline** (per your choice).
To send real email later, call an email service (SendGrid/Resend) from a scheduled Supabase Edge
Function that runs `run_sla_sweep()` and emails assignees — no schema change needed.

---

## Updating the directory

Re-import by regenerating `seed/directory.sql` from the latest Store Directory export and re-running
it (it `truncate … cascade`s and reloads). Titles drive handler assignment, so keeping titles
correct keeps routing correct.

---

## Security notes

- All writes go through `SECURITY DEFINER` functions; there are **no** insert/update/delete RLS
  policies, so the tables can't be written directly by clients.
- The claim code is never stored — only its SHA-256 hash.
- The audit log (`case_events`) records routing, state changes, messages, reminders, and escalations.
- Before go-live: review who has the Supabase **service_role** key (it bypasses RLS) and keep it
  server-side only — never in the frontend.
