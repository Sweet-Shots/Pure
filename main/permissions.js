// Permission handlers for a session: async request handler (native prompts), synchronous
// check handler, screen-share picker and device-selection denial.
// Normal sessions remember decisions per origin in storage.sitePermissions; incognito
// sessions keep them in memory only (gone when the incognito session is garbage-collected).
'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, webContents } = require('electron');

// Allowed without asking. The page can only request fullscreen while it is user-initiated.
const ALWAYS_ALLOW = new Set(['fullscreen']);
// Allowed while the page is in HTML fullscreen (detected via enter/leave-html-full-screen);
// otherwise the user is prompted.
const FULLSCREEN_ONLY = new Set(['pointerLock', 'keyboardLock', 'clipboard-sanitized-write']);
// Asked every time (unless remembered).
const PROMPT = new Set([
  'media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read',
  'idle-detection', 'storage-access', 'top-level-storage-access', 'speaker-selection', 'openExternal',
]);
// The screen picker (setDisplayMediaRequestHandler) is the real gate for display capture.
const DISPLAY_CAPTURE = 'display-capture';

const VERB = {
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices, including system exclusive messages',
  'clipboard-read': 'read text and images from your clipboard',
  'idle-detection': 'detect when you are idle',
  'storage-access': 'use its cookies while you are on this site',
  'top-level-storage-access': 'use its cookies when you visit it directly',
  'speaker-selection': 'choose audio output devices',
  pointerLock: 'lock your mouse pointer',
  keyboardLock: 'lock the keyboard',
  'clipboard-sanitized-write': 'write to your clipboard',
};

function log(...args) {
  try { require('./logger').log(...args); } catch { /* logging must never break a prompt */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function alive(wc) {
  return !!wc && !wc.isDestroyed();
}

// The BrowserWindow that hosts a webContents. Tab pages live in WebContentsViews, which
// BrowserWindow.fromWebContents() does not see, so search the window's child views too.
function ownerWindow(wc) {
  if (!alive(wc)) return null;
  try {
    const direct = BrowserWindow.fromWebContents(wc);
    if (direct) return direct;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.contentView.children.some((v) => v.webContents === wc)) return win;
    }
  } catch { /* fall through */ }
  return null;
}

function lastFocusedWindow() {
  try {
    return require('./windows').getLastFocusedBrowserWindow() || BrowserWindow.getFocusedWindow() || null;
  } catch {
    return null;
  }
}

// 'https://example.com/x' -> 'https://example.com'; 'pure://home/' -> 'pure://home'.
function originOf(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'pure:') return 'pure://' + u.host;
    if (u.origin && u.origin !== 'null') return u.origin;
    return u.protocol;
  } catch {
    return '';
  }
}

function requestOrigin(raw, wc) {
  let source = raw;
  if (!source && alive(wc)) {
    try { source = wc.getURL(); } catch { source = ''; }
  }
  return originOf(source || '');
}

function hostOf(origin) {
  try {
    const u = new URL(origin);
    return u.host || 'This page';
  } catch {
    return 'This page';
  }
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function mediaVerb(types) {
  const video = types.includes('video');
  const audio = types.includes('audio');
  if (video && !audio) return 'use your camera';
  if (audio && !video) return 'use your microphone';
  return 'use your camera and microphone';
}

// ── Stored decisions ──────────────────────────────────────────────────────────

function getDecision(ctx, origin, permission) {
  if (ctx.incognito) return ctx.memory.get(origin + '|' + permission);
  try {
    return require('./storage').sitePermissions.get(origin, permission) || undefined;
  } catch (err) {
    log('permissions: read failed', err && err.message);
    return undefined;
  }
}

function setDecision(ctx, origin, permission, decision) {
  if (ctx.incognito) {
    ctx.memory.set(origin + '|' + permission, decision);
    return;
  }
  try {
    require('./storage').sitePermissions.set(origin, permission, decision);
  } catch (err) {
    log('permissions: write failed', err && err.message);
  }
}

// ── Fullscreen tracking (for FULLSCREEN_ONLY permissions) ─────────────────────

const htmlFullscreen = new WeakSet();
const tracked = new WeakSet();
let appHooked = false;

function trackFullscreen(wc) {
  if (!alive(wc) || tracked.has(wc)) return;
  tracked.add(wc);
  wc.on('enter-html-full-screen', () => htmlFullscreen.add(wc));
  wc.on('leave-html-full-screen', () => htmlFullscreen.delete(wc));
}

function hookWebContents() {
  if (appHooked) return;
  appHooked = true;
  app.on('web-contents-created', (_event, wc) => trackFullscreen(wc));
  try {
    webContents.getAllWebContents().forEach(trackFullscreen);
  } catch { /* ignore */ }
}

function isPageFullscreen(wc) {
  if (!alive(wc)) return false;
  trackFullscreen(wc);
  return htmlFullscreen.has(wc);
}

// ── Prompt queue (one native dialog at a time, identical requests share a dialog) ─

const queue = [];
const pending = new Map(); // key -> job, while queued or being shown
let busy = false;
let ctxSeq = 0;

function describe(job) {
  const host = hostOf(job.origin);
  if (job.permission === 'openExternal') {
    return {
      message: `${host} wants to open an app outside Pure.`,
      detail: clip(job.externalURL, 300) || undefined,
    };
  }
  const verb = job.permission === 'media' ? mediaVerb(job.types) : (VERB[job.permission] || 'use this feature');
  return { message: `${host} wants to ${verb}.` };
}

async function askUser(job, parent) {
  const { message, detail } = describe(job);
  const opts = {
    type: 'question',
    title: 'Pure',
    message,
    detail,
    buttons: ['Allow', 'Block'],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: job.ctx.incognito ? 'Remember my decision for this session' : 'Remember my decision for this site',
    checkboxChecked: true,
  };
  const res = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  return { allow: res.response === 0, remember: !!res.checkboxChecked };
}

function settle(job, allow) {
  for (const entry of job.entries) {
    try { entry.callback(alive(entry.wc) ? allow : false); } catch { /* callback may be gone */ }
  }
}

async function runJob(job) {
  const live = job.entries.filter((e) => alive(e.wc));
  if (!live.length) {
    settle(job, false);
    return;
  }
  const parent = ownerWindow(live[0].wc) || lastFocusedWindow();
  const { allow, remember } = await askUser(job, parent);
  if (remember) setDecision(job.ctx, job.origin, job.permission, allow ? 'allow' : 'deny');
  settle(job, allow);
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await runJob(job);
      } catch (err) {
        log('permissions: prompt failed', err && err.message);
        settle(job, false);
      } finally {
        pending.delete(job.key);
      }
    }
  } finally {
    busy = false;
  }
}

function enqueue(ctx, wc, origin, permission, details, callback) {
  const types = Array.isArray(details && details.mediaTypes) ? details.mediaTypes : [];
  const externalURL = (details && details.externalURL) || '';
  const key = [ctx.id, origin, permission, types.join(','), externalURL].join('|');
  const entry = { wc, callback };
  const existing = pending.get(key);
  if (existing) {
    existing.entries.push(entry);
    return;
  }
  const job = { key, ctx, origin, permission, types, externalURL, entries: [entry] };
  pending.set(key, job);
  queue.push(job);
  pump();
}

// Returns true/false when decided now, or undefined when the callback will be called later.
function requestNow(ctx, wc, permission, details, callback) {
  if (ALWAYS_ALLOW.has(permission)) return true;
  const origin = requestOrigin(details && (details.requestingUrl || details.securityOrigin), wc);
  if (!origin || origin.startsWith('pure:')) return false; // internal pages: nothing but fullscreen
  if (permission === DISPLAY_CAPTURE) return true;
  const fullscreenOnly = FULLSCREEN_ONLY.has(permission);
  if (!fullscreenOnly && !PROMPT.has(permission)) return false; // deny everything else
  if (fullscreenOnly && isPageFullscreen(wc)) return true;
  const stored = getDecision(ctx, origin, permission);
  if (stored === 'allow') return true;
  if (stored === 'deny') return false;
  enqueue(ctx, wc, origin, permission, details, callback);
  return undefined;
}

// Synchronous check; must not prompt. Stored decisions only.
function checkNow(ctx, wc, permission, requestingOrigin, details) {
  if (ALWAYS_ALLOW.has(permission)) return true;
  const origin = requestOrigin(requestingOrigin || (details && details.requestingUrl) || '', wc);
  if (!origin || origin.startsWith('pure:')) return false;
  if (permission === DISPLAY_CAPTURE) return true;
  if (FULLSCREEN_ONLY.has(permission)) return isPageFullscreen(wc) || getDecision(ctx, origin, permission) === 'allow';
  if (PROMPT.has(permission)) return getDecision(ctx, origin, permission) === 'allow';
  return false;
}

// ── Screen sharing ────────────────────────────────────────────────────────────

let screenChain = Promise.resolve();

async function pickScreen(request) {
  const origin = originOf(request && request.securityOrigin);
  if (!request || !request.videoRequested || !origin || origin.startsWith('pure:')) return {};
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const windowsList = sources.filter((s) => !s.id.startsWith('screen:'));
  const list = [...screens, ...windowsList].slice(0, 9);
  if (!list.length) return {};

  const opts = {
    type: 'question',
    title: 'Share your screen',
    message: `${hostOf(origin)} wants to share your screen.`,
    detail: 'Choose a screen or window to share.',
    buttons: [...list.map((s) => clip(s.name || 'Untitled', 60)), 'Cancel'],
    defaultId: list.length,
    cancelId: list.length,
  };
  const parent = lastFocusedWindow();
  const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  const picked = list[res.response];
  return picked ? { video: { id: picked.id, name: picked.name } } : {};
}

// ── Attach ────────────────────────────────────────────────────────────────────

function attach(session, { incognito = false } = {}) {
  hookWebContents();
  const ctx = { id: ++ctxSeq, incognito: !!incognito, memory: new Map() };

  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    let answer;
    try {
      answer = requestNow(ctx, wc, permission, details, callback);
    } catch (err) {
      log('permissions: request failed', permission, err && err.message);
      answer = false;
    }
    if (answer !== undefined) callback(answer);
  });

  session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    try {
      return checkNow(ctx, wc, permission, requestingOrigin, details);
    } catch {
      return false;
    }
  });

  session.setDisplayMediaRequestHandler((request, callback) => {
    screenChain = screenChain
      .then(() => pickScreen(request))
      .then((streams) => callback(streams), (err) => {
        log('permissions: screen picker failed', err && err.message);
        callback({});
      });
  }, { useSystemPicker: false });

  // Device pickers are never offered: cancel the request.
  session.on('select-hid-device', (_event, _details, callback) => callback());
  session.on('select-serial-port', (_event, _portList, _wc, callback) => callback(''));
  session.on('select-usb-device', (_event, _details, callback) => callback());
}

module.exports = { attach, ownerWindow };
