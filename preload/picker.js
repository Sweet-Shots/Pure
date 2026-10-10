// Frame preload for the element picker (Pure 2.3, owner D3). Registered by main/picker.js through
// blocking.registerFramePreload. Sandboxed: only require('electron') is available here.
//
// Top frame of http(s) pages only, and dormant until main sends pure:picker-start to that frame: until then this
// file adds one ipcRenderer listener and nothing else. It exposes nothing to the page (no globals, no contextBridge,
// no DOM ids). The UI lives in a CLOSED shadow root on a host element appended to <html>, so page CSS and page
// scripts cannot reach it. While the picker runs, pointer and keyboard events on the page are stopped in the
// capture phase; the host has pointer-events:none so hit-testing still finds the page element under the cursor,
// and only the panel turns pointer events back on for itself.
//
//   in:  pure:picker-start {mode:'pick'|'zap', css}   from main (top frame only)
//   out: pure:picker-create(filter) -> {ok, message?}  pick mode "Create"; main re-validates the rule
//
// Selector strategy (pick): the clicked element's compound: #id when the id looks stable, else tag + up to two
// stable classes, plus :nth-of-type only when same-tag siblings with the same classes would still match. While the
// selector matches more than one element, up to three ancestors are prepended. Broader/narrower walk the tree. The
// count is a live querySelectorAll that ignores the picker's own host.

'use strict';

const { ipcRenderer } = require('electron');

(function () {
  if (window.top !== window) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  const MAX_CSS = 64 * 1024;
  const MAX_TRAIL = 64;
  const HOST_CSS = 'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important;' +
    ' right: 0 !important; bottom: 0 !important; z-index: 2147483647 !important; display: block !important;' +
    ' pointer-events: none !important; margin: 0 !important; padding: 0 !important; background: none !important;';
  const BOX_CSS = 'position: fixed; left: 0; top: 0; display: none; pointer-events: none; box-sizing: border-box;';
  const PANEL_CSS = 'position: fixed; right: 16px; bottom: 16px; pointer-events: auto;';

  // Events stopped while the picker runs. Our own UI (target = host) is never stopped.
  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick', 'dragstart'];

  let current = null;

  // ── Selector helpers ───────────────────────────────────────────────────────

  const STATE_CLASS = /^(active|open|opened|show|shown|hidden|hide|visible|focus|focused|hover|hovered|selected|checked|disabled|expanded|collapsed|current|is-|has-|ng-|js-|v-)/i;
  const FRAMEWORK_ID = /^(ember|react|radix|headlessui|mui|vue)/i;

  // Long digit runs, css-in-js / CSS-module prefixes, and mixed letter-digit blobs with no separator (hashes).
  function generated(token) {
    if (/\d{3,}/.test(token)) return true;
    if (/^_|^css-|^sc-|^jsx-|^emotion-|^svelte-|^makeStyles-|^Mui[A-Z]/.test(token)) return true;
    return token.length >= 6 && /\d/.test(token) && /[a-z]/i.test(token) && !/[-_]/.test(token);
  }

  function stableId(id) {
    return id.length <= 40 && !id.includes(':') && !FRAMEWORK_ID.test(id) && !generated(id);
  }

  function stableClass(name) {
    return name.length >= 2 && name.length <= 40 && /[a-z]/i.test(name) && !STATE_CLASS.test(name) && !generated(name);
  }

  // Compound selector for one element (without ancestors).
  function part(el) {
    if (el.id && stableId(el.id)) return '#' + CSS.escape(el.id);
    const tag = CSS.escape(el.localName);
    const classes = Array.from(el.classList).filter(stableClass).slice(0, 2);
    let out = tag + classes.map((c) => '.' + CSS.escape(c)).join('');
    const parent = el.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.localName === el.localName);
      const alike = sameTag.filter((c) => classes.every((k) => c.classList.contains(k)));
      if (alike.length > 1) out += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
    return out;
  }

  // Live match count for a selector, not counting the picker's own host. -1 when the selector is invalid.
  function countOf(selector) {
    try {
      const host = current ? current.host : null;
      let n = 0;
      for (const node of document.querySelectorAll(selector)) {
        if (node !== host) n++;
      }
      return n;
    } catch {
      return -1;
    }
  }

  function buildSelector(el) {
    let sel = part(el);
    let count = countOf(sel);
    let node = el;
    for (let depth = 0; count !== 1 && depth < 3; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.documentElement) break;
      node = parent;
      sel = `${part(node)} ${sel}`;
      count = countOf(sel);
    }
    return sel;
  }

  function childToward(el, target) {
    if (!target || target === el || !el.contains(target)) return null;
    for (const child of el.children) {
      if (child.contains(target)) return child;
    }
    return null;
  }

  function elementTag(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function place(node, rect) {
    if (!rect || (rect.width <= 0 && rect.height <= 0)) {
      node.style.display = 'none';
      return;
    }
    node.style.display = 'block';
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    node.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  }

  // ── The picker ─────────────────────────────────────────────────────────────

  class Picker {
    constructor(mode, css) {
      this.mode = mode;
      this.pageHost = location.hostname.toLowerCase();
      this.selected = null; // pick: the element the rule is built from
      this.origin = null; // the element the user first clicked (narrowing target)
      this.trail = []; // elements left by "Broader", for "Narrower"
      this.hover = null;
      this.frame = 0;
      this.removed = 0;
      this.dead = false;

      this.host = document.createElement('div');
      this.host.style.cssText = HOST_CSS;
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = css;
      this.shadow.appendChild(style);

      this.hl = elementTag('div', mode === 'zap' ? 'hl zap' : 'hl');
      this.hl.style.cssText = BOX_CSS;
      this.sel = elementTag('div', 'hl selected');
      this.sel.style.cssText = BOX_CSS;
      this.panel = elementTag('div', mode === 'zap' ? 'panel zap' : 'panel');
      this.panel.style.cssText = PANEL_CSS;
      this.shadow.append(this.hl, this.sel, this.panel);
      this.buildPanel();

      this.listeners = [];
      this.on(window, 'pointermove', (e) => this.onMove(e), true);
      for (const type of BLOCKED) this.on(window, type, (e) => this.onBlock(e), true);
      this.on(window, 'click', (e) => this.onClick(e), true);
      this.on(window, 'contextmenu', (e) => this.onContext(e), true);
      this.on(window, 'keydown', (e) => this.onKey(e), true);
      this.on(window, 'scroll', () => this.schedule(), { capture: true, passive: true });
      this.on(window, 'resize', () => this.schedule(), true);
      this.on(window, 'pagehide', () => this.finish(), true);

      document.documentElement.appendChild(this.host);
      if (mode === 'zap') this.msg('Click an element to remove it. Esc or right-click to finish.');
      else this.msg('Click the element to block.');
    }

    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      this.listeners.push([target, type, fn, opts]);
    }

    buildPanel() {
      const head = elementTag('div', 'panel-head');
      this.titleEl = elementTag('span', 'panel-title', this.mode === 'zap' ? 'Zap element' : 'Block element');
      this.countEl = elementTag('span', 'panel-count');
      head.append(this.titleEl, this.countEl);
      this.panel.appendChild(head);

      if (this.mode === 'zap') {
        this.panel.appendChild(elementTag('div', 'panel-hint',
          'Removes the element from this page only. It comes back when the page reloads.'));
        this.msgEl = elementTag('div', 'panel-msg');
        this.panel.appendChild(this.msgEl);
        const actions = elementTag('div', 'panel-actions');
        actions.appendChild(this.button('done', 'Done', 'btn btn-primary'));
        this.panel.appendChild(actions);
        this.panel.addEventListener('click', (e) => this.onPanelClick(e));
        return;
      }

      this.input = elementTag('input', 'panel-input');
      this.input.type = 'text';
      this.input.spellcheck = false;
      this.input.autocomplete = 'off';
      this.input.setAttribute('aria-label', 'Filter rule');
      this.input.addEventListener('input', () => this.refresh());
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.create();
        }
      });
      this.panel.appendChild(this.input);

      const row = elementTag('div', 'panel-row');
      this.btnBroader = this.button('broader', 'Broader', 'btn');
      this.btnBroader.title = 'Select the parent element';
      this.btnNarrower = this.button('narrower', 'Narrower', 'btn');
      this.btnNarrower.title = 'Select a child element';
      row.append(this.btnBroader, this.btnNarrower);
      this.panel.appendChild(row);

      this.msgEl = elementTag('div', 'panel-msg');
      this.panel.appendChild(this.msgEl);

      const actions = elementTag('div', 'panel-actions');
      this.btnCreate = this.button('create', 'Create', 'btn btn-primary');
      actions.append(this.button('cancel', 'Cancel', 'btn'), this.btnCreate);
      this.panel.appendChild(actions);
      this.panel.addEventListener('click', (e) => this.onPanelClick(e));
    }

    button(act, label, className) {
      const b = elementTag('button', className, label);
      b.type = 'button';
      b.dataset.act = act;
      return b;
    }

    msg(text, isError) {
      if (!this.msgEl) return;
      this.msgEl.textContent = text;
      this.msgEl.className = isError ? 'panel-msg error' : 'panel-msg';
    }

    // ── events ──

    onPanelClick(e) {
      const b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!b || b.disabled || this.dead) return;
      switch (b.dataset.act) {
        case 'broader': this.broader(); break;
        case 'narrower': this.narrow(); break;
        case 'create': this.create(); break;
        case 'cancel':
        case 'done': this.finish(); break;
        default: break;
      }
    }

    onMove(e) {
      if (this.dead) return;
      const t = e.target;
      // Over our own panel (target is the host) or the root element: no page element to highlight.
      this.hover = t instanceof Element && t !== this.host && t !== document.documentElement ? t : null;
      this.schedule();
    }

    onBlock(e) {
      if (e.target === this.host) return;
      e.preventDefault();
      e.stopPropagation();
    }

    onClick(e) {
      if (e.target === this.host) return;
      e.preventDefault();
      e.stopPropagation();
      const t = e.target;
      if (!(t instanceof Element) || t === document.documentElement) return;
      if (this.mode === 'zap') this.zap(t);
      else this.choose(t);
    }

    onContext(e) {
      if (e.target === this.host) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.mode === 'zap') this.finish();
    }

    onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.finish();
    }

    // ── painting ──

    schedule() {
      if (this.frame || this.dead) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint();
      });
    }

    paint() {
      if (this.dead) return;
      const hoverOk = this.hover && this.hover.isConnected;
      place(this.hl, hoverOk ? this.hover.getBoundingClientRect() : null);
      const selOk = this.selected && this.selected.isConnected;
      place(this.sel, selOk ? this.selected.getBoundingClientRect() : null);
    }

    // ── pick mode ──

    choose(el) {
      this.selected = el;
      this.origin = el;
      this.trail = [];
      this.renderSelection();
      this.msg('Adjust the rule if needed, then press Create.');
      this.input.focus({ preventScroll: true });
    }

    renderSelection() {
      this.input.value = `${this.pageHost}##${buildSelector(this.selected)}`;
      this.refresh();
      this.updateNav();
      this.schedule();
    }

    // Reads the editable filter. Returns {selector} or {error}.
    parseInput() {
      const prefix = `${this.pageHost}##`;
      const value = this.input.value.trim();
      if (value.slice(0, prefix.length).toLowerCase() !== prefix) {
        return { error: `Start the rule with ${this.pageHost}##` };
      }
      const selector = value.slice(prefix.length).trim();
      if (!selector) return { error: 'Enter a selector.' };
      return { selector };
    }

    refresh() {
      if (this.dead) return;
      const parsed = this.parseInput();
      let n = -1;
      if (parsed.selector) n = countOf(parsed.selector);
      if (parsed.error) this.countEl.textContent = '';
      else if (n < 0) this.countEl.textContent = 'invalid selector';
      else if (n === 0) this.countEl.textContent = 'matches no elements';
      else if (n === 1) this.countEl.textContent = 'matches 1 element';
      else this.countEl.textContent = `matches ${n} elements`;
      this.btnCreate.disabled = !!parsed.error || n < 0;
      if (parsed.error && this.input.value) this.msg(parsed.error, true);
      else if (!parsed.error && this.msgEl.classList.contains('error')) this.msg('');
    }

    updateNav() {
      const cur = this.selected;
      const parent = cur ? cur.parentElement : null;
      this.btnBroader.disabled = !parent || parent === document.documentElement;
      this.btnNarrower.disabled = !cur || !this.canNarrow();
    }

    canNarrow() {
      const cur = this.selected;
      if (!cur) return false;
      if (this.trail.some((t) => t && t.isConnected && t !== cur && cur.contains(t))) return true;
      return !!childToward(cur, this.origin);
    }

    broader() {
      const cur = this.selected;
      const parent = cur ? cur.parentElement : null;
      if (!parent || parent === document.documentElement) return;
      if (this.trail.length >= MAX_TRAIL) this.trail.shift();
      this.trail.push(cur);
      this.selected = parent;
      this.renderSelection();
    }

    narrow() {
      const cur = this.selected;
      if (!cur) return;
      let next = null;
      while (this.trail.length && !next) {
        const t = this.trail.pop();
        if (t && t.isConnected && t !== cur && cur.contains(t)) next = t;
      }
      if (!next) next = childToward(cur, this.origin);
      if (!next) {
        this.updateNav();
        return;
      }
      this.selected = next;
      this.renderSelection();
    }

    create() {
      if (this.dead || this.mode !== 'pick') return;
      const parsed = this.parseInput();
      if (parsed.error || countOf(parsed.selector) < 0) {
        this.refresh();
        return;
      }
      this.btnCreate.disabled = true;
      ipcRenderer.invoke('pure:picker-create', this.input.value.trim()).then(
        (res) => {
          if (this.dead) return;
          if (res && res.ok) {
            this.finish();
            return;
          }
          this.btnCreate.disabled = false;
          this.msg((res && res.message) || 'Could not add the rule.', true);
        },
        () => {
          if (this.dead) return;
          this.btnCreate.disabled = false;
          this.msg('Could not add the rule.', true);
        },
      );
    }

    // ── zap mode ──

    zap(el) {
      if (!el.isConnected || el === document.documentElement) return;
      el.remove();
      this.removed++;
      this.hover = null;
      place(this.hl, null);
      this.msg(this.removed === 1 ? 'Removed 1 element.' : `Removed ${this.removed} elements.`);
    }

    // ── lifecycle ──

    finish() {
      if (this.dead) return;
      this.dead = true;
      for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
      this.listeners = [];
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.host.remove();
      this.selected = null;
      this.origin = null;
      this.trail = [];
      this.hover = null;
      if (current === this) current = null;
    }
  }

  function begin(msg) {
    endCurrent();
    if (!msg || typeof msg !== 'object') return;
    const mode = msg.mode === 'zap' ? 'zap' : 'pick';
    const css = typeof msg.css === 'string' && msg.css.length > 0 && msg.css.length <= MAX_CSS ? msg.css : '';
    current = new Picker(mode, css);
  }

  function endCurrent() {
    if (current) current.finish();
    current = null;
  }

  ipcRenderer.on('pure:picker-start', (_event, msg) => {
    try {
      begin(msg);
    } catch (_err) {
      endCurrent();
    }
  });
})();
