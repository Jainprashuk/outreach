// How well a company fits what YOU are looking for, judged by one of the free AI
// providers from the company's own one-line description. Per user, because the
// same company fits one job-hunter and not another.
//
// Same rules as the team-page reader (lib/discovery/llmExtract.js): Gemini is never
// used (its ~20 free requests a day belong to reply sorting), a failure never trips
// the shared cooldown breaker, and every call is logged in the AI logs tab. The
// answer can only ADD 0–3 points; a model can't push a company down.

const breaker = require('../../classify/breaker');
const { configuredChain } = require('../../classify/providers');
const { KIND } = require('../../classify/providers/kinds');
const { newRunId } = require('../../aiCallLog');
const { fetchText } = require('../../http');
const { plain } = require('./match');

const MAX_POINTS = 3;

const SYSTEM = `You judge whether a company is likely to hire for the roles a job-seeker wants.
Return JSON only, exactly: {"score":0,"reason":"one short sentence"}
score: 0 = the company almost certainly has no such roles, 1 = possible, 2 = likely, 3 = clearly a strong fit.
Judge only from the description given. Never invent facts about the company.`;

/** Pure: the description a homepage gives of itself. */
function describe(html) {
  const s = String(html || '');
  const meta = (attr, name) => (s.match(new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']{10,400})["']`, 'i'))
    || s.match(new RegExp(`<meta[^>]+content=["']([^"']{10,400})["'][^>]*${attr}=["']${name}["']`, 'i')) || [])[1];
  const title = (s.match(/<title[^>]*>([\s\S]{2,200}?)<\/title>/i) || [])[1];
  return plain([meta('name', 'description') || meta('property', 'og:description') || '', title || ''].filter(Boolean).join(' — ')).slice(0, 400);
}

/** Pure: the model's answer → points and a reason, or null if unreadable. */
function parseFit(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    const score = Math.round(Number(j.score));
    if (!Number.isFinite(score) || score < 0 || score > MAX_POINTS) return null;
    return { score, reason: String(j.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
  } catch (_) { return null; }
}

/**
 * @param {{company: string, domain: string|null}} c
 * @param {{targets: string[], userId: any, signal?: AbortSignal}} ctx  targets: roles / search keywords
 */
async function checkFit(c, { targets = [], userId, signal } = {}) {
  if (!targets.length) return { status: 'skipped', points: 0, reasons: [], note: 'Fit check needs your Naukri searches or default roles' };
  if (!c.domain) return { status: 'skipped', points: 0, reasons: [], note: 'Fit check needs the company’s domain' };
  const chain = configuredChain().filter(p => p.name !== 'gemini' && typeof p.complete === 'function');
  if (!chain.length) return { status: 'skipped', points: 0, reasons: [], note: 'No AI provider configured' };

  let html = null;
  for (const host of [`https://${c.domain}/`, `https://www.${c.domain}/`]) {
    const res = await fetchText(host, { timeoutMs: 6_000, signal });
    if (res.ok && res.data) { html = res.data; break; }
  }
  const about = describe(html);
  if (!about) return { status: 'error', points: 0, reasons: [], note: 'Fit check: website unreachable' };

  const runId = newRunId();
  let tried = 0;
  for (const provider of chain) {
    if (breaker.blocked(provider.name)) continue;
    const res = await provider.complete(
      { system: SYSTEM, prompt: `Roles wanted: ${targets.slice(0, 8).join(', ')}\n\nCompany: ${c.company}\nDescription: ${about}`, maxTokens: 120, temperature: 0 },
      { timeoutMs: 15_000, signal, logAs: { userId, feature: 'discover', runId, attempt: ++tried, company: c.company } },
    );
    if (res.kind !== KIND.OK) continue;
    const fit = parseFit(res.text);
    if (!fit) continue;
    if (!fit.score) return { status: 'none', points: 0, reasons: [], note: fit.reason || 'Not a fit for your roles' };
    return { status: 'ok', points: fit.score, reasons: [{ text: `Fit with your roles ${fit.score}/3: ${fit.reason}` }] };
  }
  return { status: 'error', points: 0, reasons: [], note: 'Fit check: AI providers busy' };
}

module.exports = { checkFit, describe, parseFit, MAX_POINTS };
