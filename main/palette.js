// Command palette backend (C4): one query over the open tabs of every window with the same
// incognito-ness as the sender, plus bookmarks and (not for incognito) history. Ranking is a
// small fixed score: prefix > word start > substring; every query word must match somewhere.
// Results are capped (≤ 30) and the UI fills its own actions and settings entries.

const windows = require('./windows');
const storage = require('./storage');

const MAX_RESULTS = 30;
const MAX_QUERY = 200;
const MAX_TOKENS = 8;
const TAB_CAP = 20;
const BOOKMARK_CAP = 8;
const HISTORY_CAP = 8;
const RECENT_TABS = 12;
const KIND_RANK = { tab: 0, bookmark: 1, history: 2 };
const WORD_START = /[\s/.\-_:@#?=&]/;

function normalize(text) {
  if (typeof text !== 'string') return '';
  return text.slice(0, MAX_QUERY).trim().toLowerCase();
}

// 3 = prefix, 2 = word start, 1 = substring, 0 = no match.
function fieldScore(hay, token) {
  if (!hay) return 0;
  if (hay.startsWith(token)) return 3;
  let i = hay.indexOf(token);
  while (i >= 0) {
    if (i === 0 || WORD_START.test(hay.charAt(i - 1))) return 2;
    i = hay.indexOf(token, i + 1);
  }
  return hay.includes(token) ? 1 : 0;
}

// fields: lowercased strings. Each token takes its best field; the entry scores its weakest token.
function entryScore(fields, tokens) {
  let worst = 3;
  for (const tok of tokens) {
    let best = 0;
    for (const f of fields) {
      const s = fieldScore(f, tok);
      if (s > best) best = s;
      if (best === 3) break;
    }
    if (best === 0) return 0;
    if (best < worst) worst = best;
  }
  return worst;
}

function bareUrl(url) {
  return String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').toLowerCase();
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// Same-mode browser windows and their tab managers.
function managersFor(incognito) {
  const out = [];
  for (const win of windows.getBrowserWindows()) {
    if (win.isDestroyed()) continue;
    const m = windows.getTabManager(win);
    if (!m || m.destroyed || !m.state) continue;
    if (windows.isIncognitoWindow(win) !== incognito) continue;
    out.push(m);
  }
  return out;
}

function tabRows(incognito, tokens) {
  const rows = [];
  for (const m of managersFor(incognito)) {
    for (const tab of m.tabs) {
      const title = cleanText(tab.title, 300);
      const url = cleanText(tab.url, 2048);
      const fields = [title.toLowerCase(), bareUrl(url)];
      const score = tokens.length ? entryScore(fields, tokens) : 1;
      if (!score) continue;
      const row = {
        kind: 'tab',
        title: title || url || 'New Tab',
        sub: url,
        url,
        tabId: tab.id,
        windowId: m.state.id,
        score,
        recent: tab.lastActiveAt || 0,
      };
      if (typeof tab.favicon === 'string' && tab.favicon.length <= 2048 && /^(https?:|data:image\/)/i.test(tab.favicon)) {
        row.favicon = tab.favicon;
      }
      rows.push(row);
    }
  }
  if (!tokens.length) {
    // Empty query: most recently used tabs first.
    rows.sort((a, b) => b.recent - a.recent);
    return rows.slice(0, RECENT_TABS);
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, TAB_CAP);
}

function bookmarkRows(tokens) {
  if (!tokens.length) return [];
  const hits = storage.bookmarks.search(tokens.join(' '), BOOKMARK_CAP) || [];
  return hits.map((b) => {
    const title = cleanText(b.title, 300) || b.url;
    const score = entryScore([title.toLowerCase(), bareUrl(b.url)], tokens) || 1;
    return { kind: 'bookmark', title, sub: b.url, url: b.url, score };
  });
}

function historyRows(tokens) {
  if (!tokens.length) return [];
  const hits = storage.history.search(tokens.join(' '), HISTORY_CAP) || [];
  return hits.map((h) => {
    const title = cleanText(h.title, 300) || h.url;
    const score = entryScore([title.toLowerCase(), bareUrl(h.url)], tokens) || 1;
    return { kind: 'history', title, sub: h.url, url: h.url, score };
  });
}

function query(incognito, text) {
  const q = normalize(text);
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
  const rows = [
    ...tabRows(incognito, tokens),
    ...bookmarkRows(tokens),
    // Visits are not recorded or read back in incognito.
    ...(incognito ? [] : historyRows(tokens)),
  ];
  rows.sort((a, b) => b.score - a.score || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return rows.slice(0, MAX_RESULTS).map((r) => {
    const out = { kind: r.kind, title: r.title, sub: r.sub, url: r.url };
    if (r.tabId !== undefined) {
      out.tabId = r.tabId;
      out.windowId = r.windowId;
    }
    if (r.favicon) out.favicon = r.favicon;
    return out;
  });
}

function registerIpc(ipcMain) {
  // -> [{kind:'tab'|'history'|'bookmark', title, sub, url, favicon?, tabId?, windowId?}]
  ipcMain.handle('palette:query', (event, text) => {
    const st = windows.senderState(event);
    if (!st) return [];
    try {
      return query(!!st.incognito, text);
    } catch {
      return [];
    }
  });

  // Focuses the window that owns the tab and activates it. Both ids are validated; the target
  // window must have the same incognito-ness as the sender's window.
  ipcMain.on('palette:activate-tab', (event, windowId, tabId) => {
    const st = windows.senderState(event);
    if (!st || !Number.isInteger(windowId) || !Number.isInteger(tabId)) return;
    for (const win of windows.getBrowserWindows()) {
      if (win.isDestroyed()) continue;
      const target = windows.getState(win);
      if (!target || target.id !== windowId || !!target.incognito !== !!st.incognito) continue;
      const m = target.tabs;
      if (!m || m.destroyed || !m.get(tabId)) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      m.activate(tabId, { focus: true });
      return;
    }
  });
}

module.exports = { registerIpc, query, fieldScore, entryScore };
