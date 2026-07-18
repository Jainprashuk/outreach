import { useNavigate } from 'react-router-dom';
import Layout from './Layout';

export default function NotAuthorised() {
  const navigate = useNavigate();
  return (
    <Layout title="Not authorised" subtitle="This tab isn't enabled for your access">
      <div className="empty-state" style={{ flexDirection: 'column', gap: 14, padding: '48px 20px' }}>
        <i className="ti ti-lock" style={{ fontSize: 40 }} />
        <div style={{ textAlign: 'center', maxWidth: 380, lineHeight: 1.5 }}>
          The tab you're trying to access hasn't been enabled for you. Your share access only permits the <strong>Export Contacts</strong> view.
        </div>
        <button className="btn btn-primary" type="button" onClick={() => navigate('/export-contacts')}>
          <i className="ti ti-file-export" /> Go to Export Contacts
        </button>
      </div>
    </Layout>
  );
}
