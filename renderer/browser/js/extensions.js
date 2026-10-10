// Extension toolbar (#ext-actions). Owner: E1.
// Main pushes the Action list (ext:changed); this module keeps one button per extension, updated in place.
// Clicking a button sends its id and rectangle; main opens the extension popup under it.

import { pure, $ } from './util.js';

// Generic puzzle piece for extensions without an icon (lucide "puzzle", ISC).
const FALLBACK_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
      'stroke="#8a8f98" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>' +
      '</svg>'
  );

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

let container = null;
const buttons = new Map(); // extension id -> button

function createButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ext-action';
  btn.dataset.extId = id;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  const badge = document.createElement('span');
  badge.className = 'ext-badge';
  badge.hidden = true;
  btn.append(img, badge);
  return btn;
}

// Writes only what changed (the list is re-sent on every extension change).
function updateButton(btn, action) {
  const title = typeof action.title === 'string' ? action.title.slice(0, 200) : '';
  const label = title || (typeof action.name === 'string' ? action.name.slice(0, 200) : '');
  if (btn.title !== label) btn.title = label;
  if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);

  const img = btn.querySelector('img');
  const src = typeof action.icon === 'string' && action.icon.startsWith('data:image/') ? action.icon : FALLBACK_ICON;
  if (img.getAttribute('src') !== src) img.src = src;

  const badge = btn.querySelector('.ext-badge');
  const badgeText = typeof action.badge === 'string' ? action.badge.slice(0, 4) : '';
  if (badge.textContent !== badgeText) badge.textContent = badgeText;
  badge.hidden = !badgeText;
  const badgeColor = typeof action.badgeColor === 'string' && COLOR_RE.test(action.badgeColor) ? action.badgeColor : '';
  if (badge.style.backgroundColor !== badgeColor) badge.style.backgroundColor = badgeColor;

  btn.classList.toggle('no-popup', !action.hasPopup);
  // chrome.action.disable() greys the button out; a disabled button does nothing when clicked.
  const enabled = action.enabled !== false;
  btn.classList.toggle('disabled', !enabled);
  if (btn.disabled !== !enabled) btn.disabled = !enabled;
}

function render(actions) {
  if (!container) return;
  const list = Array.isArray(actions) ? actions : [];
  const seen = new Set();
  list.forEach((action, index) => {
    if (!action || typeof action.id !== 'string') return;
    seen.add(action.id);
    let btn = buttons.get(action.id);
    if (!btn) {
      btn = createButton(action.id);
      buttons.set(action.id, btn);
    }
    updateButton(btn, action);
    if (container.children[index] !== btn) container.insertBefore(btn, container.children[index] || null);
  });
  for (const [id, btn] of buttons) {
    if (seen.has(id)) continue;
    btn.remove();
    buttons.delete(id);
  }
  container.hidden = buttons.size === 0;
}

// One delegated listener for the whole toolbar.
function onClick(event) {
  const btn = event.target instanceof Element ? event.target.closest('.ext-action') : null;
  if (!btn || !container.contains(btn)) return;
  const id = btn.dataset.extId;
  if (!id || btn.disabled) return;
  const r = btn.getBoundingClientRect();
  // A plain object: DOMRect cannot cross the context bridge.
  pure.extensions.click(id, { x: r.left, y: r.top, width: r.width, height: r.height });
}

export function initExtensions() {
  container = $('ext-actions');
  if (!container || !pure || !pure.extensions) return;
  container.hidden = true;
  container.addEventListener('click', onClick);
  pure.extensions.onChanged(render);
  pure.extensions.actions().then(render).catch(() => {});
}
