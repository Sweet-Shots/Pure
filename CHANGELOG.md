# Pure Browser — Changelog

## 2.4.0

### Streaming
- **Spotify, Netflix, Disney+ and other protected streams can play.** Pure now ships with Widevine, the DRM module those sites need, by using castLabs' Widevine-enabled build of Electron. It loads only when a page asks for it.

### Import
- **More browsers**: Opera, Opera GX, Vivaldi, Chromium and Firefox, alongside Chrome, Edge and Brave. Every profile of a browser can be picked, not just the default one.
- **Passwords**: imported from Chromium-based browsers. Chrome locks newer passwords so only Chrome can read them; Pure counts those and explains how to bring them over with Chrome's Export.
- **Password files**: import CSV exports from Chrome, Edge, Firefox, Bitwarden, 1Password, LastPass and others (Settings › Import or Settings › Passwords).
- **Bookmark files**: import and export bookmarks as an HTML file, the format every browser reads.
- Importing twice adds no duplicates. Signed-in sessions aren't imported; since your passwords come across, signing back in is one click.

### Passwords
- **Strong password generator**: on sign-up and change-password forms, Pure offers "Use a strong password", fills it in and offers to save it.
- **Works inside embedded frames**: saving, filling and the generator now also work in login forms embedded from other sites.

### Bookmarks
- **Sort the bookmarks bar**: Manual, Name, Newest, Oldest or Site.
- **Drag to reorder** in Manual mode, or press Alt+↑/↓ on a focused bookmark. Arrow keys move between bookmarks.

### Tabs & windows
- **Type right away**: new tabs, new windows and startup put the cursor in the address bar. Turn it off in Settings › Appearance.
- **Tab drag preview**: dragging a tab out of the strip shows a live preview following the cursor.
- **No startup animation** on windows made by dragging a tab out.

### Purify
- **Hides ads inside embedded frames too**, not just on the main page.

### Settings
- **Centered pages** at every window width.
- **Redesigned Import page** with every browser, profile picker, and file import/export.

### Known limitations
- **Netflix and some other services** may refuse playback until Pure's build is signed by castLabs (a one-time setup on the release side). Spotify's DRM check passes.
- **Security updates**: the Widevine build of Electron is 44.5.1, slightly behind the newest 44.7.0. Pure will move to newer builds as castLabs releases them.
- **Firefox passwords** aren't read directly; export a CSV from Firefox (about:logins › ⋯ › Export) and import it.

## 2.3.0

### Extensions
- **Many more Chrome extensions work.** Pure now provides the Chrome extension features Electron leaves out:
  - toolbar badges, icon changes and clicks on toolbar buttons
  - right-click menu items from extensions
  - notifications
  - tab and window control (open, switch, close, pin, duplicate, and the matching events)
  - cookies, alarms, sync storage, permissions and navigation events
- **Tested with real extensions**: Dark Reader, SponsorBlock and Return YouTube Dislike work. Bitwarden's popup and OneTab's toolbar button work.
- **Extension pages can open in tabs** (options pages, tab managers).
- **Settings › Extensions** shows what each extension can access, and warns when one uses a feature Pure doesn't support yet.

### Tabs
- **Pinned tabs**: right-click a tab › Pin tab. Pinned tabs are icon-only, stay at the start of the strip and always reopen when Pure starts.
- **Crash recovery**: if Pure didn't close properly, it offers to restore your tabs.

### Privacy & security
- **HTTPS upgrades** (on by default): Pure tries the secure version of a site first and falls back silently when a site has none. **HTTPS-only** mode warns before every insecure site instead.
- **Clear data when Pure closes**: choose history, cookies, cache and/or the download list (Settings › Privacy).
- **Site settings**: every site with its own permissions or Purify settings in one place, with search and reset.
- **Safer downloads**:
  - downloaded files carry Windows' "from the internet" mark, so SmartScreen checks them when opened
  - Pure asks before keeping script and shortcut files, and programs downloaded over insecure connections
  - "Open when done" for downloads in progress

### Purify
- **Per-site level**: switch a site between Full and Balanced from the shield.
- **Report a broken site**: one click in the shield opens a pre-filled GitHub issue. Only the site name, Pure version and level are included, and you review and submit it yourself.

### Tools
- **Screenshots (Ctrl+Shift+X)**: the visible area or the full page, saved to Pictures › Pure Screenshots and copied to the clipboard. Also in the right-click menu and the command palette.
- **Copy clean link (Ctrl+Shift+C)**: copies the page address without tracking parameters (utm, fbclid, gclid, si…). Right-click a link for the same.
- **Notification bar** for screenshots, copied links, crash recovery and download warnings.
- **Command palette**: new actions for screenshots, clean links, pin/unpin, site settings and reporting a broken site.

### Fixes
- **Incognito**: the Purify popup no longer links to the all-time stats, which come from normal browsing.

### Project
- **MIT license**, plus GitHub issue forms for bugs, broken sites and feature ideas.

### Known limitations
- **HTTPS-only redirects**: a site whose secure address redirects back to its insecure one still loads insecurely, even in HTTPS-only mode.
- **Extensions not supported yet**: side panels, the downloads, history and bookmarks APIs, and `webRequest`-style blocking. Extension alarms don't persist across restarts.
- **Full-page screenshots** capture the page's main scroll only, up to 16,384 px tall.

## 2.2.1

Everything since the 2.0.0 installer.

### Purify — the new ad & tracker blocker
- **Purify**: Pure's built-in ad and tracker blocker, now with its own name in the shield, Settings and the home page.
- **uBlock Origin-level blocking**: lists come straight from uBlock Origin's servers, including the 2025 and 2026 filter files, and refresh every 8 hours.
- **YouTube video ads are blocked** and the player stays reliable.
- **HaGeZi DNS blocklist** (Multi NORMAL) is on by default and blocks app, phone and analytics telemetry too.
- **Ad-blocker test score**: 126 of 132 checks blocked (95%), up from 88 of 132.
- **Blocking level**: Full (recommended) or Balanced. Balanced skips the in-page ad scripts, as a fallback if a site misbehaves.
- **Filter list manager** (Settings › Privacy):
  - turn built-in, DNS, annoyance and regional lists on or off
  - add your own list URLs, then use "Update now"
  - see rule counts and when each list was last updated
- **Element picker**: "Block element…" on right-click, or "Block an element" in the shield. Hover, click, adjust the rule, then Create.
- **Zap element**: removes something from the page you're viewing, just for now.
- **My filters**: write your own rules in uBlock Origin syntax, with error checking line by line.
- **Hides ads inside embedded frames and ads that appear after the page loads**, such as feeds and infinite scroll.
- **Tracking parameters stripped from links** (`$removeparam`), and filter-list security rules for pages (`$csp`).
- **Hide cookie banners** (on by default).
- **Shield popup**: a per-site on/off switch, the domains blocked on the page, and a link to lifetime stats.
- **Purify Stats**: blocked today, this week and all time, estimated data saved, a 30-day chart, top blocked domains and the sites you've excepted.
- **Fix**: blockers that retry instantly (such as CNN's) no longer burn CPU.
- **Fix**: blocked background requests no longer cause errors (this broke YouTube's player).

### Browsing
- **Command palette (Ctrl+K)**: search open tabs, history, bookmarks, settings and actions in one box.
- **Tab search (Ctrl+Shift+A).**
- **Split view (Ctrl+Shift+S)**: two tabs side by side with a draggable divider.
- **Tab groups**: named, colored and collapsible. Right-click a tab to add it to a group.
- **Vertical tabs**, an option in Appearance.
- **Focus mode (Ctrl+Shift+F)**: hides the toolbar and tabs; move the mouse to the top to bring them back.
- **Reader mode (F9 or the book icon)**: articles in a clean, adjustable view.
- **Picture-in-picture**: right-click a video, or press Alt+P.
- **Mute other tabs (Ctrl+Shift+M).**
- **Site info panel**: click the padlock for connection status, permissions, cookies, blocked count, zoom and "Clear site data".
- **The + (new tab) button sits right after the last tab.**
- **The active tab no longer has an accent bar underneath.**

### Accounts & security
- **Google sign-in works.** Google no longer shows "This browser or app may not be secure".
- **Password saving and autofill**: passwords are encrypted with your Windows account and only filled on the exact site they were saved for. Pure never saves passwords in incognito. You can manage them in Settings › Passwords.
- **Secure DNS (DNS-over-HTTPS)**: Off, Automatic or Secure, with Cloudflare, Google, Quad9, NextDNS or a custom provider.
- **Auto-updates** through GitHub Releases. They're ready to switch on once a release repository is set up.

### Extensions
- **Chrome Web Store installs**, plus "Load unpacked" for local extensions.
- **Toolbar buttons and popups** for extensions.
- **Enable, disable and remove** in Settings › Extensions.
- **Limits**: most simple extensions work, but complex ones may be partly broken. Extensions never run in incognito.

### Home page
- **New layout**: PURE in the top-left, Customize in the top-right, and the greeting centered above the search bar. The version number sits bottom-left and the usage line ("162 MB · 0 sleeping · 41 purified today") sits bottom-right.
- **Widget board** you can customize: drag, hide and show widgets.
  - Daily brief news with topic chips, a choice of sources, and a "Show news images" toggle.
  - Weather and time, with a 3-day forecast.
  - Continue reading.
  - Notes.
- **Classic mode**: hide every widget for the minimal 1.1.1-style page.
- **Real icons** throughout, from the Lucide icon set.
- **Incognito** is fully red (accents, the PURE glow and "Purely Hidden.") and loads nothing in the background.

### Appearance
- **Light theme**, plus "Follow Windows". Pure's pages and websites switch together.
- **Dark mode for websites**: an optional setting; it takes effect after a restart.

### Performance
- **Memory panel** (Settings › Performance): each tab's RAM and CPU, with "Sleep" and "Sleep inactive tabs".
- **Smart sleep**: tabs sleep sooner on battery, in minimized windows, or when memory runs low.
- **Lite mode**: blocks annoyances, reduces animations and sleeps tabs after 3 minutes.
- **Idle home page**: about 0.3–0.8% CPU. The old 1.1.1 home page used 77%.

### Import
- **Import from Chrome, Edge, Brave and Pure 1.1.1**: bookmarks, history and, for 1.1.1, your settings and quick links.

### Fixes
- **Reader button** now shows reliably when moving between articles.
- **Only one popup open at a time**: the palette, site info, shield and group editor close each other.
- **Tab groups and split view** are kept across restarts.
- **Keyboard focus** no longer gets stuck on a hidden tab after opening a new one.
- **Smaller fixes**:
  - long History URLs no longer overflow
  - "Camera and microphone" is no longer capitalized word by word
  - the clipped palette focus outline is fixed
  - the picker panel font is fixed
  - the filter-list status no longer says "Not built yet"

### Known limitations
- **Busy sites**: on very busy sites (e.g. CNN), Purify's in-page hiding uses more CPU than having it off, though memory use is much lower.
- **Unsigned installer**: Windows SmartScreen will warn on first install until the app is code-signed.
- **Extensions**: the deeper Chrome-extension features are planned for a later release.
