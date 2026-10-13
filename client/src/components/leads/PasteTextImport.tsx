import { useMemo, useRef, useState } from 'react';
import { importLeadsApi, pastePreviewApi, type PasteLead, type PastePreview } from '../../lib/api';
import { readFileText } from '../../lib/csv';
import { isReject } from '../../lib/leads';
import { useToast } from '../../context/ToastContext';

// Paste anything with job posts in it — a WhatsApp or Telegram export, a newsletter,
// a post — and get one row per email. The server reads it (POST
// /api/sources/paste/preview) and saves nothing; the rows you keep go through the
// ordinary leads import, so they dedupe and land on the board like any harvest.

const MAX_CHARS = 300 * 1024;

const rowKey = (l: PasteLead) => l.author_url || l.emails.join(',');

export default function PasteTextImport({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PastePreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const find = async () => {
    setReading(true);
    try {
      const p = await pastePreviewApi(text);
      setPreview(p);
      // Ticked by default: good fit and not already on the board.
      setPicked(new Set(p.leads.filter(l => !isReject({ fitScore: l.fit_score }) && l.existing.length < l.emails.length).map(rowKey)));
      if (!p.leads.length) toast('No emails found in that text.', 'info');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setReading(false);
    }
  };

  const onFile = async (file: File) => {
    try { setText((await readFileText(file)).slice(0, MAX_CHARS)); setPreview(null); }
    catch (err: any) { toast('Could not read that file: ' + err.message, 'error'); }
  };

  const counts = useMemo(() => {
    const leads = preview?.leads || [];
    return {
      emails: leads.reduce((n, l) => n + l.emails.length, 0),
      existing: leads.reduce((n, l) => n + l.existing.length, 0),
      rejected: leads.filter(l => isReject({ fitScore: l.fit_score })).length,
    };
  }, [preview]);

  const toggle = (k: string, on: boolean) => setPicked(prev => {
    const next = new Set(prev);
    if (on) next.add(k); else next.delete(k);
    return next;
  });

  const save = async () => {
    if (!preview) return;
    const rows = preview.leads.filter(l => picked.has(rowKey(l)))
      .map(({ fit_reasons, existing, ...lead }) => lead);
    if (!rows.length) return;
    setSaving(true);
    try {
      const r = await importLeadsApi(rows);
      toast(
        r.created.length
          ? `${r.created.length} lead${r.created.length !== 1 ? 's' : ''} saved${r.skipped ? ` · ${r.skipped} already on your board` : ''}.`
          : 'Nothing new — they were all on your board already.',
        r.created.length ? 'success' : 'info',
      );
      setPreview(null);
      setText('');
      await onSaved();
    } catch (err: any) {
      toast('Could not save leads: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="uz-sub" style={{ marginBottom: 8 }}>
        Paste a WhatsApp or Telegram export, a newsletter, or any job posts. Every email in it becomes a row;
        the message around it tells us the company and role. Emails come from the text itself, never guessed.
      </div>
      <textarea value={text} onChange={e => { setText(e.target.value.slice(0, MAX_CHARS)); }}
        placeholder={'[12/10/26, 9:41 PM] Ravi: We are hiring React developers in Pune.\nShare your CV at hr@acme.in'}
        style={{ width: '100%', minHeight: 160, fontSize: 12.5 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" type="button" disabled={!text.trim() || reading} onClick={find}>
          <i className={reading ? 'ti ti-loader-2 tc-spin' : 'ti ti-mail-search'} /> {reading ? 'Reading…' : 'Find emails'}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => fileRef.current?.click()}>
          <i className="ti ti-upload" /> Upload .txt
        </button>
        <input ref={fileRef} type="file" accept=".txt,text/plain" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
          {Math.round(text.length / 1024)} KB of {MAX_CHARS / 1024} KB
        </span>
      </div>

      {preview && preview.leads.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="info-box">
            <i className="ti ti-info-circle" />
            <span>
              <strong>{counts.emails} email{counts.emails !== 1 ? 's' : ''}</strong> in {preview.leads.length} message{preview.leads.length !== 1 ? 's' : ''}
              {counts.existing ? ` · ${counts.existing} already on your board` : ''}
              {counts.rejected ? ` · ${counts.rejected} rejected (not hiring, a job seeker, or outside your target) — unticked` : ''}
              {preview.deadDomains.length ? ` · dropped ${preview.deadDomains.length} domain${preview.deadDomains.length !== 1 ? 's' : ''} that can't receive mail (${preview.deadDomains.slice(0, 3).join(', ')})` : ''}
              {preview.skippedChunks ? ` · only the first ${preview.chunks} messages with an email were read — paste the rest separately` : ''}
              {preview.truncated ? ' · the text was cut at 300 KB' : ''}
              .
            </span>
          </div>
          {preview.aiError && (
            <div className="info-box" style={{ marginTop: 8 }}>
              <i className="ti ti-alert-triangle" />
              <span>AI is busy, so company and role weren't read for some rows ({preview.aiError}). The emails are still right.</span>
            </div>
          )}

          <div className="table-card" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr><th /><th>Fit</th><th>Email</th><th>Company</th><th>Role</th><th>Location</th><th>Text it came from</th></tr>
              </thead>
              <tbody>
                {preview.leads.map(l => {
                  const k = rowKey(l);
                  const reject = isReject({ fitScore: l.fit_score });
                  return (
                    <tr key={k} style={reject ? { opacity: 0.6 } : undefined}>
                      <td><input type="checkbox" checked={picked.has(k)} onChange={e => toggle(k, e.target.checked)} aria-label="Keep this row" /></td>
                      <td style={{ color: reject ? 'var(--red)' : 'var(--text2)' }} title={l.fit_reasons.join(' · ')}>{l.fit_score}</td>
                      <td style={{ whiteSpace: 'normal' }}>
                        {l.emails.map(e => (
                          <div key={e}>{e}{l.existing.includes(e) && <span style={{ color: 'var(--text3)', fontSize: 11 }}> · on board</span>}</div>
                        ))}
                      </td>
                      <td>{l.company || <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 180 }}>{l.role || <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                      <td>{l.location || <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                      <td><div className="src-row-text">
                        {reject && <strong style={{ color: 'var(--red)' }}>{l.fit_reasons[0]} · </strong>}
                        {(l.snippet || '').slice(0, 180)}{(l.snippet || '').length > 180 ? '…' : ''}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="step-footer">
            <button className="btn" type="button" onClick={() => setPreview(null)} disabled={saving}>
              <i className="ti ti-x" /> Discard
            </button>
            <button className="btn btn-primary" type="button" onClick={save} disabled={saving || picked.size === 0}>
              <i className="ti ti-database-import" /> {saving ? 'Saving…' : `Save ${picked.size} lead${picked.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
