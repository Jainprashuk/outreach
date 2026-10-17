import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { useApp } from '../context/AppContext';
import { useSession } from '../context/SessionContext';
import { useToast } from '../context/ToastContext';
import { usePulseChange } from '../context/PulseContext';
import { useVisibleInterval } from '../hooks/useVisibleInterval';
import {
  actionCenterSummaryApi, actionCenterIdsApi, retryFailedApi,
  moveLeadsToOutreachApi, moveProspectsApi,
  scrapeStatusApi, queueScrapeApi, naukriOverviewApi, queueNaukriRunApi, runSourceApi,
  type ActionCenterSummary, type ScrapeStatus, type NaukriOverview,
} from '../lib/api';
import { relativeTime } from '../lib/format';
import CreateContactCampaignModal from './CreateContactCampaignModal';

const POLL_MS = 3 * 60 * 1000;
const MAILBOX_STALE_MS = 2 * 60 * 60 * 1000;
const SCRAPE_MAX_QUERIES = 20; // ScrapePanel MAX_QUERIES

type SheetProps = Omit<ComponentProps<typeof CreateContactCampaignModal>, 'onClose'>;
type Group = 'chores' | 'workflows' | 'run';

interface Row {
  id: string;
  group: Group;
  icon: string;
  tone?: 'warning' | 'info' | 'success' | 'error';
  title: string;
  hint?: string;
  /** Shown as a reason and the row can't be clicked. */
  disabled?: string;
  run: () => Promise<void> | void;
}

// What each chip says. The full sentence and the details live in its hover card.
const SHORT: Record<string, string> = {
  mailbox: 'Check mailbox', failed: 'Retry failed',
  followup: 'Follow up', ready: 'Send ready', pending: 'Approve & send', leads: 'New leads',
  prospects: 'Discover people',
  scrape: 'LinkedIn scrape', 'naukri-harvest': 'Naukri: new jobs', 'naukri-apply': 'Naukri: apply',
  hn: 'HN leads', web: 'Web leads',
};

interface Tip { row: Row; count?: number; right: number; top: number }

// Most urgent first: replies go cold, then what's already prepared and waiting,
// and finding new people last.
const PRIORITY = ['mailbox', 'failed', 'followup', 'pending', 'ready', 'prospects', 'leads'];
const rank = (id: string) => { const i = PRIORITY.indexOf(id); return i === -1 ? 99 : i; };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const idsParam = (ids: string[]) => ids.join(',');

/**
 * The floating ⚡ button (bottom-left): the few things worth doing right now, each
 * one click instead of a trip through several pages. Rows appear only when they
 * apply; every write goes through an existing endpoint.
 */
export default function ActionCenter() {
  const app = useApp();
  const toast = useToast();
  const { owner, loading: sessionLoading } = useSession();
  const enabled = !!owner && !sessionLoading;

  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<ActionCenterSummary | null>(null);
  const [scrape, setScrape] = useState<ScrapeStatus | null>(null);
  const [naukri, setNaukri] = useState<NaukriOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetProps | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  // The ring pulses only when there is MORE to do than this tab last saw — not on
  // every page change (the button remounts with each page's Layout).
  const [seenDue] = useState(() => {
    try { return Number(sessionStorage.getItem('ac-seen-due')) || 0; } catch { return 0; }
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try { setSummary(await actionCenterSummaryApi()); } catch { /* keep the last counts */ }
  }, []);
  // Worker state only matters once the panel is open — not worth a poll of its own.
  const loadRunState = useCallback(async () => {
    const [s, n] = await Promise.allSettled([scrapeStatusApi(), naukriOverviewApi()]);
    setScrape(s.status === 'fulfilled' ? s.value : null);
    setNaukri(n.status === 'fulfilled' ? n.value : null);
  }, []);

  useVisibleInterval(load, POLL_MS, enabled);
  // Contacts changed anywhere in the app (this panel included): counts follow.
  useEffect(() => { if (enabled) load(); }, [app.contactsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  usePulseChange(p => `${p.jobs}|${p.mailbox}|${p.notifications}`, load, enabled);
  useEffect(() => { if (open) { load(); loadRunState(); } else setTip(null); }, [open, load, loadRunState]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!enabled) return null;
  const rememberDue = (n: number) => { try { sessionStorage.setItem('ac-seen-due', String(n)); } catch { /* private mode */ } };

  // Wraps a row's work: one at a time, errors become a toast, counts refresh after.
  const act = (id: string, fn: () => Promise<void> | void) => async () => {
    if (busy) return;
    setBusy(id);
    try { await fn(); } catch (e: any) { toast(e?.message || 'That did not work', 'error'); }
    finally { setBusy(null); app.contactsChanged(); }
  };

  const openSheet = (props: SheetProps) => { setOpen(false); setSheet(props); };

  const s = summary;
  const rows: Row[] = [];

  // ── Chores ──────────────────────────────────────────────────────────────
  if (s) {
    const last = s.lastMailboxCheckAt ? new Date(s.lastMailboxCheckAt).getTime() : 0;
    if (!last || Date.now() - last > MAILBOX_STALE_MS) {
      rows.push({
        id: 'mailbox', group: 'chores', icon: 'ti-mail-search', tone: 'warning',
        title: 'Check mailbox for bounces and replies',
        hint: last ? `Last checked ${relativeTime(s.lastMailboxCheckAt!)}` : 'Never checked',
        disabled: s.gmailConnected ? undefined : 'Connect Gmail in Settings first',
        run: async () => {
          const r = await app.checkMailbox();
          app.setSenderMailboxCheckedAt(new Date());
          const parts: string[] = [];
          if (r?.bounced?.length) parts.push(plural(r.bounced.length, 'bounce'));
          if (r?.replied?.length) parts.push(plural(r.replied.length, 'reply', 'replies'));
          toast(parts.length ? `Found ${parts.join(' and ')}` : 'Mailbox checked — nothing new.', r?.bounced?.length ? 'error' : 'success');
        },
      });
    }
    if (s.failed > 0) {
      rows.push({
        id: 'failed', group: 'chores', icon: 'ti-refresh-alert', tone: 'error',
        title: `Retry ${plural(s.failed, 'failed send')}`,
        hint: 'Moves them back to ready — then send them from “Send to ready contacts”',
        run: async () => {
          const r = await retryFailedApi();
          toast(`${plural(r.retried, 'contact')} ready to send again.`, 'success');
        },
      });
    }
  }

  // ── Workflows ───────────────────────────────────────────────────────────
  if (s && s.followUpDue > 0) {
    rows.push({
      id: 'followup', group: 'workflows', icon: 'ti-arrow-back-up', tone: 'info',
      title: `Follow up ${plural(s.followUpDue, 'contact')}`,
      hint: 'Sent 3+ days ago with no reply — goes out as a reply in the same thread',
      run: async () => {
        const { ids } = await actionCenterIdsApi('followup');
        openSheet({
          contactIds: ids, title: `Follow up ${plural(ids.length, 'contact')}`,
          subtitle: 'No reply in 3+ days', initialTemplateKey: 'follow-up', initialName: `Follow-ups — ${today()}`,
          stepHref: (x) => `/send/step1?followup=1&ids=${idsParam(x)}`,
        });
      },
    });
  }
  if (s && s.ready > 0) {
    rows.push({
      id: 'ready', group: 'workflows', icon: 'ti-send', tone: 'success',
      title: `Send to ${plural(s.ready, 'ready contact')}`,
      hint: 'Approved and never emailed',
      run: async () => {
        const { ids } = await actionCenterIdsApi('ready');
        openSheet({
          contactIds: ids, title: `Send to ${plural(ids.length, 'ready contact')}`, subtitle: 'Approved, never emailed',
          initialName: `Ready contacts — ${today()}`,
          stepHref: (x) => `/send/step3?ids=${idsParam(x)}`,
        });
      },
    });
  }
  if (s && s.pending > 0) {
    rows.push({
      id: 'pending', group: 'workflows', icon: 'ti-checklist', tone: 'info',
      title: `Approve & send ${plural(s.pending, 'pending contact')}`,
      hint: 'Waiting for approval — review them, or schedule them as a campaign',
      run: async () => {
        const { ids } = await actionCenterIdsApi('pending');
        openSheet({
          contactIds: ids, title: `Approve & send ${plural(ids.length, 'contact')}`, subtitle: 'Waiting for approval',
          initialName: `New contacts — ${today()}`,
          stepHref: (x) => `/send/step2?from=contacts&ids=${idsParam(x)}`,
        });
      },
    });
  }
  if (s && s.newLeads > 0) {
    rows.push({
      id: 'leads', group: 'workflows', icon: 'ti-users-plus', tone: 'info',
      title: `Start outreach to ${plural(s.newLeads, 'new lead')}`,
      hint: 'Leads with an email, best fit first — moves them to Contacts and sends',
      run: async () => {
        const { ids } = await actionCenterIdsApi('leads');
        openSheet({
          count: ids.length, title: `Start outreach to ${plural(ids.length, 'lead')}`,
          subtitle: `${plural(ids.length, 'lead')} with an email · moved to Contacts when you continue`,
          initialName: `Leads — ${today()}`,
          prepare: async (template) => (await moveLeadsToOutreachApi(template, ids.map(id => ({ id }) as any))).contactIds || [],
          stepHref: (x) => `/send/step2?from=contacts&ids=${idsParam(x)}`,
        });
      },
    });
  }
  if (s && s.readyProspects > 0) {
    rows.push({
      id: 'prospects', group: 'workflows', icon: 'ti-user-search', tone: 'info',
      title: `Reach ${plural(s.readyProspects, 'person', 'people')} found on Discover`,
      hint: 'High-confidence addresses — moves them to Contacts and sends',
      run: async () => {
        const { ids } = await actionCenterIdsApi('prospects');
        openSheet({
          count: ids.length, title: `Reach ${plural(ids.length, 'person', 'people')} from Discover`,
          subtitle: 'High-confidence addresses · moved to Contacts when you continue',
          initialName: `Discover — ${today()}`,
          prepare: async (template) => (await moveProspectsApi(ids, template)).contactIds || [],
          stepHref: (x) => `/send/step2?from=contacts&ids=${idsParam(x)}`,
        });
      },
    });
  }
  // ── Run ─────────────────────────────────────────────────────────────────
  const blockedLabel = (until: string | null | undefined) =>
    until && new Date(until).getTime() > Date.now() ? `Blocked until ${new Date(until).toLocaleDateString()}` : undefined;

  const scrapeQueries = scrape ? (scrape.schedule?.queries?.length ? scrape.schedule.queries : scrape.defaultQueries) : [];
  rows.push({
    id: 'scrape', group: 'run', icon: 'ti-brand-linkedin',
    title: 'Run LinkedIn scrape',
    hint: !scrape ? 'Checking the worker…'
      : scrape.activeRun ? undefined
        : !scrape.worker.online ? 'Your Mac worker is offline — it will run when it wakes'
          : `${plural(Math.min(scrapeQueries.length, SCRAPE_MAX_QUERIES), 'search', 'searches')} from your schedule`,
    disabled: !scrape ? 'Loading…'
      : blockedLabel(scrape.blockedUntil)
        || (scrape.activeRun ? 'A scrape is already running' : undefined)
        || (!scrapeQueries.length ? 'Pick searches on Leads first' : undefined),
    run: async () => {
      await queueScrapeApi(scrapeQueries.slice(0, SCRAPE_MAX_QUERIES));
      toast(scrape && !scrape.worker.online ? 'Queued. Your Mac is asleep, so it will run when it next wakes.' : 'Scrape started.', 'success');
      loadRunState();
    },
  });

  const naukriBlocked = !naukri ? 'Loading…'
    : (naukri.paused ? 'Naukri is paused (Pause all)' : undefined)
      || blockedLabel(naukri.blockedUntil)
      || (naukri.activeRun || naukri.queuedRuns.length ? 'A Naukri run is already queued or running' : undefined);
  const naukriHint = naukri && !naukri.worker.online ? 'Worker offline — runs when it wakes' : undefined;
  rows.push({
    id: 'naukri-harvest', group: 'run', icon: 'ti-briefcase',
    title: 'Naukri: find new jobs', hint: naukriHint, disabled: naukriBlocked,
    run: async () => { await queueNaukriRunApi('harvest'); toast('Harvest queued — new listings will land in the Inbox.', 'success'); loadRunState(); },
  });
  if (naukri && naukri.waitingCount > 0) {
    rows.push({
      id: 'naukri-apply', group: 'run', icon: 'ti-send-2',
      title: `Naukri: apply to ${plural(naukri.waitingCount, 'approved job')}`, hint: naukriHint, disabled: naukriBlocked,
      run: async () => { await queueNaukriRunApi('apply'); toast('Apply run queued — approved jobs go out on the next worker poll.', 'success'); loadRunState(); },
    });
  }
  rows.push({
    id: 'hn', group: 'run', icon: 'ti-brand-ycombinator', title: 'Find leads: Hacker News hiring thread',
    run: async () => { await runSourceApi('hn'); toast('Hacker News search started — leads land on the Leads board.', 'success'); },
  });
  rows.push({
    id: 'web', group: 'run', icon: 'ti-world-search', title: 'Find leads: hiring posts on the web',
    run: async () => { await runSourceApi('web'); toast('Web search started — leads land on the Leads board.', 'success'); },
  });

  // The badge: how many things are waiting on you, not how many contacts.
  const due = rows.filter(r => r.group !== 'run' && !r.disabled).length;
  const pulse = !!s && due > seenDue;
  // Idempotent, so safe in render: the next mount compares against this.
  if (s) rememberDue(due);
  const GROUPS: { key: Group; label: string }[] = [
    { key: 'chores', label: 'Do now' },
    { key: 'workflows', label: 'Quick Actions' },
    { key: 'run', label: 'Run' },
  ];
  const COUNT: Record<string, number | undefined> = s ? {
    failed: s.failed, followup: s.followUpDue, ready: s.ready, pending: s.pending, leads: s.newLeads,
    prospects: s.readyProspects,
    'naukri-apply': naukri?.waitingCount,
  } : {};

  // The hover card sits beside the chip, outside the (scrollable) stack so it is never clipped.
  const showTip = (row: Row, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ row, count: COUNT[row.id], right: window.innerWidth - r.left + 10, top: r.top + r.height / 2 });
  };
  let order = 0;

  return (
    <>
      {open && <div className="ac-scrim" aria-hidden onMouseDown={() => setOpen(false)} />}
      <div className="ac-wrap" ref={wrapRef}>
        {open && (
          <div className="ac-dial" role="menu" aria-label="Action Center" onScroll={() => setTip(null)}>
            {!s && <div className="ac-chip ac-chip-muted"><i className="ti ti-loader-2 ac-spin" /> Loading…</div>}
            {s && GROUPS.map(g => {
              const list = rows.filter(r => r.group === g.key).sort((a, b) => rank(a.id) - rank(b.id));
              if (!list.length) return null;
              // Run actions are occasional: one row of icon buttons, details on hover.
              if (g.key === 'run') {
                return (
                  <div key={g.key} className="ac-group-stack">
                    <div className="ac-group">{g.label}</div>
                    <div className="ac-run-row" style={{ animationDelay: `${Math.min(order++, 12) * 22}ms` }}>
                      {list.map(r => (
                        <button key={r.id} type="button" role="menuitem"
                          className={`ac-icon-btn${r.disabled ? ' is-disabled' : ''}`}
                          aria-disabled={!!r.disabled || undefined}
                          aria-label={`${r.title}${r.disabled ? ` — ${r.disabled}` : r.hint ? ` — ${r.hint}` : ''}`}
                          disabled={!!busy && busy !== r.id}
                          onMouseEnter={e => showTip(r, e.currentTarget)} onMouseLeave={() => setTip(null)}
                          onFocus={e => showTip(r, e.currentTarget)} onBlur={() => setTip(null)}
                          onClick={r.disabled ? undefined : act(r.id, r.run)}>
                          <i className={`ti ${busy === r.id ? 'ti-loader-2 ac-spin' : r.icon}`} />
                          {r.disabled && <i className="ti ti-lock ac-lock-dot" aria-hidden />}
                          {COUNT[r.id] ? <span className="ac-icon-count">{COUNT[r.id]}</span> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <div key={g.key} className="ac-group-stack">
                  <div className="ac-group">{g.label}</div>
                  {list.map(r => {
                    const n = COUNT[r.id];
                    return (
                      <button key={r.id} type="button" role="menuitem"
                        className={`ac-chip tone-${r.tone || 'plain'}${r.disabled ? ' is-disabled' : ''}`}
                        style={{ animationDelay: `${Math.min(order++, 12) * 22}ms` }}
                        aria-disabled={!!r.disabled || undefined}
                        aria-label={`${r.title}${r.disabled ? ` — ${r.disabled}` : r.hint ? ` — ${r.hint}` : ''}`}
                        disabled={!!busy && busy !== r.id}
                        onMouseEnter={e => showTip(r, e.currentTarget)} onMouseLeave={() => setTip(null)}
                        onFocus={e => showTip(r, e.currentTarget)} onBlur={() => setTip(null)}
                        onClick={r.disabled ? undefined : act(r.id, r.run)}>
                        <i className={`ti ${busy === r.id ? 'ti-loader-2 ac-spin' : r.icon}`} />
                        <span className="ac-chip-label">{SHORT[r.id] || r.title}</span>
                        {r.disabled && <i className="ti ti-lock ac-chip-lock" aria-hidden />}
                        {n ? <span className="ac-chip-count">{n > 999 ? '999+' : n}</span> : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {s && due === 0 && <div className="ac-chip ac-chip-muted"><i className="ti ti-circle-check" /> All caught up</div>}
          </div>
        )}
        {!open && (
          <span className="ac-btn-label" aria-hidden>
            Action Center{due > 0 && <em> · {due} to do</em>}
          </span>
        )}
        <button ref={btnRef} type="button" className={`ac-btn${pulse && !open ? ' has-due' : ''}`} aria-expanded={open} aria-haspopup="menu"
          aria-label={due ? `Action Center, ${due} to do` : 'Action Center'} onClick={() => setOpen(o => !o)}>
          <i className={`ti ${open ? 'ti-x' : 'ti-bolt'}`} />
          {due > 0 && !open && <span className="notif-badge">{due}</span>}
        </button>
      </div>

      {open && tip && (
        <div className="ac-tip" role="tooltip" style={{ right: tip.right, top: tip.top }}>
          <div className="ac-tip-title">{tip.row.title}</div>
          {tip.row.hint && <div className="ac-tip-body">{tip.row.hint}</div>}
          {tip.row.disabled && <div className="ac-tip-warn"><i className="ti ti-lock" /> {tip.row.disabled}</div>}
          {!tip.row.disabled && (
            <div className="ac-tip-cta">
              {tip.row.group !== 'workflows' ? 'Click to start' : 'Click to choose step-wise or campaign'}
            </div>
          )}
        </div>
      )}

      {sheet && (
        <CreateContactCampaignModal {...sheet} onClose={() => { setSheet(null); app.contactsChanged(); }} />
      )}
    </>
  );
}
