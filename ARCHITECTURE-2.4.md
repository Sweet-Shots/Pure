# Pure 2.4 round — ships as **2.3.0** (binding)

Read `ARCHITECTURE.md`, `-2.1.md`, `-2.2.md`, `-2.3.md` first; this file wins on conflicts. All earlier rules apply:
**low CPU/RAM first** (no polling loops, nothing runs for users who don't use a feature, lazy-require heavy code),
sandbox + contextIsolation everywhere, validate every IPC sender (`main/security.js`) and argument, no inline
scripts/handlers, **only edit files you own**. Never weaken an existing security check. Keep comments in the style of
the surrounding code. Test with a throw-away profile (`PURE_PROFILE=<scratch dir>`), never the user's real one, and
never import the user's real browser data.

## Features

| # | Feature | Owner |
|---|---|---|
| 1 | **Extensions compatibility layer** — the chrome.* APIs Electron lacks (action/badges, contextMenus, notifications, windows, tabs events, cookies, alarms, storage.sync, permissions, webNavigation basics) | E1 |
| 2 | **Pinned tabs** (icon-only, first in the strip, always reopen at startup) | E2 |
| 3 | **Crash recovery** — "Pure didn't close properly. Restore your tabs?" | E2 |
| 4 | **HTTPS upgrades / HTTPS-only mode** | E3 |
| 5 | **Clear data when Pure closes** (history / cookies / cache / download list) | E3 |
| 6 | **Site settings** page in Settings (every site with custom permissions or Purify settings, search, reset) | E3 |
| 7 | **Per-site Purify level** (Full / Balanced, from the shield) | E4 |
| 8 | **"Report a broken site"** in the shield → pre-filled GitHub issue | E4 |
| 9 | **Safer downloads** — Mark of the Web, risky-file warning, "Open when done" | E4 |
| 10 | **Screenshots** (visible area / full page, Ctrl+Shift+X) | E5 |
| 11 | **Copy clean link** (tracking parameters removed, Ctrl+Shift+C) | E5 |
| 12 | **Toasts** — one small shared notification bar used by 3, 9, 10, 11 | E5 |
| 13 | Visual design for all of the above | Visuals (Opus) |

## Ownership

| Owner | Files |
|---|---|
| **E1 Extensions** | `main/extensions.js`, `main/extension-api.js` (new), `preload/extension-api.js` (new), `renderer/browser/js/extensions.js`, `renderer/pages/settings/extensions.js` |
| **E2 Tabs** | `main/tabs.js`, `main/windows.js`, `main/menus.js`, `renderer/browser/js/tabs.js` |
| **E3 Privacy** | `main/privacy.js` (new), `main/system.js`, `renderer/pages/error/error.js`, `renderer/pages/settings/sites.js` (new) |
| **E4 Purify & downloads** | `main/blocking.js` (site level + report only — see below), `main/cosmetics.js`, `renderer/browser/js/shield.js`, `main/downloads.js`, `renderer/browser/js/downloads.js` |
| **E5 Tools** | `main/tools.js` (new), `main/toast.js` (new), `renderer/browser/js/toast.js` (new), `main/shortcuts.js`, `renderer/browser/js/palette.js`; may add ONE import + init line to `renderer/browser/js/app.js` |
| **Visuals (Opus)** | every `.html` / `.css` under `renderer/` |
| **Manager (frozen — report needs, don't edit)** | `main/storage.js`, `main/index.js`, `preload/chrome.js`, `preload/internal.js`, `renderer/pages/settings/settings.js`, `renderer/browser/js/layout.js`, `scripts/check.js`, `package.json`, docs |

**Manager hooks already in place — keep them exactly (they're marked `2.4 (manager hook, keep)`):**
- `main/blocking.js`: `handleRequest()` asks `privacy.upgrade(details, incognito)` first for main-frame requests and
  redirects when it returns a URL; `applySession()` keeps the webRequest listener installed while
  `privacy.wantsRequestHook()` is true even with Purify off; export `refreshHooks()`. (Electron allows only ONE
  `onBeforeRequest` listener per session, so nobody else may register one.)
- `main/tabs.js`: `did-fail-load` calls `httpsFallback()` → `privacy.onMainFrameFail({webContents, url, errorCode,
  incognito})`; `tabEvents` (EventEmitter, exported) re-emits every `tabs:*` UI event as `(manager, ...args)`.
- `main/menus.js`: the page context menu appends `hookItems('tools', …)` and `hookItems('extension-api', …)` →
  `mod.contextMenuItems(params, webContents)` returning Electron menu templates (or `[]`).
- `main/index.js`: registers IPC for `privacy tools toast`; calls `privacy.init()` at startup; flushes `privacy`
  last on quit (after every other module, before `storage.flush()`); then calls `windows.markCleanExit()`.
  The whole quit sequence is capped at 2 s.
- Settings schema (`main/storage.js`): `httpsMode` ('off'|'upgrade'|'strict', default 'upgrade'),
  `clearOnExitHistory|Cookies|Cache|Downloads` (bool, default false), `purifyBalancedSites` (host[], ≤ 500),
  `warnRiskyDownloads` (bool, default true).
- `renderer/pages/settings/settings.js`: section `sites` exists; auto-save controls `https-mode-select`,
  `clear-on-exit-{history,cookies,cache,downloads}-cb`, `risky-downloads-toggle`. `index.html` already loads
  `./sites.js`.
- `renderer/browser/js/layout.js` watches `#toast-host` (it sits in the layout flow, so the page moves down when a
  toast shows — HTML can never draw over the native page view).
- Channels: `preload/chrome.js` → `pure.tabs.pin`, `pure.blocking.setSiteLevel/reportBroken`,
  `pure.downloads.keep/discard/setOpenWhenDone`, `pure.tools.*`, `pure.toasts.*`; `preload/internal.js` →
  `pureInternal.privacy.allowHttp`, `pureInternal.sites.list/reset`. Shapes are documented next to each channel.

## E1 — Extensions compatibility layer

Goal: most popular extensions work (Dark Reader, SponsorBlock, Return YouTube Dislike, Bitwarden, Grammarly-style
popups, tab managers, uBO-style toolbar badges). Electron 44 implements only part of chrome.* (runtime, storage.local,
i18n, scripting, tabs partially, webRequest, management partially, devtools). Read `node_modules/electron/electron.d.ts`
for exact APIs (`session.registerPreloadScript({type: 'frame'|'service-worker', filePath})`, `ses.serviceWorkers`,
`ServiceWorkerMain.ipc`, `contextBridge.executeInMainWorld`) before writing code.

- `preload/extension-api.js` — registered by `main/extensions.js` on the persistent session only (never incognito),
  for **both** `type: 'service-worker'` (MV3 background) and `type: 'frame'`. First line of work: return
  immediately unless the context's protocol is `chrome-extension:` (web pages must pay ~nothing and get nothing;
  content scripts in web pages keep Electron's own runtime messaging). In extension contexts, **feature-detect** each
  API and only fill what's missing or broken: build the `chrome.*` objects in the main world with
  `contextBridge.executeInMainWorld`, backed by an IPC bridge to main (`ext-api:*` channels). Event objects follow
  Chrome's shape (`addListener/removeListener/hasListener`); main pushes events only to contexts that registered a
  listener for that event.
- `main/extension-api.js` — handlers; every call validated: the sender must be a `chrome-extension://<id>/` context
  of a loaded, enabled extension, and the id is taken from the sender, never from arguments. Check the extension's
  manifest `permissions`/`host_permissions` before acting (e.g. `cookies` needs the permission and a matching host).
  APIs, in priority order:
  1. `chrome.action` / `chrome.browserAction`: `setBadgeText/getBadgeText`, `setBadgeBackgroundColor`,
     `setBadgeTextColor`, `setTitle/getTitle`, `setIcon` (imageData or path; convert to a data URL ≤ 128 KB),
     `setPopup/getPopup`, `enable/disable`, `onClicked` (no-popup actions: toolbar click → event with the active tab),
     per-tab values (tabId) overriding global ones. Feed `extensions.js` → `ext:changed` so the toolbar's existing
     Action shape (`badge`, `badgeColor`, `icon`, `title`, `hasPopup`) updates; badge changes coalesced ≤ 4/s.
  2. `chrome.contextMenus` (+ `chrome.menus` alias): `create/update/remove/removeAll`, `onClicked`, contexts
     `page|selection|link|image|video|audio|editable|all`, `documentUrlPatterns`, `targetUrlPatterns`, parent ids
     (one submenu level per extension; more than one item per extension → a submenu named after the extension).
     Exposed through `contextMenuItems(params, webContents)` (see manager hook). Persist registrations in memory per
     extension (MV3 workers re-register on startup themselves).
  3. `chrome.tabs` fill-ins (only what Electron lacks): `query` (all fields Chrome supports that we can map:
     active, currentWindow, lastFocusedWindow, windowId, url patterns, title, audible, muted, pinned, status),
     `create`, `update` (url, active, muted, pinned), `remove`, `get`, `getCurrent`, `duplicate`, `reload`,
     `onCreated/onUpdated/onActivated/onRemoved` from `require('./tabs').tabEvents`. Tab ids = Pure's tab ids;
     window ids = Pure's window ids. Never expose incognito windows/tabs.
  4. `chrome.windows`: `get/getCurrent/getLastFocused/getAll` (populate), `create` (url, focused, type normal),
     `update` (focused, state), `remove`, `onFocusChanged/onCreated/onRemoved`. Use `require('./windows')` public
     functions (`getBrowserWindows`, `getTabManager`, `getState`, `createWindow`) and TabManager methods (`list`,
     `stateOf`, `createTab`, `activate`, `closeTab`, `navigate`). Don't edit those files; if something is missing,
     put it in your report.
  5. `chrome.notifications`: `create/update/clear/getAll`, `onClicked/onClosed` → Electron `Notification`
     (title, message, iconUrl from the extension package or data URL).
  6. `chrome.cookies`: `get/getAll/set/remove`, `onChanged` → `ses.cookies` (permission + host checks).
  7. `chrome.alarms` (only if missing): `create/get/getAll/clear/clearAll`, `onAlarm`; one `setTimeout` per alarm
     (unref'd), min period 30 s like Chrome, wakes the worker if needed (deliver when it starts).
  8. `chrome.storage.sync` → alias of `storage.local` with its own key prefix if missing; `chrome.permissions`
     `contains/getAll/request` (manifest-declared → true; others → false, never prompt); `chrome.webNavigation`
     `onBeforeNavigate/onCommitted/onDOMContentLoaded/onCompleted/getFrame/getAllFrames` (main frame + frames from
     `webContents.mainFrame.framesInSubtree`).
- `main/extensions.js`: register the preload + `extension-api` IPC lazily — only once an extension is actually
  loaded. Actions without a popup now fire `onClicked`. Settings rows show what an extension can access
  (Ext gains `permissions: string[]` — human labels like "Read and change data on all sites", "Tabs", "Cookies")
  and a short warning if it uses an API we still don't support (record unknown `chrome.*` calls per extension).
  Update the "Most simple extensions work" copy to be honest about the new level.
- Test: write small fixture extensions in your scratchpad (MV3 worker + popup) covering each API, load them unpacked
  in a scratch profile, and drive them over CDP. Then try at least 5 real extensions from the Chrome Web Store in the
  scratch profile (Dark Reader, SponsorBlock, Return YouTube Dislike, Bitwarden, one tab manager) and report which
  work, partly work, or fail and why.

## E2 — Tabs

- **Pinned tabs**: `pure.tabs.pin(id, pinned)` → `tabs:pin`. TabState gains `pinned` (bool). Pinned tabs always sit
  before unpinned ones (moving keeps that order; a pinned tab can't be dragged among unpinned ones and vice versa),
  can't be in a group or a split pane (pinning removes it from its group), and are shown icon-only
  (`div.tab.pinned`, ~36 px wide, no title/close button; title in the native `title` tooltip). Closing works as
  normal (Ctrl+W, middle click). Pinned tabs of non-incognito windows are always saved and reopened at startup —
  even when `restoreSession` is off (then only the pinned tabs come back, discarded/lazy until clicked). Tab context
  menu: "Pin tab" / "Unpin tab" at the top. `renderer/browser/js/tabs.js`: render + drag rules (horizontal and
  vertical tab modes).
- **Crash recovery**: `windows.js` writes a marker file (`userData/profile/running.lock`) at startup and
  `markCleanExit()` deletes it (manager calls it at the end of quit). If the marker exists at startup, the last
  session file is kept (don't overwrite it before the user decides) and, when `restoreSession` is off, the first
  window shows a sticky toast via `require('./toast').show(win, {id:'restore', kind:'info', text:"Pure didn't close
  properly. Restore your tabs?", actions:[{id:'restore', label:'Restore'}]}, onAction)` (see E5). Restore =
  reopen the saved windows/tabs (lazy/discarded, like a normal session restore); dismiss = forget it. When
  `restoreSession` is on, just restore as normal (no toast).
- `tabs.js` `SETTINGS_SECTIONS`: add every current settings section (`sites passwords performance extensions import`).
- Keep the manager hooks, every existing behaviour and the TabManager method signatures E1 uses.

## E3 — Privacy

`main/privacy.js` exports `init()`, `registerIpc(ipc)`, `flush()`, `wantsRequestHook()`, `upgrade(details,
incognito)`, `onMainFrameFail({webContents, url, errorCode, incognito})`, `contextMenuItems` not needed.

- **HTTPS upgrades** (`httpsMode`): `wantsRequestHook()` = mode ≠ 'off'. `upgrade()` (hot path — keep it cheap):
  only `details.resourceType === 'mainFrame'`, `GET`, `http:` URLs; skip localhost, `*.localhost`, `*.test`,
  `*.local`, single-label hosts, IP literals (v4/v6), and hosts in the per-run allow list (http known to work or
  allowed by the user — a Set per profile kind; incognito keeps its own). Return the `https:` URL (same host, path,
  query; drop an explicit `:80`). Remember upgraded `webContentsId → {http URL, at}` (bounded, short-lived).
  `onMainFrameFail()`: if the failing URL is an upgrade we just did (`https:` + matches), then mode 'upgrade' →
  add the host to the allow list and return `{ load: httpUrl }` (silent fallback, like Chrome's HTTPS-Upgrades);
  mode 'strict' → return `{ error: 'HTTPS_ONLY', desc: 'This site doesn't support a secure connection.' }`.
  Otherwise `null`. Also treat an https→http redirect chain sanely (no loops: never upgrade the same URL twice within
  10 s for the same webContents). On `httpsMode` change call `require('./blocking').refreshHooks()`.
  Error page (`renderer/pages/error/error.js`): for `code=HTTPS_ONLY`, explain and show
  `#error-continue-http` ("Continue to the site (not secure)") → `pureInternal.privacy.allowHttp(url)` → main
  (sender must be a `pure://error/` page) allows the host for this run and loads the http URL in that tab.
  Verify with a real http-only site and with a site that supports https (both modes), plus localhost untouched.
- **Clear on exit**: `flush()` clears what `clearOnExit*` selects for the persistent session (history via storage's
  existing clear function, cookies + site storage via `ses.clearStorageData`, cache via `ses.clearCache()`, download
  list via the existing downloads clear). Never passwords, bookmarks, settings or Purify stats. Must finish within
  ~1.2 s: write a `userData/profile/clear-pending.json` first and delete it when done; `init()` finishes any pending
  clear before windows open (fast, async-safe). Settings › Privacy controls are listed in the manager section.
- **Site settings** (`#sites` section, `renderer/pages/settings/sites.js`): `pureInternal.sites.list()` → every host
  with a saved permission decision, a Purify exception or a Balanced level (combine `storage` site permissions,
  `blocking` exceptions and `settings.purifyBalancedSites`); `#sites-search` filters; `#sites-list` rows
  (`.site-row[data-host]` › `.site-row-host`, `.site-row-meta` (e.g. "Camera: allowed · Purify off"),
  `button[data-action="site-reset"]`). Reset → `sites:reset` (clears all three for that host). Empty state
  "No sites have custom settings yet." Settings › Privacy gets a "Site settings" link (`data-action="section"
  data-arg="sites"`, Visuals). The site-info popover's "All site settings" goes to `pure://settings/#sites`
  (siteinfo is E3-adjacent: change only that target in `renderer/browser/js/siteinfo.js` — one line, allowed).

## E4 — Purify & downloads

- **Per-site level**: `blocking:set-site-level` (chrome sender; host validated) updates `purifyBalancedSites`
  (via `storage.settings.set`). `blocking.level(host?)` returns 'balanced' for listed hosts (top-level site host,
  www-stripped match). `cosmetics.js` uses the top-level frame's host for its scriptlet decision. SiteInfo gains
  `level`. Shield (`shield.js`): `#shield-level` segmented control (`button[data-level="strict"]` "Full",
  `button[data-level="balanced"]` "Balanced", `.selected`), hidden when Purify is off for the site; changing it
  reloads the tab. Don't touch the request hooks the manager added in blocking.js.
- **Report a broken site**: `#shield-report` (`data-action="report-broken"`) → `blocking:report-broken` → main opens
  a new tab: `https://github.com/Sweet-Shots/Pure/issues/new?template=site-broken.yml&title=Broken+site%3A+<host>
  &site=<host>&version=<app version>&level=<Full|Balanced|Off>` (URL-encode; host only — never the path, query or
  anything else). Not in incognito (hide the button there: `html.incognito` CSS, plus a main-side refusal).
- **Downloads** (`main/downloads.js`):
  - Mark of the Web: when a download completes on Windows, write the `:Zone.Identifier` stream
    (`[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=<referrer origin>\r\nHostUrl=<download URL>\r\n`, only http(s)
    URLs, incognito included) so SmartScreen/Office protect opened files. First verify
    whether Electron already does this (check with `Get-Content -Stream Zone.Identifier`); don't double-write.
  - Risky files (`warnRiskyDownloads`): `.bat .cmd .ps1 .psm1 .vbs .vbe .js .jse .wsf .wsh .hta .scr .pif .com
    .reg .lnk .url .msc .cpl .jar` always; `.exe .msi .msix .appx .dll` only when the download URL is `http:`.
    Pause the item, set `warning`, and show `toast.show(win, {id:'dl-'+id, kind:'warn', text:'<name> could harm
    your computer.', actions:[{id:'keep',label:'Keep'},{id:'discard',label:'Discard'}]})`; Keep → resume, Discard →
    cancel + delete the partial file. Also `downloads:keep/discard` channels. No toast in other windows.
  - `openWhenDone`: `downloads:open-when-done` toggles; when it completes, open it (`shell.openPath`) — but never
    auto-open a file that had a warning. Add "Open when done" (checkbox item) to the native downloads menu for
    in-progress items.

## E5 — Tools & toasts

- `main/toast.js`: `show(win, toast, onAction)` → `toast:show` to that window's UI; `hide(win, id)`; `toast:action`
  from the UI (sender must be that window's UI) → `onAction(actionId)` then hides. Max 3 at once (oldest info toast
  dropped first). Default timeout 6 s for info, sticky (0) for toasts with actions unless given.
- `renderer/browser/js/toast.js`: renders into `#toast-host` (`.toast[data-id]` with `.toast-kind-info|warn|error`
  › `.toast-text`, `.toast-actions` › `button.toast-btn[data-action-id]`, `button.toast-close`). Plain text only
  (`textContent`). Timeout timers only while a toast is shown.
- `main/tools.js`:
  - **Screenshot** `tools:screenshot (tabId, mode)` (chrome sender, the tab must be in that window, http(s)/file/
    pure://home pages): 'visible' → `webContents.capturePage()`; 'full' → CDP `Page.getLayoutMetrics` +
    `Page.captureScreenshot({captureBeyondViewport: true, clip})` via `webContents.debugger` (attach only if not
    already attached — Lite mode may hold it; detach only if you attached; cap height at 16 384 px and say so in the
    toast). Save PNG to `Pictures/Pure Screenshots/Pure <yyyy-mm-dd hh.mm.ss>.png` (create folder), copy the image
    to the clipboard, toast "Screenshot saved" with actions Open / Show in folder. Incognito: same (it's the user's
    action) but don't keep anything in memory afterwards.
  - **Copy clean link** `tools:copy-clean-link (url)`: remove tracking parameters (`utm_*`, `fbclid`, `gclid`,
    `dclid`, `gbraid`, `wbraid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`, `si` on youtube.com/youtu.be/spotify,
    `ref_src`, `ref_url`, `_hsenc`, `_hsmi`, `oly_*`, `vero_*`, `yclid`, `twclid`, `ttclid`, `s_cid`, `spm`,
    `share_id`…, plus whatever Purify's `$removeparam` rules match when the engine is loaded), keep everything else,
    copy, toast "Clean link copied". Return the cleaned URL.
  - `contextMenuItems(params, webContents)`: page menu → "Take screenshot" (submenu: Visible area / Full page) for
    pages; link menu → "Copy clean link".
- `main/shortcuts.js`: Ctrl+Shift+X → screenshot (visible), Ctrl+Shift+C → copy clean link of the active tab.
  Update the Settings › Shortcuts list in your report so Visuals adds them (it's static HTML).
- `renderer/browser/js/palette.js`: new actions "Take screenshot", "Take full-page screenshot", "Copy clean link",
  "Pin tab" / "Unpin tab" (current tab), "Site settings" (→ settings#sites), "Report a broken site" (not incognito).
- `app.js`: one import + `initToasts()` line.

## Visuals (Opus, medium)

Design everything above in Pure's existing visual language (tokens in the existing CSS, Lucide icons from
`node_modules/lucide-static`, light + dark + incognito-red). Markup contract:
- Browser `index.html`: `#toast-host` (in flow directly below the toolbar/pw-bar, above `#views`; empty = 0 px tall);
  `.tab.pinned` styles (icon-only, both tab modes); `#shield-level` (two-button segmented control, inside the shield
  popover under the per-site toggle) and `#shield-report` (`data-action="report-broken"`, small text button near
  the footer; hidden in incognito); extension badges (`.ext-badge`, already in markup) polished.
- Settings: Privacy gets `#https-mode-select` (Off / Upgrade to HTTPS when possible (recommended) / HTTPS-only —
  warn before insecure sites), a "Clear when Pure closes" group with the four checkboxes, and a "Site settings"
  link; new section `#sites` (sidebar button `data-arg="sites"` with a Lucide icon, `#sites-search`,
  `#sites-list`); Downloads gets `#risky-downloads-toggle` ("Warn before keeping risky files"); Shortcuts list adds
  Ctrl+Shift+X (Screenshot) and Ctrl+Shift+C (Copy clean link); Extensions rows get a permissions line + warning.
- Error page: `#error-continue-http` button (hidden by default; error.js shows it).

## DOM IDs (scripts/check.js enforces)
Browser: `toast-host shield-level shield-report`. Settings: `sites sites-search sites-list https-mode-select
clear-on-exit-history-cb clear-on-exit-cookies-cb clear-on-exit-cache-cb clear-on-exit-downloads-cb
risky-downloads-toggle`. Error page: `error-continue-http`.

## Done means
`npm run check` passes; you ran Pure (`npx electron .` with `PURE_PROFILE` set to a scratch dir, and
`--remote-debugging-port` only for your own scripted checks) and verified your feature end to end; CPU at idle is
unchanged; your report lists what you did, how you tested it, anything you couldn't do, and anything another owner
must change. Don't build the installer, commit, push or release.
