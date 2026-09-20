import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { useToast } from '../context/ToastContext';
import { CardSkeleton } from '../components/Skeleton';
import {
  type BlocklistEntry, loadBlocklistApi, createBlocklistEntryApi, deleteBlocklistEntryApi,
} from '../lib/api';

export default function Blocklist() {
  const toast = useToast();
  const [entries, setEntries] = useState<BlocklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    loadBlocklistApi().then(setEntries).catch(err => setError(err.message)).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const add = async () => {
    const v = value.trim();
    if (!v) {
      toast('Enter an email address or a domain to block.', 'error');
      return;
    }
    setSaving(true);
    try {
      const entry = await createBlocklistEntryApi({ value: v, reason: reason.trim() });
      setEntries(prev => [entry, ...prev]);
      setValue(''); setReason('');
      toast(`Blocked ${entry.type === 'domain' ? 'domain' : 'address'} ${entry.value}.`, 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: BlocklistEntry) => {
    if (!confirm(`Remove "${entry.value}" from the blocklist?`)) return;
    try {
      await deleteBlocklistEntryApi(entry.id);
      setEntries(prev => prev.filter(e => e.id !== entry.id));
      toast('Removed from blocklist.', 'success');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  return (
    <Layout title="Blocklist" subtitle="Emails and company domains that will never be sent to">
      <div className="info-box" style={{ marginBottom: 16 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }} />
        <div>
          Add a single email address to block just that person, or a domain (e.g. <code style={{ background: 'var(--bg2)', padding: '1px 4px', borderRadius: 3 }}>acme.com</code>) to block everyone at that company. Blocklisted sends are skipped automatically and the contact's prior status is restored.
        </div>
      </div>

      <div className="form-group" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label className="form-label">Email or domain</label>
          <input type="text" value={value} onChange={e => setValue(e.target.value)}
            placeholder="jane@acme.com or acme.com"
            onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        </div>
        <div style={{ flex: '1 1 220px' }}>
          <label className="form-label">Reason (optional)</label>
          <input type="text" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Currently contracting for them"
            onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        </div>
        <button className="btn btn-primary" type="button" onClick={add} disabled={saving}>
          {saving ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> Adding…</> : <><i className="ti ti-ban" /> Add to blocklist</>}
        </button>
      </div>

      {loading ? (
        <>{Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)}</>
      ) : error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : entries.length === 0 ? (
        <div className="empty-state"><i className="ti ti-ban" />Nothing blocked yet.</div>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Value</th>
                <th>Reason</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td><span className="badge badge-queued">{e.type}</span></td>
                  <td>{e.value}</td>
                  <td style={{ color: 'var(--text2)' }}>{e.reason || '—'}</td>
                  <td style={{ color: 'var(--text2)' }}>{new Date(e.createdAt).toLocaleDateString()}</td>
                  <td>
                    <button aria-label="Remove" className="btn btn-xs btn-danger-ghost"
                      onClick={() => remove(e)} title="Remove" type="button">
                      <i className="ti ti-trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}
