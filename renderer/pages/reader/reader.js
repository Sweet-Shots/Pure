// Reader mode page (pure://reader/?id=N). Owner: C5.
// Article data comes from main (pureInternal.reader.get). contentHtml is UNSANITIZED, so it goes through
// DOMPurify (loaded from ./vendor/purify.min.js) before it touches the DOM. No inline handlers, no scripts.
(function () {
  'use strict';

  var root = document.documentElement;
  var pi = window.pureInternal;
  var purify = window.DOMPurify;

  var SIZE_MIN = 14;
  var SIZE_MAX = 28;
  var LANG_RE = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
  var ID_RE = /^[1-9]\d{0,9}$/;

  // Sanitizer: no scripts, styles, frames, forms or embedded objects. Images (src, srcset, alt) stay.
  var CONFIG = {
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'button', 'object', 'embed', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  };

  var prefs = { readerFont: 'serif', readerSize: 19 };

  function $(id) {
    return document.getElementById(id);
  }

  function isHttpUrl(value) {
    if (typeof value !== 'string') return false;
    try {
      var u = new URL(value.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (err) {
      return false;
    }
  }

  // Links open only web pages, never pure:// or other schemes; they never get a window reference.
  if (purify && typeof purify.addHook === 'function') {
    purify.addHook('afterSanitizeAttributes', function (node) {
      if (node.nodeName !== 'A') return;
      var href = node.getAttribute('href');
      if (href !== null && !isHttpUrl(href)) node.removeAttribute('href');
      node.removeAttribute('target');
      node.setAttribute('rel', 'noopener noreferrer');
    });
  }

  function clampSize(n) {
    return Math.min(SIZE_MAX, Math.max(SIZE_MIN, n));
  }

  function applyPrefs() {
    root.classList.toggle('font-sans', prefs.readerFont === 'sans');
    root.classList.toggle('font-serif', prefs.readerFont !== 'sans');
    root.style.setProperty('--reader-size', prefs.readerSize + 'px');
  }

  function setPrefs(patch) {
    for (var k in patch) prefs[k] = patch[k];
    applyPrefs();
    try {
      pi.settings.set(patch).catch(function () {});
    } catch (err) {
      // settings unavailable: the change lasts for this page only
    }
  }

  function showError() {
    var err = $('reader-error');
    var article = $('reader-article');
    if (article) article.hidden = true;
    if (err) err.hidden = false;
    document.title = 'Reader mode';
  }

  function render(article) {
    if (!purify) {
      showError();
      return;
    }
    var lang = typeof article.lang === 'string' && LANG_RE.test(article.lang) ? article.lang : '';
    if (lang) root.setAttribute('lang', lang);
    else root.removeAttribute('lang');
    root.setAttribute('dir', article.dir === 'rtl' ? 'rtl' : 'ltr');

    var title = typeof article.title === 'string' ? article.title : '';
    document.title = title || 'Reader mode';

    var titleEl = $('reader-title');
    if (titleEl) titleEl.textContent = title || 'Untitled article';

    var metaEl = $('reader-meta');
    if (metaEl) {
      var host = '';
      try {
        host = new URL(article.url).hostname;
      } catch (err) {
        host = '';
      }
      var minutes = Math.max(1, Math.round(Number(article.minutes) || 1));
      var parts = [article.siteName || host, article.byline, minutes + ' min read'];
      metaEl.textContent = parts.filter(Boolean).join(' · ');
    }

    var contentEl = $('reader-content');
    if (contentEl) {
      var html = typeof article.contentHtml === 'string' ? article.contentHtml : '';
      contentEl.innerHTML = purify.sanitize(html, CONFIG);
    }

    var articleEl = $('reader-article');
    if (articleEl) articleEl.hidden = false;
    var errEl = $('reader-error');
    if (errEl) errEl.hidden = true;
  }

  function loadArticle() {
    var id = new URLSearchParams(location.search).get('id') || '';
    if (!ID_RE.test(id) || !pi || !pi.reader) {
      showError();
      return;
    }
    pi.reader.get(Number(id)).then(function (article) {
      if (article && typeof article === 'object') render(article);
      else showError();
    }, showError);
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    var el = target && target.closest ? target.closest('[data-action]') : null;
    if (!el) return;
    switch (el.getAttribute('data-action')) {
      case 'reader-exit':
        pi.reader.exit();
        break;
      case 'font-serif':
        setPrefs({ readerFont: 'serif' });
        break;
      case 'font-sans':
        setPrefs({ readerFont: 'sans' });
        break;
      case 'size-down':
        setPrefs({ readerSize: clampSize(prefs.readerSize - 1) });
        break;
      case 'size-up':
        setPrefs({ readerSize: clampSize(prefs.readerSize + 1) });
        break;
      default:
        break;
    }
  });

  if (!pi) {
    showError();
    return;
  }

  // Settings first (font and size), then the article. Settings changes made elsewhere apply live.
  pi.settings.get().then(function (s) {
    if (s && s.readerFont) prefs.readerFont = s.readerFont;
    if (s && Number.isInteger(s.readerSize)) prefs.readerSize = clampSize(s.readerSize);
    applyPrefs();
  }, applyPrefs);
  pi.settings.onChanged(function (s) {
    if (!s) return;
    if (s.readerFont === 'serif' || s.readerFont === 'sans') prefs.readerFont = s.readerFont;
    if (Number.isInteger(s.readerSize)) prefs.readerSize = clampSize(s.readerSize);
    applyPrefs();
  });
  pi.getInfo().then(function (info) {
    root.classList.toggle('incognito', !!(info && info.isIncognito));
  }, function () {});

  applyPrefs();
  loadArticle();
})();
