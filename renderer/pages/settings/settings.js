/* Pure settings page (pure://settings/#section). Owner: H4.
 * Data comes from window.pureInternal (preload/internal.js) only. Controls auto-save; no
 * inline handlers: buttons carry data-action, one delegated listener per event type. */
(function () {
  'use strict';

  const api = window.pureInternal || null;
  const SECTIONS = ['homepage', 'appearance', 'search', 'privacy', 'sites', 'passwords', 'performance', 'extensions', 'downloads', 'import', 'shortcuts', 'history', 'about'];
  const HOME_PURE = 'pure://home/';
  const HISTORY_PAGE = 100;
  // Same values as renderer/browser/js/theme.js: incognito accent is always red.
  const INCOGNITO_ACCENT = '#c04040';
  const INCOGNITO_ACCENT_DIM = '#6b2020';

  // Settings each section's "Reset" button restores.
  const RESET_KEYS = {
    homepage: ['homepage', 'homepageLatitude', 'homepageLongitude', 'homepageTempUnit', 'homepageTimeFormat',
      'homeWidgets', 'newsTopics', 'newsSources', 'newsImages', 'showHomeStats'],
    appearance: ['accentColor', 'theme', 'showWelcomeAnimation', 'showStatusBar', 'showBookmarksBar',
      'forceDarkWeb', 'verticalTabs', 'focusMode'],
    search: ['searchEngine', 'searchSuggestions'],
    privacy: ['restoreSession', 'spellcheck', 'blockingEnabled', 'blockingLevel', 'blockCookieBanners', 'dohMode', 'dohProvider', 'dohCustomUrl',
      'httpsMode', 'clearOnExitHistory', 'clearOnExitCookies', 'clearOnExitCache', 'clearOnExitDownloads'],
    performance: ['tabDiscardMinutes', 'smartSleep', 'liteMode'],
    downloads: ['askWhereToSave', 'downloadDir', 'warnRiskyDownloads'],
  };
  const RESET_MESSAGE = {
    homepage: 'Reset homepage settings to defaults? (Home address, location, temperature and time format)',
    appearance: 'Reset appearance settings to defaults? (Accent color and startup options)',
    search: 'Reset search settings to defaults? (Search engine and suggestions)',
    privacy: 'Reset privacy settings to defaults? (Restore session, spellcheck and Purify)',
    performance: 'Reset performance settings to defaults? (Tab sleeping and Lite mode)',
    downloads: 'Reset download settings to defaults?',
  };

  // Form controls that map 1:1 to a setting. kind: bool (checkbox) | value | number.
  const CONTROLS = {
    'show-welcome-toggle': ['showWelcomeAnimation', 'bool'],
    'show-statusbar-toggle': ['showStatusBar', 'bool'],
    'show-bookmarks-bar-toggle': ['showBookmarksBar', 'bool'],
    'search-suggestions-toggle': ['searchSuggestions', 'bool'],
    'restore-session-toggle': ['restoreSession', 'bool'],
    'spellcheck-toggle': ['spellcheck', 'bool'],
    'ask-where-to-save-toggle': ['askWhereToSave', 'bool'],
    tempUnit: ['homepageTempUnit', 'value'],
    timeFormat: ['homepageTimeFormat', 'value'],
    'search-engine': ['searchEngine', 'value'],
    'tab-discard-select': ['tabDiscardMinutes', 'number'],
    'accent-picker': ['accentColor', 'value'],
    // 2.1
    'theme-select': ['theme', 'value'],
    'blocking-toggle': ['blockingEnabled', 'bool'],
    'lite-mode-toggle': ['liteMode', 'bool'],
    'smart-sleep-toggle': ['smartSleep', 'bool'],
    'news-images-toggle': ['newsImages', 'bool'],
    'home-stats-toggle': ['showHomeStats', 'bool'],
    // 2.2
    'save-passwords-toggle': ['savePasswords', 'bool'],
    'auto-update-toggle': ['autoUpdate', 'bool'],
    'doh-mode-select': ['dohMode', 'value'],
    'doh-provider-select': ['dohProvider', 'value'],
    'doh-custom-input': ['dohCustomUrl', 'value'],
    'cookie-banners-toggle': ['blockCookieBanners', 'bool'],
    // 2.4
    'https-mode-select': ['httpsMode', 'value'],
    'clear-on-exit-history-cb': ['clearOnExitHistory', 'bool'],
    'clear-on-exit-cookies-cb': ['clearOnExitCookies', 'bool'],
    'clear-on-exit-cache-cb': ['clearOnExitCache', 'bool'],
    'clear-on-exit-downloads-cb': ['clearOnExitDownloads', 'bool'],
    'risky-downloads-toggle': ['warnRiskyDownloads', 'bool'],
    'blocking-level-select': ['blockingLevel', 'value'],
    'force-dark-toggle': ['forceDarkWeb', 'bool'],
    'vertical-tabs-toggle': ['verticalTabs', 'bool'],
    'focus-mode-toggle': ['focusMode', 'bool'],
  };

  const state = {
    settings: null,
    incognito: false, // set from getInfo() before settings are applied; applyAccent() reads it
    historyLoaded: false,
    historyQuery: '',
    historyOffset: 0,
    historyTotal: 0,
    historySeq: 0,
    historyPending: null,
    historyDay: '', // day key of the last rendered history group
    downloads: new Map(), // id -> DownloadItem
    downloadFrame: 0,
    toastTimer: 0,
  };

  const $ = (id) => document.getElementById(id);

  // ── Small helpers ──────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, action, className) {
    const b = el('button', className || '', label);
    b.type = 'button';
    b.dataset.action = action;
    return b;
  }

  /* ICON-SHAPES:BEGIN */
  const ICON_ATTRS = {
    'width': '16',
    'height': '16',
    'viewBox': '0 0 24 24',
    'fill': 'none',
    'stroke': 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    'focusable': 'false',
  };
  const ICON_SHAPES = {
    'trash-2': [
      ['path', { 'd': 'M10 11v6' }],
      ['path', { 'd': 'M14 11v6' }],
      ['path', { 'd': 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }],
      ['path', { 'd': 'M3 6h18' }],
      ['path', { 'd': 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ],
    'external-link': [
      ['path', { 'd': 'M15 3h6v6' }],
      ['path', { 'd': 'M10 14 21 3' }],
      ['path', { 'd': 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
    ],
    'globe': [
      ['circle', { 'cx': '12', 'cy': '12', 'r': '10' }],
      ['path', { 'd': 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
      ['path', { 'd': 'M2 12h20' }],
    ],
    'folder': [
      ['path', { 'd': 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }],
    ],
  };
  /* ICON-SHAPES:END */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const iconCache = new Map();
  // icon('trash-2') -> <svg class="icon">; built once per name, then cloned.
  function icon(name, extraClass) {
    let base = iconCache.get(name);
    if (!base) {
      base = document.createElementNS(SVG_NS, 'svg');
      base.setAttribute('class', 'icon');
      for (const k of Object.keys(ICON_ATTRS)) base.setAttribute(k, ICON_ATTRS[k]);
      for (const [tag, attrs] of ICON_SHAPES[name] || []) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
        base.append(node);
      }
      iconCache.set(name, base);
    }
    const svg = base.cloneNode(true);
    if (extraClass) svg.setAttribute('class', 'icon ' + extraClass);
    return svg;
  }

  // Icon-only row button; the label becomes the tooltip and accessible name.
  function iconButton(name, label, action, className) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = ['icon-btn', className].filter(Boolean).join(' ');
    b.dataset.action = action;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    return b;
  }

  function emptyState(text) {
    return el('p', 'empty-state', text);
  }

  function debounce(fn, ms) {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function isWebUrl(raw) {
    try {
      const u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function faviconFor(url) {
    try {
      return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(new URL(url).hostname)}.ico`;
    } catch {
      return '';
    }
  }

  // Tab icon: a dot in the accent colour (static markup has no href; this sets it).
  function setFavicon(color) {
    const link = document.querySelector('link[rel="icon"]');
    if (!link || link.dataset.color === color) return;
    link.dataset.color = color;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
      `<circle cx="16" cy="16" r="8" fill="${color}"/></svg>`;
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  // Incognito pages are always red, whatever the user's accent setting is.
  function applyAccent(color) {
    const style = document.documentElement.style;
    if (state.incognito) {
      style.setProperty('--accent', INCOGNITO_ACCENT);
      style.setProperty('--accent-dim', INCOGNITO_ACCENT_DIM);
      setFavicon(INCOGNITO_ACCENT);
      return;
    }
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
    const n = parseInt(color.slice(1), 16);
    const dim = (shift) => Math.round(((n >> shift) & 255) * 0.35).toString(16).padStart(2, '0');
    style.setProperty('--accent', color);
    style.setProperty('--accent-dim', `#${dim(16)}${dim(8)}${dim(0)}`);
    setFavicon(color);
  }

  function flash(message) {
    const toast = $('save-toast');
    const text = $('save-toast-text');
    if (!toast || !text) return;
    text.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 1600);
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  function sectionFromHash() {
    let id = '';
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      id = '';
    }
    return SECTIONS.includes(id) ? id : 'homepage';
  }

  function isActive(id) {
    const node = $(id);
    return !!node && node.classList.contains('active');
  }

  function showSection(id, updateHash) {
    if (!SECTIONS.includes(id)) return;
    document.querySelectorAll('.tab-content').forEach((node) => {
      node.classList.toggle('active', node.id === id);
    });
    document.querySelectorAll('[data-action="section"]').forEach((node) => {
      node.classList.toggle('active', node.dataset.arg === id);
    });
    if (updateHash && location.hash !== '#' + id) {
      // replaceState does not fire hashchange, so this does not re-enter showSection
      window.history.replaceState(null, '', '#' + id);
    }
    // The hash would otherwise leave .content scrolled to the section's top edge (padding cut off).
    const content = document.querySelector('.content');
    if (content) content.scrollTop = 0;
    onSectionShown(id);
  }

  function onSectionShown(id) {
    if (!api) return;
    if (id === 'history' && !state.historyLoaded) {
      state.historyLoaded = true;
      resetHistory(state.historyQuery);
    } else if (id === 'downloads') {
      refreshDownloads();
    } else if (id === 'privacy') {
      refreshPermissions();
      refreshDefaultBrowser();
    }
  }

  // ── Settings controls ──────────────────────────────────────────────────────
  function setControl(id, value, kind) {
    const node = $(id);
    if (!node || node === document.activeElement) return; // never overwrite what the user is typing
    if (kind === 'bool') {
      node.checked = !!value;
      return;
    }
    const text = String(value);
    if (node.tagName === 'SELECT' && ![...node.options].some((o) => o.value === text)) {
      const custom = el('option', '', 'Custom');
      custom.value = text;
      node.appendChild(custom);
    }
    if (node.value !== text) node.value = text;
  }

  function renderControls(s) {
    for (const id of Object.keys(CONTROLS)) {
      const [key, kind] = CONTROLS[id];
      setControl(id, s[key], kind);
    }
    setControl('homepage-url', s.homepage === HOME_PURE ? '' : s.homepage, 'value');
    setControl('latitude', s.homepageLatitude, 'value');
    setControl('longitude', s.homepageLongitude, 'value');
  }

  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    state.settings = s;
    applyAccent(s.accentColor);
    renderControls(s);
  }

  // What the value would be stored as, so invalid input can be reported.
  function expectedValue(key, value) {
    if (key === 'homepage') return value.trim() === '' ? HOME_PURE : value.trim();
    if (key === 'accentColor') return String(value).toLowerCase();
    if (key === 'homepageLatitude') return String(value).trim() || '40.7128';
    if (key === 'homepageLongitude') return String(value).trim() || '-74.0060';
    if (key === 'tabDiscardMinutes') return Number(value);
    return value;
  }

  async function save(patch) {
    if (!api) return;
    try {
      const next = await api.settings.set(patch);
      applySettings(next);
      const rejected = Object.keys(patch).some((k) => !sameJson(expectedValue(k, patch[k]), next[k]));
      flash(rejected ? 'Not saved: check the value' : 'Saved');
    } catch {
      flash('Not saved');
    }
  }

  async function resetSection(section) {
    const keys = RESET_KEYS[section];
    if (!api || !keys || !window.confirm(RESET_MESSAGE[section])) return;
    try {
      applySettings(await api.settings.reset(keys));
      flash('Reset to defaults');
    } catch {
      flash('Could not reset');
    }
  }

  async function resetAccent() {
    if (!api || !window.confirm('Reset the accent color to default?')) return;
    try {
      applySettings(await api.settings.reset(['accentColor']));
      flash('Reset to defaults');
    } catch {
      flash('Could not reset');
    }
  }

  // ── Privacy: clear browsing data ───────────────────────────────────────────
  function setClearStatus(text) {
    const node = $('clear-data-status');
    if (node) node.textContent = text;
  }

  async function clearData() {
    if (!api) return;
    const picks = {
      history: !!($('clear-history-cb') && $('clear-history-cb').checked),
      cookies: !!($('clear-cookies-cb') && $('clear-cookies-cb').checked),
      cache: !!($('clear-cache-cb') && $('clear-cache-cb').checked),
      downloads: !!($('clear-downloads-cb') && $('clear-downloads-cb').checked),
    };
    const names = Object.keys(picks).filter((k) => picks[k]);
    if (!names.length) {
      setClearStatus('Select what to clear first.');
      return;
    }
    if (!window.confirm(`Clear ${names.join(', ')}? This cannot be undone.`)) return;
    setClearStatus('Clearing...');
    try {
      await api.clearBrowsingData(picks);
      if (picks.history) {
        state.historyLoaded = false;
        if (isActive('history')) {
          state.historyLoaded = true;
          resetHistory(state.historyQuery);
        }
      }
      if (picks.downloads) refreshDownloads();
      setClearStatus('Cleared.');
    } catch {
      setClearStatus('Could not clear the selected data.');
    }
  }

  // ── Privacy: site permissions ──────────────────────────────────────────────
  function prettyPermission(name) {
    const text = String(name).replace(/-/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  async function refreshPermissions() {
    const list = $('site-permissions-list');
    if (!list || !api) return;
    let rows = [];
    try {
      rows = await api.getSitePermissions();
    } catch {
      rows = [];
    }
    if (!rows.length) {
      list.replaceChildren(emptyState('No site permissions saved.'));
      return;
    }
    list.replaceChildren(...rows.map((row) => {
      const line = el('div', 'perm-row');
      const reset = button('Reset', 'reset-permission', 'btn-reset');
      reset.dataset.origin = row.origin;
      reset.dataset.permission = row.permission;
      const decision = row.decision === 'allow' ? 'allow' : 'deny';
      const decisionNode = el('span', `perm-decision ${decision}`, decision === 'allow' ? 'Allowed' : 'Blocked');
      decisionNode.dataset.decision = decision;
      line.append(
        el('span', 'perm-origin', row.origin),
        el('span', 'perm-name', prettyPermission(row.permission)),
        decisionNode,
        reset,
      );
      return line;
    }));
  }

  async function resetPermission(btn) {
    if (!api) return;
    try {
      await api.resetSitePermission(btn.dataset.origin, btn.dataset.permission);
    } catch {
      // fall through: the list is re-read either way
    }
    refreshPermissions();
  }

  // ── Privacy: default browser ───────────────────────────────────────────────
  async function refreshDefaultBrowser() {
    const node = $('default-browser-status');
    if (!node || !api) return;
    try {
      const isDefault = await api.isDefaultBrowser();
      node.textContent = isDefault ? 'Pure is your default browser.' : 'Pure is not your default browser.';
    } catch {
      node.textContent = 'Default browser status is unavailable.';
    }
  }

  // ── Downloads ──────────────────────────────────────────────────────────────
  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function downloadMeta(item) {
    const labels = {
      progressing: item.paused ? 'Paused' : 'Downloading',
      completed: 'Completed',
      cancelled: 'Cancelled',
      interrupted: 'Interrupted',
    };
    const received = formatBytes(item.receivedBytes);
    const total = item.totalBytes > 0 ? ` of ${formatBytes(item.totalBytes)}` : '';
    return `${labels[item.state] || 'Unknown'} · ${received}${total}`;
  }

  function downloadRow(item) {
    const row = el('div', 'download-row');
    row.dataset.id = String(item.id);
    row.dataset.state = String(item.state || '');
    if (item.state === 'interrupted' || item.state === 'cancelled') row.classList.add('failed');
    const open = iconButton('external-link', 'Open', 'open-download');
    open.disabled = item.state !== 'completed';
    const show = iconButton('folder', 'Show in folder', 'show-download');
    const info = el('div', 'download-info');
    info.append(el('div', 'download-name', item.filename || 'Download'), el('div', 'download-meta', downloadMeta(item)));
    row.append(info, open, show);
    return row;
  }

  function renderDownloads() {
    const list = $('downloads-list');
    if (!list) return;
    const items = [...state.downloads.values()].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    if (!items.length) {
      list.replaceChildren(emptyState('No downloads yet.'));
      return;
    }
    list.replaceChildren(...items.map(downloadRow));
  }

  // Progress events can arrive many times a second: coalesce them into one render per frame.
  function scheduleDownloadRender() {
    if (state.downloadFrame || !isActive('downloads')) return;
    state.downloadFrame = requestAnimationFrame(() => {
      state.downloadFrame = 0;
      renderDownloads();
    });
  }

  async function refreshDownloads() {
    if (!api) return;
    try {
      const items = await api.downloads.list();
      state.downloads = new Map((Array.isArray(items) ? items : []).map((i) => [i.id, i]));
    } catch {
      // keep what we have
    }
    renderDownloads();
  }

  function downloadById(btn) {
    const row = btn.closest('.download-row');
    if (!row) return null;
    for (const item of state.downloads.values()) {
      if (String(item.id) === row.dataset.id) return item;
    }
    return null;
  }

  // downloads.clear() resolves with the remaining list; there is no "removed" event.
  async function clearDownloads() {
    if (!api) return;
    try {
      const remaining = await api.downloads.clear();
      if (Array.isArray(remaining)) {
        state.downloads = new Map(remaining.map((i) => [i.id, i]));
        renderDownloads();
        return;
      }
    } catch {
      // fall through to re-read
    }
    refreshDownloads();
  }

  // ── History ────────────────────────────────────────────────────────────────
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (dayKey(ts) === dayKey(now.getTime())) return 'Today';
    if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function timeLabel(ts) {
    const twelve = !!state.settings && state.settings.homepageTimeFormat === '12h';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: twelve });
  }

  function historyRow(item, day) {
    const row = el('div', 'history-row');
    row.dataset.id = String(item.id);
    row.dataset.url = item.url;
    row.dataset.day = day;
    row.tabIndex = 0;

    const img = document.createElement('img');
    img.className = 'history-favicon';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    const src = faviconFor(item.url);
    if (src) img.src = src;

    const text = el('div', 'history-text');
    text.append(el('div', 'history-title', item.title || item.url), el('div', 'history-url', item.url));

    const del = iconButton('trash-2', 'Delete', 'delete-history', 'history-delete');
    row.append(img, text, el('span', 'history-time', timeLabel(item.visitedAt)), del);
    return row;
  }

  function updateHistoryMore() {
    const more = $('history-more');
    if (more) more.hidden = state.historyOffset >= state.historyTotal;
  }

  function resetHistory(query) {
    state.historyQuery = query;
    state.historyOffset = 0;
    state.historyTotal = 0;
    state.historySeq++;
    state.historyPending = null;
    loadHistory();
  }

  async function loadHistory() {
    const list = $('history-list');
    if (!api || !list) return;
    const seq = state.historySeq;
    if (state.historyPending === seq) return; // a page is already on its way
    state.historyPending = seq;

    let page = { items: [], total: 0 };
    try {
      page = await api.history.list({
        query: state.historyQuery,
        offset: state.historyOffset,
        limit: HISTORY_PAGE,
      });
    } catch {
      page = { items: [], total: 0 };
    } finally {
      if (state.historyPending === seq) state.historyPending = null;
    }
    if (seq !== state.historySeq) return; // a newer search started meanwhile

    const items = Array.isArray(page.items) ? page.items : [];
    const first = state.historyOffset === 0;
    if (first) {
      list.replaceChildren();
      state.historyDay = '';
    }
    state.historyTotal = Number(page.total) || 0;

    if (first && !items.length) {
      list.replaceChildren(emptyState(state.historyQuery ? 'No matching history.' : 'No history yet.'));
    } else {
      const frag = document.createDocumentFragment();
      for (const item of items) {
        const key = dayKey(item.visitedAt);
        if (key !== state.historyDay) {
          state.historyDay = key;
          frag.append(el('div', 'history-day', dayLabel(item.visitedAt)));
        }
        frag.append(historyRow(item, key));
      }
      list.append(frag);
    }
    state.historyOffset += items.length;
    updateHistoryMore();
  }

  function openHistoryRow(row) {
    const url = row.dataset.url || '';
    if (isWebUrl(url)) location.href = url;
  }

  async function deleteHistory(btn) {
    const row = btn.closest('.history-row');
    const list = $('history-list');
    if (!row || !api) return;
    let removed = false;
    try {
      removed = await api.history.remove(Number(row.dataset.id));
    } catch {
      removed = false;
    }
    if (!removed) return;

    const prev = row.previousElementSibling;
    const next = row.nextElementSibling;
    row.remove();
    if (prev && prev.classList.contains('history-day') && (!next || next.classList.contains('history-day'))) {
      prev.remove();
    }
    // keep paging consistent with what is on screen
    state.historyOffset = Math.max(0, state.historyOffset - 1);
    state.historyTotal = Math.max(0, state.historyTotal - 1);
    if (list) {
      const rows = list.querySelectorAll('.history-row');
      const last = rows.length ? rows[rows.length - 1] : null;
      state.historyDay = last ? last.dataset.day : '';
      if (!rows.length) list.replaceChildren(emptyState(state.historyQuery ? 'No matching history.' : 'No history yet.'));
    }
    updateHistoryMore();
  }

  async function clearHistory() {
    if (!api || !window.confirm('Clear all browsing history? This cannot be undone.')) return;
    try {
      await api.history.clear();
    } catch {
      flash('Could not clear history');
      return;
    }
    const search = $('history-search');
    if (search) search.value = '';
    resetHistory('');
  }

  // ── About ──────────────────────────────────────────────────────────────────
  async function renderAbout() {
    if (!api) return;
    try {
      const info = await api.getInfo();
      const version = $('version-display');
      const engine = $('engine-display');
      if (version) version.textContent = `Version ${info.version}`;
      if (engine) engine.textContent = `Electron ${info.electron} / Chromium ${info.chrome}`;
    } catch {
      // leave the markup text in place
    }
  }

  // ── Event wiring (one delegated listener per event type) ──────────────────
  const actions = {
    section: (node) => showSection(node.dataset.arg, true),
    reset: (node) => resetSection(node.dataset.arg),
    'reset-accent': () => resetAccent(),
    'clear-data': () => clearData(),
    'reset-permission': (node) => resetPermission(node),
    'make-default': () => api && api.openDefaultBrowserSettings(),
    'open-download': (node) => {
      const item = downloadById(node);
      if (item && api) api.downloads.open(item.id);
    },
    'show-download': (node) => {
      const item = downloadById(node);
      if (item && api) api.downloads.showInFolder(item.id);
    },
    'clear-downloads': () => clearDownloads(),
    'delete-history': (node) => deleteHistory(node),
    'history-more': () => loadHistory(),
    'clear-history': () => clearHistory(),
  };

  document.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (node) {
      const run = actions[node.dataset.action];
      if (run) {
        e.preventDefault();
        run(node);
      }
      return;
    }
    const row = e.target instanceof Element ? e.target.closest('.history-row') : null;
    if (row) openHistoryRow(row);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof Element && e.target.classList.contains('history-row')) {
      openHistoryRow(e.target);
    }
  });

  const textInputs = {
    'homepage-url': debounce((node) => save({ homepage: node.value.trim() }), 400),
    latitude: debounce((node) => save({ homepageLatitude: node.value.trim() }), 400),
    longitude: debounce((node) => save({ homepageLongitude: node.value.trim() }), 400),
    'history-search': debounce((node) => {
      state.historyQuery = node.value.trim();
      if (state.historyLoaded) resetHistory(state.historyQuery);
    }, 250),
  };

  document.addEventListener('input', (e) => {
    const node = e.target;
    if (!(node instanceof HTMLElement)) return;
    if (node.id === 'accent-picker') {
      applyAccent(node.value); // live preview; the value is saved on change
      return;
    }
    const run = textInputs[node.id];
    if (run) run(node);
  });

  document.addEventListener('change', (e) => {
    const node = e.target;
    if (!(node instanceof HTMLElement)) return;
    const spec = CONTROLS[node.id];
    if (!spec || !api) return;
    const [key, kind] = spec;
    let value;
    if (kind === 'bool') value = node.checked;
    else if (kind === 'number') value = Number(node.value);
    else value = node.value;
    save({ [key]: value });
  });

  // A history favicon that fails to load is replaced by a neutral globe.
  document.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement && t.classList.contains('history-favicon')) {
        t.replaceWith(icon('globe', 'history-favicon'));
      }
    },
    true,
  );

  window.addEventListener('hashchange', () => showSection(sectionFromHash(), false));
  window.addEventListener('focus', () => {
    if (isActive('privacy')) refreshDefaultBrowser();
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    showSection(sectionFromHash(), false);
    if (!api) return;

    // Read incognito first: no settings callback may apply the user's accent before this is known.
    try {
      const info = await api.getInfo();
      state.incognito = !!(info && info.isIncognito);
    } catch {
      state.incognito = false;
    }
    document.documentElement.classList.toggle('incognito', state.incognito);

    api.settings.onChanged((s) => applySettings(s));
    api.downloads.onUpdated((item) => {
      if (!item || item.id === undefined) return;
      state.downloads.set(item.id, item);
      scheduleDownloadRender();
    });

    try {
      applySettings(await api.settings.get());
    } catch {
      // keep the markup defaults
    }
    renderAbout();
  }

  boot();
})();
