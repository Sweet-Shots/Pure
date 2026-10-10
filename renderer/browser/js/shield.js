// Address-bar shield: blocked-count badge for the active tab, and a popover with per-site blocking
// toggle, top blocked domains and a link to the all-time stats. Counts arrive from main
// (blocking:count, throttled); siteInfo is asked on tab activation and when the popover opens.
// The popover freezes the live page like the suggestions dropdown does, so it can draw over it.

import { $, el, pure } from './util.js';
import { on, activeTab } from './state.js';
import { acquireFreeze, registerOverlay, claimOverlay } from './freeze.js';

const btn = $('btn-shield');
const count = $('shield-count');
const box = $('shield-popover');
const hostEl = $('shield-host');
const blockedEl = $('shield-blocked');
const toggle = $('shield-toggle');
const list = $('shield-list');

const fmtPlain = new Intl.NumberFormat();
const fmtCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const fmt = (n) => (n >= 10000 ? fmtCompact.format(n) : fmtPlain.format(n));

const DOMAIN_REFRESH_MS = 500;

const counts = new Map(); // String(tabId) -> blocked count on that tab's current page
const current = {
  id: null, // active tab id (number) or null
  url: '',
  pure: true, // pure:// page or no tab: shield hidden
  host: '',
  enabled: true, // blocking on for this host (main's answer)
  blocked: 0,
  domains: [],
};
let globalOn = true;
let open = false;
let release = null;
let infoSeq = 0;
let domainTimer = 0;

function isPureUrl(url) {
  return typeof url === 'string' && url.startsWith('pure:');
}

// Badge and popover count for the active tab. Also keeps the per-tab map current.
function setBlocked(n) {
  current.blocked = n;
  count.textContent = fmt(n);
  count.hidden = n === 0 || current.pure;
  blockedEl.textContent = fmt(n);
}

function renderState() {
  const off = !globalOn || (!!current.host && !current.enabled);
  btn.classList.toggle('off', off);
  btn.style.display = current.pure ? 'none' : '';
  hostEl.textContent = current.host;
  toggle.disabled = !globalOn || !current.host;
  toggle.checked = globalOn && (!current.host || current.enabled);
}

function renderList() {
  const rows = current.domains.map((d) => {
    const row = el('div', 'shield-row');
    row.append(el('span', 'shield-domain', String(d.domain || '')), el('span', 'shield-n', fmt(Number(d.count) || 0)));
    return row;
  });
  list.replaceChildren(...rows);
}

function renderAll() {
  renderState();
  setBlocked(current.blocked);
  renderList();
}

async function loadInfo(id) {
  const seq = ++infoSeq;
  let info = null;
  try {
    info = await pure.blocking.siteInfo(id);
  } catch {
    info = null;
  }
  // Stale: another tab became active, or a newer request started.
  if (seq !== infoSeq || current.id !== id || !info) return;
  counts.set(String(id), Number(info.blocked) || 0);
  current.host = typeof info.host === 'string' ? info.host : '';
  current.enabled = info.enabled !== false;
  current.domains = Array.isArray(info.domains) ? info.domains : [];
  current.blocked = Number(info.blocked) || 0;
  renderState();
  setBlocked(current.blocked);
  renderList();
}

function scheduleDomains() {
  clearTimeout(domainTimer);
  domainTimer = setTimeout(() => {
    domainTimer = 0;
    if (open && current.id !== null) loadInfo(current.id);
  }, DOMAIN_REFRESH_MS);
}

function openPopover() {
  claimOverlay('shield');
  if (open || current.pure || current.id === null) return;
  open = true;
  box.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  if (!release) release = acquireFreeze();
  renderAll();
  loadInfo(current.id);
}

function closePopover() {
  if (!open) return;
  open = false;
  box.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
  clearTimeout(domainTimer);
  domainTimer = 0;
  if (release) {
    release();
    release = null;
  }
}

// Active tab changed (tab switch, or the list was rebuilt): reset to that tab's last known count, then ask main.
function onActive() {
  closePopover();
  const t = activeTab();
  current.id = t ? t.id : null;
  current.url = t ? t.url || '' : '';
  current.pure = !t || isPureUrl(current.url);
  current.host = '';
  current.enabled = true;
  current.domains = [];
  setBlocked(current.id !== null ? counts.get(String(current.id)) || 0 : 0);
  renderState();
  renderList();
  if (current.id !== null && !current.pure) loadInfo(current.id);
}

// Active tab's details changed. Only a URL change matters here.
function onActiveUpdate(merged, patch) {
  if (!patch || patch.url === undefined || patch.url === current.url) return;
  onActive();
}

function onCount(msg) {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.tabId;
  const n = Number(msg.blocked) || 0;
  counts.set(String(id), n);
  if (current.id !== null && String(current.id) === String(id)) {
    setBlocked(n);
    if (open) scheduleDomains();
  }
}

async function onToggle() {
  const id = current.id;
  const host = current.host;
  if (id === null || !host) return;
  const on = toggle.checked;
  try {
    await pure.blocking.setSiteEnabled(host, on);
  } catch {
    toggle.checked = current.enabled;
    return;
  }
  current.enabled = on;
  renderState();
  pure.tabs.reload(id, false);
}

export function initShield() {
  if (!btn || !box || !count || !toggle || !list) return;

  btn.addEventListener('click', () => {
    if (open) closePopover();
    else openPopover();
  });

  box.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[data-action="open-blocking-stats"]') : null;
    if (!link) return;
    e.preventDefault();
    closePopover();
    pure.tabs.create({ url: 'pure://settings/#privacy', active: true }).catch(() => {});
  });

  // Element picker (2.3): "Block an element" / "Zap element" close the popover, then start the picker on the
  // active tab's page (main answers only for http(s) tabs in this window).
  box.addEventListener('click', (e) => {
    const pick = e.target instanceof Element
      ? e.target.closest('[data-action="pick-element"], [data-action="zap-element"]')
      : null;
    if (!pick) return;
    e.preventDefault();
    const mode = pick.dataset.action === 'zap-element' ? 'zap' : 'pick';
    const id = current.id;
    closePopover();
    if (id === null || current.pure) return;
    pure.blocking.pickElement(id, mode);
  });

  toggle.addEventListener('change', onToggle);

  // Click outside closes. Capture phase, so a page snapshot (#views) click also closes it.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!open) return;
      const t = e.target;
      if (t instanceof Node && (box.contains(t) || btn.contains(t))) return;
      closePopover();
    },
    true,
  );

  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') closePopover();
  });

  pure.blocking.onCount(onCount);
  pure.tabs.onRemoved((id) => counts.delete(String(id)));
  pure.settings.onChanged((s) => {
    globalOn = !s || s.blockingEnabled !== false;
    renderState();
  });
  pure.settings.get().then(
    (s) => {
      globalOn = !s || s.blockingEnabled !== false;
      renderState();
    },
    () => {},
  );

  on('active', onActive);
  on('activeupdate', onActiveUpdate);
  onActive();
}

// Escape routing (keys.js) closes the shield popover too.
export function closeShield() {
  closePopover();
}

export function isShieldOpen() {
  return open;
}

registerOverlay('shield', closeShield);
