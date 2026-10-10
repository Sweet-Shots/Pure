/* Pure new-tab page widgets: clock + weather + forecast, news, continue reading, notes, footer.
 * Classic script, loaded after shared.js and before home.js. Owner: B3. Exposes window.PureHomeWidgets.
 *
 * No timers here. Data is requested when a widget becomes visible or the page loads; main caches
 * news, forecast and footer; current weather is cached in sessionStorage. Incognito: nothing fetched.
 * Every DOM lookup is guarded; API data is rendered with createElement/textContent only. */
(function () {
  'use strict';

  const H = window.PureHome;
  const WEATHER_KEY = 'pure.weather';
  const WEATHER_TTL_MS = 30 * 60 * 1000;
  const WEATHER_TIMEOUT_MS = 8000;
  const NOTES_DEBOUNCE_MS = 800;
  const MAX_NOTES = 20000;
  const NEWS_AFTER_LEAD = 5;
  const TOPICS = ['top', 'tech', 'world', 'science', 'business', 'sports', 'entertainment', 'health'];
  const TOPIC_LABELS = {
    top: 'Top', tech: 'Tech', world: 'World', science: 'Science', business: 'Business',
    sports: 'Sports', entertainment: 'Entertainment', health: 'Health',
  };

  const $ = (id) => document.getElementById(id);

  const ws = {
    api: null,
    incognito: false,
    settings: null,
    current: { key: '', entry: null, failed: false, token: 0 },
    forecast: { key: '', data: null, failed: false, token: 0 },
    news: { key: '', data: null, loaded: false, token: 0 },
    reading: { token: 0 },
    notes: { loaded: false, dirty: false, timer: 0 },
    footerShown: false,
  };

  // ── Visibility of widgets (settings.homeWidgets) ───────────────────────────
  function isVisible(s, id) {
    const w = s && Array.isArray(s.homeWidgets) ? s.homeWidgets.find((x) => x && x.id === id) : null;
    return w ? w.visible !== false : true;
  }

  // ── Clock (in the weather widget) ──────────────────────────────────────────
  function formatTime(date, format) {
    const h = date.getHours();
    const m = String(date.getMinutes()).padStart(2, '0');
    if (format === '12h') {
      return `${String(h % 12 || 12).padStart(2, '0')}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
    }
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  function weatherShown() {
    return !ws.incognito && !!ws.settings && isVisible(ws.settings, 'weather');
  }

  function renderClock(date) {
    const el = $('clock');
    if (!el || !weatherShown()) return;
    el.textContent = formatTime(date || new Date(), ws.settings.homepageTimeFormat);
  }

  // ── Weather (current: open-meteo, sessionStorage 30 min) ───────────────────
  // WMO weather interpretation codes -> label and icon.
  function weatherLabel(code) {
    if (code === 0 || code === 1) return 'Clear';
    if (code === 2) return 'Mostly Clear';
    if (code === 3) return 'Overcast';
    if (code === 45 || code === 48) return 'Foggy';
    if (code === 51 || code === 53 || code === 55) return 'Drizzle';
    if (code === 61 || code === 63 || code === 65) return 'Rainy';
    if (code === 71 || code === 73 || code === 75) return 'Snowy';
    if (code === 77) return 'Snow';
    if (code === 80 || code === 81 || code === 82) return 'Showers';
    if (code === 85 || code === 86) return 'Snow Showers';
    if (code === 95 || code === 96 || code === 99) return 'Thunderstorm';
    return 'Variable';
  }

  function weatherIconName(code) {
    if (code === 0 || code === 1) return 'sun';
    if (code === 2) return 'cloud-sun';
    if (code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'cloud-fog';
    if (code >= 51 && code <= 57) return 'cloud-drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'cloud-rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'cloud-snow';
    if (code >= 95) return 'cloud-lightning';
    return 'cloud';
  }

  function unitSymbol(s) {
    return s.homepageTempUnit === 'fahrenheit' ? '°F' : '°C';
  }

  function readWeatherCache(key) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(WEATHER_KEY) || 'null');
      if (hit && hit.key === key && Date.now() - hit.t < WEATHER_TTL_MS && Number.isFinite(hit.temp)) return hit;
    } catch {
      // storage unavailable: just fetch
    }
    return null;
  }

  function writeWeatherCache(entry) {
    try {
      sessionStorage.setItem(WEATHER_KEY, JSON.stringify(entry));
    } catch {
      // storage unavailable: nothing to do
    }
  }

  function renderCurrent() {
    const tempEl = $('weather');
    const condEl = $('weather-condition');
    const iconEl = $('weather-icon');
    if (!weatherShown() || (!tempEl && !condEl)) return;
    const s = ws.settings;
    const cur = ws.current;
    let temp = '--';
    let cond = '--';
    if (cur.failed) {
      cond = 'Unavailable';
    } else if (cur.entry) {
      const w = cur.entry;
      const shown = s.homepageTempUnit === 'fahrenheit' ? Math.round((w.temp * 9) / 5 + 32) : Math.round(w.temp);
      temp = `${shown}${unitSymbol(s)}`;
      cond = weatherLabel(w.code);
    }
    if (tempEl) tempEl.textContent = temp;
    if (condEl) condEl.textContent = cond;
    if (iconEl) {
      const name = cur.entry && !cur.failed ? weatherIconName(cur.entry.code) : '';
      iconEl.hidden = !name;
      if (name && iconEl.dataset.name !== name) {
        iconEl.dataset.name = name;
        iconEl.replaceChildren(H.icon(name));
      }
    }
  }

  async function loadCurrent(key) {
    const cached = readWeatherCache(key);
    if (cached) {
      ws.current = { key, entry: cached, failed: false, token: ws.current.token };
      renderCurrent();
      return;
    }
    const token = ++ws.current.token;
    ws.current = { key, entry: null, failed: false, token };
    renderCurrent();
    try {
      const s = ws.settings;
      const url =
        'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(s.homepageLatitude) +
        '&longitude=' + encodeURIComponent(s.homepageLongitude) +
        '&current=temperature_2m,weather_code&timezone=auto';
      const res = await fetch(url, {
        signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const cur = data && data.current;
      const temp = Number(cur && cur.temperature_2m);
      const code = Number(cur && cur.weather_code);
      if (!Number.isFinite(temp) || !Number.isFinite(code)) throw new Error('unexpected response');
      if (token !== ws.current.token) return;
      const entry = { key, t: Date.now(), temp, code };
      ws.current = { key, entry, failed: false, token };
      writeWeatherCache(entry);
    } catch {
      if (token !== ws.current.token) return;
      ws.current = { key, entry: null, failed: true, token };
    }
    renderCurrent();
  }

  // ── Forecast (3 days, from main) ───────────────────────────────────────────
  function dayName(date, index) {
    if (index === 0) return 'Today';
    return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
  }

  function renderForecast() {
    const box = $('forecast');
    if (!box || !weatherShown()) return;
    const f = ws.forecast;
    const days = f.data && Array.isArray(f.data.days) ? f.data.days : [];
    box.dataset.state = days.length ? 'ready' : f.failed ? 'failed' : 'loading';
    const unit = ws.settings.homepageTempUnit === 'fahrenheit' ? '°F' : '°C';
    box.replaceChildren(...days.map((d, i) => {
      const name = dayName(d.date, i);
      const day = H.el('div', 'forecast-day');
      day.title = `${name}: ${weatherLabel(d.code)}, high ${d.max}${unit}, low ${d.min}${unit}`;
      day.append(
        H.el('span', 'forecast-name', name),
        H.icon(weatherIconName(d.code), 'forecast-icon'),
        H.el('span', 'forecast-temp', `${d.max}° / ${d.min}°`),
      );
      return day;
    }));
  }

  async function loadForecast(key) {
    const token = ++ws.forecast.token;
    ws.forecast = { key, data: null, failed: false, token };
    renderForecast();
    try {
      const data = await ws.api.home.forecast();
      if (token !== ws.forecast.token) return;
      ws.forecast = { key, data: data && Array.isArray(data.days) ? data : null, failed: !data, token };
    } catch {
      if (token !== ws.forecast.token) return;
      ws.forecast = { key, data: null, failed: true, token };
    }
    renderForecast();
  }

  // Current weather and forecast are refetched only when the location (or forecast unit) changes.
  function ensureWeather() {
    if (!weatherShown()) return;
    const s = ws.settings;
    const locKey = `${s.homepageLatitude},${s.homepageLongitude}`;
    if (ws.current.key !== locKey) loadCurrent(locKey);
    const fKey = `${locKey},${s.homepageTempUnit}`;
    if (ws.forecast.key !== fKey) loadForecast(fKey);
    renderClock();
  }

  // ── News ───────────────────────────────────────────────────────────────────
  function newsKeyOf(s) {
    const topics = TOPICS.filter((t) => (s.newsTopics || []).includes(t));
    const off = (s.newsSources || []).slice().sort();
    return `${topics.join(',')}|${off.join(',')}`;
  }

  function relTime(ms) {
    if (!Number.isFinite(ms)) return '';
    const min = Math.floor(Math.max(0, Date.now() - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
  }

  function metaText(source, publishedAt) {
    return [source, relTime(publishedAt)].filter(Boolean).join(' · ');
  }

  function setNewsStatus(text) {
    const node = $('news-status');
    if (node) node.textContent = text;
  }

  function newsMeta(item) {
    const meta = H.el('span', 'news-meta', metaText(item.source, item.publishedAt));
    meta.dataset.source = item.source || '';
    if (Number.isFinite(item.publishedAt)) meta.dataset.published = String(item.publishedAt);
    return meta;
  }

  function newsLead(item) {
    const a = H.el('a', 'news-lead');
    a.href = item.link;
    if (ws.settings && ws.settings.newsImages && item.image) {
      const img = document.createElement('img');
      img.className = 'news-image';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.dataset.fallback = 'remove';
      img.src = item.image;
      a.append(img);
    }
    a.append(H.el('span', 'news-title', item.title), newsMeta(item));
    return a;
  }

  function newsItem(item) {
    const a = H.el('a', 'news-item');
    a.href = item.link;
    a.append(H.el('span', 'news-title', item.title), newsMeta(item));
    return a;
  }

  function renderNews(data) {
    const list = $('news-list');
    if (!list) return;
    ws.news.data = data;
    if (data === null) {
      list.replaceChildren();
      setNewsStatus('Could not load headlines.');
      return;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    const nodes = [];
    if (items[0]) nodes.push(newsLead(items[0]));
    for (const item of items.slice(1, 1 + NEWS_AFTER_LEAD)) nodes.push(newsItem(item));
    list.replaceChildren(...nodes);
    if (!items.length) setNewsStatus(data.offline ? 'Offline, and no headlines are saved.' : 'No headlines right now.');
    else if (data.offline) setNewsStatus(data.stale ? 'Offline: showing saved headlines.' : 'Offline.');
    else setNewsStatus('');
  }

  // Updates only the "12 min ago" text, so the lead image is not reloaded every minute.
  function refreshNewsMeta() {
    document.querySelectorAll('#news-list .news-meta').forEach((node) => {
      const published = node.dataset.published ? Number(node.dataset.published) : null;
      node.textContent = metaText(node.dataset.source, published);
    });
  }

  function renderTopics() {
    const box = $('news-topics');
    if (!box || !ws.settings) return;
    const on = new Set(ws.settings.newsTopics || []);
    box.replaceChildren(...TOPICS.map((t) => {
      const b = H.el('button', 'news-topic', TOPIC_LABELS[t]);
      b.type = 'button';
      b.dataset.action = 'news-topic';
      b.dataset.topic = t;
      b.classList.toggle('on', on.has(t));
      b.setAttribute('aria-pressed', String(on.has(t)));
      return b;
    }));
  }

  async function loadNews(force) {
    if (ws.incognito || !ws.api) return;
    const token = ++ws.news.token;
    setNewsStatus('Loading headlines...');
    let data = null;
    try {
      data = await ws.api.home.news({ force: !!force });
    } catch {
      data = null;
    }
    if (token !== ws.news.token) return;
    ws.news.loaded = true;
    renderNews(data);
  }

  // Keeps at least one topic on.
  function onTopicClick(topic) {
    if (!ws.api || !ws.settings) return;
    const current = ws.settings.newsTopics || [];
    let next;
    if (current.includes(topic)) {
      if (current.length <= 1) return;
      next = current.filter((t) => t !== topic);
    } else {
      next = [...current, topic];
    }
    ws.api.settings.set({ newsTopics: TOPICS.filter((t) => next.includes(t)) }).catch(() => {});
  }

  // ── Continue reading ───────────────────────────────────────────────────────
  function renderReading(items) {
    const list = $('reading-list');
    if (!list) return;
    if (!items.length) {
      list.replaceChildren(H.el('p', 'empty', 'Pages you visit will show up here.'));
      return;
    }
    list.replaceChildren(...items.map((it) => {
      const a = H.el('a', 'reading-item');
      a.href = it.url;
      const img = document.createElement('img');
      img.className = 'reading-favicon';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.dataset.fallback = 'hide';
      const src = H.faviconFor(it.url);
      if (src) img.src = src;
      a.append(img, H.el('span', 'reading-title', it.title || it.url));
      return a;
    }));
  }

  async function loadReading() {
    if (ws.incognito || !ws.api) return;
    const token = ++ws.reading.token;
    let items = [];
    try {
      items = await ws.api.home.continueReading();
    } catch {
      items = [];
    }
    if (token !== ws.reading.token) return;
    renderReading(Array.isArray(items) ? items : []);
  }

  // ── Notes (autosave, 800 ms debounce) ─────────────────────────────────────
  function setNotesStatus(text) {
    const node = $('notes-status');
    if (node) node.textContent = text;
  }

  async function loadNotes() {
    if (ws.incognito || !ws.api || ws.notes.loaded) return;
    ws.notes.loaded = true;
    try {
      const text = await ws.api.home.notes.get();
      const area = $('notes-input');
      // Keep anything typed while the load was in flight.
      if (area && !ws.notes.dirty && typeof text === 'string') area.value = text;
      setNotesStatus('Saved');
    } catch {
      setNotesStatus('Could not load notes');
    }
  }

  function onNotesInput() {
    ws.notes.dirty = true;
    setNotesStatus('Saving...');
    clearTimeout(ws.notes.timer);
    ws.notes.timer = setTimeout(() => {
      ws.notes.timer = 0;
      saveNotes();
    }, NOTES_DEBOUNCE_MS);
  }

  async function saveNotes() {
    clearTimeout(ws.notes.timer);
    ws.notes.timer = 0;
    const area = $('notes-input');
    if (!ws.notes.dirty || !area || !ws.api || ws.incognito) return;
    const text = area.value;
    ws.notes.dirty = false;
    try {
      const ok = await ws.api.home.notes.set(text);
      setNotesStatus(ok ? 'Saved' : 'Not saved');
    } catch {
      ws.notes.dirty = true;
      setNotesStatus('Not saved');
    }
  }

  // ── Footer (memory, sleeping tabs, blocked today) ──────────────────────────
  function footerShouldShow(s) {
    return !ws.incognito && !!s && s.showHomeStats !== false;
  }

  function setFooterHidden(hidden) {
    const node = $('home-stats');
    if (node) node.hidden = hidden;
  }

  async function loadFooter() {
    const node = $('home-stats');
    if (!node || !ws.api || !footerShouldShow(ws.settings)) return;
    try {
      const f = await ws.api.home.footer();
      if (!f) return;
      node.textContent =
        `${Math.round(f.memoryMB)} MB · ${f.sleeping} sleeping · ${f.blockedToday} purified today`;
    } catch {
      // keep the previous text
    }
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action="news-topic"]') : null;
    if (btn) onTopicClick(btn.dataset.topic);
  });

  document.addEventListener('input', (e) => {
    if (e.target instanceof HTMLElement && e.target.id === 'notes-input') onNotesInput();
  });

  // ── Public API (used by home.js) ───────────────────────────────────────────
  function start(api, incognito) {
    ws.api = api || null;
    ws.incognito = !!incognito;
    const area = $('notes-input');
    if (area) area.maxLength = MAX_NOTES;
  }

  // Called after every settings change. prev is null on the first call.
  function update(s, prev) {
    ws.settings = s;
    const footer = $('home-stats');
    if (footer) footer.hidden = !footerShouldShow(s);
    if (ws.incognito) return;

    // Clock and weather.
    const wOn = isVisible(s, 'weather');
    const wBecame = !prev || !isVisible(prev, 'weather');
    if (wOn) {
      if (wBecame) {
        ws.current.key = '';
        ws.forecast.key = '';
      }
      ensureWeather();
      if (prev && prev.homepageTempUnit !== s.homepageTempUnit) renderCurrent();
      if (prev && prev.homepageTempUnit !== s.homepageTempUnit) renderForecast();
    }

    // News: refetch when the topics or disabled sources change or the widget appears.
    const nOn = isVisible(s, 'news');
    const nBecame = !prev || !isVisible(prev, 'news');
    if (nOn) {
      const key = newsKeyOf(s);
      if (nBecame || !ws.news.loaded || key !== ws.news.key) {
        ws.news.key = key;
        loadNews(false);
      } else if (prev && prev.newsImages !== s.newsImages && ws.news.data) {
        renderNews(ws.news.data);
      }
    }
    if (!prev || (prev.newsTopics || []).join() !== (s.newsTopics || []).join()) renderTopics();

    // Continue reading: a local history read, no network.
    if (isVisible(s, 'reading') && (!prev || !isVisible(prev, 'reading'))) loadReading();

    // Notes: load on first show; save pending text when the widget is hidden.
    const notesOn = isVisible(s, 'notes');
    if (notesOn) {
      loadNotes();
    } else if (prev && isVisible(prev, 'notes') && ws.notes.dirty) {
      saveNotes();
    }

    // Footer: fetched when shown (page load, or the setting turned on).
    if (footerShouldShow(s) && (!prev || prev.showHomeStats === false)) loadFooter();
  }

  // Called once a minute while the page is visible (home.js owns that timer).
  function onMinute(date) {
    if (ws.incognito) return;
    renderClock(date);
    if (isVisible(ws.settings, 'news')) refreshNewsMeta();
  }

  function onVisible() {
    if (!ws.incognito) loadFooter();
  }

  function onHidden() {
    saveNotes();
  }

  function flush() {
    return saveNotes();
  }

  window.PureHomeWidgets = { start, update, onMinute, onVisible, onHidden, flush };
})();
