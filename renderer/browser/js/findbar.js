// Find bar: runs tabs.find / stopFind on the tab the search started in. Closes when the tab changes.

import { activeTab, on } from './state.js';
import { $, pure } from './util.js';

const bar = $('findbar');
const input = $('find-input');
const count = $('find-count');

let open = false;
let findTabId = null; // tab the current search runs in (null = no search running)

function startOrContinue(text, opts) {
  const t = activeTab();
  if (!t) return;
  findTabId = t.id;
  pure.tabs.find(t.id, text, opts);
}

function clearSearch() {
  if (findTabId != null) pure.tabs.stopFind(findTabId);
  findTabId = null;
  count.textContent = '';
}

function onInput() {
  const text = input.value;
  if (!text) {
    clearSearch();
    return;
  }
  startOrContinue(text, { forward: true, findNext: false });
}

function step(forward) {
  const text = input.value;
  if (!text) return;
  startOrContinue(text, { forward, findNext: true });
}

export function openFind() {
  if (!open) {
    open = true;
    bar.classList.add('open');
    document.body.classList.add('find-open');
  }
  input.focus();
  input.select();
}

export function closeFind() {
  if (!open) return;
  open = false;
  bar.classList.remove('open');
  document.body.classList.remove('find-open');
  input.value = '';
  clearSearch();
}

export function isFindOpen() {
  return open;
}

// tabs:found payload: { id, activeMatchOrdinal, matches }.
export function onFound(res) {
  if (!open || findTabId == null || !res || String(res.id) !== String(findTabId)) return;
  const matches = res.matches || 0;
  count.textContent = matches ? `${res.activeMatchOrdinal || 0}/${matches}` : '0/0';
}

export function initFindBar() {
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  $('find-next').addEventListener('click', () => step(true));
  $('find-prev').addEventListener('click', () => step(false));
  $('find-close').addEventListener('click', () => closeFind());
  on('active', () => closeFind());
}
