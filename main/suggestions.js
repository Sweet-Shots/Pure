'use strict';
// main/suggestions.js — address-bar suggestions (suggest:query). Owner: H4.
// Local matches (bookmarks, history) come first, remote search suggestions fill the rest.
// Remote requests go through the profile session, are skipped in incognito windows,
// time out after REMOTE_TIMEOUT_MS, and are cancelled when the same sender asks again.

const { session, BrowserWindow } = require('electron');
const { log } = require('./logger');
const { isChromeSender } = require('./security');
const storage = require('./storage');

const PARTITION = 'persist:pure';
const MAX_TOTAL = 8;
const MAX_LOCAL = 4;
const MAX_INPUT = 200;
const MAX_REMOTE_INPUT = 100;
const REMOTE_TIMEOUT_MS = 1500;
const MAX_RESPONSE_CHARS = 64 * 1024;
const CACHE_SIZE = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Suggestion endpoints keyed by the host of the configured search engine.
const ENGINES = [
  { test: /(^|\.)duckduckgo\.com$/, endpoint: (q) => `https://duckduckgo.com/ac/?q=${q}&type=list` },
  { test: /(^|\.)google\.[a-z.]+$/, endpoint: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}` },
  { test: /(^|\.)bing\.com$/, endpoint: (q) => `https://api.bing.com/osjson.aspx?query=${q}` },
  { test: /^search\.brave\.com$/, endpoint: (q) => `https://search.brave.com/api/suggest?q=${q}` },
];

// Tiny LRU: Map keeps insertion order, a hit re-inserts the key at the end.
const cache = new Map();
// webContents id -> AbortController of its latest query
const inflight = new Map();
const watched = new WeakSet();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.list;
}

function cacheSet(key, list) {
  cache.delete(key);
  cache.set(key, { t: Date.now(), list });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
}

// Things that are clearly addresses should not be sent to a search suggestion service.
function looksLikeUrl(text) {
  if (/\s/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  if (/^localhost(:\d+)?([/?#]|$)/i.test(text)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(text)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(text);
}

function endpointFor(engineUrl, text) {
  let host;
  try {
    host = new URL(engineUrl).hostname;
  } catch {
    return null;
  }
  const engine = ENGINES.find((e) => e.test.test(host));
  return engine ? engine.endpoint(encodeURIComponent(text)) : null;
}

function localMatches(text) {
  const out = [];
  const seen = new Set();
  const add = (type, item) => {
    if (out.length >= MAX_LOCAL || seen.has(item.url)) return;
    seen.add(item.url);
    out.push({ type, url: item.url, title: item.title, text: item.title || item.url });
  };
  for (const b of storage.bookmarks.search(text, MAX_LOCAL)) add('bookmark', b);
  for (const h of storage.history.search(text, MAX_LOCAL)) add('history', h);
  return out;
}

function remoteAllowed(event, text) {
  if (text.length > MAX_REMOTE_INPUT || looksLikeUrl(text)) return false;
  const settings = storage.settings.get();
  if (!settings.searchSuggestions || !endpointFor(settings.searchEngine, text)) return false;
  // Incognito windows never send what the user types to a suggestion service.
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const incognito = require('./windows').isIncognitoWindow(win);
    return !!win && !incognito;
  } catch {
    return false;
  }
}

async function fetchSuggestions(endpoint, query, signal) {
  const res = await session.fromPartition(PARTITION).fetch(endpoint, { signal, credentials: 'omit' });
  if (!res.ok) return null;
  const body = await res.text();
  if (body.length > MAX_RESPONSE_CHARS) return null;
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || !Array.isArray(data[1])) return null;

  const q = query.toLowerCase();
  const out = [];
  const seen = new Set();
  for (const item of data[1]) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    const key = s.toLowerCase();
    if (!s || s.length > 200 || key === q || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_TOTAL) break;
  }
  return out;
}

async function remoteMatches(text, limit, controller) {
  const engineUrl = storage.settings.get().searchEngine;
  const endpoint = endpointFor(engineUrl, text);
  if (!endpoint) return [];

  const key = `${new URL(endpoint).hostname}|${text.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached.slice(0, limit);

  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const list = await fetchSuggestions(endpoint, text, controller.signal);
    if (!list) return [];
    if (!controller.signal.aborted) cacheSet(key, list);
    return list.slice(0, limit);
  } catch {
    // timeout, superseded by a newer query, offline: local results only
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Drop a sender's in-flight remote request when that window goes away.
function watchSender(wc) {
  if (watched.has(wc)) return;
  watched.add(wc);
  const id = wc.id;
  wc.once('destroyed', () => {
    const c = inflight.get(id);
    if (c) c.abort();
    inflight.delete(id);
  });
}

async function query(event, rawText) {
  const id = event.sender.id;
  const previous = inflight.get(id);
  if (previous) previous.abort();
  const controller = new AbortController();
  inflight.set(id, controller);
  watchSender(event.sender);

  try {
    const text = typeof rawText === 'string' ? rawText.trim().slice(0, MAX_INPUT) : '';
    if (!text) return [];

    let local = [];
    try {
      local = localMatches(text);
    } catch (err) {
      log(`suggest: local lookup failed: ${err.message}`);
    }

    let remote = [];
    const room = MAX_TOTAL - local.length;
    if (room > 0 && !controller.signal.aborted && remoteAllowed(event, text)) {
      remote = await remoteMatches(text, room, controller);
    }
    return [...local, ...remote.map((s) => ({ type: 'search', text: s }))];
  } catch (err) {
    log(`suggest: query failed: ${err.message}`);
    return [];
  } finally {
    if (inflight.get(id) === controller) inflight.delete(id);
  }
}

function registerIpc(ipcMain) {
  ipcMain.handle('suggest:query', (event, text) => {
    if (!isChromeSender(event)) throw new Error('forbidden sender');
    return query(event, text);
  });
}

module.exports = { registerIpc };
