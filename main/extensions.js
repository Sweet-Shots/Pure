'use strict';
// Chrome extensions (C2, E1 for the compatibility layer). Only the persistent profile session (persist:pure) carries
// extensions. Incognito sessions are ignored here: incognito windows show no toolbar actions and run no extension code.
//
// What Electron 44 gives us (session.extensions, see electron.d.ts):
//  - loadExtension(folder) / removeExtension(id) / getAllExtensions(), and extension-loaded / -unloaded events.
//  - Loaded extensions are NOT remembered between runs, so every enabled one is loaded again in init().
//  - Toolbar actions are read from the manifest (action or browser_action). Their badges, titles, icons and popups
//    are driven by main/extension-api.js (chrome.action) and shown per window for the window's active tab.
//
// The compatibility layer (main/extension-api.js + preload/extension-api.js) is set up lazily: ensureApi() runs right
// before the first extension is loaded, so users without extensions register nothing.
//
// Store installs use electron-chrome-web-store (MIT). Its preload and IPC are registered lazily, the first time
// the Chrome Web Store is opened (or a store page is navigated to), so users without extensions never run them.
// Its own startup loader and 5 h update timer are disabled: enable/disable state is ours, and updates run from a
// single timer here that exists only while a store extension is loaded.
//
// State: userData/profile/extensions.json = { version, disabled: [id], unpacked: [{id, path}] }.
// Store installs live in userData/extensions/<id>/<version>_0 (the library's layout).

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, screen, session, webContents } = require('electron');
const { log } = require('./logger');
const security = require('./security');
const extApi = require('./extension-api');

// Required lazily: windows.js loads sessions.js, which loads this module during configure().
const windows = () => require('./windows');

const PERSIST_PARTITION = 'persist:pure';
const STORE_HOST = 'chromewebstore.google.com';
const STORE_URL = `https://${STORE_HOST}/`;
const ID_RE = /^[a-p]{32}$/;
const SAVE_DELAY_MS = 1000;
const REFRESH_DELAY_MS = 150;
const ACTION_PUSH_MS = 250; // toolbar updates are coalesced to at most 4 per second
const UPDATE_FIRST_MS = 5 * 60 * 1000;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000; // never more often than every 6 h
const POPUP_MIN = { w: 200, h: 100 };
const POPUP_MAX = { w: 800, h: 600 };
const POPUP_TIMEOUT_MS = 8000;
const ICON_MAX_BYTES = 128 * 1024;
const ICON_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
// Read in the popup's own page, so no extension code runs for the measurement.
const MEASURE_JS = '({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })';

// Manifest permissions with a plain-language label for the settings page.
const PERMISSION_LABELS = {
  tabs: 'Tabs',
  activeTab: 'Current tab',
  storage: 'Storage',
  cookies: 'Cookies',
  notifications: 'Notifications',
  contextMenus: 'Right-click menu',
  menus: 'Right-click menu',
  webNavigation: 'Page navigation',
  alarms: 'Alarms',
  scripting: 'Scripts on pages',
  webRequest: 'Network requests',
  webRequestBlocking: 'Block network requests',
  declarativeNetRequest: 'Block network requests',
  declarativeNetRequestWithHostAccess: 'Block network requests',
  idle: 'Idle state',
  unlimitedStorage: 'Unlimited storage',
  offscreen: 'Offscreen pages',
  clipboardRead: 'Read the clipboard',
  clipboardWrite: 'Write to the clipboard',
  geolocation: 'Location',
  windows: 'Windows',
  background: 'Runs in the background',
};
// Permissions Pure does not provide at all (the settings page warns about them).
const UNSUPPORTED_PERMISSIONS = new Set([
  'bookmarks', 'browsingData', 'commands', 'debugger', 'desktopCapture', 'downloads', 'fontSettings', 'history',
  'identity', 'nativeMessaging', 'pageCapture', 'power', 'privacy', 'proxy', 'readingList', 'search', 'sessions',
  'sidePanel', 'tabCapture', 'topSites', 'tts', 'ttsEngine', 'userScripts', 'vpnProvider', 'contentSettings', 'dns',
  'gcm', 'loginState', 'printerProvider', 'enterprise.deviceAttributes', 'webRequest', 'webRequestBlocking',
  'webRequestAuthProvider',
]);

let mainSession = null; // persist:pure, set by attach()
let storeSupport = null; // installChromeWebStore() promise, created on first use
let prefsLoad = null; // promise: extensions.json read once
let readyPromise = null; // promise: prefs loaded + first reconcile done
let queue = Promise.resolve(); // serialises load / unload / install-state work
let refreshTimer = null;
let updateTimer = null;
let actionTimer = null;
let lastUpdateAt = 0;
let watching = false;
let popup = null; // { id, win, parent, anchor, ready, sized, shown, timer }

const prefs = { disabled: new Set(), unpacked: [] };
let dirty = false;
let saveTimer = null;
let saveChain = Promise.resolve();

let catalog = []; // [{ id, source:'store'|'unpacked', path, manifest, messages }]
const errors = new Map(); // id -> message from the last failed load
let defaults = new Map(); // id -> { title, icon, popup } from the manifest, for loaded and enabled extensions
let extList = []; // Ext[] for the settings page

const iconCache = new Map(); // absolute file -> data URL | null
const messageCache = new Map(); // extension folder -> { key: message }

// ── Paths and small helpers ─────────────────────────────────────────────────

function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function extensionsDir() {
  return userDataPath('extensions');
}

function prefsFile() {
  return userDataPath('profile', 'extensions.json');
}

const validId = (id) => typeof id === 'string' && ID_RE.test(id);

function isHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isStoreUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === STORE_HOST;
  } catch {
    return false;
  }
}

function sanitizeRect(r) {
  if (!r || typeof r !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(20000, Math.max(0, v)) : NaN);
  const out = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
  return Object.values(out).some(Number.isNaN) ? null : out;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function text(value, max) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, max) : '';
}

// Dotted numeric compare for manifest versions ("1.10.0" > "1.9.2"). Non-numeric parts count as 0.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Only the sender that owns the settings tab may manage extensions.
function isSettingsSender(event) {
  if (!security.isInternalSender(event)) return false;
  const url = event.senderFrame && typeof event.senderFrame.url === 'string' ? event.senderFrame.url : '';
  return url.startsWith('pure://settings/');
}

function errorText(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.slice(0, 200);
}

// Serialises state changes: one load/unload/install at a time, and a failure never blocks the queue.
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch((err) => log('[extensions] task failed:', err));
  return run;
}

// The compatibility layer is registered once, right before the first extension is loaded.
function ensureApi() {
  if (mainSession) extApi.ensure(mainSession);
}

// ── Preferences (debounced, atomic) ────────────────────────────────────────

async function loadPrefs() {
  try {
    const obj = JSON.parse(await fs.promises.readFile(prefsFile(), 'utf8'));
    if (obj && Array.isArray(obj.disabled)) {
      for (const id of obj.disabled) if (validId(id)) prefs.disabled.add(id);
    }
    if (obj && Array.isArray(obj.unpacked)) {
      for (const u of obj.unpacked.slice(0, 100)) {
        if (u && validId(u.id) && typeof u.path === 'string' && path.isAbsolute(u.path)) {
          prefs.unpacked.push({ id: u.id, path: u.path });
        }
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') log('[extensions] could not read extensions.json:', err);
  }
}

function ensurePrefs() {
  if (!prefsLoad) prefsLoad = loadPrefs();
  return prefsLoad;
}

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writePrefs();
  }, SAVE_DELAY_MS);
}

function writePrefs() {
  dirty = false;
  const file = prefsFile();
  const data = JSON.stringify({
    version: 1,
    disabled: [...prefs.disabled].sort(),
    unpacked: prefs.unpacked.map((u) => ({ id: u.id, path: u.path })),
  }, null, 2);
  saveChain = saveChain
    .then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, file);
    })
    .catch((err) => log('[extensions] could not save extensions.json:', err));
  return saveChain;
}

// ── Scanning what is installed ─────────────────────────────────────────────

async function readManifest(dir) {
  try {
    const m = JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

// Chrome manifests may use __MSG_key__ placeholders; resolve them from _locales (app language first).
async function loadMessages(dir, manifest) {
  if (messageCache.has(dir)) return messageCache.get(dir);
  let out = {};
  const loc = String(app.getLocale() || 'en').replace('-', '_');
  const langs = [loc, loc.split('_')[0]];
  if (typeof manifest.default_locale === 'string') langs.push(manifest.default_locale);
  for (const lang of langs) {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(lang)) continue;
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(dir, '_locales', lang, 'messages.json'), 'utf8'));
      for (const [key, value] of Object.entries(raw || {})) {
        if (value && typeof value.message === 'string') out[key.toLowerCase()] = value.message;
      }
      break;
    } catch {
      out = {};
    }
  }
  messageCache.set(dir, out);
  return out;
}

function localize(entry, value, max = 200) {
  if (typeof value !== 'string') return '';
  const m = /^__MSG_(\w+)__$/.exec(value);
  const out = m ? entry.messages[m[1].toLowerCase()] || '' : value;
  return out.slice(0, max);
}

async function scanCatalog() {
  const found = [];
  const seen = new Set();

  // Store installs: <extensionsDir>/<id>/<version>_0 (newest version wins).
  let ids = [];
  try {
    ids = await fs.promises.readdir(extensionsDir(), { withFileTypes: true });
  } catch {
    ids = []; // nothing installed from the store yet
  }
  for (const dirent of ids) {
    if (!dirent.isDirectory() || !validId(dirent.name)) continue;
    const idDir = path.join(extensionsDir(), dirent.name);
    let versions = [];
    try {
      versions = await fs.promises.readdir(idDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let best = null;
    for (const v of versions) {
      if (!v.isDirectory()) continue;
      const dir = path.join(idDir, v.name);
      const manifest = await readManifest(dir);
      if (!manifest) continue;
      if (!best || compareVersions(manifest.version || '0', best.manifest.version || '0') > 0) {
        best = { dir, manifest };
      }
    }
    if (best && !seen.has(dirent.name)) {
      seen.add(dirent.name);
      found.push({ id: dirent.name, source: 'store', path: best.dir, manifest: best.manifest });
    }
  }

  // Unpacked folders the user chose (not copied; if the folder is gone the entry is skipped).
  for (const u of prefs.unpacked) {
    if (seen.has(u.id)) continue;
    const manifest = await readManifest(u.path);
    if (!manifest) continue;
    seen.add(u.id);
    found.push({ id: u.id, source: 'unpacked', path: u.path, manifest });
  }

  for (const entry of found) entry.messages = await loadMessages(entry.path, entry.manifest);
  return found;
}

// ── Icons and popup URLs ───────────────────────────────────────────────────

// manifest icon entries are either a path or a { "16": path, "32": path } map. Pick the closest size >= target.
function pickIconPath(spec, target) {
  if (typeof spec === 'string') return spec;
  if (!spec || typeof spec !== 'object') return '';
  const sizes = Object.keys(spec)
    .map(Number)
    .filter((n) => Number.isFinite(n) && typeof spec[n] === 'string')
    .sort((a, b) => a - b);
  if (!sizes.length) return '';
  const size = sizes.find((s) => s >= target) ?? sizes[sizes.length - 1];
  return spec[size];
}

async function readIcon(extDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 300 || path.isAbsolute(rel) || rel.includes('..')) return null;
  const type = ICON_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return null; // svg is not allowed: it is never shown as a data URL
  const root = path.resolve(extDir) + path.sep;
  const file = path.resolve(extDir, rel);
  if (!file.startsWith(root)) return null;
  if (iconCache.has(file)) return iconCache.get(file);
  let data = null;
  try {
    const st = await fs.promises.stat(file);
    if (st.isFile() && st.size <= ICON_MAX_BYTES) {
      data = `data:${type};base64,${(await fs.promises.readFile(file)).toString('base64')}`;
    }
  } catch {
    data = null;
  }
  iconCache.set(file, data);
  return data;
}

function iconFor(entry, spec, target) {
  return readIcon(entry.path, pickIconPath(spec, target));
}

// chrome-extension://<id>/<popup> only; anything that points elsewhere is refused.
function popupUrlFor(id, rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 300) return null;
  let u;
  try {
    u = new URL(rel.trim(), `chrome-extension://${id}/`);
  } catch {
    return null;
  }
  return u.protocol === 'chrome-extension:' && u.hostname === id ? u.href : null;
}

// Settings labels for what an extension can access, and warnings for what Pure does not provide.
function permissionLabels(manifest) {
  const out = [];
  const list = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const hosts = [];
  for (const p of list) {
    if (typeof p !== 'string') continue;
    if (p === '<all_urls>' || p.includes('://')) hosts.push(p);
    else if (PERMISSION_LABELS[p]) out.push(PERMISSION_LABELS[p]);
  }
  if (Array.isArray(manifest.host_permissions)) for (const h of manifest.host_permissions) if (typeof h === 'string') hosts.push(h);
  const everywhere = hosts.some((h) => h === '<all_urls>' || /^(\*|https?|http\*):\/\/\*\//.test(h) || h === '*://*/*');
  if (everywhere) out.push('Read and change data on all sites');
  else if (hosts.length) {
    const names = [...new Set(hosts.map((h) => h.replace(/^[^:]+:\/\//, '').split('/')[0]))];
    out.push(`Access to ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`);
  }
  return [...new Set(out)].slice(0, 12);
}

function warningsFor(id, manifest) {
  const out = [];
  const list = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const p of list) {
    if (typeof p !== 'string' || p.includes('://')) continue;
    if (UNSUPPORTED_PERMISSIONS.has(p) || p.startsWith('system.')) out.push(`Needs "${p}", which Pure does not support yet.`);
  }
  for (const key of extApi.unsupportedCalls(id).slice(0, 3)) out.push(`Calls chrome.${key}, which Pure does not support yet.`);
  return out.slice(0, 6);
}

// ── Reconcile: make Electron's loaded set match the enabled set ─────────────

async function reconcileNow() {
  const ses = mainSession;
  if (!ses || !ses.extensions) return;
  catalog = await scanCatalog();

  // Forget disabled ids whose files were removed elsewhere (e.g. from the store page).
  const known = new Set(catalog.map((e) => e.id));
  let pruned = false;
  for (const id of [...prefs.disabled]) {
    if (!known.has(id)) {
      prefs.disabled.delete(id);
      pruned = true;
    }
  }
  if (pruned) markDirty();

  // Unload anything the user disabled (a store install may have loaded it before we knew).
  for (const ext of ses.extensions.getAllExtensions()) {
    if (!prefs.disabled.has(ext.id)) continue;
    try {
      ses.extensions.removeExtension(ext.id);
    } catch (err) {
      log('[extensions] could not unload', ext.id, err);
    }
  }

  // Only now, with something to load, the compatibility layer is set up.
  if (catalog.some((e) => !prefs.disabled.has(e.id))) ensureApi();

  // Load every enabled one that is not loaded yet.
  for (const entry of catalog) {
    if (prefs.disabled.has(entry.id)) {
      errors.delete(entry.id);
      continue;
    }
    if (ses.extensions.getExtension(entry.id)) {
      errors.delete(entry.id);
      continue;
    }
    try {
      await ses.extensions.loadExtension(entry.path);
      errors.delete(entry.id);
    } catch (err) {
      errors.set(entry.id, errorText(err));
      log('[extensions] could not load', entry.id, err);
    }
  }

  await rebuild();
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    serial(reconcileNow).catch(() => {});
  }, REFRESH_DELAY_MS);
}

// Recomputes the manifest defaults and the settings list, then pushes them to every UI that shows them.
async function rebuild() {
  const ses = mainSession;
  const nextDefaults = new Map();
  const nextList = [];

  for (const entry of catalog) {
    const { manifest, id } = entry;
    const enabled = !prefs.disabled.has(id);
    nextList.push({
      id,
      name: localize(entry, manifest.name) || id,
      version: text(manifest.version, 40),
      description: localize(entry, manifest.description, 300),
      enabled,
      icon: await iconFor(entry, manifest.icons, 48),
      source: entry.source,
      error: errors.get(id) || null,
      permissions: permissionLabels(manifest),
      warnings: warningsFor(id, manifest),
    });

    if (!enabled || !ses || !ses.extensions.getExtension(id)) continue;
    const spec = manifest.action || manifest.browser_action;
    if (!spec || typeof spec !== 'object') continue;
    nextDefaults.set(id, {
      title: localize(entry, spec.default_title) || localize(entry, manifest.name) || id,
      icon: (await iconFor(entry, spec.default_icon, 32)) || (await iconFor(entry, manifest.icons, 32)),
      popup: popupUrlFor(id, spec.default_popup),
    });
  }

  defaults = nextDefaults;
  extList = nextList;
  if (popup && !defaults.has(popup.id)) closePopup();

  broadcastActions();
  broadcastList();
  ensureUpdateTimer();
}

// The toolbar for one window: manifest defaults, overridden by chrome.action values for its active tab.
function actionsFor(win) {
  const out = [];
  let tabId = null;
  try {
    const mgr = windows().getTabManager(win);
    tabId = mgr && mgr.activeId ? mgr.activeId : null;
  } catch {
    tabId = null;
  }
  for (const [id, d] of defaults) {
    const eff = extApi.effectiveAction(id, tabId);
    const title = typeof eff.title === 'string' ? eff.title : d.title;
    const icon = eff.icon || d.icon || null;
    const popupUrl = eff.popup !== undefined ? eff.popup || null : d.popup;
    out.push({
      id,
      name: title,
      icon,
      title,
      badge: typeof eff.badge === 'string' ? eff.badge : '',
      badgeColor: typeof eff.badgeColor === 'string' ? eff.badgeColor : '',
      hasPopup: !!popupUrl,
      enabled: eff.enabled !== false,
    });
  }
  return out;
}

function broadcastActions() {
  let wins = [];
  try {
    wins = windows().getBrowserWindows();
  } catch {
    return;
  }
  for (const win of wins) {
    if (win.isDestroyed()) continue;
    const incognito = windows().isIncognitoWindow(win);
    try {
      win.webContents.send('ext:changed', incognito ? [] : actionsFor(win));
    } catch {
      /* window closing */
    }
  }
}

// Called by extension-api.js when a badge, title, icon or popup changes, or the active tab / focus moves.
function scheduleActionPush() {
  if (!defaults.size || actionTimer) return;
  actionTimer = setTimeout(() => {
    actionTimer = null;
    broadcastActions();
  }, ACTION_PUSH_MS);
}

function broadcastList() {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      continue;
    }
    if (!url.startsWith('pure://settings/')) continue;
    try {
      wc.send('ext:list-changed', extList);
    } catch {
      /* page closing */
    }
  }
}

// ── Chrome Web Store support (lazy) ────────────────────────────────────────

// Asked before every store install. The user confirms in a native dialog; the library then installs and loads.
async function confirmInstall(details) {
  await ensurePrefs();
  const name = text(details.localizedName || details.id || 'this extension', 120) || 'this extension';
  const opts = {
    type: 'question',
    title: 'Add extension',
    message: `Add "${name}" to Pure Browser?`,
    detail: 'The extension can read and change the sites you visit. Only add extensions you trust.',
    buttons: ['Add extension', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const win = details.browserWindow && !details.browserWindow.isDestroyed() ? details.browserWindow : null;
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (res.response !== 0) return { action: 'deny' };
  if (validId(details.id) && prefs.disabled.delete(details.id)) markDirty(); // re-adding turns it on
  return { action: 'allow' };
}

// Registers the store preload and IPC once. Until this runs, nothing store-related is loaded.
function ensureStoreSupport() {
  if (storeSupport || !mainSession) return storeSupport;
  ensureApi(); // installs load extensions, so the compatibility layer must be in place first
  try {
    const store = require('electron-chrome-web-store');
    storeSupport = store
      .installChromeWebStore({
        session: mainSession,
        extensionsPath: extensionsDir(),
        loadExtensions: false, // we load enabled extensions ourselves
        autoUpdate: false, // updates run from ensureUpdateTimer()
        beforeInstall: confirmInstall,
      })
      .catch((err) => log('[extensions] Chrome Web Store setup failed:', err));
  } catch (err) {
    log('[extensions] electron-chrome-web-store unavailable:', err);
    storeSupport = Promise.resolve();
  }
  return storeSupport;
}

function watchStoreNavigation(contents) {
  contents.on('did-start-navigation', (details, url) => {
    if (details && details.isMainFrame === false) return;
    const target = details && typeof details.url === 'string' ? details.url : url;
    if (isStoreUrl(target)) ensureStoreSupport();
  });
}

// ── Updates: one timer, only while a store extension is loaded ───────────────

function hasLoadedStore() {
  if (!mainSession) return false;
  return catalog.some((e) => e.source === 'store' && !prefs.disabled.has(e.id) && mainSession.extensions.getExtension(e.id));
}

function ensureUpdateTimer() {
  if (updateTimer || !hasLoadedStore()) return;
  const due = lastUpdateAt
    ? Math.max(UPDATE_FIRST_MS, lastUpdateAt + UPDATE_EVERY_MS - Date.now())
    : UPDATE_FIRST_MS;
  updateTimer = setTimeout(runUpdates, due);
  updateTimer.unref?.();
}

async function runUpdates() {
  updateTimer = null;
  lastUpdateAt = Date.now();
  if (!mainSession) return;
  try {
    // The library only updates extensions that are loaded and whose manifest points at Google's update URL.
    await require('electron-chrome-web-store').updateExtensions(mainSession);
  } catch (err) {
    log('[extensions] update check failed:', err);
  }
  scheduleRefresh(); // a newer version may now be loaded from its new folder
}

// ── Popup window ───────────────────────────────────────────────────────────

function closePopup() {
  const p = popup;
  if (!p) return;
  popup = null;
  clearTimeout(p.timer);
  if (!p.win.isDestroyed()) p.win.close();
}

function closeIfCurrent(p) {
  if (popup === p) closePopup();
}

function maybeShow(p) {
  if (p.shown || !p.ready || !p.sized || popup !== p || p.win.isDestroyed()) return;
  p.shown = true;
  clearTimeout(p.timer);
  p.win.show();
  p.win.focus();
}

// Places the popup under the toolbar button (or above it when there is no room below), inside the work area.
function placePopup(p) {
  if (p.win.isDestroyed() || p.parent.isDestroyed()) return;
  const cb = p.parent.getContentBounds();
  const a = { x: cb.x + p.anchor.x, y: cb.y + p.anchor.y, width: p.anchor.width, height: p.anchor.height };
  const { width, height } = p.win.getBounds();
  const wa = screen.getDisplayMatching(a).workArea;
  let x = Math.round(a.x + a.width / 2 - width / 2);
  let y = Math.round(a.y + a.height + 4);
  if (y + height > wa.y + wa.height) y = Math.round(a.y - height - 4);
  x = clamp(x, wa.x, wa.x + wa.width - width);
  y = clamp(y, wa.y, wa.y + wa.height - height);
  p.win.setPosition(x, y);
}

async function measurePopup(p) {
  try {
    const size = await p.win.webContents.executeJavaScript(MEASURE_JS);
    if (popup !== p || p.win.isDestroyed()) return;
    const w = clamp(Math.round(Number(size && size.w) || 0), POPUP_MIN.w, POPUP_MAX.w);
    const h = clamp(Math.round(Number(size && size.h) || 0), POPUP_MIN.h, POPUP_MAX.h);
    p.win.setContentSize(w, h);
    placePopup(p);
    p.sized = true;
    maybeShow(p);
  } catch (err) {
    log('[extensions] popup measure failed:', err);
    closeIfCurrent(p);
  }
}

function openPopup(parentWin, id, popupUrl, rect) {
  const win = new BrowserWindow({
    parent: parentWin,
    frame: false,
    show: false,
    width: POPUP_MIN.w,
    height: 240,
    minWidth: POPUP_MIN.w,
    minHeight: POPUP_MIN.h,
    maxWidth: POPUP_MAX.w,
    maxHeight: POPUP_MAX.h,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: true,
    webPreferences: {
      session: mainSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const p = { id, win, parent: parentWin, anchor: rect, ready: false, sized: false, shown: false, timer: null };
  popup = p;
  p.timer = setTimeout(() => closeIfCurrent(p), POPUP_TIMEOUT_MS);

  const wc = win.webContents;
  const ownPage = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === 'chrome-extension:' && u.hostname === id;
    } catch {
      return false;
    }
  };
  // The popup stays on its own extension. Web links open in a normal tab.
  const guard = (event, url) => {
    if (ownPage(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) windows().openUrl(url);
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) windows().openUrl(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) closeIfCurrent(p);
  });
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') closeIfCurrent(p);
  });
  wc.once('did-finish-load', () => {
    measurePopup(p);
  });
  win.once('ready-to-show', () => {
    p.ready = true;
    maybeShow(p);
  });
  win.on('blur', () => {
    if (popup !== p) return;
    blurClose = { id, at: Date.now() };
    closePopup();
  });
  win.once('closed', () => {
    if (popup === p) popup = null;
    clearTimeout(p.timer);
  });
  win.loadURL(popupUrl).catch((err) => {
    log('[extensions] popup load failed:', err);
    closeIfCurrent(p);
  });
}

// Clicking the toolbar button of an open popup blurs (closes) the popup before the click arrives. Remember
// that close briefly so the same click does not reopen it.
let blurClose = null; // { id, at }

function togglePopup(parentWin, id, rect, popupUrl) {
  const wasOpen = popup && popup.id === id;
  const justBlurred = !!blurClose && blurClose.id === id && Date.now() - blurClose.at < 500;
  blurClose = null;
  closePopup();
  if (wasOpen || justBlurred) return;
  if (!popupUrl || !mainSession || !parentWin || parentWin.isDestroyed()) return;
  openPopup(parentWin, id, popupUrl, rect);
}

// ── Adding and removing ───────────────────────────────────────────────────

async function loadUnpacked(event) {
  const parent = BrowserWindow.fromWebContents(event.sender) || windows().getLastFocusedBrowserWindow() || null;
  const opts = { title: 'Choose an unpacked extension folder', properties: ['openDirectory'] };
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;

  const dir = path.resolve(res.filePaths[0]);
  if (!(await readManifest(dir))) return { error: 'That folder has no valid manifest.json.' };
  await ensurePrefs();
  if (prefs.unpacked.some((u) => path.resolve(u.path) === dir)) {
    return { error: 'That folder is already added.' };
  }

  return serial(async () => {
    let ext;
    try {
      ensureApi();
      ext = await mainSession.extensions.loadExtension(dir);
    } catch (err) {
      return { error: `Electron could not load it: ${errorText(err)}` };
    }
    const id = ext.id;
    if (!prefs.unpacked.some((u) => u.id === id)) prefs.unpacked.push({ id, path: dir });
    prefs.disabled.delete(id);
    markDirty();
    await reconcileNow();
    return extList.find((e) => e.id === id) || { error: 'Loaded, but it is not listed.' };
  }).catch((err) => {
    log('[extensions] load unpacked failed:', err);
    return { error: 'Could not add the folder.' };
  });
}

// ── Lifecycle hooks called by sessions.js / index.js ───────────────────────

// Called for every configured session. Only the persistent profile session is kept.
function attach(ses, { incognito = false } = {}) {
  if (incognito || mainSession) return;
  if (ses !== session.fromPartition(PERSIST_PARTITION)) return;
  mainSession = ses;
  if (ses.extensions) {
    ses.extensions.on('extension-loaded', scheduleRefresh);
    ses.extensions.on('extension-unloaded', scheduleRefresh);
  }
}

function ready() {
  if (!readyPromise) {
    readyPromise = ensurePrefs()
      .then(() => serial(reconcileNow))
      .catch((err) => log('[extensions] startup failed:', err));
  }
  return readyPromise;
}

// Must stay fast: it only starts background work. Nothing is loaded and no timer is set when no extension exists.
function init() {
  if (!mainSession) return;
  if (!watching) {
    watching = true;
    app.on('web-contents-created', (_event, contents) => watchStoreNavigation(contents));
  }
  void ready();
}

async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) await writePrefs();
  await saveChain;
  await extApi.flush();
}

// ── IPC ────────────────────────────────────────────────────────────────────

function registerIpc(ipc) {
  // Browser UI (chrome sender): toolbar actions and clicks.
  ipc.handle('ext:actions', (event) => {
    const st = windows().senderState(event);
    if (!st || st.incognito) return [];
    return actionsFor(st.win);
  });
  ipc.on('ext:click', (event, id, rect) => {
    const st = windows().senderState(event);
    if (!st || st.incognito || !validId(id)) return;
    const r = sanitizeRect(rect);
    if (!r) return;
    const tabId = st.tabs && st.tabs.activeId ? st.tabs.activeId : null;
    const eff = extApi.effectiveAction(id, tabId);
    if (eff.enabled === false) return;
    const d = defaults.get(id);
    const popupUrl = eff.popup !== undefined ? eff.popup || null : d ? d.popup : null;
    if (popupUrl) {
      togglePopup(st.win, id, r, popupUrl);
      return;
    }
    closePopup();
    if (tabId) extApi.fireActionClicked(id, tabId); // no popup: chrome.action.onClicked, if the extension listens
  });

  // Settings page (pure://settings only): management.
  ipc.handle('ext:list', async (event) => {
    if (!isSettingsSender(event)) return [];
    await ready();
    return extList;
  });
  ipc.handle('ext:set-enabled', async (event, id, enabled) => {
    if (!isSettingsSender(event) || !validId(id)) return { error: 'Unknown extension.' };
    await ready();
    if (!catalog.some((e) => e.id === id)) return { error: 'Extension not found.' };
    try {
      await serial(async () => {
        if (enabled === true) prefs.disabled.delete(id);
        else prefs.disabled.add(id);
        markDirty();
        await reconcileNow();
      });
    } catch (err) {
      log('[extensions] set-enabled failed:', err);
      return { error: 'Could not change the extension.' };
    }
    return extList.find((e) => e.id === id) || { error: 'Extension not found.' };
  });
  ipc.handle('ext:remove', async (event, id) => {
    if (!isSettingsSender(event) || !validId(id)) return { error: 'Unknown extension.' };
    await ready();
    const entry = catalog.find((e) => e.id === id);
    if (!entry) return { error: 'Extension not found.' };
    try {
      await serial(async () => {
        if (entry.source === 'store') {
          // Unloads it and deletes its folder.
          await require('electron-chrome-web-store').uninstallExtension(id, {
            session: mainSession,
            extensionsPath: extensionsDir(),
          });
        } else {
          // The user's own folder is never deleted; only the entry is forgotten.
          if (mainSession.extensions.getExtension(id)) mainSession.extensions.removeExtension(id);
          prefs.unpacked = prefs.unpacked.filter((u) => u.id !== id);
        }
        prefs.disabled.delete(id);
        errors.delete(id);
        markDirty();
        await reconcileNow();
      });
      return { ok: true };
    } catch (err) {
      log('[extensions] remove failed:', err);
      return { error: 'Could not remove the extension.' };
    }
  });
  ipc.handle('ext:load-unpacked', async (event) => {
    if (!isSettingsSender(event)) return { error: 'Not allowed.' };
    await ready();
    return loadUnpacked(event);
  });
  ipc.on('ext:open-store', (event) => {
    if (!isSettingsSender(event)) return;
    ensureStoreSupport();
    windows().openUrl(STORE_URL);
  });
}

// True when `id` is an extension loaded (enabled) on the persistent session. Used by tabs.js to allow
// chrome-extension:// pages (options pages, OneTab-style tab pages) in normal tabs.
function isLoadedExtension(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || !mainSession) return false;
  try {
    return !!mainSession.extensions.getExtension(id);
  } catch {
    return false;
  }
}

module.exports = { attach, init, flush, registerIpc, scheduleActionPush, isLoadedExtension };
