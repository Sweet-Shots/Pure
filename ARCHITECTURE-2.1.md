# Pure 2.1 Overhaul — addendum to ARCHITECTURE.md

Binding. Read `ARCHITECTURE.md` first; where the two conflict, this file wins.

Features: ad/tracker blocking + lifetime stats + address-bar shield · memory panel, smarter sleeping, Lite mode ·
home widget board (news / weather+forecast / continue reading / notes) · light theme + follow Windows ·
picture-in-picture · import from Chrome/Edge/Brave and Pure 1.1.1.

**Already done by the manager (frozen — report needs, don't edit):**
- Settings schema in `main/storage.js`: `theme` ∈ `dark|light|system`, `homeWidgets` (`[{id, visible}]`, ids
  `news weather reading notes`), `newsTopics` (`top tech world science business sports entertainment health`),
  `newsSources` (ids of **disabled** sources; `[]` = all on), `newsImages`, `showHomeStats`, `blockingEnabled`,
  `liteMode`, `smartSleep`.
- New channels in `preload/chrome.js` (`pure.blocking`) and `preload/internal.js`
  (`pureInternal.blocking / performance / home / importer`) — shapes are documented there.
- Settings auto-save map in `renderer/pages/settings/settings.js` already covers `theme-select`, `blocking-toggle`,
  `lite-mode-toggle`, `smart-sleep-toggle`, `news-images-toggle`, `home-stats-toggle`, `tab-discard-select`,
  and the Reset keys for a new `performance` section.
- `scripts/check.js` verifies every ID listed below exists.

Rule change: `webRequest` hooks are allowed **only** inside `main/blocking.js` (via the Ghostery library).

## Ownership

| Owner | Files |
|---|---|
| **B1 Blocking** | `main/blocking.js` (new), `main/sessions.js` (only: call `blocking.attach(ses, {incognito})` where sessions are configured), `renderer/browser/js/shield.js` (new; add its one-line import/init to `renderer/browser/js/app.js`), `renderer/pages/settings/blocking.js` (new) |
| **B2 Performance** | `main/performance.js` (new), `main/tabs.js`, `main/windows.js`, `renderer/pages/settings/performance.js` (new) |
| **B3 Home** | `main/homepage.js` (new), `renderer/pages/home/home.js` (may split into more `renderer/pages/home/*.js`), `renderer/pages/settings/home-widgets.js` (new) |
| **B4 Platform** | `main/importer.js` (new), `main/menus.js`, `main/shortcuts.js`, `main/system.js`, `main/index.js` (only: register new modules), `main/storage.js` (only: the two bulk-import functions below), `renderer/pages/settings/import.js` (new) |
| **Visuals (Opus)** | every `.html` and `.css` under `renderer/`, plus `renderer/browser/js/theme.js` |

- `main/index.js` (B4): call `registerIpc(ipcMain)` for `blocking`, `performance`, `homepage`, `importer`, and
  `await blocking.init()` right after `storage.init`.
- Settings page loads extra classic scripts after `settings.js`: `blocking.js performance.js home-widgets.js import.js`
  (Visuals adds the `<script src>` tags). Each is an IIFE, guards every lookup, binds its own delegated
  `data-action` click handling for its own actions only, and runs live updates only while its section is
  `.tab-content.active` and `!document.hidden`.

## Main-process interfaces

```js
// blocking.js (B1) — @ghostery/adblocker-electron (already installed). Prebuilt ads+tracking lists; serialized
// engine cached at userData/blocker/engine.bin; background refresh at most once per 24 h.
init() → Promise<void>              // load cached engine (or fetch); must not delay first window by > 300 ms —
                                    // windows can open before the engine is ready (attach late is fine)
attach(session, { incognito })      // called by sessions.js for every configured session
getStats() → Stats                  // shape in preload/internal.js
blockedOnTab(webContentsId) → number
setLiteMode(bool)                   // lite adds annoyance + cookie-banner lists (load lazily)
registerIpc(ipcMain)
// Live-respects settings.blockingEnabled and per-host exceptions. Stats + exceptions persist in
// userData/profile/blocking.json (debounced, atomic). Incognito: blocks, never persists anything.
// Cosmetic filtering: use it only if the library's preload works with sandbox:true + contextIsolation; otherwise
// network-only blocking. Count resets per tab on main-frame navigation.

// performance.js (B2)
snapshot() → Snapshot               // app.getAppMetrics() joined to tabs via webContents.getOSProcessId()
summary() → { memoryMB, sleeping }  // cheap, for the home footer
registerIpc(ipcMain)
// tabs.js (B2) also exports: findTabByWebContentsId(id) → {manager, tab}|null, allTabs() → [{manager, tab}],
//   discardTab(manager, tabId) → bool, and emits blocked counts? NO — B1 sends `blocking:count` itself, resolving
//   the tab with findTabByWebContentsId and sending to manager.win.webContents.

// homepage.js (B3)
registerIpc(ipcMain)                // home:* — news via net.fetch on the persist:pure session; tiny hand-written
                                    // RSS/Atom parser (no deps); cache 30 min in memory + userData/profile/news-cache.json;
                                    // image URLs http(s) only; forecast = open-meteo daily (3 days, cache 30 min);
                                    // notes in userData/profile/notes.txt (debounced write); continue-reading = 4 most
                                    // recent distinct history entries not currently open; footer = performance.summary()
                                    // + blocking.getStats().today. All internal-sender only, incognito → empty/null.

// storage.js — B4 adds ONLY:
bookmarks.importMany([{url, title, createdAt?}]) → added   // dedupe, cap, ONE bookmarks:changed broadcast
history.importMany([{url, title, visitedAt, visitCount?}]) → added  // dedupe by url (keep newest), cap
```

## Feature specs

**Shield** (B1 logic, Visuals markup). `#btn-shield` inside `#address-wrap`, before `#btn-bookmark`; `#shield-count`
badge = active tab's blocked count (hidden when 0 or on pure:// pages); `#btn-shield.off` when blocking is off for the
site or globally. Click toggles `#shield-popover.open` — an HTML popover under the address bar that uses the freeze
helper in `renderer/browser/js/freeze.js` exactly like the suggestions dropdown. Contents: `#shield-host`,
`#shield-blocked` (big number), `input#shield-toggle` (checked = blocking on for this site; on change →
`pure.blocking.setSiteEnabled(host, on)` then `pure.tabs.reload(id)`), `#shield-list` (JS fills `.shield-row` ›
`.shield-domain` + `.shield-n`), `a[data-action="open-blocking-stats"]` → open/activate `pure://settings/#privacy`.
Esc or click outside closes.

**Lifetime stats** (B1, privacy section). `#blocking-toggle`; `#stat-today #stat-week #stat-total #stat-data-saved`
(estimate from per-type average sizes; show "est."); `#stat-chart` (JS fills 30 `div.stat-bar` with inline
`style="--h:0..1"` and a `title` "Oct 9 · 312 blocked"); `#top-blocked-list` (`.top-row` › `.top-domain .top-n`);
`#shield-exceptions-list` (`.exception-row` › `.exception-host` + `button[data-action="remove-exception"][data-host]`;
empty → `.empty-state`); `[data-action="reset-stats"]` (confirm first).

**Performance section `#performance`** (B2). `#lite-mode-toggle`, `#smart-sleep-toggle`, `#tab-discard-select`
(moved here from privacy), `#perf-total` ("412 MB · 3% CPU · 2 sleeping"), `#perf-list` (`.perf-row[data-tab-id]` ›
`img.perf-favicon .perf-title .perf-mem .perf-cpu` + `button[data-action="sleep-tab"]`; `.sleeping` when
discarded), `[data-action="sleep-all"]`. Refresh every 2 s only while visible.
- Smart sleep (when `smartSleep`): on battery halve the discard delay (`powerMonitor`); when
  `os.freemem()/os.totalmem() < 0.15` discard least-recently-used inactive tabs until > 0.20 (max 3 per check);
  inactive tabs of minimized windows use half the delay. Reuse the existing single 60 s timer.
- Lite mode (when `liteMode`): discard delay 3 min, `blocking.setLiteMode(true)`, and emulate
  `prefers-reduced-motion: reduce` on http(s) tab webContents via `webContents.debugger`
  (`Emulation.setEmulatedMedia`) — attach lazily, detach when Lite turns off, skip if DevTools is open.

**Theme** (B4 + Visuals). B4: `nativeTheme.themeSource = settings.theme`, live (system.js). That drives
`prefers-color-scheme` for the browser UI, internal pages and websites. Visuals: light tokens under
`@media (prefers-color-scheme: light)` in every CSS file — no JS theme switching (theme.js may drop `data-theme`).
B2: windows.js sets `backgroundColor` from `nativeTheme.shouldUseDarkColors` and updates on `nativeTheme` 'updated'.
`#theme-select` options: `dark` (default), `light`, `system` ("Follow Windows").

**Picture-in-picture** (B4). Page context menu on a video (`params.mediaType === 'video'`) → "Picture in picture"
→ `webContents.executeJavaScript(…, true)` finding the video at (x, y) via `document.elementsFromPoint` and toggling
`requestPictureInPicture()` / `document.exitPictureInPicture()`. Shortcut **Alt+P** toggles PiP for the active tab's
largest playing video. Visuals adds Alt+P to the settings shortcut list.

**Import** (B4, section `#import`). `#import-sources` (JS fills `.import-row[data-source]` › `.import-name
.import-detail` + `button[data-action="run-import"]`, disabled when unavailable); `#import-bookmarks-cb
#import-history-cb #import-settings-cb`; `#import-status`.
- Chrome / Edge / Brave (`%LOCALAPPDATA%\…\User Data\Default`): bookmarks from `Bookmarks` JSON; history from the
  `History` SQLite DB — copy to a temp file first (it's locked while the browser runs), read with Node's built-in
  `node:sqlite` (verify it exists in Electron 44's Node; if not, bookmarks only and say so in the UI). Last 90 days,
  ≤ 10 000 rows. Chrome time = microseconds since 1601-01-01.
- Pure 1.1.1: its localStorage lives in the DEFAULT session under origin `http://localhost:3000`. Read it with a
  hidden sandboxed `BrowserWindow({show:false, webPreferences:{session: session.defaultSession, sandbox:true,
  contextIsolation:true}})`, temporarily `session.defaultSession.protocol.handle('http', …)` answering a blank HTML
  page for `http://localhost:3000/` (anything else → 404), `executeJavaScript('JSON.stringify(localStorage)')`, then
  `protocol.unhandle('http')` and destroy the window. Keys: `bookmarks`, `browsingHistory`, `quickLinks`,
  `accentColor`, `searchEngine`, `homepage*`, `showWelcomeAnimation` (settings only if the checkbox is on).

## Home 2.1 DOM (Visuals writes, B3 binds)

`#greeting` ("Good morning/afternoon/evening"), `.logo`, `#slogan`, `#search-input`, `#quick-links` +
`[data-action="add-quick-link"]` + `#quick-link-modal` (as 2.0), `[data-action="customize"]` toggles
`body.customizing`. `#widget-board` holds four static `section.widget[data-widget="news|weather|reading|notes"]`;
JS reorders them and sets `hidden`. Each has `.widget-head` › `.widget-title`, `.widget-grip` (drag handle, shown only
while customizing), `button[data-action="hide-widget"]` (shown only while customizing). `#widget-tray` (shown while
customizing) — JS fills `button[data-action="show-widget"][data-widget]` for hidden widgets. Reorder by pointer-drag
on `.widget-grip`; persist to `settings.homeWidgets`. Layout (Visuals): news is the large block (left, spans rows);
weather, reading, notes stack on the right; collapses to one column under ~760 px.
- news: `#news-topics` (JS fills `button.news-topic[data-topic]` + `.on`), `#news-list` (JS fills one `a.news-lead` ›
  `img.news-image` (only when `newsImages`), `.news-title`, `.news-meta`; then 3–5 `a.news-item` › `.news-title`,
  `.news-meta`), `#news-status` (loading / offline text). `body.no-news-images` when `newsImages` is off.
- weather: existing `#clock #weather #weather-condition #weather-icon` + `#forecast` (JS fills 3 `.forecast-day` ›
  `.forecast-name`, `svg.icon`, `.forecast-temp`).
- reading: `#reading-list` (JS fills `a.reading-item` › `img.reading-favicon`, `.reading-title`; empty → `.empty`).
- notes: `textarea#notes-input` (autosave debounced 800 ms), `#notes-status` ("Saved").
- `#home-stats` footer (JS text; `hidden` when `showHomeStats` is off).
- All widgets hidden → the page must look like the classic 1.1.1 home (logo, slogan, search, quick links).
- Incognito: logo, search, "Purely Hidden." only — no widgets, no fetches.
- Keep the background dot grid exactly as it is now.

Settings › homepage section additions: `#widget-news-toggle #widget-weather-toggle #widget-reading-toggle
#widget-notes-toggle` (B3 binds to `homeWidgets`), `#news-images-toggle`, `#home-stats-toggle`, `#news-sources`
(B3 fills `label.news-source` › `input[type=checkbox][data-source]` + `span`; unchecked → id stored in `newsSources`).
Settings nav gains `performance` and `import` sections (`[data-action="section"][data-arg="performance|import"]`).
