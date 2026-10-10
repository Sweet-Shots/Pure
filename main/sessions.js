'use strict';
// Electron sessions for Pure.
// - Normal windows share 'persist:pure' (disk-backed profile).
// - Each incognito window gets its own in-memory partition, wiped by destroyIncognitoSession().
// Every session is configured exactly once: Chrome-like user agent, pure:// handler, permission and
// download hooks (permissions.js / downloads.js, owned by H5), spellchecker.

const { app, session } = require('electron');
const { log } = require('./logger');
const protocol = require('./protocol');
const storage = require('./storage');

// Chrome's reduced user agent: no Electron or app tokens, major version only, platform from process.platform.
function platformToken() {
  switch (process.platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'linux':
      return 'X11; Linux x86_64';
    default:
      return 'Windows NT 10.0; Win64; x64';
  }
}
const CHROME_MAJOR = String(process.versions.chrome).split('.')[0];
const USER_AGENT =
  `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

const configured = new WeakSet();
const incognitoSessions = new WeakSet();
const incognitoByWindow = new Map(); // windowId -> Session
const liveSessions = new Set(); // every configured session, for settings updates
let normalSession = null;
let anonCounter = 0;
let settingsHooked = false;

function attempt(label, fn) {
  try {
    fn();
  } catch (err) {
    log(`[sessions] ${label} failed:`, err);
  }
}

// Optional hook modules: a missing or broken module is logged, never fatal.
function loadHook(name) {
  try {
    return require(name);
  } catch (err) {
    log(`[sessions] ${name} unavailable:`, err);
    return null;
  }
}

function acceptLanguages() {
  const langs = app.getPreferredSystemLanguages();
  return (langs.length ? langs : ['en-US']).join(',');
}

// Up to two system languages that the built-in spellchecker has dictionaries for (fewer dictionaries = less RAM).
function spellcheckLanguages(ses) {
  const available = ses.availableSpellCheckerLanguages || [];
  const picks = [];
  for (const lang of app.getPreferredSystemLanguages()) {
    const exact = available.includes(lang) ? lang : null;
    const base = lang.split('-')[0];
    const match = exact || available.find((a) => a === base || a.startsWith(base + '-'));
    if (match && !picks.includes(match)) picks.push(match);
    if (picks.length === 2) break;
  }
  return picks;
}

function attachPermissions(ses, incognito) {
  const mod = loadHook('./permissions');
  if (mod && typeof mod.attach === 'function') {
    attempt('permissions.attach', () => mod.attach(ses, { incognito }));
    return;
  }
  // Fail closed: without the permission module no site permission is granted.
  attempt('permission fallback', () => {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  });
}

function attachDownloads(ses, incognito) {
  const mod = loadHook('./downloads');
  if (mod && typeof mod.attach === 'function') {
    attempt('downloads.attach', () => mod.attach(ses, { incognito }));
  }
}

function attachBlocking(ses, incognito) {
  const mod = loadHook('./blocking');
  if (mod && typeof mod.attach === 'function') {
    attempt('blocking.attach', () => mod.attach(ses, { incognito }));
  }
}

// 2.2 hooks: passwords (frame preload + IPC) and extensions (persistent profile only — the module decides).
function attachHook(name, ses, incognito) {
  const mod = loadHook('./' + name);
  if (mod && typeof mod.attach === 'function') {
    attempt(name + '.attach', () => mod.attach(ses, { incognito }));
  }
}

function hookSettings() {
  if (settingsHooked) return;
  settingsHooked = true;
  storage.settings.onChange((settings) => {
    for (const ses of liveSessions) {
      attempt('spellchecker', () => ses.setSpellCheckerEnabled(settings.spellcheck !== false));
    }
  });
}

function configure(ses, { incognito = false } = {}) {
  if (configured.has(ses)) return ses;
  configured.add(ses);
  if (incognito) incognitoSessions.add(ses);
  liveSessions.add(ses);

  attempt('user agent', () => ses.setUserAgent(USER_AGENT, acceptLanguages()));
  protocol.handle(ses);
  attachPermissions(ses, incognito);
  attachDownloads(ses, incognito);
  attachBlocking(ses, incognito);
  attachHook('passwords', ses, incognito);
  attachHook('extensions', ses, incognito);
  attachHook('google-signin', ses, incognito); // Firefox UA on accounts.google.com only (see module)
  attempt('spellchecker', () => {
    ses.setSpellCheckerEnabled(storage.settings.get().spellcheck !== false);
    const langs = spellcheckLanguages(ses);
    if (langs.length) ses.setSpellCheckerLanguages(langs);
  });
  hookSettings();
  return ses;
}

// Session(s) returned here are only valid after app ready.
function getSession({ incognito = false, windowId } = {}) {
  // The default session is configured too (pure:// and UA must work in any session).
  configure(session.defaultSession);

  if (!incognito) {
    if (!normalSession) normalSession = configure(session.fromPartition('persist:pure'));
    return normalSession;
  }

  const key = windowId ?? `anon-${++anonCounter}`;
  let ses = incognitoByWindow.get(key);
  if (!ses) {
    // No 'persist:' prefix = in-memory partition. cache:false keeps nothing on disk.
    ses = session.fromPartition(`pure-incognito-${key}`, { cache: false });
    incognitoByWindow.set(key, ses);
    configure(ses, { incognito: true });
  }
  return ses;
}

function isIncognitoSession(ses) {
  return !!ses && incognitoSessions.has(ses);
}

// Call after every tab of an incognito window is destroyed. Clears all data of that partition.
async function destroyIncognitoSession(windowId) {
  const ses = incognitoByWindow.get(windowId);
  if (!ses) return;
  incognitoByWindow.delete(windowId);
  liveSessions.delete(ses);
  try {
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (err) {
    log('[sessions] clearing incognito data failed:', err);
  }
}

module.exports = {
  USER_AGENT,
  getSession,
  isIncognitoSession,
  destroyIncognitoSession,
};
