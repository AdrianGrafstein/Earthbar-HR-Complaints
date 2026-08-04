# v3 Spec — HR Requests & Accommodations
*Source: Vicky's email, 2026-07-23. Status: **MAP ONLY — nothing built yet.**
Reviewed with Adrian; open questions for Vicky listed at the end.*

---

## 1. Confirmation screen after submitting ✅ decided

**She asked:** after submitting, the "Make a request to HR" form was still on screen, so she
wasn't sure it went through.

**Cause:** the receipt currently renders as an extra card *below* the still-visible form.
Same bug on the incident form.

**Build:** when a submission succeeds, the form is **replaced** by a dedicated confirmation
view — large "Request received", the case number (`EB-0123`) prominent, a short "what
happens next" line, the claim code if anonymous, and a **Done** button back to home.
Applies to both requests and incidents.

*Frontend only. No schema change.*

---

## 2. Rename the email sender ⏸ parked (per Adrian)

Worth knowing for when it comes back: the "HR Complaints" name Vicky saw is the **Microsoft
365 mailbox display name**, not something in our code.

- Change the display name only → Eitan/IT renames the mailbox in the M365 admin center.
  **Zero code, address unchanged.**
- Change the address too → new mailbox + one SQL line (`app_config.mail_from_cases` /
  `mail_from_relay`). No redeploy — the sender address is already database-driven.

---

## 3. Accommodation fields on the dashboard

### 3a. New fields (requests only)

| Field | Type | Notes |
|---|---|---|
| Accommodation Status | Approved / Approved with Alternative / Denied / Withdrawn | the **decision** |
| Accommodation Start | date | filled by case owner |
| Accommodation End | date | filled by case owner |
| Accommodation Duration | Temporary / Ongoing | dropdown |

Stored as nullable columns on `cases`, used only when `intake_type = 'request'`.

### 3b. Separate state machine for requests

Vicky's list — Assigned, Under Review, Awaiting Information, In Interactive Process,
Monitoring, Closed — is a **different lifecycle** from the incident one
(Submitted → Triage → Assigned → Under Review → Action → Resolved → Closed).

**Build:** two state machines keyed on `intake_type`. Incidents keep theirs unchanged.

**Recommendation — loose transitions:** allow the owner to move a request to any state
rather than forcing a rigid chain. Real interactive processes loop (waiting on a doctor's
note → back to review → waiting again), and every move is already written to the audit log,
so there's a full record either way.

### 3c. Closing a request ⚠️ design change

Closing currently **requires** a substantiated yes/no — that's meaningless for an
accommodation. Proposal: closing a **request** requires the **Accommodation Status**
instead; closing an **incident** keeps substantiated. Same principle (you can't quietly
close something), correct question for each type.

### 3d. Knock-on effects to handle

- `advance_state` auto-creates a 72-hour "Begin review / investigation" task on *Assigned* —
  must not fire for requests (or gets renamed + its own clock — see open question 4).
- The 10-day "no update" reminder currently covers incidents only — should it cover
  requests? (open question 5)
- Requests table gains **Status**; dates live on the detail page and in filters, to keep
  the table readable.
- New filter: Accommodation Status.

---

## 4. Renamed / removed fields (requests only)

All label-only — a per-intake-type label map. **No migration needed**; the underlying
columns keep their names, incidents are untouched.

| Incident label | Request label |
|---|---|
| Reporter | **Requester** |
| Risk Level | **Priority / time sensitivity** |
| Evidence | **Supporting Documents** |
| Interview Guide | **Interactive Process Guide** (content from Vicky) |
| Handler | **Case owner** |
| "Begin review / investigation" | "Begin Accommodation Review" |
| Realms & policies | *hidden* |
| Relationship / Involved | *hidden* (request intake never collects these anyway) |

**Worth telling Vicky:** AI triage only ever runs on **incidents** — accommodation
requests, including anything medical, are never sent to the AI. That was already true;
it becomes a useful privacy guarantee for her HIPAA/ADA concern.

---

## 5. Forms, questions, and message attachments — the big one

### 5a. Religious requests — ask in the portal
Conditional questions appear on the request form when type = *Accommodation — Religious*.
Answers stored as structured data on the case (JSON), shown on the detail page.
**Need from Vicky:** the exact questions (from her religious form).

### 5b. Medical requests — don't collect free text
Per her instinct: no medical detail typed into the intake form. Instead HR sends the form
through the portal message thread and the employee returns it there or by email.

### 5c. Message attachments (both directions)
Currently messages are text-only. Build:

- **HR → requester:** attach a file to a message. The notification email carries a
  **time-limited secure link**, not the file itself — so the document isn't sitting in an
  inbox forever, and anonymous reporters stay anonymous.
- **Named requester → HR:** direct upload (covered by existing security rules).
- **Anonymous reporter → HR:** ⚠️ the tricky one. Anonymous users aren't signed in as
  themselves; today's storage rules assume a logged-in user. Needs a small server-side
  function that validates the claim code and accepts the upload on their behalf.
  *(Likely not needed for accommodations — see open question 10 — but required if we ever
  want anonymous evidence upload.)*

### 5d. ⚠️ Confidentiality of medical documents — worth a decision
Vicky flagged HIPAA. One nuance worth checking with counsel: medical information an
**employer** holds for an accommodation is usually governed by **ADA confidentiality
rules** (medical info kept in a separate, confidential file with limited access) rather
than HIPAA, which mainly binds health plans and providers. *(Not legal advice — worth
confirming.)*

Either way the design implication is the same, and it's a real choice:

> Today, any non-conflicted HR team member can open any case's files. Should **medical
> supporting documents** be visible to all four, or restricted to the case owner + Vicky?

**Recommendation:** store accommodation documents in a **separate bucket** from incident
evidence, so access can be tightened for medical without touching anything else.

**Need from Vicky:** both blank forms (religious + medical) — referenced in her email but
not attached.

---

## 6. Flora as case owner for accommodations

**Build:** routing becomes intake-type-aware — requests default to **Flora**, incidents stay
with **Lindsey**. Conflict-of-interest skipping is unchanged.

**Gap she didn't mention but will hit immediately:** there is currently **no way to reassign
a case owner** in the app — routing happens once at submission and can't be changed. If
Vicky wants to hand cases to Flora (or take one back), we need a *Reassign owner* control on
the case page. Recommend adding it in the same pass.

---

## Open questions for Vicky

1. **Entry state:** should a new request land straight in *Assigned* (to Flora), or is there
   a review step before it's assigned?
2. **Priority values:** keep Low / Medium / High, or different wording (e.g. Routine /
   Time-sensitive / Urgent)?
3. **Closing:** confirm a request can't be closed without an Accommodation Status. *(Rec: yes)*
4. **Deadlines:** do accommodation requests need SLA clocks (e.g. respond within X days), or
   no timers?
5. **Stale nudge:** should the "no update in 10 days" reminder apply to requests too? *(Rec: yes)*
6. **End-date reminder:** want an automatic reminder to the case owner ~2 weeks before an
   Accommodation End Date? Pairs naturally with the *Monitoring* state. *(New idea — her call.)*
7. **Medical document access:** all four HR members, or case owner + Vicky only?
8. **Reporting:** she mentions these fields matter "for reporting purposes" — does she need a
   CSV export / summary report of accommodation cases? If so, which columns?
9. **Religious questions:** exact wording to put in the portal.
10. **Anonymity:** requests are currently always named. Accommodations essentially require
    identity — confirm requests should stay named-only.

**Also needed from her:** the two blank forms, and the Interactive Process Guide text.

---

## Build phases (once answers are in)

**Phase A — no dependencies, can start immediately**
Confirmation screen · label renames + hidden fields · Flora routing · reassign-owner control
· requests filters.

**Phase B — schema**
Accommodation fields · request state machine · close-requires-status · task/reminder
adjustments.

**Phase C — needs Vicky's input**
Religious questions in the form · message attachments + secure document handling ·
Interactive Process Guide content.

**Deferred:** email sender rename (M365 change, not code).
