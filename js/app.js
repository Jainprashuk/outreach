const App = (() => {
  const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';

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
    bounced: state.contacts.filter(c => c.status === 'bounced').length,
    replied: state.contacts.filter(c => c.status === 'replied').length,
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
    const map = { sent: 'badge-sent', failed: 'badge-rejected', pending: 'badge-pending', queued: 'badge-queued', approved: 'badge-approved', rejected: 'badge-rejected', bounced: 'badge-bounced', replied: 'badge-replied' };
    const labels = { sent: 'Sent', failed: 'Failed', pending: 'Pending', queued: 'Queued', approved: 'Approved', rejected: 'Rejected', bounced: 'Bounced', replied: 'Replied' };
    return `<span class="badge ${map[status] || 'badge-queued'}">${labels[status] || status}</span>`;
  };

  const filterContacts = (tab) => {
    if (tab === 'all') return state.contacts;
    if (tab === 'pending') return state.contacts.filter(c => c.approvalStatus === 'pending');
    if (tab === 'sent') return state.contacts.filter(c => c.status === 'sent');
    if (tab === 'remaining') return state.contacts.filter(c => c.status === 'queued');
    if (tab === 'bounced') return state.contacts.filter(c => c.status === 'bounced');
    if (tab === 'replied') return state.contacts.filter(c => c.status === 'replied');
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
      lastMailboxCheckAt: s.lastMailboxCheckAt ? new Date(s.lastMailboxCheckAt) : null,
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

  // ── SEND JOB WIDGET ────────────────────────────────────────────────────────
  let _sjwJobId = null;
  let _sjwInterval = null;
  let _sjwCollapsed = false;

  const _sjwIsStep3 = () => window.location.pathname.includes('step3');

  const _sjwInjectDOM = () => {
    if (document.getElementById('send-job-widget')) return;
    const el = document.createElement('div');
    el.id = 'send-job-widget';
    el.innerHTML = `
      <div id="sjw-header">
        <span id="sjw-title"><i class="ti ti-send"></i> Sending emails…</span>
        <div style="display:flex;gap:6px">
          <button id="sjw-pause-btn" class="btn btn-xs" onclick="window._app._sjwTogglePause()"></button>
          <button class="btn btn-xs" onclick="window._app._sjwCollapse()"><i class="ti ti-minus"></i></button>
        </div>
      </div>
      <div id="sjw-body">
        <div class="progress-bar"><div class="progress-fill" id="sjw-fill" style="width:0%"></div></div>
        <div id="sjw-stats" style="font-size:12px;color:var(--text2);margin-top:6px"></div>
      </div>
    `;
    document.body.appendChild(el);
  };

  const _sjwUpdate = (job) => {
    const fill = document.getElementById('sjw-fill');
    const stats = document.getElementById('sjw-stats');
    const title = document.getElementById('sjw-title');
    const pauseBtn = document.getElementById('sjw-pause-btn');
    if (!fill || !stats) return;

    const total = job.items.length;
    const sent = job.items.filter(i => i.status === 'sent').length;
    const failed = job.items.filter(i => i.status === 'failed').length;
    const done = sent + failed;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    fill.style.width = pct + '%';
    stats.textContent = `${done}/${total} · ${failed > 0 ? failed + ' failed' : 'all good'}`;

    if (job.status === 'done' || job.status === 'cancelled') {
      if (title) title.innerHTML = `<i class="ti ti-circle-check"></i> ${sent} sent${failed ? ', ' + failed + ' failed' : ''}`;
      if (pauseBtn) pauseBtn.style.display = 'none';
      clearInterval(_sjwInterval);
      _sjwInterval = null;
      localStorage.removeItem('activeJobId');
      setTimeout(_sjwDismiss, 10000);
    } else if (job.status === 'paused') {
      if (title) title.innerHTML = `<i class="ti ti-player-pause"></i> Paused`;
      if (pauseBtn) pauseBtn.innerHTML = '<i class="ti ti-player-play"></i>';
    } else {
      if (title) title.innerHTML = `<i class="ti ti-send"></i> Sending emails…`;
      if (pauseBtn) pauseBtn.innerHTML = '<i class="ti ti-player-pause"></i>';
    }
  };

  const _sjwDismiss = () => {
    clearInterval(_sjwInterval);
    _sjwInterval = null;
    _sjwJobId = null;
    localStorage.removeItem('activeJobId');
    const el = document.getElementById('send-job-widget');
    if (el) el.remove();
  };

  const _sjwPoll = async () => {
    if (!_sjwJobId) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${_sjwJobId}`);
      if (!res.ok) return;
      const job = await res.json();
      _sjwUpdate(job);
    } catch (_) {}
  };

  const _sjwStart = (id) => {
    _sjwJobId = id;
    _sjwInjectDOM();
    // Set initial pause button label
    const pauseBtn = document.getElementById('sjw-pause-btn');
    if (pauseBtn) pauseBtn.innerHTML = '<i class="ti ti-player-pause"></i>';
    if (!_sjwInterval) {
      _sjwInterval = setInterval(_sjwPoll, 3000);
    }
    _sjwPoll();
  };

  const _sjwCheckForActiveJob = async () => {
    if (_sjwIsStep3()) return; // step3 has its own inline progress
    const id = localStorage.getItem('activeJobId');
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${id}`);
      if (!res.ok) { localStorage.removeItem('activeJobId'); return; }
      const job = await res.json();
      if (job.status === 'done' || job.status === 'cancelled') {
        localStorage.removeItem('activeJobId');
        return;
      }
      _sjwStart(id);
    } catch (_) {}
  };

  // Expose toggle functions for inline onclick handlers
  window._app_sjwTogglePause = async () => {
    if (!_sjwJobId) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${_sjwJobId}`);
      if (!res.ok) return;
      const job = await res.json();
      const action = job.status === 'paused' ? 'resume' : 'pause';
      await fetch(`${API_BASE}/api/jobs/${_sjwJobId}/${action}`, { method: 'POST' });
      _sjwPoll();
    } catch (_) {}
  };

  // Auto-start widget check on every page load (except step3)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _sjwCheckForActiveJob);
  } else {
    setTimeout(_sjwCheckForActiveJob, 500);
  }

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

    // Widget API (used by step3.html and sjw-pause-btn onclick)
    _sjwStart,
    _sjwDismiss,
    _sjwTogglePause: window._app_sjwTogglePause,
    _sjwCollapse() {
      _sjwCollapsed = !_sjwCollapsed;
      const body = document.getElementById('sjw-body');
      if (body) body.classList.toggle('collapsed', _sjwCollapsed);
    },

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

    async checkMailbox() {
      const result = await apiFetch('/api/check-mailbox', { method: 'POST' });
      await loadContacts();
      return result;
    },

    async saveSettings(patch) {
      const s = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
      state.sender = {
        name: s.senderName || 'Your Name',
        company: s.senderCompany || 'Your Company',
        email: s.gmailEmail || '',
        customVariables: s.customVariables || [],
        resume: s.resume || null,
        lastMailboxCheckAt: s.lastMailboxCheckAt ? new Date(s.lastMailboxCheckAt) : null,
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

    // Puts a button into a loading state; returns a restore function.
    // Usage: const restore = window._app.btnLoad(btn, 'Saving…');
    //        try { ... } finally { restore(); }
    btnLoad(btn, label) {
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> ${label}`;
      return () => { btn.disabled = false; btn.innerHTML = orig; };
    },
  };

  // Wire up _sjwTogglePause after window._app is defined
  window._app._sjwTogglePause = async () => {
    if (!_sjwJobId) return;
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${_sjwJobId}`);
      if (!res.ok) return;
      const job = await res.json();
      const action = job.status === 'paused' ? 'resume' : 'pause';
      await fetch(`${API_BASE}/api/jobs/${_sjwJobId}/${action}`, { method: 'POST' });
      _sjwPoll();
    } catch (_) {}
  };
})();
