// Discover: type a company, and the app finds people there and guesses each
// one's work email. Nothing is emailed from here — "Move to outreach" creates pending
// contacts, and Step 2 still approves every one of them.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import ConfidenceBadge from '../components/ConfidenceBadge';
import { SkeletonRows } from '../components/Skeleton';
import SearchReport, { ago } from '../components/prospects/SearchReport';
import HiringView from '../components/prospects/HiringView';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import {
  addGenericProspectApi, cancelSearchApi, clearHistoryApi, companyFormatApi, prospectHistoryApi, removeSearchApi, discardProspectsApi, discoveryConfigApi, loadProspectsApi,
  moveProspectsApi, prospectCompaniesApi, prospectSearchApi, recheckCompanyApi, restoreProspectsApi,
  setGithubOrgApi, startProspectSearchApi, lookupCompanyApi, updateProspectApi,
  type CompanyCandidate, type CompanyFormat, type HiringCompany, type DiscoveryConfigView, type EmailConfidence, type MoveProspectsResult,
  type Prospect, type ProspectCompany, type ProspectSearch,
} from '../lib/api';
import { CONFIDENCE_LABEL, PATTERN_EXAMPLE, SOURCE_LABEL } from '../lib/prospects';

type Tab = 'open' | 'moved' | 'discarded' | 'all';
const TAB_LABEL: Record<Tab, string> = { open: 'To review', moved: 'In outreach', discarded: 'Discarded', all: 'All' };
const OPEN = new Set(['new', 'ready', 'error']);
const VIA_LABEL: Record<string, string> = { search: 'Web search', github: 'GitHub', website: 'Website' };

const isRunning = (s: ProspectSearch | null) => !!s && (s.status === 'queued' || s.status === 'running');
const canMove = (p: Prospect) => p.status === 'ready' && !!p.email && !p.existingContactId;

// ── Search form ──────────────────────────────────────────────────────────────

const SOURCE_NOTE: Record<CompanyCandidate['source'], string> = {
  contacts: 'from your contacts',
  directory: 'company directory',
  guess: 'guessed — check it',
  typed: 'as typed',
};

/** Pick the top candidate without asking only when it can't be the wrong company. */
const autoPick = (list: CompanyCandidate[]) => {
  const top = list[0];
  if (!top || !top.exact) return null;
  return top.source === 'contacts' || top.source === 'typed' || !list.slice(1).some(c => c.exact) ? top : null;
};

function SearchCard({ config, busy, onSearch, prefill }: {
  config: DiscoveryConfigView | null;
  busy: boolean;
  onSearch: (domain: string, roles: string[], companyName: string) => void;
  /** Fill the box from elsewhere (Hiring now) and show the matches to choose from. */
  prefill?: { text: string; roles: string[]; n: number } | null;
}) {
  const [query, setQuery] = useState('');
  const [roles, setRoles] = useState('');
  const [candidates, setCandidates] = useState<CompanyCandidate[]>([]);
  const [looking, setLooking] = useState(false);
  const [open, setOpen] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const lastQuery = useRef('');

  useEffect(() => {
    if (!prefill) return;
    setQuery(prefill.text);
    setRoles(prefill.roles.join(', '));
    setOpen(true);
  }, [prefill?.n]);

  const lookup = async (q: string) => {
    lastQuery.current = q;
    setLooking(true);
    try {
      const r = await lookupCompanyApi(q);
      if (lastQuery.current !== q) return null; // a newer keystroke won
      setCandidates(r.candidates);
      setNotFound(r.candidates.length === 0);
      return r.candidates;
    } catch { return null; } finally { if (lastQuery.current === q) setLooking(false); }
  };

  useEffect(() => {
    const q = query.trim();
    setNotFound(false);
    if (q.length < 2) { setCandidates([]); return; }
    const t = setTimeout(() => { lookup(q); }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const roleList = () => roles.split(',').map(r => r.trim()).filter(Boolean);
  const pick = (c: CompanyCandidate) => {
    setOpen(false);
    setQuery(c.name || c.domain);
    onSearch(c.domain, roleList(), c.name);
  };
  const submit = async () => {
    const q = query.trim();
    if (!q || busy) return;
    const list = (lastQuery.current === q && candidates.length) ? candidates : await lookup(q);
    if (!list) return;
    const sure = autoPick(list);
    if (sure) pick(sure);
    else setOpen(true); // more than one company could be meant — let them choose
  };

  const noSearchKey = config && !config.keys.tavily && !config.keys.serpapi;
  return (
    <div className="s-card" style={{ marginBottom: 16, overflow: 'visible', position: 'relative', zIndex: 5 }}>
      <div className="s-body">
        <div className="form-grid" style={{ alignItems: 'end' }}>
          <div className="form-group" style={{ position: 'relative' }}>
            <label className="form-label">Company *</label>
            <input type="text" value={query} placeholder="Company name, e.g. Zerodha — or its website"
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }} />
            {open && candidates.length > 0 && (
              <div role="listbox" style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4,
                background: 'var(--bg)', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-md)', overflow: 'hidden',
              }}>
                {candidates.map(c => (
                  <button key={c.domain} type="button" role="option" className="tc-option"
                    onMouseDown={e => e.preventDefault()} onClick={() => pick(c)}
                    style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 10, padding: '9px 12px',
                      background: 'none', border: 0, borderBottom: '0.5px solid var(--border)', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ fontWeight: 500 }}>{c.name || c.domain}</strong>
                      <span style={{ color: 'var(--text2)' }}> · {c.domain}</span>
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>
                      {c.source === 'contacts' ? `${c.contacts} of your contacts` : SOURCE_NOTE[c.source]}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {notFound && !looking && (
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                Couldn’t find that company — try its website instead (e.g. acme.in).
              </div>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Roles <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(optional)</span></label>
            <input type="text" value={roles} placeholder="engineering manager, CTO — empty finds anyone"
              onChange={e => setRoles(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" type="button" disabled={!query.trim() || busy} onClick={submit}>
            {busy ? <><i className="ti ti-loader" /> Searching…</> : looking ? <><i className="ti ti-loader" /> Finding the company…</> : <><i className="ti ti-search" /> Find people</>}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Searches the web, the company’s GitHub and its website. Takes about a minute.
          </span>
        </div>
        {noSearchKey && (
          <div className="info-box" style={{ marginTop: 12, marginBottom: 0 }}>
            <i className="ti ti-info-circle" style={{ fontSize: 15, flexShrink: 0 }} />
            <div>
              Web search for people needs a free Tavily key — <Link to="/settings">add it in Settings</Link>.
              Without it, the app still checks GitHub and the company website.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── The company: its email format and what's been found there ────────────────

function CompanyCard({ format, prospects, onRecheck, onSearchAgain, onAddGeneric, onSetOrg, busy }: {
  format: CompanyFormat;
  prospects: Prospect[];
  onRecheck: () => void;
  onSearchAgain: () => void;
  onAddGeneric: (email: string) => void;
  onSetOrg: () => void;
  busy: boolean;
}) {
  const d = format.decision;
  const example = PATTERN_EXAMPLE[d.pattern] ? `${PATTERN_EXAMPLE[d.pattern]}@${format.domain}` : '';
  const open = prospects.filter(p => OPEN.has(p.status));
  const stat = (n: number, label: string, color?: string, help?: string) => (
    <div className="tc-stat" title={help}>
      <div className="tc-stat-n" style={color ? { color } : undefined}>{n}</div>
      <div className="tc-stat-l">{label}</div>
    </div>
  );
  const label = (c: string) => open.filter(p => p.email && p.emailSource !== 'manual' && p.emailConfidence === c).length;

  return (
    <div className="s-card" style={{ marginBottom: 16 }}>
      <div className="s-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
            <div className="tc-report-ico" style={{ width: 40, height: 40, color: 'var(--accent)' }}><i className="ti ti-building" /></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{format.companyName || format.domain}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                {format.domain}
                {format.githubOrg && <> · <a href={`https://github.com/${format.githubOrg}`} target="_blank" rel="noreferrer">github.com/{format.githubOrg}</a></>}
                {format.contactsAtDomain > 0 && <> · {format.contactsAtDomain} of your contacts work here</>}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" type="button" disabled={busy} onClick={onRecheck}
              title="Re-label everyone from what's known now — including replies and bounces since the search. No outside lookups.">
              <i className="ti ti-refresh" /> Re-check labels
            </button>
            <button className="btn btn-sm" type="button" disabled={busy} onClick={onSetOrg} title="Set the company's GitHub organisation by hand">
              <i className="ti ti-brand-github" /> GitHub
            </button>
            <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={onSearchAgain}
              title="Search again, re-reading GitHub and the website too">
              <i className="ti ti-search" /> Search again
            </button>
          </div>
        </div>

        <div className="info-box" style={{ marginTop: 14, marginBottom: 0, alignItems: 'center' }}>
          <i className="ti ti-mail" style={{ fontSize: 15, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            {d.source === 'default' ? (
              <>Email format not proven yet — guessing <strong>{d.pattern}</strong>{example && <> (like {example})</>}, the format most of your companies use.</>
            ) : (
              <>Their email format is <strong>{d.pattern}</strong>{example && <> (like {example})</>}, from {SOURCE_LABEL[d.source] || d.source}{d.runnerUp && <> · a few use <strong>{d.runnerUp}</strong></>}.</>
            )}
          </div>
          <ConfidenceBadge confidence={d.confidence} pattern={d.pattern} source={d.source} />
        </div>

        {format.hasMx === false && (
          <div className="info-box danger" style={{ marginTop: 10, marginBottom: 0 }}>
            <i className="ti ti-alert-triangle" style={{ fontSize: 15, flexShrink: 0 }} />
            <div>{format.domain} has no mail server, so nobody there can be emailed. Check the company.</div>
          </div>
        )}

        <div className="tc-stats">
          {stat(open.length, 'To review')}
          {stat(label('high'), 'High confidence', 'var(--green)', 'Proven format, or their own address')}
          {stat(label('medium'), 'Medium', 'var(--amber)', 'One sign the format is right')}
          {stat(label('low'), 'Low — check first', 'var(--red)', 'A best guess with no proof')}
          {stat(prospects.filter(p => p.status === 'moved').length, 'In outreach', 'var(--blue)')}
        </div>

        {format.genericEmails.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>Shared inboxes on their website:</span>
            {format.genericEmails.map(e => (
              <button key={e} className="btn btn-xs" type="button" onClick={() => onAddGeneric(e)} title="Add this address to the list">
                <i className="ti ti-plus" /> {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Search history ───────────────────────────────────────────────────────────

function HistoryView({ searches, loading, onOpen, onRunAgain, onRemove, onClear, busy }: {
  searches: ProspectSearch[];
  loading: boolean;
  onOpen: (s: ProspectSearch) => void;
  onRunAgain: (s: ProspectSearch) => void;
  onRemove: (s: ProspectSearch) => void;
  onClear: () => void;
  busy: boolean;
}) {
  return (
    <>
      <div className="section-head">
        <span style={{ fontSize: 13, color: 'var(--text2)' }}>
          Every company you’ve searched. Removing a search from history keeps the people it found.
        </span>
        {searches.length > 0 && (
          <button className="btn btn-sm" type="button" onClick={onClear} disabled={busy}><i className="ti ti-trash" /> Clear history</button>
        )}
      </div>
      <div className="table-card">
        <table>
          <thead>
            <tr><th>Company</th><th>Roles</th><th>When</th><th>Found</th><th>Addresses</th><th></th></tr>
          </thead>
          <tbody>
            {loading && searches.length === 0 ? (
              <SkeletonRows rows={5} cols={6} />
            ) : searches.length === 0 ? (
              <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-history" />No searches yet — search a company to start.</div></td></tr>
            ) : searches.map(s => {
              const c: any = s.counts || {};
              const running = isRunning(s);
              return (
                <tr key={s.id} className="tc-hist-row">
                  <td>
                    <button type="button" className="btn-link" onClick={() => onOpen(s)} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                      <div style={{ fontWeight: 500 }}>{s.companyName || s.domain}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>{s.domain}</div>
                    </button>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', maxWidth: 220 }}>{s.roles.length ? s.roles.join(', ') : <span style={{ color: 'var(--text3)' }}>anyone</span>}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }} title={new Date(s.createdAt).toLocaleString()}>{ago(s.createdAt)}</td>
                  <td style={{ fontSize: 13 }}>
                    {running ? <span className="badge badge-queued"><i className="ti ti-loader-2 tc-spin" /> Running</span>
                      : s.status === 'error' ? <span className="badge badge-rejected" title={s.error || ''}>Failed</span>
                        : <>{c.people ?? 0} {c.added != null && <span style={{ fontSize: 11, color: 'var(--text3)' }}>({c.added} new)</span>}</>}
                  </td>
                  <td>
                    {!running && s.status === 'done' && (
                      <span className="tc-mini">
                        {c.high ? <span className="badge badge-sent">{c.high} high</span> : null}
                        {c.medium ? <span className="badge badge-pending">{c.medium} medium</span> : null}
                        {c.low ? <span className="badge badge-rejected">{c.low} low</span> : null}
                        {!c.high && !c.medium && !c.low && <span style={{ fontSize: 12, color: 'var(--text3)' }}>—</span>}
                      </span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button className="btn btn-xs" type="button" onClick={() => onOpen(s)}><i className="ti ti-eye" /> Open</button>{' '}
                    <button className="btn btn-xs" type="button" disabled={busy || running} onClick={() => onRunAgain(s)} title="Run this search again"><i className="ti ti-refresh" /> Again</button>{' '}
                    <button className="btn btn-xs" type="button" disabled={running} onClick={() => onRemove(s)} title="Remove from history — the people stay"><i className="ti ti-x" /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Email cell with inline edit ──────────────────────────────────────────────

function EmailCell({ p, onSaved }: { p: Prospect; onSaved: (p: Prospect) => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.email || '');
  const [saving, setSaving] = useState(false);

  const save = async (email: string) => {
    setSaving(true);
    try {
      const r = await updateProspectApi(p.id, { email });
      onSaved(r.prospect);
      setEditing(false);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally { setSaving(false); }
  };

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 4 }}>
        <input type="email" value={value} autoFocus disabled={saving} style={{ minWidth: 200 }}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(value); if (e.key === 'Escape') setEditing(false); }} />
        <button className="btn btn-xs btn-primary" type="button" disabled={saving} onClick={() => save(value)}><i className="ti ti-check" /></button>
        <button className="btn btn-xs" type="button" disabled={saving} onClick={() => setEditing(false)}><i className="ti ti-x" /></button>
      </div>
    );
  }
  const editable = p.status !== 'moved';
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {p.email
          ? <span style={{ wordBreak: 'break-all' }}>{p.email}</span>
          : <span style={{ color: 'var(--text3)' }}>{p.note || 'No address yet'}</span>}
        {editable && (
          <button className="btn btn-xs" type="button" title="Edit the address" onClick={() => { setValue(p.email || ''); setEditing(true); }}>
            <i className="ti ti-pencil" />
          </button>
        )}
        {editable && p.emailSource === 'manual' && (
          <button className="btn btn-xs" type="button" title="Discard your edit and use the guess again" disabled={saving} onClick={() => save('')}>
            <i className="ti ti-arrow-back-up" />
          </button>
        )}
      </div>
      {p.email && p.note && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{p.note}</div>}
      {p.existingContactId && <div style={{ fontSize: 11, color: 'var(--amber)' }}><i className="ti ti-user-check" /> Already in outreach</div>}
      {!p.existingContactId && p.contactedAs && (
        <div style={{ fontSize: 11, color: 'var(--amber)' }} title="Same name at this company, under another address">
          <i className="ti ti-alert-triangle" /> Already contacted as {p.contactedAs}
        </div>
      )}
    </div>
  );
}

// ── Move modal ───────────────────────────────────────────────────────────────

function MoveModal({ prospects, onClose, onDone }: {
  prospects: Prospect[];
  onClose: () => void;
  onDone: (r: MoveProspectsResult) => void;
}) {
  const app = useApp();
  const templateOptions = Object.entries(app.templates).map(([key, tpl]) => ({ key, name: tpl.name }));
  const [template, setTemplate] = useState(templateOptions[0]?.key || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!template && templateOptions[0]) setTemplate(templateOptions[0].key); }, [templateOptions.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const by = (c: EmailConfidence | 'manual') => prospects.filter(p => (c === 'manual' ? p.emailSource === 'manual' : p.emailSource !== 'manual' && p.emailConfidence === c)).length;

  const confirm = async () => {
    setSaving(true); setError('');
    try { onDone(await moveProspectsApi(prospects.map(p => p.id), template)); }
    catch (err: any) { setError(err.message); setSaving(false); }
  };

  return (
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" style={{ maxWidth: 560 }}>
        <div className="reply-modal-header">
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Move {prospects.length} {prospects.length === 1 ? 'person' : 'people'} to outreach</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>They become pending contacts. Nothing is sent until you approve them in Step 2.</div>
          </div>
          <button aria-label="Close" className="btn btn-sm" onClick={onClose} type="button" disabled={saving}><i className="ti ti-x" /></button>
        </div>
        <div style={{ padding: '14px 0' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {(['high', 'generic', 'medium', 'low'] as EmailConfidence[]).map(c => by(c) > 0 && (
              <span key={c} className="contact-count-badge">{CONFIDENCE_LABEL[c]}: {by(c)}</span>
            ))}
            {by('manual') > 0 && <span className="contact-count-badge">Edited by you: {by('manual')}</span>}
          </div>
          <div className="form-group">
            <label className="form-label">Template</label>
            <select value={template} onChange={e => setTemplate(e.target.value)}>
              {templateOptions.length === 0 && <option value="">No templates — create one first</option>}
              {templateOptions.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
            {templateOptions.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}><Link to="/templates">Create a template</Link></div>
            )}
          </div>
          {error && <div className="info-box danger"><i className="ti ti-alert-triangle" /><div>{error}</div></div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" type="button" onClick={confirm} disabled={saving || !template}>
            {saving ? <><i className="ti ti-loader" /> Moving…</> : <><i className="ti ti-user-plus" /> Move to outreach</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Discover() {
  const app = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const domain = params.get('domain') || '';
  const view = params.get('view') === 'history' ? 'history' : params.get('view') === 'hiring' ? 'hiring' : 'find';
  const runId = params.get('run') || '';

  const [config, setConfig] = useState<DiscoveryConfigView | null>(null);
  const [companies, setCompanies] = useState<ProspectCompany[]>([]);
  const [search, setSearch] = useState<ProspectSearch | null>(null);
  const [format, setFormat] = useState<CompanyFormat | null>(null);
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [working, setWorking] = useState(false);

  const [tab, setTab] = useState<Tab>('open');
  const [confidence, setConfidence] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const wasRunning = useRef(false);
  const [prefill, setPrefill] = useState<{ text: string; roles: string[]; n: number } | null>(null);
  const [history, setHistory] = useState<ProspectSearch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const loadHistory = () => {
    setHistoryLoading(true);
    return prospectHistoryApi().then(r => setHistory(r.searches)).catch(() => { /* keep the last list */ }).finally(() => setHistoryLoading(false));
  };
  const go = (next: Record<string, string>) => setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)));

  const loadCompanies = () => prospectCompaniesApi().then(r => { setCompanies(r.companies); return r.companies; });
  const loadConfig = () => discoveryConfigApi().then(setConfig).catch(() => { /* card shows nothing */ });
  const loadProspects = async (d = domain) => {
    if (!d) { setProspects([]); return; }
    const r = await loadProspectsApi({ domain: d, status: 'all' });
    setProspects(r.prospects);
  };
  const loadFormat = (d = domain) => (d ? companyFormatApi(d).then(setFormat).catch(() => setFormat(null)) : Promise.resolve());

  useEffect(() => {
    loadConfig();
    app.loadTemplates().catch(() => { /* the modal shows the empty state */ });
    loadHistory();
    loadCompanies().then(list => {
      // Open on your latest company — only on Find people; History and Hiring now keep their view.
      if (!params.get('domain') && list[0] && !params.get('view')) setParams({ domain: list[0].domain }, { replace: true });
    }).catch(err => setError(err.message));
  }, []);
  useEffect(() => { if (view === 'history') loadHistory(); }, [view]);

  // A company was picked (or searched): load its people, its format and its last run.
  useEffect(() => {
    setSelected(new Set());
    setFormat(null);
    setSearch(null);
    if (!domain) { setProspects([]); return; }
    setLoading(true);
    setError('');
    Promise.all([loadProspects(domain), loadFormat(domain)])
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
    // The run picked from history, else this company's latest.
    const c = companies.find(x => x.domain === domain);
    const id = runId || c?.lastSearchId;
    if (id) prospectSearchApi(id).then(r => setSearch(r.search)).catch(() => { /* no run to show */ });
  }, [domain, runId, companies.length]);

  // While a run is going, poll it and show people as they're found.
  const running = isRunning(search);
  useVisibleInterval(async () => {
    if (!search) return;
    try {
      const r = await prospectSearchApi(search.id);
      setSearch(r.search);
      await loadProspects(r.search.domain);
    } catch { /* next tick */ }
  }, 3000, running);

  useEffect(() => {
    if (wasRunning.current && search && !running) {
      loadFormat(search.domain);
      loadCompanies();
      loadConfig();
      loadHistory();
      if (search.status === 'done') {
        toast(`Found ${search.counts.people} ${search.counts.people === 1 ? 'person' : 'people'} · ${search.counts.withEmail} with an address`, 'success');
      }
    }
    wasRunning.current = running;
  }, [running, search?.status]);

  const startSearch = async (d: string, roles: string[], companyName: string, force = false) => {
    setStarting(true);
    try {
      const r = await startProspectSearchApi({ domain: d, roles, companyName, force });
      await loadCompanies();
      go({ domain: r.search.domain });
      setSearch(r.search);
      loadHistory();
      wasRunning.current = true;
    } catch (err: any) {
      toast(err.message, 'error');
    } finally { setStarting(false); }
  };

  // From Hiring now. A LinkedIn company's website is known (from the post's email);
  // a Naukri one is looked up by name, and started only when the match is certain —
  // otherwise the Find tab opens with the name filled in and the matches to pick from.
  const findHiring = async (c: HiringCompany, roles: string[]) => {
    if (c.domain) return startSearch(c.domain, roles, c.company);
    try {
      const r = await lookupCompanyApi(c.company);
      const sure = autoPick(r.candidates);
      if (sure) return startSearch(sure.domain, roles, sure.name || c.company);
    } catch { /* fall through to choosing by hand */ }
    go({});
    setPrefill({ text: c.company, roles, n: Date.now() });
    toast(`Pick which ${c.company} you mean`, 'info');
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const inTab = (p: Prospect) =>
    tab === 'all' ? true : tab === 'open' ? OPEN.has(p.status) : p.status === tab;
  const counts = useMemo(() => ({
    open: prospects.filter(p => OPEN.has(p.status)).length,
    moved: prospects.filter(p => p.status === 'moved').length,
    discarded: prospects.filter(p => p.status === 'discarded').length,
    all: prospects.length,
  }), [prospects]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return prospects.filter(p => inTab(p)
      && (!confidence || (confidence === 'none' ? !p.emailConfidence : p.emailConfidence === confidence))
      && (!needle || `${p.name} ${p.title} ${p.email || ''}`.toLowerCase().includes(needle)));
  }, [prospects, tab, confidence, q]);

  const selectable = shown.filter(p => p.status !== 'moved');
  const allChecked = selectable.length > 0 && selectable.every(p => selected.has(p.id));
  const someChecked = selectable.some(p => selected.has(p.id));
  const toggleAll = (on: boolean) => setSelected(on ? new Set(selectable.map(p => p.id)) : new Set());
  const toggleRow = (id: string, on: boolean) => setSelected(prev => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const selectedRows = prospects.filter(p => selected.has(p.id));
  const movable = selectedRows.filter(canMove);
  const discardable = selectedRows.filter(p => OPEN.has(p.status));
  const restorable = selectedRows.filter(p => p.status === 'discarded');

  const replaceRow = (row: Prospect) => setProspects(list => list.map(p => (p.id === row.id ? row : p)));

  // ── Actions ────────────────────────────────────────────────────────────────

  const afterMove = async (r: MoveProspectsResult) => {
    setMoveOpen(false);
    setSelected(new Set());
    const parts = [`${r.moved} moved to outreach`];
    if (r.duplicates) parts.push(`${r.duplicates} already contacts`);
    if (r.blocked) parts.push(`${r.blocked} blocklisted`);
    if (r.notReady) parts.push(`${r.notReady} without an address`);
    toast(parts.join(' · '), r.moved ? 'success' : 'info');
    await Promise.all([loadProspects(), loadConfig(), loadCompanies()]);
  };

  const discard = async () => {
    try {
      const r = await discardProspectsApi(discardable.map(p => p.id));
      toast(`${r.discarded} discarded`, 'success');
      setSelected(new Set());
      await loadProspects();
    } catch (err: any) { toast(err.message, 'error'); }
  };
  const restore = async () => {
    try {
      const r = await restoreProspectsApi(restorable.map(p => p.id));
      toast(`${r.restored} restored`, 'success');
      setSelected(new Set());
      await loadProspects();
    } catch (err: any) { toast(err.message, 'error'); }
  };
  const recheck = async () => {
    setWorking(true);
    try {
      const r = await recheckCompanyApi(domain);
      toast(`Labels updated — ${r.withEmail} of ${r.people} have an address`, 'success');
      await Promise.all([loadProspects(), loadFormat()]);
    } catch (err: any) { toast(err.message, 'error'); } finally { setWorking(false); }
  };
  const addGeneric = async (email: string) => {
    try {
      const r = await addGenericProspectApi(domain, email);
      toast(r.existed ? 'Already in the list' : `${email} added`, 'success');
      await loadProspects();
    } catch (err: any) { toast(err.message, 'error'); }
  };
  const setOrg = async () => {
    const v = window.prompt('GitHub organisation for this company (e.g. acme-labs). Leave empty to find it automatically.', format?.githubOrg || '');
    if (v === null) return;
    try {
      await setGithubOrgApi(domain, v.trim());
      toast(v.trim() ? 'Saved — it’s used on the next search' : 'Cleared', 'success');
      await loadFormat();
    } catch (err: any) { toast(err.message, 'error'); }
  };

  const current = companies.find(c => c.domain === domain);
  const busy = loading && prospects.length === 0;

  return (
    <Layout
      title="Discover"
      subtitle="Find people at a company and guess their work email. You choose who moves to outreach."
      actions={<Link to="/settings" className="btn btn-sm"><i className="ti ti-key" /> Keys</Link>}
    >
      <div className="nav-tabs" style={{ marginBottom: 16 }}>
        <button type="button" className={`nav-tab${view === 'find' ? ' active' : ''}`} onClick={() => go({ domain })}>
          <i className="ti ti-search" style={{ marginRight: 4 }} />Find people
        </button>
        <button type="button" className={`nav-tab${view === 'hiring' ? ' active' : ''}`} onClick={() => go({ view: 'hiring', domain })}>
          <i className="ti ti-briefcase" style={{ marginRight: 4 }} />Hiring now
        </button>
        <button type="button" className={`nav-tab${view === 'history' ? ' active' : ''}`} onClick={() => go({ view: 'history', domain })}>
          <i className="ti ti-history" style={{ marginRight: 4 }} />History
          <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{history.length}</span>
        </button>
      </div>

      {view === 'hiring' && <HiringView busy={starting || running} onFind={findHiring} />}

      {view === 'history' && (
        <HistoryView searches={history} loading={historyLoading} busy={starting || running}
          onOpen={s => go({ domain: s.domain, run: s.id })}
          onRunAgain={s => startSearch(s.domain, s.roles, s.companyName)}
          onRemove={async s => {
            try { await removeSearchApi(s.id); setHistory(h => h.filter(x => x.id !== s.id)); toast('Removed from history — the people it found are still there', 'success'); }
            catch (err: any) { toast(err.message, 'error'); }
          }}
          onClear={async () => {
            if (!window.confirm('Clear your whole search history? The people found stay in their companies.')) return;
            try { const r = await clearHistoryApi(); toast(`Cleared ${r.cleared} searches`, 'success'); loadHistory(); }
            catch (err: any) { toast(err.message, 'error'); }
          }} />
      )}

      {view === 'find' && (<>
      <SearchCard config={config} busy={starting || running} prefill={prefill} onSearch={(d, roles, name) => startSearch(d, roles, name)} />

      {companies.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>Recent:</span>
          {companies.slice(0, 8).map(c => (
            <button key={c.domain} type="button" className={`btn btn-xs${c.domain === domain ? ' btn-primary' : ''}`}
              onClick={() => go({ domain: c.domain })} title={`${c.open} to review · ${c.moved} in outreach`}>
              {c.companyName || c.domain}{c.open ? ` · ${c.open}` : ''}
            </button>
          ))}
          {companies.length > 8 && (
            <button type="button" className="btn btn-xs" onClick={() => go({ view: 'history' })}>All {companies.length} →</button>
          )}
        </div>
      )}

      {domain && format && (
        <CompanyCard format={format} prospects={prospects} busy={working || running} onRecheck={recheck}
          onSearchAgain={() => startSearch(domain, search?.roles || [], current?.companyName || '', true)}
          onAddGeneric={addGeneric} onSetOrg={setOrg} />
      )}

      {search && search.domain === domain && (
        <SearchReport key={search.id} search={search} onSetOrg={setOrg}
          onCancel={async () => {
            try {
              const r = await cancelSearchApi(search.id);
              setSearch(r.search);
              toast(r.cancelled ? 'Search cancelled — anyone already found is kept' : 'That search had already finished', 'info');
              loadHistory();
            } catch (err: any) { toast(err.message, 'error'); }
          }} />
      )}

      {domain && (
        <>
          <div className="section-head">
            <div className="nav-tabs">
              {(['open', 'moved', 'discarded', 'all'] as Tab[]).map(t => (
                <button key={t} type="button" className={`nav-tab${tab === t ? ' active' : ''}`} onClick={() => { setTab(t); setSelected(new Set()); }}>
                  {TAB_LABEL[t]}<span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{counts[t]}</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or title" style={{ width: 180 }} />
              <select value={confidence} onChange={e => setConfidence(e.target.value)} style={{ width: 'auto' }}>
                <option value="">Any label</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="generic">Shared inbox</option>
                <option value="none">No address</option>
              </select>
            </div>
          </div>

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th className="cb-col">
                    <input type="checkbox" className="row-cb" checked={allChecked}
                      ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                      onChange={e => toggleAll(e.target.checked)} title="Select everyone in this view" />
                  </th>
                  <th>Person</th><th>Email</th><th>Label</th><th>Found via</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {busy ? (
                  <SkeletonRows rows={6} cols={6} chipCol={1} />
                ) : error ? (
                  <tr><td colSpan={6}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
                ) : shown.length === 0 ? (
                  <tr><td colSpan={6}><div className="empty-state">
                    <i className="ti ti-building" />
                    {running ? 'Looking for people…' : prospects.length === 0 ? 'Nobody found here yet — try Search again, or add a free Tavily key in Settings' : 'No one matches these filters'}
                  </div></td></tr>
                ) : shown.map(p => (
                  <tr key={p.id} style={p.status === 'discarded' ? { opacity: 0.55 } : undefined}>
                    <td className="cb-col">
                      <input type="checkbox" className="row-cb" checked={selected.has(p.id)} disabled={p.status === 'moved'}
                        onChange={e => toggleRow(p.id, e.target.checked)} />
                    </td>
                    <td>
                      <div className="contact-chip">
                        <Avatar name={p.name} />
                        <div style={{ minWidth: 0 }}>
                          <div className="name" style={{ whiteSpace: 'normal' }}>
                            {p.linkedin ? <a href={p.linkedin} target="_blank" rel="noopener noreferrer">{p.name}</a> : p.name}
                            {p.roleMatch && <i className="ti ti-target" style={{ marginLeft: 4, color: 'var(--accent)' }} title="Matches a role you searched for" />}
                          </div>
                          <div className="email" style={{ whiteSpace: 'normal' }}>{p.title || <span style={{ color: 'var(--text3)' }}>no title</span>}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 13 }}><EmailCell p={p} onSaved={replaceRow} /></td>
                    <td><ConfidenceBadge confidence={p.emailConfidence} pattern={p.emailPattern} source={p.emailSource} /></td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{p.foundVia.map(v => VIA_LABEL[v] || v).join(', ') || '—'}</td>
                    <td style={{ fontSize: 12 }}>
                      {p.status === 'moved'
                        ? <Link to="/contacts" className="badge badge-sent">In outreach</Link>
                        : p.status === 'discarded' ? <span className="badge badge-closed">Discarded</span>
                          : p.status === 'error' ? <span className="badge badge-rejected" title={p.note}>Can’t email</span>
                            : canMove(p) ? <span className="badge badge-queued">Ready</span>
                              : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!domain && companies.length === 0 && !error && (
        <div className="empty-state" style={{ marginTop: 24 }}>
          <i className="ti ti-building" />Type a company’s name above to find people there.
        </div>
      )}
      </>)}

      <div className={`bulk-bar${selected.size > 0 ? ' visible' : ''}`}>
        <span className="bb-count">
          {selected.size} selected
          {movable.length < selected.size && <span style={{ fontWeight: 400, opacity: 0.75 }}> · {movable.length} can move</span>}
        </span>
        {restorable.length > 0 && (
          <button className="btn" onClick={restore} type="button"><i className="ti ti-arrow-back-up" /> Restore</button>
        )}
        {discardable.length > 0 && (
          <button className="btn btn-del" onClick={discard} type="button"><i className="ti ti-trash" /> Discard</button>
        )}
        <button className="btn btn-send" onClick={() => setMoveOpen(true)} type="button" disabled={movable.length === 0}
          title={movable.length === 0 ? 'None of the selected people have an address that can be moved' : undefined}>
          <i className="ti ti-user-plus" /> Move to outreach{movable.length < selected.size ? ` (${movable.length})` : ''}
        </button>
      </div>

      {moveOpen && movable.length > 0 && (
        <MoveModal prospects={movable} onClose={() => setMoveOpen(false)} onDone={afterMove} />
      )}
    </Layout>
  );
}
