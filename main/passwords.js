'use strict';
// main/passwords.js — saved logins, save offers and autofill (C1, Pure 2.2).
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
// - Incognito: nothing is offered or saved. Autofill from saved logins is allowed (the logins are not incognito data).
// - safeStorage unavailable: nothing is saved, offered or filled; pw:list reports 'encryption-unavailable'.
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
const MAX_LOGINS = 2000;
const MAX_NEVER = 1000;
const MAX_OFFERS = 20;
const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;
const MAX_ORIGIN = 300;
const MAX_ENC = 8192;
const PRELOAD_FILE = path.join(__dirname, '..', 'preload', 'page-passwords.js');
const SETTINGS_URL = /^pure:\/\/settings(?:[/?#]|$)/;

// ── State ─────────────────────────────────────────────────────────────────────
let logins = [];        // { id, origin, username, passwordEnc (base64), createdAt, updatedAt }
let never = [];         // origins the user chose "Never" for
let loaded = null;      // promise, created on first use
let blocked = false;    // logins.json could not be read: never overwrite it
let dirty = false;
let writeTimer = null;
let writeQueue = Promise.resolve();
const offers = new Map(); // offerId -> { win, origin, username, update, loginId, passwordEnc, expires }
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

async function readStore() {
  const file = storeFile();
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    blocked = true; // unreadable (not missing): keep the file as it is
    throw new Error(`cannot read ${STORE_FILE}: ${err.code || err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    log(`[passwords] ${STORE_FILE} is corrupt; moved to .bak`);
    await fs.promises.rename(file, `${file}.bak`).catch(() => {});
    return;
  }
  const obj = isPlainObject(raw) ? raw : {};
  logins = sanitizeLogins(obj.logins);
  never = sanitizeNever(obj.never);
}

// Loads once, on first use. Never rejects.
function ensureLoaded() {
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
  if (!dirty || blocked) return;
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
  win.webContents.send('pw:offer', { offerId, origin, username, update: !!existing });
}

// ── Autofill ──────────────────────────────────────────────────────────────────
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

async function onFieldFocus(event, payload) {
  const hit = tabFor(event);
  const frame = event.senderFrame;
  if (!hit || !isPlainObject(payload) || !validRect(payload.rect)) return;
  if (!frameOrigin(frame) || !passwordsEnabled() || !canEncrypt()) return;
  if (payload.kind !== 'username' && payload.kind !== 'password') return;
  const origin = frameOrigin(frame);
  await ensureLoaded();
  const matches = logins.filter((l) => l.origin === origin);
  if (!matches.length) return;
  const win = hit.manager.win;
  if (!win || win.isDestroyed()) return;

  const template = matches.map((l) => ({ label: menuLabel(l.username), click: () => fillFrame(frame, l.id) }));
  template.push({ type: 'separator' });
  template.push({ label: 'Manage passwords…', click: () => windows.openSettings(win, 'passwords') });
  const at = anchorFor(win, hit, frame, payload.rect);
  Menu.buildFromTemplate(template).popup({ window: win, x: at.x, y: at.y });
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
};
