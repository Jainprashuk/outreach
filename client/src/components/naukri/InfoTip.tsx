import type { ReactNode } from 'react';
import HoverCard from '../HoverCard';

// A small ⓘ that explains the thing beside it on hover, focus or tap.
//
// Built on HoverCard, which already stops its click from reaching what it sits
// in — so an ⓘ inside a tab button explains the tab without switching to it.
export default function InfoTip({ title, children, align = 'left' }: {
  title: string; children: ReactNode; align?: 'left' | 'right';
}) {
  return (
    <HoverCard align={align} width={300}
      trigger={<i className="ti ti-info-circle" aria-label={`About ${title}`}
        style={{ fontSize: 13, color: 'var(--text3)', marginLeft: 5 }} />}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ color: 'var(--text2)' }}>{children}</div>
    </HoverCard>
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
