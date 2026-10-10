// Browser windows: BrowserWindow creation and registry, win:* / ui:* IPC, page freeze,
// session snapshot/restore and moving tabs between windows.
// Circular requires (tabs/shortcuts) are safe: module.exports is only extended, never replaced.

const path = require('path');
const { app, BrowserWindow, nativeImage, nativeTheme, screen } = require('electron');
const sessions = require('./sessions');
const storage = require('./storage');
const logger = require('./logger');
const security = require('./security');
const shortcuts = require('./shortcuts');
const tabsModule = require('./tabs');

const UI_URL = 'pure://browser/index.html';
const UI_PRELOAD = path.join(__dirname, '..', 'preload', 'chrome.js');
const BG_DARK = '#111111';
const BG_LIGHT = '#f5f5f5';
const TAB_STRIP_HEIGHT = 40;
const SESSION_DEBOUNCE_MS = 2000;
const MAX_RESTORE_TABS = 200;
const MAX_RESTORE_WINDOWS = 50;

const states = new Map(); // BrowserWindow -> window state
let nextWindowId = 1;
let sessionTimer = null;
let lastSnapshot = [];

function log(...args) {
  try { logger.log(...args); } catch { /* ignore */ }
}

function settingsSafe() {
  try { return storage.settings.get() || {}; } catch { return {}; }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isOpenableUrl = (u) => typeof u === 'string' && u.length <= 4096 && /^https?:\/\//i.test(u);
const isRestorableUrl = (u) => typeof u === 'string' && u.length <= 4096 &&
  (/^https?:\/\//i.test(u) || u.startsWith('pure://')) && security.isSafeNavigationUrl(u);

// ── Registry ─────────────────────────────────────────────────────────────

function getState(win) {
  return win ? (states.get(win) || null) : null;
}

// Validates the sender is the browser UI and returns its window state (or null).
function senderState(event) {
  if (!security.isChromeSender(event)) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  return getState(win);
}

function getTabManager(win) {
  const st = getState(win);
  return st ? st.tabs : null;
}

function getBrowserWindows() {
  return [...states.values()].map((s) => s.win).filter((w) => !w.isDestroyed());
}

function isIncognitoWindow(win) {
  const st = getState(win);
  return !!(st && st.incognito);
}

function lastFocusedState(filter) {
  let best = null;
  for (const st of states.values()) {
    if (st.win.isDestroyed()) continue;
    if (filter && st.incognito !== filter.incognito) continue;
    if (!best || st.lastFocus > best.lastFocus) best = st;
  }
  return best;
}

function getLastFocusedBrowserWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && states.has(focused)) return focused;
  const st = lastFocusedState(null);
  return st ? st.win : null;
}

// ── Window background (shows before the page paints; follows the Windows theme) ─────

function windowBackground() {
  let dark = true;
  try { dark = nativeTheme.shouldUseDarkColors; } catch { /* keep the dark default */ }
  return dark ? BG_DARK : BG_LIGHT;
}

let lastBackground = '';
let themeWired = false;

// One nativeTheme listener for the process; repaints every window only when the colour changes.
function wireTheme() {
  if (themeWired) return;
  themeWired = true;
  lastBackground = windowBackground();
  try {
    nativeTheme.on('updated', () => {
      const bg = windowBackground();
      if (bg === lastBackground) return;
      lastBackground = bg;
      for (const w of getBrowserWindows()) {
        try { w.setBackgroundColor(bg); } catch { /* window closing */ }
      }
    });
  } catch (e) {
    log('nativeTheme unavailable:', e && e.message);
  }
}

// ── Creating windows ─────────────────────────────────────────────────────

// createWindow({ incognito, urls, saved, bounds, empty })
//   urls:   http(s) URLs opened as tabs (first one active); default is one home tab
//   saved:  restore data from sanitizeSaved() (tabs, activeIndex, groups, split); tabs open lazily
//   bounds: { x, y } optional screen position
//   empty:  create no tabs (used when tabs are moved in right after creation)
function createWindow(opts = {}) {
  const incognito = !!opts.incognito;
  const id = nextWindowId++;
  const session = sessions.getSession({ incognito, windowId: id });
  wireTheme();
  const options = {
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    frame: false,
    show: false,
    backgroundColor: windowBackground(),
    roundedCorners: true,
    webPreferences: {
      session,
      preload: UI_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  };
  const b = opts.bounds;
  if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
    options.x = Math.round(b.x);
    options.y = Math.round(b.y);
  }

  const win = new BrowserWindow(options);
  const state = {
    id,
    win,
    incognito,
    session,
    tabs: null,
    bounds: null, // page rectangle reported by the UI (ui:content-bounds)
    frozen: false,
    freezeToken: 0,
    lastShot: null,
    htmlFullscreen: 0,
    lastFocus: Date.now(),
  };
  states.set(win, state);
  state.tabs = new tabsModule.TabManager(win, state);

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('maximize', () => sendMaximized(state, true));
  win.on('unmaximize', () => sendMaximized(state, false));
  win.on('focus', () => { state.lastFocus = Date.now(); });
  win.on('resize', () => {
    if (state.htmlFullscreen) state.tabs.applyLayout();
  });
  win.on('close', () => {
    // Save while this window still exists so a close-all quit keeps its tabs.
    saveSession();
  });
  win.on('closed', () => onWindowClosed(state));

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.setVisualZoomLevelLimits(1, 1).catch(() => { /* ignore */ });
  const lockNavigation = (event) => {
    const url = event && typeof event.url === 'string' ? event.url : '';
    if (!url.startsWith('pure://browser/')) event.preventDefault();
  };
  wc.on('will-navigate', lockNavigation);
  wc.on('will-frame-navigate', lockNavigation);
  wc.on('will-redirect', lockNavigation);
  wc.on('render-process-gone', (_e, details) => {
    log('browser UI renderer gone:', details && details.reason);
    if (details && details.reason !== 'clean-exit' && !win.isDestroyed()) {
      wc.loadURL(UI_URL).catch(() => { /* ignore */ });
    }
  });
  shortcuts.attach(wc, win, state.tabs);

  wc.loadURL(UI_URL).catch((e) => log('UI load failed:', e && e.message));

  if (opts.saved && Array.isArray(opts.saved.tabs) && opts.saved.tabs.length) {
    restoreTabs(state.tabs, opts.saved);
  } else if (!opts.empty) {
    const urls = Array.isArray(opts.urls) ? opts.urls.filter(isOpenableUrl) : [];
    if (urls.length) {
      urls.forEach((url, i) => state.tabs.createTab({ url, active: i === 0, user: false }));
    } else {
      state.tabs.createTab({ active: true });
    }
  }
  return win;
}

function restoreTabs(mgr, saved) {
  const created = saved.tabs.map((t) => mgr.createTab({ url: t.url, title: t.title, active: false, user: true }));
  const valid = created.filter(Boolean);
  if (!valid.length) return;
  mgr.applySavedLayout(created, saved);
  const idx = clamp(Number.isInteger(saved.activeIndex) ? saved.activeIndex : 0, 0, created.length - 1);
  const target = created[idx] || valid[0];
  mgr.activate(target.id, { focus: false });
}

function onWindowClosed(state) {
  states.delete(state.win);
  try {
    state.tabs.destroy();
  } catch (e) {
    log('tab teardown failed:', e && e.message);
  }
  if (state.incognito) {
    try { sessions.destroyIncognitoSession(state.id); } catch (e) { log('destroy session failed:', e && e.message); }
  }
  scheduleSessionSave();
}

function sendMaximized(state, value) {
  if (!state.win.isDestroyed()) state.win.webContents.send('win:maximized', value);
}

// Opens a URL the OS handed us (argv, second instance). Reuses the last focused normal window.
function openUrl(url, opts = {}) {
  if (!isOpenableUrl(url)) return;
  if (!opts.newWindow) {
    const st = lastFocusedState({ incognito: false });
    if (st && st.tabs && !st.tabs.destroyed) {
      st.tabs.createTab({ url, active: true, user: false });
      if (st.win.isMinimized()) st.win.restore();
      st.win.show();
      st.win.focus();
      return;
    }
  }
  createWindow({ urls: [url] });
}

function openSettings(win, section) {
  const st = getState(win);
  if (st) st.tabs.openSettings(typeof section === 'string' ? section : '', true);
}

// ── Page freeze (overlays draw over a still image of the page) ────────────

async function freezePage(state, frozen) {
  if (!frozen) {
    state.freezeToken++;
    if (state.frozen) {
      state.frozen = false;
      state.lastShot = null;
      state.tabs.attachActive();
    }
    return null;
  }
  if (state.frozen) return state.lastShot;
  // The panes on screen now: the active tab, or both halves of a split. Read before `frozen` hides them.
  const shown = state.tabs.shownTabs();
  state.frozen = true; // set first so tabs activated during the capture stay detached
  const token = ++state.freezeToken;
  let shot = null;
  try {
    shot = await captureShot(shown);
  } catch (e) {
    log('freeze capture failed:', e && e.message);
  }
  if (token !== state.freezeToken || !state.frozen) return null;
  state.lastShot = shot;
  state.tabs.attachActive(); // frozen: every page view is detached
  return shot;
}

// One JPEG data URL for the given tabs. Two split panes are placed side by side with the split gap
// in between (window background colour); if that fails, the first pane's capture is used alone.
async function captureShot(tabs) {
  const live = tabs.filter((t) => t.view && !t.view.webContents.isDestroyed());
  if (!live.length) return null;
  const imgs = await Promise.all(live.map((t) => t.view.webContents.capturePage().catch(() => null)));
  let img = null;
  if (imgs.length === 2 && imgs[0] && imgs[1] && !imgs[0].isEmpty() && !imgs[1].isEmpty()) {
    try {
      const w = live[0].view.getBounds().width;
      const scale = w > 0 ? imgs[0].getSize().width / w : 1;
      img = sideBySide(imgs[0], imgs[1], Math.max(0, Math.round(tabsModule.SPLIT_GAP * scale)));
    } catch (e) {
      log('split freeze composite failed:', e && e.message);
    }
  }
  if (!img) img = imgs.find((x) => x && !x.isEmpty()) || null;
  if (!img || img.isEmpty()) return null;
  return 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64');
}

// Joins two equally tall captures horizontally. Raw BGRA pixels are copied row by row.
function sideBySide(a, b, gap) {
  const sa = a.getSize();
  const sb = b.getSize();
  if (sa.height !== sb.height || sa.width < 1 || sb.width < 1) return null;
  const h = sa.height;
  const rowA = sa.width * 4;
  const rowB = sb.width * 4;
  const w = sa.width + gap + sb.width;
  const pa = a.toBitmap();
  const pb = b.toBitmap();
  if (pa.length < rowA * h || pb.length < rowB * h) return null;
  const out = Buffer.alloc(w * h * 4);
  out.fill(Buffer.from([0x11, 0x11, 0x11, 0xff])); // BGRA of the dark window background, opaque
  const rowOut = w * 4;
  const offB = (sa.width + gap) * 4;
  for (let y = 0; y < h; y++) {
    pa.copy(out, y * rowOut, y * rowA, y * rowA + rowA);
    pb.copy(out, y * rowOut + offB, y * rowB, y * rowB + rowB);
  }
  return nativeImage.createFromBitmap(out, { width: w, height: h });
}

function sanitizeRect(r) {
  if (!r || typeof r !== 'object') return null;
  const v = (n) => (typeof n === 'number' && Number.isFinite(n) ? clamp(Math.round(n), 0, 20000) : NaN);
  const out = { x: v(r.x), y: v(r.y), width: v(r.width), height: v(r.height) };
  return Object.values(out).some(Number.isNaN) ? null : out;
}

// ── Detaching tabs into other windows ─────────────────────────────────────

function containsPoint(win, x, y, height) {
  const b = win.getBounds();
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + (height === undefined ? b.height : height);
}

function newWindowPosition(x, y) {
  try {
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    return {
      x: clamp(Math.round(x - 120), wa.x, wa.x + wa.width - 200),
      y: clamp(Math.round(y - 16), wa.y, wa.y + wa.height - 100),
    };
  } catch {
    return null;
  }
}

// Moves one tab from srcState to the window whose tab strip is under (screenX, screenY), or to a new
// window at that point. Live views move only between windows sharing a session; otherwise the tab is
// suspended (history kept) and restored on activation in the new session.
function detachTab(srcState, tabId, screenX, screenY) {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY) || !Number.isInteger(tabId)) return;
  const src = srcState.tabs;
  if (!src || src.destroyed || !src.get(tabId)) return;
  const srcWin = srcState.win;
  if (containsPoint(srcWin, screenX, screenY)) return; // dropped back on its own window

  let target = null;
  for (const st of states.values()) {
    if (st === srcState || st.win.isDestroyed() || st.win.isMinimized()) continue;
    if (st.incognito !== srcState.incognito) continue;
    if (containsPoint(st.win, screenX, screenY, TAB_STRIP_HEIGHT)) {
      target = st;
      break;
    }
  }
  const destSession = target ? target.session : (srcState.incognito ? null : srcState.session);
  const sameSession = destSession === srcState.session;

  const tab = src.release(tabId);
  if (!tab) return;
  if (!sameSession) src.suspend(tab);

  let dest = target;
  if (!dest) {
    const pos = newWindowPosition(screenX, screenY);
    const win = createWindow({ incognito: srcState.incognito, empty: true, bounds: pos || undefined });
    dest = getState(win);
  }
  dest.tabs.adopt(tab, { active: true, focus: true });
  if (!dest.win.isDestroyed()) dest.win.focus();

  if (src.count() === 0 && !srcWin.isDestroyed()) srcWin.close();
}

// ── Session snapshot / restore ────────────────────────────────────────────

function restoreEnabled() {
  return !!settingsSafe().restoreSession;
}

function takeSnapshot() {
  const out = [];
  for (const st of states.values()) {
    if (st.incognito || st.win.isDestroyed() || !st.tabs || st.tabs.destroyed) continue;
    const snap = st.tabs.sessionSnapshot();
    if (snap.tabs.length) out.push(snap);
  }
  return out;
}

// Keeps the last non-empty snapshot so closing the final window still leaves something to restore.
function refreshSnapshot() {
  const snap = takeSnapshot();
  if (snap.length) lastSnapshot = snap;
  return lastSnapshot;
}

function writeSession() {
  if (!restoreEnabled()) return Promise.resolve();
  try {
    return Promise.resolve(storage.session.save(refreshSnapshot())).catch((e) => log('session save failed:', e && e.message));
  } catch (e) {
    log('session save failed:', e && e.message);
    return Promise.resolve();
  }
}

// Debounced (2 s, coalesced) session write.
function scheduleSessionSave() {
  if (sessionTimer) return;
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    writeSession();
  }, SESSION_DEBOUNCE_MS);
}

// Immediate write; called by index.js before-quit and on window close.
function saveSession() {
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
  return writeSession();
}

// Validates one saved window: { tabs: [{url, title, group?}], activeIndex, groups: [{title, color,
// collapsed}], split?: {left, right, ratio} }. Indexes of tabs that are dropped are remapped, so group and
// split references follow the tabs that survive.
function sanitizeSaved(saved) {
  if (!Array.isArray(saved)) return [];
  const out = [];
  for (const w of saved.slice(0, MAX_RESTORE_WINDOWS)) {
    if (!w || !Array.isArray(w.tabs)) continue;
    const groups = Array.isArray(w.groups)
      ? w.groups.slice(0, MAX_RESTORE_TABS).map((g) => {
        const o = g && typeof g === 'object' ? g : {};
        return {
          title: typeof o.title === 'string' ? o.title.slice(0, 60) : '',
          color: typeof o.color === 'string' ? o.color.slice(0, 20) : 'grey',
          collapsed: o.collapsed === true,
        };
      })
      : [];
    const tabs = [];
    const remap = new Map(); // saved index -> index in `tabs`
    w.tabs.slice(0, MAX_RESTORE_TABS).forEach((t, i) => {
      if (!t || !isRestorableUrl(t.url)) return;
      const entry = { url: t.url, title: typeof t.title === 'string' ? t.title.slice(0, 300) : '' };
      if (Number.isInteger(t.group) && t.group >= 0 && t.group < groups.length) entry.group = t.group;
      remap.set(i, tabs.length);
      tabs.push(entry);
    });
    if (!tabs.length) continue;
    const savedActive = Number.isInteger(w.activeIndex) ? w.activeIndex : 0;
    const activeIndex = remap.has(savedActive) ? remap.get(savedActive) : clamp(savedActive, 0, tabs.length - 1);
    const sp = w.split;
    let split = null;
    if (sp && Number.isInteger(sp.left) && Number.isInteger(sp.right) && sp.left !== sp.right &&
        remap.has(sp.left) && remap.has(sp.right)) {
      split = {
        left: remap.get(sp.left),
        right: remap.get(sp.right),
        ratio: Number.isFinite(sp.ratio) ? clamp(sp.ratio, 0.2, 0.8) : 0.5,
      };
    }
    out.push({ tabs, activeIndex, groups, split });
  }
  return out;
}

// Called by index.js at startup. Restores saved windows when restoreSession is on, otherwise opens
// argv URLs (or a home tab) in one new window.
async function restoreOrCreate(argvUrls = []) {
  const urls = (Array.isArray(argvUrls) ? argvUrls : []).filter(isOpenableUrl);
  let saved = [];
  if (restoreEnabled()) {
    try {
      saved = sanitizeSaved(await storage.session.load());
    } catch (e) {
      log('session load failed:', e && e.message);
    }
  }
  if (!saved.length) return createWindow({ urls });
  let first = null;
  for (const s of saved) {
    const win = createWindow({ saved: s });
    if (!first) first = win;
  }
  const st = getState(first);
  if (st && urls.length) {
    for (const url of urls) st.tabs.createTab({ url, active: true, user: false });
  }
  return first;
}

// ── IPC ───────────────────────────────────────────────────────────────────

function registerIpc(ipc) {
  ipc.handle('win:info', (event) => {
    const st = senderState(event);
    if (!st) return null;
    return {
      version: app.getVersion(),
      windowId: st.id,
      isIncognito: st.incognito,
      isMaximized: st.win.isMaximized(),
      platform: process.platform,
    };
  });
  ipc.on('win:minimize', (event) => {
    const st = senderState(event);
    if (st) st.win.minimize();
  });
  ipc.on('win:toggle-maximize', (event) => {
    const st = senderState(event);
    if (!st) return;
    if (st.win.isMaximized()) st.win.unmaximize();
    else st.win.maximize();
  });
  ipc.on('win:close', (event) => {
    const st = senderState(event);
    if (st) st.win.close();
  });
  ipc.on('win:open-incognito', (event) => {
    if (senderState(event)) createWindow({ incognito: true });
  });
  ipc.on('win:new', (event) => {
    if (senderState(event)) createWindow({});
  });
  ipc.on('ui:content-bounds', (event, rect) => {
    const st = senderState(event);
    const r = sanitizeRect(rect);
    if (!st || !r) return;
    st.bounds = r;
    st.tabs.applyLayout();
  });
  ipc.handle('ui:freeze', (event, frozen) => {
    const st = senderState(event);
    if (!st) return null;
    return freezePage(st, !!frozen);
  });
}

Object.assign(module.exports, {
  createWindow,
  getBrowserWindows,
  getLastFocusedBrowserWindow,
  getTabManager,
  getState,
  senderState,
  isIncognitoWindow,
  openUrl,
  openSettings,
  detachTab,
  scheduleSessionSave,
  saveSession,
  restoreOrCreate,
  registerIpc,
});
