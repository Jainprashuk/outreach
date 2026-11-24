// Proves inbox flood detection (lib/jobFloods.js): one company posting the same
// roles city by city gets grouped, an ordinary company does not. Run with:
//   node scripts/test-job-floods.js
//
// No database, no network — findFloods is pure.

const { findFloods, blockTermsFor, companyKey, citiesOf, FLOOD_MIN_JOBS } = require('../lib/jobFloods');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};

let n = 0;
const job = (company, title, location, platform = 'naukri') => ({ _id: `id${++n}`, company, title, location, platform });

console.log('\ncompanyKey / citiesOf');
ok('legal suffixes fold together',
  new Set(['Benovymed Healthcare Private Limited', 'Benovymed Healthcare Private Ltd', 'Benovymed Healthcare'].map(companyKey)).size === 1);
ok('hybrid prefix and brackets are dropped', citiesOf('Hybrid - Gurugram').join() === 'gurugram' && citiesOf('Noida(Sector 2)').join() === 'noida');
ok('several cities split', citiesOf('Gurugram, Panchkula').length === 2);

console.log('\nfindFloods');
const spam = ['Noida', 'Gurugram', 'Chennai', 'Pune'].flatMap((city, i) => [
  job(i % 2 ? 'Benovymed Healthcare Private Ltd' : 'Benovymed Healthcare Private Limited', 'Chief Technology Officer/Vice President - Full Stack Development', city),
  job('Benovymed Healthcare', 'Technical Lead/Senior Full Stack Developer - Python/AngularJS', city),
]);
const normal = [job('V2soft', 'Python Fullstack Developer', 'Bengaluru'), job('Rankwatch', 'Full-Stack Developer', 'Remote')];
const [f] = findFloods([...spam, ...normal]);
ok('the flooding company is found once', findFloods([...spam, ...normal]).length === 1 && f.count === 8, JSON.stringify(f));
ok('it counts roles and cities', f.roles === 2 && f.cities === 4, `${f.roles} roles, ${f.cities} cities`);
ok('it names the role repeated across cities', f.repeatedRole && f.repeatedRole.cities === 4);
ok('it returns the ids to hide', f.ids.length === 8);

const fewCities = ['Noida', 'Pune', 'Chennai'].map(c => job('Shashwath Solution', 'Full stack developer', c));
ok('one role in 3 cities is a flood even with few jobs', findFloods(fewCities).length === 1);

const varied = Array.from({ length: FLOOD_MIN_JOBS - 1 }, (_, i) => job('Coforge', `Role ${i}`, 'Bengaluru'));
ok(`fewer than ${FLOOD_MIN_JOBS} distinct roles in one city is not a flood`, findFloods(varied).length === 0);

ok('one listing naming 3 cities is not a flood', findFloods([job('Infosys', 'Generative AI', 'Pune, Noida, Bengaluru')]).length === 0);
ok('the same listing reposted in one city is not a flood', findFloods(['Pune', 'Pune', 'Pune'].map(c => job('Acme', 'Frontend Developer', c))).length === 0);

ok('a lower job threshold catches a smaller flood', findFloods(varied, { minJobs: FLOOD_MIN_JOBS - 1 }).length === 1);
ok('a higher city threshold lets 3 cities through', findFloods(fewCities, { minCities: 4 }).length === 0);

ok('an ignored company is never grouped', findFloods(spam, { ignore: [companyKey('Benovymed Healthcare')] }).length === 0);

console.log('\nblockTermsFor');
const terms = blockTermsFor(['Benovymed Healthcare Private Limited', 'Benovymed Healthcare', 'Benovymed Healthcare Private Ltd']);
ok('the shortest spelling covers the others', terms.length === 1 && terms[0] === 'benovymed healthcare', terms.join(' | '));
ok('unrelated spellings are each kept', blockTermsFor(['Acme Corp', 'ACME Technologies']).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
