import { useNavigate } from 'react-router-dom';
import Layout from './Layout';

export default function NotAuthorised() {
  const navigate = useNavigate();
  return (
    <Layout title="Not authorised" subtitle="You don't have access to this page">
      <div className="empty-state" style={{ flexDirection: 'column', gap: 14, padding: '48px 20px' }}>
        <i className="ti ti-lock" style={{ fontSize: 40 }} />
        <div style={{ textAlign: 'center', maxWidth: 360, lineHeight: 1.5 }}>
          This share link only permits the <strong>Export Contacts</strong> view. Sign in with the owner account to access the rest of the app.
        </div>
        <button className="btn btn-primary" type="button" onClick={() => navigate('/export-contacts')}>
          <i className="ti ti-file-export" /> Go to Export Contacts
        </button>
      </div>
    </Layout>
  );
}
