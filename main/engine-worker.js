'use strict';
// main/engine-worker.js — builds the serialized blocking engine (Pure 2.3, owner D1).
//
// Runs in a worker_threads Worker that blocking.js starts for every engine build, so parsing millions of
// filter rules never stalls the main process. The same function runs inline (buildEngineBytes) when a worker
// cannot start. Only @ghostery/adblocker is required here, never 'electron', so the file works in a plain
// worker thread.
//
// input  = { lists: [{ id, buf }], resources: buf | null }   buf = UTF-8 bytes (Buffer, Uint8Array or ArrayBuffer)
// output = { bytes: Uint8Array (the serialized engine), counts: { [listId]: networkRules + cosmeticRules } }

const { Config, FiltersEngine, parseFilters } = require('@ghostery/adblocker');

// Network + cosmetic rules, extended (procedural) selectors. HTML filtering is off: it needs a streaming
// response filter, which the blocker does not use.
const CONFIG = { loadCosmeticFilters: true, loadNetworkFilters: true, loadExtendedSelectors: true, enableHtmlFiltering: false };

const decoder = new TextDecoder('utf-8');
const decode = (buf) => decoder.decode(buf);

function buildEngineBytes({ lists, resources }) {
  const config = new Config(CONFIG);
  const networkFilters = [];
  const cosmeticFilters = [];
  const preprocessors = [];
  const counts = {};
  const checksums = new Map();
  for (const list of lists) {
    const parsed = parseFilters(decode(list.buf), config);
    counts[list.id] = parsed.networkFilters.length + parsed.cosmeticFilters.length;
    checksums.set(list.id, String(list.buf.byteLength));
    // Loops, not push(...arr): a list can hold far more filters than a call can take as arguments.
    for (const f of parsed.networkFilters) networkFilters.push(f);
    for (const f of parsed.cosmeticFilters) cosmeticFilters.push(f);
    for (const p of parsed.preprocessors) preprocessors.push(p);
  }
  // Same construction as FiltersEngine.parse(), with per-list counts kept.
  const engine = new FiltersEngine({ networkFilters, cosmeticFilters, preprocessors, config, lists: checksums });
  if (resources) engine.updateResources(decode(resources), String(resources.byteLength));
  return { bytes: engine.serialize(), counts };
}

const wt = require('worker_threads');
if (!wt.isMainThread && wt.workerData && wt.workerData.pureEngineBuild === true) {
  try {
    const { bytes, counts } = buildEngineBytes(wt.workerData.input);
    const ab = bytes.buffer;
    wt.parentPort.postMessage(
      { ok: true, buffer: ab, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength, counts },
      [ab],
    );
  } catch (err) {
    wt.parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
}

module.exports = { buildEngineBytes, CONFIG };
