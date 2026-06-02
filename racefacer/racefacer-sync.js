// racefacer-sync.js
// Logs in to RaceFacer (HKWS), pulls each kart's details/repairs/parts, parses them,
// writes them to Supabase, then reconciles the day's repairs against app stock scan-outs
// and writes the discrepancy notifications. Designed to run on a schedule (end of day).
//
// Node 18+. Handles RaceFacer's self-signed certificate via an undici Agent.
//
// Env: RF_BASE, RF_USER, RF_PASS, SB_URL, SB_SERVICE_KEY
// Optional: RF_KART_IDS (comma list), RF_KART_TYPE_UUIDS (comma list), SITE (default sydney)

const { fetch, Agent } = require('undici');
const { parseKartDetails, parseRepairs, parseParts } = require('./racefacer-parse');
const { reconcileDay } = require('./racefacer-reconcile');

const RF_BASE = process.env.RF_BASE || 'https://103.166.146.163';
const RF_USER = process.env.RF_USER, RF_PASS = process.env.RF_PASS;
const SB_URL = process.env.SB_URL, SB_KEY = process.env.SB_SERVICE_KEY;
const SITE = process.env.SITE || 'sydney';

const insecure = new Agent({ connect: { rejectUnauthorized: false } }); // accept the self-signed cert

// ---- tiny cookie jar ----
const jar = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';'); const i = pair.indexOf('=');
    if (i > 0) {
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (v && v.toLowerCase() !== 'deleted') jar[k] = v; // don't let a stray response clear our session
    }
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

// Turn RaceFacer type + number into the team's label, e.g. "Adult Track" + "19" -> "Adult 19".
function kartLabel(type, name) {
  const t = (type || '').replace(/\s*track\s*$/i, '').trim()
    .replace(/^intermediate$/i, 'Inter');
  const n = (name || '').trim();
  return t ? `${t} ${n}`.trim() : (n || null);
}

async function rf(path, { method = 'GET', body, headers = {}, ajax = false } = {}) {
  // RaceFacer's ajax/* endpoints only return JSON when the request looks like an XHR (what jQuery sends).
  const ajaxHeaders = ajax ? { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' } : {};
  const res = await fetch(path.startsWith('http') ? path : RF_BASE + path, {
    method, body, redirect: 'manual', dispatcher: insecure,
    headers: { 'Cookie': cookieHeader(), 'User-Agent': 'Mozilla/5.0 HKWorkshopSync/1.0', ...ajaxHeaders, ...headers },
  });
  storeCookies(res);
  return res;
}

// fetch an ajax endpoint and parse JSON; clear error (with HTTP status) if it isn't JSON
async function rfJson(path, tries = 3) {
  let res, text;
  for (let i = 0; i < tries; i++) {
    res = await rf(path, { ajax: true });
    text = await res.text();
    if (text) { try { return JSON.parse(text); } catch { /* empty/garbled -> retry */ } }
    if (i < tries - 1) await sleep(400 * (i + 1)); // brief back-off, then try again
  }
  throw new Error(`HTTP ${res.status}${res.headers.get('location') ? ' -> ' + res.headers.get('location') : ''} (not JSON): ${(text || '').slice(0, 80).replace(/\s+/g, ' ') || '<empty>'}`);
}

// ---- login ----
async function login() {
  const page = await (await rf('/en/auth/login')).text();
  const formMatch = page.match(/<form[^>]*action="([^"]*login[^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  const action = formMatch ? formMatch[1] : '/en/auth/login';
  const formHtml = formMatch ? formMatch[2] : page;
  const body = new URLSearchParams();
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]*)"/) || [])[1]; if (!name) continue;
    const type = (tag.match(/type="([^"]*)"/) || [])[1] || 'text';
    const val = (tag.match(/value="([^"]*)"/) || [])[1] || '';
    if (type === 'password') body.set(name, RF_PASS);
    else if (type === 'hidden') body.set(name, val);
    else if (/user|email|login|name/i.test(name)) body.set(name, RF_USER);
  }
  body.set('username', RF_USER);   // confirmed field name from the login payload
  body.set('password', RF_PASS);
  console.log('[login] action=%s fields=%s', action, [...body.keys()].join(','));

  const res = await rf(action, { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  console.log('[login] POST status=%s location=%s', res.status, res.headers.get('location') || '(none)');
  if (!jar['laravel_session']) throw new Error(`login failed (status ${res.status}); no session cookie`);
  return true;
}

// ---- one-time diagnostic probe so we can see exactly what RaceFacer replies ----
async function probe() {
  try {
    const a = await rf('/en/administration');
    console.log('[probe] /en/administration -> status=%s location=%s', a.status, a.headers.get('location') || '(none)');
    const b = await rf('/ajax/garage/kart-details?id=47', { ajax: true });
    const t = await b.text();
    console.log('[probe] kart-details?id=47 -> status=%s location=%s body=%s',
      b.status, b.headers.get('location') || '(none)', JSON.stringify(t.slice(0, 160)) || '<empty>');
  } catch (e) { console.log('[probe] error:', e.message); }
}

// ---- enumerate kart ids ----
async function enumerateKarts() {
  if (process.env.RF_KART_IDS) return [...new Set(process.env.RF_KART_IDS.split(',').map((s) => +s.trim()).filter(Boolean))];
  const uuids = (process.env.RF_KART_TYPE_UUIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pages = uuids.length ? uuids.map((u) => `/en/administration/garage/garage?kart_type_uuid=${u}`) : ['/en/administration/garage/garage'];
  const ids = new Set();
  for (const p of pages) {
    const html = await (await rf(p)).text();
    for (const re of [/kart-details\?id=(\d+)/g, /[?&]kart_id=(\d+)/g, /data-kart_id="(\d+)"/g, /select_kart\w*\((\d+)/g]) {
      let m; while ((m = re.exec(html))) ids.add(+m[1]);
    }
  }
  if (!ids.size) throw new Error('could not enumerate karts — set RF_KART_IDS env');
  return [...ids];
}

// ---- Supabase REST helpers (service role) ----
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SB ${method} ${path} -> ${res.status} ${text}`);
  if (!text) return null;                 // empty body: write with no representation, or 204 delete
  try { return JSON.parse(text); } catch { return null; }
}
const dmy = (d) => { const [a, b, c] = (d || '').split('.'); return c ? `${c}-${b}-${a}` : null; };

// A real kart's name is just its number — 1 to 3 digits (e.g. 1, 18, 104).
// Anything else ("George", "Late 2", "Archived 3", test entries) is not real fleet.
const KEEP_NAME = /^\d{1,3}$/;

async function syncKart(id) {
  const dj = await rfJson(`/ajax/garage/kart-details?id=${id}`);
  if (!dj || dj.success === false || !dj.kart) return null;
  const details = parseKartDetails(dj);
  if (!KEEP_NAME.test((details.name || '').trim())) return { id, skipped: true };   // non-numeric name (George/Late/etc.) — not real fleet
  await sb('rf_karts?on_conflict=rf_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{
    rf_id: id, name: details.name, kart_id_label: details.kartIdLabel, type: details.type,
    label: kartLabel(details.type, details.name),
    status: details.status, status_code: details.statusCode, total_km: details.totalKm,
    total_laps: details.totalLaps, total_hours: details.totalHours, total_cost: details.totalCost,
    brand: details.brand, model: details.model, fetched_at: new Date().toISOString(),
  }] });

  const { repairs } = parseRepairs(await rfJson(`/ajax/garage/kart-repairs?id=${id}`));
  await sb(`rf_repairs?rf_kart_id=eq.${id}`, { method: 'DELETE' });
  if (repairs.length) {
    const inserted = await sb('rf_repairs', { method: 'POST', prefer: 'return=representation', body: repairs.map((r, i) => ({
      rf_kart_id: id, description: r.description, date_discovered: dmy(r.dateDiscovered),
      date_repaired: dmy(r.dateRepaired), mileage: r.mileage, cost: r.cost, mechanic: r.user,
      notes: r.notes.join('\n'), fingerprint: `${id}|${i}|${r.dateRepaired}|${r.description}`.slice(0, 250),
    })) });
    const partRows = [];
    (inserted || []).forEach((row, i) => (repairs[i].parts || []).forEach((p) => partRows.push({ repair_id: row.id, part_name: p.name, qty: p.qty, price: p.price })));
    if (partRows.length) await sb('rf_repair_parts', { method: 'POST', body: partRows });
  }

  const parts = parseParts(await rfJson(`/ajax/garage/kart-parts?id=${id}`));
  await sb(`rf_parts_history?rf_kart_id=eq.${id}`, { method: 'DELETE' });
  const phSeen = new Set(), phRows = [];
  parts.forEach((p) => {
    const row = { rf_kart_id: id, date: dmy(p.date), part_name: p.part, hours_since: p.hoursSinceRepair, km_since: p.kmSinceRepair };
    const k = `${row.date}|${row.part_name}|${row.km_since}`;      // matches the table's unique key
    if (!phSeen.has(k)) { phSeen.add(k); phRows.push(row); }
  });
  if (phRows.length) await sb('rf_parts_history', { method: 'POST', body: phRows });

  return { id, name: details.name, type: details.type, label: kartLabel(details.type, details.name), repairs };
}

async function refreshAliases(allPartNames) {
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const appParts = await sb('parts?select=sku,description');
  const byName = new Map(appParts.map((p) => [norm(p.description), p.sku]));
  const rows = [...new Set(allPartNames.filter(Boolean))].map((n) => ({ rf_part_name: n, sku: byName.get(norm(n)) || null, updated_at: new Date().toISOString() }));
  if (rows.length) await sb('part_aliases?on_conflict=rf_part_name', { method: 'POST', prefer: 'resolution=merge-duplicates', body: rows });
  const aliases = {}; for (const r of rows) aliases[r.rf_part_name] = r.sku;
  return aliases;
}

async function reconcileToday(perKart, aliases) {
  const today = new Date().toISOString().slice(0, 10);
  const takes = await sb(`logs?select=staff_name,sku,qty,ts,action&site=eq.${SITE}&action=eq.TAKEN&ts=gte.${today}T00:00:00&ts=lte.${today}T23:59:59`);
  const nameBySku = new Map((await sb('parts?select=sku,description')).map((p) => [p.sku, p.description]));
  for (const t of (takes || [])) t.desc = nameBySku.get(t.sku) || t.sku; // part name for the message; logs has no desc column
  const rfRepairs = [];
  for (const k of perKart) for (const r of k.repairs) if (dmy(r.dateRepaired) === today)
    rfRepairs.push({ kartName: k.label || k.name, mechanic: r.user, date: r.dateRepaired, repairedAt: null, parts: r.parts });
  const lines = reconcileDay({ day: today, rfRepairs, appTakes: takes || [], aliases });
  await sb(`rf_discrepancies?day=eq.${today}&status=eq.new`, { method: 'DELETE' });
  if (lines.length) await sb('rf_discrepancies', { method: 'POST', body: lines.map((d) => ({
    day: d.day, kind: d.kind, rf_kart_name: d.rf_kart_name, mechanic: d.mechanic, part_name: d.part_name,
    sku: d.sku, rf_qty: d.rf_qty, app_qty: d.app_qty, at: d.at, message: d.message,
  })) });
  return lines.length;
}

// Remove karts (and their children) that are no longer listed under any type —
// e.g. stripped/archived ghosts. Guarded so a transient empty enumeration can't wipe the table.
async function pruneStale(activeIds) {
  if (process.env.RF_KART_IDS) return 0;           // never prune on a partial/test run
  if (!activeIds || activeIds.length < 10) { console.log(`[prune] skipped — only ${activeIds ? activeIds.length : 0} active ids (looks like a bad enumeration)`); return 0; }
  const existing = (await sb('rf_karts?select=rf_id')) || [];
  const active = new Set(activeIds);
  const stale = existing.map((r) => r.rf_id).filter((id) => !active.has(id));
  if (!stale.length) return 0;
  const list = stale.join(',');
  await sb(`rf_parts_history?rf_kart_id=in.(${list})`, { method: 'DELETE' });
  await sb(`rf_repairs?rf_kart_id=in.(${list})`, { method: 'DELETE' }); // rf_repair_parts cascades
  await sb(`rf_karts?rf_id=in.(${list})`, { method: 'DELETE' });
  return stale.length;
}

async function main() {
  if (!RF_USER || !RF_PASS || !SB_URL || !SB_KEY) throw new Error('missing required env vars');
  await login();
  await probe();                       // <-- prints exactly what RaceFacer replies; remove once working
  const ids = await enumerateKarts();
  console.log(`Syncing ${ids.length} karts...`);
  const perKart = [], skipIds = new Set();
  for (const id of ids) {
    try { const k = await syncKart(id); if (k && k.skipped) skipIds.add(id); else if (k) perKart.push(k); }
    catch (e) { console.error(`kart ${id}: ${e.message}`); }
    await sleep(150);
  }
  if (skipIds.size) console.log(`[skip] ${skipIds.size} non-numeric-named karts (George/Late/test) excluded.`);
  const keepIds = ids.filter((id) => !skipIds.has(id));   // real karts only (incl. ones that transiently failed)
  const pruned = await pruneStale(keepIds);
  if (pruned) console.log(`[prune] removed ${pruned} stale/ghost karts no longer listed under any type.`);
  const aliases = await refreshAliases(perKart.flatMap((k) => k.repairs.flatMap((r) => (r.parts || []).map((p) => p.name))));
  const n = await reconcileToday(perKart, aliases);
  await sb('rf_sync_state?on_conflict=k', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{ k: 'last_sync', v: new Date().toISOString(), at: new Date().toISOString() }] });
  console.log(`Done. ${perKart.length} karts synced, ${pruned} ghosts removed, ${n} discrepancies flagged for today.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { login, enumerateKarts, syncKart, reconcileToday };
