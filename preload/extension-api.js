// Preload for Chrome extension contexts (MV3 service workers and extension pages). E1, Pure 2.4.
// Registered by main/extension-api.js on the persistent profile session only, as both a 'frame' and a
// 'service-worker' preload. Web pages pay almost nothing: a frame whose URL is not chrome-extension: returns at once,
// and a service worker that is not an extension gets null from the synchronous init and returns too.
//
// What it does for an extension context: asks main which chrome.* APIs this extension may use (sync IPC, once),
// then runs installInWorld() in the MAIN world (contextBridge.executeInMainWorld). That function fills in or
// replaces only the APIs Electron 44 lacks or gets wrong (chrome.action, chrome.tabs methods and events,
// chrome.windows, chrome.contextMenus, chrome.notifications, chrome.cookies, chrome.webNavigation,
// chrome.permissions, chrome.storage.sync). Everything else stays Electron's native implementation.
// installInWorld is serialized by contextBridge, so it must not refer to anything outside its own body.

const { contextBridge, ipcRenderer } = require('electron');

const CH_INIT = 'ext-api:init';
const CH_CALL = 'ext-api:call';
const CH_SUB = 'ext-api:sub';
const CH_EVENT = 'ext-api:event';
const DISPATCH_KEY = 'pure.ext.dispatch';

// Runs in the main world. `call(api, method, args)` returns a Promise of {ok, value | message}; `sub(name, on)` tells
// main which events this context listens to; `info` is main's answer to the init call.
function installInWorld(call, sub, info) {
  const chromeObj = globalThis.chrome;
  if (!chromeObj || globalThis.__pureExtInstalled) return;
  globalThis.__pureExtInstalled = true;

  const listeners = new Map(); // event name -> Set<fn>
  const events = new Map(); // event name -> event object (shared, so menus.* and contextMenus.* match)

  const setLastError = (message) => {
    try {
      chromeObj.runtime.lastError = message === undefined ? undefined : { message };
    } catch (e) {
      /* read-only in some contexts: callbacks still run */
    }
  };

  // Chrome event object. Subscribing the first listener tells main; removing the last one tells it to stop.
  function getEvent(name) {
    if (events.has(name)) return events.get(name);
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    const ev = {
      addListener(fn) {
        if (typeof fn !== 'function') throw new TypeError('addListener expects a function');
        if (set.has(fn)) return;
        const first = set.size === 0;
        set.add(fn);
        if (first) sub(name, true);
      },
      removeListener(fn) {
        if (set.delete(fn) && set.size === 0) sub(name, false);
      },
      hasListener(fn) {
        return set.has(fn);
      },
      hasListeners() {
        return set.size > 0;
      },
    };
    events.set(name, ev);
    return ev;
  }

  // Main pushes events here (through the preload). Listener errors stay in the listener.
  globalThis[Symbol.for('pure.ext.dispatch')] = function (name, args) {
    const set = listeners.get(name);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(...(Array.isArray(args) ? args : []));
      } catch (err) {
        console.error('[extension event] ' + name, err);
      }
    }
  };

  // Promise-or-callback wrapper around one main-process call.
  function invoke(api, method, args) {
    let cb = null;
    if (args.length && typeof args[args.length - 1] === 'function') cb = args.pop();
    const p = call(api, method, args).then((res) => {
      if (!res || res.ok !== true) throw new Error((res && res.message) || 'Unknown error.');
      return res.value === null ? undefined : res.value;
    });
    if (!cb) return p;
    p.then(
      (value) => cb(value),
      (err) => {
        setLastError((err && err.message) || 'Unknown error.');
        try {
          cb();
        } finally {
          setLastError(undefined);
        }
      }
    );
    return undefined;
  }

  const method = (api, name) => (...args) => invoke(api, name, args);

  // setIcon({imageData}): ImageData (or {size: ImageData}) becomes {width, height, data: base64 RGBA}.
  function plainIconDetails(details) {
    if (!details || typeof details !== 'object' || details.imageData === undefined) return details;
    const out = Object.assign({}, details);
    const img = details.imageData;
    let image = img && typeof img === 'object' && img.width && img.height && img.data ? img : null;
    if (!image && img && typeof img === 'object') {
      const sizes = Object.keys(img).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
      image = sizes.length ? img[sizes[0]] : null;
    }
    if (image && image.data) {
      const bytes = Uint8Array.from(image.data);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      out.imageData = { width: image.width, height: image.height, data: btoa(bin) };
    }
    return out;
  }

  // Our members go into chrome.<name>. An object Electron already has is updated in place, never swapped: Chromium's
  // bindings can put their own object back over a replaced one (seen for chrome.action), but they keep the same object.
  function fill(obj, api, methods, eventNames) {
    for (const m of methods) obj[m] = method(api, m);
    for (const e of eventNames) obj[e.split('.')[1]] = getEvent(e);
    return obj;
  }
  function nsObject(parent, name) {
    if (!parent[name] || typeof parent[name] !== 'object') parent[name] = {};
    return parent[name];
  }

  const ACTION_METHODS = [
    'setTitle', 'getTitle', 'setIcon', 'setPopup', 'getPopup', 'setBadgeText', 'getBadgeText',
    'setBadgeBackgroundColor', 'getBadgeBackgroundColor', 'setBadgeTextColor', 'getBadgeTextColor',
    'enable', 'disable', 'isEnabled', 'getUserSettings', 'openPopup',
  ];
  const TAB_METHODS = ['query', 'get', 'getCurrent', 'create', 'update', 'remove', 'duplicate', 'reload', 'move', 'discard', 'goBack', 'goForward'];
  const WINDOW_METHODS = ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove'];
  const MENU_METHODS = ['create', 'update', 'remove', 'removeAll'];
  const NOTIFICATION_METHODS = ['create', 'update', 'clear', 'getAll', 'getPermissionLevel'];
  const COOKIE_METHODS = ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'];
  const NAV_METHODS = ['getAllFrames', 'getFrame'];
  const SYNC_METHODS = ['get', 'set', 'remove', 'clear', 'getBytesInUse'];
  const ALARM_METHODS = ['create', 'get', 'getAll', 'clear', 'clearAll'];

  const has = (name) => info.apis.indexOf(name) !== -1;

  // chrome.action (MV3) and chrome.browserAction (MV2): fully ours, because the toolbar is ours.
  if (has('action')) {
    const ns = fill(nsObject(chromeObj, 'action'), 'action', ACTION_METHODS, ['action.onClicked']);
    // ImageData cannot cross the bridge: copy its RGBA bytes as base64 first (main converts them to a PNG).
    const setIcon = method('action', 'setIcon');
    ns.setIcon = (details, cb) => setIcon(plainIconDetails(details), ...(cb ? [cb] : []));
    if (info.manifestVersion < 3) fill(nsObject(chromeObj, 'browserAction'), 'action', ACTION_METHODS, ['action.onClicked']);
  }

  // chrome.tabs: our tab ids and events; the native methods (sendMessage, connect, executeScript, zoom) stay.
  if (has('tabs')) {
    const t = chromeObj.tabs || {};
    for (const m of TAB_METHODS) t[m] = method('tabs', m);
    for (const e of ['tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated', 'tabs.onReplaced', 'tabs.onMoved']) {
      t[e.split('.')[1]] = getEvent(e);
    }
    if (t.TAB_ID_NONE === undefined) t.TAB_ID_NONE = -1;
    chromeObj.tabs = t;
  }

  if (has('windows')) {
    const ns = fill(nsObject(chromeObj, 'windows'), 'windows', WINDOW_METHODS, ['windows.onCreated', 'windows.onRemoved', 'windows.onFocusChanged']);
    ns.WINDOW_ID_NONE = -1;
    ns.WINDOW_ID_CURRENT = -2;
  }

  if (has('contextMenus')) {
    fill(nsObject(chromeObj, 'contextMenus'), 'contextMenus', MENU_METHODS, ['contextMenus.onClicked']);
    fill(nsObject(chromeObj, 'menus'), 'contextMenus', MENU_METHODS, ['contextMenus.onClicked']);
  }

  if (has('notifications')) {
    fill(nsObject(chromeObj, 'notifications'), 'notifications', NOTIFICATION_METHODS, ['notifications.onClicked', 'notifications.onClosed']);
  }

  if (has('cookies')) {
    fill(nsObject(chromeObj, 'cookies'), 'cookies', COOKIE_METHODS, ['cookies.onChanged']);
  }

  // chrome.alarms: timers live in the main process (Electron's do not reach a service worker's listener).
  if (has('alarms')) {
    fill(nsObject(chromeObj, 'alarms'), 'alarms', ALARM_METHODS, ['alarms.onAlarm']);
  }

  if (has('webNavigation')) {
    fill(nsObject(chromeObj, 'webNavigation'), 'webNavigation', NAV_METHODS, [
      'webNavigation.onBeforeNavigate',
      'webNavigation.onCommitted',
      'webNavigation.onDOMContentLoaded',
      'webNavigation.onCompleted',
      'webNavigation.onErrorOccurred',
    ]);
  }

  // chrome.storage.sync: Electron's copy is "not available"; ours lives in the main process. onChanged is one event
  // that also carries Electron's own local/session changes, so both areas reach one listener list.
  const storage = chromeObj.storage;
  if (storage) {
    fill(nsObject(storage, 'sync'), 'storageSync', SYNC_METHODS, []);
    const native = storage.onChanged;
    const changed = getEvent('storage.onChanged');
    storage.onChanged = {
      addListener: (fn) => changed.addListener(fn),
      removeListener: (fn) => changed.removeListener(fn),
      hasListener: (fn) => changed.hasListener(fn),
      hasListeners: () => changed.hasListeners(),
    };
    if (native && typeof native.addListener === 'function') {
      native.addListener((changes, area) => {
        const set = listeners.get('storage.onChanged');
        if (!set) return;
        for (const fn of [...set]) {
          try {
            fn(changes, area);
          } catch (err) {
            console.error('[extension event] storage.onChanged', err);
          }
        }
      });
    }
  }

  // chrome.runtime: Electron's native sendMessage does not start an idle worker, so a message to this extension's own
  // worker first asks main to start it. Messages to other extensions (an id argument) go straight through.
  if (chromeObj.runtime && typeof chromeObj.runtime.sendMessage === 'function') {
    const runtime = chromeObj.runtime;
    const nativeSend = runtime.sendMessage;
    runtime.sendMessage = function (...args) {
      if (typeof args[0] === 'string') return nativeSend.apply(runtime, args);
      return invoke('runtime', 'ensureWorker', []).then(
        () => nativeSend.apply(runtime, args),
        () => nativeSend.apply(runtime, args)
      );
    };
  }
  // Tells main that this worker listens for messages (content scripts may message it; see wakeForPage in main).
  if (chromeObj.runtime && chromeObj.runtime.onMessage && typeof chromeObj.runtime.onMessage.addListener === 'function') {
    const onMessage = chromeObj.runtime.onMessage;
    const nativeAdd = onMessage.addListener;
    onMessage.addListener = function (...args) {
      sub('runtime.onMessage', true);
      return nativeAdd.apply(onMessage, args);
    };
  }

  // Stand-ins for namespaces Pure lacks (see STUB_* in main): calls reject with "not supported" and are reported in
  // Settings; events are inert. Created only where Electron has nothing, so a worker can still start.
  for (const ns of info.stubs || []) {
    if (chromeObj[ns] !== undefined) continue;
    const cache = {};
    chromeObj[ns] = new Proxy(cache, {
      get(target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (!(prop in target)) {
          target[prop] = /^on[A-Z]/.test(prop) ? getEvent(ns + '.' + prop.charAt(2).toLowerCase() + prop.slice(3)) : method(ns, prop);
        }
        return target[prop];
      },
    });
  }

  // chrome.extension (MV2 helpers Electron lacks): file-URL and incognito access are never granted.
  if (chromeObj.extension) {
    const ext = chromeObj.extension;
    const denied = (cb) => {
      if (cb) return cb(false), undefined;
      return Promise.resolve(false);
    };
    if (typeof ext.isAllowedFileSchemeAccess !== 'function') ext.isAllowedFileSchemeAccess = denied;
    if (typeof ext.isAllowedIncognitoAccess !== 'function') ext.isAllowedIncognitoAccess = denied;
  }

  // chrome.permissions: answered here from the manifest. Optional permissions can never be granted in Pure.
  {
    const required = info.permissions;
    const hosts = info.hostPermissions;
    const contains = (req) => {
      const perms = req && Array.isArray(req.permissions) ? req.permissions : [];
      const origins = req && Array.isArray(req.origins) ? req.origins : [];
      return perms.every((p) => required.indexOf(p) !== -1) && origins.every((o) => hosts.indexOf(o) !== -1);
    };
    Object.assign(nsObject(chromeObj, 'permissions'), {
      contains: (req, cb) => {
        const v = contains(req);
        if (cb) return cb(v), undefined;
        return Promise.resolve(v);
      },
      getAll: (cb) => {
        const v = { permissions: required.slice(), origins: hosts.slice() };
        if (cb) return cb(v), undefined;
        return Promise.resolve(v);
      },
      request: (req, cb) => {
        const v = contains(req);
        if (cb) return cb(v), undefined;
        return Promise.resolve(v);
      },
      remove: (req, cb) => {
        if (cb) return cb(false), undefined;
        return Promise.resolve(false);
      },
      onAdded: getEvent('permissions.onAdded'),
      onRemoved: getEvent('permissions.onRemoved'),
    });
  }
}

(() => {
  const g = globalThis;
  const isFrame = typeof g.location === 'object' && g.location !== null;
  // Web pages (and their iframes): nothing to do, no IPC, no world access.
  if (isFrame && String(g.location.protocol) !== 'chrome-extension:') return;

  let info = null;
  try {
    info = ipcRenderer.sendSync(CH_INIT);
  } catch (err) {
    return;
  }
  if (!info || typeof info !== 'object') return;

  const call = (api, method, args) => ipcRenderer.invoke(CH_CALL, api, method, args);
  const sub = (name, on) => ipcRenderer.send(CH_SUB, name, !!on);

  try {
    contextBridge.executeInMainWorld({ func: installInWorld, args: [call, sub, info] });
  } catch (err) {
    // A failed install leaves Electron's own APIs in place. Never break the extension's page for it.
    console.error('[pure] extension API install failed:', err && err.message);
    return;
  }

  // Events pushed by main: hand them to the main-world dispatcher.
  const deliver = function (name, args) {
    const d = globalThis[Symbol.for('pure.ext.dispatch')];
    if (typeof d === 'function') d(name, args);
  };
  ipcRenderer.on(CH_EVENT, (_e, name, args) => {
    try {
      contextBridge.executeInMainWorld({ func: deliver, args: [String(name), args] });
    } catch (err) {
      /* context gone */
    }
  });
})();
