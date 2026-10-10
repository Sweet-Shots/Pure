// Static checks for the whole project: syntax of every JS file + the DOM/CSP contract.
// Usage: npm run check
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let failures = 0;
const fail = (msg) => { failures++; console.error('✗ ' + msg); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '_reference') continue;
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

const files = walk(root);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pure-check-'));

// 1. Syntax. Browser UI JS is ES modules; everything else is CommonJS / classic scripts.
for (const f of files.filter((f) => f.endsWith('.js'))) {
  const rel = path.relative(root, f);
  let target = f;
  if (rel.startsWith(path.join('renderer', 'browser', 'js'))) {
    target = path.join(tmp, path.basename(f, '.js') + '.mjs');
    fs.copyFileSync(f, target);
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax: ${rel}\n${r.stderr}`);
}

// 2. Browser UI DOM contract.
const REQUIRED_IDS = `titlebar tabs-scroll tabs tab-drop-indicator btn-new-tab btn-wmin btn-wmax btn-wclose
toolbar btn-back btn-forward btn-reload icon-reload icon-stop btn-home address-wrap lock-icon address-bar
zoom-indicator btn-bookmark suggestions btn-bookmarks-toggle btn-downloads downloads-progress btn-incognito
btn-settings bookmark-sidebar bookmark-list findbar find-input find-count find-prev find-next find-close views
loader page-freeze statusbar status-text welcome-overlay welcome-version welcome-logo welcome-tagline
welcome-status btn-shield shield-count shield-popover shield-host shield-toggle shield-blocked shield-list
site-popover site-host site-status site-perms site-cookies site-blocked site-zoom btn-reader ext-actions pw-bar
pw-bar-text palette palette-input palette-list palette-empty split-divider focus-reveal group-editor group-title
group-colors shield-pick shield-zap toast-host shield-level shield-report`.split(/\s+/);
const indexHtml = fs.readFileSync(path.join(root, 'renderer/browser/index.html'), 'utf8');
for (const id of REQUIRED_IDS) {
  if (!new RegExp(`id=["']${id}["']`).test(indexHtml)) fail(`browser/index.html missing #${id}`);
}

// 2b. 2.1 contracts for internal pages.
const PAGE_IDS = {
  'renderer/pages/home/index.html': `greeting search-input quick-links quick-link-modal widget-board widget-tray home-stats
    news-topics news-list news-status clock weather weather-condition weather-icon forecast reading-list notes-input notes-status`,
  'renderer/pages/settings/index.html': `theme-select accent-picker blocking-toggle stat-today stat-week stat-total stat-data-saved
    stat-chart top-blocked-list shield-exceptions-list performance lite-mode-toggle smart-sleep-toggle tab-discard-select
    perf-total perf-list import import-sources import-status import-bookmarks-cb import-history-cb import-settings-cb
    news-images-toggle home-stats-toggle news-sources widget-news-toggle widget-weather-toggle widget-reading-toggle
    widget-notes-toggle passwords save-passwords-toggle pw-search pw-list pw-never-list extensions ext-list
    ext-status cookie-banners-toggle doh-mode-select doh-provider-select doh-custom-input force-dark-toggle
    vertical-tabs-toggle focus-mode-toggle update-status update-progress auto-update-toggle filter-lists
    filter-lists-groups fl-add-url fl-status my-filters my-filters-input my-filters-status
    sites sites-search sites-list https-mode-select clear-on-exit-history-cb clear-on-exit-cookies-cb clear-on-exit-cache-cb
    clear-on-exit-downloads-cb risky-downloads-toggle`,
  'renderer/pages/error/index.html': `error-continue-http`,
  'renderer/pages/reader/index.html': `reader-toolbar reader-article reader-title reader-meta reader-content reader-error`,
};
for (const [file, ids] of Object.entries(PAGE_IDS)) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { fail(`${file} missing`); continue; }
  const html = fs.readFileSync(full, 'utf8');
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    if (!new RegExp(`id=["']${id}["']`).test(html)) fail(`${file} missing #${id}`);
  }
}

// 3. No inline scripts / handlers in any HTML (CSP forbids them).
for (const f of files.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) fail(`${rel}: inline on*= handler`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(`${rel}: inline <script>`);
  if (/localhost:3000/.test(html)) fail(`${rel}: references old localhost server`);
}

// 4. Banned APIs.
for (const f of files.filter((f) => f.endsWith('.js') && !f.includes('scripts'))) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  if (/globalShortcut/.test(src)) fail(`${rel}: globalShortcut is banned (use before-input-event)`);
  if (/webSecurity\s*:\s*false/.test(src)) fail(`${rel}: webSecurity:false`);
  if (/nodeIntegration\s*:\s*true/.test(src)) fail(`${rel}: nodeIntegration:true`);
  if (/require\(['"]express['"]\)/.test(src)) fail(`${rel}: express is banned`);
  if (/<webview|createElement\(['"]webview/.test(src)) fail(`${rel}: <webview> is banned (use WebContentsView)`);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} problem(s).`); process.exit(1); }
console.log('✓ all checks passed');
