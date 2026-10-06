// "How this search went" — every step of a Find-people run in plain words: what it
// found, why something was skipped, and the one thing you can do about it.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProspectSearch, ProspectSearchStep } from '../../lib/api';
import { CONFIDENCE_LABEL, PATTERN_EXAMPLE, SOURCE_LABEL } from '../../lib/prospects';

type Tone = 'good' | 'info' | 'warn' | 'bad' | 'muted' | 'busy';
interface Line { title: string; text?: string; tone: Tone; action?: { label: string; to?: string; onClick?: () => void } }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ago(at?: string | null) {
  if (!at) return '';
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const PENDING: Record<string, string> = {
  company: 'Finding the company',
  'people-search': 'Searching the web for people',
  github: 'Checking the company’s GitHub',
  website: 'Reading the company’s website',
  pattern: 'Working out their email format',
  emails: 'Guessing each person’s address',
};

const SETTINGS = { label: 'Open Settings', to: '/settings' };

function describe(step: ProspectSearchStep, search: ProspectSearch, onSetOrg?: () => void): Line {
  const i: any = step.info || {};
  const domain = search.domain;
  if (step.status === 'pending') return { title: PENDING[step.key], tone: 'muted' };
  if (step.status === 'running') return { title: `${PENDING[step.key]}…`, tone: 'busy' };
  // Searches run before the report existed carry only a short note.
  if (!step.info || !Object.keys(step.info).length) {
    const tone: Tone = step.status === 'done' ? 'good' : step.status === 'error' ? 'warn' : 'muted';
    return { title: PENDING[step.key], text: step.detail, tone };
  }

  switch (step.key) {
    case 'company': {
      if (i.hasMx === false) {
        return { title: `${domain} can’t receive email`, tone: 'bad',
          text: 'It has no mail server, so nobody there can be emailed. Check that you picked the right company.' };
      }
      const from = i.nameFrom === 'website' ? ' Name taken from their website.' : i.nameFrom === 'contacts' ? ' Name taken from your contacts.' : '';
      return { title: `Found ${i.companyName || search.companyName || domain}`, tone: 'good',
        text: `${domain}${i.hasMx ? ' · can receive email' : ''}.${from}` };
    }

    case 'people-search': {
      if (i.reason === 'no-key') {
        return { title: 'Web search skipped', tone: 'info', action: SETTINGS,
          text: 'Add a free Tavily key to find people through web search — that’s where most people come from.' };
      }
      if (i.reason === 'allowance') {
        return { title: 'Free web searches used up for this month', tone: 'warn', action: SETTINGS,
          text: 'They reset on the 1st. A free SerpApi key in Settings gives 250 more.' };
      }
      if (i.reason === 'bad-key') return { title: 'The search key was rejected', tone: 'bad', action: SETTINGS, text: 'Check or replace it in Settings.' };
      if (step.status === 'error') return { title: 'Web search didn’t work this time', tone: 'warn', text: `${step.detail}. The other sources still ran.` };
      const found = i.found || 0;
      const parts: string[] = [];
      if (search.roles.length && i.roleMatches) parts.push(`${i.roleMatches} match your roles`);
      if (found && i.added < found) parts.push(`${found - i.added} were already in your list`);
      parts.push(`${plural(i.queries || 0, 'search', 'searches')}`);
      if (i.leftThisMonth != null) parts.push(`${i.leftThisMonth} free left this month`);
      if (!found) {
        return { title: 'No one found through web search', tone: 'warn',
          text: search.roles.length ? 'Try broader roles, or leave roles empty to find anyone there.' : `Few public profiles mention ${search.companyName || domain}.` };
      }
      return { title: `Found ${plural(found, 'person', 'people')} through web search`, tone: 'good', text: parts.join(' · ') };
    }

    case 'github': {
      if (i.reason === 'rate-limit') {
        return { title: 'GitHub is limiting requests right now', tone: 'warn', action: SETTINGS,
          text: i.hasToken ? 'Skipped this time — try Search again in a few minutes.'
            : 'Skipped. A free GitHub token in Settings fixes this — then use Search again.' };
      }
      if (i.reason === 'no-org') {
        return { title: 'No GitHub organisation found', tone: 'muted', action: onSetOrg ? { label: 'Set it by hand', onClick: onSetOrg } : undefined,
          text: 'Normal for companies that don’t publish code.' };
      }
      if (i.reason === 'recent') {
        return { title: i.org ? `GitHub checked ${ago(i.checkedAt)}` : 'GitHub checked recently', tone: 'muted',
          text: i.org ? `Reusing github.com/${i.org} (${plural(i.addresses || 0, 'address', 'addresses')}). Search again re-reads it.` : 'No organisation then — Search again re-checks.' };
      }
      if (step.status === 'error') return { title: 'Couldn’t read GitHub this time', tone: 'warn', text: step.detail };
      if (!i.addresses) {
        return { title: `github.com/${i.org} has no work addresses`, tone: 'muted', text: 'Their engineers commit with personal addresses.' };
      }
      return { title: `Found ${plural(i.addresses, 'real work address', 'real work addresses')} on GitHub`, tone: 'good',
        text: `In github.com/${i.org}’s code — real addresses prove the company’s email format${i.found ? `, and add ${plural(i.found, 'person', 'people')}` : ''}.` };
    }

    case 'website': {
      if (i.reason === 'recent') return { title: `Website checked ${ago(i.checkedAt)}`, tone: 'muted', text: 'Reusing what it found. Search again re-reads it.' };
      if (i.reason === 'unreachable') {
        const why: Record<string, string> = {
          blocked: 'Their website blocks automated visits.',
          timeout: 'Their website took too long to answer.',
          elsewhere: 'Their website sends visitors to another domain.',
          'too-large': 'Their homepage is unusually large.',
          error: 'Their website returned an error.',
          unreachable: 'It may be down, or have a broken security certificate.',
        };
        return { title: 'Couldn’t open their website', tone: 'muted', text: `${why[i.why] || why.unreachable} Skipped — the other sources still ran.` };
      }
      const parts: string[] = [];
      parts.push(i.teamPeople ? `${plural(i.teamPeople, 'person', 'people')} named on their team pages` : 'no team page with names');
      if (i.personal) parts.push(`${plural(i.personal, 'email address', 'email addresses')}${i.matched ? ` (${i.matched} matched to people)` : ''}`);
      if (i.generic) parts.push(`${plural(i.generic, 'shared inbox', 'shared inboxes')} like careers@`);
      const line: Line = { title: `Read ${plural(i.pages || 0, 'page')} of their website`, tone: i.teamPeople || i.personal ? 'good' : 'muted', text: parts.join(' · ') };
      if (i.aiBusy) line.text += ' · the team page couldn’t be read (free AI busy) — try Search again later';
      return line;
    }

    case 'pattern': {
      const ex = PATTERN_EXAMPLE[i.pattern] ? `${PATTERN_EXAMPLE[i.pattern]}@${domain}` : i.pattern;
      if (i.source === 'default') {
        return { title: 'No proof of their email format yet', tone: 'warn',
          action: i.hasHunterKey ? undefined : { label: 'Add a Hunter key', to: '/settings' },
          text: `Guessing ${i.pattern} (like ${ex}) — the format most of your companies use. These are labelled Low: about a third turn out right, so check them before sending.` };
      }
      const proof: string[] = [];
      if (i.replies) proof.push(plural(i.replies, 'reply', 'replies'));
      if (i.delivered) proof.push(plural(i.delivered, 'delivered email'));
      if (i.real) proof.push(plural(i.real, 'real address', 'real addresses'));
      if (i.hunter) proof.push('Hunter');
      return { title: `Their email format is ${i.pattern}`, tone: i.confidence === 'high' ? 'good' : 'info',
        text: `Like ${ex} · ${CONFIDENCE_LABEL[i.confidence as 'high'] || i.confidence} confidence, from ${SOURCE_LABEL[i.source] || i.source}${proof.length ? ` (${proof.join(', ')})` : ''}${i.runnerUp ? ` · a few use ${i.runnerUp}` : ''}.` };
    }

    case 'emails': {
      const parts: string[] = [];
      if (i.high) parts.push(`${i.high} high`);
      if (i.medium) parts.push(`${i.medium} medium`);
      if (i.low) parts.push(`${i.low} low`);
      if (i.generic) parts.push(`${i.generic} shared inbox`);
      if (i.manual) parts.push(`${i.manual} edited by you`);
      const text = [parts.join(' · '), i.none ? `${i.none} need a full name before an address can be guessed` : ''].filter(Boolean).join(' — ');
      return { title: `${i.withEmail ?? 0} of ${plural(i.people ?? 0, 'person', 'people')} have an address`, tone: i.withEmail ? 'good' : 'muted', text };
    }
  }
  return { title: PENDING[step.key] || step.key, tone: 'muted', text: step.detail };
}

const ICON: Record<Tone, string> = {
  good: 'ti ti-circle-check', info: 'ti ti-info-circle', warn: 'ti ti-alert-triangle', bad: 'ti ti-circle-x',
  muted: 'ti ti-circle-minus', busy: 'ti ti-loader-2 tc-spin',
};
const COLOR: Record<Tone, string> = {
  good: 'var(--green)', info: 'var(--blue)', warn: 'var(--amber)', bad: 'var(--red)', muted: 'var(--text3)', busy: 'var(--accent)',
};

export default function SearchReport({ search, onSetOrg, defaultOpen }: {
  search: ProspectSearch;
  onSetOrg?: () => void;
  defaultOpen?: boolean;
}) {
  const running = search.status === 'queued' || search.status === 'running';
  const needsYou = search.steps.some(s => ['warn', 'bad'].includes(describe(s, search).tone) || (s.info as any)?.reason === 'no-key');
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (defaultOpen || running || needsYou);
  const done = search.steps.filter(s => s.status !== 'pending' && s.status !== 'running').length;
  const c: any = search.counts || {};

  const summary = running
    ? `Searching ${search.companyName || search.domain}… step ${Math.min(done + 1, search.steps.length)} of ${search.steps.length}`
    : search.status === 'error'
      ? (search.error || 'This search failed')
      : `Found ${plural(c.people || 0, 'person', 'people')}${c.added != null ? ` (${c.added} new)` : ''} · ${ago(search.finishedAt || search.createdAt)}`;

  return (
    <div className="s-card tc-report" style={{ marginBottom: 16 }}>
      <button type="button" className="tc-report-head" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <span className="tc-report-ico" style={{ color: running ? 'var(--accent)' : search.status === 'error' ? 'var(--red)' : 'var(--green)' }}>
          <i className={running ? 'ti ti-loader-2 tc-spin' : search.status === 'error' ? 'ti ti-alert-circle' : 'ti ti-search'} />
        </span>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <span style={{ display: 'block', fontWeight: 600 }}>How this search went</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text2)' }}>
            {summary}{search.roles.length > 0 && ` · roles: ${search.roles.join(', ')}`}
          </span>
        </span>
        {needsYou && !running && !isOpen && <span className="badge badge-pending">Tips inside</span>}
        <i className={`ti ti-chevron-down nav-caret${isOpen ? ' open' : ''}`} />
      </button>
      {running && (
        <div className="tc-progress"><div style={{ width: `${Math.round((done / search.steps.length) * 100)}%` }} /></div>
      )}
      {isOpen && (
        <ol className="tc-steps">
          {search.steps.map(s => {
            const line = describe(s, search, onSetOrg);
            return (
              <li key={s.key} className={`tc-step tone-${line.tone}`}>
                <i className={ICON[line.tone]} style={{ color: COLOR[line.tone] }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="tc-step-title">{line.title}</div>
                  {line.text && <div className="tc-step-text">{line.text}</div>}
                </div>
                {line.action && (line.action.to
                  ? <Link to={line.action.to} className="btn btn-xs">{line.action.label}</Link>
                  : <button type="button" className="btn btn-xs" onClick={line.action.onClick}>{line.action.label}</button>)}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
