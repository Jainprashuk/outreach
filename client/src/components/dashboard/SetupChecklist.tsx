// Shown instead of the cards until the account can actually send: Gmail connected,
// a template to send, and someone to send it to.
import { Link } from 'react-router-dom';

export interface SetupStep { key: string; title: string; detail: string; done: boolean; to: string; cta: string }

export default function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const firstOpen = steps.findIndex(s => !s.done);
  return (
    <section className="dash-setup" aria-labelledby="dash-setup">
      <h2 id="dash-setup">Get your first emails out</h2>
      <p>{steps.filter(s => s.done).length} of {steps.length} done. Most people finish in under 10 minutes.</p>
      <div className="dash-progress" aria-hidden="true">
        {steps.map(s => <i key={s.key} className={s.done ? 'on' : ''} />)}
      </div>
      {steps.map((s, i) => (
        <div key={s.key} className={`dash-step${s.done ? ' done' : ''}`}>
          <span className="dash-step-n">{s.done ? <i className="ti ti-check" /> : i + 1}</span>
          <div className="dash-row-main">
            <div className="dash-row-title">{s.title}</div>
            <div className="dash-row-sub">{s.detail}</div>
          </div>
          {s.done
            ? <span className="dash-pill green">Done</span>
            : <Link to={s.to} className={`btn btn-sm${i === firstOpen ? ' btn-primary' : ''}`}>{s.cta}</Link>}
        </div>
      ))}
    </section>
  );
}
