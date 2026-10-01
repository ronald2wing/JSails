/**
 * The bench collectors and the listener driver (`scripts/bench/collectors/`)
 * count exactly what they claim: each counter against a synthetic workload
 * with a known number of operations, installation and restoration, marks,
 * and the driver against hand-written listeners.
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import diagnostics from 'node:diagnostics_channel';
import fs, { statSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { Hono } from 'hono';

import type { AppEnv } from '../../../src/server/env.js';
import { collectorsModule, listenerModule, type Collectors } from './bench-tools.js';
import { createDrivers } from './drivers.js';
import { gateOutcome, releaseGate, waitAtGate } from './stream-gate.js';

const { installCollectors, CHANNELS, COUNTERS } = collectorsModule;
const { driveListener } = listenerModule;

const scratch = mkdtempSync(join(import.meta.dirname, 'collectors-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const file = join(scratch, 'file.txt');
writeFileSync(file, 'collector fixture');

let active: Collectors | undefined;
afterEach(() => {
  active?.uninstall();
  active = undefined;
});

function install(): Collectors {
  active = installCollectors();
  return active;
}

describe('installCollectors', () => {
  it('installs once per process and restores everything it patched', () => {
    const originalStatSync = fs.statSync;
    const originalResponse = globalThis.Response;
    const originalStream = globalThis.ReadableStream;
    const originalRun = AsyncLocalStorage.prototype.run;
    const collectors = install();
    assert.throws(() => installCollectors(), { code: 'collectors_installed' });
    assert.notEqual(fs.statSync, originalStatSync);
    collectors.uninstall();
    active = undefined;
    assert.equal(fs.statSync, originalStatSync);
    assert.equal(statSync, originalStatSync, 'the named ESM binding is restored too');
    assert.equal(globalThis.Response, originalResponse);
    assert.equal(globalThis.ReadableStream, originalStream);
    assert.equal(AsyncLocalStorage.prototype.run, originalRun);
    install();
  });

  it('adopts a Response global installed after it and leaves that global in place', () => {
    const collectors = install();
    const Wrapped = globalThis.Response;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Response');
    assert.ok(descriptor !== undefined);
    // What a Node adapter does when its listener is created.
    class Lightweight {}
    Object.defineProperty(globalThis, 'Response', { ...descriptor, value: Lightweight });
    try {
      void new globalThis.Response('x');
      assert.equal(collectors.read().responses, 0, 'not counted before adoption');
      assert.deepEqual(collectors.adoptGlobals(), ['Response']);
      assert.deepEqual(collectors.adoptGlobals(), [], 'adopting twice wraps nothing');
      void new globalThis.Response('x');
      void new Wrapped('y');
      assert.equal(collectors.read().responses, 2, 'both classes are counted');
      collectors.uninstall();
      active = undefined;
      assert.equal(globalThis.Response, Lightweight, "the adapter's global stays");
      assert.throws(() => collectors.adoptGlobals(), { code: 'collectors_uninstalled' });
    } finally {
      Object.defineProperty(globalThis, 'Response', descriptor);
      active?.uninstall();
      active = undefined;
    }
    install();
  });

  it('starts every counter at zero', () => {
    const counts = install().read();
    for (const name of COUNTERS) assert.equal(counts[name], 0, name);
    assert.deepEqual(counts.fsCalls, {});
  });
});

describe('counters', () => {
  it('counts sync, callback, promise and stream fs calls, by name', async () => {
    const collectors = install();
    fs.statSync(file);
    statSync(file);
    await stat(file);
    await new Promise((resolve) => fs.stat(file, resolve));
    fs.realpathSync.native(file);
    const counts = collectors.read();
    assert.deepEqual(counts.fsCalls, {
      'fs.statSync': 2,
      'fs/promises.stat': 1,
      'fs.stat': 1,
      'fs.realpathSync.native': 1,
    });
    assert.equal(counts.fs, 5);
  });

  it('counts a read stream and the descriptor calls it makes through the fs module', async () => {
    const collectors = install();
    const stream = fs.createReadStream(file);
    for await (const chunk of stream) void chunk;
    const calls = collectors.read().fsCalls;
    assert.equal(calls['fs.createReadStream'], 1);
    assert.equal(calls['fs.open'], 1);
    assert.equal(calls['fs.close'], 1);
    assert.ok((calls['fs.read'] ?? 0) >= 1);
  });

  it('counts zlib engines from one-shot calls, streams and CompressionStream', () => {
    const collectors = install();
    zlib.gzipSync('x');
    zlib.brotliCompressSync('x');
    zlib.createGzip().close();
    new CompressionStream('gzip');
    assert.equal(collectors.read().zlib, 4);
  });

  it('counts promises created', () => {
    const collectors = install();
    for (let index = 0; index < 10; index += 1) void Promise.resolve(index);
    assert.ok(collectors.read().promises >= 10);
  });

  it('counts Responses from the constructor and the static factories', () => {
    const collectors = install();
    const response = new Response('x');
    Response.json({ ok: true });
    Response.redirect('http://localhost/elsewhere', 302);
    class Custom extends Response {}
    const custom = new Custom('y');
    assert.equal(collectors.read().responses, 4);
    assert.ok(response instanceof Response);
    assert.ok(custom instanceof Response && custom instanceof Custom);
  });

  it('counts ReadableStream constructions and tee branches', () => {
    const collectors = install();
    const stream = new ReadableStream();
    stream.tee();
    assert.equal(collectors.read().readableStreams, 3);
  });

  it('counts a response body read out as a stream once per response', () => {
    const collectors = install();
    const response = new Response('body');
    void response.body;
    void response.body;
    void new Response(null).body;
    assert.equal(collectors.read().bodyStreams, 1);
  });

  it('counts AsyncLocalStorage runs on any instance', () => {
    const storage = new AsyncLocalStorage<number>();
    const collectors = install();
    storage.run(1, () => storage.run(2, () => undefined));
    assert.equal(collectors.read().alsRuns, 2);
  });

  it('counts a module load and not a cached import', async () => {
    const module = join(scratch, 'loaded.mjs');
    writeFileSync(module, 'export const value = 1;\n');
    const collectors = install();
    await import(pathToFileURL(module).href);
    assert.equal(collectors.read().modules, 1);
    collectors.reset();
    await import(pathToFileURL(module).href);
    assert.equal(collectors.read().modules, 0);
  });

  it('counts hashes from node:crypto and Web Crypto', async () => {
    const collectors = install();
    createHash('sha1').update('x').digest();
    await crypto.subtle.digest('SHA-1', new Uint8Array([1]));
    assert.equal(collectors.read().hashes, 2);
  });

  it('counts messages on the jsails diagnostics channels', () => {
    const collectors = install();
    diagnostics.channel(CHANNELS.render).publish({});
    diagnostics.channel(CHANNELS.render).publish({});
    diagnostics.channel(CHANNELS.hash).publish({});
    diagnostics.channel(CHANNELS.store).publish({});
    const counts = collectors.read();
    assert.deepEqual([counts.renders, counts.hashes, counts.stores], [2, 1, 1]);
  });
});

describe('reset, mark and measure', () => {
  it('reports the work since a mark and forgets marks on reset', () => {
    const collectors = install();
    fs.statSync(file);
    collectors.mark('start');
    fs.statSync(file);
    fs.statSync(file);
    assert.equal(collectors.since('start').fs, 2);
    assert.deepEqual(collectors.since('start').fsCalls, { 'fs.statSync': 2 });
    assert.equal(collectors.marked('start'), true);
    collectors.reset();
    assert.equal(collectors.marked('start'), false);
    assert.throws(() => collectors.since('start'), { code: 'unknown_mark' });
    assert.equal(collectors.read().fs, 0);
  });

  it('measures one call from zero', async () => {
    const collectors = install();
    fs.statSync(file);
    const { result, counts } = await collectors.measure(async () => {
      await stat(file);
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(counts.fsCalls, { 'fs/promises.stat': 1 });
  });
});

describe('driveListener', () => {
  function listener(
    handle: (req: IncomingMessage, res: ServerResponse) => void,
  ): (req: IncomingMessage, res: ServerResponse) => void {
    return handle;
  }

  it('reports status, headers and a body written in one end()', async () => {
    const result = await driveListener(
      listener((req, res) => {
        res.writeHead(201, [
          'content-type',
          'text/plain',
          'set-cookie',
          'a=1',
          'set-cookie',
          'b=2',
          'x-method',
          String(req.method),
          'x-header',
          String(req.headers['x-test']),
        ]);
        res.end('created');
      }),
      new Request('http://localhost:4000/path?q=1', { headers: { 'x-test': 'yes' } }),
    );
    assert.equal(result.status, 201);
    assert.equal(result.text(), 'created');
    assert.equal(result.endedWithBody, true);
    assert.equal(result.writes, 0);
    assert.equal(result.headers.get('x-method'), 'GET');
    assert.equal(result.headers.get('x-header'), 'yes');
    assert.deepEqual(result.headers.getSetCookie(), ['a=1', 'b=2']);
    assert.equal(result.error, undefined);
  });

  it('delivers the request body and URL', async () => {
    const result = await driveListener(
      listener((req, res) => {
        const parts: Buffer[] = [];
        req.on('data', (part: Buffer) => parts.push(part));
        req.on('end', () => res.end(`${req.url} ${Buffer.concat(parts).toString()}`));
      }),
      new Request('http://localhost/echo?x=1', { method: 'POST', body: 'payload' }),
    );
    assert.equal(result.text(), '/echo?x=1 payload');
  });

  it('records each write of a streamed body and can disconnect mid-stream', async () => {
    let closed = false;
    const result = await driveListener(
      listener((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        let sent = 0;
        const timer = setInterval(() => {
          sent += 1;
          res.write(`chunk ${sent}`);
        }, 5);
        res.on('close', () => {
          closed = true;
          clearInterval(timer);
        });
      }),
      new Request('http://localhost/'),
      { abortAfterChunks: 2 },
    );
    assert.equal(result.aborted, true);
    assert.equal(result.chunks.length, 2);
    assert.equal(result.writes, 2);
    assert.equal(result.endedWithBody, false);
    assert.ok(closed, 'the response saw the disconnect');
  });

  it('reports body chunks without their chunked framing', async () => {
    const result = await driveListener(
      listener((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first');
        setTimeout(() => res.end('second'), 5);
      }),
      new Request('http://localhost/'),
    );
    assert.equal(result.headers.get('transfer-encoding'), 'chunked');
    assert.deepEqual(
      result.chunks.map((chunk) => Buffer.from(chunk.bytes).toString()),
      ['first', 'second'],
    );
    assert.equal(result.text(), 'firstsecond');
    assert.equal(result.writes, 1);
    assert.equal(result.endedWithBody, true);
  });

  it('reports no body for HEAD, whatever Content-Length says', async () => {
    const result = await driveListener(
      listener((_req, res) => {
        res.writeHead(200, { 'content-length': '5' });
        res.end();
      }),
      new Request('http://localhost/', { method: 'HEAD' }),
    );
    assert.equal(result.headers.get('content-length'), '5');
    assert.equal(result.body.byteLength, 0);
  });

  it('times a chunk by its arrival at the socket, so a corked response holds it back', async () => {
    const corked = (gate: string) =>
      listener((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.cork();
        res.write('first');
        void waitAtGate(gate).then(() => {
          res.write('second');
          res.uncork();
          res.end();
        });
      });
    const gate = 'corked listener';
    const result = await driveListener(corked(gate), new Request('http://localhost/'), {
      onChunk: (count) => {
        if (count === 1) releaseGate(gate);
      },
    });
    assert.equal(result.text(), 'firstsecond');
    assert.equal(result.writes, 2, 'both writes were made');
    assert.equal(gateOutcome(gate), 'timeout', 'the first chunk was seen before the uncork');
  });

  it('reports a response destroyed with an error', async () => {
    const result = await driveListener(
      listener((_req, res) => {
        res.writeHead(200);
        res.write('partial');
        setImmediate(() => res.destroy(new Error('broken')));
      }),
      new Request('http://localhost/'),
    );
    assert.equal(result.error, 'broken');
    assert.equal(result.text(), 'partial');
  });

  it('fails when the response never finishes', async () => {
    await assert.rejects(
      driveListener(
        listener(() => undefined),
        new Request('http://localhost/'),
        { timeoutMs: 20 },
      ),
      { code: 'listener_timeout' },
    );
  });
});

describe('stream gate', () => {
  /** A body that sends one chunk, then waits at `gate` before finishing. */
  function gatedBody(gate: string): ReadableStream<Uint8Array> {
    let step = 0;
    return new ReadableStream({
      async pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(new TextEncoder().encode('first'));
        else {
          await waitAtGate(gate);
          controller.enqueue(new TextEncoder().encode('rest'));
          controller.close();
        }
      },
    });
  }

  it('is released when the first chunk reaches the client, and times out when it is buffered', async () => {
    const app = new Hono<AppEnv>();
    app.get('/streamed', (c) => new Response(gatedBody(c.req.header('x-gate') ?? '')));
    app.get('/buffered', async (c) => {
      // A pipeline stage that reads the whole body before answering.
      const bytes = await new Response(gatedBody(c.req.header('x-gate') ?? '')).arrayBuffer();
      return new Response(bytes);
    });
    for (const driver of createDrivers(app)) {
      for (const [path, expected] of [
        ['/streamed', 'released'],
        ['/buffered', 'timeout'],
      ] as const) {
        const gate = `${driver.name}${path}`;
        const response = await driver.send(
          new Request(`http://localhost${path}`, { headers: { 'x-gate': gate } }),
          {
            onChunk: (count) => {
              if (count === 1) releaseGate(gate);
            },
          },
        );
        assert.equal(response.text(), 'firstrest');
        assert.equal(gateOutcome(gate), expected, `${driver.name} ${path}`);
      }
    }
  });
});
