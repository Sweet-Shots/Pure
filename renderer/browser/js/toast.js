// Toast bar (2.4): renders what main/toast.js sends into #toast-host. The host sits in the layout flow
// (layout.js reports its size), so an empty host is 0 px tall. main owns the list and the timers; this
// file only draws nodes, forwards presses and removes nodes main hides. Text is set with textContent only.

import { $, el, pure } from './util.js';
import { icon } from './icons.js';

const nodes = new Map(); // toast id -> .toast node

function build(t) {
  const kind = t.kind === 'warn' || t.kind === 'error' ? t.kind : 'info';
  const node = el('div', `toast toast-kind-${kind}`);
  node.dataset.id = String(t.id);
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.append(el('span', 'toast-text', String(t.text || '')));

  const actions = Array.isArray(t.actions) ? t.actions : [];
  if (actions.length) {
    const row = el('div', 'toast-actions');
    for (const a of actions) {
      const btn = el('button', 'toast-btn', String(a.label || ''));
      btn.type = 'button';
      btn.dataset.actionId = String(a.id);
      row.append(btn);
    }
    node.append(row);
  }

  const close = el('button', 'toast-close');
  close.type = 'button';
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.append(icon('x'));
  node.append(close);
  return node;
}

// Same id again = replace in place (main already replaced its entry).
function showToast(t) {
  if (!t || typeof t.id !== 'string') return;
  const host = $('toast-host');
  if (!host) return;
  const node = build(t);
  const old = nodes.get(t.id);
  if (old && old.parentNode === host) old.replaceWith(node);
  else host.append(node);
  nodes.set(t.id, node);
}

function hideToast(id) {
  const node = nodes.get(id);
  if (!node) return;
  nodes.delete(id);
  node.remove();
}

// One delegated listener for every button. The node goes away at once; main hides it again (no-op).
function onClick(e) {
  if (!(e.target instanceof Element)) return;
  const node = e.target.closest('.toast');
  if (!node || !node.dataset.id) return;
  const id = node.dataset.id;
  const btn = e.target.closest('.toast-btn');
  if (btn && node.contains(btn)) {
    const actionId = btn.dataset.actionId || '';
    if (!actionId) return;
    hideToast(id);
    pure.toasts.action(id, actionId);
    return;
  }
  if (e.target.closest('.toast-close')) {
    hideToast(id);
    pure.toasts.action(id, 'dismiss');
  }
}

export function initToasts() {
  const host = $('toast-host');
  if (!host || !pure || !pure.toasts) return;
  pure.toasts.onShow(showToast);
  pure.toasts.onHide(hideToast);
  host.addEventListener('click', onClick);
}
