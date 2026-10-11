/* Settings > Passwords (C1). Classic script, loaded after settings.js. Lists saved logins with passwords masked;
 * reveal, copy, inline edit and delete; and the "never save" list.
 * Plaintext exists only while a row is revealed (re-masked after 30 s and when the section is left) or during a
 * copy. Everything from storage is written with textContent, never innerHTML. */
(function () {
  'use strict';

  const api = window.pureInternal && window.pureInternal.passwords;
  const MASK = '••••••••';
  const REVEAL_MS = 30 * 1000;
  const CONFIRM_MS = 3000;
  const TOAST_MS = 1600;
  // Inline key glyph: no network request for the row "favicon" (a saved origin is not fetched from the page).
  const KEY_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/>' +
    '<path d="m18 5 3 3"/><path d="m15 8 3 3"/></svg>');

  const state = {
    logins: [],
    never: [],
    query: '',
    revealed: new Map(), // id -> plaintext (only while revealed)
    revealTimer: 0,
    editing: null,       // id of the row in inline edit
    armed: null,         // id whose delete waits for a second click
    armTimer: 0,
    unavailable: false,  // safeStorage cannot encrypt on this device
    loadError: false,
    wasActive: false,
    toastTimer: 0,
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, action, className) {
    const b = el('button', className || 'pw-btn', label);
    b.type = 'button';
    b.dataset.action = action;
    return b;
  }

  function emptyState(text) {
    return el('div', 'empty-state', text);
  }

  function sectionShown() {
    const section = $('passwords');
    return !!section && section.classList.contains('active');
  }

  function flash(message) {
    const toast = $('save-toast');
    const text = $('save-toast-text');
    if (!toast || !text) return;
    text.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), TOAST_MS);
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  async function refresh() {
    if (!api) return;
    try {
      const [logins, never] = await Promise.all([api.list(), api.neverList()]);
      state.logins = Array.isArray(logins) ? logins : [];
      state.never = Array.isArray(never) ? never : [];
      state.unavailable = false;
      state.loadError = false;
    } catch (err) {
      const msg = err && err.message ? String(err.message) : '';
      state.unavailable = msg.includes('encryption-unavailable');
      state.loadError = !state.unavailable;
      state.logins = [];
      state.never = [];
    }
    renderList();
    renderNever();
  }

  // ── Masking ─────────────────────────────────────────────────────────────────
  function maskAll() {
    clearTimeout(state.revealTimer);
    state.revealTimer = 0;
    const ids = Array.from(state.revealed.keys());
    state.revealed.clear();
    for (const id of ids) updateRow(id);
  }

  function armRevealTimer() {
    clearTimeout(state.revealTimer);
    state.revealTimer = setTimeout(maskAll, REVEAL_MS);
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  function rowFor(id) {
    const list = $('pw-list');
    if (!list) return null;
    for (const node of list.querySelectorAll('.pw-row[data-id]')) {
      if (node.dataset.id === id) return node;
    }
    return null;
  }

  function login(id) {
    return state.logins.find((l) => l.id === id) || null;
  }

  function row(item) {
    const node = el('div', 'pw-row');
    node.dataset.id = item.id;
    if (state.editing === item.id) {
      node.classList.add('editing');
      return editRow(node, item);
    }

    const icon = el('img', 'pw-favicon');
    icon.alt = '';
    icon.src = KEY_ICON;

    const info = el('div', 'pw-info');
    info.append(
      el('div', 'pw-origin', item.origin),
      el('div', 'pw-username', item.username || '(no username)'),
      el('div', 'pw-password', state.revealed.has(item.id) ? state.revealed.get(item.id) : MASK),
    );

    const actions = el('div', 'pw-actions');
    const revealed = state.revealed.has(item.id);
    actions.append(
      button(revealed ? 'Hide' : 'Show', 'reveal-password'),
      button('Copy', 'copy-password'),
      button('Edit', 'edit-password'),
      button(state.armed === item.id ? 'Confirm delete' : 'Delete', 'delete-password'),
    );

    node.append(icon, info, actions);
    return node;
  }

  function editRow(node, item) {
    const icon = el('img', 'pw-favicon');
    icon.alt = '';
    icon.src = KEY_ICON;

    const info = el('div', 'pw-info');
    const user = el('input', 'pw-edit-username');
    user.type = 'text';
    user.value = item.username;
    user.setAttribute('aria-label', 'Username');
    user.autocomplete = 'off';
    const pass = el('input', 'pw-edit-password');
    pass.type = 'password';
    pass.placeholder = 'New password (leave blank to keep)';
    pass.setAttribute('aria-label', 'New password');
    pass.autocomplete = 'new-password';
    info.append(el('div', 'pw-origin', item.origin), user, pass);

    const actions = el('div', 'pw-actions');
    actions.append(
      button('Save', 'save-password-edit'),
      button('Cancel', 'cancel-password-edit'),
    );
    node.append(icon, info, actions);
    return node;
  }

  function renderList() {
    const list = $('pw-list');
    if (!list) return;
    list.replaceChildren();
    if (state.unavailable) {
      list.append(emptyState("Passwords can't be saved or filled on this device."));
      return;
    }
    if (state.loadError) {
      list.append(emptyState('Could not load saved passwords.'));
      return;
    }
    if (!state.logins.length) {
      list.append(emptyState('No saved passwords yet. Passwords you save on a site appear here.'));
      return;
    }
    const q = state.query;
    const rows = state.logins.filter((l) => !q
      || l.origin.toLowerCase().includes(q)
      || l.username.toLowerCase().includes(q));
    if (!rows.length) {
      list.append(emptyState('No passwords match your search.'));
      return;
    }
    for (const item of rows) list.append(row(item));
  }

  function renderNever() {
    const list = $('pw-never-list');
    if (!list) return;
    list.replaceChildren();
    if (!state.never.length) {
      list.append(emptyState('No sites are excluded. Choose "Never" in the save prompt to add one.'));
      return;
    }
    for (const origin of state.never) {
      const node = el('div', 'never-row');
      const btn = button('Remove', 'remove-never');
      btn.dataset.arg = origin;
      node.append(el('span', 'never-origin', origin), btn);
      list.append(node);
    }
  }

  // Re-renders one row in place (reveal, mask, arm delete) without rebuilding the list.
  function updateRow(id) {
    const node = rowFor(id);
    const item = login(id);
    if (!node || !item) return;
    node.replaceWith(row(item));
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function toggleReveal(id) {
    if (!api) return;
    if (state.revealed.has(id)) {
      state.revealed.delete(id);
      updateRow(id);
      return;
    }
    try {
      const password = await api.reveal(id);
      if (typeof password !== 'string') return;
      state.revealed.set(id, password);
      armRevealTimer();
      updateRow(id);
    } catch {
      flash('Could not show password');
    }
  }

  async function copyPassword(id) {
    if (!api) return;
    try {
      const password = await api.reveal(id);
      await navigator.clipboard.writeText(password);
      flash('Password copied');
    } catch {
      flash('Could not copy password');
    }
  }

  function startEdit(id) {
    maskAll();
    state.armed = null;
    state.editing = id;
    const node = rowFor(id);
    if (node) node.replaceWith(row(login(id)));
    renderEditFocus(id);
  }

  function renderEditFocus(id) {
    const node = rowFor(id);
    const input = node && node.querySelector('.pw-edit-username');
    if (input) input.focus();
  }

  async function saveEdit(id) {
    if (!api || state.editing !== id) return;
    const node = rowFor(id);
    if (!node) return;
    const user = node.querySelector('.pw-edit-username');
    const pass = node.querySelector('.pw-edit-password');
    const patch = { username: user ? user.value : '' };
    if (pass && pass.value) patch.password = pass.value;
    try {
      const saved = await api.update(id, patch);
      if (!saved) {
        flash('Not saved: that username already exists for this site');
        return;
      }
      state.editing = null;
      flash('Saved');
      await refresh();
    } catch {
      flash('Not saved');
    }
  }

  function cancelEdit() {
    const id = state.editing;
    state.editing = null;
    if (id) updateRow(id);
  }

  // Two clicks: the first arms the delete for a few seconds, the second removes the login.
  async function deleteLogin(btn) {
    if (!api) return;
    const node = btn.closest('.pw-row[data-id]');
    if (!node) return;
    const id = node.dataset.id;
    if (state.armed !== id) {
      clearTimeout(state.armTimer);
      state.armed = id;
      updateRow(id);
      state.armTimer = setTimeout(() => {
        if (state.armed === id) {
          state.armed = null;
          updateRow(id);
        }
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(state.armTimer);
    state.armed = null;
    state.revealed.delete(id);
    try {
      await api.remove(id);
      flash('Password deleted');
    } catch {
      flash('Could not delete password');
    }
    await refresh();
  }

  async function removeNever(btn) {
    if (!api) return;
    const origin = btn.dataset.arg || '';
    try {
      await api.removeNever(origin);
      flash('Site removed from the never-save list');
    } catch {
      flash('Could not update the list');
    }
    await refresh();
  }

  // ── Import ──────────────────────────────────────────────────────────────────
  // The importer (main/importer.js) owns the file picker and the CSV parsing; this page only starts it and reports
  // the result. Result: null (cancelled) | {passwords: n} | {error}. Error codes are mapped to sentences; text from
  // the file is never shown as HTML.
  const IMPORT_ERRORS = new Map([
    ['encryption-unavailable', "Passwords can't be saved on this device, so none were imported."],
    ['passwords-disabled', 'Turn on "Offer to save passwords" to import passwords.'],
    ['unreadable', 'Saved passwords could not be read, so nothing was imported.'],
  ]);
  let importing = false;

  function setImportStatus(text) {
    const node = $('pw-import-status');
    if (node) node.textContent = text;
  }

  async function importCsv() {
    const importer = window.pureInternal && window.pureInternal.importer;
    if (importing || !importer || typeof importer.importFile !== 'function') return;
    importing = true;
    try {
      const result = await importer.importFile('passwords-csv');
      if (!result) return; // the file dialog was cancelled
      if (result.error) {
        const code = String(result.error);
        const text = IMPORT_ERRORS.get(code) || code.slice(0, 300);
        setImportStatus(text);
        flash('Could not import passwords');
        return;
      }
      const n = Number.isFinite(result.passwords) ? result.passwords : 0;
      const text = n ? `Imported ${n} ${n === 1 ? 'password' : 'passwords'}.` : 'No new passwords to import.';
      setImportStatus(text);
      flash(text);
      await refresh();
    } catch {
      setImportStatus('Import failed.');
      flash('Import failed');
    } finally {
      importing = false;
    }
  }

  const actions = {
    'reveal-password': (node) => toggleReveal(node.closest('.pw-row[data-id]').dataset.id),
    'copy-password': (node) => copyPassword(node.closest('.pw-row[data-id]').dataset.id),
    'edit-password': (node) => startEdit(node.closest('.pw-row[data-id]').dataset.id),
    'delete-password': (node) => deleteLogin(node),
    'save-password-edit': (node) => saveEdit(node.closest('.pw-row[data-id]').dataset.id),
    'cancel-password-edit': () => cancelEdit(),
    'remove-never': (node) => removeNever(node),
    'import-passwords-csv': () => importCsv(),
  };

  // ── Wiring ──────────────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (node) {
      const run = actions[node.dataset.action];
      if (run && node.closest('#passwords, #pw-never-list')) {
        e.preventDefault();
        run(node);
      }
    }
    // Leaving the section by a nav button does not fire hashchange (settings.js uses replaceState), so check
    // after the click has been handled.
    if (e.target instanceof Element && e.target.closest('[data-action="section"]')) setTimeout(afterNav, 0);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof Element)) return;
    const row = e.target.closest('.pw-row.editing');
    const isEditField = e.target.classList.contains('pw-edit-password') || e.target.classList.contains('pw-edit-username');
    if (row && isEditField) saveEdit(row.dataset.id);
  });

  const onSearch = (() => {
    let t = 0;
    return (value) => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.query = value.trim().toLowerCase();
        renderList();
      }, 150);
    };
  })();

  document.addEventListener('input', (e) => {
    if (e.target instanceof HTMLElement && e.target.id === 'pw-search') onSearch(e.target.value);
  });

  function afterNav() {
    const shown = sectionShown();
    if (shown && !state.wasActive) refresh();
    if (!shown && state.wasActive) maskAll();
    state.wasActive = shown;
  }

  window.addEventListener('hashchange', afterNav);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) maskAll();
    else if (sectionShown()) refresh();
  });

  function boot() {
    if (!api || !$('passwords')) return;
    api.onChanged(() => {
      if (sectionShown() && !document.hidden) refresh();
    });
    state.wasActive = sectionShown();
    if (state.wasActive) refresh();
    else renderList();
  }

  boot();
})();
