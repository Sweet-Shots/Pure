// System IPC for internal pages (pure://home, pure://settings, pure://error): app info,
// clear browsing data, site permissions, default-browser handling. All handlers accept
// internal senders only.
'use strict';

const { app, nativeTheme, shell } = require('electron');
const security = require('./security');

const MAX_STRING = 300;
const THEMES = new Set(['dark', 'light', 'system']);
let themeHooked = false;
const DEFAULT_BROWSER_SETTINGS = 'ms-settings:defaultapps?registeredAppUser=Pure%20Browser';
// Electron 44's ClearStorageDataOptions.storages (websql is no longer supported).
const PERSISTED_STORAGES = ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'];

function log(...args) {
  try { require('./logger').log(...args); } catch { /* ignore */ }
}

function requireInternal(event) {
  if (!security.isInternalSender(event)) {
    throw new Error('system: forbidden sender');
  }
}

function asString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING ? value : null;
}

function normalSession() {
  return require('./sessions').getSession({ incognito: false });
}

async function clearData(what) {
  const picks = what && typeof what === 'object' ? what : {};
  const ses = normalSession();
  const done = [];

  if (picks.cookies) {
    await ses.clearStorageData({ storages: PERSISTED_STORAGES });
    done.push('cookies');
  }
  if (picks.cache) {
    await ses.clearCache();
    await ses.clearCodeCaches({});
    done.push('cache');
  }
  if (picks.history) {
    require('./storage').history.clear();
    done.push('history');
  }
  if (picks.downloads) {
    require('./downloads').clearFinished();
    done.push('downloads');
  }
  return { ok: true, cleared: done };
}

function getSitePermissions() {
  try {
    const list = require('./storage').sitePermissions.list();
    return Array.isArray(list) ? list : [];
  } catch (err) {
    log('system: site permissions list failed', err && err.message);
    return [];
  }
}

function resetSitePermission(origin, permission) {
  const o = asString(origin);
  const p = asString(permission);
  if (!o || !p) return false;
  require('./storage').sitePermissions.reset(o, p);
  return true;
}

function openDefaultBrowserSettings() {
  if (process.platform === 'win32') {
    shell.openExternal(DEFAULT_BROWSER_SETTINGS).catch((err) => log('system: settings open failed', err && err.message));
    return;
  }
  // Best effort elsewhere: register as the handler for web links.
  try {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
  } catch (err) {
    log('system: setAsDefaultProtocolClient failed', err && err.message);
  }
}

// settings.theme drives nativeTheme.themeSource, which sets prefers-color-scheme for the browser UI,
// pure:// pages and web pages. Only assigned when the value actually changes.
function applyTheme(value) {
  if (!THEMES.has(value)) return;
  try {
    if (nativeTheme.themeSource !== value) nativeTheme.themeSource = value;
  } catch (err) {
    log('system: theme update failed', err && err.message);
  }
}

function hookTheme() {
  if (themeHooked) return;
  themeHooked = true;
  const storage = require('./storage');
  applyTheme(storage.settings.get().theme);
  storage.settings.onChange((settings) => applyTheme(settings.theme));
}

function isDefaultBrowser() {
  try {
    return !!app.isDefaultProtocolClient('https');
  } catch {
    return false;
  }
}

function registerIpc(ipcMain) {
  hookTheme();

  ipcMain.handle('internal:info', (event) => {
    requireInternal(event);
    return {
      version: app.getVersion(),
      isIncognito: require('./sessions').isIncognitoSession(event.sender.session),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    };
  });

  ipcMain.handle('system:clear-data', async (event, what) => {
    requireInternal(event);
    return clearData(what);
  });

  ipcMain.handle('system:site-permissions', (event) => {
    requireInternal(event);
    return getSitePermissions();
  });

  ipcMain.handle('system:site-permission-reset', (event, origin, permission) => {
    requireInternal(event);
    return resetSitePermission(origin, permission);
  });

  ipcMain.on('system:default-browser', (event) => {
    if (!security.isInternalSender(event)) return;
    openDefaultBrowserSettings();
  });

  ipcMain.handle('system:is-default-browser', (event) => {
    requireInternal(event);
    return isDefaultBrowser();
  });
}

module.exports = { registerIpc };
