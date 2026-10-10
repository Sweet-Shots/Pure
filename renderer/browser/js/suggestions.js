// Address-bar suggestions dropdown: debounced queries, stale-response guard, keyboard and mouse picks.
// While the dropdown is open the live page is frozen (it is a native view and would cover it).

import { $, el, pure } from './util.js';
import { acquireFreeze, registerOverlay } from './freeze.js';
import { navigateItem } from './navigate.js';
import { icon } from './icons.js';

const input = $('address-bar');
const box = $('suggestions');
const DEBOUNCE_MS = 120;
const MAX_ITEMS = 10;
const ICONS = { bookmark: 'star', history: 'history', search: 'search', url: 'globe' };

let timer = 0;
let seq = 0; // bumped on every close, so responses to old queries are dropped
let typed = ''; // what the user typed (the input may show a preview of the selected item)
let items = [];
let index = -1;
let release = null;

function normalize(s) {
  const type = s && ICONS[s.type] ? s.type : 'search';
  const url = s && typeof s.url === 'string' ? s.url : '';
  const title = s && typeof s.title === 'string' ? s.title : '';
  const text = s && typeof s.text === 'string' ? s.text : '';
  return { type, url, title, text: text || title || url };
}

function buildItem(it, i) {
  const node = el('div', 'sug-item');
  node.dataset.index = String(i);
  node.dataset.type = it.type;
  const glyph = el('span', 'sug-icon');
  glyph.append(icon(ICONS[it.type]));
  node.append(
    glyph,
    el('span', 'sug-text', it.title || it.text || it.url),
    el('span', 'sug-type', it.type),
  );
  return node;
}

function previewOf(it) {
  return it.url || it.text;
}

function setIndex(i) {
  index = i;
  for (const node of box.children) node.classList.toggle('selected', Number(node.dataset.index) === i);
}

function render(list) {
  items = list.slice(0, MAX_ITEMS).map(normalize);
  index = -1;
  if (!items.length) {
    closeSuggestions();
    return;
  }
  box.replaceChildren(...items.map(buildItem));
  if (!release) release = acquireFreeze();
  box.classList.add('open');
}

async function query() {
  timer = 0;
  const my = ++seq;
  const text = typed;
  let list = [];
  try {
    list = await pure.suggest(text);
  } catch (_) {
    list = [];
  }
  // Stale: a newer query or a close happened while this one was in flight.
  if (my !== seq || text !== typed) return;
  render(Array.isArray(list) ? list : []);
}

function onPointerDown(e) {
  const node = e.target.closest('.sug-item');
  if (!node || e.button !== 0) return;
  // Picking on pointerdown: the address bar would blur (and close the list) before a click lands.
  e.preventDefault();
  const it = items[Number(node.dataset.index)];
  if (it) navigateItem(it);
}

function onHover(e) {
  const node = e.target.closest('.sug-item');
  if (!node) return;
  const i = Number(node.dataset.index);
  if (i !== index) setIndex(i);
}

export function initSuggestions() {
  box.addEventListener('pointerdown', onPointerDown);
  box.addEventListener('pointerover', onHover);
  box.addEventListener('mousedown', (e) => e.preventDefault()); // keeps focus in the address bar
}

export function queueSuggest(text) {
  clearTimeout(timer);
  typed = text;
  if (!text.trim()) {
    closeSuggestions();
    return;
  }
  timer = setTimeout(query, DEBOUNCE_MS);
}

export function moveSelection(delta) {
  if (!items.length) return;
  const next = Math.max(-1, Math.min(items.length - 1, index + delta));
  setIndex(next);
  input.value = next < 0 ? typed : previewOf(items[next]);
}

// Navigates the highlighted item. Returns false when nothing is highlighted.
export function pickSelected() {
  const it = items[index];
  if (!it) return false;
  navigateItem(it);
  return true;
}

export function isSuggestionsOpen() {
  return box.classList.contains('open');
}

export function closeSuggestions() {
  clearTimeout(timer);
  timer = 0;
  seq++;
  box.classList.remove('open');
  box.replaceChildren();
  items = [];
  index = -1;
  if (release) {
    release();
    release = null;
  }
}

registerOverlay('suggestions', closeSuggestions);
