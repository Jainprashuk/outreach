// Try the extra format sources (lib/discovery/webFormat.js) on real companies, without
// touching the database. Spends 2 Tavily credits per domain (none for Gravatar).
//
//   TAVILY_KEY=tvly-... node scripts/web-format-probe.js razorpay.com:Razorpay "zerodha.com:Zerodha" ["Name Surname" ...]
//
// Names after the domains are checked on Gravatar against every domain.

const { postJson } = require('../lib/http');
const wf = require('../lib/discovery/webFormat');

async function search(key, query) {
  const res = await postJson('https://api.tavily.com/search', {
    timeoutMs: 15_000,
    headers: { authorization: `Bearer ${key}` },
    body: { query, search_depth: 'basic', max_results: 20 },
  });
  if (!res.ok) throw new Error(`Tavily: ${res.error}`);
  return (res.data.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: r.content || '' }));
}

(async () => {
  const key = process.env.TAVILY_KEY;
  const args = process.argv.slice(2);
  const companies = args.filter(a => /^[a-z0-9.-]+\.[a-z]+(:.*)?$/i.test(a)).map(a => { const [d, n] = a.split(':'); return { domain: d.toLowerCase(), name: n || d.split('.')[0] }; });
  const names = args.filter(a => !companies.some(c => a.toLowerCase().startsWith(c.domain)));
  if (!companies.length) { console.log('Usage: TAVILY_KEY=... node scripts/web-format-probe.js domain.com:Name ["Person Name" ...]'); process.exit(1); }

  for (const { domain, name } of companies) {
    console.log(`\n${name} (${domain})`);
    if (names.length) {
      const g = await wf.gravatarHits(names, domain);
      console.log(`  gravatar: ${g.checked} checked, hits: ${g.hits.map(h => h.email).join(', ') || 'none'}`);
    }
    if (!key) { console.log('  web: skipped (no TAVILY_KEY)'); continue; }
    const q = wf.webQueries(name, domain);
    const [addr, dir] = await Promise.all([search(key, q.addresses), search(key, q.directory)]);
    const pairs = wf.webAddresses(addr, domain, names);
    console.log(`  web addresses (${addr.length} results): ${pairs.map(p => `${p.name} <${p.email}>`).join(', ') || 'none'}`);
    const d = wf.directoryFormats(dir, domain, name);
    console.log(`  format sites (${dir.length} results): ${d.map(x => `${x.site}=${x.pattern}${x.share ? ` ${x.share}%` : ''}`).join(', ') || 'none'}`);
    if (process.env.VERBOSE) for (const r of dir) console.log(`    · ${r.url}\n      ${r.title} — ${r.snippet.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
})().catch(err => { console.error(err.message); process.exit(1); });
