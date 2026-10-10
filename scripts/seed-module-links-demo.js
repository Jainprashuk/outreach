#!/usr/bin/env node
/**
 * Demo data for trying "Worth searching", Naukri → Find people, Company pages and
 * Results by source locally. DEV DATABASE ONLY — refuses to run against prod.
 *
 *   node scripts/seed-module-links-demo.js --email=you@example.com          # add
 *   node scripts/seed-module-links-demo.js --email=you@example.com --clean  # remove it all
 *
 * Everything added is tagged ("[demo]" names, "demo-ml:" keys) so --clean removes
 * exactly it — plus anything you created FROM it while testing (searches, people
 * and contacts at the demo companies, dismissals, cached outside signals).
 *
 * Safety: demo contacts use real company domains (so outside signals have something
 * to check) but are never sendable — every one is already sent/replied/bounced,
 * never `queued`, so no send step can pick them up.
 *
 * Connects with mongoose directly, never through db.js.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const NaukriJob = require('../models/NaukriJob');
const Interview = require('../models/Interview');
const Prospect = require('../models/Prospect');
const ProspectSearch = require('../models/ProspectSearch');
const SuggestionDismissal = require('../models/SuggestionDismissal');
const CompanySignal = require('../models/CompanySignal');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const EMAIL = (value('email') || '').toLowerCase();
const CLEAN = args.includes('--clean');

const DAY = 24 * 3600 * 1000;
const ago = (d) => new Date(Date.now() - d * DAY);
const TAG = '[demo] ';
const KEY = 'demo-ml:';
// Companies the demo touches — and what each one shows.
const DOMAINS = ['razorpay.com', 'freshworks.com', 'postman.com', 'zoho.com', 'zomato.com', 'swiggy.in', 'meesho.com'];
const NAMES = ['postman', 'zoho', 'freshworks'];

async function clean(userId) {
  const jobs = await NaukriJob.find({ userId, sourceKey: { $regex: `^${KEY}` } }, { _id: 1 }).lean();
  const jobIds = jobs.map(j => String(j._id));
  const domainRe = new RegExp(`@(${DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|')})$`, 'i');
  const r = await Promise.all([
    Contact.deleteMany({ userId, $or: [{ name: { $regex: '^\\[demo\\] ' } }, { naukriJobId: { $in: jobIds } }, { email: domainRe, createdAt: { $gte: ago(30) }, prospectId: { $exists: true } }] }),
    Lead.deleteMany({ userId, dedupeKey: { $regex: `^${KEY}` } }),
    NaukriJob.deleteMany({ userId, sourceKey: { $regex: `^${KEY}` } }),
    Interview.deleteMany({ userId, name: { $regex: '^\\[demo\\] ' } }),
    Prospect.deleteMany({ userId, domain: { $in: DOMAINS } }),
    ProspectSearch.deleteMany({ userId, domain: { $in: DOMAINS } }),
    SuggestionDismissal.deleteMany({ userId, key: { $in: [...DOMAINS.map(d => `d:${d}`), ...NAMES.map(n => `n:${n}`)] } }),
    CompanySignal.deleteMany({ key: { $in: [...DOMAINS, ...NAMES.map(n => `n:${n}`)] } }),
  ]);
  const labels = ['contacts', 'leads', 'naukri jobs', 'interviews', 'prospects', 'searches', 'dismissals', 'cached signals'];
  console.log('removed:', r.map((x, i) => `${x.deletedCount} ${labels[i]}`).join(', '));
}

const history = (...steps) => steps.map(([status, d]) => ({ status, changedAt: ago(d), note: 'demo' }));

async function seed(userId) {
  let n = 0;
  const lead = (email, extra = {}) => ({
    userId, authorName: `${TAG}${extra.author || 'Hiring post'}`, email, company: extra.company || '',
    fitScore: extra.fit ?? 5, postUrl: `https://www.linkedin.com/feed/update/demo-${++n}`, hiring: true,
    dedupeKey: `${KEY}lead-${n}`, createdAt: ago(extra.days ?? 3), source: 'demo',
  });
  const job = (company, title, extra = {}) => ({
    userId, sourceId: `${KEY}${++n}`, sourceKey: `${KEY}${n}`, title, company, location: 'Bengaluru',
    url: 'https://www.naukri.com/', postedAt: ago(extra.days ?? 4), createdAt: ago(extra.days ?? 4), lastSeenAt: ago(1),
    approval: extra.approval || 'pending', applyStatus: extra.applyStatus || 'none',
    ...(extra.applyStatus && extra.applyStatus !== 'none' ? { appliedAt: ago(2) } : {}),
  });
  const contact = (name, email, company, extra = {}) => ({
    userId, name: `${TAG}${name}`, email, company, role: extra.role || 'Recruiter', approvalStatus: 'approved',
    status: extra.status || 'sent', lastSentAt: extra.sentDaysAgo != null ? ago(extra.sentDaysAgo) : ago(6),
    ...(extra.replyCategory ? { replyCategory: extra.replyCategory, repliedAt: ago(extra.repliedDaysAgo ?? 3), replyClassifierOk: true, classifiedBy: 'manual' } : {}),
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.prospectId ? { prospectId: extra.prospectId, emailConfidence: 'medium', emailPattern: 'first.last' } : {}),
    ...(extra.bounceReason ? { bounceReason: extra.bounceReason } : {}),
    statusHistory: extra.history || history(['sent', extra.sentDaysAgo ?? 6]),
  });

  // 1. Razorpay — warm: two good replies + fresh LinkedIn posts. Top suggestion.
  // 7. Meesho — already tried: three emailed a month ago, nobody replied.
  await Lead.insertMany([
    lead('talent.demo1@razorpay.com', { company: 'Razorpay', author: 'Razorpay TA', fit: 9, days: 2 }),
    lead('talent.demo2@razorpay.com', { company: 'Razorpay', author: 'Razorpay EM', fit: 7, days: 5 }),
    lead('hr.demo@zomato.com', { company: 'Zomato', author: 'Zomato HR', days: 4 }),
    lead('hr.demo@swiggy.in', { company: 'Swiggy', author: 'Swiggy HR', fit: 2, days: 6 }),
    lead('hr.demo@meesho.com', { company: 'Meesho', author: 'Meesho HR', days: 3 }),
    lead('hr.demo2@meesho.com', { company: 'Meesho', author: 'Meesho TA', days: 8 }),
  ]);

  // 2. Freshworks — you applied on Naukri (+ momentum). Shows Find people on Naukri → Applied.
  // 3. Postman — application in review + an interview in progress.
  // 4. Zoho — four approved jobs this fortnight (momentum).
  const jobs = await NaukriJob.insertMany([
    job('Freshworks', 'Senior Backend Engineer (Node.js)', { applyStatus: 'applied', approval: 'approved' }),
    job('Freshworks', 'Backend Engineer II', { approval: 'approved', days: 6 }),
    job('Postman', 'Software Engineer - Platform', { applyStatus: 'in-review', approval: 'approved' }),
    job('Zoho', 'Member Technical Staff', { approval: 'approved', days: 2 }),
    job('Zoho', 'Data Analyst', { approval: 'approved', days: 5 }),
    job('Zoho', 'Product Manager', { approval: 'approved', days: 7 }),
    job('Zoho', 'QA Engineer', { approval: 'approved', days: 9 }),
  ]);
  await Interview.create({ userId, name: `${TAG}Postman recruiter`, company: 'Postman', role: 'Software Engineer', status: 'scheduled', interviewAt: new Date(Date.now() + 3 * DAY) });

  await Contact.insertMany([
    contact('Ananya Rao', 'ananya.demo@razorpay.com', 'Razorpay', { status: 'replied', replyCategory: 'reviewing', history: history(['sent', 6], ['replied', 3]) }),
    contact('Vikram Shah', 'vikram.demo@razorpay.com', 'Razorpay', { status: 'replied', replyCategory: 'resume-requested', source: 'lead', history: history(['sent', 5], ['replied', 2]) }),
    // Ties Freshworks (a Naukri-only name) to its domain, and counts as a Discover contact.
    contact('Meera Iyer', 'meera.demo@freshworks.com', 'Freshworks', { prospectId: 'demo', role: 'Engineering Manager', sentDaysAgo: 4, history: history(['sent', 4]) }),
    // 5. Zomato — said no recently: left out of suggestions.
    contact('Rohit Jain', 'rohit.demo@zomato.com', 'Zomato', { status: 'replied', replyCategory: 'no', history: history(['sent', 7], ['replied', 5]) }),
    ...[1, 2, 3].map(i => contact(`Meesho person ${i}`, `person${i}.demo@meesho.com`, 'Meesho', { sentDaysAgo: 30, history: history(['sent', 30]) })),
    contact('Bounced Demo', 'wrong.demo@meesho.com', 'Meesho', { status: 'bounced', bounceReason: '550 5.1.1 user unknown', history: history(['sent', 6], ['bounced', 6]) }),
  ]);

  console.log(`added: 6 leads, ${jobs.length} Naukri jobs, 1 interview, 8 contacts`);
  console.log(`
What to look for:
  Discover → Worth searching   Razorpay, Postman, Freshworks, Zoho (each with reasons). Zomato (said no)
                               and Swiggy/Meesho (weak / already tried) should NOT be there.
  Naukri → Applied             Freshworks + Postman rows have a "Find people" button.
  Companies                    /companies — open Razorpay or Meesho for the full page.
  Analytics → Reports          "Results by source" (Direct, LinkedIn Leads, Discover).
  Refresh signals              needs the Inngest dev server; news/careers/GitHub points appear after ~1 min.

Remove it all:  node scripts/seed-module-links-demo.js --email=${EMAIL} --clean`);
}

async function main() {
  if (!EMAIL) { console.error('Usage: node scripts/seed-module-links-demo.js --email=you@example.com [--clean]'); process.exit(2); }
  if (process.env.NODE_ENV === 'prod') { console.error('Refusing: NODE_ENV=prod. This script is for the dev database only.'); process.exit(2); }
  await mongoose.connect(process.env.MONGODB_URI_DEV);
  const dbName = mongoose.connection.db.databaseName;
  if (/prod/i.test(dbName)) throw new Error(`Refusing: ${dbName} looks like production`);
  console.log(`database: ${dbName}`);
  const user = await mongoose.connection.db.collection('users').findOne({ email: EMAIL });
  if (!user) throw new Error(`No user ${EMAIL} in ${dbName}`);
  await clean(user._id); // re-running starts fresh rather than doubling up
  if (!CLEAN) await seed(user._id);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err.message); process.exit(1); });
