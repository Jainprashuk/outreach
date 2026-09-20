import { type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import Mailbox from './pages/Mailbox';
import Leads from './pages/Leads';
import Jobs from './pages/Jobs';
import CampaignsRouter from './pages/campaigns/CampaignsRouter';
import Interviews from './pages/Interviews';
import AddContacts from './pages/AddContacts';
import ExportContacts from './pages/ExportContacts';
import Templates from './pages/Templates';
import Blocklist from './pages/Blocklist';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import Logs from './pages/Logs';
import Onboarding from './pages/Onboarding';
import Admin from './pages/Admin';
import Step1 from './pages/send/Step1';
import Step2 from './pages/send/Step2';
import Step3 from './pages/send/Step3';
import Done from './pages/send/Done';
import NotAuthorised from './components/NotAuthorised';
import { useSession } from './context/SessionContext';

// Owner-only pages render "Not authorised" for share/unauthenticated visitors.
function OwnerOnly({ children }: { children: ReactNode }) {
  const { owner } = useSession();
  return owner ? <>{children}</> : <NotAuthorised />;
}

// Until first-run setup is done there is nothing useful on any other page, and
// sending is refused server-side anyway. This is the redirect; lib/onboardingGuard.js
// is the part that actually enforces it.
//
// Sits INSIDE OwnerOnly so a share-link visitor still gets "Not authorised"
// rather than being pushed into a wizard they could never complete.
function OnboardingGate({ children }: { children: ReactNode }) {
  const { onboarded } = useSession();
  const { pathname } = useLocation();
  if (onboarded) return <>{children}</>;
  return <Navigate to="/onboarding" replace state={{ from: pathname }} />;
}

// Display gate only — requireAdmin on the server is the security boundary.
function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useSession();
  return isAdmin ? <>{children}</> : <NotAuthorised variant="admin" />;
}

export default function App() {
  const { loading } = useSession();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text2)' }}>
        <i className="ti ti-loader" style={{ fontSize: 28 }} />
      </div>
    );
  }

  // Every owner page also passes the onboarding gate. The two exceptions are
  // registered explicitly below: the wizard itself (which would redirect to
  // itself forever) and /admin (an admin diagnosing a broken fleet must not be
  // trapped in a wizard).
  const owner = (el: ReactNode) => <OwnerOnly><OnboardingGate>{el}</OnboardingGate></OwnerOnly>;

  return (
    <Routes>
      <Route path="/" element={owner(<Dashboard />)} />
      <Route path="/leads" element={owner(<Leads />)} />
      <Route path="/jobs" element={owner(<Jobs />)} />
      {/* Splat route: the list, wizard and detail screens live in CampaignsRouter. */}
      <Route path="/campaigns/*" element={owner(<CampaignsRouter />)} />
      <Route path="/interviews" element={owner(<Interviews />)} />
      <Route path="/contacts" element={owner(<Contacts />)} />
      <Route path="/mailbox" element={owner(<Mailbox />)} />
      <Route path="/add-contacts" element={owner(<AddContacts />)} />
      <Route path="/export-contacts" element={<ExportContacts />} />
      <Route path="/onboarding" element={<OwnerOnly><Onboarding /></OwnerOnly>} />
      <Route path="/admin" element={<OwnerOnly><AdminOnly><Admin /></AdminOnly></OwnerOnly>} />
      <Route path="/templates" element={owner(<Templates />)} />
      <Route path="/blocklist" element={owner(<Blocklist />)} />
      <Route path="/analytics" element={owner(<Analytics />)} />
      <Route path="/settings" element={owner(<Settings />)} />
      <Route path="/logs" element={owner(<Logs />)} />
      <Route path="/send/step1" element={owner(<Step1 />)} />
      <Route path="/send/step2" element={owner(<Step2 />)} />
      <Route path="/send/step3" element={owner(<Step3 />)} />
      <Route path="/send/done" element={owner(<Done />)} />
      <Route path="*" element={owner(<Dashboard />)} />
    </Routes>
  );
}
