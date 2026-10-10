// Welcome overlay. The animation is pure CSS (≤ 1.2 s); this only holds the page frozen while it
// plays, then adds .leaving, removes the node, and unfreezes. No timers cycle any text.

import { $, setText } from './util.js';
import { acquireFreeze } from './freeze.js';

const SLOGANS = ['Nothing more. Nothing less.', 'Purely for you.'];
const HOLD_MS = 1200;
const FADE_MS = 200;

export function startWelcome(show) {
  const overlay = $('welcome-overlay');
  if (!overlay) return;
  setText($('welcome-tagline'), SLOGANS[Math.floor(Math.random() * SLOGANS.length)]);
  if (!show) {
    overlay.classList.add('hide');
    overlay.remove();
    return;
  }
  const release = acquireFreeze();
  setTimeout(() => {
    overlay.classList.add('leaving');
    setTimeout(() => {
      overlay.remove();
      release();
    }, FADE_MS);
  }, HOLD_MS);
}
