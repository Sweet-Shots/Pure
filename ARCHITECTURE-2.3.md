# Pure 2.3 — uBlock-Origin-level blocker (binding)

Read `ARCHITECTURE.md`, `-2.1.md`, `-2.2.md` first; this file wins on conflicts. All earlier rules apply (low CPU/RAM
first, sandbox + contextIsolation, validate every IPC sender/argument, no inline scripts, only edit files you own).

**Goal:** match uBlock Origin. Measured baseline (manager, 2026-10-09):
- Lists now come straight from uBO's CDN (`main/blocking.js` `adsLists()/adsAndTrackingLists()/fullLists()`, includes the
  yearly `filters-2020…<current year>` files the library list set was missing) and refresh every 8 h.
- Scriptlets run at document start via `preload/blocking-scriptlets.js` + sync IPC `pure:blocking-scriptlets`
  (`scriptletsFor()` in blocking.js). With fresh lists YouTube plays with **no ads** (3/3) on level `strict` (now the
  default; UI name "Full"). `balanced` = no scriptlets (fallback).
- adblock.turtlecute.org host checks: 87/128 with uBO lists; **126/128 adding HaGeZi Multi NORMAL**
  (`https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/multi.txt`), 128/128 with HaGeZi Pro.
- Remaining gaps vs uBO: list management UI; cosmetics/scriptlets only in the top frame; no procedural (extended)
  cosmetic filters and no dynamic hiding (MutationObserver off); no `$csp` / `$removeparam`; no element picker / My filters.

## Ownership

| Owner | Files |
|---|---|
| **D1 Lists & engine** | `main/filterlists.js` (new), `main/blocking.js` (engine build/refresh/list wiring/network matching, `$csp`, `$removeparam` — not the cosmetic parts), `main/engine-worker.js` (new, worker thread), `renderer/pages/settings/filterlists.js` (new) |
| **D2 Cosmetics** | `main/cosmetics.js` (new: all cosmetic + scriptlet IPC), `preload/blocking-cosmetics.js` (new: replaces both the Ghostery library preload and `preload/blocking-scriptlets.js`, which D2 deletes) |
| **D3 Picker & My filters** | `main/picker.js` (new), `preload/picker.js` (new frame preload), `main/menus.js` (only: "Block element…" item), `renderer/browser/js/shield.js` (only: "Block an element" button handler), `renderer/pages/settings/myfilters.js` (new) |
| **Visuals (Opus)** | all `.html`/`.css` under `renderer/`, plus `renderer/assets/picker.css` (new — the picker overlay styles; main/picker.js reads it and hands it to the page preload, because sandboxed preloads can't read files) |

Manager already did: channels in `preload/internal.js` (`pureInternal.blocking.lists/setListEnabled/addList/removeList/
updateLists/onListsChanged/getMyFilters/setMyFilters`) and `preload/chrome.js` (`pure.blocking.pickElement(tabId, mode)`),
`main/index.js` registers IPC + flush for `filterlists cosmetics picker`.

## Interfaces between D1 / D2 / D3 (main process)

```js
// blocking.js (D1) exports, in addition to what it has:
getEngine() → ElectronBlocker|null          // current engine (swapped atomically on rebuild)
onEngineChanged(fn)                          // fn(engine) after every (re)build/swap
isActiveFor(webContents, url) → bool         // blocking on globally, http(s), not an excepted host, not pure://
level() → 'strict'|'balanced'
registerFramePreload(filePath) → void        // D2/D3 call once at require time; blocking.js registers every such preload
                                             // on every attached session while blocking is on (and unregisters when off)
                                             // — replaces the current hard-coded COSMETIC_PRELOAD/SCRIPTLET_PRELOAD logic
// filterlists.js (D1)
getUserListText() → string                   // D3's My filters are compiled in as one more list: D1 asks D3 via
                                             // require('./picker').getMyFiltersText() at build time
rebuild(reason) → Promise                    // D3 calls after My filters change (debounced 1 s)
// cosmetics.js (D2) — owns channels '@ghostery/adblocker/*' (taken over from blocking.js; D1 removes them there)
// and 'pure:blocking-scriptlets' (D1 removes scriptletsFor/its handler from blocking.js; D2 re-implements in cosmetics.js)
// picker.js (D3)
getMyFiltersText() → string
```

## D1 — Lists & engine
- `main/filterlists.js`: registry of built-in lists with ids, names, groups and default state:
  default (on): uBO filters (incl. yearly files), badware, privacy, quick-fixes, unbreak, resource-abuse, EasyList,
  EasyPrivacy, Peter Lowe; dns: HaGeZi Multi NORMAL (on, `recommended`), HaGeZi Pro (off), HaGeZi Pro++ (off);
  annoyances: uBO annoyances (cookies/others), EasyList Cookie (on when `blockCookieBanners` or `liteMode` —
  replaces the standard/full engine-kind split); regional (off): EasyList Germany, Liste FR, EasyList Italy, EasyList
  Spanish, EasyList Dutch, RU AdList, EasyList China, AdGuard Japanese, IndianList, EasyList Polish, Turkish — use
  the URLs from uBO's `assets.json` (fetch `https://ublockorigin.github.io/uAssets/` … or the uBlock repo's
  `assets/assets.json` once at dev time and hard-code the ones you use; verify each URL returns 200).
  Custom lists: user-added http(s) URLs (≤ 20, ≤ 10 MB each).
- Per-list cache in `userData/blocker/lists/<id>.txt` + metadata (fetchedAt, expires from the list's `! Expires:`
  header — default 4 days, quick-fixes 8 h, min 1 h). Refresh only expired lists; one rebuild after a refresh round.
- **Build off the main thread**: `main/engine-worker.js` (Node `worker_threads`, loaded with the library) parses the
  concatenated lists + resources and returns the serialized engine; main deserializes (fast) and swaps. Cache the
  serialized engine (`userData/blocker/engine.bin`) keyed by a hash of enabled list ids + their fetchedAt.
  Startup: load the cache instantly; rebuild in background only if stale. Must not stall the UI.
- Resources (scriptlets library): keep the library's mirrored `resources.json` fetch (it matches the engine's
  format), cache it with the lists.
- `$csp` filters: `onHeadersReceived` for main-frame/sub-frame document responses only (return immediately for
  other resource types) — use the engine's CSP matching (`getCSPDirectives` / see library `onHeadersReceived`).
- `$removeparam`: on matching requests (including main-frame navigations) redirect to the URL with the parameters
  removed (engine's `removeparams` bucket / `match` result — check the library API). Never loop (only redirect
  when the URL actually changed).
- Settings `#filter-lists` section (Visuals adds markup): `#filter-lists-groups` (JS renders groups → `.fl-group` ›
  `.fl-group-title` + `.fl-row[data-id]` › `input.fl-toggle[type=checkbox]`, `.fl-name`, `.fl-meta` (rules · updated
  ago · error), custom rows get `button[data-action="remove-list"]`), `#fl-add-url` input +
  `[data-action="add-list"]`, `[data-action="update-lists"]`, `#fl-status` ("Updated 3 min ago · 412,301 rules" /
  "Building…").

## D2 — Cosmetics (in every frame)
- `preload/blocking-cosmetics.js` (frame preload, ALL http(s) frames incl. iframes): at document start
  `ipcRenderer.sendSync('pure:blocking-scriptlets', ancestors)` → run returned code with `webFrame.executeJavaScript`;
  then request styles asynchronously (base rules for hostname) and inject them **in this frame** by creating a
  `<style>` element (or `document.adoptedStyleSheets`) — not `webContents.insertCSS` (that only reaches the top frame).
- Generic hiding by DOM: after DOMContentLoaded collect classes/ids/hrefs (cap 1,000 each) and ask for matching
  generic rules; then a **throttled** `MutationObserver` (batch new nodes, flush at most every 300 ms via
  `requestIdleCallback`, stop observing when the page has been idle with no new classes for 60 s… restart on next
  mutation burst) → only new classes/ids are sent.
- Procedural/extended filters (`:has-text`, `:upward`, `:xpath`, `:matches-css`, `:min-text-length`, …): use the
  library's extended-selector support (`getExtendedRules: true`, the `@ghostery/adblocker-extended-selectors`
  package is installed) evaluated in the preload, re-run on the same throttled mutation batches.
- `main/cosmetics.js`: IPC handlers with sender checks (http(s) frames only; `blocking.isActiveFor`), using
  `blocking.getEngine()`, ancestors for iframes (`senderFrame.parent` chain hostnames).
- `level() === 'balanced'` → no scriptlets (styles still apply).

## D3 — Element picker & My filters
- Start: page context menu "Block element…" (menus.js, http(s) pages only) and a "Block an element" button in the
  shield popover (`[data-action="pick-element"]`, Visuals adds it) → `pure.blocking.pickElement(tabId, 'pick')`;
  a second "Zap element" (`[data-action="zap-element"]`) → mode 'zap'. Main → the tab's main frame:
  `pure:picker-start {mode, css}` (css = contents of `renderer/assets/picker.css`).
- `preload/picker.js` (frame preload, top frames): on start, draw a full-page overlay inside a **closed shadow root**
  attached to a host element at `document.documentElement` (so page CSS can't touch it); hover highlights the element
  under the cursor; click selects; a small panel offers a generated filter (`host##selector`, built from id/classes/
  tag:nth-of-type — prefer stable classes, avoid generated-looking hashes) with "broader/narrower" controls (walk up
  /down the tree), live preview count ("matches 3 elements"), Create / Cancel; Esc cancels. Zap mode: click removes
  the element immediately, Esc exits. The preload never exposes anything to the page.
- `main/picker.js`: `myfilters:get/set` (internal sender — settings page), `picker:start` (chrome sender), create
  → append to `userData/profile/my-filters.txt` (debounced atomic, `flush()`), validate syntax by parsing with the
  library (`FilterEngine.parse` on the text, report bad lines), then `filterlists.rebuild('my-filters')`; for instant
  effect also apply the new cosmetic rule to the current page right away (`insertCSS` on that frame is fine for the
  top frame).
- Settings `#my-filters` card (Visuals): `textarea#my-filters-input` (monospace), `[data-action="save-my-filters"]`,
  `#my-filters-status` (errors listed with line numbers).

## DOM IDs (scripts/check.js enforces)
Browser: `shield-pick` `shield-zap` (the two shield buttons; also carry `data-action`).
Settings: `filter-lists` `filter-lists-groups` `fl-add-url` `fl-status` `my-filters` `my-filters-input` `my-filters-status`.
