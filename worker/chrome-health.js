'use strict';

// Two questions about the debug Chrome that must be answered WITHOUT a full
// Playwright attach, because the full attach is exactly what breaks.
//
// connectOverCDP (Node) and connect_over_cdp (Python, inside `jl`) both walk
// every target in the browser before they resolve. A background tab Chrome has
// frozen or discarded never answers, so the attach hangs until its timeout —
// 180s for `jl doctor`. The worker used to read that silence as "logged out",
// which sent you hunting for a login problem that did not exist.
//
// Both checks here talk raw CDP over one WebSocket each, with a short timeout,
// so a stuck tab is named instead of hanging everything.

const PROBE_MS = 5000;

function cdp(wsUrl, method, params = {}, timeoutMs = PROBE_MS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('timeout')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (msg) => {
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      const data = JSON.parse(msg.data);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
  });
}

async function json(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(PROBE_MS) });
  return res.json();
}

// Page tabs that do not answer a trivial evaluate. Any one of them is enough to
// hang a Playwright attach, so the caller should refuse to start a run.
async function stuckTabs(port) {
  const targets = (await json(port, '/json/list')).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  const results = await Promise.all(targets.map(t =>
    cdp(t.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: '1' }).then(() => null, () => t.url)));
  return results.filter(Boolean);
}

// Browser-level cookie read: touches no page, so it works even with stuck tabs.
async function hasCookie(port, name, domainPart) {
  const { webSocketDebuggerUrl } = await json(port, '/json/version');
  const { cookies = [] } = await cdp(webSocketDebuggerUrl, 'Storage.getCookies');
  const now = Date.now() / 1000;
  return cookies.some(c => c.name === name && c.domain.includes(domainPart)
    && (c.expires <= 0 || c.expires > now));   // -1 = session cookie
}

// "docs.google.com, outlook.office.com and 3 more" — readable in the portal.
function describeTabs(urls, max = 4) {
  const hosts = [...new Set(urls.map(u => { try { return new URL(u).host; } catch (_) { return u; } }))];
  const shown = hosts.slice(0, max).join(', ');
  return hosts.length > max ? `${shown} and ${hosts.length - max} more` : shown;
}

function stuckTabsError(urls) {
  return `Chrome has ${urls.length === 1 ? '1 tab that is' : urls.length + ' tabs that are'} not responding `
       + `(${describeTabs(urls)}), which stops the worker attaching. Close those tabs or click into `
       + `each one to wake it, then try again. This is not a login problem.`;
}

module.exports = { stuckTabs, hasCookie, stuckTabsError };
