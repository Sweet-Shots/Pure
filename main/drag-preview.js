'use strict';
// Drag-out preview (2.5, F3). While a tab is dragged outside its window's tab strip, a small frameless, transparent,
// click-through, non-focusable window follows the cursor and shows a snapshot of the tab with its title.
//   - Created lazily on the first drag, reused between drags (hidden), destroyed when the last browser window closes.
//   - The snapshot is captured once per drag, scaled down, and put in a data: page (no preload, no scripts).
//   - The browser UI sends pointer positions, at most once per animation frame; this module only moves the window.
// Nothing here polls: the window is moved only when the UI reports a position.

const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const logger = require('./logger');

const PAGE_DIR = path.join(__dirname, '..', 'renderer', 'pages', 'drag-preview');
const CARD_WIDTH = 320;        // px; the snapshot is scaled to this width
const TITLE_HEIGHT = 30;       // px; the title strip (must match drag-preview.css .strip)
const SLEEP_HEIGHT = 96;       // px; card body for a sleeping (discarded) tab, which has no snapshot
const MAX_SHOT_HEIGHT = 240;   // px; taller pages are cropped at the top
const JPEG_QUALITY = 70;
const OFFSET_X = 36;           // the card's top-left corner sits this far from the cursor
const OFFSET_Y = 14;
const FAVICON_MAX = 100000;
const TITLE_MAX = 200;
const CSP = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'";

let win = null;        // the preview BrowserWindow (created lazily, reused)
let shown = false;     // the window is visible for the current drag
let token = 0;         // bumped by begin / end / destroy: async work from an older drag stops when it differs
let last = null;       // latest pointer position {x, y}
let assets = null;     // { template, css } read once, on the first drag

function log(...args) {
  try { logger.log(...args); } catch { /* ignore */ }
}

async function loadAssets() {
  if (!assets) {
    const [template, css] = await Promise.all([
      fs.promises.readFile(path.join(PAGE_DIR, 'index.html'), 'utf8'),
      fs.promises.readFile(path.join(PAGE_DIR, 'drag-preview.css'), 'utf8'),
    ]);
    assets = { template, css };
  }
  return assets;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Favicons are only http(s) or data: image URLs (the browser UI already filters them the same way).
function faviconSrc(f) {
  return typeof f === 'string' && f.length <= FAVICON_MAX && /^(https?:\/\/|data:image\/)/i.test(f) ? f : '';
}

// One JPEG of the tab, scaled to CARD_WIDTH and cropped to MAX_SHOT_HEIGHT. null when there is nothing to show.
async function snapshot(tab) {
  const wc = tab.view ? tab.view.webContents : null; // a sleeping tab has no view
  if (!wc || wc.isDestroyed()) return null;
  const full = await wc.capturePage();
  if (!full || full.isEmpty()) return null;
  let img = full.resize({ width: CARD_WIDTH, quality: 'good' });
  const { height } = img.getSize();
  const h = Math.min(MAX_SHOT_HEIGHT, height);
  if (h < 1) return null;
  if (h < height) img = img.crop({ x: 0, y: 0, width: CARD_WIDTH, height: h });
  return { h, src: 'data:image/jpeg;base64,' + img.toJPEG(JPEG_QUALITY).toString('base64') };
}

function buildPage(template, css, tab, shot) {
  const title = String(tab.title || tab.url || 'New Tab').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, TITLE_MAX);
  const fav = faviconSrc(tab.favicon);
  const favHtml = fav ? `<img class="favicon" src="${esc(fav)}" alt="" width="16" height="16">` : '';
  const body = shot
    ? `<div class="shot"><img src="${shot.src}" width="${CARD_WIDTH}" height="${shot.h}" alt=""></div>`
    : `<div class="shot sleeping">${fav ? `<img class="favicon-large" src="${esc(fav)}" alt="" width="32" height="32">` : ''}</div>`;
  const card = `<main class="card">${body}<div class="strip">${favHtml}<span class="title">${esc(title)}</span></div></main>`;
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${css}</style>`;
  return template.replace('<!--pure:head-->', head).replace('<!--pure:card-->', card);
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  const w = new BrowserWindow({
    width: CARD_WIDTH,
    height: CARD_WIDTH,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      partition: 'drag-preview', // in-memory session: nothing is stored
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: false, // the page has no scripts
      spellcheck: false,
      devTools: false,
    },
  });
  win = w;
  w.setIgnoreMouseEvents(true, { forward: false }); // the pointer always reaches the tab strip underneath
  const wc = w.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
  // A crashed preview is simply rebuilt on the next drag.
  wc.on('render-process-gone', () => {
    if (win === w) win = null;
    shown = false;
    if (!w.isDestroyed()) w.destroy();
  });
  w.on('closed', () => {
    if (win === w) {
      win = null;
      shown = false;
    }
  });
  return w;
}

function placeAt(x, y) {
  if (!win || win.isDestroyed()) return;
  win.setPosition(Math.round(x - OFFSET_X), Math.round(y - OFFSET_Y), false);
}

// Starts a preview for `tab` (a TabManager tab) with the pointer at screen point x, y. The snapshot is taken here,
// once; the window shows when its page has loaded, at the latest known position.
async function begin(tab, x, y) {
  const my = ++token;
  last = { x, y };
  let shot = null;
  try {
    shot = await snapshot(tab);
  } catch (e) {
    log('drag preview snapshot failed:', e && e.message);
  }
  if (my !== token) return;
  let bundle;
  try {
    bundle = await loadAssets();
  } catch (e) {
    log('drag preview assets missing:', e && e.message);
    return;
  }
  if (my !== token) return;
  const w = ensureWindow();
  const html = buildPage(bundle.template, bundle.css, tab, shot);
  w.setContentSize(CARD_WIDTH, (shot ? shot.h : SLEEP_HEIGHT) + TITLE_HEIGHT);
  try {
    await w.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
  } catch (e) {
    log('drag preview load failed:', e && e.message);
    return;
  }
  if (my !== token || w.isDestroyed()) return;
  placeAt(last.x, last.y);
  w.showInactive();
  shown = true;
}

// Pointer moved (screen coordinates). Cheap: the UI already throttles to one call per frame.
function move(x, y) {
  last = { x, y };
  if (shown) placeAt(x, y);
}

// Drag over, cancelled, or dropped: hide. The window stays alive for the next drag.
function end() {
  token++;
  if (win && !win.isDestroyed() && shown) win.hide();
  shown = false;
}

// The last browser window closed: release the window and its renderer.
function destroy() {
  token++;
  shown = false;
  const w = win;
  win = null;
  if (w && !w.isDestroyed()) {
    try { w.destroy(); } catch { /* already gone */ }
  }
}

module.exports = { begin, move, end, destroy };
