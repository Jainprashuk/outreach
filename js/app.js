const App = (() => {
  const API_BASE = 'http://localhost:3000';

  let state = {
    contacts: [],
    templates: {},
    sender: { name: 'Your Name', company: 'Your Company', email: '' },
    currentTab: 'all',
    batchContacts: [],
  };

  const getStats = () => ({
    total: state.contacts.length,
    sent: state.contacts.filter(c => c.status === 'sent').length,
    pending: state.contacts.filter(c => c.approvalStatus === 'pending').length,
    remaining: state.contacts.filter(c => c.status === 'queued').length
  });

  const initials = (name) => name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const avatarColor = (name) => {
    const colors = [
      ['var(--blue-bg)', 'var(--blue)'],
      ['var(--green-bg)', 'var(--green)'],
      ['var(--amber-bg)', 'var(--amber)'],
      ['var(--pink-bg)', 'var(--pink)'],
      ['var(--teal-bg)', 'var(--teal)'],
    ];
    const idx = name.charCodeAt(0) % colors.length;
    return colors[idx];
  };
  const avatarEl = (name) => {
    const [bg, fg] = avatarColor(name);
    return `<div class="avatar" style="background:${bg};color:${fg}">${initials(name)}</div>`;
  };

  const statusBadge = (status) => {
    const map = { sent: 'badge-sent', failed: 'badge-rejected', pending: 'badge-pending', queued: 'badge-queued', approved: 'badge-approved', rejected: 'badge-rejected' };
    const labels = { sent: 'Sent', failed: 'Failed', pending: 'Pending', queued: 'Queued', approved: 'Approved', rejected: 'Rejected' };
    return `<span class="badge ${map[status] || 'badge-queued'}">${labels[status] || status}</span>`;
  };

  const filterContacts = (tab) => {
    if (tab === 'all') return state.contacts;
    if (tab === 'pending') return state.contacts.filter(c => c.approvalStatus === 'pending');
    if (tab === 'sent') return state.contacts.filter(c => c.status === 'sent');
    if (tab === 'remaining') return state.contacts.filter(c => c.status === 'queued');
    return state.contacts;
  };

  // Built-in template variables, always available.
  const BUILTIN_VARIABLES = [
    { key: 'name', desc: "Contact's first name" },
    { key: 'company', desc: "Contact's company" },
    { key: 'role', desc: "Contact's role" },
    { key: 'sender', desc: 'Your name' },
    { key: 'senderCompany', desc: 'Your company' },
  ];

  // Built-in + user-defined custom variables, for variable pickers.
  const allVariables = () => [
    ...BUILTIN_VARIABLES,
    ...(state.sender.customVariables || []).map(v => ({ key: v.key, desc: v.value, custom: true })),
  ];

  const renderTemplate = (tplKey, contact) => {
    const tpl = state.templates[tplKey];
    if (!tpl) return { subject: '', body: '' };
    const replace = (str) => {
      let out = str
        .replace(/{{name}}/g, contact.name.split(' ')[0])
        .replace(/{{company}}/g, contact.company)
        .replace(/{{role}}/g, contact.role)
        .replace(/{{sender}}/g, state.sender.name)
        .replace(/{{senderCompany}}/g, state.sender.company);
      (state.sender.customVariables || []).forEach(v => {
        out = out.replace(new RegExp(`{{${v.key}}}`, 'g'), v.value || '');
      });
      return out;
    };
    return { subject: replace(tpl.subject), body: replace(tpl.body) };
  };

  // ── API-backed data loading ────────────────────────────────────────────
  const apiFetch = async (path, opts) => {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request to ${path} failed`);
    return data;
  };

  const loadContacts = async () => {
    state.contacts = await apiFetch('/api/contacts');
    return state.contacts;
  };

  const loadTemplates = async () => {
    const list = await apiFetch('/api/templates');
    state.templates = {};
    list.forEach(t => { state.templates[t.key] = t; });
    return state.templates;
  };

  const loadSettings = async () => {
    const s = await apiFetch('/api/settings');
    state.sender = {
      name: s.senderName || 'Your Name',
      company: s.senderCompany || 'Your Company',
      email: s.gmailEmail || '',
      customVariables: s.customVariables || [],
      resume: s.resume || null,
    };
    return state.sender;
  };

  const init = async () => {
    await Promise.all([loadContacts(), loadTemplates(), loadSettings()]);
  };

  // ── THEME ───────────────────────────────────────────────────────────────
  const THEME_KEY = 'outreach-theme';

  const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  };

  const getTheme = () => localStorage.getItem(THEME_KEY) || 'light';

  const toggleTheme = () => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    return next;
  };

  const initTheme = () => {
    applyTheme(getTheme());
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.addEventListener('click', () => toggleTheme());
    });
  };

  // ── MOBILE NAV ──────────────────────────────────────────────────────────
  const initMobileNav = () => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    let backdrop = document.querySelector('.sidebar-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'sidebar-backdrop';
      document.body.appendChild(backdrop);
    }

    const close = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); };
    const open = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); };

    document.querySelectorAll('[data-mobile-menu-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        sidebar.classList.contains('open') ? close() : open();
      });
    });

    backdrop.addEventListener('click', close);
    sidebar.querySelectorAll('a.nav-item').forEach(a => a.addEventListener('click', close));
  };

  // ── TOASTS ──────────────────────────────────────────────────────────────
  const ICONS = { success: 'ti-circle-check', error: 'ti-alert-triangle', info: 'ti-info-circle' };

  const toast = (message, type = 'info', duration = 4000) => {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="ti ${ICONS[type] || ICONS.info}"></i><div class="toast-msg">${message}</div>`;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-leave');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, duration);
  };

  window._app = {
    API_BASE,
    get state() { return state; },
    init,
    loadContacts,
    loadTemplates,
    loadSettings,
    getStats,
    filterContacts,
    initials,
    avatarEl,
    statusBadge,
    renderTemplate,

    setTab(tab) { state.currentTab = tab; },

    initTheme,
    toggleTheme,
    initMobileNav,
    toast,

    async createContacts(rows) {
      const created = await apiFetch('/api/contacts', { method: 'POST', body: JSON.stringify(rows) });
      state.contacts.unshift(...created);
      return created;
    },

    async updateContact(id, patch) {
      const updated = await apiFetch(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const idx = state.contacts.findIndex(c => c.id === id);
      if (idx !== -1) state.contacts[idx] = updated;
      return updated;
    },

    async saveSettings(patch) {
      const s = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
      state.sender = {
        name: s.senderName || 'Your Name',
        company: s.senderCompany || 'Your Company',
        email: s.gmailEmail || '',
        customVariables: s.customVariables || [],
        resume: s.resume || null,
      };
      return s;
    },

    async uploadResume(file) {
      const formData = new FormData();
      formData.append('resume', file);
      const res = await fetch(`${API_BASE}/api/settings/resume`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      state.sender.resume = data.resume || null;
      return state.sender.resume;
    },

    async deleteResume() {
      await apiFetch('/api/settings/resume', { method: 'DELETE' });
      state.sender.resume = null;
    },

    allVariables,

    async createTemplate(data) {
      const tpl = await apiFetch('/api/templates', { method: 'POST', body: JSON.stringify(data) });
      state.templates[tpl.key] = tpl;
      return tpl;
    },

    async updateTemplate(key, patch) {
      const tpl = await apiFetch(`/api/templates/${key}`, { method: 'PATCH', body: JSON.stringify(patch) });
      state.templates[tpl.key] = tpl;
      return tpl;
    },

    async deleteTemplate(key) {
      await apiFetch(`/api/templates/${key}`, { method: 'DELETE' });
      delete state.templates[key];
    },
  };
})();
