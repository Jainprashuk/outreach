import { useCallback, useEffect, useState } from 'react';
import type { NaukriConfig, NaukriAnswer } from '../../../lib/api';
import { Card, Hint } from '../ui';
import { updateNaukriConfigApi, testNaukriAnswerApi, naukriUnknownQuestionsApi, addNaukriStarterRulesApi } from '../../../lib/api';
import { useToast } from '../../../context/ToastContext';

// How the worker answers Naukri's screening questions.
//
// Three things make this card work, and all three exist because the alternative
// is a bot typing something untrue into a form with your name on it:
//
//  1. FIRST MATCH WINS, so order is meaningful and you can reorder rows.
//  2. NO MATCH MEANS SKIP. The job is left alone and the question is reported.
//  3. Reported questions are answered under Jobs → Needs answer, with an AI
//     draft from your resume; Use there adds the rule here. Saving rules here
//     re-queues any skipped job they now answer, too.
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
  const [aiDrafts, setAiDrafts] = useState(config.aiDrafts !== false);
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
      const r = await updateNaukriConfigApi({ answers: usable, aiDrafts });
      setRows(usable.length ? usable : [blank()]);
      const text = `Saved ${usable.length} rule${usable.length === 1 ? '' : 's'}.`
        + (r.requeued ? ` ${r.requeued} skipped job${r.requeued === 1 ? '' : 's'} back in Waiting.` : '');
      toast(text, 'success'); setMsg(text);
      loadUnknown();
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  const addCommon = async () => {
    setSaving(true); setMsg('');
    try {
      const r = await addNaukriStarterRulesApi();
      setRows(r.config.answers.length ? r.config.answers : [blank()]);
      const text = r.added
        ? `Added ${r.added} common rule${r.added === 1 ? '' : 's'} (notice period, CTC, experience…) at the bottom.`
          + (r.requeued ? ` ${r.requeued} skipped job${r.requeued === 1 ? '' : 's'} back in Waiting.` : '')
        : 'You already have all the common rules.';
      toast(text, 'success'); setMsg(text);
      loadUnknown();
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not add', 'error'); }
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

  const pending = unknown;

  return (
    <Card title="Answers" icon="ti-messages" collapsible id="answers" defaultOpen={false}
      badge={pending.length > 0
        ? <span className="contact-count-badge" style={{ marginLeft: 6 }}>{pending.length} unanswered</span>
        : null}
      right={<span style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-xs" type="button" onClick={addCommon} disabled={saving}
          title="Notice period, current/expected CTC, total experience, location, relocation… answered from your Profile">
          <i className="ti ti-wand" /> Add common rules
        </button>
        <button className="btn btn-xs" type="button" onClick={() => setRows(r => [...r, blank()])}>
          <i className="ti ti-plus" /> Add rule
        </button>
      </span>}>

      {pending.length > 0 ? (
        <Hint style={{ marginTop: 0, marginBottom: 12 }}>
          {pending.length} question{pending.length === 1 ? '' : 's'} stopped an application and still {pending.length === 1 ? 'has' : 'have'} no
          rule. Answer {pending.length === 1 ? 'it' : 'them'} under Jobs → Needs answer, where each comes with an AI draft from your resume.
        </Hint>
      ) : answeredCount > 0 ? (
        <Hint style={{ marginTop: 0, marginBottom: 12 }}>
          All {answeredCount} question{answeredCount === 1 ? '' : 's'} that caused a skip now have a rule.
        </Hint>
      ) : null}

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
        First matching rule wins, so order matters. Punctuation and case are ignored, and{' '}
        <code>notice period|joining time</code> matches either phrase. For a choice question, the answer must name
        one option (or, for a number, fall in its range). Placeholders: {PLACEHOLDERS.map(p => `{{${p}}}`).join(' ')}
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '10px 0' }}>
        <input type="checkbox" checked={aiDrafts} onChange={e => setAiDrafts(e.target.checked)} />
        <span>
          Draft answers from my resume with AI
          <div style={{ color: 'var(--text2)', fontSize: 11 }}>
            Drafts appear under Jobs → Needs answer for you to check. Nothing is sent until you press Use.
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
