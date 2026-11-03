'use strict';

// Everything Wellfound-shaped, in one place. The driver (../shared/driver.js)
// reads only this file.
//
// STATUS: read side VERIFIED live 2026-10-28 (RECON.md): /jobs loads POST
// /graphql operation JobSearchResultsX (page 1, then 2, 3… as it is scrolled),
// results grouped by startup; applied jobs are OngoingApplicationList /
// ArchivedApplicationList. Login cookie _wellfound. Real apply mapped 2026-10-28
// (CreateJobApplication, see applyFlow). Wellfound
// sits behind Cloudflare: a challenge is a hard stop like on every site.

const { capabilitiesOf } = require('../../../lib/platforms');

const ORIGIN = 'https://wellfound.com';
const operationOf = (req) => {
  try { return String(req && req.postData() || ''); } catch (_) { return ''; }
};

module.exports = {
  id: 'wellfound',
  label: 'Wellfound',
  origin: ORIGIN,
  apiHosts: ['wellfound.com'],
  // Every Wellfound call is POST /graphql, so the operation decides (verified).
  feedTest: (url, req) => /\/graphql/.test(url) && /"operationName":"JobSearchResultsX"/.test(operationOf(req)),

  cookieUrls: [ORIGIN],
  // Rails session; unverified logged out.
  sessionCookies: ['_wellfound'],

  guardMarkers: {
    loginUrls: ['/login'],   // verify
    urls: [],
    text: [],
    loginText: [],
  },

  capabilities: capabilitiesOf('wellfound'),

  // /jobs shows your own saved search ("Software Engineer · Mumbai · Full Time"
  // when verified) as Recommended. Search URLs (/role/l/<role>/<city>) are
  // server-rendered and make no JobSearchResultsX call, so there is no
  // searchUrl: this is a feed-only platform. Change the search on Wellfound.
  feeds: [
    { url: `${ORIGIN}/jobs`, label: 'Your Wellfound search', origin: 'recommended' },
  ],
  recruiterFeed: false,
  // Who posted a job (verified live 2026-11-03): no JSON carries it — the job
  // page's own HTML has a "Hiring contact" heading followed by the name and the
  // title ("Founder"): a /u/<slug> link logged in, a plain span logged out. The
  // first two pieces of text after the heading are read, whatever wraps them.
  // Fetched inside your tab (the job's url, built by jobsFromBody). The server
  // reads the same page logged out (lib/recruiterLinkedin.js).
  recruiterDetail: {
    url: (id, job) => (job && job.url) || `${ORIGIN}/jobs/${encodeURIComponent(id)}`,
    // Runs IN the page on the fetched document: self-contained, no closures.
    fromDocument: (doc) => {
      const head = [...doc.querySelectorAll('body *')].find(e => e.children.length === 0 && /^hiring contact$/i.test((e.textContent || '').trim()));
      if (!head) return null;
      // Text nodes in document order after the heading (a parsed document has
      // no layout, so no innerText): the first is the name, the next the title.
      const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
      const texts = [];
      let past = false;
      for (let n = walker.nextNode(); n && texts.length < 2; n = walker.nextNode()) {
        if (!past) { if (head.contains(n)) past = true; continue; }
        if (head.contains(n)) continue;
        const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (t) texts.push(t);
      }
      const name = texts[0] || '';
      return name && name.length <= 100 ? { name, title: texts[1] && texts[1].length < 80 ? texts[1] : '' } : null;
    },
    parse: (body) => {
      const name = body && typeof body.name === 'string' ? body.name.trim() : '';
      return name ? { name, title: String(body.title || '').trim(), company: '' } : null;
    },
  },

  // data.talent.jobSearchResults.startups.edges[].node (a PromotedResult
  // wraps it in promotedStartup): the startup carries the company, and
  // highlightedJobListings the jobs { id, title, slug, locationNames, remote,
  // compensation "₹8L – ₹13L • No equity", liveStartAt (seconds),
  // currentUserApplied }. Jobs you already applied to are left out.
  jobsFromBody: (body) => {
    const edges = (((body || {}).data || {}).talent || {}).jobSearchResults;
    const list = (edges && edges.startups && edges.startups.edges) || [];
    const out = [];
    for (const e of list) {
      const node = e && e.node;
      const s = node && (node.promotedStartup || node);
      if (!s) continue;
      for (const l of s.highlightedJobListings || []) {
        if (!l || l.currentUserApplied) continue;
        const place = [...(l.locationNames || [])];
        if (l.remote && !place.length) place.push('Remote');
        out.push({
          id: l.id,
          title: l.title,
          company: s.name,
          location: place,
          compensation: l.compensation,
          posted_at: l.liveStartAt,
          tags: [l.primaryRoleTitle].filter(Boolean),
          description: s.highConcept || '',
          url: `${ORIGIN}/jobs/${l.id}-${l.slug || 'job'}`,
        });
      }
    }
    return out;
  },
  jobUrl: (o, url) => url,

  // Applied jobs (verified): GET /jobs/applications → OngoingApplicationList,
  // the Archived tab → ArchivedApplicationList. A row's node: { jobListing:
  // { id, title }, startup: { name }, status "REJECTED" | "EXPIRED" | …,
  // createdAt (seconds) }. The job id is jobListing.id, the harvest's id.
  applications: {
    url: `${ORIGIN}/jobs/applications`,
    test: (url) => /\/graphql/.test(url),
    tabs: [/^\s*archived\b/i],
    rowsFrom: (body) => {
      const t = (((body || {}).data || {}).talent) || {};
      const conn = t.ongoingJobApplications || t.archivedJobApplications;
      return ((conn && conn.edges) || []).map((e) => {
        const n = e && e.node;
        const id = n && n.jobListing && n.jobListing.id;
        if (!id) return null;
        return {
          jobId: String(id),
          statuses: [n.status].filter(x => typeof x === 'string' && x),
          at: n.createdAt ? new Date(Number(n.createdAt) * 1000).toISOString() : null,
        };
      }).filter(Boolean);
    },
  },

  // Real apply (mapped 2026-10-28 with one real application). "Apply" on the
  // listing loads JobApplicationModal (the job's questions, each with
  // `required`) and opens a modal form ending in "Send application"
  // (data-test JobApplicationModal--SubmitButton); sending is the GraphQL
  // mutation CreateJobApplication { input: { jobListingId, customQuestionAnswers,
  // userNote, … } } → { data.jobListing.currentUserApplied: true }, and the
  // button turns "✓ Applied". JobApplicationApplyButton says beforehand whether
  // you already applied.
  applyFlow: {
    applyButtons: [/^apply$/i],
    externalButtons: [/apply on company (site|website)/i, /^apply (on|at) (the )?(company|employer)/i],
    alreadyText: [],
    applyRequest: (url, method, post) => method === 'POST' && /\/graphql/.test(url) && !!post && post.operationName === 'CreateJobApplication',
    jobIdOf: (url, post) => {
      const i = post && post.variables && post.variables.input;
      return i && i.jobListingId != null ? String(i.jobListingId) : null;
    },
    detailTest: (url, req) => /\/graphql/.test(url) && /"operationName":"JobApplicationApplyButton"/.test(operationOf(req)),
    preCheck: (body) => {
      const l = body && body.data && body.data.jobListing;
      return l && l.currentUserApplied ? 'Wellfound says you have already applied to this job' : null;
    },
    screening: {
      inline: true,
      // Open questions are written for the job (lib/applyNote.js), not left blank.
      aiNote: true,
      questionnaireTest: (url, req) => /\/graphql/.test(url) && /"operationName":"JobApplicationModal"/.test(operationOf(req)),
      mandatoryFrom: (body) => (((body && body.data && body.data.jobListing && body.data.jobListing.questions) || [])
        .filter(q => q && q.required).map(q => q.question)),
      questionBox: 'form:has([data-test="JobApplicationModal--SubmitButton"]) label.block',
      questionText: 'div.font-medium',
      input: 'textarea, input[type=text], input[type=number]',
      option: 'button.pill-option',
      choice: 'label:has(input[type=radio]), label:has(input[type=checkbox])',
      submit: '[data-test="JobApplicationModal--SubmitButton"]',
      maxSteps: 2,
      // Verified 2026-10-28 (Loopr AI, job 4897494): a job outside your profile's locations opens
      // the form with a location question first (relocate / currently in …); the answer box and
      // Send stay disabled until it is answered. Never answered for you: skipped.
      blocked: [{
        selector: '[data-test="RadioGroup-qualification.location.action"]',
        reason: "Wellfound says this job does not support the locations on your profile (it asks where you are or whether you would relocate). Nothing was sent — apply on Wellfound yourself if you want it, or update your location preferences there.",
      }],
    },
    redirects: [],
  },
};
