// Writes a first draft of your reply to a conversation. You always see it, can edit it, and
// decide whether to send — nothing here sends anything.
//
// The model gets the whole conversation, your saved reply profile and an optional note for
// this one reply — and nothing else. The biggest risk with a drafted job-search reply is a
// confident invented fact ("I have 6 years of Kotlin"), so the instructions forbid facts
// that aren't in those three sources and make it leave a [bracketed gap] instead, which is
// easy to spot and fill before sending.
//
// Runs over the same provider chain and cooldowns as the classifier (lib/classify), so a
// rate-limited Groq key falls through to Gemini or Cerebras here too.

const breaker = require('./classify/breaker');
const { configuredChain } = require('./classify/providers');
const { KIND, retryAfterMs } = require('./classify/providers/kinds');
const { normalizeBody } = require('./classify/text');
const { deadline } = require('./http');

const TOTAL_BUDGET_MS = 30_000;
const PER_ATTEMPT_MS = 20_000;
const MAX_MESSAGES = 10;         // the latest ten are the conversation; older is noise
const MAX_MESSAGE_CHARS = 2_000;
const COOLDOWN_MS = { [KIND.RATE_LIMITED]: 60_000, [KIND.AUTH]: 60 * 60_000, [KIND.TRANSIENT]: 15_000 };

// What the app writes in place of a first-send body it never stored.
const PLACEHOLDER = /original message body was not stored/i;

const SYSTEM = `You draft email replies for a job seeker who contacted recruiters and hiring managers.
You write the job seeker's next reply in an existing email conversation.

Rules:
- Short and professional: 3 to 6 sentences, plain text, no markdown, no subject line.
- Start with a greeting using the other person's first name, then reply to their LATEST message.
- Answer every question they asked in their latest message.
- Use ONLY facts found in the job seeker's profile, their note for this reply, or the conversation.
  Never invent experience, skills, dates, notice periods, salaries, locations or availability.
  A yes or no is a fact too: never say they are (or aren't) open to a location, a relocation,
  a role or a salary unless the profile or the note says so.
  If a question needs a fact you don't have, write a short placeholder in square brackets,
  e.g. [notice period] or [open to Pune?], so the job seeker can fill it in before sending.
- If the job seeker's note says what to say, follow it.
- If a resume is attached, say so in one short phrase. Never say it is attached when it isn't.
- End with a short sign-off and the job seeker's name, exactly as given.
- Output only the email body, nothing before or after it.`;

const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The conversation as the model reads it: oldest first, each message trimmed to what was typed. */
function transcript(contact, senderName) {
  const messages = [...(contact.thread || [])]
    .filter(t => t.text && !PLACEHOLDER.test(t.text))
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(-MAX_MESSAGES);
  return messages.map(t => {
    const who = t.direction === 'outbound' ? `${senderName} (the job seeker)` : contact.name;
    let text = normalizeBody(t.text);
    if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS) + ' …';
    return `--- ${who}, ${fmtDate(t.at)} ---\n${text}`;
  }).join('\n\n');
}

function buildPrompt({ contact, senderName, profile, note, attachResume }) {
  const firstName = (contact.name || '').trim().split(/\s+/)[0] || 'there';
  return [
    `The other person: ${contact.name}${contact.role ? `, ${contact.role}` : ''}${contact.company ? ` at ${contact.company}` : ''} (first name: ${firstName}).`,
    `The job seeker's name for the sign-off: ${senderName}.`,
    `Job seeker's profile:\n${(profile || '').trim() || '(none given)'}`,
    `Job seeker's note for this reply:\n${(note || '').trim() || '(none)'}`,
    `Resume attached to this reply: ${attachResume ? 'yes' : 'no'}.`,
    `The conversation so far, oldest first:\n\n${transcript(contact, senderName)}`,
    `Write the job seeker's reply to ${firstName}'s latest message.`,
  ].join('\n\n');
}

// Models sometimes wrap the body anyway; take it off so the textarea holds only the email.
function clean(text) {
  return String(text || '')
    .replace(/^```[a-z]*\n?|```$/gim, '')
    .replace(/^\s*subject:.*\n+/i, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .trim();
}

/**
 * @returns {Promise<{ok: true, body: string, provider: string} | {ok: false, error: string}>}
 */
async function draftReply({ contact, senderName, profile, note, attachResume }, { providers } = {}) {
  const chain = providers || configuredChain();
  if (!chain.length) return { ok: false, error: 'No AI provider is configured (set GROQ_API_KEY, GEMINI_API_KEY or CEREBRAS_API_KEY).' };
  if (!(contact.thread || []).some(t => t.direction === 'inbound')) {
    return { ok: false, error: 'There is no reply from them to answer yet.' };
  }

  const prompt = buildPrompt({ contact, senderName, profile, note, attachResume });
  const budget = deadline(TOTAL_BUDGET_MS);
  let lastError = null;

  for (const provider of chain) {
    if (typeof provider.complete !== 'function' || breaker.blocked(provider.name)) continue;
    const remaining = budget.remaining();
    if (remaining < 2_000) break;

    const res = await provider.complete(
      { system: SYSTEM, prompt, maxTokens: 700, temperature: 0.4 },
      { timeoutMs: Math.min(PER_ATTEMPT_MS, remaining), signal: budget.signal },
    );
    if (res.kind === KIND.OK) {
      const body = clean(res.text);
      if (body) return { ok: true, body, provider: provider.name };
    }
    lastError = `${provider.name}: ${res.error || res.kind}`;
    if (res.kind === KIND.ABORTED) break;
    const cooldown = COOLDOWN_MS[res.kind];
    if (cooldown) breaker.trip(provider.name, res.retryAfterMs ?? retryAfterMs(res.retryAfter) ?? cooldown, res.kind);
  }
  return { ok: false, error: `Every AI provider failed — they may be rate-limited. Try again shortly. (${lastError || 'no provider available'})` };
}

module.exports = { draftReply, buildPrompt, SYSTEM };
