// Split view: #split-divider inside #views, placed at the ratio (left = ratio × width − 3 px, width 6 px).
// Pointer drag sets the ratio (rAF-throttled, clamped 0.2–0.8); double-click resets to 0.5.
// State arrives as split:changed ({left, right, ratio, focused} | null).

import { $, pure } from './util.js';

const divider = $('split-divider');
const views = $('views');
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const DIVIDER_PX = 6;

let split = null; // {left, right, ratio, focused} | null
let dragging = false;
let raf = 0;

export function isSplitActive() {
  return split !== null;
}

function clamp(r) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

function position() {
  if (!divider || !views) return;
  if (!split) {
    divider.hidden = true;
    return;
  }
  divider.hidden = false;
  const w = views.getBoundingClientRect().width;
  divider.style.width = `${DIVIDER_PX}px`;
  divider.style.left = `${Math.round(split.ratio * w - DIVIDER_PX / 2)}px`;
}

function queueRatio(ratio) {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    pure.split.setRatio(ratio);
  });
}

function flushRatio() {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  if (split) pure.split.setRatio(split.ratio);
}

// split:changed payload.
function onChanged(s) {
  if (!s || typeof s !== 'object') {
    split = null;
  } else {
    const ratio = typeof s.ratio === 'number' && Number.isFinite(s.ratio) ? clamp(s.ratio) : 0.5;
    split = { left: s.left, right: s.right, ratio, focused: s.focused };
  }
  position();
}

// Boot: the split state is also visible on the tab list (TabState.split), so a restored split shows up
// without waiting for an event. Keeps the last known ratio when one exists.
export function syncSplitFromTabs(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  const has = list.some((t) => t && (t.split === 'left' || t.split === 'right'));
  if (!has) {
    if (split) onChanged(null);
    return;
  }
  if (!split) {
    split = { left: null, right: null, ratio: 0.5, focused: null };
  }
  for (const t of list) {
    if (t && t.split === 'left') split.left = t.id;
    else if (t && t.split === 'right') split.right = t.id;
  }
  position();
}

export function initSplit() {
  if (!divider || !views) return;
  pure.split.onChanged(onChanged);
  // The divider's place depends on #views' width; the page area only changes size on resize.
  const ro = new ResizeObserver(position);
  ro.observe(views);

  divider.addEventListener('pointerdown', (e) => {
    if (!split || e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    try {
      divider.setPointerCapture(e.pointerId);
    } catch (_) {
      // Capture only keeps the drag going outside the divider; it still works without it.
    }
    divider.classList.add('dragging');
  });

  divider.addEventListener('pointermove', (e) => {
    if (!dragging || !split) return;
    const r = views.getBoundingClientRect();
    if (!r.width) return;
    const ratio = clamp((e.clientX - r.left) / r.width);
    split.ratio = ratio;
    position();
    queueRatio(ratio);
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    try {
      divider.releasePointerCapture(e.pointerId);
    } catch (_) {
      // Not captured any more: nothing to release.
    }
    flushRatio();
  };
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);

  divider.addEventListener('dblclick', () => {
    if (!split) return;
    split.ratio = 0.5;
    position();
    pure.split.setRatio(0.5);
  });
}
