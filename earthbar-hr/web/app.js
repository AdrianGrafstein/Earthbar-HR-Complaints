// Earthbar HR Case Management — frontend v2 (Supabase; email OTP + Microsoft SSO)
// ============================================================================
// V2 BACKEND CONTRACT — the RPCs this frontend calls (see UPDATE_SPEC.md).
// Until the v2 migrations are deployed these fail; the UI shows a clear
// "backend not deployed yet" message instead of breaking.
//
//   submit_case_v2(p_intake_type, p_category, p_description, p_anonymous,
//                  p_location, p_relationship, p_role, p_contact_email,
//                  p_contact_phone, p_parties jsonb, p_manual bool, p_incident_date date)
//     -> json { case_id, ref, anonymous, claim_code, handler, external, route_reason }
//     p_parties: [{type:'employee'|'customer', id?, name?, role_in_case:'victim'|'subject'|'witness'}]
//     Contact email/phone are stored on EVERY case (even anonymous) but are
//     server-side only — never selectable by the dashboard.
//   set_risk_level(p_case_id uuid, p_risk text)   -- 'Low'|'Medium'|'High'
//   set_policies(p_case_id uuid, p_policies text) -- realms & policies in question
//   close_case(p_case_id uuid, p_substantiated boolean, p_note text)
//     -- closing REQUIRES substantiated yes/no
//   mention_lookup(p_employee_id text)
//     -> json [{ref, state, role_in_case, created_at}]
//   Storage bucket 'evidence' — path: <case_id>/<filename>
//   Unchanged v1 RPCs: advance_state, post_handler_message, check_status,
//                      reporter_reply, app_is_admin, app_is_handler
// ============================================================================
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.EARTHBAR_CONFIG || {};
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// NOTE (meeting 2026-07-13): harassment/discrimination is deliberately NOT an
// option — HR classifies internally after review. FINAL LIST STILL OPEN — placeholder:
const CATEGORIES = ["Manager conduct","Coworker conduct","Workplace safety","Pay / hours dispute","Policy violation","Customer incident","Other"];
const RELATIONSHIPS = ["Employee","Former employee","Customer","Vendor / partner","Other"];
const RISKS = ["Low","Medium","High"];
const PARTY_ROLES = ["subject","victim","witness"];
const NEXT = {
  Submitted:["Triage"], Triage:["Assigned","Escalated"], Assigned:["UnderReview"],
  UnderReview:["Action","OnHold"], Action:["Resolved"], Resolved:["Closed","UnderReview"],
  OnHold:["UnderReview"], Escalated:["Assigned"], Closed:["UnderReview"],
};
const SLABEL = { UnderReview:"Under Review", OnHold:"On Hold" };
const stlabel = s => SLABEL[s] || s;

// ---- state ----
let session = null, me = null, isHandler = false, isAdmin = false;
let dirList = [], dirMap = {}, storeList = [];
let view = "home", selected = null, busy = false, errorMsg = "";
let auth = { email:"", sent:false, err:"" };
let form = blankIncident();
let qform = { location:"", body:"", email:"" };
let receipt = null, statusResult = null, myReports = [];
let filters = { q:"", risk:"", cat:"", state:"" };
let showManual = false, manual = blankIncident(true);
let closeModal = { open:false, caseId:null, sub:null, note:"" };
let lookup = { query:"", picked:null, result:null, err:"" };
let evidence = { list:[], err:"" };

function todayStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function blankIncident(isManual = false){
  return { anonymous:false, location:"", relationship:"Employee", role:"",
    category:CATEGORIES[0], parties:[], pQuery:"", pType:"employee", pName:"",
    pRole:"subject", description:"", email:"", phone:"", files:[], manual:isManual,
    incidentDate: todayStr() };
}

const $ = id => document.getElementById(id);
const esc = s => (s==null?"":String(s)).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
const nameOf = id => dirMap[id]?.name || id || "—";
const roleOf = id => dirMap[id]?.title || "";
const pill = s => `<span class="pill dot s-${s}">${stlabel(s)}</span>`;
const riskPill = r => r ? `<span class="pill r-${r}">${r}</span>` : '<span class="muted">—</span>';
const caseRisk = c => c.risk_level || (c.severity === "High" ? "High" : null);
// Friendly message when a v2 RPC isn't deployed yet
const errText = e => /function|does not exist|not exist|PGRST202|schema cache/i.test(e?.message||"")
  ? "This action needs the v2 backend, which isn't deployed yet." : (e?.message || "Unknown error");

Object.assign(window, { go, signInMicrosoft, sendOtp, verifyOtp, signOut,
  setF, addParty, rmParty, onPartyInput, pickPartyEmp, submitIncident, submitQuestion,
  openCase, closeCase, doAdvance, sendHandlerMsg, doStatusCheck, sendReporterReply,
  setFilter, applyFilters, toggleManual, setM, mAddParty, mRmParty, mOnPartyInput, mPickPartyEmp, submitManual,
  openCloseModal, cancelCloseModal, setCloseSub, confirmClose,
  saveRisk, savePolicies, uploadCaseEvidence,
  onLookupInput, pickLookup, backToLookup });

// ---------------- AUTH / BOOTSTRAP ----------------
async function boot(){
  const { data } = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_e, s) => { session = s; if (s) loadContext().then(render); else { me=null; render(); } });
  if (session) await loadContext();
  render();
}
async function loadContext(){
  const email = (session.user.email || "").toLowerCase();
  const { data: dir } = await sb.from("directory").select("employee_id,name,email,title,store,manager_id");
  dirList = dir || [];
  dirMap = Object.fromEntries(dirList.map(d => [d.employee_id, d]));
  storeList = [...new Set(dirList.map(d => d.store).filter(Boolean))].sort();
  me = dirList.find(d => (d.email||"").toLowerCase() === email) || { name: session.user.user_metadata?.name || email, title:null, email };
  const [a, h] = await Promise.all([ sb.rpc("app_is_admin"), sb.rpc("app_is_handler") ]);
  isAdmin = !!a.data; isHandler = !!h.data;
  form.email = form.email || email; qform.email = qform.email || email;
  if (view === "dashboard" && !isHandler) view = "home";
}
async function signInMicrosoft(){
  await sb.auth.signInWithOAuth({ provider:"azure",
    options:{ scopes:"openid email profile", redirectTo: window.location.href.split("#")[0] } });
}
async function sendOtp(){
  const email = ($("otp-email")?.value || "").trim().toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(email)){ auth.err = "Please enter a valid email address."; render(); return; }
  auth.email = email; auth.err = ""; busy = true; render();
  const { error } = await sb.auth.signInWithOtp({ email, options:{ shouldCreateUser:true } });
  busy = false;
  if(error){ auth.err = error.message; } else { auth.sent = true; }
  render();
}
async function verifyOtp(){
  const token = ($("otp-code")?.value || "").trim();
  if(!token){ return; }
  busy = true; render();
  const { error } = await sb.auth.verifyOtp({ email: auth.email, token, type: "email" });
  busy = false;
  if(error){ auth.err = "That code didn't work — check it or request a new one."; render(); return; }
  auth = { email:"", sent:false, err:"" };
}
async function signOut(){ await sb.auth.signOut(); me=null; view="home"; selected=null; render(); }

// ---------------- NAV ----------------
function tabs(){
  const t = [{id:"home",label:"Home"},{id:"status",label:"Check my report status"}];
  if (isHandler) t.push({id:"dashboard",label:"HR Dashboard"},{id:"lookup",label:"Employee Lookup"});
  return t;
}
function go(v){
  if ((v==="dashboard"||v==="lookup") && !isHandler) v="home";
  view=v; selected=null; receipt=null; errorMsg=""; showManual=false;
  render();
}
function renderNav(){
  $("nav").innerHTML = session ? tabs().map(t=>`<button class="${view===t.id?'active':''}" onclick="go('${t.id}')">${t.label}</button>`).join("") : "";
}
function renderUserBox(){
  const el = $("userbox"); if (!el) return;
  if (!session){ el.innerHTML=""; return; }
  el.style.display="flex"; el.style.alignItems="center"; el.style.gap="12px";
  el.innerHTML = `<span style="font-size:12px;text-align:right;line-height:1.2;color:#111">${esc(me?.name||session.user.email)}<br>
    <span style="color:#6b6b6b">${esc(me?.title||"")}</span></span>
    <button onclick="signOut()" style="background:#fff;color:#111;border:1px solid #111;padding:6px 12px;border-radius:2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;cursor:pointer">Sign out</button>`;
}

// ---------------- LOGIN (email code for anyone; Microsoft for staff) ----------------
function renderLogin(){
  const ok = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT");
  if(!ok) return `<div class="card" style="max-width:520px;margin:40px auto">
    <div class="banner err">Configuration needed: set <b>SUPABASE_URL</b> and <b>SUPABASE_ANON_KEY</b> in <code>config.js</code>. See the README.</div></div>`;
  return `<div class="card" style="max-width:520px;margin:40px auto">
    <h2 class="section">Sign in to Earthbar HR</h2>
    <p class="muted">Anyone can sign in with any email address — you don't need an @earthbar.com account. We'll email you a one-time code.</p>
    ${!auth.sent ? `
      <label>Email address</label>
      <input id="otp-email" type="text" placeholder="you@example.com" value="${esc(auth.email)}">
      <div style="margin-top:14px"><button class="btn" onclick="sendOtp()" ${busy?'disabled':''}>${busy?'<span class="spin"></span> Sending…':'Email me a sign-in code'}</button></div>`
    : `
      <div class="banner ok">Email sent to <b>${esc(auth.email)}</b>. <b>Open the sign-in link in that email on this device</b> — you'll land back here signed in. (Check spam if you don't see it.)</div>
      <label>Got a code instead? Enter it here</label>
      <input id="otp-code" type="text" placeholder="6-digit code (if your email shows one)" autocomplete="one-time-code">
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="btn" onclick="verifyOtp()" ${busy?'disabled':''}>${busy?'<span class="spin"></span> Checking…':'Sign in with code'}</button>
        <button class="btn ghost" onclick="(function(){window.dispatchEvent(new Event('otp-reset'))})()" id="otp-back">Use a different email</button>
      </div>`}
    ${auth.err?`<div class="banner err">${esc(auth.err)}</div>`:""}
    <div class="divider"></div>
    <p class="muted" style="font-size:13px">Earthbar staff can also use single sign-on:</p>
    <button class="btn ms" onclick="signInMicrosoft()">
      <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true"><rect width="10" height="10" x="1" y="1" fill="#F25022"/><rect width="10" height="10" x="12" y="1" fill="#7FBA00"/><rect width="10" height="10" x="1" y="12" fill="#00A4EF"/><rect width="10" height="10" x="12" y="12" fill="#FFB900"/></svg>
      Sign in with Microsoft</button>
    <p class="note-sm" style="margin-top:14px">Reported anonymously before? You can check status any time with your claim code after signing in with any email.</p>
  </div>`;
}
window.addEventListener("otp-reset", ()=>{ auth={email:"",sent:false,err:""}; render(); });

// ---------------- HOME (question vs incident fork) ----------------
function renderHome(){
  return `<div class="card" style="max-width:720px;margin:24px auto">
    <h2 class="section">How can HR help?</h2>
    <p class="muted">Choose one to get started.</p>
    <div class="radio-cards" style="margin-top:14px">
      <div class="radio-card fork" onclick="go('question')"><b>I have a question or request</b>
        <span class="muted">Benefits, policies, scheduling, documents — anything you'd normally email HR about.</span></div>
      <div class="radio-card fork" onclick="go('incident')"><b>I want to report an incident</b>
        <span class="muted">Something happened that HR should look into. You can report anonymously.</span></div>
    </div>
  </div>`;
}

// ---------------- QUESTION / REQUEST ----------------
function renderQuestion(){
  return `<div class="card" style="max-width:720px;margin:0 auto">
    <button class="back" onclick="go('home')">← Back</button>
    <h2 class="section">Ask HR a question or make a request</h2>
    <label>Location (optional)</label>
    <select onchange="qformLoc(this.value)">${["",...storeList].map(s=>`<option value="${esc(s)}" ${qform.location===s?'selected':''}>${s||'— Not store-specific —'}</option>`).join("")}</select>
    <label>Your question or request</label>
    <textarea id="qbody" placeholder="What do you need?">${esc(qform.body)}</textarea>
    <label>Email for the reply</label>
    <input id="qemail" type="text" value="${esc(qform.email)}">
    ${errorMsg?`<div class="banner err">${esc(errorMsg)}</div>`:""}
    <div style="margin-top:18px"><button class="btn" onclick="submitQuestion()" ${busy?'disabled':''}>${busy?'<span class="spin"></span> Sending…':'Send to HR'}</button></div>
  </div>${receipt?renderReceipt(receipt):""}`;
}
window.qformLoc = v => { qform.location = v; };
async function submitQuestion(){
  qform.body = $("qbody")?.value || ""; qform.email = ($("qemail")?.value||"").trim();
  errorMsg = "";
  if(!qform.body.trim()){ errorMsg="Please enter your question."; render(); return; }
  if(!/^\S+@\S+\.\S+$/.test(qform.email)){ errorMsg="Please enter a valid email for the reply."; render(); return; }
  busy=true; render();
  const { data, error } = await sb.rpc("submit_case_v2", {
    p_intake_type:"question", p_category:"Question / request", p_description:qform.body,
    p_anonymous:false, p_location:qform.location||null, p_relationship:null, p_role:null,
    p_contact_email:qform.email, p_contact_phone:null, p_parties:[], p_manual:false, p_incident_date:null });
  busy=false;
  if(error){ errorMsg = errText(error); render(); return; }
  receipt = Object.assign({question:true}, data);
  qform = { location:"", body:"", email:(session.user.email||"") };
  render(); window.scrollTo({top:99999,behavior:"smooth"});
}

// ---------------- INCIDENT INTAKE ----------------
function partyBuilder(f, pre){
  // pre = "" for reporter form, "m" for manual-entry form (separate handlers)
  const P = pre ? {input:"mOnPartyInput",pick:"mPickPartyEmp",add:"mAddParty",rm:"mRmParty",set:"setM"}
                : {input:"onPartyInput",pick:"pickPartyEmp",add:"addParty",rm:"rmParty",set:"setF"};
  const results = f.pType==="employee" && f.pQuery.length>=2 ? dirList.filter(d =>
      (d.name||"").toLowerCase().includes(f.pQuery.toLowerCase()) ||
      (d.title||"").toLowerCase().includes(f.pQuery.toLowerCase())).slice(0,8) : [];
  return `
    <label>Who was involved? <span class="muted" style="font-weight:400">(employees drive conflict-of-interest routing)</span></label>
    <div class="row" style="align-items:flex-end">
      <div class="col" style="min-width:130px"><span class="mini-l">They are a…</span>
        <select onchange="${P.set}('pType',this.value)"><option value="employee" ${f.pType==='employee'?'selected':''}>Earthbar employee</option><option value="customer" ${f.pType==='customer'?'selected':''}>Customer</option></select></div>
      <div class="col" style="min-width:130px"><span class="mini-l">Their role in this</span>
        <select onchange="${P.set}('pRole',this.value)">${PARTY_ROLES.map(r=>`<option ${f.pRole===r?'selected':''}>${r}</option>`).join("")}</select></div>
      <div class="col" style="min-width:220px">
        ${f.pType==="employee"
          ? `<span class="mini-l">Find the employee</span><input id="${pre}psearch" type="text" placeholder="Search a name or title…" value="${esc(f.pQuery)}" oninput="${P.input}(this.value)">`
          : `<span class="mini-l">Customer name / description</span><input id="${pre}pname" type="text" placeholder="e.g. customer, tall, red jacket" value="${esc(f.pName)}" oninput="${P.set}('pName',this.value,true)">
             <div style="margin-top:6px"><button class="btn sm sec" onclick="${P.add}()">Add customer</button></div>`}
      </div>
    </div>
    ${results.map(d=>`<div class="subj-result" onclick="${P.pick}('${d.employee_id}')">${esc(d.name)} — <span class="muted">${esc(d.title||'')}${d.store?' · '+esc(d.store):''}</span></div>`).join("")}
    <div style="margin-top:8px">${f.parties.map((p,i)=>`<span class="chip" style="margin-right:6px">${p.type==='employee'?esc(nameOf(p.id)):esc(p.name)+' (customer)'} · <i>${p.role_in_case}</i> <a onclick="${P.rm}(${i})" style="cursor:pointer;color:var(--red);font-weight:700">×</a></span>`).join("") || '<span class="muted">No one added yet.</span>'}</div>`;
}
function renderIncident(){
  return `<div class="card">
    <button class="back" onclick="go('home')">← Back</button>
    <h2 class="section">Report an incident</h2>
    <p class="muted">Only the assigned HR handler can see this — never anyone the report is about.</p>

    <label>Which location is this about?</label>
    <select onchange="setF('location',this.value)">${["",...storeList,"Other / not store-specific"].map(s=>`<option value="${esc(s)}" ${form.location===s?'selected':''}>${s||'— Select a location —'}</option>`).join("")}</select>

    <label>When did this happen?</label>
    <input type="date" max="${todayStr()}" value="${esc(form.incidentDate)}" onchange="setF('incidentDate',this.value||todayStr(),true)">

    <label>How do you want to submit?</label>
    <div class="radio-cards">
      <div class="radio-card ${!form.anonymous?'sel':''}" onclick="setF('anonymous',false)"><b>With my name</b><span class="muted">HR can follow up with you directly.</span></div>
      <div class="radio-card ${form.anonymous?'sel':''}" onclick="setF('anonymous',true)"><b>Anonymously</b><span class="muted">HR never sees who you are. You still get email updates, and a claim code for two-way messaging.</span></div>
    </div>
    ${form.anonymous?`<div class="banner ok" style="margin-top:10px">Your name is hidden from HR. Your email is stored securely <b>only</b> so the system can send you updates — the HR team cannot see it.</div>`:""}

    <label>What is your relationship to Earthbar?</label>
    <select onchange="setF('relationship',this.value)">${RELATIONSHIPS.map(r=>`<option ${form.relationship===r?'selected':''}>${r}</option>`).join("")}</select>
    ${form.relationship==="Employee"?`
      <label>Your current role at Earthbar</label>
      <input id="f-role" type="text" placeholder="e.g. Shift lead, EB Brentwood" value="${esc(form.role)}" oninput="setF('role',this.value,true)">`:""}

    <label>Category</label>
    <select onchange="setF('category',this.value)">${CATEGORIES.map(c=>`<option ${form.category===c?'selected':''}>${c}</option>`).join("")}</select>
    <p class="note-sm">Pick the closest fit — HR reviews and classifies every report after it's submitted.</p>

    ${partyBuilder(form,"")}

    <label>What happened?</label>
    <textarea id="f-desc" placeholder="Describe the situation.${form.anonymous?' If anonymous, avoid details that would reveal who you are.':''}">${esc(form.description)}</textarea>

    <label>Relevant documents <span class="muted" style="font-weight:400">(optional)</span></label>
    <p class="note-sm" style="margin:0 0 6px">If you have any relevant documents for this case, please submit them — photos, screenshots, PDFs.</p>
    <input id="f-files" type="file" multiple>

    <label>Your email <span class="muted" style="font-weight:400">(required — for your case confirmation and updates${form.anonymous?', never shown to HR':''})</span></label>
    <input id="f-email" type="text" value="${esc(form.email)}">
    <label>Your phone <span class="muted" style="font-weight:400">(optional)</span></label>
    <input id="f-phone" type="text" value="${esc(form.phone)}">

    ${errorMsg?`<div class="banner err">${esc(errorMsg)}</div>`:""}
    <div style="margin-top:18px"><button class="btn" onclick="submitIncident()" ${busy?'disabled':''}>${busy?'<span class="spin"></span> Submitting…':'Submit report'}</button></div>
  </div>${receipt?renderReceipt(receipt):""}`;
}
function setF(k,v,silent){ form[k]=v; if(!silent) render(); }
function onPartyInput(v){ form.pQuery=v; render(); const el=$("psearch"); if(el){el.focus();el.setSelectionRange(v.length,v.length);} }
function pickPartyEmp(id){ if(!form.parties.some(p=>p.id===id)) form.parties.push({type:"employee",id,role_in_case:form.pRole}); form.pQuery=""; render(); }
function addParty(){ const n=($("pname")?.value||form.pName||"").trim(); if(!n)return; form.parties.push({type:"customer",name:n,role_in_case:form.pRole}); form.pName=""; render(); }
function rmParty(i){ form.parties.splice(i,1); render(); }

async function submitIncident(){
  form.description = $("f-desc")?.value || "";
  form.email = ($("f-email")?.value||"").trim(); form.phone = ($("f-phone")?.value||"").trim();
  form.role = form.relationship==="Employee" ? ($("f-role")?.value||form.role||"") : "";
  const files = Array.from($("f-files")?.files || []);
  errorMsg="";
  if(!form.location){ errorMsg="Please choose a location."; render(); return; }
  if(!form.description.trim()){ errorMsg="Please describe what happened."; render(); return; }
  if(!/^\S+@\S+\.\S+$/.test(form.email)){ errorMsg="An email is required so we can confirm your report and send updates (it's hidden from HR if you're anonymous)."; render(); return; }
  busy=true; render();
  const { data, error } = await sb.rpc("submit_case_v2", {
    p_intake_type:"incident", p_category:form.category, p_description:form.description,
    p_anonymous:form.anonymous, p_location:form.location, p_relationship:form.relationship,
    p_role:form.role||null, p_contact_email:form.email, p_contact_phone:form.phone||null,
    p_parties:form.parties, p_manual:false, p_incident_date:form.incidentDate });
  if(error){ busy=false; errorMsg = errText(error); render(); return; }
  // upload evidence after the case exists
  let upNote = "";
  if(files.length && data?.case_id){
    const fails = [];
    for(const f of files){
      const { error:ue } = await sb.storage.from("evidence").upload(`${data.case_id}/${Date.now()}_${f.name}`, f);
      if(ue) fails.push(f.name);
    }
    upNote = fails.length ? `⚠️ ${fails.length} of ${files.length} file(s) failed to upload — you can send them later via messaging.`
                          : `${files.length} file(s) attached.`;
  }
  busy=false;
  receipt = Object.assign({upNote}, data);
  form = blankIncident(); form.email = (session.user.email||"");
  render(); window.scrollTo({top:99999,behavior:"smooth"});
}
function renderReceipt(r){
  if(r.question) return `<div class="card"><div class="banner ok"><b>Sent to HR.</b> Reference <span class="ref">${esc(r.ref)}</span> — you'll get a reply at the email you provided.</div></div>`;
  return `<div class="card">
    <div class="banner ok"><b>Report received.</b> Reference <span class="ref">${esc(r.ref)}</span> — a confirmation email is on its way.</div>
    ${r.upNote?`<p class="muted">${esc(r.upNote)}</p>`:""}
    ${r.anonymous ? `<p class="muted">Save this claim code — it's how you check status and message HR without revealing who you are. Email updates will still reach you automatically.</p>
      <div class="codebox">${esc(r.claim_code)}</div>
      <p class="note-sm">Shown once. Check it any time under “Check my report status”.</p>`
      : `<p class="muted">You submitted with your name. The assigned handler can follow up with you directly.</p>`}
    <div class="divider"></div>
    <div class="kv"><span class="k">Routed to</span><b>${esc(r.handler)}</b>${r.external?' <span class="warnbadge" style="margin-left:8px">EXTERNAL</span>':''}</div>
    <div class="kv"><span class="k">Why</span><span>${r.route_reason==='default'?'Default handler — no conflict of interest.':r.route_reason==='conflict_reroute'?'Rerouted — the usual handler was connected to this case.':'All internal HR handlers were conflicted → external advisor.'}</span></div>
  </div>`;
}

// ---------------- DASHBOARD ----------------
function setFilter(k,v){ filters[k]=v; }
function applyFilters(){ render(); }
async function renderDashboardInto(el){
  // NOTE: no select("*") on cases — reporter_email/phone are column-locked
  // server-side (anonymity guarantee); requesting them is permission-denied.
  const CASE_COLS = "id,ref,category,description,severity,anonymous,handler_id,external,route_reason,state,created_at,closed_at,incident_date,intake_type,location,reporter_relationship,reporter_role,reporter_display,risk_level,substantiated,substantiated_note,policies,ai_summary,manual_entry,updated_at";
  const { data:cases, error } = await sb.from("cases")
    .select(CASE_COLS + ", tasks(status,due_at)")
    .order("created_at",{ascending:false});
  if(error){ el.innerHTML = `<div class="card"><div class="banner err">Could not load cases: ${esc(error.message)}</div></div>`; return; }
  const now = Date.now();
  const overdue = c => (c.tasks||[]).some(t => t.status==="open" && t.due_at && new Date(t.due_at).getTime() < now);
  const q = ($("flt-q")?.value ?? filters.q).toLowerCase();
  filters.q = q;
  const shown = cases.filter(c =>
    (!filters.risk || caseRisk(c)===filters.risk) &&
    (!filters.cat  || c.category===filters.cat) &&
    (!filters.state|| c.state===filters.state) &&
    (!q || (c.ref||"").toLowerCase().includes(q) || (c.description||"").toLowerCase().includes(q) || (c.location||"").toLowerCase().includes(q)));
  const open = cases.filter(c=>c.state!=="Closed").length;
  const hi = cases.filter(c=>caseRisk(c)==="High").length;
  const od = cases.filter(overdue).length;
  const states = [...new Set(cases.map(c=>c.state))];
  el.innerHTML = `<div class="card">
      <h2 class="section">HR case dashboard <span class="chip" style="vertical-align:middle">${esc(me?.title||'Handler')}</span></h2>
      <p class="muted">${isAdmin?"You have HR-leadership access: all cases except any you're personally involved in.":"You see cases assigned to you, and none you're involved in."}</p>
      <div class="row" style="margin:14px 0 4px">
        <div class="stat"><div class="n">${cases.length}</div><div class="l">Cases you can see</div></div>
        <div class="stat"><div class="n">${open}</div><div class="l">Open</div></div>
        <div class="stat"><div class="n" style="color:${hi?'var(--red)':'var(--green-dk)'}">${hi}</div><div class="l">High risk</div></div>
        <div class="stat"><div class="n" style="color:${od?'var(--red)':'var(--green-dk)'}">${od}</div><div class="l">SLA overdue</div></div>
      </div>
      <div class="filters">
        <input id="flt-q" type="text" placeholder="Search ref, description, location…" value="${esc(filters.q)}" onkeydown="if(event.key==='Enter')applyFilters()">
        <select onchange="setFilter('risk',this.value);applyFilters()"><option value="">Risk: all</option>${RISKS.map(r=>`<option ${filters.risk===r?'selected':''}>${r}</option>`).join("")}</select>
        <select onchange="setFilter('cat',this.value);applyFilters()"><option value="">Category: all</option>${[...new Set(cases.map(c=>c.category))].map(c=>`<option ${filters.cat===c?'selected':''}>${esc(c)}</option>`).join("")}</select>
        <select onchange="setFilter('state',this.value);applyFilters()"><option value="">Status: all</option>${states.map(s=>`<option value="${s}" ${filters.state===s?'selected':''}>${stlabel(s)}</option>`).join("")}</select>
        <button class="btn sm" onclick="applyFilters()">Filter</button>
        <button class="btn sm sec" style="margin-left:auto" onclick="toggleManual()">${showManual?'✕ Cancel manual entry':'+ Add case manually'}</button>
      </div>
      <p class="note-sm">Cases naming you (or someone above you who is named) are hidden by the database and never sent to your browser. Anonymous reporters' contact info is never visible here.</p>
    </div>
    ${showManual?renderManual():""}
    <div class="card" style="padding:8px 0"><table>
      <thead><tr><th style="padding-left:20px">Ref</th><th>Risk</th><th>Category</th><th>Location</th><th>Reporter</th><th>Handler</th><th>State</th><th>SLA</th></tr></thead>
      <tbody>${shown.length ? shown.map(c=>`<tr class="clk" onclick="openCase('${c.id}')">
        <td style="padding-left:20px"><span class="ref">${esc(c.ref)}</span></td>
        <td>${riskPill(caseRisk(c))}</td>
        <td>${esc(c.category)}</td>
        <td>${esc(c.location||'—')}</td>
        <td>${c.anonymous?'<span class="chip">Anonymous</span>':esc(c.reporter_display||'Named')}</td>
        <td>${c.external?'External advisor <span class="warnbadge">EXT</span>':esc(nameOf(c.handler_id))}</td>
        <td>${pill(c.state)}</td>
        <td>${overdue(c)?'<span class="pill dot s-Escalated">Overdue</span>':'<span class="pill dot s-Resolved">On track</span>'}</td>
      </tr>`).join("") : `<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--grey)">No cases match.</td></tr>`}</tbody>
    </table></div>`;
}
function openCase(id){ selected=id; evidence={list:[],err:""}; render(); window.scrollTo({top:0,behavior:"smooth"}); }
function closeCase(){ selected=null; render(); }

// ---- manual case entry (for reports that reach Lindsey by email first) ----
function toggleManual(){ showManual=!showManual; if(showManual) manual=blankIncident(true); render(); }
function renderManual(){
  return `<div class="card" style="border-color:var(--green)">
    <h2 class="section" style="font-size:16px">Add a case manually <span class="chip">received outside the portal</span></h2>
    <label>Reporter's email (if known)</label><input id="m-email" type="text" value="${esc(manual.email)}">
    <label>Location</label>
    <select onchange="setM('location',this.value)">${["",...storeList,"Other / not store-specific"].map(s=>`<option value="${esc(s)}" ${manual.location===s?'selected':''}>${s||'— Select —'}</option>`).join("")}</select>
    <label>Category</label>
    <select onchange="setM('category',this.value)">${CATEGORIES.map(c=>`<option ${manual.category===c?'selected':''}>${c}</option>`).join("")}</select>
    <label>When did it happen? (if known)</label>
    <input type="date" max="${todayStr()}" value="${esc(manual.incidentDate)}" onchange="setM('incidentDate',this.value,true)">
    ${partyBuilder(manual,"m")}
    <label>Description (paste the report as received)</label>
    <textarea id="m-desc">${esc(manual.description)}</textarea>
    ${errorMsg?`<div class="banner err">${esc(errorMsg)}</div>`:""}
    <div style="margin-top:14px"><button class="btn" onclick="submitManual()" ${busy?'disabled':''}>${busy?'<span class="spin"></span> Adding…':'Add case'}</button></div>
  </div>`;
}
function setM(k,v,silent){ manual[k]=v; if(!silent) render(); }
function mOnPartyInput(v){ manual.pQuery=v; render(); const el=$("mpsearch"); if(el){el.focus();el.setSelectionRange(v.length,v.length);} }
function mPickPartyEmp(id){ if(!manual.parties.some(p=>p.id===id)) manual.parties.push({type:"employee",id,role_in_case:manual.pRole}); manual.pQuery=""; render(); }
function mAddParty(){ const n=($("mpname")?.value||manual.pName||"").trim(); if(!n)return; manual.parties.push({type:"customer",name:n,role_in_case:manual.pRole}); manual.pName=""; render(); }
function mRmParty(i){ manual.parties.splice(i,1); render(); }
async function submitManual(){
  manual.description = $("m-desc")?.value || ""; manual.email = ($("m-email")?.value||"").trim();
  errorMsg="";
  if(!manual.description.trim()){ errorMsg="Please paste or describe the report."; render(); return; }
  busy=true; render();
  const { data, error } = await sb.rpc("submit_case_v2", {
    p_intake_type:"incident", p_category:manual.category, p_description:manual.description,
    p_anonymous:false, p_location:manual.location||null, p_relationship:null, p_role:null,
    p_contact_email:manual.email||null, p_contact_phone:null, p_parties:manual.parties, p_manual:true, p_incident_date:manual.incidentDate||null });
  busy=false;
  if(error){ errorMsg = errText(error); render(); return; }
  showManual=false; manual=blankIncident(true);
  alert(`Case ${data.ref} added.`); render();
}

// ---- case detail ----
async function renderCaseDetailInto(el, id){
  const CASE_COLS = "id,ref,category,description,severity,anonymous,handler_id,external,route_reason,state,created_at,closed_at,incident_date,intake_type,location,reporter_relationship,reporter_role,reporter_display,risk_level,substantiated,substantiated_note,policies,ai_summary,manual_entry,updated_at";
  const [{data:c}, {data:parties}, {data:events}, {data:tasks}, {data:messages}] = await Promise.all([
    sb.from("cases").select(CASE_COLS).eq("id",id).maybeSingle(),
    sb.from("case_parties").select("*").eq("case_id",id),
    sb.from("case_events").select("*").eq("case_id",id).order("at",{ascending:true}),
    sb.from("tasks").select("*").eq("case_id",id).order("created_at",{ascending:true}),
    sb.from("messages").select("*").eq("case_id",id).order("created_at",{ascending:true}),
  ]);
  if(!c){ el.innerHTML=`<button class="back" onclick="closeCase()">← Back</button><div class="card"><div class="banner warn">This case isn't available to you.</div></div>`; return; }
  // evidence list (bucket may not exist pre-v2 — degrade quietly)
  sb.storage.from("evidence").list(id).then(({data,error})=>{
    evidence = error ? {list:[],err:"Evidence storage isn't set up yet (v2 backend)."} : {list:data||[],err:""};
    const ev=$("ev-list"); if(ev) ev.innerHTML = evidenceHtml(id);
  });
  const handlerName = c.external ? "External advisor" : nameOf(c.handler_id);
  const nexts = (NEXT[c.state] || []).filter(n=>n!=="Closed");
  const canClose = (NEXT[c.state]||[]).includes("Closed");
  const now = Date.now();
  const partyLine = p => p.party_type==="customer" || (!p.subject_id && p.display_name)
      ? `${esc(p.display_name||"Customer")} (customer, ${esc(p.role_in_case)})`
      : `${esc(nameOf(p.subject_id))} (${esc(roleOf(p.subject_id))}${p.role_in_case&&p.role_in_case!=='subject'?', '+esc(p.role_in_case):''})`;
  el.innerHTML = `<button class="back" onclick="closeCase()">← Back to dashboard</button>
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px"><span class="ref" style="font-size:16px">${esc(c.ref)}</span>${pill(c.state)}${riskPill(caseRisk(c))}${c.substantiated===true?'<span class="chip">Substantiated</span>':c.substantiated===false?'<span class="chip" style="background:#F1F1F4;color:#475467">Unsubstantiated</span>':''}</div>
    <h2 class="section" style="margin-top:6px">${esc(c.category)}</h2>
    <div class="row">
      <div class="col">
        <div class="kv"><span class="k">Reporter</span>${c.anonymous?'<span class="chip">Anonymous — contact info hidden, system emails them updates</span>':`<b>${esc(c.reporter_display||'—')}</b>`}</div>
        <div class="kv"><span class="k">Location</span><span>${esc(c.location||'—')}</span></div>
        <div class="kv"><span class="k">Occurred</span><span>${c.incident_date?esc(c.incident_date):'—'}</span></div>
        <div class="kv"><span class="k">Relationship</span><span>${esc(c.reporter_relationship||'—')}${c.reporter_role?' · '+esc(c.reporter_role):''}</span></div>
        <div class="kv"><span class="k">Involved</span><span>${(parties||[]).map(partyLine).join(", ")||'—'}</span></div>
        <div class="kv"><span class="k">Handler</span><b>${esc(handlerName)}</b>${c.external?' <span class="warnbadge">EXTERNAL</span>':''}</div>
        <div class="kv"><span class="k">Route reason</span><span>${esc((c.route_reason||'').replace(/_/g,' '))}</span></div>
        <div class="kv"><span class="k">Risk level</span><span>
          <select id="risk-sel" style="width:auto;padding:5px 8px">${["",...RISKS].map(r=>`<option value="${r}" ${caseRisk(c)===r?'selected':''}>${r||'— unset —'}</option>`).join("")}</select>
          <button class="btn sm sec" onclick="saveRisk('${c.id}')">Save</button></span></div>
      </div>
      <div class="col"><div class="kv"><span class="k">Description</span></div><div class="banner" style="background:#fff;border:1px solid var(--line)">${esc(c.description)}</div>
        ${c.ai_summary?`<div class="kv" style="margin-top:8px"><span class="k">AI review</span></div><div class="banner info">${esc(c.ai_summary)}</div>`:""}</div>
    </div>
    <label>Realms &amp; policies in question</label>
    <div style="display:flex;gap:8px"><input id="pol" type="text" placeholder="e.g. Anti-harassment policy §3; Timekeeping policy" value="${esc(c.policies||'')}"><button class="btn sm sec" onclick="savePolicies('${c.id}')">Save</button></div>
    <div class="divider"></div>
    <b style="font-size:13px">Advance case state</b>
    <div style="margin-top:8px">
      ${nexts.map(n=>`<button class="btn sm sec" style="margin-right:8px" onclick="doAdvance('${c.id}','${n}')">→ ${stlabel(n)}</button>`).join("")}
      ${canClose?`<button class="btn sm" style="background:var(--red)" onclick="openCloseModal('${c.id}')">Close case…</button>`:""}
      ${!nexts.length&&!canClose?'<span class="muted">Case is closed.</span>':""}
    </div>
  </div>
  <div class="row">
    <div class="col card"><b>Evidence</b>
      <div id="ev-list" style="margin-top:10px">${evidenceHtml(id)}</div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center"><input id="ev-file" type="file" multiple style="flex:1"><button class="btn sm sec" onclick="uploadCaseEvidence('${c.id}')">Upload</button></div>
    </div>
    <div class="col card"><b>Follow-up tasks &amp; SLAs</b><div style="margin-top:10px">
      ${(tasks||[]).length?tasks.map(t=>{const over=t.status==="open"&&t.due_at&&new Date(t.due_at).getTime()<now;
        return `<div class="task">
          <span style="${t.status==='done'?'text-decoration:line-through;color:var(--grey)':''}">${esc(t.title)}</span>
          <span class="due" style="color:${over?'var(--red)':'var(--grey)'}">${t.status==='done'?'Done':(over?'Overdue':'Due '+fmt(t.due_at))}</span></div>`;}).join(""):'<span class="muted">No tasks.</span>'}
    </div></div>
  </div>
  <div class="card"><b>Case timeline (audit log)</b><ul class="timeline" style="margin-top:10px">
    ${(events||[]).map(e=>`<li><div class="t">${fmt(e.at)} · ${esc(e.type)}</div><div class="e">${esc(e.note)}</div></li>`).join("")}
  </ul></div>
  <div class="card"><b>Messages ${c.anonymous?'<span class="chip">relayed — reporter stays anonymous</span>':''}</b>
    <div class="msgwrap" style="margin:12px 0">${(messages||[]).length?messages.map(m=>`<div class="msg ${m.sender_type}"><div class="who">${m.sender_type==='handler'?esc(handlerName):(c.anonymous?'Anonymous reporter':esc(c.reporter_display||'Reporter'))}</div>${esc(m.body)}</div>`).join(""):'<span class="muted">No messages yet.</span>'}</div>
    <p class="note-sm">Messages are also emailed to the reporter automatically${c.anonymous?" — without revealing their address to you":""}.</p>
    <div style="display:flex;gap:8px"><input id="hmsg" type="text" placeholder="Message the reporter…"><button class="btn" onclick="sendHandlerMsg('${c.id}')">Send</button></div>
  </div>
  ${closeModal.open?renderCloseModal():""}`;
}
function evidenceHtml(caseId){
  if(evidence.err) return `<span class="muted">${esc(evidence.err)}</span>`;
  if(!evidence.list.length) return '<span class="muted">No evidence uploaded.</span>';
  return evidence.list.map(f=>`<div class="task"><span>${esc(f.name.replace(/^\d+_/,''))}</span><span class="due">${f.created_at?fmt(f.created_at):''}</span></div>`).join("");
}
async function uploadCaseEvidence(caseId){
  const files = Array.from($("ev-file")?.files||[]);
  if(!files.length) return;
  for(const f of files){
    const { error } = await sb.storage.from("evidence").upload(`${caseId}/${Date.now()}_${f.name}`, f);
    if(error){ alert("Upload failed: "+errText(error)); return; }
  }
  render();
}
async function saveRisk(id){
  const v = $("risk-sel")?.value; if(!v) return;
  const { error } = await sb.rpc("set_risk_level",{ p_case_id:id, p_risk:v });
  if(error){ alert(errText(error)); return; } render();
}
async function savePolicies(id){
  const v = $("pol")?.value ?? "";
  const { error } = await sb.rpc("set_policies",{ p_case_id:id, p_policies:v });
  if(error){ alert(errText(error)); return; } render();
}
async function doAdvance(id,to){ const {error}=await sb.rpc("advance_state",{p_case_id:id,p_to:to}); if(error)alert(errText(error)); render(); }
async function sendHandlerMsg(id){ const v=$("hmsg")?.value.trim(); if(!v)return; const {error}=await sb.rpc("post_handler_message",{p_case_id:id,p_body:v}); if(error)alert(errText(error)); render(); }

// ---- close-case modal (substantiated y/n is REQUIRED) ----
function openCloseModal(caseId){ closeModal={open:true,caseId,sub:null,note:""}; render(); }
function cancelCloseModal(){ closeModal={open:false,caseId:null,sub:null,note:""}; render(); }
function setCloseSub(v){ closeModal.sub=v; closeModal.note=$("close-note")?.value||""; render(); }
function renderCloseModal(){
  return `<div class="modal-overlay" onclick="if(event.target===this)cancelCloseModal()">
    <div class="modal">
      <h2 class="section" style="font-size:17px">Close this case</h2>
      <p class="muted">Before closing, you must record whether the report was substantiated — was there evidence?</p>
      <div class="radio-cards" style="margin-top:10px">
        <div class="radio-card ${closeModal.sub===true?'sel':''}" onclick="setCloseSub(true)"><b>Substantiated</b><span class="muted">Yes — evidence supported the report.</span></div>
        <div class="radio-card ${closeModal.sub===false?'sel':''}" onclick="setCloseSub(false)"><b>Not substantiated</b><span class="muted">No — evidence did not support it.</span></div>
      </div>
      <label>Closing note (optional)</label>
      <textarea id="close-note" style="min-height:70px">${esc(closeModal.note)}</textarea>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn ghost" onclick="cancelCloseModal()">Cancel</button>
        <button class="btn" ${closeModal.sub===null?'disabled':''} onclick="confirmClose()">Close case</button>
      </div>
    </div></div>`;
}
async function confirmClose(){
  if(closeModal.sub===null) return;
  const note = $("close-note")?.value || "";
  const { error } = await sb.rpc("close_case",{ p_case_id:closeModal.caseId, p_substantiated:closeModal.sub, p_note:note });
  if(error){ alert(errText(error)); return; }
  cancelCloseModal();
}

// ---------------- EMPLOYEE MENTION LOOKUP ----------------
function renderLookup(){
  const results = lookup.query.length>=2 && !lookup.picked ? dirList.filter(d =>
      (d.name||"").toLowerCase().includes(lookup.query.toLowerCase())).slice(0,8) : [];
  return `<div class="card" style="max-width:760px;margin:0 auto">
    <h2 class="section">Employee mention lookup</h2>
    <p class="muted">See how many times an employee has been mentioned across cases, and what their role was each time. Cases you're blocked from are excluded automatically.</p>
    ${lookup.picked ? `
      <div class="kv" style="margin-top:10px"><span class="k">Employee</span><b>${esc(nameOf(lookup.picked))}</b> <span class="muted">· ${esc(roleOf(lookup.picked))}</span>
        <button class="btn sm ghost" style="margin-left:10px" onclick="backToLookup()">change</button></div>
      ${lookup.err?`<div class="banner warn">${esc(lookup.err)}</div>`
        : lookup.result===null?`<div class="card" style="box-shadow:none"><span class="spin"></span></div>`
        : `<div class="banner ${lookup.result.length?'warn':'ok'}"><b>${lookup.result.length}</b> mention(s) in cases you can see.</div>
           ${lookup.result.length?`<table style="margin-top:8px"><thead><tr><th>Case</th><th>Their role</th><th>Status</th><th>Date</th></tr></thead>
           <tbody>${lookup.result.map(r=>`<tr><td><span class="ref">${esc(r.ref)}</span></td><td>${esc(r.role_in_case)}</td><td>${pill(r.state)}</td><td>${fmt(r.created_at)}</td></tr>`).join("")}</tbody></table>`:""}`}`
    : `<label>Find an employee</label>
      <input id="lk" type="text" placeholder="Search a name…" value="${esc(lookup.query)}" oninput="onLookupInput(this.value)">
      ${results.map(d=>`<div class="subj-result" onclick="pickLookup('${d.employee_id}')">${esc(d.name)} — <span class="muted">${esc(d.title||'')}${d.store?' · '+esc(d.store):''}</span></div>`).join("")}`}
  </div>`;
}
function onLookupInput(v){ lookup.query=v; render(); const el=$("lk"); if(el){el.focus();el.setSelectionRange(v.length,v.length);} }
function backToLookup(){ lookup={query:"",picked:null,result:null,err:""}; render(); }
async function pickLookup(id){
  lookup.picked=id; lookup.result=null; lookup.err=""; render();
  const { data, error } = await sb.rpc("mention_lookup",{ p_employee_id:id });
  if(error){ lookup.err = errText(error); } else { lookup.result = data || []; }
  render();
}

// ---------------- STATUS (claim code + my named reports) ----------------
function renderStatus(){
  return `<div class="card">
    <h2 class="section">Check the status of your report</h2>
    <p class="muted">Reported anonymously? Enter your claim code. You'll also get email updates automatically whenever your case changes.</p>
    <label>Claim code</label>
    <div style="display:flex;gap:8px"><input id="cc" type="text" placeholder="e.g. ACDE-4679" value="${esc(statusResult?.tried||'')}"><button class="btn" onclick="doStatusCheck()">Check</button></div>
    ${statusResult ? (statusResult.found ? renderStatusCard(statusResult) : `<div class="banner warn">No report found for that code.</div>`) : ""}
  </div>
  <div class="card">
    <b style="font-size:14px">Reports you submitted with your name</b>
    ${myReports.length?`<table style="margin-top:10px"><thead><tr><th>Ref</th><th>Category</th><th>Status</th><th>Submitted</th></tr></thead>
      <tbody>${myReports.map(c=>`<tr><td><span class="ref">${esc(c.ref)}</span></td><td>${esc(c.category)}</td><td>${pill(c.state)}</td><td>${fmt(c.created_at)}</td></tr>`).join("")}</tbody></table>`
      :'<p class="muted">None found for this email.</p>'}
  </div>`;
}
async function loadMyReports(){
  const { data } = await sb.from("cases").select("ref,category,state,created_at").order("created_at",{ascending:false});
  // RLS returns only rows this user may see; for non-handlers that's just their own named cases
  myReports = (isHandler||isAdmin) ? [] : (data||[]);
}
async function doStatusCheck(){
  const code = $("cc")?.value.trim().toUpperCase(); if(!code) return;
  const { data, error } = await sb.rpc("check_status",{ p_claim_code: code });
  statusResult = error ? {tried:code,found:false} : Object.assign({tried:code}, data);
  render();
}
function renderStatusCard(s){
  return `<div class="divider"></div>
    <div class="kv"><span class="k">Reference</span><span class="ref">${esc(s.ref)}</span></div>
    <div class="kv"><span class="k">Status</span>${pill(s.state)}</div>
    <div class="kv"><span class="k">Handled by</span><span>${esc(s.handler||'—')}</span></div>
    <b style="font-size:13px;display:block;margin-top:14px">Messages with HR</b>
    <div class="msgwrap" style="margin:10px 0">${(s.messages||[]).length?s.messages.map(m=>`<div class="msg ${m.sender==='handler'?'handler':'reporter'}"><div class="who">${m.sender==='handler'?'HR':'You'}</div>${esc(m.body)}</div>`).join(""):'<span class="muted">No messages yet.</span>'}</div>
    <div style="display:flex;gap:8px"><input id="rmsg" type="text" placeholder="Reply to HR (still anonymous)…"><button class="btn sec" onclick="sendReporterReply()">Send</button></div>`;
}
async function sendReporterReply(){
  const v=$("rmsg")?.value.trim(); if(!v)return;
  const { error } = await sb.rpc("reporter_reply",{ p_claim_code: statusResult.tried, p_body: v });
  if(error){ alert(errText(error)); return; }
  await doStatusCheck();
}

// ---------------- helpers / router ----------------
function fmt(ts){ if(!ts) return ""; const d=new Date(ts); return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}); }

function render(){
  renderUserBox(); renderNav();
  const el = $("app");
  if(!session){ el.innerHTML = renderLogin(); return; }
  if((view==="dashboard"||view==="lookup") && !isHandler) view="home";
  if(view==="home"){ el.innerHTML = renderHome(); }
  else if(view==="incident"){ el.innerHTML = renderIncident(); }
  else if(view==="question"){ el.innerHTML = renderQuestion(); }
  else if(view==="status"){ el.innerHTML = renderStatus(); loadMyReports().then(()=>{ if(view==="status"){ el.innerHTML = renderStatus(); } }); }
  else if(view==="lookup"){ el.innerHTML = renderLookup(); }
  else if(view==="dashboard"){
    el.innerHTML = `<div class="card"><span class="spin"></span> Loading cases…</div>`;
    if(selected) renderCaseDetailInto(el, selected); else renderDashboardInto(el);
  } else { el.innerHTML = renderHome(); }
}

boot();
