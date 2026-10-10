'use strict';
// main/storage.js — profile JSON stores (settings, bookmarks, history, site permissions,
// session) and their IPC handlers. Owner: H4.
//
// Files live in userData/profile/. Every store is loaded once at init(); writes are
// debounced (DEBOUNCE_MS), atomic (tmp file + rename) and serialized per file.

const fs = require('fs');
const path = require('path');
const { session, webContents } = require('electron');
const { log } = require('./logger');
const { isChromeSender, isInternalSender, parseUrl } = require('./security');

const PARTITION = 'persist:pure';
const DEBOUNCE_MS = 1500;
const MAX_BOOKMARKS = 2000;
const MAX_HISTORY = 10000;
const MAX_IMPORT_ROWS = 20000; // per importMany() call (main/importer.js)
const HISTORY_MERGE_MS = 30 * 60 * 1000;
const MAX_URL = 2048;
const MAX_TITLE = 300;
const MAX_QUERY = 200;
const MAX_IPC_KEYS = 64;
const MAX_QUICK_LINKS = 24;
const MAX_SESSION_WINDOWS = 50;
const MAX_SESSION_TABS = 200;
const TAB_DISCARD_VALUES = [0, 5, 10, 30, 60];
const DAY_MS = 24 * 60 * 60 * 1000;

const SETTINGS_DEFAULTS = {
  homepage: 'pure://home/',
  searchEngine: 'https://duckduckgo.com/?q=',
  searchSuggestions: true,
  accentColor: '#4f8ef7',
  theme: 'dark',
  showWelcomeAnimation: true,
  showBookmarksBar: false,
  showStatusBar: true,
  homepageLatitude: '40.7128',
  homepageLongitude: '-74.0060',
  homepageTempUnit: 'celsius',
  homepageTimeFormat: '24h',
  quickLinks: [],
  restoreSession: false,
  tabDiscardMinutes: 10,
  spellcheck: true,
  askWhereToSave: false,
  downloadDir: '',
  // 2.1 — home widget board
  homeWidgets: [
    { id: 'news', visible: true },
    { id: 'weather', visible: true },
    { id: 'reading', visible: true },
    { id: 'notes', visible: true },
  ],
  newsTopics: ['top', 'tech'],
  newsSources: [],          // ids of DISABLED sources (registry lives in main/homepage.js); [] = all on
  newsImages: true,
  showHomeStats: true,
  // 2.1 — blocking & performance
  blockingEnabled: true,
  liteMode: false,
  smartSleep: true,
  // 2.2 — accounts, privacy, updates, layout
  savePasswords: true,          // offer to save passwords + autofill
  autoUpdate: true,             // check GitHub Releases in the background (main/updater.js)
  dohMode: 'automatic',         // off | automatic | secure  (secure DNS / DNS-over-HTTPS)
  dohProvider: 'cloudflare',    // cloudflare | google | quad9 | nextdns | custom
  dohCustomUrl: '',             // https template when dohProvider = custom
  blockCookieBanners: true,
  blockingLevel: 'strict',    // strict = full (network + element hiding + in-page scriptlets, like uBO) | balanced (no scriptlets; fallback)
  forceDarkWeb: false,          // Chromium WebContentsForceDark — applied at startup (restart required)
  verticalTabs: false,
  focusMode: false,
  readerFont: 'serif',          // serif | sans
  readerSize: 19,               // px, 14–28
};

const WIDGET_IDS = ['news', 'weather', 'reading', 'notes'];
const NEWS_TOPICS = ['top', 'tech', 'world', 'science', 'business', 'sports', 'entertainment', 'health'];

// 1.1.1 shipped with these quick links; a fresh profile (no settings.json yet) gets them
// so the new-tab page looks the same as before. Once settings are saved, [] is respected.
const FRESH_QUICK_LINKS = [
  { title: 'GitHub', url: 'https://github.com' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com' },
  { title: 'Reddit', url: 'https://reddit.com' },
  { title: 'YouTube', url: 'https://youtube.com' },
];

const INVALID = Symbol('invalid');
const VALID_DECISIONS = new Set(['allow', 'deny']);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns the normalized href for http(s) URLs of reasonable length, otherwise null.
function httpUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return null;
  const u = parseUrl(raw);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
}

// URLs the session may restore: http(s) or the internal home/settings pages.
function restorableUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return null;
  if (/^pure:\/\/(home|settings)\//.test(raw)) return raw;
  return httpUrl(raw);
}

function cleanTitle(v, max = MAX_TITLE) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function normalizeQuery(text) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, MAX_QUERY).toLowerCase();
}

// host of an already-normalized http(s) url, without "www."
function hostOf(url) {
  const m = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

// ── Debounced, atomic JSON file ───────────────────────────────────────────────
class JsonFile {
  constructor(name, serialize) {
    this.name = name;
    this.file = null;
    this.serialize = serialize;
    this.dirty = false;
    this.timer = null;
    this.queue = Promise.resolve();
  }

  attach(dir) {
    this.file = path.join(dir, this.name);
  }

  // -> { missing, data }. A corrupt file is renamed to .bak and treated as missing data.
  async read() {
    let text;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true, data: undefined };
      log(`storage: cannot read ${this.name}: ${err.message}`);
      return { missing: false, data: undefined };
    }
    try {
      return { missing: false, data: JSON.parse(text) };
    } catch (err) {
      log(`storage: ${this.name} is corrupt (${err.message}); moved to .bak`);
      await fs.promises.rename(this.file, `${this.file}.bak`).catch(() => {});
      return { missing: false, data: undefined };
    }
  }

  markDirty() {
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.save();
      }, DEBOUNCE_MS);
    }
  }

  // Queued so two writes of the same file never overlap. Never rejects.
  save() {
    this.queue = this.queue.then(() => this.write());
    return this.queue;
  }

  async write() {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    let text;
    try {
      text = JSON.stringify(this.serialize());
    } catch (err) {
      log(`storage: cannot serialize ${this.name}: ${err.message}`);
      return;
    }
    const tmp = `${this.file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, text, 'utf8');
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      // Keep dirty: the next change schedules another attempt.
      this.dirty = true;
      log(`storage: cannot write ${this.name}: ${err.message}`);
    }
  }
}

const settingsFile = new JsonFile('settings.json', () => settingsState);
const bookmarksFile = new JsonFile('bookmarks.json', () => bookmarkList);
const historyFile = new JsonFile('history.json', () => historyEntries);
const permissionsFile = new JsonFile('permissions.json', () => permState);
const sessionFile = new JsonFile('session.json', () => sessionState);
const ALL_FILES = [settingsFile, bookmarksFile, historyFile, permissionsFile, sessionFile];

// ── Settings ──────────────────────────────────────────────────────────────────
const coord = (limit, fallback) => (v) => {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return INVALID;
  const t = v.trim();
  if (t === '') return fallback;
  if (!/^-?\d{1,3}(\.\d{1,6})?$/.test(t)) return INVALID;
  return Math.abs(Number(t)) <= limit ? t : INVALID;
};

const oneOf = (list) => (v) => (list.includes(v) ? v : INVALID);
const boolOnly = (v) => (typeof v === 'boolean' ? v : INVALID);

function sanitizeQuickLinks(v) {
  if (!Array.isArray(v)) return INVALID;
  const out = [];
  for (const item of v) {
    if (out.length >= MAX_QUICK_LINKS) break;
    if (!isPlainObject(item)) continue;
    const title = cleanTitle(item.title, 60);
    const url = httpUrl(item.url);
    if (!title || !url) continue;
    out.push({ title, url });
  }
  return out;
}

const VALIDATORS = {
  homepage(v) {
    if (typeof v !== 'string') return INVALID;
    const t = v.trim();
    if (t === '' || t === 'pure://home/') return 'pure://home/';
    return httpUrl(t) ? t : INVALID;
  },
  searchEngine(v) {
    if (typeof v !== 'string') return INVALID;
    const t = v.trim();
    return t.length <= 300 && t.startsWith('https://') && httpUrl(t) ? t : INVALID;
  },
  searchSuggestions: boolOnly,
  accentColor(v) {
    return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : INVALID;
  },
  theme: oneOf(['dark', 'light', 'system']),
  showWelcomeAnimation: boolOnly,
  showBookmarksBar: boolOnly,
  showStatusBar: boolOnly,
  homepageLatitude: coord(90, SETTINGS_DEFAULTS.homepageLatitude),
  homepageLongitude: coord(180, SETTINGS_DEFAULTS.homepageLongitude),
  homepageTempUnit: oneOf(['celsius', 'fahrenheit']),
  homepageTimeFormat: oneOf(['24h', '12h']),
  quickLinks: sanitizeQuickLinks,
  restoreSession: boolOnly,
  tabDiscardMinutes(v) {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    return TAB_DISCARD_VALUES.includes(n) ? n : INVALID;
  },
  spellcheck: boolOnly,
  askWhereToSave: boolOnly,
  downloadDir(v) {
    if (typeof v !== 'string') return INVALID;
    const t = v.trim();
    if (t === '') return '';
    return t.length <= 500 && path.isAbsolute(t) ? t : INVALID;
  },
  homeWidgets(v) {
    if (!Array.isArray(v)) return INVALID;
    const seen = new Set();
    const out = [];
    for (const w of v) {
      if (!isPlainObject(w) || !WIDGET_IDS.includes(w.id) || seen.has(w.id)) continue;
      seen.add(w.id);
      out.push({ id: w.id, visible: w.visible !== false });
    }
    // Widgets missing from the stored order are appended (keeps future widgets visible).
    for (const id of WIDGET_IDS) if (!seen.has(id)) out.push({ id, visible: true });
    return out;
  },
  newsTopics(v) {
    if (!Array.isArray(v)) return INVALID;
    const out = [...new Set(v.filter((t) => NEWS_TOPICS.includes(t)))];
    return out.length ? out : INVALID;
  },
  newsSources(v) {
    if (!Array.isArray(v)) return INVALID;
    return [...new Set(v.filter((id) => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)))].slice(0, 100);
  },
  newsImages: boolOnly,
  showHomeStats: boolOnly,
  blockingEnabled: boolOnly,
  liteMode: boolOnly,
  smartSleep: boolOnly,
  savePasswords: boolOnly,
  autoUpdate: boolOnly,
  dohMode: oneOf(['off', 'automatic', 'secure']),
  dohProvider: oneOf(['cloudflare', 'google', 'quad9', 'nextdns', 'custom']),
  dohCustomUrl(v) {
    if (typeof v !== 'string') return INVALID;
    const t = v.trim();
    if (t === '') return '';
    return t.length <= 300 && t.startsWith('https://') && httpUrl(t) ? t : INVALID;
  },
  blockCookieBanners: boolOnly,
  blockingLevel: oneOf(['balanced', 'strict']),
  forceDarkWeb: boolOnly,
  verticalTabs: boolOnly,
  focusMode: boolOnly,
  readerFont: oneOf(['serif', 'sans']),
  readerSize(v) {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= 14 && n <= 28 ? n : INVALID;
  },
};

let settingsState = clone(SETTINGS_DEFAULTS);
const settingsListeners = new Set();

function sanitizeSettings(raw, fresh) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    const def = SETTINGS_DEFAULTS[key];
    if (!hasOwn(src, key)) {
      out[key] = clone(def);
      continue;
    }
    const v = VALIDATORS[key](src[key]);
    out[key] = v === INVALID ? clone(def) : v;
  }
  if (fresh) out.quickLinks = sanitizeQuickLinks(FRESH_QUICK_LINKS);
  return out;
}

function settingsSnapshot() {
  return { ...settingsState, quickLinks: settingsState.quickLinks.map((l) => ({ ...l })) };
}

// Applies valid keys of `patch`; returns the list of keys that actually changed.
function applySettingsPatch(patch) {
  const changed = [];
  if (!isPlainObject(patch)) return changed;
  for (const key of Object.keys(patch)) {
    if (!hasOwn(VALIDATORS, key)) continue;
    const v = VALIDATORS[key](patch[key]);
    if (v === INVALID || sameValue(settingsState[key], v)) continue;
    settingsState[key] = v;
    changed.push(key);
  }
  return changed;
}

function applySpellcheck(enabled) {
  const sessions = [session.defaultSession, session.fromPartition(PARTITION)];
  for (const s of sessions) {
    try {
      s.setSpellCheckerEnabled(!!enabled);
    } catch (err) {
      log(`storage: setSpellCheckerEnabled failed: ${err.message}`);
    }
  }
}

function broadcast(channel, payload) {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.isDestroyed() || !wc.getURL().startsWith('pure://')) continue;
      wc.send(channel, payload);
    } catch {
      // destroyed between the check and the send
    }
  }
}

function commitSettings(changed) {
  if (!changed.length) return;
  settingsFile.markDirty();
  if (changed.includes('spellcheck')) applySpellcheck(settingsState.spellcheck);
  const snap = settingsSnapshot();
  for (const fn of settingsListeners) {
    try {
      fn(snap);
    } catch (err) {
      log(`storage: settings listener failed: ${err.message}`);
    }
  }
  broadcast('settings:changed', snap);
}

const settings = {
  get: () => settingsSnapshot(),
  set(patch) {
    commitSettings(applySettingsPatch(patch));
    return settingsSnapshot();
  },
  // keys: string[] of settings keys, or omitted/null for all.
  reset(keys) {
    const list = Array.isArray(keys)
      ? keys.filter((k) => typeof k === 'string' && hasOwn(SETTINGS_DEFAULTS, k))
      : Object.keys(SETTINGS_DEFAULTS);
    const patch = {};
    for (const k of list) patch[k] = clone(SETTINGS_DEFAULTS[k]);
    commitSettings(applySettingsPatch(patch));
    return settingsSnapshot();
  },
  onChange(fn) {
    settingsListeners.add(fn);
    return () => settingsListeners.delete(fn);
  },
};

// ── Bookmarks ─────────────────────────────────────────────────────────────────
function sanitizeFavicon(v) {
  if (typeof v !== 'string' || v.length > 8192) return '';
  if (httpUrl(v)) return v;
  return /^data:image\//i.test(v) ? v : '';
}

let bookmarkList = []; // ascending createdAt
let bookmarkUrls = new Set();

function setBookmarks(list) {
  bookmarkList = list;
  bookmarkUrls = new Set(list.map((b) => b.url));
}

function bookmarksChanged() {
  bookmarkUrls = new Set(bookmarkList.map((b) => b.url));
  bookmarksFile.markDirty();
  broadcast('bookmarks:changed', bookmarks.list());
}

function removeBookmark(url) {
  const idx = bookmarkList.findIndex((b) => b.url === url);
  if (idx < 0) return false;
  bookmarkList.splice(idx, 1);
  bookmarkUrls.delete(url);
  bookmarksChanged();
  return true;
}

function loadBookmarks(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isPlainObject(item)) continue;
    const url = httpUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      title: cleanTitle(item.title) || url,
      favicon: sanitizeFavicon(item.favicon),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    });
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out.length > MAX_BOOKMARKS ? out.slice(out.length - MAX_BOOKMARKS) : out;
}

const bookmarks = {
  list: () => bookmarkList.map((b) => ({ ...b })),
  has(url) {
    const u = httpUrl(url);
    return !!u && bookmarkUrls.has(u);
  },
  // Toggles the bookmark for bm.url. Returns true when the page is now bookmarked.
  toggle(bm) {
    if (!isPlainObject(bm)) return false;
    const url = httpUrl(bm.url);
    if (!url) return false;
    if (bookmarkUrls.has(url)) {
      removeBookmark(url);
      return false;
    }
    if (bookmarkList.length >= MAX_BOOKMARKS) {
      log('storage: bookmark limit reached');
      return false;
    }
    bookmarkList.push({
      url,
      title: cleanTitle(bm.title) || url,
      favicon: sanitizeFavicon(bm.favicon),
      createdAt: Date.now(),
    });
    bookmarksChanged();
    return true;
  },
  remove(url) {
    const u = httpUrl(url);
    return u ? removeBookmark(u) : false;
  },
  // Bulk import (main/importer.js). Dedupes by url against the existing list and within the batch,
  // respects MAX_BOOKMARKS, keeps the list sorted by createdAt and broadcasts once. -> number added.
  importMany(items) {
    if (!Array.isArray(items)) return 0;
    const now = Date.now();
    const seen = new Set(bookmarkUrls);
    const fresh = [];
    for (const item of items.slice(0, MAX_IMPORT_ROWS)) {
      if (bookmarkList.length + fresh.length >= MAX_BOOKMARKS) break;
      if (!isPlainObject(item)) continue;
      const url = httpUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      fresh.push({
        url,
        title: cleanTitle(item.title) || url,
        favicon: '',
        createdAt: Number.isFinite(item.createdAt) && item.createdAt > 0 ? Math.min(item.createdAt, now) : now,
      });
    }
    if (!fresh.length) return 0;
    for (const b of fresh) bookmarkList.push(b);
    bookmarkList.sort((a, b) => a.createdAt - b.createdAt);
    bookmarksChanged();
    return fresh.length;
  },
  // Address-bar suggestions: title-prefix > host-prefix > substring, newest first on ties.
  search(text, limit = 4) {
    const q = normalizeQuery(text);
    if (!q) return [];
    const hits = [];
    for (const b of bookmarkList) {
      const title = b.title.toLowerCase();
      let score;
      if (title.startsWith(q)) score = 3;
      else if (hostOf(b.url).startsWith(q)) score = 2;
      else if (title.includes(q) || b.url.toLowerCase().includes(q)) score = 1;
      else continue;
      hits.push({ b, score });
    }
    hits.sort((x, y) => y.score - x.score || y.b.createdAt - x.b.createdAt);
    return hits.slice(0, limit).map(({ b }) => ({ url: b.url, title: b.title }));
  },
};

// ── History ───────────────────────────────────────────────────────────────────
// historyEntries is kept in ascending visitedAt order: new and merged visits are always
// the newest, so they go to the end and nothing is ever re-sorted on add.
let historyEntries = [];
const historyLatest = new Map(); // url -> most recent entry for that url
let historyNextId = 1;

function loadHistory(raw) {
  const rows = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isPlainObject(item)) continue;
    const url = httpUrl(item.url);
    if (!url || !Number.isFinite(item.visitedAt) || item.visitedAt <= 0) continue;
    rows.push({
      rawId: Number.isInteger(item.id) && item.id > 0 ? item.id : 0,
      url,
      title: cleanTitle(item.title) || url,
      visitedAt: item.visitedAt,
      visitCount: Number.isInteger(item.visitCount) && item.visitCount > 0 ? Math.min(item.visitCount, 1e6) : 1,
    });
  }
  rows.sort((a, b) => a.visitedAt - b.visitedAt);
  const kept = rows.length > MAX_HISTORY ? rows.slice(rows.length - MAX_HISTORY) : rows;

  let next = 1;
  for (const e of kept) if (e.rawId >= next) next = e.rawId + 1;
  const seen = new Set();
  for (const e of kept) {
    if (e.rawId > 0 && !seen.has(e.rawId)) {
      e.id = e.rawId;
      seen.add(e.rawId);
    } else {
      e.id = next++;
    }
    delete e.rawId;
  }
  historyNextId = next;
  return kept;
}

function moveToEnd(entry) {
  const last = historyEntries.length - 1;
  for (let i = last; i >= 0; i--) {
    if (historyEntries[i] === entry) {
      if (i !== last) {
        historyEntries.splice(i, 1);
        historyEntries.push(entry);
      }
      return;
    }
  }
}

function evictOldest(count) {
  for (const e of historyEntries.splice(0, count)) {
    if (historyLatest.get(e.url) === e) historyLatest.delete(e.url);
  }
}

const historyView = (e) => ({ id: e.id, url: e.url, title: e.title, visitedAt: e.visitedAt });

const history = {
  // Records a visit. Same url within HISTORY_MERGE_MS merges into the existing entry.
  add(input) {
    if (!isPlainObject(input)) return null;
    const url = httpUrl(input.url);
    if (!url) return null;
    const title = cleanTitle(input.title);
    const now = Date.now();
    const existing = historyLatest.get(url);
    if (existing && now - existing.visitedAt < HISTORY_MERGE_MS) {
      existing.visitCount = Math.min(existing.visitCount + 1, 1e6);
      existing.visitedAt = now;
      if (title) existing.title = title;
      moveToEnd(existing);
      historyFile.markDirty();
      return historyView(existing);
    }
    const entry = { id: historyNextId++, url, title: title || url, visitedAt: now, visitCount: 1 };
    historyEntries.push(entry);
    historyLatest.set(url, entry);
    if (historyEntries.length > MAX_HISTORY) evictOldest(historyEntries.length - MAX_HISTORY);
    historyFile.markDirty();
    return historyView(entry);
  },
  updateTitle(rawUrl, title) {
    const url = httpUrl(rawUrl);
    const t = cleanTitle(title);
    const entry = url ? historyLatest.get(url) : null;
    if (!entry || !t || entry.title === t) return false;
    entry.title = t;
    historyFile.markDirty();
    return true;
  },
  remove(id) {
    if (!Number.isInteger(id)) return false;
    for (let i = historyEntries.length - 1; i >= 0; i--) {
      const e = historyEntries[i];
      if (e.id !== id) continue;
      historyEntries.splice(i, 1);
      if (historyLatest.get(e.url) === e) {
        historyLatest.delete(e.url);
        for (let j = historyEntries.length - 1; j >= 0; j--) {
          if (historyEntries[j].url === e.url) {
            historyLatest.set(e.url, historyEntries[j]);
            break;
          }
        }
      }
      historyFile.markDirty();
      return true;
    }
    return false;
  },
  clear() {
    historyEntries = [];
    historyLatest.clear();
    historyFile.markDirty();
    return true;
  },
  // Bulk import (main/importer.js). One entry per url: a url already in history is only bumped when the
  // imported visit is newer; new urls are appended, the list is re-sorted once, MAX_HISTORY drops the
  // oldest visits, and the file is marked dirty once. -> number of new entries kept.
  importMany(items) {
    if (!Array.isArray(items)) return 0;
    const now = Date.now();
    const best = new Map(); // url -> { url, title, visitedAt, visitCount } (newest visit per url)
    for (const item of items.slice(0, MAX_IMPORT_ROWS)) {
      if (!isPlainObject(item)) continue;
      const url = httpUrl(item.url);
      if (!url || !Number.isFinite(item.visitedAt) || item.visitedAt <= 0) continue;
      const visitedAt = Math.min(item.visitedAt, now);
      const visitCount = Number.isInteger(item.visitCount) && item.visitCount > 0 ? Math.min(item.visitCount, 1e6) : 1;
      const title = cleanTitle(item.title);
      const prev = best.get(url);
      if (!prev) {
        best.set(url, { url, title, visitedAt, visitCount });
      } else {
        prev.visitCount = Math.max(prev.visitCount, visitCount);
        if (visitedAt > prev.visitedAt) {
          prev.visitedAt = visitedAt;
          prev.title = title || prev.title;
        }
      }
    }

    const pending = [];
    let bumped = false;
    for (const c of best.values()) {
      const latest = historyLatest.get(c.url);
      if (latest) {
        if (c.visitedAt > latest.visitedAt) {
          latest.visitedAt = c.visitedAt;
          if (c.title) latest.title = c.title;
          bumped = true;
        }
        continue;
      }
      pending.push({
        id: historyNextId++,
        url: c.url,
        title: c.title || c.url,
        visitedAt: c.visitedAt,
        visitCount: c.visitCount,
      });
    }
    if (!pending.length && !bumped) return 0;

    for (const e of pending) {
      historyEntries.push(e);
      historyLatest.set(e.url, e);
    }
    historyEntries.sort((a, b) => a.visitedAt - b.visitedAt);

    let added = pending.length;
    if (historyEntries.length > MAX_HISTORY) {
      const kept = new Set(pending);
      evictOldest(historyEntries.length - MAX_HISTORY);
      added = 0;
      for (const e of historyEntries) if (kept.has(e)) added++;
    }
    historyFile.markDirty();
    return added;
  },
  // Newest first. -> { items, total }
  list(opts) {
    const o = isPlainObject(opts) ? opts : {};
    const q = normalizeQuery(o.query);
    const offset = Number.isInteger(o.offset) ? Math.min(Math.max(o.offset, 0), 1e7) : 0;
    const limit = Number.isInteger(o.limit) ? Math.min(Math.max(o.limit, 1), 500) : 100;
    const items = [];
    let total = 0;
    for (let i = historyEntries.length - 1; i >= 0; i--) {
      const e = historyEntries[i];
      if (q && !e.url.toLowerCase().includes(q) && !e.title.toLowerCase().includes(q)) continue;
      if (total >= offset && items.length < limit) items.push(historyView(e));
      total++;
    }
    return { items, total };
  },
  // Address-bar suggestions. Visits to the same url are aggregated; a host prefix match
  // outranks a substring match; the result is weighted by visit count and recency.
  search(text, limit = 4) {
    const q = normalizeQuery(text);
    if (!q) return [];
    const now = Date.now();
    const agg = new Map();
    for (let i = historyEntries.length - 1; i >= 0; i--) {
      const e = historyEntries[i];
      let tier;
      if (hostOf(e.url).startsWith(q)) tier = 3;
      else if (e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)) tier = 1;
      else continue;
      let a = agg.get(e.url);
      if (!a) {
        // reverse order: the first entry seen for a url is its newest visit
        a = { entry: e, tier, visits: 0 };
        agg.set(e.url, a);
      }
      a.visits += e.visitCount;
    }
    const scored = [];
    for (const a of agg.values()) {
      const ageDays = Math.max(0, (now - a.entry.visitedAt) / DAY_MS);
      const recency = 1 / (1 + ageDays / 7);
      scored.push({ a, score: a.tier * (1 + Math.log2(1 + a.visits)) * recency });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, limit).map(({ a }) => ({
      id: a.entry.id,
      url: a.entry.url,
      title: a.entry.title,
      visitedAt: a.entry.visitedAt,
    }));
  },
};

// ── Site permissions ──────────────────────────────────────────────────────────
// { [origin]: { [permission]: 'allow' | 'deny' } }, null-prototype objects throughout.
let permState = Object.create(null);

const originOf = (raw) => {
  const u = typeof raw === 'string' && raw.length <= MAX_URL ? parseUrl(raw) : null;
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null;
};
const validPermission = (p) => typeof p === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(p);

function loadPermissions(raw) {
  const out = Object.create(null);
  if (!isPlainObject(raw)) return out;
  for (const rawOrigin of Object.keys(raw)) {
    const origin = originOf(rawOrigin);
    const perms = raw[rawOrigin];
    if (!origin || !isPlainObject(perms)) continue;
    for (const perm of Object.keys(perms)) {
      if (!validPermission(perm) || !VALID_DECISIONS.has(perms[perm])) continue;
      if (!out[origin]) out[origin] = Object.create(null);
      out[origin][perm] = perms[perm];
    }
  }
  return out;
}

const sitePermissions = {
  get(origin, permission) {
    const o = originOf(origin);
    if (!o || !permState[o] || !validPermission(permission)) return undefined;
    return permState[o][permission];
  },
  set(origin, permission, decision) {
    const o = originOf(origin);
    if (!o || !validPermission(permission) || !VALID_DECISIONS.has(decision)) return false;
    if (!permState[o]) permState[o] = Object.create(null);
    if (permState[o][permission] === decision) return true;
    permState[o][permission] = decision;
    permissionsFile.markDirty();
    return true;
  },
  // -> [{origin, permission, decision}]
  list() {
    const rows = [];
    for (const origin of Object.keys(permState)) {
      for (const permission of Object.keys(permState[origin])) {
        rows.push({ origin, permission, decision: permState[origin][permission] });
      }
    }
    rows.sort((a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission));
    return rows;
  },
  // permission omitted = forget every permission of that origin.
  reset(origin, permission) {
    const o = originOf(origin);
    if (!o || !permState[o]) return false;
    if (permission === undefined) {
      delete permState[o];
    } else {
      if (!validPermission(permission) || !hasOwn(permState[o], permission)) return false;
      delete permState[o][permission];
      if (!Object.keys(permState[o]).length) delete permState[o];
    }
    permissionsFile.markDirty();
    return true;
  },
};

// ── Session (open tabs for restore) ───────────────────────────────────────────
// [{ tabs: [{url, title}], activeIndex }]  or null when nothing was saved.
let sessionState = null;

function sanitizeWindows(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const w of v.slice(0, MAX_SESSION_WINDOWS)) {
    if (!isPlainObject(w) || !Array.isArray(w.tabs)) continue;
    // 2.2: tab groups ({title,color,collapsed}) referenced by per-tab `group` index.
    const groups = Array.isArray(w.groups)
      ? w.groups.slice(0, MAX_SESSION_TABS).map((g) => ({
          title: isPlainObject(g) ? cleanTitle(g.title, 60) : '',
          color: isPlainObject(g) && GROUP_COLORS.includes(g.color) ? g.color : 'grey',
          collapsed: isPlainObject(g) && g.collapsed === true,
        }))
      : [];
    const tabs = [];
    const indexMap = new Map(); // original tab index -> kept index (unrestorable tabs are dropped)
    w.tabs.forEach((t, i) => {
      if (tabs.length >= MAX_SESSION_TABS || !isPlainObject(t)) return;
      const url = restorableUrl(t.url);
      if (!url) return;
      const tab = { url, title: cleanTitle(t.title) };
      if (Number.isInteger(t.group) && t.group >= 0 && t.group < groups.length) tab.group = t.group;
      indexMap.set(i, tabs.length);
      tabs.push(tab);
    });
    if (!tabs.length) continue;
    const idx = Number.isInteger(w.activeIndex) ? (indexMap.get(w.activeIndex) ?? 0) : 0;
    const win = { tabs, activeIndex: Math.min(Math.max(idx, 0), tabs.length - 1) };
    if (groups.length) win.groups = groups;
    // 2.2: split view {left, right, ratio} as tab indexes; dropped if either pane didn't survive.
    const sp = w.split;
    if (isPlainObject(sp) && indexMap.has(sp.left) && indexMap.has(sp.right) && sp.left !== sp.right) {
      const ratio = typeof sp.ratio === 'number' && sp.ratio >= 0.2 && sp.ratio <= 0.8 ? sp.ratio : 0.5;
      win.split = { left: indexMap.get(sp.left), right: indexMap.get(sp.right), ratio };
    }
    out.push(win);
  }
  return out;
}

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const sessionStore = {
  save(windowsState) {
    const next = sanitizeWindows(windowsState);
    if (!next || sameValue(next, sessionState)) return !!next;
    sessionState = next;
    sessionFile.markDirty();
    return true;
  },
  load() {
    return sessionState ? clone(sessionState) : null;
  },
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────
async function init(userDataDir) {
  const dir = path.join(userDataDir, 'profile');
  await fs.promises.mkdir(dir, { recursive: true });
  for (const f of ALL_FILES) f.attach(dir);

  const [s, b, h, p, ses] = await Promise.all([
    settingsFile.read(),
    bookmarksFile.read(),
    historyFile.read(),
    permissionsFile.read(),
    sessionFile.read(),
  ]);

  settingsState = sanitizeSettings(s.data, s.missing);
  setBookmarks(loadBookmarks(b.data));
  historyEntries = loadHistory(h.data);
  historyLatest.clear();
  for (const e of historyEntries) historyLatest.set(e.url, e);
  permState = loadPermissions(p.data);
  sessionState = sanitizeWindows(ses.data);

  if (!settingsState.spellcheck) applySpellcheck(false);
}

// Writes everything that is dirty now. Called on before-quit.
function flush() {
  for (const f of ALL_FILES) {
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = null;
    }
  }
  return Promise.all(ALL_FILES.map((f) => f.save())).then(() => undefined);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
const isBrowserOrInternal = (event) => isChromeSender(event) || isInternalSender(event);

function forbidden() {
  throw new Error('forbidden sender');
}

function registerIpc(ipcMain) {
  ipcMain.handle('settings:get', (event) => {
    if (!isBrowserOrInternal(event)) forbidden();
    return settingsSnapshot();
  });

  ipcMain.handle('settings:set', (event, patch) => {
    if (!isBrowserOrInternal(event)) forbidden();
    if (!isPlainObject(patch) || Object.keys(patch).length > MAX_IPC_KEYS) return settingsSnapshot();
    return settings.set(patch);
  });

  ipcMain.handle('settings:reset', (event, keys) => {
    if (!isBrowserOrInternal(event)) forbidden();
    if (keys !== undefined && keys !== null) {
      if (!Array.isArray(keys) || keys.length > MAX_IPC_KEYS || !keys.every((k) => typeof k === 'string')) {
        return settingsSnapshot();
      }
    }
    return settings.reset(keys == null ? undefined : keys);
  });

  ipcMain.handle('bookmarks:list', (event) => {
    if (!isBrowserOrInternal(event)) forbidden();
    return bookmarks.list();
  });

  ipcMain.handle('bookmarks:toggle', (event, bm) => {
    if (!isChromeSender(event)) forbidden();
    return bookmarks.toggle(bm);
  });

  ipcMain.handle('bookmarks:remove', (event, url) => {
    if (!isBrowserOrInternal(event)) forbidden();
    return typeof url === 'string' ? bookmarks.remove(url) : false;
  });

  ipcMain.handle('history:list', (event, opts) => {
    if (!isInternalSender(event)) forbidden();
    return history.list(opts);
  });

  ipcMain.handle('history:remove', (event, id) => {
    if (!isInternalSender(event)) forbidden();
    return history.remove(id);
  });

  ipcMain.handle('history:clear', (event) => {
    if (!isInternalSender(event)) forbidden();
    return history.clear();
  });
}

module.exports = {
  init,
  flush,
  registerIpc,
  settings,
  bookmarks,
  history,
  sitePermissions,
  session: sessionStore,
};
