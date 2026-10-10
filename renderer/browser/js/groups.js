// Tab groups: group state from main (pure.groups), the chip builder used by tabs.js, chip clicks
// (collapse / expand) and the #group-editor popover (title, colour, ungroup, close tabs).
// Group changes reach the strip through the 'groups' bus event; tabs.js owns the DOM.

import { S, emit } from './state.js';
import { $, el, pure, setText } from './util.js';
import { acquireFreeze, registerOverlay, claimOverlay } from './freeze.js';

// Colour names are main's (C3). Their colours are CSS tokens (--group-<name>) in styles/groups.css.
export const GROUP_COLORS = [
  ['grey', '#8b8f98'],
  ['blue', '#4f8ef7'],
  ['red', '#e5484d'],
  ['yellow', '#f5a524'],
  ['green', '#30a46c'],
  ['pink', '#d6409f'],
  ['purple', '#8e4ec6'],
  ['cyan', '#12a8b8'],
  ['orange', '#f76b15'],
];
const KNOWN = new Set(GROUP_COLORS.map(([name]) => name));
const MAX_TITLE = 40;

const strip = $('tabs');
const box = $('group-editor');
const titleInput = $('group-title');
const colorsBox = $('group-colors');
let editing = null; // group id (as main sent it) while the editor is open
let release = null;

// CSS token for a colour name (styles/groups.css defines --group-<name> per theme).
export function groupColorValue(name) {
  return KNOWN.has(name) ? `var(--group-${name})` : 'var(--group-grey)';
}

export function getGroup(gid) {
  if (gid === null || gid === undefined) return null;
  return S.groups.get(String(gid)) || null;
}

// pure.groups.list() / groups:changed payload: Group[] for this window.
export function setGroups(list) {
  S.groups.clear();
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || g.id === null || g.id === undefined) continue;
    S.groups.set(String(g.id), {
      id: g.id,
      title: typeof g.title === 'string' ? g.title : '',
      color: typeof g.color === 'string' ? g.color : 'grey',
      collapsed: !!g.collapsed,
    });
  }
  if (editing !== null && !S.groups.has(String(editing))) closeGroupEditor();
  emit('groups');
}

// ── Chip (button.tab-group) ───────────────────────────────

// Chip = button.tab-group with no children: its text is the title, and an untitled chip is empty
// (styled as a dot by groups.css).
export function createChip(gid) {
  const b = document.createElement('button');
  b.className = 'tab-group';
  b.type = 'button';
  b.dataset.groupId = String(gid);
  return b;
}

// Only writes what changed: chips are re-applied on every strip render. count = member tabs (shown
// as data-count on a collapsed chip).
export function updateChip(node, g, count) {
  const value = groupColorValue(g.color);
  if (node.style.getPropertyValue('--group-color') !== value) node.style.setProperty('--group-color', value);
  node.classList.toggle('collapsed', !!g.collapsed);
  const expanded = g.collapsed ? 'false' : 'true';
  if (node.getAttribute('aria-expanded') !== expanded) node.setAttribute('aria-expanded', expanded);
  const label = g.title || 'Tab group';
  if (node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label);
  const dc = g.collapsed && count > 0 ? String(count) : '';
  if (dc) {
    if (node.dataset.count !== dc) node.dataset.count = dc;
  } else if (node.dataset.count !== undefined) {
    delete node.dataset.count;
  }
  setText(node, g.title || '');
}

function onStripClick(e) {
  if (!(e.target instanceof Element)) return;
  const chip = e.target.closest('.tab-group');
  if (!chip) return;
  const g = getGroup(chip.dataset.groupId);
  if (!g) return;
  e.preventDefault();
  pure.groups.update(g.id, { collapsed: !g.collapsed });
}

function onStripContext(e) {
  if (!(e.target instanceof Element)) return;
  const chip = e.target.closest('.tab-group');
  if (!chip) return;
  e.preventDefault();
  const g = getGroup(chip.dataset.groupId);
  if (g) openGroupEditor(g.id, chip.getBoundingClientRect());
}

// ── Editor (#group-editor, popover over the frozen page) ──────

// The swatches are markup (button.group-swatch[data-color], role=radio); JS only marks the current one.
function markColor(name) {
  if (!colorsBox) return;
  for (const b of colorsBox.querySelectorAll('button[data-color]')) {
    const on = b.dataset.color === name;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

function placeNear(r) {
  const w = box.offsetWidth || 240;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(r.bottom + 6)}px`;
}

// Saves the title when it changed (≤ 40 chars). Called on Enter, blur and close.
function saveTitle() {
  if (editing === null || !titleInput) return;
  const g = getGroup(editing);
  if (!g) return;
  const v = titleInput.value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (v === g.title) return;
  g.title = v; // optimistic; main's groups:changed confirms
  emit('groups');
  pure.groups.update(g.id, { title: v });
}

export function openGroupEditor(gid, anchor) {
  claimOverlay('group-editor');
  const g = getGroup(gid);
  if (!box || !titleInput || !g) return;
  if (editing !== null) saveTitle();
  editing = g.id;
  titleInput.value = g.title;
  markColor(g.color);
  box.classList.add('open');
  if (!release) release = acquireFreeze();
  if (anchor) placeNear(anchor);
  titleInput.focus();
  titleInput.select();
}

export function closeGroupEditor() {
  if (editing === null) return;
  saveTitle();
  editing = null;
  if (box) box.classList.remove('open');
  if (release) {
    release();
    release = null;
  }
}

export function isGroupEditorOpen() {
  return editing !== null;
}

function tabIdsIn(gid) {
  const out = [];
  for (const k of S.order) {
    const t = S.tabs.get(k);
    if (t && t.groupId !== null && t.groupId !== undefined && String(t.groupId) === String(gid)) out.push(t.id);
  }
  return out;
}

export function initGroups() {
  if (strip) {
    strip.addEventListener('click', onStripClick);
    strip.addEventListener('contextmenu', onStripContext);
  }
  if (!box || !titleInput) return;

  titleInput.maxLength = MAX_TITLE;
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      closeGroupEditor();
    }
  });
  titleInput.addEventListener('blur', saveTitle);

  if (colorsBox) {
    colorsBox.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || editing === null) return;
      const b = e.target.closest('button[data-color]');
      const g = getGroup(editing);
      if (!b || !g) return;
      const name = b.dataset.color;
      g.color = name;
      markColor(name);
      emit('groups');
      pure.groups.update(g.id, { color: name });
    });
  }

  box.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || editing === null) return;
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = editing;
    if (btn.dataset.action === 'group-ungroup') {
      closeGroupEditor();
      pure.groups.ungroup(id);
    } else if (btn.dataset.action === 'group-close-tabs') {
      const ids = tabIdsIn(id);
      if (!ids.length) {
        closeGroupEditor();
        return;
      }
      const n = ids.length;
      if (!window.confirm(`Close ${n} tab${n === 1 ? '' : 's'} in this group?`)) return;
      closeGroupEditor();
      for (const tabId of ids) pure.tabs.close(tabId);
    }
  });

  // Clicking anywhere outside the editor closes it (capture, so the page snapshot is covered too).
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (editing === null) return;
      if (e.target instanceof Node && box.contains(e.target)) return;
      closeGroupEditor();
    },
    true,
  );
}

registerOverlay('group-editor', closeGroupEditor);
