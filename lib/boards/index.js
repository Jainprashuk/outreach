// Registry for the public, keyless ATS job boards. Adding a fourth source is a
// new file in this directory plus one line in ADAPTERS.

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');
const normalise = require('./normalise');

const ADAPTERS = { greenhouse, lever, ashby };
const SOURCES = Object.keys(ADAPTERS);

const getAdapter = (source) => ADAPTERS[source] || null;
const isSource = (source) => Object.prototype.hasOwnProperty.call(ADAPTERS, source);

const SOURCE_META = {
  greenhouse: {
    label: 'Greenhouse',
    boardUrl: (t) => `https://boards.greenhouse.io/${t}`,
    tokenHint: 'The slug in boards.greenhouse.io/<token>',
  },
  lever: {
    label: 'Lever',
    boardUrl: (t) => `https://jobs.lever.co/${t}`,
    tokenHint: 'The slug in jobs.lever.co/<token>',
  },
  ashby: {
    label: 'Ashby',
    boardUrl: (t) => `https://jobs.ashbyhq.com/${t}`,
    tokenHint: 'The slug in jobs.ashbyhq.com/<token>',
  },
};

/**
 * Fetch one board through its adapter. Validates the token first so a malformed
 * slug can never reach a URL template — this code makes outbound requests on
 * behalf of whatever the caller typed.
 *
 * Never throws: an adapter bug surfaces as kind 'error', which closes nothing.
 *
 * @param {string} source
 * @param {string} token
 * @param {{signal?: AbortSignal, deadline?: object, label?: string}} [opts]
 */
async function fetchBoard(source, token, opts = {}) {
  const adapter = getAdapter(source);
  if (!adapter) {
    return require('./result').error(`Unknown source '${source}'`);
  }
  const clean = normalise.normaliseToken(token);
  if (!normalise.isValidToken(clean)) {
    return require('./result').error(`Invalid board token '${token}'`);
  }
  try {
    return await adapter.fetchBoard(clean, opts);
  } catch (err) {
    // Adapters promise not to throw. If one does it is a bug, and the safe
    // reading of a bug is "we could not find out" — never "nothing is listed".
    return require('./result').error(`Adapter crashed: ${err.message}`);
  }
}

module.exports = {
  ADAPTERS, SOURCES, SOURCE_META, getAdapter, isSource, fetchBoard, ...normalise,
};
