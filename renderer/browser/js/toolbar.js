// Toolbar: back/forward, reload/stop, home, new tab, incognito and settings buttons, the page
// loader line and the zoom indicator. Everything here follows the active tab.

import { S, activeTab, on, homeUrl } from './state.js';
import { $, pure, setText } from './util.js';

const btnBack = $('btn-back');
const btnForward = $('btn-forward');
const btnReload = $('btn-reload');
const iconReload = $('icon-reload');
const iconStop = $('icon-stop');
const btnHome = $('btn-home');
const btnNewTab = $('btn-new-tab');
const btnIncognito = $('btn-incognito');
const btnSettings = $('btn-settings');
const loader = $('loader');
const zoomEl = $('zoom-indicator');

let wasLoading = false;

export function refreshToolbar() {
  const t = activeTab();
  btnBack.disabled = !(t && t.canGoBack);
  btnForward.disabled = !(t && t.canGoForward);

  const loading = !!(t && t.isLoading);
  iconReload.style.display = loading ? 'none' : '';
  iconStop.style.display = loading ? '' : 'none';
  btnReload.classList.toggle('loading', loading);
  btnReload.title = loading ? 'Stop' : 'Reload';
  btnReload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');

  // The loader line plays 'done' once when a load finishes; the next load clears it.
  if (loading) {
    loader.classList.add('loading');
    loader.classList.remove('done');
  } else {
    loader.classList.remove('loading');
    if (wasLoading) loader.classList.add('done');
  }
  wasLoading = loading;

  const zoom = t && typeof t.zoom === 'number' ? t.zoom : 1;
  setText(zoomEl, `${Math.round(zoom * 100)}%`);
  zoomEl.classList.toggle('visible', !!t && Math.abs(zoom - 1) > 0.001);
}

// Incognito windows hide the settings button (1.1.1 behaviour) and retitle the incognito button.
export function applyIncognitoMode() {
  btnSettings.hidden = S.incognito;
  btnIncognito.title = S.incognito ? 'Close incognito window (Ctrl+Shift+W)' : 'New incognito window (Ctrl+Shift+N)';
  btnIncognito.setAttribute('aria-label', btnIncognito.title);
}

export function initToolbar() {
  btnBack.addEventListener('click', () => {
    const t = activeTab();
    if (t) pure.tabs.back(t.id);
  });
  btnForward.addEventListener('click', () => {
    const t = activeTab();
    if (t) pure.tabs.forward(t.id);
  });
  btnReload.addEventListener('click', () => {
    const t = activeTab();
    if (!t) return;
    if (t.isLoading) pure.tabs.stop(t.id);
    else pure.tabs.reload(t.id, false);
  });
  btnHome.addEventListener('click', () => {
    const t = activeTab();
    if (t) pure.tabs.navigate(t.id, homeUrl());
    else pure.tabs.create({ url: homeUrl() });
  });
  btnNewTab.addEventListener('click', () => pure.tabs.create({ url: homeUrl() }));
  btnIncognito.addEventListener('click', () => {
    if (!S.incognito) {
      pure.openIncognito();
      return;
    }
    if (window.confirm('Close this incognito window?')) pure.close();
  });
  // Main dedupes: an existing settings tab is activated instead of opening a second one.
  btnSettings.addEventListener('click', () => pure.tabs.create({ url: 'pure://settings/' }));
  zoomEl.addEventListener('click', () => {
    const t = activeTab();
    if (t) pure.tabs.zoom(t.id, 'reset');
  });

  on('active', () => {
    wasLoading = false;
    refreshToolbar();
  });
  on('activeupdate', (_t, p) => {
    if ('url' in p || 'isLoading' in p || 'canGoBack' in p || 'canGoForward' in p || 'zoom' in p) refreshToolbar();
  });
  refreshToolbar();
}
