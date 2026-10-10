'use strict';
// preload/blocking-cosmetics.js — cosmetic filtering in every http(s) frame (Pure 2.3, owner D2).
//
// Sandboxed frame preload: `require` reaches electron only, so this file is self-contained. It runs in the
// isolated world and defines nothing on `window`, so the page never sees it.
//
// Life of a frame:
//   1. Document start: sendSync pure:blocking-scriptlets → scriptlet code, run in the page world with
//      webFrame.executeJavaScript (each scriptlet is already try-wrapped by main).
//   2. invoke pure:cosmetics-base → { styles, ext }. Styles go into an adopted stylesheet of THIS frame
//      (not webContents.insertCSS, which only reaches the top frame). ext = extended selectors, kept for step 4.
//   3. DOMContentLoaded (and every later batch): classes / ids / hrefs of the added or changed nodes, sent with
//      invoke pure:cosmetics-dom. Only features never sent before go out, at most 1000 per kind per message.
//   4. Extended selectors (:has-text, :upward, :remove(), …) are evaluated with the extended-selectors matcher.
//      Its source is fetched once per frame (pure:cosmetics-matcher) and only when the frame has such rules.
//      A match gets the attribute the engine's stylesheet hides, or the directive is applied.
//   5. One MutationObserver. Its records only queue nodes; one flush runs at most every 300 ms (idle callback)
//      and backs off while nothing new shows up. Quiet for 60 s → disconnect, and nothing runs until scroll,
//      pointer or key input, navigation or the tab becoming visible wakes it. Hidden tabs never observe.

const { ipcRenderer, webFrame } = require('electron');

const FLUSH_MS = 300;
const IDLE_MAX_MS = 2000;
const QUIET_MS = 60000;
const MAX_FEATURES = 1000; // per kind and message (main caps the same)
const MAX_KNOWN = 20000; // per kind and frame; past it, new features are not sent
const MAX_FEATURE_LEN = 300;
const MAX_PENDING_ROOTS = 256; // more changed nodes than this → one full rescan instead
const MAX_EXT = 500;
const SELECTOR = '[id],[class],[href]';
const IGNORED_TAGS = new Set(['br', 'head', 'link', 'meta', 'script', 'style', 's']);
const WAKE_EVENTS = ['scroll', 'pointerdown', 'keydown', 'popstate', 'hashchange', 'visibilitychange'];

// ── Styles ────────────────────────────────────────────────────────────────────
// Two adopted sheets: 'base' (hostname + generic rules, replaced on each reply) and 'dom' (accumulated batches).
const sheets = { base: null, dom: null };
let domCss = '';

function attachSheets() {
  const list = document.adoptedStyleSheets;
  const ours = [sheets.base, sheets.dom].filter(Boolean);
  if (ours.every((s) => Array.prototype.includes.call(list, s))) return;
  // The page may have replaced its own list; keep its sheets and put ours last.
  document.adoptedStyleSheets = [...list.filter((s) => s !== sheets.base && s !== sheets.dom), ...ours];
}

function putSheet(kind, css) {
  try {
    if (!sheets[kind]) sheets[kind] = new CSSStyleSheet();
    sheets[kind].replaceSync(css);
    attachSheets();
  } catch {
    // no constructable stylesheets: nothing to hide with, the page is left as it is
  }
}

// ── Extended selectors ────────────────────────────────────────────────────────
const extIds = new Set();
const extList = [];
let matcher = null;
let matcherReq = null;

// The UMD bundle exports querySelectorAll / handlePseudoDirective. It is evaluated here, in the isolated world.
function loadMatcher(src) {
  if (typeof src !== 'string' || src.length === 0) return null;
  const mod = { exports: {} };
  new Function('exports', 'module', src)(mod.exports, mod);
  const m = mod.exports;
  return typeof m.querySelectorAll === 'function' && typeof m.handlePseudoDirective === 'function' ? m : null;
}

function ensureMatcher() {
  if (!matcherReq) {
    matcherReq = ipcRenderer
      .invoke('pure:cosmetics-matcher')
      .then(loadMatcher)
      .catch(() => null)
      .then((m) => {
        matcher = m;
        return m;
      });
  }
  return matcherReq;
}

function addExtended(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  let added = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object' || !it.ast || extIds.has(it.id)) continue;
    if (extList.length >= MAX_EXT) break;
    extIds.add(it.id);
    extList.push(it);
    added++;
  }
  if (added > 0) ensureMatcher().then((m) => m && runExtended());
}

// One pass over the whole document. Returns the time it took (ms) so the flush can back off when it is slow.
function runExtended() {
  const root = document.documentElement;
  if (!matcher || !root || extList.length === 0) return 0;
  const t0 = performance.now();
  for (const item of extList) {
    // One broken rule must not stop the others.
    try {
      for (const el of matcher.querySelectorAll(root, item.ast)) {
        if (!el) continue;
        if (item.attribute) {
          if (!el.hasAttribute(item.attribute)) el.setAttribute(item.attribute, '');
        } else if (item.directive) {
          matcher.handlePseudoDirective(el, item.directive);
        }
      }
    } catch {
      // skipped for this pass
    }
  }
  // Our own edits must not queue another flush.
  if (observer) observer.takeRecords();
  return performance.now() - t0;
}

// ── Features (classes / ids / hrefs) ──────────────────────────────────────────
const known = { classes: new Set(), ids: new Set(), hrefs: new Set() };
const queued = { classes: new Set(), ids: new Set(), hrefs: new Set() };
let domBusy = false;

function note(kind, value) {
  if (value.length > MAX_FEATURE_LEN) return 0;
  const set = known[kind];
  if (set.has(value) || set.size >= MAX_KNOWN) return 0;
  set.add(value);
  queued[kind].add(value);
  return 1;
}

function visit(el) {
  if (IGNORED_TAGS.has(el.localName)) return 0;
  let found = 0;
  const id = el.getAttribute('id');
  if (id) found += note('ids', id);
  const cls = el.classList;
  for (let i = 0; i < cls.length; i++) found += note('classes', cls[i]);
  const href = el.getAttribute('href');
  if (href) found += note('hrefs', href);
  return found;
}

// Features of a subtree that are new to this frame. Returns how many were new.
function collect(root) {
  let found = visit(root);
  for (const el of root.querySelectorAll(SELECTOR)) found += visit(el);
  return found;
}

function queueSize() {
  return queued.classes.size + queued.ids.size + queued.hrefs.size;
}

function take(set) {
  const out = [];
  for (const v of set) {
    out.push(v);
    set.delete(v);
    if (out.length >= MAX_FEATURES) break;
  }
  return out;
}

function sendDom() {
  if (domBusy) return;
  const payload = { classes: take(queued.classes), ids: take(queued.ids), hrefs: take(queued.hrefs) };
  domBusy = true;
  ipcRenderer
    .invoke('pure:cosmetics-dom', payload)
    .then(onDom, () => {})
    .then(() => {
      domBusy = false;
      if (queueSize() > 0) scheduleFlush();
    });
}

// ── Replies ───────────────────────────────────────────────────────────────────
function onBase(res) {
  if (!res || typeof res !== 'object') return;
  if (typeof res.styles === 'string' && res.styles) putSheet('base', res.styles);
  addExtended(res.ext);
}

function onDom(res) {
  if (!res || typeof res !== 'object') return;
  if (typeof res.styles === 'string' && res.styles) {
    domCss += `\n${res.styles}`;
    putSheet('dom', domCss);
  }
  addExtended(res.ext);
}

// ── Observer, batched flushes ─────────────────────────────────────────────────
let observer = null;
const pendingRoots = new Set();
let pendingAll = false;
let flushTimer = 0;
let lastFlushAt = 0;
let quietSince = 0;
let delay = FLUSH_MS;
let waiting = false; // wake listeners attached

function onMutations(records) {
  for (const r of records) {
    if (r.type === 'childList') {
      for (const n of r.addedNodes) if (n.nodeType === 1) pendingRoots.add(n);
    } else if (r.target && r.target.nodeType === 1) {
      pendingRoots.add(r.target);
    }
  }
  if (pendingRoots.size > MAX_PENDING_ROOTS) {
    pendingRoots.clear();
    pendingAll = true;
  }
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  const wait = Math.max(0, lastFlushAt + delay - performance.now());
  flushTimer = setTimeout(() => {
    flushTimer = 0;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(flush, { timeout: 1000 });
    else flush();
  }, wait);
}

function flush() {
  const now = performance.now();
  lastFlushAt = now;
  if (document.hidden) {
    sleep();
    return;
  }
  const roots = pendingAll ? [document.documentElement] : [...pendingRoots];
  pendingRoots.clear();
  pendingAll = false;

  let found = 0;
  for (const root of roots) {
    if (root && root.nodeType === 1 && root.isConnected) found += collect(root);
  }
  if (queueSize() > 0) sendDom();

  let extCost = 0;
  if (extList.length > 0) {
    if (matcher) extCost = runExtended();
    else ensureMatcher().then((m) => m && runExtended());
  }
  attachSheets();

  if (found > 0) {
    quietSince = now;
    delay = FLUSH_MS;
  } else {
    delay = Math.min(delay * 2, IDLE_MAX_MS);
    if (now - quietSince > QUIET_MS) {
      sleep();
      return;
    }
  }
  // A slow whole-document pass gets at most ~5 % of the time.
  if (extCost * 20 > delay) delay = Math.min(IDLE_MAX_MS, extCost * 20);
}

function connect() {
  if (observer || !document.documentElement) return;
  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'id', 'href'],
  });
}

function sleep() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  pendingRoots.clear();
  pendingAll = false;
  if (!waiting) {
    waiting = true;
    for (const t of WAKE_EVENTS) window.addEventListener(t, wake, { capture: true, passive: true });
  }
}

function wake() {
  if (!waiting || document.hidden) return; // stays asleep until visible; visibilitychange calls again
  waiting = false;
  for (const t of WAKE_EVENTS) window.removeEventListener(t, wake, { capture: true });
  quietSince = performance.now();
  delay = FLUSH_MS;
  connect();
  pendingAll = true;
  scheduleFlush();
}

// ── Start ─────────────────────────────────────────────────────────────────────
function onReady() {
  if (!document.documentElement) return;
  connect();
  pendingAll = true;
  quietSince = performance.now();
  flush();
}

function start() {
  // 1. Scriptlets, before the page's own scripts. Main answers from its cache.
  let code = '';
  try {
    const v = ipcRenderer.sendSync('pure:blocking-scriptlets');
    if (typeof v === 'string') code = v;
  } catch {
    code = '';
  }
  if (code) webFrame.executeJavaScript(code).catch(() => {});

  // 2. Hostname and generic styles, as soon as main answers.
  ipcRenderer.invoke('pure:cosmetics-base').then(onBase, () => {});

  // 3-5. Once the DOM exists.
  window.addEventListener('pagehide', () => {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(flushTimer);
    flushTimer = 0;
  }, { once: true, passive: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
}

if (location.protocol === 'http:' || location.protocol === 'https:') {
  try {
    start();
  } catch {
    // a broken cosmetic layer must never break the page
  }
}
