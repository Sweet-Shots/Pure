// Browser UI entry point. Wires the modules to window.pure and boots: layout, tabs, settings,
// bookmarks, downloads. Startup never waits on the welcome animation.

import { S, DEFAULT_SETTINGS, homeUrl } from './state.js';
import { pure } from './util.js';
import { initLayout } from './layout.js';
import { initTabStrip, applyTabList, addTab, updateTab, removeTab, setActiveFromMain, moveTabs, applyVerticalTabs } from './tabs.js';
import { initAddressBar } from './address-bar.js';
import { initSuggestions } from './suggestions.js';
import { initFindBar, onFound } from './findbar.js';
import { initBookmarks, setBookmarks, applyBookmarksBar } from './bookmarks.js';
import { initToolbar, applyIncognitoMode } from './toolbar.js';
import { initShield } from './shield.js';
import { initPasswords } from './passwords.js';
import { initDownloads, setDownloads, updateDownload } from './downloads.js';
import { initStatusBar, applyStatusBar, setHoverUrl } from './statusbar.js';
import { initWindowControls, applyInfo, setMaximized } from './window-controls.js';
import { applyTheme } from './theme.js';
import { startWelcome } from './welcome.js';
import { initKeys, runCommand } from './keys.js';
import { initPalette } from './palette.js';
import { initSiteInfo } from './siteinfo.js';
import { initFocus, applyFocusMode } from './focus.js';
import { initSplit, syncSplitFromTabs } from './split.js';
import { initGroups, setGroups } from './groups.js';
import { initReader } from './reader.js';
import { initExtensions } from './extensions.js';
import { initToasts } from './toast.js'; // 2.4 — E5
// 2.2 — C1 (passwords) and C2 (extensions) each add one import + init line here.

function applySettings(next) {
  S.settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
  applyTheme();
  applyBookmarksBar();
  applyStatusBar();
  applyVerticalTabs(!!S.settings.verticalTabs);
  applyFocusMode();
}

// Subscribe before taking the snapshot, so no event between the two is lost.
function wireMain() {
  pure.tabs.onCreated(addTab);
  pure.tabs.onUpdated(updateTab);
  pure.tabs.onRemoved(removeTab);
  pure.tabs.onActivated(setActiveFromMain);
  pure.tabs.onMoved(moveTabs);
  pure.tabs.onFound(onFound);
  pure.tabs.onHoverUrl(setHoverUrl);
  pure.onCommand(runCommand);
  pure.settings.onChanged(applySettings);
  pure.bookmarks.onChanged(setBookmarks);
  pure.downloads.onUpdated(updateDownload);
  pure.groups.onChanged(setGroups);
  pure.onMaximizedChange(setMaximized);
}

async function boot() {
  initLayout();
  initTabStrip();
  initAddressBar();
  initSuggestions();
  initFindBar();
  initBookmarks();
  initToolbar();
  initShield();
  initPasswords();
  initDownloads();
  initStatusBar();
  initWindowControls();
  initKeys();
  initPalette();
  initSiteInfo();
  initFocus();
  initSplit();
  initGroups();
  initReader();
  initExtensions();
  initToasts(); // 2.4 — E5
  wireMain();

  const [info, settings, tabs, bookmarks, downloads, groups] = await Promise.all([
    pure.getInfo(),
    pure.settings.get(),
    pure.tabs.list(),
    pure.bookmarks.list(),
    pure.downloads.list(),
    pure.groups.list(),
  ]);
  applyInfo(info);
  applySettings(settings);
  applyIncognitoMode();
  // The welcome starts before any tab is created so the new page view never shows over it.
  startWelcome(S.settings.showWelcomeAnimation !== false);
  setBookmarks(bookmarks);
  setDownloads(downloads);
  setGroups(groups);
  applyTabList(tabs);
  syncSplitFromTabs(tabs);
  if (!S.order.length) pure.tabs.create({ url: homeUrl() });
}

boot().catch((err) => console.error('[pure] browser UI failed to start', err));
