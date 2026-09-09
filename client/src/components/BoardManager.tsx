import { useState } from 'react';
import type { BoardPreview, BoardSource, JobBoard, Lead, Posting } from '../lib/api';
import { createBoardApi, deleteBoardApi, previewBoardApi, updateBoardApi } from '../lib/api';
import { useToast } from '../context/ToastContext';
import {
  BOARD_STATUS_BADGE, BOARD_STATUS_LABELS, boardLabel, relativeTime,
  SOURCE_BOARD_URL, SOURCE_LABELS, SOURCE_TOKEN_HINT, suggestedBoardsFromLeads,
} from '../lib/postings';

const SOURCES: BoardSource[] = ['greenhouse', 'lever', 'ashby'];

export default function BoardManager({ boards, postings, leads, onChanged, onSyncBoard, syncing }: {
  boards: JobBoard[];
  postings: Posting[];
  leads: Lead[];
  onChanged: () => Promise<void> | void;
  onSyncBoard: (id: string) => Promise<void>;
  syncing: boolean;
}) {
  const toast = useToast();
  const [source, setSource] = useState<BoardSource>('greenhouse');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState<BoardPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);

  const suggestions = suggestedBoardsFromLeads(leads, boards);

  // Counts per board, so a board with zero open roles is visible as such.
  const countFor = (b: JobBoard) => {
    const mine = postings.filter(p => p.source === b.source && p.boardToken === b.token);
    return { open: mine.filter(p => p.listingStatus === 'open').length, total: mine.length };
  };

  const check = async () => {
    if (!token.trim()) return;
    setChecking(true);
    setPreview(null);
    try {
      const p = await previewBoardApi({ source, token: token.trim() });
      setPreview(p);
      // Greenhouse is the only source that names the company; for the others
      // this is the slug title-cased, which is the honest best guess.
      if (p.kind === 'ok' && !label.trim()) setLabel(p.suggestedLabel);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not check that board', 'error');
    } finally {
      setChecking(false);
    }
  };

  const add = async (src: BoardSource, tok: string, lab?: string) => {
    setAdding(true);
    try {
      const res = await createBoardApi({ source: src, token: tok, label: lab });
      toast(res.revived ? `Re-added ${boardLabel(res.board)}.` : `Added ${boardLabel(res.board)}.`, 'success');
      setToken(''); setLabel(''); setPreview(null);
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add that board', 'error');
    } finally {
      setAdding(false);
    }
  };

  const toggleEnabled = async (b: JobBoard) => {
    try {
      await updateBoardApi(b.id, { enabled: !b.enabled });
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update that board', 'error');
    }
  };

  const remove = async (b: JobBoard) => {
    const { total } = countFor(b);
    // Postings may carry your application history, which is yours and unrelated
    // to whether you still watch the board — so keeping them is the default.
    const alsoDelete = total > 0 && window.confirm(
      `Stop tracking ${boardLabel(b)}.\n\n` +
      `It has ${total} posting${total === 1 ? '' : 's'}.\n\n` +
      `OK  = also delete those postings (loses any application status on them)\n` +
      `Cancel = keep them`
    );
    try {
      const res = await deleteBoardApi(b.id, alsoDelete ? 'delete' : 'keep');
      toast(
        alsoDelete
          ? `Removed ${boardLabel(b)} and ${res.postingsDeleted} postings.`
          : `Removed ${boardLabel(b)}; its postings were kept.`,
        'success',
      );
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove that board', 'error');
    }
  };

  return (
    <div className="section" style={{ marginBottom: 16 }}>
      <div className="section-head">
        <div>
          <h2 style={{ fontSize: 14, margin: 0 }}>Boards</h2>
          <p style={{ fontSize: 12, color: 'var(--text2)', margin: '2px 0 0' }}>
            Public job boards to watch. No API keys, nothing to sign up for.
          </p>
        </div>
        <span className="contact-count-badge">{boards.length} tracked</span>
      </div>

      {boards.length > 0 && (
        <div className="table-card" style={{ marginBottom: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Board</th><th>Source</th><th>Postings</th><th>Last sync</th><th>On</th><th></th>
              </tr>
            </thead>
            <tbody>
              {boards.map(b => {
                const { open, total } = countFor(b);
                const url = SOURCE_BOARD_URL[b.source]?.(b.token);
                return (
                  <tr key={b.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{boardLabel(b)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                        {url
                          ? <a href={url} target="_blank" rel="noopener noreferrer">{b.token}</a>
                          : b.token}
                      </div>
                    </td>
                    <td>{SOURCE_LABELS[b.source]}</td>
                    <td>
                      {open} open
                      {total !== open && (
                        <span style={{ color: 'var(--text3)', fontSize: 11 }}> / {total} total</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${BOARD_STATUS_BADGE[b.lastSyncStatus]}`}>
                        {BOARD_STATUS_LABELS[b.lastSyncStatus]}
                      </span>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                        {relativeTime(b.lastSyncAt)}
                      </div>
                      {b.lastError && (
                        <div style={{
                          fontSize: 10, color: 'var(--red)', marginTop: 3,
                          maxWidth: 200, whiteSpace: 'normal', lineHeight: 1.3,
                        }}>
                          {b.lastError}
                          {b.consecutiveFailures >= 3 &&
                            ` · failed ${b.consecutiveFailures} times in a row`}
                        </div>
                      )}
                    </td>
                    <td>
                      <input type="checkbox" checked={b.enabled} onChange={() => toggleEnabled(b)}
                        title={b.enabled ? 'Included in syncs' : 'Skipped by syncs'} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" type="button" disabled={syncing || !b.enabled}
                        onClick={() => onSyncBoard(b.id)} title="Sync just this board">
                        <i className="ti ti-refresh" />
                      </button>
                      <button className="btn btn-sm" type="button" onClick={() => remove(b)}
                        title="Stop tracking this board" style={{ marginLeft: 4 }}>
                        <i className="ti ti-trash" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="info-box" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
          <i className="ti ti-wand" style={{ marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ marginBottom: 6 }}>
              Found {suggestions.length} board{suggestions.length === 1 ? '' : 's'} in your leads' apply links.
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {suggestions.slice(0, 12).map(s => (
                <button key={`${s.source}:${s.token}`} className="btn btn-xs" type="button" disabled={adding}
                  onClick={() => add(s.source, s.token)}
                  title={`Seen in ${s.n} lead${s.n === 1 ? '' : 's'}`}>
                  <i className="ti ti-plus" /> {SOURCE_LABELS[s.source]}: {s.token} ({s.n})
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">Source</label>
          <select value={source} onChange={e => { setSource(e.target.value as BoardSource); setPreview(null); }}>
            {SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Board token</label>
          <input type="text" placeholder={source === 'lever' ? 'leverdemo' : source === 'ashby' ? 'ashby' : 'stripe'}
            value={token}
            onChange={e => { setToken(e.target.value); setPreview(null); }}
            onKeyDown={e => { if (e.key === 'Enter') check(); }} />
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>
            {SOURCE_TOKEN_HINT[source]} — pasting the whole board URL works too.
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">
            Label{source !== 'greenhouse' && <span style={{ color: 'var(--text3)' }}> (shown as the company)</span>}
          </label>
          <input type="text" placeholder="Optional" value={label} onChange={e => setLabel(e.target.value)} />
        </div>
        <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button className="btn btn-sm" type="button" onClick={check} disabled={checking || !token.trim()}>
            <i className={`ti ti-${checking ? 'loader' : 'search'}`} /> {checking ? 'Checking…' : 'Check'}
          </button>
          <button className="btn btn-sm btn-primary" type="button" disabled={adding || !token.trim()}
            onClick={() => add(source, token.trim(), label.trim() || undefined)}>
            <i className="ti ti-plus" /> Add board
          </button>
        </div>
      </div>

      {preview && (
        <div className="info-box" style={{ marginTop: 10, alignItems: 'flex-start' }}>
          <i className={`ti ti-${preview.kind === 'ok' ? 'check' : preview.kind === 'empty' ? 'info-circle' : 'alert-triangle'}`}
            style={{ marginTop: 2, color: preview.kind === 'ok' ? 'var(--green)' : preview.kind === 'empty' ? undefined : 'var(--red)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {preview.kind === 'ok' && (
              <>
                <div>
                  <strong>{SOURCE_LABELS[source]} · {preview.token}</strong> — {preview.count} posting
                  {preview.count === 1 ? '' : 's'} listed.
                  {preview.filtered > 0 && (
                    <span style={{ color: 'var(--text3)' }}> ({preview.filtered} unlisted, skipped)</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                  e.g. {preview.sample.map(s => s.title + (s.location ? ` (${s.location})` : '')).join(' · ')}
                </div>
              </>
            )}
            {preview.kind === 'empty' && (
              <div>
                <strong>{preview.token}</strong> is a real board but lists nothing right now. You can still add
                it — the sync will pick roles up when they appear.
              </div>
            )}
            {(preview.kind === 'not-found' || preview.kind === 'error') && (
              <div style={{ color: 'var(--red)' }}>
                {preview.error || 'Could not read that board'}
                {preview.kind === 'not-found' && (
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                    Check the slug in the board's own URL — {SOURCE_TOKEN_HINT[source]}.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
