// Accent colour. Incognito windows are forced to red.
// Light/dark is NOT switched here: main sets nativeTheme.themeSource, which drives
// prefers-color-scheme; every stylesheet overrides its tokens under that media query.

import { S } from './state.js';

const DEFAULT_ACCENT = '#4f8ef7';
const INCOGNITO_ACCENT = '#c04040';
const INCOGNITO_ACCENT_DIM = '#6b2020';
const HEX_RE = /^#[0-9a-f]{6}$/i;

// Same darkening as 1.1.1: each channel scaled by 0.35.
function dim(hex, factor = 0.35) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 255) * factor).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export function applyTheme() {
  const root = document.documentElement;
  if (S.incognito) {
    root.style.setProperty('--accent', INCOGNITO_ACCENT);
    root.style.setProperty('--accent-dim', INCOGNITO_ACCENT_DIM);
  } else {
    const configured = S.settings.accentColor;
    const accent = HEX_RE.test(configured || '') ? configured : DEFAULT_ACCENT;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-dim', dim(accent));
  }
  delete root.dataset.theme;
}
