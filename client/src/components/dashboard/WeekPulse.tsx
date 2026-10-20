// This week against last week: sent, replies, reply rate, interviews — each with
// a 14-day sparkline. The whole row opens Analytics, which has the detail.
import { Link } from 'react-router-dom';
import type { AnalyticsSummary, Interview } from '../../lib/api';
import { Skeleton } from '../Skeleton';

const DAY = 86400000;

function Spark({ values }: { values: number[] }) {
  const w = 120, h = 34;
  const max = Math.max(...values), min = Math.min(...values), range = max - min || 1;
  const pts = values.map((v, i) => [i * (w / Math.max(1, values.length - 1)), h - 4 - ((v - min) / range) * (h - 10)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const end = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" className="dash-spark">
      <path className="ar" d={`${d} L${w} ${h} L0 ${h}Z`} />
      <path className="ln" d={d} vectorEffect="non-scaling-stroke" />
      <circle className="end" cx={end[0] - 2} cy={end[1]} r={2.5} />
    </svg>
  );
}

interface Kpi { label: string; value: string; delta: string; up: boolean | null; series: number[] }

function kpis(a: AnalyticsSummary, interviews: Interview[]): Kpi[] {
  const { s1, s2, r1, r2 } = a.week;
  const days = a.series['30'].slice(-14);
  const rate = (r: number, s: number) => (s > 0 ? (r / s) * 100 : 0);
  const rate1 = rate(r1, s1), rate2 = rate(r2, s2);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = today.getTime() - 13 * DAY;
  const ivDays = new Array(14).fill(0);
  let iv1 = 0, iv2 = 0;
  const now = Date.now();
  for (const iv of interviews) {
    const t = new Date(iv.createdAt).getTime();
    if (t >= start) ivDays[Math.min(13, Math.floor((t - start) / DAY))]++;
    if (t >= now - 7 * DAY) iv1++;
    else if (t >= now - 14 * DAY) iv2++;
  }

  const diff = (n: number) => (n === 0 ? 'same' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`);
  const pctDiff = s2 > 0 ? Math.round(((s1 - s2) / s2) * 100) : null;
  return [
    { label: 'Emails sent', value: s1.toLocaleString(), delta: pctDiff === null ? diff(s1 - s2) : `${pctDiff >= 0 ? '+' : '−'}${Math.abs(pctDiff)}%`, up: s1 === s2 ? null : s1 > s2, series: days.map(d => d.sent) },
    { label: 'Replies', value: r1.toLocaleString(), delta: diff(r1 - r2), up: r1 === r2 ? null : r1 > r2, series: days.map(d => d.replied) },
    // Under 10 sends a week the rate swings on a single reply, so it shows a dash.
    { label: 'Reply rate', value: s1 >= 10 ? `${rate1.toFixed(1)}%` : '—', delta: s1 < 10 || s2 < 10 ? (s1 < 10 ? 'too few sends' : '') : `${rate1 >= rate2 ? '+' : '−'}${Math.abs(rate1 - rate2).toFixed(1)} pt`,
      up: s1 < 10 || s2 < 10 || Math.abs(rate1 - rate2) < 0.05 ? null : rate1 > rate2, series: days.map(d => rate(d.replied, d.sent)) },
    { label: 'Interviews added', value: String(iv1), delta: diff(iv1 - iv2), up: iv1 === iv2 ? null : iv1 > iv2, series: ivDays },
  ];
}

export default function WeekPulse({ analytics, interviews }: { analytics: AnalyticsSummary | null; interviews: Interview[] }) {
  return (
    <section className="dash-section" aria-labelledby="dash-week">
      <div className="dash-label">
        <span id="dash-week">Last 7 days vs the 7 before</span>
        <Link to="/analytics">Open Analytics <i className="ti ti-arrow-right" aria-hidden="true" /></Link>
      </div>
      <div className="dash-kpis">
        {!analytics ? [0, 1, 2, 3].map(i => (
          <div key={i} className="dash-kpi"><Skeleton w="50%" /><Skeleton w="40%" h={24} /><Skeleton h={30} /></div>
        )) : kpis(analytics, interviews).map(k => (
          <Link key={k.label} to="/analytics" className="dash-kpi">
            <span className="dash-kpi-label">{k.label}</span>
            <span className="dash-kpi-value">
              {k.value}
              <span className={`dash-delta ${k.up === null ? '' : k.up ? 'up' : 'down'}`}>{k.delta}</span>
            </span>
            <Spark values={k.series} />
          </Link>
        ))}
      </div>
    </section>
  );
}
