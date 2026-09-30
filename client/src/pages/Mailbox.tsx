// Gmail-style conversation view with a to-do list built in. Every contact who replied sits
// in one tab — Needs you, Waiting on them, Snoozed or Done — and the server decides which
// (lib/actionQueue.js, via ActionQueueContext). This page never works a bucket out itself:
// it takes the server's ids in the server's order and joins them onto the contacts already
// loaded — only those it can show (GET /api/contacts?view=mailbox), not every contact.
// "All" is the plain conversation list, newest message first.
//
// Renders each message's plain-text body only (never `html`) — no sanitizer needed since
// nothing is ever injected into the DOM as markup.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import ClassifierStatus from '../components/ClassifierStatus';
import ReplyComposer from '../components/ReplyComposer';
import SelectionBar, { RowCheck } from '../components/naukri/SelectionBar';
import { useApp } from '../context/AppContext';
import { useActionQueue } from '../context/ActionQueueContext';
import { useToast } from '../context/ToastContext';
import {
  backfillReplyCountApi, backfillRepliesApi,
  type ActionBucket, type ActionItem, type ActionOp, type Contact, type ReplyCategory, type ThreadEntry,
} from '../lib/api';
import { CATEGORY_OPTIONS, actionReasonLabel, relativeDay } from '../lib/format';

type Tab = ActionBucket | 'all';

const TABS: [Tab, string, string][] = [
  ['needs-you', 'Needs you', 'ti-bell-ringing'],
  ['follow-up', 'Follow up', 'ti-arrow-forward-up'],
  ['waiting', 'Waiting on them', 'ti-hourglass'],
  ['snoozed', 'Snoozed', 'ti-clock-pause'],
  ['done', 'Done', 'ti-circle-check'],
  ['all', 'All', 'ti-inbox'],
];

const EMPTY: Record<Tab, string> = {
  'needs-you': 'Nothing needs you right now. Replies that need an answer land here.',
  'follow-up': 'No one to chase. People who go quiet for 7 days after your reply land here.',
  waiting: 'No one owes you a reply at the moment.',
  snoozed: 'Nothing is snoozed.',
  done: 'Nothing is marked done yet.',
  all: 'No conversations yet — thread capture starts with your next reply or mailbox check.',
};

const OP_DONE_LABEL: Record<ActionOp, string> = { done: 'Marked done', snooze: 'Snoozed', reopen: 'Moved to Needs you' };

const isTab = (v: string | null): v is Tab => !!v && TABS.some(([k]) => k === v);

const fmtDateTime = (d: string) => new Date(d).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const fmtDay = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const byNewest = (a: ThreadEntry, b: ThreadEntry) => new Date(b.at).getTime() - new Date(a.at).getTime();
const lastEntry = (c: Contact): ThreadEntry | undefined => [...(c.thread || [])].sort(byNewest)[0];
const lastActivityAt = (c: Contact) => lastEntry(c)?.at || c.repliedAt || c.updatedAt;

// A snooze ends at 9am local, so the item is there when the day starts rather than at
// whatever minute you happened to press the button.
const morningIn = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
};

// When the item got to where it is: an item that came back is waiting on you since the
// moment it came back, not since it was parked.
const cameBack = (i: ActionItem, now: Date) => (i.bucket === 'needs-you' || i.bucket === 'follow-up') && !!i.dueAt && new Date(i.dueAt) <= now;

function whenLabel(i: ActionItem, now: Date) {
  if ((i.bucket === 'waiting' || i.bucket === 'snoozed') && i.dueAt) return `back ${fmtDay(i.dueAt)}`;
  const at = cameBack(i, now) ? i.dueAt : i.since;
  return at ? relativeDay(at, now) : '';
}

function reasonLine(i: ActionItem, now: Date) {
  return [actionReasonLabel(i.bucket, i.reason), whenLabel(i, now)].filter(Boolean).join(' · ');
}

// Opens the conversation in Gmail: the exact message when we have its id, otherwise
// everything from them. authuser picks the right account when several are signed in.
function gmailUrl(c: Contact, account: string) {
  const inbound = (c.thread || []).filter(t => t.direction === 'inbound' && t.messageId).sort(byNewest)[0];
  const q = inbound?.messageId ? `rfc822msgid:${inbound.messageId}` : `from:${c.email}`;
  const base = account ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}` : 'https://mail.google.com/mail/u/0/';
  return `${base}#search/${encodeURIComponent(q)}`;
}

export default function Mailbox() {
  const app = useApp();
  const queue = useActionQueue();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab: Tab = isTab(params.get('tab')) ? (params.get('tab') as Tab) : 'needs-you';

  const [loading, setLoading] = useState(!app.loaded);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState('');
  const [backfillCount, setBackfillCount] = useState(0);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState(0);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const refreshBackfillCount = () => backfillReplyCountApi().then(r => setBackfillCount(r.count)).catch(() => {});

  useEffect(() => {
    // Just the conversations this page can show, not every contact (see ?view=mailbox).
    app.initMailbox().catch(err => setError(err.message)).finally(() => setLoading(false));
    refreshBackfillCount();
  }, []);

  const setTab = (next: Tab) => {
    setParams(p => { const n = new URLSearchParams(p); n.set('tab', next); return n; }, { replace: true });
    setChecked(new Set());
    setSnoozeOpen(false);
  };

  // Older replies (detected before the thread/classification pipeline existed) only have
  // status + replySnippet — no thread entry, no category. Backfills them in bounded
  // batches (each a separate request, so a large backlog can't hit a function timeout).
  const runBackfill = async () => {
    setBackfilling(true);
    setBackfillProgress(0);
    try {
      let remaining = backfillCount;
      let processedTotal = 0;
      while (true) {
        const { processed, remaining: left } = await backfillRepliesApi(20);
        processedTotal += processed;
        remaining = left;
        setBackfillProgress(processedTotal);
        if (processed === 0 || remaining === 0) break;
      }
      setBackfillCount(remaining);
      await app.loadMailboxContacts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBackfilling(false);
    }
  };

  const now = useMemo(() => new Date(), [queue.items]);
  const contactsById = useMemo(() => new Map(app.contacts.map(c => [c.id, c])), [app.contacts]);

  // The queue refreshes on its own (every few minutes); a reply found meanwhile by the
  // scheduled mailbox check can name a contact this page's list doesn't hold yet.
  // Reload the list once per new set of such ids rather than dropping them.
  const missingKey = useMemo(
    () => (loading ? '' : queue.items.filter(i => !contactsById.has(i.id)).map(i => i.id).sort().join(',')),
    [loading, queue.items, contactsById],
  );
  const reloadedFor = useRef('');
  useEffect(() => {
    if (!missingKey || reloadedFor.current === missingKey) return;
    reloadedFor.current = missingKey;
    app.loadMailboxContacts().catch(() => {});
  }, [missingKey]);

  // The conversations in this tab, in the server's order for a queue tab. "All" is every
  // conversation with a reply, newest message first — contacts who were only ever emailed
  // have nothing to show in a mailbox and would flood the list.
  const inTab = useMemo<Contact[]>(() => {
    if (tab !== 'all') {
      return queue.items
        .filter(i => i.bucket === tab)
        .map(i => contactsById.get(i.id))
        .filter((c): c is Contact => !!c);
    }
    return app.contacts
      .filter(c => queue.byId.has(c.id) || (c.thread || []).some(t => t.direction === 'inbound'))
      .sort((a, b) => new Date(lastActivityAt(b)).getTime() - new Date(lastActivityAt(a)).getTime());
  }, [tab, queue.items, queue.byId, contactsById, app.contacts]);

  // Category counts reflect search (so switching category doesn't re-count against an
  // unrelated set) but not the category filter itself, so every option's count stays visible
  // while one is selected.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inTab;
    return inTab.filter(c => (c.name + c.email + c.company).toLowerCase().includes(q));
  }, [inTab, search]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of searched) {
      const key = c.replyClassifierOk ? (c.replyCategory || 'uncategorized') : 'needs-classification';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [searched]);

  const shown = useMemo(() => {
    let list = searched;
    if (categoryFilter === 'needs-classification') {
      list = list.filter(c => !c.replyClassifierOk);
    } else if (categoryFilter) {
      list = list.filter(c => c.replyClassifierOk && c.replyCategory === categoryFilter);
    }
    if (unreadOnly) list = list.filter(c => !c.replyRead);
    return list;
  }, [searched, categoryFilter, unreadOnly]);

  const shownIds = useMemo(() => shown.map(c => c.id), [shown]);

  // Keeps a selection valid as the list changes — falls back to the top conversation rather
  // than showing a blank pane for a hidden/missing selection. Done → the next one.
  useEffect(() => {
    if (shown.length === 0) return;
    if (!shown.some(c => c.id === selectedId)) setSelectedId(shown[0].id);
  }, [shown, selectedId]);

  // Never act on rows you can't see: a filter change drops them from the selection.
  useEffect(() => {
    setChecked(prev => {
      const visible = new Set(shownIds);
      const next = new Set([...prev].filter(id => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [shownIds]);

  const selected = shown.find(c => c.id === selectedId) || null;
  const selectedItem = selected ? queue.byId.get(selected.id) || null : null;
  const orderedThread = useMemo(
    () => selected ? [...(selected.thread || [])].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()) : [],
    [selected],
  );

  // Opening a conversation is reading it. Only a click counts — the auto-selected top row
  // on page load hasn't been read by anyone.
  const open = (c: Contact) => {
    setSelectedId(c.id);
    setSnoozeOpen(false);
    if (!c.replyRead && c.repliedAt) app.updateContact(c.id, { replyRead: true }).catch(() => {});
  };

  const act = async (ids: string[], op: ActionOp, until?: Date) => {
    if (!ids.length) return;
    setBusyAction(true);
    try {
      const n = await queue.act(ids, op, until);
      const what = OP_DONE_LABEL[op] + (op === 'snooze' && until ? ` until ${fmtDay(until.toISOString())}` : '');
      toast(ids.length === 1 ? what : `${what}: ${n} conversation${n !== 1 ? 's' : ''}`, 'success');
      setChecked(new Set());
      setSnoozeOpen(false);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusyAction(false);
    }
  };

  const snoozeTo = (ids: string[], until: Date) => act(ids, 'snooze', until);

  const setCategory = async (c: Contact, category: ReplyCategory) => {
    try {
      await app.updateContact(c.id, { replyCategory: category });
      toast('Category changed', 'success');
    } catch (err: any) {
      toast('Could not change the category: ' + err.message, 'error');
    }
  };

  const busy = (loading && app.contacts.length === 0) || !queue.loaded;
  const needsYou = queue.counts['needs-you'];
  const subtitle = needsYou
    ? `${needsYou} need${needsYou === 1 ? 's' : ''} you · ${inTab.length} in this tab`
    : `${inTab.length} conversation${inTab.length !== 1 ? 's' : ''}`;

  return (
    <Layout title="Mailbox" subtitle={subtitle}>
      {backfillCount > 0 && (
        <div className="info-box" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-history" />
          <span style={{ flex: 1 }}>
            {backfilling
              ? `Backfilling older conversations… ${backfillProgress} done so far.`
              : `${backfillCount} contact${backfillCount !== 1 ? 's have' : ' has'} sends/replies from before this thread view existed — they're missing from the list above until backfilled.`}
          </span>
          <button className="btn btn-sm" type="button" disabled={backfilling} onClick={runBackfill}>
            {backfilling ? <i className="ti ti-loader" /> : <i className="ti ti-refresh" />} Backfill now
          </button>
        </div>
      )}

      <div className="nav-tabs mailbox-tabs" role="tablist">
        {TABS.map(([key, label, icon]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`nav-tab${tab === key ? ' active' : ''}`}>
            <i className={`ti ${icon}`} style={{ marginRight: 5 }} />{label}
            {key !== 'all' && queue.counts[key as ActionBucket] ? (
              <span className={key === 'needs-you' ? 'tab-badge' : 'contact-count-badge'} style={{ marginLeft: 6 }}>{queue.counts[key]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {busy ? (
        <div className="empty-state"><i className="ti ti-loader" />Loading…</div>
      ) : error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : inTab.length === 0 ? (
        <div className="empty-state"><i className={`ti ${tab === 'needs-you' ? 'ti-mood-check' : 'ti-inbox'}`} />{EMPTY[tab]}</div>
      ) : (
        <div className="mailbox-layout">
          <div className="mailbox-list-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="text"
              placeholder="Search name, email or company…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} style={{ flex: 1, fontSize: 12.5 }}>
                <option value="">All categories ({searched.length})</option>
                {CATEGORY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value} disabled={!categoryCounts[opt.value]}>
                    {opt.label} ({categoryCounts[opt.value] || 0})
                  </option>
                ))}
                {categoryCounts['needs-classification'] ? (
                  <option value="needs-classification">Needs classification ({categoryCounts['needs-classification']})</option>
                ) : null}
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text2)' }}>
              <input type="checkbox" checked={unreadOnly} onChange={e => setUnreadOnly(e.target.checked)} />
              Unread only
            </label>
            {(search || categoryFilter || unreadOnly) && (
              <button className="btn btn-sm" type="button" onClick={() => { setSearch(''); setCategoryFilter(''); setUnreadOnly(false); }}>
                Clear filters
              </button>
            )}

            {tab !== 'all' && shown.length > 0 && (
              <SelectionBar ids={shownIds} selected={checked} onChange={setChecked}>
                {tab !== 'done' && (
                  <button className="btn btn-sm" type="button" disabled={busyAction} onClick={() => act([...checked], 'done')}>
                    <i className="ti ti-check" /> Done
                  </button>
                )}
                <button className="btn btn-sm" type="button" disabled={busyAction} onClick={() => snoozeTo([...checked], morningIn(7))}>
                  <i className="ti ti-clock-pause" /> Snooze a week
                </button>
                {tab !== 'needs-you' && tab !== 'follow-up' && (
                  <button className="btn btn-sm" type="button" disabled={busyAction} onClick={() => act([...checked], 'reopen')}>
                    <i className="ti ti-arrow-back-up" /> Reopen
                  </button>
                )}
              </SelectionBar>
            )}

            <div className="mailbox-list" style={{ flex: 1 }}>
              {shown.length === 0 ? (
                <div className="empty-state"><i className="ti ti-search" />No conversations match these filters</div>
              ) : shown.map(contact => {
                const item = queue.byId.get(contact.id);
                const last = lastEntry(contact);
                return (
                  <div
                    key={contact.id}
                    className={`mailbox-row${contact.id === selectedId ? ' active' : ''}`}
                    onClick={() => open(contact)}
                  >
                    {tab !== 'all' && (
                      <span onClick={e => e.stopPropagation()} style={{ paddingTop: 8 }}>
                        <RowCheck
                          checked={checked.has(contact.id)}
                          onToggle={() => setChecked(prev => {
                            const next = new Set(prev);
                            if (next.has(contact.id)) next.delete(contact.id); else next.add(contact.id);
                            return next;
                          })}
                        />
                      </span>
                    )}
                    <Avatar name={contact.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontWeight: contact.replyRead ? 500 : 650, fontSize: 13, display: 'flex', gap: 6, minWidth: 0 }}>
                          {!contact.replyRead && contact.repliedAt && <span className="mailbox-row-unread" aria-label="Unread" />}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.name}</span>
                        </span>
                        <span className="mailbox-row-time">{fmtDateTime(last?.at || lastActivityAt(contact))}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{contact.company}</div>
                      <div className="mailbox-row-preview">{last?.text || contact.replySnippet || '(no content)'}</div>
                      {item && (
                        <div className={`mailbox-row-reason${item.bucket === 'needs-you' ? ' needs-you' : item.bucket === 'follow-up' ? ' follow-up' : ''}`}>
                          {tab === 'all' && <span className="contact-count-badge">{TABS.find(([k]) => k === item.bucket)?.[1]}</span>}
                          {reasonLine(item, now)}
                        </div>
                      )}
                      <ClassifierStatus contact={contact} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mailbox-thread">
            {!selected ? (
              <div className="empty-state"><i className="ti ti-mail" />Select a conversation</div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 15 }}>{selected.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text2)', overflowWrap: 'anywhere' }}>
                      {selected.email}{selected.company ? ` · ${selected.company}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <ClassifierStatus contact={selected} />
                    <a className="btn btn-sm" href={gmailUrl(selected, app.sender.email)} target="_blank" rel="noreferrer"
                      title="Opens this conversation in Gmail, signed in as the account you send from">
                      <i className="ti ti-brand-gmail" /> Open in Gmail
                    </a>
                  </div>
                </div>

                {selectedItem && (
                  <div className="mailbox-queue-bar">
                    <div className="mailbox-queue-reason">
                      <b>{TABS.find(([k]) => k === selectedItem.bucket)?.[1]}</b>
                      <span>· {reasonLine(selectedItem, now)}</span>
                    </div>
                    {selectedItem.bucket !== 'done' && (
                      <button className="btn btn-sm btn-primary" type="button" disabled={busyAction} onClick={() => act([selected.id], 'done')}>
                        <i className="ti ti-check" /> Done
                      </button>
                    )}
                    <div className="mailbox-snooze">
                      <button className="btn btn-sm" type="button" disabled={busyAction} aria-expanded={snoozeOpen}
                        onClick={() => setSnoozeOpen(o => !o)}>
                        <i className="ti ti-clock-pause" /> Snooze <i className="ti ti-chevron-down" />
                      </button>
                      {snoozeOpen && (
                        <div className="mailbox-snooze-menu" role="menu">
                          <button className="btn btn-sm" type="button" onClick={() => snoozeTo([selected.id], morningIn(1))}>Tomorrow</button>
                          <button className="btn btn-sm" type="button" onClick={() => snoozeTo([selected.id], morningIn(3))}>In 3 days</button>
                          <button className="btn btn-sm" type="button" onClick={() => snoozeTo([selected.id], morningIn(7))}>In a week</button>
                          <label htmlFor="mailbox-snooze-date">
                            Until a date
                            <input id="mailbox-snooze-date" type="date" value={snoozeDate}
                              min={morningIn(1).toISOString().slice(0, 10)}
                              onChange={e => setSnoozeDate(e.target.value)} />
                          </label>
                          <button className="btn btn-sm" type="button" disabled={!snoozeDate}
                            onClick={() => { const d = new Date(snoozeDate + 'T09:00:00'); snoozeTo([selected.id], d); }}>
                            Snooze until {snoozeDate ? fmtDay(snoozeDate + 'T09:00:00') : '…'}
                          </button>
                        </div>
                      )}
                    </div>
                    {selectedItem.bucket !== 'needs-you' && selectedItem.bucket !== 'follow-up' && (
                      <button className="btn btn-sm" type="button" disabled={busyAction} onClick={() => act([selected.id], 'reopen')}>
                        <i className="ti ti-arrow-back-up" /> Reopen
                      </button>
                    )}
                    <select aria-label="Change category" value={selected.replyClassifierOk ? selected.replyCategory || '' : ''}
                      onChange={e => e.target.value && setCategory(selected, e.target.value as ReplyCategory)}
                      style={{ fontSize: 12.5, width: 'auto' }}>
                      <option value="" disabled>Set category…</option>
                      {CATEGORY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </div>
                )}

                {selected.repliedAt && <ReplyComposer key={selected.id} contact={selected} />}

                {orderedThread.length === 0 && selected.replySnippet && (
                  <div className="mailbox-bubble inbound">
                    <div className="mailbox-bubble-meta">{selected.name}{selected.repliedAt ? ` · ${fmtDateTime(selected.repliedAt)}` : ''}</div>
                    {selected.replySnippet}
                  </div>
                )}
                {orderedThread.map((m, i) => (
                  <div key={i} className={`mailbox-bubble ${m.direction}`}>
                    <div className="mailbox-bubble-meta">
                      {m.direction === 'outbound' ? 'You' : selected.name} · {fmtDateTime(m.at)}
                    </div>
                    {m.text || '(no content captured)'}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}
