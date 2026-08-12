# Handover — do this together, on Adrian's last day (~30 min)

**Read this first, Eitan.** The HR app is finished and running, but every account it
runs on is currently Adrian's personal account. This checklist moves ownership to
Earthbar. It has to be done **while Adrian still has access** — after his internship
ends, nobody at the company can transfer, fix, restore, or shut down the app.

Sit down together, screen-shared, and work straight down this list. Nothing here is
hard; the only reason it takes 30 minutes is that accounts have to be created before
they can be transferred into.

**Time:** ~30 min · **Downtime:** none · **Cost after:** $25/month (Supabase Pro)

---

## What you're taking ownership of

| Piece | What it is | Where it lives now | Where it should end up |
|---|---|---|---|
| **Repo + website** | The app itself; GitHub also hosts the live page | Adrian's personal GitHub | An Earthbar GitHub organization |
| **Supabase project** | Database, logins, files, the email/AI functions, all secrets | Adrian's personal Supabase | An Earthbar Supabase organization, on the Pro plan |
| **Azure mail app** | Sends mail as hrcomplaints@earthbar.com | Already Earthbar's tenant ✅ | No action |
| **Anthropic key** | AI risk triage | Eitan's account ✅ | Needs credits topped up (see bottom) |

Live app: `https://adriangrafstein.github.io/Earthbar-HR-Complaints/`
Repo: `https://github.com/AdrianGrafstein/Earthbar-HR-Complaints`
Supabase project: `Earthbar-HR-Complaints` (ref `kocslkcomltzfzlttvhx`)

---

## Step 1 — Eitan creates the two accounts (5 min, Eitan drives)

Both are free and both must use an **@earthbar.com** email, not a personal one. The
whole point is that these outlive any one person.

**GitHub organization**

1. Go to `https://github.com` — sign in, or sign up with your @earthbar.com email.
2. Top-right avatar → **Your organizations** → **New organization**.
3. Choose the **Free** plan.
4. Name it something like `earthbar-inc` (the exact name doesn't matter; write down
   what you picked — Step 3 needs it).
5. Skip the "invite members" screen.

**Supabase account + organization**

1. Go to `https://supabase.com` → **Sign in** → sign up with your @earthbar.com email.
2. It will create an organization automatically, or prompt you — name it `Earthbar`.
3. Stop there. Do **not** create a new project — you're receiving Adrian's existing one.

> ✅ Done when: Eitan can see an empty GitHub org and an empty Supabase org.

---

## Step 2 — Adrian transfers the repo (2 min, Adrian drives)

1. Open `https://github.com/AdrianGrafstein/Earthbar-HR-Complaints`.
2. **Settings** → scroll to the bottom, **Danger Zone** → **Transfer ownership**.
3. Type the org name from Step 1 as the new owner, confirm by typing the repo name.
4. GitHub may ask Eitan to accept — check his email and accept.
5. Once transferred: repo **Settings → Pages** → confirm the source is still on and
   note the **new URL** it shows (it becomes `https://<org>.github.io/Earthbar-HR-Complaints/`).
   **Write that URL down — Step 4 needs it.**

> ⚠️ The app's web address changes here. GitHub forwards the old address for a while,
> so nothing breaks immediately, but Step 4 must still be done.

---

## Step 3 — Adrian transfers the Supabase project (3 min, Adrian drives)

1. Open `https://supabase.com/dashboard` → select project **Earthbar-HR-Complaints**.
2. **Project Settings** → **General** → **Transfer project**.
3. Pick Eitan's `Earthbar` organization. (If it isn't listed, Eitan has to invite
   Adrian to that org first: Supabase org → **Team** → **Invite** → Adrian's email →
   role **Developer**. Then retry.)
4. Confirm.
5. Eitan then re-invites Adrian as **Developer** if he isn't already, so Adrian can
   help with Step 4.

Everything moves with the project — data, logins, uploaded files, the email and AI
functions, and all the secrets. Nothing needs to be re-entered.

---

## Step 4 — Point everything at the new web address (5 min, together)

Three places store the app's address. Two of them matter; skip them and sign-in
emails will send people to a dead link.

**4a. Supabase Auth** — Supabase dashboard → **Authentication** → **URL Configuration**

- **Site URL** → the new URL from Step 2
- **Redirect URLs** → add `https://<org>.github.io/Earthbar-HR-Complaints/**`
  (keep the old entry too until you're sure everyone has the new link)

**4b. The address inside emails** — Supabase dashboard → **SQL Editor** → run:

```sql
update app_config
   set value = 'https://<NEW-URL-FROM-STEP-2>/'
 where key = 'portal_url';
```

(Currently `https://adriangrafstein.github.io/Earthbar-HR-Complaints/`. Keep the
trailing slash.)

**4c. Azure** — no action needed. The Microsoft mail app points at Supabase, and that
address doesn't change.

---

## Step 5 — Upgrade Supabase to Pro (3 min, Eitan drives)

**Do not skip this one.** On the free plan, Supabase **pauses the database when it
sits idle** — for an HR reporting line that's used a few times a month, that's not a
theoretical risk, it's the normal case. A paused database means an employee trying to
report something gets an error page. Pro also turns on daily backups, which is the
difference between "a case got deleted by mistake" being an inconvenience and being
permanent.

1. Supabase → the `Earthbar` org → **Billing** → add the company card.
2. Upgrade the **Earthbar-HR-Complaints** project to **Pro** ($25/month).

> ✅ Done when: the project header shows **Pro**, not Free.

---

## Step 6 — Remove the two temporary admin accounts (2 min, together)

Adrian and Eitan both have full HR-dashboard access so they could build and test the
app. Per the July 15 decision, production access is **Lindsey, Vicky, Ernie, and Flora
only** — nobody else should be able to read employee complaints.

Supabase dashboard → **SQL Editor** → run:

```sql
delete from access_overrides
 where email in ('adrian.g@earthbar.com', 'eitan@earthbar.com');

-- confirm: should return zero rows
select email from access_overrides;
```

Then check it worked: open the app, sign in as one of those two, and confirm the **HR
Dashboard** and **Employee Lookup** tabs are gone.

> If Eitan ever needs access back, re-add a row to `access_overrides` — but treat that
> as a real decision, not a convenience. It's access to employee complaints.

---

## Step 7 — Two-minute sanity check (together)

Open the new URL and confirm:

- [ ] The page loads
- [ ] Sign-in works: enter an @earthbar.com address, the 8-digit code arrives from
      hrcomplaints@earthbar.com, and it lets you in
- [ ] Submit a test report → the confirmation screen appears and the confirmation
      email arrives, with a link pointing at the **new** address
- [ ] Lindsey (or another HR member) can see the test case on the HR dashboard
- [ ] Adrian and Eitan can **not** see the HR dashboard anymore
- [ ] Close the test case, then delete it from the dashboard

If all six pass, the handover is complete and the app is entirely company-owned.

---

## What's still outstanding after this (not blocking)

**Eitan owns these:**

- **Anthropic credits are at zero.** AI risk triage is off — new reports simply come in
  without a suggested risk level; nothing breaks. Top up at
  `https://console.anthropic.com` → Billing, and turn on **auto-reload** so it doesn't
  lapse again (it has twice).
- **Designate a real external advisor.** When a report names an HR team member, the app
  routes it away from them to an "external advisor" — currently a placeholder. Pick a
  real person (outside counsel, or a senior leader outside HR) before launch.
- **Make the repo private** — new org → repo **Settings** → **Danger Zone** →
  **Change visibility**. The code contains no passwords, so this is tidiness, not an
  emergency.
- Delete `supabase/seed/demo_cases.sql` from the repo — it's fake sample data used for
  testing and shouldn't ship.

**HR (Lindsey/Vicky) owes content before employees are told about the app:**

- The official **category list** (the current one is a placeholder and is missing a
  harassment/discrimination option)
- Approval of the **allegation and policy dropdown lists** — drafted from the employee
  handbook, never reviewed by HR
- Lindsey's **intake template** and Vicky's **Interactive Process Guide** text — both
  are stubs in the app right now
- A **data-retention policy**: how long closed cases are kept before deletion

---

## Where to find everything else

- `README.md` — what the app is and how it's put together
- `HANDOVER_PLAN.md` — the longer version of this runbook, including how to move the
  app onto a real address like `hr.earthbar.com` (optional, do it later)
- `UPDATE_SPEC.md`, `SPEC_V3_ACCOMMODATIONS.md` — what each round of HR feedback asked
  for and how it was built
- `supabase/migrations/` — every database change in order, with notes on why
- Adrian's `LEARNINGS.md` (in his intern folder) — the running log of gotchas, and the
  single most useful file for whoever picks this up next

*Prepared by Adrian Graf, August 2026.*
