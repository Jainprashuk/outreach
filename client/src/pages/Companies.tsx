// Companies: one page per company, joining every module — your contacts there by
// where they came from, LinkedIn posts, Naukri jobs, interviews, Discover's people
// and searches, the email format, and whether it's worth a people search.
// Read-only: actions link to the page that already does them.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import { SkeletonRows } from '../components/Skeleton';
import { ago } from '../components/prospects/SearchReport';
import { STATUS_LABELS, CATEGORY_LABELS } from '../lib/format';
import { companiesApi, companyApi, type CompanyDetail, type CompanyListRow } from '../lib/api';

const SOURCE_TITLE: Record<string, string> = {
  outreach: 'Direct (CSV / manual)', lead: 'From LinkedIn Leads', discover: 'From Discover', naukri: 'From Naukri → Find people',
};
const EXCLUDED_NOTE: Record<string, string> = {
  searched: 'Searched in the last 30 days', 'said-no': 'Someone there said no recently', blocked: 'On your blocklist',
  offer: 'You have an offer here', dismissed: 'You marked it not worth it',
};
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
const keyHref = (key: string) => `/companies/${encodeURIComponent(key)}`;

function CompanyList() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // ?q= — a company name linked from Contacts or Naukri.
  const [q, setQ] = useState(params.get('q') || '');
  const [debounced, setDebounced] = useState((params.get('q') || '').trim());
  const [sort, setSort] = useState('score');
  const [rows, setRows] = useState<CompanyListRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let alive = true;
    companiesApi({ q: debounced, sort })
      .then(r => { if (alive) { setRows(r.companies); setTotal(r.total); setError(''); } })
      .catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [debounced, sort]);

  return (
    <Layout title="Companies" subtitle="Every company you have anything on — contacts, LinkedIn posts, Naukri jobs — in one place.">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search a company or domain" style={{ width: 240 }} />
        <div className="seg-toggle">
          {([['score', 'Worth searching'], ['recent', 'Recent'], ['contacts', 'Most contacts']] as const).map(([k, label]) => (
            <button key={k} type="button" className={`btn btn-xs${sort === k ? ' active' : ''}`} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>{total} companies</span>
      </div>
      <div className="table-card">
        <table>
          <thead><tr><th>Company</th><th>Score</th><th>Contacts</th><th>Replied</th><th>Bounced</th><th>Hiring</th><th>Last activity</th></tr></thead>
          <tbody>
            {!rows && !error ? <SkeletonRows rows={8} cols={7} />
              : error ? <tr><td colSpan={7}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
              : rows!.length === 0 ? <tr><td colSpan={7}><div className="empty-state"><i className="ti ti-building" />No companies match</div></td></tr>
              : rows!.map(r => (
                <tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => navigate(keyHref(r.key))}>
                  <td>
                    <Link to={keyHref(r.key)} onClick={e => e.stopPropagation()} style={{ fontWeight: 500 }}>{r.company}</Link>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.domain || 'domain not known yet'}</div>
                  </td>
                  <td title={r.excluded ? EXCLUDED_NOTE[r.excluded] : undefined}>
                    {r.score == null ? <span style={{ color: 'var(--text3)' }}>—</span>
                      : <span className={`badge ${r.excluded ? 'badge-seen' : r.score >= 5 ? 'badge-approved' : 'badge-queued'}`}>{r.score}</span>}
                  </td>
                  <td>{r.contacts || <span style={{ color: 'var(--text3)' }}>0</span>}</td>
                  <td>{r.replied ? <>{r.replied} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({pct(r.replied, r.sent)})</span></> : <span style={{ color: 'var(--text3)' }}>0</span>}</td>
                  <td>{r.bounced || <span style={{ color: 'var(--text3)' }}>0</span>}</td>
                  <td style={{ fontSize: 12 }}>
                    {r.leads > 0 && <span className="badge badge-queued" style={{ marginRight: 4 }}><i className="ti ti-brand-linkedin" /> {r.leads}</span>}
                    {r.naukri > 0 && <span className="badge badge-pending"><i className="ti ti-briefcase-2" /> {r.naukri}</span>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{ago(r.lastAt)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

function Section({ title, icon, count, children }: { title: string; icon: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="s-card" style={{ marginBottom: 14 }}>
      <div className="s-body">
        <div style={{ fontWeight: 600, marginBottom: 10 }}>
          <i className={`ti ${icon}`} style={{ marginRight: 6, color: 'var(--text3)' }} />{title}
          {count != null && <span style={{ marginLeft: 6, color: 'var(--text3)', fontWeight: 400 }}>{count}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

function CompanyPage({ companyKey }: { companyKey: string }) {
  const [d, setD] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setD(null);
    companyApi(companyKey).then(setD).catch(err => setError(err.message));
  }, [companyKey]);

  if (error) return <Layout title="Company"><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></Layout>;
  if (!d) return <Layout title="Company"><div className="table-card"><table><tbody><SkeletonRows rows={6} cols={3} /></tbody></table></div></Layout>;

  const discoverHref = d.domain ? `/discover?domain=${encodeURIComponent(d.domain)}` : '/discover?view=worth';
  const sources = Object.entries(d.contacts);
  return (
    <Layout
      title={d.company}
      subtitle={d.domain || 'Email domain not known yet'}
      actions={<>
        <Link to="/companies" className="btn btn-sm"><i className="ti ti-arrow-left" /> All companies</Link>
        <Link to={discoverHref} className="btn btn-sm btn-primary"><i className="ti ti-compass" /> Open in Discover</Link>
      </>}
    >
      <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 14 }}>
        {([
          ['Contacts', d.totals.contacts],
          ['Emailed', d.totals.sent],
          ['Replied', `${d.totals.replied} (${pct(d.totals.replied, d.totals.sent)})`],
          ['Bounced', d.totals.bounced],
          ['Email format', d.format?.pattern ? `${d.format.pattern} · ${d.format.confidence}` : '—'],
        ] as const).map(([label, value]) => (
          <div key={label} className="s-card" style={{ margin: 0 }}>
            <div className="s-body">
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>{label}</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
            </div>
          </div>
        ))}
      </div>

      <Section title="Worth searching?" icon="ti-target">
        {!d.worth ? (
          <div style={{ fontSize: 13, color: 'var(--text2)' }}>No LinkedIn posts or Naukri jobs from this company in the last 30 days, so it isn't scored.</div>
        ) : (<>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            Score <strong>{d.worth.score}</strong>
            {d.worth.excluded && <span style={{ color: 'var(--text3)' }}> · not suggested: {EXCLUDED_NOTE[d.worth.excluded] || d.worth.excluded}</span>}
          </div>
          {d.worth.reasons.length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)' }}>No signals yet.</div>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
            {d.worth.reasons.map((r, i) => (
              <li key={i} style={{ padding: '2px 0', color: 'var(--text2)' }}>
                <span style={{ display: 'inline-block', width: 28, fontWeight: 600, color: r.points > 0 ? 'var(--green)' : 'var(--red)' }}>{sign(r.points)}</span>
                {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.text}</a> : r.text}
              </li>
            ))}
          </ul>
          {d.worth.notes.length > 0 && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>{d.worth.notes.join(' · ')}</div>}
        </>)}
      </Section>

      <Section title="Your contacts here" icon="ti-users" count={d.totals.contacts}>
        {sources.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text3)' }}>Nobody yet.</div> : sources.map(([src, s]) => s && (
          <div key={src} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
              <strong>{SOURCE_TITLE[src] || src}</strong> · {s.contacts} people · {s.sent} emailed · {s.replied} replied ({pct(s.replied, s.sent)}) · {s.bounced} bounced
            </div>
            <table style={{ fontSize: 12.5 }}>
              <tbody>
                {s.people.map(p => (
                  <tr key={p.id}>
                    <td>{p.name}{p.linkedin && <> <a href={p.linkedin} target="_blank" rel="noopener noreferrer" title="LinkedIn"><i className="ti ti-brand-linkedin" /></a></>}</td>
                    <td style={{ color: 'var(--text3)' }}>{p.email}</td>
                    <td style={{ color: 'var(--text2)' }}>{p.role}{p.jobTitle ? <span style={{ color: 'var(--text3)' }}> · for {p.jobTitle}</span> : null}</td>
                    <td>{STATUS_LABELS[p.status] || p.status}{p.replyCategory && <span style={{ color: 'var(--text3)' }}> · {CATEGORY_LABELS[p.replyCategory] || p.replyCategory}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Section>

      {d.naukriJobs.length > 0 && (
        <Section title="Naukri jobs" icon="ti-briefcase-2" count={d.naukriJobs.length}>
          <table style={{ fontSize: 12.5 }}>
            <tbody>
              {d.naukriJobs.slice(0, 30).map(j => (
                <tr key={j.id}>
                  <td>{j.url ? <a href={j.url} target="_blank" rel="noopener noreferrer">{j.title}</a> : j.title}</td>
                  <td style={{ color: 'var(--text3)' }}>{j.location}</td>
                  <td>{j.applyStatus !== 'none' ? j.applyStatus : j.approval}</td>
                  <td style={{ color: 'var(--text3)' }}>{ago(j.appliedAt || j.postedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {d.leads.length > 0 && (
        <Section title="LinkedIn posts" icon="ti-brand-linkedin" count={d.leads.length}>
          <table style={{ fontSize: 12.5 }}>
            <tbody>
              {d.leads.slice(0, 30).map(l => (
                <tr key={l.id}>
                  <td>{l.authorUrl ? <a href={l.authorUrl} target="_blank" rel="noopener noreferrer">{l.authorName || 'Someone'}</a> : (l.authorName || 'Someone')}</td>
                  <td style={{ color: 'var(--text3)' }}>{l.email || '—'}</td>
                  <td>{l.postUrl && <a href={l.postUrl} target="_blank" rel="noopener noreferrer">post</a>}</td>
                  <td style={{ color: 'var(--text3)' }}>fit {l.fitScore} · {ago(l.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {d.interviews.length > 0 && (
        <Section title="Interviews" icon="ti-user-check" count={d.interviews.length}>
          {d.interviews.map(i => (
            <div key={i.id} style={{ fontSize: 13, padding: '2px 0' }}>
              <Link to="/interviews">{i.name}</Link> · {i.role} · {i.status}{i.interviewAt ? ` · ${new Date(i.interviewAt).toLocaleDateString()}` : ''}
            </div>
          ))}
        </Section>
      )}

      <Section title="Discover" icon="ti-compass">
        <div style={{ fontSize: 13, color: 'var(--text2)' }}>
          {d.prospects.total} people found{Object.entries(d.prospects.byStatus).length > 0 && ` (${Object.entries(d.prospects.byStatus).map(([k, n]) => `${n} ${k}`).join(', ')})`}
          {' · '}{d.searches.length} {d.searches.length === 1 ? 'search' : 'searches'}
        </div>
        {d.searches.slice(0, 5).map(s => (
          <div key={s.id} style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
            {ago(s.at)} · {s.people} people{s.roles.length ? ` · ${s.roles.join(', ')}` : ''}{s.jobTitle ? ` · for "${s.jobTitle}"` : ''}
          </div>
        ))}
      </Section>

      {d.timeline.length > 0 && (
        <Section title="Timeline" icon="ti-timeline">
          {d.timeline.slice(0, 30).map((e, i) => (
            <div key={i} style={{ fontSize: 12.5, padding: '2px 0', color: 'var(--text2)' }}>
              <span style={{ display: 'inline-block', width: 90, color: 'var(--text3)' }}>{ago(e.at)}</span>{e.what}
            </div>
          ))}
        </Section>
      )}
    </Layout>
  );
}

export default function Companies() {
  const { key } = useParams();
  return key ? <CompanyPage companyKey={key} /> : <CompanyList />;
}
