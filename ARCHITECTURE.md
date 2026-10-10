# Pure Browser 2.0 — Architecture & Team Contract

Pure is a minimal Chromium browser built on **Electron 44** (`node_modules/electron/electron.d.ts` is the
authoritative API reference — check it, don't guess). This is a rewrite of Pure 1.1.1 (original source in
`../source/` and `_reference/`). The look and feature set stay **1:1** with 1.1.1; the internals are rebuilt
so it is fast, light, secure, and passes Google sign-in.

## Non-negotiable goals (every agent)

1. **Low CPU / RAM.** This beats every other nice-to-have.
   - No polling loops / `setInterval` unless unavoidable (and then ≥ 30 s). Prefer events.
   - No per-request `webRequest` hooks. No Express / local HTTP server. No extra renderer processes
     (no hidden windows, no overlay views) — the browser UI is ONE renderer.
   - Lazy everything: tabs create their `WebContentsView` only when first activated; inactive tabs are
     discarded (webContents destroyed, navigation history kept) after `settings.tabDiscardMinutes`.
   - Batch/debounce disk writes (≥ 1 s). Never `fs.*Sync` on a hot path (startup reads are fine).
   - UI: animate only `transform`/`opacity`; no infinite animations; no `backdrop-filter`;
     no large box-shadow animations; event delegation instead of per-element listeners.
2. **Real-browser compatibility (Google sign-in must work).**
   - User agent = plain Chrome UA built from `process.versions.chrome` — no `Electron/` or app tokens.
     Set via `app.userAgentFallback` and `session.setUserAgent` (never in `onBeforeSendHeaders`).
   - Persistent profile session `persist:pure`; incognito uses an in-memory partition per window.
   - `window.open` popups that need `window.opener` (OAuth) must open as real popup windows created by
     Electron (`setWindowOpenHandler` → `action: 'allow'`), not as tabs.
3. **Secure by default.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
   `webSecurity: true` everywhere. Validate every IPC sender with `main/security.js`. Validate every URL
   scheme before navigating or `shell.openExternal`. Internal pages ship a strict CSP and **no inline
   scripts or inline event handlers** (`onclick="…"` is forbidden — see "data-action" below).
4. **No global shortcuts.** Shortcuts are handled per-window via `before-input-event`.

## Process & file layout

```
main/
  index.js        H1  entry: single-instance lock, switches, scheme registration, app lifecycle, argv URLs
  sessions.js     H1  getSession({incognito}) → configured Session (UA, pure:// handler, hooks from H5)
  protocol.js     H1  pure:// handler (static files from renderer/, traversal-safe, MIME, CSP headers)
  logger.js       H1  log(...args) → userData/app.log (async append, size-capped)
  security.js     (manager — read-only for all)  sender + URL validation helpers
  windows.js      H2  BrowserWindow creation/registry, layout of views, win:* and ui:* IPC
  tabs.js         H2  per-window TabManager on WebContentsView, tabs:* IPC, popups, discard, error pages
  shortcuts.js    H2  before-input-event keyboard map
  storage.js      H4  JSON stores (settings, bookmarks, history, site permissions, session); settings:*,
                      bookmarks:*, history:* IPC
  suggestions.js  H4  suggest:query IPC
  downloads.js    H5  will-download handling, downloads:* IPC
  permissions.js  H5  permission request/check handlers with native prompts, remembered per origin
  menus.js        H5  native context menus (page + tab strip)
  system.js       H5  system:* and internal:info IPC, default browser, clear data
preload/
  chrome.js       (manager) API for the browser UI  → window.pure          ← THE IPC CONTRACT
  internal.js     (manager) API for pure:// pages   → window.pureInternal  ← THE IPC CONTRACT
renderer/
  browser/index.html, browser/styles/**       VISUALS (Opus)
  browser/js/**                               H3
  pages/{home,settings,error}/index.html,*.css VISUALS (Opus)
  pages/home/home.js, pages/settings/settings.js  H4
  pages/error/error.js                        H5
  assets/**, build/icon.ico                   VISUALS (Opus)
scripts/check.js  (manager)
```

**Only edit files you own.** If you need something from a file you don't own, write it under
"Requests to other owners" in your final report — do not edit it. The preload files are frozen; if a
channel is genuinely missing, report it.

## Internal URLs (`pure://`)

Registered privileged (`standard`, `secure`, `supportFetchAPI`, `corsEnabled: false`) before `ready`, and
handled on **every** session that loads pages (default, `persist:pure`, incognito partitions).

| URL                          | Serves                                   |
|------------------------------|------------------------------------------|
| `pure://browser/<path>`      | `renderer/browser/<path>` (browser UI)    |
| `pure://home/`               | `renderer/pages/home/index.html` (new tab page) |
| `pure://settings/`           | `renderer/pages/settings/index.html` — section via hash: `#homepage`, `#appearance`, `#search`, `#privacy`, `#downloads`, `#shortcuts`, `#history`, `#about` |
| `pure://error/?code=&desc=&url=` | `renderer/pages/error/index.html`    |
| `pure://assets/<path>`       | `renderer/assets/<path>`                 |

`pure://<host>/x.css` etc. resolve inside that host's folder. Anything else → 404.
Web pages (http/https) may NOT navigate, redirect, frame, or `window.open` into `pure://` — only the user
(address bar / UI) can. Exception: `pure://error` is loaded by main itself.

Homepage = `pure://home/` (settings may override with an http(s) URL). The address bar shows **empty** for
`pure://home/` and the tab shows the dot icon (1:1 with 1.1.1).

Settings opens **as a tab** (`pure://settings/#section`), replacing the 1.1.1 modal window. Ctrl+H opens
`pure://settings/#history`. If a settings tab is already open in the window, activate it.

## Main-process module interfaces (so modules can call each other)

```js
// storage.js (H4)
init(userDataDir) → Promise<void>          // called first in index.js
settings.get() → Settings ; settings.set(patch) ; settings.onChange(fn(settings))
bookmarks.list() ; bookmarks.toggle({url,title,favicon}) → bool ; bookmarks.has(url) ; bookmarks.remove(url)
history.add({url,title}) ; history.updateTitle(url,title) ; history.search(text,limit) ; history.clear()
sitePermissions.get(origin, permission) → 'allow'|'deny'|undefined ; .set(origin, permission, decision) ; .list() ; .reset(origin, permission)
session.save(windowsState) ; session.load() → windowsState|null   // [{tabs:[{url,title}], activeIndex}]
flush() → Promise<void>                    // called on before-quit
registerIpc(ipcMain)

// sessions.js (H1)
getSession({ incognito, windowId }) → Electron.Session   // cached for normal; new partition per incognito window
isIncognitoSession(session) → bool                       // use this to decide incognito for tab/internal-page senders:
                                                         //   sessions.isIncognitoSession(event.sender.session)
USER_AGENT                                               // string
// For the browser-UI sender use windows.isIncognitoWindow(BrowserWindow.fromWebContents(event.sender)).
// The browser UI webContents itself uses the same session as its window's tabs.

// windows.js (H2)
createWindow({ incognito=false, urls=[] , tabs=null }) → BrowserWindow
getBrowserWindows() → BrowserWindow[] ; getLastFocusedBrowserWindow() → BrowserWindow|null
openUrl(url, { newWindow=false }) → void   // used for argv / second-instance / external opens
isIncognitoWindow(win) → bool
registerIpc(ipcMain)

// tabs.js (H2) — TabManager instance per window, reachable as windows.getTabManager(win)

// menus.js (H5) — pure UI builders, no tab knowledge
showPageContextMenu({ win, webContents, params, actions })
//   actions: { openInNewTab(url), openInNewWindow(url), openInIncognito(url), searchFor(text),
//              bookmarkPage(), inspect(x,y), saveImageAs(src) }
showTabContextMenu({ win, tab /*TabState*/, actions })
//   actions: { newTab(), reload(), duplicate(), toggleMute(), close(), closeOthers(), closeToRight(), reopenClosed() }

// downloads.js (H5)
attach(session, { incognito }) ; registerIpc(ipcMain)

// permissions.js (H5)
attach(session, { incognito })     // incognito: never persist decisions

// system.js (H5)
registerIpc(ipcMain)
```

`index.js` startup order: `requestSingleInstanceLock` → command-line switches → `protocol.registerSchemesAsPrivileged`
→ `app.whenReady` → `storage.init` → register all IPC (`storage`, `suggestions`, `windows`, `tabs`, `downloads`,
`system`) → restore session or `createWindow({ urls: argvUrls })`.
`sessions.getSession` calls `protocol` registration + `permissions.attach` + `downloads.attach` once per session.

## Renderer DOM contract — `renderer/browser/index.html`

Visuals (Opus) owns the markup and may restyle freely, but **these IDs must exist** (H3's JS uses them):

`#titlebar #tabs-scroll #tabs #tab-drop-indicator #btn-new-tab #btn-wmin #btn-wmax #btn-wclose`
`#toolbar #btn-back #btn-forward #btn-reload #icon-reload #icon-stop #btn-home`
`#address-wrap #lock-icon #address-bar #zoom-indicator #btn-bookmark #suggestions`
`#btn-bookmarks-toggle #btn-downloads #downloads-progress #btn-incognito #btn-settings`
`#bookmark-sidebar #bookmark-list` (it's a horizontal bookmarks BAR under the toolbar)
`#findbar #find-input #find-count #find-prev #find-next #find-close`
`#views #loader #page-freeze` (`#page-freeze` is an `<img>` filling #views, hidden by default)
`#statusbar #status-text`
`#welcome-overlay #welcome-version #welcome-logo #welcome-tagline #welcome-status`

Removed from 1.1.1 (replaced by native UI): `#ctx-menu #ctx-overlay #confirm-*`.

State classes the JS toggles (style them):
- `html.incognito` — incognito window (red accent). `html.maximized`.
- `body.find-open` / `#findbar.open`, `#bookmark-sidebar.active`, `#suggestions.open`
- `#address-wrap.focused`, `#lock-icon.secure`, `#lock-icon.insecure`, `#lock-icon.internal`
- `#btn-bookmark.active`, `#btn-downloads.active` (downloads running), `#zoom-indicator.visible`
- `#loader.loading` / `#loader.done`
- `#welcome-overlay.hide` (skip instantly), `#welcome-overlay.leaving` (fade out, ≤ 200 ms; JS removes it after)
- `#page-freeze.visible`

Generated markup (H3 must produce exactly these classes; Opus styles them):
- Tab: `div.tab[data-tab-id]` (+ `.active`, `.dragging`, `.discarded`, `.crashed`) containing
  `.tab-favicon-wrapper` (+ `.loading`, `.homepage-dot`) › `img.tab-favicon` or `.tab-dot`;
  `span.tab-title`; `button.tab-audio` (+ `.muted`, only when audible/muted); `span.tab-sleeping` (discarded);
  `button.tab-close`.
- Bookmark: `div.bookmark-item[data-url]` › `img.bookmark-favicon`, `span.bookmark-title`, `button.bookmark-delete`.
- Suggestion: `div.sug-item[data-index][data-type]` (+ `.selected`) › `span.sug-icon`, `span.sug-text`, `span.sug-type`.

The welcome animation must be pure CSS, total ≤ 1.2 s, no particles/JS timers. H3 shows it only when
`settings.showWelcomeAnimation` is true, keeps the page frozen while it plays, then adds `.leaving`.

## Internal pages contract (home / settings / error)

- No inline JS, no `on*=` attributes. Interactive elements use **`data-action="name"`** (optional
  `data-arg="value"`); the page JS binds one delegated `click` listener on `document` and dispatches by name.
  Existing 1.1.1 handlers map to: `switchTab(x)` → `data-action="section" data-arg="x"`,
  `resetTab(x)` → `data-action="reset" data-arg="x"`, `closeQuickLinkModal()` → `data-action="close-quick-link"`,
  `saveQuickLink()` → `data-action="save-quick-link"`. New ones must be listed in your report.
- Keep all existing element IDs from 1.1.1 (JS relies on them). Visuals may add wrappers/classes.
- CSP (sent by protocol.js): `default-src 'self'; img-src 'self' data: https:; connect-src 'self' https://api.open-meteo.com; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- Data comes from `window.pureInternal` (see preload/internal.js) — **not** localStorage. Incognito home
  page = same page with `html.incognito` class (set by home.js from `getInfo().isIncognito`); the 1.1.1
  incognito page (`_reference/home-incognito.html`) is the visual reference for that state.
- Settings sections (IDs): `homepage appearance search privacy downloads shortcuts history about`.
  `privacy` and `downloads` are new (clear browsing data, site permissions, search suggestions toggle,
  default browser; downloads list).

### Settings page IDs (Opus writes markup, H4 binds) — keep every 1.1.1 ID plus these

Settings **auto-save on change** (no Save buttons). `#save-toast` gets `.visible` briefly after a save.
Section nav: `[data-action="section"][data-arg="<id>"]` (+ `.active`); sections are `.tab-content#<id>` (+ `.active`).
- homepage: `#homepage-url` (text; empty = Pure home), `#latitude #longitude #tempUnit #timeFormat`, `[data-action="reset"][data-arg="homepage"]`
- appearance: `#accent-picker`, `#show-welcome-toggle`, `#show-statusbar-toggle`, `#show-bookmarks-bar-toggle`, `[data-action="reset"][data-arg="appearance"]`
- search: `#search-engine` (`<select>`, option values are URL prefixes, e.g. `https://duckduckgo.com/?q=`, Google, Bing, Brave, Startpage, Ecosia), `#search-suggestions-toggle`
- privacy: `#restore-session-toggle`, `#tab-discard-select` (values `0 5 10 30 60`), `#spellcheck-toggle`,
  `#clear-history-cb #clear-cookies-cb #clear-cache-cb #clear-downloads-cb`, `[data-action="clear-data"]`, `#clear-data-status`,
  `#site-permissions-list` (JS fills `.perm-row` › `.perm-origin .perm-name .perm-decision` + `button[data-action="reset-permission"][data-origin][data-permission]`; empty → `.empty-state`),
  `#default-browser-status`, `[data-action="make-default"]`
- downloads: `#ask-where-to-save-toggle`, `#downloads-list` (JS fills `.download-row[data-id]` › `.download-name .download-meta` + `button[data-action="open-download"]`, `button[data-action="show-download"]`; empty → `.empty-state`), `[data-action="clear-downloads"]`
- shortcuts: static list (match the shortcut table below)
- history: `#history-search` (text), `#history-list` (JS fills `.history-day` headers and `.history-row[data-id]` › `img.history-favicon .history-time .history-title .history-url` + `button[data-action="delete-history"]`; rows are clickable → navigate), `[data-action="history-more"]#history-more`, `[data-action="clear-history"]`
- about: `#version-display`, `#engine-display`

### Error page IDs (Opus markup, H5 `error.js`)
`#error-title #error-message #error-code #error-url`, `[data-action="retry"]`, `[data-action="home"]`. `html.offline` for network-down errors.

### Home page IDs
All 1.1.1 IDs (`#search-input #clock #weather #weather-condition #quick-links #quick-link-modal #quick-link-title #quick-link-url #slogan`), plus `[data-action="add-quick-link"]`, quick links rendered by JS as `a.quick-link[data-index]` › `img.quick-link-favicon`, `span.quick-link-title`, `button.quick-link-remove[data-action="remove-quick-link"]`. Modal open = `#quick-link-modal.open`.

## Settings schema (storage.js defaults)

```js
{
  homepage: 'pure://home/',            // or an http(s) URL
  searchEngine: 'https://duckduckgo.com/?q=',   // prefix; query appended URL-encoded
  searchSuggestions: true,
  accentColor: '#4f8ef7',
  theme: 'dark',
  showWelcomeAnimation: true,
  showBookmarksBar: false,
  showStatusBar: true,
  homepageLatitude: '40.7128', homepageLongitude: '-74.0060',
  homepageTempUnit: 'celsius', homepageTimeFormat: '24h',
  quickLinks: [],                      // [{title,url}]
  restoreSession: false,
  tabDiscardMinutes: 10,               // 0 = never
  spellcheck: true,
  askWhereToSave: false,
  downloadDir: '',                     // '' = OS Downloads folder
}
```

## Keyboard shortcuts (shortcuts.js, per window, work while focus is in the page too)

Ctrl+T new tab · Ctrl+W / Ctrl+F4 close tab · Ctrl+Shift+T reopen closed · Ctrl+N new window ·
Ctrl+Shift+N incognito window · Ctrl+Tab / Ctrl+Shift+Tab cycle · Ctrl+1–8 / Alt+1–8 tab N · Ctrl+9 last tab ·
Ctrl+L / Alt+D / F6 focus address bar · Ctrl+F find · Esc close find / stop loading · Ctrl+D bookmark ·
Ctrl+Shift+B bookmarks bar · Ctrl+R / F5 reload · Ctrl+Shift+R / Ctrl+F5 hard reload ·
Alt+Left / Alt+Right back/forward (NOT Ctrl+arrows — those are text editing keys) ·
Ctrl+= / Ctrl+- / Ctrl+0 zoom · Ctrl+H history · F12 / Ctrl+Shift+I devtools · Ctrl+P print · F11 fullscreen.

## Definition of done (every agent)

- `node --check` passes on every JS file you touched; `npm run check` passes.
- No `TODO`s left for core behaviour; no leftover `console.log` spam (use `logger.log` in main, nothing in hot paths).
- Final report: what you built, any deviations from this contract, and "Requests to other owners".
