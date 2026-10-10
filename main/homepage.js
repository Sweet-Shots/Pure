'use strict';
// main/homepage.js — data for the new-tab page widgets (2.1). Owner: B3.
//
// IPC (internal pure:// senders only): home:news, home:news-sources, home:forecast,
// home:continue-reading, home:notes-get, home:notes-set, home:footer. Incognito senders get
// empty results and never trigger a fetch, a history read or a disk write.
//
// Nothing here polls. Every fetch is caused by a page asking for data, and each answer is
// cached (memory + profile file) so a new tab within the TTL costs no network at all.
// Network requests use the persist:pure session (user agent set by sessions.js) with
// credentials omitted, so feed hosts never receive the profile's cookies.

const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');
const { log } = require('./logger');
const { isInternalSender } = require('./security');
const storage = require('./storage');

const PARTITION = 'persist:pure';
const FEED_TIMEOUT_MS = 8000;
const FEED_MAX_BYTES = 1024 * 1024;
const FORECAST_MAX_BYTES = 64 * 1024;
const MAX_FEEDS = 6;
const MAX_ITEMS = 12;
const MAX_ITEMS_PER_FEED = 40;
const NEWS_TTL_MS = 30 * 60 * 1000;
const NEWS_CACHE_KEYS = 8;
const FORECAST_TTL_MS = 30 * 60 * 1000;
const FORECAST_DAYS = 3;
const READING_COUNT = 4;
const READING_SCAN = 300;
const MAX_URL = 2048;
const MAX_NOTES = 20000;
const NOTES_DEBOUNCE_MS = 1000;

// Topic order is the display order of the chips and the priority order when picking feeds.
const TOPICS = ['top', 'tech', 'world', 'science', 'business', 'sports', 'entertainment', 'health'];

// Built-in registry. `topics` lists the chips a source serves; within a topic the list order is
// the pick order. Every URL was checked to return a feed (HTTP 200, RSS or Atom) when written.
const SOURCES = [
  { id: 'bbc-top', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml', topics: ['top'] },
  { id: 'npr-news', name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml', topics: ['top'] },
  { id: 'bbc-tech', name: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', topics: ['tech'] },
  { id: 'ars-technica', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', topics: ['tech'] },
  { id: 'the-verge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', topics: ['tech'] },
  { id: 'techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', topics: ['tech'] },
  { id: 'hacker-news', name: 'Hacker News', url: 'https://hnrss.org/frontpage', topics: ['tech'] },
  { id: 'guardian-tech', name: 'The Guardian Tech', url: 'https://www.theguardian.com/uk/technology/rss', topics: ['tech'] },
  { id: 'npr-technology', name: 'NPR Technology', url: 'https://feeds.npr.org/1019/rss.xml', topics: ['tech'] },
  { id: 'bbc-world', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', topics: ['world'] },
  { id: 'npr-world', name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml', topics: ['world'] },
  { id: 'guardian-world', name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', topics: ['world'] },
  { id: 'bbc-science', name: 'BBC Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', topics: ['science'] },
  { id: 'sciencedaily', name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/top/science.xml', topics: ['science'] },
  { id: 'npr-science', name: 'NPR Science', url: 'https://feeds.npr.org/1007/rss.xml', topics: ['science'] },
  { id: 'guardian-science', name: 'The Guardian Science', url: 'https://www.theguardian.com/science/rss', topics: ['science'] },
  { id: 'bbc-business', name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', topics: ['business'] },
  { id: 'npr-business', name: 'NPR Business', url: 'https://feeds.npr.org/1006/rss.xml', topics: ['business'] },
  { id: 'guardian-business', name: 'The Guardian Business', url: 'https://www.theguardian.com/uk/business/rss', topics: ['business'] },
  { id: 'bbc-sport', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml', topics: ['sports'] },
  { id: 'espn', name: 'ESPN', url: 'https://www.espn.com/espn/rss/news', topics: ['sports'] },
  { id: 'guardian-sport', name: 'The Guardian Sport', url: 'https://www.theguardian.com/sport/rss', topics: ['sports'] },
  { id: 'bbc-entertainment', name: 'BBC Entertainment', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', topics: ['entertainment'] },
  { id: 'guardian-culture', name: 'The Guardian Culture', url: 'https://www.theguardian.com/culture/rss', topics: ['entertainment'] },
  { id: 'bbc-health', name: 'BBC Health', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', topics: ['health'] },
  { id: 'npr-health', name: 'NPR Health', url: 'https://feeds.npr.org/1128/rss.xml', topics: ['health'] },
  { id: 'sciencedaily-health', name: 'ScienceDaily Health', url: 'https://www.sciencedaily.com/rss/top/health.xml', topics: ['health'] },
];

const profileFile = (name) => path.join(app.getPath('userData'), 'profile', name);
const forbidden = () => {
  throw new Error('forbidden sender');
};
const guard = (event) => {
  if (!isInternalSender(event)) forbidden();
};
// Incognito pages come from the in-memory incognito partition (sessions.js).
const isIncognito = (event) => require('./sessions').isIncognitoSession(event.sender.session);

// Returns the normalized href for an http(s) URL of sane length, otherwise ''.
function httpUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return '';
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Reads a response body, failing once it grows past maxBytes (a declared length is checked first).
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── Feed parsing (tolerant RSS 2.0 + Atom; regex-based, no dependencies) ──────────
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

// Visible text of an XML fragment: CDATA unwrapped, tags removed, entities decoded, whitespace collapsed.
function plainText(raw, max) {
  const text = decodeEntities(String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '));
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Raw inner XML of the first <name> element in block ('' when absent).
function tagRaw(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(block);
  return m ? m[1] : '';
}

// Opening tags <name ...> in block.
function tagsOf(block, name) {
  return block.match(new RegExp(`<${name}(?=[\\s/>])[^>]*>`, 'gi')) || [];
}

// Attribute value from an opening tag, entities decoded.
function attrOf(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (!m) return '';
  return decodeEntities(m[1] !== undefined ? m[1] : m[2]);
}

// First usable image: media:content / media:thumbnail, image enclosure, then the first <img> in the body.
function imageOf(block, html) {
  for (const tag of [...tagsOf(block, 'media:content'), ...tagsOf(block, 'media:thumbnail')]) {
    const type = attrOf(tag, 'type');
    const medium = attrOf(tag, 'medium');
    if (type && !/^image\//i.test(type)) continue;
    if (medium && medium !== 'image') continue;
    const u = httpUrl(attrOf(tag, 'url'));
    if (u) return u;
  }
  for (const tag of tagsOf(block, 'enclosure')) {
    if (!/^image\//i.test(attrOf(tag, 'type'))) continue;
    const u = httpUrl(attrOf(tag, 'url'));
    if (u) return u;
  }
  for (const tag of html.match(/<img(?=[\s/>])[^>]*>/gi) || []) {
    if (attrOf(tag, 'width') === '1' || attrOf(tag, 'height') === '1') continue; // tracking pixel
    const u = httpUrl(attrOf(tag, 'src'));
    if (u) return u;
  }
  return null;
}

function parseEntry(block, isAtom, source) {
  let link = '';
  if (isAtom) {
    for (const tag of tagsOf(block, 'link')) {
      const rel = attrOf(tag, 'rel') || 'alternate';
      if (rel !== 'alternate') continue;
      link = httpUrl(attrOf(tag, 'href'));
      if (link) break;
    }
  } else {
    link = httpUrl(plainText(tagRaw(block, 'link'), MAX_URL)) || httpUrl(plainText(tagRaw(block, 'guid'), MAX_URL));
  }
  const title = plainText(tagRaw(block, 'title'), 200);
  if (!title || !link) return null;
  const when = isAtom
    ? tagRaw(block, 'published') || tagRaw(block, 'updated')
    : tagRaw(block, 'pubDate') || tagRaw(block, 'dc:date');
  const stamp = Date.parse(plainText(when, 60));
  const html = tagRaw(block, 'content:encoded') || tagRaw(block, 'description') || tagRaw(block, 'content') || tagRaw(block, 'summary');
  return {
    title,
    link,
    source: source.name,
    publishedAt: Number.isFinite(stamp) ? stamp : null,
    image: imageOf(block, html),
  };
}

function parseFeed(xml, source) {
  const out = [];
  const re = /<(item|entry)(?=[\s>])[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while (out.length < MAX_ITEMS_PER_FEED && (m = re.exec(xml))) {
    const entry = parseEntry(m[2], m[1].toLowerCase() === 'entry', source);
    if (entry) out.push(entry);
  }
  return out;
}

// Newest first, duplicates (same link or same title) removed, at most MAX_ITEMS.
function mergeItems(lists) {
  const all = lists.flat().sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  const links = new Set();
  const titles = new Set();
  const out = [];
  for (const item of all) {
    const key = item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (links.has(item.link) || (key && titles.has(key))) continue;
    links.add(item.link);
    titles.add(key);
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// Cached items come back from disk, so they are validated again before use.
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 200) : '';
  const link = httpUrl(raw.link);
  if (!title || !link) return null;
  return {
    title,
    link,
    source: typeof raw.source === 'string' ? raw.source.slice(0, 60) : '',
    publishedAt: Number.isFinite(raw.publishedAt) ? raw.publishedAt : null,
    image: httpUrl(raw.image) || null,
  };
}

// ── News ─────────────────────────────────────────────────────────────────────────
// The feeds for a request: enabled topics, round-robin over topics so each chip gets a source,
// at most MAX_FEEDS feeds. The cache key is the list of picked feed ids, which already reflects
// both the topics and the disabled sources.
function pickFeeds(topics, disabled) {
  const off = new Set(disabled);
  const perTopic = new Map(
    topics.map((t) => [t, SOURCES.filter((s) => s.topics.includes(t) && !off.has(s.id))]),
  );
  const picked = [];
  const taken = new Set();
  for (let rank = 0; picked.length < MAX_FEEDS; rank++) {
    let any = false;
    for (const t of topics) {
      const candidate = perTopic.get(t)[rank];
      if (!candidate) continue;
      any = true;
      if (taken.has(candidate.id)) continue;
      taken.add(candidate.id);
      picked.push(candidate);
      if (picked.length >= MAX_FEEDS) break;
    }
    if (!any) break;
  }
  return picked;
}

const newsCache = new Map(); // key -> { fetchedAt, items }, insertion order = age order
const newsInflight = new Map(); // key -> Promise
let newsDiskLoad = null;
let newsWrite = Promise.resolve();

function loadNewsDisk() {
  if (!newsDiskLoad) {
    newsDiskLoad = fs.promises
      .readFile(profileFile('news-cache.json'), 'utf8')
      .then((text) => {
        const raw = JSON.parse(text);
        const entries = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
        for (const key of Object.keys(entries).slice(-NEWS_CACHE_KEYS)) {
          const e = entries[key];
          if (!e || !Number.isFinite(e.fetchedAt) || !Array.isArray(e.items)) continue;
          const items = e.items.map(sanitizeItem).filter(Boolean).slice(0, MAX_ITEMS);
          newsCache.set(key, { fetchedAt: e.fetchedAt, items });
        }
      })
      .catch((err) => {
        if (err.code !== 'ENOENT') log(`[home] cannot read news cache: ${err.message}`);
      });
  }
  return newsDiskLoad;
}

function saveNewsDisk() {
  const text = JSON.stringify({ entries: Object.fromEntries(newsCache) });
  newsWrite = newsWrite.then(async () => {
    const file = profileFile('news-cache.json');
    const tmp = `${file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, text, 'utf8');
      await fs.promises.rename(tmp, file);
    } catch (err) {
      log(`[home] cannot write news cache: ${err.message}`);
    }
  });
  return newsWrite;
}

async function fetchFeed(source) {
  const res = await session.fromPartition(PARTITION).fetch(source.url, {
    redirect: 'follow',
    credentials: 'omit',
    headers: { accept: 'application/rss+xml, application/atom+xml;q=0.9, application/xml;q=0.8, */*;q=0.5' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await readCapped(res, FEED_MAX_BYTES), source);
}

function newsReply(entry, topics, offline, stale) {
  return { items: entry.items, fetchedAt: entry.fetchedAt, topics, offline, stale };
}

async function refreshNews(feeds, key, cached, topics) {
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const lists = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') lists.push(r.value);
    else log(`[home] feed ${feeds[i].id} failed: ${r.reason && r.reason.message}`);
  });
  if (lists.length) {
    const entry = { fetchedAt: Date.now(), items: mergeItems(lists) };
    newsCache.delete(key);
    newsCache.set(key, entry);
    while (newsCache.size > NEWS_CACHE_KEYS) newsCache.delete(newsCache.keys().next().value);
    saveNewsDisk();
    return newsReply(entry, topics, false, false);
  }
  // Every feed failed (offline or blocked): show the last saved headlines, however old they are.
  if (cached) return newsReply(cached, topics, true, true);
  return { items: [], fetchedAt: 0, topics, offline: true, stale: false };
}

async function getNews(force) {
  const s = storage.settings.get();
  const topics = TOPICS.filter((t) => s.newsTopics.includes(t));
  const feeds = pickFeeds(topics, s.newsSources);
  if (!feeds.length) return { items: [], fetchedAt: 0, topics, offline: false, stale: false };

  await loadNewsDisk();
  const key = feeds.map((f) => f.id).join(',');
  const cached = newsCache.get(key) || null;
  if (cached && !force && Date.now() - cached.fetchedAt < NEWS_TTL_MS) {
    return newsReply(cached, topics, false, false);
  }
  if (newsInflight.has(key)) {
    const pending = await newsInflight.get(key);
    return { ...pending, topics };
  }
  const run = refreshNews(feeds, key, cached, topics).finally(() => newsInflight.delete(key));
  newsInflight.set(key, run);
  return run;
}

// ── Forecast (open-meteo, 3 days, cached 30 min) ─────────────────────────────────
const forecastCache = new Map(); // key -> { t, data }
const forecastInflight = new Map();

const finiteNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

function parseForecast(data, unit) {
  const d = data && data.daily;
  if (!d || !Array.isArray(d.time)) return null;
  const days = [];
  for (let i = 0; i < d.time.length && days.length < FORECAST_DAYS; i++) {
    const date = String(d.time[i]);
    const max = finiteNum(d.temperature_2m_max && d.temperature_2m_max[i]);
    const min = finiteNum(d.temperature_2m_min && d.temperature_2m_min[i]);
    const code = finiteNum(d.weather_code && d.weather_code[i]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(max) || !Number.isFinite(min) || !Number.isInteger(code)) continue;
    days.push({ date, min: Math.round(min), max: Math.round(max), code });
  }
  return days.length ? { days, unit } : null;
}

async function loadForecast(key, s, unit, stale) {
  try {
    const query = new URLSearchParams({
      latitude: s.homepageLatitude,
      longitude: s.homepageLongitude,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min',
      forecast_days: String(FORECAST_DAYS),
      timezone: 'auto',
      temperature_unit: unit,
    });
    const res = await session.fromPartition(PARTITION).fetch(`https://api.open-meteo.com/v1/forecast?${query}`, {
      credentials: 'omit',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = parseForecast(JSON.parse(await readCapped(res, FORECAST_MAX_BYTES)), unit);
    if (!data) throw new Error('unexpected response');
    forecastCache.set(key, { t: Date.now(), data });
    return data;
  } catch (err) {
    log(`[home] forecast failed: ${err.message}`);
    return stale ? stale.data : null;
  }
}

async function getForecast() {
  const s = storage.settings.get();
  const unit = s.homepageTempUnit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
  const key = `${s.homepageLatitude},${s.homepageLongitude},${unit}`;
  const hit = forecastCache.get(key) || null;
  if (hit && Date.now() - hit.t < FORECAST_TTL_MS) return hit.data;
  if (forecastInflight.has(key)) return forecastInflight.get(key);
  const run = loadForecast(key, s, unit, hit).finally(() => forecastInflight.delete(key));
  forecastInflight.set(key, run);
  return run;
}

// ── Continue reading ─────────────────────────────────────────────────────────────
// URLs of every open tab, when tabs.js exports allTabs(); otherwise nothing is excluded.
function openUrls() {
  const open = new Set();
  let all = [];
  try {
    all = require('./tabs').allTabs?.() || [];
  } catch (err) {
    log(`[home] cannot list open tabs: ${err.message}`);
  }
  for (const entry of all) {
    const u = httpUrl(entry && entry.tab && entry.tab.url);
    if (u) open.add(u);
  }
  return open;
}

function continueReading() {
  const open = openUrls();
  const { items } = storage.history.list({ limit: READING_SCAN }); // newest first
  const hosts = new Set();
  const out = [];
  for (const e of items) {
    if (out.length >= READING_COUNT) break;
    const host = hostOf(e.url);
    if (!host || hosts.has(host) || open.has(e.url)) continue;
    hosts.add(host);
    out.push({ url: e.url, title: e.title || e.url });
  }
  return out;
}

// ── Notes (profile/notes.txt, debounced atomic writes) ───────────────────────────
let notesText = null;
let notesLoad = null;
let notesDirty = false;
let notesTimer = null;
let notesQueue = Promise.resolve();

function loadNotes() {
  if (!notesLoad) {
    notesLoad = fs.promises.readFile(profileFile('notes.txt'), 'utf8').then(
      (text) => {
        notesText = text;
      },
      (err) => {
        if (err.code !== 'ENOENT') log(`[home] cannot read notes: ${err.message}`);
        notesText = '';
      },
    );
  }
  return notesLoad;
}

async function getNotes() {
  await loadNotes();
  return notesText;
}

async function setNotes(text) {
  if (typeof text !== 'string' || text.length > MAX_NOTES) return false;
  await loadNotes();
  notesText = text;
  notesDirty = true;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => {
    notesTimer = null;
    writeNotes();
  }, NOTES_DEBOUNCE_MS);
  return true;
}

function writeNotes() {
  notesQueue = notesQueue.then(async () => {
    if (!notesDirty) return;
    notesDirty = false;
    const file = profileFile('notes.txt');
    const tmp = `${file}.tmp`;
    try {
      await fs.promises.writeFile(tmp, notesText, 'utf8');
      await fs.promises.rename(tmp, file);
    } catch (err) {
      notesDirty = true; // the next edit or quit flush retries
      log(`[home] cannot write notes: ${err.message}`);
    }
  });
  return notesQueue;
}

// ── Footer ───────────────────────────────────────────────────────────────────────
// Lazy requires: performance.js and blocking.js may be absent or not yet initialised.
function footerStats() {
  let memoryMB = 0;
  let sleeping = 0;
  let blockedToday = 0;
  try {
    const perf = require('./performance').summary({ incognito: false });
    memoryMB = Number(perf.memoryMB) || 0;
    sleeping = Number(perf.sleeping) || 0;
  } catch {
    // performance module unavailable: show zeros
  }
  try {
    blockedToday = Number(require('./blocking').getStats().today) || 0;
  } catch {
    // blocking module unavailable: show zero
  }
  return { memoryMB, sleeping, blockedToday };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────────
// Writes pending notes now. index.js calls this on before-quit.
function flush() {
  clearTimeout(notesTimer);
  notesTimer = null;
  writeNotes();
  return Promise.all([notesQueue, newsWrite]).then(() => undefined);
}

function registerIpc(ipcMain) {
  ipcMain.handle('home:news', (event, opts) => {
    guard(event);
    if (isIncognito(event)) return { items: [], fetchedAt: 0, topics: [], offline: false, stale: false };
    return getNews(!!(opts && opts.force === true));
  });

  ipcMain.handle('home:news-sources', (event) => {
    guard(event);
    return SOURCES.map((s) => ({ id: s.id, name: s.name, topics: [...s.topics] }));
  });

  ipcMain.handle('home:forecast', (event) => {
    guard(event);
    return isIncognito(event) ? null : getForecast();
  });

  ipcMain.handle('home:continue-reading', (event) => {
    guard(event);
    return isIncognito(event) ? [] : continueReading();
  });

  ipcMain.handle('home:notes-get', (event) => {
    guard(event);
    return isIncognito(event) ? '' : getNotes();
  });

  ipcMain.handle('home:notes-set', (event, text) => {
    guard(event);
    return isIncognito(event) ? false : setNotes(text);
  });

  ipcMain.handle('home:footer', (event) => {
    guard(event);
    return isIncognito(event) ? null : footerStats();
  });
}

module.exports = { registerIpc, flush, SOURCES };
