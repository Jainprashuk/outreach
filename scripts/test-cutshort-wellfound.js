// Offline checks for the Cutshort and Wellfound drivers: registry wiring, and
// that their meta.js reads the row shapes recorded live on 2026-10-28
// (worker/platforms/<id>/RECON.md). No browser, no database.
//   node scripts/test-cutshort-wellfound.js
const assert = require('assert');
const P = require('../lib/platforms');
const { toJob, jobsInJson } = require('../worker/platforms/shared/feed');
const cs = require('../worker/platforms/cutshort/meta');
const wf = require('../worker/platforms/wellfound/meta');

let pass = 0;
const ok = (name, cond, extra) => { assert(cond, `${name}${extra ? ' — ' + extra : ''}`); pass++; console.log('  ok', name); };

console.log('registry');
for (const id of ['cutshort', 'wellfound']) {
  ok(`${id} is a platform`, P.isPlatform(id) && P.SITE_IDS.includes(id));
  ok(`${id} real apply is switched on by the registry, only when on`, P.applyModeOf({ applyMode: 'on' }, id) === 'on' && P.applyModeOf({ applyMode: 'dry-run' }, id) === 'dry-run' && P.applyModeOf({}, id) === 'off');
  ok(`${id} has no search source`, !P.PLATFORMS[id].sources.searches && !!P.PLATFORMS[id].sources.recommended);
  ok(`${id} scopes its own rows`, JSON.stringify(P.platformQuery(id)) === JSON.stringify({ platform: id }));
  ok(`${id} real apply is blocked`, P.kindBlocked('apply', { applyMode: 'off' }, id) !== null);
  const site = P.siteOf({}, id);
  ok(`${id} settings live under platforms.${id}`, site && typeof site === 'object');
  const m = id === 'cutshort' ? cs : wf;
  ok(`${id} meta matches the registry`, m.id === id && m.capabilities === P.capabilitiesOf(id) && !m.searchUrl);
}

console.log('cutshort');
const csRow = {
  _id: '6ab4d171d5db5827b92a0c34', headline: 'Full Stack Developer', company: 'Byldd',
  companyid: { name: 'Byldd' }, public_url: 'https://cutshort.io/job/Full-Stack-Developer-Byldd-CraXemtJ',
  expRange: { min: 2, max: 4 }, salaryRange: { minVanity: 500000, maxVanity: 700000 },
  allSkills: ['Javascript', 'TypeScript'], locations: [], remoteType: 'remote_only',
  comment: 'About Byldd: a startup studio', creationDate: '2026-09-24T07:29:53.445Z',
  lastUpdateDate: new Date().toISOString(), createdBy: { name: 'Ayesha Siddiqa' },
};
const csOpts = { fields: cs.fields, baseUrl: cs.origin, urlFor: cs.jobUrl, prepare: cs.prepare };
const csJob = toJob(csRow, csOpts);
ok('id, title, company', csJob.sourceId === csRow._id && csJob.title === 'Full Stack Developer' && csJob.company === 'Byldd');
ok('remote job is located "Remote"', csJob.location === 'Remote');
ok('experience band', csJob.experienceMin === 2 && csJob.experienceMax === 4);
ok('salary in rupees reads as lakhs', csJob.salaryText === '5-7 Lacs PA', csJob.salaryText);
ok('url, tags, description', csJob.url === csRow.public_url && csJob.tags.join() === 'Javascript,TypeScript' && /startup studio/.test(csJob.description));
ok('posted today', csJob.postedText === 'Today');
ok('poster is kept as a recruiter name', (csJob.recruiters || [])[0] && csJob.recruiters[0].name === 'Ayesha Siddiqa');
const csList = jobsInJson({ results: [csRow, { ...csRow, _id: 'b', locations: ['Pune'] }], total_count: 2 }, csOpts);
ok('a /findjobs/q page yields every job', csList.length === 2 && csList[1].location === 'Pune');
ok('feedTest takes the list, not other calls', cs.feedTest('https://cutshort.io/findjobs/q?page=2&matchesfor=x') && !cs.feedTest('https://cutshort.io/api/auth/user'));

console.log('wellfound');
const startup = (extra = {}) => ({
  __typename: 'StartupSearchResult', id: '238874', name: 'IDfy', highConcept: 'AI identity tech',
  highlightedJobListings: [
    { id: '4890545', slug: 'software-engineer', title: 'Software Engineer', locationNames: ['Mumbai'], remote: false,
      compensation: '₹8L – ₹13L • No equity', liveStartAt: Math.floor(Date.now() / 1000) - 86400 * 3, primaryRoleTitle: 'Software Engineer', currentUserApplied: false },
    { id: '4890546', slug: 'remote-dev', title: 'Remote Dev', locationNames: [], remote: true, compensation: null,
      liveStartAt: Math.floor(Date.now() / 1000), currentUserApplied: false },
    { id: '4890547', slug: 'done', title: 'Already Applied', locationNames: [], currentUserApplied: true },
  ], ...extra,
});
const body = { data: { talent: { jobSearchResults: { hasNextPage: true, startups: { edges: [
  { node: { __typename: 'PromotedResult', id: 'p1', promotedStartup: startup({ name: 'Parsewave' }) } },
  { node: startup() },
] } } } } };
const wfOpts = { fields: wf.fields, baseUrl: wf.origin, urlFor: wf.jobUrl, rawJobs: wf.jobsFromBody };
const raw = wf.jobsFromBody(body);
ok('jobs you applied to are left out', !raw.some(r => r.id === '4890547') && raw.length === 4);
const w = toJob(raw[0], wfOpts);
ok('company comes from the startup', w.company === 'Parsewave' && w.title === 'Software Engineer');
ok('url is /jobs/<id>-<slug>', w.url === 'https://wellfound.com/jobs/4890545-software-engineer', w.url);
ok('salary text and location', w.salaryText === '₹8L – ₹13L • No equity' && w.location === 'Mumbai');
ok('posted from liveStartAt seconds', w.postedText === '3 days ago', w.postedText);
ok('remote job is located "Remote"', toJob(raw[1], wfOpts).location === 'Remote');
const req = (op) => ({ postData: () => JSON.stringify({ operationName: op, variables: {} }) });
ok('feedTest takes only JobSearchResultsX', wf.feedTest('https://wellfound.com/graphql', req('JobSearchResultsX'))
  && !wf.feedTest('https://wellfound.com/graphql', req('JobSearchPage')) && !wf.feedTest('https://wellfound.com/jobs', req('JobSearchResultsX')));
const apps = wf.applications.rowsFrom({ data: { talent: { ongoingJobApplications: { edges: [
  { node: { jobListing: { id: '4293714', title: 'Full Stack' }, status: 'REJECTED', createdAt: 1781188917 } },
  { node: { jobListing: null, status: 'X' } },
] } } } });
ok('applied rows: job id, status, date', apps.length === 1 && apps[0].jobId === '4293714' && apps[0].statuses[0] === 'REJECTED' && /^2026/.test(apps[0].at), JSON.stringify(apps));
ok('archived rows are read too', wf.applications.rowsFrom({ data: { talent: { archivedJobApplications: { edges: [
  { node: { jobListing: { id: '1' }, status: 'EXPIRED', createdAt: 1781188917 } }] } } } }).length === 1);
ok('other GraphQL answers read as no rows', wf.applications.rowsFrom({ data: { talent: {} } }).length === 0);

console.log('apply flows');
const ca = cs.applyFlow, wa = wf.applyFlow;
ok('cutshort applies from the in-app view of the job', ca.listingUrl({ sourceId: 'abc' }) === 'https://cutshort.io/profile/all-jobs?jobid=abc');
ok('cutshort counts only /sendreply/jobsignal, for the job asked', ca.applyRequest('https://cutshort.io/sendreply/jobsignal', 'POST')
  && !ca.applyRequest('https://cutshort.io/follow/company', 'POST') && !ca.applyRequest('https://cutshort.io/sendreply/jobsignal', 'GET')
  && ca.jobIdOf('', { signalid: 'abc' }) === 'abc' && ca.jobIdOf('', {}) === null);
ok('cutshort: an existing application means already applied', !!ca.preCheck([{ _id: '1' }]) && ca.preCheck([]) === null);
ok('cutshort replies by tab', (() => {
  const row = { jobSignal: { _id: 'j1' }, lastApplicationActivityOn: '2026-10-28T16:31:40.588Z' };
  const u = (t) => `https://cutshort.io/conversations-v2/candidate?page=1&user_role=candidate&context=x&convo_status=${t}`;
  const r = (t) => cs.applications.rowsFrom({ results: [row, { jobSignal: null }] }, u(t));
  return r('awaiting').length === 1 && r('awaiting')[0].jobId === 'j1' && r('awaiting')[0].statuses.length === 0
    && r('shortlisted')[0].statuses[0] === 'Shortlisted' && r('nottakenforward')[0].statuses[0] === 'Not shortlisted'
    && cs.applications.test(u('awaiting')) && !cs.applications.test('https://cutshort.io/conversations-v2/candidate?page=1&user_role=candidate');
})());
const post = (op, input) => ({ operationName: op, variables: { input } });
ok('wellfound counts only the CreateJobApplication mutation', wa.applyRequest('https://wellfound.com/graphql', 'POST', post('CreateJobApplication', { jobListingId: '9' }))
  && !wa.applyRequest('https://wellfound.com/graphql', 'POST', post('CreateInteraction', { jobListingId: '9' }))
  && wa.jobIdOf('', post('CreateJobApplication', { jobListingId: '9' })) === '9');
ok('wellfound: already applied is read before clicking', !!wa.preCheck({ data: { jobListing: { currentUserApplied: true } } })
  && wa.preCheck({ data: { jobListing: { currentUserApplied: false } } }) === null);
ok('wellfound: required questions come from JobApplicationModal', wa.screening.mandatoryFrom({ data: { jobListing: { questions: [
  { question: 'Why us?', required: true }, { question: 'Optional?', required: false }] } } }).join() === 'Why us?'
  && wa.screening.questionnaireTest('https://wellfound.com/graphql', req('JobApplicationModal')) && !wa.screening.questionnaireTest('https://wellfound.com/graphql', req('JobSearchResultsX')));

ok('cutshort writes its message into the dialog box before Send', ca.confirm.message && ca.confirm.message.selector === 'textarea[name="message"]');
ok('wellfound writes open questions with AI', wa.screening.aiNote === true);
ok('the note endpoint is a worker path on every platform', require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8').includes("'ai-note'"));

ok('wellfound skips a form locked behind a location question', wa.screening.blocked && wa.screening.blocked[0].selector.includes('qualification.location.action') && /locations on your profile/.test(wa.screening.blocked[0].reason));

console.log(`\n${pass} checks passed`);
