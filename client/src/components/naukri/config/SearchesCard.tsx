import { useState } from 'react';
import type { NaukriConfig, NaukriSearch } from '../../../lib/api';
import { Card } from '../ui';
import { updateNaukriConfigApi } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

// What the harvest walks.
//
// Keywords + location build a Naukri slug URL (backend-developer-jobs-in-
// bangalore). The URL field is the escape hatch: paste a search you built on
// Naukri itself and it is used verbatim, which is the only way to express a
// filter combination this form does not model.

const blank = (): NaukriSearch => ({
  label: '', keywords: '', location: '', experienceYears: null, url: '', enabled: true,
});

export default function SearchesCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [rows, setRows] = useState<NaukriSearch[]>(config.searches.length ? config.searches : [blank()]);
  const toast = useToast();
  const [useRecommended, setUseRecommended] = useState(config.useRecommended);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const patch = (i: number, p: Partial<NaukriSearch>) =>
    setRows(r => r.map((row, n) => (n === i ? { ...row, ...p } : row)));

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      // Rows with neither keywords nor a URL are dropped server-side; say so
      // rather than letting them vanish silently.
      const usable = rows.filter(r => r.keywords.trim() || r.url.trim());
      await updateNaukriConfigApi({ searches: usable, useRecommended });
      setRows(usable.length ? usable : [blank()]);
      { toast(`Saved ${usable.length} search${usable.length === 1 ? '' : 'es'}.`, 'success'); setMsg(`Saved ${usable.length} search${usable.length === 1 ? '' : 'es'}.`); };
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  return (
    <Card title="Searches" icon="ti-search" collapsible id="searches" defaultOpen={false}
      right={<button className="btn btn-xs" type="button" onClick={() => setRows(r => [...r, blank()])}>
        <i className="ti ti-plus" /> Add
      </button>}>

      {rows.map((row, i) => (
        <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="text"
              placeholder="Label (optional)" value={row.label}
              onChange={e => patch(i, { label: e.target.value })} style={{ width: 140 }}
            />
            <input type="text"
              placeholder="Keywords, e.g. backend developer" value={row.keywords}
              onChange={e => patch(i, { keywords: e.target.value })} style={{ flex: 1, minWidth: 180 }}
            />
            <input type="text"
              placeholder="Location" value={row.location}
              onChange={e => patch(i, { location: e.target.value })} style={{ width: 130 }}
            />
            <input
              type="number" min={0} max={50} placeholder="Exp"
              value={row.experienceYears ?? ''}
              onChange={e => patch(i, { experienceYears: e.target.value === '' ? null : Number(e.target.value) })}
              style={{ width: 70 }}
            />
            <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={row.enabled} onChange={e => patch(i, { enabled: e.target.checked })} />
              on
            </label>
            <button className="btn btn-sm" onClick={() => setRows(r => r.filter((_, n) => n !== i))}>
              <i className="ti ti-trash" />
            </button>
          </div>
          <input type="text"
            placeholder="…or paste a Naukri search URL (overrides the fields above)"
            value={row.url} onChange={e => patch(i, { url: e.target.value })}
            style={{ width: '100%', marginTop: 6, fontSize: 12 }}
          />
        </div>
      ))}

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '12px 0' }}>
        <input type="checkbox" checked={useRecommended} onChange={e => setUseRecommended(e.target.checked)} />
        Also walk Naukri&apos;s recommended jobs
      </label>

      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save searches'}
      </button>
    </Card>
  );
}
