// The Dashboard's to-do cards. Each one is a count that opens the page owning it,
// so the number here is the number there. Cards with nothing waiting are hidden.
import { Link } from 'react-router-dom';
import { Skeleton } from '../Skeleton';

export interface NeedsTask {
  key: string;
  n: number;
  title: string;
  detail: string;
  /** amber = someone is waiting on you, red = something broke, accent = ready when you are. */
  tone: 'amber' | 'red' | 'accent';
  cta: string;
  to?: string;
  onClick?: () => void;
  busy?: boolean;
}

export default function NeedsYouStrip({ tasks, loading }: { tasks: NeedsTask[]; loading: boolean }) {
  const shown = tasks.filter(t => t.n > 0);
  return (
    <section className="dash-section" aria-labelledby="dash-needs">
      <div className="dash-label"><span id="dash-needs">Needs you</span></div>
      {loading ? (
        <div className="dash-needs">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="dash-task"><Skeleton w="30%" h={26} /><Skeleton w="70%" /><Skeleton w="90%" /></div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="dash-caught">
          <i className="ti ti-circle-check" aria-hidden="true" />
          <span><b>All caught up.</b> No replies, follow-ups, approvals or failed sends are waiting on you.</span>
        </div>
      ) : (
        <div className="dash-needs">
          {shown.map(t => {
            const body = (
              <>
                <div className="dash-task-top">
                  <span className="dash-task-n">{t.n}</span>
                  <span className={`dash-dot ${t.tone}`} aria-hidden="true" />
                </div>
                <div className="dash-task-title">{t.title}</div>
                <div className="dash-task-detail">{t.detail}</div>
                <div className="dash-task-cta">{t.busy ? 'Working…' : t.cta} <i className="ti ti-arrow-right" aria-hidden="true" /></div>
              </>
            );
            const cls = `dash-task tone-${t.tone}`;
            return t.to
              ? <Link key={t.key} to={t.to} className={cls}>{body}</Link>
              : <button key={t.key} type="button" className={cls} onClick={t.onClick} disabled={t.busy}>{body}</button>;
          })}
        </div>
      )}
    </section>
  );
}
