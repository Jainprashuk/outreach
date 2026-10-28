import { useState } from 'react';
import type { NaukriConfig, NaukriSearch, NaukriRecommendedTab } from '../../../lib/api';
import { usePlatform } from '../platform';
import { Card } from '../ui';
import { updateNaukriConfigApi } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

// What the harvest walks.
//
// Keywords + location build a Naukri slug URL (backend-developer-jobs-in-
// bangalore). The URL field is the escape hatch: paste a search you built on
// Naukri itself and it is used verbatim, which is the only way to express a
// filter combination this form does not model.

// Naukri's own tab names on the Recommended jobs page.
const REC_TABS: Array<[NaukriRecommendedTab, string, string]> = [
  ['apply', 'Applies', 'similar to jobs you applied to'],
  ['profile', 'Profile', 'matching your profile'],
  ['preference', 'Preferences', 'matching your job preferences'],
  ['similar_jobs', 'You might like', 'broader suggestions'],
];
const ALL_TABS = REC_TABS.map(t => t[0]);

const blank = (): NaukriSearch => ({
  label: '', keywords: '', location: '', experienceYears: null, url: '', enabled: true,
});

export default function SearchesCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [rows, setRows] = useState<NaukriSearch[]>(config.searches.length ? config.searches : [blank()]);
  const { id: platformId, label: site, sources: siteSources } = usePlatform();
  const isNaukri = platformId === 'naukri';
  // A site with no matched feed harvests searches only (none today; Hirist's
  // job feed was mapped 2026-10-21).
  const recLabel = siteSources.recommended;
  // Cutshort and Wellfound have no URL-controlled search: they harvest their
  // own feed only (the search is set on the site itself).
  const feedOnly = !isNaukri && !siteSources.searches;
  const toast = useToast();
  const [limits, setLimits] = useState(config.searchLimits || { maxSearches: 10, maxPages: 8 });
  const [sources, setSources] = useState({
    searches: config.sources?.searches ?? true, recommended: config.sources?.recommended ?? false,
    recommendedTabs: config.sources?.recommendedTabs?.length ? config.sources.recommendedTabs : ALL_TABS,
  });
  const toggleTab = (t: NaukriRecommendedTab) => setSources(s => {
    const has = s.recommendedTabs.includes(t);
    const next = has ? s.recommendedTabs.filter(x => x !== t) : [...s.recommendedTabs, t];
    return { ...s, recommendedTabs: next.length ? next : s.recommendedTabs };   // never none
  });
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
      if (!feedOnly && !sources.searches && !(recLabel && sources.recommended)) throw new Error(recLabel ? `Pick at least one: your searches or ${recLabel.toLowerCase()}` : 'Add a search and keep My searches ticked');
      const r = await updateNaukriConfigApi({ searches: usable, searchLimits: limits, sources });
      setLimits(r.config.searchLimits);
      setSources(s => ({ ...s, ...r.config.sources, recommendedTabs: r.config.sources.recommendedTabs?.length ? r.config.sources.recommendedTabs : ALL_TABS }));
      setRows(usable.length ? usable : [blank()]);
      { toast(`Saved ${usable.length} search${usable.length === 1 ? '' : 'es'}.`, 'success'); setMsg(`Saved ${usable.length} search${usable.length === 1 ? '' : 'es'}.`); };
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  return (
    <Card title="Searches" icon="ti-search" collapsible id="searches" defaultOpen={false} scope="site"
      right={feedOnly ? undefined : <button className="btn btn-xs" type="button" onClick={() => setRows(r => [...r, blank()])}>
        <i className="ti ti-plus" /> Add
      </button>}>

      {feedOnly && (
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 10 }}>
          {site} can&apos;t be searched from here: it harvests {recLabel?.toLowerCase()}. Change what that list shows on {site} itself.
        </div>
      )}
      {!feedOnly && rows.map((row, i) => (
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
            placeholder={`…or paste a ${site} search URL (overrides the fields above)`}
            value={row.url} onChange={e => patch(i, { url: e.target.value })}
            style={{ width: '100%', marginTop: 6, fontSize: 12 }}
          />
        </div>
      ))}

      <div style={{ margin: '14px 0 6px' }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 6 }}>Harvest from (default — scheduled harvests use this)</div>
        {!feedOnly && <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 6 }}>
          <input type="checkbox" checked={sources.searches} style={{ marginTop: 3 }}
            onChange={e => setSources(s => ({ ...s, searches: e.target.checked }))} />
          <span>My searches<div style={{ color: 'var(--text2)', fontSize: 11 }}>The searches listed above.</div></span>
        </label>}
        {!recLabel && (
          <div style={{ color: 'var(--text2)', fontSize: 11 }}>{site} has no recommended feed, so harvest uses these searches only.</div>
        )}
        {recLabel && <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input type="checkbox" checked={sources.recommended} style={{ marginTop: 3 }}
            onChange={e => setSources(s => ({ ...s, recommended: e.target.checked }))} />
          <span>
            {isNaukri ? <>Naukri&apos;s recommended jobs</> : `${site}'s ${recLabel.toLowerCase()}`}
            <div style={{ color: 'var(--text2)', fontSize: 11 }}>
              The jobs {site} picks for your profile. They go through the same filters, scoring, inbox and apply flow,
              marked “Recommended”. The Harvest button can also pick a source for one run.
            </div>
            {isNaukri && sources.recommended && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {REC_TABS.map(([id, label, help]) => (
                  <button key={id} type="button" title={help} onClick={() => toggleTab(id)}
                    className={`btn btn-xs${sources.recommendedTabs.includes(id) ? ' btn-primary' : ''}`}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </span>
        </label>}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '12px 0 4px' }}>
        {!feedOnly && <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Searches per harvest</div>
          <input type="number" min={1} max={10} style={{ width: 90 }} value={limits.maxSearches}
            onChange={e => setLimits(l => ({ ...l, maxSearches: Number(e.target.value) }))} />
        </label>}
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Pages per search</div>
          <input type="number" min={1} max={8} style={{ width: 90 }} value={limits.maxPages}
            onChange={e => setLimits(l => ({ ...l, maxPages: Number(e.target.value) }))} />
        </label>
      </div>
      <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 12 }}>
        {isNaukri
          ? <>20 listings a page. At most 10 searches × 8 pages — the worker&apos;s safety caps — so these can only be lowered.
            Recommended jobs reads the tabs you pick above, each one page. Fewer means a quicker, lighter harvest.</>
          : <>A page is one scroll of {site}&apos;s list. At most 5 searches × 5 pages on {site} — the worker&apos;s safety caps — so
            higher numbers here are lowered to those.</>}
      </div>

      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save searches'}
      </button>
    </Card>
  );
}
