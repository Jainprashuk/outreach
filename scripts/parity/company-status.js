/**
 * Parity: POST /api/companies/status (lib/companyView.companyStatus) vs the
 * Company page's name-matched totals, for the companies on your Naukri jobs.
 * READ-ONLY.   node scripts/parity/company-status.js   (NODE_ENV=prod for prod)
 *
 * companyStatus matches by NAME only; companyDetail also adds contacts on the
 * company's email domain. So the status count must be <= detail's, and equal
 * whenever the detail has no domain-only contacts.
 */
require('dotenv').config();
const assert = require('assert');
const mongoose = require('mongoose');
const NaukriJob = require('../../models/NaukriJob');
const { companyStatus, companyDetail } = require('../../lib/companyView');
const { keyOf } = require('../../lib/companyKey');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

(async () => {
  await mongoose.connect(uri);
  const jobs = await NaukriJob.find({ deleted: { $ne: true }, company: { $ne: '' } }, { userId: 1, company: 1 }).limit(3000).lean();
  const byUser = new Map();
  for (const j of jobs) {
    if (!byUser.has(String(j.userId))) byUser.set(String(j.userId), new Set());
    byUser.get(String(j.userId)).add(j.company);
  }
  let checked = 0, withContacts = 0;
  for (const [uid, set] of byUser) {
    const names = [...set].slice(0, 60);
    const st = await companyStatus(uid, names);
    for (const n of names) {
      const s = st[n];
      assert(s, `no status for ${n}`);
      const d = await companyDetail(uid, `n:${keyOf(n)}`);
      if (!d) continue;
      checked++;
      if (s.contacts) withContacts++;
      assert(s.contacts <= d.totals.contacts, `${n}: status ${s.contacts} > detail ${d.totals.contacts}`);
      if (s.contacts === d.totals.contacts) {
        assert.strictEqual(s.sent, d.totals.sent, `${n}: sent`);
        assert.strictEqual(s.replied, d.totals.replied, `${n}: replied`);
        assert.strictEqual(s.bounced, d.totals.bounced, `${n}: bounced`);
      }
    }
  }
  console.log(`[${env}] ${checked} companies checked, ${withContacts} with contacts — parity OK`);
  await mongoose.disconnect();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
