'use strict';
// Pure Browser main process entry. Startup order follows ARCHITECTURE.md:
// single-instance lock -> switches -> scheme registration -> ready -> storage.init -> IPC -> windows.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Must be set before anything reads userData (logger, storage paths).
const { app, ipcMain } = require('electron');
app.name = 'Pure Browser';
// Dev only: PURE_PROFILE=<dir> runs against a throwaway profile.
if (!app.isPackaged && process.env.PURE_PROFILE) app.setPath('userData', path.resolve(process.env.PURE_PROFILE));

const logger = require('./logger');
const { log } = logger;
const protocol = require('./protocol');
const sessions = require('./sessions');
const storage = require('./storage');
const { parseUrl } = require('./security');

const UI_ORIGIN = 'pure://browser';
const OPENABLE_EXT = new Set(['.htm', '.html', '.pdf', '.svg', '.webp']);
// Schemes a web page's window.open() may create as a popup (OAuth popups are https).
const POPUP_SCHEMES = new Set(['http:', 'https:', 'about:', 'blob:']);

// Lazy module load for modules owned by other agents: a failure is logged and startup continues.
function load(name) {
  try {
    return require(`./${name}`);
  } catch (err) {
    log(`[main] could not load ${name}:`, err);
    return null;
  }
}

function attempt(label, fn) {
  try {
    return fn();
  } catch (err) {
    log(`[main] ${label} failed:`, err);
    return undefined;
  }
}

// http(s) / file URLs and local .html/.pdf (etc.) paths from a command line or second-instance argv.
// Anything else is ignored: pure:, javascript:, flags, and the executable itself.
function argvToUrls(args, cwd = process.cwd()) {
  const out = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) continue;
    if (/^(https?|file):/i.test(arg)) {
      const u = parseUrl(arg);
      if (u && (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:')) out.push(u.href);
      continue;
    }
    const abs = path.resolve(cwd, arg);
    if (OPENABLE_EXT.has(path.extname(abs).toLowerCase()) && fs.existsSync(abs)) {
      out.push(pathToFileURL(abs).href);
    }
  }
  return out;
}

function registerIpc() {
  storage.registerIpc(ipcMain);
  for (const name of ['suggestions', 'windows', 'tabs', 'downloads', 'system', 'blocking', 'performance', 'homepage', 'importer',
    // 2.2
    'passwords', 'extensions', 'updater', 'palette', 'siteinfo', 'reader',
    // 2.3 — blocker
    'filterlists', 'cosmetics', 'picker',
    // 2.4
    'privacy', 'tools', 'toast']) {
    const mod = load(name);
    if (mod && typeof mod.registerIpc === 'function') {
      attempt(`${name}.registerIpc`, () => mod.registerIpc(ipcMain));
    }
  }
}

// The blocking engine loads from its cache. A failure or a slow load is logged and never delays startup
// beyond the timeout; windows can open before the engine is ready.
async function initBlocking() {
  try {
    const blocking = load('blocking');
    if (blocking && typeof blocking.init === 'function') {
      await withTimeout(Promise.resolve().then(() => blocking.init()), 1500);
    }
  } catch (err) {
    log('[main] blocking.init failed:', err);
  }
}

async function boot() {
  await storage.init(app.getPath('userData'));
  await initBlocking();
  registerIpc();
  sessions.getSession({ incognito: false }); // also configures the default session
  // 2.2 modules with startup work (each must be fast and never throw; heavy work goes async).
  for (const name of ['dns', 'extensions', 'updater', 'privacy']) {
    const mod = load(name);
    if (mod && typeof mod.init === 'function') {
      try {
        await withTimeout(Promise.resolve().then(() => mod.init()), 1500);
      } catch (err) {
        log(`[main] ${name}.init failed:`, err);
      }
    }
  }

  const windows = load('windows');
  if (!windows) throw new Error('windows module failed to load');

  await windows.restoreOrCreate(argvToUrls(process.argv));
}

async function onSecondInstance(argv, cwd) {
  const windows = load('windows');
  if (!windows) return;
  const urls = argvToUrls(argv, cwd);
  if (!windows.getBrowserWindows().length) {
    windows.createWindow({ urls });
    return;
  }
  for (const url of urls) windows.openUrl(url);
  const win = windows.getLastFocusedBrowserWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

// Web contents hardening, applied to every WebContents at creation.
// Tab contents get their own window-open handler from tabs.js right after creation, which replaces the
// default set here. Anything else (the browser UI, popup windows) uses this default.
function guardWebContents(contents) {
  // Webview tags are never used (WebContentsView only), so refuse any attempt to attach one.
  contents.on('will-attach-webview', (event) => event.preventDefault());

  contents.setWindowOpenHandler((details) => {
    const from = attempt('getURL', () => contents.getURL()) || '';
    // The browser UI never opens windows.
    if (from.startsWith(UI_ORIGIN)) return { action: 'deny' };
    const target = details.url || '';
    // Web content can never open pure:// pages (only the user, through the UI, can).
    if (/^pure:/i.test(target) && !/^pure:/i.test(from)) return { action: 'deny' };
    // about:blank is what window.open() without a URL produces, and OAuth flows need it.
    if (target && target !== 'about:blank') {
      const u = parseUrl(target);
      if (!u || !POPUP_SCHEMES.has(u.protocol)) return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

let quitting = false;
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Reads one setting synchronously before app ready (storage.init is async and runs after ready).
function readStartupSetting(key) {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'profile', 'settings.json'), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj[key] : undefined;
  } catch {
    return undefined;
  }
}

function start() {
  app.setAppUserModelId('com.pure-browser.app'); // groups all processes under one name in the Windows taskbar
  app.userAgentFallback = sessions.USER_AGENT;   // global fallback, used until a session sets its own
  app.enableSandbox();                           // every renderer sandboxed, whatever webPreferences say
  protocol.registerSchemes();                    // must run before ready

  // No resource-tuning switches: GPU acceleration stays on and Chromium defaults are kept, because any
  // switch that lowers resource use would have to be justified against site compatibility.
  // The one user-chosen switch: "Dark mode for websites" (Chromium's auto dark mode). It can only be set
  // before ready, so read it straight from settings.json; changing it needs a restart.
  if (readStartupSetting('forceDarkWeb') === true) app.commandLine.appendSwitch('enable-features', 'WebContentsForceDark');

  process.on('uncaughtException', (err) => log('[main] uncaughtException:', err));
  process.on('unhandledRejection', (reason) => log('[main] unhandledRejection:', reason));

  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));

  app.on('render-process-gone', (_event, webContents, details) => {
    const url = attempt('getURL', () => webContents.getURL()) || '';
    log('[main] render-process-gone:', details.reason, 'exit', details.exitCode, url);
  });

  app.on('child-process-gone', (_event, details) => {
    log('[main] child-process-gone:', details.type, details.reason, 'exit', details.exitCode);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    const work = (async () => {
      try {
        await load('windows')?.saveSession?.();
      } catch (err) {
        log('[main] saveSession failed:', err);
      }
      try {
        await load('downloads')?.flush?.();
      } catch (err) {
        log('[main] downloads flush failed:', err);
      }
      // privacy last: clear-on-exit runs after everything else has written its data.
      for (const name of ['blocking', 'homepage', 'passwords', 'extensions', 'filterlists', 'picker', 'privacy']) {
        try {
          await load(name)?.flush?.();
        } catch (err) {
          log(`[main] ${name} flush failed:`, err);
        }
      }
      try {
        await storage.flush();
      } catch (err) {
        log('[main] storage flush failed:', err);
      }
      try {
        await load('windows')?.markCleanExit?.(); // 2.4: crash-recovery marker (E2)
      } catch (err) {
        log('[main] markCleanExit failed:', err);
      }
      await logger.flush();
    })();
    // Never wait more than 2 s for disk writes; then quit anyway.
    withTimeout(work, 2000).finally(() => app.quit());
  });

  const ready = app.whenReady().then(boot).catch((err) => {
    log('[main] startup failed:', err);
    app.exit(1);
  });

  app.on('second-instance', (_event, argv, cwd) => {
    ready
      .then(() => onSecondInstance(argv, cwd))
      .catch((err) => log('[main] second-instance failed:', err));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}
