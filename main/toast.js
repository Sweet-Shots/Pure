'use strict';
// Toasts (2.4, E5): one small notification bar per browser window, drawn by the browser UI in #toast-host.
// main owns the list; the UI only renders what main sends and reports button presses back.
//
//   show(win, toast, onAction) -> bool
//     toast    = { id, text, kind?: 'info'|'warn'|'error', actions?: [{id, label}] (max 3), timeoutMs? }
//                same id again = replace in place (timer restarts, the new onAction replaces the old one)
//                timeoutMs: 0 = sticky; default 6000 ms without actions, sticky with actions
//     onAction = fn(actionId), called AFTER the toast is hidden, so the callback may show a toast with the
//                same id again. actionId is one of the toast's action ids, or 'dismiss' when the user closed
//                it, its timer ran out, the window closed, or the max-3 limit pushed it out.
//   hide(win, id)   -> hides a toast without calling onAction (the caller already knows the outcome)
//   has(win, id)    -> bool
//
// At most MAX toasts per window; when a new one would exceed it, the oldest info toast goes first.
// Timers exist only while a toast is shown. Text is plain text (the UI uses textContent).

const { BrowserWindow, ipcMain } = require('electron');
const security = require('./security');
const logger = require('./logger');

const MAX = 3;
const HARD_MAX = 6; // toasts with actions may go past MAX up to this
const DEFAULT_MS = 6000;
const MAX_MS = 60000;
const MAX_TEXT = 300;
const MAX_ID = 64;
const KINDS = new Set(['info', 'warn', 'error']);
const RESERVED_ACTION = 'dismiss';

// BrowserWindow -> { list: [entry], flushPending: bool }. Entry removed when its window closes.
const windows = new Map();

function alive(win) {
  return !!win && !win.isDestroyed() && !!win.webContents && !win.webContents.isDestroyed();
}

// Checks and bounds every field; returns null when the toast cannot be shown at all.
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const id = raw.id.slice(0, MAX_ID);
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '';
  if (!text) return null;
  const kind = KINDS.has(raw.kind) ? raw.kind : 'info';
  const actions = [];
  if (Array.isArray(raw.actions)) {
    for (const a of raw.actions) {
      if (actions.length >= 3) break;
      if (!a || typeof a !== 'object') continue;
      const aid = typeof a.id === 'string' ? a.id.slice(0, 32) : '';
      const label = typeof a.label === 'string' ? a.label.slice(0, 40) : '';
      if (!aid || !label || aid === RESERVED_ACTION || actions.some((x) => x.id === aid)) continue;
      actions.push({ id: aid, label });
    }
  }
  let timeoutMs;
  if (Number.isInteger(raw.timeoutMs) && raw.timeoutMs >= 0) timeoutMs = Math.min(raw.timeoutMs, MAX_MS);
  else timeoutMs = actions.length ? 0 : DEFAULT_MS;
  return { id, text, kind, actions, timeoutMs };
}

function stateOf(win) {
  let st = windows.get(win);
  if (st) return st;
  st = { list: [], flushPending: false };
  windows.set(win, st);
  // Closing the window ends its toasts. Their callbacks hear 'dismiss' (the owner decides what that means).
  win.once('closed', () => {
    const gone = windows.get(win);
    windows.delete(win);
    if (!gone) return;
    for (const e of gone.list) {
      clearTimer(e);
      callAction(e, RESERVED_ACTION);
    }
  });
  return st;
}

function payloadOf(e) {
  return {
    id: e.id,
    text: e.text,
    kind: e.kind,
    actions: e.actions.map((a) => ({ id: a.id, label: a.label })),
    timeoutMs: e.timeoutMs,
  };
}

// Sends one entry to the UI. While the UI page is still loading, everything waits for did-finish-load,
// when the whole list is sent in order (the UI's listeners are registered before that event).
function sendShow(win, st, e) {
  if (!alive(win)) return;
  const wc = win.webContents;
  if (wc.isLoading()) {
    if (!st.flushPending) {
      st.flushPending = true;
      wc.once('did-finish-load', () => {
        st.flushPending = false;
        if (!alive(win)) return;
        for (const x of st.list) wc.send('toast:show', payloadOf(x));
      });
    }
    return;
  }
  wc.send('toast:show', payloadOf(e));
}

function sendHide(win, id) {
  if (!alive(win)) return;
  const wc = win.webContents;
  if (wc.isLoading()) return; // nothing was sent yet (the flush above sends the current list only)
  wc.send('toast:hide', id);
}

function armTimer(win, st, e) {
  clearTimer(e);
  if (!(e.timeoutMs > 0)) return;
  e.timer = setTimeout(() => {
    e.timer = null;
    if (removeEntry(win, st, e)) callAction(e, RESERVED_ACTION);
  }, e.timeoutMs);
  if (e.timer && typeof e.timer.unref === 'function') e.timer.unref();
}

function clearTimer(e) {
  if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
}

// Takes an entry out of the list, stops its timer and tells the UI. -> true when it was listed.
function removeEntry(win, st, e) {
  const i = st.list.indexOf(e);
  if (i < 0) return false;
  st.list.splice(i, 1);
  clearTimer(e);
  sendHide(win, e.id);
  return true;
}

function callAction(e, actionId) {
  const fn = e.onAction;
  e.onAction = null;
  if (typeof fn !== 'function') return;
  try {
    fn(actionId);
  } catch (err) {
    logger.log('[toast] action handler failed:', err && err.message);
  }
}

function show(win, toast, onAction) {
  if (!alive(win)) return false;
  const t = clean(toast);
  if (!t) return false;
  const st = stateOf(win);
  const handler = typeof onAction === 'function' ? onAction : null;

  const same = st.list.find((x) => x.id === t.id);
  if (same) {
    // Replace in place. The old callback is not called: the caller replaced the toast on purpose.
    Object.assign(same, t, { onAction: handler });
    armTimer(win, st, same);
    sendShow(win, st, same);
    return true;
  }

  // Over the limit: the oldest toast without actions goes first. Toasts that wait for an answer (a crash
  // restore offer, a held risky download) are never pushed out while there is room up to HARD_MAX, because
  // their dismiss means "discard".
  let victim = null;
  const hasActions = (x) => Array.isArray(x.actions) && x.actions.length > 0;
  if (st.list.length >= MAX) {
    victim = st.list.find((x) => !hasActions(x)) || (st.list.length >= HARD_MAX ? st.list[0] : null);
    if (victim) removeEntry(win, st, victim);
  }

  const e = { ...t, onAction: handler, timer: null };
  st.list.push(e);
  armTimer(win, st, e);
  sendShow(win, st, e);
  // Called last, so a callback that shows another toast sees a consistent list.
  if (victim) callAction(victim, RESERVED_ACTION);
  return true;
}

function hide(win, id) {
  const st = win && windows.get(win);
  if (!st || typeof id !== 'string') return false;
  const e = st.list.find((x) => x.id === id);
  if (!e) return false;
  return removeEntry(win, st, e);
}

function has(win, id) {
  const st = win && windows.get(win);
  return !!st && st.list.some((x) => x.id === id);
}

// toast:action from the browser UI of the window that shows the toast (a press on a button or on ×).
// The toast is hidden first, then its callback runs, so a callback may show a toast with the same id.
function onActionIpc(event, id, actionId) {
  if (!security.isChromeSender(event)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  const st = win && windows.get(win);
  if (!st || typeof id !== 'string' || typeof actionId !== 'string') return;
  const e = st.list.find((x) => x.id === id);
  if (!e) return;
  if (actionId !== RESERVED_ACTION && !e.actions.some((a) => a.id === actionId)) return;
  removeEntry(win, st, e);
  callAction(e, actionId);
}

function registerIpc(ipc) {
  ipc.on('toast:action', onActionIpc);
}

module.exports = { show, hide, has, registerIpc };
