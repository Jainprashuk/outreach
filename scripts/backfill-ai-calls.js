#!/usr/bin/env node
/**
 * Fills the admin's Gemini logs tab with the AI calls made BEFORE it existed,
 * rebuilt from the activity log. Rows land with source 'history' and never expire.
 *
 * What the activity log kept, and so what a history row can show:
 *   - Reply sorting, category 'classifier' (2026-09-19 on): one row per provider
 *     ATTEMPT, with outcome, HTTP status and latency, the verdict, and the run's
 *     final error. Rule-pass verdicts made no AI call and are skipped.
 *   - Reply sorting, category 'gemini' (before that): one Gemini call per row,
 *     with latency, verdict and error.
 *   - Reply drafts ('reply_drafted'): only which provider answered. No prompt or
 *     draft text, no latency, and failed drafts were never logged.
 *   - Discover: nothing was logged, so there is nothing to rebuild.
 * Never recorded anywhere: the raw model output, token counts, the system text.
 *
 * For reply sorting the PROMPT is reconstructed: the matching inbound message is
 * read off the contact's stored thread and put through today's buildPrompt().
 * The row's note says so, and says when no stored message could be matched.
 *
 * Idempotent: every row carries runId `hist:<activity log id>`, and a log row
 * already backfilled is skipped. Dry run unless --execute.
 *
 *   node scripts/backfill-ai-calls.js                       # dev, dry run
 *   node scripts/backfill-ai-calls.js --env=prod            # prod, dry run (reads only)
 *   node scripts/backfill-ai-calls.js --env=prod --execute
 *
 * Connects with mongoose directly, never through db.js — that would run
 * backfills against whichever database it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');
const Contact = require('../models/Contact');
const AiCall = require('../models/AiCall');
const { buildPrompt } = require('../lib/classify/prompt');
const { normalizeBody } = require('../lib/classify/text');
const { kindForStatus } = require('../lib/classify/providers/kinds');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };

const EXECUTE = flag('execute');
const ENV = value('env') === 'prod' ? 'prod' : 'dev';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const BATCH = 500;

const MODEL_OF = {
  gemini: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
  groq: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
  cerebras: process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
};

const contactCache = new Map();
async function contactFor(userId, email) {
  if (!email) return null;
  const key = `${userId || '-'}|${email}`;
  if (!contactCache.has(key)) {
    const q = { email: String(email).toLowerCase() };
    if (userId) q.userId = userId;
    contactCache.set(key, await Contact.findOne(q, { name: 1, email: 1, company: 1, thread: 1, replySnippet: 1, repliedAt: 1 }).lean());
  }
  return contactCache.get(key);
}

/** The inbound message that log row classified: same subject, latest before it. */
function messageFor(contact, subject, at) {
  const inbound = (contact.thread || []).filter(t => t.direction === 'inbound' && (t.text || t.html));
  const before = inbound.filter(t => new Date(t.at) <= new Date(at.getTime() + 60_000));
  const pool = before.length ? before : inbound;
  const sameSubject = pool.filter(t => (t.subject || '') === (subject || ''));
  const pick = (list) => list.sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  return pick(sameSubject.length ? sameSubject : pool);
}

async function promptFor(log) {
  const m = log.meta || {};
  const contact = await contactFor(log.userId, m.contactEmail);
  if (!contact) return { prompt: '', contact: null, how: 'contact not found — prompt not recoverable' };
  const msg = messageFor(contact, m.subject, log.createdAt);
  if (msg) {
    return {
      prompt: buildPrompt({ subject: m.subject || msg.subject || '', body: normalizeBody(msg.text || msg.html || '') }),
      contact, how: 'prompt reconstructed from the stored reply',
    };
  }
  if (contact.replySnippet) {
    return { prompt: buildPrompt({ subject: m.subject || '', body: contact.replySnippet }), contact, how: 'prompt reconstructed from the reply preview only (full message not stored)' };
  }
  return { prompt: '', contact, how: 'no stored reply — prompt not recoverable' };
}

const outcomeFromError = (error) => kindForStatus(/\b429\b/.test(error || '') ? 429 : null, error || '');

function base(log, extra) {
  const m = log.meta || {};
  return {
    userId: log.userId || null,
    runId: `hist:${log._id}`,
    source: 'history',
    createdAt: log.createdAt,
    expireAt: null,
    system: '',
    output: '',
    tokens: {},
    context: {
      contactEmail: m.contactEmail || null,
      contactName: m.contactName || null,
      contactId: m.contactId || null,
      company: null,
    },
    ...extra,
  };
}

async function rowsForClassifier(log) {
  const m = log.meta || {};
  if (m.provider === 'rules') return [];                       // no AI call was made
  const attempts = (m.attempts || []).filter(a => a && !String(a.outcome || '').startsWith('skipped'));
  const { prompt, contact, how } = await promptFor(log);
  const ctx = (r) => ({ ...r, context: { ...r.context, company: contact?.company || null } });
  const verdict = m.category ? { category: m.category, reasoning: m.reasoning || '' } : null;
  const note = `From the activity log: ${how}; raw output, tokens and system text were not recorded.`;

  // Before the provider chain (category 'gemini'), or a chain row without attempts.
  if (!attempts.length) {
    if (log.category === 'classifier' && !m.model && !m.provider) return [];
    const ok = log.action === 'classify';
    const provider = m.provider || 'gemini';
    return [ctx(base(log, {
      feature: 'classify', attempt: 1, provider, model: m.model || MODEL_OF[provider] || null, method: 'classify',
      outcome: ok ? 'ok' : outcomeFromError(m.error), status: ok ? 200 : null,
      latencyMs: typeof m.latencyMs === 'number' ? m.latencyMs : null,
      error: ok ? null : (m.error || null), prompt, result: ok ? verdict : null, note,
    }))];
  }

  return attempts.map((a, i) => {
    const ok = a.outcome === 'ok';
    const last = i === attempts.length - 1;
    return ctx(base(log, {
      feature: 'classify', attempt: i + 1, provider: a.provider, model: a.model || MODEL_OF[a.provider] || null, method: 'classify',
      outcome: a.outcome, status: a.status ?? null, latencyMs: a.latencyMs ?? null,
      // Only the run's final error was kept; earlier failures get their kind and status.
      error: ok ? null : (last && m.error ? m.error : `${a.outcome}${a.status ? ` (HTTP ${a.status})` : ''}`),
      prompt, result: ok ? verdict : null, note,
    }));
  });
}

async function rowsForDraft(log) {
  const m = log.meta || {};
  const contact = m.contactId && mongoose.isValidObjectId(m.contactId)
    ? await Contact.findOne({ _id: m.contactId }, { name: 1, email: 1, company: 1 }).lean()
    : null;
  return [base(log, {
    feature: 'draft', attempt: 1, provider: m.provider || 'unknown', model: MODEL_OF[m.provider] || null, method: 'complete',
    outcome: 'ok', status: 200, latencyMs: null, error: null, prompt: '', result: null,
    context: { contactEmail: contact?.email || null, contactName: contact?.name || null, contactId: m.contactId || null, company: contact?.company || null },
    note: 'From the activity log: only the provider that answered was recorded — no prompt, draft text, latency or tokens. Failed drafts were never logged.',
  })];
}

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`\nDatabase: ${mongoose.connection.db.databaseName} (${ENV})   ${EXECUTE ? 'EXECUTE' : 'dry run'}\n`);

  const done = new Set((await AiCall.distinct('runId', { source: 'history' })).filter(Boolean));
  const cursor = ActivityLog.find({
    $or: [
      { category: { $in: ['classifier', 'gemini'] }, action: { $in: ['classify', 'classify_failed'] } },
      { action: 'reply_drafted' },
    ],
  }).sort({ createdAt: 1 }).lean().cursor();

  const tally = new Map();
  let logs = 0, skippedDone = 0, noCall = 0, written = 0, first = null, last = null;
  let pending = [];
  const flush = async () => {
    if (EXECUTE && pending.length) { await AiCall.insertMany(pending, { ordered: false }); written += pending.length; }
    pending = [];
  };

  for await (const log of cursor) {
    logs++;
    if (done.has(`hist:${log._id}`)) { skippedDone++; continue; }
    const rows = log.action === 'reply_drafted' ? await rowsForDraft(log) : await rowsForClassifier(log);
    if (!rows.length) { noCall++; continue; }
    for (const r of rows) {
      const k = `${r.feature.padEnd(9)} ${String(r.provider).padEnd(9)} ${r.outcome}`;
      tally.set(k, (tally.get(k) || 0) + 1);
      first = first || r.createdAt; last = r.createdAt;
    }
    pending.push(...rows);
    if (pending.length >= BATCH) await flush();
  }
  await flush();

  console.log(`Activity log rows read:        ${logs}`);
  console.log(`  already backfilled:          ${skippedDone}`);
  console.log(`  no AI call (rules verdicts): ${noCall}`);
  console.log(`AI call rows ${EXECUTE ? 'written' : 'that would be written'}: ${[...tally.values()].reduce((a, b) => a + b, 0)}${EXECUTE ? ` (${written})` : ''}`);
  if (first) console.log(`  spanning ${first.toISOString().slice(0, 10)} → ${last.toISOString().slice(0, 10)}`);
  console.log('');
  for (const [k, n] of [...tally].sort()) console.log(`  ${k.padEnd(36)} ${n}`);
  if (!EXECUTE) console.log('\nDry run — nothing written. Add --execute to write.');
  await mongoose.disconnect();
}

main().catch(async (err) => { console.error(err.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
