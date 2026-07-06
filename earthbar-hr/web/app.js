// Earthbar HR Case Management — frontend (Supabase + Microsoft SSO)
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.EARTHBAR_CONFIG || {};
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const CATEGORIES = ["Harassment / discrimination","Manager conduct","Workplace safety","Pay / hours dispute","Policy violation","Other"];
const NEXT = {
  Submitted:["Triage"], Triage:["Assigned","Escalated"], Assigned:["UnderReview"],
  UnderReview:["Action","OnHold"], Action:["Resolved"], Resolved:["Closed","UnderReview"],
  OnHold:["UnderReview"], Escalated:["Assigned"], Closed:["UnderReview"],
};
const SLABEL = { UnderReview:"Under Review", OnHold:"On Hold" };
const stlabel = s => SLABEL[s] || s;

// ---- state ----
let session = null, me = null, isHandler = false, isAdmin = false;
let dirList = [], dirMap = {};
let view = "submit", selected = null, busy = false;
let form = { mode:"named", category:CATEGORIES[0], subjectIds:[], subjQuery:"", description:"" };
let receipt = null, statusResult = null, errorMsg = "";

const $ = id => document.getElementById(id);
const esc = s => (s==null?"":String(s)).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
const nameOf = id => dirMap[id]?.name || id || "—";
const roleOf = id => dirMap[id]?.title || "";
const pill = s => `<span class="pill dot s-${s}">${stlabel(s)}</span>`;

// expose handlers used from inline onclick
Object.assign(window, { go, signInMicrosoft, signOut, setMode, submitForm, addSubject, rmSubject,
  onSubjInput, openCase, closeCase, doAdvance, sendHandlerMsg, doStatusCheck, sendReporterReply, setCategory });

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
  // directory (RLS: any authenticated user may read)
  const { data: dir } = await sb.from("directory").select("employee_id,name,email,title,store,manager_id");
  dirList = dir || [];
  dirMap = Object.fromEntries(dirList.map(d => [d.employee_id, d]));
  me = dirList.find(d => (d.email||"").toLowerCase() === email) || { name: session.user.user_metadata?.name || email, title:"Employee", email };
  const [a, h] = await Promise.all([ sb.rpc("app_is_admin"), sb.rpc("app_is_handler") ]);
  isAdmin = !!a.data; isHandler = !!h.data;
  if (view === "dashboard" && !isHandler) view = "submit";
}
async function signInMicrosoft(){
  await sb.auth.signInWithOAuth({ provider:"azure",
    options:{ scopes:"openid email profile", redirectTo: window.location.href.split("#")[0] } });
}
async function signOut(){ await sb.auth.signOut(); me=null; view="submit"; selected=null; render(); }

// ---------------- NAV ----------------
function tabs(){
  const t = [{id:"submit",label:"Submit a report"},{id:"status",label:"Check my report status"}];
  if (isHandler) t.splice(1,0,{id:"dashboard",label:"HR dashboard 🔒"});
  return t;
}
function go(v){ if (v==="dashboard" && !isHandler) v="submit"; view=v; selected=null; receipt=null; errorMsg=""; render(); }

function renderNav(){
  $("nav").innerHTML = session ? tabs().map(t=>`<button class="${view===t.id?'active':''}" onclick="go('${t.id}')">${t.label}</button>`).join("") : "";
}
function renderUserBox(){
  const el = $("userbox"); if (!el) return;
  if (!session){ el.innerHTML=""; return; }
  el.style.display="flex"; el.style.alignItems="center"; el.style.gap="12px";
  el.innerHTML = `<span style="font-size:12px;text-align:right;line-height:1.2;color:#fff">${esc(me?.name||session.user.email)}<br>
    <span style="opacity:.8">${esc(me?.title||"Employee")}</span></span>
    <button onclick="signOut()" style="background:rgba(255,255,255,.16);color:#fff;border:none;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">Sign out</button>`;
}

// ---------------- LOGIN ----------------
function renderLogin(){
  const ok = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT");
  return `<div class="card" style="max-width:520px;margin:40px auto">
    <h2 class="section">Sign in to Earthbar HR</h2>
    <p class="muted">Sign in with your Earthbar Microsoft account. Only verified @earthbar.com accounts can access this system.</p>
    ${ok ? `<div style="margin-top:16px"><button class="btn ms" onclick="signInMicrosoft()">
      <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true"><rect width="10" height="10" x="1" y="1" fill="#F25022"/><rect width="10" height="10" x="12" y="1" fill="#7FBA00"/><rect width="10" height="10" x="1" y="12" fill="#00A4EF"/><rect width="10" height="10" x="12" y="12" fill="#FFB900"/></svg>
      Sign in with Microsoft</button></div>`
    : `<div class="banner err" style="margin-top:14px">Configuration needed: set <b>SUPABASE_URL</b> and <b>SUPABASE_ANON_KEY</b> in <code>config.js</code>, and enable the Azure provider in Supabase Auth. See the README.</div>`}
    <p class="note-sm" style="margin-top:14px">Anyone reporting anonymously can still check status without signing in, using their claim code.</p>
  </div>`;
}

// ---------------- SUBMIT ----------------
function renderSubmit(){
  const results = form.subjQuery.length>=2 ? dirList.filter(d =>
      (d.name||"").toLowerCase().includes(form.subjQuery.toLowerCase()) ||
      (d.title||"").toLowerCase().includes(form.subjQuery.toLowerCase())
    ).slice(0,8) : [];
  return `<div class="card">
    <h2 class="section">Submit an HR report</h2>
    <p class="muted">You choose whether to attach your name. Either way, only the assigned handler can see this — never anyone the report is about.</p>
    <label>How do you want to submit?</label>
    <div class="radio-cards">
      <div class="radio-card ${form.mode==='named'?'sel':''}" onclick="setMode('named')"><b>With my name</b><span class="muted">HR can follow up with you directly.</span></div>
      <div class="radio-card ${form.mode==='anon'?'sel':''}" onclick="setMode('anon')"><b>Anonymously</b><span class="muted">No identity stored. You get a claim code to check status and message HR.</span></div>
    </div>
    ${form.mode==='named'
      ? `<div class="banner info" style="margin-top:10px">Submitting as <b>${esc(me?.name||session.user.email)}</b> — ${esc(me?.title||"Employee")}.</div>`
      : `<div class="banner ok" style="margin-top:10px">You're signed in (so we know you're Earthbar staff), but this report will carry <b>no identity</b>.</div>`}
    <label>Category</label>
    <select onchange="setCategory(this.value)">${CATEGORIES.map(c=>`<option ${form.category===c?'selected':''}>${c}</option>`).join("")}</select>
    <label>Who is this about? <span class="muted" style="font-weight:400">(optional — drives conflict-of-interest routing)</span></label>
    <input id="subj" type="text" placeholder="Search a name or title…" value="${esc(form.subjQuery)}" oninput="onSubjInput(this.value)">
    ${results.map(d=>`<div class="subj-result" onclick="addSubject('${d.employee_id}')">${esc(d.name)} — <span class="muted">${esc(d.title||'')}${d.store?' · '+esc(d.store):''}</span></div>`).join("")}
    <div style="margin-top:8px">${form.subjectIds.map(id=>`<span class="chip" style="margin-right:6px">${esc(nameOf(id))} <a onclick="rmSubject('${id}')" style="cursor:pointer;color:var(--red)">✕</a></span>`).join("") || '<span class="muted">No one added yet.</span>'}</div>
    <label>What happened?</label>
    <textarea id="desc" placeholder="Describe the situation. If anonymous, avoid details that would reveal who you are.">${esc(form.description)}</textarea>
    ${errorMsg?`<div class="banner err">${esc(errorMsg)}</div>`:""}
    <div style="margin-top:18px"><button class="btn" onclick="submitForm()" ${busy?'disabled':''}>${busy?'<span class="spin"></span> Submitting…':'Submit report'}</button></div>
  </div>
  ${receipt?renderReceipt(receipt):""}`;
}
function setMode(m){ form.mode=m; render(); }
function setCategory(c){ form.category=c; }
function onSubjInput(v){ form.subjQuery=v; render(); const el=$("subj"); if(el){el.focus();el.setSelectionRange(v.length,v.length);} }
function addSubject(id){ if(!form.subjectIds.includes(id)) form.subjectIds.push(id); form.subjQuery=""; render(); }
function rmSubject(id){ form.subjectIds=form.subjectIds.filter(x=>x!==id); render(); }
async function submitForm(){
  form.description = $("desc")?.value || "";
  errorMsg="";
  if(!form.description.trim()){ errorMsg="Please describe what happened."; render(); return; }
  busy=true; render();
  const { data, error } = await sb.rpc("submit_case", {
    p_category: form.category, p_description: form.description,
    p_anonymous: form.mode==="anon", p_subject_ids: form.subjectIds });
  busy=false;
  if(error){ errorMsg = "Could not submit: "+error.message; render(); return; }
  receipt = data;
  form = { mode:"named", category:CATEGORIES[0], subjectIds:[], subjQuery:"", description:"" };
  render(); window.scrollTo({top:99999,behavior:"smooth"});
}
function renderReceipt(r){
  return `<div class="card">
    <div class="banner ok"><b>✓ Report received.</b> Reference <span class="ref">${esc(r.ref)}</span></div>
    ${r.anonymous ? `<p class="muted">Save this claim code. It's the only way to check status or message HR — we store no identity.</p>
      <div class="codebox">${esc(r.claim_code)}</div>
      <p class="note-sm">Shown once. Check it any time under “Check my report status”.</p>`
      : `<p class="muted">You submitted with your name. The assigned handler can follow up with you directly.</p>`}
    <div class="divider"></div>
    <div class="kv"><span class="k">Routed to</span><b>${esc(r.handler)}</b>${r.external?' <span class="warnbadge" style="margin-left:8px">EXTERNAL</span>':''}</div>
    <div class="kv"><span class="k">Why</span><span>${r.route_reason==='default'?'Default handler — no conflict of interest.':r.route_reason==='conflict_reroute'?'Rerouted — the usual handler was connected to this case.':'All internal HR handlers were conflicted → external advisor.'}</span></div>
  </div>`;
}

// ---------------- DASHBOARD ----------------
async function renderDashboardInto(el){
  const { data:cases, error } = await sb.from("cases")
    .select("id,ref,category,severity,anonymous,reporter_email,handler_id,external,state,created_at, tasks(status,due_at)")
    .order("created_at",{ascending:false});
  if(error){ el.innerHTML = `<div class="card"><div class="banner err">Could not load cases: ${esc(error.message)}</div></div>`; return; }
  const now = Date.now();
  const overdue = c => (c.tasks||[]).some(t => t.status==="open" && t.due_at && new Date(t.due_at).getTime() < now);
  const open = cases.filter(c=>c.state!=="Closed").length;
  const od = cases.filter(overdue).length;
  const ext = cases.filter(c=>c.external).length;
  const scope = isAdmin ? "You have HR-leadership access: all cases except any you're personally involved in."
                        : "You see cases assigned to you, and none you're involved in.";
  el.innerHTML = `<div class="card">
      <h2 class="section">HR case dashboard <span class="chip" style="vertical-align:middle">${esc(me?.title||'Handler')}</span></h2>
      <p class="muted">${scope}</p>
      <div class="row" style="margin:14px 0 4px">
        <div class="stat"><div class="n">${cases.length}</div><div class="l">Cases you can see</div></div>
        <div class="stat"><div class="n">${open}</div><div class="l">Open</div></div>
        <div class="stat"><div class="n" style="color:${od?'var(--red)':'var(--green-dk)'}">${od}</div><div class="l">SLA overdue</div></div>
        <div class="stat"><div class="n">${ext}</div><div class="l">Escalated to external</div></div>
      </div>
      <p class="note-sm">🔒 Cases naming you (or someone above you who is named) are hidden by the database and never sent to your browser.</p>
    </div>
    <div class="card" style="padding:8px 0"><table>
      <thead><tr><th style="padding-left:20px">Ref</th><th>Category</th><th>Reporter</th><th>Handler</th><th>State</th><th>SLA</th></tr></thead>
      <tbody>${cases.length ? cases.map(c=>`<tr class="clk" onclick="openCase('${c.id}')">
        <td style="padding-left:20px"><span class="ref">${esc(c.ref)}</span>${c.severity==='High'?' <span class="warnbadge">High</span>':''}</td>
        <td>${esc(c.category)}</td>
        <td>${c.anonymous?'<span class="chip">Anonymous</span>':esc(c.reporter_email||'—')}</td>
        <td>${c.external?'External advisor <span class="warnbadge">EXT</span>':esc(nameOf(c.handler_id))}</td>
        <td>${pill(c.state)}</td>
        <td>${overdue(c)?'<span class="pill dot s-Escalated">Overdue</span>':'<span class="pill dot s-Resolved">On track</span>'}</td>
      </tr>`).join("") : `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--grey)">No cases assigned to you right now.</td></tr>`}</tbody>
    </table></div>`;
}
function openCase(id){ selected=id; render(); window.scrollTo({top:0,behavior:"smooth"}); }
function closeCase(){ selected=null; render(); }

async function renderCaseDetailInto(el, id){
  const [{data:c}, {data:parties}, {data:events}, {data:tasks}, {data:messages}] = await Promise.all([
    sb.from("cases").select("*").eq("id",id).maybeSingle(),
    sb.from("case_parties").select("subject_id").eq("case_id",id),
    sb.from("case_events").select("*").eq("case_id",id).order("at",{ascending:true}),
    sb.from("tasks").select("*").eq("case_id",id).order("created_at",{ascending:true}),
    sb.from("messages").select("*").eq("case_id",id).order("created_at",{ascending:true}),
  ]);
  if(!c){ el.innerHTML=`<button class="back" onclick="closeCase()">← Back</button><div class="card"><div class="banner warn">This case isn't available to you.</div></div>`; return; }
  const handlerName = c.external ? "External advisor" : nameOf(c.handler_id);
  const nexts = NEXT[c.state] || [];
  const now = Date.now();
  const evIcon = {created:"📥",routed:"🧭",task:"⏰",state:"🔄",reminder:"🔔",escalation:"⚠️",notify:"✉️"};
  el.innerHTML = `<button class="back" onclick="closeCase()">← Back to dashboard</button>
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px"><span class="ref" style="font-size:16px">${esc(c.ref)}</span>${pill(c.state)}${c.severity==='High'?'<span class="warnbadge">High severity</span>':''}</div>
    <h2 class="section" style="margin-top:6px">${esc(c.category)}</h2>
    <div class="row">
      <div class="col">
        <div class="kv"><span class="k">Reporter</span>${c.anonymous?'<span class="chip">Anonymous — identity not stored</span>':`<b>${esc(c.reporter_email||'—')}</b>`}</div>
        <div class="kv"><span class="k">About</span><span>${(parties||[]).map(p=>esc(nameOf(p.subject_id))+' ('+esc(roleOf(p.subject_id))+')').join(", ")||'—'}</span></div>
        <div class="kv"><span class="k">Handler</span><b>${esc(handlerName)}</b>${c.external?' <span class="warnbadge">EXTERNAL</span>':''}</div>
        <div class="kv"><span class="k">Route reason</span><span>${esc((c.route_reason||'').replace(/_/g,' '))}</span></div>
      </div>
      <div class="col"><div class="kv"><span class="k">Description</span></div><div class="banner" style="background:#fff;border:1px solid var(--line)">${esc(c.description)}</div></div>
    </div>
    <div class="divider"></div>
    <b style="font-size:13px">Advance case state</b>
    <div style="margin-top:8px">${nexts.length?nexts.map(n=>`<button class="btn sm sec" style="margin-right:8px" onclick="doAdvance('${c.id}','${n}')">→ ${stlabel(n)}</button>`).join(""):'<span class="muted">Case is closed.</span>'}</div>
  </div>
  <div class="row">
    <div class="col card"><b>Follow-up tasks &amp; SLAs</b><div style="margin-top:10px">
      ${(tasks||[]).length?tasks.map(t=>{const over=t.status==="open"&&t.due_at&&new Date(t.due_at).getTime()<now;
        return `<div class="task"><span>${t.status==='done'?"✅":over?"🔴":"🟢"}</span>
          <span style="${t.status==='done'?'text-decoration:line-through;color:var(--grey)':''}">${esc(t.title)}</span>
          <span class="due" style="color:${over?'var(--red)':'var(--grey)'}">${t.status==='done'?'done':(over?'overdue':'due '+fmt(t.due_at))}</span></div>`;}).join(""):'<span class="muted">No tasks.</span>'}
    </div></div>
    <div class="col card"><b>Case timeline (audit log)</b><ul class="timeline" style="margin-top:10px">
      ${(events||[]).map(e=>`<li><div class="t">${fmt(e.at)} · ${evIcon[e.type]||"•"} ${esc(e.type)}</div><div class="e">${esc(e.note)}</div></li>`).join("")}
    </ul></div>
  </div>
  <div class="card"><b>Messages ${c.anonymous?'<span class="chip">via claim code — reporter stays anonymous</span>':''}</b>
    <div class="msgwrap" style="margin:12px 0">${(messages||[]).length?messages.map(m=>`<div class="msg ${m.sender_type}"><div class="who">${m.sender_type==='handler'?esc(handlerName):(c.anonymous?'Anonymous reporter':esc(c.reporter_email||'Reporter'))}</div>${esc(m.body)}</div>`).join(""):'<span class="muted">No messages yet.</span>'}</div>
    <div style="display:flex;gap:8px"><input id="hmsg" type="text" placeholder="Message the reporter…"><button class="btn" onclick="sendHandlerMsg('${c.id}')">Send</button></div>
  </div>`;
}
async function doAdvance(id,to){ const {error}=await sb.rpc("advance_state",{p_case_id:id,p_to:to}); if(error)alert(error.message); render(); }
async function sendHandlerMsg(id){ const v=$("hmsg")?.value.trim(); if(!v)return; const {error}=await sb.rpc("post_handler_message",{p_case_id:id,p_body:v}); if(error)alert(error.message); render(); }

// ---------------- STATUS (anonymous / claim code) ----------------
function renderStatus(){
  return `<div class="card">
    <h2 class="section">Check the status of your report</h2>
    <p class="muted">Enter the claim code you received when you submitted anonymously.</p>
    <label>Claim code</label>
    <div style="display:flex;gap:8px"><input id="cc" type="text" placeholder="e.g. ACDE-4679" value="${esc(statusResult?.tried||'')}"><button class="btn" onclick="doStatusCheck()">Check</button></div>
    ${statusResult ? (statusResult.found ? renderStatusCard(statusResult) : `<div class="banner warn">No report found for that code.</div>`) : ""}
  </div>`;
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
  if(error){ alert(error.message); return; }
  await doStatusCheck();
}

// ---------------- helpers / router ----------------
function fmt(ts){ if(!ts) return ""; const d=new Date(ts); return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}); }

function render(){
  renderUserBox(); renderNav();
  const el = $("app");
  if(!session){ el.innerHTML = renderLogin(); return; }
  if(view==="dashboard" && !isHandler) view="submit";
  if(view==="submit"){ el.innerHTML = renderSubmit(); }
  else if(view==="status"){ el.innerHTML = renderStatus(); }
  else if(view==="dashboard"){
    el.innerHTML = `<div class="card"><span class="spin"></span> Loading cases…</div>`;
    if(selected) renderCaseDetailInto(el, selected); else renderDashboardInto(el);
  } else { el.innerHTML = renderSubmit(); }
}

boot();
