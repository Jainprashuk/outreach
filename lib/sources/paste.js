// Paste text → preview rows. You paste anything (a WhatsApp or Telegram export, a
// newsletter, a post); this finds every email, reads the message it sits in, and
// returns rows for the Leads import preview. Nothing is saved here — the page saves
// the rows you keep through the existing POST /api/leads/import.

const { checkMx } = require('../mx');
const { mapLimit } = require('../http');
const { extractEmails, domainOf } = require('./emails');
const { readPosts } = require('./readPosts');
const { toSourceLead } = require('./toSourceLeads');

const MAX_TEXT = 300 * 1024;
const MAX_CHUNKS = 80;
const CHUNK_MAX = 1500;

// A new message starts on a line like these:
//   WhatsApp: "[12/10/26, 9:41 PM] Name: …" or "12/10/2026, 21:41 - Name: …"
//   Telegram (desktop export, text): "Name, [12.10.26 21:41]"
const MESSAGE_START = /^(?:\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}[:.]\d{2}|.{1,60},\s*\[\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\s+\d{1,2}[:.]\d{2})/;
const WHATSAPP_PREFIX = /^\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\]?\s*(?:-\s*)?/i;

/** Pure: split pasted text into messages. Chat exports by message, anything else by blank lines. */
function splitChunks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const chatLines = lines.filter(l => MESSAGE_START.test(l)).length;
  let chunks;
  if (chatLines >= 3) {
    chunks = [];
    for (const line of lines) {
      if (MESSAGE_START.test(line) || !chunks.length) chunks.push(line.replace(WHATSAPP_PREFIX, ''));
      else chunks[chunks.length - 1] += `\n${line}`;
    }
  } else {
    chunks = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  }
  return chunks.map(c => c.trim()).filter(Boolean);
}

/**
 * Pure: the chunks worth reading — those with an email. A long chunk is cut to the
 * text around its first email so one essay doesn't use the whole AI budget.
 */
function emailChunks(text) {
  const out = [];
  for (const chunk of splitChunks(text)) {
    const emails = extractEmails(chunk);
    if (!emails.length) continue;
    let body = chunk;
    if (body.length > CHUNK_MAX) {
      const at = Math.max(0, body.toLowerCase().indexOf(emails[0].split('@')[0]));
      const start = Math.max(0, at - CHUNK_MAX / 2);
      body = body.slice(start, start + CHUNK_MAX);
    }
    out.push({ text: body, emails });
  }
  return out;
}

/**
 * Drops addresses on domains that can't receive mail (typos like gmial.com). Unknown
 * = kept. A lead left with no email is dropped, unless `keepLinks` and it has an
 * apply link (HN posts: those go to the board's direct-apply journey).
 */
async function dropDeadEmails(leads, { keepLinks = false } = {}) {
  const domains = [...new Set(leads.flatMap(l => l.emails.map(domainOf)).filter(Boolean))];
  const dead = new Set();
  await mapLimit(domains, 8, async (d) => { if ((await checkMx(d, { timeoutMs: 3000 })) === false) dead.add(d); });
  let dropped = 0;
  for (const l of leads) {
    const keep = l.emails.filter(e => !dead.has(domainOf(e)));
    dropped += l.emails.length - keep.length;
    l.emails = keep;
  }
  const kept = leads.filter(l => l.emails.length || (keepLinks && (l.links || []).length));
  return { leads: kept, dropped, deadDomains: [...dead] };
}

/**
 * @returns {Promise<{ leads: object[], chunks: number, truncated: boolean, deadDomains: string[], aiError: string|null }>}
 */
async function previewPaste(text, { userId, target, now = new Date() }) {
  const raw = String(text || '');
  const truncated = raw.length > MAX_TEXT;
  const all = emailChunks(raw.slice(0, MAX_TEXT));
  const chunks = all.slice(0, MAX_CHUNKS);
  const { readings, error } = await readPosts(chunks.map(c => c.text), { userId });
  const leads = chunks.map((c, i) => toSourceLead({
    source: 'paste', text: c.text, emails: c.emails, reading: readings[i],
  }, target, now));
  const checked = await dropDeadEmails(leads);
  return {
    leads: checked.leads,
    chunks: chunks.length,
    skippedChunks: all.length - chunks.length,
    truncated,
    deadDomains: checked.deadDomains,
    aiError: error,
  };
}

module.exports = { previewPaste, splitChunks, emailChunks, dropDeadEmails, MAX_TEXT, MAX_CHUNKS };
