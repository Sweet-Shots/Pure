'use strict';
// main/dns.js — secure DNS (DNS-over-HTTPS) per settings (C1, Pure 2.2).
// init() applies the current settings once the default session exists; storage.settings.onChange re-applies
// on every change. app.configureHostResolver is cheap, but it is skipped when the effective config is unchanged.
//
// Modes (settings.dohMode): off → no DoH; automatic → DoH first, insecure DNS as fallback; secure → DoH only.
// Providers (settings.dohProvider) map to fixed templates; custom uses settings.dohCustomUrl (https only).
// A custom URL that is empty or invalid, or a "secure" mode with no server, falls back to automatic with no
// servers, so name resolution never breaks.

const { app } = require('electron');
const { log } = require('./logger');
const storage = require('./storage');

const TEMPLATES = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query{?dns}',
  quad9: 'https://dns.quad9.net/dns-query',
  nextdns: 'https://dns.nextdns.io',
};

let lastKey = null;
let hooked = false;

function effectiveConfig(settings) {
  const mode = settings.dohMode === 'off' || settings.dohMode === 'secure' ? settings.dohMode : 'automatic';
  if (mode === 'off') return { secureDnsMode: 'off', secureDnsServers: [] };

  let servers = [];
  if (settings.dohProvider === 'custom') {
    const url = typeof settings.dohCustomUrl === 'string' ? settings.dohCustomUrl.trim() : '';
    if (url.startsWith('https://') && url.length <= 300) servers = [url];
  } else if (TEMPLATES[settings.dohProvider]) {
    servers = [TEMPLATES[settings.dohProvider]];
  }

  if (!servers.length) return { secureDnsMode: 'automatic', secureDnsServers: [] };
  return { secureDnsMode: mode, secureDnsServers: servers };
}

function apply(settings) {
  try {
    const config = effectiveConfig(settings);
    const key = JSON.stringify(config);
    if (key === lastKey) return;
    app.configureHostResolver(config);
    lastKey = key;
  } catch (err) {
    log('[dns] configureHostResolver failed:', err && err.message);
  }
}

function init() {
  apply(storage.settings.get());
  if (!hooked) {
    hooked = true;
    storage.settings.onChange((settings) => apply(settings));
  }
}

module.exports = { init, effectiveConfig };
