// Frame preload registered by main/google-signin.js. On Google's sign-in pages ONLY, it makes the page's own
// JavaScript environment consistent with the Firefox user agent Pure sends there: Chromium-only properties
// (navigator.userAgentData, window.chrome, Chrome's navigator.vendor/productSub/appVersion) are removed or
// given Firefox's values. It runs before the page's scripts and does nothing on any other site.

const { webFrame } = require('electron');

if (location.protocol === 'https:' && location.hostname === 'accounts.google.com') {
  webFrame.executeJavaScript(`(() => {
    const N = Navigator.prototype;
    const define = (obj, key, value) => {
      try { Object.defineProperty(obj, key, { get: () => value, configurable: true, enumerable: true }); } catch {}
    };
    // Firefox has no User-Agent Client Hints API at all.
    try { delete N.userAgentData; } catch {}
    // Firefox values for properties that differ from Chromium.
    define(N, 'vendor', '');
    define(N, 'productSub', '20100101');
    define(N, 'appVersion', '5.0 (Windows)');
    define(N, 'oscpu', 'Windows NT 10.0; Win64; x64');
    define(N, 'buildID', '20181001000000');
    // window.chrome only exists in Chromium browsers.
    try { delete window.chrome; } catch {}
  })();`).catch(() => {
    // Frames that are torn down mid-load reject; nothing to do.
  });
}
