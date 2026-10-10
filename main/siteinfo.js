'use strict';
// main/siteinfo.js — site info popover backend (Pure 2.2, owner C5).
//
// Channels (preload/chrome.js `pure.site`):
//   site:info(tabId)                      -> SiteInfo | null     (http(s) tabs only)
//   site:set-permission(tabId, perm, dec) -> 'allow'|'deny'|'ask' | null
//   site:clear-data(tabId)                -> { cookies: n } | null
// Only the browser UI may call these, and the tab must belong to the sender's window.
//
// Permissions: the stored decisions are the ones main/permissions.js uses (storage.sitePermissions, keyed by
// origin and Electron's permission name). Camera and microphone are one Electron permission ('media'), so
// they are one row. Incognito decisions live only in permissions.js's memory, which is not exposed, so
// incognito tabs report 'ask' for every row and changes are no-ops (SiteInfo.incognito = true tells the UI).
//
// Clear data: clearStorageData for the origin, plus cookies for the site's domain and its subdomains
// (the registrable domain, approximated: example.co.uk -> example.co.uk, news.example.com -> example.com).

const security = require('./security');
const storage = require('./storage');

const PERMISSIONS = [
  { id: 'media', label: 'Camera and microphone' },
  { id: 'geolocation', label: 'Location' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'clipboard-read', label: 'Clipboard' },
  { id: 'midi', label: 'MIDI devices' },
];
const PERMISSION_IDS = new Set(PERMISSIONS.map((p) => p.id));
const DECISIONS = new Set(['allow', 'deny', 'ask']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

function windowsModule() {
  return require('./windows');
}

function blockingModule() {
  return require('./blocking');
}

// Chrome sender with a valid tab id, owned by the sender's window. -> { st, tab, url } or null.
function tabContext(event, tabId) {
  if (!security.isChromeSender(event)) throw new Error('forbidden sender');
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  const st = windowsModule().senderState(event);
  const tab = st && st.tabs ? st.tabs.get(tabId) : null;
  if (!tab) return null;
  return { st, tab };
}

// The tab's http(s) URL as a URL object, or null for pure:// pages, about:blank, etc.
function webUrl(tab) {
  const raw = typeof tab.url === 'string' ? tab.url : '';
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function decisionOf(st, origin, permission) {
  if (st.incognito) return 'ask';
  const d = storage.sitePermissions.get(origin, permission);
  return d === 'allow' || d === 'deny' ? d : 'ask';
}

// Electron domain for cookie clearing: the registrable-ish domain, so subdomain cookies are included.
function siteBase(host) {
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const labels = host.split('.');
  const n = labels.length;
  if (n > 2 && labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2])) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

async function clearCookies(ses, host) {
  const cookies = await ses.cookies.get({ domain: siteBase(host) });
  let removed = 0;
  for (const c of cookies) {
    const domain = String(c.domain || '').replace(/^\./, '');
    if (!domain) continue;
    const scheme = c.secure ? 'https' : 'http';
    try {
      await ses.cookies.remove(`${scheme}://${domain}${c.path || '/'}`, c.name);
      removed++;
    } catch {
      // cookie already gone or not removable
    }
  }
  return removed;
}

function registerIpc(ipc) {
  ipc.handle('site:info', async (event, tabId) => {
    const ctx = tabContext(event, tabId);
    if (!ctx) return null;
    const { st, tab } = ctx;
    const u = webUrl(tab);
    if (!u) return null;
    const origin = u.origin;
    const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    let cookies = 0;
    try {
      cookies = (await st.session.cookies.get({ url: `${origin}/` })).length;
    } catch {
      cookies = 0;
    }
    return {
      tabId,
      origin,
      host: u.host,
      scheme: u.protocol.slice(0, -1),
      secure: tab.security === 'secure',
      certError: tab.security === 'error',
      permissions: PERMISSIONS.map((p) => ({
        permission: p.id,
        label: p.label,
        decision: decisionOf(st, origin, p.id),
      })),
      cookies,
      blocked: wc ? blockingModule().blockedOnTab(wc.id) : 0,
      zoom: tab.zoom,
      incognito: !!st.incognito,
    };
  });

  ipc.handle('site:set-permission', (event, tabId, permission, decision) => {
    const ctx = tabContext(event, tabId);
    if (!ctx) return null;
    if (!PERMISSION_IDS.has(permission) || !DECISIONS.has(decision)) return null;
    const u = webUrl(ctx.tab);
    if (!u || ctx.st.incognito) return null;
    if (decision === 'ask') {
      storage.sitePermissions.reset(u.origin, permission); // false when nothing was stored: still 'ask'
      return 'ask';
    }
    return storage.sitePermissions.set(u.origin, permission, decision) ? decision : null;
  });

  ipc.handle('site:clear-data', async (event, tabId) => {
    const ctx = tabContext(event, tabId);
    if (!ctx) return null;
    const u = webUrl(ctx.tab);
    if (!u) return null;
    const ses = ctx.st.session;
    try {
      await ses.clearStorageData({ origin: u.origin });
    } catch {
      // storage for the origin could not be cleared; cookies are still tried below
    }
    const cookies = await clearCookies(ses, u.hostname);
    return { cookies };
  });
}

module.exports = { registerIpc };
