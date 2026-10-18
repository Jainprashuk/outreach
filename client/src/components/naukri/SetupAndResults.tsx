import { Fragment, useState } from 'react';
import type { NaukriOverview, NaukriStageTally } from '../../lib/api';
import { Card, Band, Muted, Hint } from './ui';
import { fmtRunTime } from './format';

// Two cards for the Activity tab.
//
// SETUP — what still needs doing for this to work well, each item with the
// card that fixes it. Hidden once everything is done (and collapsible before).
//
// RESULTS — what recruiters did with the last 30 days of applications, read
// daily from Naukri's own history: sent → viewed → shortlisted / contacted.
// Split by where the job came from and by fit score, because "which kind of
// job gets answers" is the question that changes what you approve.

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '—');

export function SetupCard({ overview, onFix }: { overview: NaukriOverview; onFix: (card: string | null) => void }) {
  const { items, done, total } = overview.setup;
  const [open, setOpen] = useState(true);
  if (done >= total) return null;
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: open ? 10 : 0 }}>
        <Band>Setup</Band>
        <span className="contact-count-badge">{done}/{total}</span>
        <div style={{ flex: 1, height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden', maxWidth: 220 }}>
          <div style={{ width: `${(100 * done) / total}%`, height: '100%', background: 'var(--green)' }} />
        </div>
        <button className="btn btn-xs" type="button" onClick={() => setOpen(o => !o)} style={{ marginLeft: 'auto' }}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && items.map(it => (
        <div key={it.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
          <i className={`ti ${it.done ? 'ti-circle-check' : 'ti-circle-dashed'}`}
            style={{ color: it.done ? 'var(--green)' : 'var(--text3)', fontSize: 16, marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: it.done ? 'var(--text2)' : 'var(--text)' }}>{it.label}</div>
            {!it.done && <Hint style={{ marginTop: 1 }}>{it.hint}</Hint>}
          </div>
          {!it.done && it.card && (
            <button className="btn btn-xs btn-primary" type="button" onClick={() => onFix(it.card)}>Fix</button>
          )}
        </div>
      ))}
    </Card>
  );
}

function Funnel({ t, compact = false }: { t: NaukriStageTally; compact?: boolean }) {
  const steps: Array<[string, number, string]> = [
    ['sent', t.sent, 'var(--text2)'],
    ['viewed', t.viewed, 'var(--text)'],
    ['shortlisted', t.shortlisted, 'var(--green)'],
    ['contacted', t.contacted, 'var(--green)'],
  ];
  return (
    <span style={{ display: 'inline-flex', gap: compact ? 10 : 16, flexWrap: 'wrap', fontSize: compact ? 12 : 13 }}>
      {steps.map(([label, n, color]) => (
        <span key={label} style={{ color }}>
          <strong>{n}</strong> {label}{label !== 'sent' && t.sent ? <Muted> ({pct(n, t.sent)})</Muted> : null}
        </span>
      ))}
    </span>
  );
}

export function ResultsCard({ overview, onCheck, busy }: { overview: NaukriOverview; onCheck: () => void; busy: boolean }) {
  const r = overview.results;
  if (!r) return null;
  const tracked = !!r.lastTracked;
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <Band>Results · last {r.days} days</Band>
        <Muted>{tracked ? `checked ${fmtRunTime(r.lastTracked)}` : 'not checked yet'}</Muted>
        <button className="btn btn-xs" type="button" onClick={onCheck} disabled={busy} style={{ marginLeft: 'auto' }}
          title="Read what recruiters did from Naukri's My applies (read-only)">
          <i className="ti ti-refresh" /> Check replies now
        </button>
      </div>
      {!r.sent ? (
        <Muted>Nothing sent from here in the last {r.days} days yet.</Muted>
      ) : (
        <>
          <Funnel t={r} />
          {r.notShortlisted > 0 && <Muted style={{ display: 'block', marginTop: 4 }}>{r.notShortlisted} not shortlisted</Muted>}
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', alignItems: 'baseline' }}>
            {r.bySource.search.sent > 0 && (<><Muted>My searches</Muted><Funnel t={r.bySource.search} compact /></>)}
            {r.bySource.recommended.sent > 0 && (<><Muted>Recommended</Muted><Funnel t={r.bySource.recommended} compact /></>)}
            {Object.entries(r.byScore).filter(([, t]) => t.sent > 0).map(([band, t]) => (
              <Fragment key={band}><Muted>Fit {band}</Muted><Funnel t={t} compact /></Fragment>
            ))}
          </div>
          {!tracked && (
            <Hint style={{ marginTop: 8 }}>
              Replies are read once a day from Naukri&apos;s My applies (Schedule → Track replies), or now with the button above.
            </Hint>
          )}
        </>
      )}
    </Card>
  );
}
