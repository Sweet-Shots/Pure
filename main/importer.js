'use strict';
// Import from Chrome / Edge / Brave and from Pure 1.1.1 (owner: B4). Internal senders only; refused in
// incognito windows. Read-only with respect to the other browsers' profiles.
//
// Chromium: Bookmarks (JSON) and History (SQLite). History is copied to a temp folder first (the browser
// keeps it locked while it runs) and read with node:sqlite; the temp copy is removed in finally.
// Pure 1.1.1: its localStorage lives in the default session under http://localhost:3000. It is read from a
// hidden, sandboxed window on that session while a temporary protocol handler answers a blank page for
// exactly that URL; the handler is removed and the window destroyed in finally, with a 10 s timeout.
//
// Every failure reaches the page as { error } or as a `warning` next to the counts, never as a raw throw.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, app, session } = require('electron');
const security = require('./security');
const sessions = require('./sessions');
const storage = require('./storage');
const { log } = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEBKIT_EPOCH_MS = 11644473600000; // 1601-01-01 → 1970-01-01, in ms
const HISTORY_DAYS = 90;
const HISTORY_ROWS = 10000;
const BOOKMARK_NODES = 50000;
const MAX_DEPTH = 32;
const TIMEOUT_MS = 10000;
const PURE1_ORIGIN = 'http://localhost:3000';
const PURE1_PAGE = '<!doctype html><meta charset="utf-8"><title>Pure</title>';
const PURE1_SETTING_KEYS = [
  'accentColor', 'searchEngine', 'homepageLatitude', 'homepageLongitude', 'homepageTempUnit', 'homepageTimeFormat',
];

const SOURCES = [
  { id: 'chrome', name: 'Chrome', dir: ['Google', 'Chrome', 'User Data', 'Default'] },
  { id: 'edge', name: 'Edge', dir: ['Microsoft', 'Edge', 'User Data', 'Default'] },
  { id: 'brave', name: 'Brave', dir: ['BraveSoftware', 'Brave-Browser', 'User Data', 'Default'] },
];

let busy = false;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function profileDir(src) {
  return path.join(localAppData(), ...src.dir);
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const toBig = (v) => (typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0)));

// Chromium stores times as microseconds since 1601-01-01 (bookmark date_added is a string).
function webkitToMs(value) {
  const us = Number(value);
  if (!Number.isFinite(us) || us <= 0) return undefined;
  const ms = Math.round(us / 1000 - WEBKIT_EPOCH_MS);
  return ms > 0 ? ms : undefined;
}

// ── Detection ─────────────────────────────────────────────────────────────────

async function detectChromium(src) {
  const dir = profileDir(src);
  const parts = [];
  if (await exists(path.join(dir, 'Bookmarks'))) parts.push('Bookmarks');
  if (await exists(path.join(dir, 'History'))) parts.push('History');
  return {
    id: src.id,
    name: src.name,
    available: parts.length > 0,
    detail: parts.length ? parts.join(' · ') : 'Not found on this computer',
  };
}

async function detectPure1() {
  const leveldb = path.join(app.getPath('userData'), 'Local Storage', 'leveldb');
  const available = await exists(leveldb);
  return {
    id: 'pure1',
    name: 'Pure 1.1.1',
    available,
    detail: available ? 'Bookmarks · History · Settings' : 'Not found on this computer',
  };
}

// ── Chromium readers ──────────────────────────────────────────────────────────

async function readChromiumBookmarks(file) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const roots = isPlainObject(json) && isPlainObject(json.roots) ? json.roots : {};
  const out = [];
  const walk = (node, depth) => {
    if (!isPlainObject(node) || depth > MAX_DEPTH || out.length >= BOOKMARK_NODES) return;
    if (node.type === 'url' && typeof node.url === 'string') {
      out.push({
        url: node.url,
        title: typeof node.name === 'string' ? node.name : '',
        createdAt: webkitToMs(node.date_added),
      });
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  for (const key of ['bookmark_bar', 'other', 'synced']) walk(roots[key], 0);
  return out;
}

// Reads the last 90 days (≤ 10 000 rows) from a temp copy of History, including its WAL/journal files
// so that recent visits not yet checkpointed are included.
async function readChromiumHistory(dir) {
  const src = path.join(dir, 'History');
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pure-import-'));
  try {
    await fs.promises.copyFile(src, path.join(tmp, 'History'));
    for (const suffix of ['-journal', '-wal']) {
      await fs.promises.copyFile(src + suffix, path.join(tmp, 'History' + suffix)).catch(() => {});
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmp, 'History'));
    try {
      // Chrome times are ~1.3e16 µs, above Number.MAX_SAFE_INTEGER, so integers are read and bound as BigInt.
      const cutoff = (BigInt(Date.now() - HISTORY_DAYS * DAY_MS) + BigInt(WEBKIT_EPOCH_MS)) * 1000n;
      const stmt = db.prepare(
        'SELECT url, title, last_visit_time, visit_count FROM urls ' +
        'WHERE last_visit_time > ? ORDER BY last_visit_time DESC LIMIT ?',
      );
      stmt.setReadBigInts(true);
      const rows = stmt.all(cutoff, BigInt(HISTORY_ROWS));
      return rows.map((r) => ({
        url: String(r.url || ''),
        title: typeof r.title === 'string' ? r.title : '',
        visitedAt: Number(toBig(r.last_visit_time) / 1000n) - WEBKIT_EPOCH_MS,
        visitCount: Number(toBig(r.visit_count)) || 1,
      }));
    } finally {
      db.close();
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Pure 1.1.1 reader ─────────────────────────────────────────────────────────

// -> { [key]: string } copy of the 1.1.1 localStorage of http://localhost:3000.
async function readPure1Storage() {
  const ses = session.defaultSession;
  const handler = (request) => {
    if (request.url === PURE1_ORIGIN + '/') {
      return new Response(PURE1_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  };
  let win = null;
  let handled = false;
  try {
    ses.protocol.handle('http', handler);
    handled = true;
    win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    await withTimeout(win.loadURL(PURE1_ORIGIN + '/'), TIMEOUT_MS);
    const json = await withTimeout(win.webContents.executeJavaScript('JSON.stringify(localStorage)'), TIMEOUT_MS);
    const data = JSON.parse(typeof json === 'string' ? json : '{}');
    return isPlainObject(data) ? data : {};
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (handled) {
      try {
        ses.protocol.unhandle('http');
      } catch (err) {
        log('[importer] unhandle failed:', err && err.message);
      }
    }
  }
}

const storedString = (map, key) => (typeof map[key] === 'string' ? map[key] : undefined);

function storedJson(map, key) {
  const v = storedString(map, key);
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

// 1.1.1 appended bookmarks in order, so createdAt keeps that order once the list is sorted.
function pure1Bookmarks(map) {
  const list = storedJson(map, 'bookmarks');
  if (!Array.isArray(list)) return [];
  const base = Date.now() - list.length;
  return list
    .filter(isPlainObject)
    .map((b, i) => ({ url: b.url, title: b.title, createdAt: base + i }));
}

function pure1History(map) {
  const list = storedJson(map, 'browsingHistory');
  if (!Array.isArray(list)) return [];
  return list
    .filter(isPlainObject)
    .map((h) => ({ url: h.url, title: h.title, visitedAt: h.timestamp, visitCount: 1 }));
}

// 1.1.1 kept settings as strings. showWelcomeAnimation defaulted to on (anything but 'false').
function pure1SettingsPatch(map) {
  const patch = {};
  const quick = storedJson(map, 'quickLinks');
  if (Array.isArray(quick)) patch.quickLinks = quick;
  for (const key of PURE1_SETTING_KEYS) {
    const v = storedString(map, key);
    if (v !== undefined) patch[key] = v;
  }
  const welcome = storedString(map, 'showWelcomeAnimation');
  if (welcome !== undefined) patch.showWelcomeAnimation = welcome !== 'false';
  return patch;
}

// ── Runs ──────────────────────────────────────────────────────────────────────

async function importChromium(src, what) {
  const dir = profileDir(src);
  if (!(await exists(dir))) return { error: `${src.name} was not found on this computer.` };

  const out = { bookmarks: 0, history: 0, settings: false };
  const warnings = [];
  if (what.bookmarks) {
    try {
      out.bookmarks = storage.bookmarks.importMany(await readChromiumBookmarks(path.join(dir, 'Bookmarks')));
    } catch (err) {
      log(`[importer] ${src.id} bookmarks failed:`, err && err.message);
      warnings.push(`Could not read ${src.name} bookmarks.`);
    }
  }
  if (what.history) {
    try {
      out.history = storage.history.importMany(await readChromiumHistory(dir));
    } catch (err) {
      log(`[importer] ${src.id} history failed:`, err && err.message);
      warnings.push(`Could not read ${src.name} history. Close ${src.name} and try again.`);
    }
  }
  if (warnings.length) out.warning = warnings.join(' ');
  return out;
}

async function importPure1(what) {
  let map;
  try {
    map = await readPure1Storage();
  } catch (err) {
    log('[importer] pure1 read failed:', err && err.message);
    return { error: 'Could not read Pure 1.1.1 data. Make sure Pure 1.1.1 is closed and try again.' };
  }
  const out = { bookmarks: 0, history: 0, settings: false };
  if (what.bookmarks) out.bookmarks = storage.bookmarks.importMany(pure1Bookmarks(map));
  if (what.history) out.history = storage.history.importMany(pure1History(map));
  if (what.settings) {
    const patch = pure1SettingsPatch(map);
    if (Object.keys(patch).length) {
      storage.settings.set(patch);
      out.settings = true;
    }
  }
  return out;
}

async function run(id, rawWhat) {
  if (busy) return { error: 'An import is already running.' };
  const what = isPlainObject(rawWhat) ? rawWhat : {};
  const opts = {
    bookmarks: what.bookmarks === true,
    history: what.history === true,
    settings: what.settings === true,
  };
  if (!opts.bookmarks && !opts.history && !opts.settings) return { error: 'Choose something to import.' };

  busy = true;
  try {
    if (id === 'pure1') return await importPure1(opts);
    const src = SOURCES.find((s) => s.id === id);
    if (!src) return { error: 'Unknown import source.' };
    return await importChromium(src, opts);
  } catch (err) {
    log('[importer] import failed:', err && err.message);
    return { error: 'The import failed. Please try again.' };
  } finally {
    busy = false;
  }
}

async function detectAll() {
  const out = [];
  for (const src of SOURCES) out.push(await detectChromium(src));
  out.push(await detectPure1());
  return out;
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function isIncognito(event) {
  return sessions.isIncognitoSession(event.sender.session);
}

function registerIpc(ipcMain) {
  ipcMain.handle('import:detect', async (event) => {
    if (!security.isInternalSender(event) || isIncognito(event)) return [];
    try {
      return await detectAll();
    } catch (err) {
      log('[importer] detect failed:', err && err.message);
      return [];
    }
  });

  ipcMain.handle('import:run', async (event, id, what) => {
    if (!security.isInternalSender(event)) return { error: 'Import is not available here.' };
    if (isIncognito(event)) return { error: 'Import is not available in incognito windows.' };
    if (typeof id !== 'string') return { error: 'Unknown import source.' };
    return run(id, what);
  });
}

module.exports = { registerIpc };
