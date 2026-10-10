// Focus mode (settings.focusMode): html.focus-mode collapses the chrome; the 4 px #focus-reveal strip
// at the top stays, and hovering it (or the chrome while it is shown) adds html.focus-reveal.
// Leaving the chrome removes it after 700 ms, unless an overlay or the address bar still needs it.
// Vertical tabs (html.vertical-tabs) are applied from app.js through tabs.js.

import { S } from './state.js';
import { $ } from './util.js';
import { isAddressFocused } from './address-bar.js';

const LEAVE_DELAY_MS = 700;
const root = document.documentElement;
const reveal = $('focus-reveal');
const CHROME_IDS = ['titlebar', 'toolbar', 'bookmark-sidebar', 'findbar', 'statusbar'];
const OVERLAY_SELECTOR = '#palette.open, #site-popover.open, #group-editor.open, #shield-popover.open, #suggestions.open';

let leaveTimer = 0;

function holdsReveal() {
  if (isAddressFocused() || document.body.classList.contains('find-open')) return true;
  return !!document.querySelector(OVERLAY_SELECTOR);
}

function show() {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = 0;
  }
  if (!root.classList.contains('focus-reveal')) root.classList.add('focus-reveal');
}

function scheduleHide() {
  if (!root.classList.contains('focus-mode') || leaveTimer) return;
  leaveTimer = setTimeout(() => {
    leaveTimer = 0;
    if (holdsReveal()) return;
    root.classList.remove('focus-reveal');
  }, LEAVE_DELAY_MS);
}

// settings.focusMode (called from app.js on every settings snapshot).
export function applyFocusMode() {
  const on = !!S.settings.focusMode;
  root.classList.toggle('focus-mode', on);
  if (!on) {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = 0;
    }
    root.classList.remove('focus-reveal');
  }
}

export function initFocus() {
  if (reveal) {
    reveal.addEventListener('pointerenter', show);
    reveal.addEventListener('pointerleave', scheduleHide);
  }
  for (const id of CHROME_IDS) {
    const node = $(id);
    if (!node) continue;
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointerleave', scheduleHide);
  }
  applyFocusMode();
}
