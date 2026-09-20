import { useNavigate } from 'react-router-dom';
import Layout from './Layout';

/**
 * `share` — a share-link visitor who only has the export view.
 * `admin` — a signed-in, ordinary user who reached an admin-only page. Its own
 *   copy because the share wording ("your share link only permits…") is simply
 *   untrue for them, and pointing them at Export Contacts is a dead end.
 */
export default function NotAuthorised({ variant = 'share' }: { variant?: 'share' | 'admin' }) {
  const navigate = useNavigate();
  const isAdminCase = variant === 'admin';

  return (
    <Layout
      title="Access restricted"
      subtitle={isAdminCase ? 'This page is for administrators' : "This tab isn't part of your shared access"}
    >
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
            {isAdminCase ? 'Administrators only' : "You don't have access to this tab"}
          </h2>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text2)', margin: '0 0 24px' }}>
            {isAdminCase ? (
              <>Your own account and data are unaffected — this page just shows totals across every account.</>
            ) : (
              <>
                This page hasn't been enabled for your access. Your share link only permits
                the <strong style={{ color: 'var(--text)' }}>Export Contacts</strong> view.
              </>
            )}
          </p>

          <button
            className="btn btn-primary"
            type="button"
            onClick={() => navigate(isAdminCase ? '/' : '/export-contacts')}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {isAdminCase
              ? <><i className="ti ti-layout-dashboard" /> Back to dashboard</>
              : <><i className="ti ti-file-export" /> Go to Export Contacts</>}
          </button>

          {!isAdminCase && (
            <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 16 }}>
              Need full access? Sign in with the owner account.
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
