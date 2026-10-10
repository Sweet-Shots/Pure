// Keyboard handling inside the browser UI, plus the commands main forwards to it.
// Global shortcuts are main's (before-input-event); the UI only handles keys while its own
// document has focus. Ctrl+F / Ctrl+L are idempotent, so main's forwarded copy is harmless.

import { $, pure } from './util.js';
import { activeTab } from './state.js';
import { focusAddress, isAddressFocused, revertAddress } from './address-bar.js';
import { closeSuggestions, isSuggestionsOpen } from './suggestions.js';
import { closeFind, isFindOpen, openFind } from './findbar.js';
import { toggleActiveBookmark, toggleBookmarksBar } from './bookmarks.js';
import { isPaletteOpen, closePalette, togglePalette } from './palette.js';
import { isSiteInfoOpen, closeSiteInfo } from './siteinfo.js';
import { isShieldOpen, closeShield } from './shield.js';
import { isGroupEditorOpen, closeGroupEditor } from './groups.js';
import { toggleFocusMode, toggleSplit, muteOthers, toggleReader } from './commands.js';

// Escape closes the topmost overlay first: palette, group editor, site info, shield, find, suggestions.
function onEscape() {
  if (isPaletteOpen()) {
    closePalette();
    return;
  }
  if (isGroupEditorOpen()) {
    closeGroupEditor();
    return;
  }
  if (isSiteInfoOpen()) {
    closeSiteInfo();
    return;
  }
  if (isShieldOpen()) {
    closeShield();
    return;
  }
  if (isFindOpen()) {
    closeFind();
    return;
  }
  if (isSuggestionsOpen()) {
    closeSuggestions();
    return;
  }
  if (isAddressFocused()) {
    revertAddress();
    $('address-bar').blur();
    return;
  }
  // Nothing UI-side to close: Esc stops a loading page, as in other browsers.
  const t = activeTab();
  if (t && t.isLoading) pure.tabs.stop(t.id);
}

// Commands from main's onCommand (arg is unused for every command today).
export function runCommand(name) {
  switch (name) {
    case 'focus-address-bar':
      focusAddress();
      break;
    case 'find':
      openFind();
      break;
    case 'close-find':
      closeFind();
      break;
    case 'toggle-bookmark':
      toggleActiveBookmark();
      break;
    case 'toggle-bookmarks-bar':
      toggleBookmarksBar();
      break;
    // 2.2 — main's shortcuts.js sends these (Ctrl+K, Ctrl+Shift+A, Ctrl+Shift+F, Ctrl+Shift+S, Ctrl+Shift+M, F9).
    case 'command-palette':
      togglePalette(false);
      break;
    case 'tab-search':
      togglePalette(true);
      break;
    case 'focus-mode':
      toggleFocusMode();
      break;
    case 'split-view':
      toggleSplit();
      break;
    case 'mute-others':
      muteOthers();
      break;
    case 'reader-mode':
      toggleReader();
      break;
    case 'escape':
      onEscape();
      break;
    default:
      break;
  }
}

export function initKeys() {
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'l') {
        e.preventDefault();
        focusAddress();
      } else if (k === 'f') {
        e.preventDefault();
        openFind();
      }
    },
    true,
  );
}
