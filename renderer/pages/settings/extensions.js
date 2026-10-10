/* Pure settings › Extensions (pure://settings/#extensions). Owner: C2.
 * Classic IIFE, loaded after settings.js. Fills #ext-list from window.pureInternal.extensions and keeps it current
 * from the ext:list-changed push. Buttons carry data-action (one delegated listener); every lookup is guarded,
 * because the markup belongs to Visuals. All text is set with textContent. */
(() => {
  'use strict';

  const api = window.pureInternal && window.pureInternal.extensions;
  const listEl = document.getElementById('ext-list');
  const statusEl = document.getElementById('ext-status');
  if (!api || !listEl) return;

  const FALLBACK_ICON =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" ' +
        'stroke="#8a8f98" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>' +
        '</svg>'
    );
  const SOURCE_LABEL = { store: 'Chrome Web Store', unpacked: 'Unpacked folder' };

  const rows = new Map(); // extension id -> row element
  let pending = false; // one management request at a time (load / remove)

  function setStatus(message) {
    if (statusEl && statusEl.textContent !== message) statusEl.textContent = message;
  }

  function createRow(id) {
    const row = document.createElement('div');
    row.className = 'ext-row';
    row.dataset.id = id;

    const icon = document.createElement('img');
    icon.className = 'ext-icon';
    icon.alt = '';
    icon.draggable = false;

    // Flat children: the grid in settings.css places each one.
    const name = document.createElement('div');
    name.className = 'ext-name';
    const meta = document.createElement('div');
    meta.className = 'ext-meta';
    const desc = document.createElement('div');
    desc.className = 'ext-desc';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'ext-toggle';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ext-remove';
    remove.dataset.action = 'remove-extension';
    remove.textContent = 'Remove';

    row.append(icon, name, meta, desc, toggle, remove);
    return row;
  }

  function updateRow(row, ext) {
    const name = typeof ext.name === 'string' ? ext.name.slice(0, 200) : ext.id;
    const version = typeof ext.version === 'string' && ext.version ? ` · v${ext.version.slice(0, 40)}` : '';
    const source = SOURCE_LABEL[ext.source] || '';
    const error = typeof ext.error === 'string' && ext.error ? ` · Could not load: ${ext.error.slice(0, 200)}` : '';
    const iconSrc = typeof ext.icon === 'string' && ext.icon.startsWith('data:image/') ? ext.icon : FALLBACK_ICON;
    row.dataset.source = ext.source || '';
    row.dataset.name = name;
    row.classList.toggle('has-error', !!error);
    row.classList.toggle('disabled', !ext.enabled);

    const icon = row.querySelector('.ext-icon');
    if (icon && icon.getAttribute('src') !== iconSrc) icon.src = iconSrc;
    const nameEl = row.querySelector('.ext-name');
    if (nameEl && nameEl.textContent !== name) nameEl.textContent = name;
    const metaEl = row.querySelector('.ext-meta');
    const metaText = (source + version + error).replace(/^ · /, '');
    if (metaEl && metaEl.textContent !== metaText) metaEl.textContent = metaText;
    const descEl = row.querySelector('.ext-desc');
    const desc = typeof ext.description === 'string' ? ext.description.slice(0, 300) : '';
    if (descEl && descEl.textContent !== desc) descEl.textContent = desc;

    const toggle = row.querySelector('.ext-toggle');
    if (toggle) {
      toggle.checked = !!ext.enabled;
      toggle.disabled = pending;
      toggle.setAttribute('aria-label', `Enable ${name}`);
    }
    const remove = row.querySelector('[data-action="remove-extension"]');
    if (remove) {
      remove.disabled = pending;
      remove.setAttribute('aria-label', `Remove ${name}`);
    }
  }

  // Keyed render: rows are reused, so a toggle keeps keyboard focus when the list is pushed again.
  function render(list) {
    const items = Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string') : [];
    listEl.querySelectorAll('.empty-state').forEach((node) => node.remove());
    if (!items.length) {
      for (const row of rows.values()) row.remove();
      rows.clear();
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No extensions added yet.';
      listEl.append(empty);
      return;
    }
    const seen = new Set();
    items.forEach((ext, index) => {
      seen.add(ext.id);
      let row = rows.get(ext.id);
      if (!row) {
        row = createRow(ext.id);
        rows.set(ext.id, row);
      }
      updateRow(row, ext);
      if (listEl.children[index] !== row) listEl.insertBefore(row, listEl.children[index] || null);
    });
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.remove();
      rows.delete(id);
    }
  }

  function setPending(on) {
    pending = on;
    for (const row of rows.values()) {
      const toggle = row.querySelector('.ext-toggle');
      const remove = row.querySelector('[data-action="remove-extension"]');
      if (toggle) toggle.disabled = on;
      if (remove) remove.disabled = on;
    }
  }

  async function onToggle(input) {
    const row = input.closest('.ext-row');
    if (!row || pending) {
      input.checked = !input.checked;
      return;
    }
    const wanted = input.checked;
    setPending(true);
    let failed = null;
    try {
      const result = await api.setEnabled(row.dataset.id, wanted);
      if (result && result.error && !result.id) failed = result.error;
    } catch {
      failed = 'Could not change the extension.';
    }
    setPending(false);
    if (failed) {
      input.checked = !wanted; // the list is only re-sent on success, so show the real state here
      setStatus(failed);
    } else {
      setStatus(wanted ? 'Extension turned on.' : 'Extension turned off.');
    }
  }

  async function onRemove(button) {
    const row = button.closest('.ext-row');
    if (!row || pending) return;
    const name = row.dataset.name || 'this extension';
    const store = row.dataset.source === 'store';
    const message = store
      ? `Remove "${name}"? Its files are deleted from Pure. This cannot be undone.`
      : `Remove "${name}" from Pure? The folder on disk is kept.`;
    if (!window.confirm(message)) return;
    setPending(true);
    try {
      const result = await api.remove(row.dataset.id);
      setStatus(result && result.error ? result.error : `Removed ${name}.`);
    } catch {
      setStatus('Could not remove the extension.');
    } finally {
      setPending(false);
    }
  }

  async function onLoadUnpacked() {
    if (pending) return;
    setPending(true);
    setStatus('Choose an extension folder…');
    try {
      const result = await api.loadUnpacked();
      if (!result) setStatus('');
      else if (result.error && !result.id) setStatus(result.error);
      else setStatus(`Added ${result.name || 'the extension'}.`);
    } catch {
      setStatus('Could not add the folder.');
    } finally {
      setPending(false);
    }
  }

  function onOpenStore() {
    api.openStore();
    setStatus('Opened the Chrome Web Store in a new tab.');
  }

  const actions = {
    'open-web-store': onOpenStore,
    'load-unpacked': onLoadUnpacked,
    'remove-extension': onRemove,
  };

  document.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!node) return;
    const run = actions[node.dataset.action];
    if (!run) return;
    e.preventDefault();
    run(node);
  });

  listEl.addEventListener('change', (e) => {
    const input = e.target;
    if (input instanceof HTMLInputElement && input.classList.contains('ext-toggle')) onToggle(input);
  });

  api.onChanged(render);
  api.list().then(render).catch(() => setStatus('Could not load the extension list.'));
})();
