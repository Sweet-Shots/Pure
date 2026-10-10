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
// 2.4 risky files. Scripts and shortcuts always raise the warning; programs only when they came over http.
const SCRIPT_RISK_EXT = new Set([
  '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.scr', '.pif',
  '.com', '.reg', '.lnk', '.url', '.msc', '.cpl', '.jar',
]);
const PROGRAM_RISK_EXT = new Set(['.exe', '.msi', '.msix', '.appx', '.dll']);
const TOAST_NAME_MAX = 80;

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
    warning: e.warning || null, // 2.4: null | 'script' | 'insecure-program' while a keep/discard answer is pending
    openWhenDone: !!e.openWhenDone,
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
    .filter((e) => !e.incognito && !e.item && e.state !== 'progressing' && !e.stagePath && !e.stageDir)
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

// Only http(s) origins/URLs are written to the zone data; anything else (blob:, data:, file:) is left alone.
function httpUrlOf(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

function httpOriginOf(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch { return ''; }
}

// Mark of the Web: Windows marks files from the internet so SmartScreen and Protected View apply. Chromium
// normally quarantines downloads itself; the stream is written only when it is missing, never overwritten.
function markOfTheWeb(entry) {
  if (process.platform !== 'win32' || !entry.savePath) return;
  const hostUrl = httpUrlOf(entry.url).replace(/[\r\n]/g, '');
  if (!hostUrl) return;
  const referrer = httpOriginOf(entry.referrer);
  let body = '[ZoneTransfer]\r\nZoneId=3\r\n';
  if (referrer) body += `ReferrerUrl=${referrer}\r\n`;
  body += `HostUrl=${hostUrl}\r\n`;
  const stream = entry.savePath + ':Zone.Identifier';
  fs.promises.stat(stream)
    .then(() => null, () => fs.promises.writeFile(stream, body))
    .catch(() => { /* best effort: the file may be gone already */ });
}

// Removes the files of a discarded download: the final file (ours) and Chromium's in-progress file.
function deleteDownloadFiles(savePath) {
  if (!savePath) return;
  for (const f of [savePath + '.crdownload', savePath]) {
    fs.promises.unlink(f).catch(() => { /* already gone */ });
  }
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
  // A download that was cancelled or failed cannot be decided on any more; a completed one keeps its
  // warning until Keep or Discard (the file stays in the private holding folder until then).
  if (entry.warning && state !== 'completed') clearWarning(entry);
  if (entry.discarded) {
    deleteDownloadFiles(entry.savePath);
    removeHeldDir(entry);
    entry.savePath = '';
    entry.state = 'cancelled';
  }
  emit(entry, { immediate: true });
  if (state === 'completed' && entry.kept && entry.stagePath && entry.target) {
    // Kept while it was still running: the file moves to its place now that it is complete.
    moveHeld(entry);
  } else {
    if (state === 'completed') markOfTheWeb(entry);
    if (state === 'completed' && entry.openWhenDone && !entry.warned && !entry.discarded) openWhenDone(entry);
  }
  trimFinished();
  if (!entry.incognito) scheduleSave();
}

// ── Risky files (2.4) ─────────────────────────────────────────────────────────

// 'script' | 'insecure-program' | null for a file name and the download URL.
function riskOf(filename, url) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (SCRIPT_RISK_EXT.has(ext)) return 'script';
  if (PROGRAM_RISK_EXT.has(ext) && httpUrlOf(url).startsWith('http:')) return 'insecure-program';
  return null;
}

function toastApi() {
  try {
    const t = require('./toast');
    return t && typeof t.show === 'function' ? t : null;
  } catch { return null; }
}

function ownerWin(entry) {
  if (entry.winId == null) return null;
  const win = BrowserWindow.fromId(entry.winId);
  return win && !win.isDestroyed() ? win : null;
}

function toastId(entry) {
  return 'dl-' + entry.id;
}

function hideWarningToast(entry) {
  const t = toastApi();
  const win = ownerWin(entry);
  if (t && win && typeof t.hide === 'function') {
    try { t.hide(win, toastId(entry)); } catch { /* window closing */ }
  }
}

function clearWarning(entry) {
  entry.warning = null;
  hideWarningToast(entry);
}

// Holds a risky download (paused) and asks in the window that started it. Without a window or a toast to
// ask in, the file is refused: a held download nobody can answer would only sit there.
function raiseWarning(entry, kind) {
  entry.warning = kind;
  entry.warned = true;
  if (entry.item) {
    try { entry.item.pause(); } catch { /* finished meanwhile */ }
  }
  const win = ownerWin(entry);
  const t = toastApi();
  if (!win || !t) {
    log('downloads: no window to confirm a risky download, discarding', entry.filename);
    discardEntry(entry);
    return;
  }
  const name = clipName(entry.filename, TOAST_NAME_MAX);
  const text = kind === 'insecure-program'
    ? `${name} came over an insecure connection and could harm your computer.`
    : `${name} could harm your computer.`;
  win.once('closed', () => {
    if (entry.warning) discardEntry(entry);
  });
  let shown = false;
  try {
    shown = t.show(win, {
      id: toastId(entry),
      kind: 'warn',
      text,
      actions: [{ id: 'keep', label: 'Keep' }, { id: 'discard', label: 'Discard' }],
    }, (actionId) => {
      if (actionId === 'keep') keepEntry(entry);
      else discardEntry(entry); // 'discard', or the toast closed without an answer: refuse the file
    }) === true;
  } catch (err) {
    log('downloads: warning toast failed', err && err.message);
  }
  if (!shown) {
    discardEntry(entry);
    return;
  }
  emit(entry, { immediate: true });
}

// Risky downloads are written to a private holding folder (userData/profile/held/<id>/) and only moved to the
// download folder on Keep, so a file that finishes before anyone answers never shows up in Downloads.
function heldRoot() {
  return path.join(app.getPath('userData'), 'profile', 'held');
}

function removeHeldDir(entry) {
  entry.stagePath = null;
  if (!entry.stageDir) return;
  const dir = entry.stageDir;
  entry.stageDir = null;
  fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
}

// Where Keep puts the file: the download folder, or the Save As dialog when "Ask where to save" is on.
// null = the user cancelled that dialog (the download is then discarded).
async function heldTarget(entry) {
  const s = settings();
  const dir = downloadDir(s);
  if (!s.askWhereToSave) return uniquePath(dir, entry.filename);
  const win = ownerWin(entry);
  const opts = { title: 'Save file', defaultPath: path.join(dir, entry.filename) };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  return res.canceled || !res.filePath ? null : res.filePath;
}

// Moves a kept file from the holding folder to its target. Copies when the rename crosses volumes (then the
// Mark of the Web is written again by markOfTheWeb, since the copy does not carry the stream).
async function moveHeld(entry) {
  const from = entry.stagePath;
  const to = entry.target;
  if (!from || !to) return;
  entry.stagePath = null;
  entry.target = null;
  reservedPaths.add(to);
  try {
    try {
      await fs.promises.rename(from, to);
    } catch (err) {
      if (err && err.code !== 'EXDEV') throw err;
      await fs.promises.copyFile(from, to);
      await fs.promises.unlink(from).catch(() => { /* best effort */ });
    }
    entry.savePath = to;
    entry.filename = path.basename(to);
  } catch (err) {
    log('downloads: cannot move the kept file', err && err.message);
    entry.savePath = '';
    entry.state = 'cancelled';
  } finally {
    reservedPaths.delete(to);
    removeHeldDir(entry);
  }
  emit(entry, { immediate: true });
  if (entry.state === 'completed') markOfTheWeb(entry);
  if (!entry.incognito) scheduleSave();
}

// Keep: the held download resumes (or, when it already finished, moves to its place). Asking where to save happens
// first, so Cancel in that dialog discards the download.
async function keepEntry(entry) {
  if (!entry.warning || entry.keeping) return;
  entry.keeping = true;
  try {
    const target = entry.stagePath ? await heldTarget(entry) : null;
    if (!entry.warning) return; // answered meanwhile (discard, or the window closed)
    if (entry.stagePath && !target) {
      discardEntry(entry);
      return;
    }
    clearWarning(entry);
    entry.kept = true;
    entry.target = target;
    if (entry.item) {
      try { entry.item.resume(); } catch { /* finished meanwhile */ }
      emit(entry, { immediate: true });
      return;
    }
    if (entry.stagePath) await moveHeld(entry);
    else emit(entry, { immediate: true });
  } catch (err) {
    log('downloads: keep failed', err && err.message);
    if (entry.warning) discardEntry(entry);
  } finally {
    entry.keeping = false;
  }
}

// Discard: cancel the download (its partial file is removed in finish) or, when it already finished, delete the
// file. Never auto-opened afterwards.
function discardEntry(entry) {
  if (!entry.warning) return;
  clearWarning(entry);
  entry.discarded = true;
  if (entry.item) {
    try { entry.item.cancel(); } catch { /* finished meanwhile */ }
  } else {
    deleteDownloadFiles(entry.savePath);
    removeHeldDir(entry);
    entry.savePath = '';
    entry.state = 'cancelled';
    emit(entry, { immediate: true });
    if (!entry.incognito) scheduleSave();
  }
}

// ── Open when done (2.4) ──────────────────────────────────────────────────────

function openWhenDone(entry) {
  const win = ownerWin(entry);
  openEntry(entry, win).catch((err) => log('downloads: open when done failed', err && err.message));
}

function setOpenWhenDone(entry, on) {
  if (!entry.item) return; // only meaningful while the download runs
  entry.openWhenDone = on === true;
  emit(entry, { immediate: true });
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
    warning: null,
    warned: false, // a warning was ever raised: such a file is never opened automatically
    discarded: false,
    kept: false,
    keeping: false,
    openWhenDone: false,
    stagePath: null, // risky download: where it is written until Keep (holding folder)
    stageDir: null,
    target: null, // risky download after Keep: where it moves to
    emitTimer: null,
    lastEmit: 0,
  };
  downloads.set(entry.id, entry);

  // Risky files are staged, never written to the download folder before Keep. If the holding folder cannot be
  // made, the download is refused (cancelled) rather than left unprotected.
  const risk = s.warnRiskyDownloads !== false ? riskOf(name, entry.url) : null;
  let refuse = false;
  if (risk) {
    const stageDir = path.join(heldRoot(), entry.id);
    try {
      fs.mkdirSync(stageDir, { recursive: true });
      entry.stageDir = stageDir;
      entry.stagePath = path.join(stageDir, name);
      item.setSavePath(entry.stagePath);
      entry.savePath = entry.stagePath;
    } catch (err) {
      log('downloads: cannot make the holding folder', err && err.message);
      refuse = true;
    }
  } else if (s.askWhereToSave) {
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

  if (refuse) {
    try { item.cancel(); } catch { /* finished meanwhile */ }
  } else if (risk) {
    raiseWarning(entry, risk);
  }
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
  if (!item || entry.warning) return; // a held risky download is resumed only by Keep
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
  if (e.warning) return `${name} — waiting for your choice`;
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
  const template = [];
  for (const e of recent) {
    // Held risky downloads are answered in the browser window (toast), not from this menu.
    template.push({ label: menuLabel(e), enabled: !e.warning, click: () => activate(e, win) });
    if (e.item && !e.warning) {
      template.push({
        label: `Open "${escapeLabel(clipName(e.filename, 40))}" when done`,
        type: 'checkbox',
        checked: !!e.openWhenDone,
        click: (mi) => setOpenWhenDone(e, mi.checked),
      });
    }
  }
  if (!template.length) template.push({ label: 'No downloads', enabled: false });
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
  // Held files of a session that ended before they were answered: nothing can answer them now.
  fs.promises.rm(heldRoot(), { recursive: true, force: true }).catch(() => { /* none */ });

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

  // 2.4: answers to a held risky download, and "Open when done" for a running one.
  ipcMain.on('downloads:keep', (event, id) => {
    if (!security.isChromeSender(event)) return;
    const entry = visibleEntry(event, id);
    if (entry && entry.warning) keepEntry(entry);
  });

  ipcMain.on('downloads:discard', (event, id) => {
    if (!security.isChromeSender(event)) return;
    const entry = visibleEntry(event, id);
    if (entry && entry.warning) discardEntry(entry);
  });

  ipcMain.on('downloads:open-when-done', (event, id, on) => {
    if (!security.isChromeSender(event)) return;
    const entry = visibleEntry(event, id);
    if (entry) setOpenWhenDone(entry, on === true);
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
