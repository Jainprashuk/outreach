import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import MoveToOutreachModal from '../components/MoveToOutreachModal';
import LeadDetailModal from '../components/LeadDetailModal';
import { SkeletonRows } from '../components/Skeleton';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import {
  deleteLeadApi, deleteLeadsApi, importLeadsApi, loadLeadsApi,
  type Lead, type LeadFile, type MoveToOutreachResult,
} from '../lib/api';
import { readFileText } from '../lib/csv';
import {
  deriveCompany, explodeForPreview, isCompanyDerived, isReject,
  summarisePreview, sourceLeadsFromFile,
  LEAD_BADGE_CLASS, LEAD_STATUS_LABELS,
  type PreviewRow, type PreviewSummary,
} from '../lib/leads';

const PAGE_SIZE = 25;

// Express's json body limit is 10mb; a bigger payload comes back as an HTML 413
// that apiFetch can't parse, so catch it here with a real message.
const MAX_UPLOAD_CHARS = 9_500_000;

const TABS = [['all', 'All'], ['new', 'New'], ['added-to-outreach', 'Added to outreach']] as const;

interface Preview { rows: PreviewRow[]; summary: PreviewSummary; payload: LeadFile; label: string; }

export default function Leads() {
  const app = useApp();
  const toast = useToast();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showImport, setShowImport] = useState(false);
  const [pasted, setPasted] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [hideRejects, setHideRejects] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [detail, setDetail] = useState<Lead | null>(null);

  const reload = async () => {
    const rows = await loadLeadsApi();
    setLeads(rows);
  };

  useEffect(() => {
    loadLeadsApi().then(setLeads).catch(err => setError(err.message)).finally(() => setLoading(false));
    app.loadTemplates().catch(() => { /* the modal shows the empty state */ });
  }, []);

  const resetPage = () => setPage(1);

  const rejectCount = useMemo(() => leads.filter(isReject).length, [leads]);

  const stats = useMemo(() => ({
    total: leads.length,
    fresh: leads.filter(l => l.status === 'new').length,
    moved: leads.filter(l => l.status === 'added-to-outreach').length,
    withEmail: leads.filter(l => l.email).length,
    withoutEmail: leads.filter(l => !l.email).length,
  }), [leads]);

  const filtered = useMemo(() => {
    let list = leads;
    if (tab !== 'all') list = list.filter(l => l.status === tab);
    if (hideRejects) list = list.filter(l => !isReject(l));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(l => (l.authorName + (l.email || '') + deriveCompany(l)).toLowerCase().includes(q));
    return [...list].sort((a, b) => b.fitScore - a.fitScore);
  }, [leads, tab, hideRejects, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Only leads with an email can become contacts, so select-all ignores the rest.
  const selectable = useMemo(() => filtered.filter(l => !!l.email), [filtered]);
  const allChecked = selectable.length > 0 && selectable.every(l => selected.has(l.id));
  const someChecked = selectable.some(l => selected.has(l.id));

  const toggleRow = (id: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      selectable.forEach(l => { if (checked) next.add(l.id); else next.delete(l.id); });
      return next;
    });
  };

  // ── Import ────────────────────────────────────────────────────────────────

  const parseText = (text: string, label: string) => {
    if (text.length > MAX_UPLOAD_CHARS) {
      toast('That file is too large to upload (limit is about 9 MB).', 'error');
      return;
    }
    let parsed: LeadFile;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast("That doesn't look like valid JSON.", 'error');
      return;
    }
    const source = sourceLeadsFromFile(parsed);
    if (source.length === 0) {
      toast('No leads found — expected last_run_leads / all_leads arrays, or a bare array of leads.', 'error');
      return;
    }
    const rows = explodeForPreview(source);
    if (rows.length === 0) {
      toast('None of those rows look like leads (each needs a name or an email).', 'error');
      return;
    }
    setPreview({ rows, summary: summarisePreview(source, rows), payload: parsed, label });
  };

  const handleFile = async (file: File) => {
    try {
      parseText(await readFileText(file), file.name);
    } catch (err: any) {
      toast('Could not read that file: ' + err.message, 'error');
    }
  };

  const saveLeads = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      const r = await importLeadsApi(preview.payload);
      const bits: string[] = [];
      if (r.skippedInBatch > 0) bits.push(`${r.skippedInBatch} duplicate row${r.skippedInBatch !== 1 ? 's' : ''} in the file skipped`);
      if (r.skipped > 0) bits.push(`${r.skipped} already in your lead store`);
      if (r.ignoredRows > 0) bits.push(`${r.ignoredRows} unusable row${r.ignoredRows !== 1 ? 's' : ''} ignored`);
      const suffix = bits.length ? ` · ${bits.join(' · ')}` : '';
      toast(
        r.created.length === 0
          ? `Nothing saved — all ${r.skipped} lead${r.skipped !== 1 ? 's were' : ' was'} already in your lead store.`
          : `${r.created.length} lead${r.created.length !== 1 ? 's' : ''} saved${suffix}.`,
        r.created.length === 0 ? 'info' : 'success',
      );
      setPreview(null);
      setPasted('');
      setShowImport(false);
      setSelected(new Set());
      resetPage();
      await reload();
    } catch (err: any) {
      toast('Could not save leads: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Promote / delete ──────────────────────────────────────────────────────

  const selectedLeads = useMemo(
    () => leads.filter(l => selected.has(l.id) && l.email),
    [leads, selected],
  );

  const onMoveDone = async (r: MoveToOutreachResult, excludedCount: number) => {
    setMoveOpen(false);
    const parts = [`${r.created.length} contact${r.created.length !== 1 ? 's' : ''} created`];
    if (r.alreadyExisted > 0) parts.push(`${r.alreadyExisted} already existed`);
    if (r.skippedNoEmail > 0) parts.push(`${r.skippedNoEmail} skipped (no email)`);
    if (excludedCount > 0) parts.push(`${excludedCount} left as new`);
    toast(
      r.statusUpdateFailed
        ? `${parts.join(', ')} — but the leads could not be marked as added. Re-check before moving them again.`
        : `${parts.join(', ')} — ${r.movedIds.length} lead${r.movedIds.length !== 1 ? 's' : ''} marked as added to outreach.`,
      r.statusUpdateFailed ? 'error' : 'success',
    );
    setSelected(new Set());
    await reload();
    app.loadContacts().catch(() => { /* the Contacts page will fetch on visit */ });
  };

  const confirmDelete = async (l: Lead) => {
    if (!confirm(`Delete ${l.authorName}${l.email ? ` (${l.email})` : ''}?\nRe-uploading the same file will bring this lead back.`)) return;
    try {
      await deleteLeadApi(l.id);
      setSelected(prev => { const n = new Set(prev); n.delete(l.id); return n; });
      toast('Lead deleted.', 'success');
      await reload();
    } catch (err: any) { toast(err.message, 'error'); }
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} lead${selected.size !== 1 ? 's' : ''}?\nRe-uploading the same file will bring them back.`)) return;
    try {
      const { deleted } = await deleteLeadsApi([...selected]);
      setSelected(new Set());
      toast(`${deleted} lead${deleted !== 1 ? 's' : ''} deleted.`, 'success');
      resetPage();
      await reload();
    } catch (err: any) { toast('Could not delete leads: ' + err.message, 'error'); }
  };

  // Row click opens the full record — but never when the click landed on a
  // control (checkbox, link, delete button) that has its own behaviour.
  const openDetail = (lead: Lead, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button, input')) return;
    setDetail(lead);
  };

  // "Move to outreach" from the detail view acts on that one lead.
  const moveOne = (lead: Lead) => {
    setDetail(null);
    setSelected(new Set([lead.id]));
    setMoveOpen(true);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const busy = loading && leads.length === 0;

  return (
    <Layout
      title="Leads"
      subtitle={`${stats.total} staged · ${stats.fresh} new · ${stats.moved} in outreach · ${stats.withoutEmail} without an email`}
      actions={
        <>
          <Link to="/contacts" className="btn btn-sm"><i className="ti ti-users" /> Contacts</Link>
          <button className="btn btn-primary" type="button" onClick={() => setShowImport(v => !v)}>
            <i className={showImport ? 'ti ti-x' : 'ti ti-file-code'} /> {showImport ? 'Close import' : 'Import leads'}
          </button>
        </>
      }
    >
      {showImport && (
        <div className="section" style={{ marginBottom: 18 }}>
          <div className="section-head">
            <span className="section-title">Import harvester JSON</span>
          </div>

          <div className="upload-zone"
            style={dragOver ? { borderColor: 'var(--accent)', background: 'var(--accent-bg)' } : undefined}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
            <i className="ti ti-file-code" />
            <div className="uz-title">Drop your leads JSON here</div>
            <div className="uz-sub">Reads last_run_leads + all_leads · one row per email address</div>
            <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => fileRef.current?.click()} type="button">
              <i className="ti ti-upload" /> Browse file
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
          </div>

          <div className="divider-or">or paste JSON</div>

          <textarea value={pasted} onChange={e => setPasted(e.target.value)}
            placeholder='{ "all_leads": [ { "author_name": "…", "emails": ["…"], "fit_score": 12 } ] }'
            style={{ width: '100%', minHeight: 140, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }} />
          <button className="btn btn-sm" style={{ marginTop: 10 }} type="button"
            disabled={!pasted.trim()} onClick={() => parseText(pasted, 'pasted JSON')}>
            <i className="ti ti-eye" /> Preview
          </button>

          {preview && (
            <div style={{ marginTop: 22 }}>
              <div className="section-head" style={{ marginBottom: 10 }}>
                <span className="section-title">Preview — {preview.label}</span>
                <span className="contact-count-badge">{preview.summary.uniqueCount} leads</span>
              </div>
              <div className="info-box">
                <i className="ti ti-info-circle" />
                <span>
                  {preview.summary.sourceCount} lead{preview.summary.sourceCount !== 1 ? 's' : ''} in the file →{' '}
                  {preview.summary.explodedCount} email row{preview.summary.explodedCount !== 1 ? 's' : ''} →{' '}
                  <strong>{preview.summary.uniqueCount} unique</strong>{' '}
                  ({preview.summary.withEmail} with an email, {preview.summary.withoutEmail} without) ·{' '}
                  {preview.summary.rejects} hard reject{preview.summary.rejects !== 1 ? 's' : ''}
                  {preview.summary.ignoredCount > 0 ? ` · ${preview.summary.ignoredCount} unusable row(s) ignored` : ''}.
                  Leads already in your store will be skipped on save.
                </span>
              </div>

              <div className="table-card" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr><th>Fit</th><th>Lead</th><th>Email</th><th>Links</th><th>Post</th><th>Source</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 100).map((r, i) => (
                      <tr key={r.dedupeKey + i}>
                        <td style={{ color: isReject(r) ? 'var(--red)' : 'var(--text2)' }}>{r.fitScore}</td>
                        <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>{r.authorName}</td>
                        <td style={{ color: 'var(--text2)' }}>{r.email || <span style={{ color: 'var(--text3)' }}>no email</span>}</td>
                        <td style={{ color: 'var(--text2)' }}>{r.links.length || '—'}</td>
                        <td>{r.postUrl ? <a href={r.postUrl} target="_blank" rel="noopener noreferrer">open</a> : '—'}</td>
                        <td style={{ color: 'var(--text2)' }}>{r.source || '—'}</td>
                      </tr>
                    ))}
                    {preview.rows.length > 100 && (
                      <tr><td colSpan={6} style={{ color: 'var(--text3)' }}>+{preview.rows.length - 100} more not shown</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="step-footer">
                <button className="btn" type="button" onClick={() => setPreview(null)} disabled={saving}>
                  <i className="ti ti-x" /> Discard
                </button>
                <button className="btn btn-primary" type="button" onClick={saveLeads} disabled={saving}>
                  <i className="ti ti-database-import" /> {saving ? 'Saving…' : `Save ${preview.summary.uniqueCount} leads`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="section-head">
        <div className="nav-tabs">
          {TABS.map(([key, label]) => (
            <div key={key} className={`nav-tab${tab === key ? ' active' : ''}`}
              onClick={() => { setTab(key); resetPage(); }}>
              {label}
            </div>
          ))}
        </div>
        <span className="contact-count-badge">{filtered.length} leads</span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input type="text" placeholder="Search name, email or company..." value={search}
          onChange={e => { setSearch(e.target.value); resetPage(); }}
          style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
          <input type="checkbox" checked={hideRejects}
            onChange={e => { setHideRejects(e.target.checked); resetPage(); }} />
          Hide hard rejects ({rejectCount})
        </label>
        <button className="btn btn-sm" type="button" disabled={selectable.length === 0}
          onClick={() => toggleAll(true)}>Select all with email ({selectable.length})</button>
        <button className="btn btn-sm" type="button" disabled={selected.size === 0}
          onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th className="cb-col">
                <input type="checkbox" className="row-cb" checked={allChecked}
                  ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                  onChange={e => toggleAll(e.target.checked)}
                  title="Select all leads with an email" />
              </th>
              <th>Fit</th><th>Lead</th><th>Company</th><th>Links</th><th>Post</th><th>Source</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <SkeletonRows rows={8} cols={9} chipCol={2} />
            ) : error ? (
              <tr><td colSpan={9}><div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div></td></tr>
            ) : paged.length === 0 ? (
              <tr><td colSpan={9}><div className="empty-state">
                <i className="ti ti-target-arrow" />
                {leads.length === 0 ? 'No leads yet — import a harvester JSON to get started' : 'No leads match these filters'}
              </div></td></tr>
            ) : paged.map(l => (
              <tr key={l.id} onClick={e => openDetail(l, e)} style={{ cursor: 'pointer' }}
                title="Click to see everything stored for this lead">
                <td className="cb-col">
                  <input type="checkbox" className="row-cb" checked={selected.has(l.id)}
                    disabled={!l.email}
                    title={l.email ? undefined : 'No email — cannot be moved to outreach'}
                    onChange={e => toggleRow(l.id, e.target.checked)} />
                </td>
                <td style={{ color: isReject(l) ? 'var(--red)' : 'var(--text2)' }}>{l.fitScore}</td>
                <td>
                  <div className="contact-chip">
                    <Avatar name={l.authorName} />
                    <div>
                      <div className="name" style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                        {l.authorUrl
                          ? <a href={l.authorUrl} target="_blank" rel="noopener noreferrer">{l.authorName}</a>
                          : l.authorName}
                      </div>
                      <div className="email">
                        {l.email || <span style={{ color: 'var(--text3)' }}>no email</span>}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{ color: isCompanyDerived(l) ? 'var(--text3)' : 'var(--text2)' }}
                  title={isCompanyDerived(l) ? 'Guessed from the email domain — confirm when you move it to outreach' : undefined}>
                  {deriveCompany(l) || '—'}
                  {isCompanyDerived(l) ? <span style={{ fontStyle: 'italic' }}> ?</span> : null}
                </td>
                <td style={{ color: 'var(--text2)' }}>
                  {l.links.length === 0 ? '—' : (
                    <>
                      <a href={l.links[0]} target="_blank" rel="noopener noreferrer">link</a>
                      {l.links.length > 1 ? ` +${l.links.length - 1}` : ''}
                    </>
                  )}
                </td>
                <td>{l.postUrl ? <a href={l.postUrl} target="_blank" rel="noopener noreferrer">open</a> : '—'}</td>
                <td style={{ color: 'var(--text2)' }}>{l.source || '—'}</td>
                <td><span className={`badge ${LEAD_BADGE_CLASS[l.status]}`}>{LEAD_STATUS_LABELS[l.status]}</span></td>
                <td>
                  <button className="btn btn-sm" onClick={() => confirmDelete(l)} title="Delete lead" type="button">
                    <i className="ti ti-trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="pagination-bar">
          <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} type="button">
            <i className="ti ti-chevron-left" /> Prev
          </button>
          <span className="page-info">Page {safePage} of {totalPages}</span>
          <button className="btn btn-sm" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} type="button">
            Next <i className="ti ti-chevron-right" />
          </button>
        </div>
      )}

      <div className={`bulk-bar${selected.size > 0 ? ' visible' : ''}`}>
        <span className="bb-count">{selected.size} selected</span>
        <button className="btn btn-del" onClick={deleteSelected} type="button"><i className="ti ti-trash" /> Delete</button>
        <button className="btn btn-send" onClick={() => setMoveOpen(true)} type="button" disabled={selectedLeads.length === 0}>
          <i className="ti ti-user-plus" /> Move to outreach
        </button>
      </div>

      {moveOpen && selectedLeads.length > 0 && (
        <MoveToOutreachModal leads={selectedLeads} onClose={() => setMoveOpen(false)} onDone={onMoveDone} />
      )}

      {detail && (
        <LeadDetailModal
          lead={detail}
          allLeads={leads}
          onClose={() => setDetail(null)}
          onMove={moveOne}
          onDelete={async (l) => { setDetail(null); await confirmDelete(l); }}
        />
      )}
    </Layout>
  );
}
