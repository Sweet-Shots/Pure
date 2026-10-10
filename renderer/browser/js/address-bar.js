// Address bar: shows the active tab's URL, focus and revert behaviour, Enter/Esc, lock icon.
// While the user is focused in the bar, tab updates never overwrite the text.

import { activeTab, on } from './state.js';
import { $ } from './util.js';
import { displayUrl } from './url.js';
import { navigateInput } from './navigate.js';
import { closeSuggestions, isSuggestionsOpen, moveSelection, pickSelected, queueSuggest } from './suggestions.js';

const input = $('address-bar');
const wrap = $('address-wrap');
const lock = $('lock-icon');
const SECURITY_CLASSES = ['secure', 'insecure', 'internal'];

let focused = false;
let dirty = false; // the user typed and has not navigated or reverted yet

// Lock icon: the security class only when a URL is shown; empty bar / home shows the search glass.
function refreshAddress() {
  const t = activeTab();
  const v = displayUrl(t ? t.url : '');
  lock.classList.remove(...SECURITY_CLASSES);
  if (v && SECURITY_CLASSES.includes(t.security)) lock.classList.add(t.security);
  if (focused) return;
  dirty = false;
  if (input.value !== v) input.value = v;
}

function revert() {
  dirty = false;
  const t = activeTab();
  input.value = displayUrl(t ? t.url : '');
}

function onKeydown(e) {
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (isSuggestionsOpen()) {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
      break;
    case 'Enter':
      e.preventDefault();
      if (!pickSelected()) navigateInput(input.value);
      break;
    case 'Escape':
      e.preventDefault();
      closeSuggestions();
      revert();
      input.blur();
      break;
    default:
      break;
  }
}

export function initAddressBar() {
  input.addEventListener('focus', () => {
    focused = true;
    wrap.classList.add('focused');
    input.select();
  });
  // A mouse click into an unfocused bar selects all (and the click must not deselect it).
  input.addEventListener('mousedown', (e) => {
    if (document.activeElement !== input) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  input.addEventListener('blur', () => {
    focused = false;
    wrap.classList.remove('focused');
    closeSuggestions();
    if (!dirty) refreshAddress();
  });
  input.addEventListener('input', () => {
    dirty = true;
    queueSuggest(input.value);
  });
  input.addEventListener('keydown', onKeydown);

  on('active', () => {
    if (focused) input.blur();
    dirty = false;
    refreshAddress();
  });
  on('activeupdate', (_t, p) => {
    if ('url' in p || 'security' in p) refreshAddress();
  });
  refreshAddress();
}

export function focusAddress() {
  input.focus();
  input.select();
}

export function isAddressFocused() {
  return focused;
}

export function revertAddress() {
  revert();
}
