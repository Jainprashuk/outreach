// Wraps CategoryBadge with the "needs a Gemini trigger" state: when a contact has a reply
// but replyClassifierOk is false (never attempted, or the automatic attempt failed — e.g. a
// free-tier rate limit), shows a distinct warning badge plus a manual retry button instead of
// pretending a category exists.
import { useState } from 'react';
import CategoryBadge from './CategoryBadge';
import { useApp } from '../context/AppContext';
import { useToast } from '../context/ToastContext';
import type { Contact } from '../lib/api';

export default function ClassifierStatus({ contact }: { contact: Contact }) {
  const app = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!contact.repliedAt) return null; // nothing to classify yet

  if (contact.replyClassifierOk) {
    return <CategoryBadge category={contact.replyCategory} reasoning={contact.replyCategoryReasoning} />;
  }

  const trigger = async () => {
    setBusy(true);
    try {
      await app.classifyReply(contact.id);
    } catch (err: any) {
      toast('Gemini classification failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span className="badge badge-noopenings" title="Gemini hasn't classified this reply yet — may be rate-limited (common on a free-tier key). Trigger manually.">
        <i className="ti ti-alert-triangle" /> Needs classification
      </span>
      <button
        className="btn btn-sm" type="button" disabled={busy} onClick={trigger}
        style={{ padding: '2px 7px', fontSize: 11 }}
      >
        {busy ? <i className="ti ti-loader" /> : <i className="ti ti-wand" />} Classify
      </button>
    </span>
  );
}
