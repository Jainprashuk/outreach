const JobPosting = require('../models/JobPosting');
const JobBoard = require('../models/JobBoard');
const Settings = require('../models/Settings');
const boards = require('./boards');
const { mapLimit, deadline } = require('./http');
const { normaliseCriteria, matchesCriteria } = require('./criteria');

// CONCURRENCY x each adapter's maxBytes is ONE memory budget, not two
// independent knobs. Ashby alone can be 24MB, so raising either raises peak
// serverless memory multiplicatively.
const CONCURRENCY = 4;
const RUN_BUDGET_MS = 45_000;   // vercel maxDuration is 60
const LOCK_TTL_MS = 90_000;     // > maxDuration, so a crashed invocation self-heals
const MASS_CLOSE_WARN = 20;

// Delegated: company boards key on the token, searches deliberately don't (the
// same job found by three saved searches is one row). See lib/boards/index.js.
const sourceKeyFor = boards.sourceKeyFor;

/**
 * Sync one board: fetch, upsert, then close what vanished.
 *
 * `runStartedAt` is captured ONCE per run and shared by every board. It is
 * simultaneously the lastSeenAt stamp and the close-pass cutoff, and that single
 * fact is what makes the whole diff idempotent — re-running an identical sync
 * closes nothing.
 *
 * Never throws.
 *
 * @param {object} board          a JobBoard document (or lean object with _id)
 * @param {{runStartedAt: Date, deadline?: object, dryRun?: boolean}} opts
 * @returns {Promise<object>} BoardReport
 */
async function syncBoard(board, { runStartedAt, deadline: budget, dryRun = false, criteria = null } = {}) {
  const startedAt = Date.now();
  const source = board.source;
  const token = board.token;
  const boardId = String(board._id || board.id);

  const report = {
    boardId, source, token, label: board.label || '',
    status: 'error', httpStatus: null, error: null,
    fetched: 0, filtered: 0, filteredOut: 0, inserted: 0, updated: 0, reopened: 0, closed: 0,
    firstSync: !board.firstSyncAt, massClosed: false, writeErrors: 0, ms: 0,
    kind: boards.kindOf(source),
  };

  // Out of budget before we even started: skip, and above all close nothing.
  if (budget && budget.expired()) {
    report.status = 'skipped';
    report.error = 'Run budget exhausted before this board was reached';
    report.ms = Date.now() - startedAt;
    if (!dryRun) await recordBoardOutcome(board, report, runStartedAt);
    return report;
  }

  const res = await boards.fetchBoard(source, token, {
    signal: budget && budget.signal,
    deadline: budget,
    label: board.label || '',
    query: board.query || {},
  });

  report.status = res.kind;
  report.httpStatus = res.httpStatus;
  report.error = res.error;
  report.fetched = res.raw.count || 0;
  report.filtered = res.raw.filtered || 0;
  if (res.raw.enrichError) report.enrichError = res.raw.enrichError;

  // ── THE GUARD ────────────────────────────────────────────────────────────
  // 'not-found' and 'error' mean "we could not find out", so we touch ZERO
  // postings. This is structural, not a check that could be forgotten: the
  // close pass below is only reachable from the ok/empty branch. A 404, a
  // timeout, or an API shape change can therefore never mass-close a board.
  if (res.kind === 'not-found' || res.kind === 'error') {
    report.ms = Date.now() - startedAt;
    if (!dryRun) await recordBoardOutcome(board, report, runStartedAt);
    return report;
  }

  // Defensive: a board listing the same id twice would otherwise produce two
  // bulk ops against one document in the same batch.
  const seen = new Set();
  const postings = [];
  for (const p of res.postings) {
    const id = String(p.sourceId || '');
    if (!id || seen.has(id)) continue;
    // title is required by the schema; a titleless posting would fail the write
    // and (worse) drag the close pass down with it.
    if (!p.title) continue;
    seen.add(id);
    postings.push(p);
  }

  // EVERYTHING the source listed. This set — not the filtered one — is what the
  // close pass must reason about.
  const listedKeys = postings.map(p => sourceKeyFor(source, token, p.sourceId));

  // ── CRITERIA FILTER ──────────────────────────────────────────────────────
  // Decides what to STORE, never what exists. A posting you filtered out is
  // still open at the company, so treating it as vanished would be a lie — and
  // would "close" half a board the moment you edited your keywords.
  const toStore = criteria && criteria.enabled
    ? postings.filter(p => matchesCriteria(p, criteria))
    : postings;
  report.filteredOut = postings.length - toStore.length;

  const storeKeys = toStore.map(p => sourceKeyFor(source, token, p.sourceId));

  // Read prior state before writing: this is what yields exact inserted /
  // reopened counts without trusting bulkWrite's upsertedIds ordering.
  const prev = storeKeys.length
    ? await JobPosting.find(
        { sourceKey: { $in: storeKeys } },
        { sourceKey: 1, listingStatus: 1, firstSeenAt: 1 }
      ).lean()
    : [];
  const prevByKey = new Map(prev.map(d => [d.sourceKey, d]));

  for (const p of toStore) {
    const existing = prevByKey.get(sourceKeyFor(source, token, p.sourceId));
    if (!existing) report.inserted++;
    else {
      report.updated++;
      if (existing.listingStatus === 'closed') report.reopened++;
    }
  }

  if (dryRun) {
    report.closed = boards.closesPostings(source)
      ? await countStale({ source, boardToken: token, keys: listedKeys })
      : 0;
    report.massClosed = report.closed >= MASS_CLOSE_WARN && report.fetched === 0;
    report.ms = Date.now() - startedAt;
    return report;
  }

  // ── "STILL LISTED" STAMP ─────────────────────────────────────────────────
  // Postings the source listed but the criteria excluded get their lastSeenAt
  // refreshed anyway, so the close pass (which works off lastSeenAt) cannot
  // mistake "you don't want it" for "it's gone". Scoped to the excluded keys
  // only, so rows in the upsert pass are not counted twice.
  const stored = new Set(storeKeys);
  const excludedKeys = listedKeys.filter(k => !stored.has(k));
  if (excludedKeys.length) {
    try {
      await JobPosting.updateMany(
        { sourceKey: { $in: excludedKeys } },
        { $set: { lastSeenAt: runStartedAt }, $inc: { seenCount: 1 } }
      );
    } catch (_) {
      // Best effort. If this fails the close pass below could wrongly close a
      // filtered-out posting, so treat it as a write error and skip closing.
      report.writeErrors++;
    }
  }

  // ── UPSERT PASS ──────────────────────────────────────────────────────────
  if (toStore.length) {
    const ops = upsertOps(toStore, { source, boardToken: token, boardId, runStartedAt, prevByKey, queryTag: queryTagFor(board) });
    try {
      const out = await JobPosting.bulkWrite(ops, { ordered: false });
      report.writeErrors += (out && out.writeErrors && out.writeErrors.length) || 0;
    } catch (err) {
      // A BulkWriteError still applied its successful ops. Count the failures
      // and let the guard below skip the close pass.
      report.writeErrors += (err && err.writeErrors && err.writeErrors.length) || toStore.length;
      report.error = `Partial write failure: ${err.message}`;
    }
  }

  // A posting whose upsert failed still carries its OLD lastSeenAt, so the close
  // pass would wrongly close it. Skipping the pass leaves the board stale for one
  // run, which is strictly better than inventing closures.
  if (report.writeErrors > 0) {
    report.ms = Date.now() - startedAt;
    await recordBoardOutcome(board, report, runStartedAt);
    return report;
  }

  // ── CLOSE PASS ───────────────────────────────────────────────────────────
  // Company boards only. A search reads the first few pages of a query that can
  // run to 1400+, so a posting missing from today's slice tells us nothing about
  // whether the job still exists — closing on that would be pure fabrication.
  report.closed = boards.closesPostings(source)
    ? await closeStale({ source, boardToken: token, runStartedAt })
    : 0;

  // A board that fetched nothing and closed a lot is the ambiguous case: a real
  // hiring freeze looks identical to a renamed board. We still close (an empty
  // 200 is the board telling us it lists nothing) but flag it loudly, and it is
  // reversible — tracking is untouched and the next good run reopens everything.
  report.massClosed = report.closed >= MASS_CLOSE_WARN && report.fetched === 0;

  report.ms = Date.now() - startedAt;
  await recordBoardOutcome(board, report, runStartedAt);
  return report;
}

/**
 * Split each posting's fields into $set (the board's truth) and $setOnInsert
 * (ours). What is ABSENT from $set is the whole answer to "how does my tracking
 * survive a resync": applyStatus, appliedAt, appliedVia, applyNote,
 * applyHistory, firstSeenAt, deleted, deletedAt and closeCount can never be
 * overwritten by a sync.
 */
/** A short tag naming the saved search that surfaced a posting. */
function queryTagFor(board) {
  if (!boards.isSearchSource(board.source)) return null;
  return board.label || board.token || board.source;
}

function upsertOps(postings, { source, boardToken, boardId, runStartedAt, prevByKey, queryTag = null }) {
  return postings.map((p) => {
    const sourceKey = sourceKeyFor(source, boardToken, p.sourceId);
    const existing = prevByKey.get(sourceKey);
    const wasClosed = !!existing && existing.listingStatus === 'closed';

    const $set = {
      source, boardToken, boardId, sourceId: String(p.sourceId), sourceKey,
      title: p.title,
      company: p.company || '',
      department: p.department || '',
      team: p.team || '',
      location: p.location || '',
      locations: Array.isArray(p.locations) ? p.locations : [],
      remote: !!p.remote,
      workplaceType: p.workplaceType || '',
      employmentType: p.employmentType || '',
      country: p.country || '',
      url: p.url || '',
      applyUrl: p.applyUrl || '',
      requisitionId: p.requisitionId || '',
      salaryMin: Number.isFinite(p.salaryMin) ? p.salaryMin : null,
      salaryMax: Number.isFinite(p.salaryMax) ? p.salaryMax : null,
      salaryCurrency: p.salaryCurrency || '',
      salaryPeriod: p.salaryPeriod || '',
      postedAt: p.postedAt || null,
      sourceUpdatedAt: p.sourceUpdatedAt || null,
      listingStatus: 'open',
      lastSeenAt: runStartedAt,
    };
    if (wasClosed) {
      $set.reopenedAt = runStartedAt;
      $set.closedAt = null;
    }

    return {
      updateOne: {
        // No `deleted` clause, deliberately: without it a posting you deleted
        // would come back as a brand-new row on every single sync.
        filter: { sourceKey },
        update: {
          $set,
          $setOnInsert: {
            firstSeenAt: runStartedAt,
            applyStatus: 'not-applied',
            appliedAt: null,
            appliedVia: null,
            applyNote: '',
            applyHistory: [],
            closeCount: 0,
            ...(queryTag ? {} : { queries: [] }),
            deleted: false,
            deletedAt: null,
          },
          $inc: { seenCount: 1 },
          // Credit every saved search that surfaced this posting, without a
          // read-modify-write. Searches store one row per job, so this is how
          // "which of my queries found it" survives.
          ...(queryTag ? { $addToSet: { queries: queryTag } } : {}),
        },
        upsert: true,
      },
    };
  });
}

/**
 * Close everything still open on THIS board that THIS run did not touch.
 *
 * Uses `lastSeenAt < runStartedAt` rather than `sourceKey $nin keys` because it
 * rides the {source, boardToken, listingStatus} index instead of shipping 600+
 * keys into a query, and because it is naturally idempotent: the upsert pass
 * already bumped lastSeenAt to runStartedAt for everything present, so an
 * identical rerun closes nothing.
 *
 * $lt, not $lte — with $lte a rerun would close everything it just upserted.
 */
async function closeStale({ source, boardToken, runStartedAt }) {
  const out = await JobPosting.updateMany(
    { source, boardToken, listingStatus: 'open', lastSeenAt: { $lt: runStartedAt } },
    { $set: { listingStatus: 'closed', closedAt: runStartedAt }, $inc: { closeCount: 1 } }
  );
  return out.modifiedCount || 0;
}

// dryRun equivalent of closeStale: counts without writing.
async function countStale({ source, boardToken, keys }) {
  return JobPosting.countDocuments({
    source, boardToken, listingStatus: 'open', sourceKey: { $nin: keys },
  });
}

async function recordBoardOutcome(board, report, runStartedAt) {
  const succeeded = report.status === 'ok' || report.status === 'empty';
  const $set = {
    lastSyncAt: runStartedAt,
    lastSyncStatus: report.status,
    lastError: report.error || '',
    lastHttpStatus: report.httpStatus,
  };
  const update = { $set };

  if (succeeded && report.writeErrors === 0) {
    $set.lastSuccessAt = runStartedAt;
    $set.lastPostingCount = report.fetched;
    $set.lastNewCount = report.inserted;
    $set.lastClosedCount = report.closed;
    $set.consecutiveFailures = 0;
    // Stamped once, and only on a real success, so the UI can tell a board's
    // initial import from postings that are genuinely new.
    if (!board.firstSyncAt) $set.firstSyncAt = runStartedAt;
  } else {
    update.$inc = { consecutiveFailures: 1 };
  }

  try {
    await JobBoard.updateOne({ _id: board._id || board.id }, update);
  } catch (_) {
    // Bookkeeping must never fail a run that already did its real work.
  }
}

/**
 * Claim the lease, sync every enabled board inside one wall-clock budget, stamp
 * Settings.lastPostingSyncAt, release the lease.
 *
 * @param {{boardIds?: string[]|null, dryRun?: boolean}} [opts]
 * @returns {Promise<object>} RunReport
 */
async function syncAllBoards({ boardIds = null, dryRun = false } = {}) {
  const runStartedAt = new Date();
  const budget = deadline(RUN_BUDGET_MS);

  // One read per run, shared by every board — it is the same profile for all.
  const settingsDoc = await Settings.findOne({}, { jobCriteria: 1 }).lean();
  const criteria = normaliseCriteria(settingsDoc && settingsDoc.jobCriteria);

  const filter = { deleted: { $ne: true }, enabled: true };
  if (Array.isArray(boardIds) && boardIds.length) filter._id = { $in: boardIds };
  const list = await JobBoard.find(filter).sort({ createdAt: 1 }).lean();

  if (list.length === 0) {
    return emptyRun(runStartedAt, dryRun ? null : await readLastSyncAt(), 'no-boards');
  }

  // The previous sync stamp has to be read BEFORE we overwrite it — it is what
  // the UI diffs firstSeenAt against to decide what is new.
  let previousSyncAt = null;
  let leaseId = null;
  if (!dryRun) {
    const claim = await claimLease();
    if (!claim.ok) {
      return {
        ok: false, reason: 'locked', since: claim.since,
        startedAt: runStartedAt.toISOString(), finishedAt: new Date().toISOString(), ms: 0,
        previousSyncAt: claim.lastPostingSyncAt
          ? new Date(claim.lastPostingSyncAt).toISOString() : null,
        boards: [], totals: zeroTotals(),
      };
    }
    previousSyncAt = claim.lastPostingSyncAt || null;
    leaseId = claim.id;
  } else {
    previousSyncAt = await readLastSyncAt();
  }

  let reports;
  try {
    reports = await mapLimit(list, CONCURRENCY, (board) =>
      syncBoard(board, { runStartedAt, deadline: budget, dryRun, criteria })
    );
    // mapLimit yields undefined for a worker that threw. syncBoard promises not
    // to, but a null hole here would break the totals silently.
    reports = reports.map((r, i) => r || {
      boardId: String(list[i]._id), source: list[i].source, token: list[i].token,
      label: list[i].label || '', status: 'error', httpStatus: null,
      error: 'Sync worker failed unexpectedly',
      fetched: 0, filtered: 0, filteredOut: 0, inserted: 0, updated: 0, reopened: 0, closed: 0,
      firstSync: false, massClosed: false, writeErrors: 0, ms: 0,
      kind: boards.kindOf(list[i].source),
    });

    if (!dryRun && leaseId) {
      await Settings.updateOne({ _id: leaseId }, { $set: { lastPostingSyncAt: runStartedAt } });
    }
  } finally {
    if (!dryRun && leaseId) await releaseLease(leaseId);
  }

  const finishedAt = new Date();
  return {
    ok: true,
    startedAt: runStartedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ms: finishedAt - runStartedAt,
    previousSyncAt: previousSyncAt ? new Date(previousSyncAt).toISOString() : null,
    criteriaEnabled: !!criteria.enabled,
    boards: reports,
    totals: totalsOf(reports),
  };
}

async function claimLease() {
  // getSingleton() first, so the document is guaranteed to exist and every write
  // can be scoped to its _id. Do NOT upsert on Settings: with no unique index, a
  // filter that fails to match (i.e. the lock IS held) would insert a SECOND
  // settings document — which breaks the singleton invariant and silently
  // defeats the lease, because each contender then owns its own copy.
  const singleton = await Settings.getSingleton();
  const stale = new Date(Date.now() - LOCK_TTL_MS);

  // projection excludes the resume Buffer — MANDATORY, the singleton holds one.
  const before = await Settings.findOneAndUpdate(
    {
      _id: singleton._id,
      $or: [
        { postingSyncLockAt: null },
        { postingSyncLockAt: { $exists: false } },
        { postingSyncLockAt: { $lt: stale } },
      ],
    },
    { $set: { postingSyncLockAt: new Date() } },
    { returnDocument: 'before', projection: { 'resume.data': 0 } }
  );

  // With no upsert, null means exactly one thing: the filter did not match, so
  // the lock is genuinely held. No ambiguity to disentangle.
  if (before === null) {
    const held = await Settings.findById(singleton._id,
      { postingSyncLockAt: 1, lastPostingSyncAt: 1 }).lean();
    return {
      ok: false,
      id: singleton._id,
      since: held && held.postingSyncLockAt ? held.postingSyncLockAt.toISOString() : null,
      lastPostingSyncAt: (held && held.lastPostingSyncAt) || null,
    };
  }

  // returnDocument:'before' gives the PRE-update doc, which is where the
  // previous sync stamp still lives.
  return { ok: true, id: singleton._id, lastPostingSyncAt: before.lastPostingSyncAt || null };
}

const releaseLease = async (id) => {
  try {
    await Settings.updateOne({ _id: id }, { $set: { postingSyncLockAt: null } });
  } catch (_) { /* the TTL is the real backstop */ }
};

const readLastSyncAt = async () => {
  const s = await Settings.findOne({}, { lastPostingSyncAt: 1 }).lean();
  return (s && s.lastPostingSyncAt) || null;
};

const zeroTotals = () => ({
  boards: 0, ok: 0, empty: 0, notFound: 0, errored: 0, skipped: 0,
  fetched: 0, filteredOut: 0, inserted: 0, updated: 0, reopened: 0, closed: 0,
});

function totalsOf(reports) {
  const t = zeroTotals();
  t.boards = reports.length;
  for (const r of reports) {
    if (r.status === 'ok') t.ok++;
    else if (r.status === 'empty') t.empty++;
    else if (r.status === 'not-found') t.notFound++;
    else if (r.status === 'skipped') t.skipped++;
    else t.errored++;
    t.fetched += r.fetched; t.inserted += r.inserted; t.updated += r.updated;
    t.reopened += r.reopened; t.closed += r.closed;
    t.filteredOut += r.filteredOut || 0;
  }
  return t;
}

const emptyRun = (runStartedAt, previousSyncAt, reason) => ({
  ok: true, reason,
  startedAt: runStartedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  ms: 0,
  previousSyncAt: previousSyncAt ? new Date(previousSyncAt).toISOString() : null,
  boards: [], totals: zeroTotals(),
});

module.exports = {
  syncBoard, syncAllBoards, upsertOps, closeStale, sourceKeyFor,
  CONCURRENCY, RUN_BUDGET_MS, LOCK_TTL_MS, MASS_CLOSE_WARN,
};
