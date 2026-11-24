#!/usr/bin/env node
/**
 * Read-only recon of Cutshort's post-apply questionnaire.
 *
 * Opens Messages → Pending in the logged-in debug Chrome, opens a few threads
 * and dumps what a questionnaire looks like: the JSON the page fetches and the
 * questionnaire's markup. Clicks nothing inside a thread — no radio, no Submit —
 * and writes nothing to any database.
 *
 *   node scripts/recon-cutshort-questionnaire.js [--threads=4] [--cdp=9222] [--out=<dir>]
 */
const fs = require('fs');
const path = require('path');
const driver = require('../worker/platforms/cutshort');
const { newPage } = require('../worker/platforms/shared/session');

const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const cdpPort = Number(opt('cdp', 9222));
const maxThreads = Number(opt('threads', 4));
const out = opt('out', path.join(process.cwd(), 'cutshort-recon'));

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const session = await driver.connect({ cdpPort });
  const page = await newPage(session);
  const xhrs = [];
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (!/cutshort\.io/.test(u) || !/json/i.test(res.headers()['content-type'] || '')) return;
      const req = res.request();
      xhrs.push({ method: req.method(), url: u, post: req.postData() || null, body: await res.json().catch(() => null) });
    } catch (_) { /* unreadable */ }
  });
  try {
    await page.goto('https://cutshort.io/profile/candidate-conversations?i=all&stage=awaiting', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    // The Pending tab, in case the stage parameter is ignored.
    await page.getByText(/^\s*pending\s*\d*\s*$/i).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Threads whose last message is the questionnaire, from the list's own JSON
    // (row _id = the ?thread= id, jobSignal._id = our sourceId).
    const threads = xhrs.filter(r => /conversations-v2\/candidate/.test(r.url))
      .flatMap(r => (r.body && r.body.results) || [])
      .filter(r => r.lastMsgText === '[Questionnaire]')
      .map(r => ({ thread: r._id, job: r.jobSignal && r.jobSignal._id }));
    const n = Math.min(threads.length, maxThreads);
    console.log(`${threads.length} thread(s) end in [Questionnaire]; opening ${n}`);
    for (let i = 0; i < n; i++) {
      const before = xhrs.length;
      await page.goto(`https://cutshort.io/profile/candidate-conversations?i=all&thread=${threads[i].thread}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(7000);
      const html = await page.evaluate(() => {
        // The smallest element holding both a radio and a question-ish heading.
        const radios = [...document.querySelectorAll('input[type=radio]')];
        if (!radios.length) return null;
        let el = radios[0];
        while (el && el.parentElement && el.querySelectorAll('input[type=radio]').length < radios.length) el = el.parentElement;
        for (let k = 0; k < 3 && el && el.parentElement; k++) el = el.parentElement;
        return el ? el.outerHTML : null;
      }).catch(() => null);
      const url = page.url();
      const text = ((await page.innerText('body').catch(() => '')) || '');
      const submitted = /questionnaire submitted/i.test(text);
      fs.writeFileSync(path.join(out, `thread-${i}.html`), html || '(no radio inputs found)');
      fs.writeFileSync(path.join(out, `thread-${i}.xhr.json`), JSON.stringify(xhrs.slice(before), null, 2));
      console.log(`  #${i} ${url}\n     submitted=${submitted} radios=${html ? 'yes' : 'no'} xhrs=${xhrs.length - before}`);
    }
    fs.writeFileSync(path.join(out, 'all-xhr.json'), JSON.stringify(xhrs, null, 2));
    console.log(`written to ${out}`);
  } finally {
    await page.close().catch(() => {});
    await driver.disconnect(session).catch(() => {});
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
