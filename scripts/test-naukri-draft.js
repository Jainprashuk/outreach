#!/usr/bin/env node
/**
 * Live check of AI answer drafts (lib/naukriDraft.js) against the real
 * providers (Groq / Cerebras), using a MADE-UP resume — no personal data is
 * sent. Writes nothing to any database (calls are logged only when a DB is
 * connected, and this script connects none).
 *
 *   node scripts/test-naukri-draft.js
 *
 * Checks the prompt does what it promises: answers grounded in a real resume
 * line, `unknown` when the resume does not say, and choice answers always one
 * of the options. Pure parsing rules are covered in test-naukri-answers.js.
 */
require('dotenv').config();
const { draftAnswer } = require('../lib/naukriDraft');

const resumeText = `Asha Verma — Backend Engineer
Experience
Senior Backend Engineer, Acme Payments, Bengaluru (Jan 2021 – Present)
- Built payment reconciliation services in Node.js and MongoDB handling 2M transactions a day
- Led migration of 14 services to AWS ECS and Docker
Backend Developer, Brightline Labs, Pune (Jul 2018 – Dec 2020)
- REST APIs in Express and PostgreSQL
Education: B.Tech Computer Science, NIT Trichy, 2018
Skills: Node.js, Express, MongoDB, PostgreSQL, AWS, Docker, Kafka`;
const profile = { noticePeriodDays: 30, currentLocation: 'Bengaluru', expectedCtcLpa: 28 };

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const show = (d) => `${d.status} "${d.answer}" ← "${d.quote}"${d.note ? ` (${d.note})` : ''}`;

(async () => {
  const ask = (q, options = []) => draftAnswer(q, { resumeText, profile, options });

  console.log('\ngrounded answers');
  let d = await ask('Do you have experience with MongoDB?', ['Yes', 'No']);
  console.log('    ' + show(d));
  ok('choice from the resume → Yes', d.status === 'ready' && d.answer === 'Yes');

  d = await ask('What is your highest qualification?');
  console.log('    ' + show(d));
  ok('free text from the resume', d.status === 'ready' && /b\.?tech/i.test(d.answer));

  d = await ask('What is your notice period in days?');
  console.log('    ' + show(d));
  ok('from the profile', d.status === 'ready' && /30/.test(d.answer));

  console.log('\nnot in the resume → unknown, never a guess');
  d = await ask('Do you have experience with SAP ABAP?', ['Yes', 'No']);
  console.log('    ' + show(d));
  ok('absent skill is not answered Yes', d.answer !== 'Yes');

  d = await ask('What is your current CTC in LPA?');
  console.log('    ' + show(d));
  ok('current CTC (not given anywhere) is unknown', d.status !== 'ready', show(d));

  console.log('\noptions are respected');
  d = await ask('How many years of experience do you have with Docker?', ['0-1 years', '2-3 years', '4+ years']);
  console.log('    ' + show(d));
  ok('choice answer is one of the options, or unknown', d.status !== 'ready' || ['0-1 years', '2-3 years', '4+ years'].includes(d.answer));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
