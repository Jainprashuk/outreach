'use strict';

// Everything Cutshort-shaped, in one place. The driver (../shared/driver.js)
// reads only this file.
//
// STATUS: VERIFIED live 2026-10-28 (RECON.md): the matched job list loads GET
// /findjobs/q?page=N&matchesfor=<your signal id> (5 a page, loaded as the list
// is scrolled), login cookie cutshort_authentication; replies and real apply
// were mapped from one real application (see applications / applyFlow).

const { capabilitiesOf } = require('../../../lib/platforms');

const ORIGIN = 'https://cutshort.io';

module.exports = {
  id: 'cutshort',
  label: 'Cutshort',
  origin: ORIGIN,
  apiHosts: ['cutshort.io'],
  // The job list only (verified); other XHRs on the page are not job lists.
  feedTest: (url) => /\/findjobs\/q\?/.test(url),
  // The list is its own scrolling panel; the pointer has to be over it.
  scrollOverList: true,

  cookieUrls: [ORIGIN],
  sessionCookies: ['cutshort_authentication'],

  guardMarkers: {
    loginUrls: ['/login', '/signin'],   // verify
    urls: [],
    text: [],
    loginText: [],
  },

  capabilities: capabilitiesOf('cutshort'),

  // /profile/recommended-jobs opens the profile-matched list (verified): it
  // calls /findjobs/q?matchesfor=<signal id>, so the signal id never has to be
  // known here. The rest of Cutshort's job search is not URL-controlled (the
  // q/keywords parameters only reorder, skills needs internal ids), so there is
  // no searchUrl: this is a feed-only platform.
  feeds: [
    { url: `${ORIGIN}/profile/recommended-jobs`, label: 'Matched jobs', origin: 'recommended' },
  ],
  recruiterFeed: false,

  // A row (verified): { _id, headline, company, public_url, expRange{min,max},
  // salaryRange{minVanity,maxVanity} (rupees a year), allSkills[], locations[],
  // remoteType, comment (plain description), creationDate, lastUpdateDate,
  // createdBy{name} }. Remote jobs have no locations, so "Remote" is added.
  prepare: (o) => ({
    ...o,
    _location: (Array.isArray(o.locations) && o.locations.length)
      ? o.locations
      : (o.remoteType === 'remote_only' || o.remoteRole ? ['Remote'] : []),
    postedBy: o.createdBy && o.createdBy.name ? { name: o.createdBy.name } : null,
  }),
  fields: {
    id: ['_id'],
    title: ['headline'],
    company: ['company', 'companyid.name'],
    location: ['_location'],
    expMin: ['expRange.min'], expMax: ['expRange.max'],
    salMin: ['salaryRange.minVanity'], salMax: ['salaryRange.maxVanity'],
    tags: ['allSkills'],
    url: ['public_url', 'publicUrl'],
    description: ['comment'],
    // lastUpdateDate: Cutshort lists "recently active jobs", and creationDate
    // can be months old on a job that is still taking applications.
    posted: ['lastUpdateDate', 'creationDate'],
  },
  jobUrl: (o, url) => url || (o.short_id ? `${ORIGIN}/job/${o.short_id}` : ''),

  // Replies (verified 2026-10-28 after a real application): Messages →
  // GET /conversations-v2/candidate?page=1&user_role=candidate&context=<id>&convo_status=
  // awaiting (Pending) | shortlisted | nottakenforward (Closed), { results[] }, each
  // { jobSignal: { _id }, lastApplicationActivityOn, type: 'jobsignal', … }. The
  // default tab ("Interested in you", no convo_status) is recruiters writing
  // first, not your applications, and is skipped.
  applications: {
    url: `${ORIGIN}/profile/candidate-conversations?i=all&stage=awaiting`,
    test: (url) => /\/conversations-v2\/candidate\?/.test(url) && /convo_status=/.test(url),
    tabs: [/^\s*shortlisted\b/i, /^\s*closed\b/i],
    rowsFrom: (body, url = '') => {
      const tab = (/convo_status=([a-z_]+)/i.exec(url) || [])[1] || 'awaiting';
      const word = { shortlisted: 'Shortlisted', nottakenforward: 'Not shortlisted' }[tab] || '';
      return ((body && body.results) || []).map((r) => {
        const id = r && r.jobSignal && r.jobSignal._id;
        if (!id) return null;
        return { jobId: String(id), statuses: word ? [word] : [], at: r.lastApplicationActivityOn || null };
      }).filter(Boolean);
    },
  },

  // Real apply (mapped 2026-10-28 with one real application). The public page's
  // "Apply to this job" only opens the app view /profile/all-jobs?jobid=<id>,
  // whose "Apply now" opens a dialog ("You are applying for … To <recruiter> ·
  // message box · resume · Follow <company> · Send / Cancel"). Send is
  // POST /sendreply/jobsignal { signalid: <job id>, message, … } → { Response:
  // 'OK', message }, and the button becomes "View conversation". The dialog also
  // ticks "Follow <company>" (POST /follow/company), which is unticked here:
  // an application should not follow companies.
  applyFlow: {
    listingUrl: (job) => (job.sourceId ? `${ORIGIN}/profile/all-jobs?jobid=${job.sourceId}` : job.url),
    applyButtons: [/^apply now$/i],
    externalButtons: [/apply on company (site|website)/i],
    alreadyText: ['view conversation', 'you have applied', 'already applied'],
    // An applied job still shows "Apply now"; its dialog says "You already have an
    // active conversation on this job" instead of offering Send (verified).
    confirm: { dialog: '[role=dialog]', button: /^send$/i, untick: 'label:has-text("Follow")', message: { selector: 'textarea[name="message"]', maxChars: 600 }, already: /already have an active conversation/i },
    applyRequest: (url, method) => method === 'POST' && /\/sendreply\/jobsignal\b/.test(url),
    jobIdOf: (url, post) => (post && post.signalid ? String(post.signalid) : null),
    // The listing's own applications for this job; non-empty = already applied.
    detailTest: (url) => /\/api\/auth\/ats\/my-applications-for-job\//.test(url),
    preCheck: (body) => (Array.isArray(body) && body.length ? 'Cutshort says you have already applied to this job' : null),
  },
};
