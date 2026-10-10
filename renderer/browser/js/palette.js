// Command palette: Ctrl+K (everything) and Ctrl+Shift+A (tabs only, the @tabs chip). Overlay #palette,
// the page is frozen while it is open. Actions and settings entries are local and instant; open tabs,
// bookmarks and history come from main (palette:query, debounced 80 ms, stale responses dropped).
// Keys: ↑/↓ move, Enter runs, Esc closes (keys.js forwards Esc from main), click runs.

import { S, homeUrl, activeTab } from './state.js';
import { $, el, pure } from './util.js';
import { acquireFreeze, registerOverlay, claimOverlay } from './freeze.js';
import { icon } from './icons.js';
import { navigateActive } from './navigate.js';
import { toggleBookmarksBar } from './bookmarks.js';
import { toggleFocusMode, toggleVerticalTabs, toggleSplit, muteOthers, toggleReader } from './commands.js';
import { isSplitActive } from './split.js';

const DEBOUNCE_MS = 80;
const box = $('palette');
const input = $('palette-input');
const list = $('palette-list');
const empty = $('palette-empty');
const modeChip = $('palette-mode');
const KIND_LABEL = { tab: 'Tab', bookmark: 'Bookmark', history: 'History', action: 'Action', setting: 'Setting' };

// Settings sections (pure://settings/#<id>), listed as "Settings: …" when the query matches.
const SETTINGS_PAGES = [
  ['homepage', 'Homepage'],
  ['appearance', 'Appearance'],
  ['search', 'Search'],
  ['privacy', 'Privacy'],
  ['performance', 'Performance'],
  ['passwords', 'Passwords'],
  ['extensions', 'Extensions'],
  ['import', 'Import'],
  ['shortcuts', 'Shortcuts'],
  ['about', 'About'],
];

let open = false;
let tabsOnly = false;
let release = null;
let timer = 0;
let reqSeq = 0; // bumped on every input and on open/close: responses for older requests are dropped
let pending = false;
let typed = '';
let remote = []; // main's rows for the current query
let items = []; // rendered entries, in order
let nodes = []; // .pal-item nodes, parallel to items
let index = 0;

function openSettings(section) {
  pure.tabs.create({ url: `pure://settings/#${section}` }).catch(() => {});
}

const onOff = (v) => (v ? 'On' : 'Off');
const themeSub = (name) => (S.settings.theme === name ? 'Current' : '');

const isWebUrl = (u) => /^https?:\/\//i.test(String(u || ''));
// Pages the screenshot tool can capture (web, local file, new-tab page).
const isCapturable = (u) => isWebUrl(u) || /^file:/i.test(String(u || '')) || /^pure:\/\/home(\/|$)/i.test(String(u || ''));
const toolTab = () => {
  const t = activeTab();
  return t && isCapturable(t.url) ? t : null;
};
const webTab = () => {
  const t = activeTab();
  return t && isWebUrl(t.url) ? t : null;
};

// Local actions. title/sub may be functions (state changes while the palette is closed).
// hidden() = true leaves the action out of the list (it does not apply to the current tab or window).
const ACTIONS = [
  { title: 'New tab', icon: 'plus', keywords: 'open', run: () => pure.tabs.create({ url: homeUrl() }) },
  { title: 'New window', icon: 'app-window', run: () => pure.newWindow() },
  { title: 'New incognito window', icon: 'eye-off', keywords: 'private', run: () => pure.openIncognito() },
  { title: 'Reopen closed tab', icon: 'undo-2', keywords: 'restore', run: () => pure.tabs.reopenClosed() },
  { title: 'Toggle bookmarks bar', icon: 'bookmark', sub: () => onOff(S.settings.showBookmarksBar), run: toggleBookmarksBar },
  { title: 'Toggle focus mode', icon: 'focus', keywords: 'distraction', sub: () => onOff(S.settings.focusMode), run: toggleFocusMode },
  { title: 'Toggle vertical tabs', icon: 'panel-left', sub: () => onOff(S.settings.verticalTabs), run: toggleVerticalTabs },
  { title: () => (isSplitActive() ? 'Close split view' : 'Split view'), icon: 'columns-2', keywords: 'side by side', run: toggleSplit },
  { title: 'Reader mode', icon: 'book-open', keywords: 'article simplify', run: toggleReader },
  { title: 'Mute other tabs', icon: 'volume-x', keywords: 'silence', run: muteOthers },
  // 2.4 — tools
  { title: 'Take screenshot', icon: 'app-window', keywords: 'capture visible area print screen picture', hidden: () => !toolTab(),
    run: () => { const t = toolTab(); if (t) pure.tools.screenshot(t.id, 'visible').catch(() => {}); } },
  { title: 'Take full-page screenshot', icon: 'app-window', keywords: 'capture whole page scroll long', hidden: () => !toolTab(),
    run: () => { const t = toolTab(); if (t) pure.tools.screenshot(t.id, 'full').catch(() => {}); } },
  { title: 'Copy clean link', icon: 'shield', keywords: 'url tracking utm fbclid strip parameters copy link', hidden: () => !webTab(),
    run: () => { const t = webTab(); if (t) pure.tools.copyCleanLink(t.url).catch(() => {}); } },
  { title: () => (activeTab() && activeTab().pinned ? 'Unpin tab' : 'Pin tab'), icon: 'bookmark', keywords: 'pin keep tab',
    hidden: () => !activeTab(),
    run: () => { const t = activeTab(); if (t) pure.tabs.pin(t.id, !t.pinned); } },
  { title: 'Site settings', icon: 'lock', keywords: 'permissions cookies storage sites per site', run: () => openSettings('sites') },
  { title: 'Report a broken site', icon: 'triangle-alert', keywords: 'bug issue github problem broken', hidden: () => S.incognito || !webTab(),
    run: () => { const t = webTab(); if (t) pure.blocking.reportBroken(t.id); } },
  { title: 'Clear browsing data', icon: 'trash-2', keywords: 'cookies cache history privacy', run: () => openSettings('privacy') },
  { title: 'Theme: dark', icon: 'moon', sub: () => themeSub('dark'), run: () => pure.settings.set({ theme: 'dark' }) },
  { title: 'Theme: light', icon: 'sun', sub: () => themeSub('light'), run: () => pure.settings.set({ theme: 'light' }) },
  { title: 'Theme: follow Windows', icon: 'monitor', sub: () => themeSub('system'), run: () => pure.settings.set({ theme: 'system' }) },
  { title: 'Downloads', icon: 'download', run: () => openSettings('downloads') },
  { title: 'History', icon: 'history', run: () => openSettings('history') },
];

function labelOf(a) {
  return typeof a.title === 'function' ? a.title() : a.title;
}

function tokensOf(text) {
  return String(text || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

function matches(tokens, text) {
  if (!tokens.length) return true;
  const hay = String(text).toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

// Entries in display order: open tabs, actions, settings, bookmarks, history.
function buildItems() {
  const toks = tokensOf(typed);
  const out = [];
  for (const r of remote) {
    if (r.kind !== 'tab' || !matches(toks, `${r.title} ${r.sub}`)) continue;
    out.push({
      kind: 'tab',
      section: toks.length ? 'Open tabs' : 'Recent tabs',
      title: r.title,
      sub: r.sub,
      favicon: r.favicon,
      icon: 'globe',
      run: () => pure.palette.activateTab(r.windowId, r.tabId),
    });
  }
  if (!tabsOnly) {
    for (const a of ACTIONS) {
      if (a.hidden && a.hidden()) continue;
      if (!matches(toks, `${labelOf(a)} ${a.keywords || ''}`)) continue;
      out.push({ kind: 'action', section: 'Actions', title: labelOf(a), sub: a.sub ? a.sub() : '', icon: a.icon, run: a.run });
    }
    if (toks.length) {
      for (const [id, label] of SETTINGS_PAGES) {
        if (!matches(toks, `settings ${label} ${id}`)) continue;
        out.push({
          kind: 'setting',
          section: 'Settings',
          title: `Settings: ${label}`,
          sub: `pure://settings/#${id}`,
          icon: 'settings',
          run: () => openSettings(id),
        });
      }
    }
    for (const r of remote) {
      if (r.kind === 'bookmark' && matches(toks, `${r.title} ${r.sub}`)) {
        out.push({ kind: 'bookmark', section: 'Bookmarks', title: r.title, sub: r.sub, icon: 'star', run: () => navigateActive(r.url) });
      }
    }
    for (const r of remote) {
      if (r.kind === 'history' && matches(toks, `${r.title} ${r.sub}`)) {
        out.push({ kind: 'history', section: 'History', title: r.title, sub: r.sub, icon: 'history', run: () => navigateActive(r.url) });
      }
    }
  }
  return out;
}

function buildNode(it, i) {
  const node = el('div', 'pal-item');
  node.dataset.index = String(i);
  node.dataset.kind = it.kind;
  node.setAttribute('role', 'option');
  node.setAttribute('aria-selected', 'false');
  const glyph = el('span', 'pal-icon');
  if (it.favicon) {
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    img.src = it.favicon;
    glyph.append(img);
  } else {
    glyph.append(icon(it.icon));
  }
  node.append(glyph, el('span', 'pal-title', it.title), el('span', 'pal-sub', it.sub || ''), el('span', 'pal-kind', KIND_LABEL[it.kind] || ''));
  return node;
}

// Rebuilds the list from items. Sections are flat siblings of the items (markup contract).
function render() {
  items = buildItems();
  if (index >= items.length) index = Math.max(0, items.length - 1);
  const frag = document.createDocumentFragment();
  nodes = [];
  let section = null;
  items.forEach((it, i) => {
    if (it.section !== section) {
      section = it.section;
      frag.append(el('div', 'pal-section', section));
    }
    const node = buildNode(it, i);
    nodes.push(node);
    frag.append(node);
  });
  list.replaceChildren(frag);
  empty.hidden = items.length > 0 || pending;
  setIndex(index, false);
}

function setIndex(i, scroll) {
  if (!nodes.length) {
    index = 0;
    return;
  }
  index = Math.max(0, Math.min(nodes.length - 1, i));
  for (let n = 0; n < nodes.length; n++) {
    const on = n === index;
    if (nodes[n].classList.contains('selected') !== on) {
      nodes[n].classList.toggle('selected', on);
      nodes[n].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }
  if (scroll) nodes[index].scrollIntoView({ block: 'nearest' });
}

function scheduleQuery(delay) {
  clearTimeout(timer);
  timer = setTimeout(runQuery, delay);
}

async function runQuery() {
  timer = 0;
  const my = reqSeq;
  const text = typed;
  pending = true;
  let rows = [];
  try {
    rows = await pure.palette.query(text);
  } catch {
    rows = [];
  }
  if (!open || my !== reqSeq || text !== typed) return;
  pending = false;
  remote = Array.isArray(rows) ? rows : [];
  render();
}

function activate(i) {
  const it = items[i];
  if (!it) return;
  closePalette();
  try {
    it.run();
  } catch {
    // An action that fails must not leave the palette stuck; it is already closed.
  }
}

function setMode(tabs) {
  tabsOnly = tabs;
  box.classList.toggle('tabs-only', tabs);
  modeChip.hidden = !tabs;
  index = 0;
  render();
  scheduleQuery(0);
}

function openPalette(tabs) {
  claimOverlay('palette');
  open = true;
  tabsOnly = tabs;
  box.classList.add('open');
  box.classList.toggle('tabs-only', tabs);
  modeChip.hidden = !tabs;
  if (!release) release = acquireFreeze();
  typed = '';
  input.value = '';
  remote = [];
  index = 0;
  reqSeq++;
  render();
  input.focus();
  scheduleQuery(0);
}

export function closePalette() {
  if (!open) return;
  open = false;
  reqSeq++;
  clearTimeout(timer);
  timer = 0;
  pending = false;
  box.classList.remove('open', 'tabs-only');
  modeChip.hidden = true;
  list.replaceChildren();
  items = [];
  nodes = [];
  remote = [];
  typed = '';
  input.value = '';
  if (release) {
    release();
    release = null;
  }
}

export function isPaletteOpen() {
  return open;
}

// Ctrl+K (tabs=false) and Ctrl+Shift+A (tabs=true). The same key again closes; the other mode switches.
export function togglePalette(tabs) {
  if (!box || !input) return;
  if (open) {
    if (!!tabs === tabsOnly) closePalette();
    else setMode(!!tabs);
    return;
  }
  openPalette(!!tabs);
}

function onKeydown(e) {
  if (e.isComposing) return;
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      setIndex(index + 1, true);
      break;
    case 'ArrowUp':
      e.preventDefault();
      setIndex(index - 1, true);
      break;
    case 'Enter':
      e.preventDefault();
      activate(index);
      break;
    case 'Escape':
      e.preventDefault();
      closePalette();
      break;
    case 'Backspace':
      // The @tabs chip goes away with an empty field, as in tab-search elsewhere.
      if (tabsOnly && !input.value) {
        e.preventDefault();
        setMode(false);
      }
      break;
    default:
      break;
  }
}

function onInput() {
  typed = input.value;
  index = 0;
  reqSeq++;
  render(); // local entries and filtered remote rows at once; the query refreshes them after 80 ms
  scheduleQuery(DEBOUNCE_MS);
}

function onImgError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.pal-item')) return;
  img.replaceWith(icon('globe'));
}

export function initPalette() {
  if (!box || !input || !list || !empty || !modeChip) return;
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);

  list.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const node = e.target.closest('.pal-item');
    if (node) activate(Number(node.dataset.index));
  });
  list.addEventListener('pointerover', (e) => {
    if (!(e.target instanceof Element)) return;
    const node = e.target.closest('.pal-item');
    if (!node) return;
    const i = Number(node.dataset.index);
    if (i !== index) setIndex(i, false);
  });
  list.addEventListener('error', onImgError, true);

  // Click outside the palette closes it (capture, so a click on the frozen page closes it too).
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!open) return;
      if (e.target instanceof Node && box.contains(e.target)) return;
      closePalette();
    },
    true,
  );
}

registerOverlay('palette', closePalette);
