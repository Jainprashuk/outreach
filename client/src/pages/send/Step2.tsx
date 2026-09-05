import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../../components/Layout';
import Avatar from '../../components/Avatar';
import StatusBadge from '../../components/StatusBadge';
import Stepper from './Stepper';
import { useApp } from '../../context/AppContext';
import { useToast } from '../../context/ToastContext';
import { bodyToHtml, renderTemplate } from '../../lib/format';
import type { ApprovalStatus, Contact } from '../../lib/api';

interface Approval extends Contact { localApproval: ApprovalStatus; }

export default function Step2() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const sendMode = params.get('mode');
  const fromContacts = params.get('from') === 'contacts';
  const filterIds = params.get('ids') ? new Set(params.get('ids')!.split(',').filter(Boolean)) : null;
  const dripRate = params.get('rate');

  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');

  // Load THIS page's own fresh data and seed approvals from the result — mirrors
  // step2.html, which always loadContacts() then filters. Seeding from the shared
  // context would use stale data (e.g. after reset-for-send on the previous step).
  useEffect(() => {
    (async () => {
      try {
        const [contacts] = await Promise.all([
          app.loadContacts(), app.loadTemplates(), app.loadSettings(),
        ]);
        const pending = contacts.filter(c =>
          c.approvalStatus === 'pending' && (!filterIds || filterIds.has(c.id)),
        );
        setApprovals(pending.map(c => ({ ...c, localApproval: 'pending' as ApprovalStatus })));
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const approvedCount = approvals.filter(a => a.localApproval === 'approved').length;

  const setApproval = (idx: number, val: ApprovalStatus) =>
    setApprovals(as => as.map((a, i) => (i === idx ? { ...a, localApproval: val } : a)));

  const approveAll = () =>
    setApprovals(as => as.map(a => (a.localApproval === 'pending' ? { ...a, localApproval: 'approved' } : a)));

  const openEdit = (idx: number) => {
    const a = approvals[idx];
    const { subject, body } = renderTemplate(app.templates, app.sender, a.template, a);
    setEditSubject(a.editedSubject || subject);
    setEditBody(a.editedBody || body);
    setEditing(idx);
  };

  const saveEdit = () => {
    if (editing === null) return;
    setApprovals(as => as.map((a, i) => (i === editing
      ? { ...a, editedSubject: editSubject, editedBody: editBody, localApproval: 'approved' }
      : a)));
    setEditing(null);
  };

  const goNext = async () => {
    const approved = approvals.filter(a => a.localApproval === 'approved');
    if (approved.length === 0) { toast('Please approve at least one contact.', 'error'); return; }

    const toUpdate = approvals.filter(a => a.localApproval !== 'pending');
    if (toUpdate.length > 0) {
      try {
        await app.bulkUpdateContacts(toUpdate.map(a => ({
          id: a.id,
          approvalStatus: a.localApproval,
          editedSubject: a.editedSubject || null,
          editedBody: a.editedBody || null,
        })));
      } catch (err: any) {
        toast('Could not save approvals: ' + err.message, 'error');
        return;
      }
    }

    const next = new URLSearchParams();
    if (sendMode) next.set('mode', sendMode);
    if (filterIds) next.set('ids', [...filterIds].join(','));
    if (dripRate) next.set('rate', dripRate);
    const qs = next.toString();
    navigate(`/send/step3${qs ? '?' + qs : ''}`);
  };

  const backHref = fromContacts ? '/contacts' : `/send/step1${sendMode ? '?mode=' + sendMode : ''}`;

  return (
    <Layout title="New entry" subtitle="Step 2 of 3 — Approve templates" actions={
      <Link to="/" className="btn btn-sm"><i className="ti ti-x" /> Cancel</Link>
    } wide>
      <Stepper current={2} />

      <div className="form-body" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="info-box">
          <i className="ti ti-info-circle" style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }} />
          {' '}Review the personalised email for each contact. Approve, edit, or reject before sending. Rejected contacts will be skipped.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-sm" onClick={approveAll} type="button"><i className="ti ti-checks" /> Approve all</button>
        </div>

        {error ? (
          <div className="empty-state"><i className="ti ti-alert-triangle" />{error}</div>
        ) : loaded && approvals.length === 0 ? (
          <div className="empty-state">
            <i className="ti ti-inbox" />No pending contacts to review. <Link to="/send/step1">Add contacts first</Link>.
          </div>
        ) : approvals.map((a, i) => {
          const { subject, body } = renderTemplate(app.templates, app.sender, a.template, a);
          const displaySubject = a.editedSubject || subject;
          const displayBody = bodyToHtml(a.editedBody || body);
          const isApproved = a.localApproval === 'approved';
          const isRejected = a.localApproval === 'rejected';
          return (
            <div className={`template-card${isApproved ? ' approved' : ''}`} key={a.id}>
              <div className="template-head">
                <div className="contact-chip" style={{ minWidth: 0 }}>
                  <Avatar name={a.name} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text2)', wordBreak: 'break-word' }}>{a.email} · {app.templates[a.template]?.name || a.template}</div>
                  </div>
                </div>
                <StatusBadge status={a.localApproval} />
              </div>
              <div className="template-preview" style={isRejected ? { opacity: 0.45 } : undefined}>
                <div className="subject"><i className="ti ti-mail" style={{ fontSize: 13, marginRight: 4 }} />{displaySubject}</div>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text2)' }} dangerouslySetInnerHTML={{ __html: displayBody }} />
              </div>
              <div className="template-actions">
                <button className="btn btn-sm" onClick={() => openEdit(i)} type="button"><i className="ti ti-edit" /> Edit</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  {!isRejected && (
                    <button className="btn btn-sm btn-danger" onClick={() => setApproval(i, 'rejected')} type="button">
                      <i className="ti ti-x" /> Reject
                    </button>
                  )}
                  {!isApproved ? (
                    <button className="btn btn-sm btn-success" onClick={() => setApproval(i, 'approved')} type="button">
                      <i className="ti ti-check" /> Approve
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <i className="ti ti-circle-check" /> Approved
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="step-footer">
        <Link to={backHref} className="btn"><i className="ti ti-arrow-left" /> Back</Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>{approvedCount} of {approvals.length} approved</span>
          <button className="btn btn-primary" onClick={goNext} type="button">
            Next — send <i className="ti ti-arrow-right" />
          </button>
        </div>
      </div>

      {editing !== null && (
        <div className="edit-modal-wrap open" onClick={e => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="edit-modal">
            <h2>Edit email</h2>
            <div className="form-group">
              <label className="form-label">Subject</label>
              <input type="text" value={editSubject} onChange={e => setEditSubject(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Body</label>
              <textarea style={{ minHeight: 160 }} value={editBody} onChange={e => setEditBody(e.target.value)} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
              <button className="btn" onClick={() => setEditing(null)} type="button">Cancel</button>
              <button className="btn btn-primary" onClick={saveEdit} type="button"><i className="ti ti-check" /> Save &amp; approve</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
