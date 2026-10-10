// The Company page for a person: by their work email's domain when they have one
// (exact), else a search by company name. Null when there's nothing to go on.
import { isFreemail } from './leads';

export function companyHref({ email, company }: { email?: string | null; company?: string | null }): string | null {
  const domain = (email || '').split('@')[1]?.toLowerCase().trim();
  if (domain && !isFreemail(email || '')) return `/companies/${encodeURIComponent(`d:${domain}`)}`;
  const name = (company || '').trim();
  return name ? `/companies?q=${encodeURIComponent(name)}` : null;
}

/** A contact's conversation in the Mailbox. */
export const mailboxHref = (contactId: string) => `/mailbox?tab=all&contact=${encodeURIComponent(contactId)}`;
