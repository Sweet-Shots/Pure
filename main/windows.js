// Browser windows: BrowserWindow creation and registry, win:* / ui:* IPC, page freeze,
// session snapshot/restore and moving tabs between windows.
// Circular requires (tabs/shortcuts) are safe: module.exports is only extended, never replaced.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage, nativeTheme, screen } = require('electron');
const sessions = require('./sessions');
const storage = require('./storage');
const logger = require('./logger');
const security = require('./security');
const shortcuts = require('./shortcuts');
const tabsModule = require('./tabs');
const dragPreview = require('./drag-preview'); // 2.5 — F3: the window that follows a dragged-out tab

const UI_URL = 'pure://browser/index.html';
const UI_PRELOAD = path.join(__dirname, '..', 'preload', 'chrome.js');
const BG_DARK = '#111111';
const BG_LIGHT = '#f5f5f5';
const TAB_STRIP_HEIGHT = 40;
const SESSION_DEBOUNCE_MS = 2000;
const MAX_RESTORE_TABS = 200;
const MAX_RESTORE_WINDOWS = 50;
// 2.4 session files (profile/): the window snapshot keeps pinned flags, which storage's session.json drops.
const SESSION_FILE = 'windows-session.json';
const CRASH_FILE = 'windows-session-crash.json';   // a crashed session kept until the user answers the offer
const MARKER_FILE = 'running.lock';                // present while Pure runs; removed by markCleanExit()
const SNAPSHOT_VERSION = 1;

const states = new Map(); // BrowserWindow -> window state
let nextWindowId = 1;
let sessionTimer = null;
let lastSnapshot = [];
let lastWritten = '';        // JSON of the last live snapshot written (skips identical writes)
let writeChain = Promise.resolve();
let crashOffer = null;       // windows of a crashed session the user has not answered (restoreSession off)

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

// createWindow({ incognito, urls, saved, pinned, bounds, empty, detached })
//   urls:   http(s) URLs opened as tabs (first one active); default is one home tab
//   saved:  restore data from sanitizeSaved() (tabs, activeIndex, groups, split); tabs open lazily
//   pinned: [{url, title}] pinned tabs opened first, unloaded (2.4); ignored when `saved` is given
//   bounds: { x, y } optional screen position
//   empty:  create no tabs (used when tabs are moved in right after creation)
//   detached: 2.5 — the window was made by dragging a tab out: no welcome animation (win:info.skipWelcome) and
//           no address-bar focus (the dragged tab is not a new tab)
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
    detached: !!opts.detached, // 2.5 — F3: made by a drag-out (no welcome, no address-bar focus)
    uiReady: false,            // the browser UI has loaded once (TabManager.focusAddressBar waits for it)
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

  wc.once('did-finish-load', () => onUiLoaded(state));
  wc.loadURL(UI_URL).catch((e) => log('UI load failed:', e && e.message));

  if (opts.saved && Array.isArray(opts.saved.tabs) && opts.saved.tabs.length) {
    restoreTabs(state.tabs, opts.saved);
  } else {
    if (Array.isArray(opts.pinned)) addPinned(state.tabs, opts.pinned);
    if (!opts.empty) {
      const urls = Array.isArray(opts.urls) ? opts.urls.filter(isOpenableUrl) : [];
      if (urls.length) {
        urls.forEach((url, i) => state.tabs.createTab({ url, active: i === 0, user: false }));
      } else {
        state.tabs.createTab({ active: true });
      }
    }
  }
  return win;
}

// Pinned tabs are created unloaded (no webContents until clicked), in saved order.
function addPinned(mgr, pins) {
  for (const p of pins) {
    if (p && isRestorableUrl(p.url)) mgr.createTab({ url: p.url, title: p.title, active: false, user: true, pinned: true });
  }
}

// Restores tabs (pinned ones first, unloaded) plus their groups and split. The active tab is the saved one, but
// a pinned tab is never the one that loads at startup while the window has an unpinned tab.
function restoreTabs(mgr, saved) {
  const created = saved.tabs.map((t) => mgr.createTab({
    url: t.url,
    title: t.title,
    active: false,
    user: true,
    pinned: t.pinned === true,
  }));
  const valid = created.filter(Boolean);
  if (!valid.length) return;
  mgr.applySavedLayout(created, saved);
  const idx = clamp(Number.isInteger(saved.activeIndex) ? saved.activeIndex : 0, 0, created.length - 1);
  let target = created[idx] || valid[0];
  if (target.pinned) target = valid.find((t) => !t.pinned) || target;
  mgr.activate(target.id, { focus: false });
}

// The browser UI of a window has loaded (first time only). When the window's active tab is a blank new tab (startup,
// Ctrl+N, a restored home page), the caret goes to the address bar if focusAddressBarOnNewTab is on.
function onUiLoaded(state) {
  state.uiReady = true;
  if (state.detached || !state.tabs || state.tabs.destroyed) return;
  const active = state.tabs.activeTab();
  if (active && tabsModule.isBlankTabUrl(active.url)) state.tabs.focusAddressBar();
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
  if (states.size === 0) dragPreview.destroy(); // 2.5 — no browser window left: release the preview window
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
  dragPreview.end(); // 2.5 — the drop (or a drop back on the strip) ends the drag preview
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
    const win = createWindow({
      incognito: srcState.incognito,
      empty: true,
      bounds: pos || undefined,
      detached: true, // 2.5 — no welcome animation for a window made by dragging a tab out
    });
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

function profileDir() {
  return path.join(app.getPath('userData'), 'profile');
}

function profilePath(name) {
  return path.join(profileDir(), name);
}

async function fileExists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function removeQuiet(file) {
  try {
    await fs.promises.unlink(file);
  } catch { /* already gone */ }
}

// Saved windows from a snapshot file: null when there is no file, [] when it cannot be read.
async function readSnapshot(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    return sanitizeSaved(data && Array.isArray(data.windows) ? data.windows : []);
  } catch (e) {
    log('session file unreadable:', e && e.message);
    return [];
  }
}

// Atomic write (temp file + rename). Writes are queued, so they never interleave. `dedupe` skips the write
// when the content did not change since the last live write.
function writeSnapshot(name, windows, { dedupe = false } = {}) {
  const json = JSON.stringify({ v: SNAPSHOT_VERSION, windows });
  writeChain = writeChain.then(async () => {
    if (dedupe && json === lastWritten) return;
    await fs.promises.mkdir(profileDir(), { recursive: true });
    const file = profilePath(name);
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, json, 'utf8');
    await fs.promises.rename(tmp, file);
    if (dedupe) lastWritten = json;
  }).catch((e) => log('session save failed:', e && e.message));
  return writeChain;
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

// Live snapshot, written whatever restoreSession is: crash recovery needs it. Startup decides what to use.
function writeSession() {
  return writeSnapshot(SESSION_FILE, refreshSnapshot(), { dedupe: true });
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

// Pinned tabs of saved windows, in order. They reopen at every startup.
function pinnedOf(windows) {
  const out = [];
  for (const w of windows) {
    for (const t of w.tabs) if (t.pinned) out.push({ url: t.url, title: t.title || '' });
  }
  return out;
}

// What a clean exit keeps when restoreSession is off: the pinned tabs only.
function pinnedOnly(windows) {
  return windows
    .map((w) => ({ tabs: w.tabs.filter((t) => t.pinned), activeIndex: 0 }))
    .filter((w) => w.tabs.length);
}

// The part of a saved window that is not pinned. Pinned tabs come first in saved windows, so the rest is a
// suffix: indexes shift by the number of pinned tabs.
function unpinnedPart(w) {
  const P = w.tabs.filter((t) => t.pinned).length;
  const tabs = w.tabs.slice(P);
  const sp = w.split;
  const split = sp && sp.left >= P && sp.right >= P
    ? { left: sp.left - P, right: sp.right - P, ratio: sp.ratio }
    : null;
  return {
    tabs,
    activeIndex: Math.max(0, (Number.isInteger(w.activeIndex) ? w.activeIndex : 0) - P),
    groups: w.groups || [],
    split,
  };
}

// Windows of a crash snapshot that have something besides pinned tabs to offer.
function offerOf(windows) {
  return windows.filter((w) => w.tabs.some((t) => !t.pinned));
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
    // Valid tabs keep their order; pinned ones move to the front (pinned tabs never belong to a group).
    const kept = [];
    w.tabs.slice(0, MAX_RESTORE_TABS).forEach((t, i) => {
      if (t && typeof t === 'object' && isRestorableUrl(t.url)) kept.push({ t, i });
    });
    if (!kept.length) continue;
    const ordered = [...kept.filter((k) => k.t.pinned === true), ...kept.filter((k) => k.t.pinned !== true)];
    const tabs = [];
    const remap = new Map(); // saved index -> index in `tabs`
    for (const { t, i } of ordered) {
      const entry = { url: t.url, title: typeof t.title === 'string' ? t.title.slice(0, 300) : '' };
      if (t.pinned === true) entry.pinned = true;
      else if (Number.isInteger(t.group) && t.group >= 0 && t.group < groups.length) entry.group = t.group;
      remap.set(i, tabs.length);
      tabs.push(entry);
    }
    const savedActive = Number.isInteger(w.activeIndex) ? w.activeIndex : 0;
    const activeIndex = remap.has(savedActive) ? remap.get(savedActive) : 0;
    const sp = w.split;
    let split = null;
    if (sp && Number.isInteger(sp.left) && Number.isInteger(sp.right) && sp.left !== sp.right &&
        remap.has(sp.left) && remap.has(sp.right)) {
      const l = remap.get(sp.left);
      const r = remap.get(sp.right);
      if (!tabs[l].pinned && !tabs[r].pinned) {
        split = { left: l, right: r, ratio: Number.isFinite(sp.ratio) ? clamp(sp.ratio, 0.2, 0.8) : 0.5 };
      }
    }
    out.push({ tabs, activeIndex, groups, split });
  }
  return out;
}

// Called by index.js at startup.
//  - restoreSession on: restores the saved windows (pinned tabs unloaded), exactly as before.
//  - restoreSession off: one new window with the pinned tabs plus argv URLs (or a home tab). If the marker shows
//    the last run crashed, the unpinned tabs of that run are offered once (sticky toast, see showCrashOffer).
async function restoreOrCreate(argvUrls = []) {
  const urls = (Array.isArray(argvUrls) ? argvUrls : []).filter(isOpenableUrl);
  const restore = restoreEnabled();
  const crashed = await fileExists(profilePath(MARKER_FILE));
  let saved = await readSnapshot(profilePath(SESSION_FILE));
  if (saved === null && restore) {
    // Upgrade path: the windows of an earlier version are in storage's session.json.
    try {
      saved = sanitizeSaved(await storage.session.load());
    } catch (e) {
      log('session load failed:', e && e.message);
    }
  }
  saved = saved || [];

  crashOffer = null;
  if (!crashed) {
    await removeQuiet(profilePath(CRASH_FILE));
  } else if (restore) {
    await removeQuiet(profilePath(CRASH_FILE)); // the normal session is restored below; nothing to offer
  } else {
    const aside = await readSnapshot(profilePath(CRASH_FILE));
    if (aside !== null) {
      // An earlier crash is still unanswered: keep its snapshot.
      crashOffer = offerOf(aside);
      if (!crashOffer.length) await removeQuiet(profilePath(CRASH_FILE));
    } else {
      // Move this crash's snapshot aside, so the writes of this run cannot overwrite it before the user answers.
      crashOffer = offerOf(saved);
      if (crashOffer.length) {
        try {
          await fs.promises.rename(profilePath(SESSION_FILE), profilePath(CRASH_FILE));
          lastWritten = '';
        } catch (e) {
          log('crash snapshot not kept:', e && e.message);
        }
      }
    }
    if (!crashOffer.length) crashOffer = null;
  }

  // The marker says "running": a crash leaves it behind.
  try {
    await fs.promises.mkdir(profileDir(), { recursive: true });
    await fs.promises.writeFile(profilePath(MARKER_FILE), String(process.pid), 'utf8');
  } catch (e) {
    log('running marker not written:', e && e.message);
  }

  if (restore && saved.length) {
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

  const win = createWindow({ urls, pinned: restore ? [] : pinnedOf(saved) });
  // The toast waits for the page to finish loading (a message sent during did-finish-load is dropped by the toast
  // module, which is still "loading" then), so it goes out on the next tick.
  if (crashOffer) win.webContents.once('did-finish-load', () => setTimeout(() => showCrashOffer(win), 50));
  return win;
}

// Sticky toast in the first window: "Pure didn't close properly. Restore your tabs?" (E5's main/toast.js).
// If the toast module is missing or fails, the offer stays pending and is logged, nothing else changes.
function showCrashOffer(win) {
  if (!crashOffer || win.isDestroyed()) return;
  let toast = null;
  try {
    toast = require('./toast');
  } catch (e) {
    log('crash offer not shown (toast unavailable):', e && e.message);
    return;
  }
  if (!toast || typeof toast.show !== 'function') return;
  try {
    toast.show(win, {
      id: 'restore',
      kind: 'info',
      text: "Pure didn't close properly. Restore your tabs?",
      actions: [{ id: 'restore', label: 'Restore' }],
    }, (actionId) => answerCrashOffer(actionId, win));
  } catch (e) {
    log('crash offer failed:', e && e.message);
  }
}

// The user answered the offer. "restore" reopens the unpinned tabs: the first saved window's tabs go into the
// window that showed the offer, the others open as new windows. Any other answer forgets them.
function answerCrashOffer(actionId, win) {
  const offer = crashOffer;
  if (!offer) return;
  // The toast reports 'dismiss' when its window closes too; closing is not an answer, so the offer stays for the
  // next start (markCleanExit keeps the marker and the crash snapshot while it is pending).
  if (actionId !== 'restore' && (!win || win.isDestroyed())) return;
  crashOffer = null;
  if (actionId === 'restore') {
    let into = win && !win.isDestroyed() ? getState(win) : null; // the first saved window goes here, once
    for (const w of offer) {
      const part = unpinnedPart(w);
      if (!part.tabs.length) continue;
      if (into && into.tabs && !into.tabs.destroyed) {
        restoreTabs(into.tabs, part);
        into = null;
      } else {
        createWindow({ saved: part });
      }
    }
  }
  removeQuiet(profilePath(CRASH_FILE)).then(() => scheduleSessionSave());
}

// Called by index.js at the end of quit. A clean exit keeps every window when restoreSession is on, and only the
// pinned tabs when it is off; then the running marker goes. While the crash offer is unanswered, the marker and
// the crash snapshot stay, so the next start asks again.
async function markCleanExit() {
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
  if (crashOffer) return;
  const snap = refreshSnapshot();
  await writeSnapshot(SESSION_FILE, restoreEnabled() ? snap : pinnedOnly(snap));
  await removeQuiet(profilePath(MARKER_FILE));
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
      skipWelcome: st.detached === true, // 2.5 — welcome.js skips the overlay (windows made by a drag-out)
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
  markCleanExit,
  registerIpc,
});
