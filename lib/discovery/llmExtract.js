// Reads people (name + title) off a company's team page with the free AI providers
// the app already uses for reply sorting.
//
// Two rules keep this from costing reply sorting anything:
// - Gemini is never used: its free tier is about 20 requests a DAY, and reply
//   classification needs all of them.
// - A failure here never trips the shared cooldown breaker. A rate-limit seen here
//   just means "skip the team page", not "pause reply sorting for a minute".
// And one rule keeps it honest: every name returned must appear in the page text,
// so a model can't invent a person.

const breaker = require('../classify/breaker');
const { configuredChain } = require('../classify/providers');
const { KIND } = require('../classify/providers/kinds');
const { isPlausibleName, stripAccents } = require('../emailPatterns');

const SYSTEM = `You extract people from the text of a company's web page.
Return JSON only, in exactly this shape: {"people":[{"name":"Full Name","title":"Job title"}]}
Rules:
- Only real people who work at the company, with their full name as written in the text.
- Never invent or complete a name. If the text has no people, return {"people":[]}.
- title is their job title from the text, or "" if none is given.`;

const norm = (s) => stripAccents(s).toLowerCase().replace(/[^a-z]+/g, ' ').trim();

function parse(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
}

/**
 * @returns {Promise<{people: {name: string, title: string}[], error: string|null}>}
 */
async function extractPeople(pageText, { companyName }) {
  const chain = configuredChain().filter(p => p.name !== 'gemini' && typeof p.complete === 'function');
  if (!chain.length) return { people: [], error: 'No AI provider configured' };

  const hay = ` ${norm(pageText)} `;
  let lastError = null;
  for (const provider of chain) {
    if (breaker.blocked(provider.name)) continue;
    const res = await provider.complete(
      { system: SYSTEM, prompt: `Company: ${companyName}\n\nPage text:\n${pageText}`, maxTokens: 900, temperature: 0 },
      { timeoutMs: 20_000 },
    );
    if (res.kind !== KIND.OK) { lastError = `${provider.name}: ${res.error || res.kind}`; continue; }
    const data = parse(res.text);
    if (!data || !Array.isArray(data.people)) { lastError = `${provider.name}: unreadable answer`; continue; }

    const people = data.people
      .map(p => ({ name: String((p && p.name) || '').trim(), title: String((p && p.title) || '').trim().slice(0, 160) }))
      .filter(p => isPlausibleName(p.name) && hay.includes(` ${norm(p.name)} `));
    return { people, error: null };
  }
  return { people: [], error: lastError || 'AI providers busy' };
}

module.exports = { extractPeople };
