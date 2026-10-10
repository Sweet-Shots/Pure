// Window buttons, maximized state, and window info (incognito flag, version).

import { S } from './state.js';
import { $, pure, setText } from './util.js';

export function initWindowControls() {
  $('btn-wmin').addEventListener('click', () => pure.minimize());
  $('btn-wmax').addEventListener('click', () => pure.toggleMaximize());
  $('btn-wclose').addEventListener('click', () => pure.close());
}

// html.maximized also swaps the maximize icon for the restore icon (CSS).
export function setMaximized(on) {
  document.documentElement.classList.toggle('maximized', !!on);
}

// info: { version, windowId, isIncognito, isMaximized, platform } from pure.getInfo().
export function applyInfo(info) {
  S.incognito = !!(info && info.isIncognito);
  S.version = (info && info.version) || '';
  document.documentElement.classList.toggle('incognito', S.incognito);
  setText($('welcome-version'), S.version ? `v${S.version}` : '');
  setMaximized(info && info.isMaximized);
}
