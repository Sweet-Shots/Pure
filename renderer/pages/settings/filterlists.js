/* Settings > Privacy > Filter lists: the lists the blocker uses (built-in and custom), with rule counts and status.
 * Owner: D1. Classic IIFE, data from window.pureInternal.blocking only. Actions use data-action with one delegated
 * click listener (and one change listener for the toggles). Live updates (onListsChanged) run only while the
 * section is shown and the document is visible. Every lookup is guarded: the markup may still be changing. */
(function () {
  'use strict';

  const api = window.pureInternal || null;
  if (!api || !api.blocking) return;

  const $ = (id) => document.getElementById(id);
  const section = $('filter-lists');
  if (!section) return;
  const host = section.closest('.tab-content') || section;

  const GROUPS = [
    ['default', 'Ads & trackers'],
    ['dns', 'Multipurpose & DNS'],
    ['annoyances', 'Annoyances & cookie notices'],
    ['regional', 'Regional'],
    ['custom', 'Custom lists'],
  ];
  const numFmt = new Intl.NumberFormat();
  const rtf = typeof Intl.RelativeTimeFormat === 'function' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

  let live = false;
  let unsubscribe = null;
  let busy = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(text) {
    const node = $('fl-status');
    if (node && node.textContent !== text) node.textContent = text;
  }

  // "3 min ago", "2 days ago"; "just now" under a minute.
  function ago(ts) {
    const diff = Math.max(0, Date.now() - Number(ts || 0));
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    const units = [
      ['day', 1440],
      ['hour', 60],
      ['minute', 1],
    ];
    for (const [unit, size] of units) {
      const n = Math.floor(min / size);
      if (n >= 1) return rtf ? rtf.format(-n, unit) : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
    return 'just now';
  }

  function metaText(l) {
    const parts = [];
    if (typeof l.rules === 'number') parts.push(`${numFmt.format(l.rules)} rules`);
    else parts.push(l.enabled ? 'loading' : 'not downloaded');
    if (l.updatedAt) parts.push(`updated ${ago(l.updatedAt)}`);
    if (l.error) parts.push(`error: ${l.error}`);
    return parts.join(' · ');
  }

  function row(l) {
    const node = el('div', 'fl-row');
    node.dataset.id = l.id;
    if (l.group === 'custom') node.title = l.url || '';
    const toggle = el('input', 'fl-toggle');
    toggle.type = 'checkbox';
    toggle.checked = l.enabled === true;
    toggle.dataset.id = l.id;
    const body = el('span', 'fl-body');
    body.append(el('span', 'fl-name', String(l.name || l.id)), el('span', 'fl-meta', metaText(l)));
    node.append(toggle, body);
    if (l.group === 'custom') {
      const remove = el('button', 'fl-remove', 'Remove');
      remove.type = 'button';
      remove.dataset.action = 'remove-list';
      remove.dataset.id = l.id;
      node.append(remove);
    }
    return node;
  }

  function renderLists(st) {
    const box = $('filter-lists-groups');
    if (!box || !st || !Array.isArray(st.lists)) return;
    const byGroup = new Map(GROUPS.map(([g]) => [g, []]));
    for (const l of st.lists) {
      if (!byGroup.has(l.group)) byGroup.set(l.group, []);
      byGroup.get(l.group).push(l);
    }
    const nodes = [];
    for (const [g, title] of GROUPS) {
      const items = byGroup.get(g) || [];
      if (!items.length && g !== 'custom') continue;
      const group = el('div', 'fl-group');
      group.dataset.group = g;
      group.append(el('div', 'fl-group-title', title));
      if (!items.length) group.append(el('div', 'empty-state', 'No custom lists yet.'));
      for (const l of items) group.append(row(l));
      nodes.push(group);
    }
    box.replaceChildren(...nodes);
  }

  function renderStatus(st) {
    if (!st || busy) return;
    if (st.building) {
      setStatus('Building…');
      return;
    }
    if (!st.builtAt) {
      setStatus('Not built yet');
      return;
    }
    const rules = typeof st.rules === 'number' ? ` · ${numFmt.format(st.rules)} rules` : '';
    setStatus(`Updated ${ago(st.builtAt)}${rules}`);
  }

  function render(st) {
    if (!st) return;
    renderLists(st);
    renderStatus(st);
  }

  async function refresh() {
    try {
      render(await api.blocking.lists());
    } catch {
      // keep what is shown
    }
  }

  // Live updates only while this section is the visible one.
  function syncLive() {
    const want = host.classList.contains('active') && !document.hidden;
    if (want === live) return;
    live = want;
    if (want) {
      unsubscribe = api.blocking.onListsChanged(render);
      refresh();
    } else if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function setBusy(on) {
    busy = on;
    for (const b of section.querySelectorAll('[data-action="update-lists"], [data-action="add-list"]')) {
      b.disabled = on;
    }
  }

  const actions = {
    'add-list': async () => {
      const input = $('fl-add-url');
      const url = input ? String(input.value || '').trim() : '';
      if (!url) {
        setStatus('Enter a list address.');
        return;
      }
      try {
        const res = await api.blocking.addList(url);
        if (res && res.error) {
          setStatus(res.error);
          return;
        }
        if (input) input.value = '';
        setStatus('Added. Building…');
      } catch {
        setStatus('Could not add that list.');
      }
      refresh();
    },
    'update-lists': async () => {
      setBusy(true);
      setStatus('Updating lists…');
      try {
        const res = await api.blocking.updateLists();
        if (res && res.ok && !(res.errors && res.errors.length)) {
          setStatus('Lists updated.');
        } else {
          const msgs = (res && Array.isArray(res.errors) ? res.errors : []).map((e) => `${e.id}: ${e.message}`);
          setStatus(msgs.length ? `Some lists failed. ${msgs.join('; ')}` : 'Update failed.');
        }
      } catch {
        setStatus('Update failed.');
      } finally {
        setBusy(false);
      }
      refresh();
    },
    'remove-list': async (node) => {
      const id = node.dataset.id;
      if (!id) return;
      try {
        await api.blocking.removeList(id);
      } catch {
        // list stays listed
      }
      refresh();
    },
  };

  document.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!node || !section.contains(node)) return;
    const run = actions[node.dataset.action];
    if (!run) return;
    e.preventDefault();
    run(node);
  });

  const groupsBox = $('filter-lists-groups');
  if (groupsBox) {
    groupsBox.addEventListener('change', async (e) => {
      const toggle = e.target instanceof Element ? e.target.closest('input.fl-toggle') : null;
      if (!toggle) return;
      try {
        const st = await api.blocking.setListEnabled(toggle.dataset.id, toggle.checked);
        if (st && Array.isArray(st.lists)) render(st);
        else refresh();
      } catch {
        toggle.checked = !toggle.checked;
      }
    });
  }

  const addInput = $('fl-add-url');
  if (addInput) {
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        actions['add-list']();
      }
    });
  }

  new MutationObserver(syncLive).observe(host, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', syncLive);
  syncLive();
})();
