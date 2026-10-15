/**
 * Parity check for the Companies list and the company scorer computed from
 * per-domain contact stats (lib/discovery/contactDomains.js) against the code
 * that loaded every contact (the committed lib/discovery/companyWorth.js and
 * lib/companyView.js, read from git HEAD). READ-ONLY — it never writes.
 *
 * For every account: the database summary against statsFromContacts over the
 * old pre-load (every domain, every company-name vote, in order), the scorer's
 * full output, and GET /api/companies for every sort × a spread of searches
 * (incl. non-ASCII names) × limits.
 *
 *   NODE_ENV=prod node scripts/parity/companies.js [git-rev]
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const assert = require('assert');
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const rev = process.argv[2] || 'HEAD';
const root = path.join(__dirname, '../..');

// The old modules, beside the new ones so their relative requires resolve.
const oldWorthPath = path.join(root, 'lib/discovery/.parity-old-companyWorth.js');
const oldViewPath = path.join(root, 'lib/.parity-old-companyView.js');
fs.writeFileSync(oldWorthPath, execSync(`git show ${rev}:lib/discovery/companyWorth.js`, { cwd: root }));
fs.writeFileSync(oldViewPath, String(execSync(`git show ${rev}:lib/companyView.js`, { cwd: root }))
  .replace("require('./discovery/companyWorth')", "require('./discovery/.parity-old-companyWorth')"));
const cleanup = () => { for (const p of [oldWorthPath, oldViewPath]) try { fs.unlinkSync(p); } catch (_) { /* gone */ } };

const oldWorth = require(oldWorthPath);
const oldView = require(oldViewPath);
const newWorth = require('../../lib/discovery/companyWorth');
const newView = require('../../lib/companyView');
const { statsFromContacts, domainStats, OLD_PROJECTION } = require('../../lib/discovery/contactDomains');
const { keyOf } = require('../../lib/discovery/hiringCompanies');

const json = (x) => JSON.parse(JSON.stringify(x));
const mapJson = (m) => [...m.entries()].map(([k, v]) => [k, v instanceof Map ? mapJson(v) : v]);

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}, old code from ${rev}`);

  // The old list reloads every contact per call; load once per account instead.
  const realScored = oldWorth.scoredWithData;
  const memo = new Map();
  oldWorth.scoredWithData = (uid, opts) => {
    const k = String(uid);
    if (!memo.has(k)) memo.set(k, realScored(uid, opts));
    return memo.get(k);
  };

  let checks = 0;
  for (const userId of await Contact.distinct('userId', { deleted: { $ne: true } })) {
    const t0 = Date.now();
    const same = (label, a, b) => { checks++; assert.deepStrictEqual(json(a), json(b), `user ${userId}: ${label} differs`); };
    const now = new Date();

    // 1. The summary itself, for every domain and every vote.
    const contacts = await Contact.find({ userId, deleted: { $ne: true } }, OLD_PROJECTION).lean();
    const ref = statsFromContacts(contacts, { now, rules: newWorth.RULES, keyOf });
    // Votes for the keys the scorer asks about (name-only hiring rows) plus a random sample.
    const data = await newWorth.loadWorthData(userId, { now });
    const { mergeHiring } = require('../../lib/discovery/hiringCompanies');
    const asked = [...mergeHiring(data.leads, data.naukri).values()].filter(r => !r.domain).map(r => keyOf(r.company || ''));
    const allKeys = [...ref.votes.keys()];
    const nks = [...new Set([...asked, ...allKeys.filter((_, i) => i % Math.max(1, Math.floor(allKeys.length / 300)) === 0)])].filter(Boolean);
    const db = await domainStats(Contact, userId, { now, rules: newWorth.RULES, keyOf, domains: [...ref.byDomain.keys()], nks });
    same('domain stats', Object.fromEntries([...db.byDomain].sort()), Object.fromEntries([...ref.byDomain].sort()));
    same('company-name votes (in order)', mapJson(db.votes), mapJson(new Map([...ref.votes].filter(([k]) => nks.includes(k)))));

    // 2. The scorer.
    same('scored companies', await newWorth.scoredCompanies(userId, { now }), await oldWorth.scoredCompanies(userId, { now }));

    // 3. The list, as GET /api/companies gives it.
    const sample = (await oldView.companyList(userId, { limit: 300 })).companies;
    const names = sample.map(r => r.company).filter(Boolean);
    const qs = ['', 'a', 'tech', '.in', 'zzzz-none', '  SOFT ',
      ...names.slice(0, 3).map(n => n.slice(0, 4)),
      ...names.filter(n => /[^\x00-\x7F]/.test(n)).slice(0, 2),
      ...sample.slice(5, 7).map(r => (r.domain || '').split('.')[0])];
    for (const sort of ['score', 'recent', 'contacts']) for (const q of qs) for (const limit of [100, 7, 300, 1]) {
      same(`list sort=${sort} q=${JSON.stringify(q)} limit=${limit}`,
        await newView.companyList(userId, { q, sort, limit }), await oldView.companyList(userId, { q, sort, limit }));
    }
    console.log(`✅  user ${userId}: ${contacts.length} contacts, ${ref.byDomain.size} domains, ${ref.votes.size} name keys — identical (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  await mongoose.disconnect();
  cleanup();
  console.log(`All ${checks} companies checks passed.`);
})().catch(async (err) => {
  console.error('❌ ', err.message.slice(0, 3000));
  cleanup();
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
