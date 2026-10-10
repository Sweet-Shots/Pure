/* Settings > My filters (#my-filters card). Owner: D3. Classic IIFE, data from window.pureInternal.blocking only.
 * Save is one delegated click listener on data-action="save-my-filters". The text is loaded on start, and reloaded
 * when the section is shown or the window regains focus, unless the user has unsaved edits (so a rule added with
 * the element picker is not overwritten by a stale textarea). Live refresh runs only while the section is
 * .tab-content.active and the document is visible. */
(function () {
  'use strict';

  const api = window.pureInternal && window.pureInternal.blocking ? window.pureInternal.blocking : null;
  if (!api) return;

  const card = document.getElementById('my-filters');
  const input = document.getElementById('my-filters-input');
  const status = document.getElementById('my-filters-status');
  if (!card || !input || !status) return;

  const numFmt = new Intl.NumberFormat();
  let dirty = false;
  let saving = false;
  let loadSeq = 0;

  function live() {
    const section = card.closest('.tab-content');
    return !!section && section.classList.contains('active') && !document.hidden;
  }

  function setStatus(text, kind) {
    status.className = kind ? `mf-status ${kind}` : 'mf-status';
    status.replaceChildren(text);
  }

  function showResult(res) {
    const rules = Number(res.rules) || 0;
    const errors = Array.isArray(res.errors) ? res.errors : [];
    if (!res.ok) {
      const first = errors[0] && errors[0].message ? errors[0].message : 'Could not save filters.';
      setStatus(first, 'error');
      return;
    }
    const summary = rules === 1 ? '1 rule saved' : `${numFmt.format(rules)} rules saved`;
    if (!errors.length) {
      setStatus(rules ? summary : 'Saved. No rules yet.', 'ok');
      return;
    }
    const head = document.createElement('span');
    head.textContent = `${summary}. ${errors.length === 1 ? '1 line' : `${errors.length} lines`} not applied:`;
    const list = document.createElement('ol');
    list.className = 'mf-errors';
    for (const err of errors) {
      const item = document.createElement('li');
      item.className = 'mf-error';
      const where = err.line ? `Line ${err.line}: ` : '';
      item.textContent = `${where}${err.message || 'Invalid rule.'}`;
      list.appendChild(item);
    }
    status.className = 'mf-status error';
    status.replaceChildren(head, list);
  }

  async function load(initial) {
    if (dirty || saving || (initial !== true && !live())) return;
    const seq = ++loadSeq;
    try {
      const text = await api.getMyFilters();
      if (seq !== loadSeq || dirty || saving) return;
      const next = typeof text === 'string' ? text : '';
      if (input.value !== next) input.value = next;
    } catch {
      // keep whatever is in the box
    }
  }

  async function save(button) {
    if (saving) return;
    saving = true;
    if (button) button.disabled = true;
    const sent = input.value;
    try {
      const res = await api.setMyFilters(sent);
      if (res && typeof res === 'object') {
        showResult(res);
        dirty = input.value !== sent;
      } else {
        setStatus('Could not save filters.', 'error');
      }
    } catch {
      setStatus('Could not save filters.', 'error');
    } finally {
      saving = false;
      if (button) button.disabled = false;
    }
  }

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const saveBtn = target.closest('[data-action="save-my-filters"]');
    if (saveBtn) {
      e.preventDefault();
      save(saveBtn);
      return;
    }
    // Showing this section (or another one) may bring it into view: refresh once the section switch has run.
    if (target.closest('[data-action="section"]')) setTimeout(load, 0);
  });

  input.addEventListener('input', () => {
    dirty = true;
  });

  window.addEventListener('focus', load);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });

  load(true);
})();
