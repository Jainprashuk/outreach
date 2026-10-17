// Drafting an answer to a Naukri screening question from your resume.
//
// A DRAFT, never an answer. Nothing here is typed into a form: the draft is
// shown under Jobs → Needs answer beside the resume line it came from, and only
// pressing Use turns it into an answer-bank rule. That is what keeps the old
// doctrine of lib/naukriAnswers.js intact — no recruiter sees an answer you did
// not read — while ending the retyping.
//
// Same provider rules as lib/discovery/enrich/fit.js: Groq / Cerebras, never
// Gemini on the owner's key (its ~20 free requests a day belong to reply sorting; a user's own Gemini key is fair game), and every call
// is logged in the admin AI logs tab under "Naukri answers".

const breaker = require('./classify/breaker');
const { chainFor, breakerKeyOf } = require('./classify/providers');
const { KIND } = require('./classify/providers/kinds');
const { newRunId } = require('./aiCallLog');
const { pickOption, PLACEHOLDERS, fillPlaceholders } = require('./naukriAnswers');

const RESUME_CHARS = 6000;

const SYSTEM = `You fill in job-application screening questions for a candidate, using ONLY the facts in their resume, their profile, and answers they have already given.
Return JSON only, exactly: {"answer":"...","source":"resume"|"profile"|"answer","quote":"...","confidence":0-100} or {"answer":null}
Rules:
- Answer only from a fact stated in the resume, the profile, or an earlier answer. Never estimate, round up, or assume.
- Earlier answers are the candidate's own words and win over the resume when they cover the same thing (e.g. a question about React years answered before). Use source "answer" and quote that line.
- "quote" is the exact short line (from the resume, the profile, or the earlier answers list) the answer comes from.
- If options are given, "answer" must be one of the options, copied exactly.
- For "how many years" questions, answer with a number only. First check the earlier answers: if one covers the same skill or thing (even worded differently, e.g. "React" and "React.js"), use it. Otherwise compute it from dates stated in the resume. If neither makes it clear, return {"answer":null}.
- For yes/no questions, answer "Yes" or "No" only when the resume or profile clearly says so.
- If the fact is not there, return {"answer":null}. A missing answer is fine; a wrong one is not.
- "confidence" is how sure you are, 0–100, that the answer is exactly true for this candidate as stated. 95+ only when the quote says it outright; lower whenever you had to interpret, combine or infer. Be strict: this decides whether the answer is sent to an employer without the candidate checking it.`;

const MAX_RULES = 60;
// Earlier answers sent with ONE question: only the ones that share a word with
// it, best first. Seen live: all 60 went with every question (~9,400 chars a
// prompt) and used up Groq's 200k-tokens-a-day free limit in an evening.
const MAX_RELEVANT_RULES = 12;

// Words that say nothing about WHAT is asked — shared by the relevance filter
// below and the "No from absence" cap further down.
const QUESTION_STOP = new Set(['have', 'with', 'your', 'experience', 'experienced', 'worked', 'working', 'using', 'used',
  'hands', 'knowledge', 'any', 'like', 'such', 'other', 'years', 'many', 'much', 'what', 'which', 'from', 'that', 'this',
  'into', 'about', 'there', 'their', 'systems', 'system', 'skills', 'skill', 'familiar', 'comfortable', 'willing', 'able',
  'how', 'you', 'are', 'the', 'for', 'and', 'did', 'does', 'will', 'can', 'please', 'mention', 'tell', 'give', 'yes',
  'currently', 'total', 'role', 'job', 'company', 'work']);

/** Pure: the words of `text` that say what it is about. */
function significantTerms(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) || []) {
    const w = raw.replace(/\.+$/, '');
    // "react.js" is also "react" and "reactjs", so it meets an answer written
    // either way; the same for node.js, next.js, vue.js.
    const forms = w.includes('.') ? [w, w.split('.')[0], w.replace(/\./g, '')] : [w, w.replace(/js$/, '')];
    for (const f of forms) if (f.length >= 3 && !QUESTION_STOP.has(f)) out.add(f);
  }
  return [...out];
}

/** Pure: the earlier answers worth sending with `question` — those sharing at
    least one word with it, most shared first, at most MAX_RELEVANT_RULES. */
function relevantRules(rules = [], question = '', max = MAX_RELEVANT_RULES) {
  const q = new Set(significantTerms(question));
  if (!q.size) return [];
  return (rules || [])
    .map((r, i) => ({ r, i, n: significantTerms(r && r.pattern).filter(t => q.has(t)).length }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, max)
    .map(x => x.r);
}

/** Pure: the answers you have already given, as "- Q: … A: …" lines.
    Enabled rules only, placeholders filled from the profile, and any rule
    whose placeholders cannot be filled left out — an unfilled rule is not an
    answer. Most recent first, which is how Use adds them. */
function ruleLines(rules = [], profile = {}) {
  const out = [];
  for (const r of rules || []) {
    if (!r || r.enabled === false || !r.pattern || !String(r.answer || '').trim()) continue;
    const { text, missing } = fillPlaceholders(r.answer, profile);
    if (missing.length) continue;
    out.push(`- Q: ${String(r.pattern).split('|')[0].trim()} A: ${text}`);
    if (out.length >= MAX_RULES) break;
  }
  return out.join('\n');
}

/** Pure: the profile as plain lines, for the prompt. Only fields you filled in. */
function profileLines(profile = {}) {
  const out = [];
  for (const [key, get] of Object.entries(PLACEHOLDERS)) {
    const v = get(profile);
    if (v != null && v !== '' && String(v).trim()) out.push(`${key}: ${v}`);
  }
  return out.join('\n');
}

/** Pure: does `quote` actually appear in what the model was shown? Loose on
    spacing and case, strict on the words — a quote that is not there means the
    model made it up, and so the answer is not trusted. */
function quoteIsReal(quote, sources) {
  const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = squash(quote);
  if (q.length < 3) return false;
  return sources.some(s => squash(s).includes(q));
}

// A "how many years" answer must quote a line that itself carries the time —
// dates ("Jan 2021 – Present") or a stated duration ("5 years"). Seen live: a
// model answered "4+ years" of Docker quoting a line with no dates in it,
// which is an estimate dressed as a fact.
const ASKS_YEARS = /how many years|years of experience|experience in years|yrs of experience/i;
const CARRIES_TIME = /\b(19|20)\d{2}\b|\b\d+(\.\d+)?\s*\+?\s*(years?|yrs?)\b|totalExperience/i;

/** Pure: the model's text → a checked draft, or null if unusable. */
// The model's own 0–100, or 0 when it gave none. Only ever trusted together
// with the checks in parseDraft — a failed check means 0 whatever it said.
function readConfidence(v) {
  const n = Number(typeof v === 'string' ? v.replace('%', '') : v);
  if (!Number.isFinite(n)) return 0;
  // Some models answer on a 0–1 scale.
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function parseDraft(text, { options = [], resumeText = '', profile = {}, question = '', rules = [] } = {}) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
  const unknown = { status: 'unknown', answer: '', quote: '', source: '', confidence: 0 };
  if (j.answer == null || String(j.answer).trim() === '') return unknown;
  const confidence = readConfidence(j.confidence);

  let answer = String(j.answer).replace(/\s+/g, ' ').trim().slice(0, 300);
  const quote = String(j.quote || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const source = j.source === 'profile' ? 'profile' : j.source === 'answer' ? 'answer' : 'resume';

  // A choice question must be answered with one of its own options. The same
  // picker the worker uses decides, so a draft that passes here is one the
  // worker can actually click.
  if (options.length) {
    const chosen = pickOption(answer, options);
    if (!chosen) return unknown;
    answer = chosen;
  }
  const answers = ruleLines(rules, profile);
  if (!quoteIsReal(quote, [resumeText, profileLines(profile), answers])) return unknown;
  // Your own earlier answer is authoritative; the dates rule is for the
  // resume, where a model could otherwise estimate.
  if (ASKS_YEARS.test(question) && !CARRIES_TIME.test(quote) && !quoteIsReal(quote, [answers])) return unknown;
  return { status: 'ready', answer, quote, source, confidence: capForAbsence({ answer, quote, question, source }, confidence) };
}

// A "No" that rests on something being MISSING from the resume. Seen live: asked
// about SAP, the model answered "No" at 95%, quoting a skills line that simply
// does not mention SAP. Honest, but the resume not saying it is not you saying
// it — you may well have the skill. Capped below any auto-answer bar, so it
// waits in Needs answer for you instead of being sent.
const ABSENCE_CAP = 60;
function capForAbsence({ answer, quote, question, source }, confidence) {
  if (source === 'answer' || source === 'profile') return confidence;   // your own words
  if (!/^no\b/i.test(String(answer).trim())) return confidence;
  const q = String(quote || '').toLowerCase();
  const terms = significantTerms(question);
  const mentioned = terms.some(t => q.includes(t));
  return mentioned ? confidence : Math.min(confidence, ABSENCE_CAP);
}

/**
 * @param {string} question
 * @param {{resumeText: string, profile: object, options?: string[], userId: any, signal?: AbortSignal}} ctx
 * @returns {Promise<{status: 'ready'|'unknown'|'error', answer: string, quote: string, source: string, note?: string}>}
 */
async function draftAnswer(question, { resumeText = '', profile = {}, options = [], rules = [], userId, signal } = {}) {
  const none = (status, note) => ({ status, answer: '', quote: '', source: '', confidence: 0, note });
  const resume = String(resumeText || '').slice(0, RESUME_CHARS);
  const prof = profileLines(profile);
  // Only the relevant ones go to the AI; parseDraft still checks the quote
  // against ALL of them.
  const given = ruleLines(relevantRules(rules, question), profile);
  if (!resume.trim() && !prof && !given) return none('unknown', 'No resume text, profile or earlier answers to draft from');

  const chain = (await chainFor(userId, { skipOwnerGemini: true })).filter(p => typeof p.complete === 'function');
  if (!chain.length) return { ...none('error', 'AI drafts need your own free AI key — add one in Settings → AI keys'), code: 'AI_KEY_REQUIRED' };

  // Earlier answers go FIRST and are called facts. Tried live: listed after the
  // question as "answers already given", a small model ignored them in favour
  // of the resume and returned null for a reworded question it had the answer to.
  const prompt = [
    `Facts the candidate has already stated (their own answers, most reliable):\n${given || '(none yet)'}`,
    `Question: ${question}`,
    options.length ? `Options (answer must be one of these, exactly):\n${options.map(o => `- ${o}`).join('\n')}` : 'Options: none (free text)',
    `Profile:\n${prof || '(empty)'}`,
    `Resume:\n${resume || '(empty)'}`,
  ].join('\n\n');

  const runId = newRunId();
  let tried = 0;
  for (const provider of chain) {
    if (breaker.blocked(breakerKeyOf(provider))) continue;
    const res = await provider.complete(
      { system: SYSTEM, prompt, maxTokens: 200, temperature: 0 },
      { timeoutMs: 20_000, signal, logAs: { userId, feature: 'naukri', runId, attempt: ++tried } },
    );
    if (res.kind !== KIND.OK) continue;
    const draft = parseDraft(res.text, { options, resumeText: resume, profile, question, rules });
    if (draft) return draft;
  }
  return none('error', 'AI providers busy — will try again');
}

module.exports = { draftAnswer, parseDraft, quoteIsReal, profileLines, ruleLines, readConfidence, relevantRules, significantTerms };
