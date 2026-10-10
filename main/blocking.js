'use strict';
// main/blocking.js — ad and tracker blocking: the engine, network rules, per-site exceptions, lifetime stats
// (Pure 2.1; engine and lists reworked in 2.3 by D1). Cosmetic filtering and scriptlets live in cosmetics.js.
//
// Engine (@ghostery/adblocker, the network + cosmetic rules the library parses):
//   - The filter lists come from main/filterlists.js (registry, cache, expiry, enable state).
//   - Building runs off the main thread: main/engine-worker.js parses the lists in a worker_threads Worker and
//     returns the serialized engine. The engine is then deserialized here and swapped in atomically: requests
//     that started with the old engine finish with it.
//   - Cache: userData/blocker/engine.bin (serialized engine) + engine.json ({key, builtAt, rules}). Startup loads
//     the cache at once; a build runs in the background only when the input changed (key) or a list expired.
//   - The key hashes the enabled list ids, their fetch times and the user's My filters, so a build is skipped
//     when nothing changed.
//
// Request handling (we register our own webRequest listeners per session, not the library's):
//   onBeforeRequest (http/https only):
//     1. blocking off globally, or no engine yet          -> allow (listener removed, zero per-request cost)
//     2. request has no webContents (net.fetch, workers)  -> allow
//     3. top-level page is pure://                        -> allow (internal pages and the browser UI)
//     4. top-level host has an exception                  -> allow
//     5. main-frame navigation                            -> never blocked; only $removeparam can rewrite it
//     6. engine.match(): redirect rule -> stand-in resource (counted), block rule -> cancel (counted),
//        otherwise $removeparam -> redirect to the URL without those parameters (GET only, not counted)
//   onHeadersReceived (document responses only, mainFrame + subFrame): $csp filters add Content-Security-Policy
//     headers (one per policy, so each is enforced); @@ exceptions and per-site exceptions are honoured.
//   "Top-level host" is the host of webContents.getURL(), cached per tab (refreshed on navigation).
//
// Stats: every blocked request counts for its tab (per webContents id, reset on main-frame navigation) and,
// unless the tab is in an incognito session, for lifetime stats (today/week/total/days/byType/topDomains/
// bytesSaved). bytesSaved is an ESTIMATE from fixed per-type averages (AVG_BYTES below).
// Persistence: userData/profile/blocking.json, debounced 5 s, atomic tmp+rename, flush() on before-quit.
// Incognito: blocks, updates per-tab counts and per-tab domains, but never writes stats or exceptions. An
// incognito window's shield toggle is kept in memory only (incOverride) and lasts until the app quits.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, webContents } = require('electron');
const { Worker } = require('worker_threads');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');
const { buildEngineBytes } = require('./engine-worker');
const { log } = require('./logger');
const security = require('./security');
const storage = require('./storage');
const filterlists = require('./filterlists');

const DAY_MS = 24 * 60 * 60 * 1000;
const SAVE_MS = 5000;
const SAVE_RETRY_MS = 60 * 1000;
const STATS_GAP_MS = 1000; // blocking:stats-changed to settings pages: at most 1/s
const COUNT_GAP_MS = 250; // blocking:count per tab: at most 4/s, with a trailing send
const KEEP_DAYS = 400;
const CHART_DAYS = 30;
const TOP_KEEP = 200;
const TOP_PRUNE_AT = 300;
const TOP_RETURN = 10;
const TAB_DOMAIN_CAP = 50;
const EXCEPTION_CAP = 2000;
const DOMAIN_MAX = 253;
const STARTUP_BUILD_DELAY_MS = 3000; // the first background check waits so the first window settles
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const ENGINE_WORKER = path.join(__dirname, 'engine-worker.js');

// Estimated bytes NOT downloaded per blocked request, by type. Rough averages, not measurements:
// ad/tracker scripts ~25 KB, banner/pixel images ~12 KB, beacons/API calls ~2 KB, ad iframes ~60 KB,
// video/audio chunks ~250 KB, anything else (fonts, css, pings, sockets) ~4 KB.
const AVG_BYTES = { script: 25000, image: 12000, xhr: 2000, frame: 60000, media: 250000, other: 4000 };
const TYPES = Object.keys(AVG_BYTES);

// Only page traffic. ws/wss, file, pure and everything else are never hooked.
const REQUEST_FILTER = { urls: ['http://*/*', 'https://*/*'] };
// $csp only ever applies to documents, so the response hook is limited to frame responses.
const CSP_FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] };

const forbidden = () => {
  throw new Error('forbidden sender');
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Normalized host for exceptions: lower-case, no "www.". '' when not a valid hostname.
function normHost(raw) {
  if (typeof raw !== 'string' || raw.length > DOMAIN_MAX) return '';
  let h = raw.trim().toLowerCase();
  if (h.startsWith('www.')) h = h.slice(4);
  return HOST_RE.test(h) ? h : '';
}

// Host of an http(s) URL, normalized as above. '' for anything else (pure://, about:, file:, ...).
function hostOfUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return '';
  try {
    return normHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

function currentUrl(wc) {
  try {
    return wc.getURL() || '';
  } catch {
    return '';
  }
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

// Local calendar day as YYYY-MM-DD (sorts lexically).
function dayKeyOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Key for the day that is `daysAgo` days before today (local time).
function dayKeyAgo(daysAgo) {
  const t = new Date();
  return dayKeyOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() - daysAgo));
}

function typeOf(resourceType) {
  switch (resourceType) {
    case 'script':
      return 'script';
    case 'image':
      return 'image';
    case 'xhr':
    case 'xmlhttprequest':
      return 'xhr';
    case 'subFrame':
    case 'sub_frame':
      return 'frame';
    case 'media':
      return 'media';
    default:
      return 'other';
  }
}

// Keeps the `keep` largest entries of a Map<string, number>.
function pruneTop(map, keep) {
  const sorted = [...map].sort((a, b) => b[1] - a[1]).slice(0, keep);
  map.clear();
  for (const [k, v] of sorted) map.set(k, v);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Lifetime stats and exceptions (persisted) ─────────────────────────────────
const stats = {
  since: 0,
  total: 0,
  bytesSaved: 0,
  byType: Object.fromEntries(TYPES.map((t) => [t, 0])),
  days: new Map(), // 'YYYY-MM-DD' -> count
  top: new Map(), // domain -> count (lifetime), pruned to TOP_KEEP
};
const exceptions = new Set(); // persisted: hosts where blocking is OFF
const incOverride = new Map(); // incognito only, memory: host -> true (on) | false (off)

let dayKeyNow = '';
let dayEnd = 0;

// Recomputes the cached "today" key once per local day. Old days are dropped when the day changes.
function refreshDay() {
  const now = Date.now();
  if (dayKeyNow && now < dayEnd) return;
  const key = dayKeyOf(new Date(now));
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  dayEnd = next.getTime();
  if (key !== dayKeyNow) {
    dayKeyNow = key;
    const cutoff = dayKeyOf(new Date(now - KEEP_DAYS * DAY_MS));
    for (const k of [...stats.days.keys()]) if (k < cutoff) stats.days.delete(k);
  }
}

let statsFile = null;
let statsDirty = false;
let saveTimer = null;
let saveChain = Promise.resolve();

function markDirty(delayMs = SAVE_MS) {
  statsDirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, delayMs);
  }
}

function serializeStats() {
  return {
    version: 1,
    since: stats.since,
    total: stats.total,
    bytesSaved: stats.bytesSaved,
    byType: stats.byType,
    days: Object.fromEntries(stats.days),
    topDomains: Object.fromEntries(stats.top),
    exceptions: [...exceptions],
  };
}

async function writeStats() {
  if (!statsDirty || !statsFile) return;
  statsDirty = false;
  const tmp = `${statsFile}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(serializeStats()), 'utf8');
    await fs.promises.rename(tmp, statsFile);
  } catch (err) {
    log('[blocking] cannot write blocking.json:', err && err.message);
    markDirty(SAVE_RETRY_MS);
  }
}

// Queued so two writes never overlap. Never rejects.
function save() {
  saveChain = saveChain.then(writeStats).catch(() => {});
  return saveChain;
}

const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

async function loadStats() {
  let raw = null;
  try {
    raw = await fs.promises.readFile(statsFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log('[blocking] cannot read blocking.json:', err && err.message);
  }
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      log(`[blocking] blocking.json is corrupt (${err.message}); moved to .bak`);
      await fs.promises.rename(statsFile, `${statsFile}.bak`).catch(() => {});
    }
  }
  const obj = data && typeof data === 'object' ? data : {};
  stats.since = num(obj.since) || Date.now();
  stats.total = num(obj.total);
  stats.bytesSaved = num(obj.bytesSaved);
  if (obj.byType && typeof obj.byType === 'object') {
    for (const t of TYPES) stats.byType[t] = num(obj.byType[t]);
  }
  const cutoff = dayKeyOf(new Date(Date.now() - KEEP_DAYS * DAY_MS));
  if (obj.days && typeof obj.days === 'object') {
    for (const [k, v] of Object.entries(obj.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k >= cutoff && num(v) > 0) stats.days.set(k, num(v));
    }
  }
  if (obj.topDomains && typeof obj.topDomains === 'object') {
    for (const [k, v] of Object.entries(obj.topDomains)) {
      const d = normHost(k) || (typeof k === 'string' && k.length <= DOMAIN_MAX ? k : '');
      if (d && num(v) > 0) stats.top.set(d, num(v));
    }
    if (stats.top.size > TOP_KEEP) pruneTop(stats.top, TOP_KEEP);
  }
  if (Array.isArray(obj.exceptions)) {
    for (const h of obj.exceptions) {
      const n = normHost(h);
      if (n && exceptions.size < EXCEPTION_CAP) exceptions.add(n);
    }
  }
  if (!data) markDirty(); // first run: create the file so `since` survives a restart
}

// Counts one blocked request in the lifetime stats (not used for incognito).
function countGlobal(type, domain) {
  refreshDay();
  stats.total++;
  stats.byType[type]++;
  stats.bytesSaved += AVG_BYTES[type];
  stats.days.set(dayKeyNow, (stats.days.get(dayKeyNow) || 0) + 1);
  stats.top.set(domain, (stats.top.get(domain) || 0) + 1);
  if (stats.top.size > TOP_PRUNE_AT) pruneTop(stats.top, TOP_KEEP);
  markDirty();
  scheduleStatsBroadcast();
}

function getStats() {
  refreshDay();
  const days = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const date = dayKeyAgo(i);
    days.push({ date, count: stats.days.get(date) || 0 });
  }
  let week = 0;
  for (let i = 0; i < 7; i++) week += stats.days.get(dayKeyAgo(i)) || 0;
  const topDomains = [...stats.top]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RETURN)
    .map(([domain, count]) => ({ domain, count }));
  return {
    today: stats.days.get(dayKeyNow) || 0,
    week,
    total: stats.total,
    bytesSaved: stats.bytesSaved,
    since: stats.since,
    days,
    byType: { ...stats.byType },
    topDomains,
  };
}

function resetStats() {
  stats.total = 0;
  stats.bytesSaved = 0;
  for (const t of TYPES) stats.byType[t] = 0;
  stats.days.clear();
  stats.top.clear();
  stats.since = Date.now();
  markDirty();
  scheduleStatsBroadcast();
  return getStats();
}

// blocking:stats-changed, at most once per second, only when a settings page is open.
let statsTimer = null;
let statsSentAt = 0;

function scheduleStatsBroadcast() {
  if (statsTimer) return;
  const wait = Math.max(0, statsSentAt + STATS_GAP_MS - Date.now());
  statsTimer = setTimeout(() => {
    statsTimer = null;
    statsSentAt = Date.now();
    broadcastStats();
  }, wait);
}

function isSettingsContents(wc) {
  try {
    return !wc.isDestroyed() && wc.getURL().startsWith('pure://settings');
  } catch {
    return false;
  }
}

function broadcastStats() {
  const targets = webContents.getAllWebContents().filter(isSettingsContents);
  if (!targets.length) return;
  const payload = getStats();
  for (const wc of targets) {
    try {
      wc.send('blocking:stats-changed', payload);
    } catch {
      // destroyed between the check and the send
    }
  }
}

// ── Exceptions ────────────────────────────────────────────────────────────────
// True when blocking is off for `host`. Incognito reads the persisted list, but its own toggles win.
function isExcepted(host, incognito) {
  if (incognito) {
    const o = incOverride.get(host);
    if (o !== undefined) return !o;
  }
  return exceptions.has(host);
}

// Sets blocking on/off for a host. Returns true when the effective state changed.
function setSite(host, enabled, incognito) {
  const before = isExcepted(host, incognito);
  if (incognito) {
    incOverride.set(host, enabled);
  } else if (enabled) {
    exceptions.delete(host);
  } else if (exceptions.size < EXCEPTION_CAP) {
    exceptions.add(host);
  }
  const changed = before !== isExcepted(host, incognito);
  if (changed && !incognito) {
    markDirty();
    scheduleStatsBroadcast();
  }
  return changed;
}

function exceptionList(incognito) {
  const out = new Set();
  for (const h of exceptions) {
    if (!(incognito && incOverride.get(h) === true)) out.add(h);
  }
  if (incognito) {
    for (const [h, on] of incOverride) if (!on) out.add(h);
  }
  return [...out].sort();
}

// ── Per-contents records (per-tab counts) ─────────────────────────────────────
const contentsRecs = new Map(); // webContents id -> record

function setRecUrl(rec, url) {
  rec.url = url;
  rec.host = hostOfUrl(url);
  rec.internal = url.startsWith('pure:');
}

// Creates the record for a webContents and attaches its listeners (once per contents).
function trackContents(wc, incognito) {
  const rec = {
    id: wc.id,
    wc,
    incognito,
    url: '',
    host: '',
    internal: false,
    blocked: 0,
    domains: new Map(), // eTLD+1 -> count, at most TAB_DOMAIN_CAP
    sentAt: 0,
    timer: null,
    held: 0, // requests currently held by the retry-loop breaker
    loops: new Map(), // url -> { n, t, looping } for the retry-loop breaker
  };
  setRecUrl(rec, currentUrl(wc));
  contentsRecs.set(rec.id, rec);
  wc.on('did-navigate', (_e, url) => {
    rec.blocked = 0;
    rec.domains.clear();
    rec.loops.clear();
    setRecUrl(rec, typeof url === 'string' ? url : currentUrl(wc));
    sendCount(rec);
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame && typeof url === 'string') setRecUrl(rec, url);
  });
  wc.once('destroyed', () => {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    contentsRecs.delete(rec.id);
  });
  return rec;
}

function tallyTab(rec, domain) {
  const n = rec.domains.get(domain);
  if (n !== undefined) {
    rec.domains.set(domain, n + 1);
    return;
  }
  if (rec.domains.size >= TAB_DOMAIN_CAP) {
    let minKey = null;
    let min = Infinity;
    for (const [k, v] of rec.domains) {
      if (v < min) {
        min = v;
        minKey = k;
      }
    }
    if (minKey !== null) rec.domains.delete(minKey);
  }
  rec.domains.set(domain, 1);
}

// blocking:count to the window that owns the tab. Looked up at send time: tabs can move between windows.
function tabsModule() {
  try {
    const mod = require('./tabs');
    return typeof mod.findTabByWebContentsId === 'function' ? mod : null;
  } catch {
    return null;
  }
}

function sendCount(rec) {
  rec.sentAt = Date.now();
  if (rec.wc.isDestroyed()) return;
  const mod = tabsModule();
  if (!mod) return;
  let found = null;
  try {
    found = mod.findTabByWebContentsId(rec.id);
  } catch {
    found = null;
  }
  const win = found && found.manager ? found.manager.win : null;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('blocking:count', { tabId: found.tab.id, blocked: rec.blocked });
  } catch {
    // window closing
  }
}

// Throttled to COUNT_GAP_MS per tab. A send is due at most once per gap, and a trailing send carries the latest count.
function scheduleCount(rec) {
  const wait = rec.sentAt + COUNT_GAP_MS - Date.now();
  if (wait <= 0) {
    sendCount(rec);
    return;
  }
  if (!rec.timer) {
    rec.timer = setTimeout(() => {
      rec.timer = null;
      sendCount(rec);
    }, wait);
  }
}

function topTabDomains(rec) {
  return [...rec.domains]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));
}

// ── Engine ────────────────────────────────────────────────────────────────────
let engine = null; // ElectronBlocker in use for matching; null until the first engine is installed
let activeKey = null; // filterlists key of the lists `engine` was built from (null: unknown, from an old cache)
let globalOn = true;
let levelValue = 'strict';
let liteWanted = false;
let liteSet = false; // setLiteMode() was called explicitly (possibly before init); it wins over the settings at init
let cookieWanted = false; // settings.blockCookieBanners: annoyance lists follow it like Lite mode does
let enginePath = null;
let metaPath = null;
let refreshTimer = null;
let jobChain = Promise.resolve();
let initPromise = null;
let lifecycleReady = false; // paths and stats are set up; engine work may start
const engineListeners = new Set();

// Engine work (cache loads, builds) runs one at a time. Jobs must not call buildNow() (that would wait on
// the job itself); they call doBuild() directly.
function enqueue(job) {
  const p = jobChain.then(job);
  jobChain = p.catch((err) => log('[blocking] engine job failed:', err && err.message));
  return p;
}

// A Uint8Array that owns its ArrayBuffer (offset 0, exact length): safe to deserialize and to transfer.
function ownBytes(u8) {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8;
  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  return out;
}

// Fresh ArrayBuffer copy for the worker (the originals stay usable for the inline fallback).
function transferCopy(u8) {
  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  return out.buffer;
}

async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

// Runs the build in a worker thread. Rejects on any failure (the caller falls back to an inline build).
function runWorker(input) {
  return new Promise((resolve, reject) => {
    const transfer = [];
    const lists = input.lists.map((l) => {
      const ab = transferCopy(l.buf);
      transfer.push(ab);
      return { id: l.id, buf: ab };
    });
    let resources = null;
    if (input.resources) {
      resources = transferCopy(input.resources);
      transfer.push(resources);
    }
    let done = false;
    let timer = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const worker = new Worker(ENGINE_WORKER, {
      workerData: { pureEngineBuild: true, input: { lists, resources } },
      transferList: transfer,
    });
    timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new Error('engine build timed out'));
    }, BUILD_TIMEOUT_MS);
    worker.once('message', (msg) => {
      if (msg && msg.ok === true) {
        finish(resolve, { bytes: new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength), counts: msg.counts });
      } else {
        finish(reject, new Error((msg && msg.error) || 'engine build failed'));
      }
    });
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => finish(reject, new Error(`engine worker exited with code ${code}`)));
  });
}

// Worker build, or the same code inline when no worker can run (main thread, slower; logged).
async function compileEngine(input) {
  try {
    return await runWorker(input);
  } catch (err) {
    log('[blocking] engine worker unavailable, building inline:', err && err.message);
  }
  const out = buildEngineBytes(input);
  return { bytes: out.bytes, counts: out.counts };
}

async function writeEngineCache(key, bytes, counts) {
  let rules = 0;
  for (const n of Object.values(counts)) rules += n;
  try {
    await writeAtomic(enginePath, bytes);
    await writeAtomic(metaPath, JSON.stringify({ version: 1, key, builtAt: Date.now(), rules }));
  } catch (err) {
    log('[blocking] cannot cache engine:', err && err.message);
  }
}

// Installs the cached engine right away (startup). The key may be stale; the first build then refreshes it.
async function loadCache() {
  let key = null;
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    key = meta && typeof meta.key === 'string' ? meta.key : null;
    try {
      require('./filterlists').noteCachedEngine(meta);
    } catch {
      // status line only
    }
  } catch {
    key = null;
  }
  let buf = null;
  try {
    buf = await fs.promises.readFile(enginePath);
  } catch (err) {
    if (err.code !== 'ENOENT') log('[blocking] cannot read cached engine:', err && err.message);
    return false;
  }
  try {
    install(key, ElectronBlocker.deserialize(ownBytes(buf)));
    return true;
  } catch (err) {
    log('[blocking] cached engine unusable, rebuilding:', err && err.message);
    return false;
  }
}

function install(key, eng) {
  engine = eng;
  activeKey = key;
  applyAll();
  for (const fn of engineListeners) {
    try {
      fn(eng);
    } catch (err) {
      log('[blocking] engine listener failed:', err && err.message);
    }
  }
}

// One build: lists -> (skip when unchanged) -> worker -> swap -> cache. Errors are returned, never thrown.
async function doBuild(reason, opts) {
  try {
    const input = await filterlists.prepare({ force: opts.force === true });
    const errors = input.errors.slice();
    if (!opts.force && engine && input.key === activeKey) return { ok: true, errors, changed: false };
    if (input.wanted > 0 && input.loaded === 0) {
      errors.push({ id: 'engine', message: 'No list could be loaded. Retrying later.' });
      return { ok: false, errors, changed: false };
    }
    filterlists.setBuilding(true);
    let ok = false;
    try {
      const { bytes, counts } = await compileEngine(input);
      install(input.key, ElectronBlocker.deserialize(bytes));
      filterlists.recordBuild(counts);
      ok = true;
      await writeEngineCache(input.key, bytes, counts);
      return { ok: true, errors, changed: true };
    } finally {
      filterlists.setBuilding(false, ok);
    }
  } catch (err) {
    const message = String((err && err.message) || err);
    log(`[blocking] build failed (${reason}):`, message);
    return { ok: false, errors: [{ id: 'engine', message }], changed: false };
  } finally {
    scheduleRefresh();
  }
}

// Queues a build. Resolves with { ok, errors, changed } once it has run. Used by filterlists.js and the timer.
function buildNow(reason, opts = {}) {
  if (!lifecycleReady) return Promise.resolve({ ok: false, errors: [{ id: 'engine', message: 'Blocking is starting.' }] });
  return enqueue(() => doBuild(reason || 'build', opts || {})).catch((err) => ({
    ok: false,
    errors: [{ id: 'engine', message: String((err && err.message) || err) }],
  }));
}

// Re-arms the timer for the next list expiry or retry (filterlists.nextDueMs).
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    buildNow('expiry');
  }, filterlists.nextDueMs(Date.now()));
  if (refreshTimer.unref) refreshTimer.unref();
}

async function startup() {
  await loadCache();
  await delay(STARTUP_BUILD_DELAY_MS);
  await doBuild('startup', {});
}

function onEngineChanged(fn) {
  if (typeof fn !== 'function') return () => {};
  engineListeners.add(fn);
  return () => engineListeners.delete(fn);
}

function getEngine() {
  return engine;
}

function level() {
  return levelValue;
}

// Safe before init(): the flag is recorded and the annoyance lists follow it once the lists are loaded.
function setLiteMode(on) {
  const want = on === true;
  liteSet = true;
  if (want === liteWanted) return;
  liteWanted = want;
  filterlists.setAnnoyanceAuto(liteWanted || cookieWanted);
}

// blockCookieBanners setting: the annoyance lists follow it, like Lite mode.
function setCookieBanners(on) {
  const want = on === true;
  if (want === cookieWanted) return;
  cookieWanted = want;
  filterlists.setAnnoyanceAuto(liteWanted || cookieWanted);
}

// ── Frame preloads (registered by cosmetics.js and picker.js) ─────────────────
const framePreloads = new Map(); // filePath -> always (true: registered even while blocking is globally off)

// Called once at require time by D2 (cosmetics) and D3 (picker). Normal preloads are registered on every session
// while blocking is on and an engine is loaded. { always: true } (the picker) stays registered on every attached
// session regardless of the blocking switch.
function registerFramePreload(filePath, opts) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return;
  const always = !!(opts && opts.always === true);
  if (framePreloads.get(filePath) === always) return;
  framePreloads.set(filePath, always);
  applyAll();
}

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessionRefs = new Set(); // WeakRef<Session>, so closed incognito sessions can be collected
const incognitoSessions = new WeakSet();
const attachedSessions = new WeakSet();
const hooked = new WeakSet(); // sessions where our webRequest listeners are installed
const preloadIds = new WeakMap(); // Session -> Map(filePath -> preload registration id)

function attach(ses, opts) {
  if (!ses || attachedSessions.has(ses)) return;
  attachedSessions.add(ses);
  const incognito = !!(opts && opts.incognito);
  if (incognito) incognitoSessions.add(ses);
  sessionRefs.add(new WeakRef(ses));
  applySession(ses);
}

// Listeners and frame preloads per session. Installed only while blocking is on and an engine is loaded.
function applySession(ses) {
  const want = globalOn && engine !== null;
  if (want && !hooked.has(ses)) {
    const incognito = incognitoSessions.has(ses);
    try {
      ses.webRequest.onBeforeRequest(REQUEST_FILTER, incognito ? onRequestIncognito : onRequest);
      ses.webRequest.onHeadersReceived(CSP_FILTER, incognito ? onHeadersIncognito : onHeaders);
      hooked.add(ses);
    } catch (err) {
      log('[blocking] webRequest hook failed:', err && err.message);
    }
  } else if (!want && hooked.has(ses)) {
    try {
      ses.webRequest.onBeforeRequest(null);
      ses.webRequest.onHeadersReceived(null);
    } catch {
      // session gone
    }
    hooked.delete(ses);
  }

  // Preloads: "always" ones on every session; the others only while blocking is on with an engine loaded.
  let regs = preloadIds.get(ses);
  if (!regs) {
    regs = new Map();
    preloadIds.set(ses, regs);
  }
  for (const [p, always] of framePreloads) {
    const wantPreload = always || want;
    const has = regs.has(p);
    if (wantPreload && !has) {
      try {
        regs.set(p, ses.registerPreloadScript({ type: 'frame', filePath: p }));
      } catch (err) {
        log('[blocking] frame preload failed:', err && err.message);
      }
    } else if (!wantPreload && has) {
      try {
        ses.unregisterPreloadScript(regs.get(p));
      } catch {
        // session gone
      }
      regs.delete(p);
    }
  }
  for (const [p, id] of [...regs]) {
    if (framePreloads.has(p)) continue;
    try {
      ses.unregisterPreloadScript(id);
    } catch {
      // session gone
    }
    regs.delete(p);
  }
}

function applyAll() {
  for (const ref of [...sessionRefs]) {
    const ses = ref.deref();
    if (ses) applySession(ses);
    else sessionRefs.delete(ref);
  }
}

// ── Request decision ──────────────────────────────────────────────────────────
function onRequest(details, callback) {
  handleRequest(false, details, callback);
}

function onRequestIncognito(details, callback) {
  handleRequest(true, details, callback);
}

function onHeaders(details, callback) {
  handleHeaders(false, details, callback);
}

function onHeadersIncognito(details, callback) {
  handleHeaders(true, details, callback);
}

// Retry-loop breaker. Some ad scripts re-request a blocked URL instantly and forever (seen on cnn.com:
// ~2,400 req/s, 240% CPU). Once a URL is blocked more than LOOP_LIMIT times within LOOP_WINDOW_MS on one page,
// further attempts are held for LOOP_HOLD_MS before being cancelled ("tarpit"): the loop slows to a trickle,
// the ad still never loads, and the repeats are not counted in stats.
const LOOP_LIMIT = 20;
const LOOP_WINDOW_MS = 2000;
const LOOP_HOLD_MS = 15000;
const LOOP_MAX_HELD = 64; // per page; beyond this, cancel immediately
const LOOP_MAX_URLS = 200; // per page; bounded memory

function handleRequest(incognito, details, callback) {
  let res = null;
  const eng = engine;
  if (eng && globalOn && details.webContentsId !== undefined) {
    try {
      res = details.resourceType === 'mainFrame'
        ? decideNavigation(eng, incognito, details)
        : decide(eng, incognito, details);
    } catch (err) {
      log('[blocking] request check failed:', err && err.message);
      res = null;
    }
  }
  if (res && res.tarpit) {
    const rec = res.rec;
    if (rec.held < LOOP_MAX_HELD) {
      rec.held++;
      setTimeout(() => {
        rec.held--;
        callback({ cancel: true });
      }, LOOP_HOLD_MS);
    } else {
      callback({ cancel: true });
    }
    return;
  }
  callback(res || {});
}

function isLooping(rec, url) {
  if (!rec.loops) rec.loops = new Map();
  const now = Date.now();
  let l = rec.loops.get(url);
  if (!l || (!l.looping && now - l.t > LOOP_WINDOW_MS)) {
    if (!l && rec.loops.size >= LOOP_MAX_URLS) rec.loops.clear();
    l = { n: 0, t: now, looping: false };
    rec.loops.set(url, l);
  }
  if (l.looping) return true;
  if (++l.n > LOOP_LIMIT) l.looping = true;
  return l.looping;
}

// $removeparam: the URL without the matched parameters, or null. GET only, and only when the URL really changes.
function rewriteFor(result, details) {
  if (details.method !== 'GET') return null;
  const url = result.rewrite && result.rewrite.url;
  if (!url || url === details.url) return null;
  return { redirectURL: url };
}

// Main-frame navigations are never blocked (the library never blocks them either); only $removeparam applies.
function decideNavigation(eng, incognito, details) {
  if (details.url.indexOf('?') < 0) return null;
  const host = hostOfUrl(details.url);
  if (!host || isExcepted(host, incognito)) return null;
  const req = Request.fromRawDetails({
    requestId: String(details.id),
    tabId: details.webContentsId,
    url: details.url,
    sourceUrl: details.referrer || details.url,
    type: 'mainFrame',
  });
  return rewriteFor(eng.match(req), details);
}

function decide(eng, incognito, details) {
  const id = details.webContentsId;
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return null;
  const rec = contentsRecs.get(id) || trackContents(wc, incognito);
  if (rec.internal) return null;
  if (rec.host && isExcepted(rec.host, incognito)) return null;

  const req = Request.fromRawDetails({
    requestId: String(details.id),
    tabId: id,
    url: details.url,
    sourceUrl: details.referrer || rec.url,
    type: details.resourceType || 'other',
  });
  const result = eng.match(req);
  if (!result.match && !result.redirect) return rewriteFor(result, details);
  if (!result.redirect && isLooping(rec, details.url)) return { tarpit: true, rec };

  const domain = (req.domain || req.hostname || '').slice(0, DOMAIN_MAX);
  rec.blocked++;
  if (domain) tallyTab(rec, domain);
  scheduleCount(rec);
  if (!incognito && domain) countGlobal(typeOf(req.type), domain);

  // A redirect rule answers with a stand-in resource. Check it before a plain block, as the library does.
  // Chromium refuses to redirect XHR/fetch to a data: URL (net::ERR_UNSAFE_REDIRECT), which pages handle
  // worse than a plain block — YouTube's player never started after an ad-id XHR failed that way. So the
  // stand-in resource is only used where Chromium accepts it (scripts, images, frames…); background
  // requests are simply blocked.
  if (result.redirect && details.resourceType !== 'xhr') return { redirectURL: result.redirect.dataUrl };
  return { cancel: true };
}

function handleHeaders(incognito, details, callback) {
  let headers = null;
  const eng = engine;
  if (eng && globalOn && details.webContentsId !== undefined) {
    try {
      headers = cspHeaders(eng, incognito, details);
    } catch (err) {
      log('[blocking] csp check failed:', err && err.message);
      headers = null;
    }
  }
  if (!headers) {
    callback({});
    return;
  }
  callback({ responseHeaders: headers });
}

// The response headers with the $csp policies added, or null when nothing applies. Each policy is its own
// header value, so the browser enforces it on top of the page's own policy (the library joins them instead).
function cspHeaders(eng, incognito, details) {
  if (!details.responseHeaders) return null;
  const id = details.webContentsId;
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return null;
  const rec = contentsRecs.get(id) || trackContents(wc, incognito);
  const isMain = details.resourceType === 'mainFrame';
  let host;
  if (isMain) {
    host = hostOfUrl(details.url);
    if (!host) return null;
  } else {
    if (rec.internal) return null;
    host = rec.host;
  }
  if (host && isExcepted(host, incognito)) return null;

  const req = Request.fromRawDetails({
    requestId: String(details.id),
    tabId: id,
    url: details.url,
    sourceUrl: isMain ? details.url : rec.url,
    type: details.resourceType,
  });
  if (!req.isSupported) return null;

  const policies = new Set();
  const excluded = new Set();
  for (const f of eng.csp.matchAll(req)) {
    if (f.isException()) {
      if (f.csp === undefined) return null; // @@ with no value: every $csp policy is off for this page
      excluded.add(f.csp);
    } else if (f.csp !== undefined) {
      policies.add(f.csp);
    }
  }
  const add = [...policies].filter((p) => !excluded.has(p));
  if (!add.length) return null;

  const out = { ...details.responseHeaders };
  const key = Object.keys(out).find((k) => k.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
  const existing = out[key] ? (Array.isArray(out[key]) ? out[key] : [out[key]]) : [];
  out[key] = [...existing, ...add];
  return out;
}

// ── Settings ──────────────────────────────────────────────────────────────────
function onSettingsChanged(s) {
  const on = s.blockingEnabled !== false;
  if (on !== globalOn) {
    globalOn = on;
    applyAll();
  }
  levelValue = s.blockingLevel === 'balanced' ? 'balanced' : 'strict';
  const lite = s.liteMode === true;
  if (lite !== liteWanted) setLiteMode(lite);
  setCookieBanners(s.blockCookieBanners === true);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
// Resolves once the stats and the list registry are read. The engine loads in the background (see startup).
function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const userData = app.getPath('userData');
    statsFile = path.join(userData, 'profile', 'blocking.json');
    enginePath = path.join(userData, 'blocker', 'engine.bin');
    metaPath = path.join(userData, 'blocker', 'engine.json');
    const s = storage.settings.get();
    globalOn = s.blockingEnabled !== false;
    levelValue = s.blockingLevel === 'balanced' ? 'balanced' : 'strict';
    if (!liteSet) liteWanted = s.liteMode === true;
    cookieWanted = s.blockCookieBanners === true;
    storage.settings.onChange(onSettingsChanged);
    await fs.promises.mkdir(path.dirname(statsFile), { recursive: true });
    await loadStats();
    refreshDay();
    await filterlists.init(userData);
    filterlists.setAnnoyanceAuto(liteWanted || cookieWanted);
    lifecycleReady = true;
    setTimeout(() => enqueue(startup), 0);
  })();
  return initPromise;
}

// Writes pending stats, exceptions and list state now. Called from index.js on before-quit.
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return Promise.all([save(), filterlists.flush()]).then(() => undefined);
}

function blockedOnTab(webContentsId) {
  const rec = contentsRecs.get(webContentsId);
  return rec ? rec.blocked : 0;
}

// Whether blocking applies to a page at `url` in this contents: on globally, http(s), not excepted.
function isActiveFor(wc, url) {
  if (!globalOn) return false;
  const host = hostOfUrl(typeof url === 'string' ? url : currentUrl(wc));
  if (!host) return false;
  let incognito = false;
  try {
    incognito = incognitoSessions.has(wc.session);
  } catch {
    incognito = false;
  }
  return !isExcepted(host, incognito);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function windowsModule() {
  return require('./windows');
}

function registerIpc(ipc) {
  ipc.handle('blocking:site-info', (event, tabId) => {
    if (!security.isChromeSender(event)) forbidden();
    if (!Number.isInteger(tabId) || tabId <= 0) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    const manager = win ? windowsModule().getTabManager(win) : null;
    const tab = manager ? manager.get(tabId) : null;
    if (!tab) return null;
    const incognito = windowsModule().isIncognitoWindow(win);
    const host = hostOfUrl(tab.url);
    const live = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    const rec = live ? contentsRecs.get(live.id) : null;
    return {
      tabId,
      host,
      enabled: globalOn && !(host && isExcepted(host, incognito)),
      blocked: rec ? rec.blocked : 0,
      domains: rec ? topTabDomains(rec) : [],
    };
  });

  ipc.handle('blocking:set-site', (event, host, enabled) => {
    if (!security.isChromeSender(event)) forbidden();
    const h = normHost(host);
    if (!h || typeof enabled !== 'boolean') return false;
    const win = BrowserWindow.fromWebContents(event.sender);
    const incognito = windowsModule().isIncognitoWindow(win);
    setSite(h, enabled, incognito);
    return !isExcepted(h, incognito);
  });

  ipc.handle('blocking:stats', (event) => {
    if (!security.isInternalSender(event)) forbidden();
    return getStats();
  });

  ipc.handle('blocking:reset-stats', (event) => {
    if (!security.isInternalSender(event)) forbidden();
    // Incognito never touches the persisted stats.
    if (incognitoSessions.has(event.sender.session)) return getStats();
    return resetStats();
  });

  ipc.handle('blocking:exceptions', (event) => {
    if (!security.isInternalSender(event)) forbidden();
    return exceptionList(incognitoSessions.has(event.sender.session));
  });

  ipc.handle('blocking:remove-exception', (event, host) => {
    if (!security.isInternalSender(event)) forbidden();
    const h = normHost(host);
    if (!h) return false;
    // Removing an exception turns blocking back on for that host.
    return setSite(h, true, incognitoSessions.has(event.sender.session));
  });
}

module.exports = {
  init,
  attach,
  getStats,
  blockedOnTab,
  setLiteMode,
  registerIpc,
  flush,
  getEngine,
  onEngineChanged,
  isActiveFor,
  level,
  registerFramePreload,
  buildNow,
};
