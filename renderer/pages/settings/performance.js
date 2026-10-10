/* Pure settings › Performance (pure://settings/#performance). Owner: B2.
 * Classic IIFE, loaded after settings.js. Polls pureInternal.performance.snapshot() every 2 s, and only
 * while #performance is the visible section and the page is not hidden. Rows are keyed by tab id and
 * updated in place, so a poll only touches the text that changed. */
(() => {
  'use strict';

  const POLL_MS = 2000;
  const api = window.pureInternal && window.pureInternal.performance;
  const section = document.getElementById('performance');
  const totalEl = document.getElementById('perf-total');
  const listEl = document.getElementById('perf-list');
  if (!api || !section || !listEl) return;

  const rows = new Map(); // tabId -> { el, img, title, mem, cpu, btn, favicon }
  let timer = null;
  let busy = false;

  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

  // One decimal under 10, integer otherwise.
  function fmtNumber(v) {
    const n = num(v);
    return n < 10 ? n.toFixed(1) : String(Math.round(n));
  }
  const fmtMB = (v) => `${fmtNumber(v)} MB`;

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function span(cls) {
    const s = document.createElement('span');
    s.className = cls;
    return s;
  }

  function createRow(id) {
    const el = document.createElement('div');
    el.className = 'perf-row';
    el.dataset.tabId = String(id);

    const img = document.createElement('img');
    img.className = 'perf-favicon';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.hidden = true;

    const title = span('perf-title');
    const mem = span('perf-mem');
    const cpu = span('perf-cpu');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'perf-sleep';
    btn.dataset.action = 'sleep-tab';
    btn.dataset.arg = String(id);
    btn.textContent = 'Sleep';

    el.append(img, title, mem, cpu, btn);
    return { el, img, title, mem, cpu, btn, favicon: '' };
  }

  function updateRow(r, t) {
    r.el.classList.toggle('sleeping', !!t.discarded);
    r.el.classList.toggle('active', !!t.active);
    r.el.classList.toggle('audible', !!t.audible);
    r.el.classList.toggle('shared', !!t.shared);
    const url = typeof t.url === 'string' ? t.url : '';
    if (r.el.title !== url) r.el.title = url;

    if (r.favicon !== t.favicon) {
      r.favicon = t.favicon || '';
      if (r.favicon) {
        r.img.src = r.favicon;
        r.img.hidden = false;
      } else {
        r.img.removeAttribute('src');
        r.img.hidden = true;
      }
    }

    setText(r.title, t.title || url || 'Untitled');
    setText(r.mem, t.discarded ? fmtMB(0) : fmtMB(t.memoryMB));
    setText(r.cpu, `${Math.round(num(t.cpuPercent))}% CPU`);
    r.btn.disabled = !!(t.discarded || t.active || t.audible);
  }

  function render(snap) {
    if (!snap || typeof snap !== 'object') return;
    setText(
      totalEl,
      `${fmtMB(snap.totalMB)} · ${Math.round(num(snap.cpuPercent))}% CPU · ${snap.sleeping || 0} sleeping`,
    );

    const list = Array.isArray(snap.tabs) ? snap.tabs.slice() : [];
    list.sort((a, b) => num(b.memoryMB) - num(a.memoryMB) || a.tabId - b.tabId);

    const seen = new Set();
    let cursor = null; // the row that should come right before the next one
    for (const t of list) {
      if (!t || !Number.isInteger(t.tabId)) continue;
      seen.add(t.tabId);
      let r = rows.get(t.tabId);
      if (!r) {
        r = createRow(t.tabId);
        rows.set(t.tabId, r);
      }
      updateRow(r, t);
      const want = cursor ? cursor.nextSibling : listEl.firstChild;
      if (r.el !== want) listEl.insertBefore(r.el, want);
      cursor = r.el;
    }

    for (const [id, r] of rows) {
      if (!seen.has(id)) {
        r.el.remove();
        rows.delete(id);
      }
    }
  }

  function isOpen() {
    return section.classList.contains('tab-content') && section.classList.contains('active') && !document.hidden;
  }

  async function refresh() {
    if (busy || !isOpen()) return;
    busy = true;
    try {
      render(await api.snapshot());
    } catch {
      // keep the rows as they are; the next tick retries
    } finally {
      busy = false;
    }
  }

  // Starts or stops the poll for the current visibility. Idempotent.
  function sync() {
    if (isOpen()) {
      if (!timer) {
        timer = setInterval(refresh, POLL_MS);
        refresh();
      }
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // A missing favicon (or one that fails to load) falls back to the empty slot.
  listEl.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement && t.classList.contains('perf-favicon')) t.hidden = true;
    },
    true,
  );

  document.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!node) return;
    switch (node.dataset.action) {
      case 'section':
        // settings.js switches the section in this same click; check after it has run.
        setTimeout(sync, 0);
        break;
      case 'sleep-tab': {
        const row = node.closest('.perf-row');
        const id = Number(node.dataset.arg || (row && row.dataset.tabId));
        if (!Number.isInteger(id)) break;
        node.disabled = true;
        api.sleepTab(id).catch(() => {}).finally(refresh);
        break;
      }
      case 'sleep-all':
        api.sleepAll().catch(() => {}).finally(refresh);
        break;
      default:
        break;
    }
  });

  window.addEventListener('hashchange', () => setTimeout(sync, 0));
  document.addEventListener('visibilitychange', sync);

  sync();
})();
