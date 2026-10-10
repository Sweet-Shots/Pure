'use strict';
// main/cosmetics.js — cosmetic filtering for every http(s) frame (Pure 2.3, owner D2).
//
// The frame preload (preload/blocking-cosmetics.js) asks, all sender-checked:
//   pure:blocking-scriptlets  sync    → scriptlet code for this frame (level 'strict' only)
//   pure:cosmetics-base       invoke  → { styles, ext }  generic base sheet + hostname rules, extended selectors
//   pure:cosmetics-dom        invoke  → { styles, ext }  class/id/href rules for NEW features only
//   pure:cosmetics-matcher    invoke  → extended-selector matcher source (UMD, read once, then cached)
// The Ghostery '@ghostery/adblocker/*' channels are taken over here too; they are answered inertly because
// nothing registers the Ghostery frame preload any more.
//
// Ancestors come from the frame's WebFrameMain.parent chain, computed here (the renderer is not trusted).
// Per-hostname results (scriptlets, hostname styles, extended selectors) live in a small LRU keyed by
// hostname + domain + ancestors and are dropped when the engine changes. The generic base sheet is one string
// per engine. Exceptions are checked on every request with blocking.isActiveFor(webContents, topFrameUrl).
// Only the lookups happen here; everything the page sees is produced by the frame preload.

const fs = require('fs');
const path = require('path');

const MAX_FEATURES = 1000; // classes / ids / hrefs per message and per kind (the preload caps the same)
const MAX_FEATURE_LEN = 300;
const MAX_ANCESTORS = 16;
const CACHE_MAX = 64; // hostname entries
const EMPTY = Object.freeze({ styles: '', ext: Object.freeze([]) });

// Logging without requiring electron at load time (keeps this module loadable by the test harness).
function log(...args) {
  try {
    require('./logger').log(...args);
  } catch {
    // no logger outside Electron
  }
}

function blockingApi() {
  try {
    const b = require('./blocking');
    return b && typeof b.isActiveFor === 'function' ? b : null;
  } catch {
    return null;
  }
}

// ── Host parsing ──────────────────────────────────────────────────────────────
let parseTld = (url) => {
  try {
    return { hostname: new URL(url).hostname, domain: '' };
  } catch {
    return { hostname: '', domain: '' };
  }
};
try {
  const tldts = require('tldts-experimental');
  parseTld = (url) => tldts.parse(url);
} catch (err) {
  log('[cosmetics] tldts unavailable, using hostname only:', err && err.message);
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function hostParts(url) {
  const p = parseTld(url) || {};
  return {
    hostname: typeof p.hostname === 'string' ? p.hostname : '',
    domain: typeof p.domain === 'string' ? p.domain : '',
  };
}

// Engine view of a frame (anything with url / parent / top, i.e. a WebFrameMain). null for non-http(s) frames.
function frameContext(frame) {
  try {
    const url = frame.url;
    if (!isHttpUrl(url)) return null;
    const self = hostParts(url);
    const ancestors = [];
    let p = frame.parent;
    for (let n = 0; p && n < MAX_ANCESTORS; n++) {
      if (isHttpUrl(p.url)) {
        const a = hostParts(p.url);
        if (a.hostname) ancestors.push(a);
      }
      p = p.parent;
    }
    const top = frame.top ? frame.top.url : url;
    const key = `${self.hostname}|${self.domain}|${ancestors.map((a) => `${a.hostname}|${a.domain}`).join('|')}`;
    return { url, hostname: self.hostname, domain: self.domain, ancestors, top, key };
  } catch {
    return null;
  }
}

// Context of the frame that sent the IPC, or null when it must get nothing (not http(s), or blocking is off or
// excepted for the top-level page).
function allowedFrame(event) {
  const frame = event && event.senderFrame;
  if (!frame || !event.sender) return null;
  const ctx = frameContext(frame);
  if (!ctx) return null;
  const b = blockingApi();
  if (!b) return null;
  let active = false;
  try {
    active = b.isActiveFor(event.sender, ctx.top) === true;
  } catch {
    active = false;
  }
  return active ? ctx : null;
}

function currentEngine() {
  const b = blockingApi();
  try {
    return b && typeof b.getEngine === 'function' ? b.getEngine() || null : null;
  } catch {
    return null;
  }
}

function isStrict() {
  const b = blockingApi();
  try {
    return !!b && typeof b.level === 'function' && b.level() === 'strict';
  } catch {
    return false;
  }
}

// ── Engine lookups ────────────────────────────────────────────────────────────
// Scriptlets run in one try block each, so a failing scriptlet can't stop the others.
function joinScripts(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list.map((code) => `try {\n${code}\n} catch (e) {}`).join('\n');
}

let cacheEngine = null;
const hostCache = new Map(); // key -> entry, insertion order = recency

// Everything the engine says about one frame, with hostname and ancestor rules but no DOM-dependent rules.
// Built once per key and cached; `allowGeneric` is false when the site excepts generic hiding ($elemhide).
function buildEntry(engine, ctx) {
  if (engine.config && engine.config.loadCosmeticFilters === false) {
    return { active: false, allowGeneric: false, styles: '', scripts: '', ext: [] };
  }
  const m = engine.matchCosmeticFilters({
    url: ctx.url,
    hostname: ctx.hostname,
    domain: ctx.domain,
    ancestors: ctx.ancestors,
    getRulesFromDOM: false,
    getRulesFromHostname: true,
    getInjectionRules: true,
    getExtendedRules: true,
  });
  const filters = [];
  for (const { filter, exception } of m.matches) {
    if (filter !== undefined && exception === undefined) filters.push(filter);
  }
  const inj = engine.injectCosmeticFilters(filters, {
    url: ctx.url,
    injectScriptlets: true,
    injectExtended: true,
    allowGenericHides: m.allowGenericHides,
    getBaseRules: false,
  });
  return {
    active: true,
    allowGeneric: m.allowGenericHides !== false,
    styles: inj.styles || '',
    scripts: joinScripts(inj.scripts),
    ext: Array.isArray(inj.extended) ? inj.extended : [],
  };
}

function entryFor(engine, ctx) {
  if (cacheEngine !== engine) {
    hostCache.clear();
    cacheEngine = engine;
  }
  const hit = hostCache.get(ctx.key);
  if (hit) {
    hostCache.delete(ctx.key); // move to the most-recent end
    hostCache.set(ctx.key, hit);
    return hit;
  }
  const entry = buildEntry(engine, ctx);
  hostCache.set(ctx.key, entry);
  if (hostCache.size > CACHE_MAX) hostCache.delete(hostCache.keys().next().value);
  return entry;
}

// The generic stylesheet that no hostname rule can un-hide. Identical for every site, so kept once per engine.
let baseEngine = null;
let baseCss = '';
function genericBase(engine) {
  if (baseEngine !== engine) {
    baseEngine = engine;
    baseCss = null;
  }
  if (baseCss === null) {
    try {
      baseCss = engine.injectCosmeticFilters([], {
        url: 'https://pure.invalid/',
        injectScriptlets: false,
        injectExtended: false,
        allowGenericHides: true,
        getBaseRules: true,
      }).styles || '';
    } catch (err) {
      log('[cosmetics] base sheet failed:', err && err.message);
      baseCss = '';
    }
  }
  return baseCss;
}

function basePayload(engine, ctx) {
  const e = entryFor(engine, ctx);
  if (!e.active) return EMPTY;
  const base = e.allowGeneric ? genericBase(engine) : '';
  const styles = [base, e.styles].filter(Boolean).join('\n');
  return { styles, ext: e.ext };
}

// DOM-dependent generic rules for the features the frame reports. The engine returns only rules matching these
// features (its class / id / href indices); the hostname and base rules came from basePayload.
function domPayload(engine, ctx, feats) {
  const r = engine.getCosmeticsFilters({
    url: ctx.url,
    hostname: ctx.hostname,
    domain: ctx.domain,
    ancestors: ctx.ancestors,
    classes: feats.classes,
    hrefs: feats.hrefs,
    ids: feats.ids,
    getBaseRules: false,
    getInjectionRules: false,
    getExtendedRules: true,
    getRulesFromHostname: false,
    getRulesFromDOM: true,
  });
  if (r.active === false) return EMPTY;
  return { styles: r.styles || '', ext: Array.isArray(r.extended) ? r.extended : [] };
}

// Strings only, bounded in count and length. Anything else is dropped.
function cleanFeatures(p) {
  if (!p || typeof p !== 'object') return null;
  const list = (v) => {
    const out = [];
    if (!Array.isArray(v)) return out;
    for (const s of v) {
      if (typeof s === 'string' && s.length > 0 && s.length <= MAX_FEATURE_LEN) {
        out.push(s);
        if (out.length >= MAX_FEATURES) break;
      }
    }
    return out;
  };
  return { classes: list(p.classes), ids: list(p.ids), hrefs: list(p.hrefs) };
}

// ── Extended-selector matcher source ──────────────────────────────────────────
// The UMD bundle of @ghostery/adblocker-extended-selectors (same version as the engine). Sandboxed preloads
// cannot require files, so the frame gets the source once and evaluates it itself.
let matcherSource = null;
function readMatcherSource() {
  if (!matcherSource) {
    matcherSource = (async () => {
      const pkg = require.resolve('@ghostery/adblocker-extended-selectors/package.json');
      return fs.promises.readFile(path.join(path.dirname(pkg), 'dist', 'adblocker.umd.min.js'), 'utf8');
    })().catch((err) => {
      log('[cosmetics] extended-selector matcher unavailable:', err && err.message);
      return '';
    });
  }
  return matcherSource;
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerIpc(ipc) {
  // Document-start scriptlets. Synchronous: the page waits for them before its own scripts run.
  ipc.on('pure:blocking-scriptlets', (event) => {
    // Assign returnValue exactly once: in Electron the assignment itself sends the synchronous reply, so a
    // default assigned first would be what the page receives (that bug delivered '' to every page).
    let code = '';
    try {
      if (isStrict()) {
        const ctx = allowedFrame(event);
        const engine = ctx ? currentEngine() : null;
        if (engine) {
          const e = entryFor(engine, ctx);
          if (e.active) code = e.scripts;
        }
      }
    } catch (err) {
      log('[cosmetics] scriptlet lookup failed:', err && err.message);
    }
    event.returnValue = code;
  });

  ipc.handle('pure:cosmetics-base', (event) => {
    const ctx = allowedFrame(event);
    const engine = ctx ? currentEngine() : null;
    if (!engine) return EMPTY;
    try {
      return basePayload(engine, ctx);
    } catch (err) {
      log('[cosmetics] base lookup failed:', err && err.message);
      return EMPTY;
    }
  });

  ipc.handle('pure:cosmetics-dom', (event, payload) => {
    const feats = cleanFeatures(payload);
    if (!feats || (feats.classes.length === 0 && feats.ids.length === 0 && feats.hrefs.length === 0)) return EMPTY;
    const ctx = allowedFrame(event);
    const engine = ctx ? currentEngine() : null;
    if (!engine) return EMPTY;
    try {
      return domPayload(engine, ctx, feats);
    } catch (err) {
      log('[cosmetics] DOM lookup failed:', err && err.message);
      return EMPTY;
    }
  });

  ipc.handle('pure:cosmetics-matcher', (event) => (allowedFrame(event) ? readMatcherSource() : ''));

  // Taken over from the Ghostery preload (see the header). Answered inertly: no cosmetic data leaves main here.
  ipc.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => false);
  ipc.handle('@ghostery/adblocker/inject-cosmetic-filters', () => undefined);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
const b = blockingApi();
if (b) {
  try {
    b.registerFramePreload(path.join(__dirname, '..', 'preload', 'blocking-cosmetics.js'));
  } catch (err) {
    log('[cosmetics] frame preload not registered:', err && err.message);
  }
  if (typeof b.onEngineChanged === 'function') {
    b.onEngineChanged((engine) => {
      hostCache.clear();
      cacheEngine = null;
      baseEngine = null;
      baseCss = '';
      // Build the generic sheet now, off the first page load.
      if (engine) setImmediate(() => genericBase(engine));
    });
  }
}

module.exports = {
  registerIpc,
  // Pure helpers, exported for the test harness only.
  _internal: { frameContext, entryFor, basePayload, domPayload, cleanFeatures, genericBase },
};
