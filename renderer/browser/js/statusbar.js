// Status bar: shows the link under the pointer (tabs:hover-url). Hidden when settings say so.

import { S } from './state.js';
import { $, setText } from './util.js';

const bar = $('statusbar');
const text = $('status-text');

export function setHoverUrl(url) {
  setText(text, url || '');
}

export function applyStatusBar() {
  if (bar) bar.hidden = !S.settings.showStatusBar;
}

export function initStatusBar() {
  // The markup starts with "Ready"; the status text is empty until a link is hovered.
  setText(text, '');
}
