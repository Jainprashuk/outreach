'use strict';

// The daily profile re-save.
//
// Naukri ranks recruiter search results partly by how recently a profile was
// updated, so a profile touched this morning surfaces above an identical one
// touched last month. That is the entire value of this run, and it is why it is
// the piece worth automating first: it is one save button, it runs every day
// forever, and it applies to nothing — the worst case is a profile that looks
// the same as it did yesterday.
//
// What it edits is the resume headline, round-tripped. If you configured
// headline variants it rotates through them (the server advances the index at
// claim time), otherwise it rewrites whatever is already there. Naukri ignores a
// save that changes nothing, so writing the identical string back is not always
// enough — a variant list is the reliable path, and the "last updated" check
// below is what tells you which case you are in.
//
// SELECTORS: everything Naukri-shaped lives in this file. When the save stops
// working, fix the selector here. Do not add retries — a retry loop against a
// changed DOM is how you get rate-limited for nothing.

const { check, jitter } = require('./guard');
const { newPage } = require('./session');

const PROFILE_URL = 'https://www.naukri.com/mnjuser/profile';

// Naukri has shipped several profile layouts; each list is tried in order and
// the first visible match wins. A list beats one clever selector because a miss
// is then a specific, reportable failure rather than a timeout.
//
// The leading entry in each list was verified against the live profile page on
// 2026-09-23. The trailing entries are older/likelier-next shapes kept as
// fallbacks — they cost nothing until the leader stops matching, which is
// exactly the day you want them.
const HEADLINE_EDIT = [
  '#lazyResumeHead span.edit',                                  // verified 2026-09-23
  'div:has-text("Resume headline") >> xpath=.. >> span.edit',   // verified 2026-09-23
  '[data-test="edit-resumeHeadline"]',
  'span.edit.icon[title="Edit Resume headline"]',
];
const HEADLINE_TEXTAREA = [
  'textarea[name="resumeHeadline"]',                            // verified 2026-09-23
  '#resumeHeadlineTxt',                                         // verified 2026-09-23
  'textarea#resumeHeadline',
];
const HEADLINE_SAVE = [
  'button[type="submit"]:has-text("Save")',                     // verified 2026-09-23
  '.action button:has-text("Save")',
  'form button:has-text("Save")',
];
// The profile's own freshness stamp — the only honest proof the save landed.
// Renders as "Profile last updated - 18Sep , 2026".
const UPDATED_STAMP = [
  'text=/last updated/i',                                       // verified 2026-09-23
  '[class*="lastUpdated"]',
  'span:has-text("Updated on")',
];

// First selector that resolves to a visible element, or null. Short per-try
// timeout: we are choosing between known alternatives, not waiting for a page.
async function firstVisible(page, selectors, timeout = 3000) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout });
      return el;
    } catch (_) { /* try the next shape */ }
  }
  return null;
}

async function readStamp(page) {
  const el = await firstVisible(page, UPDATED_STAMP, 2000);
  if (!el) return '';
  try { return (await el.innerText()).trim(); } catch (_) { return ''; }
}

async function refresh(session, { config = {}, onProgress = () => {} } = {}) {
  const page = await newPage(session);

  onProgress({ phase: 'refresh', label: 'opening profile' });
  await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded' });
  await check(page, 'the profile page');

  const before = await readStamp(page);

  const editIcon = await firstVisible(page, HEADLINE_EDIT);
  if (!editIcon) {
    throw new Error(
      'Could not find the resume-headline edit control on the profile page. Naukri changed their DOM — '
      + 'fix HEADLINE_EDIT in worker/naukri/refresh.js. Do not add retries.'
    );
  }

  onProgress({ phase: 'refresh', label: 'editing headline' });
  await editIcon.click();
  await jitter(700, 1600);

  const box = await firstVisible(page, HEADLINE_TEXTAREA);
  if (!box) {
    throw new Error(
      'Opened the headline editor but found no textarea. Fix HEADLINE_TEXTAREA in worker/naukri/refresh.js.'
    );
  }

  const current = (await box.inputValue()).trim();
  const variants = Array.isArray(config.headlineVariants) ? config.headlineVariants.filter(Boolean) : [];
  // The server advanced headlineIndex when it handed out this run, so two
  // consecutive refreshes write different text even though neither knows about
  // the other. Falling back to the current value keeps the run honest when no
  // variants are configured — it just may not move the stamp, which the caller
  // reports rather than hides.
  const next = variants.length
    ? variants[(Number(config.headlineIndex) || 0) % variants.length]
    : current;

  if (!next) {
    throw new Error(
      'The resume headline is empty and no headline variants are configured. Add one in '
      + 'Configuration → Resume & Headline, or set a headline on Naukri.'
    );
  }

  // Clear and retype rather than fill(): Naukri's editor listens for input
  // events to enable its Save button, and a programmatic value set can leave the
  // button disabled — a save that silently does nothing.
  //
  // selectText(), NOT press('Control+a'). On macOS Control+A moves the caret to
  // the start of the line; it does not select anything. The first live run typed
  // the new headline onto the front of the old one and saved a profile headline
  // that was the same sentence twice. selectText() selects the field's contents
  // on every platform.
  await box.click();
  await box.selectText();
  await box.press('Backspace');

  // Refuse to save unless the field is genuinely empty. The failure above was
  // silent and landed on a live profile; a length check is cheap insurance
  // against whatever the next editor rewrite does to the clear.
  const cleared = await box.inputValue();
  if (cleared.length > 0) {
    throw new Error(
      `Could not clear the headline field before typing (${cleared.length} chars remain). Refusing to `
      + 'save rather than risk appending to your existing headline.'
    );
  }

  await box.type(next, { delay: 18 });

  // And verify what actually landed, for the same reason.
  const typed = await box.inputValue();
  if (typed.trim() !== next.trim()) {
    throw new Error(
      `The headline field holds ${typed.length} chars after typing ${next.length}. Refusing to save a `
      + 'headline that is not what was intended.'
    );
  }
  await jitter(400, 900);

  const save = await firstVisible(page, HEADLINE_SAVE);
  if (!save) {
    throw new Error('Could not find the headline Save button. Fix HEADLINE_SAVE in worker/naukri/refresh.js.');
  }
  await save.click();

  // Let the save round-trip before reading the stamp back.
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await jitter(1200, 2200);
  await check(page, 'the profile page after saving');

  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await check(page, 'the reloaded profile page');
  const after = await readStamp(page);

  // Success is "the profile is stamped today", NOT "the stamp changed".
  //
  // Those come apart on the second run of a day: the stamp already says Today,
  // so a save that worked perfectly leaves it byte-identical, and a
  // changed-or-not test calls that a dark wake. The daily schedule would never
  // notice, but pressing the button twice would report a failure every time.
  //
  // A genuine dark wake cannot reach this line anyway — a page that never
  // painted has no edit control, and firstVisible() throws long before the save.
  const isFresh = (t) => /today|just now|few seconds|moments ago/i.test(t || '');
  const updated = isFresh(after) || (!!after && after !== before);

  return {
    updated,
    note: isFresh(after)
      ? `headline saved; profile is stamped "${after}"`
      : updated
        ? `headline saved; stamp moved from "${before}" to "${after}"`
        : `stamp still reads "${after}" after saving — the save did not land`,
    headline: next,
    stampBefore: before,
    stampAfter: after,
  };
}

module.exports = { refresh };
