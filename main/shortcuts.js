// Keyboard shortcuts, per window, handled with before-input-event (keyDown only). Attached to the
// browser UI and to every tab / popup webContents, so shortcuts work while focus is in a page.
// Text-editing keys (Ctrl+A/C/V/X/Z, Ctrl+arrows) and AltGr (Ctrl+Alt) combos are never handled.

const windows = require('./windows');
const logger = require('./logger');

// attach(webContents, win, tabs)
//   win/tabs may be static (UI window) or `resolve` = () => ({ win, tabs }|null) for tabs that can move.
//   tabs = TabManager or null (popup windows: only window-level shortcuts apply).
// Returns a disposer that removes the listener.
function attach(webContents, win, tabs) {
  const resolve = typeof win === 'function' ? win : () => (win ? { win, tabs } : null);
  const onInput = (event, input) => {
    if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return;
    let ctx = null;
    try { ctx = resolve(); } catch { ctx = null; }
    if (!ctx || !ctx.win || ctx.win.isDestroyed()) return;
    let handled = false;
    try {
      handled = handle(webContents, ctx, input);
    } catch (e) {
      logger.log('shortcut failed:', e && e.message);
    }
    if (handled) event.preventDefault();
  };
  webContents.on('before-input-event', onInput);
  return () => {
    try { webContents.removeListener('before-input-event', onInput); } catch { /* destroyed */ }
  };
}

function handle(wc, ctx, input) {
  if (input.meta) return false;
  const key = String(input.key || '').toLowerCase();
  const ctrl = !!input.control;
  const shift = !!input.shift;
  const alt = !!input.alt;

  // AltGr arrives as Ctrl+Alt and produces characters: only the explicit devtools combo is ours.
  if (ctrl && alt) {
    if (shift && key === 'i') return toggleDevTools(ctx.win.webContents);
    return false;
  }

  if (alt) {
    if (ctrl || shift) return false;
    if (key === 'arrowleft') return navigateHistory(ctx, -1);
    if (key === 'arrowright') return navigateHistory(ctx, 1);
    if (key === 'd') return uiCommand(ctx, 'focus-address-bar');
    if (key === 'p') return pictureInPicture(ctx, wc);
    if (/^[1-8]$/.test(key)) return activateIndex(ctx, Number(key) - 1);
    return false;
  }

  if (ctrl) {
    // Zoom keys ignore Shift so Ctrl+Shift+= ("+") still zooms in.
    if (key === '=' || key === '+' || key === 'add') return zoom(ctx, 'in');
    if (key === '-' || key === '_' || key === 'subtract') return zoom(ctx, 'out');
    if (shift) {
      switch (key) {
        case 't': return reopenClosed(ctx);
        case 'n': return newWindow(true);
        case 'r': return reload(ctx, wc, true);
        case 'b': return uiCommand(ctx, 'toggle-bookmarks-bar');
        case 'i': return toggleDevTools(pageOf(ctx, wc));
        case 'tab': return cycle(ctx, -1);
        // 2.2 — UI features; the browser UI performs them.
        case 'a': return uiCommand(ctx, 'tab-search');
        case 'f': return uiCommand(ctx, 'focus-mode');
        case 's': return uiCommand(ctx, 'split-view');
        case 'm': return uiCommand(ctx, 'mute-others');
        // 2.4 — screenshot of the visible area; clean link of the active tab's URL (tools.js does the work).
        case 'x': return screenshot(ctx, 'visible');
        case 'c': return cleanLink(ctx);
        default: return false;
      }
    }
    if (key === '0') return zoom(ctx, 'reset');
    if (/^[1-8]$/.test(key)) return activateIndex(ctx, Number(key) - 1);
    switch (key) {
      case 't': return newTab(ctx);
      case 'w':
      case 'f4': return closeCurrent(ctx);
      case 'n': return newWindow(false);
      case 'l': return uiCommand(ctx, 'focus-address-bar');
      case 'f': return uiCommand(ctx, 'find');
      case 'd': return uiCommand(ctx, 'toggle-bookmark');
      case 'k': return uiCommand(ctx, 'command-palette');
      case 'h': return openHistory(ctx);
      case 'r': return reload(ctx, wc, false);
      case 'f5': return reload(ctx, wc, true);
      case 'p': return print(ctx, wc);
      case 'tab': return cycle(ctx, 1);
      case '9': return ctx.tabs ? ctx.tabs.activateAt(ctx.tabs.count() - 1) : false;
      default: return false;
    }
  }

  if (!shift) {
    switch (key) {
      case 'f5': return reload(ctx, wc, false);
      case 'f6': return uiCommand(ctx, 'focus-address-bar');
      case 'f9': return uiCommand(ctx, 'reader-mode');
      case 'f11': return toggleFullscreen(ctx);
      case 'f12': return toggleDevTools(pageOf(ctx, wc));
      case 'escape': return escape(ctx, wc);
      default: return false;
    }
  }
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────────

// The UI window (not a popup) is the only target of ui:command.
function uiCommand(ctx, name, arg) {
  if (!windows.getState(ctx.win)) return false;
  // These put the caret in the browser UI, so the UI webContents needs real keyboard focus.
  if (['focus-address-bar', 'find', 'command-palette', 'tab-search'].includes(name)) ctx.win.webContents.focus();
  ctx.win.webContents.send('ui:command', name, arg === undefined ? null : arg);
  return true;
}

function pageOf(ctx, wc) {
  if (ctx.tabs) return ctx.tabs.activeWebContents();
  return wc && !wc.isDestroyed() ? wc : null;
}

function toggleDevTools(page) {
  if (!page || page.isDestroyed()) return false;
  if (page.isDevToolsOpened()) page.closeDevTools();
  else page.openDevTools({ mode: 'detach' });
  return true;
}

function reload(ctx, wc, hard) {
  if (ctx.tabs) {
    if (ctx.tabs.activeId) ctx.tabs.reload(ctx.tabs.activeId, hard);
    return true;
  }
  const p = pageOf(ctx, wc);
  if (!p) return false;
  if (hard) p.reloadIgnoringCache();
  else p.reload();
  return true;
}

// Esc: the UI decides what to close (find bar, suggestions) and stops loading if nothing is open.
// Pages keep the key too, so their own Esc handling (e.g. exiting fullscreen) still works.
function escape(ctx, wc) {
  if (!ctx.tabs) return false;
  const fromUi = wc === ctx.win.webContents;
  uiCommand(ctx, 'escape');
  return fromUi;
}

function newTab(ctx) {
  if (ctx.tabs) {
    ctx.tabs.createTab({ active: true });
    uiCommand(ctx, 'focus-address-bar');
    return true;
  }
  windows.createWindow({});
  return true;
}

function closeCurrent(ctx) {
  if (ctx.tabs) {
    if (ctx.tabs.activeId) ctx.tabs.closeTab(ctx.tabs.activeId);
    return true;
  }
  if (!ctx.win.isDestroyed()) ctx.win.close();
  return true;
}

function reopenClosed(ctx) {
  if (!ctx.tabs) return false;
  ctx.tabs.reopenClosed();
  return true;
}

function newWindow(incognito) {
  windows.createWindow({ incognito });
  return true;
}

function openHistory(ctx) {
  if (!ctx.tabs) return false;
  ctx.tabs.openSettings('history', true);
  return true;
}

function print(ctx, wc) {
  const p = pageOf(ctx, wc);
  if (!p) return false;
  p.print();
  return true;
}

// Alt+P: picture-in-picture for the largest video of the active page (popups: their own page).
// Lazy require: menus.js is only needed here and on context menus.
function pictureInPicture(ctx, wc) {
  const page = pageOf(ctx, wc);
  if (!page || page.isDestroyed()) return false;
  require('./menus').togglePictureInPicture(page, null);
  return true;
}

// Ctrl+Shift+X / Ctrl+Shift+C act on the window's active tab. Lazy require: tools.js is only needed here
// and on the page context menu.
function screenshot(ctx, mode) {
  if (!ctx.tabs || !ctx.tabs.activeId) return false;
  require('./tools').takeScreenshot(ctx.tabs, ctx.tabs.activeId, mode);
  return true;
}

function cleanLink(ctx) {
  if (!ctx.tabs || !ctx.tabs.activeId) return false;
  require('./tools').copyCleanLinkForTab(ctx.tabs, ctx.tabs.activeId);
  return true;
}

function zoom(ctx, dir) {
  if (!ctx.tabs) return false;
  ctx.tabs.zoomActive(dir);
  return true;
}

function activateIndex(ctx, index) {
  if (!ctx.tabs) return false;
  return ctx.tabs.activateAt(index);
}

function cycle(ctx, dir) {
  if (!ctx.tabs) return false;
  ctx.tabs.cycle(dir);
  return true;
}

function navigateHistory(ctx, dir) {
  if (!ctx.tabs || !ctx.tabs.activeId) return false;
  if (dir < 0) ctx.tabs.back(ctx.tabs.activeId);
  else ctx.tabs.forward(ctx.tabs.activeId);
  return true;
}

function toggleFullscreen(ctx) {
  if (ctx.win.isDestroyed()) return false;
  ctx.win.setFullScreen(!ctx.win.isFullScreen());
  return true;
}

module.exports.attach = attach;
