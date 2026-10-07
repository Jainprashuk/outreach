import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientIssue } from '../lib/issueReporter';

/**
 * A render crash anywhere below this used to blank the whole app with no trace.
 * Now the person gets a way out, and the admin's Issues tab gets the stack.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientIssue('render_crash', error.message, { stack: `${error.stack || ''}\n\nComponent stack:${info.componentStack || ''}` });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ maxWidth: 460, margin: '80px auto', padding: '0 16px', textAlign: 'center' }}>
        <i className="ti ti-alert-triangle" style={{ fontSize: 32, color: 'var(--amber)' }} />
        <h2 style={{ margin: '12px 0 6px' }}>Something went wrong on this page</h2>
        <p style={{ color: 'var(--text2)', fontSize: 13.5 }}>
          It has been reported automatically. Reloading usually fixes it.
        </p>
        <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
          <i className="ti ti-refresh" /> Reload
        </button>
      </div>
    );
  }
}
