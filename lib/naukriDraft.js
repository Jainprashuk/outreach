// Drafting an answer to a Naukri screening question from your resume.
//
// A DRAFT, never an answer. Nothing here is typed into a form: the draft is
// shown under Jobs → Needs answer beside the resume line it came from, and only
// pressing Use turns it into an answer-bank rule. That is what keeps the old
// doctrine of lib/naukriAnswers.js intact — no recruiter sees an answer you did
// not read — while ending the retyping.
//
// Same provider rules as lib/discovery/enrich/fit.js: Groq / Cerebras, never
// Gemini (its ~20 free requests a day belong to reply sorting), and every call
// is logged in the admin AI logs tab under "Naukri answers".

const breaker = require('./classify/breaker');
const { configuredChain } = require('./classify/providers');
const { KIND } = require('./classify/providers/kinds');
const { newRunId } = require('./aiCallLog');
const { pickOption, PLACEHOLDERS, fillPlaceholders } = require('./naukriAnswers');

const RESUME_CHARS = 6000;

const SYSTEM = `You fill in job-application screening questions for a candidate, using ONLY the facts in their resume, their profile, and answers they have already given.
Return JSON only, exactly: {"answer":"...","source":"resume"|"profile"|"answer","quote":"..."} or {"answer":null}
Rules:
- Answer only from a fact stated in the resume, the profile, or an earlier answer. Never estimate, round up, or assume.
- Earlier answers are the candidate's own words and win over the resume when they cover the same thing (e.g. a question about React years answered before). Use source "answer" and quote that line.
- "quote" is the exact short line (from the resume, the profile, or the earlier answers list) the answer comes from.
- If options are given, "answer" must be one of the options, copied exactly.
- For "how many years" questions, answer with a number only. First check the earlier answers: if one covers the same skill or thing (even worded differently, e.g. "React" and "React.js"), use it. Otherwise compute it from dates stated in the resume. If neither makes it clear, return {"answer":null}.
- For yes/no questions, answer "Yes" or "No" only when the resume or profile clearly says so.
- If the fact is not there, return {"answer":null}. A missing answer is fine; a wrong one is not.`;

const MAX_RULES = 60;

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
function parseDraft(text, { options = [], resumeText = '', profile = {}, question = '', rules = [] } = {}) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
  if (j.answer == null || String(j.answer).trim() === '') return { status: 'unknown', answer: '', quote: '', source: '' };

  let answer = String(j.answer).replace(/\s+/g, ' ').trim().slice(0, 300);
  const quote = String(j.quote || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const source = j.source === 'profile' ? 'profile' : j.source === 'answer' ? 'answer' : 'resume';

  // A choice question must be answered with one of its own options. The same
  // picker the worker uses decides, so a draft that passes here is one the
  // worker can actually click.
  if (options.length) {
    const chosen = pickOption(answer, options);
    if (!chosen) return { status: 'unknown', answer: '', quote: '', source: '' };
    answer = chosen;
  }
  const answers = ruleLines(rules, profile);
  if (!quoteIsReal(quote, [resumeText, profileLines(profile), answers])) {
    return { status: 'unknown', answer: '', quote: '', source: '' };
  }
  // Your own earlier answer is authoritative; the dates rule is for the
  // resume, where a model could otherwise estimate.
  if (ASKS_YEARS.test(question) && !CARRIES_TIME.test(quote) && !quoteIsReal(quote, [answers])) {
    return { status: 'unknown', answer: '', quote: '', source: '' };
  }
  return { status: 'ready', answer, quote, source };
}

/**
 * @param {string} question
 * @param {{resumeText: string, profile: object, options?: string[], userId: any, signal?: AbortSignal}} ctx
 * @returns {Promise<{status: 'ready'|'unknown'|'error', answer: string, quote: string, source: string, note?: string}>}
 */
async function draftAnswer(question, { resumeText = '', profile = {}, options = [], rules = [], userId, signal } = {}) {
  const none = (status, note) => ({ status, answer: '', quote: '', source: '', note });
  const resume = String(resumeText || '').slice(0, RESUME_CHARS);
  const prof = profileLines(profile);
  const given = ruleLines(rules, profile);
  if (!resume.trim() && !prof && !given) return none('unknown', 'No resume text, profile or earlier answers to draft from');

  const chain = configuredChain().filter(p => p.name !== 'gemini' && typeof p.complete === 'function');
  if (!chain.length) return none('error', 'No AI provider configured');

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
    if (breaker.blocked(provider.name)) continue;
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

module.exports = { draftAnswer, parseDraft, quoteIsReal, profileLines, ruleLines };
