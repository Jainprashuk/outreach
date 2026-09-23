import { useCallback, useEffect, useState } from 'react';
import type { NaukriConfig, NaukriAnswer } from '../../../lib/api';
import { updateNaukriConfigApi, testNaukriAnswerApi, naukriUnknownQuestionsApi } from '../../../lib/api';

// How the worker answers Naukri's screening questions.
//
// Three things make this card work, and all three exist because the alternative
// is a bot typing something untrue into a form with your name on it:
//
//  1. FIRST MATCH WINS, so order is meaningful and you can reorder rows.
//  2. NO MATCH MEANS SKIP. The job is left alone and the question is reported.
//  3. The questions that caused skips appear at the top as one-click additions —
//     the loop by which this bank fills itself over your first week.
//
// The tester calls the same resolver the worker uses, so it cannot flatter you.

const PLACEHOLDERS = [
  'noticePeriodDays', 'currentCtcLpa', 'expectedCtcLpa', 'totalExperienceYears',
  'totalExperienceMonths', 'currentLocation', 'preferredLocations', 'willingToRelocate',
  'fullName', 'email', 'phone', 'currentCompany', 'currentDesignation',
  'highestQualification', 'skills',
];

const blank = (): NaukriAnswer => ({ pattern: '', answer: '', kind: 'text', enabled: true });

export default function AnswerBank({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [rows, setRows] = useState<NaukriAnswer[]>(config.answers.length ? config.answers : [blank()]);
  const [onUnknown, setOnUnknown] = useState(config.onUnknownQuestion);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [unknown, setUnknown] = useState<Array<{ question: string; count: number }>>([]);
  const [probe, setProbe] = useState('');
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const loadUnknown = useCallback(async () => {
    try { setUnknown((await naukriUnknownQuestionsApi()).questions); } catch { /* not fatal */ }
  }, []);
  useEffect(() => { loadUnknown(); }, [loadUnknown]);

  const patch = (i: number, p: Partial<NaukriAnswer>) =>
    setRows(r => r.map((row, n) => (n === i ? { ...row, ...p } : row)));

  const move = (i: number, dir: -1 | 1) => setRows(r => {
    const j = i + dir;
    if (j < 0 || j >= r.length) return r;
    const next = [...r];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const usable = rows.filter(r => r.pattern.trim());
      await updateNaukriConfigApi({ answers: usable, onUnknownQuestion: onUnknown });
      setRows(usable.length ? usable : [blank()]);
      setMsg(`Saved ${usable.length} rule${usable.length === 1 ? '' : 's'}.`);
      onSaved();
    } catch (e: any) { setMsg(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  const test = async () => {
    if (!probe.trim()) return;
    try {
      const r = await testNaukriAnswerApi(probe);
      setProbeResult(
        r.matched
          ? `Matches "${r.pattern}" → types: ${r.answer}`
          : r.reason === 'unresolved-placeholders'
            ? `Rule "${r.pattern}" matches but ${r.missing.join(', ')} is not set in Profile — the job would be skipped.`
            : `No rule matches. ${r.wouldSkip ? 'The job would be skipped.' : 'The job would be applied to anyway.'}`
      );
    } catch (e: any) { setProbeResult(e?.message || 'Could not test'); }
  };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <i className="ti ti-messages" />
        <strong style={{ flex: 1 }}>Answers</strong>
        <button className="btn btn-sm" onClick={() => setRows(r => [...r, blank()])}>Add rule</button>
      </div>

      {/* The feedback loop: every skip becomes a one-click rule. */}
      {unknown.length > 0 && (
        <div style={{ padding: 10, background: 'var(--bg2)', borderRadius: 6, marginBottom: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>Questions that caused a skip</div>
          {unknown.map((u, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '3px 0' }}>
              <span style={{ flex: 1 }}>{u.question}</span>
              <span className="page-info">{u.count}×</span>
              <button className="btn btn-sm" onClick={() => setRows(r => [
                // Seeded with the question itself as the pattern. It is a
                // substring match, so the full question is the safest possible
                // starting point — you shorten it if you want it to catch more.
                ...r.filter(x => x.pattern.trim()),
                { pattern: u.question.toLowerCase(), answer: '', kind: 'text', enabled: true },
              ])}>Add rule</button>
            </div>
          ))}
        </div>
      )}

      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <span className="page-info" style={{ width: 18, textAlign: 'right' }}>{i + 1}</span>
          <input className="input" placeholder="question contains…" value={row.pattern}
            onChange={e => patch(i, { pattern: e.target.value })} style={{ flex: 1, minWidth: 170 }} />
          <input className="input" placeholder="answer, may use {{expectedCtcLpa}}" value={row.answer}
            onChange={e => patch(i, { answer: e.target.value })} style={{ flex: 1.3, minWidth: 190 }} />
          <select className="input" value={row.kind} style={{ width: 92 }}
            onChange={e => patch(i, { kind: e.target.value as NaukriAnswer['kind'] })}>
            <option value="text">text</option>
            <option value="number">number</option>
            <option value="choice">choice</option>
            <option value="yesno">yes/no</option>
          </select>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={row.enabled} onChange={e => patch(i, { enabled: e.target.checked })} />on
          </label>
          <button className="btn btn-sm" onClick={() => move(i, -1)} disabled={i === 0}><i className="ti ti-arrow-up" /></button>
          <button className="btn btn-sm" onClick={() => move(i, 1)} disabled={i === rows.length - 1}><i className="ti ti-arrow-down" /></button>
          <button className="btn btn-sm" onClick={() => setRows(r => r.filter((_, n) => n !== i))}><i className="ti ti-trash" /></button>
        </div>
      ))}

      <div className="page-info" style={{ fontSize: 11, margin: '8px 0' }}>
        First matching rule wins, so order matters. Placeholders: {PLACEHOLDERS.map(p => `{{${p}}}`).join(' ')}
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '10px 0' }}>
        <input type="checkbox" checked={onUnknown === 'apply-anyway'}
          onChange={e => setOnUnknown(e.target.checked ? 'apply-anyway' : 'skip')} />
        <span>
          Apply even when a question has no rule
          <div className="page-info" style={{ fontSize: 11 }}>
            Off is strongly recommended. On means the worker submits forms with unanswered questions.
          </div>
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Test a question…" value={probe}
          onChange={e => setProbe(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && test()} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn btn-sm" onClick={test}>Test</button>
      </div>
      {probeResult && <div style={{ fontSize: 12, marginBottom: 8 }}>{probeResult}</div>}

      {msg && <div className="page-info" style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save answers'}
      </button>
    </div>
  );
}
