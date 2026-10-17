'use strict';

// A driver that never opens a browser.
//
// It exists so the worker loop — claim, progress, ingest, result, finish, the
// budget, the dry-run flag, the checkpoint path — can be exercised end to end
// against the real server before a single Naukri selector is written. Testing
// that lifecycle against the live site would mean spending real applications on
// a real account to find out whether a JSON field was misspelled.
//
// It is also the interface document. Every function the real driver
// (worker/naukri/index.js) must export appears here with the same signature and
// the same return shape, so "does the stub still pass" is a meaningful check on
// a selector refactor.
//
//   NAUKRI_STUB=1 npm run naukri-worker
//
// Env knobs, for driving the paths that are otherwise hard to reach on demand:
//   NAUKRI_STUB_FAIL=refresh|harvest|apply   make that kind throw
//   NAUKRI_STUB_CHECKPOINT=1                 raise the captcha path (exit 2)
//   NAUKRI_STUB_EMPTY=1                      harvest renders nothing (dark wake)
//   NAUKRI_STUB_JOBS=12                      how many fake listings to return

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const COMPANIES = ['Acme Systems', 'Globex', 'Initech', 'Umbrella Labs', 'Hooli', 'Vehement Capital'];
const TITLES = [
  'Senior Backend Engineer', 'Platform Engineer', 'Full Stack Developer',
  'Node.js Developer', 'Software Engineer II', 'Lead Backend Engineer',
];
const LOCATIONS = ['Bangalore', 'Pune', 'Remote', 'Hyderabad', 'Noida'];

// Named so the worker's isCheckpoint() recognises it. The real driver's guard
// throws the same shape.
class Checkpoint extends Error {
  constructor(message) { super(message); this.name = 'Checkpoint'; }
}

const maybeCheckpoint = () => {
  if (process.env.NAUKRI_STUB_CHECKPOINT === '1') {
    throw new Checkpoint('Naukri showed a captcha. Everything is paused for 7 days.');
  }
};
const maybeFail = (kind) => {
  if (process.env.NAUKRI_STUB_FAIL === kind) throw new Error(`Stub was asked to fail on ${kind}`);
};

async function connect() {
  return { stub: true, openedAt: Date.now() };
}

async function disconnect() { /* nothing to close */ }

async function loggedIn() { return true; }

async function refresh(session, { onProgress }) {
  maybeCheckpoint();
  maybeFail('refresh');
  onProgress({ phase: 'refresh', label: 'opening profile' });
  await sleep(300);
  onProgress({ phase: 'refresh', label: 'saving headline' });
  await sleep(300);
  // The real driver returns false when the profile's "last updated" stamp did
  // not move, which the worker treats as a dark wake rather than a success.
  return { updated: true, note: 'headline round-tripped (stub)' };
}

async function harvest(session, { config, onProgress }) {
  maybeCheckpoint();
  maybeFail('harvest');

  if (process.env.NAUKRI_STUB_EMPTY === '1') return { jobs: [], searches: 1 };

  const count = Number(process.env.NAUKRI_STUB_JOBS) || 8;
  const { sourcesOf } = require('./harvest');
  const sources = sourcesOf(config);
  const searches = !sources.searches ? []
    : (config.searches && config.searches.length ? config.searches : [{ keywords: 'backend engineer' }]);
  const jobs = [];

  for (let s = 0; s < searches.length; s++) {
    const label = searches[s].label || searches[s].keywords || searches[s].url || `search ${s + 1}`;
    onProgress({ phase: 'searching', label, page: s + 1, pagesTotal: searches.length, found: jobs.length });
    await sleep(250);

    for (let i = 0; i < count; i++) {
      const n = s * count + i;
      const min = 2 + (n % 5);
      jobs.push({
        // Stable across runs so a second stub harvest exercises the update path
        // rather than inserting duplicates.
        sourceId: `stub-${n}`,
        title: TITLES[n % TITLES.length],
        company: COMPANIES[n % COMPANIES.length],
        location: LOCATIONS[n % LOCATIONS.length],
        experienceMin: min,
        experienceMax: min + 4,
        salaryText: n % 3 === 0 ? 'Not disclosed' : `${8 + n % 10}-${14 + n % 10} Lacs PA`,
        tags: ['node', 'mongodb', 'express'],
        url: `https://www.naukri.com/job-listings-stub-${n}`,
        postedText: `${1 + (n % 6)} days ago`,
        queries: [label],
        origins: ['search'],
      });
    }
    onProgress({ phase: 'searching', label, page: s + 1, pagesTotal: searches.length, found: jobs.length });
  }

  // Recommended: a few of its own, plus stub-0 again so the "found both ways"
  // path is exercised whenever searches ran too.
  let recommended = 0;
  if (sources.recommended) {
    onProgress({ phase: 'recommended', label: 'Recommended for you', page: 1, pagesTotal: 1, found: jobs.length });
    await sleep(200);
    const both = jobs.find(j => j.sourceId === 'stub-0');
    if (both) { both.origins.push('recommended'); both.queries.push('Recommended for you'); recommended++; }
    for (let i = 0; i < 3; i++) {
      recommended++;
      jobs.push({
        sourceId: `stub-rec-${i}`, title: `Platform Engineer ${i + 1}`, company: COMPANIES[i % COMPANIES.length],
        location: LOCATIONS[i % LOCATIONS.length], experienceMin: 3, experienceMax: 7,
        salaryText: 'Not disclosed', tags: ['node', 'kubernetes'], url: `https://www.naukri.com/job-listings-stub-rec-${i}`,
        postedText: '2 days ago', queries: ['Recommended for you'], origins: ['recommended'],
        // The real feed says outright when Apply leaves Naukri; the last one does.
        companySite: i === 2,
      });
    }
  }

  return { jobs, searches: searches.length, recommended };
}

const STUB_QUESTION = 'Do you have experience with SAP?';
const STUB_OPTIONS = ['Yes', 'No'];

async function apply(session, { config = {}, jobs, dryRun, onProgress, onResult }) {
  const { resolveAnswer, pickOption } = require('../../lib/naukriAnswers');
  maybeCheckpoint();
  maybeFail('apply');

  const stats = { applied: 0, skipped: 0, failed: 0, rehearsed: 0 };

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress({
      phase: 'applying', label: `${job.title} · ${job.company}`,
      page: i + 1, pagesTotal: jobs.length, ...stats,
    });
    await sleep(200);

    // Every third job asks a Yes/No question. It is skipped unless the answer
    // bank resolves it to one of the options — the same rule the real driver
    // applies — so the whole loop (skip → AI draft → Use → requeue → applied)
    // runs end to end without a real screening form.
    const asks = i % 3 === 2;
    const resolved = asks ? resolveAnswer(STUB_QUESTION, config) : null;
    const unanswerable = asks && !(resolved.matched && pickOption(resolved.answer, STUB_OPTIONS));

    if (dryRun) {
      // A rehearsal must leave no trace on the job — the server enforces that
      // too, but the driver must not pretend otherwise.
      await onResult({ jobId: job.id, outcome: 'dry-run', reason: unanswerable
        ? 'would have skipped: unanswered question'
        : 'would have applied' });
      stats.rehearsed++;
      continue;
    }

    if (unanswerable) {
      stats.skipped++;
      await onResult({
        jobId: job.id, outcome: 'skipped',
        reason: 'Unanswered screening question — answer it under Jobs → Needs answer',
        question: STUB_QUESTION,
        options: STUB_OPTIONS,
      });
      continue;
    }

    stats.applied++;
    await onResult({ jobId: job.id, outcome: 'applied', reason: 'Applied (stub)' });
  }

  onProgress({ phase: 'applying', label: 'done', page: jobs.length, pagesTotal: jobs.length, ...stats });
  return stats;
}

module.exports = { connect, disconnect, loggedIn, refresh, harvest, apply, Checkpoint };
