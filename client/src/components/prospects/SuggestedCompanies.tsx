// Discover → Worth searching: the few companies, out of everything Leads and Naukri
// bring in, worth a people search — each with its score and the reasons for it.
// Nothing runs on its own: Run starts one search, Not worth it hides one company.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SkeletonRows } from '../Skeleton';
import ScoreBadge from '../ScoreBadge';
import { useToast } from '../../context/ToastContext';
import {
  dismissSuggestionApi, refreshSuggestionsApi, saveEnrichOffApi, suggestedCompaniesApi,
  type DiscoveryConfigView, type EnrichSource, type SuggestedCompany, type SuggestedPage,
} from '../../lib/api';
import { ago } from './SearchReport';

const SOURCE_LABEL: Record<EnrichSource, string> = {
  news: 'Funding / layoff news',
  hn: 'HN “Who is hiring”',
  careers: 'Careers page',
  github: 'GitHub activity',
  fit: 'AI fit check',
};
const KIND_ICON: Record<string, string> = {
  app: 'ti-circle-dot', news: 'ti-news', hn: 'ti-brand-ycombinator', careers: 'ti-briefcase', github: 'ti-brand-github', fit: 'ti-sparkles',
};
const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

export default function SuggestedCompanies({ onRun, busy, config, onConfig }: {
  onRun: (s: SuggestedCompany) => Promise<void>;
  busy: boolean;
  config: DiscoveryConfigView | null;
  onConfig: (c: DiscoveryConfigView) => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<SuggestedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSources, setShowSources] = useState(false);

  const load = () => {
    setLoading(true);
    return suggestedCompaniesApi()
      .then(r => { setData(r); setError(''); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const run = async (s: SuggestedCompany) => {
    setRunning(s.key);
    try { await onRun(s); } finally { setRunning(null); }
  };
  const dismiss = async (s: SuggestedCompany) => {
    try {
      await dismissSuggestionApi(s.key);
      setData(d => (d ? { ...d, suggestions: d.suggestions.filter(x => x.key !== s.key) } : d));
      toast(`${s.company} hidden from this list for 60 days — it stays in Hiring now`, 'success');
    } catch (err: any) { toast(err.message, 'error'); }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshSuggestionsApi();
      toast('Checking news, careers pages and more in the background — new points show up in a few minutes', 'info');
    } catch (err: any) { toast(err.message, 'error'); } finally { setRefreshing(false); }
  };
  const toggleSource = async (src: EnrichSource, on: boolean) => {
    const off = new Set(config?.enrichOff || []);
    if (on) off.delete(src); else off.add(src);
    try { onConfig(await saveEnrichOffApi([...off])); } catch (err: any) { toast(err.message, 'error'); }
  };

  const list = data?.suggestions || [];
  return (
    <>
      <div className="s-card" style={{ marginBottom: 14 }}>
        <div className="s-body">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 13, color: 'var(--text2)' }}>
              The few companies from your <Link to="/leads">LinkedIn posts</Link> and <Link to="/naukri">Naukri jobs</Link> worth a
              people search, ranked by how people there replied, your applications and interviews, how busy their hiring is,
              and free outside signals. Only companies scoring {data?.minScore ?? 5}+ are shown.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {data && data.creditsLeft != null && (
                <span className="badge badge-seen" title="Each role in a search uses one credit">
                  <i className="ti ti-coins" /> {data.creditsLeft} search credits left
                </span>
              )}
              <button type="button" className="btn btn-xs" onClick={() => setShowSources(v => !v)}>
                <i className="ti ti-adjustments" /> Outside signals
              </button>
              <button type="button" className="btn btn-xs" onClick={refresh} disabled={refreshing}>
                <i className={`ti ${refreshing ? 'ti-loader-2 tc-spin' : 'ti-refresh'}`} /> Refresh signals
              </button>
            </div>
          </div>
          {showSources && (
            <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
              {(Object.keys(SOURCE_LABEL) as EnrichSource[]).map(src => (
                <label key={src} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer', color: 'var(--text2)' }}>
                  <input type="checkbox" checked={!(config?.enrichOff || []).includes(src)} onChange={e => toggleSource(src, e.target.checked)} />
                  {SOURCE_LABEL[src]}
                </label>
              ))}
              <span style={{ color: 'var(--text3)', fontSize: 12, flexBasis: '100%' }}>
                All free and keyless (GitHub uses your token if you added one). A check that fails adds 0 points — it can never hide a company.
              </span>
            </div>
          )}
          {data && data.cutForCredits > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--amber)' }}>
              <i className="ti ti-alert-triangle" /> {data.cutForCredits} more {data.cutForCredits === 1 ? 'company' : 'companies'} left out — not enough search credits this month.
            </div>
          )}
        </div>
      </div>

      {loading && !data ? (
        <div className="table-card"><table><tbody><SkeletonRows rows={4} cols={3} /></tbody></table></div>
      ) : error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : list.length === 0 ? (
        <div className="s-card"><div className="empty-state">
          <i className="ti ti-target" />
          Nothing worth a search right now. Companies show up here when someone there replied well, you applied or are interviewing,
          or they're hiring a lot — keep <Link to="/leads">Leads</Link> and <Link to="/naukri">Naukri</Link> running.
          See every company in <Link to="/discover?view=hiring">Hiring now</Link>.
        </div></div>
      ) : (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
          {list.map(s => (
            <div key={s.key} className="s-card" style={{ margin: 0 }}>
              <div className="s-body">
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link to={`/companies/${encodeURIComponent(s.domain ? `d:${s.domain}` : s.key)}`} style={{ fontWeight: 600, fontSize: 15 }}>{s.company}</Link>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                      {s.domain || 'website found when you run it'} · seen {ago(s.lastSeenAt)}
                    </div>
                  </div>
                  <ScoreBadge score={s.score} base={s.base} reasons={s.reasons} notes={s.notes} minScore={data?.minScore} />
                </div>

                <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', fontSize: 12.5 }}>
                  {s.reasons.map((r, i) => (
                    <li key={i} style={{ display: 'flex', gap: 6, padding: '2px 0', color: 'var(--text2)' }}>
                      <span style={{ width: 24, textAlign: 'right', fontWeight: 600, color: r.points > 0 ? 'var(--green)' : 'var(--red)', flexShrink: 0 }}>{sign(r.points)}</span>
                      <i className={`ti ${KIND_ICON[r.kind] || 'ti-circle-dot'}`} style={{ color: 'var(--text3)', marginTop: 2 }} />
                      <span style={{ minWidth: 0 }}>
                        {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.text}</a> : r.text}
                      </span>
                    </li>
                  ))}
                </ul>
                {s.notes.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }} title={s.notes.join('\n')}>
                    <i className="ti ti-info-circle" /> {s.notes.length} outside {s.notes.length === 1 ? 'check' : 'checks'} unavailable (adds 0)
                  </div>
                )}

                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 10 }}>
                  <span style={{ color: 'var(--text3)' }}>Looks for:</span>{' '}
                  {s.roles.length ? s.roles.join(' · ') : 'anyone senior'}
                  {s.jobTitle && <div style={{ color: 'var(--text3)', marginTop: 2 }}>For your application: {s.jobTitle}</div>}
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                  <button type="button" className="btn btn-xs btn-primary" disabled={busy || running !== null} onClick={() => run(s)}
                    title={`Uses about ${s.cost} search credit${s.cost === 1 ? '' : 's'}`}>
                    {running === s.key ? <><i className="ti ti-loader-2 tc-spin" /> Starting…</> : <><i className="ti ti-search" /> Run search</>}
                  </button>
                  <button type="button" className="btn btn-xs" onClick={() => dismiss(s)} disabled={running === s.key}>
                    <i className="ti ti-thumb-down" /> Not worth it
                  </button>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>~{s.cost} credits</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && data.done.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text2)' }}>
            Searched in the last 30 days ({data.done.length})
          </summary>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {data.done.map(d => (
              <Link key={d.key} to={`/discover?domain=${encodeURIComponent(d.domain || '')}`} className="btn btn-xs" title={d.searchedAt ? `Searched ${ago(d.searchedAt)}` : undefined}>
                {d.company}
              </Link>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
