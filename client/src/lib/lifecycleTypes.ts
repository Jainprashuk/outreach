// What each lifecycle email is, and what will ACTUALLY happen to it for one
// account. Mirrors lib/lifecycle/types.js and the order of lib/lifecycle/gate.js
// on the server — keep the three in step.
import type { AdminUserRow, LifecycleConfig, LifecycleType } from './api';

export interface EmailTypeMeta {
  key: LifecycleType;
  label: string;
  icon: string;             // tabler icon class
  pref: 'reminders' | 'weekly-report' | null;
  what: string;             // one line: what the email says
  when: string;             // one line: when it goes out
}

export const EMAIL_TYPES: EmailTypeMeta[] = [
  {
    key: 'welcome', label: 'Welcome', icon: 'ti-confetti', pref: null,
    what: 'Confirms Gmail is connected and points to the first three steps: add contacts, pick a template, launch a campaign.',
    when: 'Once, right after the account finishes setup. Never sent late to accounts already set up.',
  },
  {
    key: 'setup-reminder', label: 'Setup reminder', icon: 'ti-alarm', pref: 'reminders',
    what: 'Names the exact setup step still missing (usually the Gmail App Password) with how to do it.',
    when: 'Once, 5 days after first sign-in, only if setup is still unfinished. Daily check at 10:00 IST.',
  },
  {
    key: 'inactive', label: "We haven't seen you", icon: 'ti-zzz', pref: 'reminders',
    what: 'What happened while they were away: new replies, finished campaigns, upcoming interviews.',
    when: 'Once per quiet spell: 3 days with no app visit AND no email sent. Daily check at 10:00 IST.',
  },
  {
    key: 'weekly-report', label: 'Weekly report', icon: 'ti-report-analytics', pref: 'weekly-report',
    what: "Last week's sends, replies, reply rate and interviews, with the full report attached as a PDF. A quiet week gets a one-line note.",
    when: 'Every Monday at 09:00 IST, for accounts that have finished setup.',
  },
  {
    key: 'manual-report', label: '"Email it to me"', icon: 'ti-mail-forward', pref: null,
    what: 'The button on Analytics → Reports that emails the user a report they generated.',
    when: 'Only when the user clicks it, up to 5 a day. Download PDF works regardless.',
  },
];

export type EffectiveTone = 'on' | 'off' | 'blocked' | 'optout' | 'test';

export interface Effective { tone: EffectiveTone; label: string; detail: string }

/** Why this email will or will not go to this account right now. First "no" wins, like the server. */
export function effectiveState(t: EmailTypeMeta, row: AdminUserRow, config: LifecycleConfig | null): Effective {
  const blocked = row.emails?.blockedByAdmin || [];
  const optOut = row.emails?.optOut || [];
  if (row.status === 'disabled') return { tone: 'off', label: 'Account disabled', detail: 'Disabled accounts get no email.' };
  if (!config) return { tone: 'off', label: '…', detail: 'Loading switches' };
  if (!config.enabled) return { tone: 'off', label: 'Master switch off', detail: 'All lifecycle emails are switched off app-wide.' };
  if (!config.types[t.key]) return { tone: 'off', label: 'Off app-wide', detail: 'Switched off for everyone. Turn it on in Admin → Lifecycle emails.' };
  if (blocked.includes(t.key)) return { tone: 'blocked', label: 'Off for this user', detail: 'You switched this off for this account.' };
  if (t.pref && optOut.includes(t.pref)) return { tone: 'optout', label: 'User opted out', detail: 'They opted out themselves. An admin cannot override that.' };
  if (config.testMode && row.email.toLowerCase() !== (config.testRecipient || '').toLowerCase()) {
    return { tone: 'test', label: 'Test mode: not sent', detail: 'Test mode is on, so this is recorded but not sent. It goes out for real once test mode is off.' };
  }
  return { tone: 'on', label: 'Will send', detail: 'Goes out whenever it falls due.' };
}

export const TONE_COLOR: Record<EffectiveTone, string> = {
  on: 'var(--green)', off: 'var(--border-md)', blocked: 'var(--red)', optout: 'var(--amber)', test: 'var(--accent)',
};
