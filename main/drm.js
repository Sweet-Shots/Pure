'use strict';
// Widevine DRM (2.5, F4). Pure runs on castLabs' Electron for Content Security (ECS), which installs the Widevine
// CDM as a Chromium component. Stock Electron has no `components` API, so on stock Electron everything here is a
// no-op and Widevine stays unavailable.
//
// The CDM is only installed here, never loaded: Chromium starts the CDM the first time a page asks for protected
// media (requestMediaKeySystemAccess / EME), so an idle browser pays nothing for it beyond this one install check.
// Nothing in this module may throw; startup continues whatever the CDM does.

const { log } = require('./logger');
const { isInternalSender } = require('./security');

// unsupported: stock Electron | installing: first-run download in progress | ready | failed
let state = 'unsupported';
let detail = null;

function componentsApi() {
  try {
    const electron = require('electron');
    return electron && electron.components ? electron.components : null;
  } catch {
    return null;
  }
}

function snapshotDetail(cdm, id) {
  try {
    const all = typeof cdm.status === 'function' ? cdm.status() : null;
    const entry = all && id ? all[id] : null;
    return entry ? JSON.parse(JSON.stringify(entry)) : null;
  } catch {
    return null;
  }
}

// Called from main/index.js after app ready, before the first window. The caller caps the wait at 3 s: a cached
// CDM registers at once, a first-run download may outlive the cap and then state flips to 'ready' in the background.
async function init() {
  try {
    const cdm = componentsApi();
    if (!cdm || typeof cdm.whenReady !== 'function') {
      state = 'unsupported';
      return;
    }
    const id = typeof cdm.WIDEVINE_CDM_ID === 'string' ? cdm.WIDEVINE_CDM_ID : null;
    // Only Widevine is required. The Google Windows CDM (Media Foundation) is experimental and disabled in releases.
    state = 'installing';
    await cdm.whenReady(id ? [id] : undefined);
    state = 'ready';
    detail = snapshotDetail(cdm, id);
    log('[drm] Widevine CDM ready', JSON.stringify(detail));
  } catch (err) {
    state = 'failed';
    log('[drm] Widevine CDM not available:', err && err.message ? err.message : err);
  }
}

function status() {
  return { state, detail };
}

function registerIpc(ipc) {
  // Read-only status for Settings > About (the preload must expose it; not wired yet).
  ipc.handle('drm:status', (event) => {
    if (!isInternalSender(event)) throw new Error('forbidden sender');
    return status();
  });
}

module.exports = { init, status, registerIpc };
