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
const { parseKartDetails, parseRepairs, parseParts, parseKartNotes, parseActiveNotes, parseGarageStatuses } = require('./racefacer-parse');
const { reconcileDay } = require('./racefacer-reconcile');

const RF_BASE = process.env.RF_BASE || 'https://103.166.146.163';
const RF_USER = process.env.RF_USER, RF_PASS = process.env.RF_PASS;
const SB_URL = process.env.SB_URL, SB_KEY = process.env.SB_SERVICE_KEY;
const SITE = process.env.SITE || 'sydney';
// How often to run the FULL sync (repairs/parts/notes/prune). Between those, only
// kart status is refreshed, which is fast. Default 5 min; tune with HEAVY_INTERVAL_SEC.
const HEAVY_INTERVAL_MS = Math.max(60000, (parseInt(process.env.HEAVY_INTERVAL_SEC, 10) || 300) * 1000);

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
    // ---- Twin diagnostic: does the Twin type page list karts, and what are they named? Remove once Twins sync. ----
    const TWIN = '00dd982c-d763-4d21-a4ad-a79035495eaf';
    const html = await (await rf(`/en/administration/garage/garage?kart_type_uuid=${TWIN}`)).text();
    const st = parseGarageStatuses(html);
    console.log('[probe] TWIN page len=%s blocks=%s ids=%s', html.length, st.length, JSON.stringify(st.map((k) => k.rfId)));
    const names = (html.match(/Name:\s*<span class="bold">([^<]*)<\/span>/g) || []).slice(0, 15);
    console.log('[probe] TWIN raw name spans:', JSON.stringify(names));
  } catch (e) { console.log('[probe] error:', e.message); }
}

// ---- enumerate kart ids ----
// Each garage "type" page maps to a (site, track-type) pair. This is the source
// of truth for which site a kart belongs to (kart-details doesn't tell us the site).
// Add a row here to onboard a new site/type.
const KART_TYPES = {
  '6de9e147-ce23-4b60-ae56-6c3dd1e1d871': { site: 'sydney',    type: 'Adult Track' },
  'e0abc9ae-153e-41bb-be90-9877e39391c3': { site: 'sydney',    type: 'Intermediate Track' },
  '86ffcdf3-f02e-4eb6-9955-0873c846f9b0': { site: 'sydney',    type: 'Junior Track' },
  '3005c630-1894-47f0-bc47-93979f118d17': { site: 'sydney',    type: 'Mini Track' },
  '00dd982c-d763-4d21-a4ad-a79035495eaf': { site: 'sydney',    type: 'Twin' },
  'bde73675-16a9-424f-b659-ada7338a2202': { site: 'sydney',    type: 'BattleKart' },
  '8d460fb0-ffc4-4838-bf6f-667f65095e65': { site: 'melbourne', type: 'Adult Track' },
};

async function enumerateKarts() {
  // Returns a Map of rf_id -> { site, type } so each kart is tagged by the page it came from.
  const map = new Map();
  if (process.env.RF_KART_IDS) {
    for (const s of process.env.RF_KART_IDS.split(',')) { const n = +s.trim(); if (n) map.set(n, { site: process.env.SITE || 'sydney', type: null }); }
    return map;
  }
  for (const [uuid, meta] of Object.entries(KART_TYPES)) {
    const html = await (await rf(`/en/administration/garage/garage?kart_type_uuid=${uuid}`)).text();
    const ids = new Set();
    for (const re of [/kart-details\?id=(\d+)/g, /[?&]kart_id=(\d+)/g, /data-kart_id="(\d+)"/g, /select_kart\w*\((\d+)/g]) {
      let m; while ((m = re.exec(html))) ids.add(+m[1]);
    }
    for (const id of ids) map.set(id, { site: meta.site, type: meta.type }); // last page wins if a kart appears twice
  }
  if (!map.size) throw new Error('could not enumerate karts — check login / type UUIDs');
  return map;
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
const noteFp = (id, n) => `${id}|${n.createdIso || ''}|${n.note}`.slice(0, 250);

// A real kart's name is just its number — 1 to 3 digits (e.g. 1, 18, 104).
// Anything else ("George", "Late 2", "Archived 3", test entries) is not real fleet.
const KEEP_NAME = /^\d{1,3}$/;

async function syncKart(id, meta) {
  meta = meta || {};
  const dj = await rfJson(`/ajax/garage/kart-details?id=${id}`);
  if (!dj || dj.success === false || !dj.kart) return null;
  const details = parseKartDetails(dj);
  if (!KEEP_NAME.test((details.name || '').trim())) return { id, skipped: true };   // non-numeric name (George/Late/etc.) — not real fleet
  const type = meta.type || details.type;   // page-derived type is authoritative (reflects Adult<->Inter moves)
  const site = meta.site || 'sydney';
  await sb('rf_karts?on_conflict=rf_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{
    rf_id: id, name: details.name, kart_id_label: details.kartIdLabel, type: type, site: site,
    label: kartLabel(type, details.name),
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

  let notesWritten = 0;
  // Which notes is RaceFacer currently showing in its top "active" list (starred, not X'd)?
  // Their fingerprints match the same notes in the Kart Notes table, so we can flag them.
  const activeFps = new Set(parseActiveNotes(dj.html).map((n) => noteFp(id, n)));
  try { notesWritten = await syncKartNotes(id, site, activeFps); } catch (e) { /* rf_kart_notes table may not exist yet — don't fail the kart */ }

  return { id, name: details.name, type: type, site: site, label: kartLabel(type, details.name), repairs, notesWritten };
}

// Kart notes -> rf_kart_notes. Full history for the Kart Notes tab, plus an `active` flag marking
// the notes RaceFacer currently shows in its top list (starred / not X'd). Replaces the kart's notes
// wholesale each heavy pass so X'd/removed notes and stale flags can't linger. CRITICAL: de-dupe by
// fingerprint first — RaceFacer can list the exact same note twice, and a bulk upsert with a repeated
// conflict key throws "cannot affect row a second time", which previously left those karts with NO notes.
async function syncKartNotes(id, site, activeFps) {
  const notes = parseKartNotes(await rfJson(`/ajax/garage/kart-notes?id=${id}`));
  const rows = [], batch = new Set();
  for (const n of notes) {
    const fp = noteFp(id, n);
    if (batch.has(fp)) continue;                 // same note listed twice in RaceFacer -> store once
    batch.add(fp);
    rows.push({ note_fp: fp, rf_kart_id: id, site, note: n.note,
      created_at: n.createdIso, created_by: n.createdBy, archived_at: n.archivedIso, archived_by: n.archivedBy,
      active: activeFps ? activeFps.has(fp) : false });
  }
  await sb(`rf_kart_notes?rf_kart_id=eq.${id}`, { method: 'DELETE' });   // replace this kart's notes wholesale
  if (rows.length) await sb('rf_kart_notes?on_conflict=note_fp', { method: 'POST', prefer: 'resolution=merge-duplicates', body: rows });
  return rows.length;
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

// FAST PATH: read OK / Damaged / For-maintenance straight off the garage LIST pages
// (one per kart type, fetched in parallel — ~5 requests for the whole fleet) instead of
// hitting all ~190 karts individually. Only updates karts already in rf_karts (so it's
// always an UPDATE — never a partial insert), and only the status fields.
async function statusFast() {
  let known = new Set();
  try { const f = (await sb('rf_karts?select=rf_id')) || []; for (const r of f) if (r.rf_id != null) known.add(r.rf_id); }
  catch (e) { console.error(`[fast] couldn't read fleet: ${e.message}`); return 0; }
  if (!known.size) return 0;                          // nothing known yet — the full sync will populate it

  const lists = await Promise.all(Object.keys(KART_TYPES).map(async (uuid) => {
    try { const html = await (await rf(`/en/administration/garage/garage?kart_type_uuid=${uuid}`)).text(); return parseGarageStatuses(html); }
    catch (e) { return []; }                          // a page that fails this cycle just gets skipped; the next cycle/heavy covers it
  }));

  const rows = [], seen = new Set(), now = new Date().toISOString();
  for (const list of lists) for (const k of list) {
    if (!k.rfId || k.statusCode == null || !known.has(k.rfId) || seen.has(k.rfId)) continue;
    seen.add(k.rfId);
    rows.push({ rf_id: k.rfId, status: k.status, status_code: k.statusCode, fetched_at: now });
  }
  for (let i = 0; i < rows.length; i += 100) {
    try { await sb('rf_karts?on_conflict=rf_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: rows.slice(i, i + 100) }); }
    catch (e) { console.error(`[fast] status upsert failed: ${e.message}`); }
  }
  try { await sb('rf_sync_state?on_conflict=k', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{ k: 'last_status', v: now, at: now }] }); } catch (e) {}
  return rows.length;
}

async function main() {
  if (!RF_USER || !RF_PASS || !SB_URL || !SB_KEY) throw new Error('missing required env vars');
  await login();

  // Run the heavy (full) sync only every HEAVY_INTERVAL_MS; every other cycle is a quick status refresh.
  let lastHeavy = 0, haveFleet = false;
  try { const st = await sb('rf_sync_state?k=eq.last_heavy&select=v'); if (st && st[0] && st[0].v) lastHeavy = Date.parse(st[0].v) || 0; } catch (e) {}
  try { const f = await sb('rf_karts?select=rf_id&limit=1'); haveFleet = !!(f && f.length); } catch (e) {}
  const doHeavy = !haveFleet || (Date.now() - lastHeavy >= HEAVY_INTERVAL_MS);

  if (!doHeavy) {
    const n = await statusFast();
    const due = Math.max(0, Math.round((HEAVY_INTERVAL_MS - (Date.now() - lastHeavy)) / 1000));
    console.log(`[fast] status refreshed for ${n} karts; full sync due in ~${due}s.`);
    return;
  }

  // ----- full sync (unchanged): enumerate everything + repairs/parts/notes + prune + reconcile -----
  await probe();                       // <-- prints exactly what RaceFacer replies; remove once working
  const idMap = await enumerateKarts();           // Map: rf_id -> { site, type }
  console.log(`Syncing ${idMap.size} karts...`);
  const perKart = [], skipIds = new Set();
  for (const [id, meta] of idMap) {
    try { const k = await syncKart(id, meta); if (k && k.skipped) skipIds.add(id); else if (k) perKart.push(k); }
    catch (e) { console.error(`kart ${id}: ${e.message}`); }
    await sleep(150);
  }
  if (skipIds.size) console.log(`[skip] ${skipIds.size} non-numeric-named karts (George/Late/test) excluded.`);
  const keepIds = [...idMap.keys()].filter((id) => !skipIds.has(id));   // real karts only (incl. ones that transiently failed)
  const pruned = await pruneStale(keepIds);
  if (pruned) console.log(`[prune] removed ${pruned} stale/ghost karts no longer listed under any type.`);
  const aliases = await refreshAliases(perKart.flatMap((k) => k.repairs.flatMap((r) => (r.parts || []).map((p) => p.name))));
  const n = await reconcileToday(perKart, aliases);
  const now = new Date().toISOString();
  await sb('rf_sync_state?on_conflict=k', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{ k: 'last_sync', v: now, at: now }, { k: 'last_heavy', v: now, at: now }] });
  console.log(`Done. ${perKart.length} karts synced, ${pruned} ghosts removed, ${n} discrepancies flagged for today.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { login, enumerateKarts, syncKart, statusFast, reconcileToday };
