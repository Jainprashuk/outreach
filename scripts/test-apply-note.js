#!/usr/bin/env node
/**
 * Live check of application messages (lib/applyNote.js) against the real AI
 * providers, with a MADE-UP resume and made-up jobs — no personal data is sent.
 * Writes nothing. Dev database only, to look up which AI key to use.
 *   node scripts/test-apply-note.js
 * Pure checks (placeholders, invented numbers, boilerplate) are asserted offline first.
 */
require('dotenv').config();
const assert = require('assert');
const { writeNote, checkNote } = require('../lib/applyNote');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); } };

const resumeText = `Asha Verma — Full Stack Engineer
Experience
Software Engineer, Acme Payments, Bengaluru (Jan 2021 – Present)
- Built a React and Node.js merchant dashboard used by 3,000 merchants
- Cut API p95 latency from 900ms to 300ms by adding Redis caching to MongoDB queries
Developer, Brightline Labs, Pune (Jul 2018 – Dec 2020)
- REST APIs in Express and PostgreSQL; led a 3 person team on a booking product
Skills: React, TypeScript, Node.js, Express, MongoDB, PostgreSQL, Redis, AWS, Docker`;
const profile = { noticePeriodDays: 30, currentLocation: 'Bengaluru' };
const jobA = { title: 'Full Stack Developer', company: 'Byldd', location: 'Remote', tags: ['React', 'Node.js', 'MongoDB'],
  description: 'Byldd is a startup studio that helps founders launch and scale software companies. We work closely with founders to refine ideas, build scalable software products and acquire first customers. You will own features end to end across React and Node.js.' };
const jobB = { title: 'Backend Engineer', company: 'Marmeto', location: 'Bangalore', tags: ['Node.js', 'Integrations'],
  description: 'Marmeto builds Shopify storefronts and custom e-commerce integrations for D2C brands. The role owns third party integrations and automation services in Node.js, with a focus on reliability.' };

(async () => {
  console.log('offline checks');
  const sources = [resumeText, jobA.description];
  ok('a 70% claim that is not in the resume is rejected', /unsupported-number/.test(checkNote('Hi, at Acme I cut latency by 70% on the React and Node.js work that Byldd describes, and I would enjoy owning features end to end. Happy to share more.', { job: jobA, sources }) || ''));

  const mongoose = require('mongoose');
  if (process.env.NODE_ENV === 'prod') { console.error('Run against dev only'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI_DEV);

  console.log('\nmessages, one per job');
  const a = await writeNote({ job: jobA, resumeText, profile, kind: 'message' });
  console.log('    A:', a.text || `(none: ${a.reason})`);
  const b = await writeNote({ job: jobB, resumeText, profile, kind: 'message', recruiter: 'Ravi Kumar' });
  console.log('    B:', b.text || `(none: ${b.reason})`);
  ok('both written', !!a.text && !!b.text, `${a.reason} / ${b.reason}`);
  if (a.text && b.text) {
    ok('A names its company or role', /byldd|full.?stack/i.test(a.text));
    ok('B names its company or role', /marmeto|backend/i.test(b.text));
    ok('they are different messages', a.text !== b.text && !b.text.includes('Byldd'));
    ok('within the length', a.text.length <= 600 && b.text.length <= 600);
    ok('no invented numbers (re-checked)', checkNote(a.text, { job: jobA, sources: [resumeText, jobA.description] }) === null && checkNote(b.text, { job: jobB, sources: [resumeText, jobB.description] }) === null);
  }

  console.log('\nopen questions');
  const why = await writeNote({ job: jobA, resumeText, profile, kind: 'question', question: 'What interests you about working for this company?' });
  console.log('    why:', why.text || `(none: ${why.reason})`);
  ok('motivation question answered, specific to the company', !!why.text && /byldd|founder|startup|studio/i.test(why.text));
  const sal = await writeNote({ job: jobA, resumeText, profile, kind: 'question', question: 'What is your expected salary in USD?' });
  console.log('    salary:', sal.text || `(none: ${sal.reason})`);
  ok('a fact the resume does not state is declined, not invented', !sal.text || !/\$\s?\d|usd\s?\d/i.test(sal.text));

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
