// Ref-counted page freeze. The live page is a native view drawn over the window, so HTML overlays
// (suggestions, welcome) hide it and show a snapshot instead. Overlapping holders share one freeze.
// IPC calls run one at a time, in order, so acquire/release can never race.

import { $, pure } from './util.js';

let holders = 0;
let frozen = false;
let queue = Promise.resolve();

async function sync() {
  const want = holders > 0;
  if (want === frozen) return;
  frozen = want;
  const img = $('page-freeze');
  try {
    if (want) {
      const snap = await pure.freezePage(true);
      if (snap && img) {
        img.src = snap;
        img.classList.add('visible');
      }
    } else {
      if (img) {
        img.classList.remove('visible');
        img.removeAttribute('src');
      }
      await pure.freezePage(false);
    }
  } catch (_) {
    // Main unavailable: keep the UI usable; the page state is main's to decide.
  }
}

function schedule() {
  queue = queue.then(sync);
}

// Returns a release function. Calling it more than once is harmless.
export function acquireFreeze() {
  holders++;
  schedule();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    schedule();
  };
}

// ── Exclusive overlays ─────────────────────────────────────────────────────
// Only one popover/overlay is open at a time. Each overlay registers its close function once, and calls
// claimOverlay(name) when it opens; every other registered overlay is closed.
const overlays = new Map(); // name -> close()

export function registerOverlay(name, close) {
  overlays.set(name, close);
}

export function claimOverlay(name) {
  for (const [other, close] of overlays) {
    if (other === name) continue;
    try { close(); } catch { /* an overlay that fails to close must not block the new one */ }
  }
}
