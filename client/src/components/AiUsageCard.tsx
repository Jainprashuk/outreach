// Settings → AI usage. What your AI did over the last 30 days, as counts: which
// features used it, how often it worked, the tokens it cost, whose key paid, and
// the last thing that went wrong. Never a prompt or an answer (lib/aiUsage.js).
import { useEffect, useState } from 'react';
import { HBar } from './AnalyticsCards';
import { aiUsageApi, type AiUsage } from '../lib/api';
import { cvar } from '../lib/analytics';

const PROVIDER: Record<string, string> = { groq: 'Groq', gemini: 'Gemini', cerebras: 'Cerebras' };
const when = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default function AiUsageCard() {
  const [data, setData] = useState<AiUsage | null>(null);
  useEffect(() => {
    let alive = true;
    aiUsageApi(30).then(d => { if (alive) setData(d); }).catch(() => { /* the card stays hidden */ });
    return () => { alive = false; };
  }, []);
  if (!data || !data.totals.calls) return null;

  const t = data.totals;
  const accent = cvar('--accent') || '#4f46e5';
  const teal = cvar('--teal') || '#085041';
  const red = cvar('--red') || '#c0392b';
  const failed = t.calls - t.ok;
  return (
    <div className="s-card" style={{ animationDelay: '.09s' }}>
      <div className="s-head">
        <div className="s-head-left">
          <div className="s-icon" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}><i className="ti ti-chart-dots" /></div>
          <div>
            <div className="s-title">AI usage</div>
            <div className="s-sub">
              {t.calls.toLocaleString()} calls in the last {data.days} days · {Math.round((t.ok / t.calls) * 100)}% worked · {t.tokens.toLocaleString()} tokens
            </div>
          </div>
        </div>
      </div>
      <div className="s-body">
        {data.features.map(f => (
          <HBar key={f.key} label={f.label} n={f.calls} d={t.calls} fill={accent}
            extra={` · ${f.ok} worked · ${f.tokens.toLocaleString()} tokens`} />
        ))}
        {failed > 0 && (
          <div className="sr-usage-sec">
            <h3 className="sr-h3">What happened to each call</h3>
            {data.outcomes.map(o => <HBar key={o.key} label={o.label} n={o.n} d={t.calls} fill={o.key === 'ok' ? teal : red} />)}
          </div>
        )}
        <div className="sr-usage-foot">
          {data.providers.map(p => `${PROVIDER[p.provider] || p.provider}: ${p.calls} call${p.calls === 1 ? '' : 's'}, ${p.ok} worked`).join(' · ')}
          {(t.yourKey > 0 || t.adminKey > 0) && <><br />{t.yourKey} on your keys{t.adminKey ? `, ${t.adminKey} on the admin's keys` : ''}.</>}
          {data.lastFailure && <><br />Last problem: {data.lastFailure.label.toLowerCase()} on {PROVIDER[data.lastFailure.provider] || data.lastFailure.provider}, {when(data.lastFailure.at)}.</>}
          <br /><span className="sr-faint">AI call records are kept for 30 days.</span>
        </div>
      </div>
    </div>
  );
}
