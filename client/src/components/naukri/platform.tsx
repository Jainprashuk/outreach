import { createContext, useContext, type ReactNode } from 'react';
import type { PlatformCapabilities, PlatformId, PlatformInfo, PlatformScope } from '../../lib/api';

// Which job platform the components under the Job Platforms page are showing.
//
// The cards and tables were written for Naukri; they read the site's name and
// what it can do from here, so one set of components serves Naukri, Instahyre
// and Hirist (and 'all', the All platforms view). Outside the page the default
// is Naukri, exactly as before.

export interface PlatformView {
  id: PlatformScope;
  label: string;
  capabilities: PlatformCapabilities;
  sources: { searches: string; recommended: string | null };
  /** Every platform that is switched on, for the All view's platform column. */
  platforms: PlatformInfo[];
}

export const NAUKRI_VIEW: PlatformView = {
  id: 'naukri', label: 'Naukri',
  capabilities: { refresh: true, harvest: true, dryRun: true, apply: true, track: true },
  sources: { searches: 'My searches', recommended: 'Recommended jobs' },
  platforms: [],
};

const Ctx = createContext<PlatformView>(NAUKRI_VIEW);

export function PlatformProvider({ value, children }: { value: PlatformView; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePlatform = () => useContext(Ctx);

// The platform colours from the prototype, as theme tokens.
export const PLATFORM_COLOR: Record<string, string> = {
  naukri: 'var(--blue, #1557a0)', instahyre: 'var(--teal, #0f766e)', hirist: 'var(--purple, #7e22ce)',
  cutshort: 'var(--orange, #c2410c)', wellfound: 'var(--pink, #be185d)',
};
export const PLATFORM_BG: Record<string, string> = {
  naukri: 'var(--blue-bg, #eaf1fb)', instahyre: 'var(--teal-bg, #e1f5ee)', hirist: 'var(--purple-bg, #f7edfd)',
  cutshort: 'var(--orange-bg, #fdf0e6)', wellfound: 'var(--pink-bg, #fdecf4)',
};
export const PLATFORM_LABEL: Record<PlatformId, string> = {
  naukri: 'Naukri', instahyre: 'Instahyre', hirist: 'Hirist', cutshort: 'Cutshort', wellfound: 'Wellfound',
};

/** The small coloured platform tag used in tables, cards and the timeline. */
export function PlatformTag({ id, style }: { id?: string | null; style?: React.CSSProperties }) {
  const p = (id || 'naukri') as PlatformId;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 7px', borderRadius: 6,
      fontSize: 11, fontWeight: 600, color: PLATFORM_COLOR[p], background: PLATFORM_BG[p], whiteSpace: 'nowrap', ...style,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: 'currentColor' }} />
      {PLATFORM_LABEL[p] || p}
    </span>
  );
}

/** "Only Naukri" / "Shared by every platform" — where a setting applies. */
export function ScopeTag({ only }: { only?: string | null }) {
  return only ? (
    <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: 'var(--accent-bg, var(--bg3))', color: 'var(--accent, var(--text))' }}>
      Only {only}
    </span>
  ) : (
    <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: 'var(--bg3)', color: 'var(--text2)' }}>
      Shared by every platform
    </span>
  );
}

/** The duplicate badge: "Already applied via Naukri on 12 Oct" etc. */
export function DupBadge({ dup }: { dup?: { state: string; text: string } | null }) {
  if (!dup) return null;
  const strong = dup.state === 'applied' || dup.state === 'approved';
  return (
    <span title="The same company and title on another platform" style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '1px 7px', borderRadius: 6, marginTop: 3,
      background: strong ? 'var(--amber-bg, #fff8e6)' : 'var(--bg3)', color: strong ? 'var(--amber, #8a5c00)' : 'var(--text2)',
    }}>
      <i className="ti ti-copy" style={{ fontSize: 12 }} />
      {dup.state === 'pending' ? `${dup.text}. Approve one of them.` : dup.text}
    </span>
  );
}

/** "Already applied to this role" — asked before approving a duplicate. */
export function DupConfirm({ job, here, onCancel, onConfirm }: {
  job: { title: string; company: string; dup?: { label: string; state: string; at: string | null } | null };
  here: string; onCancel: () => void; onConfirm: () => void;
}) {
  const d = job.dup;
  if (!d) return null;
  const day = d.at ? new Date(d.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  return (
    <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="edit-modal" role="dialog" aria-modal="true" style={{ maxWidth: 460 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>
          {d.state === 'applied' ? 'Already applied to this role' : `Already approved on ${d.label}`}
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5, margin: '0 0 14px' }}>
          {d.state === 'applied'
            ? <>You applied to <b>{job.title}</b> at {job.company} through {d.label}{day ? ` on ${day}` : ''}. Approving it on {here} would send {job.company} a second application.</>
            : <><b>{job.title}</b> at {job.company} is approved on {d.label} and will go out from there. Approving it on {here} too could send {job.company} two applications.</>}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" type="button" onClick={onCancel} autoFocus>Keep in inbox</button>
          <button className="btn btn-sm btn-primary" type="button" onClick={onConfirm}>Approve anyway</button>
        </div>
      </div>
    </div>
  );
}
