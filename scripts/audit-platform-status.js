#!/usr/bin/env node
/**
 * Read-only audit of what each job platform says about your applications.
 *
 * Does exactly what the daily "check replies" run does — opens each platform's
 * applications page in the logged-in debug Chrome, reads the JSON the page
 * fetches — but sends nothing to the server and writes nothing to any database.
 * For every platform it prints each status word the site showed, how
 * lib/jobStatus.js classifies it, and flags words that moved no stage (id 99).
 *
 *   node scripts/audit-platform-status.js [naukri instahyre hirist cutshort wellfound] [--cdp=9222]
 */
const { classifyStatus } = require('../lib/jobStatus');
const argv = process.argv.slice(2);
const cdpPort = Number((argv.find(a => a.startsWith('--cdp=')) || '--cdp=9222').slice(6));
const ids = argv.filter(a => !a.startsWith('--'));
const platforms = ids.length ? ids : ['naukri', 'instahyre', 'hirist', 'cutshort', 'wellfound'];

async function audit(id) {
  const driver = require(id === 'naukri' ? '../worker/naukri' : `../worker/platforms/${id}`);
  const session = await driver.connect({ cdpPort });
  try {
    const out = await driver.track(session, { onProgress: () => {} });
    const seen = new Map();   // word → { n, id }
    for (const r of out.rows) {
      for (const s of r.status || []) {
        const key = String(s.statusValue);
        const e = seen.get(key) || { n: 0, id: s.statusId };
        e.n++; seen.set(key, e);
      }
    }
    console.log(`\n== ${id}: ${out.rows.length} application(s) read${out.warnings && out.warnings.length ? '' : ''}`);
    if (out.sawFeed === false) console.log('   !! no application list loaded — the read is broken or you are logged out');
    for (const w of out.warnings || []) console.log(`   !! ${w}`);
    for (const [word, e] of [...seen.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const c = classifyStatus(word);
      const flag = e.id === 99 ? '  <-- moves no stage' : '';
      console.log(`   ${String(e.n).padStart(4)} × ${JSON.stringify(word).padEnd(34)} id ${String(e.id).padStart(2)}  ${c ? c.stage : 'unrecognised'}${flag}`);
    }
  } finally { await driver.disconnect(session).catch(() => {}); }
}

(async () => {
  for (const id of platforms) {
    try { await audit(id); } catch (e) { console.log(`\n== ${id}: could not read (${e.message})`); }
  }
  process.exit(0);
})();
