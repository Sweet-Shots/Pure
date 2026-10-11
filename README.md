<p align="center">
  <img src="build/icon.png" width="96" alt="Pure">
</p>

<h1 align="center">Pure Browser</h1>
<p align="center"><i>Nothing more. Nothing less.</i></p>

<p align="center">
  <a href="https://github.com/Sweet-Shots/Pure/releases/latest"><b>⬇ Download for Windows</b></a>
</p>

Pure is a minimal, fast Chromium-based browser for Windows. It's built to stay light on CPU and memory and to keep you private.

## Install

1. Open the **[latest release](https://github.com/Sweet-Shots/Pure/releases/latest)**.
2. Download **`Pure-Browser-Setup-<version>.exe`** and run it.
3. That's it. Pure **updates itself**: new versions download in the background and install the next time you close Pure.

> **"Windows protected your PC"?** The installer isn't code-signed yet, so SmartScreen warns about it. Click **More info → Run anyway**.

## Features

- **Purify**, a built-in ad & tracker blocker at uBlock Origin level:
  - blocks YouTube video ads
  - an element picker, your own filters, and a filter-list manager
- **Google sign-in works**, plus saved passwords (encrypted with your Windows account) and secure DNS.
- **Private by default**: automatic HTTPS upgrades, optional clearing of data when Pure closes, per-site settings, and download safety checks.
- **Tabs your way**: pinned tabs, groups, split view, vertical tabs, a command palette (Ctrl+K), tab search, sleeping tabs to save memory, and crash recovery.
- **Reader mode, picture-in-picture, focus mode, screenshots and clean links**, and light and dark themes.
- **A home page you can customize**: news, weather, notes and Continue reading. Or hide it all.
- **Chrome Web Store extensions**: popular ones like Dark Reader, SponsorBlock and Return YouTube Dislike work.
- **Streaming works**: Spotify and other protected music and video play (Widevine).
- **Import** bookmarks, history and passwords from Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, Chromium and Firefox, or from CSV / HTML files.

Found a site Purify breaks? Use **Report a broken site** in the shield, or [open an issue](https://github.com/Sweet-Shots/Pure/issues/new/choose).

Pure is [MIT licensed](LICENSE).

See the full **[changelog](CHANGELOG.md)**.

## Build from source

```bash
npm install
npm start          # run in development
npm run check      # static checks
npm run dist       # build the Windows installer into dist/
```

Built with [Electron](https://www.electronjs.org/).
