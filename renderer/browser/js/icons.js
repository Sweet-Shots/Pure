// Icons: Lucide (ISC License, https://lucide.dev), path data from lucide-static 1.54.0.
// Licence text: renderer/assets/icons/LICENSE-lucide.txt. Nodes are built with createElementNS
// from this static table, so no markup is parsed at runtime.

const NS = 'http://www.w3.org/2000/svg';

const ATTRS = {
  'width': '16',
  'height': '16',
  'viewBox': '0 0 24 24',
  'fill': 'none',
  'stroke': 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
  'focusable': 'false',
};

const SHAPES = {
  'x': [
    ['path', { 'd': 'M18 6 6 18' }],
    ['path', { 'd': 'm6 6 12 12' }],
  ],
  'volume-2': [
    ['path', { 'd': 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z' }],
    ['path', { 'd': 'M16 9a5 5 0 0 1 0 6' }],
    ['path', { 'd': 'M19.364 18.364a9 9 0 0 0 0-12.728' }],
  ],
  'volume-x': [
    ['path', { 'd': 'M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z' }],
    ['path', { 'd': 'm16.5 14.5 5-5' }],
    ['path', { 'd': 'm16.5 9.5 5 5' }],
  ],
  'moon': [
    ['path', { 'd': 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401' }],
  ],
  'globe': [
    ['circle', { 'cx': '12', 'cy': '12', 'r': '10' }],
    ['path', { 'd': 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
    ['path', { 'd': 'M2 12h20' }],
  ],
  'triangle-alert': [
    ['path', { 'd': 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
    ['path', { 'd': 'M12 9v4' }],
    ['path', { 'd': 'M12 17h.01' }],
  ],
  'star': [
    ['path', { 'd': 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z' }],
  ],
  'history': [
    ['path', { 'd': 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
    ['path', { 'd': 'M3 3v5h5' }],
    ['path', { 'd': 'M12 7v5l4 2' }],
  ],
  'search': [
    ['path', { 'd': 'm21 21-4.34-4.34' }],
    ['circle', { 'cx': '11', 'cy': '11', 'r': '8' }],
  ],
  // 2.2 — palette actions, site info, focus/vertical/split/reader toggles
  'plus': [
    ['path', { 'd': 'M5 12h14' }],
    ['path', { 'd': 'M12 5v14' }],
  ],
  'app-window': [
    ['rect', { 'x': '2', 'y': '4', 'width': '20', 'height': '16', 'rx': '2' }],
    ['path', { 'd': 'M10 4v4' }],
    ['path', { 'd': 'M2 8h20' }],
    ['path', { 'd': 'M6 4v4' }],
  ],
  'eye-off': [
    ['path', { 'd': 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49' }],
    ['path', { 'd': 'M14.084 14.158a3 3 0 0 1-4.242-4.242' }],
    ['path', { 'd': 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143' }],
    ['path', { 'd': 'm2 2 20 20' }],
  ],
  'undo-2': [
    ['path', { 'd': 'M9 14 4 9l5-5' }],
    ['path', { 'd': 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }],
  ],
  'panel-left': [
    ['rect', { 'width': '18', 'height': '18', 'x': '3', 'y': '3', 'rx': '2' }],
    ['path', { 'd': 'M9 3v18' }],
  ],
  'bookmark': [
    ['path', { 'd': 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z' }],
  ],
  'book-open': [
    ['path', { 'd': 'M12 5v16' }],
    ['path', { 'd': 'M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z' }],
  ],
  'columns-2': [
    ['rect', { 'width': '18', 'height': '18', 'x': '3', 'y': '3', 'rx': '2' }],
    ['path', { 'd': 'M12 3v18' }],
  ],
  'focus': [
    ['circle', { 'cx': '12', 'cy': '12', 'r': '3' }],
    ['path', { 'd': 'M3 7V5a2 2 0 0 1 2-2h2' }],
    ['path', { 'd': 'M17 3h2a2 2 0 0 1 2 2v2' }],
    ['path', { 'd': 'M21 17v2a2 2 0 0 1-2 2h-2' }],
    ['path', { 'd': 'M7 21H5a2 2 0 0 1-2-2v-2' }],
  ],
  'download': [
    ['path', { 'd': 'M12 15V3' }],
    ['path', { 'd': 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['path', { 'd': 'm7 10 5 5 5-5' }],
  ],
  'sun': [
    ['circle', { 'cx': '12', 'cy': '12', 'r': '4' }],
    ['path', { 'd': 'M12 2v2' }],
    ['path', { 'd': 'M12 20v2' }],
    ['path', { 'd': 'm4.93 4.93 1.41 1.41' }],
    ['path', { 'd': 'm17.66 17.66 1.41 1.41' }],
    ['path', { 'd': 'M2 12h2' }],
    ['path', { 'd': 'M20 12h2' }],
    ['path', { 'd': 'm6.34 17.66-1.41 1.41' }],
    ['path', { 'd': 'm19.07 4.93-1.41 1.41' }],
  ],
  'monitor': [
    ['rect', { 'width': '20', 'height': '14', 'x': '2', 'y': '3', 'rx': '2' }],
    ['path', { 'd': 'M8 21h8' }],
    ['path', { 'd': 'M12 17v4' }],
  ],
  'settings': [
    ['path', { 'd': 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }],
    ['circle', { 'cx': '12', 'cy': '12', 'r': '3' }],
  ],
  'trash-2': [
    ['path', { 'd': 'M10 11v6' }],
    ['path', { 'd': 'M14 11v6' }],
    ['path', { 'd': 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }],
    ['path', { 'd': 'M3 6h18' }],
    ['path', { 'd': 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
  ],
  'shield': [
    ['path', { 'd': 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
  ],
  'lock': [
    ['rect', { 'width': '18', 'height': '11', 'x': '3', 'y': '11', 'rx': '2', 'ry': '2' }],
    ['path', { 'd': 'M7 11V7a5 5 0 0 1 10 0v4' }],
  ],
  'lock-open': [
    ['rect', { 'width': '18', 'height': '11', 'x': '3', 'y': '11', 'rx': '2', 'ry': '2' }],
    ['path', { 'd': 'M7 11V7a5 5 0 0 1 9.9-1' }],
  ],
};

const cache = new Map();

function build(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  for (const k of Object.keys(ATTRS)) svg.setAttribute(k, ATTRS[k]);
  for (const [tag, attrs] of SHAPES[name] || []) {
    const node = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    svg.append(node);
  }
  return svg;
}

// icon('x') -> <svg class="icon">. extraClass is appended to the class list. A label gives the
// icon an accessible name and a tooltip instead of aria-hidden.
export function icon(name, extraClass, label) {
  let base = cache.get(name);
  if (!base) {
    base = build(name);
    cache.set(name, base);
  }
  const svg = base.cloneNode(true);
  if (extraClass) svg.setAttribute('class', `icon ${extraClass}`);
  if (label) {
    svg.removeAttribute('aria-hidden');
    svg.setAttribute('role', 'img');
    const title = document.createElementNS(NS, 'title');
    title.textContent = label;
    svg.prepend(title);
  }
  return svg;
}
