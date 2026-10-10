// Google sign-in compatibility.
//
// Google refuses sign-in ("This browser or app may not be secure") when it decides a Chromium-based
// browser is an embedded/automation browser. Pure's Chrome user agent is correct, but Electron differs
// from Google Chrome in ways the sign-in page checks (no "Google Chrome" client-hint brand, an empty
// `window.chrome` object, …). Faking those internals is fragile, so — like other Electron browsers (e.g.
// Min) — Pure presents itself as Firefox, ONLY on Google's account pages. Google does not run its
// Chrome-specific checks for Firefox. Every other site keeps seeing the normal Chrome user agent.
//
// Cost: one webRequest header hook filtered to https://accounts.google.com/* (other requests never reach
// it), plus a cheap host check on main-frame navigations.

const { app } = require('electron');
const { log } = require('./logger');

const SIGNIN_HOSTS = new Set(['accounts.google.com']);

// Firefox ships a new major version roughly every 4 weeks, with a longer gap over the new year. Deriving the
// version from the date keeps the user agent current without updates. Anchor: Firefox 147 on 2026-01-13.
// One release is subtracted so the estimate never names a version that doesn't exist yet (a future version
// is itself a red flag); being one release behind is normal for real users.
function firefoxVersion(now = Date.now()) {
  const base = Date.UTC(2026, 0, 13);
  const fourWeeks = 28 * 24 * 60 * 60 * 1000;
  const yearsPassed = Math.max(0, new Date(now).getUTCFullYear() - 2026); // one extra-long gap per new year
  return 147 + Math.max(0, Math.floor((now - base) / fourWeeks) - yearsPassed - 1);
}

function firefoxUserAgent() {
  const v = firefoxVersion();
  const platform = {
    win32: 'Windows NT 10.0; Win64; x64',
    darwin: 'Macintosh; Intel Mac OS X 10.15',
    linux: 'X11; Linux x86_64',
  }[process.platform] || 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${platform}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
}

const FIREFOX_UA = firefoxUserAgent();

function isSigninUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && SIGNIN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// ── Request headers (per session) ────────────────────────────────────────────
const hooked = new WeakSet();

function attach(ses) {
  if (!ses || hooked.has(ses)) return;
  hooked.add(ses);
  // Page-side half: makes the sign-in page's JS environment match the Firefox user agent (see the preload).
  try {
    ses.registerPreloadScript({
      type: 'frame',
      id: 'pure-google-signin-compat',
      filePath: require('path').join(__dirname, '..', 'preload', 'google-signin-compat.js'),
    });
  } catch (err) {
    log('[google-signin] preload registration failed:', err && err.message);
  }
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders || {};
    headers['User-Agent'] = FIREFOX_UA;
    // Firefox sends no User-Agent client hints; Chromium's would contradict the Firefox user agent.
    for (const name of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(name)) delete headers[name];
    }
    callback({ requestHeaders: headers });
  });
  hookContents();
}

// ── navigator.userAgent inside the page (per webContents) ───────────────────
// The header hook covers network requests; the page's own navigator.userAgent comes from the webContents.
let contentsHooked = false;
const switched = new WeakSet(); // webContents currently using the Firefox user agent

function onNavigation(wc, details) {
  if (!details || !details.isMainFrame || wc.isDestroyed()) return;
  const signin = isSigninUrl(details.url);
  if (signin && !switched.has(wc)) {
    switched.add(wc);
    wc.setUserAgent(FIREFOX_UA);
  } else if (!signin && switched.has(wc)) {
    switched.delete(wc);
    wc.setUserAgent(require('./sessions').USER_AGENT);
  }
}

function hookContents() {
  if (contentsHooked) return;
  contentsHooked = true;
  app.on('web-contents-created', (_event, wc) => {
    // Only page contents (tabs and popups); the browser UI and internal pages never visit Google.
    wc.on('did-start-navigation', (details) => {
      try {
        onNavigation(wc, details);
      } catch (err) {
        log('[google-signin] navigation hook failed:', err && err.message);
      }
    });
  });
}

module.exports = { attach, FIREFOX_UA, isSigninUrl };
