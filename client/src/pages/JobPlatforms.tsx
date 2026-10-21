import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  NaukriOverview, NaukriRunKind, NaukriConfig, NaukriSources, PlatformInfo, PlatformId, PlatformScope,
  ApplyMode, DuplicateRules, NaukriRun,
} from '../lib/api';
import {
  naukriOverviewApi, naukriConfigApi, queueNaukriRunApi, cancelNaukriRunApi, platformsApi,
  queuePlatformRunApi, updatePlatformConfigApi, updateNaukriConfigApi, setNaukriPlatform, workerTokenStatusApi,
} from '../lib/api';
import Layout from '../components/Layout';
import { useToast } from '../context/ToastContext';
import StatusHeader, { readiness, runLabel, TONE_COLOR } from '../components/naukri/StatusHeader';
import NaukriSetupGuide, { type NaukriGuideTab } from '../components/naukri/NaukriSetupGuide';
import RunTimeline, { ActiveRun } from '../components/naukri/RunTimeline';
import ReviewQueue from '../components/naukri/ReviewQueue';
import JobsTab, { type JobsView } from '../components/naukri/JobsTab';
import InfoTip, { TAB_INFO } from '../components/naukri/InfoTip';
import { SetupCard, ResultsCard } from '../components/naukri/SetupAndResults';
import { openNaukriCard } from '../components/naukri/ui';
import ConnectionCard from '../components/naukri/config/ConnectionCard';
import { useAdaptiveInterval } from '../hooks/useAdaptiveInterval';
import ScheduleCard from '../components/naukri/config/ScheduleCard';
import SearchesCard from '../components/naukri/config/SearchesCard';
import FiltersCard from '../components/naukri/config/FiltersCard';
import ProfileCard from '../components/naukri/config/ProfileCard';
import AnswerBank from '../components/naukri/config/AnswerBank';
import ResumeCard from '../components/naukri/config/ResumeCard';
import ApplyCard from '../components/naukri/config/ApplyCard';
import { Card, Band, Muted, Notice, Empty, Hint } from '../components/naukri/ui';
import { fmtTime, DAY_LABELS } from '../components/naukri/format';
import {
  PlatformProvider, NAUKRI_VIEW, PlatformTag, ScopeTag, PLATFORM_COLOR, type PlatformView,
} from '../components/naukri/platform';

// Job Platforms — the page that was "Naukri", now one view over every job site
// set up in Configuration: Naukri, Instahyre, Hirist.
//
// Same page, same tabs, same cards. The switcher at the top picks the scope —
// All platforms, or one platform — and every tab follows it: the naukri*Api
// helpers are pointed at that platform (setNaukriPlatform), and the cards read
// its name and what it can do from PlatformProvider. A problem on one platform
// (a captcha, a logout) never pauses the others, and the page says so.
//
// One poll still drives the screen: /platforms for the switcher (every
// platform's light overview), plus the selected platform's full overview.

const POLL_MS = 3000;
const IDLE_POLL_MS = 30_000;

type View = 'activity' | 'review' | 'jobs' | 'config';
const TABS: Array<[View, string, string]> = [
  ['activity', 'Activity', 'ti-activity'],
  ['review', 'Inbox', 'ti-inbox'],
  ['jobs', 'Jobs', 'ti-briefcase'],
  ['config', 'Configuration', 'ti-settings'],
];

const KIND_LABEL: Record<string, string> = { refresh: 'refresh profile', harvest: 'harvest', apply: 'apply', track: 'check replies' };
const CAP_LABEL: Array<['refresh' | 'harvest' | 'apply' | 'track', string]> = [
  ['refresh', 'Refresh profile'], ['harvest', 'Harvest'], ['apply', 'Apply'], ['track', 'Check replies'],
];

// The harvest choices a platform offers, from its registry entry.
function sourceChoices(info: PlatformInfo | undefined): Array<[string, string, NaukriSources]> {
  if (!info || !info.sources.recommended) return [];
  return [
    ['searches', info.sources.searches, { searches: true, recommended: false }],
    ['recommended', info.sources.recommended, { searches: false, recommended: true }],
    ['both', 'Both', { searches: true, recommended: true }],
  ];
}

// "Weekdays: 09:30 harvest, check replies; 14:00 apply." — only the steps
// this platform can actually run.
function scheduleText(o: NaukriOverview): string {
  const s = o.schedule;
  if (!s || !s.enabled) return 'Not running automatically.';
  const caps = o.capabilities || NAUKRI_VIEW.capabilities;
  const days = [...s.days].sort();
  const dayText = days.join() === '1,2,3,4,5' ? 'Weekdays' : days.length === 7 ? 'Every day' : days.map(d => DAY_LABELS[d]).join(', ');
  const slots = [
    { time: s.time, runRefresh: s.runRefresh, runHarvest: s.runHarvest, runApply: s.runApply, runTrack: s.runTrack !== false },
    ...(s.extraSlots || []),
  ];
  const parts = slots.map((t) => {
    const kinds = [
      t.runRefresh && caps.refresh && 'refresh profile',
      t.runHarvest && caps.harvest && 'harvest',
      t.runApply && o.applyMode !== 'off' && (o.applyMode === 'dry-run' ? 'dry run apply' : 'apply'),
      t.runTrack && caps.track && 'check replies',
    ].filter(Boolean);
    return `${t.time} ${kinds.length ? kinds.join(', ') : 'nothing ticked'}`;
  });
  return `${dayText}: ${parts.join('; ')}.`;
}

// A small popover menu, closed by an outside click or Escape.
function Menu({ label, icon, disabled, title, primary, items }: {
  label: string; icon: string; disabled?: boolean; title?: string; primary?: boolean;
  items: Array<{ key: string; label: string; note?: string; checked?: boolean; disabled?: boolean; onPick: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button className={`btn btn-sm${primary ? ' btn-primary' : ''}`} type="button" onClick={() => setOpen(o => !o)}
        disabled={disabled} title={title} aria-haspopup="menu" aria-expanded={open}>
        <i className={`ti ${icon}`} /> {label} <i className="ti ti-chevron-down" style={{ fontSize: 11 }} />
      </button>
      {open && (
        <span role="menu" style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50, minWidth: 210,
          background: 'var(--bg)', border: '1px solid var(--border-md)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)', padding: 4, display: 'flex', flexDirection: 'column',
        }}>
          {items.map(it => (
            <button key={it.key} type="button" role="menuitem" className="btn btn-sm" disabled={it.disabled}
              style={{ justifyContent: 'flex-start', border: 'none', background: 'transparent', opacity: it.disabled ? 0.5 : 1 }}
              onClick={() => { setOpen(false); it.onPick(); }}>
              <i className={`ti ${it.checked ? 'ti-check' : 'ti-point'}`} style={{ width: 16 }} />
              {it.label}{it.note && <span style={{ color: 'var(--text3)', marginLeft: 'auto', paddingLeft: 8 }}>{it.note}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// All platforms → Apply: one button that applies on the ticked platforms, and
// an arrow that opens the list to tick. Every platform that can apply right now
// starts ticked; one that can't (apply off, worker not ready) shows why and
// stays unticked. Your unticks are remembered on this browser.
// Short, like every other page's: the switcher and tabs say the rest.
const SUBTITLE = 'Harvest, apply and track replies across job sites';

type ApplyChoice = { id: PlatformId; label: string; ok: boolean; why?: string; mode?: string };
const APPLY_SKIP_KEY = 'jp-apply-skip';
function ApplyPicker({ choices, busy, onApply }: {
  choices: ApplyChoice[]; busy: boolean; onApply: (ids: PlatformId[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [skip, setSkip] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(APPLY_SKIP_KEY) || '[]'); } catch { return []; }
  });
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  const toggle = (id: string) => {
    const next = skip.includes(id) ? skip.filter(x => x !== id) : [...skip, id];
    setSkip(next);
    try { localStorage.setItem(APPLY_SKIP_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  const picked = choices.filter(c => c.ok && !skip.includes(c.id));
  const tip = picked.length ? `Applies on: ${picked.map(c => c.label).join(', ')}` : 'Tick at least one ready platform';
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="btn btn-primary btn-sm" type="button" disabled={!picked.length || busy} title={tip}
        onClick={() => onApply(picked.map(c => c.id))}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
        <i className="ti ti-send" /> Apply
      </button>
      <button className="btn btn-primary btn-sm" type="button" aria-label="Choose platforms to apply on"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}
        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: 7, paddingRight: 7,
          borderLeft: '1px solid color-mix(in srgb, currentColor 30%, transparent)' }}>
        <i className="ti ti-chevron-down" style={{ fontSize: 12 }} />
      </button>
      {open && (
        <span role="dialog" aria-label="Apply on" style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 50, width: 260,
          background: 'var(--bg)', border: '1px solid var(--border-md)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)', padding: 10, display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '0 4px 4px' }}>
            Apply on
          </span>
          {choices.map(c => (
            <label key={c.id} title={c.why} style={{
              display: 'flex', alignItems: 'center', gap: 9, padding: '6px 4px', borderRadius: 8, fontSize: 13,
              cursor: c.ok ? 'pointer' : 'not-allowed', opacity: c.ok ? 1 : 0.55,
            }}>
              <input type="checkbox" checked={c.ok && !skip.includes(c.id)} disabled={!c.ok} onChange={() => toggle(c.id)} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: PLATFORM_COLOR[c.id], flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{c.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{c.ok ? (c.mode === 'dry-run' ? 'Dry run' : 'Real') : c.why}</span>
            </label>
          ))}
          <span style={{ fontSize: 11, color: 'var(--text3)', padding: '4px 4px 0' }}>
            Only jobs you approved are sent, within each platform's daily limit.
          </span>
        </span>
      )}
    </span>
  );
}

// The switcher: All platforms + one card per platform that is switched on, and
// a "Turn on" card for each one that is off. There is no separate setup: a
// platform needs only to be on, its worker running and you logged into the
// site in the debug Chrome — the card's status says which of those is missing.
function Switcher({ platforms, scope, onPick, onTurnOn }: {
  platforms: PlatformInfo[]; scope: PlatformScope; onPick: (p: PlatformScope) => void; onTurnOn: (p: PlatformInfo) => void;
}) {
  const off = platforms.filter(p => !p.enabled);
  const on = platforms.filter(p => p.enabled && p.overview);
  const inbox = on.reduce((n, p) => n + (p.overview?.reviewCount || 0), 0);
  const card = (key: string, pressed: boolean, dot: React.ReactNode, name: string, status: string, count: number | null, onClick: () => void, title?: string) => (
    <button key={key} type="button" aria-pressed={pressed} onClick={onClick} title={title} style={{
      display: 'flex', alignItems: 'center', gap: 10, minWidth: 150, padding: '9px 12px', borderRadius: 12, cursor: 'pointer',
      background: 'var(--bg)', textAlign: 'left', font: 'inherit', color: 'var(--text)',
      border: `1px solid ${pressed ? 'var(--accent)' : 'var(--border-md)'}`,
      boxShadow: pressed ? '0 0 0 3px var(--accent-bg)' : 'var(--shadow-sm)',
    }}>
      {dot}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{name}</span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</span>
      </span>
      {count != null && count > 0 && <span className="contact-count-badge" title="Waiting in the inbox">{count}</span>}
    </button>
  );
  const dot = (bg: string, pulse = false) => (
    <span style={{ width: 10, height: 10, borderRadius: '50%', background: bg, flexShrink: 0, animation: pulse ? 'jp-pulse 1.2s ease-in-out infinite' : undefined }} />
  );
  return (
    <div role="group" aria-label="Platform" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <style>{'@keyframes jp-pulse{50%{opacity:.35}}@media (prefers-reduced-motion:reduce){[aria-label="Platform"] span{animation:none!important}}'}</style>
      {card('all', scope === 'all',
        dot('conic-gradient(var(--blue) 0 33%, var(--teal) 0 66%, var(--purple) 0)'),
        'All platforms', `${on.length} on`, inbox, () => onPick('all'))}
      {on.map((p) => {
        const r = readiness(p.overview!, { withRun: true });
        return card(p.id, scope === p.id, dot(TONE_COLOR[r.tone], r.tone === 'run'), p.label, r.short, p.overview!.reviewCount, () => onPick(p.id), r.text);
      })}
      {off.map(p => (
        <button key={p.id} type="button" onClick={() => onTurnOn(p)} title={`Switch ${p.label} on — it starts read-only (harvest and check replies; apply stays off until you choose)`} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 12, cursor: 'pointer',
          background: 'transparent', border: '1px dashed var(--border-md)', color: 'var(--text2)', font: 'inherit', fontSize: 13,
        }}>
          <i className="ti ti-plus" /> Turn on {p.label}
        </button>
      ))}
    </div>
  );
}

// Configuration → All platforms: every platform with its switch, apply mode
// and what its driver can do.
function PlatformsCard({ platforms, onChanged, onOpen, crossOrder }: {
  platforms: PlatformInfo[]; onChanged: () => void; onOpen: (p: PlatformId) => void; crossOrder: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (p: PlatformInfo, patch: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await updatePlatformConfigApi(p.id, patch); toast(ok, 'success'); onChanged(); }
    catch (e: any) { toast(e?.message || 'Could not save', 'error'); }
    finally { setBusy(false); }
  };
  const MODES: Array<[ApplyMode, string]> = [['off', 'Off'], ['dry-run', 'Dry run'], ['on', 'On']];
  return (
    <Card title="Platforms" icon="ti-layout-grid">
      <Hint style={{ marginTop: -6, marginBottom: 10 }}>
        Each platform has its own worker, schedule, searches, filters and apply settings. Turning one off hides it on
        this page; its jobs and history are kept.
      </Hint>
      {platforms.map((p) => {
        const o = p.overview;
        const r = o ? readiness(o, { withRun: true }) : null;
        const mode = (o?.applyMode || (p.id === 'naukri' ? 'on' : 'off')) as ApplyMode;
        return (
          <div key={p.id} style={{
            display: 'grid', gridTemplateColumns: 'minmax(180px,1.1fr) minmax(200px,1.4fr) auto auto', gap: 12, alignItems: 'center',
            padding: '10px 0', borderTop: '0.5px solid var(--border)',
          }} className="jp-platform-row">
            <div style={{ opacity: p.enabled ? 1 : 0.5 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <PlatformTag id={p.id} />
                {p.enabled && r
                  ? <span className={`badge ${r.tone === 'ok' ? 'badge-approved' : r.tone === 'bad' ? 'badge-blocked' : 'badge-queued'}`}>{r.short}</span>
                  : <span className="badge badge-seen">Off</span>}
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                {CAP_LABEL.map(([k, label]) => {
                  const has = k === 'apply' ? p.capabilities.apply || p.capabilities.dryRun : p.capabilities[k];
                  return (
                    <span key={k} title={has ? (k === 'apply' && !p.capabilities.apply ? 'Dry run only until real apply is proven' : undefined) : `${p.label} has no ${label.toLowerCase()} step`}
                      style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 999, background: 'var(--bg2)',
                        color: has ? 'var(--text2)' : 'var(--text3)', textDecoration: has ? 'none' : 'line-through' }}>
                      {label}{k === 'apply' && has && !p.capabilities.apply ? ' (dry run)' : ''}
                    </span>
                  );
                })}
              </div>
            </div>
            <div style={{ opacity: p.enabled ? 1 : 0.5 }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Apply</div>
              <div role="radiogroup" aria-label={`${p.label} apply`} style={{ display: 'inline-flex', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                {MODES.map(([m, label]) => {
                  const locked = !p.enabled || (m === 'on' && !p.capabilities.apply) || (m === 'dry-run' && !p.capabilities.dryRun);
                  return (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={busy || locked}
                      title={m === 'on' && !p.capabilities.apply ? `Real apply on ${p.label} isn't verified yet` : undefined}
                      className={`btn btn-xs${mode === m ? ' btn-primary' : ''}`} style={{ borderRadius: 0, border: 'none' }}
                      onClick={() => mode !== m && save(p, { applyMode: m }, `${p.label} apply: ${m === 'off' ? 'off' : m === 'dry-run' ? 'dry run' : 'on'}.`)}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" role="switch" aria-label={`Use ${p.label}`} checked={p.enabled} disabled={busy}
                onChange={e => save(p, { enabled: e.target.checked }, `${p.label} turned ${e.target.checked ? 'on' : 'off'}. Its jobs and history are kept.`)} />
              {p.enabled ? 'On' : 'Off'}
            </label>
            <button className="btn btn-sm" type="button" disabled={!p.enabled} onClick={() => onOpen(p.id)}>
              <i className="ti ti-settings" /> Settings
            </button>
          </div>
        );
      })}
      <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 10 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input type="checkbox" checked={crossOrder} disabled={busy} style={{ marginTop: 3 }}
            onChange={async (e) => {
              setBusy(true);
              try { await updatePlatformConfigApi('naukri', { crossPlatformOrder: e.target.checked }); onChanged(); }
              catch (err: any) { toast(err?.message || 'Could not save', 'error'); }
              finally { setBusy(false); }
            }} />
          <span>
            Run queued work oldest first across platforms
            <Hint>Off: each platform&apos;s worker takes its own runs as it polls. On: a worker waits while another ready platform has an older run queued.</Hint>
          </span>
        </label>
      </div>
      <Hint>Another platform appears here once a worker driver exists for it.</Hint>
    </Card>
  );
}

// Shared: what counts as the same role on two platforms, and what to do about it.
function DuplicatesCard({ rules, onSaved }: { rules: DuplicateRules; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState(rules);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await updateNaukriConfigApi({ duplicates: d }); toast('Duplicate rules saved for every platform.', 'success'); onSaved(); }
    catch (e: any) { toast(e?.message || 'Could not save', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Card title="Duplicates across platforms" icon="ti-copy" collapsible id="duplicates" defaultOpen={false} scope="shared">
      <Hint style={{ marginTop: -4, marginBottom: 10 }}>
        A job counts as a duplicate when the company and title match a job on another platform. Duplicates are never
        dropped, only flagged.
      </Hint>
      <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Look back</div>
        <input type="number" min={7} max={180} value={d.windowDays} style={{ width: 90 }}
          onChange={e => setD(x => ({ ...x, windowDays: Number(e.target.value) }))} /> <Muted>days</Muted>
      </label>
      <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 8 }}>
        <input type="checkbox" checked={d.blockAuto} onChange={e => setD(x => ({ ...x, blockAuto: e.target.checked }))} />
        Don&apos;t auto-approve a job already applied to or approved on another platform
      </label>
      <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={d.blockApply} onChange={e => setD(x => ({ ...x, blockApply: e.target.checked }))} />
        Skip it at apply time if another platform applied first
      </label>
      <button className="btn btn-primary btn-sm" type="button" onClick={save} disabled={busy}>Save</button>
    </Card>
  );
}

// Activity, All platforms: one card per platform with a Run on menu.
// "Today 14:00 · harvest, apply" — when a scheduled run is next.
const KIND_WORD: Record<string, string> = { refresh: 'refresh profile', harvest: 'harvest', apply: 'apply', track: 'check replies' };
function whenText(at: string): string {
  const d = new Date(at);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.getTime()) / 864e5);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function AllActivity({ platforms, onOpen, onOpenWaiting, onRun, busy }: {
  platforms: PlatformInfo[]; onOpen: (p: PlatformId) => void; onOpenWaiting: (p: PlatformId) => void; busy: boolean;
  onRun: (p: PlatformId, kind: NaukriRunKind, sources?: NaukriSources) => void;
}) {
  const on = platforms.filter(p => p.enabled && p.overview);
  const running = on.filter(p => p.overview!.activeRun);
  const history: NaukriRun[] = on.flatMap(p => p.overview!.history.map(h => ({ ...h, platform: h.platform || p.id })))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 20);
  return (
    <>
      {running.map(p => (
        <Card key={`run-${p.id}`}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <PlatformTag id={p.id} />
            <Band>{runLabel(p.overview!.activeRun!.kind, p.overview!.activeRun!.dryRun)} on {p.label}</Band>
          </div>
          <ActiveRun run={p.overview!.activeRun!} />
        </Card>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginBottom: 14 }}>
        {on.map((p) => {
          const o = p.overview!;
          const r = readiness(o, { withRun: true });
          const choices = sourceChoices(p);
          const def = o.sources || { searches: true, recommended: false };
          const items = [
            ...(p.capabilities.refresh ? [{ key: 'refresh', label: 'Refresh profile', onPick: () => onRun(p.id, 'refresh') }] : []),
            ...(choices.length
              ? choices.map(([k, label, s]) => ({
                key: `h-${k}`, label: `Harvest: ${label}`,
                note: s.searches === def.searches && s.recommended === !!def.recommended ? 'default' : undefined,
                onPick: () => onRun(p.id, 'harvest', s),
              }))
              : [{ key: 'harvest', label: 'Harvest', onPick: () => onRun(p.id, 'harvest') }]),
            ...(p.capabilities.track ? [{ key: 'track', label: 'Check replies', onPick: () => onRun(p.id, 'track') }] : []),
            o.applyMode === 'off'
              ? { key: 'apply', label: `Apply is off for ${p.label}`, disabled: true, onPick: () => {} }
              : { key: 'apply', label: o.applyMode === 'dry-run' ? 'Dry run apply' : 'Apply', onPick: () => onRun(p.id, 'apply') },
          ];
          return (
            <Card key={p.id} style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <PlatformTag id={p.id} />
                <span className={`badge ${r.tone === 'ok' ? 'badge-approved' : r.tone === 'bad' ? 'badge-blocked' : r.tone === 'run' ? 'badge-inreview' : 'badge-queued'}`}
                  style={{ marginLeft: 'auto' }} title={r.text}>{r.short}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 10 }}>
                {([['in inbox', o.reviewCount], ['found this week', o.foundThisWeek || 0], ['applied this week', o.week.applied]] as const).map(([label, n]) => (
                  <div key={label}><div style={{ fontSize: 20, fontWeight: 700 }}>{n}</div><Muted style={{ fontSize: 11, lineHeight: 1.3, display: 'block' }}>{label}</Muted></div>
                ))}
                {/* Approved, not sent yet: what the next apply run takes, within the daily limit. */}
                <button type="button" onClick={() => onOpenWaiting(p.id)} title={`Approved jobs waiting to be applied to on ${p.label} — open the Waiting list`}
                  style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: o.waitingCount ? 'var(--accent)' : undefined }}>{o.waitingCount || 0}</div>
                  <Muted style={{ fontSize: 11, lineHeight: 1.3, display: 'block' }}>approved, in queue</Muted>
                </button>
              </div>
              {o.schedule?.enabled && (o.upcoming || []).length > 0 && (
                <div style={{ fontSize: 12, marginBottom: 6, padding: '7px 9px', borderRadius: 8, background: 'var(--bg2)', display: 'grid', gap: 3 }}>
                  <span style={{ color: 'var(--text3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    <i className="ti ti-clock" /> Next runs
                  </span>
                  {(o.upcoming || []).slice(0, 2).map(u => (
                    <span key={u.at} style={{ display: 'flex', gap: 8 }}>
                      <strong style={{ fontWeight: 600, minWidth: 96 }}>{whenText(u.at)}</strong>
                      <span style={{ color: 'var(--text2)' }}>{u.kinds.map(k => KIND_WORD[k] || k).join(', ')}</span>
                    </span>
                  ))}
                </div>
              )}
              <Hint style={{ marginBottom: 10 }}>
                {scheduleText(o)}
                {o.applyMode === 'off' && (o.readOnlySince
                  ? ` Apply is off; read-only since ${new Date(o.readOnlySince).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`
                  : ' Apply is off.')}
              </Hint>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Menu label={`Run on ${p.label}`} icon="ti-player-play" primary disabled={!r.canRun || busy}
                  title={r.canRun ? undefined : r.text} items={items} />
                <button className="btn btn-sm" type="button" onClick={() => onOpen(p.id)}>Open</button>
              </div>
            </Card>
          );
        })}
      </div>
      <Card>
        <div style={{ marginBottom: 4 }}><Band>Recent runs</Band></div>
        <Hint style={{ marginTop: 0, marginBottom: 6 }}>Every run the worker did, newest first.</Hint>
        {history.length ? <RunTimeline runs={history} showPlatform /> : <Empty icon="ti-history">No runs yet. Start a harvest to see jobs here.</Empty>}
      </Card>
    </>
  );
}

// The All view's numbers, summed, in the overview's shape so the Jobs tab works.
function sumOverview(on: PlatformInfo[]): NaukriOverview | null {
  const os = on.map(p => p.overview!).filter(Boolean);
  if (!os.length) return null;
  const sum = (k: keyof NaukriOverview) => os.reduce((n, o) => n + (Number(o[k]) || 0), 0);
  return {
    ...os[0], platform: undefined, label: 'All platforms', applyMode: 'on',
    reviewCount: sum('reviewCount'), needsAnswerCount: sum('needsAnswerCount'), waitingCount: sum('waitingCount'),
    skippedCount: sum('skippedCount'), appliedCount: sum('appliedCount'), appliedToday: sum('appliedToday'),
    perRun: 10_000, paused: false, blockedUntil: null, upcoming: [],
    schedule: { ...os[0].schedule, enabled: false },
  };
}

export default function JobPlatforms() {
  const [params, setParams] = useSearchParams();
  const requested = (params.get('platform') || 'all') as PlatformScope;
  const [registry, setRegistry] = useState<{ platforms: PlatformInfo[]; duplicates: DuplicateRules; crossPlatformOrder: boolean } | null>(null);
  const enabledIds = (registry?.platforms || []).filter(p => p.enabled).map(p => p.id);
  // A platform that is switched off falls back to the All view.
  const scope: PlatformScope = requested === 'all' || !registry || enabledIds.includes(requested as PlatformId) ? requested : 'all';
  const single = scope !== 'all';
  // Every naukri*Api call below this page is for this scope. Set during render,
  // before any child effect runs. Off this page the helpers ignore it (api.ts).
  setNaukriPlatform(scope);

  const [overview, setOverview] = useState<NaukriOverview | null>(null);
  const [config, setConfig] = useState<NaukriConfig | null>(null);
  const [guide, setGuide] = useState<NaukriGuideTab | null>(null);
  // Set when an admin hosts this account's workers on the cloud VM: the link to
  // the browser there, where the user logs in to their job sites.
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  useEffect(() => { workerTokenStatusApi().then(r => setCloudUrl(r.cloudScreenUrl || null)).catch(() => {}); }, []);
  const view = (params.get('tab') as View) || 'activity';
  const setView = (v: View) => setParams(p => { const n = new URLSearchParams(p); n.set('tab', v); return n; }, { replace: true });
  const pick = (p: PlatformScope, tab?: View) => setParams(prev => {
    const n = new URLSearchParams(prev); n.set('platform', p); if (tab) n.set('tab', tab); return n;
  });
  const [jobsView, setJobsView] = useState<JobsView>('waiting');
  const openJobs = (v: JobsView) => { setJobsView(v); setView('jobs'); };
  const [pendingCard, setPendingCard] = useState<string | null>(null);
  const fix = (card: string | null) => { if (!card) return; setPendingCard(card); setView('config'); };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const info = registry?.platforms.find(p => p.id === scope);
  const platformView: PlatformView = useMemo(() => ({
    id: scope,
    label: single ? (info?.label || 'Naukri') : 'All platforms',
    capabilities: info?.capabilities || NAUKRI_VIEW.capabilities,
    sources: info?.sources || NAUKRI_VIEW.sources,
    platforms: registry?.platforms.filter(p => p.enabled) || [],
  }), [scope, single, info, registry]);

  const load = useCallback(async () => {
    try {
      const [reg, ov] = await Promise.all([platformsApi(), single ? naukriOverviewApi() : Promise.resolve(null)]);
      setRegistry(reg); setOverview(ov); setError('');
    } catch (e: any) { setError(e?.message || 'Could not load Job Platforms'); }
  }, [single, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOverview(null); setConfig(null); }, [scope]);

  const loadConfig = useCallback(async () => {
    try { setConfig((await naukriConfigApi()).config); } catch { /* cards keep what they have */ }
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyBusy = (registry?.platforms || []).some(p => p.overview && (p.overview.activeRun || p.overview.queuedRuns.length));
  useAdaptiveInterval(load, { fastMs: POLL_MS, slowMs: IDLE_POLL_MS, fast: anyBusy });
  useEffect(() => { load(); }, [load]);

  useEffect(() => { if (view === 'config') { setConfig(null); loadConfig(); } }, [view, loadConfig]);
  const onConfigSaved = useCallback(() => { load(); loadConfig(); }, [load, loadConfig]);
  useEffect(() => {
    if (view !== 'config' || !config || !pendingCard) return;
    const t = setTimeout(() => { openNaukriCard(pendingCard); setPendingCard(null); }, 80);
    return () => clearTimeout(t);
  }, [view, config, pendingCard]);

  const KIND_TOAST = (label: string, kind: string, dry?: boolean) => ({
    refresh: `Refresh queued — your ${label} profile will be re-saved on the next worker poll.`,
    track: `Checking replies — the ${label} worker reads your applications on its next poll (read-only).`,
    harvest: `${label}: harvest queued — new listings will land in the Inbox.`,
    apply: dry ? `${label}: dry run queued — fills everything and submits nothing.` : `${label}: apply run queued — approved jobs go out on the next worker poll.`,
    probe: 'Probe queued.',
  } as Record<string, string>)[kind] || 'Run queued.';

  const runOn = async (p: PlatformId, kind: NaukriRunKind, sources?: NaukriSources) => {
    setBusy(true);
    const label = registry?.platforms.find(x => x.id === p)?.label || p;
    const dry = registry?.platforms.find(x => x.id === p)?.overview?.applyMode === 'dry-run';
    try {
      await queuePlatformRunApi(p, kind, sources ? { sources } : {});
      toast(KIND_TOAST(label, kind, dry), 'success');
      await load();
    } catch (e: any) { toast(e?.message || `Could not start the ${kind} run`, 'error'); }
    finally { setBusy(false); }
  };

  const start = async (kind: NaukriRunKind, sources?: NaukriSources) => {
    setBusy(true);
    try {
      await queueNaukriRunApi(kind, sources ? { sources } : {});
      toast(KIND_TOAST(platformView.label, kind, overview?.applyMode === 'dry-run'), 'success');
      await load();
    } catch (e: any) {
      const m = e?.message || `Could not start the ${kind} run`;
      toast(m, 'error'); setError(m);
    } finally { setBusy(false); }
  };

  // All view: start one kind on every ready platform that can do it.
  const startAll = async (kind: NaukriRunKind, only?: PlatformId[]) => {
    const on = (registry?.platforms || []).filter(p => p.enabled && p.overview && (!only || only.includes(p.id as PlatformId)));
    const can = on.filter(p => readiness(p.overview!, { withRun: true }).canRun
      && (kind === 'apply' ? p.overview!.applyMode !== 'off' : kind === 'track' ? p.capabilities.track : true));
    const skipped = on.filter(p => !can.includes(p) && (kind !== 'apply' || p.overview!.applyMode !== 'off'));
    setBusy(true);
    const started: string[] = [];
    for (const p of can) {
      try { await queuePlatformRunApi(p.id, kind); started.push(p.label); }
      catch (e: any) { toast(`${p.label}: ${e?.message || 'could not start'}`, 'error'); }
    }
    setBusy(false);
    toast(`Started on ${started.length ? started.join(', ') : 'no platform'}.${skipped.length ? ` Skipped ${skipped.map(p => p.label).join(', ')} (not ready).` : ''}`,
      started.length ? 'success' : 'info');
    load();
  };

  const cancel = async (id: string) => {
    setBusy(true);
    try { await cancelNaukriRunApi(id); toast('Run cancelled.', 'info'); await load(); }
    catch (e: any) { const m = e?.message || 'Could not cancel'; toast(m, 'error'); setError(m); }
    finally { setBusy(false); }
  };

  const on = (registry?.platforms || []).filter(p => p.enabled && p.overview);
  const allOverview = useMemo(() => sumOverview(on), [registry]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = single ? overview : allOverview;

  if (!registry || !shown) {
    return (
      <Layout title="Job Platforms" subtitle={SUBTITLE}>
        <Empty icon="ti-loader">{error || 'Loading…'}</Empty>
      </Layout>
    );
  }

  const switcher = (
    <Switcher platforms={registry.platforms} scope={scope} onPick={(p) => pick(p)}
      onTurnOn={async (p) => {
        try {
          await updatePlatformConfigApi(p.id as PlatformId, { enabled: true });
          toast(cloudUrl
            ? `${p.label} turned on. Log into ${p.label} in your cloud browser.`
            : `${p.label} turned on. Start its worker on your computer and log into ${p.label} in the debug Chrome.`, 'success');
          await load();
          pick(p.id);
        } catch (e: any) { toast(e?.message || `Could not turn ${p.label} on`, 'error'); }
      }} />
  );

  // ── header actions ──────────────────────────────────────────────────────
  const cloudButton = cloudUrl ? (
    <a className="btn btn-sm" href={cloudUrl} target="_blank" rel="noreferrer"
      title="The browser your workers use, running in the cloud. Log in to your job sites here.">
      <i className="ti ti-cloud" /> Cloud browser
    </a>
  ) : null;
  let actions: React.ReactNode;
  let readinessLine: React.ReactNode;
  if (single && overview) {
    const r = readiness(overview);
    const canStart = r.canRun && !busy;
    const tip = canStart ? undefined : r.text;
    const choices = sourceChoices(info);
    const def = overview.sources || { searches: true, recommended: false };
    const mode = overview.applyMode || 'on';
    actions = (
      <>
        {cloudButton}
        {scope === 'naukri' && (
          <button className="btn btn-sm" type="button" onClick={() => setGuide(overview.worker.everSeen ? 'how' : 'setup')}
            title="How the Naukri worker works and how to set it up"><i className="ti ti-book" /> Guide</button>
        )}
        {platformView.capabilities.refresh && (
          <button className="btn btn-sm" type="button" onClick={() => start('refresh')} disabled={!canStart} title={tip}>
            <i className="ti ti-refresh" /> Refresh profile
          </button>
        )}
        {choices.length ? (
          <Menu label="Harvest" icon="ti-download" disabled={!canStart} title={tip}
            items={choices.map(([k, label, s]) => ({
              key: k, label, checked: s.searches === def.searches && s.recommended === !!def.recommended,
              note: s.searches === def.searches && s.recommended === !!def.recommended ? 'default' : undefined,
              onPick: () => start('harvest', s),
            }))} />
        ) : (
          <button className="btn btn-sm" type="button" onClick={() => start('harvest')} disabled={!canStart} title={tip}>
            <i className="ti ti-download" /> Harvest
          </button>
        )}
        {platformView.capabilities.track && (
          <button className="btn btn-sm" type="button" onClick={() => start('track')} disabled={!canStart} title={tip}>
            <i className="ti ti-messages" /> Check replies
          </button>
        )}
        {mode === 'off' ? (
          <button className="btn btn-primary btn-sm" type="button" disabled title={`Apply is off for ${platformView.label}. Turn it on in Configuration.`}>
            <i className="ti ti-send" /> Apply
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" type="button" onClick={() => start('apply')} disabled={!canStart} title={tip}>
            <i className="ti ti-send" /> {mode === 'dry-run' ? 'Dry run apply' : 'Apply'}
          </button>
        )}
      </>
    );
    readinessLine = <StatusHeader overview={overview} onHelp={scope === 'naukri' ? () => setGuide('setup') : undefined} />;
  } else {
    const ready = on.filter(p => readiness(p.overview!, { withRun: true }).canRun);
    const allTip = ready.length ? `Runs on: ${ready.map(p => p.label).join(', ')}` : 'No platform is ready to run';
    const applyChoices: ApplyChoice[] = on.map(p => {
      const r = readiness(p.overview!, { withRun: true });
      const mode = p.overview!.applyMode || 'on';
      return mode === 'off' ? { id: p.id as PlatformId, label: p.label, ok: false, why: 'Apply off' }
        : !r.canRun ? { id: p.id as PlatformId, label: p.label, ok: false, why: r.short }
        : { id: p.id as PlatformId, label: p.label, ok: true, mode };
    });
    actions = (
      <>
        {cloudButton}
        <button className="btn btn-sm" type="button" disabled={!ready.length || busy} onClick={() => startAll('harvest')} title={allTip}>
          <i className="ti ti-download" /> Harvest all
        </button>
        <button className="btn btn-sm" type="button" disabled={!ready.length || busy} onClick={() => startAll('track')} title={allTip}>
          <i className="ti ti-messages" /> Check replies
        </button>
        <ApplyPicker choices={applyChoices} busy={busy} onApply={(ids) => startAll('apply', ids)} />
      </>
    );
    const trouble = on.map(p => ({ p, r: readiness(p.overview!) })).filter(x => x.r.tone === 'bad' || x.r.tone === 'warn');
    readinessLine = trouble.length ? (
      <div className="info-box" style={{ marginBottom: 14, background: 'var(--amber-bg)', color: 'var(--text)', border: '0.5px solid var(--border-md)' }}>
        <i className="ti ti-alert-triangle" style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
        <span>
          <strong>{trouble.map(x => x.p.label).join(', ')} need{trouble.length === 1 ? 's' : ''} attention.</strong>{' '}
          {trouble.map(x => x.r.text).join(' ')}
        </span>
      </div>
    ) : (
      <div className="info-box" style={{ marginBottom: 14 }}>
        <i className="ti ti-circle-check" style={{ color: 'var(--green)', flexShrink: 0, marginTop: 1 }} />
        <span><strong>All platforms ready.</strong> Each runs on its own schedule; a problem on one never pauses the others.</span>
      </div>
    );
  }

  const counts: Partial<Record<View, number>> = { review: shown.reviewCount, jobs: shown.needsAnswerCount };
  const nextApply = (shown.upcoming || []).find(x => x.kinds.includes('apply'));
  const others = on.filter(p => p.id !== scope).map(p => p.label);

  return (
    <PlatformProvider value={platformView}>
    <Layout title="Job Platforms" subtitle={SUBTITLE} actions={actions}>
      {switcher}

      <div className="section-head">
        <div className="nav-tabs">
          {TABS.map(([key, label, icon]) => (
            <button key={key} type="button" onClick={() => setView(key)}
              className={`nav-tab${view === key ? ' active' : ''}`}>
              <i className={`ti ${icon}`} style={{ marginRight: 5 }} />{label}
              {counts[key] ? <span className="contact-count-badge" style={{ marginLeft: 6 }}>{counts[key]}</span> : null}
              <InfoTip title={label}>{TAB_INFO[key]}</InfoTip>
            </button>
          ))}
        </div>
      </div>

      {readinessLine}
      {error && <Notice tone="danger" icon="ti-alert-triangle">{error}</Notice>}

      {/* Keyed by scope so every list refetches from the right platform. */}
      <div key={scope}>
      {view === 'activity' && !single && (
        <AllActivity platforms={registry.platforms} busy={busy} onRun={runOn} onOpen={(p) => pick(p)}
          onOpenWaiting={(p) => { setJobsView('waiting'); pick(p, 'jobs'); }} />
      )}
      {view === 'activity' && single && overview && (
        <>
          <SetupCard overview={overview} onFix={fix} />
          <ResultsCard overview={overview} busy={busy || !readiness(overview).canRun} onCheck={() => start('track')} />
          <Card>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
              <Band>This week</Band>
              <button className="btn btn-xs" type="button" onClick={() => openJobs('applied')}>
                <i className="ti ti-send" /> {overview.week.applied} applied
              </button>
              <button className="btn btn-xs" type="button" onClick={() => openJobs('skipped')}>
                <i className="ti ti-player-skip-forward" /> {overview.week.skipped} skipped
              </button>
              <button className={`btn btn-xs${overview.needsAnswerCount ? ' btn-primary' : ''}`} type="button" onClick={() => openJobs('answer')}>
                <i className="ti ti-help-circle" /> {overview.needsAnswerCount} need an answer
              </button>
              {overview.week.failed > 0 && <Muted>{overview.week.failed} failed — see Past below</Muted>}
            </div>
          </Card>

          <Card>
            <div style={{ marginBottom: 10 }}><Band>Now</Band></div>
            {overview.activeRun ? <ActiveRun run={overview.activeRun} /> : <Muted>Nothing running.</Muted>}
          </Card>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <Band>Next</Band>
              <button className="btn btn-xs" type="button" style={{ marginLeft: 'auto' }} onClick={() => fix('schedule')}>Change</button>
            </div>
            <Hint style={{ marginTop: 0, marginBottom: 8 }}>{scheduleText(overview)}</Hint>
            {overview.schedule.enabled && overview.upcoming.length ? (
              <div style={{ fontSize: 13, marginBottom: 10 }}>
                {overview.upcoming.slice(0, 3).map(o => (
                  <div key={o.at} style={{ padding: '2px 0' }}>
                    <i className="ti ti-clock" style={{ marginRight: 6, color: 'var(--text2)' }} />
                    {fmtTime(o.at)} · {o.kinds.map(k => KIND_LABEL[k] || k).join(' + ')}
                  </div>
                ))}
              </div>
            ) : null}

            {overview.queuedRuns.map(run => (
              <div key={run.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0' }}>
                <span className="badge badge-queued">queued</span>
                <span style={{ fontSize: 13 }}>{runLabel(run.kind, run.dryRun)}</span>
                <button className="btn btn-xs" type="button" onClick={() => cancel(run.id)} disabled={busy}>Cancel</button>
              </div>
            ))}

            {overview.reviewCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 13 }}>
                <i className="ti ti-alert-triangle" style={{ color: 'var(--red)' }} />
                <span>{overview.reviewCount} job{overview.reviewCount === 1 ? '' : 's'} in your inbox</span>
                <button className="btn btn-xs btn-primary" type="button" onClick={() => setView('review')}>Open inbox</button>
              </div>
            )}
            {overview.waitingCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <i className="ti ti-hourglass" style={{ color: 'var(--text2)' }} />
                <span>
                  {overview.waitingCount} approved, waiting to be applied to
                  {overview.applyMode === 'off' ? ` — apply is off for ${platformView.label}`
                    : overview.schedule.enabled && nextApply ? ` — next apply run ${fmtTime(nextApply.at)}`
                      : ' — nothing will send these automatically'}
                </span>
                <button className="btn btn-xs" type="button" onClick={() => openJobs('waiting')}>See them</button>
              </div>
            )}
            {!readiness(overview).canRun && <div style={{ marginTop: 10 }}><Muted>Nothing can start until the problem above is fixed.</Muted></div>}
          </Card>

          <Card>
            <div style={{ marginBottom: 6 }}><Band>Past</Band></div>
            <RunTimeline runs={overview.history} />
          </Card>
        </>
      )}

      {view === 'review' && <ReviewQueue onChanged={load} />}

      {view === 'jobs' && <JobsTab overview={shown} view={jobsView} onView={setJobsView} onChanged={load} />}

      {view === 'config' && (
        config ? (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
              {single && (<>
                <button className="btn btn-xs" type="button" onClick={() => pick('all', 'config')}>All platforms</button>
                <Muted>/</Muted>
                <strong>{platformView.label} settings</strong>
              </>)}
              <span style={{ marginLeft: single ? 12 : 0, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Muted>Where each setting applies:</Muted>
                <ScopeTag only={single ? platformView.label : 'that platform'} />
                <ScopeTag />
              </span>
            </div>
            {single && overview ? (
              <>
                <ConnectionCard overview={overview} onChanged={load} />
                <SearchesCard config={config} onSaved={onConfigSaved} />
                <ScheduleCard schedule={overview.schedule} upcoming={overview.upcoming} pollSeconds={config.worker?.pollSeconds ?? 20}
                  applyMode={overview.applyMode} onSaved={onConfigSaved} />
                <FiltersCard config={config} onSaved={onConfigSaved} />
                <ApplyCard config={config} onSaved={onConfigSaved} />
              </>
            ) : (
              <PlatformsCard platforms={registry.platforms} crossOrder={registry.crossPlatformOrder}
                onChanged={onConfigSaved} onOpen={(p) => pick(p, 'config')} />
            )}
            <div style={{ margin: '18px 0 8px' }}>
              <Band>Shared by every platform</Band>
              <Hint style={{ marginTop: 2 }}>
                {single
                  ? `The same cards as before. Changing them here changes them for ${others.length ? others.join(' and ') : 'every platform'} too.`
                  : 'Screening questions are the same everywhere, so these are set once. They also appear in each platform’s settings.'}
              </Hint>
            </div>
            <ProfileCard config={config} onSaved={onConfigSaved} />
            <AnswerBank config={config} onSaved={onConfigSaved} />
            <ResumeCard config={config} onSaved={onConfigSaved} />
            <DuplicatesCard rules={config.duplicates || registry.duplicates} onSaved={onConfigSaved} />
          </>
        ) : <Empty icon="ti-loader">Loading configuration…</Empty>
      )}
      </div>
      {guide && <NaukriSetupGuide initialTab={guide} onClose={() => setGuide(null)} />}
    </Layout>
    </PlatformProvider>
  );
}
