// Shared formatters for the Naukri tab. Deliberately its own copy of the small
// helpers ScrapePanel defines privately — importing from that file would couple
// the two panels, and the whole point of this feature is that it can be removed
// in one revert.

export const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';

export const fmtRunTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

export const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export function elapsed(since: string | null): string {
  if (!since) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  return m < 1 ? `${secs}s` : `${m}m ${secs % 60}s`;
}

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
