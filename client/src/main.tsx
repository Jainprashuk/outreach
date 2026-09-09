import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './context/AppContext';
import { ToastProvider } from './context/ToastContext';
import { SessionProvider } from './context/SessionContext';
import { InterviewProvider } from './context/InterviewContext';
import InterviewReminders from './components/InterviewReminders';
import './styles/pages.css';
import './styles/theme.css';
import './styles/responsive.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/app">
      <SessionProvider>
        <ToastProvider>
          <AppProvider>
            <InterviewProvider>
              <App />
              {/* Sibling of <App /> so it survives client-side navigation and
                  fires once per fresh load, not once per route change. */}
              <InterviewReminders />
            </InterviewProvider>
          </AppProvider>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
