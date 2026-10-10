'use strict';
// Tools (2.4, E5): screenshots (visible area / full page) and copy clean link.
//
// Screenshots are saved to Pictures\Pure Screenshots, copied to the clipboard and announced with a toast.
// Full-page capture runs CDP (Page.captureScreenshot with captureBeyondViewport) through webContents.debugger.
// The debugger is attached only for that capture and only when nothing else holds it (Lite mode may), and it
// is detached again right after. Buffers are local to the capture: nothing is kept after the save.
//
// Clean link removes tracking parameters (built-in list below) and then whatever Purify's $removeparam rules
// match, when the blocking engine is loaded. Other parameters, the path and the fragment are left as they are.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, ClipboardItem, screen, shell } = require('electron');
const security = require('./security');
const logger = require('./logger');
const toast = require('./toast');

const FOLDER = 'Pure Screenshots';
const CDP_VERSION = '1.3';
const MAX_HEIGHT = 16384; // device pixels; a longer page is cut here and the toast says so
const CAPTURE_TIMEOUT_MS = 20000;
const MAX_URL = 8192;
const SHOT_TOAST = 'screenshot';
const LINK_TOAST = 'clean-link';

// Built-in tracking parameters (compared lowercase). Prefixes first, then exact names.
const TRACK_PREFIXES = ['utm_', 'oly_', 'vero_', 'hsa_'];
const TRACK_KEYS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'li_fat_id',
  'mc_cid', 'mc_eid', 'igshid', 'igsh', 'mibextid', 'ref_src', 'ref_url', '_hsenc', '_hsmi', 's_cid', 'spm',
  'share_id', '_ga', '_gl',
]);
// `si` is a share-tracking id on these services only (elsewhere it can be a real parameter).
const SI_DOMAINS = ['youtube.com', 'youtu.be', 'spotify.com'];

const busy = new Set(); // webContents ids with a capture in progress

function alive(win) {
  return !!win && !win.isDestroyed() && !!win.webContents && !win.webContents.isDestroyed();
}

function parse(raw) {
  try { return new URL(raw); } catch { return null; }
}

function isWeb(raw) {
  const u = parse(raw);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

// Pages that can be captured: web pages, local files and the new-tab page.
function capturable(raw) {
  const u = parse(raw);
  if (!u) return false;
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ||
    (u.protocol === 'pure:' && u.hostname === 'home');
}

function safeUrl(wc) {
  try {
    return wc && !wc.isDestroyed() ? wc.getURL() : '';
  } catch {
    return '';
  }
}

function showToast(win, t, onAction) {
  if (!alive(win)) return;
  try {
    toast.show(win, t, onAction);
  } catch (err) {
    logger.log('[tools] toast failed:', err && err.message);
  }
}

// Only the browser UI of a window may drive these (IPC). Returns the window or null.
function senderWindow(event) {
  if (!security.isChromeSender(event)) return null;
  return BrowserWindow.fromWebContents(event.sender) || null;
}

function tabsOf(win) {
  return require('./windows').getTabManager(win);
}

// ── Screenshots ─────────────────────────────────────────────────────────

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

// Writes the PNG under a new name ("Pure <stamp>.png", " (2)" on a clash). Never overwrites.
async function saveShot(png) {
  const dir = path.join(app.getPath('pictures'), FOLDER);
  await fs.promises.mkdir(dir, { recursive: true });
  const base = `Pure ${stamp()}`;
  for (let n = 0; n < 1000; n++) {
    const file = path.join(dir, n === 0 ? `${base}.png` : `${base} (${n + 1}).png`);
    try {
      await fs.promises.writeFile(file, png, { flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('no free file name');
}

function scaleFor(win) {
  try {
    const f = screen.getDisplayMatching(win.getBounds()).scaleFactor;
    return f > 0 ? Math.min(f, 3) : 1;
  } catch {
    return 1;
  }
}

function timed(promise, ms, what) {
  let timer = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// A tab that has just been created or shown may not have a surface yet: a few short retries cover that.
async function captureVisible(wc) {
  let image = null;
  for (let attempt = 0; ; attempt++) {
    try {
      image = await wc.capturePage();
      break;
    } catch (err) {
      if (attempt >= 7 || !/surface/i.test(String(err && err.message))) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!image || image.isEmpty()) throw new Error('the page is not drawn right now');
  return { png: image.toPNG(), capped: false };
}

// Image to the clipboard as PNG (Electron 44: clipboard.write with a ClipboardItem; writeImage is gone).
async function copyImage(png) {
  if (!ClipboardItem) throw new Error('ClipboardItem is not available');
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

async function captureFull(wc, win) {
  const dbg = wc.debugger;
  const attachedHere = !dbg.isAttached();
  if (attachedHere) dbg.attach(CDP_VERSION); // throws while DevTools holds the page: reported as the failure
  try {
    const metrics = await timed(dbg.sendCommand('Page.getLayoutMetrics'), CAPTURE_TIMEOUT_MS, 'layout');
    const size = metrics.cssContentSize || metrics.contentSize || { width: 1, height: 1 };
    const scale = scaleFor(win);
    const width = Math.max(1, Math.ceil(size.width));
    const fullHeight = Math.max(1, Math.ceil(size.height));
    const maxHeight = Math.max(1, Math.floor(MAX_HEIGHT / scale));
    const height = Math.min(fullHeight, maxHeight);
    const res = await timed(dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    }), CAPTURE_TIMEOUT_MS, 'capture');
    const png = Buffer.from(res.data, 'base64');
    return { png, capped: fullHeight > maxHeight };
  } finally {
    if (attachedHere && dbg.isAttached()) {
      try { dbg.detach(); } catch { /* already gone */ }
    }
  }
}

// A new tab's view has no size until the browser UI lays it out (about a second). A capture before that
// would be empty or narrow, so wait briefly (bounded, rare) and refuse if it still has no size.
async function viewReady(view) {
  for (let i = 0; i < 15; i++) {
    const b = view.getBounds();
    if (b.width > 0 && b.height > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function openShot(file) {
  return (action) => {
    if (action === 'open') {
      shell.openPath(file).then((msg) => { if (msg) logger.log('[tools] open failed:', msg); }, () => {});
    } else if (action === 'show') {
      try { shell.showItemInFolder(file); } catch { /* folder gone */ }
    }
  };
}

function friendly(err) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  return msg.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function screenshotFailed(win, err) {
  const reason = friendly(err);
  logger.log('[tools] screenshot failed:', reason);
  showToast(win, { id: SHOT_TOAST, kind: 'error', text: reason ? `Screenshot failed: ${reason}` : 'Screenshot failed' });
  return { error: reason || 'Screenshot failed' };
}

// mode 'visible' | 'full'. Saves the PNG, copies the image, shows a toast. -> { ok: true, path } | { error }
async function screenshotTab(manager, tab, mode) {
  const win = manager.win;
  if (!alive(win)) return { error: 'No window' };
  const wc = tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed()) {
    showToast(win, { id: SHOT_TOAST, kind: 'error', text: 'Open the tab first, then take the screenshot' });
    return { error: 'The tab is not loaded' };
  }
  if (!capturable(safeUrl(wc) || tab.url)) {
    showToast(win, { id: SHOT_TOAST, kind: 'error', text: 'This page cannot be captured' });
    return { error: 'This page cannot be captured' };
  }
  if (busy.has(wc.id)) return { error: 'A screenshot is already being taken' };
  if (!(await viewReady(tab.view))) {
    showToast(win, { id: SHOT_TOAST, kind: 'error', text: 'The page is still opening. Try again in a moment.' });
    return { error: 'The page is still opening' };
  }

  busy.add(wc.id);
  try {
    const shot = mode === 'full' ? await captureFull(wc, win) : await captureVisible(wc);
    const file = await saveShot(shot.png);
    try {
      await copyImage(shot.png);
    } catch (err) {
      logger.log('[tools] clipboard image failed:', err && err.message);
    }
    const text = mode === 'full'
      ? (shot.capped ? 'Full-page screenshot saved (first 16 384 px)' : 'Full-page screenshot saved')
      : 'Screenshot saved';
    showToast(win, {
      id: SHOT_TOAST,
      kind: 'info',
      text,
      actions: [{ id: 'open', label: 'Open' }, { id: 'show', label: 'Show in folder' }],
      timeoutMs: 8000,
    }, openShot(file));
    return { ok: true, path: file };
  } catch (err) {
    return screenshotFailed(win, err);
  } finally {
    busy.delete(wc.id);
  }
}

// Tab looked up at call time (a menu item or a shortcut may fire after the tab is gone).
function takeScreenshot(manager, tabId, mode) {
  const tab = manager && !manager.destroyed ? manager.get(tabId) : null;
  if (!tab) return Promise.resolve({ error: 'No such tab' });
  return screenshotTab(manager, tab, mode === 'full' ? 'full' : 'visible').catch((err) => screenshotFailed(manager.win, err));
}

// ── Clean links ─────────────────────────────────────────────────────────

function hostOf(u) {
  return u.hostname.toLowerCase();
}

function onDomain(host, domains) {
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

function isTrackingKey(key, host) {
  const k = key.toLowerCase();
  if (TRACK_KEYS.has(k) || TRACK_PREFIXES.some((p) => k.startsWith(p))) return true;
  return k === 'si' && onDomain(host, SI_DOMAINS);
}

// Raw URL parts, so every parameter that is kept stays byte-for-byte as the page wrote it.
function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const body = hashAt < 0 ? url : url.slice(0, hashAt);
  const q = body.indexOf('?');
  if (q < 0) return { head: body, query: null, hash };
  return { head: body.slice(0, q), query: body.slice(q + 1), hash };
}

// Decoded name of one "key=value" piece of a query string.
function keyOf(part) {
  const eq = part.indexOf('=');
  const raw = eq < 0 ? part : part.slice(0, eq);
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

function queryKeys(url) {
  const { query } = splitUrl(url);
  if (!query) return [];
  return query.split('&').filter(Boolean).map(keyOf);
}

// Removes the parameters for which drop(decodedName) is true. -> { url, removed }
function dropParams(url, drop) {
  const { head, query, hash } = splitUrl(url);
  if (query === null) return { url, removed: 0 };
  const kept = [];
  let removed = 0;
  for (const part of query.split('&')) {
    if (!part) continue;
    if (drop(keyOf(part))) removed++;
    else kept.push(part);
  }
  if (!removed) return { url, removed: 0 };
  return { url: head + (kept.length ? '?' + kept.join('&') : '') + hash, removed };
}

function engineOrNull() {
  try {
    return require('./blocking').getEngine() || null;
  } catch {
    return null;
  }
}

// Purify's $removeparam rules for this URL, as a Set of parameter names (null when none apply).
// The engine reports the rewritten URL; the names are those that disappeared from the query.
function engineDrop(url) {
  const eng = engineOrNull();
  if (!eng) return null;
  let rewritten = null;
  try {
    const { Request } = require('@ghostery/adblocker-electron');
    const req = Request.fromRawDetails({ requestId: 'clean-link', url, sourceUrl: url, type: 'mainFrame' });
    const res = eng.match(req);
    rewritten = res && res.rewrite && res.rewrite.url;
  } catch (err) {
    logger.log('[tools] removeparam match failed:', err && err.message);
    return null;
  }
  if (!rewritten || rewritten === url) return null;
  const kept = new Set(queryKeys(rewritten));
  const gone = new Set(queryKeys(url).filter((k) => !kept.has(k)));
  return gone.size ? gone : null;
}

// -> { url, removed } for an http(s) URL, or null. Built-in rules, then $removeparam (a few rounds, since a
// rewrite can expose another rule). A URL that a blocking rule matches gets no $removeparam (engine behaviour).
function cleanLink(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
  const u = parse(raw);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  const host = hostOf(u);
  let url = u.href;
  let removed = 0;
  const first = dropParams(url, (k) => isTrackingKey(k, host));
  url = first.url;
  removed += first.removed;
  for (let round = 0; round < 3; round++) {
    const gone = engineDrop(url);
    if (!gone) break;
    const next = dropParams(url, (k) => gone.has(k));
    if (!next.removed) break;
    url = next.url;
    removed += next.removed;
  }
  return { url, removed };
}

// Copies the clean form of url and toasts it. -> the cleaned URL, or null when url is not http(s).
function copyCleanLinkUrl(win, raw) {
  const c = cleanLink(raw);
  if (!c) {
    showToast(win, { id: LINK_TOAST, kind: 'warn', text: 'Clean links work on web pages only', timeoutMs: 4000 });
    return null;
  }
  try {
    clipboard.writeText(c.url);
  } catch (err) {
    logger.log('[tools] clipboard text failed:', err && err.message);
    return null;
  }
  const text = c.removed
    ? `Clean link copied (${c.removed} tracking ${c.removed === 1 ? 'parameter' : 'parameters'} removed)`
    : 'Clean link copied';
  showToast(win, { id: LINK_TOAST, kind: 'info', text, timeoutMs: 4000 });
  return c.url;
}

// Ctrl+Shift+C: the active tab's current URL.
function copyCleanLinkForTab(manager, tabId) {
  const tab = manager && !manager.destroyed ? manager.get(tabId) : null;
  if (!tab) return null;
  const wc = tab.view && tab.view.webContents;
  return copyCleanLinkUrl(manager.win, safeUrl(wc) || tab.url || '');
}

// ── Page context menu (menus.js hook) ───────────────────────────────────

function tabOf(webContents) {
  try {
    return require('./tabs').findTabByWebContentsId(webContents.id);
  } catch {
    return null;
  }
}

// -> MenuItem templates for the page: "Take screenshot" on capturable tabs, "Copy clean link" on links.
function contextMenuItems(params, webContents) {
  if (!webContents || webContents.isDestroyed()) return [];
  const p = params || {};
  const found = tabOf(webContents);
  const owner = found ? found.manager.win : BrowserWindow.fromWebContents(webContents);
  const out = [];

  if (found && capturable(safeUrl(webContents) || found.tab.url)) {
    const { manager } = found;
    const tabId = found.tab.id;
    out.push({
      label: 'Take screenshot',
      submenu: [
        { label: 'Visible area', click: () => takeScreenshot(manager, tabId, 'visible') },
        { label: 'Full page', click: () => takeScreenshot(manager, tabId, 'full') },
      ],
    });
  }

  const link = typeof p.linkURL === 'string' ? p.linkURL : '';
  if (link && isWeb(link)) {
    out.push({ label: 'Copy clean link', click: () => copyCleanLinkUrl(owner, link) });
  }
  return out;
}

// ── IPC (browser UI only) ───────────────────────────────────────────────

function registerIpc(ipc) {
  ipc.handle('tools:screenshot', async (event, tabId, mode) => {
    const win = senderWindow(event);
    const manager = win ? tabsOf(win) : null;
    if (!manager) return { error: 'Not allowed' };
    if (!Number.isInteger(tabId) || (mode !== 'visible' && mode !== 'full')) return { error: 'Bad request' };
    return takeScreenshot(manager, tabId, mode);
  });

  ipc.handle('tools:copy-clean-link', (event, url) => {
    const win = senderWindow(event);
    if (!win) return null;
    if (typeof url !== 'string' || url.length > MAX_URL) return null;
    return copyCleanLinkUrl(win, url);
  });
}

module.exports = {
  registerIpc,
  contextMenuItems,
  takeScreenshot,
  copyCleanLinkForTab,
  cleanLink,
};
