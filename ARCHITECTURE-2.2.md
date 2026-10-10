# Pure 2.2 — addendum (binding)

Read `ARCHITECTURE.md` and `ARCHITECTURE-2.1.md` first; where they conflict, this file wins.
All earlier rules still apply: low CPU/RAM first, no polling loops, sandbox + contextIsolation everywhere, validate
every IPC sender (`main/security.js`) and argument, no inline scripts/handlers, only edit files you own.

Features: password saving + autofill · auto-updates (GitHub Releases) · Chrome extensions (Electron built-in +
`electron-chrome-web-store`, MIT) · secure DNS · cookie-banner blocking toggle · site info panel · command palette +
tab search · split view · tab groups · reader mode · mute other tabs · force dark mode for websites · focus mode ·
vertical tabs.

**Libraries already installed:** `electron-chrome-web-store@0.13.0`, `electron-updater@6.8.9`,
`@mozilla/readability@0.6.0`, `dompurify@3.4.16`. Do not add others.

**Already done by the manager (frozen — report needs, don't edit):**
- Settings schema (`main/storage.js`): `savePasswords`, `autoUpdate`, `dohMode` (off|automatic|secure),
  `dohProvider` (cloudflare|google|quad9|nextdns|custom), `dohCustomUrl`, `blockCookieBanners`, `forceDarkWeb`,
  `verticalTabs`, `focusMode`, `readerFont` (serif|sans), `readerSize` (14–28).
- Channels: `preload/chrome.js` (`pure.groups`, `pure.split`, `pure.muteOthers`, `pure.palette`, `pure.site`,
  `pure.reader`, `pure.extensions`, `pure.passwords`) and `preload/internal.js` (`pureInternal.passwords`,
  `.extensions`, `.updater`, `.reader`). Shapes are documented there.
- `main/index.js` registers IPC for `passwords extensions updater palette siteinfo reader`, calls `init()` on
  `dns extensions updater` after the default session exists (each init must be fast; heavy work async), and flushes
  `passwords`/`extensions` (`flush()`) on quit. Force-dark is done (a startup switch read from settings.json).
- `main/sessions.js` calls `passwords.attach(ses, {incognito})` and `extensions.attach(ses, {incognito})` for every
  session.
- `main/protocol.js` serves `pure://reader/` from `renderer/pages/reader/` with a reader CSP (img http/https/data,
  `connect-src 'none'`, `script-src 'self'`).
- `main/shortcuts.js` sends `ui:command`: `command-palette` (Ctrl+K), `tab-search` (Ctrl+Shift+A), `focus-mode`
  (Ctrl+Shift+F), `split-view` (Ctrl+Shift+S), `mute-others` (Ctrl+Shift+M), `reader-mode` (F9).
- `renderer/pages/settings/settings.js`: sections `passwords` and `extensions` exist; auto-save controls
  `save-passwords-toggle auto-update-toggle doh-mode-select doh-provider-select doh-custom-input
  cookie-banners-toggle force-dark-toggle vertical-tabs-toggle focus-mode-toggle`.

## Ownership

| Owner | Files |
|---|---|
| **C1 Accounts & safety** | `main/passwords.js`, `preload/page-passwords.js` (new frame preload), `renderer/browser/js/passwords.js`, `renderer/pages/settings/passwords.js`, `main/dns.js`, `main/updater.js`, `renderer/pages/settings/updater.js`, `package.json` (only `build.publish`) |
| **C2 Extensions** | `main/extensions.js`, `renderer/browser/js/extensions.js`, `renderer/pages/settings/extensions.js` |
| **C3 Tabs** | `main/tabs.js`, `main/windows.js`, `main/menus.js` |
| **C4 Browser UI** | `main/palette.js`, everything in `renderer/browser/js/` except C1/C2's files (new: `palette.js`, `siteinfo.js`, `focus.js`, `split.js`, `groups.js`, `reader.js`); C1 and C2 may add ONE import+init line each to `app.js` |
| **C5 Reader & privacy** | `main/reader.js`, `main/siteinfo.js`, `main/blocking.js` (cookie-banner setting only), `renderer/pages/reader/reader.js`, `renderer/pages/reader/vendor/*` (vendored copies of library files) |
| **Visuals (Opus)** | every `.html` / `.css` under `renderer/` (incl. new `renderer/pages/reader/index.html` + `reader.css`) |

## Feature specs

**Passwords (C1).** Encrypted with Electron `safeStorage` (Windows DPAPI) in `userData/profile/logins.json`
(`{id, origin, username, passwordEnc (base64), createdAt, updatedAt}` + `never: [origin]`), debounced atomic writes,
`flush()`. Never stored or offered in incognito (incognito may still *fill* saved logins). Page side: a frame preload
registered with `session.registerPreloadScript({type:'frame', filePath})` in `attach()` (not on `pure://`, only
http(s) top frames + same-origin subframes). Detect login forms (password inputs), capture `{username, password}` on
submit/navigation-after-typing, send to main; main validates `event.senderFrame.origin`, then offers via `pw:offer` to
that window's UI → bar `#pw-bar` (save / never / dismiss; "Update password?" when the username exists). Autofill: when
a username/password field gets focus and logins exist for the frame's exact origin, main shows a native `Menu.popup`
at the field (preload sends its rect; convert to window coords) listing usernames; choosing one sends the credential
ONLY to that frame (`webContents.sendToFrame` / `frame.send`), which fills fields and dispatches `input`/`change`.
Never send passwords to a frame whose origin differs from the saved origin. Settings `#passwords` section: list,
search, reveal (copy with `navigator.clipboard`), edit, delete, never-save list.

**Secure DNS (C1, `main/dns.js`).** `init()` + settings change → `app.configureHostResolver({ secureDnsMode:
'off'|'automatic'|'secure', secureDnsServers: [template] })`. Templates: cloudflare
`https://cloudflare-dns.com/dns-query`, google `https://dns.google/dns-query{?dns}`, quad9
`https://dns.quad9.net/dns-query`, nextdns `https://dns.nextdns.io`, custom = `dohCustomUrl` (fallback to automatic
with no servers if empty). Verify option names in electron.d.ts.

**Auto-updates (C1, `main/updater.js`).** `electron-updater` with the GitHub provider. `package.json` `build.publish`
= `{ provider: 'github', owner: 'PURE_GITHUB_OWNER', repo: 'pure-browser' }` placeholder; the updater must detect the
placeholder (or `!app.isPackaged`) and report state `disabled` with a clear reason — never throw or spam logs.
When enabled: check 10 s after startup then every 6 h (one `setTimeout` chain, `unref`), only if `autoUpdate`;
`autoDownload = true`, `autoInstallOnAppQuit = true`; broadcast `update:status` to `pure://settings` pages.
Settings › About: `#update-status`, `#update-progress`, `#auto-update-toggle`, `[data-action="check-updates"]`,
`[data-action="install-update"]` (shown only when ready).

**Extensions (C2).** Only on the persistent profile session (`persist:pure`); never in incognito. Electron's
`session.extensions` API (Electron 44 — check electron.d.ts: `ses.extensions.loadExtension/removeExtension/
getAllExtensions` and the `extension-loaded` events). Store installs via `electron-chrome-web-store`
(`installChromeWebStore({ session, extensionsPath: userData/extensions, ... })` — read its README/types; it makes
"Add to Chrome" work on chromewebstore.google.com and keeps extensions updated). Unpacked: native folder picker,
copy-less load + remember path. Persist enabled/disabled state in `userData/profile/extensions.json`; disabled =
not loaded. Toolbar: `#ext-actions` holds `button.ext-action[data-ext-id]` (icon img + `.ext-badge`) for extensions
with an `action`/`browser_action`; click → if it has a popup, open a small frameless `BrowserWindow` (parent = window,
same session, sandboxed, `chrome-extension://<id>/<popup>`), positioned under the button, auto-sized to content (cap
800×600), closed on blur; if no popup, emit `chrome.action.onClicked` is NOT available in Electron — show nothing and
document. Settings `#extensions`: `[data-action="open-web-store"]`, `[data-action="load-unpacked"]`, `#ext-list`
(`.ext-row[data-id]` › `img.ext-icon .ext-name .ext-meta .ext-desc` + `input.ext-toggle[type=checkbox]` +
`button[data-action="remove-extension"]`), `#ext-status`. Be honest in the UI copy: "Most simple extensions work;
some that need advanced Chrome features may not."

**Tabs: groups, split view, mute others (C3).** Groups per window, persisted in session save; TabState gets
`groupId`; `groups:changed` on any change; collapsing a group hides its tabs in the strip (the active tab can't be in
a collapsed group — expand on activate). Split view: one split per window, two tabs shown side by side inside the
content rect with a 6 px gap at `ratio` (left pane width share, 0.2–0.8); the gap is where the UI draws
`#split-divider`; clicking a pane focuses it (`split.focused`) and the toolbar/address bar follow the focused pane
(it is the window's active tab). Closing either tab or `split:close` ends the split. Split state in session save.
`tabs:mute-others`. Tab context menu (menus.js): "Add tab to new group", "Add tab to group ›" (existing groups),
"Remove from group", "Open in split view" / "Close split view", "Mute other tabs". Keep everything event-driven.

**Command palette + tab search (C4 UI, C4 `main/palette.js`).** `#palette` overlay (page frozen while open via
freeze.js). Ctrl+K: empty query shows recent tabs + actions; typing searches tabs (all same-mode windows), bookmarks,
history (`palette:query`, debounced 80 ms, stale responses dropped) and local entries: actions (New tab, New window,
New incognito window, Reopen closed tab, Toggle bookmarks bar, Toggle focus mode, Toggle vertical tabs, Split view,
Reader mode, Mute other tabs, Clear browsing data → settings#privacy, Theme: dark/light/system, Downloads, History,
Settings sections). Ctrl+Shift+A opens it in tabs-only mode (prefix "@tabs" chip). ↑/↓/Enter/Esc; results grouped
with `.pal-section` headers. Markup: `#palette` › `#palette-input`, `#palette-list` (JS fills `.pal-section` and
`.pal-item[data-index][data-kind]` › `.pal-icon`, `.pal-title`, `.pal-sub`, `.pal-kind`; `.selected`),
`#palette-empty`.

**Site info (C4 UI, C5 `main/siteinfo.js`).** `#lock-icon` becomes a button; click opens `#site-popover` (frozen page)
› `#site-host`, `#site-status`, `#site-perms` (JS fills `.site-perm-row` › `.site-perm-name` +
`select.site-perm-select[data-permission]` with options allow/ask/block), `#site-cookies`, `#site-blocked`,
`#site-zoom`, `[data-action="site-clear-data"]`, `[data-action="site-all-settings"]` (→ settings#privacy). Not for
`pure://` pages. siteinfo.js: permissions from `storage.sitePermissions` for the tab's origin (the common prompted set:
camera, microphone, geolocation, notifications, clipboard-read, midi), cookies count via `ses.cookies.get({url})`,
blocked count from `blocking.blockedOnTab`, `clearData` via `ses.clearStorageData({origin})` + cookies for the domain.

**Reader mode (C5 + C4 button + Visuals page).** After `did-finish-load` on http(s) main frames (not incognito-only —
works everywhere), run Readability's `isProbablyReaderable` in an isolated world (`executeJavaScriptInIsolatedWorld`
with the library source read once from `node_modules/@mozilla/readability/Readability-readerable.js` /
`Readability.js` and cached in memory) → `reader:available` to the UI (`#btn-reader` shown). Toggle → parse with
`Readability` (clone the document) in the isolated world, keep the article in main (Map id → article, max 20,
per-tab), navigate the tab to `pure://reader/?id=N` (normal navigation so Back returns). Reader page loads
`./vendor/purify.min.js` (copy from `node_modules/dompurify/dist/purify.min.js`) then `./reader.js`; sanitize
`contentHtml` with DOMPurify (no scripts/iframes/forms/styles attributes; images allowed; links get
`rel="noopener noreferrer"`), render into `#reader-content`. Toolbar: `[data-action="reader-exit"]`,
`[data-action="font-serif"]`, `[data-action="font-sans"]`, `[data-action="size-down"]`, `[data-action="size-up"]`
(persist `readerFont`/`readerSize`); `#reader-title`, `#reader-meta`, `#reader-error`; `html.font-sans|font-serif`,
`--reader-size` on `<html>`. Exit = history back (or load `url`).

**Cookie banners (C5).** `blockCookieBanners` → blocking engine uses the cookie-banner/annoyance list variant
(the "full" engine Lite mode already uses) when `liteMode || blockCookieBanners`; live switch.

**Focus mode (C4 + Visuals).** `focusMode` setting (and Ctrl+Shift+F / palette toggles it via `pure.settings.set`).
`html.focus-mode`: title bar, toolbar, bookmarks bar and status bar collapse; a 4 px `#focus-reveal` strip stays at the
top (the page starts below it, so the UI receives the hover). Hovering the strip adds `html.focus-reveal` (chrome
shown, page pushed down); leaving the chrome for 700 ms removes it. Content bounds follow automatically.

**Vertical tabs (C4 + Visuals).** `verticalTabs` → `html.vertical-tabs`. Visuals re-flows the existing DOM with CSS
(the tab strip becomes a ~220 px column left of `#views`, + button at its top, window controls stay top-right).
C4: pointer-drag reorder uses the Y axis in vertical mode; detach rules unchanged; wheel scrolls vertically.

**Tab groups strip (C4 UI).** Before the first tab of each group render `button.tab-group[data-group-id]` (title or a
dot, `--group-color`, `.collapsed`); tabs in a group get `data-group-id` and `--group-color`. Click chip →
collapse/expand; right-click chip → `#group-editor` popover (frozen page) › `input#group-title`, `#group-colors`
(`button[data-color]` × 9, `.selected`), `[data-action="group-ungroup"]`, `[data-action="group-close-tabs"]`.

**Split divider (C4 UI).** `#split-divider` (inside `#views`, hidden unless split) — pointer-drag sets the ratio
(`pure.split.setRatio`, rAF-throttled); double-click resets to 0.5.

**Mute others / reader button / palette routing (C4).** Handle every new `ui:command`.

## DOM IDs (scripts/check.js enforces)

Browser `index.html`: `site-popover site-host site-status site-perms site-cookies site-blocked site-zoom btn-reader
ext-actions pw-bar pw-bar-text palette palette-input palette-list palette-empty split-divider focus-reveal
group-editor group-title group-colors` (+ `[data-action]` buttons named above).
Settings: `passwords save-passwords-toggle pw-search pw-list pw-never-list extensions ext-list ext-status
cookie-banners-toggle doh-mode-select doh-provider-select doh-custom-input force-dark-toggle vertical-tabs-toggle
focus-mode-toggle update-status update-progress auto-update-toggle`.
Reader `pages/reader/index.html`: `reader-toolbar reader-article reader-title reader-meta reader-content reader-error`.
