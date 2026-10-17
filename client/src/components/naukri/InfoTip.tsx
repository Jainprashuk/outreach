import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A small ⓘ that explains the thing beside it on hover, focus or tap.
//
// Drawn into <body> with fixed positioning, like the sidebar's NavTip: the tab
// bars it sits in clip their overflow, and a panel positioned inside them was
// cut down to a sliver of border. Its click is swallowed, so an ⓘ inside a
// tab button explains the tab without switching to it.
const WIDTH = 300;

export default function InfoTip({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // Under the icon, starting at it, but never off either edge of the screen.
    const left = Math.min(Math.max(8, r.left - 12), window.innerWidth - WIDTH - 8);
    setPos({ top: r.bottom + 8, left: Math.max(8, left) });
  };
  const hide = () => setPos(null);

  // A tap elsewhere, or any scroll, closes it — a fixed panel would otherwise
  // float away from the icon it belongs to.
  useEffect(() => {
    if (!pos) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) hide(); };
    document.addEventListener('pointerdown', away);
    window.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('scroll', hide, true); };
  }, [pos]);

  return (
    <>
      <span ref={ref} tabIndex={0} role="button" aria-label={`About ${title}`}
        style={{ display: 'inline-flex', marginLeft: 5, cursor: 'help' }}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
        onClick={e => { e.preventDefault(); e.stopPropagation(); if (pos) hide(); else show(); }}>
        <i className="ti ti-info-circle" style={{ fontSize: 13, color: 'var(--text3)' }} />
      </span>
      {pos && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: pos.top, left: pos.left, width: WIDTH, zIndex: 1000,
          padding: '10px 12px', borderRadius: 'var(--radius)', background: 'var(--bg)',
          border: '1px solid var(--border-md)', boxShadow: 'var(--shadow-lg)',
          fontSize: 12.5, lineHeight: 1.45, textAlign: 'left', whiteSpace: 'normal', fontWeight: 400,
          color: 'var(--text)', textTransform: 'none', letterSpacing: 'normal', pointerEvents: 'none',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
          <div style={{ color: 'var(--text2)' }}>{children}</div>
        </div>,
        document.body,
      )}
    </>
  );
}

// What each tab and view is for — one place, so the wording stays consistent.
export const TAB_INFO: Record<string, ReactNode> = {
  activity: <>What the worker is doing right now, what is scheduled next, and every past run — open one to see what happened to each job.</>,
  review: <>New jobs from your harvests, waiting for your yes or no. Best match first: hover a job&apos;s score to see why.
    Approve sends it to Jobs → Waiting and starts an apply run; Reject drops it. With auto-approve on, high scorers skip this and go straight to Waiting.</>,
  jobs: <>Everything you have approved, by where it stands: waiting to be sent, stuck on a question, sent, or skipped for good.
    The number on this tab is how many questions need your answer.</>,
  config: <>How it all runs: searches and where to harvest from, filters, your profile, screening answers, resume, schedule, and the safety switches.</>,
};

export const JOBS_INFO: Record<string, ReactNode> = {
  waiting: <>Approved and queued to be sent, in the order the next apply run takes them. They go out when you press Apply,
    when you approve more, or at the schedule&apos;s Apply time — within the per-run and daily limits. Un-approve any you change your mind on.</>,
  answer: <>The worker stopped on a screening question it had no answer for, so it skipped the job rather than guess.
    Each question comes with an AI draft from your resume. Answer it once (Use) — it becomes a rule, and every job that asked it goes back to Waiting.</>,
  applied: <>Applications that actually went out. Update each one&apos;s status as recruiters respond (in review, interviewing, offer, rejected),
    and use Find people to reach someone at the company.</>,
  skipped: <>Jobs the worker can never apply to on Naukri: they apply on the company&apos;s own site, are walk-in drives, have closed,
    were already applied to, or you set them aside. Open the listing to apply yourself if you want one.</>,
};
