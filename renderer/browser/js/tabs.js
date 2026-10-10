// Tab strip: keyed rendering of .tab nodes and group chips, click/middle/context/wheel handling,
// and pointer drag. Tab state arrives from main through app.js (addTab/updateTab/removeTab/...).
// This module keeps S.tabs / S.order / S.activeKey in sync and only touches DOM nodes that changed.
// Vertical tabs (html.vertical-tabs): the same code runs on the Y axis.

import { S, key, emit, homeUrl, on } from './state.js';
import { $, el, pure, setText } from './util.js';
import { isHomeUrl, isSettingsUrl } from './url.js';
import { icon } from './icons.js';
import { getGroup, createChip, updateChip, groupColorValue } from './groups.js';

const strip = $('tabs');
const scroller = $('tabs-scroll');
const dropEl = $('tab-drop-indicator');
const recs = new Map(); // String(id) -> { k, node, wrap, title, close, audio, sleep, dot, img, lastFavicon, favFailed, fb, fbName, gid, hex }
const chips = new Map(); // String(groupId) -> button.tab-group

const DRAG_THRESHOLD_PX = 5;
const DETACH_BELOW_PX = 60;

let dragging = false; // while true the drag owns the DOM order; renderStrip() will not reorder
let press = null; // pointer state from pointerdown until pointerup / pointercancel
let justDragged = false; // swallows the click that can follow a drag
let vertical = false; // html.vertical-tabs

// ── Rendering ────────────────────────────────────────────

function titleFor(t) {
  if (isHomeUrl(t.url)) return 'Home';
  if (isSettingsUrl(t.url)) return 'Settings';
  return t.title || t.url || 'New Tab';
}

// Tab nodes only (chips are children of the strip too).
function tabNodes() {
  return Array.from(strip.children).filter((n) => n.classList.contains('tab'));
}

function createRec(k) {
  const node = el('div', 'tab');
  node.dataset.tabId = k;
  const wrap = el('div', 'tab-favicon-wrapper');
  const title = el('span', 'tab-title');
  const close = el('button', 'tab-close');
  close.append(icon('x'));
  close.type = 'button';
  close.title = 'Close tab';
  close.setAttribute('aria-label', 'Close tab');
  node.append(wrap, title, close);
  return {
    k,
    node,
    wrap,
    title,
    close,
    audio: null,
    sleep: null,
    dot: null,
    img: null,
    lastFavicon: null,
    favFailed: null,
    fb: null,
    fbName: '',
    gid: null,
    hex: '',
  };
}

function dropImg(rec) {
  if (rec.img) {
    rec.img.remove();
    rec.img = null;
  }
}

// Fallback glyph shown in place of a favicon: globe for plain pages, alert for error/crashed tabs.
// Swapped only when the wanted glyph changes, so frequent tab events do not touch the DOM.
function setFallback(rec, glyph) {
  if (rec.fbName === glyph) return;
  if (rec.fb) rec.fb.remove();
  rec.fb = null;
  rec.fbName = glyph;
  if (glyph) {
    rec.fb = icon(glyph, `tab-fallback tab-fallback-${glyph}`);
    rec.wrap.append(rec.fb);
  }
}

function updateFavicon(rec, t) {
  const home = isHomeUrl(t.url);
  const failed = !home && (!!t.crashed || t.security === 'error');
  const fav = home || failed ? '' : t.favicon || '';
  if (fav !== rec.lastFavicon) {
    rec.lastFavicon = fav;
    rec.favFailed = null;
  }
  const showImg = !home && !!fav && rec.favFailed !== fav;
  rec.wrap.classList.toggle('homepage-dot', home);
  rec.wrap.classList.toggle('loading', !home && !!t.isLoading);
  rec.wrap.classList.toggle('no-favicon', !home && !showImg);
  setFallback(rec, home || showImg ? '' : failed ? 'triangle-alert' : 'globe');

  if (home) {
    dropImg(rec);
    if (!rec.dot) {
      rec.dot = el('div', 'tab-dot');
      rec.wrap.append(rec.dot);
    }
    return;
  }
  if (rec.dot) {
    rec.dot.remove();
    rec.dot = null;
  }
  if (!showImg) {
    dropImg(rec);
    return;
  }
  if (!rec.img) {
    rec.img = el('img', 'tab-favicon');
    rec.img.alt = '';
    rec.img.draggable = false;
    rec.wrap.append(rec.img);
  }
  if (rec.img.getAttribute('src') !== fav) rec.img.setAttribute('src', fav);
}

function updateAudio(rec, t) {
  const show = !!(t.isAudible || t.isMuted);
  if (show && !rec.audio) {
    rec.audio = el('button', 'tab-audio');
    rec.audio.type = 'button';
    rec.node.insertBefore(rec.audio, rec.close);
  } else if (!show && rec.audio) {
    rec.audio.remove();
    rec.audio = null;
    return;
  }
  if (!rec.audio) return;
  rec.audio.classList.toggle('muted', !!t.isMuted);
  const glyph = t.isMuted ? 'volume-x' : 'volume-2';
  if (rec.audio.dataset.icon !== glyph) {
    rec.audio.dataset.icon = glyph;
    rec.audio.replaceChildren(icon(glyph));
  }
  const audioLabel = t.isMuted ? 'Unmute tab' : 'Mute tab';
  if (rec.audio.title !== audioLabel) {
    rec.audio.title = audioLabel;
    rec.audio.setAttribute('aria-label', audioLabel);
  }
}

function updateSleep(rec, t) {
  const show = !!t.isDiscarded;
  if (show && !rec.sleep) {
    rec.sleep = icon('moon', 'tab-sleeping', 'Tab sleeping');
    rec.node.insertBefore(rec.sleep, rec.close);
  } else if (!show && rec.sleep) {
    rec.sleep.remove();
    rec.sleep = null;
  }
}

// Group membership: data-group-id + --group-color on the tab; hidden while its group is collapsed
// (the active tab is never hidden: main expands the group on activate).
function applyGroup(rec, t) {
  const g = getGroup(t.groupId);
  const gid = g ? String(g.id) : '';
  if (rec.gid !== gid) {
    rec.gid = gid;
    if (gid) rec.node.dataset.groupId = gid;
    else delete rec.node.dataset.groupId;
  }
  const hex = g ? groupColorValue(g.color) : '';
  if (rec.hex !== hex) {
    rec.hex = hex;
    if (hex) rec.node.style.setProperty('--group-color', hex);
    else rec.node.style.removeProperty('--group-color');
  }
  const hide = !!(g && g.collapsed) && rec.k !== S.activeKey;
  if (rec.node.hidden !== hide) rec.node.hidden = hide;
}

function updateRec(rec, t) {
  rec.node.classList.toggle('active', rec.k === S.activeKey);
  rec.node.classList.toggle('discarded', !!t.isDiscarded);
  rec.node.classList.toggle('crashed', !!t.crashed);
  setText(rec.title, titleFor(t));
  updateFavicon(rec, t);
  updateAudio(rec, t);
  updateSleep(rec, t);
  applyGroup(rec, t);
}

function renderOne(k) {
  const rec = recs.get(k);
  const t = S.tabs.get(k);
  if (rec && t) updateRec(rec, t);
}

// Keyed diff: creates/removes only the nodes that changed, updates content in place, and moves
// a node only when it is out of place relative to the wanted order. A group's chip sits directly
// before the first tab of that group in S.order.
function renderStrip() {
  const live = new Set(S.order);
  for (const [k, rec] of recs) {
    if (!live.has(k)) {
      rec.node.remove();
      recs.delete(k);
    }
  }
  for (const k of S.order) {
    let rec = recs.get(k);
    if (!rec) {
      rec = createRec(k);
      recs.set(k, rec);
    }
    const t = S.tabs.get(k);
    if (t) updateRec(rec, t);
  }

  const want = [];
  const shown = new Set();
  const counts = new Map(); // member tabs per group (data-count on collapsed chips)
  for (const k of S.order) {
    const t = S.tabs.get(k);
    const g = t ? getGroup(t.groupId) : null;
    if (g) counts.set(String(g.id), (counts.get(String(g.id)) || 0) + 1);
  }
  for (const k of S.order) {
    const rec = recs.get(k);
    if (!rec) continue;
    const t = S.tabs.get(k);
    const g = t ? getGroup(t.groupId) : null;
    if (g) {
      const gid = String(g.id);
      if (!shown.has(gid)) {
        shown.add(gid);
        let chip = chips.get(gid);
        if (!chip) {
          chip = createChip(gid);
          chips.set(gid, chip);
        }
        updateChip(chip, g, counts.get(gid) || 0);
        want.push(chip);
      }
    }
    want.push(rec.node);
  }
  for (const [gid, chip] of chips) {
    if (!shown.has(gid)) {
      chip.remove();
      chips.delete(gid);
    }
  }

  if (dragging) return;
  let ref = strip.firstElementChild;
  for (const node of want) {
    if (node === ref) ref = ref.nextElementSibling;
    else strip.insertBefore(node, ref);
  }
}

function scrollActiveIntoView() {
  const rec = S.activeKey != null ? recs.get(S.activeKey) : null;
  if (!rec) return;
  const r = rec.node.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  if (vertical) {
    if (r.top < s.top) scroller.scrollTop -= s.top - r.top;
    else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom;
  } else if (r.left < s.left) {
    scroller.scrollLeft -= s.left - r.left;
  } else if (r.right > s.right) {
    scroller.scrollLeft += r.right - s.right;
  }
}

// Makes k the active tab locally and notifies listeners. Does not talk to main.
function changeActive(k) {
  const prev = S.activeKey;
  if (k === prev) return;
  S.activeKey = k;
  if (prev != null) renderOne(prev);
  if (k != null) renderOne(k);
  scrollActiveIntoView();
  emit('active', prev);
}

function tabFromNode(node) {
  return node ? S.tabs.get(node.dataset.tabId) : undefined;
}

// html.vertical-tabs from settings (app.js). Drag and wheel switch axis; the strip is restyled by CSS.
export function applyVerticalTabs(on) {
  vertical = !!on;
  document.documentElement.classList.toggle('vertical-tabs', vertical);
  if (dropEl) dropEl.classList.remove('visible');
  scrollActiveIntoView();
}

// ── State changes from main (called by app.js) ────────────

// tabs.list() snapshot. Authoritative for order and for which tabs exist.
export function applyTabList(list) {
  const items = Array.isArray(list) ? list : [];
  const order = [];
  const seen = new Set();
  for (const t of items) {
    const k = key(t.id);
    if (seen.has(k)) continue;
    seen.add(k);
    order.push(k);
    S.tabs.set(k, { ...(S.tabs.get(k) || {}), ...t });
  }
  for (const k of [...S.tabs.keys()]) if (!seen.has(k)) S.tabs.delete(k);
  S.order = order;
  const active = items.find((t) => t.active);
  if (active) S.activeKey = key(active.id);
  else if (!seen.has(S.activeKey)) S.activeKey = order[0] ?? null;
  renderStrip();
  scrollActiveIntoView();
  emit('active', null);
}

export function addTab(t) {
  const k = key(t.id);
  const isNew = !S.tabs.has(k);
  S.tabs.set(k, { ...(S.tabs.get(k) || {}), ...t });
  if (isNew) {
    const n = S.order.length;
    const at = typeof t.index === 'number' ? Math.min(Math.max(t.index, 0), n) : n;
    S.order.splice(at, 0, k);
    renderStrip();
  } else if ('groupId' in t) {
    renderStrip();
  } else {
    renderOne(k);
  }
  if (t.active) changeActive(k);
}

export function updateTab(p) {
  const k = key(p.id);
  const cur = S.tabs.get(k);
  if (!cur) return;
  const merged = { ...cur, ...p };
  S.tabs.set(k, merged);
  if ('groupId' in p) renderStrip();
  else renderOne(k);
  if (k === S.activeKey) emit('activeupdate', merged, p);
}

export function removeTab(id) {
  const k = key(id);
  if (!S.tabs.has(k)) return;
  const idx = S.order.indexOf(k);
  const wasActive = S.activeKey === k;
  S.tabs.delete(k);
  if (idx >= 0) S.order.splice(idx, 1);
  renderStrip();
  if (!wasActive) return;
  // Same neighbour choice as 1.1.1 (tabs[max(0, index - 1)]). Main's activated event corrects it if needed.
  S.activeKey = null;
  const next = S.order[Math.max(0, idx - 1)];
  if (next != null) changeActive(next);
  else emit('active', k);
}

export function setActiveFromMain(id) {
  const k = key(id);
  if (S.tabs.has(k)) changeActive(k);
}

export function moveTabs(ids) {
  const want = [];
  const set = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    const k = key(id);
    if (S.tabs.has(k) && !set.has(k)) {
      set.add(k);
      want.push(k);
    }
  }
  S.order = [...want, ...S.order.filter((k) => !set.has(k))];
  renderStrip();
}

// ── Interaction ───────────────────────────────────────────

function onClick(e) {
  if (justDragged) return;
  const t = tabFromNode(e.target.closest('.tab'));
  if (!t) return;
  if (e.target.closest('.tab-close')) {
    pure.tabs.close(t.id);
  } else if (e.target.closest('.tab-audio')) {
    pure.tabs.toggleMute(t.id);
  } else {
    changeActive(key(t.id));
    pure.tabs.activate(t.id);
  }
}

function onAux(e) {
  if (e.button !== 1) return;
  const t = tabFromNode(e.target.closest('.tab'));
  if (!t) return;
  e.preventDefault();
  pure.tabs.close(t.id);
}

function onContext(e) {
  const t = tabFromNode(e.target.closest('.tab'));
  if (!t) return;
  e.preventDefault();
  pure.tabs.showContextMenu(t.id);
}

function onDblClick(e) {
  if (e.target === scroller || e.target === strip) pure.tabs.create({ url: homeUrl() });
}

function onWheel(e) {
  e.preventDefault();
  const d = (e.deltaY || e.deltaX) * 0.8;
  if (vertical) scroller.scrollTop += d;
  else scroller.scrollLeft += d;
}

function onMouseDown(e) {
  // Middle button must not start autoscroll; it closes the tab on auxclick instead.
  if (e.button === 1) e.preventDefault();
}

function onFavError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('tab-favicon')) return;
  const rec = recs.get(img.closest('.tab')?.dataset.tabId);
  if (!rec) return;
  rec.favFailed = img.getAttribute('src');
  dropImg(rec);
  rec.wrap.classList.add('no-favicon');
  setFallback(rec, 'globe');
}

// ── Drag reorder and detach (pointer events, not HTML5 DnD) ───

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.tab-close, .tab-audio')) return;
  const node = e.target.closest('.tab');
  if (!node) return;
  press = {
    k: node.dataset.tabId,
    node,
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    started: false,
    start: -1,
    mids: null,
  };
}

function beginDrag(e) {
  const p = press;
  p.started = true;
  dragging = true;
  p.node.classList.add('dragging');
  try {
    strip.setPointerCapture(e.pointerId);
  } catch (_) {
    // Capture is an optimisation for leaving the strip; the drag still works without it.
  }
  const all = tabNodes();
  p.start = all.indexOf(p.node);
  // Midpoints are snapshotted at drag start so live reordering does not oscillate.
  p.mids = new Map();
  for (const n of all) {
    if (n === p.node || n.hidden) continue;
    const r = n.getBoundingClientRect();
    p.mids.set(n, vertical ? r.top + r.height / 2 : r.left + r.width / 2);
  }
}

function showDrop(i, others) {
  if (!dropEl) return;
  dropEl.classList.toggle('vertical', vertical);
  if (vertical) {
    const sr = scroller.getBoundingClientRect();
    let y;
    if (!others.length) y = sr.top;
    else if (i < others.length) y = others[i].getBoundingClientRect().top;
    else y = others[others.length - 1].getBoundingClientRect().bottom;
    dropEl.style.left = '';
    dropEl.style.top = `${y - sr.top + scroller.scrollTop}px`;
  } else {
    const sr = scroller.getBoundingClientRect();
    let x;
    if (!others.length) x = sr.left;
    else if (i < others.length) x = others[i].getBoundingClientRect().left;
    else x = others[others.length - 1].getBoundingClientRect().right;
    dropEl.style.top = '';
    dropEl.style.left = `${x - sr.left + scroller.scrollLeft}px`;
  }
  dropEl.classList.add('visible');
}

function moveDrag(e) {
  const p = press;
  // Visible tabs only: a collapsed group's tabs have no box to drop beside.
  const others = tabNodes().filter((n) => n !== p.node && !n.hidden);
  const pos = vertical ? e.clientY : e.clientX;
  let i = 0;
  for (const n of others) {
    const mid = p.mids.get(n);
    if (mid !== undefined && pos > mid) i++;
  }
  const ref = others[i] || null;
  if (p.node.nextElementSibling !== ref) strip.insertBefore(p.node, ref);
  showDrop(i, others);
}

function endDrag(p) {
  dragging = false;
  p.node.classList.remove('dragging');
  if (dropEl) dropEl.classList.remove('visible');
}

function onPointerMove(e) {
  if (!press || e.pointerId !== press.pointerId) return;
  if (!press.started) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return;
    beginDrag(e);
  }
  moveDrag(e);
}

function onPointerUp(e) {
  const p = press;
  if (!p || e.pointerId !== p.pointerId) return;
  press = null;
  if (!p.started) return; // plain click: the click handler activates the tab
  endDrag(p);
  justDragged = true;
  setTimeout(() => {
    justDragged = false;
  }, 0);

  const t = S.tabs.get(p.k);
  const sr = scroller.getBoundingClientRect();
  const outsideWindow =
    e.screenX < window.screenX ||
    e.screenX > window.screenX + window.outerWidth ||
    e.screenY < window.screenY ||
    e.screenY > window.screenY + window.outerHeight;
  // Leaving the strip across its cross axis (below it, or beside the column in vertical mode) detaches.
  const offStrip = vertical
    ? e.clientX < sr.left - DETACH_BELOW_PX || e.clientX > sr.right + DETACH_BELOW_PX
    : e.clientY > sr.bottom + DETACH_BELOW_PX;

  if (outsideWindow || offStrip) {
    renderStrip(); // restore the order; main will remove the tab if it moved
    if (t) pure.tabs.detach(t.id, e.screenX, e.screenY);
    return;
  }

  const newOrder = tabNodes().map((n) => n.dataset.tabId);
  if (newOrder.length !== S.order.length) {
    renderStrip();
    return;
  }
  const toIndex = newOrder.indexOf(p.k);
  S.order = newOrder;
  renderStrip();
  if (t && toIndex !== p.start) pure.tabs.move(t.id, toIndex);
}

function onPointerCancel(e) {
  const p = press;
  if (!p || e.pointerId !== p.pointerId) return;
  press = null;
  if (p.started) {
    endDrag(p);
    renderStrip();
  }
}

// ── Setup ─────────────────────────────────────────────────

export function initTabStrip() {
  strip.addEventListener('click', onClick);
  strip.addEventListener('auxclick', onAux);
  strip.addEventListener('contextmenu', onContext);
  strip.addEventListener('pointerdown', onPointerDown);
  strip.addEventListener('error', onFavError, true);
  scroller.addEventListener('wheel', onWheel, { passive: false });
  scroller.addEventListener('mousedown', onMouseDown);
  scroller.addEventListener('dblclick', onDblClick);
  // Window-level so a drag keeps tracking even when the pointer leaves the strip.
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  // Group state changed (groups.js): re-render the chips and the group flags on every tab.
  on('groups', renderStrip);
}
