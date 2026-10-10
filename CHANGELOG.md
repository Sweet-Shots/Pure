# Pure Browser — Changelog

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
