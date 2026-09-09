// Registry for the keyless job sources. Two kinds, and the difference is
// load-bearing:
//
//   kind 'board'  — ONE company's public ATS page (Greenhouse/Lever/Ashby).
//                   Authoritative and complete: what it lists IS everything that
//                   company has open, so a posting vanishing means it closed.
//
//   kind 'search'  — a keyword/category query across many employers
//                   (The Muse, Jobicy). A PARTIAL view by construction: we read
//                   the first few pages of a query that may run to 1400+. A
//                   posting not being in today's slice says nothing about
//                   whether the job still exists, so these must NEVER drive
//                   close detection. That is what `closes: false` enforces.

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');
const muse = require('./muse');
const jobicy = require('./jobicy');
const normalise = require('./normalise');

const ADAPTERS = { greenhouse, lever, ashby, muse, jobicy };
const SOURCES = Object.keys(ADAPTERS);

const SOURCE_META = {
  greenhouse: {
    label: 'Greenhouse', kind: 'board', closes: true,
    boardUrl: (t) => `https://boards.greenhouse.io/${t}`,
    tokenHint: 'The slug in boards.greenhouse.io/<token>',
  },
  lever: {
    label: 'Lever', kind: 'board', closes: true,
    boardUrl: (t) => `https://jobs.lever.co/${t}`,
    tokenHint: 'The slug in jobs.lever.co/<token>',
  },
  ashby: {
    label: 'Ashby', kind: 'board', closes: true,
    boardUrl: (t) => `https://jobs.ashbyhq.com/${t}`,
    tokenHint: 'The slug in jobs.ashbyhq.com/<token>',
  },
  muse: {
    label: 'The Muse', kind: 'search', closes: false,
    boardUrl: () => 'https://www.themuse.com/search/',
    tokenHint: 'A name for this saved search',
    categories: muse.CATEGORIES,
    levels: muse.LEVELS,
  },
  jobicy: {
    label: 'Jobicy (remote)', kind: 'search', closes: false,
    boardUrl: () => 'https://jobicy.com/',
    tokenHint: 'A name for this saved search',
    industries: jobicy.INDUSTRIES,
    levels: jobicy.LEVELS,
  },
};

const getAdapter = (source) => ADAPTERS[source] || null;
const isSource = (source) => Object.prototype.hasOwnProperty.call(ADAPTERS, source);

const kindOf = (source) => (SOURCE_META[source] ? SOURCE_META[source].kind : 'board');
const isSearchSource = (source) => kindOf(source) === 'search';
/** Whether a vanished posting on this source may be marked closed. */
const closesPostings = (source) => !!(SOURCE_META[source] && SOURCE_META[source].closes);

const BOARD_SOURCES = SOURCES.filter(s => kindOf(s) === 'board');
const SEARCH_SOURCES = SOURCES.filter(s => kindOf(s) === 'search');

/**
 * Identity for a posting.
 *
 * Company boards include the token: Greenhouse ids are global ints but
 * Lever/Ashby are UUIDs with no cross-board guarantee, and a role listed on two
 * boards you track is legitimately two rows.
 *
 * Searches deliberately DO NOT include the token, so the same Muse job found by
 * three different saved searches is ONE row. Which searches surfaced it is
 * recorded in JobPosting.queries instead — the same approach Lead.queries takes
 * for harvester search terms.
 */
const sourceKeyFor = (source, boardToken, sourceId) =>
  isSearchSource(source) ? `${source}:${sourceId}` : `${source}:${boardToken}:${sourceId}`;

/**
 * Fetch one source. Validates the token first so a malformed slug can never
 * reach a URL template — this makes outbound requests on the caller's behalf.
 * Never throws: an adapter bug becomes kind 'error', which closes nothing.
 */
async function fetchBoard(source, token, opts = {}) {
  const R = require('./result');
  const adapter = getAdapter(source);
  if (!adapter) return R.error(`Unknown source '${source}'`);

  const clean = normalise.normaliseToken(token);
  if (!normalise.isValidToken(clean)) return R.error(`Invalid token '${token}'`);

  try {
    return await adapter.fetchBoard(clean, opts);
  } catch (err) {
    // Adapters promise not to throw. If one does it is a bug, and the safe
    // reading of a bug is "we could not find out" — never "nothing is listed".
    return R.error(`Adapter crashed: ${err.message}`);
  }
}

module.exports = {
  ADAPTERS, SOURCES, SOURCE_META, BOARD_SOURCES, SEARCH_SOURCES,
  getAdapter, isSource, kindOf, isSearchSource, closesPostings, sourceKeyFor,
  fetchBoard, ...normalise,
};
