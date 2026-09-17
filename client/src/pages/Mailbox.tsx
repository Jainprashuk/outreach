// Gmail-style conversation view: every contact with any captured thread
// activity (outbound sends + inbound replies, including manual replies pulled
// from the Sent folder), sorted by most recent message, with a full
// chronological thread on the right. Renders each message's plain-text body
// only (never `html`) — no sanitizer needed since nothing is ever injected
// into the DOM as markup.
import { useEffect, useMemo, useState } from 'react';
import Layout from '../components/Layout';
import Avatar from '../components/Avatar';
import CategoryBadge from '../components/CategoryBadge';
import { useApp } from '../context/AppContext';
import { backfillReplyCountApi, backfillRepliesApi, type Contact, type ThreadEntry } from '../lib/api';

const fmtDateTime = (d: string) => new Date(d).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

const lastEntry = (c: Contact): ThreadEntry | undefined =>
  (c.thread && c.thread.length > 0) ? [...c.thread].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0] : undefined;

export default function Mailbox() {
  const app = useApp();
  const [loading, setLoading] = useState(!app.loaded);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [backfillCount, setBackfillCount] = useState(0);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState(0);

  const refreshBackfillCount = () => backfillReplyCountApi().then(r => setBackfillCount(r.count)).catch(() => {});

  useEffect(() => {
    app.init().catch(err => setError(err.message)).finally(() => setLoading(false));
    refreshBackfillCount();
  }, []);

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
      await app.loadContacts();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBackfilling(false);
    }
  };

  const threaded = useMemo(() => {
    return app.contacts
      .filter(c => c.thread && c.thread.length > 0)
      .map(c => ({ contact: c, last: lastEntry(c)! }))
      .sort((a, b) => new Date(b.last.at).getTime() - new Date(a.last.at).getTime());
  }, [app.contacts]);

  useEffect(() => {
    if (!selectedId && threaded.length > 0) setSelectedId(threaded[0].contact.id);
  }, [threaded, selectedId]);

  const selected = threaded.find(t => t.contact.id === selectedId)?.contact || null;
  const orderedThread = useMemo(
    () => selected ? [...(selected.thread || [])].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()) : [],
    [selected],
  );

  const busy = loading && app.contacts.length === 0;

  return (
    <Layout title="Mailbox" subtitle={`${threaded.length} conversation${threaded.length !== 1 ? 's' : ''}`}>
      {backfillCount > 0 && (
        <div className="info-box" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-history" />
          <span style={{ flex: 1 }}>
            {backfilling
              ? `Backfilling older replies… ${backfillProgress} done so far.`
              : `${backfillCount} older repl${backfillCount !== 1 ? 'ies were' : 'y was'} detected before this thread/category view existed — they're missing from the list above until backfilled.`}
          </span>
          <button className="btn btn-sm" type="button" disabled={backfilling} onClick={runBackfill}>
            {backfilling ? <i className="ti ti-loader" /> : <i className="ti ti-refresh" />} Backfill now
          </button>
        </div>
      )}
      {busy ? (
        <div className="empty-state"><i className="ti ti-loader" />Loading…</div>
      ) : error ? (
        <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
      ) : threaded.length === 0 ? (
        <div className="empty-state"><i className="ti ti-inbox" />No conversations yet — thread capture starts with your next send or mailbox check.</div>
      ) : (
        <div className="mailbox-layout">
          <div className="mailbox-list">
            {threaded.map(({ contact, last }) => (
              <div
                key={contact.id}
                className={`mailbox-row${contact.id === selectedId ? ' active' : ''}`}
                onClick={() => setSelectedId(contact.id)}
              >
                <Avatar name={contact.name} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{contact.name}</span>
                    <span className="mailbox-row-time">{fmtDateTime(last.at)}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{contact.company}</div>
                  <div className="mailbox-row-preview">{last.text || '(no content)'}</div>
                  <CategoryBadge category={contact.replyCategory} reasoning={contact.replyCategoryReasoning} />
                </div>
              </div>
            ))}
          </div>

          <div className="mailbox-thread">
            {!selected ? (
              <div className="empty-state"><i className="ti ti-mail" />Select a conversation</div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                  <div>
                    <div style={{ fontWeight: 650, fontSize: 15 }}>{selected.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                      {selected.email}{selected.company ? ` · ${selected.company}` : ''}
                    </div>
                  </div>
                  <CategoryBadge category={selected.replyCategory} reasoning={selected.replyCategoryReasoning} />
                </div>
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
