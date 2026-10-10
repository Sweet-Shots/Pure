/* Settings > About: automatic updates (C1). Classic script, loaded after settings.js.
 * Shows main's update status (pure://settings only), a manual check, and install-on-ready. The auto-update toggle
 * (#auto-update-toggle) is saved by settings.js. All text is set with textContent. */
(function () {
  'use strict';

  const api = window.pureInternal && window.pureInternal.updater;
  const state = { status: null, busy: false };

  const $ = (id) => document.getElementById(id);
  const checkButton = () => document.querySelector('[data-action="check-updates"]');
  const installButton = () => document.querySelector('[data-action="install-update"]');

  function when(ms) {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return '';
    }
  }

  function describe(s) {
    const autoOn = $('auto-update-toggle') ? $('auto-update-toggle').checked : true;
    const ver = s.version ? ` ${s.version}` : '';
    switch (s.state) {
      case 'disabled':
        return `Updates are off: ${s.error || 'not available in this build'}.`;
      case 'checking':
        return 'Checking for updates…';
      case 'available':
        return `Version${ver} is available. Downloading…`;
      case 'downloading': {
        const pct = Math.round((s.progress || 0) * 100);
        return `Downloading version${ver}… ${pct}%`;
      }
      case 'ready':
        return `Version${ver} is ready. Restart Pure Browser to install it.`;
      case 'up-to-date': {
        const last = when(s.lastChecked);
        return last ? `Pure Browser is up to date. Last checked ${last}.` : 'Pure Browser is up to date.';
      }
      case 'error':
        return `Could not check for updates${s.error ? ': ' + s.error : ''}.`;
      default:
        return autoOn ? 'Update checks run in the background.' : 'Automatic update checks are off.';
    }
  }

  function render(s) {
    if (!s || typeof s !== 'object') return;
    state.status = s;
    const statusNode = $('update-status');
    if (statusNode) statusNode.textContent = describe(s);

    const progress = $('update-progress');
    if (progress) {
      const show = s.state === 'downloading';
      progress.hidden = !show;
      const value = show ? Math.min(Math.max(s.progress || 0, 0), 1) : 0;
      const pct = Math.round(value * 100);
      if (progress instanceof HTMLProgressElement) {
        progress.max = 1;
        progress.value = value;
      } else {
        progress.style.width = pct + '%';
        progress.setAttribute('aria-valuenow', String(pct));
      }
    }

    const install = installButton();
    if (install) install.hidden = s.state !== 'ready';

    const check = checkButton();
    if (check) check.disabled = s.state === 'disabled' || s.state === 'checking' || s.state === 'downloading' || state.busy;
  }

  async function checkNow() {
    if (!api || state.busy) return;
    state.busy = true;
    const check = checkButton();
    if (check) check.disabled = true;
    try {
      render(await api.check());
    } catch {
      render({ state: 'error', error: 'request failed', lastChecked: Date.now() });
    } finally {
      state.busy = false;
      if (state.status) render(state.status);
    }
  }

  const actions = {
    'check-updates': () => checkNow(),
    'install-update': () => {
      if (api && state.status && state.status.state === 'ready') api.installNow();
    },
  };

  document.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!node || !node.closest('#about')) return;
    const run = actions[node.dataset.action];
    if (!run) return;
    e.preventDefault();
    run(node);
  });

  function boot() {
    if (!api || !$('update-status')) return;
    api.onStatus(render);
    api.status().then(render).catch(() => {
      const statusNode = $('update-status');
      if (statusNode) statusNode.textContent = 'Could not read update status.';
    });
  }

  boot();
})();
