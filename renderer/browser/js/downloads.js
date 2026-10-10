// Downloads button: hidden until a download exists, .active while any is progressing, and an
// aggregate --progress (0-1) on #downloads-progress (a hidden span inside the button).

import { S } from './state.js';
import { $, pure } from './util.js';

const btn = $('btn-downloads');
const prog = $('downloads-progress');

function render() {
  const all = [...S.downloads.values()];
  btn.hidden = all.length === 0;
  let active = 0;
  let received = 0;
  let total = 0;
  for (const d of all) {
    if (d.state !== 'progressing') continue;
    active++;
    if (d.totalBytes > 0) {
      received += d.receivedBytes || 0;
      total += d.totalBytes;
    }
  }
  btn.classList.toggle('active', active > 0);
  prog.hidden = active === 0;
  const p = total > 0 ? Math.min(1, received / total) : 0;
  prog.style.setProperty('--progress', p.toFixed(3));
}

export function setDownloads(list) {
  S.downloads.clear();
  for (const d of Array.isArray(list) ? list : []) S.downloads.set(String(d.id), d);
  render();
}

export function updateDownload(d) {
  const k = String(d.id);
  S.downloads.set(k, { ...(S.downloads.get(k) || {}), ...d });
  render();
}

export function initDownloads() {
  btn.addEventListener('click', () => pure.downloads.showMenu());
  render();
}
