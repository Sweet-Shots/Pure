// Reports the page rectangle (#views) to main so the native page view sits exactly inside it.
// Size changes of the chrome around #views also move it, so those are observed too.

import { $, pure } from './util.js';

const WATCHED = ['titlebar', 'toolbar', 'bookmark-sidebar', 'findbar', 'views', 'statusbar'];

let last = '';
let queued = false;

function report() {
  queued = false;
  const r = $('views').getBoundingClientRect();
  const rect = {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
  const sig = `${rect.x},${rect.y},${rect.width},${rect.height}`;
  if (sig === last) return;
  last = sig;
  pure.setContentBounds(rect);
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(report);
}

export function initLayout() {
  const ro = new ResizeObserver(schedule);
  for (const id of WATCHED) {
    const node = $(id);
    if (node) ro.observe(node);
  }
  schedule();
}
