/**
 * Keeps Node's own module loader out of the bench's `fs` counter.
 *
 * With `module.registerHooks` hooks installed (the collectors count modules
 * through one), Node's ESM and CommonJS resolution and loading call the
 * public `fs.realpathSync`, `readFileSync`, `openSync`, `readSync` and
 * `closeSync`, so every loaded module adds several counted `fs` operations.
 * Left in, the counter would mostly repeat `modules`, follow loader internals
 * that change between Node patch releases, and bury the framework's own fs
 * work (the one extra `stat` a budget exists to catch) under thousands of
 * loader calls.
 *
 * `withoutLoaderFs(collectors)` wraps every `node:fs` operation once more,
 * outside the collectors' counting wrapper, and sets aside each call whose
 * direct caller is loader code (`node:internal/modules/`). Only the direct
 * caller is consulted: a module's top-level code also runs below loader
 * frames, and its fs calls are the framework's. Module loads stay visible in
 * `modules`. A hook window around the resolve and load chain is not enough:
 * CommonJS `require` resolution reaches `realpathSync` outside it.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);

const LOADER_FRAME = /^\s*at (?:.*\()?node:internal\/modules\//;

/** Whether a one-frame stack (`Error.captureStackTrace` output) names loader code. */
export function isLoaderFrame(stack) {
  const frame = stack.split('\n')[1];
  return frame !== undefined && LOADER_FRAME.test(frame);
}

/** The direct caller of `wrapper`, as a one-frame stack string. */
function callerOf(wrapper) {
  const holder = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 1;
  try {
    Error.captureStackTrace(holder, wrapper);
  } finally {
    Error.stackTraceLimit = limit;
  }
  return holder.stack;
}

/**
 * Wraps `fs[key]` so a loader call, and every fs call made while it runs,
 * adds to `tally.loaderFs`; returns the undo step.
 */
function wrapOperation(fs, key, tally) {
  const descriptor = Object.getOwnPropertyDescriptor(fs, key);
  const original = descriptor.value;
  const wrapper = function (...args) {
    const call = () =>
      new.target === undefined
        ? Reflect.apply(original, this, args)
        : Reflect.construct(original, args, new.target);
    // An fs function may call others through the module object
    // (`readFileSync` opens, reads and closes through `fs.openSync` and
    // friends); inside a loader call those are the loader's too.
    if (tally.inLoader) {
      tally.loaderFs += 1;
      return call();
    }
    if (!isLoaderFrame(callerOf(wrapper))) return call();
    tally.loaderFs += 1;
    tally.inLoader = true;
    try {
      return call();
    } finally {
      tally.inLoader = false;
    }
  };
  // `realpathSync.native` and friends ride along as properties.
  for (const name of Reflect.ownKeys(original)) {
    if (Object.prototype.hasOwnProperty.call(wrapper, name)) continue;
    Object.defineProperty(wrapper, name, Object.getOwnPropertyDescriptor(original, name));
  }
  Object.defineProperty(fs, key, { ...descriptor, value: wrapper });
  return () => Object.defineProperty(fs, key, descriptor);
}

/**
 * The bench's view of `collectors` (from `installCollectors()`): `read()`
 * reports `fs` without the module loader's operations (and `loaderFs`, the
 * operations left out), `reset()` zeroes both, `adoptGlobals()` passes
 * through, and `uninstall()` removes this wrapper and then the collectors.
 * Call it right after `installCollectors()`, before the code under
 * measurement loads.
 */
export function withoutLoaderFs(collectors) {
  const fs = require('node:fs');
  const tally = { loaderFs: 0, inLoader: false };
  const undo = [];
  for (const key of Object.keys(fs)) {
    if (key.startsWith('_') || /^[A-Z]/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(fs, key);
    if (descriptor === undefined || typeof descriptor.value !== 'function') continue;
    undo.push(wrapOperation(fs, key, tally));
  }
  syncBuiltinESMExports();
  return Object.freeze({
    read() {
      const counts = collectors.read();
      return { ...counts, fs: counts.fs - tally.loaderFs, loaderFs: tally.loaderFs };
    },
    reset() {
      collectors.reset();
      tally.loaderFs = 0;
    },
    adoptGlobals: () => collectors.adoptGlobals(),
    uninstall() {
      for (const step of undo.reverse()) step();
      undo.length = 0;
      syncBuiltinESMExports();
      collectors.uninstall();
    },
  });
}
