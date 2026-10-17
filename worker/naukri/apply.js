'use strict';

// Applying — the only part of this system that does something irreversible.
//
// Everything here is shaped by one fact: a sent application cannot be recalled,
// and it carries your name. So the rules are deliberately pessimistic:
//
//   * Only jobs the SERVER handed us. The worker never picks its own targets;
//     the server only hands over ones you approved.
//   * Only native Naukri applies (#apply-button). "Apply on company site"
//     (#company-site-button) leaves Naukri for an unknown third-party ATS —
//     skipped, never guessed at.
//   * A screening question with no matching answer rule SKIPS the job. It never
//     guesses, never leaves a field blank to see what happens.
//   * Anything unrecognised abandons that one job and moves on. It does not
//     click hopefully.
//
// DRY RUN, and its honest limit: dryRun stops BEFORE the Apply click. It reports
// what it found and what it would have done. It cannot rehearse the chatbot,
// because opening the chatbot requires clicking Apply, and for a job with no
// questions that click IS the application. A "dry run" that clicked Apply to
// look around would be a real application with a reassuring name.
//
// SELECTORS verified against the live site on 2026-09-24 for the apply button
// and the already-applied state. The chatbot selectors below are written from
// its published structure with fallbacks; the first real run is the one that
// confirms them, which is why failures here abandon the job loudly.

const { check, jitter } = require('./guard');
const { newPage } = require('./session');
const { resolveAnswer, pickOption } = require('../../lib/naukriAnswers');

// Hard cap, module constant rather than config. The server also clamps, and
// both matter: this one is the last line if a config ever arrives malformed.
const MAX_PER_RUN = 40;

// One job's whole visit: navigate, classify, click, answer, confirm. Generous —
// a slow listing with a five-question form is well inside it — but finite.
//
// It exists because a Playwright call CAN hang indefinitely. Its per-action
// timeouts cover waiting for an element; they do not cover a CDP connection
// that has stopped answering, and a page whose tab has become unresponsive will
// block a protocol call with no deadline at all. That happened on a live run:
// the worker sat at 0% CPU on job 18 of 20 for eight minutes, and because only
// one run may be active, the whole feature was wedged behind it.
const JOB_TIMEOUT_MS = 90 * 1000;
// With live AI answers on, each unanswered question can add up to ~20s for the
// AI on top of the form itself, so a job gets longer before it is abandoned.
const JOB_TIMEOUT_AI_MS = 180 * 1000;

// Reject after `ms` rather than waiting forever. The work carries on in the
// background — we cannot cancel a hung protocol call — but the RUN moves on,
// which is the part that matters.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

const APPLY_BUTTON = '#apply-button';
const COMPANY_SITE_BUTTON = '#company-site-button';
// Walk-in listings offer "I am interested" instead of Apply (verified live
// 2026-10-17). That registers interest in a drive; it is not an application,
// so the worker never clicks it.
const WALKIN_BUTTON = '#walkin-button';

// A listing that has closed or been taken down. Its page has no Apply button,
// which used to be reported as "Naukri changed their DOM" and retried forever.
const CLOSED_MARKERS = [
  'no longer accepting', 'not accepting applications', 'job has expired', 'this job has expired',
  'job is no longer available', 'no longer available', 'job has been removed', 'job you are looking for',
  'this job is closed', 'hiring for this job is closed',
];

// Naukri's questionnaire drawer. Ordered most-current first.
const CHATBOT = ['.chatbot_DrawerContentWrapper', '.chatbot_Drawer', '[class*="chatbot_Drawer"]'];
const BOT_QUESTION = ['.botMsg', '.chatbot_ListItem span', '[class*="botMsg"]'];
const BOT_TEXTAREA = ['.chatbot_InputContainer textarea', '.textArea', 'div[contenteditable="true"]'];
const BOT_SEND = ['.sendMsg', '.sendMsgbtn_container', '[class*="sendMsg"]'];
const BOT_RADIO = ['.ssrc__radio-btn-container label', '.singleselect-radiobutton-container label', '[class*="radio-btn"] label'];
const BOT_CHECKBOX = ['.ssrc__checkbox-container label', '[class*="checkbox"] label'];

// Evidence the application landed. Checked on the page after the flow, because
// "we clicked and nothing threw" is not evidence of anything.
//
// The phrase list alone was not enough: on a real successful apply Naukri
// renders the bare word "Applied" and REMOVES the apply button, matching none of
// these. That reported a genuine application as failed — a false negative that
// makes the history lie about what was sent. The disappearance of the button is
// the stronger signal, so it is checked too.
const SUCCESS_MARKERS = [
  'you have successfully applied',
  'application sent',
  'applied successfully',
  'you have already applied',
];

// True when the page no longer offers to apply — i.e. it took.
async function looksApplied(page) {
  const stillOffers = await page.locator(APPLY_BUTTON).count().catch(() => 1);
  if (stillOffers === 0) return true;
  const t = await page.innerText('body', { timeout: 4000 }).catch(() => '');
  return /\bapplied\b/i.test(t);
}
const ALREADY_MARKERS = ['you have already applied', 'already applied'];

// Bot messages that CLOSE the questionnaire rather than ask something.
//
// Learned the hard way on a live run: after the last answer Naukri's bot says
// "Thank you for your responses." The loop read that as a question, found no
// rule for it, and abandoned the job — navigating away before the submission
// finished. A closing line means stop reading and start confirming, not skip.
const CLOSING_MARKERS = [
  'thank you for your responses',
  'thank you for your response',
  'your application has been sent',
  'application sent',
  'successfully applied',
  'thanks for applying',
];
const isClosing = (t) => CLOSING_MARKERS.some(m => String(t || '').toLowerCase().includes(m));

async function firstVisible(page, selectors, timeout = 2500) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout });
      return el;
    } catch (_) { /* try the next shape */ }
  }
  return null;
}

const bodyText = async (page) => {
  try { return (await page.innerText('body', { timeout: 5000 }) || '').toLowerCase(); }
  catch (_) { return ''; }
};

// Answer one question in the chatbot. Returns 'answered' | 'unknown' | 'stuck'.
//
// The labels of the radio / checkbox options on screen, with their locators.
// Read before deciding anything, so a skip can report what was offered — the
// AI draft for that question must pick one of these, not invent its own.
async function readOptions(page) {
  for (const sel of [...BOT_RADIO, ...BOT_CHECKBOX]) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    const out = [];
    for (let i = 0; i < n; i++) {
      const text = ((await loc.nth(i).innerText().catch(() => '')) || '').trim();
      if (text) out.push({ text, el: loc.nth(i) });
    }
    if (out.length) return out;
  }
  return [];
}

// 'unknown' is a decision, not a failure: the question has no rule, so the job
// is abandoned with the question (and its options) reported so it can become
// a rule.
//
// With auto-answer on, a question no rule answers is put to the AI (askAI) once.
// Only an answer the server judged confident enough comes back; it is then
// typed or picked through exactly the same code a rule's answer goes through,
// so "the AI answered it" never means a looser path. Anything else — not sure
// enough, AI busy, no connection — is the old 'unknown': the job is skipped.
async function answerOne(page, question, config, askAI) {
  const radios = await firstVisible(page, [...BOT_RADIO, ...BOT_CHECKBOX], 1200);
  const options = radios ? await readOptions(page) : [];
  const labels = options.map(o => o.text);

  const resolved = resolveAnswer(question, config);
  let value;
  let ai = null;
  if (resolved.matched) {
    value = String(resolved.answer);
  } else {
    const live = askAI && config.autoAnswer && config.autoAnswer.enabled
      ? await askAI(question, labels).catch(() => null) : null;
    if (!live || !live.answer) {
      return { state: 'unknown', question, options: labels, reason: (live && live.reason) || resolved.reason };
    }
    value = String(live.answer);
    ai = live.confidence || null;
    // Reused by every later job in this run without asking again — the
    // server has already saved it as an 'auto' rule for future runs.
    if (live.rule) config.answers = [live.rule, ...(config.answers || [])];
  }

  // Radio / checkbox questions: pick the option the answer names. Matched on
  // visible text rather than index — an index would silently choose the wrong
  // option the day Naukri reorders them — and by pickOption's exact / range /
  // whole-word rules, never a bare substring ("No" must not pick "Not
  // applicable").
  if (options.length) {
    const chosen = pickOption(value, labels);
    if (!chosen) {
      // None, or more than one, fits what we would have said. Choosing the
      // nearest would be guessing on your behalf.
      return { state: 'unknown', question, options: labels, reason: 'no option matched the configured answer' };
    }
    const opt = options.find(o => o.text === chosen);
    await opt.el.click();
    await jitter(300, 700);
    const send = await firstVisible(page, BOT_SEND, 1500);
    if (send) { await send.click(); await jitter(600, 1200); }
    return { state: 'answered', question, typed: chosen, ai };
  }

  const box = await firstVisible(page, BOT_TEXTAREA, 1500);
  if (!box) return { state: 'stuck', question, reason: 'no input found for this question' };

  await box.click();
  await box.fill('').catch(() => {});
  await box.type(value, { delay: 20 });
  await jitter(300, 700);

  const send = await firstVisible(page, BOT_SEND, 2000);
  if (!send) return { state: 'stuck', question, reason: 'no send button for this question' };
  await send.click();
  await jitter(700, 1400);
  return { state: 'answered', question, typed: value, ai };
}

// Walk the questionnaire. Bounded: a chatbot that keeps asking is a loop we must
// not ride, and a loop that applies 30 times is worse than one that gives up.
async function runChatbot(page, config, onStep, askAI) {
  const MAX_QUESTIONS = 12;
  const asked = [];

  for (let i = 0; i < MAX_QUESTIONS; i++) {
    const drawer = await firstVisible(page, CHATBOT, i === 0 ? 4000 : 1500);
    if (!drawer) return { state: 'done', asked };      // no questionnaire, or it closed

    const qEl = await firstVisible(page, BOT_QUESTION, 2000);
    if (!qEl) return { state: 'done', asked };

    // The last bot message is the live question; earlier ones are answered.
    let question = '';
    for (const sel of BOT_QUESTION) {
      const all = page.locator(sel);
      const n = await all.count().catch(() => 0);
      if (n) { question = ((await all.nth(n - 1).innerText().catch(() => '')) || '').trim(); break; }
    }
    if (!question) return { state: 'done', asked };
    // The questionnaire finished. Everything after this is confirmation, not
    // input — and treating it as a question is what abandoned a completed
    // application mid-submit.
    if (isClosing(question)) return { state: 'done', asked, closed: true };
    if (asked.length && asked[asked.length - 1].question === question) {
      // The same question twice means our answer was rejected and the bot is
      // repeating itself. Trying again would loop.
      return { state: 'stuck', asked, question, reason: 'the questionnaire repeated a question' };
    }

    const result = await answerOne(page, question, config, askAI);
    asked.push(result);
    onStep && onStep(result);
    if (result.state !== 'answered') {
      return { state: result.state, asked, question: result.question, options: result.options || [], reason: result.reason };
    }
  }

  return { state: 'stuck', asked, reason: `more than ${MAX_QUESTIONS} questions` };
}

// What the page offered instead of Apply, for a failure reason someone can act
// on: the address it ended up at and the buttons it showed.
async function describePage(page) {
  const offered = await page.evaluate(() => [...document.querySelectorAll('button, [role=button]')]
    .filter(b => b.offsetParent !== null)
    .map(b => `${b.id ? '#' + b.id + ' ' : ''}"${(b.innerText || '').trim().slice(0, 30)}"`)
    .filter(t => !/""$/.test(t)).slice(0, 6)).catch(() => []);
  let url = '';
  try { url = page.url(); } catch (_) {}
  return `page: ${url.slice(0, 120)} · buttons: ${offered.join(', ') || 'none'}`;
}

async function applyToOne(page, job, { config, dryRun, onStep, askAI }) {
  // In front, because Chrome slows background tabs to a crawl and the action
  // buttons hydrate late — a listing checked from behind another tab can look
  // like it has no Apply button at all.
  await page.bringToFront().catch(() => {});
  await page.goto(job.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await check(page, `the listing for "${job.title}"`);

  const body = await bodyText(page);
  if (ALREADY_MARKERS.some(m => body.includes(m))) {
    // Terminal: no future run can change this.
    return { outcome: 'skipped', terminal: true, reason: 'Naukri says you have already applied to this job' };
  }

  // Wait for EITHER button before classifying. The listing page hydrates its
  // action buttons client-side, so a plain count() can run against a page that
  // has neither yet — which reads as "not external", falls through, and turns a
  // company-site job into a failure instead of a clean skip. Racing the two
  // selectors removes the timing question entirely.
  const appeared = await Promise.race([
    page.waitForSelector(APPLY_BUTTON, { timeout: 20000 }).then(() => 'native').catch(() => null),
    page.waitForSelector(COMPANY_SITE_BUTTON, { timeout: 20000 }).then(() => 'external').catch(() => null),
    page.waitForSelector(WALKIN_BUTTON, { timeout: 20000 }).then(() => 'walkin').catch(() => null),
  ]);

  if (appeared === 'walkin') {
    return { outcome: 'skipped', terminal: true,
      reason: 'Walk-in drive — Naukri only offers "I am interested" here, which is not an application. Attend the walk-in if you want it.' };
  }

  // External ATS. We have no idea what form is on the other side, so we do not
  // follow it — that would be applying somewhere you never showed us.
  if (appeared === 'external') {
    // Terminal: the listing has no native Apply and never will. Retrying it
    // every run would eat the per-run budget and starve the queue behind it.
    return { outcome: 'skipped', terminal: true,
      reason: 'Applies on the company site — open it yourself, this worker only does native Naukri applies' };
  }
  if (appeared !== 'native') {
    const text = await bodyText(page);
    let url = '';
    try { url = page.url(); } catch (_) {}
    // Already applied, shown as a disabled "Applied" in place of the button.
    if (ALREADY_MARKERS.some(m => text.includes(m)) || /\bapplied\b/.test((await page.locator('[class*="apply-button-container"]').first().innerText().catch(() => '')).toLowerCase())) {
      return { outcome: 'skipped', terminal: true, reason: 'Naukri says you have already applied to this job' };
    }
    // Closed or taken down: a closed-listing message, or Naukri sent us away
    // from the listing altogether.
    if (CLOSED_MARKERS.some(m => text.includes(m)) || (url && !/job-listings-/.test(url))) {
      return { outcome: 'skipped', terminal: true, reason: 'Listing closed or removed — Naukri no longer takes applications for it' };
    }
    return { outcome: 'failed', reason: `No Apply button on the listing (${await describePage(page)})` };
  }

  // Re-read after the race: a page carrying both must still be treated as
  // external, whichever selector happened to resolve first.
  if (await page.locator(COMPANY_SITE_BUTTON).count().catch(() => 0)) {
    return { outcome: 'skipped', terminal: true,
      reason: 'Applies on the company site — open it yourself, this worker only does native Naukri applies' };
  }

  const applyBtn = await firstVisible(page, [APPLY_BUTTON], 4000);
  if (!applyBtn) {
    return { outcome: 'failed', reason: 'Apply button vanished before it could be clicked.' };
  }

  // The honest stopping point for a rehearsal. Clicking to "look at" the
  // questionnaire would apply to every job that has no questionnaire.
  if (dryRun) {
    return { outcome: 'dry-run', reason: 'Would have clicked Apply (stopped here — opening the questionnaire would itself apply)' };
  }

  await applyBtn.click();
  await jitter(1500, 2600);
  await check(page, `the apply flow for "${job.title}"`);

  const bot = await runChatbot(page, config, onStep, askAI);

  if (bot.state === 'unknown') {
    return {
      outcome: 'skipped',
      reason: `Unanswered screening question — answer it under Jobs → Needs answer`,
      question: bot.question,
      options: bot.options || [],
    };
  }
  if (bot.state === 'stuck') {
    return { outcome: 'failed', reason: `Questionnaire could not be completed: ${bot.reason}`, question: bot.question };
  }

  // Give the submit time to land before judging it. The bot's closing line
  // arrives before the application is actually recorded, so reading too early
  // reports a real application as a failure.
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1500);
    if (await looksApplied(page)) break;
  }
  const after = await bodyText(page);
  if (SUCCESS_MARKERS.some(m => after.includes(m)) || await looksApplied(page)) {
    const byAI = bot.asked.filter(a => a.ai);
    const aiNote = byAI.length
      ? ` · ${byAI.length} answered by AI (${byAI.map(a => `${a.ai}%`).join(', ')})` : '';
    return { outcome: 'applied', reason: bot.asked.length ? `Applied after ${bot.asked.length} question(s)${aiNote}` : 'Applied' };
  }

  // Clicked, nothing threw, but nothing on the page says it worked. Recorded as
  // failed rather than applied: a false "applied" would stop you ever applying
  // to this job by hand.
  return { outcome: 'failed', reason: 'Clicked Apply but Naukri never confirmed. Check this one by hand before re-running.' };
}

async function apply(session, { config = {}, jobs = [], dryRun = false, onProgress = () => {}, onResult = async () => {}, askAI = null } = {}) {
  const jobTimeout = askAI && config.autoAnswer && config.autoAnswer.enabled ? JOB_TIMEOUT_AI_MS : JOB_TIMEOUT_MS;
  // `rehearsed` is counted separately and never folded into applied/skipped:
  // a dry run must not leave numbers that look like work was done.
  const stats = { applied: 0, skipped: 0, failed: 0, rehearsed: 0 };
  const list = jobs.slice(0, Math.min(MAX_PER_RUN, Number(config.apply && config.apply.maxPerRun) || MAX_PER_RUN));
  const delayMin = Number(config.apply && config.apply.delayMinMs) || 1500;
  const delayMax = Math.max(delayMin, Number(config.apply && config.apply.delayMaxMs) || 4000);

  let page = await newPage(session);

  for (let i = 0; i < list.length; i++) {
    const job = list[i];
    onProgress({
      phase: dryRun ? 'rehearsing' : 'applying',
      label: `${job.title}${job.company ? ` · ${job.company}` : ''}`,
      page: i + 1, pagesTotal: list.length, ...stats,
    });

    let result;
    try {
      result = await withTimeout(
        applyToOne(page, job, { config, dryRun, onProgress, askAI }),
        jobTimeout,
        `"${job.title}"`,
      );
    } catch (err) {
      // A Checkpoint must escape: it stops the whole run and blocks the account.
      if (err && err.name === 'Checkpoint') throw err;
      result = { outcome: 'failed', reason: String(err.message || err).slice(0, 300) };

      // A timed-out job usually means the TAB stopped answering, not that this
      // one listing is special — so every job after it on the same page would
      // hang too, one timeout at a time, and the run would crawl to its end
      // achieving nothing. Throw the page away and continue on a fresh one.
      if (/did not finish within/.test(result.reason)) {
        await page.close().catch(() => {});
        page = await newPage(session);
      }
    }

    if (result.outcome === 'applied') stats.applied++;
    else if (result.outcome === 'skipped') stats.skipped++;
    else if (result.outcome === 'failed') stats.failed++;
    else if (result.outcome === 'dry-run') stats.rehearsed++;

    // Reported as it happens, not batched. A run that dies halfway must still
    // have told the server what it already sent.
    await onResult({ jobId: job.id, ...result });

    if (i < list.length - 1) await jitter(delayMin, delayMax);
  }

  onProgress({
    phase: dryRun ? 'rehearsing' : 'applying', label: 'done',
    page: list.length, pagesTotal: list.length, ...stats,
  });
  await page.close().catch(() => {});
  return stats;
}

module.exports = { apply, MAX_PER_RUN, APPLY_BUTTON, COMPANY_SITE_BUTTON };
