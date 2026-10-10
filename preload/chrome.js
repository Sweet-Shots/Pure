// Preload for the browser UI (pure://browser/index.html).
// This file IS the contract between the browser UI and the main process.
// Every channel here has exactly one owner in main/ — see ARCHITECTURE.md.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const send = (ch, ...a) => ipcRenderer.send(ch, ...a);
const on = (ch, cb) => {
  const fn = (_e, ...a) => cb(...a);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('pure', {
  // ── Window (main/windows.js) ──────────────────────────────────────────────
  // getInfo() -> { version, windowId, isIncognito, isMaximized, platform }
  getInfo: () => invoke('win:info'),
  minimize: () => send('win:minimize'),
  toggleMaximize: () => send('win:toggle-maximize'),
  close: () => send('win:close'),
  onMaximizedChange: (cb) => on('win:maximized', cb), // cb(boolean)
  openIncognito: () => send('win:open-incognito'),
  newWindow: () => send('win:new'),

  // ── Layout (main/windows.js) ──────────────────────────────────────────────
  // Tell main where the page area (#views) is, in CSS px relative to the window.
  setContentBounds: (rect) => send('ui:content-bounds', rect), // {x,y,width,height}
  // Hide the live page so HTML overlays (suggestions, welcome) can draw over it.
  // freezePage(true) -> Promise<string|null> PNG data URL snapshot of the page to show as a stand-in.
  // freezePage(false) restores the live page.
  freezePage: (frozen) => invoke('ui:freeze', !!frozen),

  // ── Tabs (main/tabs.js) ───────────────────────────────────────────────────
  // TabState = { id, index, url, title, favicon, isLoading, canGoBack, canGoForward,
  //   security: 'secure'|'insecure'|'internal'|'error', zoom (factor, 1 = 100%),
  //   isDiscarded, isAudible, isMuted, crashed, active }
  tabs: {
    list: () => invoke('tabs:list'),                       // -> TabState[] (ordered)
    create: (opts) => invoke('tabs:create', opts || {}),    // {url?, active=true, index?} -> id
    close: (id) => send('tabs:close', id),
    activate: (id) => send('tabs:activate', id),
    move: (id, toIndex) => send('tabs:move', id, toIndex),
    reopenClosed: () => send('tabs:reopen-closed'),
    navigate: (id, url) => send('tabs:navigate', id, url),  // url must already be resolved (no search terms)
    back: (id) => send('tabs:back', id),
    forward: (id) => send('tabs:forward', id),
    reload: (id, ignoreCache) => send('tabs:reload', id, !!ignoreCache),
    stop: (id) => send('tabs:stop', id),
    zoom: (id, dir) => invoke('tabs:zoom', id, dir),        // dir: 'in'|'out'|'reset' -> new factor
    find: (id, text, opts) => send('tabs:find', id, text, opts || {}), // opts {forward=true, findNext=false}
    stopFind: (id) => send('tabs:stop-find', id),
    toggleDevTools: (id) => send('tabs:devtools', id),
    toggleMute: (id) => send('tabs:mute', id),
    showContextMenu: (id) => send('tabs:context-menu', id), // native tab-strip context menu
    // Tab dragged out of the strip and released at screen coords: move it to another window
    // (or a new one). Main decides the target window.
    detach: (id, screenX, screenY) => send('tabs:detach', id, screenX, screenY),

    onCreated: (cb) => on('tabs:created', cb),    // cb(TabState)
    onUpdated: (cb) => on('tabs:updated', cb),    // cb(partial TabState, always includes id)
    onRemoved: (cb) => on('tabs:removed', cb),    // cb(id)
    onActivated: (cb) => on('tabs:activated', cb),// cb(id)
    onMoved: (cb) => on('tabs:moved', cb),        // cb(ids[] new order)
    onFound: (cb) => on('tabs:found', cb),        // cb({id, activeMatchOrdinal, matches})
    onHoverUrl: (cb) => on('tabs:hover-url', cb), // cb(url|'') for status bar
  },

  // Commands main wants the UI to perform (keyboard shortcuts are handled in main via
  // before-input-event, then forwarded here when they need UI): 'focus-address-bar',
  // 'find', 'close-find', 'toggle-bookmark', 'toggle-bookmarks-bar', 'escape'
  onCommand: (cb) => on('ui:command', cb), // cb(name, arg)

  // ── Data (main/storage.js, main/suggestions.js) ───────────────────────────
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    onChanged: (cb) => on('settings:changed', cb), // cb(fullSettings)
  },
  bookmarks: {
    list: () => invoke('bookmarks:list'),                 // -> [{url,title,favicon,createdAt}]
    toggle: (bm) => invoke('bookmarks:toggle', bm),       // {url,title,favicon} -> boolean (now bookmarked?)
    remove: (url) => invoke('bookmarks:remove', url),
    onChanged: (cb) => on('bookmarks:changed', cb),       // cb(list)
  },
  // Address-bar suggestions. -> [{type:'history'|'bookmark'|'search', url?, title?, text}]
  suggest: (text) => invoke('suggest:query', text),

  // ── Blocking shield (main/blocking.js) — 2.1 ──────────────────────────────
  // SiteInfo = { tabId, host, enabled (blocking on for this host), blocked (count on this page),
  //   domains: [{domain, count}] (top blocked domains on this page, ≤ 10) }
  blocking: {
    siteInfo: (tabId) => invoke('blocking:site-info', tabId),       // -> SiteInfo|null
    setSiteEnabled: (host, enabled) => invoke('blocking:set-site', host, !!enabled), // reloads nothing; UI reloads tab
    onCount: (cb) => on('blocking:count', cb),                      // cb({tabId, blocked}) — throttled ≤ 4/s per tab
    // 2.3 — element picker (main/picker.js). mode 'pick' = create a permanent hiding rule, 'zap' = remove
    // the clicked element from this page view only.
    pickElement: (tabId, mode) => send('picker:start', tabId, mode === 'zap' ? 'zap' : 'pick'),
  },

  // ── 2.2 ────────────────────────────────────────────────────────────────────
  // Tab groups, split view, mute others (main/tabs.js — C3). TabState gains `groupId` (string|null) and
  // `split` ('left'|'right'|null). Group = { id, title, color, collapsed }.
  // Colors: grey blue red yellow green pink purple cyan orange.
  groups: {
    list: () => invoke('groups:list'),                                   // -> Group[] (this window)
    create: (tabIds, opts) => invoke('groups:create', tabIds, opts || {}), // opts {title?, color?} -> groupId
    update: (groupId, patch) => send('groups:update', groupId, patch),   // {title?, color?, collapsed?}
    addTab: (tabId, groupId) => send('groups:add-tab', tabId, groupId),
    removeTab: (tabId) => send('groups:remove-tab', tabId),
    ungroup: (groupId) => send('groups:ungroup', groupId),
    onChanged: (cb) => on('groups:changed', cb),                         // cb(Group[])
  },
  split: {
    open: (tabId, otherTabId) => send('split:open', tabId, otherTabId),  // otherTabId omitted → new home tab
    close: () => send('split:close'),
    setRatio: (ratio) => send('split:ratio', ratio),                     // 0.2–0.8, left pane width
    focusPane: (side) => send('split:focus', side),                      // 'left'|'right'
    onChanged: (cb) => on('split:changed', cb),                          // cb({left, right, ratio, focused}|null)
  },
  muteOthers: (tabId) => send('tabs:mute-others', tabId),

  // Command palette backend (main/palette.js — C4): open tabs in all windows of the same incognito-ness,
  // history, bookmarks. Actions/settings entries are added by the UI itself.
  // -> [{kind:'tab'|'history'|'bookmark', title, sub, url, favicon?, tabId?, windowId?}]
  palette: {
    query: (text) => invoke('palette:query', text),
    activateTab: (windowId, tabId) => send('palette:activate-tab', windowId, tabId),
  },

  // Site info popover (main/siteinfo.js — C5).
  // SiteInfo = { origin, host, scheme, secure, certError?, permissions:[{permission, label, decision:'allow'|'deny'|'ask'}],
  //   cookies (count), blocked (count on this page), zoom (factor) }
  site: {
    info: (tabId) => invoke('site:info', tabId),                        // -> SiteInfo|null
    setPermission: (tabId, permission, decision) => invoke('site:set-permission', tabId, permission, decision),
    clearData: (tabId) => invoke('site:clear-data', tabId),             // cookies+storage+cache for the origin
  },

  // Reader mode (main/reader.js — C5).
  reader: {
    toggle: (tabId) => send('reader:toggle', tabId),                     // page ⇄ pure://reader/?id=…
    onAvailable: (cb) => on('reader:available', cb),                     // cb({tabId, available})
  },

  // Extensions toolbar (main/extensions.js — C2).
  // Action = { id, name, icon (data URL|null), title, badge, badgeColor, hasPopup }
  extensions: {
    actions: () => invoke('ext:actions'),
    click: (id, rect) => send('ext:click', id, rect),                    // rect = button's client rect (popup anchor)
    onChanged: (cb) => on('ext:changed', cb),                            // cb(Action[])
  },

  // Password save offers (main/passwords.js — C1). Offer = { offerId, origin, username, update }
  passwords: {
    onOffer: (cb) => on('pw:offer', cb),
    save: (offerId) => send('pw:save', offerId),
    never: (offerId) => send('pw:never', offerId),
    dismiss: (offerId) => send('pw:dismiss', offerId),
  },

  // ── Downloads (main/downloads.js) ─────────────────────────────────────────
  // DownloadItem = { id, filename, url, state:'progressing'|'completed'|'cancelled'|'interrupted',
  //   receivedBytes, totalBytes, paused, savePath, startTime }
  downloads: {
    list: () => invoke('downloads:list'),
    open: (id) => send('downloads:open', id),
    showInFolder: (id) => send('downloads:show', id),
    cancel: (id) => send('downloads:cancel', id),
    pauseResume: (id) => send('downloads:pause-resume', id),
    showMenu: () => send('downloads:menu'), // native popup listing recent downloads
    onUpdated: (cb) => on('downloads:updated', cb), // cb(DownloadItem)
  },
});
