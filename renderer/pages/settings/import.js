/* Settings › Import (pure://settings/#import). Owner: F1 (2.5 round). Classic script, runs after settings.js.
 * #import-sources holds one label.import-row[data-source] per browser, each with a radio input[name="import-source"]
 * (disabled when unavailable), span.import-name and span.import-detail. Choosing a radio selects the source:
 * #import-profile-select lists its profiles (hidden while there is only one) and the checkboxes follow what the
 * source supports. The static #import-run button runs the selected source. The "From a file" buttons are handled
 * only inside this section; the Passwords section has its own import button (F5 handles that one).
 * #import-passwords-hint shows the Firefox note (and the v20 note after an import); it is empty otherwise.
 * #import-status gets div.import-line children (.import-warning / .import-error); data-state = busy|done|warning|error.
 * Refreshes the list only while the section is shown (no polling). All text is set with textContent. */
(function () {
  'use strict';

  const importer = window.pureInternal && window.pureInternal.importer ? window.pureInternal.importer : null;
  const $ = (id) => document.getElementById(id);
  const numberFormat = new Intl.NumberFormat('en-US');
  const FILE_ACTIONS = ['import-passwords-csv', 'import-bookmarks-html', 'export-bookmarks'];
  const FIREFOX_HINT = 'Firefox passwords can’t be read by other apps. Export a CSV from Firefox ' +
    '(about:logins › ⋯ › Export Logins) and use Import passwords from CSV below.';
  const V20_WARNING = /only .+ can read (it|them)\./;

  let sources = [];
  let selectedId = null;
  let running = false;
  let refreshing = false;

  const section = () => $('import');
  const isActive = () => !!section() && section().classList.contains('active') && !document.hidden;
  const inSection = (node) => !!section() && node instanceof Element && section().contains(node);
  const selectedSource = () => sources.find((s) => s.id === selectedId) || null;
  const plural = (n, one, many) => (n === 1 ? one : many);

  // "a", "a and b", "a, b and c"
  function joinList(parts) {
    if (parts.length <= 1) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  function checked(id) {
    const node = $(id);
    return !!node && !node.disabled && node.checked === true;
  }

  // state: '' | 'busy' | 'done' | 'warning' | 'error'. Lines: the text, then each warning as its own line.
  function setStatus(state, text, warnings) {
    const node = $('import-status');
    if (!node) return;
    node.dataset.state = state || '';
    node.textContent = '';
    const addLine = (msg, cls) => {
      const line = document.createElement('div');
      line.className = 'import-line' + (cls ? ` ${cls}` : '');
      line.textContent = String(msg);
      node.append(line);
    };
    if (text) addLine(text, state === 'error' ? 'import-error' : '');
    for (const w of Array.isArray(warnings) ? warnings.filter(Boolean) : []) addLine(w, 'import-warning');
  }

  function setHint(text) {
    const hint = $('import-passwords-hint');
    if (hint) hint.textContent = text || '';
  }

  // Disables what can't run right now: Import when no available source is selected, everything while running.
  function refreshButtons() {
    const host = section();
    if (!host) return;
    const src = selectedSource();
    const run = $('import-run');
    if (run) run.disabled = running || !src || !src.available;
    FILE_ACTIONS.forEach((action) => {
      host.querySelectorAll(`[data-action="${action}"]`).forEach((btn) => {
        btn.disabled = running;
      });
    });
    host.setAttribute('aria-busy', running ? 'true' : 'false');
  }

  function setBusy(busy) {
    running = busy;
    refreshButtons();
  }

  // Sets one checkbox: enabled only when the source supports it. Settings is hidden for sources without it.
  function setBox(id, enabled, checkedByDefault, hideWhenOff) {
    const node = $(id);
    if (!node) return;
    node.disabled = !enabled;
    node.checked = enabled && checkedByDefault;
    const box = node.closest('label') || node;
    if (hideWhenOff) box.hidden = !enabled;
    else box.classList.toggle('disabled', !enabled);
  }

  function applyDefaults(src) {
    const sup = src && src.supports ? src.supports : {};
    setBox('import-bookmarks-cb', !!sup.bookmarks, true, false);
    setBox('import-history-cb', !!sup.history, true, false);
    setBox('import-passwords-cb', !!sup.passwords, true, false);
    setBox('import-settings-cb', !!sup.settings, false, true);
    setHint(src && src.id === 'firefox' ? FIREFOX_HINT : '');
  }

  function renderProfiles(resetChoice) {
    const select = $('import-profile-select');
    if (!select) return;
    const src = selectedSource();
    const profiles = src && Array.isArray(src.profiles) ? src.profiles.filter((p) => p && typeof p.id === 'string') : [];
    const keep = resetChoice ? '' : select.value;
    select.textContent = '';
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = String(p.name || p.id);
      select.append(opt);
    }
    if (keep && profiles.some((p) => p.id === keep)) select.value = keep;
    select.hidden = profiles.length <= 1;
    select.disabled = profiles.length === 0;
  }

  function renderSources() {
    const host = $('import-sources');
    if (!host) return;
    host.textContent = '';
    if (!sources.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No browsers were found on this computer.';
      host.append(empty);
      return;
    }
    for (const src of sources) {
      const label = document.createElement('label');
      label.className = 'import-row' + (src.available ? '' : ' unavailable');
      label.dataset.source = String(src.id);

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'import-source';
      radio.value = String(src.id);
      radio.disabled = !src.available || running;
      radio.checked = src.id === selectedId;

      const name = document.createElement('span');
      name.className = 'import-name';
      name.textContent = String(src.name || src.id);

      const detail = document.createElement('span');
      detail.className = 'import-detail';
      detail.textContent = String(src.detail || '');

      label.append(radio, name, detail);
      host.append(label);
    }
  }

  // Reflects the selection in the radios and row classes, without rebuilding the rows (focus stays put).
  function markSelectedRow() {
    const host = $('import-sources');
    if (!host) return;
    host.querySelectorAll('.import-row').forEach((row) => {
      const on = row.dataset.source === selectedId;
      row.classList.toggle('selected', on);
      const radio = row.querySelector('input[name="import-source"]');
      if (radio) radio.checked = on;
    });
  }

  // Selecting a source: its profiles and checkboxes come up; the defaults are reapplied only when it changes.
  function selectSource(id) {
    const src = sources.find((s) => s.id === id) || null;
    const changed = (src ? src.id : null) !== selectedId;
    selectedId = src ? src.id : null;
    if (changed) {
      applyDefaults(src);
      renderProfiles(true);
    }
    markSelectedRow();
    refreshButtons();
  }

  // The profile to import from: the select's value when it belongs to the selected source, otherwise the first one.
  function profileFor(src) {
    if (!src || !Array.isArray(src.profiles) || !src.profiles.length) return undefined;
    const select = $('import-profile-select');
    if (select && select.value && src.profiles.some((p) => p && p.id === select.value)) return select.value;
    return src.profiles[0].id;
  }

  function profileLabel(src, id) {
    if (!src || id === undefined || !Array.isArray(src.profiles)) return '';
    const p = src.profiles.find((x) => x && x.id === id);
    return p && p.name ? String(p.name) : '';
  }

  function describeImport(src, what, result) {
    if (!result || typeof result !== 'object') return { state: 'error', text: 'The import failed. Please try again.', warnings: [] };
    if (result.error) return { state: 'error', text: String(result.error), warnings: [] };

    const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
    const bookmarks = Number(result.bookmarks) || 0;
    const history = Number(result.history) || 0;
    const passwords = Number(result.passwords) || 0;
    const updated = Number(result.passwordsUpdated) || 0;
    const pieces = [];
    if (bookmarks > 0) pieces.push(`${numberFormat.format(bookmarks)} ${plural(bookmarks, 'bookmark', 'bookmarks')}`);
    if (history > 0) pieces.push(`${numberFormat.format(history)} history ${plural(history, 'entry', 'entries')}`);
    if (passwords > 0) {
      let piece = `${numberFormat.format(passwords)} ${plural(passwords, 'password', 'passwords')}`;
      if (updated > 0) piece += ` (${numberFormat.format(updated)} updated)`;
      pieces.push(piece);
    }
    if (result.settings === true) pieces.push('your settings');

    const pName = profileLabel(src, what.profile);
    const from = ` from ${src.name}${pName ? ` (${pName})` : ''}`;
    const state = warnings.length ? 'warning' : 'done';
    if (!pieces.length) return { state, text: `Nothing new to import${from}.`, warnings };
    return { state, text: `Imported ${joinList(pieces)}${from}.`, warnings };
  }

  // The v20 note is the one warning worth keeping in view: it goes to the hint line, the rest stays in the status.
  function splitWarnings(warnings) {
    const v20 = warnings.filter((w) => V20_WARNING.test(w));
    return { hint: v20.join(' '), rest: warnings.filter((w) => !V20_WARNING.test(w)) };
  }

  async function runImport() {
    if (running || !importer) return;
    const src = selectedSource();
    if (!src || !src.available) {
      setStatus('error', 'Choose a browser to import from.');
      return;
    }
    const what = {
      bookmarks: checked('import-bookmarks-cb'),
      history: checked('import-history-cb'),
      passwords: checked('import-passwords-cb'),
      settings: checked('import-settings-cb'),
    };
    const profile = profileFor(src);
    if (profile !== undefined) what.profile = profile;
    if (!what.bookmarks && !what.history && !what.passwords && !what.settings) {
      setStatus('error', 'Choose at least one thing to import.');
      return;
    }

    setBusy(true);
    setStatus('busy', `Importing from ${src.name}…`);
    try {
      const result = await importer.run(src.id, what);
      const out = describeImport(src, what, result);
      const split = splitWarnings(out.warnings);
      setStatus(out.state, out.text, split.rest);
      setHint(split.hint || (src.id === 'firefox' ? FIREFOX_HINT : ''));
    } catch {
      setStatus('error', 'The import failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Native dialogs: a cancelled dialog returns null and leaves the status alone.
  async function runFile(action) {
    if (running || !importer) return;
    setBusy(true);
    try {
      if (action === 'export-bookmarks') {
        setStatus('busy', 'Exporting bookmarks…');
        const result = await importer.exportBookmarks();
        if (!result) setStatus('', '');
        else if (result.error) setStatus('error', String(result.error));
        else {
          const n = Number(result.count) || 0;
          setStatus('done', `Exported ${numberFormat.format(n)} ${plural(n, 'bookmark', 'bookmarks')} to ${String(result.path || 'the file')}.`);
        }
        return;
      }
      const kind = action === 'import-passwords-csv' ? 'passwords-csv' : 'bookmarks-html';
      setStatus('busy', 'Choose a file…');
      const result = await importer.importFile(kind);
      if (!result) {
        setStatus('', '');
        return;
      }
      if (result.error) {
        setStatus('error', String(result.error));
        return;
      }
      const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
      const skipped = Number(result.skipped) || 0;
      let text;
      if (kind === 'passwords-csv') {
        const n = Number(result.passwords) || 0;
        const updated = Number(result.passwordsUpdated) || 0;
        text = n > 0
          ? `Imported ${numberFormat.format(n)} ${plural(n, 'password', 'passwords')} from the file.`
          : 'No new passwords in that file.';
        if (updated > 0) text += ` ${numberFormat.format(updated)} updated.`;
        if (skipped > 0) text += ` ${numberFormat.format(skipped)} ${plural(skipped, 'row', 'rows')} skipped (no website or password).`;
      } else {
        const n = Number(result.bookmarks) || 0;
        text = n > 0
          ? `Imported ${numberFormat.format(n)} ${plural(n, 'bookmark', 'bookmarks')} from the file.`
          : 'No new bookmarks in that file.';
        if (skipped > 0) text += ` ${numberFormat.format(skipped)} already saved or over the limit.`;
      }
      setStatus(warnings.length ? 'warning' : 'done', text, warnings);
    } catch {
      setStatus('error', 'The import failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Renders the list. Keeps the selection when the source is still there; otherwise picks the first available one.
  async function refresh() {
    if (!importer || !isActive() || running || refreshing) return;
    refreshing = true;
    try {
      const list = await importer.detect();
      sources = (Array.isArray(list) ? list : []).filter((s) => s && typeof s === 'object' && typeof s.id === 'string');
      renderSources();
      if (!sources.some((s) => s.id === selectedId && s.available)) {
        const firstAvailable = sources.find((s) => s.available) || null;
        selectedId = null;
        if (firstAvailable) selectSource(firstAvailable.id);
        else applyDefaults(null);
      }
      renderProfiles(false);
      markSelectedRow();
      refreshButtons();
    } catch {
      sources = [];
      renderSources();
      setStatus('error', 'Could not check the installed browsers.');
    } finally {
      refreshing = false;
    }
  }

  // One delegated click listener, scoped to #import: the Passwords section's import button is not ours.
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !inSection(target)) return;
    const btn = target.closest('[data-action]');
    if (!btn || !inSection(btn)) return;
    const action = btn.dataset.action;
    if (action === 'run-import') {
      e.preventDefault();
      runImport();
    } else if (FILE_ACTIONS.includes(action)) {
      e.preventDefault();
      runFile(action);
    }
  });

  // Choosing a browser (radio) selects it; nothing runs on choice.
  document.addEventListener('change', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !inSection(target)) return;
    if (target.matches('input[name="import-source"]') && !target.disabled) {
      selectSource(target.value);
    }
  });

  // Refresh when the section is shown (class change on #import) and when the page becomes visible again.
  function watchSection() {
    const node = section();
    if (!node) return;
    let wasActive = node.classList.contains('active');
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => {
        const active = node.classList.contains('active');
        if (active && !wasActive) refresh();
        wasActive = active;
      });
      observer.observe(node, { attributes: true, attributeFilter: ['class'] });
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
