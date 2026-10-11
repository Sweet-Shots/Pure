// Welcome overlay. The animation is pure CSS (≤ 1.2 s); this only holds the page frozen while it
// plays, then adds .leaving, removes the node, and unfreezes. No timers cycle any text.
// 2.5 — F3: a window made by dragging a tab out has win:info.skipWelcome, and skips the overlay.

import { $, pure, setText } from './util.js';
import { acquireFreeze } from './freeze.js';

const SLOGANS = ['Nothing more. Nothing less.', 'Purely for you.'];
const HOLD_MS = 1200;
const FADE_MS = 200;

function hideOverlay(overlay) {
  overlay.classList.add('hide');
  overlay.remove();
}

function playOverlay(overlay) {
  const release = acquireFreeze();
  setTimeout(() => {
    overlay.classList.add('leaving');
    setTimeout(() => {
      overlay.remove();
      release();
    }, FADE_MS);
  }, HOLD_MS);
}

export function startWelcome(show) {
  const overlay = $('welcome-overlay');
  if (!overlay) return;
  setText($('welcome-tagline'), SLOGANS[Math.floor(Math.random() * SLOGANS.length)]);
  if (!show) {
    hideOverlay(overlay);
    return;
  }
  // Ask main whether this window skips the welcome (windows made by a drag-out). A failed call plays it.
  pure.getInfo().then(
    (info) => (info && info.skipWelcome ? hideOverlay(overlay) : playOverlay(overlay)),
    () => playOverlay(overlay),
  );
}
