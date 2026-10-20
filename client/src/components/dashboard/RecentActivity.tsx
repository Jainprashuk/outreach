// The last week's events worth a look — replies, bounces, interviews — newest first.
// The only list left on the Dashboard; browsing contacts lives on the Contacts page.
import { Link } from 'react-router-dom';
import type { AnalyticsActivity, Interview } from '../../lib/api';
import { ACTIVITY_META } from '../../lib/analytics';
import { INTERVIEW_STATUS_LABELS } from '../../lib/interviews';
import { SkeletonRows } from '../Skeleton';
import { fmtAgo } from './format';

const SHOWN = new Set(['replied', 'follow-up-replied', 'bounced', 'in-review', 'no-openings']);
const MAX_ROWS = 8;
const WEEK = 7 * 86400000;

interface Item { key: string; t: number; icon: string; tone: string; title: string; sub: string; to: string; cta: string }

function items(activity: AnalyticsActivity, interviews: Interview[]): Item[] {
  const meta = new Map(ACTIVITY_META.map(m => [m.type, m]));
  const out: Item[] = (activity.feeds['7d'] || []).filter(e => SHOWN.has(e.type)).map(e => {
    const m = meta.get(e.type);
    const replied = e.type === 'replied' || e.type === 'follow-up-replied';
    return {
      key: `c-${e.id}-${e.type}-${e.t}`,
      t: e.t,
      icon: m?.icon || 'ti-point',
      tone: replied ? 'green' : e.type === 'bounced' ? 'red' : 'muted',
      title: `${e.name}${e.company ? ` (${e.company})` : ''}`,
      sub: m?.label || e.type,
      to: replied ? `/mailbox?tab=all&contact=${e.id}` : `/contacts?q=${encodeURIComponent(e.name)}`,
      cta: replied ? 'Open' : 'View',
    };
  });
  const cutoff = activity.now - WEEK;
  for (const iv of interviews) {
    const t = new Date(iv.createdAt).getTime();
    if (t < cutoff) continue;
    out.push({
      key: `i-${iv.id}`, t, icon: 'ti-calendar-event', tone: 'accent',
      title: `${iv.company}${iv.role ? `: ${iv.role}` : ''}`,
      sub: `Interview added · ${INTERVIEW_STATUS_LABELS[iv.status] || iv.status}`,
      to: `/interviews?open=${iv.id}`, cta: 'Open',
    });
  }
  return out.sort((a, b) => b.t - a.t).slice(0, MAX_ROWS);
}

export default function RecentActivity({ activity, interviews }: { activity: AnalyticsActivity | null; interviews: Interview[] }) {
  const rows = activity ? items(activity, interviews) : [];
  return (
    <section className="dash-panel" aria-labelledby="dash-activity">
      <h3 id="dash-activity">Recent activity</h3>
      {!activity ? <table><tbody><SkeletonRows rows={4} cols={2} /></tbody></table>
        : rows.length === 0 ? <div className="dash-empty">No replies, bounces or interviews in the last 7 days.</div>
        : (
          <div className="dash-list">
            {rows.map(r => (
              <Link key={r.key} to={r.to} className="dash-row">
                <span className={`dash-ico ${r.tone}`} aria-hidden="true"><i className={`ti ${r.icon}`} /></span>
                <div className="dash-row-main">
                  <div className="dash-row-title">{r.title}</div>
                  <div className="dash-row-sub">{r.sub} · {fmtAgo(r.t, activity.now)}</div>
                </div>
                <span className="btn btn-xs">{r.cta}</span>
              </Link>
            ))}
          </div>
        )}
      <div className="dash-foot"><Link to="/contacts">Browse all contacts <i className="ti ti-arrow-right" aria-hidden="true" /></Link></div>
    </section>
  );
}
