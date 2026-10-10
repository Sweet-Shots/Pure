/* Settings > Privacy: ad and tracker blocking stats, top blocked domains, per-site exceptions.
 * Owner: B1. Classic IIFE, data from window.pureInternal.blocking only. Actions use data-action with one
 * delegated click listener. Live updates (onStats) run only while the privacy section is shown and the
 * document is visible. */
(function () {
  'use strict';

  const api = window.pureInternal || null;
  if (!api || !api.blocking) return;

  const $ = (id) => document.getElementById(id);
  const section = $('privacy');
  if (!section) return;

  const numFmt = new Intl.NumberFormat();
  const pctFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

  let live = false;
  let unsubscribe = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setText(id, text) {
    const node = $(id);
    if (node && node.textContent !== text) node.textContent = text;
  }

  // Bytes with binary units (1 KB = 1024 B).
  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024 * 1024) return `${pctFmt.format(v / (1024 * 1024 * 1024))} GB`;
    if (v >= 1024 * 1024) return `${pctFmt.format(v / (1024 * 1024))} MB`;
    if (v >= 1024) return `${pctFmt.format(v / 1024)} KB`;
    return `${numFmt.format(v)} B`;
  }

  function dayLabel(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return key || '';
    return dayFmt.format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  function renderStats(stats) {
    if (!stats || typeof stats !== 'object') return;
    setText('stat-today', numFmt.format(stats.today || 0));
    setText('stat-week', numFmt.format(stats.week || 0));
    setText('stat-total', numFmt.format(stats.total || 0));
    setText('stat-data-saved', formatBytes(stats.bytesSaved)); // the label already says "est."
    renderChart(Array.isArray(stats.days) ? stats.days : []);
    renderTop(Array.isArray(stats.topDomains) ? stats.topDomains : []);
  }

  // 30 bars, each scaled to the busiest day. --h is 0..1; the bar height comes from CSS.
  function renderChart(days) {
    const chart = $('stat-chart');
    if (!chart) return;
    const max = days.reduce((m, d) => Math.max(m, Number(d.count) || 0), 0);
    const bars = days.map((d) => {
      const count = Number(d.count) || 0;
      const bar = el('div', 'stat-bar');
      bar.style.setProperty('--h', String(max > 0 ? count / max : 0));
      bar.title = `${dayLabel(d.date)} · ${numFmt.format(count)} blocked`;
      return bar;
    });
    chart.replaceChildren(...bars);
  }

  function renderTop(domains) {
    const list = $('top-blocked-list');
    if (!list) return;
    if (!domains.length) {
      list.replaceChildren(el('div', 'empty-state', 'Nothing blocked yet.'));
      return;
    }
    const rows = domains.map((d) => {
      const row = el('div', 'top-row');
      row.append(el('span', 'top-domain', String(d.domain || '')), el('span', 'top-n', numFmt.format(Number(d.count) || 0)));
      return row;
    });
    list.replaceChildren(...rows);
  }

  function renderExceptions(hosts) {
    const list = $('shield-exceptions-list');
    if (!list) return;
    if (!hosts.length) {
      list.replaceChildren(el('div', 'empty-state', 'No sites have blocking turned off.'));
      return;
    }
    const rows = hosts.map((host) => {
      const row = el('div', 'exception-row');
      const remove = el('button', 'exception-remove', 'Turn blocking on');
      remove.type = 'button';
      remove.dataset.action = 'remove-exception';
      remove.dataset.host = host;
      row.append(el('span', 'exception-host', host), remove);
      return row;
    });
    list.replaceChildren(...rows);
  }

  async function refreshExceptions() {
    try {
      const hosts = await api.blocking.exceptions();
      renderExceptions(Array.isArray(hosts) ? hosts.filter((h) => typeof h === 'string') : []);
    } catch {
      // keep what is shown
    }
  }

  async function refreshAll() {
    try {
      renderStats(await api.blocking.stats());
    } catch {
      // keep what is shown
    }
    refreshExceptions();
  }

  function onLiveStats(stats) {
    renderStats(stats);
    refreshExceptions();
  }

  // Live updates only while the privacy section is the visible one.
  function syncLive() {
    const want = section.classList.contains('active') && !document.hidden;
    if (want === live) return;
    live = want;
    if (want) {
      unsubscribe = api.blocking.onStats(onLiveStats);
      refreshAll();
    } else if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  const actions = {
    'reset-stats': async () => {
      if (!window.confirm('Reset all blocking statistics? This clears the counts, the chart and the top domains. Your exceptions are kept.')) return;
      try {
        renderStats(await api.blocking.resetStats());
      } catch {
        // main refused; nothing changed
      }
      refreshExceptions();
    },
    'remove-exception': async (node) => {
      const host = node.dataset.host;
      if (!host) return;
      try {
        await api.blocking.removeException(host);
      } catch {
        // host stays listed
      }
      refreshExceptions();
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

  new MutationObserver(syncLive).observe(section, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', syncLive);
  syncLive();
})();
