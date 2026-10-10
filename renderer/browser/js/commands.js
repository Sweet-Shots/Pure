// Feature commands shared by the keyboard routing (keys.js) and the command palette, so both do the
// same thing. Each one talks to main through window.pure; the UI updates from the events that follow.

import { S, activeTab } from './state.js';
import { pure } from './util.js';
import { isSplitActive } from './split.js';

export function toggleFocusMode() {
  pure.settings.set({ focusMode: !S.settings.focusMode }).catch(() => {});
}

export function toggleVerticalTabs() {
  pure.settings.set({ verticalTabs: !S.settings.verticalTabs }).catch(() => {});
}

// Split view: open with the active tab (the other pane is a new home tab), or close the split.
export function toggleSplit() {
  if (isSplitActive()) {
    pure.split.close();
    return;
  }
  const t = activeTab();
  if (t) pure.split.open(t.id);
}

export function muteOthers() {
  const t = activeTab();
  if (t) pure.muteOthers(t.id);
}

// Page ⇄ reader view for the active tab (main decides whether the page is readerable).
export function toggleReader() {
  const t = activeTab();
  if (t) pure.reader.toggle(t.id);
}
