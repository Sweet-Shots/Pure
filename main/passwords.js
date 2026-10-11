'use strict';
// main/passwords.js — saved logins, save offers, autofill, strong password generator and bulk import (C1 / F5).
//
// Storage: userData/profile/logins.json = { version, logins: [{id, origin, username, passwordEnc, createdAt,
// updatedAt}], never: [origin] }. passwordEnc is base64 of safeStorage.encryptString (DPAPI on Windows). No
// plaintext password is written to disk, logged, or kept after a call returns (offers keep the ciphertext too).
//
// Rules (security-critical):
// - Only http(s) frames whose top frame has the same origin are used (top frame, or same-origin subframe).
//   The check is done in main on event.senderFrame, never trusted from the page.
// - A credential only goes to a frame whose origin is EXACTLY the saved origin. The origin is re-checked right
//   before every send (the frame may have navigated while the menu was open).
// - A generated password only goes to the frame it was offered for, re-checked the same way.
// - Incognito: nothing is offered or saved. Autofill from saved logins is allowed (the logins are not incognito data).
//   Password generation works in incognito too (generating saves nothing by itself).
// - safeStorage unavailable: nothing is saved, offered, filled or imported; pw:list reports 'encryption-unavailable'.
// - "Offer to save passwords" off (savePasswords): nothing is saved, offered, autofilled or imported.
// - Nothing here logs usernames, passwords or page content.
//
// Autofill position: for the top frame the field rect is mapped into window coordinates through the tab view's
// bounds and the page zoom factor. Subframes have no computable offset, so their menu opens at the cursor
// (screen.getCursorScreenPoint, relative to the window).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage, Menu, BrowserWindow, screen, webContents } = require('electron');
const { log } = require('./logger');
const { isChromeSender, parseUrl } = require('./security');
const storage = require('./storage');
const tabs = require('./tabs');
const windows = require('./windows');

const STORE_FILE = 'logins.json';
const DEBOUNCE_MS = 1500;
const OFFER_TTL_MS = 2 * 60 * 1000;
const GENERATED_TTL_MS = 10 * 60 * 1000;
const MAX_LOGINS = 2000;
const MAX_NEVER = 1000;
const MAX_OFFERS = 20;
const MAX_GENERATED = 50;
const MAX_IMPORT_ROWS = 20000;
const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;
const MAX_ORIGIN = 300;
const MAX_IMPORT_URL = 2048;
const MAX_ENC = 8192;
const GEN_LENGTH = 20;
const PRELOAD_FILE = path.join(__dirname, '..', 'preload', 'page-passwords.js');
const SETTINGS_URL = /^pure:\/\/settings(?:[/?#]|$)/;

// ── State ─────────────────────────────────────────────────────────────────────
let logins = [];        // { id, origin, username, passwordEnc (base64), createdAt, updatedAt }
let never = [];         // origins the user chose "Never" for
let storeReady = false; // logins/never hold the file's contents (or there is no file yet)
let loaded = null;      // promise of the async first load, created on first use
let blocked = false;    // logins.json could not be read: never overwrite it
let dirty = false;
let writeTimer = null;
let writeQueue = Promise.resolve();
const offers = new Map(); // offerId -> { win, origin, username, update, loginId, passwordEnc, expires }
const generated = new Map(); // tab webContents id -> { origin, passwordEnc, expires } (last generated, per tab)
const attached = new WeakSet();
const incognitoSessions = new WeakSet();

// ── Helpers ───────────────────────────────────────────────────────────────────
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function storeFile() {
  return path.join(app.getPath('userData'), 'profile', STORE_FILE);
}

// Canonical http(s) origin ("https://host[:port]") or null.
function httpOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_ORIGIN) return null;
  const u = parseUrl(raw);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  return u.origin === raw ? raw : null;
}

// Text from a renderer/page. Usernames may be empty; passwords may not.
function validText(v, max, allowEmpty) {
  if (typeof v !== 'string' || v.length > max) return null;
  if (!allowEmpty && v.length === 0) return null;
  return v;
}

function validRect(r) {
  if (!isPlainObject(r)) return false;
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6;
  return ok(r.x) && ok(r.y) && ok(r.width) && ok(r.height);
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function passwordsEnabled() {
  return storage.settings.get().savePasswords !== false;
}

function encrypt(plain) {
  return safeStorage.encryptString(plain).toString('base64');
}

// -> plaintext, or null when the ciphertext cannot be decrypted (for example after a profile move).
function safeDecrypt(b64) {
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

// Origin of a frame that may receive or send credentials, or null. Top frame, or a subframe whose top frame
// has exactly the same origin (cross-origin frames never qualify).
function frameOrigin(frame) {
  try {
    if (!frame || frame.isDestroyed()) return null;
    const origin = httpOrigin(frame.origin);
    if (!origin) return null;
    const top = frame.top;
    if (!top || top.isDestroyed() || top.origin !== origin) return null;
    return origin;
  } catch {
    return null;
  }
}

// The tab (and its window) that owns this sender, or null. The browser UI and internal pages are not tabs
// with a web frame, so this also rejects them when a page-side channel is used.
function tabFor(event) {
  try {
    return tabs.findTabByWebContentsId(event.sender.id);
  } catch {
    return null;
  }
}

function isIncognitoSender(event) {
  try {
    return incognitoSessions.has(event.sender.session);
  } catch {
    return true; // when in doubt, treat as incognito: nothing is saved
  }
}

// Only the settings page (top frame) may read or change saved logins.
function isSettingsSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    return SETTINGS_URL.test(frame.url || '');
  } catch {
    return false;
  }
}

function sendToSettings(channel) {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed() || !SETTINGS_URL.test(wc.getURL())) continue;
      wc.send(channel);
    } catch {
      // destroyed between the check and the send
    }
  }
}

function view(login) {
  return { id: login.id, origin: login.origin, username: login.username, updatedAt: login.updatedAt };
}

const byOriginUser = (a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username);

// ── Storage (debounced, atomic, serialized) ───────────────────────────────────
function sanitizeLogins(list) {
  const out = [];
  const ids = new Set();
  const keys = new Set();
  const now = Date.now();
  for (const item of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_LOGINS) break;
    if (!isPlainObject(item)) continue;
    const origin = httpOrigin(item.origin);
    const username = validText(item.username, MAX_USERNAME, true);
    const passwordEnc = typeof item.passwordEnc === 'string' && item.passwordEnc.length > 0 && item.passwordEnc.length <= MAX_ENC
      ? item.passwordEnc
      : null;
    if (!origin || username === null || !passwordEnc) continue;
    const key = origin + '\n' + username;
    if (keys.has(key)) continue;
    let id = typeof item.id === 'string' && /^[0-9a-f-]{36}$/i.test(item.id) ? item.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    keys.add(key);
    out.push({
      id,
      origin,
      username,
      passwordEnc,
      createdAt: Number.isFinite(item.createdAt) && item.createdAt > 0 ? item.createdAt : now,
      updatedAt: Number.isFinite(item.updatedAt) && item.updatedAt > 0 ? item.updatedAt : now,
    });
  }
  return out;
}

function sanitizeNever(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_NEVER) break;
    const origin = httpOrigin(raw);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

// Parses logins.json text into memory. False when the text is not valid JSON (the caller moves the file aside).
function applyStore(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  const obj = isPlainObject(raw) ? raw : {};
  logins = sanitizeLogins(obj.logins);
  never = sanitizeNever(obj.never);
  return true;
}

async function readStore() {
  const file = storeFile();
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (storeReady) return;
    if (err.code === 'ENOENT') {
      storeReady = true;
      return;
    }
    blocked = true; // unreadable (not missing): keep the file as it is
    throw new Error(`cannot read ${STORE_FILE}: ${err.code || err.message}`);
  }
  if (storeReady) return; // importLogins loaded the file while this read was pending
  if (!applyStore(text)) {
    log(`[passwords] ${STORE_FILE} is corrupt; moved to .bak`);
    await fs.promises.rename(file, `${file}.bak`).catch(() => {});
  }
  storeReady = true;
}

// Synchronous first load, used only by importLogins (a user action, file ≤ 2 000 logins). False when unreadable.
function loadStoreSync() {
  if (storeReady) return true;
  if (blocked) return false;
  const file = storeFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      storeReady = true;
      return true;
    }
    blocked = true;
    log(`[passwords] cannot read ${STORE_FILE}:`, err.code || err.message);
    return false;
  }
  if (!applyStore(text)) {
    log(`[passwords] ${STORE_FILE} is corrupt; moved to .bak`);
    try {
      fs.renameSync(file, `${file}.bak`);
    } catch {
      // nothing to move
    }
  }
  storeReady = true;
  return true;
}

// Loads once, on first use. Never rejects.
function ensureLoaded() {
  if (storeReady) return Promise.resolve();
  if (!loaded) {
    loaded = readStore().catch((err) => {
      log('[passwords] load failed:', err.message);
    });
  }
  return loaded;
}

function markDirty() {
  dirty = true;
  if (!writeTimer) {
    writeTimer = setTimeout(() => {
      writeTimer = null;
      save();
    }, DEBOUNCE_MS);
  }
}

function save() {
  writeQueue = writeQueue.then(writeNow);
  return writeQueue;
}

async function writeNow() {
  // Never write before the file was read: that would replace it with an empty store.
  if (!dirty || blocked || !storeReady) return;
  dirty = false;
  const text = JSON.stringify({ version: 1, logins, never });
  const file = storeFile();
  const tmp = `${file}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (err) {
    dirty = true; // the next change schedules another attempt
    log('[passwords] cannot write logins.json:', err.code || err.message);
  }
}

function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  return save().then(() => undefined);
}

// ── Strong password generator ─────────────────────────────────────────────────
// 20 characters, from upper, lower, digits and symbols, with at least one of each class. Ambiguous characters
// (0 O 1 l I) are left out. Every choice comes from crypto.randomInt.
const GEN_LOWER = 'abcdefghijkmnopqrstuvwxyz';
const GEN_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const GEN_DIGIT = '23456789';
const GEN_SYMBOL = '-_.!@#$%*';
const GEN_ALL = GEN_LOWER + GEN_UPPER + GEN_DIGIT + GEN_SYMBOL;

function pickChar(set) {
  return set[crypto.randomInt(set.length)];
}

function generatePassword(length = GEN_LENGTH) {
  const chars = [pickChar(GEN_LOWER), pickChar(GEN_UPPER), pickChar(GEN_DIGIT), pickChar(GEN_SYMBOL)];
  while (chars.length < length) chars.push(pickChar(GEN_ALL));
  // Fisher–Yates shuffle, so the guaranteed classes are not always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = chars[i];
    chars[i] = chars[j];
    chars[j] = t;
  }
  return chars.join('');
}

// ── Offers ────────────────────────────────────────────────────────────────────
function pruneOffers() {
  const now = Date.now();
  for (const [id, offer] of offers) {
    if (offer.expires <= now || offer.win.isDestroyed()) offers.delete(id);
  }
}

// Returns the offer when the sender is the window that owns it; consumes it either way it is found.
function takeOffer(event, offerId) {
  if (!isChromeSender(event) || typeof offerId !== 'string') return null;
  const offer = offers.get(offerId);
  if (!offer) return null;
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin || senderWin !== offer.win) return null;
  offers.delete(offerId);
  if (offer.expires <= Date.now() || offer.win.isDestroyed()) return null;
  return offer;
}

// Remember the password generated for a tab, so the save offer after submit is marked as generated.
function rememberGenerated(wcId, origin, password) {
  const now = Date.now();
  for (const [id, g] of generated) {
    if (g.expires <= now) generated.delete(id);
  }
  while (generated.size >= MAX_GENERATED) generated.delete(generated.keys().next().value);
  generated.set(wcId, { origin, passwordEnc: encrypt(password), expires: now + GENERATED_TTL_MS });
}

// True (and forgets it) when this submitted password is the one generated for this tab and origin.
function takeGenerated(wcId, origin, password) {
  const g = generated.get(wcId);
  if (!g || g.origin !== origin || g.expires <= Date.now()) return false;
  if (safeDecrypt(g.passwordEnc) !== password) return false;
  generated.delete(wcId);
  return true;
}

async function onSubmitted(event, payload) {
  const hit = tabFor(event);
  if (!hit || isIncognitoSender(event) || !passwordsEnabled() || !canEncrypt()) return;
  const origin = frameOrigin(event.senderFrame);
  if (!origin || !isPlainObject(payload)) return;
  const username = validText(payload.username, MAX_USERNAME, true);
  const password = validText(payload.password, MAX_PASSWORD, false);
  if (username === null || password === null) return;

  await ensureLoaded();
  if (never.includes(origin)) return;
  const existing = logins.find((l) => l.origin === origin && l.username === username) || null;
  if (existing && safeDecrypt(existing.passwordEnc) === password) return; // nothing new to save

  const win = hit.manager.win;
  if (!win || win.isDestroyed()) return;
  const isGenerated = takeGenerated(event.sender.id, origin, password);
  pruneOffers();
  while (offers.size >= MAX_OFFERS) offers.delete(offers.keys().next().value);
  const offerId = crypto.randomUUID();
  offers.set(offerId, {
    win,
    origin,
    username,
    update: !!existing,
    loginId: existing ? existing.id : null,
    passwordEnc: encrypt(password),
    expires: Date.now() + OFFER_TTL_MS,
  });
  win.webContents.send('pw:offer', { offerId, origin, username, update: !!existing, generated: isGenerated });
}

// ── Autofill and generation menus ─────────────────────────────────────────────
function menuLabel(username) {
  const text = username ? username.slice(0, 120) : '(no username)';
  return text.replace(/&/g, '&&'); // '&' is a mnemonic marker in native menus
}

function clampToWindow(win, x, y) {
  const cb = win.getContentBounds();
  return {
    x: Math.round(Math.min(Math.max(x, 0), cb.width)),
    y: Math.round(Math.min(Math.max(y, 0), cb.height)),
  };
}

function anchorFor(win, hit, frame, rect) {
  if (frame.parent === null && hit.tab.view) {
    // Top frame: CSS px of the page -> DIP in the window (tab view offset, scaled by page zoom).
    try {
      const vb = hit.tab.view.getBounds();
      const zoom = hit.tab.view.webContents.getZoomFactor() || 1;
      return clampToWindow(win, vb.x + rect.x * zoom, vb.y + (rect.y + rect.height) * zoom);
    } catch {
      // fall through to the cursor
    }
  }
  const cb = win.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  return clampToWindow(win, cursor.x - cb.x, cursor.y - cb.y);
}

// Sends the credential to exactly this frame, and only if the frame still has the saved origin.
function fillFrame(frame, loginId) {
  try {
    if (!passwordsEnabled()) return;
    const login = logins.find((l) => l.id === loginId);
    if (!login || !frame || frame.isDestroyed()) return;
    const origin = frameOrigin(frame);
    if (!origin || origin !== login.origin) return;
    const password = safeDecrypt(login.passwordEnc);
    if (password === null) return;
    frame.send('pw:page-fill', { username: login.username, password });
  } catch (err) {
    log('[passwords] fill failed:', err && err.message);
  }
}

// Sends a generated password to exactly the frame it was offered for, and only while that frame still has the
// same origin. wcId (tab webContents id) is given for normal windows only; it marks the next save offer.
function fillGenerated(frame, origin, password, wcId) {
  try {
    if (!frame || frame.isDestroyed() || frameOrigin(frame) !== origin) return;
    if (wcId !== null && canEncrypt()) rememberGenerated(wcId, origin, password);
    frame.send('pw:page-generated', { password });
  } catch (err) {
    log('[passwords] generated fill failed:', err && err.message);
  }
}

async function onFieldFocus(event, payload) {
  const hit = tabFor(event);
  const frame = event.senderFrame;
  if (!hit || !isPlainObject(payload) || !validRect(payload.rect)) return;
  const kind = payload.kind;
  if (kind !== 'username' && kind !== 'password' && kind !== 'new-password') return;
  const origin = frameOrigin(frame);
  if (!origin) return;
  const generate = kind === 'new-password';
  // Autofill keeps the existing rule (saving switched on and encryption available). Generation needs neither.
  const autofill = passwordsEnabled() && canEncrypt();
  if (autofill) await ensureLoaded();
  const matches = autofill ? logins.filter((l) => l.origin === origin) : [];
  if (!generate && !matches.length) return;
  // The await above may have let the frame navigate or the window close.
  const win = hit.manager.win;
  if (!win || win.isDestroyed() || frameOrigin(frame) !== origin) return;

  const items = [];
  if (generate) {
    const password = generatePassword();
    const wcId = isIncognitoSender(event) ? null : event.sender.id;
    // Only the first 3 characters are shown. The whole password never reaches the menu.
    items.push({
      label: `Use a strong password (${password.slice(0, 3)}…)`,
      click: () => fillGenerated(frame, origin, password, wcId),
    });
  }
  if (matches.length) {
    if (items.length) items.push({ type: 'separator' });
    for (const l of matches) items.push({ label: menuLabel(l.username), click: () => fillFrame(frame, l.id) });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Manage passwords…', click: () => windows.openSettings(win, 'passwords') });
  const at = anchorFor(win, hit, frame, payload.rect);
  Menu.buildFromTemplate(items).popup({ window: win, x: at.x, y: at.y });
}

// ── Bulk import (F1's importers call this; not an IPC channel) ────────────────
// Origin of an imported row: its `origin` or `url`, when it is an http(s) URL. Normalised to scheme://host[:port].
function importOrigin(row) {
  const raw = typeof row.origin === 'string' && row.origin ? row.origin : row.url;
  if (typeof raw !== 'string' || raw.length > MAX_IMPORT_URL) return null;
  const u = parseUrl(raw);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  return httpOrigin(u.origin);
}

// One row -> 'added' | 'updated' | 'skipped'. `index` maps origin+'\n'+username to the stored login.
function importOne(row, index, now) {
  if (!isPlainObject(row)) return 'skipped';
  const origin = importOrigin(row);
  const rawUser = typeof row.username === 'string' ? row.username.trim() : '';
  const username = validText(rawUser, MAX_USERNAME, true);
  const password = validText(row.password, MAX_PASSWORD, false);
  if (!origin || username === null || password === null) return 'skipped';
  if (never.includes(origin)) return 'skipped';
  const key = origin + '\n' + username;
  const existing = index.get(key);
  if (existing) {
    if (safeDecrypt(existing.passwordEnc) === password) return 'skipped';
    existing.passwordEnc = encrypt(password);
    existing.updatedAt = now;
    return 'updated';
  }
  if (logins.length >= MAX_LOGINS) return 'skipped';
  const login = {
    id: crypto.randomUUID(),
    origin,
    username,
    passwordEnc: encrypt(password),
    createdAt: now,
    updatedAt: now,
  };
  logins.push(login);
  index.set(key, login);
  return 'added';
}

// rows: [{origin|url, username, password}] -> { added, updated, skipped, error? }. Synchronous; one debounced save.
// Same rules as saving: refused (with `error`) when encryption is unavailable, when "Offer to save passwords" is
// off, or when logins.json cannot be read. Rows with a bad origin/username/password and origins the user chose
// "Never" for are skipped. An existing login (same origin and username) is updated only when its password differs.
// Clears the password property of every row object (also on refusal and for rows past the cap).
function clearPasswords(rows) {
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    try {
      row.password = '';
    } catch {
      // read-only row: nothing to clear
    }
  }
}

// The password property of every row is cleared before this returns, so the caller keeps no copy.
function importLogins(rows, { source = 'import' } = {}) {
  if (!Array.isArray(rows)) return { added: 0, updated: 0, skipped: 0 };
  try {
    return importRows(rows, source);
  } finally {
    clearPasswords(rows);
  }
}

function importRows(rows, source) {
  const result = { added: 0, updated: 0, skipped: 0 };
  const total = rows.length;
  const refuse = (error) => ({ added: 0, updated: 0, skipped: total, error });
  if (!canEncrypt()) return refuse('encryption-unavailable');
  if (!passwordsEnabled()) return refuse('passwords-disabled');
  if (!loadStoreSync()) return refuse('unreadable');

  const now = Date.now();
  const index = new Map(logins.map((l) => [l.origin + '\n' + l.username, l]));
  const work = rows.slice(0, MAX_IMPORT_ROWS);
  result.skipped += total - work.length;
  for (const row of work) {
    try {
      result[importOne(row, index, now)] += 1;
    } catch {
      result.skipped += 1; // encryption failed for this row: nothing stored for it
    }
  }
  if (result.added || result.updated) {
    markDirty();
    sendToSettings('pw:changed');
  }
  const tag = typeof source === 'string' && /^[a-z0-9-]{1,32}$/.test(source) ? source : 'import';
  log(`[passwords] ${tag} import: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`);
  return result;
}

// ── Frame preload registration ────────────────────────────────────────────────
function attach(ses, { incognito = false } = {}) {
  if (incognito) incognitoSessions.add(ses);
  if (attached.has(ses)) return;
  attached.add(ses);
  try {
    ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD_FILE });
  } catch (err) {
    log('[passwords] registerPreloadScript failed:', err && err.message);
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function forbidden() {
  throw new Error('forbidden sender');
}

function requireSettings(event) {
  if (!isSettingsSender(event)) forbidden();
}

function requireEncryption() {
  if (!canEncrypt()) throw new Error('encryption-unavailable');
}

function registerIpc(ipc) {
  // ── From page frames (frame preload) ──
  ipc.on('pw:page-submitted', (event, payload) => {
    onSubmitted(event, payload).catch((err) => log('[passwords] submit failed:', err && err.message));
  });
  ipc.on('pw:page-field-focus', (event, payload) => {
    onFieldFocus(event, payload).catch((err) => log('[passwords] autofill failed:', err && err.message));
  });

  // ── From the browser UI (offer bar) ──
  ipc.on('pw:save', (event, offerId) => {
    const offer = takeOffer(event, offerId);
    if (!offer) return;
    ensureLoaded().then(() => {
      if (!passwordsEnabled() || !canEncrypt() || never.includes(offer.origin)) return;
      const now = Date.now();
      const found = (offer.loginId && logins.find((l) => l.id === offer.loginId))
        || logins.find((l) => l.origin === offer.origin && l.username === offer.username)
        || null;
      if (found) {
        found.passwordEnc = offer.passwordEnc;
        found.updatedAt = now;
      } else {
        if (logins.length >= MAX_LOGINS) {
          log('[passwords] login limit reached');
          return;
        }
        logins.push({
          id: crypto.randomUUID(),
          origin: offer.origin,
          username: offer.username,
          passwordEnc: offer.passwordEnc,
          createdAt: now,
          updatedAt: now,
        });
      }
      markDirty();
      sendToSettings('pw:changed');
    }).catch((err) => log('[passwords] save failed:', err && err.message));
  });

  ipc.on('pw:never', (event, offerId) => {
    const offer = takeOffer(event, offerId);
    if (!offer) return;
    ensureLoaded().then(() => {
      if (!never.includes(offer.origin)) {
        if (never.length >= MAX_NEVER) never.shift();
        never.push(offer.origin);
        markDirty();
      }
      sendToSettings('pw:changed');
    }).catch((err) => log('[passwords] never failed:', err && err.message));
  });

  ipc.on('pw:dismiss', (event, offerId) => {
    takeOffer(event, offerId);
  });

  // ── Settings page only ──
  ipc.handle('pw:list', async (event) => {
    requireSettings(event);
    requireEncryption();
    await ensureLoaded();
    return logins.slice().sort(byOriginUser).map(view);
  });

  ipc.handle('pw:reveal', async (event, id) => {
    requireSettings(event);
    requireEncryption();
    await ensureLoaded();
    const login = typeof id === 'string' ? logins.find((l) => l.id === id) : null;
    if (!login) return null;
    const password = safeDecrypt(login.passwordEnc);
    if (password === null) throw new Error('decrypt-failed');
    return password;
  });

  ipc.handle('pw:update', async (event, id, patch) => {
    requireSettings(event);
    requireEncryption();
    await ensureLoaded();
    const login = typeof id === 'string' ? logins.find((l) => l.id === id) : null;
    if (!login || !isPlainObject(patch)) return null;
    const username = patch.username === undefined ? login.username : validText(patch.username, MAX_USERNAME, true);
    const password = patch.password === undefined ? null : validText(patch.password, MAX_PASSWORD, false);
    if (username === null || (patch.password !== undefined && password === null)) return null;
    if (logins.some((l) => l !== login && l.origin === login.origin && l.username === username)) return null;
    login.username = username;
    if (password !== null) login.passwordEnc = encrypt(password);
    login.updatedAt = Date.now();
    markDirty();
    sendToSettings('pw:changed');
    return view(login);
  });

  ipc.handle('pw:remove', async (event, id) => {
    requireSettings(event);
    await ensureLoaded();
    const idx = typeof id === 'string' ? logins.findIndex((l) => l.id === id) : -1;
    if (idx < 0) return false;
    logins.splice(idx, 1);
    markDirty();
    sendToSettings('pw:changed');
    return true;
  });

  ipc.handle('pw:never-list', async (event) => {
    requireSettings(event);
    await ensureLoaded();
    return never.slice();
  });

  ipc.handle('pw:remove-never', async (event, origin) => {
    requireSettings(event);
    await ensureLoaded();
    const o = httpOrigin(origin);
    const idx = o ? never.indexOf(o) : -1;
    if (idx < 0) return false;
    never.splice(idx, 1);
    markDirty();
    sendToSettings('pw:changed');
    return true;
  });
}

module.exports = {
  attach,
  registerIpc,
  flush,
  importLogins,
  generatePassword,
};
