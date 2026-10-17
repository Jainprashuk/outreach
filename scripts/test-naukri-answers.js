// Proves the Naukri answer bank (lib/naukriAnswers.js): rule matching, the
// option picker the worker clicks with, the starter rules, and the AI-draft
// checks in lib/naukriDraft.js that sit on top of them.
// Run with:  node scripts/test-naukri-answers.js
//
// No database, no network, no browser — every function here is pure.

const { resolveAnswer, pickOption, matchable, STARTER_RULES } = require('../lib/naukriAnswers');
const { parseDraft, quoteIsReal, ruleLines } = require('../lib/naukriDraft');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const profile = {
  noticePeriodDays: 30, currentCtcLpa: 12, expectedCtcLpa: 18, totalExperienceMonths: 50,
  currentLocation: 'Bengaluru', willingToRelocate: true, highestQualification: 'B.Tech',
  currentCompany: 'Acme', currentDesignation: 'Backend Engineer', skills: ['node.js', 'react'],
};
const bank = (answers) => ({ answers, profile });

console.log('\nmatchable');
eq('punctuation and case go', matchable('Current CTC (in LPA)?'), 'current ctc in lpa');
eq('skill punctuation stays', matchable('Experience in C++, C# and Node.js?'), 'experience in c++ c# and node.js');

console.log('\nresolveAnswer');
const rules = [{ pattern: 'current ctc|current salary', answer: '{{currentCtcLpa}}' }];
eq('alternative 1 matches through punctuation', resolveAnswer('What is your Current CTC (LPA)?', bank(rules)).answer, '12');
eq('alternative 2 matches', resolveAnswer('Current salary?', bank(rules)).answer, '12');
ok('unrelated question does not match', !resolveAnswer('Expected CTC?', bank(rules)).matched);
eq('first rule wins', resolveAnswer('notice period?', bank([
  { pattern: 'notice', answer: 'A' }, { pattern: 'notice period', answer: 'B' },
])).answer, 'A');
ok('disabled rule is skipped', !resolveAnswer('notice period?', bank([{ pattern: 'notice', answer: 'A', enabled: false }])).matched);
eq('unfilled placeholder is not an answer', resolveAnswer('notice period', { answers: [{ pattern: 'notice', answer: '{{noticePeriodDays}}' }], profile: {} }).reason, 'unresolved-placeholders');
eq('old single-pattern rules still work', resolveAnswer('Are you willing to relocate to Pune?', bank([{ pattern: 'willing to relocate', answer: '{{willingToRelocate}}' }])).answer, 'Yes');

console.log('\npickOption');
eq('exact beats substring: "No" is not "Not applicable"', pickOption('No', ['Yes', 'Not applicable', 'No']), 'No');
eq('exact ignores case and punctuation', pickOption('yes', ['Yes.', 'No.']), 'Yes.');
eq('number picks its range, not "13"', pickOption('3', ['0-2 years', '3-5 years', '13 years']), '3-5 years');
eq('number in "N+"', pickOption('7', ['Less than 5', '5+']), '5+');
eq('number in "less than"', pickOption('2', ['Less than 3 years', '3 to 6 years']), 'Less than 3 years');
eq('"to" ranges', pickOption('4', ['1 to 3', '4 to 6']), '4 to 6');
eq('overlapping ranges are ambiguous → null', pickOption('2', ['1 to 3', '2-4']), null);
eq('a lone number in a label counts as that number', pickOption('3', ['3 months', 'Immediate']), '3 months');
eq('number with no fitting range → null', pickOption('30', ['Immediate', '15 days']), null);
eq('whole words', pickOption('immediate', ['Immediate joiner', 'Serving notice']), 'Immediate joiner');
eq('two whole-word hits → null', pickOption('yes', ['Yes, remote', 'Yes, onsite']), null);
eq('no options → null', pickOption('Yes', []), null);

console.log('\nSTARTER_RULES');
const starter = { answers: STARTER_RULES, profile };
eq('notice period', resolveAnswer('What is your notice period (in days)?', starter).answer, '30');
eq('current ctc', resolveAnswer('Current CTC?', starter).answer, '12');
eq('expected ctc', resolveAnswer('Expected CTC in LPA', starter).answer, '18');
eq('total experience in years', resolveAnswer('Total experience (years)?', starter).answer, '4');
ok('"years of experience in React" is NOT total experience', !resolveAnswer('How many years of experience do you have in React?', starter).matched);
eq('relocate', resolveAnswer('Are you open to relocation?', starter).answer, 'Yes');
ok('"are you comfortable" ships disabled', !resolveAnswer('Are you comfortable with night shifts?', starter).matched);

console.log('\nparseDraft');
const resumeText = 'Senior Engineer, Acme (2019 – 2024). Built payment systems in Node.js and React. B.Tech, IIT Delhi.';
const ctx = { resumeText, profile };
eq('a grounded answer is ready', parseDraft('{"answer":"Yes","source":"resume","quote":"Built payment systems in Node.js"}', ctx).status, 'ready');
eq('a made-up quote is rejected', parseDraft('{"answer":"Yes","source":"resume","quote":"5 years of SAP"}', ctx).status, 'unknown');
eq('null answer is unknown', parseDraft('{"answer":null}', ctx).status, 'unknown');
eq('choice answer snapped to the real option', parseDraft('{"answer":"yes","quote":"Node.js and React"}', { ...ctx, options: ['Yes', 'No'] }).answer, 'Yes');
eq('choice answer that is not an option → unknown', parseDraft('{"answer":"Maybe","quote":"Node.js"}', { ...ctx, options: ['Yes', 'No'] }).status, 'unknown');
eq('profile quote counts', parseDraft('{"answer":"30","source":"profile","quote":"noticePeriodDays: 30"}', ctx).status, 'ready');
eq('junk is null (retried)', parseDraft('I think the answer is yes', ctx), null);
eq('years answer quoting a dateless line → unknown',
  parseDraft('{"answer":"4","quote":"Built payment systems in Node.js"}', { ...ctx, question: 'How many years of experience in Node.js?' }).status, 'unknown');
eq('years answer quoting a dated line → ready',
  parseDraft('{"answer":"5","quote":"Senior Engineer, Acme (2019 – 2024)"}', { ...ctx, question: 'How many years of experience in Node.js?' }).status, 'ready');
console.log('\nearlier answers as context');
const given = [
  { pattern: 'how many years of react experience|years in react', answer: '4' },
  { pattern: 'expected ctc', answer: '{{expectedCtcLpa}}' },
  { pattern: 'off rule', answer: 'x', enabled: false },
  { pattern: 'unfilled', answer: '{{phone}}' },
];
eq('rule lines: first alternative, placeholders filled, disabled and unfilled left out',
  ruleLines(given, profile), '- Q: how many years of react experience A: 4\n- Q: expected ctc A: 18');
eq('a draft quoting an earlier answer is ready',
  parseDraft('{"answer":"4","source":"answer","quote":"how many years of react experience A: 4"}',
    { ...ctx, rules: given, question: 'Years of experience in React.js?' }).status, 'ready');
eq('…and is labelled as coming from an answer',
  parseDraft('{"answer":"4","source":"answer","quote":"how many years of react experience A: 4"}',
    { ...ctx, rules: given, question: 'Years of experience in React.js?' }).source, 'answer');
eq('a made-up earlier answer is rejected',
  parseDraft('{"answer":"7","source":"answer","quote":"how many years of angular experience A: 7"}',
    { ...ctx, rules: given, question: 'Years in Angular?' }).status, 'unknown');

ok('quoteIsReal is loose on spacing', quoteIsReal('built  payment systems', [resumeText]));
ok('quoteIsReal rejects tiny quotes', !quoteIsReal('a', [resumeText]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
