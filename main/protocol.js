'use strict';
// pure:// protocol: serves the browser UI, the internal pages and their assets from renderer/.
// registerSchemes() must run before app ready; handle(session) runs once per session.
// Files are streamed (no whole-file buffering) and every path is checked against its host folder.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { protocol } = require('electron');
const { log } = require('./logger');

const SCHEME = 'pure';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// URL host -> folder under renderer/ (ARCHITECTURE.md "Internal URLs").
const HOSTS = {
  browser: 'browser',
  home: path.join('pages', 'home'),
  settings: path.join('pages', 'settings'),
  error: path.join('pages', 'error'),
  reader: path.join('pages', 'reader'),
  assets: 'assets',
};

// Internal pages: must match ARCHITECTURE.md exactly.
const INTERNAL_CSP =
  "default-src 'self'; img-src 'self' data: https:; connect-src 'self' https://api.open-meteo.com; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// Reader view: article images may be http or https; no network access for scripts.
const READER_CSP =
  "default-src 'self'; img-src 'self' data: https: http:; connect-src 'none'; media-src 'none'; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// Browser UI: favicons can come from any site, so img-src allows data/https/http.
const BROWSER_CSP =
  "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; object-src 'none'; base-uri 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const handledSessions = new WeakSet();

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Maps (host, pathname) to an absolute path inside the host folder, or null when the request is unsafe.
// pathname is percent-encoded; it is decoded exactly once, so %252e%252e stays a literal (harmless) name.
function resolveFile(host, pathname) {
  const folder = HOSTS[host];
  if (!folder) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s === '..')) return null;
  const root = path.resolve(RENDERER_DIR, folder);
  const target = path.resolve(root, ...segments);
  return isInside(root, target) ? target : null;
}

async function statOrNull(p) {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

function text(status, message, extra = {}) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

async function serve(request) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }

    // Web content may never load pure:// (navigation, frames, scripts, fetch, redirects).
    // Requests the browser starts itself carry no initiatorOrigin; anything else must come from a pure:// page.
    const initiator = request.initiatorOrigin;
    if (initiator !== undefined && !(typeof initiator === 'string' && initiator.startsWith(SCHEME + ':'))) {
      return text(403, 'Forbidden');
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return text(400, 'Bad request');
    }
    const host = url.hostname.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(HOSTS, host)) return text(404, 'Not found');

    let file = resolveFile(host, url.pathname);
    if (!file) return text(403, 'Forbidden');

    let stat = await statOrNull(file);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await statOrNull(file);
    }
    if (!stat?.isFile()) return text(404, 'Not found');

    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Security-Policy': host === 'browser' ? BROWSER_CSP : host === 'reader' ? READER_CSP : INTERNAL_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
  } catch (err) {
    log('[protocol] request failed:', request?.url, err);
    return text(500, 'Internal error');
  }
}

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        codeCache: true,
      },
    },
  ]);
}

// Attach the pure:// handler to a session. Idempotent per session.
function handle(ses) {
  if (!ses || handledSessions.has(ses)) return;
  handledSessions.add(ses);
  try {
    ses.protocol.handle(SCHEME, serve);
  } catch (err) {
    log('[protocol] could not handle pure:// on session:', err);
  }
}

module.exports = { SCHEME, registerSchemes, handle, resolveFile };
