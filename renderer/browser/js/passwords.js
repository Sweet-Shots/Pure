// Save-password bar (C1). Main sends pw:offer to this window's UI when a login form was submitted in one of its
// tabs. The bar (#pw-bar, hidden by default) offers Save / Never / Dismiss and hides itself after 30 s.
// Text is set with textContent only: origins and usernames come from web pages.

import { pure, $ } from './util.js';

const AUTO_HIDE_MS = 30 * 1000;

let offerId = null;
let hideTimer = 0;

function hide() {
  clearTimeout(hideTimer);
  hideTimer = 0;
  offerId = null;
  const bar = $('pw-bar');
  if (bar) bar.hidden = true;
}

function show(offer) {
  const bar = $('pw-bar');
  const text = $('pw-bar-text');
  if (!bar || !text || !offer || typeof offer.offerId !== 'string') return;
  offerId = offer.offerId;
  text.textContent = offer.update
    ? `Update password for ${offer.username || 'this account'}?`
    : `Save password for ${offer.origin}?`;
  bar.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, AUTO_HIDE_MS);
}

export function initPasswords() {
  const bar = $('pw-bar');
  if (!bar || !pure || !pure.passwords) return;
  pure.passwords.onOffer(show);
  bar.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!btn || !offerId) return;
    const id = offerId;
    switch (btn.dataset.action) {
      case 'pw-save':
        pure.passwords.save(id);
        break;
      case 'pw-never':
        pure.passwords.never(id);
        break;
      case 'pw-dismiss':
        pure.passwords.dismiss(id);
        break;
      default:
        return;
    }
    hide();
  });
}
