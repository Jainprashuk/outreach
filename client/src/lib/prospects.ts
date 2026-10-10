// Labels for the Discover tab, shared with Step 2's confidence badge.
import type { CompanyCandidate, EmailConfidence } from './api';

export const CONFIDENCE_LABEL: Record<EmailConfidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  generic: 'Shared inbox',
};

export const CONFIDENCE_CLASS: Record<EmailConfidence, string> = {
  high: 'badge-sent',
  medium: 'badge-pending',
  low: 'badge-rejected',
  generic: 'badge-queued',
};

export const CONFIDENCE_HELP: Record<EmailConfidence, string> = {
  high: 'Proven: a reply from this company, or two real addresses in this format',
  medium: 'One sign this format is right — check before sending',
  low: 'A best guess with no proof — right about a third of the time',
  generic: 'A shared mailbox (careers@, hr@) found on the company’s website',
};

export const SOURCE_LABEL: Record<string, string> = {
  own: 'your past emails',
  leads: 'your Leads board',
  github: 'GitHub commits',
  website: 'the company website',
  hunter: 'Hunter',
  default: 'your most common format',
  manual: 'typed by you',
};

export const PATTERN_EXAMPLE: Record<string, string> = {
  'first.last': 'rahul.sharma',
  first: 'rahul',
  firstlast: 'rahulsharma',
  flast: 'rsharma',
  firstl: 'rahuls',
  first_last: 'rahul_sharma',
  'f.last': 'r.sharma',
  'last.first': 'sharma.rahul',
};

export const STEP_LABEL: Record<string, string> = {
  company: 'Company and mail server',
  'people-search': 'Searching the web for people',
  github: 'Checking GitHub',
  website: 'Reading the company website',
  pattern: 'Working out the email format',
  emails: 'Guessing each address',
};

/** Pick the top company match without asking only when it can't be the wrong company. */
export const autoPick = (list: CompanyCandidate[]) => {
  const top = list[0];
  if (!top || !top.exact) return null;
  return top.source === 'contacts' || top.source === 'typed' || !list.slice(1).some(c => c.exact) ? top : null;
};
