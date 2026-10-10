// Downloads: will-download handling, save-path choice, live progress to the browser UI and
// settings page, Mark-of-the-Web on Windows, a small persisted history, and downloads:* IPC.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, shell, webContents } = require('electron');
const security = require('./security');
const { ownerWindow } = require('./permissions');

const MAX_HISTORY = 100;          // finished downloads kept (memory and disk)
const EMIT_INTERVAL = 250;        // ms: at most 4 progress updates per second per item
const SAVE_DELAY = 1000;          // ms: debounce for downloads.json
const VALID_ID = /^d[0-9a-z]{4,40}$/;
const EXECUTABLE_EXT = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jse',
  '.wsf', '.hta', '.jar', '.lnk', '.reg',
]);
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const downloads = new Map();      // id -> entry (in memory; finished ones capped at MAX_HISTORY)
const reservedPaths = new Set();  // save paths of downloads in progress (avoid name clashes)
let seq = 0;
let loadPromise = null;
let saveTimer = null;

function log(...args) {
  try { require('./logger').log(...args); } catch { /* ignore */ }
}

function settings() {
  try { return require('./storage').settings.get() || {}; } catch { return {}; }
}

function isIncognitoSession(ses) {
  try { return require('./sessions').isIncognitoSession(ses); } catch { return false; }
}

function isIncognitoSender(event) {
  try {
    if (security.isChromeSender(event)) {
      return require('./windows').isIncognitoWindow(BrowserWindow.fromWebContents(event.sender));
    }
  } catch { /* fall through */ }
  return isIncognitoSession(event.sender.session);
}

function newId() {
  seq += 1;
  return 'd' + Date.now().toString(36) + seq.toString(36);
}

// ── File naming ───────────────────────────────────────────────────────────────

// Make a file name safe on Windows: no illegal characters, no reserved device names,
// no trailing dots/spaces, sane length. Keeps the extension.
function safeFilename(raw) {
  let name = String(raw || '')
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'download';

  let ext = path.extname(name);
  if (ext.length > 20) ext = '';
  let base = ext ? name.slice(0, -ext.length) : name;
  base = base.replace(/[. ]+$/, '');
  if (!base) base = 'download';
  if (RESERVED_NAME.test(base)) base = '_' + base;
  if (base.length > 150) base = base.slice(0, 150).replace(/[. ]+$/, '');
  return base + ext;
}

// "name.ext" -> "name (1).ext", ... Synchronous on purpose: setSavePath must be called
// inside will-download. Only a handful of existence checks per download start.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 1;
  while ((fs.existsSync(candidate) || reservedPaths.has(candidate)) && n < 10000) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

function downloadDir(s) {
  const configured = typeof s.downloadDir === 'string' ? s.downloadDir.trim() : '';
  if (configured && path.isAbsolute(configured)) return configured;
  return app.getPath('downloads');
}

// ── Views and emitting ────────────────────────────────────────────────────────

function toView(e) {
  return {
    id: e.id,
    filename: e.filename,
    url: e.url,
    state: e.state,
    receivedBytes: e.receivedBytes,
    totalBytes: e.totalBytes,
    paused: !!e.paused,
    savePath: e.savePath,
    startTime: e.startTime,
  };
}

function visibleTo(incognito) {
  return [...downloads.values()]
    .filter((e) => !e.incognito || incognito)
    .sort((a, b) => b.startTime - a.startTime);
}

function isUiUrl(url) {
  return url.startsWith('pure://browser/') || url.startsWith('pure://settings/');
}

function uiRecipients() {
  return webContents.getAllWebContents().filter((wc) => {
    if (wc.isDestroyed()) return false;
    try { return isUiUrl(wc.getURL()); } catch { return false; }
  });
}

function clearTimer(entry) {
  if (entry.emitTimer) {
    clearTimeout(entry.emitTimer);
    entry.emitTimer = null;
  }
}

// Push one item to every browser-UI and settings page (incognito items only to incognito pages).
function flush(entry) {
  clearTimer(entry);
  entry.lastEmit = Date.now();
  const payload = toView(entry);
  for (const wc of uiRecipients()) {
    if (entry.incognito && !isIncognitoSession(wc.session)) continue;
    try { wc.send('downloads:updated', payload); } catch { /* page went away */ }
  }
  updateProgress(entry);
}

// State changes go out immediately; progress ticks are throttled.
function emit(entry, { immediate = false } = {}) {
  if (immediate) return flush(entry);
  const wait = EMIT_INTERVAL - (Date.now() - entry.lastEmit);
  if (wait <= 0) return flush(entry);
  if (!entry.emitTimer) {
    entry.emitTimer = setTimeout(() => flush(entry), wait);
    if (entry.emitTimer.unref) entry.emitTimer.unref();
  }
  return undefined;
}

// Taskbar progress for the window that started the active downloads.
function updateProgress(entry) {
  if (entry.winId == null) return;
  const win = BrowserWindow.fromId(entry.winId);
  if (!win || win.isDestroyed()) return;
  let active = 0;
  let received = 0;
  let total = 0;
  for (const d of downloads.values()) {
    if (d.winId !== entry.winId || !d.item || d.state !== 'progressing' || d.paused) continue;
    active += 1;
    if (d.totalBytes > 0) {
      received += d.receivedBytes;
      total += d.totalBytes;
    }
  }
  try {
    if (!active) win.setProgressBar(-1);
    else if (!total) win.setProgressBar(2); // indeterminate
    else win.setProgressBar(Math.min(1, received / total));
  } catch { /* window closing */ }
}

// ── Persistence (non-incognito finished downloads only) ───────────────────────

function historyFile() {
  return path.join(app.getPath('userData'), 'profile', 'downloads.json');
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save().catch((err) => log('downloads: save failed', err && err.message));
  }, SAVE_DELAY);
  if (saveTimer.unref) saveTimer.unref();
}

async function save() {
  const items = [...downloads.values()]
    .filter((e) => !e.incognito && !e.item && e.state !== 'progressing')
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, MAX_HISTORY)
    .map((e) => ({
      id: e.id, filename: e.filename, url: e.url, state: e.state,
      receivedBytes: e.receivedBytes, totalBytes: e.totalBytes,
      savePath: e.savePath, startTime: e.startTime,
    }));
  const file = historyFile();
  const tmp = file + '.tmp';
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, items }));
  await fs.promises.rename(tmp, file);
}

function load() {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = JSON.parse(await fs.promises.readFile(historyFile(), 'utf8'));
        const items = Array.isArray(raw && raw.items) ? raw.items.slice(0, MAX_HISTORY) : [];
        for (const it of items) {
          if (!it || typeof it.id !== 'string' || !VALID_ID.test(it.id) || downloads.has(it.id)) continue;
          const state = ['completed', 'cancelled', 'interrupted'].includes(it.state) ? it.state : 'interrupted';
          downloads.set(it.id, {
            id: it.id,
            filename: String(it.filename || 'download'),
            url: String(it.url || ''),
            state,
            receivedBytes: Number(it.receivedBytes) || 0,
            totalBytes: Number(it.totalBytes) || 0,
            paused: false,
            savePath: String(it.savePath || ''),
            startTime: Number(it.startTime) || 0,
            incognito: false,
            item: null,
            winId: null,
            emitTimer: null,
            lastEmit: 0,
          });
        }
      } catch {
        // No history yet, or unreadable: start empty.
      }
    })();
  }
  return loadPromise;
}

// ── Lifecycle of one download ─────────────────────────────────────────────────

function trimFinished() {
  const finished = [...downloads.values()].filter((e) => !e.item && e.state !== 'progressing');
  if (finished.length <= MAX_HISTORY) return;
  finished.sort((a, b) => a.startTime - b.startTime);
  for (const e of finished.slice(0, finished.length - MAX_HISTORY)) downloads.delete(e.id);
}

function markOfTheWeb(entry) {
  // Windows marks files from the internet so SmartScreen and Protected View apply.
  if (process.platform !== 'win32' || !entry.savePath) return;
  const clean = (s) => String(s || '').replace(/[\r\n]/g, '');
  const body = '[ZoneTransfer]\r\nZoneId=3\r\n' +
    `ReferrerUrl=${clean(entry.referrer)}\r\nHostUrl=${clean(entry.url)}\r\n`;
  fs.promises.writeFile(entry.savePath + ':Zone.Identifier', body).catch(() => { /* best effort */ });
}

function finish(entry, state) {
  const item = entry.item;
  entry.state = state;
  if (item) {
    try {
      entry.receivedBytes = item.getReceivedBytes();
      entry.totalBytes = item.getTotalBytes();
      entry.savePath = item.getSavePath() || entry.savePath;
    } catch { /* item already gone */ }
  }
  if (entry.savePath) entry.filename = path.basename(entry.savePath);
  entry.paused = false;
  entry.item = null;
  if (entry.reservedPath) {
    reservedPaths.delete(entry.reservedPath);
    entry.reservedPath = null;
  }
  emit(entry, { immediate: true });
  if (state === 'completed') markOfTheWeb(entry);
  trimFinished();
  if (!entry.incognito) scheduleSave();
}

function begin(item, wc, incognito) {
  const s = settings();
  const name = safeFilename(item.getFilename());
  const dir = downloadDir(s);
  let referrer = '';
  try { referrer = wc && !wc.isDestroyed() ? wc.getURL() : ''; } catch { referrer = ''; }
  let winId = null;
  try {
    const win = ownerWindow(wc);
    winId = win ? win.id : null;
  } catch { winId = null; }

  const entry = {
    id: newId(),
    filename: name,
    url: item.getURL(),
    referrer,
    state: 'progressing',
    receivedBytes: 0,
    totalBytes: item.getTotalBytes(),
    paused: item.isPaused(),
    savePath: '',
    startTime: Date.now(),
    incognito,
    item,
    winId,
    reservedPath: null,
    emitTimer: null,
    lastEmit: 0,
  };
  downloads.set(entry.id, entry);

  if (s.askWhereToSave) {
    item.setSaveDialogOptions({ title: 'Save file', defaultPath: path.join(dir, name) });
  } else {
    const target = uniquePath(dir, name);
    item.setSavePath(target);
    entry.savePath = target;
    entry.filename = path.basename(target);
    entry.reservedPath = target;
    reservedPaths.add(target);
  }

  item.on('updated', (_event, state) => {
    const paused = item.isPaused();
    const changed = paused !== entry.paused || (state === 'interrupted') !== (entry.state === 'interrupted');
    entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
    entry.receivedBytes = item.getReceivedBytes();
    entry.totalBytes = item.getTotalBytes();
    entry.paused = paused;
    emit(entry, { immediate: changed });
  });

  item.once('done', (_event, state) => finish(entry, state));

  emit(entry, { immediate: true });
}

// ── Opening files ─────────────────────────────────────────────────────────────

function parentFor(wc) {
  try { return ownerWindow(wc) || BrowserWindow.getFocusedWindow() || null; } catch { return null; }
}

async function openEntry(entry, parent) {
  if (entry.state !== 'completed' || !entry.savePath) return;
  if (EXECUTABLE_EXT.has(path.extname(entry.savePath).toLowerCase())) {
    const opts = {
      type: 'warning',
      title: 'Open file?',
      message: `"${entry.filename}" is a program or script that can change your computer.`,
      detail: 'Only open files from sources you trust.',
      buttons: ['Cancel', 'Open anyway'],
      defaultId: 0,
      cancelId: 0,
    };
    const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    if (res.response !== 1) return;
  }
  const err = await shell.openPath(entry.savePath);
  if (err) log('downloads: open failed', err);
}

function activate(entry, parent) {
  if (entry.state === 'completed') {
    openEntry(entry, parent).catch((err) => log('downloads: open failed', err && err.message));
  } else if (entry.savePath) {
    shell.showItemInFolder(entry.savePath);
  }
}

function togglePause(entry) {
  const item = entry.item;
  if (!item) return;
  try {
    if (entry.state === 'progressing' && !item.isPaused()) item.pause();
    else if (item.canResume()) item.resume();
  } catch { /* item finished meanwhile */ }
}

function cancel(entry) {
  if (entry.item) {
    try { entry.item.cancel(); } catch { /* already finished */ }
  }
}

function clearFinished() {
  for (const e of downloads.values()) {
    if (!e.item && e.state !== 'progressing') downloads.delete(e.id);
  }
  scheduleSave();
}

// ── Native menu (downloads:menu) ──────────────────────────────────────────────

function escapeLabel(text) {
  return String(text).replace(/&/g, '&&');
}

function clipName(name, max) {
  const s = String(name || 'download');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function menuLabel(e) {
  const name = escapeLabel(clipName(e.filename, 60));
  if (e.state === 'completed') return `${name} — done`;
  if (e.state === 'progressing') {
    const pct = e.totalBytes > 0 ? Math.floor((e.receivedBytes / e.totalBytes) * 100) : null;
    return pct === null ? `${name} — downloading` : `${name} — ${pct}%`;
  }
  if (e.state === 'cancelled') return `${name} — cancelled`;
  return `${name} — failed`;
}

function showMenu(event) {
  const win = BrowserWindow.fromWebContents(event.sender) || parentFor(event.sender);
  const recent = visibleTo(isIncognitoSender(event)).slice(0, 8);
  const template = recent.length
    ? recent.map((e) => ({ label: menuLabel(e), click: () => activate(e, win) }))
    : [{ label: 'No downloads', enabled: false }];
  template.push(
    { type: 'separator' },
    {
      label: 'Show all downloads',
      click: () => {
        try { require('./windows').openUrl('pure://settings/#downloads'); } catch (err) {
          log('downloads: open settings failed', err && err.message);
        }
      },
    },
  );
  Menu.buildFromTemplate(template).popup({ window: win || undefined });
}

// ── Public API ────────────────────────────────────────────────────────────────

function attach(session, { incognito = false } = {}) {
  session.on('will-download', (_event, item, wc) => {
    try {
      begin(item, wc, !!incognito);
    } catch (err) {
      log('downloads: begin failed', err && err.message);
      try { item.cancel(); } catch { /* ignore */ }
    }
  });
}

function getEntry(id) {
  if (typeof id !== 'string' || !VALID_ID.test(id)) return null;
  return downloads.get(id) || null;
}

function registerIpc(ipcMain) {
  load();

  const readable = (event) => security.isChromeSender(event) || security.isInternalSender(event);

  ipcMain.handle('downloads:list', (event) => {
    if (!readable(event)) return [];
    return visibleTo(isIncognitoSender(event)).map(toView);
  });

  ipcMain.handle('downloads:clear', (event) => {
    if (!security.isInternalSender(event)) return [];
    clearFinished();
    return visibleTo(isIncognitoSender(event)).map(toView);
  });

  // Open / show: validate the id and that the item is visible to this sender.
  const visibleEntry = (event, id) => {
    if (!readable(event)) return null;
    const entry = getEntry(id);
    if (!entry) return null;
    if (entry.incognito && !isIncognitoSender(event)) return null;
    return entry;
  };

  ipcMain.on('downloads:open', (event, id) => {
    const entry = visibleEntry(event, id);
    if (entry) activate(entry, parentFor(event.sender));
  });

  ipcMain.on('downloads:show', (event, id) => {
    const entry = visibleEntry(event, id);
    if (entry && entry.savePath) shell.showItemInFolder(entry.savePath);
  });

  ipcMain.on('downloads:cancel', (event, id) => {
    if (!security.isChromeSender(event)) return;
    const entry = visibleEntry(event, id);
    if (entry) cancel(entry);
  });

  ipcMain.on('downloads:pause-resume', (event, id) => {
    if (!security.isChromeSender(event)) return;
    const entry = visibleEntry(event, id);
    if (entry) togglePause(entry);
  });

  ipcMain.on('downloads:menu', (event) => {
    if (!security.isChromeSender(event)) return;
    try { showMenu(event); } catch (err) { log('downloads: menu failed', err && err.message); }
  });
}

// Write a pending history save now (call from before-quit).
function flushSave() {
  if (!saveTimer) return Promise.resolve();
  clearTimeout(saveTimer);
  saveTimer = null;
  return save();
}

module.exports = { attach, registerIpc, clearFinished, flush: flushSave };
