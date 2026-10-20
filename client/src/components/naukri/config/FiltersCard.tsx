import { useState } from 'react';
import type { NaukriConfig, NaukriFilters } from '../../../lib/api';
import { usePlatform } from '../platform';
import { Card } from '../ui';
import { updateNaukriConfigApi, previewNaukriFiltersApi } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

// What never reaches your review queue.
//
// The preview is the point of this card. A filter you cannot see the effect of
// is one you stop trusting, and then you stop using the review queue at all — so
// "Preview" replays these rules against what your last harvest actually saw,
// through the same lib the worker uses, and names the jobs it would drop.

const toList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
const toText = (a: string[]) => (a || []).join(', ');

export default function FiltersCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const { label: site } = usePlatform();
  const [f, setF] = useState<NaukriFilters>(config.filters);
  // Inbox tidy: clears jobs waiting for review that nobody will apply to.
  const [tidy, setTidy] = useState(config.inboxTidy || { enabled: false, maxAgeDays: 21, minScore: 40, companySite: false });
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState<{
    counts: { total: number; kept: number; dropped: number };
    examples: Array<{ title: string; company: string; reason: string }>;
  } | null>(null);

  const set = <K extends keyof NaukriFilters>(k: K, v: NaukriFilters[K]) => {
    setF(x => ({ ...x, [k]: v }));
    setPreview(null);   // a stale preview is worse than none
  };

  const num = (v: string) => (v === '' ? null : Number(v));

  const runPreview = async () => {
    setMsg('');
    try { setPreview(await previewNaukriFiltersApi(f)); }
    catch (e: any) { toast(e?.message || 'Could not preview', 'error'); setMsg(e?.message || 'Could not preview'); }
  };

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const r = await updateNaukriConfigApi({ filters: f, inboxTidy: tidy });
      const text = r.tidied ? `Saved — ${r.tidied} job${r.tidied === 1 ? '' : 's'} tidied out of the inbox.` : 'Saved.';
      toast(text, 'success'); setMsg(text); onSaved();
    }
    catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  const Text = ({ label, k, help }: { label: string; k: keyof NaukriFilters; help?: string }) => (
    <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
      <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <input type="text"
        style={{ width: '100%' }}
        value={toText(f[k] as string[])}
        onChange={e => set(k, toList(e.target.value) as NaukriFilters[typeof k])}
        placeholder="comma separated"
      />
      {help && <div style={{ color: 'var(--text2)', fontSize: 11, marginTop: 2 }}>{help}</div>}
    </label>
  );

  return (
    <Card title="Filters" icon="ti-filter" collapsible id="filters" defaultOpen={false} scope="site">

      <Text label="Title must contain one of" k="titleInclude" help="Empty means any title." />
      <Text label="Title must NOT contain" k="titleExclude" />
      <Text label="Never show these companies" k="companyExclude" />
      <Text label="Locations" k="locations" help="Empty means anywhere." />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Min exp (yrs)</div>
          <input type="number" min={0} max={50} style={{ width: 90 }}
            value={f.minExperienceYears ?? ''} onChange={e => set('minExperienceYears', num(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Max exp (yrs)</div>
          <input type="number" min={0} max={50} style={{ width: 90 }}
            value={f.maxExperienceYears ?? ''} onChange={e => set('maxExperienceYears', num(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Min salary (LPA)</div>
          <input type="number" min={0} style={{ width: 110 }}
            value={f.minSalaryLpa ?? ''} onChange={e => set('minSalaryLpa', num(e.target.value))} />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Max age (days)</div>
          <input type="number" min={1} max={365} style={{ width: 100 }}
            value={f.maxPostedAgeDays ?? ''} onChange={e => set('maxPostedAgeDays', num(e.target.value))} />
        </label>
      </div>
      <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 10 }}>
        Experience bands are kept when they overlap yours at all. Listings that do not publish pay are
        kept — most of {site} hides it, and dropping them would empty your queue.
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 6 }}>
        <input type="checkbox" checked={f.remoteOnly} onChange={e => set('remoteOnly', e.target.checked)} />
        Remote only
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={f.skipAlreadyApplied} onChange={e => set('skipAlreadyApplied', e.target.checked)} />
        Skip jobs {site} says you already applied to
      </label>

      {preview && (
        <div style={{ padding: 10, background: 'var(--bg2)', borderRadius: 6, marginBottom: 10 }}>
          <div style={{ fontSize: 13 }}>
            Would keep <strong>{preview.counts.kept}</strong> of {preview.counts.total} from your last harvest.
          </div>
          {preview.examples.map((x, i) => (
            <div key={i} style={{ color: 'var(--text2)', fontSize: 11, marginTop: 3 }}>
              dropped: {x.title} · {x.company} — {x.reason}
            </div>
          ))}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border)', margin: '12px 0', paddingTop: 12 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input type="checkbox" checked={tidy.enabled} style={{ marginTop: 3 }}
            onChange={e => setTidy(t => ({ ...t, enabled: e.target.checked }))} />
          <span>
            Tidy the inbox automatically
            <div style={{ color: 'var(--text2)', fontSize: 11 }}>
              After every harvest, jobs waiting for review that match a rule below are cleared away, so the inbox only
              holds what is worth a decision. Nothing is deleted: “Show tidied” in the Inbox lists them, and Restore
              brings one back for good.
            </div>
          </span>
        </label>
        {tidy.enabled && (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, margin: '8px 0 0 23px' }}>
            <span>Older than <input type="number" min={1} value={tidy.maxAgeDays} style={{ width: 64 }}
              onChange={e => setTidy(t => ({ ...t, maxAgeDays: Number(e.target.value) }))} /> days</span>
            <span>Fit below <input type="number" min={0} max={100} value={tidy.minScore} style={{ width: 64 }}
              onChange={e => setTidy(t => ({ ...t, minScore: Number(e.target.value) }))} /></span>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={tidy.companySite} onChange={e => setTidy(t => ({ ...t, companySite: e.target.checked }))} />
              Applies on the company site
            </label>
          </div>
        )}
      </div>

      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-sm" onClick={runPreview}>Preview</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save filters'}
        </button>
      </div>
    </Card>
  );
}
