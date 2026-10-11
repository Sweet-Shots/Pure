// Preload attached to every tab. Exposes `window.pureInternal` ONLY on pure:// pages
// (home, settings, error). Regular websites get nothing. Main re-validates every call
// with isInternalSender(), so this check is defence-in-depth, not the security boundary.

const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'pure:') {
  const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
  const send = (ch, ...a) => ipcRenderer.send(ch, ...a);
  const on = (ch, cb) => {
    const fn = (_e, ...a) => cb(...a);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  };

  contextBridge.exposeInMainWorld('pureInternal', {
    getInfo: () => invoke('internal:info'), // -> { version, isIncognito, electron, chrome }

    // main/storage.js
    settings: {
      get: () => invoke('settings:get'),
      set: (patch) => invoke('settings:set', patch),
      reset: (keys) => invoke('settings:reset', keys), // keys?: string[] (omit = all)
      onChanged: (cb) => on('settings:changed', cb),
    },
    history: {
      // -> { items: [{id,url,title,visitedAt}], total }
      list: (opts) => invoke('history:list', opts || {}), // {query?, offset=0, limit=100}
      remove: (id) => invoke('history:remove', id),
      clear: () => invoke('history:clear'),
    },
    bookmarks: {
      list: () => invoke('bookmarks:list'),
      remove: (url) => invoke('bookmarks:remove', url),
    },

    // main/downloads.js
    downloads: {
      list: () => invoke('downloads:list'),
      open: (id) => send('downloads:open', id),
      showInFolder: (id) => send('downloads:show', id),
      clear: () => invoke('downloads:clear'),
      onUpdated: (cb) => on('downloads:updated', cb),
    },

    // ── 2.1 ──────────────────────────────────────────────────────────────────
    // main/blocking.js
    // Stats = { today, week, total, bytesSaved, since (ms), days: [{date:'YYYY-MM-DD', count}] (last 30),
    //   byType: {script, image, xhr, frame, media, other}, topDomains: [{domain, count}] (≤ 10) }
    blocking: {
      stats: () => invoke('blocking:stats'),
      resetStats: () => invoke('blocking:reset-stats'),
      exceptions: () => invoke('blocking:exceptions'),          // -> [host]
      removeException: (host) => invoke('blocking:remove-exception', host),
      // 2.3 — filter lists (main/filterlists.js). List = { id, name, group:'default'|'dns'|'annoyances'|
      //   'regional'|'custom', url, enabled, recommended, rules (count|null), updatedAt (ms|null), error? }
      lists: () => invoke('lists:get'),                          // -> { lists: List[], building, builtAt }
      setListEnabled: (id, enabled) => invoke('lists:set-enabled', id, !!enabled),
      addList: (url) => invoke('lists:add', url),                // custom list URL -> List | {error}
      removeList: (id) => invoke('lists:remove', id),            // custom lists only
      updateLists: () => invoke('lists:update-now'),             // re-download all + rebuild -> {ok, errors[]}
      onListsChanged: (cb) => on('lists:changed', cb),           // cb({lists, building, builtAt})
      // 2.3 — My filters (main/picker.js). Raw uBO/AdBlock-syntax text, one rule per line.
      getMyFilters: () => invoke('myfilters:get'),               // -> string
      setMyFilters: (text) => invoke('myfilters:set', text),     // -> { ok, rules, errors: [{line, message}] }
      onStats: (cb) => on('blocking:stats-changed', cb),        // cb(Stats) — throttled ≤ 1/s
    },
    // main/performance.js
    // Snapshot = { totalMB, cpuPercent, tabs: [{tabId, windowId, title, url, favicon, memoryMB, cpuPercent,
    //   discarded, active, audible}], sleeping }
    performance: {
      snapshot: () => invoke('performance:snapshot'),
      sleepTab: (tabId) => invoke('performance:sleep-tab', tabId),
      sleepAll: () => invoke('performance:sleep-all'),          // all inactive tabs in all windows
    },
    // main/homepage.js
    home: {
      // -> { items: [{title, link, source, publishedAt (ms), image|null}], fetchedAt, topics } (cached ≤ 30 min)
      news: (opts) => invoke('home:news', opts || {}),          // {force?: bool}
      sources: () => invoke('home:news-sources'),               // -> [{id, name, topics:[...] }]
      forecast: () => invoke('home:forecast'),                  // -> {days:[{date, min, max, code}]} | null
      continueReading: () => invoke('home:continue-reading'),   // -> [{url, title}] (≤ 4)
      notes: {
        get: () => invoke('home:notes-get'),                    // -> string
        set: (text) => invoke('home:notes-set', text),          // ≤ 20 000 chars
      },
      footer: () => invoke('home:footer'),                      // -> { memoryMB, sleeping, blockedToday }
    },
    // main/importer.js
    importer: {
      // 2.5: Source = {id, name, browser, available, detail, profiles: [{id, name}], supports: {bookmarks,
      //   history, passwords, settings}}. browser: chrome|edge|brave|opera|opera-gx|vivaldi|chromium|firefox|pure1.
      detect: () => invoke('import:detect'),
      // what: {profile?, bookmarks, history, passwords, settings (pure1 only)} ->
      //   {bookmarks:n, history:n, passwords:n, settings:bool, warnings:[string]} | {error}
      run: (id, what) => invoke('import:run', id, what || {}),
      // 2.5: native file picker. kind: 'passwords-csv' | 'bookmarks-html' -> {passwords:n}|{bookmarks:n}|{error}|null (cancelled)
      importFile: (kind) => invoke('import:file', kind),
      // 2.5: native save dialog; writes bookmarks as a Netscape HTML file -> {ok, count, path}|{error}|null
      exportBookmarks: () => invoke('export:bookmarks'),
    },

    // ── 2.2 ──────────────────────────────────────────────────────────────────
    // main/passwords.js (C1). Login = { id, origin, username, updatedAt }
    passwords: {
      list: () => invoke('pw:list'),
      reveal: (id) => invoke('pw:reveal', id),                  // -> plaintext password (settings page only)
      update: (id, patch) => invoke('pw:update', id, patch),    // {username?, password?}
      remove: (id) => invoke('pw:remove', id),
      neverList: () => invoke('pw:never-list'),                 // -> [origin]
      removeNever: (origin) => invoke('pw:remove-never', origin),
      onChanged: (cb) => on('pw:changed', cb),
    },
    // main/extensions.js (C2). Ext = { id, name, version, description, enabled, icon, source:'store'|'unpacked', error? (load failure text) }
    extensions: {
      list: () => invoke('ext:list'),
      setEnabled: (id, enabled) => invoke('ext:set-enabled', id, !!enabled),
      remove: (id) => invoke('ext:remove', id),
      loadUnpacked: () => invoke('ext:load-unpacked'),          // native folder picker -> Ext|{error}
      openStore: () => send('ext:open-store'),                  // opens the Chrome Web Store in a tab
      onChanged: (cb) => on('ext:list-changed', cb),
    },
    // main/updater.js (C1). Status = { state:'disabled'|'idle'|'checking'|'available'|'downloading'|'ready'|
    //   'up-to-date'|'error', version?, progress? (0–1), error?, lastChecked? }
    updater: {
      status: () => invoke('update:status'),
      check: () => invoke('update:check'),
      installNow: () => send('update:install'),
      onStatus: (cb) => on('update:status', cb),
    },
    // main/reader.js (C5) — only answers pure://reader pages.
    // Article = { title, byline, siteName, url, contentHtml (UNSANITIZED — the page must sanitize), minutes, lang, dir }
    reader: {
      get: (id) => invoke('reader:get', id),
      exit: () => send('reader:exit'),                          // back to the original page
    },

    // ── 2.4 ──────────────────────────────────────────────────────────────────
    // main/privacy.js (E3).
    // Site = { host, permissions: [{origin, permission, decision}], purifyOff (bool), purifyLevel:'strict'|'balanced' }
    privacy: {
      allowHttp: (url) => invoke('privacy:allow-http', url),    // error page only: allow http for this host (this run) + load url
    },
    sites: {
      list: () => invoke('sites:list'),                          // -> Site[] (only hosts with a non-default setting)
      reset: (host) => invoke('sites:reset', host),              // permissions + Purify exception + level back to default
    },

    // main/system.js
    clearBrowsingData: (what) => invoke('system:clear-data', what), // {cache,cookies,history,downloads}
    getSitePermissions: () => invoke('system:site-permissions'),     // -> [{origin, permission, decision}]
    resetSitePermission: (origin, permission) => invoke('system:site-permission-reset', origin, permission),
    openDefaultBrowserSettings: () => send('system:default-browser'),
    isDefaultBrowser: () => invoke('system:is-default-browser'),
  });
}
