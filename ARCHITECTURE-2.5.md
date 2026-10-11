# Pure 2.5 round — ships as **2.4.0** (binding)

Read `ARCHITECTURE.md`, `-2.1.md` … `-2.4.md` first; this file wins on conflicts. All earlier rules apply:
**low CPU/RAM first** (no polling, nothing runs for users who don't use a feature, lazy-require heavy code),
sandbox + contextIsolation everywhere, validate every IPC sender (`main/security.js`) and argument, no inline
scripts/handlers, **only edit files you own**, keep every manager hook marked `(manager hook, keep)`.

**Test data rule (strict):** never read, copy or import the user's real browser profiles or passwords. Build fake
fixture profiles in your scratch folder (fake Bookmarks JSON, History/Login Data SQLite files you create, a fake
`Local State` with a test key you DPAPI-encrypt yourself) and point the importer at them through the
`PURE_IMPORT_ROOT` override described below. Test Pure only with `PURE_PROFILE=<scratch dir>` and your own
`--remote-debugging-port`. Never sign in to any account.

## Features

| # | Feature | Owner |
|---|---|---|
| 1 | Import from more browsers (Opera, Opera GX, Vivaldi, Chromium, Firefox; every profile, not just Default) | F1 |
| 2 | Import passwords (Chromium browsers + CSV files from any browser / password manager) | F1 (+ F5's `importLogins`) |
| 3 | Bookmarks HTML import / export (the universal format every browser reads) | F1 |
| 4 | Sort bookmarks (manual drag order, name, newest, oldest, site) in the sidebar and bookmarks bar | F2 |
| 5 | New tabs and new windows put the caret in the address bar | F3 |
| 6 | Tab drag-out shows a live preview window following the cursor | F3 |
| 7 | A window created by dragging a tab out skips the welcome animation | F3 |
| 8 | Widevine DRM (Spotify, Netflix, Disney+…) via castLabs Electron | F4 |
| 9 | Strong password generator on sign-up / change-password forms | F5 |
| 10 | Settings pages centered; import UI with sources, profiles, passwords, files; bookmark sort control | Visuals (Opus) |

## Ownership

| Owner | Files |
|---|---|
| **F1 Import** | `main/importer.js`, `renderer/pages/settings/import.js` |
| **F2 Bookmarks** | `renderer/browser/js/bookmarks.js` (sidebar + bookmarks bar UI) |
| **F3 Tabs & windows** | `main/windows.js`, `main/tabs.js`, `renderer/browser/js/tabs.js`, `renderer/browser/js/welcome.js`, `renderer/browser/js/address-bar.js`, `renderer/pages/home/home.js`, new `main/drag-preview.js`, new `renderer/pages/drag-preview/*` |
| **F4 Widevine** | `package.json` (only the `electron` devDependency and `build` hooks/files), new `main/drm.js`, new `scripts/*` for signing |
| **F5 Passwords** | `main/passwords.js`, `preload/page-passwords.js`, `renderer/pages/settings/passwords.js` |
| **Visuals (Opus)** | every `.html` / `.css` under `renderer/` (except F3's new drag-preview page, which F3 writes and Visuals may restyle) |
| **Manager (frozen)** | `main/storage.js`, `main/index.js`, `preload/*.js` (except F5's page-passwords.js), `renderer/pages/settings/settings.js`, `scripts/check.js`, docs |

**Manager work already in place:**
- `storage.js`: bookmarks keep a **manual order** (the stored array order; no more sort-by-date on load/import);
  `bookmarks.reorder(urls)` + IPC `bookmarks:reorder`; settings `bookmarkSort` ('manual'|'name'|'newest'|'oldest'|
  'site', default 'manual') and `focusAddressBarOnNewTab` (bool, default true).
- `preload/chrome.js`: `pure.bookmarks.reorder(urls)`. `preload/internal.js`: `pureInternal.importer.detect/run`
  (new shapes documented there), `importFile(kind)`, `exportBookmarks()`.
- `index.js`: registers IPC for `drm`, and awaits `drm.init()` (≤ 3 s) before the first window opens.
- `settings.js`: auto-save control `focus-address-bar-toggle` (Appearance section; reset with it).

## F1 — Import

- Sources (Windows paths under `%LOCALAPPDATA%` unless noted): Chrome, Edge, Brave (existing), **Chromium**
  (`Chromium\User Data`), **Vivaldi** (`Vivaldi\User Data`), **Opera** (`%APPDATA%\Opera Software\Opera Stable` — the
  profile folder is the root itself, `Local State` sits in the same folder), **Opera GX** (`%APPDATA%\Opera
  Software\Opera GX Stable`), **Firefox** (`%APPDATA%\Mozilla\Firefox\profiles.ini` → profiles), Pure 1.1.1
  (existing). For Chromium-family browsers list every profile (`Local State` → `profile.info_cache` names:
  Default, Profile 1, …); `detect` returns them as `profiles`.
- Dev/test override: when `PURE_IMPORT_ROOT` is set **and `!app.isPackaged`**, resolve `%LOCALAPPDATA%` and
  `%APPDATA%` under that folder (`<root>/Local`, `<root>/Roaming`). Ignored in packaged builds.
- Bookmarks import flat (Pure has no folders yet): skip duplicates by URL, keep `date_added` as `createdAt`, and append in the source's order.
- Firefox: `places.sqlite` (copy to temp first, like History) → bookmarks (`moz_bookmarks` type 1 joined to
  `moz_places`, skip `place:` URLs) and history (`moz_historyvisits`, last 90 days, ≤ 10 000). Passwords from
  Firefox: not decrypted — the UI tells the user to export a CSV from Firefox (about:logins › ⋯ › Export) and import
  it here.
- **Chromium passwords**: copy `Login Data` (SQLite) to temp; `Local State` → `os_crypt.encrypted_key` (base64,
  strip `DPAPI` prefix) → decrypt with Windows DPAPI for the current user. Electron has no direct DPAPI call for
  arbitrary data: use PowerShell (`[System.Security.Cryptography.ProtectedData]::Unprotect`, CurrentUser scope)
  via `child_process.execFile` with the blob passed on **stdin** (never on the command line or in a temp file),
  `windowsHide: true`, 10 s timeout. Each `password_value` starting with `v10`/`v11` is AES-256-GCM (12-byte nonce
  after the 3-byte prefix, 16-byte tag at the end) — decrypt with Node `crypto`. Values starting with `v20`
  (Chrome's app-bound encryption, Chrome 127+) **cannot** be decrypted by other apps: count them and return a
  warning: "Chrome protects N passwords so only Chrome can read them. Export them from Chrome (Settings › Passwords
  › Export) and import the CSV here." Only `http(s)` origins, non-empty password. Hand rows to
  `require('./passwords').importLogins(rows, {source})` (F5) — plaintext passwords must never be logged, put in
  temp files, sent to a renderer, or kept after the call (overwrite buffers where practical).
- **CSV import** (`import:file 'passwords-csv'`): native open dialog (`.csv`), ≤ 5 MB, RFC 4180 parsing (quoted
  fields, embedded commas/newlines). Recognise the headers of Chrome/Edge/Brave/Opera (`name,url,username,password`),
  Firefox (`url,username,password,httpRealm,formActionOrigin,…`), Bitwarden (`login_uri,login_username,login_password`),
  1Password/LastPass (`url,username,password,…`) — case-insensitive. → `importLogins`.
- **Bookmarks HTML** import (`import:file 'bookmarks-html'`, Netscape format, ≤ 10 MB; `<A HREF ADD_DATE>`) and
  export (`export:bookmarks`: native save dialog, default `Pure bookmarks <date>.html`, Netscape format, escaped).
- Incognito windows can't import (existing rule). Every channel: internal sender (settings page) only.
- Settings UI (`renderer/pages/settings/import.js`): source list with availability, `#import-profile-select`
  (profiles of the chosen source; hidden when only one), checkboxes `#import-bookmarks-cb`, `#import-history-cb`,
  `#import-passwords-cb` (disabled where unsupported, with a hint for Firefox), `#import-settings-cb` (Pure 1.1.1
  only), Import button, `#import-status` with counts + warnings; a "From a file" row with
  `[data-action="import-passwords-csv"]`, `[data-action="import-bookmarks-html"]`,
  `[data-action="export-bookmarks"]`.
- About "importing Google accounts": signed-in sessions (cookies) are not imported — Chrome encrypts them for
  Chrome only, and moving sessions between apps is unsafe. Say so in the UI hint ("Sign in to your accounts again
  in Pure — your passwords are imported, so it's one click").

## F2 — Bookmarks sorting

- `renderer/browser/js/bookmarks.js`: the sidebar (`#bookmark-sidebar` / `#bookmark-list`) and the bookmarks bar
  display bookmarks in the `bookmarkSort` order (name: locale compare, case-insensitive; newest/oldest by
  `createdAt`; site: by host then title; manual: the list order). `#bookmark-sort` (a `<select>` in the sidebar
  header, Visuals adds it) sets the setting via `pure.settings.set`. In **manual** mode, pointer-drag to reorder in
  the sidebar (Y axis) and the bar (X axis) with a drop indicator; drop → `pure.bookmarks.reorder(urls)`. In other
  modes dragging is off and a hint says "Switch to Manual to drag". Keyboard: Alt+↑/↓ moves the focused item in
  manual mode. Re-render only on `bookmarks:changed` / setting change (no polling); keep rendering cheap for
  2 000 bookmarks (build once, reuse nodes or use a DocumentFragment).

## F3 — Tabs & windows

- **Address bar focus**: when `focusAddressBarOnNewTab` is on, a new tab opened by Ctrl+T / the + button / the
  palette, the first tab of a new window, and Pure's startup window put keyboard focus in the browser UI's address
  bar (caret, empty text for the home page) instead of the home page's search box. `home.js` must not steal focus
  when it's on (read the setting; keep its own focus when off). Links opened in a background tab never move focus.
- **Drag preview**: while a tab is dragged outside the tab strip (the existing detach flow), show a small frameless,
  non-focusable, always-on-top, transparent `BrowserWindow` (~320 px wide, aspect of the window) following the cursor,
  showing a snapshot of the tab (`webContents.capturePage()` scaled down once at drag start, as a data URL) with the
  tab title. Created lazily on the first drag and reused (hidden between drags); destroyed when the last browser
  window closes. Position updates come from the renderer's pointer events (pointer capture keeps them flowing
  outside the window) at most once per animation frame; main moves the window with `setPosition`. Hide it on drop /
  cancel / Esc. Sleeping (discarded) tabs show the favicon + title instead of a snapshot. Page: `pure://` page under
  `renderer/pages/drag-preview/` (served by the existing protocol handler; check `main/protocol.js` hosts — if a
  new host is needed, report it to the manager instead of editing protocol.js) or a `data:` URL page — your choice,
  no preload, `sandbox: true`.
- **No welcome animation on detach**: windows created by dragging a tab out (and by "Move to new window") start
  without the welcome overlay. Pass a flag through `createWindow` → `win:info` (`skipWelcome: true`) →
  `welcome.js`.

## F4 — Widevine (castLabs Electron)

- Switch the `electron` devDependency to castLabs ECS: `"electron": "https://github.com/castlabs/electron-releases#v44.5.1+wvcus"`
  (the newest 44.x with Widevine; verify the tag exists and installs; it is a drop-in Electron 44 build). Update
  `package-lock.json` through npm. Check `electron-builder` still packages it (`npm run dist` is allowed **for your
  own verification only** — don't release).
- `main/drm.js`: `init()` → `const { components } = require('electron'); await components.whenReady()` when
  `components` exists (log the CDM status `components.status()` once); no-op on stock Electron. Never throw. Export
  `registerIpc` (no channels needed unless you add a status line for Settings › About — if so, report the channel
  to the manager instead of editing preloads).
- VMP signing (production Widevine needs the app signed by castLabs EVS; without it some services refuse
  playback): add `scripts/evs-sign.js` as an electron-builder `afterPack`/`afterSign` hook that runs
  `python -m castlabs_evs.vmp sign-pkg <appOutDir>` **only when** `EVS_ACCOUNT_NAME` is set in the environment;
  otherwise log one line and continue. Document the one-time setup (`pip install castlabs-evs`,
  `python -m castlabs_evs.account signup` — the **user** creates the account, not you) in your report.
- Verify: a fresh scratch profile reports `requestMediaKeySystemAccess('com.widevine.alpha', …)` success; a public
  Widevine test stream plays (e.g. the Shaka Player demo's Widevine assets or Bitmovin's DRM demo); open.spotify.com
  loads without the "playback of protected content" error (you can't sign in — just check the DRM check passes).
  Then re-check that nothing regressed on 44.5.1: Pure starts, Purify builds/loads its engine, YouTube plays, Google
  sign-in page loads, an unpacked fixture extension loads. Report CPU/RAM at idle vs before (the CDM must not run
  until a page asks for it).

## F5 — Passwords

- `importLogins(rows, {source})` export in `main/passwords.js` (used by F1): rows `{origin|url, username,
  password}`; normalise to origin (`https://host[:port]`), skip invalid/empty; same origin+username → update only if
  the password differs; returns `{added, updated, skipped}`; one debounced save; never logs secrets; refuses while
  `safeStorage.isEncryptionAvailable()` is false.
- **Password generator**: `preload/page-passwords.js` detects new-password fields (`autocomplete="new-password"`,
  or a sign-up / change-password form: two password fields, or a password field with a "confirm" sibling, or form
  text/ids like register/signup/create account). On focus of such a field, main shows the existing native popup
  (same mechanism as autofill) with "Use a strong password" (shows a masked preview like `Xk7…` — never the whole
  password in the menu). Choosing it: main generates 20 chars with `crypto.randomInt` (upper, lower, digits,
  symbols `-_.!@#$%*`, at least one of each, no ambiguous `0O1lI`), sends it ONLY to that frame, which fills every
  new-password field in the form and dispatches `input`/`change`; then the normal save offer appears on submit
  (pre-marked as generated so it's offered even if the user doesn't type). Generation also works in incognito;
  saving still follows the existing rules (never saved in incognito, respects `savePasswords`).
- Settings › Passwords: "Import passwords…" button → `pureInternal.importer.importFile('passwords-csv')` (F1 owns
  the channel; you just call it) and a note pointing to Settings › Import for browsers.

## Visuals (Opus, medium)

- **Center the settings pages**: the content column is centered in the space right of the sidebar (max-width as
  today), at every window width, without moving the sidebar; check every section incl. Site settings.
- Import section redesign for F1's UI (sources as a list with browser names, availability, profile select,
  four checkboxes incl. `#import-passwords-cb`, status area with warnings, "From a file" row with the three
  buttons). Use generic Lucide icons (no browser logos/brands).
- `#bookmark-sort` select in the bookmark sidebar header (+ styles for F2's drag indicator `.bm-drop-indicator`
  and `.bm-dragging`).
- `#focus-address-bar-toggle` in Appearance ("Start new tabs in the address bar").
- Passwords section: "Import passwords…" button (`data-action="import-passwords-csv"`).
- Optional polish of F3's drag-preview page (rounded card, shadow-free border, title strip).

## DOM IDs (scripts/check.js enforces)
Browser: `bookmark-sort`. Settings: `import-passwords-cb import-profile-select focus-address-bar-toggle`.

## Done means
`npm run check` passes; you ran Pure with a scratch `PURE_PROFILE` and your own debug port and verified your feature
end to end; idle CPU unchanged; your report lists what you did, how you tested it, what you couldn't do and anything
another owner must change. Don't commit, push, release or run the installer build (F4 may build for verification).
