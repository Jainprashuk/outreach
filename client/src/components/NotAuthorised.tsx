import { useNavigate } from 'react-router-dom';
import Layout from './Layout';

export default function NotAuthorised() {
  const navigate = useNavigate();
  return (
    <Layout title="Access restricted" subtitle="This tab isn't part of your shared access">
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh', padding: '32px 16px' }}>
        <div
          style={{
            width: '100%', maxWidth: 440, textAlign: 'center',
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-md)',
            padding: '40px 32px',
          }}
        >
          <div
            style={{
              width: 72, height: 72, margin: '0 auto 20px', borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--amber-bg)', color: 'var(--amber)',
            }}
          >
            <i className="ti ti-lock" style={{ fontSize: 34 }} />
          </div>

          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: '0 0 8px' }}>
            You don't have access to this tab
          </h2>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text2)', margin: '0 0 24px' }}>
            This page hasn't been enabled for your access. Your share link only permits
            the <strong style={{ color: 'var(--text)' }}>Export Contacts</strong> view.
          </p>

          <button
            className="btn btn-primary"
            type="button"
            onClick={() => navigate('/export-contacts')}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            <i className="ti ti-file-export" /> Go to Export Contacts
          </button>

          <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 16 }}>
            Need full access? Sign in with the owner account.
          </div>
        </div>
      </div>
    </Layout>
  );
}
