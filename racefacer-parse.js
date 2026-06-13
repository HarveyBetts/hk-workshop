// racefacer-parse.js
// Verified RaceFacer (v5.2.1) response parser for the HK Workshop integration.
// Turns RaceFacer's JSON-wrapped HTML into clean data. Tested against real kart-19 data.
// Uses querySelector-style selectors so it ports cleanly from cheerio (Node) to deno-dom
// (Supabase Edge Function). Swap the loader line per environment.

const cheerio = require('cheerio'); // Edge Function: replace with deno-dom DOMParser

const txt = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const num = (s) => { const n = Number(txt(s).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; };
const money = (s) => { const t = txt(s); return (!t || t === '-') ? null : t; };

// kart-details -> structured kart record. status codes: 1=OK, 2=DAMAGED, 3=FOR MAINTENANCE
function parseKartDetails(json) {
  const $ = cheerio.load(json.html || '');
  const fields = {};
  $('div').each((_, el) => {
    const label = txt($(el).clone().children('span').remove().end().text()).replace(/:$/, '').trim();
    const val = txt($(el).children('span').text());
    if (label && val) fields[label] = val;
  });
  let status = null, statusCode = null;
  $('a.garage_status_btn').each((_, el) => {
    if (!/\bdisabled\b/.test($(el).attr('class') || '')) {
      status = txt($(el).text());
      const m = ($(el).attr('onclick') || '').match(/toggle_kart_status\([^,]+,\s*'[^']*',\s*'(\d+)'/);
      statusCode = m ? Number(m[1]) : null;
    }
  });
  const spans = $('.fleft .spaced').map((_, el) => txt($(el).text())).get();
  const pick = (p) => { const s = spans.find((x) => x.startsWith(p)); return s ? s.slice(p.length).trim() : null; };
  return {
    id: json.kart?.id ?? null,
    name: json.kart?.name ?? pick('Name:'),
    type: pick('Type:'),
    kartIdLabel: pick('Kart ID:'),
    transponder: pick('Transponder:'),
    status, statusCode,
    totalKm: json.total_km ?? num(fields['Total mileage']),
    totalMi: json.total_mi ?? null,
    totalLaps: num(fields['Total laps']),
    totalHours: num(fields['Total working hours']),
    totalCost: fields['Total cost'] || null,
    brand: fields['Kart Brand'] || null,
    model: fields['Kart Model'] || null,
    engineBrand: fields['Engine brand'] || null,
    exploitationStart: fields['Exploitation start date'] || null,
  };
}

// kart-repairs -> [{description,dateDiscovered,dateRepaired,mileage,cost,user,notes[],parts[]}]
function parseRepairs(json) {
  const $ = cheerio.load(json.html || '');
  const repairs = [];
  let cur = null;
  $('#repairs-list').children('tr').each((_, tr) => {
    const $tr = $(tr);
    if (!$tr.hasClass('sub-section')) {
      const td = $tr.children('td').map((_, e) => txt($(e).text())).get();
      cur = { description: td[0] || '', dateDiscovered: td[1] || '', dateRepaired: td[2] || '',
        mileage: num(td[3]), cost: money(td[4]), user: td[5] || '', notes: [], parts: [] };
      repairs.push(cur);
    } else if (cur) {
      $tr.find('table').each((_, tbl) => {
        const $tbl = $(tbl);
        const headers = $tbl.find('th').map((_, e) => txt($(e).text())).get();
        if (headers[0] === 'Note') {
          $tbl.find('tbody td').each((_, e) => { const n = txt($(e).text()); if (n) cur.notes.push(n); });
        } else if (headers[0] === 'Parts used') {
          $tbl.find('tr').each((_, row) => {
            const c = $(row).children('td').map((_, e) => txt($(e).text())).get();
            if (c.length === 3 && !$(row).hasClass('no-results')) cur.parts.push({ name: c[0], qty: num(c[1]), price: money(c[2]) });
          });
        }
      });
    }
  });
  return { repairs, totalCost: txt($('tfoot td.bold').last().text()) || null };
}

// kart-parts -> [{date,part,hoursSinceRepair,kmSinceRepair}]
function parseParts(json) {
  const $ = cheerio.load(json.html || '');
  const rows = [];
  $('#running-sessions-list').children('tr').each((_, tr) => {
    const c = $(tr).children('td').map((_, e) => txt($(e).text())).get();
    if (c.length >= 4) rows.push({ date: c[0], part: c[1] || null, hoursSinceRepair: num(c[2]), kmSinceRepair: num(c[3]) });
  });
  return rows;
}

// Predictor seed: per-part replacement cadence from parts history.
function analysePartWear(rows) {
  const byPart = {};
  for (const r of rows) { if (r.part) (byPart[r.part] = byPart[r.part] || []).push(r); }
  const out = [];
  for (const [part, list] of Object.entries(byPart)) {
    list.sort((a, b) => a.kmSinceRepair - b.kmSinceRepair);
    const kmSinceLast = list[0].kmSinceRepair;
    const intervals = [];
    for (let i = 1; i < list.length; i++) intervals.push(list[i].kmSinceRepair - list[i - 1].kmSinceRepair);
    const avg = intervals.length ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length) : null;
    out.push({ part, times: list.length, avgKmBetween: avg, kmSinceLast,
      overdue: avg != null && kmSinceLast > avg, remainingKm: avg != null ? avg - kmSinceLast : null });
  }
  out.sort((a, b) => b.times - a.times || (a.avgKmBetween ?? 1e9) - (b.avgKmBetween ?? 1e9));
  return out;
}

module.exports = { parseKartDetails, parseRepairs, parseParts, analysePartWear };
