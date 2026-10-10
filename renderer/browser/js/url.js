// URL helpers: address-bar input resolution and display rules.

const SCHEME_RE = /^(?:https?|pure|file):\/\/|^(?:about|view-source):/i;
const LOCAL_RE = /^localhost(?::\d{1,5})?(?:[/?#]|$)/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]|$)/;
const IPV6_RE = /^\[[0-9a-f:.]+\](?::\d{1,5})?(?:[/?#]|$)/i;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

// Turns address-bar text into a navigable URL: explicit scheme as-is, localhost/IP -> http,
// domain-looking text -> https, anything else -> search with the given prefix.
export function resolveInput(raw, searchPrefix) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if (SCHEME_RE.test(text)) return text;
  if (!/\s/.test(text)) {
    if (LOCAL_RE.test(text) || IPV4_RE.test(text) || IPV6_RE.test(text)) return `http://${text}`;
    if (DOMAIN_RE.test(text)) return `https://${text}`;
  }
  return searchPrefix + encodeURIComponent(text);
}

// The address bar shows nothing for the home page, and the URL otherwise.
export function displayUrl(url) {
  if (!url || isHomeUrl(url)) return '';
  return url;
}

export function isHomeUrl(url) {
  return !!url && url.startsWith('pure://home');
}

export function isSettingsUrl(url) {
  return !!url && url.startsWith('pure://settings');
}

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}
