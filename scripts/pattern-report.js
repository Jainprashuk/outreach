#!/usr/bin/env node
/**
 * How well would the Discover guesser have done on YOUR real history?
 * READ-ONLY — safe against any database, prod included.
 *
 *   node scripts/pattern-report.js --email=you@example.com          # dev
 *   NODE_ENV=prod node scripts/pattern-report.js --email=...        # prod (reads only)
 *
 * Leave-one-out: for every contact who REPLIED (so their address is known good), hide
 * them, guess their address from everything else you know about their company
 * (your other contacts + your Leads board), and check the guess. The hit rate per
 * confidence label is the honest answer to "how much should I trust a 🟢 / 🟡 / 🔴".
 *
 * Connects with mongoose directly, never through db.js — that would seed and run
 * backfills against whichever database it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const ep = require('../lib/emailPatterns');
const ps = require('../lib/patternScore');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const EMAIL = value('email');
const PROD = process.env.NODE_ENV === 'prod';
const URI = PROD ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

async function main() {
  if (!EMAIL) { console.error('Usage: node scripts/pattern-report.js --email=you@example.com'); process.exit(2); }
  await mongoose.connect(URI);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`database: ${dbName} (read-only)`);

  const user = await mongoose.connection.db.collection('users').findOne({ email: EMAIL.toLowerCase() });
  if (!user) throw new Error(`No user ${EMAIL} in ${dbName}`);
  const userId = user._id;

  const contacts = await mongoose.connection.db.collection('contacts').find(
    { userId, deleted: { $ne: true } },
    { projection: { name: 1, email: 1, status: 1, repliedAt: 1, lastSentAt: 1, bounceReason: 1, 'thread.direction': 1 } },
  ).toArray();
  const leads = await mongoose.connection.db.collection('leads').find(
    { userId, deleted: { $ne: true }, email: { $ne: null } },
    { projection: { authorName: 1, email: 1 } },
  ).toArray();
  console.log(`contacts: ${contacts.length} · leads with an email: ${leads.length}\n`);

  const now = new Date();
  const byDomain = new Map();
  for (const c of contacts) {
    const d = ep.domainOfEmail(c.email);
    if (!d || ep.isFreeMail(d)) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(c);
  }
  const leadsByDomain = new Map();
  for (const l of leads) {
    const d = ep.domainOfEmail(l.email);
    if (!d || ep.isFreeMail(d)) continue;
    if (!leadsByDomain.has(d)) leadsByDomain.set(d, []);
    leadsByDomain.get(d).push({ name: l.authorName, email: l.email });
  }

  // Coverage: companies whose format is already known from your own data.
  const coverage = { high: 0, medium: 0, low: 0 };
  for (const [d, list] of byDomain) {
    const ev = [...ps.contactEvidence(list, now), ...ps.realEvidence(leadsByDomain.get(d) || [], 'leads')];
    coverage[ps.decide(ev).confidence]++;
  }

  // The default guess, recomputed without the contact being tested so it can't vote
  // for its own address. Other companies' votes are fixed, so only this company's
  // vote is recomputed per test.
  const allEvidence = ps.contactEvidence(contacts, now);
  const priorWithout = (c) => ps.priorOrder(allEvidence.filter(e => e !== evidenceOf.get(c)));
  const evidenceOf = new Map();
  {
    let i = 0;
    for (const c of contacts) {
      const sig = ps.contactSignal(c, now);
      if (sig && ep.inferPattern(c.name, c.email)) evidenceOf.set(c, allEvidence[i++]);
    }
  }

  // Leave-one-out over replied contacts.
  const result = { high: [0, 0], medium: [0, 0], low: [0, 0] };
  let replied = 0, readable = 0, cantGuess = 0;
  for (const [d, list] of byDomain) {
    for (const c of list) {
      const sig = ps.contactSignal(c, now);
      if (!sig || sig.kind !== 'reply') continue;
      replied++;
      const own = ep.inferPattern(c.name, c.email);
      if (!own) continue; // nickname, role address, or ambiguous — not a format test
      readable++;

      const others = list.filter(o => o !== c);
      const ev = [...ps.contactEvidence(others, now), ...ps.realEvidence(leadsByDomain.get(d) || [], 'leads')];
      const decision = ps.decide(ev, priorWithout(c));
      const guess = ep.generateEmail(c.name, decision.pattern, d);
      if (!guess) { cantGuess++; continue; }
      const hit = ep.localPartOf(guess) === ep.localPartOf(c.email).replace(/\d+$/, '');
      result[decision.confidence][0] += hit ? 1 : 0;
      result[decision.confidence][1] += 1;
    }
  }

  console.log(`companies you've emailed: ${byDomain.size}`);
  console.log(`  format known from your data — high: ${coverage.high} · medium: ${coverage.medium} · unknown: ${coverage.low}`);
  console.log(`\nreplied contacts: ${replied} · with a readable format: ${readable} · can't guess (name too short): ${cantGuess}`);
  console.log('leave-one-out accuracy (would the guess have been their real address?)');
  for (const k of ['high', 'medium', 'low']) {
    const [hit, n] = result[k];
    console.log(`  ${k.padEnd(6)} ${String(n).padStart(5)} guesses · ${pct(hit, n).padStart(4)} correct`);
  }
  const total = Object.values(result).reduce((a, [h, n]) => [a[0] + h, a[1] + n], [0, 0]);
  console.log(`  all    ${String(total[1]).padStart(5)} guesses · ${pct(total[0], total[1]).padStart(4)} correct`);

  const top = ps.priorOrder(allEvidence).slice(0, 4);
  console.log(`\nyour default guess order: ${top.join(' → ')}`);
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
