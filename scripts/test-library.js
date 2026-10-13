#!/usr/bin/env node
/**
 * Shared Library test (routes/library.js, lib/library.js).
 *
 * The Library is the one place that returns OTHER accounts' contact data, so
 * this asserts the promise made to every user:
 *   - only data leaves: every row has EXACTLY the allowlisted keys, and none of
 *     the planted progress (reply text, thread body, notes, status) appears;
 *   - opted-out, disabled and deleted rows never appear;
 *   - a bounced address is flagged and never imported;
 *   - import writes only into the caller's account, as pending, and respects
 *     the caller's blocklist;
 *   - only an admin, or someone an admin turned it on for, can read it.
 *
 * Dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-library.js --base=http://localhost:4099 --email=admin@example.com
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { loginViaOtp } = require('./test-helpers');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4099';
const URI = process.env.MONGODB_URI_DEV;

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const call = async (method, path, cookie, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};

// Keep in step with shapeRow() in lib/library.js — a new key must be added in both
// places on purpose.
const BASE_KEYS = ['key', 'addedBy', 'firstAt', 'lastAt'];
const PERSON = ['email', 'bounced', 'inMine'];
const KEYS = {
  people: [...BASE_KEYS, ...PERSON, 'name', 'company', 'role', 'jobTitle', 'linkedin', 'sources'],
  leads: [...BASE_KEYS, ...PERSON, 'name', 'company', 'role', 'location', 'authorUrl', 'postUrl', 'postedAt', 'sources'],
  discover: [...BASE_KEYS, ...PERSON, 'name', 'title', 'company', 'domain', 'linkedin', 'emailPattern', 'emailConfidence', 'foundVia'],
  companies: [...BASE_KEYS, 'domain', 'company', 'people', 'contacts', 'leads', 'prospects', 'contributors', 'formats', 'genericEmails'],
};
const sameKeys = (row, want) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...want].sort());

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  const email = value('email');
  if (!email) throw new Error('Pass --email= for an admin account');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const contacts = db.collection('contacts');
  const leads = db.collection('leads');
  const prospects = db.collection('prospects');
  const patterns = db.collection('companypatterns');
  const blocklists = db.collection('blocklists');

  const admin = await users.findOne({ email: email.toLowerCase() });
  if (!admin || admin.isAdmin !== true) throw new Error(`${email} must be an existing admin`);

  const ts = Date.now();
  const DOMAIN = `zzlib${ts}.example`;
  const at = (local) => `${local}@${DOMAIN}`;
  const SECRETS = [`ZZReplyText-${ts}`, `ZZThreadBody-${ts}`, `ZZNote-${ts}`, `ZZApplyNote-${ts}`];
  const now = new Date();
  const mkUser = (tag, extra = {}) => ({
    email: `library-${tag}-${ts}@example.invalid`, name: `ZZ ${tag} ${ts}`, isAdmin: false, status: 'active',
    createdAt: now, updatedAt: now,
    onboarding: { startedAt: null, completedAt: now, step: 99, skipped: [], version: 1 },
    ...extra,
  });
  const B = (await users.insertOne(mkUser('sharer'))).insertedId;
  const C = (await users.insertOne(mkUser('optout', { libraryOptOut: true }))).insertedId;
  const D = (await users.insertOne(mkUser('disabled', { status: 'disabled' }))).insertedId;
  const bDoc = await users.findOne({ _id: B });
  const planted = [];
  const plant = async (coll, doc) => { const r = await coll.insertOne({ createdAt: now, updatedAt: now, ...doc }); planted.push([coll, r.insertedId]); return r.insertedId; };

  // B shares: one contact full of progress, one bounced, one deleted.
  const b1 = await plant(contacts, {
    userId: B, name: 'Asha Rao', email: at('asha.rao'), company: 'ZZLib Co', role: 'Recruiter', source: 'outreach',
    status: 'replied', approvalStatus: 'approved', lastSentAt: now, repliedAt: now, replySnippet: SECRETS[0],
    thread: [{ direction: 'inbound', body: SECRETS[1], at: now }], editedBody: SECRETS[2],
    action: { state: 'needs-you', reason: 'reply' }, statusHistory: [],
  });
  await plant(contacts, { userId: B, name: 'Bo Bounce', email: at('bo.bounce'), company: 'ZZLib Co', status: 'bounced', bounceReason: '550 no such user', approvalStatus: 'approved' });
  await plant(contacts, { userId: B, name: 'Del Eted', email: at('del.eted'), company: 'ZZLib Co', status: 'queued', deleted: true, deletedAt: now });
  await plant(contacts, { userId: B, name: 'Blo Cked', email: at('blo.cked'), company: 'ZZLib Co', status: 'queued', approvalStatus: 'pending' });
  await plant(leads, {
    userId: B, authorName: 'Lee Lead', email: at('lee.lead'), company: 'ZZLib Co', role: 'Hiring manager',
    source: 'hn', postUrl: 'https://news.ycombinator.com/item?id=1', authorUrl: 'https://news.ycombinator.com/item?id=1',
    dedupeKey: `e:${at('lee.lead')}`, status: 'added-to-outreach', applyStatus: 'applied', applyNote: SECRETS[3], fitScore: 5,
  });
  await plant(prospects, {
    userId: B, domain: DOMAIN, company: 'ZZLib Co', name: 'Pri High', nameKey: 'pri|high', title: 'Engineer',
    foundVia: ['github'], email: at('pri.high'), emailPattern: 'first.last', emailConfidence: 'high', emailSource: 'github',
    status: 'moved', note: SECRETS[2], contactId: 'x',
  });
  await plant(prospects, {
    userId: B, domain: DOMAIN, company: 'ZZLib Co', name: 'Low Guess', nameKey: 'low|guess', title: 'Engineer',
    foundVia: ['search'], email: at('low'), emailPattern: 'first', emailConfidence: 'low', emailSource: 'default', status: 'ready',
  });
  await plant(prospects, { userId: B, domain: DOMAIN, company: 'ZZLib Co', name: 'Dis Carded', nameKey: 'dis|carded', status: 'discarded', foundVia: ['search'] });
  await plant(patterns, { userId: B, domain: DOMAIN, companyName: 'ZZLib Co', manualPattern: 'first.last', manualFrom: 'test', genericEmails: [at('careers')] });
  // C opted out, D is disabled: neither may appear.
  await plant(contacts, { userId: C, name: 'Opt Out', email: at('opt.out'), company: 'ZZLib Co', status: 'queued' });
  await plant(contacts, { userId: D, name: 'Dis Abled', email: at('dis.abled'), company: 'ZZLib Co', status: 'queued' });
  // The admin's own blocklist, to prove import honours it.
  await plant(blocklists, { userId: admin._id, type: 'email', value: at('blo.cked'), reason: 'test' });

  const importedEmails = [at('asha.rao'), at('bo.bounce'), at('blo.cked'), at('lee.lead'), at('pri.high'), at('low')];
  const adminHadBefore = await contacts.countDocuments({ userId: admin._id, email: { $in: importedEmails } });
  if (adminHadBefore) throw new Error('The admin already has a planted address — rerun');
  const bBefore = await contacts.find({ userId: B }).sort({ _id: 1 }).toArray();

  try {
    const adminCookie = await loginViaOtp({ base: BASE, email });
    const bCookie = await loginViaOtp({ base: BASE, email: bDoc.email });
    const q = `domain=${encodeURIComponent(DOMAIN)}&limit=100`;

    console.log('\nAccess: hidden unless an admin turns it on');
    let r = await call('GET', `/api/library/people?${q}`, '');
    check(r.status === 401, `signed out -> ${r.status} (want 401)`);
    r = await call('GET', `/api/library/people?${q}`, bCookie);
    check(r.status === 403, `a user without access -> ${r.status} (want 403)`);
    r = await call('POST', '/api/library/import', bCookie, { tab: 'people', keys: [at('asha.rao')] });
    check(r.status === 403, `their import -> ${r.status} (want 403)`);
    r = await call('GET', '/api/share/session', bCookie);
    check(r.data && r.data.user && r.data.user.canSeeLibrary === false, 'their session says canSeeLibrary: false');
    r = await call('POST', `/api/admin/users/${B}/library-access`, bCookie, { on: true });
    check(r.status === 403, `they cannot turn it on themselves -> ${r.status} (want 403)`);
    const forged = await fetch(`${BASE}/api/library/people?${q}`, { headers: { 'X-Worker-Secret': 'wk_forged' } });
    check(forged.status === 401 || forged.status === 403, `a forged worker token -> ${forged.status}`);
    r = await call('POST', `/api/admin/users/${B}/library-access`, adminCookie, { on: true });
    check(r.status === 200 && r.data.libraryAccess === true && Object.keys(r.data).sort().join() === 'libraryAccess,ok', 'the admin turns it on (answer is the flag only)');
    r = await call('GET', `/api/library/people?${q}`, bCookie);
    check(r.status === 200, `now they get ${r.status} (want 200)`);
    r = await call('GET', '/api/share/session', bCookie);
    check(r.data && r.data.user && r.data.user.canSeeLibrary === true, 'and their session says canSeeLibrary: true');
    await call('POST', `/api/admin/users/${B}/library-access`, adminCookie, { on: false });
    r = await call('GET', `/api/library/people?${q}`, bCookie);
    check(r.status === 403, `turned off again -> ${r.status} (want 403, on the very next request)`);

    console.log('\nPeople: data only, the right rows');
    r = await call('GET', `/api/library/people?${q}`, adminCookie);
    check(r.status === 200, `admin -> ${r.status}`);
    const people = (r.data && r.data.rows) || [];
    const byEmail = new Map(people.map(p => [p.email, p]));
    check(byEmail.has(at('asha.rao')), 'a shared contact appears');
    check(!byEmail.has(at('opt.out')), 'an opted-out account\'s contact does not');
    check(!byEmail.has(at('dis.abled')), 'a disabled account\'s contact does not');
    check(!byEmail.has(at('del.eted')), 'a deleted contact does not');
    check(byEmail.get(at('bo.bounce'))?.bounced === true, 'a bounced address is flagged');
    check(byEmail.get(at('asha.rao'))?.bounced === false, 'a good address is not');
    check(people.every(p => sameKeys(p, KEYS.people)), 'every row has exactly the allowlisted keys');
    check(byEmail.get(at('asha.rao'))?.addedBy?.[0]?.name === bDoc.name, 'it says who added it');

    console.log('\nLeads, Discover, Companies');
    const all = { people: r.data };
    for (const tab of ['leads', 'discover', 'companies']) {
      const res = await call('GET', `/api/library/${tab}?${tab === 'companies' ? `q=${DOMAIN}` : q}`, adminCookie);
      all[tab] = res.data;
      const rows = (res.data && res.data.rows) || [];
      check(res.status === 200 && rows.length > 0, `${tab}: ${rows.length} row(s)`);
      check(rows.every(x => sameKeys(x, KEYS[tab])), `${tab}: exactly the allowlisted keys`);
    }
    const disc = all.discover.rows || [];
    check(!disc.some(p => p.name === 'Dis Carded'), 'a discarded Discover person does not appear');
    const co = (all.companies.rows || []).find(c => c.domain === DOMAIN);
    check(co && co.formats.some(f => f.pattern === 'first.last' && f.tested), 'the company shows the format a user set');
    check(co && co.people >= 4 && co.contributors === 1, `the company counts people (${co && co.people}) from one contributor`);

    console.log('\nNothing but data leaves');
    const json = JSON.stringify(all);
    check(SECRETS.every(s => !json.includes(s)), 'no reply text, thread body, note or apply note anywhere');
    check(!/"(status|approvalStatus|repliedAt|replySnippet|thread|action|note|applyNote|applyStatus|lastSentAt|userId|bounceReason)"/.test(json),
      'no progress key names anywhere');

    console.log('\nImport writes only into the caller\'s account');
    r = await call('POST', '/api/library/import', adminCookie, {
      tab: 'people', keys: [at('asha.rao'), at('bo.bounce'), at('blo.cked'), at('opt.out'), at('nobody')], template: 'zz-test',
    });
    check(r.status === 200, `import -> ${r.status}`);
    const res1 = r.data || {};
    check(res1.created === 1, `1 created (got ${res1.created})`);
    check(res1.bounced === 1, `the bounced one skipped (got ${res1.bounced})`);
    check(res1.blocked === 1, `the blocklisted one skipped (got ${res1.blocked})`);
    check(res1.notFound === 2, `an opted-out / unknown key matches nothing (got ${res1.notFound})`);
    const mine = await contacts.findOne({ userId: admin._id, email: at('asha.rao') });
    check(mine && mine.approvalStatus === 'pending' && mine.status === 'queued', 'it lands pending + queued');
    check(mine && mine.fromLibrary === true && mine.source === 'outreach' && !mine.prospectId, 'marked fromLibrary, source unchanged');
    check(mine && !mine.replySnippet && !mine.repliedAt && !(mine.thread || []).length, 'none of their progress came with it');
    r = await call('POST', '/api/library/import', adminCookie, { tab: 'people', keys: [at('asha.rao')], template: 'zz-test' });
    check(r.data && r.data.created === 0 && r.data.existing === 1, 'importing again is a no-op');
    r = await call('POST', '/api/library/import', adminCookie, { tab: 'discover', keys: [`${DOMAIN}|pri|high`, `${DOMAIN}|low|guess`], template: 'zz-test' });
    check(r.data && r.data.created === 1 && r.data.lowConfidence === 1, 'Discover: the high guess is added, the low one skipped');
    r = await call('POST', '/api/library/import', adminCookie, { tab: 'leads', keys: [`e:${at('lee.lead')}`], template: 'zz-test' });
    check(r.data && r.data.created === 1, 'Leads: a lead with an email is added');
    r = await call('POST', '/api/library/import', adminCookie, { tab: 'companies', keys: [DOMAIN] });
    check(r.status === 400, `companies cannot be imported -> ${r.status}`);
    const bAfter = await contacts.find({ userId: B }).sort({ _id: 1 }).toArray();
    check(JSON.stringify(bAfter) === JSON.stringify(bBefore), 'the other account\'s contacts are byte-identical');

    r = await call('GET', `/api/library/people?${q}`, adminCookie);
    check((r.data.rows || []).find(p => p.email === at('asha.rao'))?.inMine === true, 'the row now says "In my contacts"');
    r = await call('GET', `/api/library/people?${q}&hideMine=1&hideBounced=1`, adminCookie);
    const hidden = new Set((r.data.rows || []).map(p => p.email));
    check(!hidden.has(at('asha.rao')) && !hidden.has(at('bo.bounce')), 'Hide mine / Hide bounced work');

    console.log('\nOpting out removes your data at once');
    r = await call('PUT', '/api/settings/library-sharing', bCookie, { sharing: false });
    check(r.status === 200 && r.data.sharing === false, 'B turns sharing off');
    r = await call('GET', `/api/library/people?${q}`, adminCookie);
    check(!(r.data.rows || []).some(p => p.addedBy.some(a => a.name === bDoc.name)), 'none of B\'s rows remain');
    r = await call('GET', '/api/settings/library-sharing', bCookie);
    check(r.data && r.data.sharing === false, 'and the setting reads back off');
    r = await call('PUT', '/api/settings/library-sharing', bCookie, { sharing: 'yes' });
    check(r.status === 400, `a non-boolean -> ${r.status}`);
  } finally {
    for (const [coll, id] of planted) await coll.deleteOne({ _id: id });
    await contacts.deleteMany({ userId: admin._id, email: { $in: importedEmails } });
    for (const id of [B, C, D]) {
      const u = await users.findOne({ _id: id });
      await db.collection('sessions').deleteMany({ userId: id });
      if (u) await db.collection('logincodes').deleteMany({ email: u.email });
      await users.deleteOne({ _id: id });
    }
    await db.collection('activitylogs').deleteMany({ userId: { $in: [B, C, D] } });
    console.log('\nCleaned up the planted accounts, rows and imported contacts.');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
