/* Pure settings: Home widgets and news sources (classic IIFE). Owner: B3.
 * Binds the four widget toggles to settings.homeWidgets and fills #news-sources from
 * pureInternal.home.sources(). Checked source = enabled; unchecked ids are stored in newsSources.
 * Live updates run only while the homepage section is active and the page is visible. */
(function () {
  'use strict';

  const api = window.pureInternal || null;
  const WIDGET_IDS = ['news', 'weather', 'reading', 'notes'];

  const state = {
    settings: null,
    sources: null, // [{id, name, topics}]
    stale: true, // settings changed while the section was not visible
  };

  const $ = (id) => document.getElementById(id);

  function sectionActive() {
    const section = $('homepage');
    return !!section && section.classList.contains('active') && !document.hidden;
  }

  function widgetVisible(s, id) {
    const w = s && Array.isArray(s.homeWidgets) ? s.homeWidgets.find((x) => x && x.id === id) : null;
    return w ? w.visible !== false : true;
  }

  function renderWidgetToggles(s) {
    for (const id of WIDGET_IDS) {
      const node = $(`widget-${id}-toggle`);
      if (node) node.checked = widgetVisible(s, id);
    }
  }

  // Builds the list once; afterwards only the checkboxes are updated (keeps keyboard focus).
  function renderSources(s) {
    const box = $('news-sources');
    if (!box || !state.sources) return;
    const off = new Set(s.newsSources || []);
    if (!box.querySelector('label.news-source')) {
      box.replaceChildren(...state.sources.map((src) => {
        const label = document.createElement('label');
        label.className = 'news-source';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.source = src.id;
        const name = document.createElement('span');
        name.textContent = src.name;
        label.append(input, name);
        return label;
      }));
    }
    box.querySelectorAll('input[data-source]').forEach((input) => {
      input.checked = !off.has(input.dataset.source);
    });
  }

  function sync() {
    if (!state.settings) return;
    state.stale = false;
    renderWidgetToggles(state.settings);
    renderSources(state.settings);
  }

  function maybeSync() {
    if (state.stale && sectionActive()) sync();
  }

  function onSettings(s) {
    if (!s || typeof s !== 'object') return;
    state.settings = s;
    if (!sectionActive()) {
      state.stale = true;
      return;
    }
    sync();
  }

  async function saveWidgetVisible(id, visible) {
    if (!api || !state.settings) return;
    const next = WIDGET_IDS.map((wid) => ({
      id: wid,
      visible: wid === id ? visible : widgetVisible(state.settings, wid),
    }));
    try {
      onSettings(await api.settings.set({ homeWidgets: next }));
    } catch {
      sync(); // revert the control to the stored value
    }
  }

  async function saveSourceEnabled(id, enabled) {
    if (!api || !state.settings) return;
    const off = new Set(state.settings.newsSources || []);
    if (enabled) off.delete(id);
    else off.add(id);
    try {
      onSettings(await api.settings.set({ newsSources: [...off] }));
    } catch {
      sync();
    }
  }

  document.addEventListener('change', (e) => {
    const node = e.target;
    if (!(node instanceof HTMLInputElement)) return;
    const widget = /^widget-(news|weather|reading|notes)-toggle$/.exec(node.id);
    if (widget) {
      saveWidgetVisible(widget[1], node.checked);
      return;
    }
    if (node.dataset.source && node.closest('#news-sources')) {
      saveSourceEnabled(node.dataset.source, node.checked);
    }
  });

  // Re-sync when the user comes back to the section (hash changes do not fire for nav clicks).
  document.addEventListener('click', (e) => {
    const nav = e.target instanceof Element ? e.target.closest('[data-action="section"][data-arg="homepage"]') : null;
    if (nav) setTimeout(maybeSync, 0);
  });
  window.addEventListener('hashchange', maybeSync);
  document.addEventListener('visibilitychange', maybeSync);

  async function boot() {
    if (!api) return;
    api.settings.onChanged(onSettings);
    try {
      state.sources = await api.home.sources();
    } catch {
      state.sources = [];
    }
    state.stale = true;
    try {
      onSettings(await api.settings.get());
    } catch {
      // keep the markup defaults
    }
    maybeSync();
  }

  boot();
})();
