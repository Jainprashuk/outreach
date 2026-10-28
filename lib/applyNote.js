// The message sent with an application, written for ONE job.
//
// Cutshort has a message to the recruiter; Wellfound has open questions ("What
// interests you about working for this company?"). Neither should go out empty,
// and neither may be a canned paragraph reused across companies. So this writes
// a short note per job from three things only: the candidate's resume and
// profile (who they are), and that job's own text (what the company says it
// needs). It is NOT lib/naukriDraft.js: that answers factual screening
// questions from the resume and saves the answer as a reusable rule; a note
// written for one company must never be saved or reused for the next.
//
// Nothing is trusted because the model said so. A note is checked before it is
// returned: no placeholders, within the length, no number / link / address that
// is not in the resume, profile or job text, it names the company or the role,
// and it is not boilerplate. A note that fails is rejected and the next
// provider tries; if none passes the caller sends NOTHING (the application is
// not made with an empty or doubtful message).
//
// Same provider rules as lib/naukriDraft.js (the user's own AI keys, logged in
// the admin AI logs under feature "naukri").

const breaker = require('./classify/breaker');
const { chainFor, breakerKeyOf } = require('./classify/providers');
const { KIND } = require('./classify/providers/kinds');
const { newRunId } = require('./aiCallLog');
const { profileLines } = require('./naukriDraft');

const RESUME_CHARS = 6000;
const JOB_CHARS = 3500;

const MESSAGE_SYSTEM = `You write the short message a job candidate sends to a recruiter together with their application. The goal: the recruiter reads it, sees a specific fit, and opens the resume.
Return JSON only: {"text":"..."}   or   {"text":null,"reason":"..."} if the candidate's facts do not support an honest message for this job.
Rules:
- First person, plain and warm, like a real person typing; 3 to 5 sentences, at most {MAX} characters. No greeting line longer than "Hi <first name>," (use the recruiter's first name only if given), no sign-off block, no bullet points, no emojis, no markdown.
- Open with something specific to THIS role or company taken from the job text (what they are building or what the role owns) — never with "I am writing to apply".
- Then 1–2 concrete matches between what the job asks for and what the resume shows: a real project, employer, stack or result. Use the resume's own words and numbers.
- Close with a low-pressure line (happy to share more / can talk this week). Mention notice period or availability only if the profile states it and it is short.
- Facts about the candidate come ONLY from the resume and profile. Facts about the company come ONLY from the job text. Never invent a metric, employer, skill, product detail or achievement. If the job text says little about the company, speak to the role instead.
- Banned: "passionate", "dynamic", "rockstar", "ninja", "I hope this finds you well", "I am writing to", "perfect fit", "team player", "hard-working", any placeholder like [Company] or {{name}}.`;

const QUESTION_SYSTEM = `You answer ONE open question on a job application form, for a candidate, to impress the hiring team honestly.
Return JSON only: {"text":"..."}   or   {"text":null,"reason":"..."} if the answer is a fact about the candidate that their resume and profile do not state.
Rules:
- First person, at most {MAX} characters, plain paragraphs, no bullets, no emojis, no markdown.
- If the question is about interest or motivation: tie something specific in the job text (what the company does, what the role owns) to something real in the resume. Be concrete, not flattering.
- If it asks for a fact (salary, notice period, visa, relocation, years of X): answer only if the resume or profile states it; otherwise return text null.
- Facts about the candidate come ONLY from the resume and profile; about the company ONLY from the job text. Never invent anything.
- Banned: "passionate", "dynamic", "rockstar", "ninja", "I am writing to", "perfect fit", placeholders like [Company] or {{name}}.`;

const BANNED = /\b(passionate|dynamic|rock ?star|ninja|team player|hard-?working)\b|i am writing to|i hope this (message|email) finds you|perfect fit|\[[^\]]{1,40}\]|\{\{|<\/?[a-z][^>]*>|lorem ipsum/i;

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Words that name a company or a role (not "technologies", "pvt", "ltd", …).
const NAME_STOP = new Set(['the', 'and', 'for', 'pvt', 'ltd', 'llc', 'inc', 'limited', 'private', 'technologies', 'technology',
  'solutions', 'software', 'services', 'labs', 'systems', 'india', 'global', 'group', 'company', 'developer', 'engineer', 'senior', 'junior', 'staff']);
const namesIn = (text) => squash(text).split(' ').filter(w => w.length >= 3 && !NAME_STOP.has(w));

/**
 * Pure: is this text safe to send? Returns null when fine, else the reason.
 * `sources` = the strings the model was shown (resume, profile, job text).
 */
function checkNote(text, { kind = 'message', maxChars = 600, job = {}, sources = [] } = {}) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (t.length > maxChars) return 'too-long';
  if (kind === 'message' && t.length < 120) return 'too-short';
  if (BANNED.test(t)) return 'boilerplate-or-placeholder';
  const seen = squash(sources.join(' '));
  // Every number must be in what the model was shown ("5 years", "40%", "2023").
  for (const n of t.match(/\d+(?:\.\d+)?/g) || []) {
    if (!new RegExp(`(^| )${n.replace('.', ' ?\\.? ?')}( |$)`).test(seen) && !seen.includes(n)) return `unsupported-number:${n}`;
  }
  // No link, address or phone that is not in the sources.
  for (const x of t.match(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+/gi) || []) {
    if (!seen.includes(squash(x))) return 'unsupported-contact';
  }
  if (kind === 'message') {
    // It must speak to this job: the company or a distinctive word of the title.
    const mine = squash(t);
    const hooks = [...namesIn(job.company), ...namesIn(job.title)];
    if (hooks.length && !hooks.some(w => mine.includes(w))) return 'generic';
  }
  return null;
}

function parse(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

const jobText = (job) => [
  `Title: ${job.title || ''}`, `Company: ${job.company || ''}`, job.location ? `Location: ${job.location}` : '',
  job.salaryText ? `Pay: ${job.salaryText}` : '', (job.tags || []).length ? `Skills: ${job.tags.join(', ')}` : '',
  job.description ? `Description:\n${String(job.description).slice(0, JOB_CHARS)}` : '',
].filter(Boolean).join('\n');

/**
 * @param {{job: object, resumeText: string, profile: object, userId: any, kind?: 'message'|'question',
 *          question?: string, maxChars?: number, recruiter?: string, signal?: AbortSignal}} ctx
 * @returns {Promise<{text: string|null, reason?: string, code?: string, declined?: boolean}>}
 *   declined = the model judged the facts do not support an answer (a decision, not a failure)
 */
async function writeNote({ job, resumeText = '', profile = {}, userId, kind = 'message', question = '', maxChars, recruiter = '', signal } = {}) {
  const max = Math.max(200, Math.min(1500, Number(maxChars) || (kind === 'message' ? 600 : 800)));
  const resume = String(resumeText || '').slice(0, RESUME_CHARS);
  const prof = profileLines(profile);
  if (!resume.trim() && !prof) return { text: null, reason: 'No resume text or profile to write from' };
  const jt = jobText(job || {});
  if (!(job && job.title)) return { text: null, reason: 'No job to write for' };

  const chain = (await chainFor(userId, { skipOwnerGemini: true })).filter(p => typeof p.complete === 'function');
  if (!chain.length) return { text: null, code: 'AI_KEY_REQUIRED', reason: 'Writing application messages needs your own free AI key — add one in Settings → AI keys' };

  const system = (kind === 'message' ? MESSAGE_SYSTEM : QUESTION_SYSTEM).replace('{MAX}', String(max));
  const prompt = [
    kind === 'question' ? `Question on the form: ${question}` : (recruiter ? `Recruiter's first name: ${String(recruiter).split(/\s+/)[0]}` : 'Recruiter: unknown'),
    `The job:\n${jt}`,
    `Candidate profile:\n${prof || '(empty)'}`,
    `Candidate resume:\n${resume || '(empty)'}`,
  ].join('\n\n');
  const sources = [resume, prof, jt, question];

  const runId = newRunId();
  let tried = 0, lastWhy = 'AI providers busy';
  for (const provider of chain) {
    if (breaker.blocked(breakerKeyOf(provider))) continue;
    const res = await provider.complete(
      { system, prompt: lastWhy.startsWith('rejected:') ? `${prompt}\n\nYour previous attempt was rejected (${lastWhy.slice(9)}). Write it again, fixing that.` : prompt,
        maxTokens: 420, temperature: 0.5 },
      { timeoutMs: 25_000, signal, logAs: { userId, feature: 'applynote', runId, attempt: ++tried, company: job.company, contactName: job.title } },
    );
    if (res.kind !== KIND.OK) continue;
    const j = parse(res.text);
    if (!j) { lastWhy = 'rejected:not JSON'; continue; }
    if (j.text == null || !String(j.text).trim()) return { text: null, declined: true, reason: String(j.reason || 'The resume does not support an honest answer').slice(0, 200) };
    const text = String(j.text).replace(/\s+/g, ' ').trim();
    const bad = checkNote(text, { kind, maxChars: max, job, sources });
    if (!bad) return { text };
    lastWhy = `rejected:${bad}`;
  }
  return { text: null, reason: lastWhy.startsWith('rejected:') ? `AI wrote a note that failed checks (${lastWhy.slice(9)})` : lastWhy };
}

module.exports = { writeNote, checkNote };
