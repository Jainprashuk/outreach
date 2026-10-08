import { Fragment, useCallback, useEffect, useState } from 'react';
import { fmtAgo } from '../lib/analytics';
import { RefreshBar, Refreshing } from './RefreshBar';
import {
  adminAiCallApi, adminAiCallsApi,
  type AiCallDetail, type AiCallRow, type AiCallsView, type AiFeature, type AiProviderStats,
} from '../lib/api';

const RANGES = ['1h', '24h', '7d', '30d'] as const;
type Range = typeof RANGES[number];

const FEATURES: Array<{ key: AiFeature; label: string; hint: string }> = [
  { key: 'classify', label: 'Reply sorting', hint: 'Sorting an incoming reply into a category' },
  { key: 'draft', label: 'Reply drafts', hint: 'Writing a first draft of a reply' },
  { key: 'discover', label: 'Discover', hint: "Reading names off a company's team page" },
  { key: 'other', label: 'Other', hint: 'Calls made without a feature label (scripts, tests)' },
];
const featureLabel = (f: string) => FEATURES.find(x => x.key === f)?.label || f;

const OUTCOMES: Array<{ key: string; label: string }> = [
  { key: 'ok', label: 'Succeeded' },
  { key: 'failed', label: 'Any failure' },
  { key: 'rate-limited', label: 'Rate-limited' },
  { key: 'bad-output', label: 'Bad output' },
  { key: 'transient', label: 'Timeout / network' },
  { key: 'auth', label: 'Key / auth' },
  { key: 'aborted', label: 'Aborted' },
];
const OUTCOME_BADGE: Record<string, string> = {
  ok: 'badge-sent', 'rate-limited': 'badge-pending', 'bad-output': 'badge-rejected',
  transient: 'badge-rejected', auth: 'badge-rejected', aborted: 'badge',
};
const SLOW = [{ v: '', l: 'Any speed' }, { v: '3000', l: '≥ 3s' }, { v: '7000', l: '≥ 7s' }, { v: '15000', l: '≥ 15s' }];

// Gemini's free tier on gemini-3-flash, per Pacific day (lib/classify/providers/index.js).
const GEMINI_FREE_PER_DAY = 20;

const ms = (v: number | null | undefined) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const ago = (v: string | null) => (v ? fmtAgo(new Date(v).getTime()) : '—');

export default function AdminAiLogs() {
  const [range, setRange] = useState<Range>('24h');
  const [provider, setProvider] = useState('');
  const [feature, setFeature] = useState<AiFeature | ''>('');
  const [outcome, setOutcome] = useState('');
  const [userId, setUserId] = useState('');
  const [model, setModel] = useState('');
  const [slowMs, setSlowMs] = useState('');
  const [source, setSource] = useState('');
  const [runId, setRunId] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');   // q, debounced

  const [data, setData] = useState<AiCallsView | null>(null);
  const [rows, setRows] = useState<AiCallRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const params = useCallback((): Record<string, string> => {
    const p: Record<string, string> = { range };
    if (provider) p.provider = provider;
    if (feature) p.feature = feature;
    if (outcome) p.outcome = outcome;
    if (userId) p.userId = userId;
    if (model) p.model = model;
    if (slowMs) p.slowMs = slowMs;
    if (source) p.source = source;
    if (runId) p.runId = runId;
    if (query) p.q = query;
    return p;
  }, [range, provider, feature, outcome, userId, model, slowMs, source, runId, query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminAiCallsApi(params());
      setData(d);
      setRows(d.calls);
      setNextBefore(d.nextBefore);
      setError('');
    } catch (e: any) {
      setError(e.message || 'Could not load the AI logs');
    } finally {
      setLoading(false);
    }
  }, [params]);
  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setMoreLoading(true);
    try {
      const d = await adminAiCallsApi({ ...params(), before: nextBefore });
      setRows(r => [...r, ...d.calls]);
      setNextBefore(d.nextBefore);
    } catch (e: any) {
      setError(e.message || 'Could not load more');
    } finally {
      setMoreLoading(false);
    }
  };

  const filtered = !!(provider || feature || outcome || userId || model || slowMs || source || runId || query);
  const clear = () => {
    setProvider(''); setFeature(''); setOutcome(''); setUserId(''); setModel(''); setSlowMs(''); setSource(''); setRunId(''); setQ('');
  };

  const totalCalls = (data?.providers || []).reduce((n, p) => n + p.calls, 0);
  const totalOk = (data?.providers || []).reduce((n, p) => n + p.ok, 0);
  // Always show every configured provider, even one with no calls in the window.
  const providerCards: AiProviderStats[] = (() => {
    const seen = new Map((data?.providers || []).map(p => [p.provider, p]));
    const names = [...new Set([...(data?.providerOrder || []), ...seen.keys()])];
    return names.map(n => seen.get(n) || {
      provider: n, calls: 0, ok: 0, rateLimited: 0, failed: 0, avgLatencyMs: null, maxLatencyMs: null,
      tokensIn: 0, tokensOut: 0, tokensThinking: 0, lastAt: null, lastFailure: null,
    });
  })();

  return (
    <>
      {data && (
        <div className="an-card" style={{ marginBottom: 16 }}>
          <div className="an-card-body" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5 }}>
            <span>
              <i className="ti ti-sparkles" /> Gemini today: <b style={{ color: data.geminiToday >= GEMINI_FREE_PER_DAY ? 'var(--red)' : undefined }}>
                {data.geminiToday} / {GEMINI_FREE_PER_DAY}
              </b> free requests <span style={{ color: 'var(--text3)' }}>(resets at midnight Pacific · {data.geminiModel})</span>
            </span>
            <span style={{ color: 'var(--text2)' }}>
              Order tried: {data.providerOrder.map((p, i) => (
                <Fragment key={p}>{i > 0 && ' → '}<b style={{ opacity: data.configured.includes(p) ? 1 : 0.4 }}>{p}</b></Fragment>
              ))}
              {data.providerOrder.some(p => !data.configured.includes(p)) && <span style={{ color: 'var(--text3)' }}> (faded = no API key)</span>}
            </span>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-arrows-exchange" /> All calls · {range}</div>
          <div className="stat-value">{num(totalCalls)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{pct(totalOk, totalCalls)} succeeded</div>
        </div>
        {providerCards.map(p => {
          const active = provider === p.provider;
          return (
            <button
              key={p.provider} type="button" className="stat-card"
              onClick={() => setProvider(active ? '' : p.provider)}
              title={p.lastFailure ? `Last failure ${new Date(p.lastFailure.at).toLocaleString()}: ${p.lastFailure.error || p.lastFailure.outcome}` : 'No failures in this window'}
              style={{ textAlign: 'left', cursor: 'pointer', outline: active ? '2px solid var(--accent)' : undefined }}
            >
              <div className="stat-label" style={{ textTransform: 'capitalize' }}>
                <i className={`ti ${p.provider === 'gemini' ? 'ti-sparkles' : 'ti-cpu'}`} /> {p.provider}
              </div>
              <div className={`stat-value ${p.calls === 0 ? '' : p.ok === p.calls ? 'green' : p.ok / p.calls >= 0.8 ? 'amber' : 'red'}`}>
                {num(p.calls)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2, lineHeight: 1.5 }}>
                {pct(p.ok, p.calls)} ok · {p.rateLimited} rate-limited · {p.failed} failed<br />
                avg {ms(p.avgLatencyMs)} · max {ms(p.maxLatencyMs)}<br />
                {num(p.tokensIn)} in / {num(p.tokensOut)} out tokens{p.tokensThinking ? ` (${num(p.tokensThinking)} thinking)` : ''}
              </div>
            </button>
          );
        })}
      </div>

      <div className="an-card" style={{ marginTop: 16 }}>
        <div className="an-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="an-card-title"><i className="ti ti-message-chatbot" /> Gemini logs</div>
            <div className="an-card-sub">
              Every request to Gemini and the providers it shares the work with, for every account: the full prompt,
              the raw answer, tokens and timing. When one provider fails and the next answers, both attempts are shown.
              Live calls are kept for 30 days. Calls from before this tab existed are rebuilt from the activity log
              (marked “history”) with less detail, and kept.
            </div>
          </div>
          <div className="seg-toggle">
            {RANGES.map(r => (
              <button key={r} type="button" className={`btn btn-xs${range === r ? ' active' : ''}`} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
        </div>
        <div className="an-card-body">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <input
              className="login-input" type="search" placeholder="Search prompt, answer, error, contact or company…"
              value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 220 }}
            />
            <select value={provider} onChange={e => setProvider(e.target.value)} aria-label="Provider" style={{ width: 'auto' }}>
              <option value="">Every provider</option>
              {providerCards.map(p => <option key={p.provider} value={p.provider}>{p.provider}</option>)}
            </select>
            <select value={feature} onChange={e => setFeature(e.target.value as AiFeature | '')} aria-label="Feature" style={{ width: 'auto' }}>
              <option value="">Every feature</option>
              {FEATURES.map(f => (
                <option key={f.key} value={f.key}>
                  {f.label}{data?.features[f.key] ? ` (${data.features[f.key]!.calls})` : ''}
                </option>
              ))}
            </select>
            <select value={outcome} onChange={e => setOutcome(e.target.value)} aria-label="Outcome" style={{ width: 'auto' }}>
              <option value="">Every outcome</option>
              {OUTCOMES.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <select value={userId} onChange={e => setUserId(e.target.value)} aria-label="Account" style={{ width: 'auto' }}>
              <option value="">Every account</option>
              <option value="none">No account (scripts)</option>
              {(data?.users || []).map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
            <select value={model} onChange={e => setModel(e.target.value)} aria-label="Model" style={{ width: 'auto' }}>
              <option value="">Every model</option>
              {(data?.models || []).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={slowMs} onChange={e => setSlowMs(e.target.value)} aria-label="Speed" style={{ width: 'auto' }}>
              {SLOW.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
            </select>
            <select value={source} onChange={e => setSource(e.target.value)} aria-label="Recorded" style={{ width: 'auto' }}>
              <option value="">Live and history</option>
              <option value="live">Logged live (full detail)</option>
              <option value="history">From history (before this tab)</option>
            </select>
            {runId && (
              <span className="badge" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                One request's attempts
                <button type="button" className="btn btn-xs" onClick={() => setRunId('')} aria-label="Clear">×</button>
              </span>
            )}
            {filtered && <button className="btn btn-xs" type="button" onClick={clear}>Clear filters</button>}
            <button className="btn btn-xs" type="button" onClick={load} disabled={loading} title="Refresh">
              <i className={`ti ${loading ? 'ti-loader' : 'ti-refresh'}`} />
            </button>
          </div>

          {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
          {!data && !error && <div className="skeleton" style={{ height: 120 }} />}

          <RefreshBar active={loading && !!data} />
          <Refreshing active={loading && !!data}>
            {data && rows.length === 0 && (
              <div className="an-empty">
                <i className="ti ti-message-off" />
                {filtered ? 'No calls match these filters.' : `No AI calls in the last ${range}.`}
              </div>
            )}
            {data && rows.length > 0 && (
              <div className="table-card" style={{ boxShadow: 'none' }}>
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Provider</th>
                      <th>What for</th>
                      <th>Answer</th>
                      <th style={{ textAlign: 'right' }}>Time</th>
                      <th style={{ textAlign: 'right' }}>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <Fragment key={r.id}>
                        <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                          <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }} title={new Date(r.at).toLocaleString()}>
                            {ago(r.at)}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <div style={{ fontWeight: 600, fontSize: 12.5 }}>{r.provider}</div>
                            <div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.model}</div>
                          </td>
                          <td style={{ maxWidth: 260 }}>
                            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginBottom: 2 }}>
                              <span className="badge">{featureLabel(r.feature)}</span>
                              {r.attempt > 1 && <span className="badge badge-pending" title="An earlier provider failed first">attempt {r.attempt}</span>}
                              {r.source === 'history' && <span className="badge" title={r.note || ''}>history</span>}
                            </div>
                            <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.userEmail || <span style={{ color: 'var(--text3)' }}>no account</span>}
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.context.contactName || r.context.contactEmail || r.context.company || ''}
                            </div>
                          </td>
                          <td style={{ maxWidth: 440 }}>
                            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginBottom: 3 }}>
                              <span className={`badge ${OUTCOME_BADGE[r.outcome] || 'badge'}`}>{r.outcome}</span>
                              {r.result?.category && <code style={{ fontSize: 11.5 }}>{r.result.category}</code>}
                              {r.status != null && r.status !== 200 && <code style={{ fontSize: 11, color: 'var(--text3)' }}>HTTP {r.status}</code>}
                            </div>
                            <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.error ? 'var(--red)' : undefined }}>
                              {r.error || r.result?.reasoning || r.outputPreview || <span style={{ color: 'var(--text3)' }}>(empty)</span>}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12.5, whiteSpace: 'nowrap' }}>{ms(r.latencyMs)}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text2)' }}>
                            {r.tokens?.total != null ? num(r.tokens.total) : '—'}
                          </td>
                        </tr>
                        {expanded === r.id && (
                          <CallDetail id={r.id} onShowRun={(rid) => { clear(); setRunId(rid); setExpanded(null); }} />
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data && rows.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
                  Showing {rows.length} of {num(data.total)} matching call(s), newest first.
                </span>
                {nextBefore && (
                  <button className="btn btn-xs" type="button" onClick={loadMore} disabled={moreLoading}>
                    {moreLoading ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </div>
            )}
          </Refreshing>
        </div>
      </div>
    </>
  );
}

function CallDetail({ id, onShowRun }: { id: string; onShowRun: (runId: string) => void }) {
  const [d, setD] = useState<AiCallDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    adminAiCallApi(id).then(x => { if (live) setD(x); }).catch(e => { if (live) setError(e.message || 'Could not load'); });
    return () => { live = false; };
  }, [id]);

  const pre: React.CSSProperties = {
    fontSize: 11.5, background: 'var(--surface2, var(--bg))', border: '1px solid var(--border)', borderRadius: 6,
    padding: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 360, overflow: 'auto', margin: '4px 0 10px',
  };
  const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); };
  const Block = ({ title, text }: { title: string; text: string }) => (
    <>
      <div className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{title} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>· {text.length.toLocaleString()} chars</span></span>
        <button type="button" className="btn btn-xs" onClick={() => copy(text)} title="Copy"><i className="ti ti-copy" /></button>
      </div>
      <pre style={pre}>{text || '(empty)'}</pre>
    </>
  );

  return (
    <tr>
      <td colSpan={6} style={{ paddingTop: 0 }}>
        {error && <div className="login-error" style={{ textAlign: 'left' }}>{error}</div>}
        {!d && !error && <div className="skeleton" style={{ height: 80 }} />}
        {d && (
          <div style={{ padding: '4px 0 6px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', margin: '2px 0 8px', lineHeight: 1.6 }}>
              {new Date(d.at).toLocaleString()} · {d.provider} / {d.model} · {d.method}
              {d.status != null && <> · HTTP {d.status}</>}
              {d.finishReason && <> · finish: {d.finishReason}</>}
              {' · '}tokens {num(d.tokens.input)} in / {num(d.tokens.output)} out
              {d.tokens.thinking ? <> / {num(d.tokens.thinking)} thinking</> : null}
              {d.params && <> · {Object.entries(d.params).map(([k, v]) => `${k} ${String(v)}`).join(', ')}</>}
              {(d.context.contactEmail || d.context.company) && (
                <> · {[d.context.contactName, d.context.contactEmail, d.context.company].filter(Boolean).join(' · ')}</>
              )}
            </div>

            {d.note && (
              <div style={{ fontSize: 12, color: 'var(--amber)', background: 'var(--amber-bg)', borderRadius: 6, padding: '6px 10px', marginBottom: 10 }}>
                <i className="ti ti-history" /> {d.note}
              </div>
            )}

            {d.run.length > 1 && (
              <div style={{ marginBottom: 10 }}>
                <div className="form-label">This request tried {d.run.length} providers</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
                  {d.run.map((s, i) => (
                    <Fragment key={s.id}>
                      {i > 0 && <i className="ti ti-arrow-right" style={{ color: 'var(--text3)' }} />}
                      <span className={`badge ${OUTCOME_BADGE[s.outcome] || 'badge'}`} title={s.error || ''}
                        style={{ outline: s.id === d.id ? '2px solid var(--accent)' : undefined }}>
                        {s.provider} · {s.outcome} · {ms(s.latencyMs)}
                      </span>
                    </Fragment>
                  ))}
                  {d.runId && <button type="button" className="btn btn-xs" onClick={() => onShowRun(d.runId!)}>Show only these</button>}
                </div>
              </div>
            )}

            {d.error && (<><div className="form-label">Error</div><pre style={{ ...pre, color: 'var(--red)' }}>{d.error}</pre></>)}
            {d.result && (<><div className="form-label">Parsed result</div><pre style={pre}>{JSON.stringify(d.result, null, 2)}</pre></>)}
            <Block title="Output (raw)" text={d.output} />
            <Block title="Prompt" text={d.prompt} />
            <details>
              <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text2)', marginBottom: 6 }}>System instruction</summary>
              <pre style={pre}>{d.system || '(none)'}</pre>
            </details>
          </div>
        )}
      </td>
    </tr>
  );
}
