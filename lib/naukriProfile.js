// Filling the Naukri profile from your resume.
//
// The profile drives the fit score (skills, years) and the answer bank's
// {{placeholders}}; most people leave it half empty, and then every job scores
// ~53 and auto-approve never fires. This reads the resume text once and
// SUGGESTS values — the Profile card shows them beside what you have, and
// nothing is saved until you tick and apply them.
//
// Same provider rules as lib/naukriDraft.js (your own AI key first, logged in
// the AI logs as "Naukri answers"). Checked like a draft: a skill that does not
// appear in the resume text is dropped rather than invented.

const breaker = require('./classify/breaker');
const { chainFor, breakerKeyOf } = require('./classify/providers');
const { KIND } = require('./classify/providers/kinds');
const { newRunId } = require('./aiCallLog');

const RESUME_CHARS = 8000;

const SYSTEM = `You read a candidate's resume and extract their job-search profile.
Return JSON only, exactly:
{"skills":["..."],"totalExperienceMonths":0,"currentDesignation":"","currentCompany":"","currentLocation":"","highestQualification":""}
Rules:
- Only facts stated in the resume. Leave a field "" (or null for the number) when the resume does not say it.
- skills: up to 25 concrete technical skills, tools and frameworks, written as in the resume (e.g. "React", "Node.js", "MongoDB"). No soft skills.
- totalExperienceMonths: total professional experience in months, computed from the dated roles (count "Present" as today). Internships only if nothing else.
- currentDesignation / currentCompany: the most recent role. currentLocation: the city stated for it or in the header.
- highestQualification: the degree as written (e.g. "B.Tech Computer Science").`;

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();

/** Pure: the model's text → checked suggestions, or null if unreadable. */
function parseProfile(text, resumeText = '') {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
  const body = ` ${squash(resumeText)} `;
  const inResume = (v) => { const q = squash(v); return q.length >= 2 && body.includes(` ${q} `); };
  const str = (v, max = 120) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const seen = new Set();
  const skills = (Array.isArray(j.skills) ? j.skills : [])
    .map(x => str(x, 60)).filter(Boolean)
    .filter(x => inResume(x))                       // only skills the resume actually names
    .filter(x => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 25);
  const months = Math.round(Number(j.totalExperienceMonths));
  return {
    skills,
    totalExperienceMonths: Number.isFinite(months) && months > 0 && months < 720 ? months : null,
    // Text fields are kept only when the resume contains them.
    currentDesignation: inResume(j.currentDesignation) ? str(j.currentDesignation) : '',
    currentCompany: inResume(j.currentCompany) ? str(j.currentCompany) : '',
    currentLocation: inResume(j.currentLocation) ? str(j.currentLocation) : '',
    highestQualification: inResume(j.highestQualification) ? str(j.highestQualification) : '',
  };
}

/**
 * @returns {Promise<{ok: true, profile: object} | {ok: false, error: string, code?: string}>}
 */
async function profileFromResume(resumeText, { userId, signal } = {}) {
  const resume = String(resumeText || '').slice(0, RESUME_CHARS);
  if (!resume.trim()) return { ok: false, error: 'No resume text yet — add your resume in Settings (PDF) or paste its text in Resume & headline.' };
  const chain = (await chainFor(userId, { skipOwnerGemini: true })).filter(p => typeof p.complete === 'function');
  if (!chain.length) return { ok: false, error: 'Needs your own free AI key — add one in Settings → AI keys', code: 'AI_KEY_REQUIRED' };

  const runId = newRunId();
  let tried = 0;
  for (const provider of chain) {
    if (breaker.blocked(breakerKeyOf(provider))) continue;
    const res = await provider.complete(
      { system: SYSTEM, prompt: `Resume:\n${resume}`, maxTokens: 800, temperature: 0 },
      { timeoutMs: 30_000, signal, logAs: { userId, feature: 'naukri', runId, attempt: ++tried } },
    );
    if (res.kind !== KIND.OK) continue;
    const profile = parseProfile(res.text, resume);
    if (profile) return { ok: true, profile };
  }
  return { ok: false, error: 'AI providers busy — try again in a minute' };
}

module.exports = { profileFromResume, parseProfile };
