/* Pure new-tab page: helpers shared by widgets.js and home.js. Classic script, loaded first.
 * Owner: B3. Exposes window.PureHome. */
(function () {
  'use strict';

  /* ICON-SHAPES:BEGIN */
  const ICON_ATTRS = {
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
  const ICON_SHAPES = {
    'x': [
      ['path', { 'd': 'M18 6 6 18' }],
      ['path', { 'd': 'm6 6 12 12' }],
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
    'cloud-sun': [
      ['path', { 'd': 'M12 2v2' }],
      ['path', { 'd': 'm4.93 4.93 1.41 1.41' }],
      ['path', { 'd': 'M20 12h2' }],
      ['path', { 'd': 'm19.07 4.93-1.41 1.41' }],
      ['path', { 'd': 'M15.947 12.65a4 4 0 0 0-5.925-4.128' }],
      ['path', { 'd': 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z' }],
    ],
    'cloud': [
      ['path', { 'd': 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }],
    ],
    'cloud-fog': [
      ['path', { 'd': 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
      ['path', { 'd': 'M16 17H7' }],
      ['path', { 'd': 'M17 21H9' }],
    ],
    'cloud-drizzle': [
      ['path', { 'd': 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
      ['path', { 'd': 'M8 19v1' }],
      ['path', { 'd': 'M8 14v1' }],
      ['path', { 'd': 'M16 19v1' }],
      ['path', { 'd': 'M16 14v1' }],
      ['path', { 'd': 'M12 21v1' }],
      ['path', { 'd': 'M12 16v1' }],
    ],
    'cloud-rain': [
      ['path', { 'd': 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
      ['path', { 'd': 'M16 14v6' }],
      ['path', { 'd': 'M8 14v6' }],
      ['path', { 'd': 'M12 16v6' }],
    ],
    'cloud-snow': [
      ['path', { 'd': 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }],
      ['path', { 'd': 'M8 15h.01' }],
      ['path', { 'd': 'M8 19h.01' }],
      ['path', { 'd': 'M12 17h.01' }],
      ['path', { 'd': 'M12 21h.01' }],
      ['path', { 'd': 'M16 15h.01' }],
      ['path', { 'd': 'M16 19h.01' }],
    ],
    'cloud-lightning': [
      ['path', { 'd': 'M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973' }],
      ['path', { 'd': 'm13 12-3 5h4l-3 5' }],
    ],
  };
  /* ICON-SHAPES:END */
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(name, extraClass) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', extraClass ? `icon ${extraClass}` : 'icon');
    for (const k of Object.keys(ICON_ATTRS)) svg.setAttribute(k, ICON_ATTRS[k]);
    for (const [tag, attrs] of ICON_SHAPES[name] || []) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
      svg.append(node);
    }
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function faviconFor(url) {
    try {
      return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(new URL(url).hostname)}.ico`;
    } catch {
      return '';
    }
  }

  function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  window.PureHome = { icon, el, faviconFor, sameJson };
})();
