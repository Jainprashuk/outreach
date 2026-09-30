import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  type Contact, type Template, type Sender,
  loadContactsApi, loadTemplatesApi, loadSettingsApi,
  createContactsApi, updateContactApi, bulkUpdateContactsApi, deleteContactApi, bulkDeleteContactsApi,
  checkMailboxApi, saveSettingsApi, createTemplateApi, updateTemplateApi, deleteTemplateApi,
  uploadResumeApi, deleteResumeApi, triggerReplyClassificationApi,
} from '../lib/api';
import { isFollowUpDue } from '../lib/format';

const DEFAULT_SENDER: Sender = {
  name: 'Your Name', company: 'Your Company', email: '',
  customVariables: [], resume: null, lastMailboxCheckAt: null,
};

interface AppStore {
  contacts: Contact[];
  templates: Record<string, Template>;
  sender: Sender;
  loaded: boolean;
  /** Templates + settings are in (init or initMeta ran). */
  metaLoaded: boolean;
  /**
   * Bumped on every contact mutation made through this store. Pages that load
   * their own page of contacts from /api/contacts/list refetch when it changes,
   * the way the in-memory list used to re-render.
   */
  contactsVersion: number;
  loadContacts: () => Promise<Contact[]>;
  loadTemplates: () => Promise<Record<string, Template>>;
  loadSettings: () => Promise<Sender>;
  init: () => Promise<void>;
  /** init() without the full contact list — for pages that page contacts on the server. */
  initMeta: () => Promise<void>;
  getStats: () => Record<string, number>;
  filterContacts: (tab: string) => Contact[];
  createContacts: (rows: Partial<Contact>[]) => Promise<{ created: Contact[]; skipped: number }>;
  updateContact: (id: string, patch: Partial<Contact>) => Promise<Contact>;
  classifyReply: (id: string) => Promise<Contact>;
  /** Swap in a contact the server just returned (e.g. after sending a reply). */
  replaceContact: (c: Contact) => void;
  bulkUpdateContacts: (updates: Array<{ id: string } & Partial<Contact>>) => Promise<any>;
  deleteContact: (id: string) => Promise<void>;
  /** Deletes many in one request; resolves with how many could not be deleted. */
  deleteContacts: (ids: string[]) => Promise<{ failed: number }>;
  checkMailbox: () => Promise<any>;
  saveSettings: (patch: any) => Promise<any>;
  createTemplate: (data: Partial<Template>) => Promise<Template>;
  updateTemplate: (key: string, patch: Partial<Template>) => Promise<Template>;
  deleteTemplate: (key: string) => Promise<void>;
  uploadResume: (file: File) => Promise<void>;
  deleteResume: () => Promise<void>;
  setSenderMailboxCheckedAt: (d: Date) => void;
}

const AppContext = createContext<AppStore | null>(null);

const parseSettings = (s: any): Sender => ({
  name: s.senderName || 'Your Name',
  company: s.senderCompany || 'Your Company',
  email: s.gmailEmail || '',
  customVariables: s.customVariables || [],
  resume: s.resume || null,
  lastMailboxCheckAt: s.lastMailboxCheckAt ? new Date(s.lastMailboxCheckAt) : null,
});

export function AppProvider({ children }: { children: ReactNode }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [templates, setTemplates] = useState<Record<string, Template>>({});
  const [sender, setSender] = useState<Sender>(DEFAULT_SENDER);
  const [loaded, setLoaded] = useState(false);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [contactsVersion, setContactsVersion] = useState(0);
  const bump = useCallback(() => setContactsVersion(v => v + 1), []);
  // Whether some page has loaded the full list, so a mailbox check knows to refresh it.
  const contactsLoadedRef = useRef(false);
  // Refs mirror state so imperative flows read fresh values without re-subscribing
  const contactsRef = useRef(contacts); contactsRef.current = contacts;

  const loadContacts = useCallback(async () => {
    const list = await loadContactsApi();
    contactsLoadedRef.current = true;
    setContacts(list);
    bump();
    return list;
  }, [bump]);

  const loadTemplates = useCallback(async () => {
    const list = await loadTemplatesApi();
    const map: Record<string, Template> = {};
    list.forEach(t => { map[t.key] = t; });
    setTemplates(map);
    return map;
  }, []);

  const loadSettings = useCallback(async () => {
    const s = await loadSettingsApi();
    const parsed = parseSettings(s);
    setSender(parsed);
    return parsed;
  }, []);

  const init = useCallback(async () => {
    await Promise.all([loadContacts(), loadTemplates(), loadSettings()]);
    setLoaded(true);
    setMetaLoaded(true);
  }, [loadContacts, loadTemplates, loadSettings]);

  const initMeta = useCallback(async () => {
    await Promise.all([loadTemplates(), loadSettings()]);
    setMetaLoaded(true);
  }, [loadTemplates, loadSettings]);

  const getStats = useCallback(() => ({
    total: contactsRef.current.length,
    sent: contactsRef.current.filter(c => c.status === 'sent').length,
    bounced: contactsRef.current.filter(c => c.status === 'bounced').length,
    replied: contactsRef.current.filter(c => c.status === 'replied').length,
    followUpReplied: contactsRef.current.filter(c => c.status === 'follow-up-replied').length,
    pending: contactsRef.current.filter(c => c.approvalStatus === 'pending').length,
    remaining: contactsRef.current.filter(c => c.status === 'queued').length,
    followUpDue: contactsRef.current.filter(isFollowUpDue).length,
    followUpSent: contactsRef.current.filter(c => c.status === 'follow-up-sent').length,
    closed: contactsRef.current.filter(c => c.status === 'closed').length,
    noOpenings: contactsRef.current.filter(c => c.status === 'no-openings').length,
    inReview: contactsRef.current.filter(c => c.status === 'in-review').length,
  }), []);

  const filterContacts = useCallback((tab: string): Contact[] => {
    const cs = contactsRef.current;
    if (tab === 'all') return cs;
    if (tab === 'pending') return cs.filter(c => c.approvalStatus === 'pending');
    if (tab === 'sent') return cs.filter(c => c.status === 'sent');
    if (tab === 'in-campaign') return cs.filter(c => c.status === 'in-campaign');
    if (tab === 'remaining') return cs.filter(c => c.status === 'queued');
    if (tab === 'bounced') return cs.filter(c => c.status === 'bounced');
    if (tab === 'replied') return cs.filter(c => c.status === 'replied');
    if (tab === 'followup-due') return cs.filter(isFollowUpDue);
    if (tab === 'follow-up-sent') return cs.filter(c => c.status === 'follow-up-sent');
    if (tab === 'follow-up-replied') return cs.filter(c => c.status === 'follow-up-replied');
    if (tab === 'closed') return cs.filter(c => c.status === 'closed');
    if (tab === 'no-openings') return cs.filter(c => c.status === 'no-openings');
    if (tab === 'in-review') return cs.filter(c => c.status === 'in-review');
    return cs;
  }, []);

  const store = useMemo<AppStore>(() => ({
    contacts, templates, sender, loaded, metaLoaded, contactsVersion,
    loadContacts, loadTemplates, loadSettings, init, initMeta, getStats, filterContacts,

    async createContacts(rows) {
      const res = await createContactsApi(rows);
      setContacts(prev => [...res.created, ...prev]);
      bump();
      return res;
    },
    async updateContact(id, patch) {
      const updated = await updateContactApi(id, patch);
      setContacts(prev => prev.map(c => (c.id === id ? updated : c)));
      bump();
      return updated;
    },
    replaceContact(c) {
      setContacts(prev => prev.map(x => (x.id === c.id ? c : x)));
      bump();
    },
    async classifyReply(id) {
      const updated = await triggerReplyClassificationApi(id);
      setContacts(prev => prev.map(c => (c.id === id ? updated : c)));
      bump();
      return updated;
    },
    bulkUpdateContacts: (updates) => bulkUpdateContactsApi(updates),
    async deleteContact(id) {
      await deleteContactApi(id);
      setContacts(prev => prev.filter(c => c.id !== id));
      bump();
    },
    async deleteContacts(ids) {
      const res = await bulkDeleteContactsApi(ids);
      const gone = new Set(res.deleted);
      setContacts(prev => prev.filter(c => !gone.has(c.id)));
      bump();
      return { failed: res.failed };
    },
    async checkMailbox() {
      const result = await checkMailboxApi();
      // Only refresh the full list if a page actually uses it; paged views
      // refetch their own page off the version bump.
      if (contactsLoadedRef.current) setContacts(await loadContactsApi());
      bump();
      return result;
    },
    async saveSettings(patch) {
      const s = await saveSettingsApi(patch);
      setSender(parseSettings(s));
      return s;
    },
    async createTemplate(data) {
      const tpl = await createTemplateApi(data);
      setTemplates(prev => ({ ...prev, [tpl.key]: tpl }));
      return tpl;
    },
    async updateTemplate(key, patch) {
      const tpl = await updateTemplateApi(key, patch);
      setTemplates(prev => ({ ...prev, [tpl.key]: tpl }));
      return tpl;
    },
    async deleteTemplate(key) {
      await deleteTemplateApi(key);
      setTemplates(prev => { const next = { ...prev }; delete next[key]; return next; });
    },
    async uploadResume(file) {
      const resume = await uploadResumeApi(file);
      setSender(prev => ({ ...prev, resume }));
    },
    async deleteResume() {
      await deleteResumeApi();
      setSender(prev => ({ ...prev, resume: null }));
    },
    setSenderMailboxCheckedAt(d) {
      setSender(prev => ({ ...prev, lastMailboxCheckAt: d }));
    },
  }), [contacts, templates, sender, loaded, metaLoaded, contactsVersion, bump, loadContacts, loadTemplates, loadSettings, init, initMeta, getStats, filterContacts]);

  return <AppContext.Provider value={store}>{children}</AppContext.Provider>;
}

export function useApp(): AppStore {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
