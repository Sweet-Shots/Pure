// Frame preload for saved passwords and the strong password generator (C1 / F5). Registered by main/passwords.js
// on every session.
//
// Sandboxed: only require('electron') is available here. It exposes nothing to the page (no contextBridge, no
// globals, no DOM ids), it does nothing on non-http(s) pages, and it acts only in the top frame or in a
// subframe that is same-origin with the top frame. Main re-checks all of this from event.senderFrame.
//
// Nothing here scans the page unless the user focuses a text or password field, or submits a form.
//
//   out: pw:page-field-focus {rect, kind:'username'|'password'|'new-password'}  rect = field in frame CSS px
//   out: pw:page-submitted   {username, password}                 on form submit, or on pagehide after typing
//   in:  pw:page-fill        {username, password}                 from main, only to the exact saved origin
//   in:  pw:page-generated   {password}                           from main, only after "Use a strong password"
//
// A password field is 'new-password' when it has autocomplete="new-password", when its form has a second password
// field (password + confirm, the new field of a change-password form), or when the form's id/name/class/action or
// submit button says sign up / register / create account / change password. The old password of a change-password
// form (autocomplete="current-password", or a name such as "old password") is 'password', so it is never generated.

'use strict';

const { ipcRenderer } = require('electron');

if (location.protocol === 'http:' || location.protocol === 'https:') {
  const TEXT_TYPES = ['text', 'email', 'tel'];
  const PW_SELECTOR = 'input[type="password"]';
  const NEW_AUTOCOMPLETE = /(^|\s)new-password(\s|$)/i;
  const CURRENT_AUTOCOMPLETE = /(^|\s)current-password(\s|$)/i;
  const CURRENT_HINT = /current|old[-_ ]?pass|existing|previous/i;
  const NEW_HINT = /new[-_ ]?pass|confirm|repeat|retype|re-?enter|again/i;
  const SIGNUP_HINT = /regist|sign[-_ ]?up|create[-_ ]?(an? |your )?account|new[-_ ]?account|join|change[-_ ]?password|password[-_ ]?change|reset[-_ ]?password|new[-_ ]?user/i;
  const USER_HINT = /user|login|email|mail|account/i;

  let pending = null;   // password field typed into but not submitted (sent on pagehide)
  let lastNewField = null; // last focused field classified as new-password (the generator's target)

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

  // Hints from the field's own attributes (only read on focus / submit).
  function hintOf(el) {
    return [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
  }

  // Hints from the form: id, name, class, action and its submit buttons (capped, so a huge form costs little).
  function formHint(form) {
    let text = [form.id, form.getAttribute('name'), String(form.className || ''), form.getAttribute('action')].join(' ');
    let n = 0;
    for (const b of form.querySelectorAll('button, input[type="submit"]')) {
      if (++n > 10) break;
      text += ' ' + String(b.textContent || b.value || '').slice(0, 200);
    }
    return text;
  }

  // Visible, editable password fields that belong with `el`: its form, or else the nearest ancestor (within 6
  // levels) holding two or more. `el` itself is always included.
  function passwordGroup(el) {
    let list = [el];
    if (el.form) {
      list = el.form.querySelectorAll(PW_SELECTOR);
    } else {
      let node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const found = node.querySelectorAll(PW_SELECTOR);
        if (found.length >= 2) {
          list = found;
          break;
        }
      }
    }
    return Array.from(list).filter((p) => p === el || (isEditable(p) && isVisible(p)));
  }

  // 'new' (sign-up or new-password field), 'current' (the old password of a change-password form) or 'login'.
  function classify(el) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (NEW_AUTOCOMPLETE.test(ac)) return 'new';
    if (CURRENT_AUTOCOMPLETE.test(ac)) return 'current';
    const hint = hintOf(el);
    if (CURRENT_HINT.test(hint)) return 'current';
    const group = passwordGroup(el);
    if (group.length >= 2) {
      if (NEW_HINT.test(hint)) return 'new';
      if (group.length === 2) return 'new'; // password + confirm
      return group.indexOf(el) === 0 ? 'current' : 'new'; // current, new, confirm
    }
    if (el.form && SIGNUP_HINT.test(formHint(el.form))) return 'new';
    return 'login';
  }

  // Nearest preceding visible text/email field in the same form (or document): one with a user/email hint wins.
  function findUsername(pw) {
    const scope = pw.form || document;
    let plain = null;
    let hinted = null;
    for (const el of scope.querySelectorAll('input')) {
      if (el === pw) break;
      if (!isTextField(el) || !isEditable(el) || !isVisible(el)) continue;
      plain = el;
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (el.type === 'email' || ac.includes('username') || ac.includes('email') || USER_HINT.test(hintOf(el))) {
        hinted = el;
      }
    }
    return hinted || plain;
  }

  function sendCredentials(pw) {
    const user = findUsername(pw);
    ipcRenderer.send('pw:page-submitted', {
      username: user ? user.value : '',
      password: pw.value,
    });
  }

  // Field focus: a password field (login or new), or a text field in a form that has a password field.
  document.addEventListener('focusin', (e) => {
    if (!sameOriginAsTop()) return;
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !isEditable(el)) return;
    let kind = null;
    if (isPasswordField(el)) {
      const c = classify(el);
      if (c === 'new') {
        kind = 'new-password';
        lastNewField = el;
      } else {
        kind = 'password';
      }
    } else if (isTextField(el) && (el.form || document).querySelector(PW_SELECTOR)) {
      kind = 'username';
    }
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
    const filled = Array.from(form.querySelectorAll(PW_SELECTOR)).filter((p) => p.value);
    if (!filled.length) return;
    // The last new-password field with a value: the new password of a change form, or the confirmed one.
    const news = filled.filter((p) => classify(p) === 'new');
    const pw = news.length ? news[news.length - 1] : filled[0];
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

  // Sets a value the way a user would: native setter (so framework-controlled inputs see the change), then input
  // and change events.
  function setValue(el, value) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Autofill from main: fill the username (nearest preceding text field) and the password field.
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

  // Prefers the one in the same form as `anchor`.
  function visiblePasswordFields(anchor) {
    const list = Array.from(document.querySelectorAll(PW_SELECTOR))
      .filter((el) => isEditable(el) && isVisible(el));
    if (anchor && anchor.form) {
      const same = list.find((el) => el.form === anchor.form);
      if (same) return same;
    }
    return list[0] || null;
  }

  // "Use a strong password" chosen in main's menu: fill every new-password field of the form the user is in.
  ipcRenderer.on('pw:page-generated', (_event, data) => {
    if (!sameOriginAsTop() || !data || typeof data !== 'object') return;
    const password = data.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return;
    const target = lastNewField && lastNewField.isConnected ? lastNewField : null;
    if (!target) return;
    for (const field of passwordGroup(target)) {
      if (field === target || classify(field) === 'new') setValue(field, password);
    }
  });
}
