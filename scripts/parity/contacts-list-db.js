/**
 * Parity check for GET /api/contacts/list computed in the database
 * (lib/contactListDb.js listResponse) against the in-memory version it replaced
 * (memoryListResponse — the code scripts/parity/contacts-list.js proved against
 * the old browser code). READ-ONLY — it never writes.
 *
 * For every account: every tab × sort × direction, searches (incl. non-ASCII and
 * the name|email boundary), each dropdown filter, company spellings, date
 * ranges, paging (incl. past the end), page sizes and select-all ids. Each pair
 * of responses must be identical JSON — rows, order, totals and counts.
 *
 *   TZ=Asia/Kolkata NODE_ENV=prod node scripts/parity/contacts-list-db.js
 */
require('dotenv').config();
const assert = require('assert');
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const contactList = require('../../lib/contactList');
const { listResponse, memoryListResponse } = require('../../lib/contactListDb');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const serialize = (doc) => { const o = { ...doc }; o.id = doc._id.toString(); delete o._id; delete o.__v; return o; };

const TABS = ['all', 'sent', 'pending', 'remaining', 'in-campaign', 'bounced', 'replied', 'followup-due',
  'follow-up-sent', 'follow-up-replied', 'closed', 'no-openings', 'in-review', 'blocked', 'nonsense'];
const SORTS = [null, 'name', 'company', 'template', 'status', 'approval', 'lastSentAt', 'repliedAt', 'createdAt', 'nonsense'];
const NON_ASCII = /[^\x00-\x7F]/;

let seed = 7;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pickN = (arr, n) => Array.from({ length: Math.min(n, arr.length) }, () => arr[rnd(arr.length)]);

function searchSamples(cs) {
  const out = new Set(['a', 'e', '@', '.com', 'gmail', 'undefined', 'null', '  ', 'ZZZZ-no-match', 'İ', 'é']);
  const hayOf = c => String(c.name) + String(c.email) + String(c.company);
  const withAccents = cs.filter(c => NON_ASCII.test(hayOf(c)));
  for (const c of [...pickN(cs, 30), ...pickN(withAccents, 15)]) {
    const hay = hayOf(c);
    const start = rnd(Math.max(1, hay.length - 4)); const sub = hay.slice(start, start + 2 + rnd(5));
    out.add(sub); out.add(sub.toUpperCase()); out.add(`  ${sub} `);
  }
  for (const c of withAccents.slice(0, 10)) { // the accented characters themselves
    const ch = [...hayOf(c)].find(x => NON_ASCII.test(x)); if (ch) { out.add(ch); out.add(ch.toUpperCase()); }
  }
  for (const c of pickN(cs, 8)) out.add(String(c.name).slice(-2) + String(c.email).slice(0, 2));
  return [...out];
}

function companySamples(cs) {
  const names = [...new Set(cs.map(c => c.company).filter(Boolean))];
  const out = new Set(['zzzz no such company', ' ']);
  for (const n of [...pickN(names, 12), ...names.filter(n => NON_ASCII.test(n)).slice(0, 8)]) {
    out.add(n); out.add(`  ${n.toUpperCase()}  `); out.add(n.replace(/ /g, '\t  '));
  }
  return [...out];
}

function dateSamples(cs) {
  const days = new Set();
  for (const c of pickN(cs, 400)) for (const f of ['createdAt', 'lastSentAt', 'repliedAt']) {
    if (c[f]) { const d = new Date(c[f]); days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }
  }
  const list = [...days].sort();
  const pick = i => list[Math.floor(i * (list.length - 1))] || '';
  const from = d => d ? new Date(`${d}T00:00:00`).toISOString() : '';
  const to = d => d ? new Date(`${d}T23:59:59.999`).toISOString() : '';
  return [[pick(0.1), ''], ['', pick(0.5)], [pick(0.3), pick(0.7)], [pick(0.5), pick(0.5)], [pick(0.9), pick(0.2)]]
    .map(([a, b]) => [from(a), to(b)]);
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}, TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  const userIds = await Contact.distinct('userId', { deleted: { $ne: true } });
  let checks = 0;
  for (const userId of userIds) {
    const t0 = Date.now();
    const slim = await Contact.find({ deleted: { $ne: true }, userId }, contactList.FILTER_FIELDS).sort({ createdAt: -1 }).lean();
    console.log(`user ${userId}: ${slim.length} contacts loaded in ${Date.now() - t0} ms`);

    const check = async (query) => {
      const [a, b] = await Promise.all([
        memoryListResponse(Contact, userId, query, serialize, slim),
        listResponse(Contact, userId, query, serialize),
      ]);
      if (b === null) throw new Error(`database version declined ${JSON.stringify(query)} — expected it to handle every prod account`);
      // followUpDue is time-based; both ran within the same second.
      assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), `differs for ${JSON.stringify(query)}`);
      if (++checks % 50 === 0) console.log(`  … ${checks} checks identical`);
    };
    const run = async (queries) => { for (let i = 0; i < queries.length; i += 8) await Promise.all(queries.slice(i, i + 8).map(check)); };

    const opts = (field) => [...new Set(slim.map(c => c[field]).filter(v => v != null && v !== ''))];
    const searches = searchSamples(slim), companies = companySamples(slim), dates = dateSamples(slim);
    const queries = [];
    for (const tab of TABS) {
      for (const sort of SORTS) for (const dir of ['asc', 'desc']) {
        queries.push({ tab, ...(sort ? { sort, dir } : {}) });
        queries.push({ tab, ...(sort ? { sort, dir } : {}), page: '2', limit: '7' });
      }
      queries.push({ tab, page: '9999' }, { tab, limit: '500', page: '3' }, { tab, ids: '1' }, { tab, ids: '1', sort: 'name', dir: 'asc' });
      for (const q of tab === 'all' ? searches : searches.slice(0, 12)) queries.push({ tab, q }, { tab, q, sort: 'name', dir: 'asc' });
      for (const v of [...opts('status'), 'no-such']) queries.push({ tab, status: v });
      for (const v of opts('approvalStatus')) queries.push({ tab, approval: v });
      for (const v of opts('template')) queries.push({ tab, template: v }, { tab, template: v, sort: 'lastSentAt', dir: 'desc' });
      for (const v of opts('replyCategory')) queries.push({ tab, category: v });
      for (const v of ['outreach', 'lead', 'discover', 'library', 'naukri', 'nope']) queries.push({ tab, source: v });
      for (const v of tab === 'all' ? companies : companies.slice(0, 6)) queries.push({ tab, company: v });
      for (const [from, to] of dates) for (const f of ['created', 'sent', 'replied']) {
        queries.push({ tab, [`${f}From`]: from, [`${f}To`]: to });
      }
      queries.push({ tab, q: 'a', template: opts('template')[0] || '', source: 'outreach', sort: 'company', dir: 'desc', page: '2' });
    }
    await run(queries);
    console.log(`✅  user ${userId}: ${queries.length} queries identical (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  await mongoose.disconnect();
  console.log(`All ${checks} checks passed.`);
})().catch(async (err) => {
  console.error('❌ ', err.message.slice(0, 3000));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
