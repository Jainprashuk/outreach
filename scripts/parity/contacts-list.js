/**
 * Parity check for GET /api/contacts/list. READ-ONLY — it never writes.
 *
 * Runs the OLD browser code (scripts/parity/reference/contactsClient.ts,
 * verbatim from the pages) over exactly what the old GET /api/contacts sent the
 * browser, and the NEW server port (lib/contactList.js) over the slim
 * projection the new endpoint loads — for every tab, filter, a spread of real
 * search strings, date ranges and every sort — and requires the same ids in
 * the same order, and the same counts.
 *
 *   TZ=Asia/Kolkata node scripts/parity/contacts-list.js
 *   TZ=Asia/Kolkata NODE_ENV=prod node scripts/parity/contacts-list.js
 *
 * TZ matters: the old date filter read yyyy-mm-dd in the browser's timezone,
 * and the new page converts it to an instant the same way before sending it.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const contactList = require('../../lib/contactList');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

function loadReference() {
  const esbuild = require(path.join(__dirname, '../../client/node_modules/esbuild'));
  const out = path.join(os.tmpdir(), `contacts-ref-${process.pid}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'reference/contactsClient.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  const ref = require(out);
  fs.unlinkSync(out);
  return ref;
}

// What the browser held: GET /api/contacts → serialize → JSON.
const serialize = (doc) => { const o = { ...doc }; o.id = doc._id.toString(); delete o._id; delete o.__v; return o; };

const CONTACTS_TABS = ['all', 'sent', 'pending', 'remaining', 'in-campaign', 'bounced', 'replied', 'followup-due',
  'follow-up-sent', 'follow-up-replied', 'closed', 'no-openings', 'in-review', 'blocked'];
const SORTS = ['name', 'company', 'template', 'status', 'approval', 'lastSentAt', 'repliedAt', 'createdAt'];
const NO_DATES = { createdFrom: '', createdTo: '', sentFrom: '', sentTo: '', repliedFrom: '', repliedTo: '' };

// The page turns a yyyy-mm-dd into the instant it sends (see useContactList).
const fromInstant = d => d ? new Date(`${d}T00:00:00`).toISOString() : '';
const toInstant = d => d ? new Date(`${d}T23:59:59.999`).toISOString() : '';

function searchSamples(cs) {
  const out = new Set(['', 'a', 'e', '@', '.com', 'gmail', 'undefined', 'null', '  ', 'ZZZZ-no-match']);
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 60 && cs.length; i++) {
    const c = cs[rnd(cs.length)];
    const hay = String(c.name) + String(c.email) + String(c.company);
    const start = rnd(Math.max(1, hay.length - 4)); const len = 2 + rnd(5);
    const sub = hay.slice(start, start + len);
    out.add(sub); out.add(sub.toUpperCase()); out.add(`  ${sub} `);
  }
  // Across the name|email boundary — the old search matched the concatenation.
  for (let i = 0; i < 10 && cs.length; i++) {
    const c = cs[rnd(cs.length)];
    out.add(String(c.name).slice(-2) + String(c.email).slice(0, 2));
  }
  return [...out];
}

function dateSamples(cs) {
  const days = new Set();
  for (const c of cs.slice(0, 400)) for (const f of ['createdAt', 'lastSentAt', 'repliedAt']) {
    if (c[f]) { const d = new Date(c[f]); days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }
  }
  const list = [...days].sort();
  const pick = i => list[Math.floor(i * (list.length - 1))] || '';
  return [[pick(0.1), ''], ['', pick(0.5)], [pick(0.3), pick(0.7)], [pick(0.5), pick(0.5)], [pick(0.9), pick(0.2)]];
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  const ref = loadReference();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}, TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  const userIds = await Contact.distinct('userId', { deleted: { $ne: true } });
  let checks = 0;
  for (const userId of userIds) {
    const filter = { deleted: { $ne: true }, userId };
    const [oldDocs, slim] = await Promise.all([
      Contact.find(filter, { 'thread.html': 0 }).sort({ createdAt: -1 }).lean(),
      Contact.find(filter, contactList.FILTER_FIELDS).sort({ createdAt: -1 }).lean(),
    ]);
    const browser = JSON.parse(JSON.stringify(oldDocs.map(serialize)));
    const ids = list => list.map(c => String(c.id || c._id));
    const same = (label, oldList, newList) => {
      checks++;
      const a = ids(oldList), b = ids(newList);
      if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
        const i = a.findIndex((id, k) => id !== b[k]);
        throw new Error(`${label}: old ${a.length} rows vs new ${b.length}, first difference at #${i} (${a[i]} vs ${b[i]})`);
      }
    };
    const q = (o) => contactList.parseListQuery(o);

    assert.deepStrictEqual(contactList.getStats(slim), ref.getStats(browser), `user ${userId}: stats differ`); checks++;
    assert.strictEqual(slim.map(c => String(c._id)).join(), browser.map(c => c.id).join(), 'base order differs'); checks++;

    const opts = (field) => [...new Set(browser.map(c => c[field]).filter(v => v != null && v !== ''))];
    const statuses = opts('status'), approvals = opts('approvalStatus'), templates = opts('template'),
      categories = opts('replyCategory'), sources = ['outreach', 'lead'];
    const searches = searchSamples(browser);

    for (const tab of CONTACTS_TABS) {
      // Contacts page: tab × search, then each other filter on its own.
      for (const search of searches) {
        same(`contacts tab=${tab} q=${JSON.stringify(search)}`,
          ref.contactsFiltered(browser, { tab, search, statusFilter: '', approvalFilter: '', templateFilter: '', categoryFilter: '', sourceFilter: '', dateFilters: NO_DATES }),
          contactList.applyListQuery(slim, q({ tab, q: search })));
      }
      const one = (label, refState, newQuery) => same(`contacts tab=${tab} ${label}`,
        ref.contactsFiltered(browser, { tab, search: '', statusFilter: '', approvalFilter: '', templateFilter: '', categoryFilter: '', sourceFilter: '', dateFilters: NO_DATES, ...refState }),
        contactList.applyListQuery(slim, q({ tab, ...newQuery })));
      for (const v of statuses) one(`status=${v}`, { statusFilter: v }, { status: v });
      for (const v of approvals) one(`approval=${v}`, { approvalFilter: v }, { approval: v });
      for (const v of templates) one(`template=${v}`, { templateFilter: v }, { template: v });
      for (const v of categories) one(`category=${v}`, { categoryFilter: v }, { category: v });
      // 'Added directly' no longer includes contacts moved in from Discover — they have
      // their own 'From Discover' option (lib/contactList.js sourceOf). That is the one
      // intended change, so the old result is compared with exactly those removed.
      for (const v of sources) {
        const want = ref.contactsFiltered(browser, { tab, search: '', statusFilter: '', approvalFilter: '', templateFilter: '', categoryFilter: '', sourceFilter: v, dateFilters: NO_DATES })
          .filter(c => !(v === 'outreach' && c.prospectId));
        same(`contacts tab=${tab} source=${v}`, want, contactList.applyListQuery(slim, q({ tab, source: v })));
      }
      same(`contacts tab=${tab} source=discover`,
        ref.contactsFiltered(browser, { tab, search: '', statusFilter: '', approvalFilter: '', templateFilter: '', categoryFilter: '', sourceFilter: '', dateFilters: NO_DATES }).filter(c => c.prospectId),
        contactList.applyListQuery(slim, q({ tab, source: 'discover' })));
      for (const [from, to] of dateSamples(browser)) for (const f of ['created', 'sent', 'replied']) {
        one(`${f} ${from}..${to}`, { dateFilters: { ...NO_DATES, [`${f}From`]: from, [`${f}To`]: to } },
          { [`${f}From`]: fromInstant(from), [`${f}To`]: toInstant(to) });
      }
      // Dashboard: every sort × direction, plus a few searches and filters under a sort.
      for (const sortCol of SORTS) for (const sortDir of ['asc', 'desc']) {
        same(`dashboard tab=${tab} sort=${sortCol} ${sortDir}`,
          ref.dashboardFiltered(browser, { tab, search: '', statusFilter: '', approvalFilter: '', templateFilter: '', sortCol, sortDir }),
          contactList.applyListQuery(slim, q({ tab, sort: sortCol, dir: sortDir })));
      }
      for (const search of searches.slice(0, 15)) for (const v of [...templates.slice(0, 2), '']) {
        same(`dashboard tab=${tab} q=${JSON.stringify(search)} template=${v} sort=name asc`,
          ref.dashboardFiltered(browser, { tab, search, statusFilter: '', approvalFilter: '', templateFilter: v, sortCol: 'name', sortDir: 'asc' }),
          contactList.applyListQuery(slim, q({ tab, q: search, template: v, sort: 'name', dir: 'asc' })));
      }
    }
    console.log(`✅  user ${userId}: ${browser.length} contacts — every combination identical`);
  }
  await mongoose.disconnect();
  console.log(`All ${checks} contact-list checks passed.`);
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
