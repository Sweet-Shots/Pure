'use strict';
// main/updater.js — automatic updates from GitHub Releases with electron-updater (C1, Pure 2.2).
//
// Status = { state: 'disabled'|'idle'|'checking'|'available'|'downloading'|'ready'|'up-to-date'|'error',
//            version?, progress? (0–1), error? (for 'disabled': the reason), lastChecked? (ms) }
//
// Dormant unless the app is packaged AND the update source is real. The source is read from
// resources/app-update.yml (the file electron-builder writes and electron-updater reads), so the placeholder owner
// in package.json build.publish keeps the updater disabled. Disabled = no electron-updater load, no timers.
// When enabled: a check 10 s after startup, then every 6 h (one timer chain, unref'd), only while the
// autoUpdate setting is on. Manual checks (About → Check) always run. Downloads start automatically; the
// update is installed on quit (autoInstallOnAppQuit) or from the About page.
//
// Status is broadcast to pure://settings pages only. No update check or download detail is logged beyond errors.

const fs = require('fs');
const path = require('path');
const { app, webContents } = require('electron');
const { log } = require('./logger');
const storage = require('./storage');

const PLACEHOLDER_OWNER = 'PURE_GITHUB_OWNER';
const REASON_NOT_CONFIGURED = 'Update source not configured';
const REASON_UNPACKAGED = 'Updates are only available in the installed app';
const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const PROGRESS_MIN_MS = 250;
const SETTINGS_URL = /^pure:\/\/settings(?:[/?#]|$)/;

let status = { state: 'idle' };
let configured = false;
let hooked = false;
let updater = null;     // electron-updater's autoUpdater, loaded on first real use
let timer = null;
let checking = false;   // a check is in flight (download progress is not "checking")
let lastProgressAt = 0;

function snapshot() {
  return { ...status };
}

function broadcast() {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed() || !SETTINGS_URL.test(wc.getURL())) continue;
      wc.send('update:status', snapshot());
    } catch {
      // destroyed between the check and the send
    }
  }
}

function setStatus(next) {
  status = { ...next };
  broadcast();
}

function shortError(err) {
  const msg = err && typeof err.message === 'string' ? err.message : String(err || 'unknown error');
  return msg.slice(0, 200);
}

function versionOf(info) {
  return info && typeof info.version === 'string' ? info.version.slice(0, 40) : undefined;
}

// Only the settings page (top frame) may read status or act on it.
function isSettingsSender(event) {
  try {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) return false;
    return SETTINGS_URL.test(frame.url || '');
  } catch {
    return false;
  }
}

function autoUpdateOn() {
  return storage.settings.get().autoUpdate !== false;
}

// True when electron-builder wrote a real owner/repo into the packaged app.
async function sourceConfigured() {
  try {
    const text = await fs.promises.readFile(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = /^owner:\s*(\S+)/m.exec(text);
    const repo = /^repo:\s*(\S+)/m.exec(text);
    return !!owner && !!repo && owner[1] !== PLACEHOLDER_OWNER && !owner[1].includes(PLACEHOLDER_OWNER);
  } catch {
    return false;
  }
}

// Loads electron-updater and wires its events once. Only called when configured.
function loadUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // errors are reported through setStatus and log() below

  autoUpdater.on('checking-for-update', () => {
    if (status.state === 'downloading' || status.state === 'ready') return;
    setStatus({ state: 'checking', lastChecked: status.lastChecked });
  });
  autoUpdater.on('update-available', (info) => {
    if (status.state === 'ready') return;
    setStatus({ state: 'available', version: versionOf(info), lastChecked: Date.now() });
  });
  autoUpdater.on('download-progress', (p) => {
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_MIN_MS) return;
    lastProgressAt = now;
    const percent = p && Number.isFinite(p.percent) ? p.percent : 0;
    setStatus({
      state: 'downloading',
      version: status.version,
      progress: Math.min(Math.max(percent / 100, 0), 1),
      lastChecked: status.lastChecked,
    });
  });
  autoUpdater.on('update-downloaded', (event) => {
    setStatus({ state: 'ready', version: versionOf(event), lastChecked: status.lastChecked });
  });
  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'up-to-date', lastChecked: Date.now() });
  });
  autoUpdater.on('error', (err) => {
    const message = shortError(err);
    log('[updater] check failed:', message);
    setStatus({ state: 'error', error: message, lastChecked: Date.now() });
  });

  updater = autoUpdater;
  return updater;
}

// One check. Results arrive as updater events; resolves with the status after the check settled.
async function checkNow() {
  if (!configured || checking) return snapshot();
  if (status.state === 'downloading' || status.state === 'ready') return snapshot();
  checking = true;
  try {
    await loadUpdater().checkForUpdates();
  } catch (err) {
    const message = shortError(err);
    log('[updater] check failed:', message);
    setStatus({ state: 'error', error: message, lastChecked: Date.now() });
  } finally {
    checking = false;
  }
  return snapshot();
}

// Background checks: one timer chain. Re-armed after each check, and only while autoUpdate is on.
function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!configured || !autoUpdateOn()) return;
  timer = setTimeout(() => {
    timer = null;
    checkNow().finally(() => schedule(CHECK_EVERY_MS));
  }, ms);
  if (timer.unref) timer.unref();
}

function onSettingsChanged(settings) {
  if (!configured) return;
  if (settings && settings.autoUpdate === false) {
    if (timer) clearTimeout(timer);
    timer = null;
    return;
  }
  if (!timer && !checking) schedule(FIRST_CHECK_MS);
}

function init() {
  if (!hooked) {
    hooked = true;
    storage.settings.onChange(onSettingsChanged);
  }
  if (!app.isPackaged) {
    setStatus({ state: 'disabled', error: REASON_UNPACKAGED });
    return;
  }
  // Reads one small file asynchronously; the first check is scheduled only if the source is real.
  sourceConfigured()
    .then((ok) => {
      if (!ok) {
        setStatus({ state: 'disabled', error: REASON_NOT_CONFIGURED });
        return;
      }
      configured = true;
      schedule(FIRST_CHECK_MS);
    })
    .catch((err) => log('[updater] init failed:', shortError(err)));
}

function installNow(event) {
  if (!isSettingsSender(event)) return;
  if (status.state !== 'ready' || !updater) return;
  try {
    updater.quitAndInstall();
  } catch (err) {
    log('[updater] install failed:', shortError(err));
    setStatus({ state: 'error', error: shortError(err), lastChecked: status.lastChecked });
  }
}

function forbidden() {
  throw new Error('forbidden sender');
}

function registerIpc(ipc) {
  ipc.handle('update:status', (event) => {
    if (!isSettingsSender(event)) forbidden();
    return snapshot();
  });

  ipc.handle('update:check', (event) => {
    if (!isSettingsSender(event)) forbidden();
    return checkNow();
  });

  ipc.on('update:install', (event) => {
    installNow(event);
  });
}

module.exports = {
  init,
  registerIpc,
};
