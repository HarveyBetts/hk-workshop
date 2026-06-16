#!/usr/bin/env node
/*
 * RaceFacer -> Supabase sync WORKER (always-on)
 * --------------------------------------------
 * Runs continuously on a small always-on host (a Render Background Worker, a
 * Railway service, or any machine that can run `node racefacer-sync-worker.js`).
 * It replaces the GitHub Actions cron, whose scheduling gaps were making kart
 * status and the manager repair counts lag.
 *
 * Two independent loops, each spawning an isolated racefacer-sync.js child
 * (fresh RaceFacer login/cookies each cycle, no memory growth; a stuck child is
 * killed after a timeout):
 *   - STATUS loop : STATUS_ONLY=1 fast OK / Damaged / Maintenance refresh.
 *                   ~10s between cycles, so a status flip shows almost at once.
 *   - HEAVY  loop : the full sync (repairs, parts, notes, prune, reconcile).
 *                   ~2min pause between passes; a full pass itself takes
 *                   ~2-3min, so repairs land roughly every ~5min.
 *
 * Fixed-DELAY scheduling (the next cycle starts only after the previous one
 * ends) so cycles never pile up. One worker syncs ONE site (the SITE env var);
 * run two for Sydney + Melbourne.
 *
 * Env: same as racefacer-sync.js (RF_USER, RF_PASS, SB_URL, SB_SERVICE_KEY, SITE)
 *      plus, optional:
 *        STATUS_GAP_SEC     pause between status refreshes (default 10, min 5)
 *        HEAVY_GAP_SEC      pause between full syncs        (default 120, min 60)
 *        CYCLE_TIMEOUT_SEC  kill a stuck child after        (default 600, min 120)
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT     = path.join(__dirname, 'racefacer-sync.js');
const STATUS_GAP = Math.max(5,   parseInt(process.env.STATUS_GAP_SEC    || '10',  10)) * 1000;
const HEAVY_GAP  = Math.max(60,  parseInt(process.env.HEAVY_GAP_SEC     || '120', 10)) * 1000;
const TIMEOUT_MS = Math.max(120, parseInt(process.env.CYCLE_TIMEOUT_SEC || '600', 10)) * 1000;
const SITE       = process.env.SITE || 'sydney';

let stopping = false;

function ts(){ return new Date().toISOString().replace('T', ' ').replace(/\..+/, ''); }
function log(m){ console.log(`[worker ${ts()}] ${m}`); }

// One self-rescheduling loop: spawn racefacer-sync.js with extra env, kill a
// stuck cycle, then wait `gapMs` AFTER it ends before the next one (fixed delay
// => no overlap, no pile-up). Children inherit the worker's env (the secrets).
function loop(tag, gapMs, extraEnv){
  let n = 0, fails = 0, timer = null;
  function run(){
    if (stopping) return;
    const id = ++n, t0 = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
    const killer = setTimeout(() => { log(`${tag} #${id} exceeded ${TIMEOUT_MS / 1000}s — killing`); child.kill('SIGKILL'); }, TIMEOUT_MS);
    function done(code, sig, err){
      clearTimeout(killer);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (err)             { fails++; log(`${tag} #${id} spawn error: ${err.message} — fails ${fails}`); }
      else if (code === 0) { log(`${tag} #${id} ok (${secs}s)`); }
      else                 { fails++; log(`${tag} #${id} FAILED code ${code}${sig ? ' ' + sig : ''} (${secs}s) — fails ${fails}`); }
      if (!stopping) timer = setTimeout(run, gapMs);
    }
    child.once('exit',  (code, sig) => done(code, sig, null));
    child.once('error', (e)         => done(null, null, e));
  }
  return { start(delay){ timer = setTimeout(run, delay || 0); }, stop(){ clearTimeout(timer); } };
}

log(`starting · site=${SITE} · status every ~${STATUS_GAP / 1000}s · full-sync gap ~${HEAVY_GAP / 1000}s · child timeout ${TIMEOUT_MS / 1000}s`);

const statusLoop = loop('status', STATUS_GAP, { STATUS_ONLY: '1' });
// Force each heavy child to actually run the full pass: a low HEAVY_INTERVAL_SEC
// (clamped to 60s inside racefacer-sync.js) is always < the time since the last
// heavy, so the gate opens every heavy cycle.
const heavyLoop  = loop('heavy',  HEAVY_GAP,  { STATUS_ONLY: '', HEAVY_INTERVAL_SEC: '60' });

statusLoop.start(0);      // status begins immediately
heavyLoop.start(4000);    // heavy begins a few seconds later so the first logins don't collide

function shutdown(sig){
  if (stopping) return;
  stopping = true;
  log(`${sig} received — stopping after the current cycles settle`);
  statusLoop.stop(); heavyLoop.stop();
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
