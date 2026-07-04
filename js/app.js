const App = (() => {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const API_BASE = isLocal ? window.location.origin : '';

  let state = {
    contacts: [],
    templates: {},
    sender: { name: 'Your Name', company: 'Your Company', email: '' },
    currentTab: 'all',
    batchContacts: [],
  };

  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const isFollowUpDue = (c) =>
    (c.status === 'sent' || c.status === 'replied') && !c.followUpSentAt &&
    c.lastSentAt && (Date.now() - new Date(c.lastSentAt).getTime() >= THREE_DAYS_MS);

  const getStats = () => ({
    total: state.contacts.length,
    sent: state.contacts.filter(c => c.status === 'sent').length,
    bounced: state.contacts.filter(c => c.status === 'bounced').length,
    replied: state.contacts.filter(c => c.status === 'replied').length,
    pending: state.contacts.filter(c => c.approvalStatus === 'pending').length,
    remaining: state.contacts.filter(c => c.status === 'queued').length,
    followUpDue: state.contacts.filter(isFollowUpDue).length,
    followUpSent: state.contacts.filter(c => c.status === 'follow-up-sent').length,
    closed: state.contacts.filter(c => c.status === 'closed').length,
    noOpenings: state.contacts.filter(c => c.status === 'no-openings').length,
    inReview: state.contacts.filter(c => c.status === 'in-review').length,
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

  const STATUS_LABELS = { sent: 'Sent', 'follow-up-sent': 'Follow-up Sent', failed: 'Failed', pending: 'Pending', queued: 'Queued', approved: 'Approved', rejected: 'Rejected', bounced: 'Bounced', replied: 'Replied', closed: 'Closed', 'no-openings': 'No Openings', 'in-review': 'In Review' };

  const statusBadge = (status, contactId = null) => {
    const map = { sent: 'badge-sent', 'follow-up-sent': 'badge-followup', failed: 'badge-rejected', pending: 'badge-pending', queued: 'badge-queued', approved: 'badge-approved', rejected: 'badge-rejected', bounced: 'badge-bounced', replied: 'badge-replied', closed: 'badge-closed', 'no-openings': 'badge-noopenings', 'in-review': 'badge-inreview' };
    const dbl = contactId ? ` ondblclick="window._app.openStatusEdit(event,'${contactId}','${status}')"` : '';
    const hover = contactId ? ` onmouseenter="window._app.showStatusHistory(event,'${contactId}')" onmouseleave="window._app.hideStatusHistory()"` : '';
    const cursor = contactId ? ' style="cursor:pointer"' : '';
    const title = contactId ? ' title="Hover: history · Double-click: change"' : '';
    return `<span class="badge ${map[status] || 'badge-queued'}"${dbl}${hover}${cursor}${title}>${STATUS_LABELS[status] || status}</span>`;
  };

  let _historyHideTimer = null;

  const showStatusHistory = (event, contactId) => {
    clearTimeout(_historyHideTimer);
    document.querySelectorAll('.status-history-popup').forEach(el => el.remove());

    const contact = state.contacts.find(c => c.id === contactId);
    if (!contact) return;

    const history = contact.statusHistory || [];
    const fmtDate = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const rows = history.length
      ? [...history].reverse().map(h => `
          <div class="sh-row">
            <span class="badge ${({sent:'badge-sent','follow-up-sent':'badge-followup',failed:'badge-rejected',queued:'badge-queued',bounced:'badge-bounced',replied:'badge-replied',closed:'badge-closed','no-openings':'badge-noopenings','in-review':'badge-inreview'})[h.status]||'badge-queued'}" style="font-size:10px">${STATUS_LABELS[h.status]||h.status}</span>
            <span class="sh-date">${fmtDate(h.changedAt)}</span>
            ${h.note ? `<span class="sh-note">${h.note}</span>` : ''}
          </div>`)
        .join('')
      : `<div style="color:var(--text3);font-size:12px;padding:4px 0">No history recorded yet</div>`;

    const popup = document.createElement('div');
    popup.className = 'status-history-popup';
    popup.innerHTML = `<div class="sh-title">Status History</div>${rows}`;
    popup.addEventListener('mouseenter', () => clearTimeout(_historyHideTimer));
    popup.addEventListener('mouseleave', () => { _historyHideTimer = setTimeout(() => popup.remove(), 150); });

    const rect = event.target.getBoundingClientRect();
    popup.style.top  = (rect.bottom + 6) + 'px';
    popup.style.left = rect.left + 'px';
    document.body.appendChild(popup);

    const dd = popup.getBoundingClientRect();
    if (dd.bottom > window.innerHeight - 8) popup.style.top = (rect.top - dd.height - 6) + 'px';
    if (dd.right  > window.innerWidth  - 8) popup.style.left = Math.max(8, window.innerWidth - dd.width - 8) + 'px';
  };

  const hideStatusHistory = () => {
    _historyHideTimer = setTimeout(() => {
      document.querySelectorAll('.status-history-popup').forEach(el => el.remove());
    }, 150);
  };

  const STATUS_OPTIONS = [
    { value: 'queued',         label: 'Queued' },
    { value: 'sent',           label: 'Sent' },
    { value: 'follow-up-sent', label: 'Follow-up Sent' },
    { value: 'replied',        label: 'Replied' },
    { value: 'bounced',        label: 'Bounced' },
    { value: 'failed',         label: 'Failed' },
    { value: 'closed',         label: 'Closed' },
    { value: 'no-openings',    label: 'No Openings' },
    { value: 'in-review',      label: 'In Review' },
  ];

  const openStatusEdit = (event, contactId, currentStatus) => {
    event.stopPropagation();
    document.querySelectorAll('.status-edit-dropdown').forEach(el => el.remove());

    const dropdown = document.createElement('div');
    dropdown.className = 'status-edit-dropdown';
    STATUS_OPTIONS.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'status-edit-option' + (opt.value === currentStatus ? ' active' : '');
      item.textContent = opt.label;
      item.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        dropdown.remove();
        if (opt.value === currentStatus) return;
        try {
          await window._app.updateContact(contactId, { status: opt.value });
          document.dispatchEvent(new CustomEvent('contactupdated'));
        } catch (err) {
          toast('Could not update status: ' + err.message, 'error');
        }
      });
      dropdown.appendChild(item);
    });

    const rect = event.target.getBoundingClientRect();
    // Start below the badge, then adjust after measuring actual dropdown size
    dropdown.style.top  = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
    document.body.appendChild(dropdown);

    const dd = dropdown.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Flip upward if not enough room below
    if (dd.bottom > vh - 8) {
      dropdown.style.top = (rect.top - dd.height - 4) + 'px';
    }
    // Shift left if overflowing right edge
    if (dd.right > vw - 8) {
      dropdown.style.left = Math.max(8, vw - dd.width - 8) + 'px';
    }

    const close = () => dropdown.remove();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  };

  const filterContacts = (tab) => {
    if (tab === 'all') return state.contacts;
    if (tab === 'pending') return state.contacts.filter(c => c.approvalStatus === 'pending');
    if (tab === 'sent') return state.contacts.filter(c => c.status === 'sent');
    if (tab === 'remaining') return state.contacts.filter(c => c.status === 'queued');
    if (tab === 'bounced') return state.contacts.filter(c => c.status === 'bounced');
    if (tab === 'replied') return state.contacts.filter(c => c.status === 'replied');
    if (tab === 'followup-due')  return state.contacts.filter(isFollowUpDue);
    if (tab === 'follow-up-sent') return state.contacts.filter(c => c.status === 'follow-up-sent');
    if (tab === 'closed')        return state.contacts.filter(c => c.status === 'closed');
    if (tab === 'no-openings')   return state.contacts.filter(c => c.status === 'no-openings');
    if (tab === 'in-review')     return state.contacts.filter(c => c.status === 'in-review');
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

  // Converts plain-text body to HTML for previews and sending.
  // Supports [link text](url) syntax → clickable <a> tags.
  const bodyToHtml = (text) => {
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let result = '', lastIndex = 0, match;
    while ((match = linkRe.exec(text)) !== null) {
      result += esc(text.slice(lastIndex, match.index));
      result += `<a href="${esc(match[2])}" target="_blank" rel="noopener noreferrer">${esc(match[1])}</a>`;
      lastIndex = linkRe.lastIndex;
    }
    result += esc(text.slice(lastIndex));
    return result.replace(/\n/g, '<br>');
  };

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
        .replace(/{{senderCompany}}/g, state.sender.company)
        .replace(/{{sentSubject}}/g, contact.sentSubject || '');
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
          <button class="btn btn-xs" onclick="window._app._sjwCollapse()" title="Minimise"><i class="ti ti-minus"></i></button>
          <button class="btn btn-xs" onclick="window._app._sjwClose()" title="Dismiss"><i class="ti ti-x"></i></button>
        </div>
      </div>
      <div id="sjw-body">
        <div class="progress-bar"><div class="progress-fill" id="sjw-fill" style="width:0%"></div></div>
        <div id="sjw-stats" style="font-size:12px;color:var(--text2);margin-top:6px"></div>
      </div>
    `;
    document.body.appendChild(el);
  };

  const _sjwFormatTime = (ms) => {
    if (ms <= 0) return 'finishing…';
    const totalMins = Math.round(ms / 60000);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return hrs > 0 ? `~${hrs}h ${mins}m` : `~${mins}m`;
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

    // A stuck job has all items done but status still 'processing' due to a prior race condition.
    // Detect it here, call repair in the background, and treat it as done immediately.
    const allItemsDone = job.items.length > 0 && job.items.every(i => i.status !== 'pending');
    const effectivelyDone = job.status === 'done' || job.status === 'cancelled' || (job.status === 'processing' && allItemsDone);

    if (effectivelyDone) {
      if (job.status === 'processing' && allItemsDone) {
        fetch(`${API_BASE}/api/jobs/${_sjwJobId}/repair`, { method: 'POST' }).catch(() => {});
      }
      if (title) title.innerHTML = `<i class="ti ti-circle-check"></i> ${sent} sent${failed ? ', ' + failed + ' failed' : ''}`;
      if (pauseBtn) pauseBtn.style.display = 'none';
      clearInterval(_sjwInterval);
      _sjwInterval = null;
      setTimeout(_sjwDismiss, 8000);
    } else if (job.sendMode === 'drip') {
      const remaining = job.items.filter(i => i.status === 'pending').length;
      const delayMs = Math.round(3_600_000 / (job.ratePerHour || 5));
      const timeLeftMs = Math.max(0, (remaining - 1) * delayMs);
      const timeStr = _sjwFormatTime(timeLeftMs);
      if (title) title.innerHTML = `<i class="ti ti-clock"></i> Drip — ${timeStr} left`;
      if (pauseBtn) pauseBtn.style.display = 'none'; // individual events already scheduled
    } else if (job.status === 'paused') {
      if (title) title.innerHTML = `<i class="ti ti-player-pause"></i> Paused`;
      if (pauseBtn) { pauseBtn.style.display = ''; pauseBtn.innerHTML = '<i class="ti ti-player-play"></i>'; }
    } else {
      if (title) title.innerHTML = `<i class="ti ti-send"></i> Sending emails…`;
      if (pauseBtn) { pauseBtn.style.display = ''; pauseBtn.innerHTML = '<i class="ti ti-player-pause"></i>'; }
    }
  };

  // Natural auto-dismiss (job completed) — no dismissed marker needed, DB has the truth
  const _sjwDismiss = () => {
    clearInterval(_sjwInterval);
    _sjwInterval = null;
    _sjwJobId = null;
    const el = document.getElementById('send-job-widget');
    if (el) el.remove();
  };

  // User-initiated close → cancel the job in DB so it never comes back as "active"
  const _sjwClose = async () => {
    const id = _sjwJobId;
    _sjwDismiss(); // remove widget immediately
    if (!id) return;
    try {
      await fetch(`${API_BASE}/api/jobs/${id}/cancel`, { method: 'POST' });
    } catch (_) {}
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
    if (_sjwJobId) return; // already tracking a job on this page
    _sjwJobId = id;
    _sjwInjectDOM();
    if (!_sjwInterval) {
      _sjwInterval = setInterval(_sjwPoll, 3000);
    }
    _sjwPoll(); // immediate first update
  };

  // Use GET /api/jobs/active — DB is source of truth, no storage needed
  const _sjwCheckForActiveJob = async () => {
    if (_sjwIsStep3()) return; // step3 has its own inline progress
    if (_sjwJobId) return; // already tracking a job on this page
    try {
      const res = await fetch(`${API_BASE}/api/jobs/active`);
      if (!res.ok) return;
      const job = await res.json();
      if (!job) return;
      _sjwStart(job.id);
    } catch (_) {}
  };

  // Placeholder — real implementation wired up after window._app is defined below
  window._app_sjwTogglePause = () => window._app?._sjwTogglePause();

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
    openStatusEdit,
    showStatusHistory,
    hideStatusHistory,
    apiFetch,
    initials,
    avatarEl,
    statusBadge,
    renderTemplate,
    bodyToHtml,

    setTab(tab) { state.currentTab = tab; },

    initTheme,
    toggleTheme,
    initMobileNav,
    toast,

    // Widget API (used by step3.html and sjw button onclicks)
    _sjwStart,
    _sjwDismiss,
    _sjwClose,
    _sjwTogglePause: window._app_sjwTogglePause,
    _sjwCollapse() {
      _sjwCollapsed = !_sjwCollapsed;
      const body = document.getElementById('sjw-body');
      if (body) body.classList.toggle('collapsed', _sjwCollapsed);
    },

    async createContacts(rows) {
      const res = await apiFetch('/api/contacts', { method: 'POST', body: JSON.stringify(rows) });
      state.contacts.unshift(...res.created);
      return res; // { created: [...], skipped: N }
    },

    async updateContact(id, patch) {
      const updated = await apiFetch(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const idx = state.contacts.findIndex(c => c.id === id);
      if (idx !== -1) state.contacts[idx] = updated;
      return updated;
    },

    // Bulk-update N contacts in a single request using bulkWrite on the server.
    async bulkUpdateContacts(updates) {
      return apiFetch('/api/contacts', { method: 'PATCH', body: JSON.stringify(updates) });
    },

    async deleteContact(id) {
      await apiFetch(`/api/contacts/${id}`, { method: 'DELETE' });
      const idx = state.contacts.findIndex(c => c.id === id);
      if (idx !== -1) state.contacts.splice(idx, 1);
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
      const actionRes = await fetch(`${API_BASE}/api/jobs/${_sjwJobId}/${action}`, { method: 'POST' });
      if (!actionRes.ok) {
        const err = await actionRes.json();
        if (err.error === 'credentials_missing') {
          // Old job has no stored credentials — dismiss widget and let user go through Resume sending
          _sjwDismiss();
          toast('Gmail credentials expired for this job. Use the "Resume sending" button on the dashboard.', 'error', 7000);
          return;
        }
      }
      _sjwPoll();
    } catch (_) {}
  };
})();
