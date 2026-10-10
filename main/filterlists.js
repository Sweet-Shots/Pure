'use strict';
// main/filterlists.js — the filter-list registry of the blocker (Pure 2.3, owner D1).
//
// Here: the built-in lists (ids, names, groups, defaults), user-added URL lists, the per-list text cache with
// expiry, the enabled/disabled choices, the lists:* IPC, and prepare() — the list side of an engine build.
// The engine itself (parse in the worker, install, cache) lives in blocking.js.
//
// Files:
//   userData/profile/filterlists.json   { version, enabled: {id: bool}, custom: [{id, url}] }   user choices
//   userData/blocker/lists/index.json   { version, lists: {id: {fetchedAt, expiresMs, retryAt, rules, error}} }
//   userData/blocker/lists/<id>.txt     list text as downloaded (UTF-8)
// Writes are debounced (1 s), atomic (tmp + rename) and flushed on quit.
//
// Expiry: "! Expires: N hours|days" in the list header (default 4 days, never under 1 hour). A failed download
// keeps the last good copy and is retried after an hour (retryAt), so a dead URL never causes a retry loop.
// Annoyance lists are on when the user switched them on, or, without an explicit choice, when Lite mode or
// blockCookieBanners is on (setAnnoyanceAuto).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net, webContents } = require('electron');
const { ENGINE_VERSION } = require('@ghostery/adblocker');
const security = require('./security');
const { log } = require('./logger');

// ── Registry ──────────────────────────────────────────────────────────────────
// def: true (on by default) | false (off) | 'auto' (follows the annoyance rule above).
// urls: one list = one or more files, concatenated. All URLs were checked with curl (HTTP 200) at dev time.
const UBO = 'https://ublockorigin.github.io/uAssets';
const HAGEZI = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock';
const RESOURCES_URL = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const RES_ID = 'resources';

function yearlyUrls() {
  const out = [];
  for (let y = 2020; y <= new Date().getUTCFullYear(); y++) out.push(`${UBO}/filters/filters-${y}.txt`);
  return out;
}

const BUILTIN = [
  // default: uBO (uBlock Origin's own lists), EasyList, EasyPrivacy, Peter Lowe
  { id: 'ublock-filters', name: 'uBlock filters – ads (incl. yearly lists)', group: 'default', def: true, urls: [`${UBO}/filters/filters.txt`, ...yearlyUrls()] },
  { id: 'ublock-badware', name: 'uBlock filters – badware risks', group: 'default', def: true, urls: [`${UBO}/filters/badware.txt`] },
  { id: 'ublock-privacy', name: 'uBlock filters – privacy', group: 'default', def: true, urls: [`${UBO}/filters/privacy.txt`] },
  { id: 'ublock-quick-fixes', name: 'uBlock filters – quick fixes', group: 'default', def: true, urls: [`${UBO}/filters/quick-fixes.txt`] },
  { id: 'ublock-unbreak', name: 'uBlock filters – unbreak', group: 'default', def: true, urls: [`${UBO}/filters/unbreak.txt`] },
  { id: 'ublock-resource-abuse', name: 'uBlock filters – resource abuse', group: 'default', def: true, urls: [`${UBO}/filters/resource-abuse.txt`] },
  { id: 'easylist', name: 'EasyList', group: 'default', def: true, urls: [`${UBO}/thirdparties/easylist.txt`] },
  { id: 'easyprivacy', name: 'EasyPrivacy', group: 'default', def: true, urls: [`${UBO}/thirdparties/easyprivacy.txt`] },
  { id: 'peter-lowe', name: "Peter Lowe's ad and tracking server list", group: 'default', def: true,
    urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext'] },

  // DNS-style multipurpose lists
  { id: 'hagezi-multi-normal', name: 'HaGeZi Multi NORMAL', group: 'dns', def: true, recommended: true, urls: [`${HAGEZI}/multi.txt`] },
  { id: 'hagezi-pro', name: 'HaGeZi Pro', group: 'dns', def: false, urls: [`${HAGEZI}/pro.txt`] },
  { id: 'hagezi-pro-plus', name: 'HaGeZi Pro++', group: 'dns', def: false, urls: [`${HAGEZI}/pro.plus.txt`] },

  // annoyances: follow Lite mode / cookie-banner blocking unless the user chose otherwise
  { id: 'ublock-annoyances-cookies', name: 'uBlock filters – cookie notices', group: 'annoyances', def: 'auto', urls: [`${UBO}/filters/annoyances-cookies.txt`] },
  { id: 'ublock-annoyances-others', name: 'uBlock filters – other annoyances', group: 'annoyances', def: 'auto', urls: [`${UBO}/filters/annoyances-others.txt`] },
  { id: 'easylist-cookie', name: 'EasyList – cookie notices', group: 'annoyances', def: 'auto', urls: [`${UBO}/thirdparties/easylist-cookies.txt`] },

  // regional (off)
  { id: 'easylist-germany', name: 'EasyList Germany', group: 'regional', def: false, urls: ['https://easylist.to/easylistgermany/easylistgermany.txt'] },
  { id: 'liste-fr', name: 'Liste FR', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/liste_fr.txt'] },
  { id: 'easylist-italy', name: 'EasyList Italy', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/easylistitaly.txt'] },
  { id: 'easylist-spanish', name: 'EasyList Spanish', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/easylistspanish.txt'] },
  { id: 'easylist-dutch', name: 'EasyList Dutch', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/easylistdutch.txt'] },
  { id: 'ru-adlist', name: 'RU AdList', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/advblock.txt'] },
  { id: 'easylist-china', name: 'EasyList China', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/easylistchina.txt'] },
  { id: 'adguard-japanese', name: 'AdGuard Japanese', group: 'regional', def: false, urls: ['https://filters.adtidy.org/extension/ublock/filters/7.txt'] },
  { id: 'indianlist', name: 'IndianList', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/indianlist.txt'] },
  { id: 'easylist-polish', name: 'EasyList Polish', group: 'regional', def: false, urls: ['https://easylist-downloads.adblockplus.org/easylistpolish.txt'] },
  { id: 'adguard-turkish', name: 'AdGuard Turkish', group: 'regional', def: false, urls: ['https://filters.adtidy.org/extension/ublock/filters/13.txt'] },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_EXPIRES = 4 * DAY;
const MIN_EXPIRES = HOUR;
const MAX_EXPIRES = 14 * DAY;
const RETRY_MS = HOUR;
const MAX_BYTES_BUILTIN = 16 * 1024 * 1024;
const MAX_BYTES_CUSTOM = 10 * 1024 * 1024;
const CUSTOM_CAP = 20;
const URL_MAX = 2048;
const FETCH_TIMEOUT_MS = 90 * 1000;
const SAVE_MS = 1000;
const REBUILD_MS = 1000;
const BROADCAST_MS = 250;
const MIN_TIMER_MS = 60 * 1000;
const MAX_TIMER_MS = 24 * HOUR;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

// ── State ─────────────────────────────────────────────────────────────────────
let inited = false;
let profileFile = null;
let indexFile = null;
let listsDir = null;
let enabledOverride = new Map(); // id -> bool (explicit user choice)
let customLists = []; // [{id, url}]
let index = new Map(); // id -> record (see header)
let autoAnnoy = false;
let building = false;
let builtAt = 0;
let engineRules = null; // total rules of the engine last built
let dirtyProfile = false;
let dirtyIndex = false;
let saveTimer = null;
let saveChain = Promise.resolve();
let bcastTimer = null;
let rebuildTimer = null;
let rebuildDeferred = null;
let rebuildReason = 'rebuild';

const forbidden = () => {
  throw new Error('forbidden sender');
};

function validUrl(s) {
  if (typeof s !== 'string' || s.length > URL_MAX) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function customId(url) {
  return `custom-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
}

function shortName(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
  return String(err.message || err).slice(0, 160);
}

// ── Entries ───────────────────────────────────────────────────────────────────
function customEntries() {
  return customLists.map((c) => ({ id: c.id, name: shortName(c.url), group: 'custom', def: true, urls: [c.url], custom: true }));
}

function allEntries() {
  return [...BUILTIN, ...customEntries()];
}

function findEntry(id) {
  if (typeof id !== 'string') return undefined;
  return allEntries().find((e) => e.id === id);
}

function isEnabled(e) {
  const o = enabledOverride.get(e.id);
  if (typeof o === 'boolean') return o;
  if (e.def === 'auto') return autoAnnoy;
  return e.def === true;
}

function enabledEntries() {
  return allEntries().filter(isEnabled);
}

function listView(e) {
  const r = index.get(e.id) || {};
  const out = {
    id: e.id,
    name: e.name,
    group: e.group,
    url: e.urls[0],
    enabled: isEnabled(e),
    recommended: e.recommended === true,
    rules: typeof r.rules === 'number' ? r.rules : null,
    updatedAt: r.fetchedAt || null,
  };
  if (r.error) out.error = r.error;
  return out;
}

function state() {
  return { lists: allEntries().map(listView), building, builtAt, rules: engineRules };
}

// ── Persistence ───────────────────────────────────────────────────────────────
async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log('[filterlists] cannot read', path.basename(file), err && err.message);
    return null;
  }
}

function parseProfile(o) {
  const enabled = new Map();
  const custom = [];
  if (o && o.enabled && typeof o.enabled === 'object') {
    for (const [k, v] of Object.entries(o.enabled)) {
      if (ID_RE.test(k) && typeof v === 'boolean') enabled.set(k, v);
    }
  }
  if (o && Array.isArray(o.custom)) {
    for (const c of o.custom) {
      if (custom.length >= CUSTOM_CAP) break;
      if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || !validUrl(c.url)) continue;
      if (custom.some((x) => x.id === c.id || x.url === c.url)) continue;
      custom.push({ id: c.id, url: c.url });
    }
  }
  return { enabled, custom };
}

function parseIndex(o) {
  const out = new Map();
  const lists = o && o.lists && typeof o.lists === 'object' ? o.lists : {};
  for (const [id, r] of Object.entries(lists)) {
    if (!ID_RE.test(id) && id !== RES_ID) continue;
    if (!r || typeof r !== 'object') continue;
    const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
    out.set(id, {
      fetchedAt: num(r.fetchedAt),
      expiresMs: num(r.expiresMs) || DEFAULT_EXPIRES,
      retryAt: num(r.retryAt),
      rules: Number.isFinite(r.rules) ? r.rules : null,
      error: typeof r.error === 'string' ? r.error.slice(0, 160) : null,
    });
  }
  return out;
}

function serializeProfile() {
  return {
    version: 1,
    enabled: Object.fromEntries(enabledOverride),
    custom: customLists.map((c) => ({ id: c.id, url: c.url })),
  };
}

function serializeIndex() {
  const lists = {};
  for (const [id, r] of index) lists[id] = { ...r };
  return { version: 1, lists };
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, SAVE_MS);
}

async function writeDirty() {
  if (dirtyProfile) {
    dirtyProfile = false;
    try {
      await writeAtomic(profileFile, JSON.stringify(serializeProfile()));
    } catch (err) {
      dirtyProfile = true;
      log('[filterlists] cannot write filterlists.json:', err && err.message);
    }
  }
  if (dirtyIndex) {
    dirtyIndex = false;
    try {
      await writeAtomic(indexFile, JSON.stringify(serializeIndex()));
    } catch (err) {
      dirtyIndex = true;
      log('[filterlists] cannot write lists/index.json:', err && err.message);
    }
  }
}

// Queued so two writes never overlap. Never rejects.
function save() {
  saveChain = saveChain.then(writeDirty).catch(() => {});
  return saveChain;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
async function init(userDataDir) {
  if (inited) return;
  profileFile = path.join(userDataDir, 'profile', 'filterlists.json');
  listsDir = path.join(userDataDir, 'blocker', 'lists');
  indexFile = path.join(listsDir, 'index.json');
  const p = parseProfile(await readJson(profileFile));
  enabledOverride = p.enabled;
  customLists = p.custom;
  index = parseIndex(await readJson(indexFile));
  // A record whose text file is gone counts as never fetched, so the next build downloads it again.
  await Promise.all(
    [...index.keys()].map(async (id) => {
      try {
        await fs.promises.access(path.join(listsDir, `${id}.txt`));
      } catch {
        const r = index.get(id);
        r.fetchedAt = 0;
        dirtyIndex = true;
      }
    }),
  );
  inited = true;
  if (dirtyIndex) scheduleSave();
}

// Pending writes are written now. Called on before-quit (index.js).
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return save();
}

// Annoyance lists follow Lite mode / cookie-banner blocking. A change rebuilds the engine (debounced).
function setAnnoyanceAuto(on) {
  const v = on === true;
  if (v === autoAnnoy) return;
  autoAnnoy = v;
  if (inited) rebuild('annoyances');
}

// ── Downloads and the list side of a build ────────────────────────────────────
// Downloads fail on purpose-built bad input too (HTML error pages), so the body is only checked for size here.
async function download(url, maxBytes) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length'));
      if (declared > maxBytes) throw new Error('list is too large');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('list is too large');
      return buf;
    } catch (err) {
      lastErr = err;
      if (err.message === 'list is too large') break;
    }
  }
  throw lastErr;
}

// "! Expires: 8 hours" / "! Expires: 6 days (update frequency)"; null when the header is absent.
const EXPIRES_RE = /^!\s*Expires:\s*(\d+(?:\.\d+)?)\s*(hours?|h|days?|d)\b/im;
function parseExpires(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  const m = EXPIRES_RE.exec(head);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].startsWith('h') ? HOUR : DAY;
  return Math.min(MAX_EXPIRES, Math.max(MIN_EXPIRES, Math.round(n * unit)));
}

// Downloads an entry (all its files) and replaces its cache file atomically. Throws on failure; the old copy stays.
async function fetchEntry(entry, maxBytes, fallbackExpires) {
  const parts = await Promise.all(entry.urls.map((u) => download(u, maxBytes)));
  let expires = null;
  for (const part of parts) {
    const ms = parseExpires(part);
    if (ms !== null) expires = expires === null ? ms : Math.min(expires, ms);
  }
  const data = parts.length === 1 ? parts[0] : Buffer.concat(parts.flatMap((p, i) => (i ? [Buffer.from('\n'), p] : [p])));
  await writeAtomic(path.join(listsDir, `${entry.id}.txt`), data);
  const prev = index.get(entry.id) || {};
  index.set(entry.id, {
    fetchedAt: Date.now(),
    expiresMs: expires !== null ? expires : fallbackExpires || DEFAULT_EXPIRES,
    retryAt: 0,
    rules: prev.rules ?? null,
    error: null,
  });
  dirtyIndex = true;
  scheduleSave();
}

function recordError(id, message) {
  const prev = index.get(id) || { fetchedAt: 0, expiresMs: DEFAULT_EXPIRES, rules: null };
  index.set(id, { ...prev, retryAt: Date.now() + RETRY_MS, error: message });
  dirtyIndex = true;
  scheduleSave();
}

function isDue(id, now, force) {
  if (force) return true;
  const r = index.get(id);
  if (!r) return true;
  if (r.retryAt && now < r.retryAt) return false;
  if (!r.fetchedAt) return true;
  return now >= r.fetchedAt + (r.expiresMs || DEFAULT_EXPIRES);
}

async function readCache(id) {
  try {
    return await fs.promises.readFile(path.join(listsDir, `${id}.txt`));
  } catch {
    return null;
  }
}

// The user's My filters text (picker.js, D3), compiled in as one more list.
function getUserListText() {
  try {
    const picker = require('./picker');
    if (picker && typeof picker.getMyFiltersText === 'function') {
      const t = picker.getMyFiltersText();
      return typeof t === 'string' ? t : '';
    }
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') log('[filterlists] picker unavailable:', err.message);
  }
  return '';
}

function computeKey(lists, resBuf, resAt) {
  const h = crypto.createHash('sha1');
  h.update(`v1|${ENGINE_VERSION}|`);
  for (const l of lists) {
    if (l.id === 'my-filters') {
      h.update(`my:${crypto.createHash('sha1').update(l.buf).digest('hex')}|`);
    } else {
      h.update(`${l.id}:${index.get(l.id).fetchedAt}:${l.buf.length}|`);
    }
  }
  h.update(`res:${resAt || 0}:${resBuf ? resBuf.length : 0}`);
  return h.digest('hex');
}

// Makes sure every enabled list is as fresh as its expiry allows (or fresh now when `force`), then returns the
// build input. Lists that cannot be downloaded and have no cached copy are left out (their errors are returned).
// The key identifies the exact input; blocking.js skips the build when it equals the installed engine's key.
async function prepare({ force = false } = {}) {
  const now = Date.now();
  const enabled = enabledEntries();
  const resources = { id: RES_ID, urls: [RESOURCES_URL] };
  const errors = [];
  const due = [...enabled, resources].filter((e) => isDue(e.id, now, force));
  await Promise.all(
    due.map(async (e) => {
      try {
        await fetchEntry(e, e.custom ? MAX_BYTES_CUSTOM : MAX_BYTES_BUILTIN, e.id === RES_ID ? DAY : null);
      } catch (err) {
        const message = describeError(err);
        recordError(e.id, message);
        errors.push({ id: e.id, message });
        log(`[filterlists] ${e.id}: ${message}`);
      }
      broadcastSoon();
    }),
  );

  const lists = [];
  for (const e of enabled) {
    const r = index.get(e.id);
    if (!r || !r.fetchedAt) continue;
    const buf = await readCache(e.id);
    if (buf) lists.push({ id: e.id, buf });
  }
  const resBuf = await readCache(RES_ID);
  const my = getUserListText();
  if (my.trim()) lists.push({ id: 'my-filters', buf: Buffer.from(my, 'utf8') });
  const key = computeKey(lists, resBuf, (index.get(RES_ID) || {}).fetchedAt);
  if (dirtyIndex) scheduleSave();
  return { key, lists, resources: resBuf, errors, wanted: enabled.length, loaded: lists.length - (my.trim() ? 1 : 0) };
}

// After a build: per-list rule counts for the UI and the engine total.
function recordBuild(counts) {
  let total = 0;
  for (const [id, n] of Object.entries(counts || {})) {
    total += n;
    if (id === 'my-filters') continue;
    const r = index.get(id);
    if (r) r.rules = n;
  }
  engineRules = total;
  dirtyIndex = true;
  scheduleSave();
  broadcastSoon();
}

// Milliseconds until the next list is due (expiry or retry). Clamped to [1 min, 24 h]; blocking.js sleeps on it.
function nextDueMs(now = Date.now()) {
  let next = Infinity;
  for (const e of [...enabledEntries(), { id: RES_ID }]) {
    const r = index.get(e.id) || {};
    let t;
    if (r.retryAt && r.retryAt > now) t = r.retryAt;
    else if (!r.fetchedAt) t = now;
    else t = r.fetchedAt + (r.expiresMs || DEFAULT_EXPIRES);
    if (t < next) next = t;
  }
  if (next === Infinity) return MAX_TIMER_MS;
  return Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, next - now));
}

// Startup loads a cached engine: show when it was built (and its size) until the next build.
function noteCachedEngine(meta) {
  if (!meta || typeof meta !== 'object') return;
  if (!builtAt && Number.isFinite(meta.builtAt)) builtAt = meta.builtAt;
  if (engineRules === null && Number.isFinite(meta.rules)) engineRules = meta.rules;
  broadcastSoon();
}

function setBuilding(on, ok = false) {
  building = on === true;
  if (!building && ok) builtAt = Date.now();
  broadcastSoon();
}

// ── Rebuild requests (debounced) ──────────────────────────────────────────────
// Asks blocking.js for a build after REBUILD_MS of quiet. Every caller gets the same promise.
function rebuild(reason) {
  if (!inited) return Promise.resolve({ ok: false, errors: [] });
  if (!rebuildDeferred) {
    const d = {};
    d.promise = new Promise((resolve) => {
      d.resolve = resolve;
    });
    rebuildDeferred = d;
  }
  const d = rebuildDeferred;
  rebuildReason = reason || rebuildReason;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuildDeferred = null;
    let p;
    try {
      p = Promise.resolve(require('./blocking').buildNow(rebuildReason));
    } catch (err) {
      p = Promise.resolve({ ok: false, errors: [{ id: 'engine', message: describeError(err) }] });
    }
    p.then(d.resolve);
  }, REBUILD_MS);
  return d.promise;
}

// ── Broadcast (lists:changed to pure://settings pages, coalesced) ─────────────
function isSettingsContents(wc) {
  try {
    return !wc.isDestroyed() && wc.getURL().startsWith('pure://settings');
  } catch {
    return false;
  }
}

function broadcastNow() {
  const targets = webContents.getAllWebContents().filter(isSettingsContents);
  if (!targets.length) return;
  const payload = state();
  for (const wc of targets) {
    try {
      wc.send('lists:changed', payload);
    } catch {
      // destroyed between the check and the send
    }
  }
}

function broadcastSoon() {
  if (bcastTimer) return;
  bcastTimer = setTimeout(() => {
    bcastTimer = null;
    broadcastNow();
  }, BROADCAST_MS);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerIpc(ipc) {
  ipc.handle('lists:get', (event) => {
    if (!security.isInternalSender(event)) forbidden();
    return state();
  });

  ipc.handle('lists:set-enabled', (event, id, enabled) => {
    if (!security.isInternalSender(event)) forbidden();
    const e = findEntry(id);
    if (!e || typeof enabled !== 'boolean') return { error: 'unknown list' };
    enabledOverride.set(e.id, enabled);
    dirtyProfile = true;
    scheduleSave();
    rebuild('toggle');
    return state();
  });

  ipc.handle('lists:add', (event, url) => {
    if (!security.isInternalSender(event)) forbidden();
    const clean = typeof url === 'string' ? url.trim() : '';
    if (!validUrl(clean)) return { error: 'Enter a full http:// or https:// address.' };
    if (customLists.some((c) => c.url === clean)) return { error: 'That list is already added.' };
    if (customLists.length >= CUSTOM_CAP) return { error: `You can add up to ${CUSTOM_CAP} custom lists.` };
    const id = customId(clean);
    customLists.push({ id, url: clean });
    enabledOverride.set(id, true);
    dirtyProfile = true;
    scheduleSave();
    rebuild('add-list');
    return listView(findEntry(id));
  });

  ipc.handle('lists:remove', (event, id) => {
    if (!security.isInternalSender(event)) forbidden();
    if (typeof id !== 'string' || !id.startsWith('custom-')) return { error: 'Only custom lists can be removed.' };
    const at = customLists.findIndex((c) => c.id === id);
    if (at < 0) return { error: 'unknown list' };
    customLists.splice(at, 1);
    enabledOverride.delete(id);
    index.delete(id);
    dirtyProfile = true;
    dirtyIndex = true;
    scheduleSave();
    fs.promises.rm(path.join(listsDir, `${id}.txt`), { force: true }).catch(() => {});
    rebuild('remove-list');
    return { ok: true };
  });

  // Re-downloads every enabled list now and rebuilds. Resolves when the build has finished.
  ipc.handle('lists:update-now', async (event) => {
    if (!security.isInternalSender(event)) forbidden();
    const r = await require('./blocking').buildNow('manual', { force: true });
    return { ok: r.ok === true, errors: Array.isArray(r.errors) ? r.errors : [] };
  });
}

module.exports = {
  BUILTIN,
  RESOURCES_URL,
  init,
  flush,
  registerIpc,
  getUserListText,
  state,
  prepare,
  recordBuild,
  nextDueMs,
  setBuilding,
  noteCachedEngine,
  setAnnoyanceAuto,
  rebuild,
  writeAtomic,
  parseExpires,
};
