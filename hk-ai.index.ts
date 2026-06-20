// ===========================================================================
//  Supabase Edge Function:  hk-ai
//  "HK AI" — ask anything about the workshop in plain English. Answers are pulled
//  LIVE from Supabase (kart status, the live track, today's repairs, recent kart
//  notes, stock) and — for managers only — finance. The asking user is identified
//  by their PIN (verified via the existing verify-pin function) so finance / staff
//  data is gated by role. The Anthropic key lives ONLY here (server-side), never
//  in the browser.
//
//  DEPLOY (same as the other functions): Supabase dashboard -> Edge Functions ->
//  Create a new function -> name it exactly  hk-ai  -> paste this -> Deploy.
//  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected for you.
//
//  ONE SECRET TO ADD (dashboard -> Edge Functions -> Secrets / Manage secrets):
//      ANTHROPIC_API_KEY   = your Anthropic API key (sk-ant-...)
//  Optional secret:
//      HK_AI_MODEL         = model id (default: claude-haiku-4-5 — fast + cheap;
//                            set claude-sonnet-4-6 for stronger answers)
//
//  App calls it as:
//    fetch(SB_FN+'hk-ai', {method:'POST', headers:HDRS,
//      body: JSON.stringify({ pin: cu.pin, site: currentSite, question, history }) })
//  Returns: { success:true, answer:"...", role:"Mechanic", model:"..." }
//        or { success:false, message:"..." }
// ===========================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY      = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL         = Deno.env.get("HK_AI_MODEL") || "claude-haiku-4-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const isMgr   = (role: string) => role === "Manager" || role === "Assistant Manager";
const tzOf    = (site: string) => (site === "melbourne" ? "Australia/Melbourne" : "Australia/Sydney");
const dayInTz = (tz: string, d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: tz });          // YYYY-MM-DD
const daysAgo = (tz: string, n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return dayInTz(tz, d); };
const num     = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
const kartNum = (name: unknown) => { const m = String(name ?? "").match(/\d+/); return m ? parseInt(m[0], 10) : 0; };
const shortType = (t: unknown) => { const s = String(t ?? "").replace(/\s*track\s*$/i, "").trim(); return /^intermediate$/i.test(s) ? "Intermediate" : (s || "Kart"); };

// kart status class — mirrors the app's rfStatusClass(code, txt) exactly
function statusClass(code: number | null, txt: string | null): "ok" | "maint" | "damaged" {
  if (code === 2 || /damaged/i.test(txt || "")) return "damaged";
  if (code === 3 || /maintenance/i.test(txt || "")) return "maint";
  return "ok";
}

// Authenticate the asking user by reusing the existing verify-pin function, so this
// function never needs to know how PINs are stored — and gets the authoritative role.
async function verifyUser(pin: string): Promise<{ name: string; role: string } | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/verify-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify({ pin }),
    });
    const m = await r.json().catch(() => ({} as any));
    if (m && m.success) return { name: String(m.name || "there"), role: String(m.role || "Mechanic") };
    return null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, message: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ success: false, message: "Bad JSON" }, 400); }

  const pin      = String(body?.pin ?? "");
  const question = String(body?.question ?? "").trim();
  const site     = String(body?.site ?? "sydney").toLowerCase();
  const history  = Array.isArray(body?.history) ? body.history : [];
  if (!question) return json({ success: false, message: "Ask me a question." }, 400);
  if (!/^\d{4,8}$/.test(pin)) return json({ success: false, message: "Sign in first." }, 401);

  const user = await verifyUser(pin);
  if (!user) return json({ success: false, message: "Couldn't verify your PIN — sign in again." }, 401);
  const mgr = isMgr(user.role);

  if (!ANTHROPIC_KEY) {
    return json({ success: false, message: "HK AI isn't switched on yet — an Anthropic API key needs to be added to this function's secrets." }, 503);
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const tz = tzOf(site);
  const today = dayInTz(tz);

  // ---- gather live context (best-effort: a failed slice is just omitted) ----
  const ctx: any = { site, today };
  const kartMap: Record<number, { num: number; type: string }> = {};
  let kartIds: number[] = [];

  // karts
  try {
    const { data } = await db.from("rf_karts").select("rf_id,name,type,status,status_code,long_term").eq("site", site).limit(5000);
    const ks = data || [];
    const cnt = { ok: 0, maint: 0, damaged: 0 };
    const byType: Record<string, { total: number; usable: number; damaged: number; maintenance: number }> = {};
    const notRunning: string[] = [];
    const longTermList: string[] = [];
    for (const k of ks) {
      if (k.rf_id != null) { kartIds.push(k.rf_id); kartMap[k.rf_id] = { num: kartNum(k.name), type: shortType(k.type) }; }
      if (k.long_term) { longTermList.push(`${shortType(k.type)} ${k.name}`); continue; }   // set aside — can't be fixed right now; excluded from the usable/damaged picture
      const c = statusClass(k.status_code, k.status);
      cnt[c]++;
      const t = shortType(k.type);
      byType[t] = byType[t] || { total: 0, usable: 0, damaged: 0, maintenance: 0 };
      byType[t].total++;
      if (c === "damaged") { byType[t].damaged++; notRunning.push(`${t} ${k.name} — damaged`); }
      else { byType[t].usable++; if (c === "maint") { byType[t].maintenance++; notRunning.push(`${t} ${k.name} — maintenance`); } }
    }
    ctx.karts = { total: ks.length, fixableFleet: ks.length - longTermList.length, usable: cnt.ok + cnt.maint, ok: cnt.ok, maintenance: cnt.maint, damaged: cnt.damaged, byType, notRunning: notRunning.slice(0, 50), longTerm: { count: longTermList.length, karts: longTermList.slice(0, 50) } };
  } catch { /* omit */ }

  // live track
  try {
    const { data } = await db.from("tracks").select("name,direction,live").eq("site", site).eq("live", true);
    ctx.liveTrack = (data || []).map((t: any) => ({ name: t.name, direction: t.direction || null }));
  } catch { /* omit */ }

  // today's repairs (scoped to this site's karts) + parts replaced today
  try {
    const { data: reps0 } = await db.from("rf_repairs").select("id,cost,mechanic,description,rf_kart_id,date_discovered").eq("date_discovered", today).limit(4000);
    let reps = reps0 || [];
    if (kartIds.length) { const ids = new Set(kartIds); reps = reps.filter((r: any) => ids.has(r.rf_kart_id)); }
    const byMech: Record<string, { jobs: number; cost: number }> = {};
    for (const r of reps) { const m = r.mechanic || "Unassigned"; byMech[m] = byMech[m] || { jobs: 0, cost: 0 }; byMech[m].jobs++; byMech[m].cost += num(r.cost); }
    ctx.repairsToday = {
      count: reps.length,
      byMechanic: Object.entries(byMech).map(([name, v]) => ({ name, jobs: v.jobs, cost: Math.round(v.cost) })).sort((a, b) => b.jobs - a.jobs),
    };
    const repIds = reps.map((r: any) => r.id).filter((x: any) => x != null);
    if (repIds.length) {
      const pm: Record<string, number> = {};
      for (let i = 0; i < repIds.length; i += 200) {
        const { data: pd } = await db.from("rf_repair_parts").select("part_name,qty,repair_id").in("repair_id", repIds.slice(i, i + 200)).limit(8000);
        for (const p of (pd || [])) { const n = p.part_name || "Part"; pm[n] = (pm[n] || 0) + num(p.qty); }
      }
      ctx.repairsToday.partsReplaced = Object.entries(pm).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty).slice(0, 20);
    }
  } catch { /* omit */ }

  // today's open discrepancies
  try {
    const { data } = await db.from("rf_discrepancies").select("rf_kart_name,message,part_name,mechanic,kind,status,day").eq("day", today).neq("status", "resolved").limit(60);
    ctx.discrepanciesToday = (data || []).map((d: any) => ({ kart: d.rf_kart_name, part: d.part_name, mechanic: d.mechanic, kind: d.kind, message: d.message }));
  } catch { /* omit */ }

  // recent active kart notes (label by kart number/type)
  try {
    const { data } = await db.from("rf_kart_notes").select("rf_kart_id,note,created_at,created_by").eq("site", site).eq("active", true).order("created_at", { ascending: false }).limit(25);
    ctx.recentNotes = (data || []).map((n: any) => {
      const k = kartMap[n.rf_kart_id];
      return { kart: k ? `${k.type} ${k.num}` : `kart ${n.rf_kart_id}`, note: n.note, by: n.created_by || null, at: n.created_at };
    });
  } catch { /* omit */ }

  // damage points — last 30 days: top parts replaced + busiest karts (this site)
  try {
    const { data: reps0 } = await db.from("rf_repairs").select("id,rf_kart_id,date_discovered").gte("date_discovered", daysAgo(tz, 30)).limit(8000);
    let reps = reps0 || [];
    if (kartIds.length) { const ids = new Set(kartIds); reps = reps.filter((r: any) => ids.has(r.rf_kart_id)); }
    const byKart: Record<number, number> = {};
    for (const r of reps) byKart[r.rf_kart_id] = (byKart[r.rf_kart_id] || 0) + 1;
    const topKarts = Object.entries(byKart)
      .map(([id, n]) => { const k = kartMap[Number(id)]; return { kart: k ? `${k.type} ${k.num}` : `kart ${id}`, repairs: n }; })
      .sort((a, b) => b.repairs - a.repairs).slice(0, 10);
    const repIds = reps.map((r: any) => r.id).filter((x: any) => x != null);
    const pm: Record<string, number> = {};
    for (let i = 0; i < repIds.length; i += 200) {
      const { data: pd } = await db.from("rf_repair_parts").select("part_name,qty,repair_id").in("repair_id", repIds.slice(i, i + 200)).limit(8000);
      for (const p of (pd || [])) { const n = p.part_name || "Part"; pm[n] = (pm[n] || 0) + num(p.qty); }
    }
    const topParts = Object.entries(pm).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty).slice(0, 12);
    ctx.last30Days = { repairs: reps.length, topPartsReplaced: topParts, busiestKarts: topKarts };
  } catch { /* omit */ }

  // low stock + (for managers) finance — both read `parts` once
  let partsAll: any[] = [];
  try {
    const { data } = await db.from("parts").select("sku,description,qty,reorder,price").eq("site", site).limit(5000);
    partsAll = data || [];
    ctx.lowStock = partsAll.filter((p: any) => num(p.qty) <= num(p.reorder))
      .map((p: any) => ({ name: p.description, sku: p.sku, qty: num(p.qty), reorder: num(p.reorder) })).slice(0, 60);
  } catch { /* omit */ }

  if (mgr) {
    try {
      const pMap: Record<string, number> = {};
      let stockValue = 0;
      for (const p of partsAll) { const price = num(p.price); pMap[p.sku] = price; stockValue += price * num(p.qty); }
      const ym = today.slice(0, 7), yr = today.slice(0, 4), since90 = daysAgo(tz, 90);
      const { data: logs } = await db.from("logs").select("sku,qty,ts,action").eq("site", site).eq("action", "TAKEN").limit(20000);
      let spendMonth = 0, spendYTD = 0;
      const usage90: Record<string, number> = {};
      for (const l of (logs || [])) {
        const d = new Date(l.ts); if (isNaN(d.getTime())) continue;
        const dl = dayInTz(tz, d);
        const cost = (pMap[l.sku] || 0) * num(l.qty);
        if (dl.slice(0, 4) === yr) spendYTD += cost;
        if (dl.slice(0, 7) === ym) spendMonth += cost;
        if (dl >= since90) usage90[l.sku] = (usage90[l.sku] || 0) + num(l.qty);
      }
      let forecastCost = 0;
      const forecastItems: any[] = [];
      for (const p of partsAll) {
        if (num(p.qty) > num(p.reorder)) continue;
        const u = usage90[p.sku] || 0, oq = Math.max(1, Math.ceil(u * 2)), cost = oq * num(p.price);
        if (cost > 0) { forecastCost += cost; forecastItems.push({ name: p.description, qty: num(p.qty), orderQty: oq, cost: Math.round(cost) }); }
      }
      forecastItems.sort((a, b) => b.cost - a.cost);
      ctx.finance = {
        currency: "AUD",
        stockValue: Math.round(stockValue),
        spendThisMonth: Math.round(spendMonth),
        spendYTD: Math.round(spendYTD),
        reorderForecastCost: Math.round(forecastCost),
        reorderForecastItems: forecastItems.slice(0, 15),
      };
    } catch { /* omit */ }
  }

  // ---- hardware reference: the SAME high-level text the app shows in Kart Info -> Wiring.
  //      It deliberately has NO pin numbers / wire colours / voltages — see the safety rule below.
  const hardwareRef = [
    "Main Power Loop: Battery (+) -> Main fuse (60A) -> Master switch -> Motor controller (+). Battery (-) -> Chassis ground -> Motor controller (-). Charging port -> Battery management (BMS) -> Battery pack.",
    "Control Signals: Throttle pedal -> TPS (3-pin) -> Motor controller signal input. Brake pedal -> Brake switch -> Motor controller brake cut. Speed-mode button -> CPU board -> Motor controller mode select.",
    "CPU & Telemetry: CPU board -> WiFi antenna (top of kart). CPU board -> Transponder (in dash). CPU board -> Beacon antenna (underneath, front-center). CPU board -> 12V regulator (from main battery).",
  ].join("\n");

  // ---- system prompt ----
  const system =
    `You are HK AI, the in-app assistant for Hyper Karting's go-kart workshop app (parts inventory, kart fleet, repairs, stock). ` +
    `You're talking to ${user.name}, role: ${user.role}. Active site: "${site}". Today is ${today} (${tz}).\n\n` +
    `STYLE: brief, plain, direct — usually one or two sentences, numbers first. No preamble, no markdown headings, no bullet dumps unless asked for a list. ` +
    `Answer ONLY from the live data and hardware reference below. If something needed isn't in the context, say you don't have it in view rather than guessing.\n\n` +
    `ROLE GATING: ${mgr
      ? "This user is a manager — finance, stock value and spend answers are allowed."
      : "This user is a MECHANIC — do NOT reveal finance, stock value, spend, money figures, or staff PINs. If asked, say that's manager-only."}\n\n` +
    `HARDWARE SAFETY (critical): The hardware reference is high-level wiring only — it has NO pin numbers, pin-to-pin connections, wire colours, or voltages. ` +
    `If asked for a specific pin (e.g. "where does pin 12 of the WiFi chip go"), a wire colour, or a voltage (e.g. "volts on pin 6 of the CON sensor"), you MUST NOT guess, infer, or estimate — a wrong electrical spec can destroy a board. ` +
    `Say it isn't in the documented reference yet and to check the official RiMO documentation (or ask Harvey to add the pinout docs). Only state a hardware fact if it appears verbatim in the reference below.\n\n` +
    `DEFINITION: "usable" karts = OK + For-Maintenance (both can still run); Damaged cannot run. Long-term-damaged karts (karts.longTerm) can't be fixed right now and are set aside — they are EXCLUDED from usable/ok/maintenance/damaged and byType; "fixableFleet" is the whole fleet minus those, and "total" is the whole fleet. Report long-term separately if asked.\n\n` +
    `=== LIVE WORKSHOP DATA (JSON) ===\n${JSON.stringify(ctx)}\n\n` +
    `=== HARDWARE REFERENCE (the only hardware facts you may state) ===\n${hardwareRef}`;

  // ---- conversation ----
  const msgs: Array<{ role: string; content: string }> = [];
  for (const h of history.slice(-6)) {
    const role = h && h.role === "assistant" ? "assistant" : "user";
    const content = String((h && h.content) ?? "").slice(0, 4000);
    if (content) msgs.push({ role, content });
  }
  msgs.push({ role: "user", content: question.slice(0, 4000) });

  // ---- call Anthropic (server-side; the key never leaves this function) ----
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: msgs }),
    });
    const data = await r.json().catch(() => ({} as any));
    if (!r.ok) {
      const m = (data && (data.error?.message || data.message)) || `Anthropic error ${r.status}`;
      return json({ success: false, message: r.status === 401 ? "HK AI's API key is missing or invalid." : `HK AI error: ${m}` }, 502);
    }
    const answer = Array.isArray(data.content)
      ? data.content.filter((b: any) => b && b.type === "text").map((b: any) => b.text).join("").trim()
      : "";
    return json({ success: true, answer: answer || "(no answer)", role: user.role, model: MODEL });
  } catch {
    return json({ success: false, message: "HK AI is unreachable right now — try again in a moment." }, 502);
  }
});
