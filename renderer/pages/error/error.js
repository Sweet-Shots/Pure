// Error page for pure://error/?code=&desc=&url=. Classic script (no modules, no inline handlers).
// Maps Chromium network error names to friendly text. Every element lookup is guarded, so the
// page still works if the markup is missing a piece.
(function () {
  'use strict';

  var FALLBACK = {
    title: "This page isn't working",
    message: 'Something went wrong while loading this page. Try again in a moment.',
  };

  // Keys are Chromium error names without the ERR_ prefix, upper case.
  var ERRORS = {
    NAME_NOT_RESOLVED: {
      title: "This site can't be reached",
      message: 'The address could not be found. Check it for typos, or search for the site instead.',
    },
    INTERNET_DISCONNECTED: {
      title: "You're offline",
      message: "Check your network connection. This page will load again automatically when you're back online.",
      offline: true,
    },
    NETWORK_CHANGED: {
      title: 'Your network changed',
      message: 'Your connection changed while the page was loading. Try again.',
      offline: true,
    },
    CONNECTION_REFUSED: {
      title: "This site can't be reached",
      message: 'The site refused the connection. It may be down or blocking access.',
    },
    CONNECTION_RESET: {
      title: 'The connection was reset',
      message: 'The connection to the site was interrupted. Try again.',
    },
    CONNECTION_CLOSED: {
      title: 'The connection was closed',
      message: 'The site closed the connection before the page loaded. Try again.',
    },
    CONNECTION_TIMED_OUT: {
      title: 'This site took too long to respond',
      message: 'The connection timed out. The site may be slow or unavailable.',
    },
    TIMED_OUT: {
      title: 'This site took too long to respond',
      message: 'The request timed out. The site may be slow or unavailable.',
    },
    ADDRESS_UNREACHABLE: {
      title: "This site can't be reached",
      message: "The site's address could not be reached from your network.",
    },
    SSL_PROTOCOL_ERROR: {
      title: "This site can't provide a secure connection",
      message: 'The site sent a response that could not be used over a secure connection. Try again later.',
    },
    // Matches every CERT_* code (see lookup()). No option to bypass the warning is offered.
    CERT: {
      title: 'Your connection is not private',
      message: 'Attackers might be trying to steal your information from this site. Check the date and time on your device and try again later.',
    },
    TOO_MANY_REDIRECTS: {
      title: "This page isn't working",
      message: 'The site redirected you too many times.',
    },
    EMPTY_RESPONSE: {
      title: "This page isn't working",
      message: "The site didn't send any data.",
    },
    BLOCKED_BY_CLIENT: {
      title: 'This page was blocked',
      message: 'Something on this device blocked the page from loading.',
    },
    FILE_NOT_FOUND: {
      title: 'File not found',
      message: "Pure couldn't find this file. It may have been moved or deleted.",
    },
    CRASHED: {
      title: 'This page crashed',
      message: 'Something went wrong while displaying this page. Reload to try again.',
    },
  };

  // Chromium numeric net error codes that show up as strings.
  var NUMERIC = {
    '-105': 'NAME_NOT_RESOLVED',
    '-106': 'INTERNET_DISCONNECTED',
    '-21': 'NETWORK_CHANGED',
    '-102': 'CONNECTION_REFUSED',
    '-101': 'CONNECTION_RESET',
    '-100': 'CONNECTION_CLOSED',
    '-118': 'CONNECTION_TIMED_OUT',
    '-7': 'TIMED_OUT',
    '-109': 'ADDRESS_UNREACHABLE',
    '-107': 'SSL_PROTOCOL_ERROR',
    '-310': 'TOO_MANY_REDIRECTS',
    '-324': 'EMPTY_RESPONSE',
    '-20': 'BLOCKED_BY_CLIENT',
    '-6': 'FILE_NOT_FOUND',
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  // 'net::ERR_NAME_NOT_RESOLVED' / 'ERR_NAME_NOT_RESOLVED' / 'NAME_NOT_RESOLVED' / '-105' -> 'NAME_NOT_RESOLVED'
  function normalizeCode(raw) {
    var s = String(raw || '').trim().toUpperCase();
    if (!s) return '';
    if (/^-?\d+$/.test(s)) return NUMERIC[s] || '';
    return s.replace(/^NET::/, '').replace(/^ERR_/, '');
  }

  function lookup(name) {
    if (name && ERRORS[name]) return ERRORS[name];
    if (name && name.indexOf('CERT_') === 0) return ERRORS.CERT;
    return FALLBACK;
  }

  function retryable(raw) {
    try {
      var u = new URL(raw);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:';
    } catch (e) {
      return false;
    }
  }

  function hostOf(raw) {
    try {
      return new URL(raw).host || '';
    } catch (e) {
      return '';
    }
  }

  var params = new URLSearchParams(location.search);
  var rawCode = params.get('code') || '';
  var desc = params.get('desc') || '';
  var url = params.get('url') || '';

  var name = normalizeCode(rawCode);
  var info = lookup(name);
  var isNetError = !!name && name !== 'CRASHED';
  var offline = !!info.offline || (typeof navigator !== 'undefined' && navigator.onLine === false);

  var codeText = '';
  if (isNetError) codeText = 'ERR_' + name;
  else if (name) codeText = name;
  else codeText = desc || rawCode;

  var autoRetried = false;

  function render() {
    document.title = hostOf(url) || info.title;
    setText('error-title', info.title);
    setText('error-message', info.message);
    setText('error-code', codeText);
    setText('error-url', url);
    if (document.documentElement) {
      document.documentElement.classList.toggle('offline', offline);
      // Picks the icon in error.css: generic | offline | cert | crashed.
      var kind = offline ? 'offline' : info === ERRORS.CERT ? 'cert' : name === 'CRASHED' ? 'crashed' : 'generic';
      document.documentElement.setAttribute('data-kind', kind);
    }
  }

  function retry() {
    if (retryable(url)) location.replace(url);
  }

  function goHome() {
    location.href = 'pure://home/';
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var el = target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'retry') {
      event.preventDefault();
      retry();
    } else if (action === 'home') {
      event.preventDefault();
      goHome();
    }
  });

  // Network-down errors: retry once automatically when the connection comes back.
  window.addEventListener('online', function () {
    if (!offline || autoRetried || !retryable(url)) return;
    autoRetried = true;
    location.replace(url);
  });

  // Incognito windows get the red accent (error.css: html.incognito), whatever the user's accent is.
  var api = window.pureInternal || null;
  if (api && typeof api.getInfo === 'function') {
    api.getInfo().then(
      function (info) {
        if (info && info.isIncognito) document.documentElement.classList.add('incognito');
      },
      function () {
        // no info: keep the default accent
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
