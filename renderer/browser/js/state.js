// Shared in-memory UI state plus a tiny event bus. Nothing here is persisted: settings, bookmarks
// and downloads come from main, tab state from the tabs:* events.

export const HOME_URL = 'pure://home/';
export const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=';
export const INCOGNITO_SEARCH = 'https://duckduckgo.com/?q=';

export const DEFAULT_SETTINGS = {
  homepage: HOME_URL,
  searchEngine: DEFAULT_SEARCH,
  searchSuggestions: true,
  accentColor: '#4f8ef7',
  theme: 'dark',
  showWelcomeAnimation: true,
  showBookmarksBar: false,
  showStatusBar: true,
  verticalTabs: false,
  focusMode: false,
};

export const S = {
  incognito: false,
  version: '',
  tabs: new Map(), // String(id) -> TabState
  order: [], // String(id) in strip order
  activeKey: null, // String(id) of the active tab
  settings: { ...DEFAULT_SETTINGS },
  bookmarks: [],
  downloads: new Map(), // String(id) -> DownloadItem
  groups: new Map(), // String(groupId) -> Group {id, title, color, collapsed}
};

// Map keys are always strings. IPC always uses the original tab.id.
export const key = (id) => String(id);

export function activeTab() {
  return S.activeKey == null ? null : S.tabs.get(S.activeKey) || null;
}

export function homeUrl() {
  if (S.incognito) return HOME_URL;
  return S.settings.homepage || HOME_URL;
}

export function searchPrefix() {
  if (S.incognito) return INCOGNITO_SEARCH;
  return S.settings.searchEngine || DEFAULT_SEARCH;
}

// Tiny event bus for module-to-module notifications (no polling anywhere).
const listeners = new Map();

export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, []);
  listeners.get(name).push(fn);
}

export function emit(name, ...args) {
  const list = listeners.get(name);
  if (list) for (const fn of list) fn(...args);
}
