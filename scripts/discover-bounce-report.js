#!/usr/bin/env node
/**
 * How do contacts that came from Discover actually do once emailed — split by the label
 * they had (🟢 / 🟡 / 🔴), by where the address came from, and by format — next to every
 * other work contact. READ-ONLY — safe against any database, prod included.
 *
 *   node scripts/discover-bounce-report.js                         # dev, every user
 *   NODE_ENV=prod node scripts/discover-bounce-report.js           # prod (reads only)
 *   ... --email=you@example.com                                    # one user
 *
 * "Hard bounce" means the address doesn't exist (lib/patternScore.js HARD_BOUNCE) — the
 * kind a wrong format causes. Other bounces (mailbox full, spam blocks) are counted apart.
 *
 * Connects with mongoose directly, never through db.js — that would seed and run
 * backfills against whichever database it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const ep = require('../lib/emailPatterns');
const { HARD_BOUNCE } = require('../lib/patternScore');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const EMAIL = value('email');
const PROD = process.env.NODE_ENV === 'prod';
const URI = PROD ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const REPLIED = new Set(['replied', 'follow-up-replied']);

function outcome(c) {
  const replied = !!c.repliedAt || REPLIED.has(c.status) || (c.thread || []).some(t => t && t.direction === 'inbound');
  if (replied) return 'replied';
  if (c.status === 'bounced') return HARD_BOUNCE.test(c.bounceReason || '') ? 'hard' : 'soft';
  if (c.lastSentAt) return 'sent';
  return 'unsent';
}

function table(title, rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r) || '(none)';
    if (!groups.has(k)) groups.set(k, { sent: 0, hard: 0, soft: 0, replied: 0, unsent: 0 }); // sent = emailed, whatever happened
    const g = groups.get(k);
    const o = outcome(r);
    if (o === 'unsent') g.unsent++;
    else { g.sent++; if (o !== 'sent') g[o]++; }
  }
  console.log(`\n${title}`);
  console.log('  group                       emailed   hard bounce      other bounce   replied');
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].sent - a[1].sent)) {
    console.log(`  ${k.padEnd(26)} ${String(g.sent).padStart(8)}   ${String(g.hard).padStart(5)} ${pct(g.hard, g.sent).padStart(7)}   ${String(g.soft).padStart(5)} ${pct(g.soft, g.sent).padStart(6)}   ${String(g.replied).padStart(4)} ${pct(g.replied, g.sent).padStart(6)}` +
      (g.unsent ? `   (+${g.unsent} not sent yet)` : ''));
  }
}

async function main() {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  console.log(`database: ${db.databaseName} (read-only)`);

  const filter = { deleted: { $ne: true } };
  if (EMAIL) {
    const user = await db.collection('users').findOne({ email: EMAIL.toLowerCase() });
    if (!user) throw new Error(`No user ${EMAIL}`);
    filter.userId = user._id;
  }
  const fields = { email: 1, name: 1, status: 1, repliedAt: 1, lastSentAt: 1, bounceReason: 1, 'thread.direction': 1, prospectId: 1, emailConfidence: 1, emailPattern: 1, source: 1 };
  const all = await db.collection('contacts').find(filter, { projection: fields }).toArray();
  const work = all.filter(c => c.email && !ep.isFreeMail(ep.domainOfEmail(c.email)));
  const discover = work.filter(c => c.prospectId);
  const other = work.filter(c => !c.prospectId);

  // Where each Discover address came from, read off its prospect.
  const ids = discover.map(c => c.prospectId).filter(id => /^[a-f0-9]{24}$/.test(id)).map(id => new mongoose.Types.ObjectId(id));
  const prospects = await db.collection('prospects').find({ _id: { $in: ids } }, { projection: { emailSource: 1 } }).toArray();
  const sourceOf = new Map(prospects.map(p => [String(p._id), p.emailSource]));

  console.log(`\nwork contacts: ${work.length} (${discover.length} from Discover, ${other.length} from elsewhere)`);
  table('Discover vs everything else', work, c => (c.prospectId ? 'Discover' : 'other sources'));
  if (!discover.length) { console.log('\nNo contacts from Discover yet.'); return; }
  table('Discover, by the label they had when moved', discover, c => c.emailConfidence);
  table('Discover, by where the address came from', discover, c => sourceOf.get(String(c.prospectId)));
  table('Discover, by format', discover, c => c.emailPattern);
  table('Discover, by label × format', discover, c => `${c.emailConfidence || '-'} · ${c.emailPattern || '-'}`);
  table('Discover, by source × format', discover, c => `${sourceOf.get(String(c.prospectId)) || '-'} · ${c.emailPattern || '-'}`);

  // Which companies a "first" guess was labelled high at, and what proved it there:
  // replies from first-name addresses at the same domain.
  const highFirst = discover.filter(c => c.emailConfidence === 'high' && c.emailPattern === 'first');
  if (highFirst.length) {
    const byDomain = new Map();
    for (const c of highFirst) {
      const d = ep.domainOfEmail(c.email);
      if (!byDomain.has(d)) byDomain.set(d, { n: 0, hard: 0 });
      const g = byDomain.get(d);
      g.n++;
      if (outcome(c) === 'hard') g.hard++;
    }
    console.log('\nHigh-confidence "first" guesses, per company (what the app took as proof)');
    for (const [d, g] of [...byDomain.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
      const proof = work.filter(c => ep.domainOfEmail(c.email) === d && !c.prospectId && outcome(c) === 'replied' && ep.inferPattern(c.name, c.email) === 'first');
      console.log(`  ${d.padEnd(28)} ${g.n} guessed, ${g.hard} hard-bounced · replies from first-name addresses there: ${proof.length}`);
    }
  }
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
