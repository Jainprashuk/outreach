// A company's "worth searching" score, with the full working on hover: every point
// and why, how much came from your own data vs outside signals, and why a company
// isn't being suggested even if its score is high.
import HoverCard from './HoverCard';
import type { WorthReason } from '../lib/api';

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
const EXCLUDED: Record<string, string> = {
  searched: 'Not suggested: searched in the last 30 days.',
  'said-no': 'Not suggested: someone there said no in the last 90 days.',
  blocked: 'Not suggested: the domain is on your blocklist.',
  offer: 'Not suggested: you have an offer here.',
  dismissed: 'Not suggested: you marked it not worth it.',
};

export default function ScoreBadge({ score, base, reasons, notes = [], excluded = null, minScore = 5, align = 'right' }: {
  score: number;
  base?: number;
  reasons: WorthReason[];
  notes?: string[];
  excluded?: string | null;
  minScore?: number;
  align?: 'left' | 'right';
}) {
  const own = base ?? reasons.filter(r => r.kind === 'app').reduce((n, r) => n + r.points, 0);
  const outside = score - own;
  const cls = excluded ? 'badge-seen' : score >= minScore ? 'badge-approved' : 'badge-queued';
  return (
    <HoverCard align={align} trigger={<span className={`badge ${cls}`} style={{ fontSize: 13, fontWeight: 600 }}>{score}</span>}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Why {score}?</div>
      {reasons.length === 0 ? (
        <div style={{ color: 'var(--text2)' }}>No signals yet — no replies, applications or busy hiring here.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {reasons.map((r, i) => (
              <tr key={i}>
                <td style={{ width: 30, verticalAlign: 'top', padding: '2px 6px 2px 0', fontWeight: 600, color: r.points > 0 ? 'var(--green)' : 'var(--red)' }}>{sign(r.points)}</td>
                <td style={{ padding: '2px 0', color: 'var(--text2)' }}>
                  {r.text}{r.kind !== 'app' && <span style={{ color: 'var(--text3)' }}> · outside signal</span>}
                </td>
              </tr>
            ))}
            <tr><td colSpan={2} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, color: 'var(--text2)' }}>
              <strong style={{ color: 'var(--text)' }}>{score}</strong> = {own} from your own data{outside ? ` ${outside > 0 ? '+' : '−'} ${Math.abs(outside)} from outside signals` : ''}
            </td></tr>
          </tbody>
        </table>
      )}
      {notes.length > 0 && <div style={{ marginTop: 6, color: 'var(--text3)' }}>Unavailable (adds 0): {notes.join(' · ')}</div>}
      <div style={{ marginTop: 6, color: 'var(--text3)' }}>
        {excluded ? EXCLUDED[excluded] || 'Not suggested.' : score >= minScore ? `Suggested: ${minScore}+ makes the Worth searching list.` : `Below ${minScore}, so not suggested.`}
      </div>
    </HoverCard>
  );
}
