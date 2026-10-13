#!/usr/bin/env node
// How well does the hiring-post finder (lib/sources/webPosts.js) find real emails?
// Runs a few of its searches on your own Tavily key and prints what came back —
// nothing is written anywhere, no AI is called. Spends one credit per search.
//
//   TAVILY_KEY=tvly-... node scripts/web-posts-probe.js --role="React developer" [--place=india] [--n=3]
//
// Look at: results per search, how many snippets hold a full email, and whether the
// dates are recent (i.e. time_range:'week' is honoured).

const { tavilyPosts } = require('../lib/discovery/search');
const { buildPostQueries } = require('../lib/sources/webPosts');
const { extractEmails, isCompanyEmail } = require('../lib/sources/emails');
const { scoreItem, REJECT } = require('../lib/sources/sourceFit');

const arg = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

(async () => {
  const key = process.env.TAVILY_KEY;
  const role = arg('role');
  if (!key || !role) { console.log('Usage: TAVILY_KEY=... node scripts/web-posts-probe.js --role="React developer" [--place=india] [--n=3]'); process.exit(1); }
  const target = { roles: [role.toLowerCase()], locations: [arg('place', 'india'), 'remote'] };
  const queries = buildPostQueries(target, Number(arg('n', 3)), 0);

  let total = 0;
  let withEmail = 0;
  let kept = 0;
  for (const query of queries) {
    const res = await tavilyPosts(key, query);
    console.log(`\n■ ${query}`);
    if (!res.ok) { console.log(`  failed: ${res.status} ${res.error}`); continue; }
    total += res.results.length;
    for (const r of res.results) {
      const text = `${r.title}\n${r.snippet}`;
      const emails = extractEmails(text);
      if (!emails.length) continue;
      withEmail++;
      const fit = scoreItem({ text, emails }, target);
      if (fit.score !== REJECT) kept++;
      console.log(`  ${fit.score === REJECT ? '✗' : '✓'} ${emails.map(e => (isCompanyEmail(e) ? e : `${e} (free mail)`)).join(', ')}`);
      console.log(`    ${r.url}  ${r.publishedAt || 'no date'}  ${fit.reasons.join('; ')}`);
      console.log(`    "${r.snippet.replace(/\s+/g, ' ').slice(0, 160)}…"`);
    }
    console.log(`  ${res.results.length} results`);
  }
  console.log(`\n${queries.length} searches · ${total} results · ${withEmail} with an email · ${kept} would be kept (before AI reading)`);
})();
