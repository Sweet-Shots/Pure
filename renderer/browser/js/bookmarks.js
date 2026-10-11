// Bookmarks bar (horizontal, under the toolbar), the address-bar star, the bar toggle, and the bookmark
// sort (settings.bookmarkSort: manual | name | newest | oldest | site).
//
// Display order is derived from S.bookmarks (the stored order is the manual order). Item nodes are cached
// per URL, so a re-sort moves existing nodes instead of rebuilding them. Nothing is built while the bar is
// hidden: the list is rebuilt once when the bar is shown. Pointer drag and Alt+Up/Down only reorder in manual
// mode; the drag does no DOM reads per item after it starts and handles pointer moves once per frame.

import { S, activeTab, on } from './state.js';
import { $, el, pure } from './util.js';
import { isHttpUrl } from './url.js';
import { icon } from './icons.js';

const bar = $('bookmark-sidebar');
const list = $('bookmark-list');
const star = $('btn-bookmark');
const toggleBtn = $('btn-bookmarks-toggle');

const SORT_MODES = ['manual', 'name', 'newest', 'oldest', 'site'];
const DRAG_THRESHOLD = 4; // px a press must travel before it counts as a drag
const EDGE_ZONE = 32; // px from either end of the list where a drag auto-scrolls
const EDGE_STEP = 14; // px scrolled per frame in that zone
const GAP = 4; // list gap (sidebar.css); the drop line sits in the middle of it

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

let mode = 'manual';
let stale = true; // the DOM does not match S.bookmarks + mode yet
let shown = []; // entries in the order last written to the DOM: {url, title, favicon, node}
const entries = new Map(); // url -> entry; nodes are reused across re-sorts
let roverNode = null; // the one item with tabIndex 0 (roving tabindex, so Tab stops once in the bar)
let roverUrl = null;
let focusUrl = null; // url to focus after a keyboard move re-renders the list
let press = null; // { item, id, x, y, moved } from pointerdown until pointerup
let drag = null; // active drag state (manual mode only)
let suppressClick = false; // a press that moved must not also activate the item
let sortSelect = null; // #bookmark-sort (visuals markup); optional

function normalizeMode(v) {
  return SORT_MODES.includes(v) ? v : 'manual';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function titleOf(bm) {
  return bm.title || bm.url;
}

// Display order. Ties keep the manual order (Array.prototype.sort is stable).
function sortedBookmarks() {
  const items = S.bookmarks.slice();
  switch (mode) {
    case 'name':
      return items.sort((a, b) => collator.compare(titleOf(a), titleOf(b)));
    case 'newest':
      return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    case 'oldest':
      return items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    case 'site': {
      const hosts = new Map();
      for (const b of items) hosts.set(b, hostOf(b.url));
      return items.sort((a, b) => collator.compare(hosts.get(a), hosts.get(b)) || collator.compare(titleOf(a), titleOf(b)));
    }
    default:
      return items;
  }
}

function buildItem(bm) {
  const item = el('div', 'bookmark-item');
  item.dataset.url = bm.url;
  item.tabIndex = -1;
  if (bm.favicon) {
    const img = el('img', 'bookmark-favicon');
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';
    img.src = bm.favicon;
    item.append(img);
  } else {
    item.append(icon('globe', 'bookmark-favicon'));
  }
  item.append(el('span', 'bookmark-title', titleOf(bm)));
  const del = el('button', 'bookmark-delete');
  del.append(icon('x'));
  del.type = 'button';
  del.tabIndex = -1; // reached with the Delete key instead, so Tab does not visit every bookmark
  del.title = 'Delete bookmark';
  del.setAttribute('aria-label', 'Delete bookmark');
  item.append(del);
  return item;
}

function pickRover() {
  const entry = (roverUrl && entries.get(roverUrl)) || shown[0] || null;
  const node = entry ? entry.node : null;
  if (node === roverNode) return;
  if (roverNode) roverNode.tabIndex = -1;
  roverNode = node;
  roverUrl = entry ? entry.url : null;
  if (node) node.tabIndex = 0;
}

// Writes the DOM only when the displayed entries changed (a drop and its bookmarks:changed echo cost nothing).
function render() {
  if (drag) {
    stale = true; // the dragged nodes must stay put until the drop
    return;
  }
  if (!S.settings.showBookmarksBar) {
    stale = true; // built the next time the bar is shown
    return;
  }
  stale = false;

  const ordered = sortedBookmarks();
  const next = [];
  const live = new Set();
  let changed = ordered.length !== shown.length;
  for (let i = 0; i < ordered.length; i++) {
    const bm = ordered[i];
    live.add(bm.url);
    let entry = entries.get(bm.url);
    if (!entry || entry.title !== bm.title || entry.favicon !== bm.favicon) {
      entry = { url: bm.url, title: bm.title, favicon: bm.favicon, node: buildItem(bm) };
      entries.set(bm.url, entry);
    }
    if (!changed && shown[i] !== entry) changed = true;
    next.push(entry);
  }
  if (!changed) return;

  for (const url of entries.keys()) if (!live.has(url)) entries.delete(url);
  shown = next;
  // Read the scroll position before the DOM changes; a re-render keeps it.
  const sc = scrollerOf();
  const at = sc.scrollLeft;
  syncDom(next);
  if (at && sc.scrollLeft !== at) sc.scrollLeft = at;
  pickRover();

  if (focusUrl) {
    const entry = entries.get(focusUrl);
    focusUrl = null;
    if (entry) {
      entry.node.focus({ preventScroll: true });
      entry.node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

// Makes the list hold exactly `next` in order, touching only what changed: stale nodes are removed and each
// node that is out of place is moved (a single added bookmark costs one insert, not a rebuild).
function syncDom(next) {
  const want = new Set();
  for (const entry of next) want.add(entry.node);
  for (const node of Array.from(list.children)) if (!want.has(node)) node.remove();
  let ref = list.firstElementChild;
  for (const entry of next) {
    if (entry.node === ref) ref = ref.nextElementSibling;
    else list.insertBefore(entry.node, ref);
  }
}

function syncSortUi() {
  list.dataset.sort = mode;
  if (!sortSelect) return;
  if (sortSelect.value !== mode) sortSelect.value = mode;
  const tip = mode === 'manual' ? 'Bookmark order: drag to reorder' : 'Switch to Manual to drag bookmarks';
  if (sortSelect.title !== tip) sortSelect.title = tip;
}

function refreshStar() {
  const t = activeTab();
  const url = t ? t.url : '';
  star.classList.toggle('active', isHttpUrl(url) && S.bookmarks.some((b) => b.url === url));
}

function removeBookmark(url) {
  const bm = S.bookmarks.find((b) => b.url === url);
  if (!window.confirm(`Remove "${(bm && bm.title) || 'this bookmark'}" from bookmarks?`)) return;
  pure.bookmarks.remove(url);
}

function openItem(url, background) {
  if (background) {
    pure.tabs.create({ url, active: false });
    return;
  }
  const t = activeTab();
  if (t) pure.tabs.navigate(t.id, url);
  else pure.tabs.create({ url });
}

// Returns the list with `urls` applied first (unknown urls skipped), then the leftovers in their old order.
// Mirrors bookmarks.reorder in main/storage.js so the local copy matches the broadcast that follows.
function applyOrder(items, urls) {
  const byUrl = new Map(items.map((b) => [b.url, b]));
  const out = [];
  const used = new Set();
  for (const u of urls) {
    const b = byUrl.get(u);
    if (b && !used.has(u)) {
      used.add(u);
      out.push(b);
    }
  }
  for (const b of items) if (!used.has(b.url)) out.push(b);
  return out;
}

function onClick(e) {
  if (suppressClick) return;
  const item = e.target.closest('.bookmark-item');
  if (!item) return;
  const url = item.dataset.url;
  if (e.target.closest('.bookmark-delete')) {
    removeBookmark(url);
    return;
  }
  openItem(url, e.ctrlKey || e.metaKey);
}

function onAux(e) {
  if (e.button !== 1 || e.target.closest('.bookmark-delete')) return;
  const item = e.target.closest('.bookmark-item');
  if (!item) return;
  e.preventDefault();
  openItem(item.dataset.url, true);
}

function onFavError(e) {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('bookmark-favicon')) img.replaceWith(icon('globe', 'bookmark-favicon'));
}

function scrollerOf() {
  return bar.scrollWidth > bar.clientWidth || bar.scrollHeight > bar.clientHeight ? bar : list;
}

function onWheel(e) {
  e.preventDefault();
  const sc = scrollerOf();
  sc.scrollLeft += (e.deltaY || e.deltaX) * 0.8;
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function focusItem(item) {
  if (item) item.focus();
}

function moveFocused(item, delta) {
  const url = item.dataset.url;
  const from = S.bookmarks.findIndex((b) => b.url === url);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= S.bookmarks.length) return;
  const next = S.bookmarks.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  S.bookmarks = next;
  focusUrl = url;
  render();
  pure.bookmarks.reorder(next.map((b) => b.url)).catch(() => {});
}

function onKeyDown(e) {
  const target = e.target;
  if (!(target instanceof Element) || target.closest('.bookmark-delete')) return;
  const item = target.closest('.bookmark-item');
  if (!item) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    if (mode === 'manual') moveFocused(item, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      focusItem(item.previousElementSibling);
      break;
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault();
      focusItem(item.nextElementSibling);
      break;
    case 'Enter':
      e.preventDefault();
      openItem(item.dataset.url, false);
      break;
    case 'Delete':
      e.preventDefault();
      removeBookmark(item.dataset.url);
      break;
    default:
      break;
  }
}

function onFocusIn(e) {
  const target = e.target;
  const item = target instanceof Element ? target.closest('.bookmark-item') : null;
  if (!item || item === roverNode) return;
  if (roverNode) roverNode.tabIndex = -1;
  roverNode = item;
  roverUrl = item.dataset.url;
  item.tabIndex = 0;
}

// ── Pointer drag (manual mode) ────────────────────────────────────────────────
// Between pointerdown and pointerup the window listens for pointermove. Positions are measured once when the
// drag starts; each frame only moves the dragged item (transform) and the indicator. Coordinates are kept in
// "content" units along the axis: offset from the list's start plus the list's scroll position, so the drag
// stays correct while the list auto-scrolls near its ends.

function onPointerDown(e) {
  if (e.button !== 0) return;
  // A press whose pointerup never arrived is cancelled (no reorder) before the new one starts.
  if (press) onPointerEnd({ type: 'pointercancel', pointerId: press.id });
  const target = e.target;
  if (!(target instanceof Element)) return;
  const item = target.closest('.bookmark-item');
  if (!item || target.closest('.bookmark-delete')) return;
  press = { item, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
}

function beginDrag(e) {
  const item = press.item;
  const vert = getComputedStyle(list).flexDirection === 'column';
  const sc = scrollerOf();
  const rect = sc.getBoundingClientRect();
  const scroll0 = vert ? sc.scrollTop : sc.scrollLeft;
  // The dragged item is translated past the content, which widens the scrollable area; auto-scroll must not
  // chase that growth, so it is capped at the range measured before the drag.
  const maxScroll = vert ? sc.scrollHeight - sc.clientHeight : sc.scrollWidth - sc.clientWidth;
  const nodes = Array.from(list.children);
  const n = nodes.length;
  const pos = new Float64Array(n);
  const size = new Float64Array(n);
  let from = -1;
  for (let i = 0; i < n; i++) {
    const r = nodes[i].getBoundingClientRect();
    pos[i] = (vert ? r.top - rect.top : r.left - rect.left) + scroll0;
    size[i] = vert ? r.height : r.width;
    if (nodes[i] === item) from = i;
  }
  if (from < 0) return;

  // The drop line is appended to the bar, position: fixed (sidebar.css); placeIndicator sets its box inline.
  const ind = el('div', 'bm-drop-indicator');
  ind.style.display = 'none';
  bar.append(ind);
  item.classList.add('bm-dragging');
  list.classList.add('bm-drag-active');
  list.style.userSelect = 'none';
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  try {
    list.setPointerCapture(press.id);
  } catch {
    // Pointer capture is a nicety: the window listeners still get the moves inside the document.
  }
  drag = {
    item,
    id: press.id,
    vert,
    sc,
    maxScroll,
    rect,
    from,
    n,
    nodes,
    pos,
    size,
    scroll0,
    startP: vert ? press.y : press.x, // anchored at the press, so the item stays under the pointer
    px: e.clientX,
    py: e.clientY,
    t: 0,
    k: from,
    raf: 0,
    ind,
  };
}

function onPointerMove(e) {
  if (!press || e.pointerId !== press.id) return;
  if (!press.moved) {
    if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < DRAG_THRESHOLD) return;
    press.moved = true;
    suppressClick = true;
    if (mode === 'manual') beginDrag(e);
  }
  if (!drag) return;
  drag.px = e.clientX;
  drag.py = e.clientY;
  if (!drag.raf) drag.raf = requestAnimationFrame(frame);
}

// Index among the other items (the dragged one excluded) where the dragged item would be inserted.
function dragOtherIndex(d, j) {
  return j < d.from ? j : j + 1;
}

function insertionIndex(d, center) {
  let lo = 0;
  let hi = d.n - 1; // there are n - 1 other items
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const idx = dragOtherIndex(d, mid);
    const c = d.pos[idx] + d.size[idx] / 2;
    if (c < center) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Puts the drop line in the gap at the drop slot, inside the bar's visible area (hidden at the original slot).
function placeIndicator(d, scroll) {
  const k = d.k;
  const m = d.n - 1;
  let boundary = NaN;
  if (k !== d.from && m > 0) {
    if (k < m) {
      const idx = dragOtherIndex(d, k);
      boundary = d.pos[idx] - GAP / 2;
    } else {
      const idx = dragOtherIndex(d, m - 1);
      boundary = d.pos[idx] + d.size[idx] + GAP / 2;
    }
  }
  const lo = d.vert ? d.rect.top : d.rect.left;
  const hi = d.vert ? d.rect.bottom : d.rect.right;
  const v = lo + boundary - scroll; // viewport coordinate of the slot
  const ind = d.ind;
  if (!(v >= lo + 2 && v <= hi - 2)) {
    ind.style.display = 'none';
    return;
  }
  ind.style.display = '';
  if (d.vert) {
    ind.style.left = `${d.rect.left + 4}px`;
    ind.style.top = `${v - 1}px`;
    ind.style.width = `${Math.max(0, d.rect.width - 8)}px`;
    ind.style.height = '2px';
  } else {
    ind.style.left = `${v - 1}px`;
    ind.style.top = `${d.rect.top + 4}px`;
    ind.style.width = '2px';
    ind.style.height = `${Math.max(0, d.rect.height - 8)}px`;
  }
}

function frame() {
  const d = drag;
  if (!d) return;
  d.raf = 0;
  const lo = d.vert ? d.rect.top : d.rect.left;
  const hi = d.vert ? d.rect.bottom : d.rect.right;
  const p = d.vert ? d.py : d.px;
  const before = d.vert ? d.sc.scrollTop : d.sc.scrollLeft;

  let step = 0;
  if (p < lo + EDGE_ZONE) step = -EDGE_STEP;
  else if (p > hi - EDGE_ZONE) step = EDGE_STEP;
  if (step) {
    const next = Math.min(d.maxScroll, Math.max(0, before + step));
    if (d.vert) d.sc.scrollTop = next;
    else d.sc.scrollLeft = next;
  }
  const scroll = d.vert ? d.sc.scrollTop : d.sc.scrollLeft;
  // Keep scrolling while the pointer rests at an edge; stop when the bar cannot scroll further.
  if (step && scroll !== before) d.raf = requestAnimationFrame(frame);
  layout(d, scroll);
}

// Places the dragged item under the pointer and works out the drop slot for the latest pointer position.
// Runs once per frame, and once more on pointerup so a release that comes before the next frame still drops
// where the pointer is.
function layout(d, scroll) {
  const p = d.vert ? d.py : d.px;
  const t = p - d.startP + (scroll - d.scroll0);
  if (t !== d.t) {
    d.t = t;
    d.item.style.transform = d.vert ? `translateY(${t}px)` : `translateX(${t}px)`;
  }
  const center = d.pos[d.from] + d.size[d.from] / 2 + t;
  d.k = insertionIndex(d, center);
  placeIndicator(d, scroll);
}

function endDragVisuals(d) {
  if (d.raf) cancelAnimationFrame(d.raf);
  d.item.style.transform = '';
  d.item.classList.remove('bm-dragging');
  list.classList.remove('bm-drag-active');
  d.ind.remove();
  list.style.userSelect = '';
  try {
    list.releasePointerCapture(d.id);
  } catch {
    // Already released.
  }
}

function commitMove(d) {
  const urls = S.bookmarks.map((b) => b.url);
  // Positions were measured on the DOM order, which is the manual order; apply the move to that order.
  const dragged = d.item.dataset.url;
  const from = urls.indexOf(dragged);
  if (from < 0) return;
  urls.splice(from, 1);
  urls.splice(d.k, 0, dragged);
  S.bookmarks = applyOrder(S.bookmarks, urls);
  render();
  pure.bookmarks.reorder(urls).catch(() => {});
}

function onPointerEnd(e) {
  if (!press || e.pointerId !== press.id) return;
  const d = drag;
  press = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerEnd);
  window.removeEventListener('pointercancel', onPointerEnd);
  // The click that follows a release is dispatched in the same task; clear the guard afterwards.
  setTimeout(() => {
    suppressClick = false;
  }, 0);
  if (!d) return;
  if (e.type === 'pointerup' && mode === 'manual') layout(d, d.vert ? d.sc.scrollTop : d.sc.scrollLeft);
  drag = null;
  endDragVisuals(d);
  if (e.type === 'pointerup' && mode === 'manual' && d.k !== d.from) commitMove(d);
  if (stale) render();
}

// ── Public API ────────────────────────────────────────────────────────────────

function onSortChange() {
  const v = normalizeMode(sortSelect.value);
  if (v === S.settings.bookmarkSort) return;
  S.settings.bookmarkSort = v;
  pure.settings.set({ bookmarkSort: v }).catch(() => {});
  applyBookmarksBar();
}

export function applyBookmarksBar() {
  const visible = !!S.settings.showBookmarksBar;
  bar.classList.toggle('active', visible);
  toggleBtn.classList.toggle('active', visible);
  const next = normalizeMode(S.settings.bookmarkSort);
  if (next !== mode) {
    mode = next;
    stale = true;
  }
  syncSortUi();
  if (visible && stale) render();
}

export function toggleBookmarksBar() {
  const next = !S.settings.showBookmarksBar;
  S.settings.showBookmarksBar = next;
  applyBookmarksBar();
  pure.settings.set({ showBookmarksBar: next });
}

// Bookmark the active page (http/https only). Ctrl+D arrives here as the 'toggle-bookmark' command.
export function toggleActiveBookmark() {
  const t = activeTab();
  if (!t || !isHttpUrl(t.url)) return;
  pure.bookmarks
    .toggle({ url: t.url, title: t.title || t.url, favicon: t.favicon || '' })
    .then((now) => star.classList.toggle('active', !!now))
    .catch(() => {});
}

// bookmarks.list() / bookmarks.onChanged payload (the stored order is the manual order).
export function setBookmarks(items) {
  S.bookmarks = Array.isArray(items) ? items : [];
  render();
  refreshStar();
}

export function initBookmarks() {
  sortSelect = $('bookmark-sort');
  list.addEventListener('click', onClick);
  list.addEventListener('auxclick', onAux);
  list.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  list.addEventListener('error', onFavError, true);
  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('keydown', onKeyDown);
  list.addEventListener('focusin', onFocusIn);
  bar.addEventListener('wheel', onWheel, { passive: false });
  star.addEventListener('click', toggleActiveBookmark);
  toggleBtn.addEventListener('click', toggleBookmarksBar);
  if (sortSelect) sortSelect.addEventListener('change', onSortChange);
  on('active', refreshStar);
  on('activeupdate', (_t, p) => {
    if ('url' in p) refreshStar();
  });
  refreshStar();
  applyBookmarksBar();
}
