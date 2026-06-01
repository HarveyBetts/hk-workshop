// racefacer-sync.js
// Logs in to RaceFacer (HKWS), pulls each kart's details/repairs/parts, parses them,
// writes them to Supabase, then reconciles the day's repairs against app stock scan-outs
// and writes the discrepancy notifications. Designed to run on a schedule (end of day).
//
// Runs in Node 18+. Handles RaceFacer's self-signed certificate via an undici Agent.
//
// Required env vars (set as GitHub Actions secrets, or in your runner):
//   RF_BASE   = https://103.166.146.163
//   RF_USER   = HKWS
//   RF_PASS   = HKWS
//   SB_URL    = https://jnxdjzewfrcrexyscxul.supabase.co
//   SB_SERVICE_KEY = <service-role key>   (server-side only; never in the app)
// Optional:
//   RF_KART_IDS = 47,48,49           (authoritative kart-id list; recommended — see enumerateKarts)
//   RF_KART_TYPE_UUIDS = 6de9e147-ce23-4b60-ae56-6c3dd1e1d871   (Adult Track; for page-scrape fallback)
//   SITE = sydney                    (which app site's logs to reconcile against)

const { fetch, Agent } = require('undici');
const { parseKartDetails, parseRepairs, parseParts } = require('./racefacer-parse');
const { reconcileDay } = require('./racefacer-reconcile');

const RF_BASE = process.env.RF_BASE || 'https://103.166.146.163';
const RF_USER = process.env.RF_USER, RF_PASS = process.env.RF_PASS;
const SB_URL = process.env.SB_URL, SB_KEY = process.env.SB_SERVICE_KEY;
const SITE = process.env.SITE || 'sydney';

// Accept the host's self-signed certificate (single known internal box).
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

// ---- tiny cookie jar ----
const jar = {};
function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';'); const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function rf(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path.startsWith('http') ? path : RF_BASE + path, {
    method, body, redirect: 'manual', dispatcher: insecure,
    headers: { 'Cookie': cookieHeader(), 'User-Agent': 'HKWorkshopSync/1.0', ...headers },
  });
  storeCookies(res);
  return res;
}

// ---- login: read the form, grab the fresh CSRF token, post credentials ----
async function login() {
  const page = await (await rf('/en/auth/login')).text();
  const formMatch = page.match(/<form[^>]*action="([^"]*login[^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  const action = formMatch ? formMatch[1] : '/en/auth/login';
  const formHtml = formMatch ? formMatch[2] : page;
  const body = new URLSearchParams();
  // keep every hidden input (incl. _token), fill the visible text + password fields
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]*)"/) || [])[1]; if (!name) continue;
    const type = (tag.match(/type="([^"]*)"/) || [])[1] || 'text';
    const val = (tag.match(/value="([^"]*)"/) || [])[1] || '';
    if (type === 'password') body.set(name, RF_PASS);
    else if (type === 'hidden') body.set(name, val);
    else if (/user|email|login|name/i.test(name)) body.set(name, RF_USER);
  }
  if (![...body.keys()].some((k) => /user|email|login/i.test(k))) body.set('username', RF_USER);
  if (!body.has('password')) body.set('password', RF_PASS);

  const res = await rf(action, {
    method: 'POST', body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!jar['laravel_session']) throw new Error(`login failed (status ${res.status}); no session cookie set`);
  return true;
}

// ---- enumerate kart ids ----
// Most reliable: set RF_KART_IDS. Otherwise scrape the garage list page(s).
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
  if (!ids.size) throw new Error('could not enumerate karts — set RF_KART_IDS env (see notes)');
  return [...ids];
}

// ---- Supabase REST helpers (service role) ----
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`SB ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const dmy = (d) => { const [a, b, c] = (d || '').split('.'); return c ? `${c}-${b}-${a}` : null; }; // 25.05.2026 -> 2026-05-25

async function syncKart(id) {
  const details = parseKartDetails(await (await rf(`/ajax/garage/kart-details?id=${id}`)).json());
  await sb('rf_karts?on_conflict=rf_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{
    rf_id: id, name: details.name, kart_id_label: details.kartIdLabel, type: details.type,
    status: details.status, status_code: details.statusCode, total_km: details.totalKm,
    total_laps: details.totalLaps, total_hours: details.totalHours, total_cost: details.totalCost,
    brand: details.brand, model: details.model, fetched_at: new Date().toISOString(),
  }] });

  // repairs: clean replace per kart (cascade clears parts)
  const { repairs } = parseRepairs(await (await rf(`/ajax/garage/kart-repairs?id=${id}`)).json());
  await sb(`rf_repairs?rf_kart_id=eq.${id}`, { method: 'DELETE' });
  if (repairs.length) {
    const inserted = await sb('rf_repairs', { method: 'POST', prefer: 'return=representation', body: repairs.map((r) => ({
      rf_kart_id: id, description: r.description, date_discovered: dmy(r.dateDiscovered),
      date_repaired: dmy(r.dateRepaired), mileage: r.mileage, cost: r.cost, mechanic: r.user,
      notes: r.notes.join('\n'), fingerprint: `${id}|${r.dateRepaired}|${r.description}`.slice(0, 250),
    })) });
    const partRows = [];
    inserted.forEach((row, i) => (repairs[i].parts || []).forEach((p) => partRows.push({ repair_id: row.id, part_name: p.name, qty: p.qty, price: p.price })));
    if (partRows.length) await sb('rf_repair_parts', { method: 'POST', body: partRows });
  }

  // parts wear history: clean replace per kart
  const parts = parseParts(await (await rf(`/ajax/garage/kart-parts?id=${id}`)).json());
  await sb(`rf_parts_history?rf_kart_id=eq.${id}`, { method: 'DELETE' });
  if (parts.length) await sb('rf_parts_history', { method: 'POST', body: parts.map((p) => ({
    rf_kart_id: id, date: dmy(p.date), part_name: p.part, hours_since: p.hoursSinceRepair, km_since: p.kmSinceRepair,
  })) });

  return { id, name: details.name, repairs };
}

// auto-map RaceFacer part names -> app SKUs by exact (normalised) name match
async function refreshAliases(allPartNames) {
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const appParts = await sb('parts?select=sku,name');
  const byName = new Map(appParts.map((p) => [norm(p.name), p.sku]));
  const rows = [...new Set(allPartNames.filter(Boolean))].map((n) => ({ rf_part_name: n, sku: byName.get(norm(n)) || null, updated_at: new Date().toISOString() }));
  if (rows.length) await sb('part_aliases?on_conflict=rf_part_name', { method: 'POST', prefer: 'resolution=merge-duplicates', body: rows });
  const aliases = {}; for (const r of rows) aliases[r.rf_part_name] = r.sku;
  return aliases;
}

async function reconcileToday(perKart, aliases) {
  const today = new Date().toISOString().slice(0, 10);
  // app scan-outs for today
  const takes = await sb(`logs?select=staff_name,sku,desc,qty,ts,action&site=eq.${SITE}&action=eq.TAKEN&ts=gte.${today}T00:00:00&ts=lte.${today}T23:59:59`);
  // RaceFacer repairs done today
  const rfRepairs = [];
  for (const k of perKart) for (const r of k.repairs) if (dmy(r.dateRepaired) === today)
    rfRepairs.push({ kartName: k.name, mechanic: r.user, date: r.dateRepaired, repairedAt: null, parts: r.parts });

  const lines = reconcileDay({ day: today, rfRepairs, appTakes: takes || [], aliases });
  await sb(`rf_discrepancies?day=eq.${today}&status=eq.new`, { method: 'DELETE' }); // idempotent re-run
  if (lines.length) await sb('rf_discrepancies', { method: 'POST', body: lines.map((d) => ({
    day: d.day, kind: d.kind, rf_kart_name: d.rf_kart_name, mechanic: d.mechanic, part_name: d.part_name,
    sku: d.sku, rf_qty: d.rf_qty, app_qty: d.app_qty, at: d.at, message: d.message,
  })) });
  return lines.length;
}

async function main() {
  if (!RF_USER || !RF_PASS || !SB_URL || !SB_KEY) throw new Error('missing required env vars');
  await login();
  const ids = await enumerateKarts();
  console.log(`Syncing ${ids.length} karts...`);
  const perKart = [];
  for (const id of ids) { try { perKart.push(await syncKart(id)); } catch (e) { console.error(`kart ${id}: ${e.message}`); } }
  const aliases = await refreshAliases(perKart.flatMap((k) => k.repairs.flatMap((r) => (r.parts || []).map((p) => p.name))));
  const n = await reconcileToday(perKart, aliases);
  await sb('rf_sync_state?on_conflict=k', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{ k: 'last_sync', v: new Date().toISOString(), at: new Date().toISOString() }] });
  console.log(`Done. ${perKart.length} karts synced, ${n} discrepancies flagged for today.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { login, enumerateKarts, syncKart, reconcileToday };
