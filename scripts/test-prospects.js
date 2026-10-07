#!/usr/bin/env node
/**
 * Discover API test — the move rules, labels from your own history, edits,
 * the daily cap on guesses, key storage, and isolation from another user's rows.
 * Drives the real HTTP API; makes no outside requests (no search, GitHub or website).
 *
 * Run against a DEV database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4012 node server.js
 *   node scripts/test-prospects.js --base=http://localhost:4012 --email=you@example.com
 *
 * Signs in by minting an ordinary Session row (no email is sent) and deletes it,
 * and every fixture, at the end.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const Contact = require('../models/Contact');
const Prospect = require('../models/Prospect');
const ProspectSearch = require('../models/ProspectSearch');
const CompanyPattern = require('../models/CompanyPattern');
const DiscoveryConfig = require('../models/DiscoveryConfig');
const { createSession } = require('../lib/session');
const crypto = require('crypto');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4012';
const EMAIL = (value('email') || '').toLowerCase();

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

let COOKIE = '';
const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE, ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) {}
  return { status: res.status, body, text };
};

const stamp = Date.now();
const DOMAIN = `tc-test-${stamp}.example`;
const DOMAIN2 = `tc-cap-${stamp}.example`;
const INTRUDER = new mongoose.Types.ObjectId();
const DAY = 24 * 3600 * 1000;

async function main() {
  if (!EMAIL) throw new Error('Pass --email=<a dev account>');
  await mongoose.connect(process.env.MONGODB_URI_DEV);
  const dbName = mongoose.connection.db.databaseName;
  if (!/dev/i.test(dbName)) throw new Error(`Refusing to run against ${dbName} — dev databases only`);
  console.log(`database: ${dbName}`);

  const user = await User.findOne({ email: EMAIL }).lean();
  if (!user) throw new Error(`No account ${EMAIL}`);
  const userId = user._id;
  const token = await createSession(userId);
  COOKIE = `outreach_session=${encodeURIComponent(token)}`;

  try {
    // ── fixtures ────────────────────────────────────────────────────────────
    await Contact.insertMany([
      { userId, name: 'Priya Verma', email: `priya.verma@${DOMAIN}`, status: 'replied', repliedAt: new Date(Date.now() - 3 * DAY) },
      { userId, name: 'Anil Mehta', email: `anil.mehta@${DOMAIN}`, status: 'queued' },
      { userId, name: 'Ravi Kumar', email: `ravik@${DOMAIN}`, status: 'queued' },
    ]);
    await CompanyPattern.create({ userId, domain: DOMAIN, companyName: 'TC Test', hasMx: true, mxCheckedAt: new Date(), genericEmails: [`careers@${DOMAIN}`] });
    const mk = (name, extra = {}) => ({ userId, domain: DOMAIN, company: 'TC Test', name, nameKey: require('../lib/emailPatterns').nameKey(name), foundVia: ['search'], ...extra });
    const docs = await Prospect.insertMany([
      mk('Neha Gupta'), mk('Anil Mehta'), mk('Ravi Kumar'), mk('Om'), mk('Venkatesh R'),
      mk('Sara Intruder', { userId: INTRUDER }),
    ]);
    const id = Object.fromEntries(docs.map(d => [d.name, String(d._id)]));
    const intruderSearch = await ProspectSearch.create({ userId: INTRUDER, domain: DOMAIN, steps: [] });

    // ── labels from your own history ───────────────────────────────────────
    console.log('\nlabels');
    let r = await api(`/api/prospects/patterns/${DOMAIN}/recheck`, { method: 'POST' });
    ok('recheck succeeds', r.status === 200, r.text);
    ok('format learned from your reply', r.body && r.body.pattern === 'first.last' && r.body.confidence === 'high', r.text);

    r = await api(`/api/prospects?domain=${DOMAIN}&status=all`);
    const by = Object.fromEntries((r.body.prospects || []).map(p => [p.name, p]));
    ok('only your prospects listed', r.body.prospects.length === 5 && !by['Sara Intruder'], `got ${r.body.prospects.length}`);
    ok('guess + high label', by['Neha Gupta'].email === `neha.gupta@${DOMAIN}` && by['Neha Gupta'].emailConfidence === 'high');
    ok('already a contact detected', !!by['Anil Mehta'].existingContactId);
    ok('same person under another address detected', by['Ravi Kumar'].contactedAs === `ravik@${DOMAIN}`, JSON.stringify(by['Ravi Kumar']));
    ok('single name gets no guess', by.Om.email === null && /full name/i.test(by.Om.note));
    ok('initial-only surname is low', by['Venkatesh R'].emailConfidence === 'low');

    r = await api(`/api/prospects/patterns/${DOMAIN}`);
    ok('format view', r.body && r.body.decision.pattern === 'first.last' && r.body.contactsAtDomain === 3, r.text);

    // ── edits ──────────────────────────────────────────────────────────────
    console.log('\nedits');
    r = await api(`/api/prospects/${id['Sara Intruder']}`, { method: 'PATCH', body: { email: 'x@y.com' } });
    ok("another user's prospect can't be edited", r.status === 404);
    r = await api(`/api/prospects/not-an-id`, { method: 'PATCH', body: { email: 'x@y.com' } });
    ok('bad id is 404, not 500', r.status === 404);
    r = await api(`/api/prospects/${id['Neha Gupta']}`, { method: 'PATCH', body: { email: 'not an email' } });
    ok('invalid address rejected', r.status === 400);
    r = await api(`/api/prospects/${id.Om}`, { method: 'PATCH', body: { email: `om@${DOMAIN}` } });
    ok('typed address is manual with no guessed label', r.body && r.body.prospect.emailSource === 'manual' && r.body.prospect.emailConfidence === null, r.text);
    await api(`/api/prospects/patterns/${DOMAIN}/recheck`, { method: 'POST' });
    r = await api(`/api/prospects?domain=${DOMAIN}&status=all`);
    ok('recheck never overwrites a typed address', r.body.prospects.find(p => p.name === 'Om').email === `om@${DOMAIN}`);

    // ── move ───────────────────────────────────────────────────────────────
    console.log('\nmove');
    r = await api('/api/prospects/move', { method: 'POST', body: { ids: [id['Neha Gupta'], id['Anil Mehta'], id.Om, id['Sara Intruder']], template: '' } });
    ok('move succeeds', r.status === 200, r.text);
    ok('moved 2, Anil reported as duplicate, intruder ignored', r.body.moved === 2 && r.body.duplicates === 1, r.text);
    const neha = await Contact.findOne({ userId, email: `neha.gupta@${DOMAIN}` }).lean();
    ok('contact is pending with prospect fields', neha && neha.approvalStatus === 'pending' && neha.prospectId === id['Neha Gupta']
      && neha.emailConfidence === 'high' && neha.emailPattern === 'first.last' && neha.source === 'outreach', JSON.stringify(neha));
    const om = await Contact.findOne({ userId, email: `om@${DOMAIN}` }).lean();
    ok('typed address moves without a confidence key', om && om.prospectId === id.Om && !('emailConfidence' in om));
    const intr = await Prospect.findById(id['Sara Intruder']).lean();
    ok("another user's prospect untouched", intr.status === 'new');
    r = await api('/api/prospects/move', { method: 'POST', body: { ids: [id['Neha Gupta']], template: '' } });
    ok('never moved twice', r.body.moved === 0 && r.body.alreadyMoved === 1, r.text);
    r = await api(`/api/prospects/${id['Neha Gupta']}`, { method: 'PATCH', body: { title: 'x' } });
    ok("a moved prospect can't be edited", r.status === 409);

    // ── analytics ──────────────────────────────────────────────────────────
    console.log('\nanalytics');
    await Contact.updateOne({ userId, email: `neha.gupta@${DOMAIN}` }, { $set: { status: 'replied', lastSentAt: new Date(Date.now() - 2 * DAY), repliedAt: new Date() } });
    r = await api('/api/prospects/analytics');
    const high = r.body && r.body.byLabel.find(x => x.label === 'high');
    const manual = r.body && r.body.byLabel.find(x => x.label === 'manual');
    ok('analytics responds', r.status === 200, r.text.slice(0, 200));
    ok('a moved high guess that replied is counted', high && high.moved >= 1 && high.emailed >= 1 && high.replied >= 1, JSON.stringify(high));
    ok('a typed address counts as manual, not as a guess', manual && manual.moved >= 1, JSON.stringify(manual));
    ok("another user's prospects aren't counted", !r.body.companies.some(c => c.people > 0 && c.domain === DOMAIN && c.people > 6));

    // ── discard / restore ──────────────────────────────────────────────────
    console.log('\ndiscard');
    r = await api('/api/prospects/discard', { method: 'POST', body: { ids: [id['Ravi Kumar'], id['Sara Intruder']] } });
    ok('discards only your own', r.body.discarded === 1, r.text);
    r = await api('/api/prospects/restore', { method: 'POST', body: { ids: [id['Ravi Kumar']] } });
    ok('restore', r.body.restored === 1);
    r = await api(`/api/prospects/search/${intruderSearch._id}`);
    ok("another user's search is 404", r.status === 404);

    // ── cancel ─────────────────────────────────────────────────────────────
    const mine = await ProspectSearch.create({ userId, domain: DOMAIN, status: 'queued', steps: ProspectSearch.STEP_KEYS.map(key => ({ key })) });
    r = await api(`/api/prospects/search/${mine._id}/cancel`, { method: 'POST' });
    ok('cancel a running search', r.status === 200 && r.body.cancelled === true && r.body.search.status === 'error' && r.body.search.error === 'Cancelled', r.text);
    ok('its waiting steps are skipped', r.body.search.steps.every(st => st.status === 'skipped'));
    r = await api(`/api/prospects/search/${mine._id}/cancel`, { method: 'POST' });
    ok('cancelling a finished search changes nothing', r.status === 200 && r.body.cancelled === false);
    r = await api(`/api/prospects/search/${intruderSearch._id}/cancel`, { method: 'POST' });
    ok("can't cancel another user's search", r.status === 404 && (await ProspectSearch.findById(intruderSearch._id).lean()).status === 'queued');

    // ── shared inbox ───────────────────────────────────────────────────────
    r = await api('/api/prospects/add-generic', { method: 'POST', body: { domain: DOMAIN, email: `careers@${DOMAIN}` } });
    ok('shared inbox added as generic', r.status === 201 && r.body.prospect.emailConfidence === 'generic', r.text);
    r = await api('/api/prospects/add-generic', { method: 'POST', body: { domain: DOMAIN, email: `ceo@${DOMAIN}` } });
    ok('only addresses actually found on the site', r.status === 404);

    // ── no daily limit on guesses ──────────────────────────────────────────
    console.log('\nmove many');
    const names = ['Aarav Shah', 'Diya Nair', 'Kabir Rao', 'Isha Jain', 'Vivaan Das', 'Anaya Bose', 'Reyansh Iyer', 'Myra Sen',
      'Arjun Pillai', 'Sia Gill', 'Advik Roy', 'Kiara Dutta', 'Ayaan Ghosh', 'Pari Menon', 'Ishaan Bhat', 'Navya Kapoor'];
    const lows = await Prospect.insertMany(names.map(n => ({
      userId, domain: DOMAIN2, name: n, nameKey: require('../lib/emailPatterns').nameKey(n), status: 'ready',
      email: `${n.toLowerCase().replace(' ', '.')}@${DOMAIN2}`, emailConfidence: 'low', emailPattern: 'first.last', emailSource: 'default',
    })));
    r = await api('/api/prospects/move', { method: 'POST', body: { ids: lows.map(d => String(d._id)), template: '' } });
    ok('16 low guesses all move at once — no daily limit', r.body.moved === 16 && !('overCap' in r.body), r.text);

    // ── keys ───────────────────────────────────────────────────────────────
    console.log('\nkeys');
    const before = await DiscoveryConfig.findOne({ userId }).lean();
    if (before && before.tavilyEnc) {
      console.log('  skip  key round-trip (this account already has a Tavily key)');
    } else {
      const secret = `tvly-test-${crypto.randomBytes(6).toString('hex')}`;
      r = await api('/api/prospects/config', { method: 'PUT', body: { tavily: secret } });
      ok('key stored', r.status === 200 && r.body.keys.tavily === true, r.text);
      ok('key never sent back', !r.text.includes(secret) && !/Enc"/.test(r.text));
      const s = await api('/api/settings');
      ok('/api/settings carries nothing new', !/tavily|discovery/i.test(s.text));
      const stored = await DiscoveryConfig.findOne({ userId }).lean();
      ok('stored encrypted', stored.tavilyEnc && !stored.tavilyEnc.includes(secret));
      r = await api('/api/prospects/config/tavily', { method: 'DELETE' });
      ok('key removed', r.body.keys.tavily === false);
    }

    // ── search validation ──────────────────────────────────────────────────
    console.log('\nsearch validation');
    r = await api('/api/prospects/search', { method: 'POST', body: { domain: 'gmail.com' } });
    ok('personal-mail domain refused', r.status === 400);
    r = await api('/api/prospects/search', { method: 'POST', body: { domain: 'not a domain' } });
    ok('junk domain refused', r.status === 400);
  } finally {
    await Prospect.deleteMany({ domain: { $in: [DOMAIN, DOMAIN2] } });
    await Contact.deleteMany({ userId, email: { $regex: `@(${DOMAIN}|${DOMAIN2})$`.replace(/\./g, '\\.') } });
    await CompanyPattern.deleteMany({ domain: { $in: [DOMAIN, DOMAIN2] } });
    await ProspectSearch.deleteMany({ domain: { $in: [DOMAIN, DOMAIN2] } });
    await Session.deleteOne({ tokenHash: crypto.createHash('sha256').update(token).digest('hex') });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch(err => { console.error(err.message); fail++; })
  .finally(async () => { await mongoose.disconnect(); process.exit(fail ? 1 : 0); });
