// Proves the small shared changes behind the module links, with no database:
// - {{jobTitle}} in lib/renderTemplate.js (and that templates without it are unchanged)
// - importContacts' new optional fields and the opt-in fillBlanks
//   (lib/contactImport.js, with the Contact model stubbed)
// - lib/companyKey.js
// Run with:  node scripts/test-module-links.js

const Contact = require('../models/Contact');
const { renderTemplate } = require('../lib/renderTemplate');
const { keyFor, parseKey } = require('../lib/companyKey');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── Contact stub: an in-memory "collection" ─────────────────────────────────
let rows = [];
let lastInsert = null;
let writes = [];
Contact.find = (filter, projection) => ({
  collation: () => ({
    lean: async () => rows.filter(r => filter.email.$in.includes(r.email)).map(r => {
      const out = { _id: r._id, email: r.email };
      for (const k of Object.keys(projection || {})) if (k !== 'email') out[k] = r[k];
      return out;
    }),
  }),
});
Contact.insertMany = async (docs) => { lastInsert = docs; return docs.map((d, i) => ({ ...d, _id: `new${i}` })); };
Contact.bulkWrite = async (ops) => { writes = ops; return { modifiedCount: ops.length }; };
const { importContacts } = require('../lib/contactImport');

(async () => {
  console.log('\nrenderTemplate {{jobTitle}}');
  const sender = { name: 'Asha', company: 'Self', vars: [] };
  const plain = { subject: '{{role}} at {{company}}', body: 'Hi {{name}}, about {{role}}.' };
  const c = { name: 'Rahul Sharma', company: 'Acme', role: 'Engineering Manager' };
  eq('template without the variable: unchanged', renderTemplate(plain, { ...c, jobTitle: 'Backend Engineer' }, sender), renderTemplate(plain, c, sender));
  eq('filled', renderTemplate({ subject: 'Applied for {{jobTitle}}', body: '{{jobTitle}} at {{company}}' }, { ...c, jobTitle: 'Backend Engineer' }, sender),
    { subject: 'Applied for Backend Engineer', body: 'Backend Engineer at Acme' });
  eq('missing jobTitle renders empty, never braces', renderTemplate({ subject: 'x {{jobTitle}} y', body: '' }, c, sender).subject, 'x  y');

  console.log('\nimportContacts');
  rows = [];
  await importContacts([{ name: 'A', email: 'a@acme.in', company: 'Acme', role: 'HR' }], 'u1');
  eq('a plain row inserts exactly the old keys', Object.keys(lastInsert[0]).sort(), ['company', 'email', 'name', 'role', 'source', 'sourceLeadId', 'template', 'userId'].sort());

  await importContacts([{ name: 'A', email: 'b@acme.in', jobTitle: '  Backend Engineer ', naukriJobId: 'j1', linkedin: 'https://www.linkedin.com/in/someone' }], 'u1');
  eq('new optional fields stored when given', [lastInsert[0].jobTitle, lastInsert[0].naukriJobId, lastInsert[0].linkedin], ['Backend Engineer', 'j1', 'https://www.linkedin.com/in/someone']);
  await importContacts([{ name: 'A', email: 'c@acme.in', linkedin: 'javascript:alert(1)' }], 'u1');
  ok('a non-LinkedIn URL is dropped', !('linkedin' in lastInsert[0]));

  rows = [{ _id: 'x1', email: 'old@acme.in', company: '', role: 'CTO', linkedin: '', jobTitle: '' }];
  writes = [];
  let r = await importContacts([{ name: 'Old', email: 'OLD@acme.in', company: 'Acme', role: 'Recruiter', linkedin: 'https://linkedin.com/in/old' }], 'u1');
  eq('without fillBlanks nothing is written to an existing contact', writes.length, 0);
  eq('…and filled is 0', r.filled, 0);

  r = await importContacts([{ name: 'Old', email: 'OLD@acme.in', company: 'Acme', role: 'Recruiter', linkedin: 'https://linkedin.com/in/old' }], 'u1', { fillBlanks: true });
  eq('fillBlanks fills only empty fields', writes[0] && writes[0].updateOne.update.$set, { company: 'Acme', linkedin: 'https://linkedin.com/in/old' });
  ok('an existing value (role) is never overwritten', !('role' in writes[0].updateOne.update.$set));
  ok('scoped to the user', writes[0].updateOne.filter.userId === 'u1');
  ok('source / prospectId never touched', !Object.keys(writes[0].updateOne.update.$set).some(k => ['source', 'prospectId', 'sourceLeadId'].includes(k)));
  eq('filled count', r.filled, 1);
  eq('nothing new inserted', r.created.length, 0);

  rows = [{ _id: 'x2', email: 'full@acme.in', company: 'Acme', role: 'HR', linkedin: 'https://linkedin.com/in/a', jobTitle: 'X' }];
  writes = [];
  await importContacts([{ name: 'F', email: 'full@acme.in', company: 'Other', role: 'Other' }], 'u1', { fillBlanks: true });
  eq('nothing empty → no write at all', writes.length, 0);

  console.log('\ncompanyKey');
  eq('domain key', keyFor({ domain: 'https://www.Acme.in/careers' }), 'd:acme.in');
  eq('name key when no domain', keyFor({ company: 'Acme Technologies Pvt Ltd' }), 'n:acme');
  eq('free-mail domain falls back to the name', keyFor({ domain: 'gmail.com', company: 'Acme' }), 'n:acme');
  eq('parse d:', parseKey('d:acme.in'), { domain: 'acme.in' });
  eq('parse bare domain', parseKey('acme.in'), { domain: 'acme.in' });
  eq('parse n:', parseKey('n:acme'), { nameKey: 'acme' });
  eq('reject free-mail', parseKey('gmail.com'), null);
  eq('reject junk name key', parseKey('n:$where'), null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
