// Bookmarks bar (horizontal, under the toolbar), the address-bar star, and the bar toggle.

import { S, activeTab, on } from './state.js';
import { $, el, pure } from './util.js';
import { isHttpUrl } from './url.js';
import { icon } from './icons.js';

const bar = $('bookmark-sidebar');
const list = $('bookmark-list');
const star = $('btn-bookmark');
const toggleBtn = $('btn-bookmarks-toggle');

function renderBookmarks() {
  const frag = document.createDocumentFragment();
  for (const bm of S.bookmarks) {
    const item = el('div', 'bookmark-item');
    item.dataset.url = bm.url;
    if (bm.favicon) {
      const img = el('img', 'bookmark-favicon');
      img.alt = '';
      img.draggable = false;
      img.src = bm.favicon;
      item.append(img);
    } else {
      item.append(icon('globe', 'bookmark-favicon'));
    }
    item.append(el('span', 'bookmark-title', bm.title || bm.url));
    const del = el('button', 'bookmark-delete');
    del.append(icon('x'));
    del.type = 'button';
    del.title = 'Delete bookmark';
    del.setAttribute('aria-label', 'Delete bookmark');
    item.append(del);
    frag.append(item);
  }
  list.replaceChildren(frag);
}

function refreshStar() {
  const t = activeTab();
  const url = t ? t.url : '';
  star.classList.toggle('active', isHttpUrl(url) && S.bookmarks.some((b) => b.url === url));
}

function removeBookmark(url) {
  const bm = S.bookmarks.find((b) => b.url === url);
  if (!window.confirm(`Remove "${(bm && bm.title) || 'this bookmark'}" from bookmarks?`)) return;
  pure.bookmarks.remove(url);
}

function onClick(e) {
  const item = e.target.closest('.bookmark-item');
  if (!item) return;
  const url = item.dataset.url;
  if (e.target.closest('.bookmark-delete')) {
    removeBookmark(url);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    pure.tabs.create({ url, active: false });
    return;
  }
  const t = activeTab();
  if (t) pure.tabs.navigate(t.id, url);
  else pure.tabs.create({ url });
}

function onAux(e) {
  if (e.button !== 1 || e.target.closest('.bookmark-delete')) return;
  const item = e.target.closest('.bookmark-item');
  if (!item) return;
  e.preventDefault();
  pure.tabs.create({ url: item.dataset.url, active: false });
}

function onFavError(e) {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('bookmark-favicon')) img.replaceWith(icon('globe', 'bookmark-favicon'));
}

function onWheel(e) {
  e.preventDefault();
  const target = bar.scrollWidth > bar.clientWidth ? bar : list;
  target.scrollLeft += (e.deltaY || e.deltaX) * 0.8;
}

export function applyBookmarksBar() {
  const visible = !!S.settings.showBookmarksBar;
  bar.classList.toggle('active', visible);
  toggleBtn.classList.toggle('active', visible);
}

export function toggleBookmarksBar() {
  const next = !S.settings.showBookmarksBar;
  S.settings.showBookmarksBar = next;
  applyBookmarksBar();
  pure.settings.set({ showBookmarksBar: next });
}

// Bookmark the active page (http/https only). Ctrl+D arrives here as the 'toggle-bookmark' command.
export function toggleActiveBookmark() {
  const t = activeTab();
  if (!t || !isHttpUrl(t.url)) return;
  pure.bookmarks
    .toggle({ url: t.url, title: t.title || t.url, favicon: t.favicon || '' })
    .then((now) => star.classList.toggle('active', !!now))
    .catch(() => {});
}

// bookmarks.list() / bookmarks.onChanged payload.
export function setBookmarks(items) {
  S.bookmarks = Array.isArray(items) ? items : [];
  renderBookmarks();
  refreshStar();
}

export function initBookmarks() {
  list.addEventListener('click', onClick);
  list.addEventListener('auxclick', onAux);
  list.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  list.addEventListener('error', onFavError, true);
  bar.addEventListener('wheel', onWheel, { passive: false });
  star.addEventListener('click', toggleActiveBookmark);
  toggleBtn.addEventListener('click', toggleBookmarksBar);
  on('active', refreshStar);
  on('activeupdate', (_t, p) => {
    if ('url' in p) refreshStar();
  });
  renderBookmarks();
  refreshStar();
  applyBookmarksBar();
}
