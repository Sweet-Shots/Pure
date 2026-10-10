// Performance panel data: memory and CPU per tab, sleep actions, and the cheap summary used by the
// home footer. Owner: B2. Nothing here runs on a timer; the settings page asks for snapshot() every 2 s
// only while its section is visible.
//
// Attribution: app.getAppMetrics() reports processes, tabs report their renderer's OS pid. Several tabs
// can share one renderer process, so a process's memory and CPU are split evenly between the tabs that
// use it and those tabs are flagged `shared`. totalMB and cpuPercent are sums over all processes (browser,
// GPU, utility, UI and every renderer), so split shares never double count. Processes that no tab uses
// (browser, GPU, UI renderer, ...) are reported as otherMB.
// Memory per process = privateBytes (Windows) or workingSetSize: memory not shared with other processes.

const { app } = require('electron');
const security = require('./security');
const sessions = require('./sessions');
const tabs = require('./tabs');

const SUMMARY_CACHE_MS = 10 * 1000;
const FAVICON_DATA_MAX = 8192;   // larger data: favicons are dropped to keep the 2 s payload small
const TITLE_MAX = 300;
const URL_MAX = 2048;

let cachedKB = { at: 0, kb: 0 };

const round1 = (n) => Math.round(n * 10) / 10;
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

function readMetrics() {
  try {
    return app.getAppMetrics() || [];
  } catch {
    return [];
  }
}

// ProcessMetric.memory values are in KB.
function processKB(p) {
  const m = p && p.memory;
  if (!m) return 0;
  const priv = Number(m.privateBytes);
  const v = priv > 0 ? priv : Number(m.workingSetSize);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function processCpu(p) {
  const v = p && p.cpu ? Number(p.cpu.percentCPUUsage) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function sumKB(metrics) {
  let kb = 0;
  for (const p of metrics) kb += processKB(p);
  return kb;
}

function liveWebContents(tab) {
  const wc = tab.view && tab.view.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function osPid(wc) {
  try {
    const pid = wc.getOSProcessId();
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function faviconOf(tab) {
  const f = tab.favicon;
  if (typeof f !== 'string' || !f) return '';
  if (/^https:\/\//i.test(f) && f.length <= URL_MAX) return f;
  if (/^data:image\//i.test(f) && f.length <= FAVICON_DATA_MAX) return f;
  return '';
}

function senderIncognito(event) {
  try {
    return sessions.isIncognitoSession(event.sender.session);
  } catch {
    return false;
  }
}

// Shape (preload/internal.js): { totalMB, cpuPercent, otherMB, sleeping, tabs: [...] }.
// Only tabs of the caller's kind are listed (incognito pages see incognito tabs, others see normal
// tabs); totals and otherMB cover the whole browser because they are process-level numbers.
function snapshot(opts = {}) {
  const incognito = opts.incognito === true;
  const metrics = readMetrics();
  cachedKB = { at: Date.now(), kb: sumKB(metrics) };

  const procs = new Map(); // pid -> { kb, cpu }
  let totalKB = 0;
  let totalCpu = 0;
  for (const p of metrics) {
    const kb = processKB(p);
    const cpu = processCpu(p);
    totalKB += kb;
    totalCpu += cpu;
    if (Number.isInteger(p.pid)) procs.set(p.pid, { kb, cpu });
  }

  // Pass 1: every tab, to attribute processes across windows before filtering.
  const entries = [];
  const byPid = new Map(); // pid -> [entry]
  for (const { manager, tab } of tabs.allTabs()) {
    const wc = liveWebContents(tab);
    const entry = { manager, tab, wc, pid: wc ? osPid(wc) : 0, row: null };
    entries.push(entry);
    if (entry.pid > 0) {
      let group = byPid.get(entry.pid);
      if (!group) byPid.set(entry.pid, (group = []));
      group.push(entry);
    }
  }

  let attributedKB = 0;
  for (const [pid, group] of byPid) {
    const info = procs.get(pid);
    if (!info) continue;
    attributedKB += info.kb;
    const n = group.length;
    for (const e of group) {
      e.memoryMB = round1(info.kb / 1024 / n);
      e.cpuPercent = round1(info.cpu / n);
      e.shared = n > 1;
    }
  }

  // Pass 2: rows for the caller's kind of window.
  const rows = [];
  let sleeping = 0;
  for (const e of entries) {
    if (e.manager.incognito !== incognito) continue;
    const discarded = !e.wc;
    if (discarded) sleeping++;
    rows.push({
      tabId: e.tab.id,
      windowId: e.manager.state ? e.manager.state.id : 0,
      title: clip(e.tab.title || e.tab.url || '', TITLE_MAX),
      url: clip(e.tab.url || '', URL_MAX),
      favicon: faviconOf(e.tab),
      memoryMB: discarded ? 0 : (e.memoryMB || 0),
      cpuPercent: discarded ? 0 : (e.cpuPercent || 0),
      discarded,
      active: e.tab.id === e.manager.activeId,
      audible: !!e.tab.isAudible,
      shared: !discarded && !!e.shared,
    });
  }

  return {
    totalMB: round1(totalKB / 1024),
    cpuPercent: round1(totalCpu),
    otherMB: round1(Math.max(0, totalKB - attributedKB) / 1024),
    sleeping,
    tabs: rows,
  };
}

// Cheap: one process list (cached for 10 s, so the home footer does not reset the CPU sampling
// interval that the panel relies on) and a count of tabs without a live view. No per-tab joins.
function summary(opts = {}) {
  const incognito = opts.incognito === true;
  const now = Date.now();
  if (now - cachedKB.at > SUMMARY_CACHE_MS) cachedKB = { at: now, kb: sumKB(readMetrics()) };
  let sleeping = 0;
  for (const { manager, tab } of tabs.allTabs()) {
    if (manager.incognito === incognito && !liveWebContents(tab)) sleeping++;
  }
  return { memoryMB: round1(cachedKB.kb / 1024), sleeping };
}

function sleepTab(tabId, incognito) {
  if (!Number.isInteger(tabId) || tabId <= 0) return false;
  const hit = tabs.allTabs().find((x) => x.tab.id === tabId);
  if (!hit || hit.manager.incognito !== incognito) return false;
  return tabs.discardTab(hit.manager, tabId);
}

// Sleeps every tab that can sleep (inactive, silent, loaded) in the caller's kind of windows.
function sleepAll(incognito) {
  let n = 0;
  for (const { manager, tab } of tabs.allTabs()) {
    if (manager.incognito !== incognito) continue;
    if (tabs.discardTab(manager, tab.id)) n++;
  }
  return n;
}

function registerIpc(ipcMain) {
  ipcMain.handle('performance:snapshot', (event) => {
    if (!security.isInternalSender(event)) return null;
    return snapshot({ incognito: senderIncognito(event) });
  });
  ipcMain.handle('performance:sleep-tab', (event, tabId) => {
    if (!security.isInternalSender(event)) return false;
    return sleepTab(tabId, senderIncognito(event));
  });
  ipcMain.handle('performance:sleep-all', (event) => {
    if (!security.isInternalSender(event)) return 0;
    return sleepAll(senderIncognito(event));
  });
}

module.exports = {
  snapshot,
  summary,
  sleepTab,
  sleepAll,
  registerIpc,
};
