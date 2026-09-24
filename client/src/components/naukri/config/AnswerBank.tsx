import { useCallback, useEffect, useState } from 'react';
import type { NaukriConfig, NaukriAnswer } from '../../../lib/api';
import { Card, Hint } from '../ui';
import { updateNaukriConfigApi, testNaukriAnswerApi, naukriUnknownQuestionsApi } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

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
  const toast = useToast();
  const [onUnknown, setOnUnknown] = useState(config.onUnknownQuestion);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [unknown, setUnknown] = useState<Array<{ question: string; count: number }>>([]);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [probe, setProbe] = useState('');
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const loadUnknown = useCallback(async () => {
    try {
      const r = await naukriUnknownQuestionsApi();
      setUnknown(r.questions); setAnsweredCount(r.answeredCount || 0);
    } catch { /* not fatal */ }
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
      { toast(`Saved ${usable.length} rule${usable.length === 1 ? '' : 's'}.`, 'success'); setMsg(`Saved ${usable.length} rule${usable.length === 1 ? '' : 's'}.`); };
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
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

  // A draft rule covers a question when its pattern appears in it — the same
  // substring test the worker applies. Case-insensitive because patterns are
  // stored lowercased.
  const covered = (q: string) => rows.some(r =>
    r.enabled !== false && r.pattern.trim() && q.toLowerCase().includes(r.pattern.trim().toLowerCase()));
  const pending = unknown.filter(u => !covered(u.question));

  return (
    <Card title="Answers" icon="ti-messages" collapsible id="answers" defaultOpen={false}
      badge={pending.length > 0
        ? <span className="contact-count-badge" style={{ marginLeft: 6 }}>{pending.length} unanswered</span>
        : null}
      right={<button className="btn btn-xs" type="button" onClick={() => setRows(r => [...r, blank()])}>
        <i className="ti ti-plus" /> Add rule
      </button>}>

      {/* The feedback loop: every skip becomes a one-click rule.
          Filtered against the DRAFT rows as well as the saved ones, so a
          question disappears the moment you add its rule rather than lingering
          until you save — the list is a to-do, and a done item that stays on it
          gets answered twice. */}
      {pending.length === 0 && answeredCount > 0 && (
        <Hint style={{ marginTop: 0, marginBottom: 12 }}>
          All {answeredCount} question{answeredCount === 1 ? '' : 's'} that caused a skip now have a rule.
          Those jobs retry on the next apply run.
        </Hint>
      )}

      {pending.length > 0 && (
        <div style={{ padding: 10, background: 'var(--bg2)', borderRadius: 6, marginBottom: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>Questions that caused a skip</div>
          {pending.map((u, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '3px 0' }}>
              <span style={{ flex: 1 }}>{u.question}</span>
              <span style={{ color: 'var(--text2)', fontSize: 12 }}>{u.count}×</span>
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
          <span style={{ color: 'var(--text2)', fontSize: 12, width: 18, textAlign: 'right' }}>{i + 1}</span>
          <input type="text" placeholder="question contains…" value={row.pattern}
            onChange={e => patch(i, { pattern: e.target.value })} style={{ flex: 1, minWidth: 170 }} />
          <input type="text" placeholder="answer, may use {{expectedCtcLpa}}" value={row.answer}
            onChange={e => patch(i, { answer: e.target.value })} style={{ flex: 1.3, minWidth: 190 }} />
          <select value={row.kind} style={{ width: 92 }}
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

      <div style={{ color: 'var(--text2)', fontSize: 11, margin: '8px 0' }}>
        First matching rule wins, so order matters. Placeholders: {PLACEHOLDERS.map(p => `{{${p}}}`).join(' ')}
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '10px 0' }}>
        <input type="checkbox" checked={onUnknown === 'apply-anyway'}
          onChange={e => setOnUnknown(e.target.checked ? 'apply-anyway' : 'skip')} />
        <span>
          Apply even when a question has no rule
          <div style={{ color: 'var(--text2)', fontSize: 11 }}>
            Off is strongly recommended. On means the worker submits forms with unanswered questions.
          </div>
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' }}>
        <input type="text" placeholder="Test a question…" value={probe}
          onChange={e => setProbe(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && test()} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn btn-sm" onClick={test}>Test</button>
      </div>
      {probeResult && <div style={{ fontSize: 12, marginBottom: 8 }}>{probeResult}</div>}

      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save answers'}
      </button>
    </Card>
  );
}
