/* Pure new-tab page (pure://home/). Owner: B3.
 * Core: greeting, search, slogan, quick links, accent, the widget board (order, hide/show, pointer-drag
 * reorder, customize mode) and boot. Widget data lives in widgets.js; shared helpers in shared.js.
 * Load order: shared.js, widgets.js, home.js. Data comes from window.pureInternal only. No inline
 * handlers: controls carry data-action and one delegated click listener dispatches them. */
(function () {
  'use strict';

  const api = window.pureInternal || null;
  const H = window.PureHome;
  const W = window.PureHomeWidgets || null;
  const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=';
  const MAX_QUICK_LINKS = 24;
  const SLOGAN = 'Nothing more. Nothing less.';
  const WIDGET_IDS = ['news', 'weather', 'reading', 'notes'];
  // Same values as renderer/browser/js/theme.js: incognito accent is always red.
  const INCOGNITO_ACCENT = '#c04040';
  const INCOGNITO_ACCENT_DIM = '#6b2020';

  const state = {
    settings: null,
    incognito: false,
    sloganTimer: 0,
    sloganStep: null,
    minuteTimer: 0,
    drag: null, // { id, grip, section, board, lastKey }
  };

  const $ = (id) => document.getElementById(id);

  // ── Accent ─────────────────────────────────────────────────────────────────
  function hexToDim(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (shift) => Math.round(((n >> shift) & 255) * 0.35).toString(16).padStart(2, '0');
    return `#${ch(16)}${ch(8)}${ch(0)}`;
  }

  // Incognito pages are always red, whatever the user's accent setting is.
  function applyAccent(color) {
    const style = document.documentElement.style;
    if (state.incognito) {
      style.setProperty('--accent', INCOGNITO_ACCENT);
      style.setProperty('--accent-dim', INCOGNITO_ACCENT_DIM);
      return;
    }
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
    style.setProperty('--accent', color);
    style.setProperty('--accent-dim', hexToDim(color));
  }

  // ── Greeting and minute timer (the only timer; paused while hidden or incognito) ──
  function greetingFor(date) {
    const h = date.getHours();
    if (h >= 5 && h < 12) return 'Good morning';
    if (h >= 12 && h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function renderGreeting(date) {
    const el = $('greeting');
    if (!el) return;
    const text = greetingFor(date);
    if (el.textContent !== text) el.textContent = text;
  }

  function minuteTick() {
    const now = new Date();
    renderGreeting(now);
    if (W) W.onMinute(now);
  }

  function scheduleMinute() {
    clearTimeout(state.minuteTimer);
    state.minuteTimer = 0;
    if (document.hidden || state.incognito) return;
    minuteTick();
    const delay = 60000 - (Date.now() % 60000) + 50;
    state.minuteTimer = setTimeout(scheduleMinute, delay);
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  // Returns the URL to load for the search box text, or null for empty input.
  function buildSearchUrl(raw) {
    const q = raw.trim();
    if (!q) return null;
    if (/^https?:\/\/\S+$/i.test(q)) return q;
    // Any other scheme ("file://", "javascript:") is treated as plain search text.
    const otherScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(q);
    if (!otherScheme && !/\s/.test(q) && q.includes('.')) return 'https://' + q;
    const engine = state.settings && state.settings.searchEngine ? state.settings.searchEngine : DEFAULT_SEARCH;
    return engine + encodeURIComponent(q);
  }

  function bindSearch() {
    const input = $('search-input');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const url = buildSearchUrl(input.value);
      if (url) location.href = url;
    });
  }

  // 2.5 — F3: with focusAddressBarOnNewTab on (the default), the browser's address bar keeps the caret and this page
  // does not take it. With the setting off, the search box takes focus when the page loads, as in 1.1.1.
  // Called once the settings are known, so a late settings read cannot steal focus from the address bar.
  function focusSearchIfWanted() {
    const input = $('search-input');
    if (!input || !state.settings || state.settings.focusAddressBarOnNewTab !== false) return;
    setTimeout(() => input.focus(), 100);
  }

  // ── Slogan: types the first slogan once, then stops (no idle timers) ───────
  function startSlogan() {
    const el = $('slogan');
    if (!el) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = SLOGAN;
      return;
    }
    let pos = 0;
    state.sloganStep = () => {
      state.sloganTimer = 0;
      pos++;
      el.textContent = SLOGAN.slice(0, pos);
      if (pos < SLOGAN.length) {
        state.sloganTimer = setTimeout(state.sloganStep, 45);
      } else {
        state.sloganStep = null; // finished: nothing left to resume
      }
    };
    el.textContent = '';
    state.sloganTimer = setTimeout(state.sloganStep, 250);
  }

  function sloganVisibility() {
    if (document.hidden) {
      clearTimeout(state.sloganTimer);
      state.sloganTimer = 0;
    } else if (!state.sloganTimer && state.sloganStep) {
      state.sloganStep(); // resume where it stopped
    }
  }

  // ── Quick links ────────────────────────────────────────────────────────────
  function buildQuickLink(link, index) {
    const a = document.createElement('a');
    a.className = 'quick-link';
    a.href = link.url;
    a.title = link.url;
    a.dataset.index = String(index);

    const img = document.createElement('img');
    img.className = 'quick-link-favicon';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.dataset.fallback = 'hide';
    const src = H.faviconFor(link.url);
    if (src) img.src = src;

    const title = H.el('span', 'quick-link-title', link.title);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quick-link-remove';
    remove.dataset.action = 'remove-quick-link';
    remove.setAttribute('aria-label', `Remove ${link.title}`);
    remove.append(H.icon('x'));

    a.append(img, title, remove);
    return a;
  }

  function renderQuickLinks() {
    const container = $('quick-links');
    if (!container || state.incognito || !state.settings) return;
    // The "+ Add" button is static markup outside #quick-links; only the links are rendered here.
    container.replaceChildren(...state.settings.quickLinks.map((link, i) => buildQuickLink(link, i)));
  }

  function openQuickLinkModal() {
    const modal = $('quick-link-modal');
    if (!modal) return;
    modal.classList.add('open');
    const title = $('quick-link-title');
    if (title) title.focus();
  }

  function closeQuickLinkModal() {
    const modal = $('quick-link-modal');
    if (modal) modal.classList.remove('open');
    const title = $('quick-link-title');
    const url = $('quick-link-url');
    if (title) title.value = '';
    if (url) {
      url.value = '';
      url.removeAttribute('aria-invalid');
    }
  }

  async function saveQuickLink() {
    const titleEl = $('quick-link-title');
    const urlEl = $('quick-link-url');
    const title = titleEl ? titleEl.value.trim().slice(0, 60) : '';
    let raw = urlEl ? urlEl.value.trim() : '';
    if (!title || !raw) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;

    let url = '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
    } catch {
      url = '';
    }
    if (!url) {
      if (urlEl) urlEl.setAttribute('aria-invalid', 'true');
      return;
    }

    const current = state.settings ? state.settings.quickLinks : [];
    closeQuickLinkModal();
    if (current.length >= MAX_QUICK_LINKS || !api) return;
    await saveSettings({ quickLinks: [...current, { title, url }] });
  }

  async function removeQuickLink(index) {
    if (!api || !state.settings) return;
    const current = state.settings.quickLinks;
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return;
    await saveSettings({ quickLinks: current.filter((_, i) => i !== index) });
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  async function saveSettings(patch) {
    if (!api) return;
    try {
      applySettings(await api.settings.set(patch));
    } catch {
      // main rejected the write: the page keeps its current state
    }
  }

  // ── Widget board: order, visibility, customize mode ─────────────────────────
  function widgetNodes() {
    const board = $('widget-board');
    return board ? [...board.querySelectorAll('section.widget[data-widget]')] : [];
  }

  function widgetVisible(s, id) {
    const w = s && Array.isArray(s.homeWidgets) ? s.homeWidgets.find((x) => x && x.id === id) : null;
    return w ? w.visible !== false : true;
  }

  function renderBoard() {
    const board = $('widget-board');
    const s = state.settings;
    if (!board || !s || state.drag) return;
    const nodes = new Map(widgetNodes().map((n) => [n.dataset.widget, n]));
    const order = (Array.isArray(s.homeWidgets) ? s.homeWidgets : []).map((w) => w.id).filter((id) => nodes.has(id));
    for (const id of nodes.keys()) if (!order.includes(id)) order.push(id);

    const current = widgetNodes().map((n) => n.dataset.widget);
    if (order.some((id, i) => id !== current[i])) {
      for (const id of order) board.appendChild(nodes.get(id));
    }
    let anyVisible = false;
    for (const [id, node] of nodes) {
      node.hidden = !widgetVisible(s, id);
      if (!node.hidden) anyVisible = true;
    }
    // Every widget hidden → classic layout (bigger greeting, slogan, narrow search); home.css keys off this.
    document.body.classList.toggle('board-empty', !anyVisible);
  }

  function renderTray() {
    const tray = $('widget-tray');
    const s = state.settings;
    if (!tray || !s) return;
    const labels = { news: 'News', weather: 'Weather', reading: 'Continue reading', notes: 'Notes' };
    const hidden = WIDGET_IDS.filter((id) => !widgetVisible(s, id));
    tray.querySelectorAll('[data-action="show-widget"]').forEach((n) => n.remove());
    for (const id of hidden) {
      const b = H.el('button', 'tray-item', labels[id]);
      b.type = 'button';
      b.dataset.action = 'show-widget';
      b.dataset.widget = id;
      b.setAttribute('aria-label', `Show ${labels[id]}`);
      tray.append(b);
    }
    tray.hidden = state.incognito || !hidden.length;
    // The wrapper carries the "Hidden widgets" label; hide it together with the tray.
    const wrap = tray.closest('.widget-tray-wrap');
    if (wrap) wrap.hidden = tray.hidden;
  }

  // Incognito pages show the logo, search and "Purely Hidden." only.
  function applyIncognitoLayout() {
    const hide = state.incognito;
    document.querySelectorAll('.normal-only').forEach((n) => {
      n.hidden = hide;
    });
    const greeting = $('greeting');
    if (greeting) greeting.hidden = hide;
    const board = $('widget-board');
    if (board) board.hidden = hide;
    const customize = document.querySelector('[data-action="customize"]');
    if (customize) customize.hidden = hide;
  }

  function setCustomizing(on) {
    document.body.classList.toggle('customizing', on);
    const btn = document.querySelector('[data-action="customize"]');
    if (btn) btn.setAttribute('aria-pressed', String(on));
  }

  async function setWidgetVisible(id, visible) {
    const s = state.settings;
    if (!api || !s || !WIDGET_IDS.includes(id)) return;
    const next = WIDGET_IDS.map((wid) => ({ id: wid, visible: wid === id ? visible : widgetVisible(s, wid) }));
    await saveSettings({ homeWidgets: next });
  }

  // Pointer-drag on .widget-grip (customize mode only). The dragged section is moved live when the
  // pointer enters another visible widget, on its upper or lower half; the order is saved on drop.
  function onPointerDown(e) {
    if (e.button !== 0 || !document.body.classList.contains('customizing')) return;
    const grip = e.target instanceof Element ? e.target.closest('.widget-grip') : null;
    if (!grip) return;
    const section = grip.closest('section.widget[data-widget]');
    const board = $('widget-board');
    if (!section || !board || !board.contains(section)) return;
    e.preventDefault();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    state.drag = { id: e.pointerId, grip, section, board, lastKey: '' };
    section.classList.add('dragging');
  }

  function onPointerMove(e) {
    const d = state.drag;
    if (!d || e.pointerId !== d.id) return;
    const others = widgetNodes().filter((n) => n !== d.section && !n.hidden);
    for (const n of others) {
      const r = n.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
      const before = e.clientY < r.top + r.height / 2;
      const key = `${n.dataset.widget}:${before ? 'b' : 'a'}`;
      if (key === d.lastKey) return;
      d.lastKey = key;
      if (before) d.board.insertBefore(d.section, n);
      else d.board.insertBefore(d.section, n.nextElementSibling);
      return;
    }
  }

  function endDrag(e) {
    const d = state.drag;
    if (!d || e.pointerId !== d.id) return;
    state.drag = null;
    d.section.classList.remove('dragging');
    try {
      d.grip.releasePointerCapture(d.id);
    } catch {
      // capture already released
    }
    const order = widgetNodes().map((n) => n.dataset.widget);
    const s = state.settings;
    if (!s || !api) return;
    const next = order.map((id) => ({ id, visible: widgetVisible(s, id) }));
    if (H.sameJson(next, s.homeWidgets)) return;
    saveSettings({ homeWidgets: next });
  }

  // ── Apply settings ─────────────────────────────────────────────────────────
  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    const prev = state.settings;
    state.settings = s;
    applyAccent(s.accentColor);
    document.body.classList.toggle('no-news-images', s.newsImages === false);
    applyIncognitoLayout();
    if (!prev || !H.sameJson(prev.quickLinks, s.quickLinks)) renderQuickLinks();
    if (!prev || !H.sameJson(prev.homeWidgets, s.homeWidgets)) {
      renderBoard();
      renderTray();
    }
    if (W) W.update(s, prev);
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  const actions = {
    'add-quick-link': () => openQuickLinkModal(),
    'close-quick-link': () => closeQuickLinkModal(),
    'save-quick-link': () => saveQuickLink(),
    'remove-quick-link': (el) => {
      const link = el.closest('[data-index]');
      if (link) removeQuickLink(Number(link.dataset.index));
    },
    customize: () => setCustomizing(!document.body.classList.contains('customizing')),
    'hide-widget': (el) => {
      const w = el.closest('[data-widget]');
      if (w) setWidgetVisible(w.dataset.widget, false);
    },
    'show-widget': (el) => setWidgetVisible(el.dataset.widget, true),
  };

  document.addEventListener('click', (e) => {
    const modal = $('quick-link-modal');
    if (modal && e.target === modal) {
      closeQuickLinkModal();
      return;
    }
    const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!el) return;
    const run = actions[el.dataset.action];
    if (!run) return; // other owners' actions (e.g. news-topic) are handled in widgets.js
    // Buttons sit inside <a class="quick-link">; keep the link from navigating.
    e.preventDefault();
    run(el);
  });

  document.addEventListener('keydown', (e) => {
    const modal = $('quick-link-modal');
    if (modal && modal.classList.contains('open')) {
      if (e.key === 'Escape') {
        closeQuickLinkModal();
      } else if (e.key === 'Enter' && e.target && e.target.id === 'quick-link-url') {
        e.preventDefault();
        saveQuickLink();
      }
      return;
    }
    if (e.key === 'Escape' && document.body.classList.contains('customizing')) setCustomizing(false);
  });

  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // Images that fail to load are hidden or removed instead of showing a broken icon.
  document.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLImageElement)) return;
      if (t.dataset.fallback === 'remove') t.remove();
      else if (t.dataset.fallback === 'hide') t.hidden = true;
    },
    true,
  );

  document.addEventListener('visibilitychange', () => {
    scheduleMinute();
    sloganVisibility();
    if (W) {
      if (document.hidden) W.onHidden();
      else W.onVisible();
    }
  });

  window.addEventListener('pagehide', () => {
    if (W) W.flush();
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    bindSearch();
    startSlogan();
    if (!api) return;

    try {
      const info = await api.getInfo();
      state.incognito = !!(info && info.isIncognito);
      const version = $('home-version');
      if (version && info && typeof info.version === 'string') version.textContent = `Pure ${info.version}`;
    } catch {
      state.incognito = false;
    }
    document.documentElement.classList.toggle('incognito', state.incognito);
    // state.incognito is final before any settings callback can run (applyAccent reads it).
    if (W) W.start(api, state.incognito);
    scheduleMinute();

    api.settings.onChanged((s) => applySettings(s));
    try {
      applySettings(await api.settings.get());
      focusSearchIfWanted();
    } catch {
      // no settings: the page keeps its markup defaults
    }
  }

  boot();
})();
