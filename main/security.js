// Sender validation helpers shared by every ipcMain handler.
// Never trust an IPC message without checking where it came from.

const CHROME_ORIGIN = 'pure://browser';

function senderUrl(event) {
  try {
    return event.senderFrame?.url || event.sender.getURL() || '';
  } catch {
    return '';
  }
}

// The browser UI (tab strip, toolbar) — the only caller allowed to drive tabs.
function isChromeSender(event) {
  return senderUrl(event).startsWith(CHROME_ORIGIN + '/') && event.senderFrame === event.sender.mainFrame;
}

// Internal pages (pure://home, pure://settings, pure://error) — top frame only.
function isInternalSender(event) {
  const url = senderUrl(event);
  return url.startsWith('pure://') && !url.startsWith(CHROME_ORIGIN) && event.senderFrame === event.sender.mainFrame;
}

// Only these schemes may be opened from user input / web content.
const SAFE_NAV_SCHEMES = new Set(['http:', 'https:', 'pure:', 'about:', 'view-source:', 'file:']);
const SAFE_EXTERNAL_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'magnet:', 'zoommtg:', 'msteams:', 'slack:', 'spotify:', 'steam:', 'discord:']);

function parseUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

function isSafeNavigationUrl(raw) {
  const u = parseUrl(raw);
  return !!u && SAFE_NAV_SCHEMES.has(u.protocol);
}

function isSafeExternalUrl(raw) {
  const u = parseUrl(raw);
  return !!u && SAFE_EXTERNAL_SCHEMES.has(u.protocol);
}

module.exports = {
  CHROME_ORIGIN,
  isChromeSender,
  isInternalSender,
  isSafeNavigationUrl,
  isSafeExternalUrl,
  parseUrl,
};
