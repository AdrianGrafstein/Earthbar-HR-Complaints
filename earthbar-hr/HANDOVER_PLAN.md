# Ownership Transfer & Custom Domain — Runbook

*Goal: move the HR app from Adrian's personal accounts to company-owned accounts and
put it on the company domain. No rebuild, no downtime beyond ~minutes. Do the whole
thing in one sitting (~1 hour) because three registered URLs must be updated together.*

## Who does what

| Step | Who | What |
|---|---|---|
| 0 | Eitan/IT | Decide the exact hostname (e.g. `hr.earthbar.com`) and identify who manages Earthbar's DNS |
| 1 | Eitan | Create a free **GitHub organization** (e.g. `earthbar-inc`) with a company email as owner |
| 2 | Adrian | GitHub repo → Settings → Danger Zone → **Transfer ownership** → the new org. Re-check Pages is still enabled (Settings → Pages → Source: GitHub Actions) |
| 3 | Eitan/IT | Add DNS record for the chosen hostname: **CNAME → `<org>.github.io`** |
| 4 | Adrian | Repo (now in org) → Settings → Pages → Custom domain → enter hostname → wait for DNS check → tick **Enforce HTTPS** |
| 5 | Adrian + Claude | Update the three registered URLs (see below) |
| 6 | Eitan | Create a **Supabase account with a company email** → create org "Earthbar" |
| 7 | Adrian | Supabase project → Settings → General → **Transfer project** to Eitan's org. Eitan re-invites Adrian as **Developer** |
| 8 | Eitan | Org billing → company card → upgrade project to **Pro ($25/mo)** (daily backups; free tier pauses when idle — unacceptable for an always-on HR app) |
| 9 | Eitan (org owner) | Make the repo **Private** (Settings → Danger Zone → Change visibility) |
| 10 | Adrian + Claude | End-to-end test (below), then update LEARNINGS.md |

## Step 5 — the three URLs that break when the address changes

All currently point at `https://adriangrafstein.github.io/Earthbar-HR-Complaints/`.
After the transfer + custom domain they must ALL become `https://<new-hostname>/`:

1. **Supabase Auth** → Authentication → URL Configuration → Site URL + Redirect URLs
   (`https://<new-hostname>/**`). *If missed: sign-in links bounce users to the old URL.*
2. **Azure app registration** (Earthbar tenant, Eitan) → Authentication → Redirect URIs.
   The Supabase callback (`https://kocslkcomltzfzlttvhx.supabase.co/auth/v1/callback`)
   does NOT change — only add/keep the new site if it's listed. *Microsoft SSO breaks
   if the callback entry is removed.*
3. **`app_config.portal_url`** in the database (one SQL update — Claude does this).
   *If missed: emails link to the old URL.*

Note: GitHub redirects the old `adriangrafstein.github.io/...` Pages URL for a while
after transfer, so a missed update degrades gracefully — but fix all three anyway.

## Step 10 — end-to-end test checklist

- [ ] New hostname loads over HTTPS
- [ ] Email-link sign-in round-trips (link lands on the NEW domain, signed in)
- [ ] Microsoft SSO works for an @earthbar.com account
- [ ] Submit a test incident → confirmation email arrives, links point to new domain
- [ ] AI triage event appears on the test case; Lindsey-alert email sends
- [ ] HR dashboard loads for an authorized user; test case visible; delete test case
- [ ] Repo is private; Supabase project shows under the Earthbar org; Pro plan active

## After this runbook

Every component is company-owned: GitHub org (repo + hosting), Supabase org (data,
auth, functions, secrets), Azure tenant (mail app registration — always was), and the
Anthropic key (from Eitan's account). Adrian remains a collaborator/developer on all
of them. Remaining separate to-dos: employee handbook upload, final category list,
custom SMTP before company-wide announcement, real external advisor designation,
data-retention policy from HR.
