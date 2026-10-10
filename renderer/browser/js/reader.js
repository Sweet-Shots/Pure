// Reader button (#btn-reader). Main sends reader:available per tab only when the value changes, and a
// window opened later never receives earlier values, so the per-tab map is only what this window has
// seen; an unknown tab counts as not readerable (hidden). On pure://reader/ pages the button is always
// shown and .active, so the user can leave the reader view from it.

import { $, pure } from './util.js';
import { activeTab, on } from './state.js';

const btn = $('btn-reader');
const available = new Map(); // String(tabId) -> { url, available } — trusted only while the tab is still on url

function isReaderUrl(url) {
  return typeof url === 'string' && url.startsWith('pure://reader/');
}

function refresh() {
  if (!btn) return;
  const t = activeTab();
  const inReader = !!t && isReaderUrl(t.url);
  const entry = t ? available.get(String(t.id)) : null;
  const readerable = !!entry && entry.available && entry.url === t.url;
  btn.hidden = !(inReader || readerable);
  btn.classList.toggle('active', inReader);
  btn.setAttribute('aria-pressed', inReader ? 'true' : 'false');
}

export function initReader() {
  if (!btn) return;
  pure.reader.onAvailable((msg) => {
    if (!msg || typeof msg !== 'object') return;
    available.set(String(msg.tabId), { url: typeof msg.url === 'string' ? msg.url : '', available: msg.available === true });
    const t = activeTab();
    if (t && String(t.id) === String(msg.tabId)) refresh();
  });
  // A navigation makes the stored answer stale by URL (checked in refresh); main answers again after each load.
  pure.tabs.onUpdated((p) => {
    if (!p || typeof p !== 'object' || !('url' in p)) return;
    const t = activeTab();
    if (t && String(t.id) === String(p.id)) refresh();
  });
  pure.tabs.onRemoved((id) => available.delete(String(id)));
  btn.addEventListener('click', () => {
    const t = activeTab();
    if (t) pure.reader.toggle(t.id);
  });
  on('active', refresh);
  on('activeupdate', (_t, p) => {
    if (p && ('url' in p || 'isLoading' in p)) refresh();
  });
  refresh();
}
