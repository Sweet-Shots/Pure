/* Settings › Import (pure://settings/#import). Owner: B4. Classic script, runs after settings.js.
 * Fills #import-sources from pureInternal.importer.detect() and runs imports for the checked items.
 * Handles only its own data-action ("run-import"). Refreshes the source list only while the import
 * section is active and the page is visible. Text is always set with textContent. */
(function () {
  'use strict';

  const importer = window.pureInternal && window.pureInternal.importer ? window.pureInternal.importer : null;
  const $ = (id) => document.getElementById(id);
  const numberFormat = new Intl.NumberFormat('en-US');
  let running = false;

  function isActive() {
    const section = $('import');
    return !!section && section.classList.contains('active') && !document.hidden;
  }

  function setStatus(text, state) {
    const node = $('import-status');
    if (!node) return;
    node.textContent = text || '';
    node.dataset.state = state || '';
  }

  function checked(id) {
    const node = $(id);
    return !!node && node.checked === true;
  }

  function setRunButtonsDisabled(disabled) {
    const host = $('import-sources');
    if (!host) return;
    host.querySelectorAll('[data-action="run-import"]').forEach((btn) => {
      btn.disabled = disabled || btn.dataset.available !== 'true';
    });
  }

  // Renders one row per detected source. Unavailable sources keep their row, with the button disabled.
  function renderSources(list) {
    const host = $('import-sources');
    if (!host) return;
    host.textContent = '';
    const rows = Array.isArray(list) ? list : [];
    for (const src of rows) {
      if (!src || typeof src !== 'object') continue;
      const row = document.createElement('div');
      row.className = 'import-row';
      row.dataset.source = String(src.id || '');

      const name = document.createElement('span');
      name.className = 'import-name';
      name.textContent = String(src.name || src.id || '');

      const detail = document.createElement('span');
      detail.className = 'import-detail';
      detail.textContent = String(src.detail || '');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = 'run-import';
      btn.dataset.available = src.available ? 'true' : 'false';
      btn.textContent = 'Import';
      btn.disabled = !src.available || running;

      row.append(name, detail, btn);
      host.append(row);
    }
  }

  async function refresh() {
    if (!importer || !isActive() || running) return;
    try {
      renderSources(await importer.detect());
    } catch {
      renderSources([]);
      setStatus('Could not check the installed browsers.', 'error');
    }
  }

  // "a", "a and b", "a, b and c"
  function joinList(parts) {
    if (parts.length <= 1) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  function describeResult(name, what, result) {
    if (!result || typeof result !== 'object') return { text: 'The import failed. Please try again.', state: 'error' };
    if (result.error) return { text: String(result.error), state: 'error' };

    const bookmarks = Number(result.bookmarks) || 0;
    const history = Number(result.history) || 0;
    const settings = result.settings === true;
    const pieces = [];
    if (what.bookmarks) pieces.push(`${numberFormat.format(bookmarks)} bookmarks`);
    if (what.history) pieces.push(`${numberFormat.format(history)} history entries`);
    if (settings) pieces.push('your settings');

    let text;
    if (!pieces.length || (bookmarks === 0 && history === 0 && !settings)) {
      text = `Nothing new to import from ${name}.`;
    } else {
      text = `Imported ${joinList(pieces)} from ${name}.`;
    }
    if (result.warning) text += ` ${String(result.warning)}`;
    return { text, state: result.warning ? 'warning' : 'done' };
  }

  async function run(id, name) {
    if (running || !importer || !id) return;
    const what = {
      bookmarks: checked('import-bookmarks-cb'),
      history: checked('import-history-cb'),
      settings: id === 'pure1' && checked('import-settings-cb'),
    };
    if (!what.bookmarks && !what.history && !what.settings) {
      setStatus('Choose at least one thing to import.', 'error');
      return;
    }

    running = true;
    setRunButtonsDisabled(true);
    setStatus(`Importing from ${name}…`, 'busy');
    try {
      const result = await importer.run(id, what);
      const out = describeResult(name, what, result);
      setStatus(out.text, out.state);
    } catch {
      setStatus('The import failed. Please try again.', 'error');
    } finally {
      running = false;
      setRunButtonsDisabled(false);
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action="run-import"]') : null;
    if (!btn || !importer) return;
    const row = btn.closest('.import-row');
    if (!row) return;
    e.preventDefault();
    const nameNode = row.querySelector('.import-name');
    run(row.dataset.source, nameNode ? nameNode.textContent : row.dataset.source);
  });

  // Re-detect when the section is shown (class change on #import) and when the page becomes visible.
  function watchSection() {
    const section = $('import');
    if (!section) return;
    let wasActive = section.classList.contains('active');
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => {
        const active = section.classList.contains('active');
        if (active && !wasActive) refresh();
        wasActive = active;
      });
      observer.observe(section, { attributes: true, attributeFilter: ['class'] });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  }

  function init() {
    if (!importer) return;
    watchSection();
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
