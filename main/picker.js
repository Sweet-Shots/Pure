'use strict';
// Element picker and My filters (Pure 2.3, owner D3).
//
//   picker:start(tabId, mode)        browser UI  -> top frame of that tab: pure:picker-start {mode, css}
//   pure:picker-create(filter)       top frame of an http(s) tab (preload/picker.js) -> adds a rule to My filters
//   myfilters:get / myfilters:set    settings page (internal sender only)
//
// My filters are one text file, userData/profile/my-filters.txt, saved exactly as typed. Only valid lines are
// compiled (getMyFiltersText, read by filterlists.js at build time); invalid lines are reported back by line.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { log } = require('./logger');
const security = require('./security');

const PRELOAD_FILE = path.join(__dirname, '..', 'preload', 'picker.js');
const CSS_FILE = path.join(__dirname, '..', 'renderer', 'assets', 'picker.css');
const MAX_CSS = 64 * 1024;
const MAX_LINE = 1000;
const MAX_LINES = 5000;
const MAX_TEXT = 256 * 1024;
const MAX_ERRORS = 100;
const SAVE_MS = 1500;
const REBUILD_MS = 1000;
// hostname##selector, one hostname only. Selectors may not contain braces or '<' (they go into CSS), a leading
// '+' or '@' (scriptlets / unhide), or comment markers.
const FILTER_RE = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)##([^\r\n]+)$/i;

// Used only when renderer/assets/picker.css is missing or unreadable. Layout-critical rules live in the preload.
const FALLBACK_CSS = `
.hl{box-sizing:border-box;border:2px solid #4f8ef7;background:rgba(79,142,247,.15);border-radius:2px}
.hl.zap{border-color:#e5484d;background:rgba(229,72,77,.18)}
.hl.selected{border-style:dashed}
.panel{box-sizing:border-box;width:320px;max-width:calc(100vw - 32px);padding:12px;border-radius:8px;background:#1d1f24;color:#eceef2;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)}
.panel-head{display:flex;align-items:baseline;gap:8px}
.panel-title{font-weight:600}
.panel-count{margin-left:auto;opacity:.75;font-size:12px}
.panel-input{box-sizing:border-box;width:100%;margin-top:8px;padding:6px 8px;border-radius:6px;border:1px solid #3a3e47;background:#14161a;color:inherit;font:12px/1.4 ui-monospace,Consolas,monospace}
.panel-row,.panel-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.panel-actions{justify-content:flex-end}
.panel-hint{margin-top:8px;opacity:.85}
.btn{font:inherit;padding:5px 10px;border-radius:6px;border:1px solid #3a3e47;background:#2a2d34;color:inherit;cursor:pointer}
.btn:disabled{opacity:.4;cursor:default}
.btn-primary{background:#4f8ef7;border-color:#4f8ef7;color:#fff}
.panel-msg{min-height:1em;margin-top:8px;font-size:12px;opacity:.85}
.panel-msg.error{color:#ff8a8a}
`;

let text = null;        // the file exactly as typed (null until first use)
let report = { valid: [], errors: [], errorCount: 0 };
let compiled = '';      // valid lines joined with newlines, for the engine build
let dirty = false;
let saveTimer = null;
let writeQueue = Promise.resolve();
let rebuildTimer = null;
let cssPromise = null;
let ghostery = null;

function lib() {
  if (!ghostery) ghostery = require('@ghostery/adblocker');
  return ghostery;
}

function tabsModule() {
  return require('./tabs');
}

function windowsModule() {
  return require('./windows');
}

function isWebUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── My filters: storage, validation, compilation ─────────────────────────────

function filePath() {
  return path.join(app.getPath('userData'), 'profile', 'my-filters.txt');
}

// One line -> { kind:'skip' } | { kind:'ok' } | { kind:'error', message }.
function classify(line) {
  if (!line) return { kind: 'skip' };
  if (line.length > MAX_LINE) return { kind: 'error', message: 'Line is longer than 1,000 characters.' };
  const { detectFilterType, FilterType, parseFilter } = lib();
  let type;
  try {
    type = detectFilterType(line, { extendedNonSupportedTypes: true });
  } catch {
    return { kind: 'error', message: 'Could not read this line.' };
  }
  if (type === FilterType.NOT_SUPPORTED_EMPTY || type === FilterType.NOT_SUPPORTED_COMMENT) return { kind: 'skip' };
  if (type === FilterType.NOT_SUPPORTED_ADGUARD) return { kind: 'error', message: 'AdGuard-only syntax is not supported.' };
  if (type !== FilterType.NETWORK && type !== FilterType.COSMETIC) {
    return { kind: 'error', message: 'Unsupported filter syntax.' };
  }
  // The library parser is lenient: check the shape of cosmetic rules (domain list, then a non-empty selector).
  if (type === FilterType.COSMETIC) {
    const sep = /#[@?$%]?#/.exec(line);
    if (!sep) return { kind: 'error', message: 'Not a valid filter.' };
    if (/\s/.test(line.slice(0, sep.index))) return { kind: 'error', message: 'Domain list cannot contain spaces.' };
    if (!line.slice(sep.index + sep[0].length).trim()) return { kind: 'error', message: 'Empty selector.' };
  }
  let parsed = null;
  try {
    parsed = parseFilter(line);
  } catch {
    parsed = null;
  }
  return parsed ? { kind: 'ok' } : { kind: 'error', message: 'Not a valid filter.' };
}

function analyze(source) {
  const valid = [];
  const errors = [];
  let errorCount = 0;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '').trim();
    const r = classify(line);
    if (r.kind === 'skip') continue;
    if (r.kind === 'error') {
      errorCount++;
      if (errors.length < MAX_ERRORS) errors.push({ line: i + 1, message: r.message });
      continue;
    }
    valid.push(line);
  }
  return { valid, errors, errorCount };
}

function recompile() {
  report = analyze(text);
  compiled = report.valid.length ? report.valid.join('\n') + '\n' : '';
}

function ensureLoaded() {
  if (text !== null) return;
  try {
    text = fs.readFileSync(filePath(), 'utf8');
  } catch {
    text = '';
  }
  recompile();
}

function setText(next) {
  ensureLoaded();
  const before = compiled;
  text = next;
  recompile();
  dirty = true;
  scheduleSave();
  if (compiled !== before) scheduleRebuild();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush().catch(() => {});
  }, SAVE_MS);
}

// Writes the file now (if it changed). Serialized; never rejects. Called on before-quit.
function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeQueue = writeQueue.then(writeNow, writeNow);
  return writeQueue;
}

async function writeNow() {
  if (!dirty || text === null) return;
  dirty = false;
  const snapshot = text;
  const file = filePath();
  const tmp = `${file}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, snapshot, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (err) {
    dirty = true; // keep the change; the next edit schedules another attempt
    log('[picker] cannot save my-filters.txt:', err && err.message);
  }
}

// The engine is rebuilt at most once per burst of edits. filterlists.js owns the build.
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    try {
      const filterlists = require('./filterlists');
      if (filterlists && typeof filterlists.rebuild === 'function') {
        Promise.resolve(filterlists.rebuild('my-filters')).catch((err) => log('[picker] rebuild failed:', err && err.message));
      }
    } catch (err) {
      log('[picker] filter rebuild unavailable:', err && err.message);
    }
  }, REBUILD_MS);
}

// Valid My filters lines only, joined with newlines ('' when there are none). Read by filterlists.js.
function getMyFiltersText() {
  ensureLoaded();
  return compiled;
}

// ── Picker: start on a page ──────────────────────────────────────────────────

function pickerCss() {
  if (!cssPromise) {
    cssPromise = fs.promises.readFile(CSS_FILE, 'utf8').then(
      (css) => (css.trim() && css.length <= MAX_CSS ? css : FALLBACK_CSS),
      () => FALLBACK_CSS,
    );
  }
  return cssPromise;
}

// Sends the start message to the page's top frame. The preload is dormant until this arrives.
async function startOn(wc, mode) {
  if (!wc || wc.isDestroyed() || !isWebUrl(wc.getURL())) return false;
  const frame = wc.mainFrame;
  if (!frame || frame.detached) return false;
  const css = await pickerCss();
  if (wc.isDestroyed() || frame.detached) return false;
  frame.send('pure:picker-start', { mode: mode === 'zap' ? 'zap' : 'pick', css });
  return true;
}

// Used by the page context menu ("Block element…"), which is already main-process initiated.
function startPicker(webContents, mode = 'pick') {
  if (!webContents || webContents.isDestroyed()) return false;
  if (!tabsModule().findTabByWebContentsId(webContents.id)) return false;
  startOn(webContents, mode).catch((err) => log('[picker] start failed:', err && err.message));
  return true;
}

// ── Picker: create a rule from the page ──────────────────────────────────────

function badSelector(sel) {
  return !sel || sel.length > MAX_LINE || /[{}<\u0000]/.test(sel) || /^[+@!]/.test(sel) || /\/\*|\*\//.test(sel);
}

// Validates a rule sent by the page. The host must be the page's own host; the library must parse it as a plain
// cosmetic rule (no unhide, scriptlet or HTML-filtering rules).
function parseCreate(filter, pageHost) {
  if (typeof filter !== 'string' || filter.length > MAX_LINE) return { error: 'The rule is too long.' };
  const line = filter.trim();
  const m = FILTER_RE.exec(line);
  if (!m) return { error: 'Expected hostname##selector.' };
  const host = m[1].toLowerCase();
  if (host !== pageHost) return { error: `The rule must be for this site (${pageHost}).` };
  const selector = m[2].trim();
  if (badSelector(selector)) return { error: 'That selector is not allowed.' };
  const rule = `${host}##${selector}`;
  let cf = null;
  try {
    cf = lib().parseFilter(rule);
  } catch {
    cf = null;
  }
  if (!cf || !cf.isCosmeticFilter() || cf.isUnhide() || cf.isScriptInject() || cf.isHtmlFiltering()) {
    return { error: 'Not a valid cosmetic rule.' };
  }
  return { rule, selector };
}

function createRule(event, filter) {
  const fail = (message) => ({ ok: false, message });
  const wc = event.sender;
  const frame = event.senderFrame;
  // Top frame of a tab only; subframes and popups cannot add rules.
  if (!wc || wc.isDestroyed() || !frame || frame.parent !== null) return fail('Only the top page can add a rule.');
  if (!isWebUrl(frame.url)) return fail('Only web pages can add rules.');
  if (!tabsModule().findTabByWebContentsId(wc.id)) return fail('This page is not a tab.');
  let pageHost = '';
  try {
    pageHost = new URL(frame.url).hostname.toLowerCase();
  } catch {
    return fail('Unknown page address.');
  }
  const parsed = parseCreate(filter, pageHost);
  if (parsed.error) return fail(parsed.error);

  ensureLoaded();
  if (text.split('\n').some((l) => l.trim() === parsed.rule)) {
    return { ok: true, duplicate: true, rule: parsed.rule, rules: report.valid.length, message: 'Rule already exists.' };
  }
  if (text.split('\n').length >= MAX_LINES) return fail('My filters is full (5,000 lines).');
  const base = text && !text.endsWith('\n') ? `${text}\n` : text;
  const next = `${base}${parsed.rule}\n`;
  if (next.length > MAX_TEXT) return fail('My filters is full.');
  setText(next);

  // Apply now to this page. Only the top frame, so insertCSS reaches the same document the picker ran in.
  try {
    wc.insertCSS(`${parsed.selector}{display:none !important}`).catch(() => {});
  } catch {
    // the page went away
  }
  return { ok: true, rule: parsed.rule, rules: report.valid.length };
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function registerIpc(ipc) {
  ipc.on('picker:start', (event, tabId, mode) => {
    try {
      if (!security.isChromeSender(event)) return;
      if (!Number.isInteger(tabId) || tabId <= 0) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      const manager = win ? windowsModule().getTabManager(win) : null;
      const tab = manager ? manager.get(tabId) : null;
      const wc = tab && tab.view ? tab.view.webContents : null;
      if (!wc) return;
      startOn(wc, mode).catch((err) => log('[picker] start failed:', err && err.message));
    } catch (err) {
      log('[picker] picker:start failed:', err && err.message);
    }
  });

  ipc.handle('pure:picker-create', (event, filter) => {
    try {
      return createRule(event, filter);
    } catch (err) {
      log('[picker] create failed:', err && err.message);
      return { ok: false, message: 'Could not add the rule.' };
    }
  });

  ipc.handle('myfilters:get', (event) => {
    if (!security.isInternalSender(event)) throw new Error('forbidden sender');
    ensureLoaded();
    return text;
  });

  ipc.handle('myfilters:set', (event, value) => {
    if (!security.isInternalSender(event)) throw new Error('forbidden sender');
    if (typeof value !== 'string') return { ok: false, rules: 0, errors: [{ line: 0, message: 'Expected text.' }] };
    if (value.length > MAX_TEXT) {
      return { ok: false, rules: 0, errors: [{ line: 0, message: 'Too large: at most 256 KB.' }] };
    }
    if (value.split('\n').length > MAX_LINES) {
      return { ok: false, rules: 0, errors: [{ line: 0, message: 'Too many lines: at most 5,000.' }] };
    }
    setText(value);
    return {
      ok: true,
      rules: report.valid.length,
      errors: report.errors.map((e) => ({ line: e.line, message: e.message })),
    };
  });
}

// Registers the page-side preload for every session while blocking is on. Missing module -> logged, not fatal.
try {
  require('./blocking').registerFramePreload(PRELOAD_FILE, { always: true });
} catch (err) {
  log('[picker] frame preload not registered:', err && err.message);
}

module.exports = {
  registerIpc,
  getMyFiltersText,
  startPicker,
  flush,
};
