// Tabs: one TabManager per browser window. Every tab is a WebContentsView that exists only while
// the tab is active or has been loaded and not yet discarded. Owns tabs:* IPC, navigation guards,
// popups, error/crash pages, history recording, discarding, the closed-tab stack and zoom.
// windows.js and shortcuts.js are required here in circular fashion: they are only read at call time,
// and this file never reassigns module.exports.

const os = require('os');
const path = require('path');
const { BrowserWindow, WebContentsView, dialog, shell } = require('electron');
const storage = require('./storage');
const logger = require('./logger');
const menus = require('./menus');
const security = require('./security');
const shortcuts = require('./shortcuts');
const windows = require('./windows');
const dragPreview = require('./drag-preview'); // 2.5 — F3: window that follows a tab dragged out of the strip

const INTERNAL_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const HOME_URL = 'pure://home/';
const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const CLOSED_LIMIT = 25;
const FOCUS_RETAKE_MS = [60, 250, 800]; // 2.5 — F3: when a new tab's page takes the keyboard focus back, checks at these times
const FLUSH_MS = 50;
const SWEEP_MS = 60 * 1000;
const FAVICON_MAX = 100000;
const SETTINGS_SECTIONS = new Set([
  'homepage', 'appearance', 'search', 'privacy', 'downloads', 'shortcuts', 'history', 'about',
  // 2.2 / 2.3 / 2.4 sections
  'sites', 'passwords', 'performance', 'extensions', 'import',
]);
// 2.1 smart sleep / Lite mode
const LITE_DELAY_MIN = 3;            // Lite mode discard delay, replaces tabDiscardMinutes
const LOW_MEMORY_ON = 0.15;          // free RAM fraction that starts an emergency sleep pass
const LOW_MEMORY_OFF = 0.20;         // ... which stops once free RAM is above this
const LOW_MEMORY_MAX = 3;            // max tabs slept per sweep tick
const REDUCED_MOTION_PROTOCOL = '1.3';
// 2.2 tab groups / split view / mute others
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const GROUP_TITLE_MAX = 60;
const SPLIT_GAP = 6;                 // px between the two panes (the UI draws #split-divider there)
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
const SPLIT_DEFAULT = 0.5;

let nextTabId = 1;
let nextGroupSeq = 1;
const managers = new Set();
// 2.4 (manager hook, keep): every 'tabs:*' UI event is also emitted here as (manager, ...args), so main modules
// (main/extension-api.js: chrome.tabs events) can follow tabs without polling.
const tabEvents = new (require('events').EventEmitter)();
tabEvents.setMaxListeners(20);
let sweepTimer = null;
let externalDialogOpen = false;
let onBattery = false;               // kept current by powerMonitor events (no polling)
let powerWired = false;
let liteOn = false;                  // last applied settings.liteMode
let policyWired = false;
let lastPolicyKey = '';

function log(...args) {
  try { logger.log(...args); } catch { /* logging must never break a tab */ }
}

function settingsSafe() {
  try { return storage.settings.get() || {}; } catch (e) { log('settings read failed:', e && e.message); return {}; }
}

function safeCall(fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => log('storage call failed:', e && e.message));
  } catch (e) {
    log('storage call failed:', e && e.message);
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const isSettingsUrl = (u) => typeof u === 'string' && u.startsWith('pure://settings/');
const isId = (v) => Number.isInteger(v) && v > 0;
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const isGroupId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 40;
const newGroupId = () => 'g' + nextGroupSeq++;
const cleanGroupTitle = (v) => (typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, GROUP_TITLE_MAX)
  : '');

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function homepageUrl() {
  const h = settingsSafe().homepage;
  const ok = typeof h === 'string' && (isHttpUrl(h) || h.startsWith('pure://')) && security.isSafeNavigationUrl(h);
  return ok ? h : HOME_URL;
}

// 2.5 — F3: a blank new tab shows the home page (pure://home/ or the homepage setting). Such a tab takes the caret.
function isBlankTabUrl(url) {
  return typeof url === 'string' && (url.startsWith('pure://home') || url === homepageUrl());
}

// Web-triggered URLs (popups, context menu, redirects) may only be http(s) or internal pure://.
// User-triggered URLs (address bar, UI IPC) may use any navigation scheme the security module allows.
// 2.4: main/privacy.js (E3) decides what happens when an upgraded https load fails.
// -> { load: httpUrl } | { error: code, desc } | null
function httpsFallback(m, tab, errorCode, url) {
  try {
    const privacy = require('./privacy');
    if (!privacy || typeof privacy.onMainFrameFail !== 'function') return null;
    return privacy.onMainFrameFail({ webContents: tab.view.webContents, url, errorCode, incognito: !!m.incognito });
  } catch {
    return null;
  }
}

function safeUrl(raw, user) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  if (!security.isSafeNavigationUrl(raw)) return null;
  if (user) return raw;
  return isHttpUrl(raw) || raw.startsWith('pure://') || raw === 'about:blank' ? raw : null;
}

// A chrome-extension:// page of a loaded extension, allowed in normal (never incognito) tabs. -> url | null
function extensionPageUrl(raw, incognito) {
  if (incognito || typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('chrome-extension://')) return null;
  const u = security.parseUrl(raw);
  if (!u || u.protocol !== 'chrome-extension:') return null;
  try {
    return require('./extensions').isLoadedExtension(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function searchUrl(text) {
  const prefix = settingsSafe().searchEngine;
  const base = typeof prefix === 'string' && isHttpUrl(prefix) ? prefix : DEFAULT_SEARCH;
  return base + encodeURIComponent(text);
}

function computeSecurity(url) {
  if (!url) return 'internal';
  if (url.startsWith('pure://') || url.startsWith('chrome-extension://')) return 'internal';
  const u = security.parseUrl(url);
  if (!u) return 'insecure';
  if (u.protocol === 'https:') return 'secure';
  if (u.protocol === 'about:') return 'internal';
  return 'insecure';
}

function settingsSection(url) {
  const hash = url.indexOf('#');
  const sec = hash < 0 ? '' : url.slice(hash + 1);
  return SETTINGS_SECTIONS.has(sec) ? sec : '';
}

function safeZoom(wc) {
  try { return wc.getZoomFactor(); } catch { return 1; }
}

// Decides what a navigation from the page `current` to `target` may do.
// Returns 'allow' | 'block' | 'external' (external = ask the user, then hand to the OS).
function navPolicy(current, target, mainFrame) {
  const u = security.parseUrl(target);
  if (!u) return 'block';
  const fromInternal = typeof current === 'string' && current.startsWith('pure://');
  switch (u.protocol) {
    case 'http:':
    case 'https:':
      return 'allow';
    case 'pure:':
      return fromInternal ? 'allow' : 'block';
    case 'about:':
      return target === 'about:blank' ? 'allow' : 'block';
    case 'blob:':
    case 'data:':
      return mainFrame ? 'block' : 'allow';
    case 'chrome-extension:':
      // Only within the same extension (its own pages linking to each other); Chromium also enforces
      // web_accessible_resources for subframes of web pages.
      if (!mainFrame) return 'allow';
      return typeof current === 'string' && current.startsWith(`chrome-extension://${u.hostname}/`) ? 'allow' : 'block';
    default:
      if (security.isSafeExternalUrl(target)) return mainFrame ? 'external' : 'block';
      return 'block';
  }
}

function applyNavPolicy(wc, ctx, details, mainFrame, mayPrompt) {
  const url = details.url;
  let current = '';
  try { current = wc.getURL(); } catch { /* destroyed */ }
  const policy = navPolicy(current, url, mainFrame);
  if (policy === 'allow') return;
  details.preventDefault();
  if (policy === 'external' && mayPrompt) confirmExternal(ctx.getWin(), url);
}

async function confirmExternal(win, url) {
  if (externalDialogOpen || !security.isSafeExternalUrl(url)) return;
  externalDialogOpen = true;
  try {
    const opts = {
      type: 'question',
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Pure Browser',
      message: 'Open this link in another app?',
      detail: url,
    };
    const owner = win && !win.isDestroyed() ? win : null;
    const r = owner ? await dialog.showMessageBox(owner, opts) : await dialog.showMessageBox(opts);
    if (r.response === 0 && security.isSafeExternalUrl(url)) await shell.openExternal(url);
  } catch (e) {
    log('external open failed:', e && e.message);
  } finally {
    externalDialogOpen = false;
  }
}

function parseFeatures(features) {
  const out = {};
  for (const part of features.split(',')) {
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (key) out[key] = eq < 0 ? '' : part.slice(eq + 1).trim();
  }
  return out;
}

// Real popup windows (OAuth / sign-in) keep window.opener, so they are Electron child windows with
// the opener's session, sandboxed, and the normal window frame.
function popupOptions(features, wc) {
  const f = parseFeatures(features);
  const num = (v) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? Math.round(n) : null;
  };
  const width = clamp(num(f.width) ?? 500, 320, 2560);
  const height = clamp(num(f.height) ?? 700, 320, 1600);
  const opts = {
    width,
    height,
    autoHideMenuBar: true,
    webPreferences: {
      session: wc.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  };
  const left = num(f.left !== undefined ? f.left : f.screenx);
  const top = num(f.top !== undefined ? f.top : f.screeny);
  if (left !== null) opts.x = left;
  if (top !== null) opts.y = top;
  return opts;
}

function pageActions(ctx, wc) {
  return {
    openInNewTab: (url) => {
      if (!isHttpUrl(url)) return;
      const m = ctx.getManager();
      if (m) m.createTab({ url, active: false, after: ctx.tab });
      else windows.openUrl(url, { newWindow: false });
    },
    openInNewWindow: (url) => {
      if (isHttpUrl(url)) windows.createWindow({ urls: [url] });
    },
    openInIncognito: (url) => {
      if (isHttpUrl(url)) windows.createWindow({ incognito: true, urls: [url] });
    },
    searchFor: (text) => {
      const m = ctx.getManager();
      if (!m || typeof text !== 'string' || !text.trim()) return;
      m.createTab({ url: searchUrl(text.trim().slice(0, 500)), active: true, user: false });
    },
    bookmarkPage: () => {
      const win = ctx.getWin();
      if (win && windows.getState(win)) win.webContents.send('ui:command', 'toggle-bookmark', null);
    },
    inspect: (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || wc.isDestroyed()) return;
      if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
      wc.inspectElement(Math.round(x), Math.round(y));
    },
    saveImageAs: (src) => {
      if (isHttpUrl(src) && !wc.isDestroyed()) wc.downloadURL(src);
    },
  };
}

function handleWindowOpen(ctx, wc, details) {
  const deny = { action: 'deny' };
  const url = typeof details.url === 'string' ? details.url : '';
  const features = typeof details.features === 'string' ? details.features : '';
  const disp = details.disposition;
  const wantsPopup = features.length > 0 && (disp === 'new-window' || disp === 'default' || disp === 'other');
  if (wantsPopup) {
    if (isHttpUrl(url) || url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: popupOptions(features, wc) };
    }
    return deny;
  }
  if (!isHttpUrl(url)) return deny;
  if (disp === 'new-window') {
    windows.openUrl(url, { newWindow: true });
    return deny;
  }
  const m = ctx.getManager();
  const active = disp !== 'background-tab';
  if (m) m.createTab({ url, active, after: ctx.tab });
  else windows.openUrl(url, { newWindow: false });
  return deny;
}

function wirePopup(child, parent) {
  const ctx = {
    getWin: () => child,
    getManager: () => parent.getManager(),
    resolve: () => ({ win: child, tabs: null }),
    tab: parent.tab,
    onPopup: null,
  };
  guardWebContents(child.webContents, ctx, () => {});
}

// Hardens any web-content webContents (tab views and popup windows) with the same rules.
function guardWebContents(wc, ctx, track) {
  const on = (ev, fn) => {
    wc.on(ev, fn);
    track(() => wc.removeListener(ev, fn));
  };
  on('will-navigate', (details) => {
    if (!details || details.isSameDocument) return;
    applyNavPolicy(wc, ctx, details, true, true);
  });
  on('will-redirect', (details) => {
    if (!details) return;
    applyNavPolicy(wc, ctx, details, details.isMainFrame !== false, false);
  });
  on('will-frame-navigate', (details) => {
    if (!details || details.isMainFrame || details.isSameDocument) return;
    applyNavPolicy(wc, ctx, details, false, false);
  });
  on('will-prevent-unload', (event) => event.preventDefault());
  on('context-menu', (_event, params) => {
    const win = ctx.getWin();
    if (!win || win.isDestroyed()) return;
    menus.showPageContextMenu({ win, webContents: wc, params, actions: pageActions(ctx, wc) });
  });
  on('did-create-window', (child) => {
    if (ctx.onPopup) ctx.onPopup(child);
    wirePopup(child, ctx);
  });
  wc.setWindowOpenHandler((details) => handleWindowOpen(ctx, wc, details));
  track(shortcuts.attach(wc, ctx.resolve));
}

function makeTab(opts) {
  const url = opts.url;
  const entries = Array.isArray(opts.entries) && opts.entries.length ? opts.entries : null;
  return {
    id: nextTabId++,
    owner: null,
    url,
    title: opts.title || (url === HOME_URL ? 'Home' : ''),
    favicon: '',
    view: null,
    entries,
    entryIndex: Number.isInteger(opts.entryIndex) ? opts.entryIndex : 0,
    isLoading: false,
    crashed: false,
    showingError: false,
    isAudible: false,
    isMuted: false,
    lastActiveAt: Date.now(),
    zoom: 1,
    security: computeSecurity(url),
    canGoBack: false,
    canGoForward: false,
    groupId: null,      // id of the tab's group in its window (groups are contiguous in the strip)
    pinned: !!opts.pinned, // 2.4: pinned tabs sit first in the strip, icon-only, never in a group or split
    popups: 0,
    liteEmu: false,     // this tab holds our debugger session for reduced-motion emulation (Lite mode)
    dbgWc: null,        // webContents the detach listener was attached to
    disposers: [],
  };
}

class TabManager {
  constructor(win, state) {
    this.win = win;
    this.state = state; // window state from windows.js: { id, incognito, session, bounds, frozen, htmlFullscreen }
    this.incognito = !!state.incognito;
    this.tabs = [];
    this.activeId = 0;
    this.closed = [];
    this.pending = new Map();
    this.flushTimer = null;
    this.destroyed = false;
    this.groups = [];   // [{id, title, color, collapsed}] in creation order; every group has >= 1 tab
    this.split = null;  // {left, right, ratio} tab ids; at most one split per window
    managers.add(this);
    ensureSweep();
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  get(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  indexOf(tab) {
    return tab ? this.tabs.indexOf(tab) : -1;
  }

  activeTab() {
    return this.activeId ? this.get(this.activeId) : null;
  }

  count() {
    return this.tabs.length;
  }

  activeWebContents() {
    const t = this.activeTab();
    return t && t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
  }

  activeLoading() {
    const t = this.activeTab();
    return !!(t && t.isLoading);
  }

  list() {
    return this.tabs.map((t) => this.stateOf(t));
  }

  stateOf(tab) {
    return {
      id: tab.id,
      index: this.indexOf(tab),
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      security: tab.security,
      zoom: tab.zoom,
      isDiscarded: !tab.view,
      isAudible: tab.isAudible,
      isMuted: tab.isMuted,
      crashed: tab.crashed,
      active: tab.id === this.activeId,
      groupId: tab.groupId || null,
      pinned: !!tab.pinned,
      split: this.splitSide(tab),
    };
  }

  // Session snapshot: { tabs: [{url, title, group?, pinned?}], activeIndex, groups: [{title, color, collapsed}],
  // split?: {left, right, ratio} }. `group` and `split` are indexes into the same snapshot (tab ids change
  // on restore), so they stay valid after windows.js filters unrestorable tabs.
  sessionSnapshot() {
    const groupIndex = new Map();
    const groups = this.groups.map((g, i) => {
      groupIndex.set(g.id, i);
      return { title: g.title, color: g.color, collapsed: g.collapsed };
    });
    const tabs = this.tabs.map((t) => {
      const entry = { url: t.url, title: t.title || '' };
      if (t.pinned) entry.pinned = true;
      if (groupIndex.has(t.groupId)) entry.group = groupIndex.get(t.groupId);
      return entry;
    });
    const out = { tabs, activeIndex: Math.max(0, this.indexOf(this.activeTab())), groups };
    if (this.split) {
      const l = this.indexOf(this.get(this.split.left));
      const r = this.indexOf(this.get(this.split.right));
      if (l >= 0 && r >= 0) out.split = { left: l, right: r, ratio: this.split.ratio };
    }
    return out;
  }

  // ── IPC plumbing ────────────────────────────────────────────────────────

  send(channel, ...args) {
    if (this.destroyed || !this.win || this.win.isDestroyed()) return;
    const wc = this.win.webContents;
    if (wc.isDestroyed()) return;
    wc.send(channel, ...args);
    if (channel.startsWith('tabs:') && tabEvents.listenerCount(channel)) {
      try { tabEvents.emit(channel, this, ...args); } catch (err) { logger.log('[tabs] event listener failed:', err && err.message); }
    }
  }

  // Coalesces tab:updated events per tab: the flush sends the current values of the changed fields.
  markUpdated(tab, ...fields) {
    if (this.destroyed || !this.tabs.includes(tab)) return;
    let set = this.pending.get(tab.id);
    if (!set) {
      set = new Set();
      this.pending.set(tab.id, set);
    }
    for (const f of fields) set.add(f);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this.flushTimer = null;
    if (this.destroyed) return;
    const pending = this.pending;
    this.pending = new Map();
    for (const [id, fields] of pending) {
      const tab = this.get(id);
      if (!tab) continue;
      const s = this.stateOf(tab);
      const payload = { id };
      for (const f of fields) payload[f] = s[f];
      this.send('tabs:updated', payload);
    }
  }

  scheduleSave() {
    if (!this.incognito) windows.scheduleSessionSave();
  }

  // ── Creating and activating ─────────────────────────────────────────────

  createTab(opts = {}) {
    if (this.destroyed) return null;
    const url = extensionPageUrl(opts.url, this.incognito) || safeUrl(opts.url, !!opts.user) || homepageUrl();
    const active = opts.active !== false;
    if (isSettingsUrl(url) && this.tabs.some((t) => isSettingsUrl(t.url))) {
      return this.openSettings(settingsSection(url), active);
    }
    // 2.5 — F3: a blank new tab (no URL given, or the home page) takes the caret in the address bar.
    const blank = opts.url === undefined || isBlankTabUrl(url);
    return this.insertTab({ ...opts, url, active, blank });
  }

  insertTab(opts) {
    const tab = makeTab(opts);
    tab.owner = this;
    refreshNavFlags(tab);
    let idx = tab.pinned ? this.pinnedCount() : this.tabs.length;
    if (Number.isInteger(opts.index)) idx = clamp(opts.index, 0, this.tabs.length);
    else if (opts.after) {
      const a = this.indexOf(opts.after);
      if (a >= 0) idx = a + 1;
    }
    this.tabs.splice(this.settleIndex(idx, tab.pinned), 0, tab);
    this.send('tabs:created', this.stateOf(tab));
    this.scheduleSave();
    if (opts.active !== false) {
      this.activate(tab.id, { focus: !!opts.focus });
      // Sent after activation, so the UI handles it once the new tab is the active one.
      if (opts.blank) this.focusAddressBar();
    }
    return tab;
  }

  // 2.5 — F3: puts the caret in the browser UI's address bar (new blank tab, first load of a window). Does nothing
  // when settings.focusAddressBarOnNewTab is false, and before the UI has loaded (windows.js calls it then).
  focusAddressBar() {
    if (this.destroyed || !this.state.uiReady || !this.win || this.win.isDestroyed()) return false;
    if (settingsSafe().focusAddressBarOnNewTab === false) return false;
    this.grabFocusForUi();
    // Chromium can hand the keyboard focus to a page view the first time it is shown, a few ms after the activation
    // above. Take it back if that happened: a few one-shot checks (no polling) and once more when the page has loaded.
    // Typing in the bar in the meantime is safe: then the UI holds the focus, so nothing is taken back.
    const tab = this.activeTab();
    if (tab && tab.view && !tab.view.webContents.isDestroyed()) {
      const retake = () => {
        if (this.destroyed || this.activeId !== tab.id || !tab.view || tab.view.webContents.isDestroyed()) return;
        if (tab.view.webContents.isFocused()) this.grabFocusForUi();
      };
      for (const ms of FOCUS_RETAKE_MS) setTimeout(retake, ms);
      tab.view.webContents.once('did-finish-load', retake);
    }
    return true;
  }

  // Gives the browser UI the keyboard focus and tells its address bar to take the caret (ui:command, as Ctrl+L does).
  grabFocusForUi() {
    try { this.win.webContents.focus(); } catch { /* focus is best effort */ }
    try { this.win.webContents.send('ui:command', 'focus-address-bar', null); } catch (e) { log('focus address bar failed:', e && e.message); }
  }

  activate(id, { focus = false } = {}) {
    const tab = this.get(id);
    if (!tab || this.destroyed) return false;
    const prev = this.activeTab();
    let hadFocus = false;
    if (prev && prev !== tab) {
      // A view that leaves the screen keeps keyboard focus, which would swallow every later keystroke.
      try { hadFocus = !!prev.view && !prev.view.webContents.isDestroyed() && prev.view.webContents.isFocused(); } catch { hadFocus = false; }
      prev.lastActiveAt = Date.now();
    }
    if (this.state.htmlFullscreen && this.state.htmlFullscreen !== tab.id) this.state.htmlFullscreen = 0;
    this.activeId = tab.id;
    tab.lastActiveAt = Date.now();
    // Activating a tab in a collapsed group expands the group.
    if (this.expandGroup(tab.groupId)) this.emitGroups();
    const view = this.ensureView(tab);
    if (tab.crashed && !tab.showingError) {
      this.showError(tab, 'crashed', 'The page process stopped unexpectedly.', tab.url);
    }
    this.syncViews(); // shows the active tab (and both split panes), hides whatever is no longer shown
    this.send('tabs:activated', tab.id);
    this.send('tabs:hover-url', '');
    if (this.split) this.emitSplit();
    if (focus && view && !this.state.frozen && !view.webContents.isDestroyed()) {
      try { view.webContents.focus(); } catch { /* focus is best effort */ }
    } else if (hadFocus && this.win && !this.win.isDestroyed()) {
      try { this.win.webContents.focus(); } catch { /* focus is best effort */ }
    }
    this.scheduleSave();
    return true;
  }

  activateAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.tabs.length) return false;
    return this.activate(this.tabs[index].id, { focus: true });
  }

  cycle(dir) {
    const n = this.tabs.length;
    if (n < 2) return;
    const i = this.indexOf(this.activeTab());
    const next = ((i < 0 ? 0 : i) + (dir < 0 ? -1 : 1) + n) % n;
    this.activate(this.tabs[next].id, { focus: true });
  }

  // Lazily creates the WebContentsView. Restores history entries if present, otherwise loads the URL.
  ensureView(tab) {
    if (tab.view) return tab.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.state.session,
        preload: INTERNAL_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 2.5: Node stays off everywhere; this only makes the session's frame preloads (Purify cosmetics, password
        // fill/generator, picker) run in iframes too. They're sandboxed, and main checks event.senderFrame.
        nodeIntegrationInSubFrames: true,
        webSecurity: true,
        spellcheck: !!settingsSafe().spellcheck,
        safeDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    tab.view = view;
    const wc = view.webContents;
    try { wc.setAudioMuted(tab.isMuted); } catch { /* ignore */ }
    this.wireTab(tab, wc);
    const entries = tab.entries;
    tab.entries = null;
    if (tab.zoom !== 1) {
      try { wc.setZoomFactor(tab.zoom); } catch { /* ignore */ }
    }
    syncLite(tab); // before the first navigation, so the emulation covers the first paint
    if (entries) {
      wc.navigationHistory.restore({ entries, index: tab.entryIndex }).catch((e) => log('restore failed:', e && e.message));
    } else if (tab.url) {
      wc.loadURL(tab.url).catch(() => { /* did-fail-load shows the error page */ });
    }
    this.markUpdated(tab, 'isDiscarded', 'isLoading');
    return view;
  }

  // The tabs whose views must be on screen, with their rectangles: the active tab alone, or both split
  // panes side by side (the active tab is one of them). Nothing while frozen. A split pane that is in
  // HTML fullscreen fills the window and hides its partner.
  paneLayout() {
    if (this.state.frozen) return [];
    const active = this.activeTab();
    if (!active) return [];
    const sp = this.split;
    if (!sp || (active.id !== sp.left && active.id !== sp.right)) return [{ tab: active, rect: this.contentRect() }];
    const L = this.get(sp.left);
    const R = this.get(sp.right);
    if (!L || !R) return [{ tab: active, rect: this.contentRect() }];
    const area = this.contentRect();
    const full = this.state.htmlFullscreen;
    if (full === L.id || full === R.id) return [{ tab: full === L.id ? L : R, rect: area }];
    const avail = Math.max(0, area.width - SPLIT_GAP);
    const lw = Math.round(avail * sp.ratio);
    return [
      { tab: L, rect: { x: area.x, y: area.y, width: lw, height: area.height } },
      { tab: R, rect: { x: area.x + lw + SPLIT_GAP, y: area.y, width: avail - lw, height: area.height } },
    ];
  }

  // Tabs currently on screen (for the freeze snapshot). Call before `state.frozen` is set.
  shownTabs() {
    return this.paneLayout().map((w) => w.tab).filter((t) => t.view);
  }

  // Makes the window's child views match paneLayout(): wanted views are attached and placed, page views
  // that are no longer wanted are detached. Frozen pages are not attached.
  syncViews() {
    if (this.destroyed || !this.win || this.win.isDestroyed()) return;
    const want = this.paneLayout();
    const cv = this.win.contentView;
    const wanted = new Set();
    for (const w of want) {
      if (!w.tab.view) this.ensureView(w.tab);
      if (w.tab.view) wanted.add(w.tab.view);
    }
    const owned = new Set(this.tabs.map((t) => t.view).filter(Boolean));
    for (const child of [...cv.children]) {
      if (owned.has(child) && !wanted.has(child)) {
        try { cv.removeChildView(child); } catch { /* ignore */ }
      }
    }
    for (const w of want) {
      const view = w.tab.view;
      if (!view) continue;
      if (!cv.children.includes(view)) cv.addChildView(view);
      view.setBounds(w.rect);
    }
  }

  attachActive() {
    this.syncViews();
  }

  detachView(tab) {
    if (!tab || !tab.view || this.win.isDestroyed()) return;
    try { this.win.contentView.removeChildView(tab.view); } catch { /* ignore */ }
  }

  contentRect() {
    const size = this.win.getContentBounds();
    if (this.state.htmlFullscreen) return { x: 0, y: 0, width: size.width, height: size.height };
    const b = this.state.bounds;
    if (!b) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(b.x, size.width);
    const y = Math.min(b.y, size.height);
    return {
      x,
      y,
      width: Math.max(0, Math.min(b.width, size.width - x)),
      height: Math.max(0, Math.min(b.height, size.height - y)),
    };
  }

  applyLayout() {
    this.attachActive();
  }

  setHtmlFullscreen(tab, on) {
    if (on) this.state.htmlFullscreen = tab.id;
    else if (this.state.htmlFullscreen === tab.id) this.state.htmlFullscreen = 0;
    if (tab.id === this.activeId || this.isSplitMember(tab)) this.syncViews();
  }

  // A split pane took keyboard focus (click or Tab key): it becomes the active tab. The other pane stays.
  onPaneFocus(tab) {
    if (this.destroyed || this.state.frozen || tab.id === this.activeId || !this.isSplitMember(tab)) return;
    this.activate(tab.id, { focus: false });
  }

  // ── Event wiring for a tab's webContents ─────────────────────────────────

  wireTab(tab, wc) {
    const on = (ev, fn) => {
      const h = (...args) => {
        const m = tab.owner;
        if (!m || m.destroyed || !tab.view || tab.view.webContents !== wc) return;
        fn(m, ...args);
      };
      wc.on(ev, h);
      tab.disposers.push(() => wc.removeListener(ev, h));
    };

    on('did-start-loading', (m) => {
      tab.isLoading = true;
      m.markUpdated(tab, 'isLoading');
    });
    on('did-stop-loading', (m) => {
      tab.isLoading = false;
      refreshNavFlags(tab);
      m.markUpdated(tab, 'isLoading', 'canGoBack', 'canGoForward');
    });
    on('did-navigate', (m, _e, url) => {
      m.onNavigated(tab, url);
      syncLite(tab);
    });
    on('devtools-opened', () => releaseLite(tab)); // DevTools gets the debugger target to itself
    on('devtools-closed', () => syncLite(tab));
    on('did-navigate-in-page', (m, _e, url, isMainFrame) => {
      if (!isMainFrame || typeof url !== 'string' || url.startsWith('pure://error/')) return;
      tab.url = url;
      refreshNavFlags(tab);
      m.markUpdated(tab, 'url', 'canGoBack', 'canGoForward');
    });
    on('did-fail-load', (m, _e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED (user stopped or replaced the load)
      if (typeof validatedURL !== 'string' || !validatedURL || validatedURL.startsWith('pure://')) return;
      // 2.4 (manager hook, keep): an upgraded https load that failed falls back to http, or shows the HTTPS-only page.
      const alt = httpsFallback(m, tab, errorCode, validatedURL);
      if (alt && alt.load) { tab.view.webContents.loadURL(alt.load).catch(() => { /* ignore */ }); return; }
      if (alt && alt.error) { m.showError(tab, alt.error, alt.desc || '', validatedURL); return; }
      m.showError(tab, errorDescription || 'ERR_FAILED', `Chromium error ${errorCode}`, validatedURL);
    });
    on('certificate-error', (m, _e, url, _error, _cert, callback, isMainFrame) => {
      try { callback(false); } catch { /* ignore */ }
      if (isMainFrame) {
        tab.security = 'error';
        m.markUpdated(tab, 'security');
      }
    });
    on('render-process-gone', (m, _e, details) => {
      if (details && details.reason === 'clean-exit') return;
      log('tab renderer gone:', details && details.reason);
      tab.crashed = true;
      tab.isLoading = false;
      m.markUpdated(tab, 'crashed', 'isLoading');
      if (m.activeId === tab.id) m.showError(tab, 'crashed', 'The page process stopped unexpectedly.', tab.url);
    });
    on('page-title-updated', (m, _e, title) => {
      if (tab.showingError) return;
      tab.title = String(title || '').slice(0, 500);
      m.markUpdated(tab, 'title');
      if (!m.incognito && isHttpUrl(tab.url) && tab.title) {
        safeCall(() => storage.history.updateTitle(tab.url, tab.title));
      }
    });
    on('page-favicon-updated', (m, _e, favicons) => {
      const f = Array.isArray(favicons)
        ? favicons.find((x) => typeof x === 'string' && /^(https?:|data:)/i.test(x) && x.length <= FAVICON_MAX)
        : null;
      if (f && f !== tab.favicon) {
        tab.favicon = f;
        m.markUpdated(tab, 'favicon');
      }
    });
    on('audio-state-changed', (m, event) => {
      const audible = !!(event && event.audible);
      if (audible !== tab.isAudible) {
        tab.isAudible = audible;
        m.markUpdated(tab, 'isAudible');
      }
    });
    on('zoom-changed', (m, _e, dir) => m.zoomStep(tab, dir === 'in' ? 'in' : 'out'));
    on('enter-html-full-screen', (m) => m.setHtmlFullscreen(tab, true));
    on('leave-html-full-screen', (m) => m.setHtmlFullscreen(tab, false));
    on('found-in-page', (m, _e, result) => {
      if (!result) return;
      m.send('tabs:found', { id: tab.id, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
    });
    on('update-target-url', (m, _e, url) => {
      if (m.activeId === tab.id) m.send('tabs:hover-url', typeof url === 'string' ? url : '');
    });
    on('focus', (m) => m.onPaneFocus(tab));

    guardWebContents(wc, {
      getWin: () => (tab.owner && !tab.owner.destroyed ? tab.owner.win : null),
      getManager: () => tab.owner || null,
      resolve: () => {
        const m = tab.owner;
        return m && !m.destroyed ? { win: m.win, tabs: m } : null;
      },
      tab,
      onPopup: (child) => {
        tab.popups++;
        child.once('closed', () => { tab.popups = Math.max(0, tab.popups - 1); });
      },
    }, (d) => tab.disposers.push(d));
  }

  onNavigated(tab, url) {
    if (typeof url !== 'string' || !tab.view) return;
    if (url.startsWith('pure://error/')) {
      tab.showingError = true;
      tab.isLoading = false;
      tab.security = 'error';
      this.markUpdated(tab, 'security', 'isLoading');
      return;
    }
    const prev = tab.url;
    tab.showingError = false;
    tab.crashed = false;
    if (url !== prev) {
      tab.title = '';
      if (originOf(url) !== originOf(prev)) tab.favicon = '';
    }
    tab.url = url;
    tab.security = computeSecurity(url);
    tab.zoom = safeZoom(tab.view.webContents);
    refreshNavFlags(tab);
    if (!this.incognito && isHttpUrl(url)) {
      safeCall(() => storage.history.add({ url, title: '' }));
    }
    this.markUpdated(tab, 'url', 'title', 'favicon', 'security', 'zoom', 'canGoBack', 'canGoForward', 'crashed');
    this.scheduleSave();
  }

  // Shows the internal error page for `failedUrl`; the address bar keeps showing failedUrl.
  showError(tab, code, desc, failedUrl) {
    if (!tab.view || tab.view.webContents.isDestroyed()) return;
    const url = typeof failedUrl === 'string' ? failedUrl : tab.url;
    tab.showingError = true;
    tab.isLoading = false;
    if (url) tab.url = url;
    tab.title = url || '';
    tab.security = 'error';
    const q = new URLSearchParams({ code: String(code), desc: String(desc), url: String(url || '') });
    tab.view.webContents.loadURL(`pure://error/?${q.toString()}`).catch(() => { /* ignore */ });
    this.markUpdated(tab, 'url', 'title', 'security', 'isLoading', 'crashed');
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  navigate(id, raw) {
    const tab = this.get(id);
    if (!tab || this.destroyed) return;
    const url = extensionPageUrl(raw, this.incognito) || safeUrl(raw, true);
    if (!url) return;
    tab.showingError = false;
    tab.crashed = false;
    tab.entries = null;
    if (originOf(url) !== originOf(tab.url)) tab.favicon = '';
    tab.url = url;
    tab.security = computeSecurity(url);
    if (tab.view) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.loadURL(url).catch(() => { /* did-fail-load */ });
    } else if (this.activeId === tab.id) {
      this.ensureView(tab);
    }
    this.markUpdated(tab, 'url', 'favicon', 'security', 'crashed');
    this.scheduleSave();
  }

  reload(id, ignoreCache = false) {
    const tab = this.get(id);
    if (!tab) return;
    if (!tab.view) {
      if (this.activeId === tab.id) this.ensureView(tab);
      return;
    }
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    if (tab.crashed || tab.showingError) {
      tab.crashed = false;
      tab.showingError = false;
      wc.loadURL(tab.url).catch(() => { /* did-fail-load */ });
      return;
    }
    try {
      if (ignoreCache) wc.reloadIgnoringCache();
      else wc.reload();
    } catch { /* ignore */ }
  }

  stop(id) {
    const tab = this.get(id);
    if (tab && tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
  }

  back(id) {
    const tab = this.get(id);
    if (!tab || !tab.view) return;
    const nh = tab.view.webContents.navigationHistory;
    if (nh.canGoBack()) nh.goBack();
  }

  forward(id) {
    const tab = this.get(id);
    if (!tab || !tab.view) return;
    const nh = tab.view.webContents.navigationHistory;
    if (nh.canGoForward()) nh.goForward();
  }

  // ── Zoom, find, devtools, mute ──────────────────────────────────────────

  zoomStep(tab, dir) {
    const live = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    const cur = live ? safeZoom(live) : tab.zoom || 1;
    let next;
    if (dir === 'reset') next = 1;
    else if (dir === 'in') next = ZOOM_STEPS.find((s) => s > cur + 0.001) ?? cur;
    else next = [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.001) ?? cur;
    tab.zoom = next;
    if (live) {
      try { live.setZoomFactor(next); } catch { /* ignore */ }
    }
    this.markUpdated(tab, 'zoom');
    return next;
  }

  zoom(id, dir) {
    const tab = this.get(id);
    return tab ? this.zoomStep(tab, dir) : null;
  }

  zoomActive(dir) {
    const tab = this.activeTab();
    if (tab) this.zoomStep(tab, dir);
  }

  find(id, text, opts) {
    const tab = this.get(id);
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
    const wc = tab.view.webContents;
    if (typeof text !== 'string' || text.length === 0 || text.length > 500) {
      wc.stopFindInPage('clearSelection');
      return;
    }
    const o = plain(opts);
    wc.findInPage(text, { forward: o.forward !== false, findNext: !!o.findNext });
  }

  stopFind(id) {
    const tab = this.get(id);
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
    // Like Chrome: keep the found match selected and hand keyboard focus back to the page.
    tab.view.webContents.stopFindInPage('activateSelection');
    if (tab.id === this.activeId && !this.state.frozen) tab.view.webContents.focus();
  }

  toggleDevTools(id) {
    const tab = this.get(id);
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
    const wc = tab.view.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  }

  toggleMute(id) {
    const tab = this.get(id);
    if (!tab) return;
    tab.isMuted = !tab.isMuted;
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.setAudioMuted(tab.isMuted);
    this.markUpdated(tab, 'isMuted');
  }

  // ── Closing, reopening, moving ─────────────────────────────────────────

  snapshotEntries(tab) {
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      try {
        const nh = tab.view.webContents.navigationHistory;
        const entries = nh.getAllEntries();
        return { entries: entries.length ? entries : null, entryIndex: nh.getActiveIndex() };
      } catch { /* fall through to the stored copy */ }
    }
    return { entries: tab.entries || null, entryIndex: tab.entryIndex || 0 };
  }

  rememberClosed(tab) {
    if (!tab.url) return;
    const snap = this.snapshotEntries(tab);
    this.closed.push({ url: tab.url, title: tab.title, entries: snap.entries, entryIndex: snap.entryIndex });
    if (this.closed.length > CLOSED_LIMIT) this.closed.shift();
  }

  closeTab(id) {
    const tab = this.get(id);
    if (!tab || this.destroyed) return;
    const idx = this.indexOf(tab);
    const wasActive = this.activeId === tab.id;
    this.rememberClosed(tab);
    if (this.isSplitMember(tab)) this.endSplit();
    const hadGroup = !!tab.groupId;
    this.tabs.splice(idx, 1);
    this.pending.delete(tab.id);
    if (wasActive) this.activeId = 0;
    if (this.state.htmlFullscreen === tab.id) this.state.htmlFullscreen = 0;
    this.destroyView(tab);
    this.send('tabs:removed', tab.id);
    if (hadGroup) this.groupLost();
    if (this.tabs.length === 0) this.createTab({ active: true });
    else if (wasActive) this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)].id, { focus: true });
    this.scheduleSave();
  }

  // Pinned tabs are never closed by these bulk actions (Chrome does the same).
  closeOthers(keepId) {
    if (!this.get(keepId)) return;
    if (this.activeId !== keepId) this.activate(keepId, { focus: false });
    for (const t of [...this.tabs]) {
      if (t.id !== keepId && !t.pinned) this.closeTab(t.id);
    }
  }

  closeToRight(id) {
    const tab = this.get(id);
    if (!tab) return;
    const idx = this.indexOf(tab);
    const right = this.tabs.slice(idx + 1).filter((t) => !t.pinned);
    if (!right.length) return;
    if (right.includes(this.activeTab())) this.activate(tab.id, { focus: false });
    for (const t of right) this.closeTab(t.id);
  }

  reopenClosed() {
    const rec = this.closed.pop();
    if (!rec) return null;
    return this.createTab({
      url: rec.url,
      title: rec.title,
      entries: rec.entries,
      entryIndex: rec.entryIndex,
      active: true,
      user: true,
    });
  }

  // Moves a tab to toIndex. It joins the group it lands inside (a group's neighbours on both sides) and
  // leaves the group it is dragged out of; groups stay contiguous by construction.
  // 2.4: a pinned tab stays inside the pinned run and an unpinned tab stays after it.
  move(id, toIndex) {
    const tab = this.get(id);
    const from = this.indexOf(tab);
    if (from < 0 || !Number.isInteger(toIndex)) return;
    const P = this.pinnedCount();
    const lo = tab.pinned ? 0 : P;
    const hi = tab.pinned ? P - 1 : this.tabs.length - 1;
    const to = clamp(toIndex, lo, Math.max(lo, hi));
    if (to === from) return;
    const [t] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, t);
    const prev = this.tabs[to - 1];
    const next = this.tabs[to + 1];
    const joined = !t.pinned && prev && next && prev.groupId && prev.groupId === next.groupId ? prev.groupId : null;
    const membershipChanged = joined !== t.groupId;
    this.setGroupOf(t, joined);
    const expanded = joined ? this.expandGroup(joined) : false;
    const pruned = this.pruneGroups();
    this.send('tabs:moved', this.tabs.map((x) => x.id));
    if (membershipChanged || expanded || pruned) this.emitGroups();
    this.scheduleSave();
  }

  // 2.4: pins or unpins a tab. Pinning takes it out of its group and ends a split it is in, then puts it at
  // the end of the pinned run. Unpinning puts it at the start of the unpinned run. -> true when it changed.
  setPinned(id, on) {
    const tab = this.get(id);
    if (this.destroyed || !tab) return false;
    const want = !!on;
    if (tab.pinned === want) return false;
    const before = this.orderKey();
    if (want) {
      if (this.isSplitMember(tab)) this.endSplit();
      if (tab.groupId) this.groupRemoveTab(tab.id);
    }
    const from = this.indexOf(tab);
    this.tabs.splice(from, 1);
    tab.pinned = want;
    // Pinned tabs of the remaining strip = the slot where the tab goes, for both directions.
    this.tabs.splice(this.pinnedCount(), 0, tab);
    this.markUpdated(tab, 'pinned');
    const pruned = this.pruneGroups();
    if (this.orderKey() !== before) this.send('tabs:moved', this.tabs.map((x) => x.id));
    if (pruned) this.emitGroups();
    this.scheduleSave();
    return true;
  }

  // Removes a tab from this window without destroying its view (used when moving to another window).
  // A tab that changes window drops its group and ends a split it belongs to.
  release(id) {
    const tab = this.get(id);
    if (!tab) return null;
    const idx = this.indexOf(tab);
    const wasActive = this.activeId === tab.id;
    if (this.isSplitMember(tab)) this.endSplit();
    const hadGroup = !!tab.groupId;
    this.tabs.splice(idx, 1);
    this.pending.delete(tab.id);
    if (wasActive) this.activeId = 0;
    if (this.state.htmlFullscreen === tab.id) this.state.htmlFullscreen = 0;
    this.detachView(tab);
    this.send('tabs:removed', tab.id);
    tab.groupId = null;
    if (hadGroup) this.groupLost();
    if (wasActive && this.tabs.length) {
      this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)].id, { focus: true });
    }
    this.scheduleSave();
    return tab;
  }

  adopt(tab, opts = {}) {
    if (this.destroyed) return false;
    tab.owner = this;
    tab.lastActiveAt = Date.now();
    tab.groupId = null;
    const fallback = tab.pinned ? this.pinnedCount() : this.tabs.length;
    const idx = Number.isInteger(opts.index) ? clamp(opts.index, 0, this.tabs.length) : fallback;
    this.tabs.splice(this.settleIndex(idx, tab.pinned), 0, tab);
    this.send('tabs:created', this.stateOf(tab));
    this.scheduleSave();
    if (opts.active !== false) this.activate(tab.id, { focus: !!opts.focus });
    return true;
  }

  // ── Discarding ─────────────────────────────────────────────────────────

  // Saves history entries, then destroys the webContents. The tab is restored on next activation.
  suspend(tab) {
    if (!tab.view) return;
    const snap = this.snapshotEntries(tab);
    tab.entries = snap.entries;
    tab.entryIndex = snap.entryIndex;
    const cur = snap.entries && snap.entries[snap.entryIndex];
    if (cur && cur.url && !cur.url.startsWith('pure://error/')) tab.url = cur.url;
    this.destroyView(tab);
    tab.isLoading = false;
    tab.isAudible = false;
    refreshNavFlags(tab);
    this.markUpdated(tab, 'isDiscarded', 'isLoading', 'isAudible', 'url', 'canGoBack', 'canGoForward');
  }

  discardTab(tab) {
    if (!tab.view || tab.id === this.activeId || tab.isAudible || tab.isLoading || tab.popups > 0) return false;
    if (this.isSplitMember(tab)) return false; // split panes are never discarded
    this.suspend(tab);
    return true;
  }

  sweep(now, limitMs) {
    for (const tab of [...this.tabs]) {
      if (tab.view && now - tab.lastActiveAt >= limitMs) this.discardTab(tab);
    }
  }

  destroyView(tab) {
    const view = tab.view;
    if (!view) return;
    tab.view = null;
    tab.liteEmu = false; // closing the webContents detaches our debugger session
    tab.dbgWc = null;
    const disposers = tab.disposers;
    tab.disposers = [];
    for (const d of disposers) {
      try { d(); } catch { /* ignore */ }
    }
    try {
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view);
    } catch { /* ignore */ }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch (e) {
      log('webContents close failed:', e && e.message);
    }
  }

  // ── Strip order helpers ────────────────────────────────────────────────

  orderKey() {
    return this.tabs.map((t) => t.id).join(',');
  }

  // Number of pinned tabs. Pinned tabs always form the first run of the strip.
  pinnedCount() {
    let n = 0;
    while (n < this.tabs.length && this.tabs[n].pinned) n++;
    return n;
  }

  // Insertion index. Pinned tabs go inside the pinned run [0, pinnedCount]; other tabs go after it, and
  // never between two members of the same group.
  settleIndex(idx, pinned = false) {
    const P = this.pinnedCount();
    if (pinned) return clamp(idx, 0, P);
    let i = clamp(idx, P, this.tabs.length);
    while (i > P && i < this.tabs.length && this.tabs[i - 1].groupId && this.tabs[i - 1].groupId === this.tabs[i].groupId) i++;
    return i;
  }

  // ── Tab groups ─────────────────────────────────────────────────────────

  groupsList() {
    return this.groups.map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: g.collapsed }));
  }

  groupById(id) {
    return id ? this.groups.find((g) => g.id === id) || null : null;
  }

  emitGroups() {
    this.send('groups:changed', this.groupsList());
  }

  // Least used colour in this window (the first unused one while any is free).
  pickColor() {
    const uses = new Map(GROUP_COLORS.map((c) => [c, 0]));
    for (const g of this.groups) uses.set(g.color, (uses.get(g.color) || 0) + 1);
    let best = GROUP_COLORS[0];
    for (const c of GROUP_COLORS) if (uses.get(c) < uses.get(best)) best = c;
    return best;
  }

  // [first, last] strip indexes of a group's members, or null.
  groupRun(groupId) {
    const first = this.tabs.findIndex((t) => t.groupId === groupId);
    if (first < 0) return null;
    let last = first;
    for (let i = first + 1; i < this.tabs.length; i++) if (this.tabs[i].groupId === groupId) last = i;
    return { first, last };
  }

  setGroupOf(tab, groupId) {
    if (tab.groupId === groupId) return;
    tab.groupId = groupId;
    this.markUpdated(tab, 'groupId');
  }

  // Deletes groups without tabs. -> true when a group was removed.
  pruneGroups() {
    const before = this.groups.length;
    this.groups = this.groups.filter((g) => this.tabs.some((t) => t.groupId === g.id));
    return this.groups.length !== before;
  }

  // Called after a tab left its group (closed or released): drop empty groups and tell the UI.
  groupLost() {
    this.pruneGroups();
    this.emitGroups();
  }

  // Expands a collapsed group. -> true when it was collapsed.
  expandGroup(groupId) {
    const g = this.groupById(groupId);
    if (!g || !g.collapsed) return false;
    g.collapsed = false;
    return true;
  }

  // Groups the given tabs (in strip order) as one contiguous block at the first one's position.
  groupCreate(tabIds, opts = {}) {
    if (this.destroyed || !Array.isArray(tabIds)) return null;
    const picked = new Set(tabIds.map((id) => this.get(id)).filter((t) => t && !t.pinned));
    if (!picked.size) return null;
    const before = this.orderKey();
    const members = this.tabs.filter((t) => picked.has(t));
    const first = this.indexOf(members[0]);
    this.tabs = this.tabs.filter((t) => !picked.has(t));
    this.tabs.splice(this.settleIndex(first), 0, ...members);
    const g = {
      id: newGroupId(),
      title: cleanGroupTitle(opts.title),
      color: GROUP_COLORS.includes(opts.color) ? opts.color : this.pickColor(),
      collapsed: false,
    };
    this.groups.push(g);
    for (const t of members) this.setGroupOf(t, g.id);
    this.pruneGroups();
    if (this.orderKey() !== before) this.send('tabs:moved', this.tabs.map((x) => x.id));
    this.emitGroups();
    this.scheduleSave();
    return g.id;
  }

  // Adds a tab to a group at the end of the group's range (a tab already in it moves to the end too).
  groupAddTab(tabId, groupId) {
    const tab = this.get(tabId);
    const g = this.groupById(groupId);
    if (this.destroyed || !tab || !g || tab.pinned) return false;
    const before = this.orderKey();
    const from = this.indexOf(tab);
    this.tabs.splice(from, 1);
    const run = this.groupRun(groupId);
    this.tabs.splice(run ? run.last + 1 : from, 0, tab);
    this.setGroupOf(tab, groupId);
    g.collapsed = false;
    this.pruneGroups();
    if (this.orderKey() !== before) this.send('tabs:moved', this.tabs.map((x) => x.id));
    this.emitGroups();
    this.scheduleSave();
    return true;
  }

  // Takes a tab out of its group. A tab inside the group's range moves to the group's end so the
  // group stays contiguous; a tab on the group's edge stays where it is.
  groupRemoveTab(tabId) {
    const tab = this.get(tabId);
    if (!tab || !tab.groupId) return false;
    const before = this.orderKey();
    const gid = tab.groupId;
    const run = this.groupRun(gid);
    const from = this.indexOf(tab);
    if (run && from > run.first && from < run.last) {
      this.tabs.splice(from, 1);
      const rest = this.groupRun(gid);
      this.tabs.splice(rest ? rest.last + 1 : from, 0, tab);
    }
    this.setGroupOf(tab, null);
    this.pruneGroups();
    if (this.orderKey() !== before) this.send('tabs:moved', this.tabs.map((x) => x.id));
    this.emitGroups();
    this.scheduleSave();
    return true;
  }

  groupUngroup(groupId) {
    const g = this.groupById(groupId);
    if (this.destroyed || !g) return false;
    for (const t of this.tabs) if (t.groupId === g.id) this.setGroupOf(t, null);
    this.groups = this.groups.filter((x) => x !== g);
    this.emitGroups();
    this.scheduleSave();
    return true;
  }

  // patch: {title?, color?, collapsed?}. Collapsing can be refused (see collapseGroup).
  groupUpdate(groupId, patch) {
    const g = this.groupById(groupId);
    if (this.destroyed || !g || !patch || typeof patch !== 'object') return false;
    let changed = false;
    if (typeof patch.title === 'string') {
      const title = cleanGroupTitle(patch.title);
      if (title !== g.title) { g.title = title; changed = true; }
    }
    if (typeof patch.color === 'string' && GROUP_COLORS.includes(patch.color) && patch.color !== g.color) {
      g.color = patch.color;
      changed = true;
    }
    if (typeof patch.collapsed === 'boolean' && patch.collapsed !== g.collapsed) {
      if (patch.collapsed) {
        if (this.collapseGroup(g)) changed = true;
      } else {
        g.collapsed = false;
        changed = true;
      }
    }
    if (changed) {
      this.emitGroups();
      this.scheduleSave();
    }
    return changed;
  }

  // A group can't hide a split pane (both panes stay visible). When it holds the active tab, activation
  // moves to the nearest tab outside the group (ties go right); with no tab outside, collapsing is refused.
  collapseGroup(g) {
    const run = this.groupRun(g.id);
    if (!run) return false;
    for (let i = run.first; i <= run.last; i++) if (this.isSplitMember(this.tabs[i])) return false;
    const active = this.activeTab();
    if (active && active.groupId === g.id) {
      const actIdx = this.indexOf(active);
      const left = run.first - 1 >= 0 ? this.tabs[run.first - 1] : null;
      const right = run.last + 1 < this.tabs.length ? this.tabs[run.last + 1] : null;
      let target = null;
      if (left && right) target = run.last + 1 - actIdx <= actIdx - (run.first - 1) ? right : left;
      else target = right || left;
      if (!target) return false;
      g.collapsed = true;
      this.activate(target.id, { focus: true });
      return true;
    }
    g.collapsed = true;
    return true;
  }

  // Restores groups and the split after a session restore. `created[i]` is the tab made for saved.tabs[i]
  // (or null); tabs are already in saved order, so every group is contiguous.
  applySavedLayout(created, saved) {
    if (this.destroyed || !saved || typeof saved !== 'object') return;
    const savedTabs = Array.isArray(saved.tabs) ? saved.tabs : [];
    const groups = Array.isArray(saved.groups) ? saved.groups : [];
    groups.forEach((spec, gi) => {
      if (!spec || typeof spec !== 'object') return;
      const members = created.filter((t, i) => t && savedTabs[i] && savedTabs[i].group === gi);
      if (!members.length) return;
      const g = {
        id: newGroupId(),
        title: cleanGroupTitle(spec.title),
        color: GROUP_COLORS.includes(spec.color) ? spec.color : 'grey',
        collapsed: spec.collapsed === true,
      };
      this.groups.push(g);
      for (const t of members) this.setGroupOf(t, g.id);
    });
    const sp = saved.split;
    if (sp && Number.isInteger(sp.left) && Number.isInteger(sp.right)) {
      const L = created[sp.left];
      const R = created[sp.right];
      if (L && R && L !== R) {
        const ratio = Number.isFinite(sp.ratio) ? sp.ratio : SPLIT_DEFAULT;
        this.split = { left: L.id, right: R.id, ratio: clamp(ratio, SPLIT_MIN, SPLIT_MAX) };
        this.markUpdated(L, 'split');
        this.markUpdated(R, 'split');
      }
    }
    if (this.groups.length) this.emitGroups();
  }

  // ── Split view ─────────────────────────────────────────────────────────

  isSplitMember(tab) {
    return !!(tab && this.split && (tab.id === this.split.left || tab.id === this.split.right));
  }

  splitSide(tab) {
    if (!this.isSplitMember(tab)) return null;
    return tab.id === this.split.left ? 'left' : 'right';
  }

  // Shows `tabId` on the left and `otherId` on the right (a new home tab when otherId is null).
  // Replaces an existing split. The tab that becomes the left pane is activated.
  splitOpen(tabId, otherId) {
    if (this.destroyed) return false;
    const left = this.get(tabId);
    if (!left || left.pinned) return false; // pinned tabs are never a split pane
    if (otherId !== null && otherId !== undefined && this.get(otherId) && this.get(otherId).pinned) return false;
    const right = otherId === null || otherId === undefined
      ? this.insertTab({ url: homepageUrl(), active: false })
      : this.get(otherId);
    if (!right || right === left) return false;
    const old = this.split ? [this.split.left, this.split.right] : [];
    this.split = { left: left.id, right: right.id, ratio: SPLIT_DEFAULT };
    for (const id of [...old, left.id, right.id]) {
      const t = this.get(id);
      if (t) this.markUpdated(t, 'split');
    }
    this.expandGroup(left.groupId);
    this.expandGroup(right.groupId);
    if (this.activeId !== left.id) {
      this.activate(left.id, { focus: false }); // emits split:changed and syncs the views
    } else {
      this.syncViews();
      this.emitSplit();
    }
    this.emitGroups();
    this.scheduleSave();
    return true;
  }

  // Menu: the active tab goes on the left and the chosen tab on the right; on the active tab itself,
  // the other pane is a new home tab.
  splitFromMenu(id) {
    const tab = this.get(id);
    if (!tab || tab.pinned) return false;
    const active = this.activeTab();
    if (!active || active.id === tab.id || active.pinned) return this.splitOpen(tab.id, null);
    return this.splitOpen(active.id, tab.id);
  }

  endSplit() {
    if (!this.split) return false;
    const old = this.split;
    this.split = null;
    for (const id of [old.left, old.right]) {
      const t = this.get(id);
      if (t) this.markUpdated(t, 'split');
    }
    this.emitSplit();
    this.syncViews();
    this.scheduleSave();
    return true;
  }

  splitRatio(ratio) {
    if (!this.split || !Number.isFinite(ratio)) return false;
    const r = clamp(ratio, SPLIT_MIN, SPLIT_MAX);
    if (r === this.split.ratio) return true;
    this.split.ratio = r;
    this.syncViews();
    this.emitSplit();
    this.scheduleSave();
    return true;
  }

  splitFocus(side) {
    if (!this.split) return false;
    const id = side === 'left' ? this.split.left : side === 'right' ? this.split.right : 0;
    return id ? this.activate(id, { focus: true }) : false;
  }

  // focused = the window's active tab. The split is on screen while focused is one of its panes.
  emitSplit() {
    if (!this.split) {
      this.send('split:changed', null);
      return;
    }
    this.send('split:changed', {
      left: this.split.left,
      right: this.split.right,
      ratio: this.split.ratio,
      focused: this.activeId,
    });
  }

  // ── Mute others ────────────────────────────────────────────────────────

  muteOthers(tabId) {
    const keep = this.get(tabId);
    if (this.destroyed || !keep) return 0;
    let n = 0;
    for (const t of this.tabs) {
      if (t === keep || t.isMuted) continue;
      t.isMuted = true;
      if (t.view && !t.view.webContents.isDestroyed()) {
        try { t.view.webContents.setAudioMuted(true); } catch { /* ignore */ }
      }
      this.markUpdated(t, 'isMuted');
      n++;
    }
    return n;
  }

  // ── Settings tab ───────────────────────────────────────────────────────

  openSettings(section = '', active = true) {
    const sec = SETTINGS_SECTIONS.has(section) ? section : '';
    const existing = this.tabs.find((t) => isSettingsUrl(t.url));
    if (existing) {
      if (sec) this.navigateSettingsTab(existing, `pure://settings/#${sec}`);
      if (active) this.activate(existing.id, { focus: true });
      return existing;
    }
    return this.insertTab({ url: `pure://settings/${sec ? '#' + sec : ''}`, active, focus: active });
  }

  navigateSettingsTab(tab, url) {
    if (tab.url === url) return;
    tab.url = url;
    tab.entries = null;
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.loadURL(url).catch(() => { /* ignore */ });
    this.markUpdated(tab, 'url');
  }

  // ── Context menus ──────────────────────────────────────────────────────

  showTabMenu(id) {
    const tab = this.get(id);
    if (!tab) return;
    const actions = {
      togglePin: () => this.setPinned(tab.id, !tab.pinned),
      newTab: () => this.createTab({ active: true }),
      reload: () => this.reload(tab.id),
      duplicate: () => {
        const snap = this.snapshotEntries(tab);
        this.createTab({
          url: tab.url,
          user: true,
          entries: snap.entries,
          entryIndex: snap.entryIndex,
          after: tab,
          active: true,
        });
      },
      toggleMute: () => this.toggleMute(tab.id),
      close: () => this.closeTab(tab.id),
      closeOthers: () => this.closeOthers(tab.id),
      closeToRight: () => this.closeToRight(tab.id),
      reopenClosed: () => this.reopenClosed(),
      newGroup: () => this.groupCreate([tab.id], {}),
      addToGroup: (groupId) => this.groupAddTab(tab.id, groupId),
      removeFromGroup: () => this.groupRemoveTab(tab.id),
      openSplit: () => this.splitFromMenu(tab.id),
      closeSplit: () => this.endSplit(),
      muteOthers: () => this.muteOthers(tab.id),
    };
    menus.showTabContextMenu({
      win: this.win,
      tab: this.stateOf(tab),
      actions,
      groups: this.groupsList(),
      splitOn: !!this.split,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onWindowFocus() {
    this.attachActive();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
    for (const tab of this.tabs) {
      try { this.destroyView(tab); } catch (e) { log('destroy tab failed:', e && e.message); }
    }
    this.tabs = [];
    this.activeId = 0;
    this.closed = [];
    this.groups = [];
    this.split = null;
    managers.delete(this);
    if (managers.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }
}

function refreshNavFlags(tab) {
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    try {
      const nh = tab.view.webContents.navigationHistory;
      tab.canGoBack = nh.canGoBack();
      tab.canGoForward = nh.canGoForward();
      return;
    } catch { /* fall through */ }
  }
  const n = tab.entries ? tab.entries.length : 0;
  tab.canGoBack = n > 0 && tab.entryIndex > 0;
  tab.canGoForward = n > 0 && tab.entryIndex < n - 1;
}

// One sweep timer per process, only while at least one window exists; unref'd.
function ensureSweep() {
  wirePower();
  if (sweepTimer || managers.size === 0) return;
  sweepTimer = setInterval(sweepAll, SWEEP_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

// Runs once per 60 s tick (the only timer for sleeping). Delay rules:
//   base    = Lite ? 3 min : tabDiscardMinutes (0 = never; Lite always applies its 3 min)
//   smart   = settings.smartSleep: halved on battery, halved again for windows that are minimized,
//             and the low-memory pass below also runs even when base is 0.
function sweepAll() {
  const s = settingsSafe();
  const smart = s.smartSleep === true;
  const lite = s.liteMode === true;
  const baseMin = lite ? LITE_DELAY_MIN : (Number(s.tabDiscardMinutes) || 0);
  const now = Date.now();
  if (baseMin > 0) {
    for (const m of [...managers]) {
      let limit = baseMin * 60 * 1000;
      if (smart) {
        if (onBattery) limit /= 2;
        if (m.win && !m.win.isDestroyed() && m.win.isMinimized()) limit /= 2;
      }
      m.sweep(now, limit);
    }
  }
  if (smart) lowMemorySweep();
}

function freeRamRatio() {
  const total = os.totalmem();
  return total > 0 ? os.freemem() / total : 1;
}

// When free RAM drops below LOW_MEMORY_ON, sleep the least recently used inactive tabs (all windows)
// until free RAM is above LOW_MEMORY_OFF, at most LOW_MEMORY_MAX per tick. Freed memory shows up only
// after the renderer exits, so the ratio is re-read after each tab and the cap bounds a single tick.
function lowMemorySweep() {
  if (freeRamRatio() >= LOW_MEMORY_ON) return 0;
  const candidates = [];
  for (const m of managers) {
    for (const tab of m.tabs) {
      if (tab.view && tab.id !== m.activeId) candidates.push(tab);
    }
  }
  candidates.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  let done = 0;
  for (const tab of candidates) {
    if (done >= LOW_MEMORY_MAX) break;
    if (!tab.owner || !tab.owner.discardTab(tab)) continue; // refuses audible, loading, popups
    done++;
    if (freeRamRatio() > LOW_MEMORY_OFF) break;
  }
  return done;
}

// powerMonitor is only usable after app 'ready'; this runs from the first TabManager, i.e. after it.
function wirePower() {
  if (powerWired) return;
  powerWired = true;
  try {
    const pm = require('electron').powerMonitor;
    onBattery = !!pm.isOnBatteryPower();
    pm.on('on-battery', () => { onBattery = true; });
    pm.on('on-ac', () => { onBattery = false; });
  } catch (e) {
    log('power monitor unavailable:', e && e.message);
  }
}

// ── Lite mode ──────────────────────────────────────────────────────────────
// Reduced-motion emulation needs a debugger session per tab. It is attached only to http(s) pages,
// detached when Lite is off, when the page leaves http(s), and while DevTools is open. Emulation is
// cleared when the session detaches, so releasing is enough to undo it.

function releaseLite(tab) {
  if (!tab.liteEmu) return;
  tab.liteEmu = false;
  const wc = tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  } catch { /* already detached */ }
}

// Idempotent: re-sent after every main-frame navigation, so the override is never lost across
// cross-process navigations (persistence per target is not relied on).
function syncLite(tab) {
  const wc = tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  let url = '';
  let devtools = false;
  try {
    url = wc.getURL() || tab.url || '';
    devtools = wc.isDevToolsOpened();
  } catch { return; }
  if (!liteOn || devtools || !isHttpUrl(url)) {
    releaseLite(tab);
    return;
  }
  try {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach(REDUCED_MOTION_PROTOCOL); // throws if another client holds the target
    if (tab.dbgWc !== wc) {
      tab.dbgWc = wc;
      const onDetach = () => { tab.liteEmu = false; };
      dbg.on('detach', onDetach);
      tab.disposers.push(() => { try { dbg.removeListener('detach', onDetach); } catch { /* gone */ } });
    }
    tab.liteEmu = true;
    dbg.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    }).catch(() => { /* target gone or navigation pending; the next navigation re-sends */ });
  } catch (e) {
    tab.liteEmu = false;
    log('reduced-motion emulation failed:', e && e.message);
  }
}

// Turns Lite on or off: blocking's lite lists, then every open tab.
function applyLiteMode(on) {
  liteOn = !!on;
  try {
    const blocking = require('./blocking'); // owned by B1; absent or failing is not fatal
    if (blocking && typeof blocking.setLiteMode === 'function') blocking.setLiteMode(liteOn);
  } catch (e) {
    log('blocking lite mode not applied:', e && e.message);
  }
  for (const m of managers) {
    for (const tab of m.tabs) syncLite(tab);
  }
}

function policyKey(s) {
  return [s.liteMode === true, s.smartSleep === true, Number(s.tabDiscardMinutes) || 0].join('|');
}

function onSettingsChanged(s) {
  const key = policyKey(s);
  if (key === lastPolicyKey) return;
  lastPolicyKey = key;
  const lite = s.liteMode === true;
  if (lite !== liteOn) applyLiteMode(lite);
  sweepAll(); // new delays apply now instead of at the next tick
}

// Called once from registerIpc (startup, after storage.init).
function wirePolicy() {
  if (policyWired) return;
  policyWired = true;
  const s = settingsSafe();
  lastPolicyKey = policyKey(s);
  try {
    storage.settings.onChange(onSettingsChanged);
  } catch (e) {
    log('settings listener failed:', e && e.message);
  }
  applyLiteMode(s.liteMode === true); // startup: tells blocking the current mode
}

// ── IPC ──────────────────────────────────────────────────────────────────

function senderManager(event) {
  if (!security.isChromeSender(event)) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const st = win ? windows.getState(win) : null;
  return st && st.tabs && !st.tabs.destroyed ? st.tabs : null;
}

// ── Lookups and discarding for other main-process modules (performance.js, blocking.js) ─────

// -> { manager, tab } for the tab whose live view has this webContents id, or null.
function findTabByWebContentsId(id) {
  if (!Number.isInteger(id)) return null;
  for (const m of managers) {
    for (const tab of m.tabs) {
      const wc = tab.view && tab.view.webContents;
      if (wc && !wc.isDestroyed() && wc.id === id) return { manager: m, tab };
    }
  }
  return null;
}

// -> [{ manager, tab }] for every tab of every window (live or discarded).
function allTabs() {
  const out = [];
  for (const m of managers) {
    if (m.destroyed) continue;
    for (const tab of m.tabs) out.push({ manager: m, tab });
  }
  return out;
}

// Discards one tab (destroys its view, keeps history). Refuses the active tab, audible or loading
// tabs, tabs with open popups and tabs that are already discarded. -> true when discarded.
function discardTab(manager, tabId) {
  if (!manager || manager.destroyed || !managers.has(manager)) return false;
  const tab = manager.get(tabId);
  if (!tab || !tab.view) return false;
  if (tab.id === manager.activeId || tab.isAudible || tab.isLoading || tab.popups > 0) return false;
  return manager.discardTab(tab);
}

function registerIpc(ipcMain) {
  wirePolicy();
  ipcMain.handle('tabs:list', (event) => {
    const m = senderManager(event);
    if (!m) return [];
    // The UI asks for the list at boot and after reloads: send it the current group and split state too.
    m.emitGroups();
    m.emitSplit();
    return m.list();
  });

  ipcMain.handle('tabs:create', (event, opts) => {
    const m = senderManager(event);
    if (!m) return null;
    const o = plain(opts);
    const tab = m.createTab({
      url: o.url,
      user: true,
      active: o.active !== false,
      index: Number.isInteger(o.index) ? o.index : undefined,
    });
    return tab ? tab.id : null;
  });

  ipcMain.on('tabs:close', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.closeTab(id);
  });
  ipcMain.on('tabs:activate', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.activate(id, { focus: true });
  });
  ipcMain.on('tabs:move', (event, id, toIndex) => {
    const m = senderManager(event);
    if (m && isId(id)) m.move(id, toIndex);
  });
  ipcMain.on('tabs:reopen-closed', (event) => {
    const m = senderManager(event);
    if (m) m.reopenClosed();
  });
  ipcMain.on('tabs:navigate', (event, id, url) => {
    const m = senderManager(event);
    if (m && isId(id)) m.navigate(id, url);
  });
  ipcMain.on('tabs:back', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.back(id);
  });
  ipcMain.on('tabs:forward', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.forward(id);
  });
  ipcMain.on('tabs:reload', (event, id, ignoreCache) => {
    const m = senderManager(event);
    if (m && isId(id)) m.reload(id, ignoreCache === true);
  });
  ipcMain.on('tabs:stop', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.stop(id);
  });
  ipcMain.handle('tabs:zoom', (event, id, dir) => {
    const m = senderManager(event);
    if (!m || !isId(id) || !['in', 'out', 'reset'].includes(dir)) return null;
    return m.zoom(id, dir);
  });
  ipcMain.on('tabs:find', (event, id, text, opts) => {
    const m = senderManager(event);
    if (m && isId(id)) m.find(id, text, opts);
  });
  ipcMain.on('tabs:stop-find', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.stopFind(id);
  });
  ipcMain.on('tabs:devtools', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.toggleDevTools(id);
  });
  ipcMain.on('tabs:mute', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.toggleMute(id);
  });
  ipcMain.on('tabs:context-menu', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.showTabMenu(id);
  });
  ipcMain.on('tabs:detach', (event, id, x, y) => {
    const st = windows.senderState(event);
    if (st) windows.detachTab(st, id, x, y);
  });
  // 2.5 — drag-out preview (main/drag-preview.js, F3). 'start' (id, x, y) snapshots the tab once and shows the
  // window; 'move' (x, y) follows the pointer (the UI sends at most one per frame); 'end' hides it.
  ipcMain.on('tabs:drag-preview', (event, op, id, x, y) => {
    const st = windows.senderState(event);
    if (!st || !st.tabs || st.tabs.destroyed) return;
    const finite = (n) => typeof n === 'number' && Number.isFinite(n);
    if (op === 'start') {
      const tab = isId(id) && finite(x) && finite(y) ? st.tabs.get(id) : null;
      if (tab) dragPreview.begin(tab, x, y);
    } else if (op === 'move') {
      if (finite(x) && finite(y)) dragPreview.move(x, y);
    } else if (op === 'end') {
      dragPreview.end();
    }
  });
  ipcMain.on('tabs:mute-others', (event, id) => {
    const m = senderManager(event);
    if (m && isId(id)) m.muteOthers(id);
  });
  // 2.4 pinned tabs: pure.tabs.pin(id, pinned)
  ipcMain.on('tabs:pin', (event, id, pinned) => {
    const m = senderManager(event);
    if (m && isId(id) && typeof pinned === 'boolean') m.setPinned(id, pinned);
  });

  // ── 2.2 groups ──
  ipcMain.handle('groups:list', (event) => {
    const m = senderManager(event);
    return m ? m.groupsList() : [];
  });
  ipcMain.handle('groups:create', (event, tabIds, opts) => {
    const m = senderManager(event);
    if (!m || !Array.isArray(tabIds) || tabIds.length > 500) return null;
    const o = plain(opts);
    return m.groupCreate(tabIds.filter(isId), { title: o.title, color: o.color });
  });
  ipcMain.on('groups:update', (event, groupId, patch) => {
    const m = senderManager(event);
    if (m && isGroupId(groupId)) m.groupUpdate(groupId, plain(patch));
  });
  ipcMain.on('groups:add-tab', (event, tabId, groupId) => {
    const m = senderManager(event);
    if (m && isId(tabId) && isGroupId(groupId)) m.groupAddTab(tabId, groupId);
  });
  ipcMain.on('groups:remove-tab', (event, tabId) => {
    const m = senderManager(event);
    if (m && isId(tabId)) m.groupRemoveTab(tabId);
  });
  ipcMain.on('groups:ungroup', (event, groupId) => {
    const m = senderManager(event);
    if (m && isGroupId(groupId)) m.groupUngroup(groupId);
  });

  // ── 2.2 split view ──
  ipcMain.on('split:open', (event, tabId, otherTabId) => {
    const m = senderManager(event);
    if (!m || !isId(tabId)) return;
    if (otherTabId !== undefined && otherTabId !== null && !isId(otherTabId)) return;
    m.splitOpen(tabId, otherTabId === undefined ? null : otherTabId);
  });
  ipcMain.on('split:close', (event) => {
    const m = senderManager(event);
    if (m) m.endSplit();
  });
  ipcMain.on('split:ratio', (event, ratio) => {
    const m = senderManager(event);
    if (m && typeof ratio === 'number') m.splitRatio(ratio);
  });
  ipcMain.on('split:focus', (event, side) => {
    const m = senderManager(event);
    if (m && (side === 'left' || side === 'right')) m.splitFocus(side);
  });
}

Object.assign(module.exports, {
  TabManager,
  registerIpc,
  navPolicy,
  safeUrl,
  searchUrl,
  homepageUrl,
  isBlankTabUrl,
  findTabByWebContentsId,
  allTabs,
  discardTab,
  SPLIT_GAP,
  tabEvents,
});
