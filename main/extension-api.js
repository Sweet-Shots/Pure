'use strict';
// Chrome extension API compatibility layer (E1, Pure 2.4). Electron 44 implements part of chrome.* and some of it
// is wrong for a browser with its own tabs and windows. This module supplies what is missing or replaces what is
// wrong, for extensions of the persistent profile only (never incognito).
//
// Shape: preload/extension-api.js runs in every extension context (extension pages and MV3 workers), asks us for the
// APIs this extension may use (ext-api:init), installs them in the main world, and sends calls (ext-api:call) and
// listener registrations (ext-api:sub). We push events (ext-api:event) to the contexts that listen.
//
// Trust: the extension id is always taken from the caller's own URL (frame URL or worker scope), never from the
// arguments, and the extension must be loaded. Host permissions and the "cookies"/"contextMenus"/... permissions come
// from the manifest. Nothing here reads the user's data for an extension that has not asked for it.
//
// Tab ids follow Electron's native numbering for tabs that are loaded (the webContents id), so content-script
// messaging and sender.tab.id match what Electron itself does. A tab that is not loaded yet (lazy or discarded) has
// the id -(pureTabId + 1); when it first loads it gets its real id and tabs.onReplaced reports the change.
//
// Only loaded extensions cost anything: nothing is registered until extensions.js calls ensure() for the first load.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Notification, ipcMain, nativeImage } = require('electron');
const { log } = require('./logger');

const windows = () => require('./windows');
const tabs = () => require('./tabs');
const extensionsMod = () => require('./extensions');

const PRELOAD = path.join(__dirname, '..', 'preload', 'extension-api.js');
const PRELOAD_IDS = { frame: 'pure-extension-api-frame', worker: 'pure-extension-api-worker' };
const CH = { init: 'ext-api:init', call: 'ext-api:call', sub: 'ext-api:sub', event: 'ext-api:event' };
const EXT_PREFIX = 'chrome-extension://';
const ID_RE = /^[a-p]{32}$/;
const MAX_ARGS = 20;
const PENDING_MAX = 100;
const ICON_MAX_BYTES = 128 * 1024;
const ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const SYNC_QUOTA_BYTES = 102400;
const SYNC_ITEM_BYTES = 8192;
const SYNC_MAX_ITEMS = 512;
const SYNC_SAVE_MS = 1000;
const ALARM_MIN_MS = 30 * 1000; // Chrome's minimum spacing for alarms
const WORKER_FLUSH_MS = 200;
const MENU_CONTEXTS = new Set(['all', 'page', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'frame', 'launcher', 'browser_action', 'page_action', 'action']);
const EVENT_NAMES = new Set([
  'action.onClicked',
  'tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated', 'tabs.onReplaced', 'tabs.onMoved',
  'windows.onCreated', 'windows.onRemoved', 'windows.onFocusChanged',
  'contextMenus.onClicked',
  'notifications.onClicked', 'notifications.onClosed',
  'cookies.onChanged',
  'webNavigation.onBeforeNavigate', 'webNavigation.onCommitted', 'webNavigation.onDOMContentLoaded',
  'webNavigation.onCompleted', 'webNavigation.onErrorOccurred',
  'storage.onChanged',
  'permissions.onAdded', 'permissions.onRemoved',
  'alarms.onAlarm',
  'runtime.onMessage', // only tracked (native messages are Electron's); see wakeForPage()
]);

let ses = null; // persist:pure session, set by ensure()
let wiredIpc = false;
const exts = new Map(); // extension id -> ExtState
const knownIds = new Map(); // Pure tab id -> chrome tab id last reported
const winIds = new WeakMap(); // BrowserWindow -> Pure window id
const workerWired = new WeakSet();
const navWired = new WeakSet(); // webContents with navigation listeners
const frameIds = new WeakMap(); // WebFrameMain -> small integer (webNavigation frameId)
const groupNums = new Map(); // Pure group id -> integer (tab.groupId)
let frameSeq = 0;
let groupSeq = 0;
let noteSeq = 0;
let menuSeq = 0;
let cookieWired = false;
let tabsWired = false;
let navSubscribed = false;
const patternCache = new Map();

function newState(id) {
  return {
    id,
    subs: new Map(), // event -> Map<contextKey, {kind:'frame'|'worker', frame?, worker?}>
    swNames: new Set(), // events the background worker listens to (kept while it is stopped, to wake it)
    swRunning: false,
    swStart: null, // promise while the worker is being started
    wantsMessages: false, // the worker listens for runtime.onMessage (content scripts may message it)
    pending: [], // {name, args} queued while the worker starts
    actionGlobal: {}, // title, badge, badgeColor, badgeTextColor, icon, popup, enabled
    actionTabs: new Map(), // Pure tab id -> same keys
    menus: new Map(), // id -> item
    notes: new Map(), // notification id -> Notification
    sync: null, // { data: {}, bytes, dirty, timer } once loaded
    syncP: null, // promise of the first load (calls wait for it)
    unsupported: new Set(),
    alarms: new Map(), // name -> { name, scheduledTime, periodInMinutes?, timer }
  };
}

function stateOf(id) {
  let s = exts.get(id);
  if (!s) {
    s = newState(id);
    exts.set(id, s);
  }
  return s;
}

// ── Caller identity ───────────────────────────────────────────────────────────

// URL an extension may open in a tab: web pages, about:blank, or its own pages (relative paths resolve
// against the extension root). Other extensions' pages and other schemes are refused.
function tabUrlFor(ctx, raw) {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Invalid url.');
  if (/^(https?:\/\/|about:blank$)/i.test(raw)) return raw;
  let u = null;
  try { u = new URL(raw, `chrome-extension://${ctx.id}/`); } catch { u = null; }
  if (u && u.protocol === 'chrome-extension:' && u.hostname === ctx.id) return u.href;
  throw new Error("Only web pages and this extension's own pages can be opened in a tab.");
}

function extIdFromUrl(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(EXT_PREFIX)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'chrome-extension:' && ID_RE.test(u.hostname) ? u.hostname : null;
  } catch {
    return null;
  }
}

// Who is calling: { id, ext, frame, worker, wc } or null. Works for IPC from frames and from service workers.
function callerOf(event) {
  if (!ses || !event) return null;
  let raw = '';
  let frame = null;
  let worker = null;
  let wc = null;
  if (event.serviceWorker) {
    if (event.session !== ses) return null;
    worker = event.serviceWorker;
    raw = worker.scope || '';
  } else if (event.senderFrame) {
    wc = event.sender || null;
    if (!wc || wc.session !== ses) return null;
    frame = event.senderFrame;
    raw = frame.url || '';
  } else {
    return null;
  }
  const id = extIdFromUrl(raw);
  if (!id) return null;
  const ext = ses.extensions && ses.extensions.getExtension(id);
  if (!ext) return null;
  return { id, ext, frame, worker, wc };
}

// ── Manifest helpers ──────────────────────────────────────────────────────────

function permsOf(manifest) {
  const perms = [];
  const hosts = [];
  const list = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const p of list) {
    if (typeof p !== 'string') continue;
    if (p === '<all_urls>' || p.includes('://')) hosts.push(p);
    else perms.push(p);
  }
  if (manifest && Array.isArray(manifest.host_permissions)) {
    for (const h of manifest.host_permissions) if (typeof h === 'string') hosts.push(h);
  }
  return { perms, hosts };
}

// Chrome match patterns: <all_urls>, *://*/*, https://*.example.com/path*
function patternRegex(pattern) {
  if (patternCache.has(pattern)) return patternCache.get(pattern);
  let re = null;
  if (pattern === '<all_urls>') {
    re = /^(https?|file|ftp|wss?):\/\//i;
  } else {
    const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)$/i.exec(pattern);
    if (m) {
      const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const scheme = m[1] === '*' ? '(https?|wss?)' : esc(m[1].toLowerCase());
      const host = m[2];
      let hostRe;
      if (host === '*') hostRe = '[^/]*';
      else if (host.startsWith('*.')) hostRe = '([^/]*\\.)?' + esc(host.slice(2));
      else hostRe = esc(host);
      const pathRe = esc(m[3]).replace(/\*/g, '.*');
      re = new RegExp('^' + scheme + ':\\/\\/' + hostRe + pathRe + '$', 'i');
    }
  }
  if (patternCache.size > 500) patternCache.clear();
  patternCache.set(pattern, re);
  return re;
}

function matchesPatterns(patterns, url) {
  if (typeof url !== 'string' || !url) return false;
  for (const p of patterns) {
    const re = patternRegex(p);
    if (re && re.test(url)) return true;
  }
  return false;
}

// Simple glob used by tabs.query({title}) (`*` only).
function globMatch(glob, value) {
  const re = new RegExp('^' + String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return re.test(value);
}

function infoOf(id) {
  const ext = ses && ses.extensions && ses.extensions.getExtension(id);
  const manifest = ext && ext.manifest ? ext.manifest : {};
  const { perms, hosts } = permsOf(manifest);
  return { manifest, perms, hosts, mv: manifest.manifest_version === 2 ? 2 : 3, extDir: ext ? ext.path : "" };
}

function canSeeUrl(info, url) {
  return info.perms.includes('tabs') || matchesPatterns(info.hosts, url);
}

function requireHost(info, url) {
  if (!matchesPatterns(info.hosts, url)) throw new Error(`Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`);
}

// ── Window and tab lookups (normal windows only; incognito is never exposed) ─────────────

function managers() {
  const out = [];
  for (const win of windows().getBrowserWindows()) {
    const mgr = windows().getTabManager(win);
    if (mgr && !mgr.incognito && !mgr.destroyed) out.push(mgr);
  }
  return out;
}

function managerById(id) {
  if (!Number.isInteger(id)) return null;
  return managers().find((m) => m.state.id === id) || null;
}

function lastFocusedManager() {
  let win = null;
  try {
    win = windows().getLastFocusedBrowserWindow();
  } catch {
    win = null;
  }
  const mgr = win ? windows().getTabManager(win) : null;
  if (mgr && !mgr.incognito && !mgr.destroyed) return mgr;
  return managers()[0] || null;
}

// -> { mgr, tab } | null
function findTab(id) {
  if (!Number.isInteger(id)) return null;
  if (id > 0) {
    const r = tabs().findTabByWebContentsId(id);
    if (!r || r.manager.incognito || r.manager.destroyed) return null;
    return { mgr: r.manager, tab: r.tab };
  }
  if (id < 0) {
    const pureId = -id - 1;
    for (const mgr of managers()) {
      const tab = mgr.get(pureId);
      if (tab) return { mgr, tab };
    }
  }
  return null;
}

function requireTab(id) {
  const f = findTab(id);
  if (!f) throw new Error(`No tab with id: ${id}.`);
  return f;
}

function findPureTab(pureId) {
  for (const mgr of managers()) {
    const tab = mgr.get(pureId);
    if (tab) return { mgr, tab };
  }
  return null;
}

function chromeIdOf(tab) {
  const wc = tab.view && tab.view.webContents;
  return wc && !wc.isDestroyed() ? wc.id : -(tab.id + 1);
}

function groupNum(groupId) {
  if (!groupId) return -1;
  if (!groupNums.has(groupId)) groupNums.set(groupId, ++groupSeq);
  return groupNums.get(groupId);
}

// Tab object for one extension. url/title/favIconUrl only when the extension may see them.
function tabObject(info, mgr, tab) {
  const wc = tab.view && tab.view.webContents;
  const loaded = !!(wc && !wc.isDestroyed());
  const active = mgr.activeId === tab.id;
  const url = tab.url || '';
  const out = {
    id: chromeIdOf(tab),
    index: mgr.indexOf(tab),
    windowId: mgr.state.id,
    active,
    highlighted: active,
    selected: active,
    pinned: !!tab.pinned,
    audible: !!tab.isAudible,
    mutedInfo: { muted: !!tab.isMuted, reason: 'user' },
    discarded: !loaded,
    autoDiscardable: true,
    frozen: false,
    incognito: false,
    status: tab.isLoading ? 'loading' : 'complete',
    groupId: groupNum(tab.groupId),
    width: 0,
    height: 0,
  };
  if (canSeeUrl(info, url)) {
    out.url = url;
    out.title = tab.title || url;
    out.favIconUrl = tab.favicon || '';
  }
  return out;
}

function windowObject(info, mgr, populate) {
  const win = mgr.win;
  const b = win.getBounds();
  const state = win.isMinimized() ? 'minimized' : win.isFullScreen() ? 'fullscreen' : win.isMaximized() ? 'maximized' : 'normal';
  const out = {
    id: mgr.state.id,
    focused: BrowserWindow.getFocusedWindow() === win,
    incognito: false,
    alwaysOnTop: false,
    type: 'normal',
    state,
    left: b.x,
    top: b.y,
    width: b.width,
    height: b.height,
  };
  if (populate) out.tabs = mgr.tabs.map((t) => tabObject(info, mgr, t));
  return out;
}

// The tab-id bookkeeping: report a changed id once (tabs.onReplaced) and remember the current one.
function noteTabId(tab) {
  const id = chromeIdOf(tab);
  const prev = knownIds.get(tab.id);
  knownIds.set(tab.id, id);
  if (prev !== undefined && prev !== id) emitToAll('tabs.onReplaced', () => [id, prev]);
  return id;
}

// ── Events ───────────────────────────────────────────────────────────────────

// Keys listeners so the same frame or worker is never registered twice.
function contextKeyOfFrame(frame) {
  return `f:${frame.processId}:${frame.routingId}`;
}

// Sends one event to every context of one extension that listens to it; queues it for a stopped worker.
function emitTo(s, name, args) {
  const m = s.subs.get(name);
  if (m) {
    for (const [key, t] of [...m]) {
      try {
        if (t.kind === 'frame') {
          if (t.frame.isDestroyed()) {
            m.delete(key);
            continue;
          }
          t.frame.send(CH.event, name, args);
        } else if (s.swRunning && t.worker && !t.worker.isDestroyed()) {
          t.worker.send(CH.event, name, args);
        }
      } catch {
        m.delete(key);
      }
    }
    if (m.size === 0) s.subs.delete(name);
  }
  if (s.swNames.has(name) && !s.swRunning) queueForWorker(s, name, args);
}

// `build(state)` returns the args for one extension, or null to skip it (per-extension visibility).
function emitToAll(name, build) {
  for (const s of exts.values()) {
    if (!s.subs.has(name) && !s.swNames.has(name)) continue;
    const args = build(s);
    if (args) emitTo(s, name, args);
  }
}

function hasListeners(name) {
  for (const s of exts.values()) if (s.subs.has(name) || s.swNames.has(name)) return true;
  return false;
}

// Starts a stopped background worker (once; concurrent callers share the start). Resolves true when it runs.
function ensureWorker(s) {
  if (s.swRunning || !ses) return Promise.resolve(s.swRunning);
  const bg = infoOf(s.id).manifest.background;
  if (!bg || typeof bg.service_worker !== 'string') return Promise.resolve(false); // MV2 background pages never stop
  if (!s.swStart) {
    s.swStart = ses.serviceWorkers
      .startWorkerForScope(`${EXT_PREFIX}${s.id}/`)
      .then(() => true, (err) => {
        log('[extension-api] could not start the worker of', s.id, err && err.message);
        return false;
      })
      .finally(() => {
        s.swStart = null;
      });
  }
  return s.swStart;
}

// A stopped background worker is started for an event it listens to, as Chrome does. Events wait in the queue.
function queueForWorker(s, name, args) {
  if (s.pending.length >= PENDING_MAX) s.pending.shift();
  s.pending.push({ name, args });
  ensureWorker(s).then((ok) => {
    if (!ok) s.pending = [];
  });
}

// Content scripts message the background through Electron's native path, which does not start an idle worker. So a
// navigation starts the worker of extensions that listen for messages and have a content script for this page.
function wakeForPage(url) {
  if (!url || !ses) return;
  for (const s of exts.values()) {
    if (s.swRunning || !s.wantsMessages) continue;
    const scripts = infoOf(s.id).manifest.content_scripts;
    if (!Array.isArray(scripts)) continue;
    if (scripts.some((cs) => cs && matchesPatterns(Array.isArray(cs.matches) ? cs.matches : [], url))) ensureWorker(s);
  }
}

function flushPending(s) {
  if (!s.swRunning || s.pending.length === 0) return;
  const queue = s.pending;
  s.pending = [];
  for (const ev of queue) {
    if (s.swNames.has(ev.name)) emitTo(s, ev.name, ev.args);
  }
}

// ── Action state (chrome.action) ───────────────────────────────────────────────

// Hex for the toolbar badge (#rrggbb or #rrggbbaa); arrays are [r,g,b,a] as Chrome passes them.
function colorHex(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, '0');
    const alpha = value.length > 3 && Number(value[3]) < 255 ? h(value[3]) : '';
    return `#${h(value[0])}${h(value[1])}${h(value[2])}${alpha}`;
  }
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : '';
}

function parseColor(value) {
  if (Array.isArray(value) && value.length >= 3) return value.slice(0, 4).map((n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))));
  if (typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    const v = value.slice(1);
    const out = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
    if (v.length === 8) out.push(parseInt(v.slice(6, 8), 16));
    else out.push(255);
    return out;
  }
  throw new Error('Invalid color.');
}

// What the toolbar shows for one extension on one Pure tab (undefined = use the manifest default).
function effectiveAction(extId, pureTabId) {
  const s = exts.get(extId);
  if (!s) return {};
  const tabOverrides = pureTabId != null ? s.actionTabs.get(pureTabId) : null;
  const pick = (key) => {
    if (tabOverrides && Object.prototype.hasOwnProperty.call(tabOverrides, key)) return tabOverrides[key];
    return s.actionGlobal[key];
  };
  return {
    title: pick('title'),
    icon: pick('icon'),
    badge: pick('badge'),
    badgeColor: colorHex(pick('badgeColor')),
    popup: pick('popup'),
    enabled: pick('enabled'),
  };
}

function actionsChanged(extId) {
  try {
    extensionsMod().scheduleActionPush();
  } catch {
    /* UI not ready */
  }
  return extId;
}


// Writes an action value: for one tab (Pure tab id) or globally.
function setAction(ctx, key, tab, value) {
  const s = ctx.state;
  if (tab) {
    let o = s.actionTabs.get(tab.id);
    if (!o) {
      o = {};
      s.actionTabs.set(tab.id, o);
    }
    if (value === null || value === undefined) delete o[key];
    else o[key] = value;
  } else if (value === null || value === undefined) {
    delete s.actionGlobal[key];
  } else {
    s.actionGlobal[key] = value;
  }
  actionsChanged(ctx.id);
  return null;
}

function popupUrlFor(id, rel) {
  if (rel === '' || rel === null) return '';
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 300) throw new Error('Invalid popup.');
  const u = new URL(rel.trim(), `${EXT_PREFIX}${id}/`);
  if (u.protocol !== 'chrome-extension:' || u.hostname !== id) throw new Error('Invalid popup.');
  return u.href;
}

// Resolves an icon path the way Chrome does: relative to the calling script's URL (so "../icons/x.png" from
// background/index.js is icons/x.png), and it must stay inside the extension folder.
function iconFileOf(extId, extDir, rel, baseUrl) {
  if (typeof rel !== 'string' || !rel || rel.length > 300) return null;
  let u;
  try {
    u = new URL(rel, baseUrl || `${EXT_PREFIX}${extId}/`);
  } catch {
    return null;
  }
  if (u.protocol !== 'chrome-extension:' || u.hostname !== extId) return null;
  const relPath = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!relPath || relPath.includes('\0')) return null;
  const root = path.resolve(extDir) + path.sep;
  const file = path.resolve(extDir, relPath);
  return file.startsWith(root) ? file : null;
}

// Reads an icon file as a small PNG/JPEG/GIF/WebP data URL.
function readIconDataUrl(file) {
  if (!file) return null;
  const type = ICON_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > ICON_MAX_BYTES) return null;
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

function pathFromIconSpec(spec) {
  if (typeof spec === 'string') return spec;
  if (!spec || typeof spec !== 'object') return '';
  const keys = Object.keys(spec).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!keys.length) return '';
  const best = keys.find((k) => k >= 32) ?? keys[keys.length - 1];
  return typeof spec[best] === 'string' ? spec[best] : '';
}

// imageData (ImageData or {size: ImageData}) arrives from the main world as {width, height, data: base64 RGBA}.
function dataUrlFromImageData(img) {
  if (!img || typeof img !== 'object' || typeof img.data !== 'string') return null;
  const w = Math.floor(Number(img.width));
  const h = Math.floor(Number(img.height));
  if (!(w > 0 && h > 0 && w <= 128 && h <= 128)) return null;
  const buf = Buffer.from(img.data, 'base64');
  if (buf.length !== w * h * 4) return null;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i];
    buf[i] = buf[i + 2];
    buf[i + 2] = r;
  }
  const image = nativeImage.createFromBitmap(buf, { width: w, height: h });
  return image.isEmpty() ? null : `data:image/png;base64,${image.toPNG().toString('base64')}`;
}

// ── Context for a handler ──────────────────────────────────────────────────────

function makeCtx(c) {
  const info = infoOf(c.id);
  let mgr = null;
  let tabRef = null;
  if (c.wc) {
    const found = tabs().findTabByWebContentsId(c.wc.id);
    if (found) {
      tabRef = { mgr: found.manager, tab: found.tab };
      mgr = found.manager;
    } else {
      // A popup or extension window: its Pure window is the parent.
      const win = BrowserWindow.fromWebContents(c.wc);
      const parent = win && !win.isDestroyed() ? (win.getParentWindow ? win.getParentWindow() : null) : null;
      const owner = windows().getTabManager(win) || (parent ? windows().getTabManager(parent) : null);
      if (owner && !owner.incognito) mgr = owner;
    }
  }
  const base = c.worker ? c.worker.scriptURL : c.frame ? c.frame.url : '';
  return { id: c.id, state: stateOf(c.id), info, base, mgr: mgr && !mgr.incognito ? mgr : null, tabRef };
}

// ── IPC: init, call, subscribe ───────────────────────────────────────────────

// Namespaces Pure does not provide. A worker that touches one at top level (chrome.commands.onCommand.addListener, for
// example) fails to start, so each gets a stand-in: calls reject with "not supported", events never fire.
const STUB_ALWAYS = ['commands', 'omnibox'];
const STUB_WITH_PERMISSION = [
  'bookmarks', 'browsingData', 'desktopCapture', 'downloads', 'fontSettings', 'history', 'identity', 'pageCapture',
  'power', 'privacy', 'proxy', 'readingList', 'search', 'sessions', 'sidePanel', 'tabCapture', 'tabGroups', 'topSites',
  'tts', 'debugger', 'gcm', 'userScripts', 'vpnProvider', 'contentSettings', 'dns', 'printerProvider', 'loginState',
  // Electron does not expose chrome.webRequest to extensions (network rules run through DNR where supported).
  'webRequest', 'webRequestBlocking', 'webRequestAuthProvider',
];

function initInfo(event) {
  const c = callerOf(event);
  if (!c) return null;
  const info = infoOf(c.id);
  const apis = ['action', 'tabs', 'windows', 'permissions', 'storage'];
  const stubs = STUB_ALWAYS.concat(STUB_WITH_PERMISSION.filter((p) => info.perms.includes(p)));
  if (info.perms.includes('contextMenus')) apis.push('contextMenus');
  if (info.perms.includes('notifications')) apis.push('notifications');
  if (info.perms.includes('alarms')) apis.push('alarms');
  if (info.perms.includes('cookies')) apis.push('cookies');
  if (info.perms.includes('webNavigation')) apis.push('webNavigation');
  return {
    id: c.id,
    name: String(info.manifest.name || '').slice(0, 200),
    version: String(info.manifest.version || '').slice(0, 40),
    manifestVersion: info.mv,
    permissions: info.perms,
    hostPermissions: info.hosts,
    apis,
    stubs,
  };
}

async function onCall(event, api, method, args) {
  const c = callerOf(event);
  if (!c) return fail('Not allowed.');
  const ns = typeof api === 'string' ? api : '';
  const name = typeof method === 'string' ? method : '';
  const alias = { browserAction: 'action', menus: 'contextMenus' }[ns] || ns;
  const key = `${alias}.${name}`;
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, key)) {
    const s = stateOf(c.id);
    if (s.unsupported.size < 50) s.unsupported.add(key);
    return fail(`${ns}.${name} is not supported in Pure yet.`);
  }
  if (!Array.isArray(args) || args.length > MAX_ARGS) return fail('Bad arguments.');
  try {
    const value = await HANDLERS[key](makeCtx(c), ...args);
    return { ok: true, value: value === undefined ? null : value };
  } catch (err) {
    return fail(err && err.message ? err.message : 'Failed.');
  }
}

function fail(message) {
  return { ok: false, message: String(message || 'Failed.').slice(0, 300) };
}

function onSub(event, name, on) {
  const c = callerOf(event);
  if (!c || typeof name !== 'string' || !EVENT_NAMES.has(name)) return;
  const s = stateOf(c.id);
  if (on) {
    let m = s.subs.get(name);
    if (!m) {
      m = new Map();
      s.subs.set(name, m);
    }
    const key = c.worker ? 'worker' : contextKeyOfFrame(c.frame);
    m.set(key, c.worker ? { kind: 'worker', worker: c.worker } : { kind: 'frame', frame: c.frame });
    if (c.worker) {
      s.swNames.add(name);
      if (name === 'runtime.onMessage') s.wantsMessages = true;
      flushPending(s);
    }
    onFirstListener(name);
  } else {
    const m = s.subs.get(name);
    if (m) {
      m.delete(c.worker ? 'worker' : contextKeyOfFrame(c.frame));
      if (m.size === 0) s.subs.delete(name);
    }
  }
}

// Some events need a native hook that is only worth installing once someone listens.
function onFirstListener(name) {
  if (name === 'cookies.onChanged') wireCookies();
  if (name.startsWith('webNavigation.')) {
    navSubscribed = true;
    wireNavigationAll();
  }
}

function wireIpc(sessionObj) {
  if (wiredIpc) return;
  wiredIpc = true;
  ipcMain.on(CH.init, (event) => {
    event.returnValue = initInfo(event);
  });
  ipcMain.handle(CH.call, (event, api, method, args) => onCall(event, api, method, args));
  ipcMain.on(CH.sub, (event, name, on) => onSub(event, name, on));
  sessionObj.serviceWorkers.on('running-status-changed', onWorkerStatus);
}

// The worker's own IPC: the same three channels, scoped to the worker (ServiceWorkerMain.ipc).
function wireWorker(w) {
  if (workerWired.has(w)) return;
  workerWired.add(w);
  w.ipc.on(CH.init, (event) => {
    event.returnValue = initInfo(event);
  });
  w.ipc.handle(CH.call, (event, api, method, args) => onCall(event, api, method, args));
  w.ipc.on(CH.sub, (event, name, on) => onSub(event, name, on));
}

// Worker lifecycle. The worker object is only available while it exists, so the extension id is remembered per version
// at 'starting' and used for the later 'running' / 'stopped' events.
const versionOwner = new Map(); // ServiceWorker versionId -> extension id

function onWorkerStatus(details) {
  if (!ses || !details) return;
  const vid = details.versionId;
  if (details.runningStatus === 'starting' || details.runningStatus === 'running') {
    let w = null;
    try {
      w = ses.serviceWorkers.getWorkerFromVersionID(vid) || null;
    } catch {
      w = null;
    }
    const id = w ? extIdFromUrl(w.scope) : versionOwner.get(vid) || null;
    if (!id) return; // a site's own worker, not ours
    if (w && details.runningStatus === 'starting') {
      versionOwner.set(vid, id);
      wireWorker(w);
    }
    const s = stateOf(id);
    if (details.runningStatus === 'running') {
      s.swRunning = true;
      setTimeout(() => flushPending(s), WORKER_FLUSH_MS).unref?.();
    }
    return;
  }
  if (details.runningStatus === 'stopping' || details.runningStatus === 'stopped') {
    const id = versionOwner.get(vid);
    if (id) {
      stateOf(id).swRunning = false;
      if (details.runningStatus === 'stopped') versionOwner.delete(vid);
    }
  }
}

// ── Tab and window event bridge ───────────────────────────────────────────────

function onTabCreated(mgr, st) {
  const tab = mgr.get(st && st.id);
  if (!tab || mgr.incognito) return;
  noteTabId(tab);
  emitToAll('tabs.onCreated', (s) => [tabObject(infoOf(s.id), mgr, tab)]);
}

function onTabUpdated(mgr, payload) {
  if (!payload || mgr.incognito) return;
  const tab = mgr.get(payload.id);
  if (!tab) return;
  const id = noteTabId(tab);
  if ('isLoading' in payload && tab.isLoading) wakeForPage(tab.url);
  if (Object.keys(payload).length <= 1) return;
  emitToAll('tabs.onUpdated', (s) => {
    const info = infoOf(s.id);
    const change = {};
    if ('url' in payload && canSeeUrl(info, tab.url)) change.url = tab.url;
    if ('title' in payload && canSeeUrl(info, tab.url)) change.title = tab.title || '';
    if ('favicon' in payload && canSeeUrl(info, tab.url)) change.favIconUrl = tab.favicon || '';
    if ('isLoading' in payload) change.status = tab.isLoading ? 'loading' : 'complete';
    if ('isAudible' in payload) change.audible = !!tab.isAudible;
    if ('isMuted' in payload) change.mutedInfo = { muted: !!tab.isMuted, reason: 'user' };
    if (!Object.keys(change).length) return null;
    return [id, change, tabObject(info, mgr, tab)];
  });
  if (navSubscribed) wireNavigation(tab);
}

function onTabRemoved(mgr, pureId) {
  if (mgr.incognito) return;
  const id = knownIds.has(pureId) ? knownIds.get(pureId) : -(pureId + 1);
  knownIds.delete(pureId);
  for (const s of exts.values()) s.actionTabs.delete(pureId);
  emitToAll('tabs.onRemoved', () => [id, { windowId: mgr.state.id, isWindowClosing: false }]);
}

function onTabActivated(mgr, pureId) {
  if (mgr.incognito) return;
  const tab = mgr.get(pureId);
  if (!tab) return;
  const id = noteTabId(tab);
  emitToAll('tabs.onActivated', () => [{ tabId: id, windowId: mgr.state.id }]);
  actionsChanged(null);
  if (navSubscribed) wireNavigation(tab);
}

function wireTabEvents() {
  if (tabsWired) return;
  tabsWired = true;
  const te = tabs().tabEvents;
  te.on('tabs:created', onTabCreated);
  te.on('tabs:updated', onTabUpdated);
  te.on('tabs:removed', onTabRemoved);
  te.on('tabs:activated', onTabActivated);
}

function wireWindowEvents() {
  app.on('browser-window-created', (_e, win) => {
    setImmediate(() => {
      const mgr = windows().getTabManager(win);
      if (!mgr || mgr.incognito) return;
      winIds.set(win, mgr.state.id);
      emitToAll('windows.onCreated', (s) => [windowObject(infoOf(s.id), mgr, true)]);
      win.once('closed', () => {
        const id = winIds.get(win);
        if (id !== undefined) emitToAll('windows.onRemoved', () => [id]);
      });
    });
  });
  app.on('browser-window-focus', (_e, win) => {
    const mgr = windows().getTabManager(win);
    if (!mgr || mgr.incognito) return;
    emitToAll('windows.onFocusChanged', () => [mgr.state.id]);
    extensionsMod().scheduleActionPush();
  });
  app.on('browser-window-blur', () => {
    setImmediate(() => {
      if (!BrowserWindow.getFocusedWindow()) emitToAll('windows.onFocusChanged', () => [-1]);
    });
  });
}

// ── webNavigation (only while a listener exists) ──────────────────────────────────

function frameIdOf(frame) {
  if (!frame) return 0;
  if (frame.parent === null) return 0;
  if (!frameIds.has(frame)) frameIds.set(frame, ++frameSeq);
  return frameIds.get(frame);
}

function wireNavigation(tab) {
  const wc = tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed() || navWired.has(wc)) return;
  navWired.add(wc);
  const tabIdNow = () => chromeIdOf(tab);
  const frameDetails = (frame, url) => {
    const parentId = frame.parent ? frameIdOf(frame.parent) : -1;
    return { tabId: tabIdNow(), url, frameId: frameIdOf(frame), parentFrameId: parentId, processId: frame.processId, timeStamp: Date.now() };
  };
  const send = (name, build) => {
    emitToAll(name, (s) => {
      const info = infoOf(s.id);
      const d = build(info);
      return d ? [d] : null;
    });
  };
  wc.on('did-start-navigation', (_e, url, _inPage, isMainFrame, _frameProcessId, _frameRoutingId) => {
    if (!hasListeners('webNavigation.onBeforeNavigate')) return;
    send('webNavigation.onBeforeNavigate', (info) => (canSeeUrl(info, url) ? { ...navDetail(tab, url, isMainFrame), frameId: isMainFrame ? 0 : -1 } : null));
  });
  wc.on('did-navigate', (_e, url) => {
    send('webNavigation.onCommitted', (info) => (canSeeUrl(info, url) ? { ...navDetail(tab, url, true), transitionType: 'link', transitionQualifiers: [] } : null));
  });
  wc.on('dom-ready', () => {
    send('webNavigation.onDOMContentLoaded', (info) => (canSeeUrl(info, wc.getURL()) ? navDetail(tab, wc.getURL(), true) : null));
  });
  wc.on('did-finish-load', () => {
    send('webNavigation.onCompleted', (info) => (canSeeUrl(info, wc.getURL()) ? navDetail(tab, wc.getURL(), true) : null));
  });
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    send('webNavigation.onErrorOccurred', (info) => (canSeeUrl(info, validatedURL) ? { ...navDetail(tab, validatedURL, true), error: errorDescription || 'net::ERR_FAILED' } : null));
  });
  wc.once('destroyed', () => navWired.delete(wc));
}

function navDetail(tab, url, isMain) {
  return { tabId: chromeIdOf(tab), url, frameId: isMain ? 0 : -1, parentFrameId: -1, timeStamp: Date.now() };
}

function wireNavigationAll() {
  for (const { tab } of allTabs()) wireNavigation(tab);
}

function allTabs() {
  const out = [];
  for (const mgr of managers()) for (const tab of mgr.tabs) out.push({ mgr, tab });
  return out;
}

// ── Cookies ────────────────────────────────────────────────────────────────────

function wireCookies() {
  if (cookieWired || !ses) return;
  cookieWired = true;
  ses.cookies.on('changed', (_e, cookie, cause, removed) => {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    const url = `https://${domain}/`;
    emitToAll('cookies.onChanged', (s) => {
      const info = infoOf(s.id);
      if (!info.perms.includes('cookies') || !matchesPatterns(info.hosts, url)) return null;
      return [{ removed: !!removed, cookie: cookieObject(cookie), cause }];
    });
  });
}

function cookieObject(c) {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: !!c.hostOnly,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    session: !!c.session,
    sameSite: c.sameSite || 'unspecified',
    storeId: '0',
  };
  if (!c.session && typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate;
  return out;
}

// ── Synced storage (chrome.storage.sync): one JSON file per extension, quotas as in Chrome ─────────────────

function syncFile(id) {
  return path.join(app.getPath('userData'), 'profile', 'extension-data', id, 'sync.json');
}

// The first call reads the file; calls that arrive meanwhile wait for the same promise.
function loadSync(s) {
  if (!s.syncP) {
    s.syncP = (async () => {
      const holder = { data: {}, bytes: 0, dirty: false, timer: null, chain: Promise.resolve() };
      try {
        const obj = JSON.parse(await fs.promises.readFile(syncFile(s.id), 'utf8'));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) holder.data = obj;
      } catch {
        holder.data = {};
      }
      holder.bytes = bytesOf(holder.data);
      s.sync = holder;
      return holder;
    })();
  }
  return s.syncP;
}

function bytesOf(data) {
  let n = 0;
  for (const [k, v] of Object.entries(data)) n += Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v));
  return n;
}

function saveSync(s) {
  const h = s.sync;
  if (!h || !h.dirty) return Promise.resolve();
  h.dirty = false;
  const file = syncFile(s.id);
  const body = JSON.stringify(h.data);
  h.chain = h.chain
    .then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, body, 'utf8');
      await fs.promises.rename(tmp, file);
    })
    .catch((err) => log('[extension-api] could not save sync storage:', err));
  return h.chain;
}

function markSyncDirty(s) {
  const h = s.sync;
  h.dirty = true;
  if (h.timer) return;
  h.timer = setTimeout(() => {
    h.timer = null;
    saveSync(s);
  }, SYNC_SAVE_MS);
}

function keysOf(keys, data) {
  if (keys === undefined || keys === null) return Object.keys(data);
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys.filter((k) => typeof k === 'string');
  if (typeof keys === 'object') return Object.keys(keys);
  return [];
}

// ── Context menus ────────────────────────────────────────────────────────────

function menuMatches(item, params, url) {
  const ctxs = item.contexts;
  if (!ctxs.includes('all')) {
    const has = (c) => ctxs.includes(c);
    const kinds = [];
    if (params.linkURL) kinds.push('link');
    if (params.selectionText) kinds.push('selection');
    if (params.mediaType === 'image') kinds.push('image');
    if (params.mediaType === 'video') kinds.push('video');
    if (params.mediaType === 'audio') kinds.push('audio');
    if (params.isEditable) kinds.push('editable');
    if (!kinds.length) kinds.push('page');
    if (!kinds.some(has)) return false;
  }
  if (item.documentUrlPatterns.length && !matchesPatterns(item.documentUrlPatterns, url)) return false;
  if (item.targetUrlPatterns.length) {
    const target = params.linkURL || params.srcURL || '';
    if (!matchesPatterns(item.targetUrlPatterns, target)) return false;
  }
  return item.visible !== false;
}

function menuTitle(item, params) {
  const sel = String(params.selectionText || '').slice(0, 40);
  return String(item.title || '').replace(/%s/g, sel);
}

// Electron template for one extension's visible items: one item directly, or a submenu named after the extension.
function menuTemplateFor(s, params, url, webContents) {
  const info = infoOf(s.id);
  const visible = [...s.menus.values()].filter((it) => menuMatches(it, params, url));
  if (!visible.length) return null;
  const build = (parentId) =>
    visible
      .filter((it) => (it.parentId || null) === parentId)
      .map((it) => {
        if (it.type === 'separator') return { type: 'separator' };
        const children = build(it.id);
        const tpl = {
          label: menuTitle(it, params),
          enabled: it.enabled !== false,
          type: it.type === 'checkbox' || it.type === 'radio' ? it.type : 'normal',
        };
        if (tpl.type !== 'normal') tpl.checked = !!it.checked;
        if (children.length) tpl.submenu = children;
        else
          tpl.click = () => {
            const tab = webContents && !webContents.isDestroyed() ? tabs().findTabByWebContentsId(webContents.id) : null;
            const info2 = {
              menuItemId: it.id,
              editable: !!params.isEditable,
              pageUrl: url,
              linkUrl: params.linkURL || undefined,
              srcUrl: params.srcURL || undefined,
              selectionText: params.selectionText || undefined,
              mediaType: params.mediaType || undefined,
              checked: tpl.type !== 'normal' ? !it.checked : undefined,
              wasChecked: tpl.type !== 'normal' ? !!it.checked : undefined,
            };
            if (it.parentId) info2.parentMenuItemId = it.parentId;
            if (tpl.type !== 'normal') it.checked = !it.checked;
            const tabObj = tab ? tabObject(info, tab.manager, tab.tab) : undefined;
            emitTo(s, 'contextMenus.onClicked', [info2, tabObj]);
          };
        return tpl;
      });
  const top = build(null);
  if (!top.length) return null;
  if (top.length === 1 && !top[0].submenu) return top[0];
  return { label: String(info.manifest.name || s.id).slice(0, 60), submenu: top };
}

// Called by menus.js for every page and link context menu.
function contextMenuItems(params, webContents) {
  if (!ses || !params || !webContents || webContents.isDestroyed() || webContents.session !== ses) return []; // never incognito
  const url = webContents && !webContents.isDestroyed() ? webContents.getURL() : '';
  const out = [];
  for (const s of exts.values()) {
    if (!s.menus.size || !ses.extensions.getExtension(s.id)) continue;
    const tpl = menuTemplateFor(s, params, url, webContents);
    if (tpl) out.push(tpl);
  }
  return out;
}

function parseMenuProps(props, existing) {
  const out = existing ? { ...existing } : { type: 'normal', contexts: ['page'], documentUrlPatterns: [], targetUrlPatterns: [], enabled: true, visible: true, checked: false };
  if (props.type !== undefined) {
    if (!['normal', 'checkbox', 'radio', 'separator'].includes(props.type)) throw new Error('Invalid menu item type.');
    out.type = props.type;
  }
  if (props.title !== undefined) out.title = String(props.title).slice(0, 300);
  if (props.contexts !== undefined) {
    const list = (Array.isArray(props.contexts) ? props.contexts : [props.contexts]).filter((c) => MENU_CONTEXTS.has(c));
    out.contexts = list.length ? list : ['page'];
  }
  if (props.documentUrlPatterns !== undefined) out.documentUrlPatterns = (props.documentUrlPatterns || []).slice(0, 50).map(String);
  if (props.targetUrlPatterns !== undefined) out.targetUrlPatterns = (props.targetUrlPatterns || []).slice(0, 50).map(String);
  if (props.enabled !== undefined) out.enabled = !!props.enabled;
  if (props.visible !== undefined) out.visible = !!props.visible;
  if (props.checked !== undefined) out.checked = !!props.checked;
  if (props.parentId !== undefined) out.parentId = props.parentId === null ? null : props.parentId;
  return out;
}

// ── Notifications ────────────────────────────────────────────────────────────

function notificationIcon(ctx, iconUrl) {
  if (typeof iconUrl !== 'string') return undefined;
  const dataUrl = readIconDataUrl(iconFileOf(ctx.id, ctx.info.extDir, iconUrl, ctx.base));
  if (!dataUrl) return undefined;
  const img = nativeImage.createFromDataURL(dataUrl);
  return img.isEmpty() ? undefined : img;
}

function showNotification(ctx, id, opts) {
  if (!opts || typeof opts !== 'object') throw new Error('Missing notification options.');
  if (!Notification.isSupported()) throw new Error('Notifications are not available here.');
  const s = ctx.state;
  const nid = (id || `n${++noteSeq}`).slice(0, 200);
  const old = s.notes.get(nid);
  if (old) {
    s.notes.delete(nid);
    try {
      old.close();
    } catch {
      /* already gone */
    }
  }
  const title = String(opts.title || ctx.info.manifest.name || '').slice(0, 200);
  const body = String(opts.message || '').slice(0, 1000);
  const n = new Notification({ title, body, silent: !!opts.silent, icon: notificationIcon(ctx, opts.iconUrl) });
  s.notes.set(nid, n);
  n.on('click', () => emitTo(s, 'notifications.onClicked', [nid]));
  n.on('close', () => {
    if (s.notes.get(nid) === n) s.notes.delete(nid);
    emitTo(s, 'notifications.onClosed', [nid, true]);
  });
  n.show();
  return nid;
}

// ── Handlers (keys are "api.method"; `api` is the chrome namespace) ─────────────────────

function tabArg(a) {
  if (a === undefined || a === null) return undefined;
  if (typeof a === 'number') return a;
  if (typeof a === 'object' && a.tabId !== undefined) return a.tabId;
  return undefined;
}

function actionTabFor(tabId) {
  if (tabId === undefined || tabId === null) return null;
  return requireTab(tabId).tab;
}

function actionGet(ctx, key, tabId, def) {
  const s = ctx.state;
  const tab = actionTabFor(tabId);
  if (tab) {
    const o = s.actionTabs.get(tab.id);
    if (o && Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  }
  return Object.prototype.hasOwnProperty.call(s.actionGlobal, key) ? s.actionGlobal[key] : def;
}

function activeTabOf(ctx) {
  if (ctx.tabRef) return ctx.tabRef;
  const mgr = ctx.mgr || lastFocusedManager();
  const tab = mgr ? mgr.activeTab() : null;
  return tab ? { mgr, tab } : null;
}

const HANDLERS = {
  // chrome.commands: the manifest's shortcuts are listed; Pure does not bind extension shortcuts.
  'commands.getAll': (ctx) =>
    Object.entries(ctx.info.manifest.commands && typeof ctx.info.manifest.commands === 'object' ? ctx.info.manifest.commands : {})
      .slice(0, 50)
      .map(([name, c]) => ({
        name: String(name).slice(0, 100),
        description: text(c && c.description, 300),
        shortcut: text(c && c.suggested_key && c.suggested_key.default, 50),
      })),

  // Messages to the extension's own worker: start it first (Electron's native send does not start an idle worker).
  'runtime.ensureWorker': async (ctx) => {
    await ensureWorker(ctx.state);
    return true;
  },

  // chrome.action / browserAction
  'action.setTitle':(ctx, d) => setAction(ctx, 'title', actionTargetOf(d), text(d && d.title, 200)),
  'action.getTitle': (ctx, d) => actionGet(ctx, 'title', tabArg(d), ''),
  'action.setIcon': (ctx, d) => {
    const tab = actionTargetOf(d);
    if (!d || typeof d !== 'object') throw new Error('Missing icon details.');
    if (d.imageData !== undefined) {
      const url = dataUrlFromImageData(d.imageData);
      if (!url) throw new Error('Invalid imageData.');
      return setAction(ctx, 'icon', tab, url);
    }
    const rel = pathFromIconSpec(d.path);
    const url = readIconDataUrl(iconFileOf(ctx.id, ctx.info.extDir, rel, ctx.base));
    if (!url) throw new Error('Could not read the icon (PNG, JPEG, GIF or WebP up to 128 KB).');
    return setAction(ctx, 'icon', tab, url);
  },
  'action.setPopup': (ctx, d) => setAction(ctx, 'popup', actionTargetOf(d), popupUrlFor(ctx.id, d && d.popup)),
  'action.getPopup': (ctx, d) => actionGet(ctx, 'popup', tabArg(d), ''),
  'action.setBadgeText': (ctx, d) => setAction(ctx, 'badge', actionTargetOf(d), text(d && d.text, 4)),
  'action.getBadgeText': (ctx, d) => actionGet(ctx, 'badge', tabArg(d), ''),
  'action.setBadgeBackgroundColor': (ctx, d) => setAction(ctx, 'badgeColor', actionTargetOf(d), parseColor(d && d.color)),
  'action.getBadgeBackgroundColor': (ctx, d) => actionGet(ctx, 'badgeColor', tabArg(d), [0x46, 0x88, 0xf1, 255]),
  'action.setBadgeTextColor': (ctx, d) => setAction(ctx, 'badgeTextColor', actionTargetOf(d), parseColor(d && d.color)),
  'action.getBadgeTextColor': (ctx, d) => actionGet(ctx, 'badgeTextColor', tabArg(d), [255, 255, 255, 255]),
  'action.enable': (ctx, t) => setAction(ctx, 'enabled', actionTabFor(tabArg(t)), true),
  'action.disable': (ctx, t) => setAction(ctx, 'enabled', actionTabFor(tabArg(t)), false),
  'action.isEnabled': (ctx, t) => actionGet(ctx, 'enabled', tabArg(t), true) !== false,
  'action.getUserSettings': () => ({ isOnToolbar: true }),
  'action.openPopup': () => {
    throw new Error('chrome.action.openPopup is not supported in Pure yet.');
  },

  // chrome.tabs (Pure tabs)
  'tabs.query': (ctx, q) => {
    const query = q && typeof q === 'object' ? q : {};
    const info = ctx.info;
    const cur = ctx.mgr || lastFocusedManager();
    const last = lastFocusedManager();
    const out = [];
    for (const mgr of managers()) {
      for (const tab of mgr.tabs) {
        if (query.windowId !== undefined && query.windowId !== -2 && mgr.state.id !== query.windowId) continue;
        if ((query.windowId === -2 || query.currentWindow === true) && mgr !== cur) continue;
        if (query.lastFocusedWindow === true && mgr !== last) continue;
        const active = mgr.activeId === tab.id;
        if (query.active !== undefined && !!query.active !== active) continue;
        if (query.highlighted !== undefined && !!query.highlighted !== active) continue;
        if (query.pinned !== undefined && !!query.pinned !== !!tab.pinned) continue;
        if (query.audible !== undefined && !!query.audible !== !!tab.isAudible) continue;
        if (query.muted !== undefined && !!query.muted !== !!tab.isMuted) continue;
        if (query.discarded !== undefined && !!query.discarded !== !(tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed())) continue;
        if (query.status !== undefined && query.status !== (tab.isLoading ? 'loading' : 'complete')) continue;
        if (query.index !== undefined && mgr.indexOf(tab) !== query.index) continue;
        if (query.groupId !== undefined && query.groupId !== groupNum(tab.groupId)) continue;
        if (query.windowType !== undefined && query.windowType !== 'normal') continue;
        if (query.title !== undefined && (!canSeeUrl(info, tab.url) || !globMatch(query.title, tab.title || ''))) continue;
        if (query.url !== undefined) {
          const pats = Array.isArray(query.url) ? query.url : [query.url];
          if (!canSeeUrl(info, tab.url) || !matchesPatterns(pats.map(String), tab.url)) continue;
        }
        out.push(tabObject(info, mgr, tab));
      }
    }
    return out;
  },
  'tabs.get': (ctx, id) => {
    const f = requireTab(id);
    return tabObject(ctx.info, f.mgr, f.tab);
  },
  'tabs.getCurrent': (ctx) => (ctx.tabRef ? tabObject(ctx.info, ctx.tabRef.mgr, ctx.tabRef.tab) : undefined),
  'tabs.create': (ctx, props) => {
    const p = props && typeof props === 'object' ? props : {};
    let url = null;
    if (p.url !== undefined) url = tabUrlFor(ctx, p.url);
    let mgr = null;
    if (p.windowId !== undefined) {
      mgr = managerById(p.windowId);
      if (!mgr) throw new Error(`No window with id: ${p.windowId}.`);
    }
    mgr = mgr || ctx.mgr || lastFocusedManager();
    if (!mgr) {
      const win = windows().createWindow({ urls: url ? [url] : [] });
      mgr = windows().getTabManager(win);
      const tab = mgr.tabs[mgr.tabs.length - 1];
      return tabObject(ctx.info, mgr, tab);
    }
    const tab = mgr.createTab({ url: url || undefined, active: p.active !== false, index: Number.isInteger(p.index) ? p.index : undefined, user: true });
    if (!tab || !tab.id) throw new Error('Could not open the tab.');
    return tabObject(ctx.info, mgr, tab);
  },
  'tabs.update': (ctx, a, b) => {
    const hasId = b !== undefined || (typeof a !== 'object' || a === null);
    const id = hasId ? a : null;
    const p = (hasId ? b : a) || {};
    const f = id === null || id === undefined ? activeTabOf(ctx) : requireTab(id);
    if (!f) throw new Error('No active tab.');
    if (p.url !== undefined) f.mgr.navigate(f.tab.id, tabUrlFor(ctx, p.url));
    if (p.pinned !== undefined && typeof f.mgr.setPinned === 'function') f.mgr.setPinned(f.tab.id, !!p.pinned);
    if (p.active === true) f.mgr.activate(f.tab.id, { focus: true });
    if (p.muted !== undefined && !!p.muted !== !!f.tab.isMuted) f.mgr.toggleMute(f.tab.id);
    return tabObject(ctx.info, f.mgr, f.tab);
  },
  'tabs.remove': (ctx, ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      const f = findTab(id);
      if (f) f.mgr.closeTab(f.tab.id);
    }
    return null;
  },
  'tabs.duplicate': (ctx, id) => {
    const f = requireTab(id);
    const tab = f.mgr.createTab({ url: f.tab.url, active: true, user: true, after: f.tab });
    if (!tab || !tab.id) throw new Error('Could not duplicate the tab.');
    return tabObject(ctx.info, f.mgr, tab);
  },
  'tabs.reload': (ctx, a, b) => {
    const hasId = typeof a === 'number';
    const f = hasId ? requireTab(a) : activeTabOf(ctx);
    if (f) f.mgr.reload(f.tab.id, !!(b && b.bypassCache));
    return null;
  },
  'tabs.move': (ctx, ids, info) => {
    const list = Array.isArray(ids) ? ids : [ids];
    const out = [];
    for (const id of list) {
      const f = requireTab(id);
      const index = info && Number.isInteger(info.index) && info.index >= 0 ? info.index : f.mgr.tabs.length - 1;
      f.mgr.move(f.tab.id, index);
      out.push(tabObject(ctx.info, f.mgr, f.tab));
    }
    return Array.isArray(ids) ? out : out[0];
  },
  'tabs.discard': (ctx, id) => {
    const f = id === undefined || id === null ? activeTabOf(ctx) : requireTab(id);
    if (!f) throw new Error('No tab to discard.');
    if (!tabs().discardTab(f.mgr, f.tab.id)) throw new Error('This tab cannot be discarded now.');
    return tabObject(ctx.info, f.mgr, f.tab);
  },
  'tabs.goBack': (ctx, id) => {
    const f = id === undefined || id === null ? activeTabOf(ctx) : requireTab(id);
    if (f) f.mgr.back(f.tab.id);
    return null;
  },
  'tabs.goForward': (ctx, id) => {
    const f = id === undefined || id === null ? activeTabOf(ctx) : requireTab(id);
    if (f) f.mgr.forward(f.tab.id);
    return null;
  },

  // chrome.windows
  'windows.get': (ctx, id, info) => {
    const mgr = managerById(id);
    if (!mgr) throw new Error(`No window with id: ${id}.`);
    return windowObject(ctx.info, mgr, !!(info && info.populate));
  },
  'windows.getCurrent': (ctx, info) => {
    const mgr = ctx.mgr || lastFocusedManager();
    return mgr ? windowObject(ctx.info, mgr, !!(info && info.populate)) : undefined;
  },
  'windows.getLastFocused': (ctx, info) => {
    const mgr = lastFocusedManager();
    return mgr ? windowObject(ctx.info, mgr, !!(info && info.populate)) : undefined;
  },
  'windows.getAll': (ctx, info) => managers().map((mgr) => windowObject(ctx.info, mgr, !!(info && info.populate))),
  'windows.create': (ctx, d) => {
    const o = d && typeof d === 'object' ? d : {};
    if (o.incognito) throw new Error('Incognito windows are not available to extensions.');
    const list = (Array.isArray(o.url) ? o.url : o.url !== undefined ? [o.url] : []).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 20);
    const opts = { urls: list };
    if (Number.isFinite(o.left) && Number.isFinite(o.top)) opts.bounds = { x: Math.round(o.left), y: Math.round(o.top) };
    const win = windows().createWindow(opts);
    const mgr = windows().getTabManager(win);
    if (o.focused === false) win.blur?.();
    return windowObject(ctx.info, mgr, false);
  },
  'windows.update': (ctx, id, info) => {
    const mgr = managerById(id);
    if (!mgr) throw new Error(`No window with id: ${id}.`);
    const win = mgr.win;
    const o = info && typeof info === 'object' ? info : {};
    if (o.state === 'minimized') win.minimize();
    else if (o.state === 'maximized') win.maximize();
    else if (o.state === 'normal') win.restore();
    if (Number.isFinite(o.left) || Number.isFinite(o.top) || Number.isFinite(o.width) || Number.isFinite(o.height)) {
      const b = win.getBounds();
      win.setBounds({
        x: Number.isFinite(o.left) ? Math.round(o.left) : b.x,
        y: Number.isFinite(o.top) ? Math.round(o.top) : b.y,
        width: Number.isFinite(o.width) ? Math.round(o.width) : b.width,
        height: Number.isFinite(o.height) ? Math.round(o.height) : b.height,
      });
    }
    if (o.focused) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    return windowObject(ctx.info, mgr, !!o.populate);
  },
  'windows.remove': (ctx, id) => {
    const mgr = managerById(id);
    if (!mgr) throw new Error(`No window with id: ${id}.`);
    mgr.win.close();
    return null;
  },

  // chrome.contextMenus (+ menus)
  'contextMenus.create': (ctx, props) => {
    const p = props && typeof props === 'object' ? props : {};
    const id = p.id !== undefined ? String(p.id).slice(0, 200) : `m${++menuSeq}`;
    if (ctx.state.menus.has(id)) throw new Error(`Cannot create item with duplicate id ${id}`);
    const item = parseMenuProps({ ...p, id }, null);
    item.id = id;
    if (p.parentId !== undefined && p.parentId !== null && !ctx.state.menus.has(String(p.parentId))) throw new Error(`Cannot find menu item with id ${p.parentId}`);
    item.parentId = p.parentId === undefined || p.parentId === null ? null : String(p.parentId);
    ctx.state.menus.set(id, item);
    return id;
  },
  'contextMenus.update': (ctx, id, props) => {
    const key = String(id);
    const item = ctx.state.menus.get(key);
    if (!item) throw new Error(`Cannot find menu item with id ${key}`);
    ctx.state.menus.set(key, parseMenuProps(props || {}, item));
    return null;
  },
  'contextMenus.remove': (ctx, id) => {
    const key = String(id);
    if (!ctx.state.menus.has(key)) throw new Error(`Cannot find menu item with id ${key}`);
    removeMenu(ctx.state, key);
    return null;
  },
  'contextMenus.removeAll': (ctx) => {
    ctx.state.menus.clear();
    return null;
  },

  // chrome.notifications
  'notifications.create': (ctx, a, b) => {
    const id = typeof a === 'string' ? a : '';
    return showNotification(ctx, id, typeof a === 'string' ? b : a);
  },
  'notifications.update': (ctx, id, opts) => {
    if (!ctx.state.notes.has(String(id))) return false;
    showNotification(ctx, String(id), opts);
    return true;
  },
  'notifications.clear': (ctx, id) => {
    const n = ctx.state.notes.get(String(id));
    if (!n) return false;
    ctx.state.notes.delete(String(id));
    n.close();
    return true;
  },
  'notifications.getAll': (ctx) => {
    const out = {};
    for (const id of ctx.state.notes.keys()) out[id] = true;
    return out;
  },
  'notifications.getPermissionLevel': () => (Notification.isSupported() ? 'granted' : 'denied'),

  // chrome.cookies (host permission from the manifest)
  'cookies.get': async (ctx, d) => {
    const o = d || {};
    requireHost(ctx.info, o.url);
    const list = await ses.cookies.get({ url: o.url, name: o.name });
    return list.length ? cookieObject(list[0]) : null;
  },
  'cookies.getAll': async (ctx, d) => {
    const o = d || {};
    const filter = {};
    if (o.url !== undefined) {
      requireHost(ctx.info, o.url);
      filter.url = o.url;
    }
    if (o.name !== undefined) filter.name = o.name;
    if (o.domain !== undefined) filter.domain = o.domain;
    if (o.path !== undefined) filter.path = o.path;
    if (o.secure !== undefined) filter.secure = !!o.secure;
    if (o.session !== undefined) filter.session = !!o.session;
    if (o.url === undefined && o.domain === undefined) throw new Error('cookies.getAll needs a url or domain.');
    const list = await ses.cookies.get(filter);
    return list.filter((c) => matchesPatterns(ctx.info.hosts, `https://${String(c.domain).replace(/^\./, '')}/`)).map(cookieObject);
  },
  'cookies.set': async (ctx, d) => {
    const o = d || {};
    requireHost(ctx.info, o.url);
    const details = { url: o.url, name: o.name || '', value: o.value || '', path: o.path || '/', secure: !!o.secure, httpOnly: !!o.httpOnly };
    if (o.domain) details.domain = o.domain;
    if (Number.isFinite(o.expirationDate)) details.expirationDate = o.expirationDate;
    if (o.sameSite && ['unspecified', 'no_restriction', 'lax', 'strict'].includes(o.sameSite)) details.sameSite = o.sameSite;
    await ses.cookies.set(details);
    const list = await ses.cookies.get({ url: o.url, name: details.name });
    return list.length ? cookieObject(list[0]) : null;
  },
  'cookies.remove': async (ctx, d) => {
    const o = d || {};
    requireHost(ctx.info, o.url);
    await ses.cookies.remove(o.url, o.name);
    return { url: o.url, name: o.name, storeId: '0' };
  },
  'cookies.getAllCookieStores': () => [{ id: '0', tabIds: [] }],

  // chrome.webNavigation (read-only details; events are wired while listened to)
  'webNavigation.getAllFrames': (ctx, d) => {
    const f = requireTab(d && d.tabId);
    const wc = f.tab.view && f.tab.view.webContents;
    if (!wc || wc.isDestroyed()) return [];
    const info = ctx.info;
    const url = wc.getURL();
    if (!canSeeUrl(info, url)) return [];
    return wc.mainFrame.framesInSubtree.map((fr) => ({
      frameId: frameIdOf(fr),
      parentFrameId: fr.parent ? frameIdOf(fr.parent) : -1,
      url: fr.url,
      tabId: chromeIdOf(f.tab),
      processId: fr.processId,
      documentId: undefined,
    }));
  },
  'webNavigation.getFrame': (ctx, d) => {
    const o = d || {};
    const all = HANDLERS['webNavigation.getAllFrames'](ctx, { tabId: o.tabId });
    const hit = all.find((x) => x.frameId === (o.frameId || 0));
    if (!hit) throw new Error('No frame with id ' + o.frameId + ' in tab ' + o.tabId + '.');
    return hit;
  },

  // chrome.storage.sync
  'storageSync.get': async (ctx, keys) => {
    const h = await loadSync(ctx.state);
    const out = {};
    for (const k of keysOf(keys, h.data)) {
      if (Object.prototype.hasOwnProperty.call(h.data, k)) out[k] = h.data[k];
      else if (keys && typeof keys === 'object' && !Array.isArray(keys) && Object.prototype.hasOwnProperty.call(keys, k)) out[k] = keys[k];
    }
    return out;
  },
  'storageSync.set': async (ctx, items) => {
    if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('Invalid items.');
    const s = ctx.state;
    const h = await loadSync(s);
    const next = { ...h.data };
    for (const [k, v] of Object.entries(items)) {
      if (k.length > 512) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      if (JSON.stringify(v) === undefined) throw new Error('Value is not serialisable.');
      if (Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v)) > SYNC_ITEM_BYTES) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      next[k] = JSON.parse(JSON.stringify(v));
    }
    if (Object.keys(next).length > SYNC_MAX_ITEMS) throw new Error('MAX_ITEMS quota exceeded');
    if (bytesOf(next) > SYNC_QUOTA_BYTES) throw new Error('QUOTA_BYTES quota exceeded');
    const changes = {};
    for (const k of Object.keys(items)) {
      const oldValue = h.data[k];
      changes[k] = oldValue === undefined ? { newValue: next[k] } : { oldValue, newValue: next[k] };
    }
    h.data = next;
    h.bytes = bytesOf(next);
    markSyncDirty(s);
    emitTo(s, 'storage.onChanged', [changes, 'sync']);
    return null;
  },
  'storageSync.remove': async (ctx, keys) => {
    const s = ctx.state;
    const h = await loadSync(s);
    const changes = {};
    const next = { ...h.data };
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(next, k)) continue;
      changes[k] = { oldValue: next[k] };
      delete next[k];
    }
    h.data = next;
    h.bytes = bytesOf(next);
    if (Object.keys(changes).length) {
      markSyncDirty(s);
      emitTo(s, 'storage.onChanged', [changes, 'sync']);
    }
    return null;
  },
  'storageSync.clear': async (ctx) => {
    const s = ctx.state;
    const h = await loadSync(s);
    const changes = {};
    for (const [k, v] of Object.entries(h.data)) changes[k] = { oldValue: v };
    h.data = {};
    h.bytes = 0;
    if (Object.keys(changes).length) {
      markSyncDirty(s);
      emitTo(s, 'storage.onChanged', [changes, 'sync']);
    }
    return null;
  },
  // chrome.alarms: one timer per alarm in the main process. Fires as an event (queued if the worker is stopped).
  'alarms.create': (ctx, a, b) => {
    const name = typeof a === 'string' ? a : '';
    const info = (typeof a === 'string' ? b : a) || {};
    const s = ctx.state;
    let delayMs = null;
    if (Number.isFinite(info.when)) delayMs = Math.max(0, info.when - Date.now());
    else if (Number.isFinite(info.delayInMinutes)) delayMs = info.delayInMinutes * 60000;
    const period = Number.isFinite(info.periodInMinutes) ? info.periodInMinutes * 60000 : null;
    if (delayMs === null && period === null) throw new Error('Alarm needs a when, delayInMinutes or periodInMinutes.');
    const old = s.alarms.get(name);
    if (old) clearTimeout(old.timer);
    const wait = Math.max(ALARM_MIN_MS, delayMs === null ? period : delayMs);
    const alarm = { name, scheduledTime: Date.now() + wait, periodInMinutes: period === null ? undefined : period / 60000, timer: null };
    const fire = () => {
      const cur = s.alarms.get(name);
      if (cur !== alarm) return;
      const out = { name, scheduledTime: alarm.scheduledTime };
      if (alarm.periodInMinutes !== undefined) {
        alarm.scheduledTime = Date.now() + Math.max(ALARM_MIN_MS, alarm.periodInMinutes * 60000);
        alarm.timer = setTimeout(fire, alarm.scheduledTime - Date.now());
        alarm.timer.unref?.();
      } else {
        s.alarms.delete(name);
      }
      emitTo(s, 'alarms.onAlarm', [out]);
    };
    alarm.timer = setTimeout(fire, wait);
    alarm.timer.unref?.();
    s.alarms.set(name, alarm);
    return null;
  },
  'alarms.get': (ctx, name) => {
    const a = ctx.state.alarms.get(typeof name === 'string' ? name : '');
    return a ? alarmView(a) : undefined;
  },
  'alarms.getAll': (ctx) => [...ctx.state.alarms.values()].map(alarmView),
  'alarms.clear': (ctx, name) => {
    const key = typeof name === 'string' ? name : '';
    const a = ctx.state.alarms.get(key);
    if (!a) return false;
    clearTimeout(a.timer);
    ctx.state.alarms.delete(key);
    return true;
  },
  'alarms.clearAll': (ctx) => {
    const any = ctx.state.alarms.size > 0;
    for (const a of ctx.state.alarms.values()) clearTimeout(a.timer);
    ctx.state.alarms.clear();
    return any;
  },

  'storageSync.getBytesInUse': async (ctx, keys) => {
    const h = await loadSync(ctx.state);
    const picked = {};
    for (const k of keysOf(keys, h.data)) if (Object.prototype.hasOwnProperty.call(h.data, k)) picked[k] = h.data[k];
    return bytesOf(picked);
  },
};

function alarmView(a) {
  const out = { name: a.name, scheduledTime: a.scheduledTime };
  if (a.periodInMinutes !== undefined) out.periodInMinutes = a.periodInMinutes;
  return out;
}

function actionTargetOf(d) {
  const raw = d && typeof d === 'object' ? d.tabId : undefined;
  return raw === undefined || raw === null ? null : requireTab(raw).tab;
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function removeMenu(s, id) {
  s.menus.delete(id);
  for (const [k, it] of [...s.menus]) if (it.parentId === id) removeMenu(s, k);
}

// ── Setup and teardown ───────────────────────────────────────────────────────

// Called by extensions.js before the first extension is loaded. Idempotent. Nothing runs before this.
function ensure(sessionObj) {
  if (ses) return;
  ses = sessionObj;
  for (const [kind, id] of Object.entries(PRELOAD_IDS)) {
    try {
      ses.registerPreloadScript({ id, type: kind === 'frame' ? 'frame' : 'service-worker', filePath: PRELOAD });
    } catch (err) {
      log('[extension-api] preload registration failed:', err && err.message);
    }
  }
  wireIpc(ses);
  wireTabEvents();
  wireWindowEvents();
  ses.extensions.on('extension-unloaded', (_e, ext) => forget(ext && ext.id));
}

// Drops everything for an extension that was unloaded or removed (menus, action values, listeners, notifications).
function forget(id) {
  if (!id) return;
  const s = exts.get(id);
  if (!s) return;
  for (const n of s.notes.values()) {
    try {
      n.close();
    } catch {
      /* already closed */
    }
  }
  for (const a of s.alarms.values()) clearTimeout(a.timer);
  s.alarms.clear();
  if (s.sync && s.sync.timer) clearTimeout(s.sync.timer);
  saveSync(s);
  exts.delete(id);
}

function flush() {
  const jobs = [];
  for (const s of exts.values()) jobs.push(saveSync(s));
  return Promise.all(jobs).then(() => undefined);
}

// IPC channels are registered by ensure() when the first extension loads, not at startup.
module.exports = {
  ensure,
  forget,
  flush,
  contextMenuItems,
  effectiveAction,
  actionsChanged,
  fireActionClicked(extId, pureTabId) {
    const s = exts.get(extId);
    if (!s || (!s.subs.has('action.onClicked') && !s.swNames.has('action.onClicked'))) return false;
    const f = findPureTab(pureTabId);
    if (!f) return false;
    emitTo(s, 'action.onClicked', [tabObject(infoOf(extId), f.mgr, f.tab)]);
    return true;
  },
  hasActionListener(extId) {
    const s = exts.get(extId);
    return !!s && (s.subs.has('action.onClicked') || s.swNames.has('action.onClicked'));
  },
  unsupportedCalls(extId) {
    const s = exts.get(extId);
    return s ? [...s.unsupported] : [];
  },
};
