'use strict';
// Import from other browsers, password managers and files (owner: F1, 2.5 round). Internal senders only; refused
// in incognito windows. Read-only with respect to the other browsers' profiles.
//
// Sources: Chrome, Edge, Brave, Vivaldi, Chromium (Chromium-family "User Data" folders, every profile listed from
// Local State), Opera and Opera GX (profile folder is the root itself), Firefox (profiles.ini), Pure 1.1.1.
// Chromium SQLite files (History, Login Data) and Firefox places.sqlite are copied to a temp folder first (the
// browser keeps them locked while it runs) and read with node:sqlite; the temp copy is removed in finally.
// Chromium passwords: Local State's os_crypt key is unwrapped with Windows DPAPI (CurrentUser) through a short
// PowerShell helper that gets its input on stdin; v10/v11 values are AES-256-GCM. v20 values are app-bound and
// can't be read by other apps: they are counted and reported as a warning.
// Plaintext passwords only ever travel from here to passwords.importLogins() (main). They are never logged, never
// written to disk, never put on a command line and never sent to a renderer.
// Dev/test: when PURE_IMPORT_ROOT is set and the app is not packaged, %LOCALAPPDATA% and %APPDATA% resolve under
// <root>/Local and <root>/Roaming instead.
//
// Every failure reaches the page as { error } or as a string in `warnings`, never as a raw throw.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { BrowserWindow, app, dialog, session } = require('electron');
const security = require('./security');
const sessions = require('./sessions');
const storage = require('./storage');
const { log } = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEBKIT_EPOCH_MS = 11644473600000; // 1601-01-01 → 1970-01-01, in ms
const HISTORY_DAYS = 90;
const HISTORY_ROWS = 10000;
const BOOKMARK_ROWS = 50000;
const LOGIN_ROWS = 20000;
const IMPORT_CHUNK = 250; // passwords handed to importLogins() at a time (bounds the plaintext held at once)
const MAX_DEPTH = 32;
const TIMEOUT_MS = 10000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_INI_BYTES = 1024 * 1024;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_HTML_BOOKMARKS = 20000;
const MAX_TITLE = 300;
const PROFILE_DIR_RE = /^(Default|Profile \d{1,3})$/;
const DATA_FILES = { bookmarks: 'Bookmarks', history: 'History', passwords: 'Login Data' };
const PURE1_ORIGIN = 'http://localhost:3000';
const PURE1_PAGE = '<!doctype html><meta charset="utf-8"><title>Pure</title>';
const PURE1_SETTING_KEYS = [
  'accentColor', 'searchEngine', 'homepageLatitude', 'homepageLongitude', 'homepageTempUnit', 'homepageTimeFormat',
];
const FIREFOX_PASSWORDS_HINT = 'Firefox passwords can\u2019t be read by other apps. Export a CSV from Firefox ' +
  '(about:logins \u203A \u22EF \u203A Export) and use From a file here.';

// layout 'user-data': profiles are sub-folders of the base folder (Local State sits in the base folder).
// layout 'root': the base folder is the profile itself (Opera, Opera GX).
const SOURCES = [
  { id: 'chrome', name: 'Chrome', kind: 'chromium', base: 'local', dir: ['Google', 'Chrome', 'User Data'], layout: 'user-data' },
  { id: 'edge', name: 'Edge', kind: 'chromium', base: 'local', dir: ['Microsoft', 'Edge', 'User Data'], layout: 'user-data' },
  { id: 'brave', name: 'Brave', kind: 'chromium', base: 'local', dir: ['BraveSoftware', 'Brave-Browser', 'User Data'], layout: 'user-data' },
  { id: 'vivaldi', name: 'Vivaldi', kind: 'chromium', base: 'local', dir: ['Vivaldi', 'User Data'], layout: 'user-data' },
  { id: 'chromium', name: 'Chromium', kind: 'chromium', base: 'local', dir: ['Chromium', 'User Data'], layout: 'user-data' },
  { id: 'opera', name: 'Opera', kind: 'chromium', base: 'roaming', dir: ['Opera Software', 'Opera Stable'], layout: 'root' },
  { id: 'opera-gx', name: 'Opera GX', kind: 'chromium', base: 'roaming', dir: ['Opera Software', 'Opera GX Stable'], layout: 'root' },
  { id: 'firefox', name: 'Firefox', kind: 'firefox', base: 'roaming', dir: ['Mozilla', 'Firefox'] },
];

let busy = false;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Locations ─────────────────────────────────────────────────────────────────

function roots() {
  const override = process.env.PURE_IMPORT_ROOT;
  if (override && !app.isPackaged) {
    const base = path.resolve(override);
    return { local: path.join(base, 'Local'), roaming: path.join(base, 'Roaming') };
  }
  return {
    local: process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    roaming: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  };
}

function isSafeName(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 80 && id !== '.' && id !== '..' &&
    !/[\\/:*?"<>|\x00-\x1f]/.test(id);
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(file, maxBytes) {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return (await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

async function readJsonFile(file, maxBytes) {
  const text = await readTextFile(file, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Chromium stores times as microseconds since 1601-01-01 (bookmark date_added is a string).
function webkitToMs(value) {
  const us = Number(value);
  if (!Number.isFinite(us) || us <= 0) return undefined;
  const ms = Math.round(us / 1000 - WEBKIT_EPOCH_MS);
  return ms > 0 ? ms : undefined;
}

function microsToMs(value) {
  const us = Number(value);
  if (!Number.isFinite(us) || us <= 0) return undefined;
  return Math.round(us / 1000);
}

// ── Profile discovery ─────────────────────────────────────────────────────────

function profileRank(p) {
  if (p.id === 'Default' || p.id === 'root') return [0, 0];
  const m = /^Profile (\d+)$/.exec(p.id);
  return m ? [1, Number(m[1])] : [2, 0];
}

function sortProfiles(list) {
  return list.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const [ra, na] = profileRank(a);
    const [rb, nb] = profileRank(b);
    return ra - rb || na - nb || a.name.localeCompare(b.name);
  });
}

async function chromiumFiles(dir) {
  return {
    bookmarks: await exists(path.join(dir, DATA_FILES.bookmarks)),
    history: await exists(path.join(dir, DATA_FILES.history)),
    passwords: await exists(path.join(dir, DATA_FILES.passwords)),
  };
}

const hasData = (files) => files.bookmarks || files.history || files.passwords;

async function chromiumProfiles(src, bases) {
  const base = path.join(bases[src.base], ...src.dir);
  if (src.layout === 'root') {
    const files = await chromiumFiles(base);
    if (!hasData(files)) return [];
    return [{ id: 'root', name: src.name, dir: base, stateDir: base, files, isDefault: true }];
  }
  const state = await readJsonFile(path.join(base, 'Local State'), MAX_JSON_BYTES);
  const cache = isPlainObject(state) && isPlainObject(state.profile) && isPlainObject(state.profile.info_cache)
    ? state.profile.info_cache : {};
  const ids = new Set(Object.keys(cache));
  try {
    for (const entry of await fs.promises.readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory() && PROFILE_DIR_RE.test(entry.name)) ids.add(entry.name);
    }
  } catch {
    // No User Data folder: no profiles.
  }
  const out = [];
  for (const id of ids) {
    if (!isSafeName(id)) continue;
    const dir = path.join(base, id);
    const files = await chromiumFiles(dir);
    if (!hasData(files)) continue;
    const info = cache[id];
    const name = isPlainObject(info) && typeof info.name === 'string' && info.name.trim()
      ? info.name.trim().slice(0, 80) : id;
    out.push({ id, name, dir, stateDir: base, files, isDefault: id === 'Default' });
  }
  return sortProfiles(out);
}

// profiles.ini: [ProfileN] Name/Path/IsRelative/Default, [InstallXXXX] Default = the default profile folder.
function parseIni(text) {
  const sections = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';' || line[0] === '#') continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1];
      if (!sections.has(current)) sections.set(current, {});
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0 && current !== null) sections.get(current)[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

async function firefoxProfiles(src, bases) {
  const root = path.join(bases[src.base], ...src.dir);
  const text = await readTextFile(path.join(root, 'profiles.ini'), MAX_INI_BYTES);
  if (text === null) return [];
  const sections = parseIni(text);
  const resolveFolder = (p, relative) => (relative ? path.resolve(root, p) : path.resolve(p));
  let installDefault = null;
  for (const [name, kv] of sections) {
    if (/^Install/i.test(name) && kv.Default) installDefault = resolveFolder(kv.Default, true);
  }
  const out = [];
  for (const [name, kv] of sections) {
    if (!/^Profile\d+$/i.test(name) || !kv.Path || !isSafeName(name)) continue;
    const dir = resolveFolder(kv.Path, kv.IsRelative !== '0');
    if (!(await exists(path.join(dir, 'places.sqlite')))) continue;
    const label = typeof kv.Name === 'string' && kv.Name.trim() ? kv.Name.trim().slice(0, 80) : path.basename(dir);
    out.push({
      id: name,
      name: label,
      dir,
      stateDir: dir,
      files: { bookmarks: true, history: true, passwords: false },
      isDefault: kv.Default === '1' || (installDefault !== null && dir === installDefault),
    });
  }
  return sortProfiles(out);
}

async function scanSource(src, bases) {
  const profiles = src.kind === 'firefox' ? await firefoxProfiles(src, bases) : await chromiumProfiles(src, bases);
  const supports = { bookmarks: false, history: false, passwords: false, settings: false };
  for (const p of profiles) {
    if (p.files.bookmarks) supports.bookmarks = true;
    if (p.files.history) supports.history = true;
    if (p.files.passwords && src.kind !== 'firefox') supports.passwords = true;
  }
  return { profiles, supports };
}

function publicSource(src, scan) {
  const available = scan.profiles.length > 0;
  const found = [];
  if (scan.supports.bookmarks) found.push('Bookmarks');
  if (scan.supports.history) found.push('History');
  if (scan.supports.passwords) found.push('Passwords');
  let detail = 'Not found on this computer';
  if (available) {
    const count = scan.profiles.length;
    detail = `${count === 1 ? '1 profile' : `${count} profiles`} \u00B7 ${found.join(' \u00B7 ')}`;
  }
  return {
    id: src.id,
    name: src.name,
    browser: src.id,
    available,
    detail,
    profiles: scan.profiles.map((p) => ({ id: p.id, name: p.name })),
    supports: { ...scan.supports },
  };
}

async function detectPure1() {
  const leveldb = path.join(app.getPath('userData'), 'Local Storage', 'leveldb');
  const available = await exists(leveldb);
  return {
    id: 'pure1',
    name: 'Pure 1.1.1',
    browser: 'pure1',
    available,
    detail: available ? 'Bookmarks \u00B7 History \u00B7 Settings' : 'Not found on this computer',
    profiles: [],
    supports: { bookmarks: available, history: available, passwords: false, settings: available },
  };
}

async function detectAll() {
  const bases = roots();
  const out = [];
  for (const src of SOURCES) out.push(publicSource(src, await scanSource(src, bases)));
  out.push(await detectPure1());
  return out;
}

// ── SQLite copies ─────────────────────────────────────────────────────────────

// Copies name (+ its -journal / -wal) to a temp folder, runs fn(db) on the copy and removes the copy. fn is sync.
async function withDbCopy(dir, name, fn) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pure-import-'));
  try {
    await fs.promises.copyFile(path.join(dir, name), path.join(tmp, name));
    for (const suffix of ['-journal', '-wal']) {
      await fs.promises.copyFile(path.join(dir, name + suffix), path.join(tmp, name + suffix)).catch(() => {});
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmp, name));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Bookmarks / history readers ───────────────────────────────────────────────

// Chromium "Bookmarks" JSON, flattened in source order (bookmark bar, other, synced).
async function readChromiumBookmarks(file) {
  const st = await fs.promises.stat(file).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!st) return [];
  if (st.size > MAX_JSON_BYTES) throw new Error('bookmarks file too large');
  const json = JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const roots = isPlainObject(json) && isPlainObject(json.roots) ? json.roots : {};
  const out = [];
  const walk = (node, depth) => {
    if (!isPlainObject(node) || depth > MAX_DEPTH || out.length >= BOOKMARK_ROWS) return;
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

// Last 90 days (≤ 10 000 rows) of the copied Chromium History database.
function readChromiumHistory(db) {
  // Chrome times are ~1.3e16 µs, above Number.MAX_SAFE_INTEGER, so integers are read and bound as BigInt.
  const cutoff = (BigInt(Date.now() - HISTORY_DAYS * DAY_MS) + BigInt(WEBKIT_EPOCH_MS)) * 1000n;
  const stmt = db.prepare(
    "SELECT url, title, last_visit_time, visit_count FROM urls " +
    `WHERE last_visit_time > ? AND url LIKE 'http%' ORDER BY last_visit_time DESC LIMIT ${HISTORY_ROWS}`,
  );
  stmt.setReadBigInts(true);
  return stmt.all(cutoff).map((r) => ({
    url: String(r.url || ''),
    title: typeof r.title === 'string' ? r.title : '',
    visitedAt: Number(BigInt(r.last_visit_time) / 1000n) - WEBKIT_EPOCH_MS,
    visitCount: Number(BigInt(r.visit_count || 1)) || 1,
  }));
}

// Firefox bookmarks (moz_bookmarks type 1 joined to moz_places), toolbar first, flattened.
function readFirefoxBookmarks(db) {
  return db.prepare(
    'SELECT b.title AS title, p.url AS url, b.dateAdded AS added FROM moz_bookmarks b ' +
    "JOIN moz_places p ON p.id = b.fk WHERE b.type = 1 AND p.url LIKE 'http%' " +
    `ORDER BY CASE WHEN b.parent = 3 THEN 0 ELSE 1 END, b.parent, b.position LIMIT ${BOOKMARK_ROWS}`,
  ).all().map((r) => ({
    url: String(r.url || ''),
    title: typeof r.title === 'string' ? r.title : '',
    createdAt: microsToMs(r.added),
  }));
}

// Firefox history: one row per page, last 90 days (≤ 10 000 rows). visit_date is microseconds since 1970.
function readFirefoxHistory(db) {
  const cutoff = (Date.now() - HISTORY_DAYS * DAY_MS) * 1000;
  return db.prepare(
    'SELECT p.url AS url, p.title AS title, MAX(v.visit_date) AS last, COUNT(*) AS n ' +
    'FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id ' +
    `WHERE v.visit_date > ? AND p.url LIKE 'http%' GROUP BY p.id ORDER BY last DESC LIMIT ${HISTORY_ROWS}`,
  ).all(cutoff).map((r) => ({
    url: String(r.url || ''),
    title: typeof r.title === 'string' ? r.title : '',
    visitedAt: microsToMs(r.last),
    visitCount: Number(r.n) || 1,
  }));
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

// ── Chromium passwords ────────────────────────────────────────────────────────

// Unwraps DPAPI blobs (CurrentUser scope) in one PowerShell call. Input: one base64 blob per line on stdin; output:
// one line per blob, "+<base64 plaintext>" or "-" when it can't be unwrapped. The script travels as -EncodedCommand,
// so nothing secret is on the command line. Resolves with null entries on any failure.
const DPAPI_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'", // progress output would otherwise be written to stdout
  'Add-Type -AssemblyName System.Security',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$out = New-Object System.Text.StringBuilder',
  'foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) {',
  '  $t = $line.Trim()',
  '  if ($t.Length -eq 0) { continue }',
  '  try {',
  '    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($t), $null, $scope)',
  "    [void]$out.Append('+').Append([Convert]::ToBase64String($plain)).Append([char]10)",
  "  } catch { [void]$out.Append('-').Append([char]10) }",
  '}',
  '[Console]::Out.Write($out.ToString())',
].join('\n');

function dpapiUnprotect(blobs) {
  const fail = () => blobs.map(() => null);
  if (!blobs.length) return Promise.resolve([]);
  if (process.platform !== 'win32') return Promise.resolve(fail());
  return new Promise((resolve) => {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64');
    let child;
    try {
      child = execFile(
        exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          // stdout (plaintext keys) is never logged; only the failure is.
          if (err) {
            log('[importer] DPAPI helper failed');
            resolve(fail());
            return;
          }
          // Only "+" / "-" result lines count; anything else PowerShell printed is ignored.
          const lines = String(stdout).split(/\r?\n/).filter((l) => l[0] === '+' || l[0] === '-');
          resolve(blobs.map((_, i) => {
            const line = lines[i] || '';
            return line[0] === '+' ? Buffer.from(line.slice(1), 'base64') : null;
          }));
        },
      );
    } catch (err) {
      log('[importer] DPAPI helper could not start:', err && err.message);
      resolve(fail());
      return;
    }
    child.stdin.on('error', () => {});
    child.stdin.end(blobs.map((b) => b.toString('base64')).join('\n') + '\n');
  });
}

async function readEncryptedKey(stateDir) {
  const state = await readJsonFile(path.join(stateDir, 'Local State'), MAX_JSON_BYTES);
  const enc = isPlainObject(state) && isPlainObject(state.os_crypt) ? state.os_crypt.encrypted_key : null;
  if (typeof enc !== 'string' || !enc) return null;
  const raw = Buffer.from(enc, 'base64');
  if (raw.length <= 5 || raw.subarray(0, 5).toString('latin1') !== 'DPAPI') return null;
  return Buffer.from(raw.subarray(5));
}

// -> plaintext Buffer, an empty Buffer, or null when the value can't be authenticated with this key.
function decryptV10(enc, key) {
  if (enc.length < 31) return null; // 3-byte version + 12-byte nonce + 16-byte tag
  const nonce = enc.subarray(3, 15);
  const body = enc.subarray(15, enc.length - 16);
  const tag = enc.subarray(enc.length - 16);
  if (body.length === 0) return Buffer.alloc(0);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

// Origin of a Chromium origin_url, or null for android://, chrome:// and other non-web rows.
function webOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

const plural = (n, one, many) => (n === 1 ? one : many);

async function importChromiumPasswords(src, profile, out) {
  const keyBlob = await readEncryptedKey(profile.stateDir);
  const unlockWarning = `Could not unlock ${src.name}'s saved passwords.`;
  if (!keyBlob) {
    out.warnings.push(unlockWarning);
    return;
  }
  const [masterKey] = await dpapiUnprotect([keyBlob]);
  keyBlob.fill(0);
  if (!masterKey || masterKey.length !== 32) {
    if (masterKey) masterKey.fill(0);
    out.warnings.push(unlockWarning);
    return;
  }

  let rows;
  try {
    rows = await withDbCopy(profile.dir, DATA_FILES.passwords, (db) => db.prepare(
      'SELECT origin_url AS origin, username_value AS username, password_value AS password FROM logins ' +
      `WHERE COALESCE(blacklisted_by_user, 0) = 0 LIMIT ${LOGIN_ROWS}`,
    ).all());
  } catch (err) {
    log(`[importer] ${src.id} passwords read failed:`, err && err.message);
    masterKey.fill(0);
    out.warnings.push(`Could not read ${src.name} passwords. Close ${src.name} and try again.`);
    return;
  }
  // Encrypted values only from here on; plaintext exists just for one chunk at a time.
  const entries = [];
  let v20 = 0;
  let failed = 0;
  for (const r of rows) {
    const origin = webOrigin(r.origin);
    if (!origin || !(r.password instanceof Uint8Array) || r.password.length === 0) continue;
    const enc = Buffer.from(r.password);
    const prefix = enc.subarray(0, 3).toString('latin1');
    if (prefix === 'v20') {
      v20++;
      enc.fill(0);
      continue;
    }
    entries.push({
      origin,
      username: typeof r.username === 'string' ? r.username : '',
      enc,
      legacy: prefix !== 'v10' && prefix !== 'v11',
    });
  }
  rows.length = 0;

  // Pre-2020 entries are wrapped with DPAPI directly (no version prefix). Unwrap them in one helper call.
  const legacy = entries.filter((e) => e.legacy);
  const legacyPlain = legacy.length ? await dpapiUnprotect(legacy.map((e) => e.enc)) : [];
  let legacyIndex = 0;

  let batch = [];
  let stopped = false;
  const flush = async () => {
    if (!batch.length || stopped) {
      batch = [];
      return;
    }
    const res = await importLoginRows(batch, src.id);
    batch = [];
    if (res.error) {
      out.warnings.push(res.error);
      stopped = true;
      return;
    }
    out.passwords += res.added;
    out.passwordsUpdated += res.updated;
  };

  for (const e of entries) {
    if (stopped) break;
    const plain = e.legacy ? legacyPlain[legacyIndex++] : decryptV10(e.enc, masterKey);
    e.enc.fill(0);
    if (!plain) {
      failed++;
      continue;
    }
    const password = plain.toString('utf8');
    plain.fill(0);
    if (!password) continue;
    batch.push({ origin: e.origin, username: e.username, password });
    if (batch.length >= IMPORT_CHUNK) await flush();
  }
  await flush();
  masterKey.fill(0);

  if (v20 > 0) {
    const word = plural(v20, 'password', 'passwords');
    const them = plural(v20, 'it', 'them');
    out.warnings.push(
      `${src.name} protects ${v20} ${word} so only ${src.name} can read ${them}. ` +
      `Export ${them} from ${src.name} (Settings \u203A Passwords \u203A Export) and import the CSV here.`,
    );
  }
  if (failed > 0) {
    out.warnings.push(`${failed} saved ${plural(failed, 'password', 'passwords')} could not be unlocked and were skipped.`);
  }
}

// ── Password saving (F5: passwords.importLogins) ──────────────────────────────

function loadPasswords() {
  try {
    const mod = require('./passwords');
    return mod && typeof mod.importLogins === 'function' ? mod : null;
  } catch (err) {
    log('[importer] passwords module failed:', err && err.message);
    return null;
  }
}

// rows: [{origin, username, password}] -> { added, updated, skipped } or { error }. Never logs the rows.
async function importLoginRows(rows, source) {
  const mod = loadPasswords();
  if (!mod) return { error: 'Passwords can\u2019t be saved in this version of Pure.', added: 0, updated: 0, skipped: 0 };
  try {
    const res = await mod.importLogins(rows, { source });
    if (!res || res.error) {
      const reason = {
        'encryption-unavailable': 'Windows encryption isn\u2019t available, so Pure can\u2019t store passwords. Nothing was saved.',
        'passwords-disabled': 'Offering to save passwords is turned off in Settings \u203a Passwords. Nothing was saved.',
        unreadable: 'Pure\u2019s saved passwords couldn\u2019t be read. Nothing was saved.',
      }[res && res.error] || 'Pure couldn\u2019t save the passwords. Try again.';
      return { error: reason, added: 0, updated: 0, skipped: rows.length };
    }
    return {
      added: Number(res.added) || 0,
      updated: Number(res.updated) || 0,
      skipped: Number(res.skipped) || 0,
    };
  } catch (err) {
    log('[importer] passwords import failed:', err && err.message);
    return { error: 'Pure couldn\u2019t save the passwords. Try again.', added: 0, updated: 0, skipped: 0 };
  }
}

// ── Runs ──────────────────────────────────────────────────────────────────────

function emptyResult() {
  return { bookmarks: 0, history: 0, passwords: 0, passwordsUpdated: 0, settings: false, warnings: [] };
}

async function step(out, warning, fn) {
  try {
    await fn();
  } catch (err) {
    log('[importer] step failed:', err && err.message);
    out.warnings.push(warning);
  }
}

async function importChromium(src, profile, what, out) {
  if (what.bookmarks && profile.files.bookmarks) {
    await step(out, `Could not read ${src.name} bookmarks.`, async () => {
      out.bookmarks = storage.bookmarks.importMany(await readChromiumBookmarks(path.join(profile.dir, DATA_FILES.bookmarks)));
    });
  }
  if (what.history && profile.files.history) {
    await step(out, `Could not read ${src.name} history. Close ${src.name} and try again.`, async () => {
      const rows = await withDbCopy(profile.dir, DATA_FILES.history, readChromiumHistory);
      out.history = storage.history.importMany(rows);
    });
  }
  if (what.passwords && profile.files.passwords) {
    await step(out, `Could not read ${src.name} passwords.`, () => importChromiumPasswords(src, profile, out));
  }
}

async function importFirefox(src, profile, what, out) {
  if (what.passwords) out.warnings.push(FIREFOX_PASSWORDS_HINT);
  if (!what.bookmarks && !what.history) return;
  await step(out, `Could not read ${src.name} bookmarks and history. Close ${src.name} and try again.`, async () => {
    await withDbCopy(profile.dir, 'places.sqlite', (db) => {
      if (what.bookmarks) out.bookmarks = storage.bookmarks.importMany(readFirefoxBookmarks(db));
      if (what.history) out.history = storage.history.importMany(readFirefoxHistory(db));
    });
  });
}

function pickProfile(profiles, id) {
  if (id === undefined) return profiles[0] || null;
  return profiles.find((p) => p.id === id) || null;
}

async function importBrowser(src, what) {
  const scan = await scanSource(src, roots());
  if (!scan.profiles.length) return { error: `${src.name} was not found on this computer.` };
  const profile = pickProfile(scan.profiles, what.profile);
  if (!profile) return { error: 'That profile was not found. Refresh the list and try again.' };
  const out = emptyResult();
  if (src.kind === 'firefox') await importFirefox(src, profile, what, out);
  else await importChromium(src, profile, what, out);
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
  const out = emptyResult();
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

// what: { profile?, bookmarks, history, passwords, settings } -> normalised copy, or { error }.
function parseWhat(raw) {
  const w = isPlainObject(raw) ? raw : {};
  let profile;
  if (w.profile !== undefined && w.profile !== null) {
    if (typeof w.profile !== 'string' || !isSafeName(w.profile)) return { error: 'That profile was not found.' };
    profile = w.profile;
  }
  return {
    profile,
    bookmarks: w.bookmarks === true,
    history: w.history === true,
    passwords: w.passwords === true,
    settings: w.settings === true,
  };
}

async function run(id, rawWhat) {
  if (busy) return { error: 'An import is already running.' };
  const what = parseWhat(rawWhat);
  if (what.error) return what;
  if (!what.bookmarks && !what.history && !what.passwords && !what.settings) {
    return { error: 'Choose something to import.' };
  }
  busy = true;
  try {
    if (id === 'pure1') {
      return await importPure1({ bookmarks: what.bookmarks, history: what.history, settings: what.settings });
    }
    const src = SOURCES.find((s) => s.id === id);
    if (!src) return { error: 'Unknown import source.' };
    return await importBrowser(src, what);
  } catch (err) {
    log('[importer] import failed:', err && err.message);
    return { error: 'The import failed. Please try again.' };
  } finally {
    busy = false;
  }
}

// ── Files: CSV passwords, Netscape bookmarks HTML, export ─────────────────────

function dialogParent() {
  try {
    return require('./windows').getLastFocusedBrowserWindow() || undefined;
  } catch {
    return undefined;
  }
}

async function pickOpenFile(title, filters) {
  const opts = { title, properties: ['openFile', 'dontAddToRecent'], filters };
  const parent = dialogParent();
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

// RFC 4180: quoted fields with "" escapes, commas and line breaks inside quotes, CRLF or LF. -> string[][]
function parseCsv(input) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
      continue;
    }
    if (c === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      fieldStart = true;
      i++;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStart = true;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      fieldStart = false;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// Column positions for the header of a password export (Chrome/Edge/Brave/Opera/Vivaldi, Firefox, Bitwarden,
// 1Password, LastPass, Dashlane, Keeper and similar). Case-insensitive. -> null when the file isn't one.
function mapCsvColumns(header) {
  const names = header.map((h) => String(h).trim().toLowerCase());
  const find = (candidates) => {
    for (const c of candidates) {
      const i = names.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };
  const pass = find(['password', 'login_password']);
  const url = find(['url', 'login_uri', 'website', 'website address', 'uri', 'origin', 'formactionorigin', 'hostname']);
  if (pass < 0 || url < 0) return null;
  return {
    url,
    user: find(['username', 'login_username', 'user name', 'login', 'user']),
    pass,
    type: names.indexOf('type'), // Bitwarden exports notes and cards too; only "login" rows are passwords
  };
}

// 'example.com' → https://example.com; android://, file: and other non-web values → null.
function csvOrigin(raw) {
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function importPasswordsCsv() {
  const file = await pickOpenFile('Choose a password CSV', [{ name: 'CSV files', extensions: ['csv'] }]);
  if (!file) return null;
  const st = await fs.promises.stat(file);
  if (!st.isFile()) return { error: 'Choose a CSV file.' };
  if (st.size > MAX_CSV_BYTES) return { error: 'That file is larger than 5 MB. Password exports are much smaller, so check that you picked the right file.' };

  let buf = await fs.promises.readFile(file);
  let table;
  try {
    table = parseCsv(buf.toString('utf8'));
  } finally {
    buf.fill(0);
    buf = null;
  }
  const cols = table.length ? mapCsvColumns(table[0]) : null;
  if (!cols) {
    table = null;
    return { error: 'This file doesn\u2019t look like a password export. Use a CSV exported from a browser or password manager.' };
  }

  const entries = [];
  let skipped = 0;
  const warnings = [];
  for (let i = 1; i < table.length; i++) {
    if (entries.length >= LOGIN_ROWS) {
      warnings.push(`Only the first ${LOGIN_ROWS.toLocaleString('en-US')} rows were read.`);
      break;
    }
    const r = table[i];
    if (cols.type >= 0) {
      const kind = (r[cols.type] || '').trim().toLowerCase();
      if (kind && kind !== 'login') {
        skipped++;
        continue;
      }
    }
    const password = r[cols.pass] || '';
    const origin = csvOrigin(r[cols.url] || '');
    if (!password || !origin) {
      skipped++;
      continue;
    }
    entries.push({ origin, username: cols.user >= 0 ? r[cols.user] || '' : '', password });
  }
  table = null;

  const out = { passwords: 0, passwordsUpdated: 0, skipped, warnings };
  for (let i = 0; i < entries.length; i += IMPORT_CHUNK) {
    const res = await importLoginRows(entries.slice(i, i + IMPORT_CHUNK), 'csv');
    if (res.error) return { error: res.error };
    out.passwords += res.added;
    out.passwordsUpdated += res.updated;
    out.skipped += res.skipped;
  }
  entries.length = 0;
  return out;
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = named[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Netscape bookmark file (the format every browser reads). Only <A HREF> entries are read; folders are flattened.
function parseBookmarksHtml(text) {
  const out = [];
  const tag = /<a\s([^>]*)>/gi;
  const attr = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = tag.exec(text)) !== null && out.length < MAX_HTML_BOOKMARKS) {
    const attrs = new Map();
    attr.lastIndex = 0;
    let a;
    while ((a = attr.exec(m[1])) !== null) {
      attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    }
    const href = decodeEntities(attrs.get('href') || '').trim();
    let url = null;
    if (href.length <= 2048) {
      try {
        const u = new URL(href);
        if (u.protocol === 'http:' || u.protocol === 'https:') url = href;
      } catch {
        url = null;
      }
    }
    const start = tag.lastIndex;
    const end = text.indexOf('<', start);
    if (!url) continue;
    const titleRaw = text.slice(start, end < 0 ? text.length : Math.min(end, start + 2000));
    const title = decodeEntities(titleRaw).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    const added = Number(attrs.get('add_date'));
    out.push({
      url,
      title: title || url,
      createdAt: Number.isFinite(added) && added > 0 ? added * 1000 : undefined,
    });
  }
  return out;
}

async function importBookmarksHtml() {
  const file = await pickOpenFile('Choose a bookmarks file', [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }]);
  if (!file) return null;
  const st = await fs.promises.stat(file);
  if (!st.isFile()) return { error: 'Choose an HTML file.' };
  if (st.size > MAX_HTML_BYTES) return { error: 'That file is larger than 10 MB.' };
  const list = parseBookmarksHtml(await fs.promises.readFile(file, 'utf8'));
  if (!list.length) return { bookmarks: 0, found: 0, skipped: 0, warnings: ['No bookmarks were found in that file.'] };
  const added = storage.bookmarks.importMany(list);
  return { bookmarks: added, found: list.length, skipped: list.length - added, warnings: [] };
}

function buildBookmarksHtml(list) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  for (const b of list) {
    const added = Number.isFinite(b.createdAt) && b.createdAt > 0 ? Math.floor(b.createdAt / 1000) : 0;
    const title = String(b.title || b.url).replace(/[\r\n\t]+/g, ' ');
    lines.push(`    <DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${added}">${escapeHtml(title)}</A>`);
  }
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}

function localDateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function exportBookmarks() {
  const list = storage.bookmarks.list();
  const opts = {
    title: 'Export bookmarks',
    defaultPath: path.join(app.getPath('downloads'), `Pure bookmarks ${localDateStamp()}.html`),
    filters: [{ name: 'Bookmarks (HTML)', extensions: ['html'] }],
  };
  const parent = dialogParent();
  const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
  if (!res || res.canceled || !res.filePath) return null;
  const file = /\.html?$/i.test(res.filePath) ? res.filePath : `${res.filePath}.html`;
  await fs.promises.writeFile(file, buildBookmarksHtml(list), 'utf8');
  return { ok: true, count: list.length, path: file };
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function isIncognito(event) {
  return sessions.isIncognitoSession(event.sender.session);
}

// null when the call may proceed, otherwise the { error } to return.
function refuse(event) {
  if (!security.isInternalSender(event)) return { error: 'Import is not available here.' };
  if (isIncognito(event)) return { error: 'Import is not available in incognito windows.' };
  return null;
}

async function guarded(event, fn) {
  const denied = refuse(event);
  if (denied) return denied;
  if (busy) return { error: 'An import is already running.' };
  busy = true;
  try {
    return await fn();
  } catch (err) {
    log('[importer] file action failed:', err && err.message);
    return { error: 'The import failed. Please try again.' };
  } finally {
    busy = false;
  }
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
    const denied = refuse(event);
    if (denied) return denied;
    if (typeof id !== 'string') return { error: 'Unknown import source.' };
    return run(id, what);
  });

  ipcMain.handle('import:file', async (event, kind) => {
    if (kind !== 'passwords-csv' && kind !== 'bookmarks-html') return { error: 'Unknown file type.' };
    return guarded(event, () => (kind === 'passwords-csv' ? importPasswordsCsv() : importBookmarksHtml()));
  });

  ipcMain.handle('export:bookmarks', async (event) => guarded(event, () => exportBookmarks()));
}

module.exports = {
  registerIpc,
  // Parsers and readers, exposed for the scratch test scripts only.
  _test: {
    parseCsv,
    mapCsvColumns,
    csvOrigin,
    parseBookmarksHtml,
    buildBookmarksHtml,
    parseIni,
    decryptV10,
    detectAll,
    dpapiUnprotect,
    run,
  },
};
