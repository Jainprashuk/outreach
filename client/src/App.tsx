import { Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import AddContacts from './pages/AddContacts';
import Templates from './pages/Templates';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import Step1 from './pages/send/Step1';
import Step2 from './pages/send/Step2';
import Step3 from './pages/send/Step3';
import Done from './pages/send/Done';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/contacts" element={<Contacts />} />
      <Route path="/add-contacts" element={<AddContacts />} />
      <Route path="/templates" element={<Templates />} />
      <Route path="/analytics" element={<Analytics />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/send/step1" element={<Step1 />} />
      <Route path="/send/step2" element={<Step2 />} />
      <Route path="/send/step3" element={<Step3 />} />
      <Route path="/send/done" element={<Done />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  );
}
