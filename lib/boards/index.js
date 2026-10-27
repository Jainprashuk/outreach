// The three public company-board adapters (Greenhouse, Lever, Ashby), kept only
// for Discover's careers-page check (lib/discovery/enrich/careers.js): given a
// company that links a board from its website, list that board's open roles.
// The Jobs tab no longer syncs boards; see lib/platforms.js for job sources.

const greenhouse = require('./greenhouse');
const lever = require('./lever');
const ashby = require('./ashby');

const ADAPTERS = { greenhouse, lever, ashby };

const SOURCE_META = {
  greenhouse: { label: 'Greenhouse', boardUrl: (t) => `https://boards.greenhouse.io/${t}` },
  lever: { label: 'Lever', boardUrl: (t) => `https://jobs.lever.co/${t}` },
  ashby: { label: 'Ashby', boardUrl: (t) => `https://jobs.ashbyhq.com/${t}` },
};

const getAdapter = (source) => ADAPTERS[source] || null;

module.exports = { ADAPTERS, SOURCE_META, getAdapter };
