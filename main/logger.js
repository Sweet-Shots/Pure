'use strict';
// Main-process logger. log(...args) appends one line to <userData>/app.log.
// - Writes are async and serialized through a promise queue (no fs.*Sync, no interleaving).
// - The file is rotated to app.log.old once it passes MAX_BYTES (one old copy is kept).
// - Errors are logged with their stack, objects with util.inspect, all args are kept.
// - The console is only used in unpackaged (development) runs.

const fs = require('fs');
const path = require('path');
const util = require('util');
const { app } = require('electron');

const MAX_BYTES = 1024 * 1024;

let logPath = null;
let oldPath = null;
let dirReady = false;
let knownSize = -1; // -1 = not measured yet
let queue = Promise.resolve();

function resolvePaths() {
  if (!logPath) {
    const dir = app.getPath('userData');
    logPath = path.join(dir, 'app.log');
    oldPath = path.join(dir, 'app.log.old');
  }
}

function formatArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return util.inspect(arg, { depth: 4, breakLength: Infinity, maxArrayLength: 50, maxStringLength: 2000 });
  } catch {
    return '[unprintable]';
  }
}

async function writeLine(line) {
  resolvePaths();
  if (!dirReady) {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    dirReady = true;
  }
  const bytes = Buffer.byteLength(line);
  if (knownSize < 0) {
    try {
      knownSize = (await fs.promises.stat(logPath)).size;
    } catch {
      knownSize = 0;
    }
  }
  if (knownSize + bytes > MAX_BYTES) {
    // rename replaces an existing app.log.old on Windows; a missing file is fine.
    await fs.promises.rename(logPath, oldPath).catch(() => {});
    knownSize = 0;
  }
  await fs.promises.appendFile(logPath, line);
  knownSize += bytes;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(formatArg).join(' ')}\n`;
  if (!app.isPackaged) console.log(line.trimEnd());
  queue = queue.then(() => writeLine(line)).catch(() => {
    // Logging must never throw into the caller; a failed write is dropped.
  });
}

// Resolves once every line logged so far has been written.
function flush() {
  return queue;
}

module.exports = { log, flush };
