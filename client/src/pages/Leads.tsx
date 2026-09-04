import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import MoveToOutreachModal from '../components/MoveToOutreachModal';
import LeadDetailModal from '../components/LeadDetailModal';
import LeadFilterPanel from '../components/LeadFilterPanel';
import { SkeletonRows } from '../components/Skeleton';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import {
  bulkUpdateLeadsApi, deleteLeadApi, deleteLeadsApi, importLeadsApi, loadLeadsApi,
  loadLeadOutcomesApi,
  type ApplyStatus, type Lead, type LeadFile, type LeadOutcomeMap, type MoveToOutreachResult,
} from '../lib/api';
import { readFileText } from '../lib/csv';
import { hasApplyableLink, leadLinkTypes, LINK_TYPE_META } from '../lib/linkTypes';
import {
  contactBadgeClass, contactStatusLabel, outcomeOf, stageOf, STAGE_BADGE, STAGE_LABELS,
} from '../lib/leadOutcome';
import {
  activeChips, applyLeadFilters, countActive, DEFAULT_FILTERS, tabCounts, TAB_LABELS,
  type LeadFilters, type LeadTab,
} from '../lib/leadFilters';
import {
  APPLY_BADGE_CLASS, APPLY_STATUS_LABELS, APPLY_STATUS_ORDER, isApplyActioned,
} from '../lib/leads';
import {
  deriveCompany, explodeForPreview, isCompanyDerived, isReject,
  summarisePreview, sourceLeadsFromFile,
  LEAD_BADGE_CLASS, LEAD_STATUS_LABELS,
  type PreviewRow, type PreviewSummary,
} from '../lib/leads';

const PAGE_SIZE = 25;

// Vercel rejects serverless request bodies over 4,500,000 bytes at the edge,
// before Express sees them, with a plain-text 413 that apiFetch's res.json()
// cannot parse — so the failure would surface as an opaque SyntaxError. Guard
// below that, and measure BYTES: string length undercounts non-ASCII, and these
// dumps carry emoji in author names.
const MAX_UPLOAD_BYTES = 4_000_000;
const byteLength = (s: string) =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;

const TABS: LeadTab[] = ['all', 'new', 'added-to-outreach', 'direct-apply'];

interface Preview { rows: PreviewRow[]; summary: PreviewSummary; payload: LeadFile; label: string; }

export default function Leads() {
  const app = useApp();
  const toast = useToast();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [outcomes, setOutcomes] = useState<LeadOutcomeMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showImport, setShowImport] = useState(false);
  const [pasted, setPasted] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [filters, setFilters] = useState<LeadFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [detail, setDetail] = useState<Lead | null>(null);
  // Lets the open modal pick up its own refreshed row after a save.
  const leadsRef = useRef<Lead[]>([]);

  const reload = async () => {
    const [rows, out] = await Promise.all([
      loadLeadsApi(),
      // Outcomes are best-effort: the page is still useful without them.
      loadLeadOutcomesApi().catch(() => ({ outcomes: {} as LeadOutcomeMap, count: 0 })),
    ]);
    setLeads(rows);
    leadsRef.current = rows;
    setOutcomes(out.outcomes);
  };

  useEffect(() => {
    reload().catch(err => setError(err.message)).finally(() => setLoading(false));
    app.loadTemplates().catch(() => { /* the modal shows the empty state */ });
  }, []);

  const resetPage = () => setPage(1);

  const counts = useMemo(() => tabCounts(leads), [leads]);
  const rejectCount = useMemo(() => leads.filter(isReject).length, [leads]);
  // No email, but a link you can actually apply through — otherwise invisible,
  // since the checkbox is disabled for every email-less lead.
  const applyableNoEmail = useMemo(
    () => leads.filter(l => !l.email && hasApplyableLink(l)).length, [leads]);

  const stats = useMemo(() => ({
    total: leads.length,
    fresh: leads.filter(l => l.status === 'new').length,
    moved: leads.filter(l => l.status === 'added-to-outreach').length,
    withEmail: leads.filter(l => l.email).length,
    withoutEmail: leads.filter(l => !l.email).length,
    emailed: leads.filter(l => ['emailed', 'replied', 'bounced'].includes(stageOf(outcomeOf(l, outcomes)))).length,
    replied: leads.filter(l => stageOf(outcomeOf(l, outcomes)) === 'replied').length,
    bounced: leads.filter(l => stageOf(outcomeOf(l, outcomes)) === 'bounced').length,
  }), [leads, outcomes]);

  const filtered = useMemo(() => applyLeadFilters(leads, filters, outcomes), [leads, filters, outcomes]);
  const chips = useMemo(() => activeChips(filters), [filters]);
  const activeCount = countActive(filters);

  const setFilter = (patch: Partial<LeadFilters>) => { setFilters(f => ({ ...f, ...patch })); resetPage(); };
  const clearFilters = () => { setFilters(DEFAULT_FILTERS); resetPage(); };
  // Chips clear one filter at a time, back to that field's default.
  const clearOne = (key: keyof LeadFilters) => setFilter({ [key]: DEFAULT_FILTERS[key] } as Partial<LeadFilters>);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Every lead is selectable: email-bearing ones can be moved to outreach, and
  // email-less ones can still be tracked as direct applications.
  const emailable = useMemo(() => filtered.filter(l => !!l.email), [filtered]);
  const allChecked = filtered.length > 0 && filtered.every(l => selected.has(l.id));
  const someChecked = filtered.some(l => selected.has(l.id));

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
      filtered.forEach(l => { if (checked) next.add(l.id); else next.delete(l.id); });
      return next;
    });
  };

  const selectEmailable = () => setSelected(new Set(emailable.map(l => l.id)));

  // ── Import ────────────────────────────────────────────────────────────────

  const parseText = (text: string, label: string) => {
    const bytes = byteLength(text);
    if (bytes > MAX_UPLOAD_BYTES) {
      toast(
        `That JSON is ${(bytes / 1048576).toFixed(1)} MB — uploads are capped at about 4 MB `
        + `(roughly 8,500 leads). Split the file and import it in parts.`,
        'error',
      );
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
      if (r.updated > 0) bits.push(`${r.updated} existing lead${r.updated !== 1 ? 's' : ''} backfilled with search queries`);
      if (r.ignoredRows > 0) bits.push(`${r.ignoredRows} unusable row${r.ignoredRows !== 1 ? 's' : ''} ignored`);
      const suffix = bits.length ? ` · ${bits.join(' · ')}` : '';
      toast(
        r.created.length === 0
          ? `Nothing new saved — all ${r.skipped} were already stored${r.updated > 0 ? `, but ${r.updated} got their search queries backfilled` : ''}.`
          : `${r.created.length} lead${r.created.length !== 1 ? 's' : ''} saved${suffix}.`,
        r.created.length === 0 && r.updated === 0 ? 'info' : 'success',
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

  const setApplyStatusBulk = async (applyStatus: ApplyStatus) => {
    if (selected.size === 0) return;
    const ids = [...selected];
    try {
      await bulkUpdateLeadsApi(ids.map(id => ({ id, applyStatus, note: 'Bulk update' })));
      toast(`${ids.length} lead${ids.length !== 1 ? 's' : ''} marked “${APPLY_STATUS_LABELS[applyStatus]}”.`, 'success');
      setSelected(new Set());
      await reload();
    } catch (err: any) {
      toast('Could not update: ' + err.message, 'error');
    }
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
      subtitle={`${stats.total} staged · ${stats.fresh} new · ${stats.moved} in outreach · ${stats.emailed} emailed · ${stats.replied} replied${stats.bounced ? ` · ${stats.bounced} bounced` : ''}`}
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
            <div className="uz-sub">
              Reads last_run_leads + all_leads · one row per email address · up to ~4 MB per upload
            </div>
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
                    <tr><th>Fit</th><th>Lead</th><th>Email</th><th>Found by</th><th>Links</th><th>Post</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 100).map((r, i) => (
                      <tr key={r.dedupeKey + i}>
                        <td style={{ color: isReject(r) ? 'var(--red)' : 'var(--text2)' }}>{r.fitScore}</td>
                        <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>{r.authorName}</td>
                        <td style={{ color: 'var(--text2)' }}>{r.email || <span style={{ color: 'var(--text3)' }}>no email</span>}</td>
                        <td style={{ color: 'var(--text2)', maxWidth: 190, whiteSpace: 'normal' }}>
                          {r.queries.length === 0 ? '—' : r.queries.join(', ')}
                        </td>
                        <td style={{ color: 'var(--text2)' }}>{r.links.length || '—'}</td>
                        <td>{r.postUrl ? <a href={r.postUrl} target="_blank" rel="noopener noreferrer">open</a> : '—'}</td>
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
          {TABS.map(key => (
            <div key={key} className={`nav-tab${filters.status === key ? ' active' : ''}`}
              onClick={() => setFilter({ status: key })}
              title={key === 'direct-apply' ? 'Leads with a real application link — apply yourself instead of emailing' : undefined}>
              {key === 'direct-apply' && <i className="ti ti-file-check" style={{ marginRight: 4 }} />}
              {TAB_LABELS[key]}
              <span style={{ marginLeft: 5, opacity: 0.6, fontSize: 11 }}>{counts[key]}</span>
            </div>
          ))}
        </div>
        <span className="contact-count-badge">{filtered.length} leads</span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input type="text" placeholder="Search name, email, company, links..." value={filters.search}
          onChange={e => setFilter({ search: e.target.value })}
          style={{ flex: 1, minWidth: 180, maxWidth: 280 }} />
        <div style={{ position: 'relative' }}>
          <button className={`btn btn-sm${showFilters || activeCount > 0 ? ' btn-primary' : ''}`} type="button"
            data-filter-trigger onClick={() => setShowFilters(v => !v)}>
            <i className="ti ti-filter" /> Filters
            {activeCount > 0 && <span className="contact-count-badge" style={{ marginLeft: 6 }}>{activeCount}</span>}
            <i className={`ti ti-chevron-${showFilters ? 'up' : 'down'}`} style={{ marginLeft: 4, fontSize: 12 }} />
          </button>
          {showFilters && (
            <LeadFilterPanel leads={leads} filters={filters} onChange={setFilter}
              onReset={clearFilters} matched={filtered.length} onClose={() => setShowFilters(false)} />
          )}
        </div>
        <button className="btn btn-sm" type="button" disabled={filters.hideRejects}
          onClick={() => setFilter({ hideRejects: true })}
          title="Quick filter — same as the hard-rejects option in Filters">
          Hide rejects ({rejectCount})
        </button>

        <button className="btn btn-sm" type="button" disabled={emailable.length === 0}
          onClick={selectEmailable}>Select emailable ({emailable.length})</button>
        <button className="btn btn-sm" type="button" disabled={selected.size === 0}
          onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>

      {filters.status === 'direct-apply' && (
        <div className="info-box" style={{ marginBottom: 12 }}>
          <i className="ti ti-file-check" />
          <span>
            {counts['direct-apply']} lead{counts['direct-apply'] !== 1 ? 's' : ''} carry a real application
            link (ATS form, job posting or careers page).{' '}
            {applyableNoEmail > 0 && (
              <>
                <strong>{applyableNoEmail}</strong> of them have no email address, so applying is the only way in —{' '}
                <a href="#" onClick={e => { e.preventDefault(); setFilter({ hasEmail: 'no' }); }}>show just those</a>.{' '}
              </>
            )}
            Track progress per lead with the <strong>Application status</strong> filter, or select rows and set it in bulk.
          </span>
        </div>
      )}

      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          {chips.map(c => (
            <button key={c.key} className="btn btn-xs" type="button" onClick={() => clearOne(c.key)}
              title="Remove this filter">
              {c.label} <i className="ti ti-x" style={{ marginLeft: 2 }} />
            </button>
          ))}
          <button className="btn btn-xs" type="button" onClick={clearFilters}
            style={{ color: 'var(--red)', borderColor: 'var(--red-bg)' }}>
            <i className="ti ti-filter-off" /> Clear all
          </button>
        </div>
      )}


      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th className="cb-col">
                <input type="checkbox" className="row-cb" checked={allChecked}
                  ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                  onChange={e => toggleAll(e.target.checked)}
                  title="Select every lead in this view" />
              </th>
              <th>Fit</th><th>Lead</th><th>Company</th><th>Found by</th><th>Links</th><th>Post</th><th>Status</th><th></th>
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
                    title={l.email ? undefined : 'No email — can still be tracked as a direct application'}
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
                <td style={{ color: 'var(--text2)', maxWidth: 190 }}
                  title={(l.queries || []).join('\n') || 'No query recorded'}>
                  {(l.queries || []).length === 0 ? '—' : (
                    <span style={{ whiteSpace: 'normal' }}>
                      {l.queries[0]}
                      {l.queries.length > 1 ? <span style={{ color: 'var(--text3)' }}> +{l.queries.length - 1}</span> : null}
                    </span>
                  )}
                </td>
                <td style={{ color: 'var(--text2)' }}>
                  {l.links.length === 0 ? '—' : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
                      {leadLinkTypes(l).slice(0, 2).map(t => (
                        <span key={t} title={LINK_TYPE_META[t].hint}
                          style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
                            background: t === 'junk' ? 'var(--red-bg)' : 'var(--bg2)',
                            color: t === 'junk' ? 'var(--red)' : 'var(--text2)' }}>
                          <i className={`ti ${LINK_TYPE_META[t].icon}`} /> {LINK_TYPE_META[t].label}
                        </span>
                      ))}
                      {leadLinkTypes(l).length > 2 && (
                        <span style={{ fontSize: 10, color: 'var(--text3)' }}>+{leadLinkTypes(l).length - 2}</span>
                      )}
                      <a href={l.links[0]} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
                        open{l.links.length > 1 ? ` (${l.links.length})` : ''}
                      </a>
                    </div>
                  )}
                </td>
                <td>{l.postUrl ? <a href={l.postUrl} target="_blank" rel="noopener noreferrer">open</a> : '—'}</td>

                <td>
                  {(() => {
                    const o = outcomeOf(l, outcomes);
                    const applyBadge = isApplyActioned(l) ? (
                      <div style={{ marginTop: 3 }}>
                        <span className={`badge ${APPLY_BADGE_CLASS[l.applyStatus]}`} title="Direct application">
                          <i className="ti ti-file-check" /> {APPLY_STATUS_LABELS[l.applyStatus]}
                        </span>
                      </div>
                    ) : null;
                    if (!o) return (
                      <div>
                        <span className={`badge ${LEAD_BADGE_CLASS[l.status]}`}>{LEAD_STATUS_LABELS[l.status]}</span>
                        {applyBadge}
                      </div>
                    );
                    const stage = stageOf(o);
                    return (
                      <div>
                        <span className={`badge ${contactBadgeClass(o.status)}`}
                          title={`In outreach — ${STAGE_LABELS[stage]}`}>
                          {contactStatusLabel(o.status)}
                        </span>
                        {o.repliedAt && (
                          <div style={{ fontSize: 10, color: 'var(--green)', marginTop: 3 }}>
                            <i className="ti ti-corner-down-left" /> replied
                          </div>
                        )}
                        {o.bounceReason && (
                          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 3, maxWidth: 150, whiteSpace: 'normal', lineHeight: 1.3 }}>
                            {o.bounceReason.slice(0, 48)}
                          </div>
                        )}
                        {applyBadge}
                      </div>
                    );
                  })()}
                </td>
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
        <span className="bb-count">
          {selected.size} selected
          {selected.size > selectedLeads.length && (
            <span style={{ fontWeight: 400, opacity: 0.75 }}>
              {' '}· {selectedLeads.length} emailable
            </span>
          )}
        </span>
        <select value="" onChange={e => { if (e.target.value) setApplyStatusBulk(e.target.value as ApplyStatus); e.target.value = ''; }}
          style={{ width: 'auto', minWidth: 165 }} title="Set the direct-application status">
          <option value="">Set application status…</option>
          {APPLY_STATUS_ORDER.map(a => <option key={a} value={a}>{APPLY_STATUS_LABELS[a]}</option>)}
        </select>
        <button className="btn btn-del" onClick={deleteSelected} type="button"><i className="ti ti-trash" /> Delete</button>
        <button className="btn btn-send" onClick={() => setMoveOpen(true)} type="button" disabled={selectedLeads.length === 0}
          title={selectedLeads.length === 0 ? 'None of the selected leads have an email address' : undefined}>
          <i className="ti ti-user-plus" /> Move to outreach{selected.size > selectedLeads.length ? ` (${selectedLeads.length})` : ''}
        </button>
      </div>

      {moveOpen && selectedLeads.length > 0 && (
        <MoveToOutreachModal leads={selectedLeads} onClose={() => setMoveOpen(false)} onDone={onMoveDone} />
      )}

      {detail && (
        <LeadDetailModal
          lead={detail}
          allLeads={leads}
          outcome={outcomeOf(detail, outcomes)}
          onSaved={async () => {
            await reload();
            setDetail(d => (d ? leadsRef.current.find(x => x.id === d.id) || d : d));
            toast('Application status saved.', 'success');
          }}
          onClose={() => setDetail(null)}
          onMove={moveOne}
          onDelete={async (l) => { setDetail(null); await confirmDelete(l); }}
        />
      )}
    </Layout>
  );
}
