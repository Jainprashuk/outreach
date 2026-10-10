#!/usr/bin/env node
/**
 * What would Discover's "Worth searching" suggest for one account, and does the
 * score mean anything? READ-ONLY — safe against any database, prod included.
 *
 *   node scripts/suggest-report.js --email=you@example.com                 # dev
 *   NODE_ENV=prod node scripts/suggest-report.js --email=...               # prod (reads only)
 *   node scripts/suggest-report.js --email=... --enrich                    # + live outside lookups
 *
 * Prints:
 *   1. the stage-1 candidates (the app's own signals) and the final list, with reasons
 *   2. a backtest: for companies you have ALREADY emailed, the score they'd have had
 *      before any outcome was known (reply/bounce points removed) against the reply
 *      rate they actually got. If higher scores don't reply more, the weights are wrong.
 *
 * --enrich runs the free outside checks (news, HN, careers, GitHub, fit) for the
 * candidates right now and prints what they'd add. Nothing is written: the results
 * are held in memory, the CompanySignal cache is untouched.
 *
 * Connects with mongoose directly, never through db.js — that would seed and run
 * backfills against whichever database it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const worth = require('../lib/discovery/companyWorth');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const EMAIL = value('email');
const ENRICH = args.includes('--enrich');
const PROD = process.env.NODE_ENV === 'prod';
const URI = PROD ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const sign = (n) => (n > 0 ? `+${n}` : String(n));
// Points that come from what happened AFTER you emailed — left out of the backtest score.
const OUTCOME_TEXT = /reviewing|stay in touch|Already emailed|bounced|format there is already known/;

function show(r, i) {
  console.log(`${String(i + 1).padStart(2)}. ${r.company}${r.domain ? ` (${r.domain})` : ' (needs domain)'}  score ${r.score}${r.score !== r.base ? `  [own ${r.base}]` : ''}`);
  for (const x of r.reasons) console.log(`      ${sign(x.points).padStart(3)}  ${x.text}${x.url ? `  <${x.url}>` : ''}`);
  for (const n of r.notes || []) console.log(`        ·  ${n}`);
  if (r.roles) console.log(`        roles: ${r.roles.join(', ')}`);
}

async function main() {
  if (!EMAIL) { console.error('Usage: node scripts/suggest-report.js --email=you@example.com [--enrich]'); process.exit(2); }
  await mongoose.connect(URI);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`database: ${dbName} (read-only)`);
  const user = await mongoose.connection.db.collection('users').findOne({ email: EMAIL.toLowerCase() });
  if (!user) throw new Error(`No user ${EMAIL} in ${dbName}`);

  const now = new Date();
  const data = await worth.loadWorthData(user._id, { now });
  const own = worth.scoreCompanies(data, { now });
  console.log(`\n${own.length} companies in Hiring now (last ${worth.RULES.windowDays} days) · ${data.contacts.length} contacts`);
  const why = {};
  for (const r of own) if (r.excluded) why[r.excluded] = (why[r.excluded] || 0) + 1;
  console.log('left out:', Object.keys(why).length ? Object.entries(why).map(([k, n]) => `${k} ${n}`).join(', ') : 'none');

  const cands = worth.pickCandidates(own);
  console.log(`\n── Stage 1: ${cands.length} candidates (own signals ≥ ${worth.RULES.candidateMin})`);
  cands.forEach(show);

  let final = own;
  if (ENRICH) {
    const { contextFor, SOURCES } = require('../lib/discovery/enrich');
    const checks = {
      news: require('../lib/discovery/enrich/news').checkNews,
      hn: require('../lib/discovery/enrich/hn').checkHn,
      github: require('../lib/discovery/enrich/github').checkGithub,
      careers: require('../lib/discovery/enrich/careers').checkCareers,
      fit: require('../lib/discovery/enrich/fit').checkFit,
    };
    const ctx = await contextFor(user._id);
    console.log(`\n── Outside lookups (live, NOT saved) · targets: ${[...ctx.targets.terms, ...ctx.targets.families].join(', ') || 'none'}`);
    const signals = [];
    for (const c of cands) {
      const key = worth.signalKey(c);
      const opts = {
        news: {}, hn: {},
        github: { token: ctx.githubToken, knownOrg: ctx.orgs.get(c.domain) || null },
        careers: ctx.targets,
        fit: { targets: [...ctx.targets.terms, ...ctx.targets.families], userId: user._id },
      };
      const line = [];
      for (const s of ctx.sources) {
        const r = await checks[s](c, opts[s]).catch(e => ({ status: 'error', points: 0, reasons: [], note: e.message }));
        signals.push({ key, source: s, userId: SOURCES[s].shared ? null : user._id, ...r });
        line.push(`${s}:${r.status}${r.points ? `(${sign(r.points)})` : ''}`);
      }
      console.log(`   ${c.company.padEnd(28)} ${line.join('  ')}`);
    }
    final = worth.scoreCompanies({ ...data, signals }, { now });
  }

  const picked = worth.pickSuggestions(final);
  console.log(`\n── Final: ${picked.length} suggestions (score ≥ ${worth.RULES.minScore}, at most ${worth.RULES.maxShown})`);
  picked.forEach(show);

  // ── Backtest
  const byDomain = new Map();
  for (const c of data.contacts) {
    const d = (c.email || '').split('@')[1];
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, { sent: 0, replied: 0 });
    const b = byDomain.get(d);
    if (c.lastSentAt || ['sent', 'follow-up-sent', 'replied', 'follow-up-replied', 'bounced'].includes(c.status)) b.sent++;
    if (c.repliedAt || ['replied', 'follow-up-replied'].includes(c.status)) b.replied++;
  }
  const buckets = [['≤ 0', s => s <= 0], ['1–2', s => s >= 1 && s <= 2], ['3–4', s => s >= 3 && s <= 4], ['≥ 5', s => s >= 5]]
    .map(([label, test]) => ({ label, test, companies: 0, sent: 0, replied: 0 }));
  for (const r of own) {
    const o = r.domain && byDomain.get(r.domain);
    if (!o || !o.sent) continue;
    const before = r.reasons.filter(x => !OUTCOME_TEXT.test(x.text)).reduce((a, x) => a + x.points, 0);
    const b = buckets.find(x => x.test(before));
    b.companies++; b.sent += o.sent; b.replied += o.replied;
  }
  console.log('\n── Backtest: companies you already emailed, by the score they had before any reply');
  console.log('   score   companies   sent   replied   reply rate');
  for (const b of buckets) console.log(`   ${b.label.padEnd(7)} ${String(b.companies).padStart(9)} ${String(b.sent).padStart(6)} ${String(b.replied).padStart(9)}   ${pct(b.replied, b.sent).padStart(10)}`);
  console.log('   (only the last 30 days of Leads/Naukri are scored, so this sample is small at first)');

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
