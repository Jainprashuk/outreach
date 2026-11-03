#!/usr/bin/env node
/**
 * Recruiter → LinkedIn lookup: name/company matching in findProfile, mode cleaning.
 * No database, no network: the search call and the allowance are stubbed.
 *   node scripts/test-recruiter-linkedin.js
 */
process.noDeprecation = true;
const path = require('path');
const resolve = (p) => require.resolve(path.join('..', p));

let reply = { ok: true, data: { results: [] } };
let calls = 0;
require.cache[resolve('lib/http')] = { id: resolve('lib/http'), filename: resolve('lib/http'), loaded: true,
  exports: { postJson: async () => { calls++; return reply; }, fetchJson: async () => { calls++; return reply; } } };
require.cache[resolve('lib/discovery/usage')] = { id: resolve('lib/discovery/usage'), filename: resolve('lib/discovery/usage'), loaded: true,
  exports: { take: async () => true, loadKeys: async () => ({}) } };
// recruiterLinkedin.js pulls in models and inngest; only its pure helper is used here.
require.cache[resolve('inngest')] = { id: resolve('inngest'), filename: resolve('inngest'), loaded: true,
  exports: { inngest: { createFunction: () => ({}), send: async () => {} } } };

const { findProfile } = require('../lib/discovery/search');
const { cleanModes } = require('../lib/recruiterLinkedin');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + l + (c || !d ? '' : '  << ' + d)); };
const hit = (title, url, content = '') => ({ title, url, content });
const keys = { tavily: 'k' };
const run = (results, over = {}) => { reply = { ok: true, data: { results } }; return findProfile({ userId: 'u', keys, name: 'Priya Sharma', companyName: 'Acme Technologies Pvt Ltd', ...over }); };

(async () => {
  let r = await run([hit('Priya Sharma - Talent Lead - Acme | LinkedIn', 'https://in.linkedin.com/in/Priya-Sharma-123')]);
  ok('right person at the company is found', r.profile && r.profile.linkedin === 'https://www.linkedin.com/in/priya-sharma-123', JSON.stringify(r));

  r = await run([hit('Rahul Mehta - Engineer - Acme | LinkedIn', 'https://www.linkedin.com/in/rahul')]);
  ok('a different name is not accepted', r.profile === null);

  r = await run([hit('Priya Sharma - Designer - Globex | LinkedIn', 'https://www.linkedin.com/in/priya-g')]);
  ok('same name at another company is not accepted', r.profile === null);

  r = await run([hit('Priya Sharma - Ex-Acme | LinkedIn', 'https://www.linkedin.com/in/priya-ex')]);
  ok('a former employee is not accepted', r.profile === null);

  r = await run([hit('Priya Sharma - Acme', 'https://www.linkedin.com/company/acme')]);
  ok('a non-profile link is not accepted', r.profile === null);

  r = await run([hit('Priya Sharma - Acme | LinkedIn', 'https://www.linkedin.com/in/wrong'), hit('Priya Sharma - Talent Lead - Acme | LinkedIn', 'https://www.linkedin.com/in/priya-ok')]);
  ok('the first accepted result wins', r.profile && r.profile.linkedin.endsWith('/wrong'), JSON.stringify(r.profile));

  calls = 0;
  r = await findProfile({ userId: 'u', keys, name: 'X', companyName: 'Acme' });
  ok('a one-word name makes no search', r.profile === null && calls === 0);
  calls = 0;
  r = await findProfile({ userId: 'u', keys: {}, name: 'Priya Sharma', companyName: 'Acme' });
  ok('no key says so, no search', r.profile === null && /No search key/.test(r.error) && calls === 0);

  reply = { ok: false, status: 429, error: 'limit' };
  r = await findProfile({ userId: 'u', keys, name: 'Priya Sharma', companyName: 'Acme' });
  ok('a failed search is an error, not "not found"', r.profile === null && !!r.error, JSON.stringify(r));

  ok('modes: manual is always on', JSON.stringify(cleanModes([])) === '["manual"]');
  ok('modes: unknown values dropped, order kept', JSON.stringify(cleanModes(['all', 'bogus', 'approved'])) === '["all","approved","manual"]');
  ok('modes: junk input is safe', cleanModes('nope').length === 1 && cleanModes(null).includes('manual'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
