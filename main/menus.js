// Native context menus: the page menu (link / image / media / selection / editable / page)
// and the tab-strip menu. Pure UI builders: they call back into the window through `actions`.
'use strict';

const { BrowserWindow, Menu, clipboard } = require('electron');
const { ownerWindow } = require('./permissions');

const SEARCH_ENGINES = [
  ['duckduckgo', 'DuckDuckGo'],
  ['google', 'Google'],
  ['bing', 'Bing'],
  ['brave', 'Brave'],
  ['startpage', 'Startpage'],
  ['ecosia', 'Ecosia'],
];

const SEP = { type: 'separator' };

function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (err) {
    try { require('./logger').log('menus: action failed', err && err.message); } catch { /* ignore */ }
  }
}

function safeAction(actions, name) {
  return (...args) => safeCall(actions && actions[name], ...args);
}

// Menu labels: '&' is a mnemonic marker on Windows, so escape user-derived text.
function esc(text) {
  return String(text).replace(/&/g, '&&');
}

function parseUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

function isWebUrl(raw) {
  const u = parseUrl(raw);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

// Image/media/download targets: web or data URLs only (no pure://, file://, about:).
function isDownloadableUrl(raw) {
  const u = parseUrl(raw);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'data:');
}

function item(label, click, opts = {}) {
  const out = {
    label: esc(label),
    enabled: opts.enabled !== false,
    click: () => click(),
  };
  if (opts.accelerator) {
    out.accelerator = opts.accelerator;
    out.registerAccelerator = false; // display only; the shortcut map lives in shortcuts.js
  }
  return out;
}

function engineName(searchPrefix) {
  let host = '';
  try { host = new URL(searchPrefix || '').hostname.toLowerCase(); } catch { host = ''; }
  for (const [key, name] of SEARCH_ENGINES) {
    if (host.includes(key)) return name;
  }
  return host.replace(/^www\./, '') || 'the web';
}

function currentSearchPrefix() {
  try { return require('./storage').settings.get().searchEngine || ''; } catch { return ''; }
}

// Drop separators at the edges and doubled separators.
function tidy(list) {
  const out = [];
  for (const it of list) {
    if (it.type === 'separator') {
      if (!out.length || out[out.length - 1].type === 'separator') continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

// Position of the page view inside its window, so params.x/y (relative to the page) map to screen.
function viewOrigin(win, webContents) {
  try {
    for (const v of win.contentView.children) {
      if (v.webContents === webContents) {
        const b = v.getBounds();
        return { x: b.x, y: b.y };
      }
    }
  } catch { /* fall through */ }
  return { x: 0, y: 0 };
}

function popupAt(win, template, point) {
  const menu = Menu.buildFromTemplate(tidy(template));
  const options = { window: win || undefined };
  if (point) {
    options.x = Math.round(point.x);
    options.y = Math.round(point.y);
  }
  menu.popup(options);
}

// ── Page context menu ─────────────────────────────────────────────────────────

function linkItems(p, actions) {
  const link = p.linkURL || '';
  if (!link) return [];
  const web = isWebUrl(link);
  return [
    item('Open link in new tab', () => safeCall(actions.openInNewTab, link), { enabled: web }),
    item('Open link in new window', () => safeCall(actions.openInNewWindow, link), { enabled: web }),
    item('Open link in incognito window', () => safeCall(actions.openInIncognito, link), { enabled: web }),
    SEP,
    item('Copy link address', () => clipboard.writeText(link)),
  ];
}

function imageItems(p, actions, webContents) {
  const src = p.srcURL || '';
  if (p.mediaType !== 'image' || !src) return [];
  return [
    item('Open image in new tab', () => safeCall(actions.openInNewTab, src), { enabled: isWebUrl(src) }),
    item('Save image as…', () => webContents.downloadURL(src), { enabled: isDownloadableUrl(src) }),
    item('Copy image', () => webContents.copyImageAt(p.x, p.y)),
    item('Copy image address', () => clipboard.writeText(src)),
  ];
}

// ── Picture-in-picture ────────────────────────────────────────────────────────

// Script run in the page. point = {x, y} (page coordinates of a right-click on a video) or null for
// Alt+P (the largest playing video, else the largest video with metadata). A page already showing a
// picture-in-picture window exits it. The script never throws: a page without a usable video is left alone.
function pipScript(point) {
  const pick = point
    ? `const x = ${Math.round(Number(point.x)) || 0}, y = ${Math.round(Number(point.y)) || 0};
    const hits = document.elementsFromPoint(x, y) || [];
    video = hits.find((el) => el && el.tagName === 'VIDEO') || null;`
    : `let bestScore = -1;
    for (const v of document.querySelectorAll('video')) {
      if (v.readyState < 1) continue;
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      const score = (v.paused || v.ended ? 0 : 1e12) + area;
      if (score > bestScore) { bestScore = score; video = v; }
    }`;
  return `(() => {
    try {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
        return true;
      }
      if (!document.pictureInPictureEnabled) return false;
      let video = null;
      ${pick}
      if (!video || video.disablePictureInPicture || video.readyState < 1) return false;
      video.requestPictureInPicture().catch(() => {});
      return true;
    } catch (e) {
      return false;
    }
  })()`;
}

// Toggles picture-in-picture in a page. Needs a user gesture (the second argument) for requestPictureInPicture.
function togglePictureInPicture(webContents, point = null) {
  if (!webContents || webContents.isDestroyed()) return;
  try {
    webContents.executeJavaScript(pipScript(point), true).catch(() => {});
  } catch {
    // the page went away between the check and the call
  }
}

function mediaItems(p, webContents) {
  const out = [];
  if (p.mediaType === 'video') {
    const pipAllowed = !(p.mediaFlags && p.mediaFlags.canShowPictureInPicture === false);
    out.push(item('Picture in picture', () => togglePictureInPicture(webContents, { x: p.x, y: p.y }), {
      enabled: pipAllowed,
    }));
  }
  const src = p.srcURL || '';
  if ((p.mediaType !== 'video' && p.mediaType !== 'audio') || !src) return out;
  const kind = p.mediaType === 'video' ? 'video' : 'audio';
  if (out.length) out.push(SEP);
  out.push(
    item(`Save ${kind} as…`, () => webContents.downloadURL(src), { enabled: isDownloadableUrl(src) }),
    item(`Copy ${kind} address`, () => clipboard.writeText(src)),
  );
  return out;
}

function selectionItems(p, actions, webContents) {
  const text = String(p.selectionText || '').trim();
  if (!text) return [];
  const flags = p.editFlags || {};
  const snippet = text.length > 30 ? text.slice(0, 30) + '…' : text;
  const out = [];
  if (!p.isEditable) {
    out.push(item('Copy', () => webContents.copy(), { enabled: flags.canCopy !== false, accelerator: 'Ctrl+C' }));
  }
  out.push(item(
    `Search ${engineName(currentSearchPrefix())} for "${snippet}"`,
    () => safeCall(actions.searchFor, text),
  ));
  return out;
}

function editableItems(p, webContents) {
  const flags = p.editFlags || {};
  const out = [];
  if (p.misspelledWord) {
    const suggestions = Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions.slice(0, 5) : [];
    if (suggestions.length) {
      for (const s of suggestions) {
        out.push(item(s, () => webContents.replaceMisspelling(s)));
      }
    } else {
      out.push(item('No spelling suggestions', () => {}, { enabled: false }));
    }
    out.push(item(`Add “${p.misspelledWord}” to dictionary`, () => {
      webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord);
    }));
    out.push(SEP);
  }
  out.push(
    item('Undo', () => webContents.undo(), { enabled: !!flags.canUndo, accelerator: 'Ctrl+Z' }),
    item('Redo', () => webContents.redo(), { enabled: !!flags.canRedo, accelerator: 'Ctrl+Y' }),
    SEP,
    item('Cut', () => webContents.cut(), { enabled: !!flags.canCut, accelerator: 'Ctrl+X' }),
    item('Copy', () => webContents.copy(), { enabled: !!flags.canCopy, accelerator: 'Ctrl+C' }),
    item('Paste', () => webContents.paste(), { enabled: !!flags.canPaste, accelerator: 'Ctrl+V' }),
    item('Paste as plain text', () => webContents.pasteAndMatchStyle(), {
      enabled: !!flags.canPaste, accelerator: 'Ctrl+Shift+V',
    }),
    SEP,
    item('Select all', () => webContents.selectAll(), { enabled: flags.canSelectAll !== false, accelerator: 'Ctrl+A' }),
  );
  return out;
}

function pageNavItems(webContents) {
  const history = webContents.navigationHistory;
  const canBack = !!history && history.canGoBack();
  const canForward = !!history && history.canGoForward();
  return [
    item('Back', () => history.goBack(), { enabled: canBack, accelerator: 'Alt+Left' }),
    item('Forward', () => history.goForward(), { enabled: canForward, accelerator: 'Alt+Right' }),
    item('Reload', () => webContents.reload(), { accelerator: 'Ctrl+R' }),
  ];
}

function pageItems(p, actions, webContents) {
  const url = p.pageURL || webContents.getURL();
  const web = isWebUrl(url);
  return [
    item('Save page as…', () => webContents.downloadURL(url), { enabled: web || (parseUrl(url) || {}).protocol === 'file:' }),
    item('Print…', () => webContents.print(), { accelerator: 'Ctrl+P' }),
    item('View page source', () => safeCall(actions.openInNewTab, 'view-source:' + url), { enabled: web }),
    SEP,
    item('Bookmark this page', () => safeCall(actions.bookmarkPage), { enabled: web, accelerator: 'Ctrl+D' }),
  ];
}

// 2.4: other modules add page context-menu items. mod.contextMenuItems(params, webContents) -> MenuItem templates.
function hookItems(name, p, webContents) {
  try {
    const mod = require(`./${name}`);
    const items = mod && typeof mod.contextMenuItems === 'function' ? mod.contextMenuItems(p, webContents) : [];
    return Array.isArray(items) ? items : [];
  } catch (err) {
    if (!err || err.code !== 'MODULE_NOT_FOUND') require('./logger').log(`[menus] ${name} items failed:`, err && err.message);
    return [];
  }
}

// params: Electron's ContextMenuParams for the page (x/y are relative to the page view).
function showPageContextMenu({ win, webContents, params, actions = {} }) {
  if (!webContents || webContents.isDestroyed()) return;
  const p = params || {};
  const acts = {
    openInNewTab: actions.openInNewTab,
    openInNewWindow: actions.openInNewWindow,
    openInIncognito: actions.openInIncognito,
    searchFor: actions.searchFor,
    bookmarkPage: actions.bookmarkPage,
  };
  const owner = win && !win.isDestroyed() ? win : ownerWindow(webContents);

  const contextual = [
    linkItems(p, acts),
    imageItems(p, acts, webContents),
    mediaItems(p, webContents),
    selectionItems(p, acts, webContents),
    p.isEditable ? editableItems(p, webContents) : [],
  ].filter((g) => g.length);

  const groups = [
    ...(contextual.length ? contextual : [pageNavItems(webContents), pageItems(p, acts, webContents)]),
    blockElementItems(p, webContents),
    hookItems('tools', p, webContents),         // 2.4 (manager hook): screenshot, copy clean link — main/tools.js
    hookItems('extension-api', p, webContents), // 2.4 (manager hook): chrome.contextMenus items — main/extension-api.js
  ].filter((g) => g.length);

  const template = [];
  for (const g of groups) {
    if (template.length) template.push(SEP);
    template.push(...g);
  }
  template.push(SEP, {
    label: 'Inspect',
    accelerator: 'Ctrl+Shift+I',
    registerAccelerator: false,
    click: () => safeCall(actions.inspect, p.x, p.y),
  });

  const origin = owner ? viewOrigin(owner, webContents) : { x: 0, y: 0 };
  popupAt(owner, template, { x: origin.x + (p.x || 0), y: origin.y + (p.y || 0) });
}

// ── Element picker (2.3) ──────────────────────────────────────────────────────

// "Block element…" on http(s) pages. Starts the picker (main/picker.js) on this page's top frame.
function blockElementItems(p, webContents) {
  const url = p.pageURL || webContents.getURL();
  if (!isWebUrl(url)) return [];
  return [item('Block element…', () => {
    try {
      require('./picker').startPicker(webContents, 'pick');
    } catch (err) {
      require('./logger').log('menus: block element failed', err && err.message);
    }
  })];
}

// ── Tab strip context menu ────────────────────────────────────────────────────

function colorName(color) {
  const c = typeof color === 'string' && color ? color : 'grey';
  return c.charAt(0).toUpperCase() + c.slice(1);
}

// "Add tab to group" submenu: this window's groups, by title (or colour name when untitled).
// Pinned tabs can't join a group, so the whole submenu is disabled for them.
function groupPicker(tab, groups, actions) {
  const list = Array.isArray(groups) ? groups : [];
  const pinned = !!(tab && tab.pinned);
  const children = list.map((g) => {
    const name = g.title ? `${g.title} (${colorName(g.color)})` : colorName(g.color);
    return item(name, () => safeCall(actions && actions.addToGroup, g.id), {
      enabled: !pinned && !(tab && tab.groupId === g.id),
    });
  });
  if (!children.length) children.push(item('No groups yet', () => {}, { enabled: false }));
  return { label: esc('Add tab to group'), submenu: children, enabled: !pinned };
}

// tab: TabState (with groupId, pinned and split); actions: togglePin, newTab, reload, duplicate, toggleMute,
// close, closeOthers, closeToRight, reopenClosed, newGroup, addToGroup(groupId), removeFromGroup, openSplit,
// closeSplit, muteOthers (see ARCHITECTURE.md). groups: this window's Group[]; splitOn: a split exists.
function showTabContextMenu({ win, tab, actions = {}, groups = [], splitOn = false }) {
  const owner = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
  const grouped = !!(tab && tab.groupId);
  const pinned = !!(tab && tab.pinned);
  const template = [
    item(pinned ? 'Unpin tab' : 'Pin tab', safeAction(actions, 'togglePin')),
    SEP,
    item('New tab', safeAction(actions, 'newTab'), { accelerator: 'Ctrl+T' }),
    item('Reload', safeAction(actions, 'reload'), { accelerator: 'Ctrl+R' }),
    item('Duplicate', safeAction(actions, 'duplicate')),
    item(tab && tab.isMuted ? 'Unmute site' : 'Mute site', safeAction(actions, 'toggleMute')),
    SEP,
    item('Close tab', safeAction(actions, 'close'), { accelerator: 'Ctrl+W' }),
    item('Close other tabs', safeAction(actions, 'closeOthers')),
    item('Close tabs to the right', safeAction(actions, 'closeToRight')),
    SEP,
    item('Reopen closed tab', safeAction(actions, 'reopenClosed'), { accelerator: 'Ctrl+Shift+T' }),
    SEP,
    item('Add tab to new group', safeAction(actions, 'newGroup'), { enabled: !pinned }),
    groupPicker(tab, groups, actions),
    ...(grouped ? [item('Remove from group', safeAction(actions, 'removeFromGroup'))] : []),
    SEP,
    splitOn
      ? item('Close split view', safeAction(actions, 'closeSplit'))
      : item('Open in split view', safeAction(actions, 'openSplit'), { enabled: !pinned }),
    item('Mute other tabs', safeAction(actions, 'muteOthers')),
  ];
  popupAt(owner, template, null);
}

module.exports = { showPageContextMenu, showTabContextMenu, togglePictureInPicture };
