import { useCallback, useEffect, useRef, useState } from 'react';
import type { NaukriQuestionGroup, NaukriAutoAnswer } from '../../lib/api';
import { naukriNeedsAnswerApi, draftNaukriAnswerApi, useNaukriAnswerApi, ignoreNaukriQuestionApi, isAiKeyRequired, reviewNaukriAutoAnswerApi } from '../../lib/api';
import { Card, Muted, Hint, Empty, Notice } from './ui';
import { PLATFORM_LABEL } from './platform';
import { useToast } from '../../context/ToastContext';

// Screening questions that stopped an application, one card per QUESTION —
// answering it once unblocks every job that asked it.
//
// Each card carries an AI draft written from your resume, with the resume line
// it came from. The draft is only ever a suggestion: pressing Use is what turns
// it into an answer-bank rule, and that is the moment the blocked jobs go back
// to Waiting. Nothing a recruiter sees was written without you reading it.

const DRAFT_CONCURRENCY = 3;

type AutoMeta = { enabled: boolean; minConfidence: number };

// Answers the AI gave live during applies. Already sent — this is the review:
// Keep makes it yours, Edit corrects it for next time, Remove deletes the rule.
function AutoAnswered({ items, busy, onReview }: {
  items: NaukriAutoAnswer[]; busy: boolean;
  onReview: (pattern: string, action: 'keep' | 'edit' | 'remove', answer?: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  return (
    <Card title={`Auto-answered by AI · ${items.length}`} icon="ti-sparkles" style={{ marginBottom: 14 }}>
      <Hint style={{ marginTop: 0, marginBottom: 8 }}>
        The AI answered these during an apply because it was sure enough. They are saved as rules, so the same question
        is answered the same way next time. Keep the right ones, fix any that are off.
      </Hint>
      {items.map(a => (
        <div key={a.pattern} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{a.pattern}</div>
          {editing === a.pattern ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <input type="text" value={text} onChange={e => setText(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
              <button className="btn btn-sm btn-primary" type="button" disabled={busy || !text.trim()}
                onClick={() => { onReview(a.pattern, 'edit', text.trim()); setEditing(null); }}>Save</button>
              <button className="btn btn-sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 3 }}>
              <span style={{ fontSize: 13 }}>→ <strong>{a.answer}</strong></span>
              {a.confidence != null && <span className="badge badge-seen">{a.confidence}% sure</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="btn btn-xs btn-primary" type="button" disabled={busy} onClick={() => onReview(a.pattern, 'keep')}>Keep</button>
                <button className="btn btn-xs" type="button" disabled={busy} onClick={() => { setEditing(a.pattern); setText(a.answer); }}>Edit</button>
                <button className="btn btn-xs" type="button" disabled={busy} onClick={() => onReview(a.pattern, 'remove')}>Remove</button>
              </span>
            </div>
          )}
          {a.quote && <Hint>From: “{a.quote}”</Hint>}
        </div>
      ))}
    </Card>
  );
}

function QuestionCard({ group, busy, auto, onUse, onIgnore }: {
  group: NaukriQuestionGroup & { drafting?: boolean };
  busy: boolean;
  auto: AutoMeta;
  onUse: (answer: string, pattern?: string) => void;
  onIgnore: () => void;
}) {
  const d = group.draft;
  const [answer, setAnswer] = useState(d && d.status === 'ready' ? d.answer : '');
  const [pattern, setPattern] = useState('');
  const [showRule, setShowRule] = useState(false);
  // A draft that arrives after the card mounted fills the box — unless you
  // already started typing your own.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && d && d.status === 'ready') setAnswer(d.answer);
  }, [d]);
  const set = (v: string) => { touched.current = true; setAnswer(v); };

  return (
    <Card style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.4 }}>{group.question}</div>
          <Muted>
            blocks {group.count} job{group.count === 1 ? '' : 's'}:{' '}
            {group.jobs.slice(0, 3).map((j, i) => (
              <span key={j.id}>{i > 0 && ', '}<a href={j.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{j.title} · {j.company}</a>
                {j.platform && (group.platforms || []).length > 1 ? ` (${PLATFORM_LABEL[j.platform]})` : ''}</span>
            ))}
            {group.count > 3 && ` +${group.count - 3} more`}
          </Muted>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        {group.options.length > 0 ? (
          <select value={answer} onChange={e => set(e.target.value)} style={{ width: '100%', maxWidth: 420 }}>
            <option value="">Choose an answer…</option>
            {group.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input type="text" value={answer} onChange={e => set(e.target.value)}
            placeholder={group.drafting ? 'Drafting from your resume…' : 'Type the answer'}
            style={{ width: '100%' }} />
        )}

        {group.drafting && <Hint><i className="ti ti-loader" /> Drafting from your resume…</Hint>}
        {!group.drafting && d && d.status === 'ready' && d.quote && (
          <Hint>
            <i className="ti ti-sparkles" style={{ marginRight: 4 }} />
            AI draft{d.confidence ? ` (${d.confidence}% sure)` : ''}, from {d.source === 'answer' ? 'an answer you gave before' : `your ${d.source || 'resume'}`}: “{d.quote}” — check it before you use it.
            {auto.enabled && (d.confidence || 0) < auto.minConfidence && ` Below your ${auto.minConfidence}% bar, so it was not used automatically.`}
          </Hint>
        )}
        {!group.drafting && d && d.status === 'unknown' && (
          <Hint>Your resume, profile and earlier answers don’t say — type the answer yourself.</Hint>
        )}
        {!group.drafting && d && d.status === 'error' && (
          <Hint>AI was busy; type it yourself, or come back to this tab later for a draft.</Hint>
        )}
      </div>

      {showRule && (
        <div style={{ marginTop: 8 }}>
          <span className="form-label">Use this answer for any question containing</span>
          <input type="text" value={pattern} onChange={e => setPattern(e.target.value)}
            placeholder={group.question.toLowerCase()} style={{ width: '100%' }} />
          <Hint>Leave blank to match this exact question only. Shorten it (say, to “notice period”) to cover similar wording too.</Hint>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-primary" type="button" disabled={busy || !answer.trim()}
          onClick={() => onUse(answer.trim(), pattern.trim() || undefined)}>
          <i className="ti ti-check" /> Use — re-queue {group.count}
        </button>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setShowRule(v => !v)}>
          {showRule ? 'Exact question only' : 'Match similar questions'}
        </button>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={onIgnore}
          title="Don't answer this one; its jobs are dismissed">
          Ignore
        </button>
      </div>
    </Card>
  );
}

export default function NeedsAnswer({ onChanged }: { onChanged: () => void }) {
  const [groups, setGroups] = useState<Array<NaukriQuestionGroup & { drafting?: boolean }>>([]);
  const [meta, setMeta] = useState<{ aiDrafts: boolean; hasResumeText: boolean; autoAnswer: AutoMeta } | null>(null);
  const [autoAnswered, setAutoAnswered] = useState<NaukriAutoAnswer[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const drafting = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await naukriNeedsAnswerApi();
      setGroups(r.questions);
      setMeta({ aiDrafts: r.aiDrafts, hasResumeText: r.hasResumeText, autoAnswer: r.autoAnswer || { enabled: false, minConfidence: 85 } });
      setAutoAnswered(r.autoAnswered || []);
      if (r.autoRequeued) {
        toast(`${r.autoRequeued} job${r.autoRequeued === 1 ? '' : 's'} back in Waiting — the AI was sure enough to answer for you.`, 'success');
        onChanged();
      }
    } catch (e: any) { toast(e?.message || 'Could not load', 'error'); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // Ask for the drafts that are missing, a few at a time. Each is its own
  // request so none comes near the server's time limit; one failing leaves the
  // others alone.
  useEffect(() => {
    if (!meta || !meta.aiDrafts || drafting.current) return;
    // Missing drafts only. An 'error' draft is retried on the next visit to
    // the tab (a fresh load), never in a loop here.
    const todo = groups.filter(g => !g.draft).map(g => g.question);
    if (!todo.length) return;
    drafting.current = true;
    setGroups(gs => gs.map(g => (todo.includes(g.question) ? { ...g, drafting: true } : g)));
    (async () => {
      const queue = [...todo];
      let noKey = false;
      let autoChanged = false;
      const worker = async () => {
        for (let q = queue.shift(); q; q = queue.shift()) {
          const question = q;
          try {
            if (noKey) throw new Error('no key');
            const r = await draftNaukriAnswerApi(question);
            if (r.autoUsed) {
              // Sure enough with auto-answer on: already saved as an auto rule.
              toast(`AI was ${r.draft.confidence}% sure — answered automatically`
                + (r.requeued ? `, ${r.requeued} job${r.requeued === 1 ? '' : 's'} back in Waiting.` : '.'), 'success');
              setGroups(gs => gs.filter(g => g.question !== question));
              autoChanged = true;
              continue;
            }
            setGroups(gs => gs.map(g => (g.question === question ? { ...g, draft: r.draft, drafting: false } : g)));
          } catch (e) {
            // No AI key: say so once and stop asking — every other question would fail the same way.
            if (isAiKeyRequired(e) && !noKey) { noKey = true; toast((e as Error).message, 'error'); }
            setGroups(gs => gs.map(g => (g.question === question
              ? { ...g, draft: { answer: '', quote: '', source: '', status: 'error' }, drafting: false } : g)));
          }
        }
      };
      await Promise.all(Array.from({ length: DRAFT_CONCURRENCY }, worker));
      drafting.current = false;
      // Auto-used answers moved jobs and added rules: refresh the counts and
      // the Auto-answered list.
      if (autoChanged) { onChanged(); load(); }
    })();
    // Runs once per load: errors are not retried in a loop, only on the next visit.
  }, [meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const use = async (question: string, answer: string, pattern?: string) => {
    setBusy(true);
    try {
      const r = await useNaukriAnswerApi(question, answer, pattern);
      // The answer bank is shared: say which platforms it just freed jobs on.
      const on = (r.platforms || []).map(p => p.label).join(', ');
      toast(r.requeued
        ? `Saved to the answer bank. ${r.requeued} job${r.requeued === 1 ? '' : 's'}${on ? ` on ${on}` : ''} will be retried on the next apply run.`
        : 'Saved to the answer bank.', 'success');
      // A broader pattern may have answered other questions too: reload.
      await load(); onChanged();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); }
    finally { setBusy(false); }
  };

  const ignore = async (question: string) => {
    setBusy(true);
    try {
      const r = await ignoreNaukriQuestionApi(question);
      toast(`Ignored — ${r.dismissed} job${r.dismissed === 1 ? '' : 's'} dismissed.`, 'info');
      setGroups(gs => gs.filter(g => g.question !== question));
      onChanged();
    } catch (e: any) { toast(e?.message || 'Could not ignore', 'error'); }
    finally { setBusy(false); }
  };

  const review = async (pattern: string, action: 'keep' | 'edit' | 'remove', answer?: string) => {
    setBusy(true);
    try {
      await reviewNaukriAutoAnswerApi(pattern, action, answer);
      toast(action === 'remove' ? 'Removed — that question will need an answer again.' : 'Saved as your answer.', 'success');
      await load();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); }
    finally { setBusy(false); }
  };

  if (!meta) return <Empty icon="ti-loader">Loading…</Empty>;
  const autoCard = autoAnswered.length > 0 && <AutoAnswered items={autoAnswered} busy={busy} onReview={review} />;
  if (!groups.length) {
    return (
      <>
        {autoCard}
        <Empty icon="ti-circle-check">No questions waiting. Jobs stopped by a screening question show up here.</Empty>
      </>
    );
  }

  const blocked = groups.reduce((n, g) => n + g.count, 0);
  return (
    <>
      <Notice icon="ti-share">
        Answers go into one answer bank shared by every platform. Answer once and the jobs below are retried on their
        own platform&apos;s next apply run.
      </Notice>
      {autoCard}
      {!meta.aiDrafts && (
        <Notice icon="ti-info-circle">AI drafts are off (Configuration → Answers). You can still answer each question below.</Notice>
      )}
      {meta.aiDrafts && !meta.hasResumeText && (
        <Notice tone="warn" icon="ti-file-alert">
          No resume text yet, so drafts come only from your profile. Upload a PDF resume (or paste its text) in
          Configuration → Resume for better drafts.
        </Notice>
      )}
      <Hint style={{ marginBottom: 10 }}>
        {groups.length} question{groups.length === 1 ? '' : 's'} blocking {blocked} job{blocked === 1 ? '' : 's'}.
        Answer each once — it becomes a rule, and every job that asked it goes back to Waiting.
      </Hint>
      {groups.map(g => (
        <QuestionCard key={g.question} group={g} busy={busy} auto={meta.autoAnswer}
          onUse={(a, p) => use(g.question, a, p)} onIgnore={() => ignore(g.question)} />
      ))}
    </>
  );
}
