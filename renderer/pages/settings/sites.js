/* Settings > Site settings (pure://settings/#sites). Owner: E3.
 * Lists every site with a saved permission decision, a Purify exception or a Balanced level, with search and a
 * per-site reset. Data comes from window.pureInternal.sites only (main re-checks the sender). Classic IIFE, no
 * inline handlers: one delegated click listener on the section. Text is set with textContent only.
 * The list is refreshed when the section is shown (no polling). */
(function () {
  'use strict';

  const api = window.pureInternal || null;
  if (!api || !api.sites) return;

  const $ = (id) => document.getElementById(id);
  const section = $('sites');
  if (!section) return;
  const listEl = $('sites-list');
  const searchEl = $('sites-search');
  if (!listEl) return;

  // Permission names as Pure stores them (main/permissions.js) -> labels.
  const PERMISSION_LABELS = {
    camera: 'Camera',
    microphone: 'Microphone',
    geolocation: 'Location',
    notifications: 'Notifications',
    'clipboard-read': 'Clipboard',
    midi: 'MIDI',
  };

  let sites = [];
  let loaded = false;
  let failed = false;
  let requestSeq = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function permissionLabel(name) {
    return PERMISSION_LABELS[name] || String(name);
  }

  // "Camera: allowed · Microphone: blocked · Purify off"
  function metaText(site) {
    const parts = [];
    for (const p of site.permissions || []) {
      parts.push(`${permissionLabel(p.permission)}: ${p.decision === 'allow' ? 'allowed' : 'blocked'}`);
    }
    if (site.purifyOff) parts.push('Purify off');
    else if (site.purifyLevel === 'balanced') parts.push('Purify balanced');
    return parts.join(' · ') || 'Custom settings';
  }

  function matches(site, query) {
    if (!query) return true;
    return site.host.indexOf(query) >= 0 || metaText(site).toLowerCase().indexOf(query) >= 0;
  }

  function siteRow(site) {
    const row = el('div', 'site-row');
    row.dataset.host = site.host;
    const reset = el('button', 'btn-reset', 'Reset');
    reset.type = 'button';
    reset.dataset.action = 'site-reset';
    reset.setAttribute('aria-label', `Reset settings for ${site.host}`);
    row.append(el('div', 'site-row-host', site.host), el('div', 'site-row-meta', metaText(site)), reset);
    return row;
  }

  function emptyState(text) {
    return el('div', 'empty-state', text);
  }

  function render() {
    if (failed) {
      listEl.replaceChildren(emptyState('Could not load site settings.'));
      return;
    }
    if (!loaded) return;
    if (!sites.length) {
      listEl.replaceChildren(emptyState('No sites have custom settings yet.'));
      return;
    }
    const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
    const shown = sites.filter((site) => matches(site, query));
    if (!shown.length) {
      listEl.replaceChildren(emptyState('No sites match your search.'));
      return;
    }
    listEl.replaceChildren(...shown.map(siteRow));
  }

  async function refresh() {
    const seq = ++requestSeq;
    let rows = null;
    try {
      rows = await api.sites.list();
    } catch {
      rows = null;
    }
    if (seq !== requestSeq) return; // a newer request answered first
    failed = rows === null;
    sites = Array.isArray(rows) ? rows : [];
    loaded = true;
    render();
  }

  // Loads when the section becomes visible, and again when the window becomes visible while it is shown.
  function syncShown() {
    if (section.classList.contains('active') && !document.hidden) refresh();
  }

  document.addEventListener('click', async (event) => {
    const node = event.target instanceof Element ? event.target.closest('[data-action="site-reset"]') : null;
    if (!node || !section.contains(node)) return;
    event.preventDefault();
    const row = node.closest('.site-row');
    const host = row ? row.dataset.host : '';
    if (!host) return;
    node.disabled = true;
    try {
      await api.sites.reset(host);
    } catch {
      // main refused or the host is gone; the refresh below shows the real state
    }
    node.disabled = false;
    refresh();
  });

  if (searchEl) searchEl.addEventListener('input', render);

  new MutationObserver(syncShown).observe(section, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', syncShown);
  syncShown();
})();
