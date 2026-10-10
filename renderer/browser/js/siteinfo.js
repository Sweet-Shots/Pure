// Site info popover: #lock-icon opens #site-popover (page frozen while open) for the active tab.
// Data is main's SiteInfo (pure.site.info). It is null for non-http(s) tabs, so nothing opens there.
// Incognito tabs show the permissions but the selects are disabled (changes would not persist).
// Permission decisions: the UI says allow / ask / block; main's decision for block is 'deny'.

import { $, el, pure, setText } from './util.js';
import { activeTab, on } from './state.js';
import { acquireFreeze, registerOverlay, claimOverlay } from './freeze.js';

const lock = $('lock-icon');
const box = $('site-popover');
const hostEl = $('site-host');
const statusEl = $('site-status');
const permsEl = $('site-perms');
const cookiesEl = $('site-cookies');
const blockedEl = $('site-blocked');
const zoomEl = $('site-zoom');
const clearBtn = box ? box.querySelector('[data-action="site-clear-data"]') : null;
const allBtn = box ? box.querySelector('[data-action="site-all-settings"]') : null;

const DECISION_TO_UI = { allow: 'allow', ask: 'ask', deny: 'block' };
const UI_TO_DECISION = { allow: 'allow', ask: 'ask', block: 'deny' };
const UI_OPTIONS = [
  ['allow', 'Allow'],
  ['ask', 'Ask'],
  ['block', 'Block'],
];

let open = false;
let release = null;
let infoSeq = 0; // bumped on every open/close, so a late answer for an old request is dropped
let currentId = null; // tab id the popover describes

function isPureUrl(url) {
  return typeof url === 'string' && url.startsWith('pure:');
}

function statusFor(info) {
  if (info.certError) return { text: 'Certificate error', state: 'error' };
  if (info.secure) return { text: 'Connection is secure', state: 'secure' };
  return { text: 'Connection is not secure', state: 'insecure' };
}

function permissionRow(p, incognito) {
  const row = el('div', 'site-perm-row');
  row.append(el('span', 'site-perm-name', String(p.label || p.permission)));
  const sel = el('select', 'site-perm-select');
  sel.dataset.permission = String(p.permission);
  for (const [value, text] of UI_OPTIONS) {
    const o = el('option', null, text);
    o.value = value;
    sel.append(o);
  }
  const shown = DECISION_TO_UI[p.decision] || 'ask';
  sel.value = shown;
  sel.dataset.decision = shown; // last known value, restored if a change is refused
  sel.disabled = incognito;
  row.append(sel);
  return row;
}

function render(info) {
  setText(hostEl, info.host || info.origin || '');
  const st = statusFor(info);
  setText(statusEl, info.incognito ? `${st.text} · Incognito` : st.text);
  if (statusEl) {
    statusEl.classList.remove('secure', 'insecure', 'error');
    statusEl.classList.add(st.state);
  }

  const perms = Array.isArray(info.permissions) ? info.permissions : [];
  if (permsEl) {
    if (perms.length) {
      permsEl.replaceChildren(...perms.map((p) => permissionRow(p, !!info.incognito)));
    } else {
      permsEl.replaceChildren(el('div', 'site-perm-empty', 'No permissions requested on this site'));
    }
  }
  setText(cookiesEl, String(Number(info.cookies) || 0));
  setText(blockedEl, String(Number(info.blocked) || 0));
  const zoom = typeof info.zoom === 'number' ? info.zoom : 1;
  setText(zoomEl, `${Math.round(zoom * 100)}%`);
}

function refreshLock() {
  if (!lock) return;
  const t = activeTab();
  // #lock-icon:disabled is styled by CSS; a disabled button ignores clicks, so pure pages are no-ops.
  lock.disabled = !t || isPureUrl(t.url);
}

async function openPopover() {
  claimOverlay('site');
  const t = activeTab();
  if (!t || isPureUrl(t.url) || open) return;
  const seq = ++infoSeq;
  let info = null;
  try {
    info = await pure.site.info(t.id);
  } catch {
    info = null;
  }
  // Stale (closed, or another request started) or nothing to show for this page.
  if (seq !== infoSeq || !info || typeof info !== 'object') return;
  currentId = t.id;
  render(info);
  open = true;
  box.classList.add('open');
  lock.setAttribute('aria-expanded', 'true');
  if (!release) release = acquireFreeze();
}

function closePopover() {
  infoSeq++;
  if (!open) return;
  open = false;
  currentId = null;
  box.classList.remove('open');
  lock.setAttribute('aria-expanded', 'false');
  if (release) {
    release();
    release = null;
  }
}

export function closeSiteInfo() {
  closePopover();
}

export function isSiteInfoOpen() {
  return open;
}

async function onPermissionChange(e) {
  const sel = e.target;
  if (!(sel instanceof HTMLSelectElement) || !sel.dataset.permission || currentId === null) return;
  const decision = UI_TO_DECISION[sel.value] || 'ask';
  let stored = null;
  try {
    stored = await pure.site.setPermission(currentId, sel.dataset.permission, decision);
  } catch {
    stored = null;
  }
  if (stored === null || stored === undefined) {
    // Refused: put the last known value back.
    sel.value = sel.dataset.decision || 'ask';
    return;
  }
  const shown = DECISION_TO_UI[stored] || sel.value;
  sel.value = shown;
  sel.dataset.decision = shown;
}

async function onClearData() {
  if (currentId === null) return;
  const id = currentId;
  const host = hostEl ? hostEl.textContent || 'this site' : 'this site';
  if (!window.confirm(`Clear cookies and site data for ${host}? You will be signed out of this site.`)) return;
  try {
    await pure.site.clearData(id);
  } catch {
    // Still reload: the page may have been cleared partly.
  }
  closePopover();
  pure.tabs.reload(id, false);
}

export function initSiteInfo() {
  if (!lock || !box) return;

  lock.addEventListener('click', () => {
    if (open) closePopover();
    else openPopover();
  });

  permsEl.addEventListener('change', onPermissionChange);
  if (clearBtn) clearBtn.addEventListener('click', onClearData);
  if (allBtn) {
    allBtn.addEventListener('click', () => {
      closePopover();
      pure.tabs.create({ url: 'pure://settings/#sites' }).catch(() => {});
    });
  }

  // Click outside closes (capture, so a click on the frozen page closes it too).
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!open) return;
      const t = e.target;
      if (t instanceof Node && (box.contains(t) || lock.contains(t))) return;
      closePopover();
    },
    true,
  );

  on('active', () => {
    closePopover();
    refreshLock();
  });
  on('activeupdate', (_t, p) => {
    if (p && 'url' in p) {
      closePopover();
      refreshLock();
    }
  });
  refreshLock();
}

registerOverlay('site', closeSiteInfo);
