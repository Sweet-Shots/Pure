// main/privacy.js (2.4, E3) — HTTPS upgrades and HTTPS-only mode, clear browsing data when Pure closes, and the IPC
// behind the Site settings page.
//
// Hot path: upgrade() runs for every main-frame request (blocking.js calls it first). It only does a few string
// checks, one URL parse and Set lookups. Nothing here polls or sets timers.
//
// Modes (settings.httpsMode):
//   off      no upgrades, no request hook from this module.
//   upgrade  http main-frame loads go to https first. If https fails because the site has no TLS on that port,
//            the load silently continues over http for the rest of the run.
//   strict   same upgrade, but the failure shows the HTTPS_ONLY error page; "Continue" allows http for that host.
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const security = require('./security');
const { log } = require('./logger');

const MODES = new Set(['off', 'upgrade', 'strict']);
const MAX_URL = 2048;
const RECENT_MAX = 32; // upgraded main-frame loads remembered (one entry per webContents, oldest dropped)
const LOOP_WINDOW_MS = 10 * 1000; // the same http URL is not upgraded twice within this window on one webContents
const ALLOW_MAX = 500; // hosts allowed to stay on http for this run, per profile kind
const HTTPS_ONLY_DESC = "This site doesn't support a secure connection.";
const CLEAR_KINDS = ['history', 'cookies', 'cache', 'downloads'];
const SITE_LIMIT = 500;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

// Chromium net errors that mean "no TLS service on the port we tried": refused, reset, closed, timed out,
// SSL protocol errors, empty response. DNS and offline errors are left out (http would fail the same way), and so
// are certificate errors: a bad certificate keeps its normal error page and is never downgraded to http.
const NO_TLS_ERRORS = new Set([
  -7, // ERR_TIMED_OUT
  -100, // ERR_CONNECTION_CLOSED
  -101, // ERR_CONNECTION_RESET
  -102, // ERR_CONNECTION_REFUSED
  -104, // ERR_CONNECTION_FAILED
  -107, // ERR_SSL_PROTOCOL_ERROR
  -113, // ERR_SSL_VERSION_OR_CIPHER_MISMATCH
  -118, // ERR_CONNECTION_TIMED_OUT
  -324, // ERR_EMPTY_RESPONSE
]);

// ── Mode (cached; kept in sync by the settings listener, never read from disk on the hot path) ──
let mode = null; // 'off' | 'upgrade' | 'strict', null until first use
let modeHooked = false;

function storageMod() {
  return require('./storage');
}

function currentMode() {
  if (mode === null) {
    let value = 'upgrade';
    try {
      value = storageMod().settings.get().httpsMode;
    } catch {
      // storage not ready: keep the default
    }
    mode = MODES.has(value) ? value : 'upgrade';
    if (!modeHooked) {
      modeHooked = true;
      try {
        storageMod().settings.onChange(onSettings);
      } catch (err) {
        log('[privacy] settings listener failed:', err && err.message);
      }
    }
  }
  return mode;
}

function onSettings(settings) {
  const next = settings && MODES.has(settings.httpsMode) ? settings.httpsMode : 'upgrade';
  if (next === mode) return;
  mode = next;
  if (next === 'off') recent.clear();
  // Re-check which sessions carry the webRequest hook (it is needed for every mode except off).
  try {
    require('./blocking').refreshHooks();
  } catch (err) {
    log('[privacy] refreshHooks failed:', err && err.message);
  }
}

// ── Allow lists (per run; never persisted) ────────────────────────────────────
const allowed = { normal: new Set(), incognito: new Set() };

function allowSet(incognito) {
  return incognito ? allowed.incognito : allowed.normal;
}

function allowHost(host, incognito) {
  const set = allowSet(incognito);
  if (set.size >= ALLOW_MAX) set.clear(); // bounded; a dropped host just gets one more https attempt
  set.add(host);
}

// ── Upgraded loads, per webContents id: { http, https, host, incognito, at } ───
const recent = new Map();

function remember(id, entry) {
  if (recent.size >= RECENT_MAX && !recent.has(id)) recent.delete(recent.keys().next().value);
  recent.set(id, entry);
}

// Hosts that are never upgraded: single labels (localhost, intranet names), .localhost / .test / .local,
// IPv4 literals (last label is numeric) and IPv6 literals ('[...]').
function localOnly(host) {
  if (!host || host.indexOf('.') < 0 || host.charCodeAt(0) === 91 /* [ */) return true;
  const last = host.slice(host.lastIndexOf('.') + 1);
  return last === 'localhost' || last === 'test' || last === 'local' || /^[0-9]+$/.test(last);
}

// Hot path. Returns the https URL to redirect to, or null to leave the request alone.
function upgrade(details, incognito) {
  if (!details || details.resourceType !== 'mainFrame' || details.method !== 'GET') return null;
  if (currentMode() === 'off') return null;
  const raw = details.url;
  if (typeof raw !== 'string' || raw.length > MAX_URL || !raw.startsWith('http://')) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // Only the default port upgrades; a non-default port is someone's specific server, so it stays as typed.
  if (u.port !== '' && u.port !== '80') return null;
  const host = u.hostname;
  if (localOnly(host) || allowSet(!!incognito).has(host)) return null;

  const id = details.webContentsId;
  const now = Date.now();
  const prev = recent.get(id);
  // Loop guard: this exact http URL was already upgraded on this page moments ago, so the https load was sent back
  // to http by the server (a server-side downgrade). Let it through rather than ping-pong between the schemes.
  if (prev && prev.http === raw && now - prev.at < LOOP_WINDOW_MS) return null;

  u.protocol = 'https:';
  u.port = '';
  const https = u.href;
  remember(id, { http: raw, https, host, incognito: !!incognito, at: now });
  return https;
}

function wantsRequestHook() {
  return currentMode() !== 'off';
}

function sameUrl(a, b) {
  if (typeof b !== 'string' || b.length > MAX_URL) return false;
  const x = security.parseUrl(a);
  const y = security.parseUrl(b);
  return !!x && !!y && x.href === y.href;
}

// Called by tabs.js when a main-frame load fails. -> { load: httpUrl } | { error, desc } | null
function onMainFrameFail(info) {
  if (!info || currentMode() === 'off') return null;
  let id;
  try {
    const wc = info.webContents;
    if (!wc || wc.isDestroyed()) return null;
    id = wc.id;
  } catch {
    return null;
  }
  const entry = recent.get(id);
  if (!entry || !NO_TLS_ERRORS.has(info.errorCode) || !sameUrl(entry.https, info.url)) return null;
  recent.delete(id);
  if (currentMode() === 'strict') return { error: 'HTTPS_ONLY', desc: HTTPS_ONLY_DESC };
  // upgrade mode: this host has no https, so keep it on http for the rest of the run.
  allowHost(entry.host, entry.incognito);
  return { load: entry.http };
}

// ── IPC senders ───────────────────────────────────────────────────────────────
function pageUrl(event) {
  try {
    return event.senderFrame?.url || event.sender.getURL() || '';
  } catch {
    return '';
  }
}

// The HTTPS_ONLY error page that main shows for `url`: returns the failed URL (http or https), else null.
function httpsOnlyPageTarget(event) {
  if (!security.isInternalSender(event)) return null;
  const page = security.parseUrl(pageUrl(event));
  if (!page || page.protocol !== 'pure:' || page.host !== 'error') return null;
  if (page.searchParams.get('code') !== 'HTTPS_ONLY') return null;
  const failed = security.parseUrl(page.searchParams.get('url') || '');
  return failed && (failed.protocol === 'https:' || failed.protocol === 'http:') ? failed : null;
}

// privacy:allow-http — only from the HTTPS_ONLY page, only for the host that page is about.
function allowHttp(event, raw) {
  const failed = httpsOnlyPageTarget(event);
  if (!failed || typeof raw !== 'string' || raw.length > MAX_URL) return false;
  const target = security.parseUrl(raw);
  if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) return false;
  if (target.hostname !== failed.hostname || localOnly(target.hostname)) return false;

  const incognito = require('./sessions').isIncognitoSession(event.sender.session);
  allowHost(target.hostname, incognito);

  target.protocol = 'http:';
  if (target.port === '443' || target.port === '80') target.port = '';
  const found = require('./tabs').findTabByWebContentsId(event.sender.id);
  if (!found) return false;
  found.manager.navigate(found.tab.id, target.href);
  return true;
}

// Settings pages only (pure://settings/).
function requireSettingsPage(event) {
  if (!security.isInternalSender(event)) throw new Error('privacy: forbidden sender');
  const page = security.parseUrl(pageUrl(event));
  if (!page || page.protocol !== 'pure:' || page.host !== 'settings') throw new Error('privacy: forbidden sender');
}

// ── Site settings (sites:list / sites:reset) ──────────────────────────────────
function normHost(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 253) return '';
  let h = raw.trim().toLowerCase();
  if (h.startsWith('www.')) h = h.slice(4);
  return HOST_RE.test(h) ? h : '';
}

function hostOfOrigin(origin) {
  const u = security.parseUrl(origin);
  return u ? normHost(u.hostname) : '';
}

// Purify exceptions live in main/blocking.js. It exports exceptionList(incognito) and setSite(host, enabled,
// incognito); until it does, Purify-off sites are not listed and not reset here.
function purifyOffHosts() {
  let b = null;
  try {
    b = require('./blocking');
  } catch {
    return [];
  }
  if (!b || typeof b.exceptionList !== 'function') return [];
  try {
    return b.exceptionList(false).map(normHost).filter(Boolean);
  } catch {
    return [];
  }
}

function sitesList() {
  const byHost = new Map();
  const row = (host) => {
    let r = byHost.get(host);
    if (!r) {
      r = { host, permissions: [], purifyOff: false, purifyLevel: 'strict' };
      byHost.set(host, r);
    }
    return r;
  };

  for (const p of storageMod().sitePermissions.list()) {
    const host = hostOfOrigin(p.origin);
    if (host) row(host).permissions.push({ origin: p.origin, permission: p.permission, decision: p.decision });
  }
  for (const host of purifyOffHosts()) row(host).purifyOff = true;
  let balanced = [];
  try {
    balanced = storageMod().settings.get().purifyBalancedSites || [];
  } catch {
    balanced = [];
  }
  for (const h of balanced) {
    const host = normHost(h);
    if (host) row(host).purifyLevel = 'balanced';
  }

  return [...byHost.values()]
    .sort((a, b) => a.host.localeCompare(b.host))
    .slice(0, SITE_LIMIT);
}

// Resets everything Pure remembers for one host: permission decisions (every origin of that host), the Purify
// exception and the Balanced level. Never touches history, cookies or anything else.
function resetSite(raw) {
  const host = normHost(raw);
  if (!host) return false;
  const store = storageMod();

  const origins = new Set();
  for (const p of store.sitePermissions.list()) {
    if (hostOfOrigin(p.origin) === host) origins.add(p.origin);
  }
  for (const origin of origins) store.sitePermissions.reset(origin);

  const current = store.settings.get().purifyBalancedSites || [];
  if (current.some((h) => normHost(h) === host)) {
    store.settings.set({ purifyBalancedSites: current.filter((h) => normHost(h) !== host) });
  }

  let b = null;
  try {
    b = require('./blocking');
  } catch {
    b = null;
  }
  if (b && typeof b.setSite === 'function') {
    try {
      b.setSite(host, true, false);
    } catch (err) {
      log('[privacy] remove Purify exception failed:', err && err.message);
    }
  }
  return true;
}

// ── Clear on exit ─────────────────────────────────────────────────────────────
// The pick is written to userData/profile/clear-pending.json before anything is deleted, and the file is removed
// only after the clear finished. If Pure is killed mid-way, the next start finishes the job (init()).
function pendingFile() {
  return path.join(app.getPath('userData'), 'profile', 'clear-pending.json');
}

function sanitizePicks(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const picks = {};
  let any = false;
  for (const kind of CLEAR_KINDS) {
    picks[kind] = raw[kind] === true;
    if (picks[kind]) any = true;
  }
  return any ? picks : null;
}

function picksFromSettings() {
  const s = storageMod().settings.get();
  return sanitizePicks({
    history: s.clearOnExitHistory,
    cookies: s.clearOnExitCookies,
    cache: s.clearOnExitCache,
    downloads: s.clearOnExitDownloads,
  });
}

async function writePending(picks) {
  const file = pendingFile();
  const tmp = `${file}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify({ picks, at: Date.now() }), 'utf8');
    await fs.promises.rename(tmp, file);
    return true;
  } catch (err) {
    log('[privacy] cannot write clear-pending:', err && err.message);
    return false;
  }
}

async function removePending() {
  try {
    await fs.promises.rm(pendingFile(), { force: true });
  } catch (err) {
    log('[privacy] cannot remove clear-pending:', err && err.message);
  }
}

// Runs one clear. Each part is isolated (system.clearData), then the stores that wrote during the clear are
// flushed so the change survives an immediate quit.
async function runClears(picks) {
  try {
    await require('./system').clearData(picks);
  } catch (err) {
    log('[privacy] clear on exit failed:', err && err.message);
  }
  const tasks = [];
  if (picks.history) tasks.push(storageMod().flush());
  if (picks.downloads) tasks.push(Promise.resolve().then(() => require('./downloads').flush()));
  await Promise.allSettled(tasks);
}

// quit path (index.js before-quit). Must finish within ~1.2 s; the marker covers the rest.
async function flush() {
  const picks = picksFromSettings();
  if (!picks) return;
  await writePending(picks);
  await runClears(picks);
  await removePending();
}

// Startup: finish a clear that was interrupted by a quit or a crash, before windows open.
async function recoverPending() {
  let text;
  try {
    text = await fs.promises.readFile(pendingFile(), 'utf8');
  } catch {
    return; // no pending clear (the usual case)
  }
  let picks = null;
  try {
    picks = sanitizePicks(JSON.parse(text).picks);
  } catch {
    picks = null;
  }
  if (picks) {
    log('[privacy] finishing an interrupted clear on exit');
    await runClears(picks);
  }
  await removePending();
}

async function init() {
  currentMode();
  await recoverPending();
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerIpc(ipc) {
  ipc.handle('privacy:allow-http', (event, url) => allowHttp(event, url));

  ipc.handle('sites:list', (event) => {
    requireSettingsPage(event);
    return sitesList();
  });

  ipc.handle('sites:reset', (event, host) => {
    requireSettingsPage(event);
    return resetSite(host);
  });
}

module.exports = {
  init,
  registerIpc,
  flush,
  wantsRequestHook,
  upgrade,
  onMainFrameFail,
};
