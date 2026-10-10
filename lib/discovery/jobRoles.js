// Who to look for at a company, given the job you applied to there.
//
// Recruiters are always worth finding — they own the opening whatever it is. Then
// the person the role reports to, picked by keywords in the job title. Pure, no I/O;
// the Discover search takes at most 5 roles (cleanRoles in routes/prospects.js).

const RECRUITERS = ['recruiter', 'talent acquisition', 'hr'];

// First match wins, so the more specific families come before the broad ones
// ("data engineer" is a data role before it is an engineering one).
const FAMILIES = [
  { name: 'data', re: /\b(data|machine learning|ml|ai|analytics|analyst|scientist)\b/, roles: ['head of data', 'data engineering manager'] },
  { name: 'infra', re: /\b(devops|sre|site reliability|cloud|platform|infrastructure)\b/, roles: ['engineering manager', 'head of infrastructure'] },
  { name: 'qa', re: /\b(qa|quality|test|sdet|automation)\b/, roles: ['qa manager', 'engineering manager'] },
  { name: 'product', re: /\b(product manager|product owner|apm|pm)\b/, roles: ['head of product', 'product director'] },
  { name: 'design', re: /\b(design|designer|ux|ui)\b/, roles: ['design lead', 'head of design'] },
  { name: 'sales', re: /\b(sales|business development|bdr|sdr|account executive)\b/, roles: ['sales head', 'vp sales'] },
  { name: 'marketing', re: /\b(marketing|growth|seo|content)\b/, roles: ['marketing head', 'head of growth'] },
  { name: 'engineering', re: /\b(engineer|developer|sde|software|programmer|frontend|backend|full ?stack|react|node|java|python|golang|android|ios|mobile|tech lead)\b/, roles: ['engineering manager', 'cto'] },
];

const familyFor = (title) => {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
  return FAMILIES.find(f => f.re.test(t)) || null;
};

/**
 * @param {string} title  the job's title, e.g. "Senior Backend Engineer (Node.js)"
 * @returns {string[]}    up to 5 roles, recruiters first
 */
function rolesForJob(title) {
  const family = familyFor(title);
  return [...RECRUITERS, ...(family ? family.roles : [])].slice(0, 5);
}

/** 'engineering', 'data', … or null — which kind of job a title is. */
const familyOf = (title) => (familyFor(title) || {}).name || null;

module.exports = { rolesForJob, familyOf, RECRUITERS };
