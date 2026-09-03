import { type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import Leads from './pages/Leads';
import AddContacts from './pages/AddContacts';
import ExportContacts from './pages/ExportContacts';
import Templates from './pages/Templates';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
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

export default function App() {
  const { loading } = useSession();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text2)' }}>
        <i className="ti ti-loader" style={{ fontSize: 28 }} />
      </div>
    );
  }

  const owner = (el: ReactNode) => <OwnerOnly>{el}</OwnerOnly>;

  return (
    <Routes>
      <Route path="/" element={owner(<Dashboard />)} />
      <Route path="/leads" element={owner(<Leads />)} />
      <Route path="/contacts" element={owner(<Contacts />)} />
      <Route path="/add-contacts" element={owner(<AddContacts />)} />
      <Route path="/export-contacts" element={<ExportContacts />} />
      <Route path="/templates" element={owner(<Templates />)} />
      <Route path="/analytics" element={owner(<Analytics />)} />
      <Route path="/settings" element={owner(<Settings />)} />
      <Route path="/send/step1" element={owner(<Step1 />)} />
      <Route path="/send/step2" element={owner(<Step2 />)} />
      <Route path="/send/step3" element={owner(<Step3 />)} />
      <Route path="/send/done" element={owner(<Done />)} />
      <Route path="*" element={owner(<Dashboard />)} />
    </Routes>
  );
}
