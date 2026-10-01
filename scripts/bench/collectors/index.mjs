/**
 * Request-cost collectors: deterministic operation counters for one process.
 *
 * The conformance suite (`core/test/server/conformance/`) and the bench
 * harness count what a request costs instead of timing it, so a budget names
 * the mechanism that regressed (one extra fs call, one extra zlib engine) and
 * never flakes on a loaded runner. `installCollectors()` patches the process
 * once and returns counters that can be reset, marked and read:
 *
 * - `fs`: every call of a function exported by `node:fs` (sync, callback and
 *   stream factories) or `node:fs/promises`, by name in `fsCalls`. The module
 *   objects are patched and `syncBuiltinESMExports()` updates the named ESM
 *   bindings, so `import { stat } from 'node:fs/promises'` is counted whether
 *   the importer loaded before or after installation. Only a function
 *   reference copied out of the module object before installation (a CommonJS
 *   `const { stat } = require('fs')`) escapes, which is why the collectors are
 *   installed before the app is imported.
 * - `zlib`: zlib engine creations, seen as `async_hooks` resources of type
 *   `ZLIB`. That covers the one-shot sync and callback functions, the stream
 *   classes and the web `CompressionStream`, which all allocate one.
 * - `promises`: promises created (`async_hooks` type `PROMISE`). Not exact
 *   across Node versions or JIT tiers; a budget on it needs a band.
 * - `responses`: `Response` objects built through the global constructor or
 *   its static factories (`json`, `redirect`, `error`). A Node adapter that
 *   replaces the global with its own class (`@hono/node-server` installs a
 *   lightweight `Response` when its listener is created) is followed by
 *   calling `adoptGlobals()` afterwards. The adapter keeps the class it found
 *   at import, the counted one, so a lightweight response it materializes
 *   into a native one counts twice: both objects exist.
 * - `readableStreams`: streams built through the global `ReadableStream`
 *   constructor, plus two per `tee()`.
 * - `bodyStreams`: native responses whose `body` stream was read out (the
 *   first `body` access per response object), which is what a Node adapter
 *   pays to pump a body through a web stream instead of writing bytes.
 * - `alsRuns`: `AsyncLocalStorage#run` calls on any instance.
 * - `modules`: modules loaded (ESM or CommonJS), seen through a synchronous
 *   `module.registerHooks` load hook, so a lazy `import()` that reaches a
 *   module not yet in the cache counts and a cached one does not.
 * - `hashes`: `crypto.createHash`, `crypto.createHmac`, one-shot `crypto.hash`
 *   and `SubtleCrypto#digest` calls, plus messages on `jsails:hash`.
 * - `renders`, `stores`: messages published on the `jsails:render` and
 *   `jsails:store` diagnostics channels. Subscribing costs the publisher
 *   nothing until a subscriber exists; until the framework publishes on a
 *   channel its counter stays 0, so a budget that needs it counts the work in
 *   its own fixture instead.
 *
 * Counters are process-wide: everything the process does between `reset()`
 * (or a `mark()`) and the read is counted, test fixtures included. A
 * measurement therefore covers one request at a time.
 */
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import diagnostics from 'node:diagnostics_channel';

const require = createRequire(import.meta.url);

/** The diagnostics channels the framework publishes request work on. */
export const CHANNELS = Object.freeze({
  render: 'jsails:render',
  hash: 'jsails:hash',
  store: 'jsails:store',
});

/** Every scalar counter, in report order. */
export const COUNTERS = Object.freeze([
  'fs',
  'zlib',
  'promises',
  'responses',
  'readableStreams',
  'bodyStreams',
  'alsRuns',
  'modules',
  'hashes',
  'renders',
  'stores',
]);

/** Raised when the collectors are misused; value-free, identified by `code`. */
export class CollectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
  }
}

let installed;

function emptyCounts() {
  const counts = Object.fromEntries(COUNTERS.map((name) => [name, 0]));
  counts.fsCalls = {};
  return counts;
}

function copyCounts(counts) {
  return { ...counts, fsCalls: { ...counts.fsCalls } };
}

function subtractCounts(now, base) {
  const delta = emptyCounts();
  for (const name of COUNTERS) delta[name] = now[name] - base[name];
  for (const [name, value] of Object.entries(now.fsCalls)) {
    const diff = value - (base.fsCalls[name] ?? 0);
    if (diff !== 0) delta.fsCalls[name] = diff;
  }
  return delta;
}

/**
 * Replace `owner[key]` with `make(original)`, keeping the original's own
 * properties (`promisify.custom`, `realpath.native`), and return the undo.
 */
function replace(owner, key, make) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  const original = owner[key];
  const wrapper = make(original);
  for (const name of Reflect.ownKeys(original)) {
    if (name === 'length' || name === 'name' || name === 'prototype') continue;
    if (Object.prototype.hasOwnProperty.call(wrapper, name)) continue;
    Object.defineProperty(wrapper, name, Object.getOwnPropertyDescriptor(original, name));
  }
  Object.defineProperty(owner, key, { ...descriptor, value: wrapper });
  return () => Object.defineProperty(owner, key, descriptor);
}

/** A function-valued export that is an operation, not a class or a private helper. */
function isOperation(module, key) {
  if (typeof key !== 'string' || key.startsWith('_') || /^[A-Z]/.test(key)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(module, key);
  return (
    descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function'
  );
}

function patchFs(counts, undo) {
  const modules = [
    ['fs', require('node:fs')],
    ['fs/promises', require('node:fs/promises')],
  ];
  for (const [label, module] of modules) {
    for (const key of Object.keys(module)) {
      if (!isOperation(module, key)) continue;
      const name = `${label}.${key}`;
      undo.push(
        replace(module, key, (original) => {
          const counted = function (...args) {
            counts.fs += 1;
            counts.fsCalls[name] = (counts.fsCalls[name] ?? 0) + 1;
            return new.target === undefined
              ? Reflect.apply(original, this, args)
              : Reflect.construct(original, args, new.target);
          };
          return counted;
        }),
      );
    }
  }
  // `realpath.native` is its own operation, carried as a property.
  const fs = require('node:fs');
  for (const key of ['realpath', 'realpathSync']) {
    const host = fs[key];
    if (typeof host?.native !== 'function') continue;
    const name = `fs.${key}.native`;
    undo.push(
      replace(
        host,
        'native',
        (original) =>
          function (...args) {
            counts.fs += 1;
            counts.fsCalls[name] = (counts.fsCalls[name] ?? 0) + 1;
            return Reflect.apply(original, this, args);
          },
      ),
    );
  }
}

function patchCrypto(counts, undo) {
  const crypto = require('node:crypto');
  for (const key of ['createHash', 'createHmac', 'hash']) {
    if (typeof crypto[key] !== 'function') continue;
    undo.push(
      replace(
        crypto,
        key,
        (original) =>
          function (...args) {
            counts.hashes += 1;
            return Reflect.apply(original, this, args);
          },
      ),
    );
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    const proto = Object.getPrototypeOf(subtle);
    undo.push(
      replace(
        proto,
        'digest',
        (original) =>
          function (...args) {
            counts.hashes += 1;
            return Reflect.apply(original, this, args);
          },
      ),
    );
  }
}

/** The engine's own `Response`, under any adapter subclass installed as the global. */
function nativeResponse() {
  let candidate = globalThis.Response;
  for (;;) {
    const parent = Object.getPrototypeOf(candidate);
    if (typeof parent !== 'function' || parent.name !== 'Response') return candidate;
    candidate = parent;
  }
}

/** A construct-counting proxy over the Response class `ResponseClass`. */
function countingResponse(counts, ResponseClass) {
  const factories = new Set(['json', 'redirect', 'error']);
  const wrappedFactories = new Map();
  const responseProxy = new Proxy(ResponseClass, {
    construct(target, args, newTarget) {
      counts.responses += 1;
      return Reflect.construct(target, args, newTarget === responseProxy ? target : newTarget);
    },
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver === responseProxy ? target : receiver);
      if (!factories.has(key) || typeof value !== 'function') return value;
      if (!wrappedFactories.has(key)) {
        wrappedFactories.set(key, function (...args) {
          counts.responses += 1;
          return Reflect.apply(value, target, args);
        });
      }
      return wrappedFactories.get(key);
    },
  });
  return responseProxy;
}

/** A construct-counting proxy over the ReadableStream class `StreamClass`. */
function countingStream(counts, StreamClass) {
  const streamProxy = new Proxy(StreamClass, {
    construct(target, args, newTarget) {
      counts.readableStreams += 1;
      return Reflect.construct(target, args, newTarget === streamProxy ? target : newTarget);
    },
  });
  return streamProxy;
}

/**
 * Wrap whichever `Response` and `ReadableStream` classes are the globals now
 * and are not already wrapped; return the names wrapped. `wrapped` holds the
 * proxies installed so far.
 */
function wrapGlobals(counts, undo, wrapped) {
  const adopted = [];
  for (const [name, wrap] of [
    ['Response', countingResponse],
    ['ReadableStream', countingStream],
  ]) {
    if (wrapped.get(name) === globalThis[name]) continue;
    const proxy = wrap(counts, globalThis[name]);
    const restore = replace(globalThis, name, () => proxy);
    // A global someone replaced after it was wrapped is theirs to keep.
    undo.push(() => {
      if (globalThis[name] === proxy) restore();
    });
    wrapped.set(name, proxy);
    adopted.push(name);
  }
  return Object.freeze(adopted);
}

function patchWebGlobals(counts, undo, wrapped) {
  wrapGlobals(counts, undo, wrapped);
  undo.push(
    replace(
      globalThis.ReadableStream.prototype,
      'tee',
      (original) =>
        function (...args) {
          counts.readableStreams += 2;
          return Reflect.apply(original, this, args);
        },
    ),
  );

  const native = nativeResponse();
  const descriptor = Object.getOwnPropertyDescriptor(native.prototype, 'body');
  const seen = new WeakSet();
  Object.defineProperty(native.prototype, 'body', {
    ...descriptor,
    get() {
      const body = Reflect.apply(descriptor.get, this, []);
      if (body !== null && !seen.has(this)) {
        seen.add(this);
        counts.bodyStreams += 1;
      }
      return body;
    },
  });
  undo.push(() => Object.defineProperty(native.prototype, 'body', descriptor));
}

function patchAsyncLocalStorage(counts, undo) {
  undo.push(
    replace(
      AsyncLocalStorage.prototype,
      'run',
      (original) =>
        function (...args) {
          counts.alsRuns += 1;
          return Reflect.apply(original, this, args);
        },
    ),
  );
}

function subscribeChannels(counts, undo) {
  for (const [counter, channel] of [
    ['renders', CHANNELS.render],
    ['hashes', CHANNELS.hash],
    ['stores', CHANNELS.store],
  ]) {
    const onMessage = () => {
      counts[counter] += 1;
    };
    diagnostics.subscribe(channel, onMessage);
    undo.push(() => diagnostics.unsubscribe(channel, onMessage));
  }
}

function hookModuleLoads(counts, undo) {
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      counts.modules += 1;
      return nextLoad(url, context);
    },
  });
  undo.push(() => hooks.deregister());
}

function hookAsyncResources(counts, undo) {
  const hook = createHook({
    init(_id, type) {
      if (type === 'ZLIB') counts.zlib += 1;
      else if (type === 'PROMISE') counts.promises += 1;
    },
  });
  hook.enable();
  undo.push(() => hook.disable());
}

/**
 * Patch this process and return its counters. Call once per process, before
 * the code under measurement is imported; a second call throws
 * `collectors_installed` until `uninstall()`.
 */
export function installCollectors() {
  if (installed !== undefined) {
    throw new CollectorError('collectors_installed', 'collectors are already installed');
  }
  const counts = emptyCounts();
  const undo = [];
  const marks = new Map();
  const wrapped = new Map();
  try {
    patchFs(counts, undo);
    patchCrypto(counts, undo);
    syncBuiltinESMExports();
    patchWebGlobals(counts, undo, wrapped);
    patchAsyncLocalStorage(counts, undo);
    subscribeChannels(counts, undo);
    hookModuleLoads(counts, undo);
    hookAsyncResources(counts, undo);
  } catch (error) {
    for (const step of undo.reverse()) step();
    syncBuiltinESMExports();
    throw error;
  }

  const collectors = Object.freeze({
    /** The counts since installation or the last `reset()`. */
    read: () => copyCounts(counts),
    /** Zero every counter and forget every mark. */
    reset() {
      Object.assign(counts, emptyCounts());
      marks.clear();
    },
    /** Remember the current counts under `name`. */
    mark(name) {
      marks.set(name, copyCounts(counts));
    },
    /** Whether `mark(name)` was called since the last `reset()`. */
    marked: (name) => marks.has(name),
    /** The counts accrued since `mark(name)`. */
    since(name) {
      const base = marks.get(name);
      if (base === undefined) {
        throw new CollectorError('unknown_mark', 'no mark with that name since the last reset');
      }
      return subtractCounts(counts, base);
    },
    /** Reset, await `fn()`, and return its result with the counts it cost. */
    async measure(fn) {
      collectors.reset();
      const result = await fn();
      return { result, counts: copyCounts(counts) };
    },
    /**
     * Count constructions through a `Response` or `ReadableStream` global that
     * replaced the one wrapped at installation (a Node adapter installs its
     * own `Response` when its listener is created); return the names newly
     * wrapped. The replaced class stays counted for whoever kept it.
     */
    adoptGlobals() {
      if (installed !== collectors) {
        throw new CollectorError('collectors_uninstalled', 'the collectors were uninstalled');
      }
      return wrapGlobals(counts, undo, wrapped);
    },
    /** Restore every patched function and global. */
    uninstall() {
      if (installed !== collectors) return;
      for (const step of undo.reverse()) step();
      undo.length = 0;
      syncBuiltinESMExports();
      installed = undefined;
    },
  });
  installed = collectors;
  return collectors;
}
