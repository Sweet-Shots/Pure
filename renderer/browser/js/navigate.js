// Navigation entry points shared by the address bar, suggestions and bookmarks.
// URLs are resolved here, before they reach main (tabs.navigate takes resolved URLs only).

import { activeTab, searchPrefix } from './state.js';
import { $, pure } from './util.js';
import { resolveInput } from './url.js';

export function navigateActive(url) {
  const t = activeTab();
  if (t) pure.tabs.navigate(t.id, url);
  else pure.tabs.create({ url });
}

// Address-bar text: URL or search. Leaves the address bar so keyboard focus goes to the page.
export function navigateInput(text) {
  const url = resolveInput(text, searchPrefix());
  if (!url) return false;
  navigateActive(url);
  $('address-bar').blur();
  return true;
}

// Suggestion item: { type, url?, text? }.
export function navigateItem(item) {
  let url = '';
  if (item.url) url = item.url;
  else if (item.type === 'search' || !item.type) url = searchPrefix() + encodeURIComponent(item.text || '');
  else url = resolveInput(item.text, searchPrefix());
  if (!url) return;
  navigateActive(url);
  $('address-bar').blur();
}
