'use strict';
// main/reader.js — reader mode (Pure 2.2, owner C5).
//
// Availability: on every main-frame did-finish-load of an http(s) page in a tab, Readability's
// isProbablyReaderable() runs in an isolated world (WORLD_ID). Only the small readerable source is injected
// for that check, one call per page load. reader:available (with the page URL) goes to the tab's window UI
// after every load.
// Toggle: the full Readability source is injected into the same isolated world for one parse of a clone
// of the document (the page's own document is never modified). The article is kept here (LRU, MAX_ARTICLES)
// and the tab navigates to pure://reader/?id=N, so Back returns to the original page.
// Nothing runs on pure:// pages, non-http(s) URLs, or webContents that are not browser tabs.

const fs = require('fs');
const path = require('path');
const { app, ipcMain, webContents } = require('electron');
const { log } = require('./logger');
const security = require('./security');

const WORLD_ID = 1001; // Electron reserves 999 for contextIsolation; 1000+ is for the app
const MAX_ARTICLES = 20;
const MAX_CONTENT = 2 * 1024 * 1024; // characters of contentHtml kept per article
const WORDS_PER_MINUTE = 230;
const READER_PREFIX = 'pure://reader/';
const TEXT_MAX = 300;

// ── Library sources (read once, lazily; they ship inside app.asar with node_modules) ──────────────
let readerableCode = null; // code that evaluates to isProbablyReaderable(document)
let readabilitySource = null; // Readability.js source text

function libPath(file) {
  return path.join(path.dirname(require.resolve('@mozilla/readability')), file);
}

// Evaluates a UMD/CommonJS source with a local `module` object (the library then sets module.exports).
function wrapModule(src, tail) {
  return `(function(){var module={exports:{}};var exports=module.exports;\n${src}\n;${tail}})()`;
}

function getReaderableCode() {
  if (readerableCode === null) {
    const src = fs.readFileSync(libPath('Readability-readerable.js'), 'utf8');
    readerableCode = wrapModule(src, 'return module.exports(document);');
  }
  return readerableCode;
}

function getParseCode() {
  if (readabilitySource === null) readabilitySource = fs.readFileSync(libPath('Readability.js'), 'utf8');
  return wrapModule(
    readabilitySource,
    'var Rd=module.exports;return new Rd(document.cloneNode(true)).parse();',
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const isHttp = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);
const isReaderUrl = (url) => typeof url === 'string' && url.startsWith(READER_PREFIX);
const tabsModule = () => require('./tabs');
const windowsModule = () => require('./windows');

function readerIdOf(url) {
  try {
    const id = Number(new URL(url).searchParams.get('id'));
    return Number.isInteger(id) && id > 0 ? id : 0;
  } catch {
    return 0;
  }
}

function textField(v, max = TEXT_MAX) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function safeLang(v) {
  return typeof v === 'string' && /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,3}$/.test(v) ? v : '';
}

// Cuts an oversized article at the last paragraph end below the cap (or hard-cuts when there is none).
function capHtml(html) {
  if (html.length <= MAX_CONTENT) return html;
  const cut = html.lastIndexOf('</p>', MAX_CONTENT);
  return cut > 0 ? html.slice(0, cut + 4) : html.slice(0, MAX_CONTENT);
}

// Turns Readability's result into the Article shape. contentHtml is NOT sanitized here (the reader page does it).
function buildArticle(raw, pageUrl) {
  if (!raw || typeof raw !== 'object' || typeof raw.content !== 'string') return null;
  const text = typeof raw.textContent === 'string' ? raw.textContent.trim() : '';
  const words = text ? text.split(/\s+/).length : 0;
  return {
    title: textField(raw.title),
    byline: textField(raw.byline),
    siteName: textField(raw.siteName, 200),
    url: pageUrl,
    contentHtml: capHtml(raw.content),
    minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    lang: safeLang(raw.lang),
    dir: raw.dir === 'rtl' ? 'rtl' : 'ltr',
  };
}

// ── Article store (LRU) ───────────────────────────────────────────────────────
const articles = new Map(); // id -> Article, insertion order = age
let nextArticleId = 1;

function rememberArticle(article) {
  const id = nextArticleId++;
  articles.set(id, article);
  while (articles.size > MAX_ARTICLES) articles.delete(articles.keys().next().value);
  return id;
}

// ── Availability ──────────────────────────────────────────────────────────────
const availableSent = new Map(); // webContents id -> last value sent to the UI
const busy = new Set(); // webContents ids with a parse in flight
const attached = new WeakSet();

// Sends reader:available for the tab after every page load. The UI forgets a tab's answer whenever its URL
// changes, so sending only on change left the button stale across two readable (or two plain) pages in a row.
// One small message per page load.
function publishAvailable(wc, available) {
  if (wc.isDestroyed()) return;
  availableSent.set(wc.id, available);
  const found = tabsModule().findTabByWebContentsId(wc.id);
  // url lets the UI ignore an answer for a page the tab has already left.
  if (found) found.manager.send('reader:available', { tabId: found.tab.id, available, url: wc.getURL() });
}

function onFinishLoad(wc) {
  if (wc.isDestroyed()) return;
  const url = wc.getURL();
  // pure:// pages (reader included), the browser UI and other non-web pages keep the last known value.
  if (!isHttp(url)) return;
  // Only browser tabs: popups and other windows are not tabs.
  if (!tabsModule().findTabByWebContentsId(wc.id)) return;
  wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: getReaderableCode() }], false)
    .then((v) => v === true, () => false)
    .then((ok) => publishAvailable(wc, ok));
}

function attachContents(wc) {
  if (!wc || attached.has(wc)) return;
  attached.add(wc);
  wc.on('did-finish-load', () => onFinishLoad(wc));
  wc.once('destroyed', () => availableSent.delete(wc.id));
}

// ── Toggle and exit ───────────────────────────────────────────────────────────
// Leaves the reader page: Back when there is history, else the original URL stored in the article.
function leaveReader(manager, tab, wc) {
  if (wc.navigationHistory.canGoBack()) {
    manager.back(tab.id);
    return;
  }
  const article = articles.get(readerIdOf(wc.getURL()));
  if (article && isHttp(article.url)) manager.navigate(tab.id, article.url);
}

async function enterReader(manager, tab, wc) {
  const url = wc.getURL();
  if (!isHttp(url) || busy.has(wc.id)) return;
  busy.add(wc.id);
  try {
    const raw = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: getParseCode() }], false);
    // The page may have navigated or the tab may have closed while Readability ran.
    if (wc.isDestroyed() || manager.get(tab.id) !== tab || wc.getURL() !== url) return;
    const article = buildArticle(raw, url);
    if (!article) {
      log('[reader] nothing to show for', url);
      return;
    }
    const id = rememberArticle(article);
    manager.navigate(tab.id, `${READER_PREFIX}?id=${id}`);
  } finally {
    busy.delete(wc.id);
  }
}

// ── Sender checks ─────────────────────────────────────────────────────────────
function readerSender(event) {
  if (!security.isInternalSender(event)) return false;
  const url = event.senderFrame ? event.senderFrame.url : '';
  return isReaderUrl(url);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerIpc(ipc) {
  app.on('web-contents-created', (_e, wc) => attachContents(wc));
  for (const wc of webContents.getAllWebContents()) attachContents(wc);

  // Chrome sender only; the tab must belong to the sender's window.
  ipc.on('reader:toggle', (event, tabId) => {
    if (!security.isChromeSender(event) || !Number.isInteger(tabId)) return;
    const st = windowsModule().senderState(event);
    const tab = st && st.tabs ? st.tabs.get(tabId) : null;
    if (!tab || !tab.view) return;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const run = isReaderUrl(wc.getURL()) ? () => leaveReader(st.tabs, tab, wc) : () => enterReader(st.tabs, tab, wc);
    Promise.resolve()
      .then(run)
      .catch((err) => log('[reader] toggle failed:', err && err.message));
  });

  ipc.handle('reader:get', (event, id) => {
    if (!readerSender(event)) throw new Error('forbidden sender');
    const article = Number.isInteger(id) ? articles.get(id) : null;
    return article ? { ...article } : null;
  });

  ipc.on('reader:exit', (event) => {
    if (!readerSender(event)) return;
    const found = tabsModule().findTabByWebContentsId(event.sender.id);
    if (found) leaveReader(found.manager, found.tab, event.sender);
  });
}

module.exports = { registerIpc };
