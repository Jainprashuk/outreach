import { useEffect, useState } from 'react';
import type { CriteriaTestResult, JobCriteria } from '../lib/api';
import { loadCriteriaApi, saveCriteriaApi, testCriteriaApi } from '../lib/api';
import { useToast } from '../context/ToastContext';

const toText = (list: string[]) => (list || []).join(', ');
const toList = (text: string) =>
  text.split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

/**
 * "What I actually want." Applied when a sync decides what to STORE, so a
 * 600-role board only keeps roles you'd read.
 *
 * It never affects what EXISTS: a posting excluded here is still open at the
 * company, and the sync knows that — it refreshes the posting's lastSeenAt so
 * the close pass can't mistake "you don't want it" for "it's gone".
 */
export default function CriteriaPanel({ onSaved, onClose }: {
  onSaved: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [criteria, setCriteria] = useState<JobCriteria | null>(null);
  const [includeText, setIncludeText] = useState('');
  const [excludeText, setExcludeText] = useState('');
  const [locationsText, setLocationsText] = useState('');
  const [test, setTest] = useState<CriteriaTestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadCriteriaApi()
      .then(({ criteria: c }) => {
        setCriteria(c);
        setIncludeText(toText(c.include));
        setExcludeText(toText(c.exclude));
        setLocationsText(toText(c.locations));
      })
      .catch(err => toast(err instanceof Error ? err.message : 'Could not load criteria', 'error'));
  }, []);

  if (!criteria) {
    return (
      <div className="section" style={{ marginBottom: 16 }}>
        <i className="ti ti-loader" /> Loading your criteria…
      </div>
    );
  }

  const current = (): JobCriteria => ({
    enabled: criteria.enabled,
    include: toList(includeText),
    exclude: toList(excludeText),
    locations: toList(locationsText),
    remoteOnly: criteria.remoteOnly,
  });

  const runTest = async () => {
    setBusy(true);
    try {
      setTest(await testCriteriaApi(current()));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not test', 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const { criteria: saved } = await saveCriteriaApi(current());
      setCriteria(saved);
      toast(saved.enabled
        ? 'Criteria saved — the next sync will only keep matching roles.'
        : 'Criteria saved (currently off, so everything is kept).', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section" style={{ marginBottom: 16 }}>
      <div className="section-head">
        <div>
          <h2 style={{ fontSize: 14, margin: 0 }}>What I'm looking for</h2>
          <p style={{ fontSize: 12, color: 'var(--text2)', margin: '2px 0 0' }}>
            Filters what a sync <strong>stores</strong>. A board with 600 roles only keeps the ones that match.
          </p>
        </div>
        <button className="btn btn-xs" type="button" onClick={onClose}><i className="ti ti-x" /></button>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 12 }}>
        <input type="checkbox" checked={criteria.enabled}
          onChange={e => setCriteria({ ...criteria, enabled: e.target.checked })} />
        <span>
          <strong>Filter my syncs</strong>
          <span style={{ color: 'var(--text3)' }}>
            {' '}— off means every role from every board is stored
          </span>
        </span>
      </label>

      <div className="form-grid">
        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label className="form-label">Role must mention any of these</label>
          <textarea value={includeText} onChange={e => setIncludeText(e.target.value)} rows={3}
            placeholder="engineer, backend, machine learning…" style={{ width: '100%', fontSize: 12 }} />
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>
            Comma or newline separated. Matched against the <strong>job title only</strong> — matching the
            department too is circular, since a search sets it to the category you searched for.
            Leave empty to accept any role.
          </div>
        </div>

        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label className="form-label">…but never if it mentions any of these</label>
          <textarea value={excludeText} onChange={e => setExcludeText(e.target.value)} rows={2}
            placeholder="sales, recruiter, marketing…" style={{ width: '100%', fontSize: 12 }} />
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>
            Checked against the title <em>and</em> the department/team, and it <strong>wins</strong> over the
            list above — so “Solution Engineer (Pre-Sales)”, and anything in a Sales org, is dropped.
            Remove “sales” if you'd rather keep those.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Locations (optional)</label>
          <input type="text" value={locationsText} onChange={e => setLocationsText(e.target.value)}
            placeholder="india, bangalore, london" />
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>
            Remote roles always pass — they're open to you wherever you are.
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Remote</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', paddingTop: 6 }}>
            <input type="checkbox" checked={criteria.remoteOnly}
              onChange={e => setCriteria({ ...criteria, remoteOnly: e.target.checked })} />
            Remote roles only
          </label>
        </div>
      </div>

      {test && (
        <div className="info-box" style={{ marginTop: 10, alignItems: 'flex-start' }}>
          <i className="ti ti-flask" style={{ marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>
              Against the {test.total} postings you already have: <strong>{test.kept} kept</strong>,
              {' '}{test.dropped} dropped.
            </div>
            {test.keptSample.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                <strong>Keeps:</strong> {test.keptSample.slice(0, 5).join(' · ')}
              </div>
            )}
            {test.droppedSample.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                <strong>Drops:</strong> {test.droppedSample.slice(0, 5).join(' · ')}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
              This is a preview only — nothing was deleted. Existing postings stay until you remove them;
              the filter applies to what future syncs store.
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn-sm" type="button" onClick={runTest} disabled={busy}>
          <i className="ti ti-flask" /> Test on what I have
        </button>
        <button className="btn btn-sm btn-primary" type="button" onClick={save} disabled={busy}
          style={{ marginLeft: 'auto' }}>
          <i className="ti ti-check" /> Save criteria
        </button>
      </div>
    </div>
  );
}
