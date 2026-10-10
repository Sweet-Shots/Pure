// Frame preload for saved-password support (C1, Pure 2.2). Registered by main/passwords.js on every session.
//
// Sandboxed: only require('electron') is available here. It exposes nothing to the page (no contextBridge, no
// globals, no DOM ids), it does nothing on non-http(s) pages, and it acts only in the top frame or in a
// subframe that is same-origin with the top frame. Main re-checks all of this from event.senderFrame.
//
//   out: pw:page-field-focus {rect, kind:'username'|'password'}   rect = field in frame CSS px
//   out: pw:page-submitted   {username, password}                 on form submit, or on pagehide after typing
//   in:  pw:page-fill        {username, password}                 from main, only to the exact saved origin

'use strict';

const { ipcRenderer } = require('electron');

if (location.protocol === 'http:' || location.protocol === 'https:') {
  const TEXT_TYPES = ['text', 'email', 'tel'];
  let pending = null; // password field typed into but not submitted (sent on pagehide)

  function sameOriginAsTop() {
    if (window.top === window) return true;
    try {
      return location.origin !== 'null' && window.top.location.origin === location.origin;
    } catch {
      return false; // cross-origin top: no access, no action
    }
  }

  function isEditable(el) {
    return !el.disabled && !el.readOnly;
  }

  function isVisible(el) {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function isTextField(el) {
    return el instanceof HTMLInputElement && TEXT_TYPES.includes(el.type);
  }

  function isPasswordField(el) {
    return el instanceof HTMLInputElement && el.type === 'password';
  }

  // Nearest preceding visible text/email field in the same form (or document when there is no form).
  function findUsername(pw) {
    const scope = pw.form || document;
    let best = null;
    for (const el of scope.querySelectorAll('input')) {
      if (el === pw) break;
      if (isTextField(el) && isEditable(el) && isVisible(el)) best = el;
    }
    return best;
  }

  // Visible, editable password fields; prefers the one in the same form as `anchor`.
  function visiblePasswordFields(anchor) {
    const list = Array.from(document.querySelectorAll('input[type="password"]'))
      .filter((el) => isEditable(el) && isVisible(el));
    if (anchor && anchor.form) {
      const same = list.find((el) => el.form === anchor.form);
      if (same) return same;
    }
    return list[0] || null;
  }

  function sendCredentials(pw) {
    const user = findUsername(pw);
    ipcRenderer.send('pw:page-submitted', {
      username: user ? user.value : '',
      password: pw.value,
    });
  }

  // Field focus: a password field, or a text field in a form that has a password field.
  document.addEventListener('focusin', (e) => {
    if (!sameOriginAsTop()) return;
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !isEditable(el)) return;
    let kind = null;
    if (isPasswordField(el)) kind = 'password';
    else if (isTextField(el) && (el.form || document).querySelector('input[type="password"]')) kind = 'username';
    if (!kind) return;
    const r = el.getBoundingClientRect();
    ipcRenderer.send('pw:page-field-focus', {
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      kind,
    });
  }, true);

  // Typed passwords: remembered until a submit or a navigation.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (isPasswordField(el)) pending = el.value ? el : null;
  }, true);

  document.addEventListener('submit', (e) => {
    if (!sameOriginAsTop()) return;
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const pw = Array.from(form.querySelectorAll('input[type="password"]')).find((p) => p.value);
    if (!pw) return;
    sendCredentials(pw);
    pending = null;
  }, true);

  // Fallback for logins that do not submit a form (script-driven). Only when a typed password is still pending.
  function flushPending() {
    if (!pending || !pending.isConnected || !pending.value || !sameOriginAsTop()) return;
    sendCredentials(pending);
    pending = null;
  }
  window.addEventListener('pagehide', flushPending);
  window.addEventListener('beforeunload', flushPending);

  // Autofill from main: fill the username (nearest preceding text field) and the password field.
  function setValue(el, value) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, value); // native setter, so framework-controlled inputs see the change
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  ipcRenderer.on('pw:page-fill', (_event, data) => {
    if (!sameOriginAsTop() || !data || typeof data !== 'object') return;
    if (typeof data.username !== 'string' || typeof data.password !== 'string') return;
    const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    const pw = active && isPasswordField(active) && isEditable(active) ? active : visiblePasswordFields(active);
    if (!pw) return;
    const user = findUsername(pw);
    if (user) setValue(user, data.username);
    setValue(pw, data.password);
  });
}
