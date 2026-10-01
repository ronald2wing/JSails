/**
 * Stdout guard tests: console output and direct stdout writes are diverted to
 * stderr, the frame writer alone reaches stdout, a stdout error reaches the
 * frame writer instead of crashing, and restore puts everything back.
 */

import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { guardStdout } from '../../src/mcp/stdout-guard.js';

function streams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
  stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')));
  const target = new Console({ stdout, stderr });
  return { stdout, stderr, out, err, target };
}

async function writeFrame(frames: NodeJS.WritableStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    frames.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('guardStdout', () => {
  it('sends every console method and direct stdout writes to stderr', async () => {
    const io = streams();
    const guard = guardStdout({ stdout: io.stdout, stderr: io.stderr, console: io.target });
    try {
      io.target.log('log line');
      io.target.info('info line');
      io.target.debug('debug line');
      io.target.table([{ a: 1 }]);
      io.target.dir({ dir: true });
      io.target.warn('warn line');
      io.target.error('error line');
      io.stdout.write('raw write\n');
      await writeFrame(guard.frames, '{"jsonrpc":"2.0"}\n');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(io.out, ['{"jsonrpc":"2.0"}\n']);
      const err = io.err.join('');
      for (const text of [
        'log line',
        'info line',
        'debug line',
        '│ a',
        'dir: true',
        'warn line',
        'error line',
        'raw write',
      ]) {
        assert.ok(err.includes(text), `${text} reached stderr`);
      }
    } finally {
      guard.restore();
    }
  });

  it('restores the console and stdout.write, and restore is idempotent', async () => {
    const io = streams();
    const ownLog = Object.getOwnPropertyDescriptor(io.target, 'log');
    const guard = guardStdout({ stdout: io.stdout, stderr: io.stderr, console: io.target });
    guard.restore();
    guard.restore();
    assert.equal(Object.hasOwn(io.stdout, 'write'), false, 'no own write property is left');
    assert.deepEqual(Object.getOwnPropertyDescriptor(io.target, 'log'), ownLog);
    io.target.log('after restore');
    io.stdout.write('direct\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(io.out, ['after restore\n', 'direct\n']);
    assert.deepEqual(io.err, []);
  });

  it('restores an own stdout.write property that existed before', () => {
    const io = streams();
    const own = io.stdout.write.bind(io.stdout);
    Object.defineProperty(io.stdout, 'write', { value: own, writable: true, configurable: true });
    const guard = guardStdout({ stdout: io.stdout, stderr: io.stderr, console: io.target });
    assert.notEqual(io.stdout.write, own);
    guard.restore();
    assert.equal(io.stdout.write, own);
  });

  it('routes a stdout error to the frame writer instead of throwing', async () => {
    const io = streams();
    const guard = guardStdout({ stdout: io.stdout, stderr: io.stderr, console: io.target });
    try {
      const failed = once(guard.frames, 'error');
      io.stdout.emit('error', new Error('EPIPE'));
      const [error] = (await failed) as [Error];
      assert.equal(error.message, 'EPIPE');
    } finally {
      guard.restore();
    }
    assert.equal(io.stdout.listenerCount('error'), 0, 'the error listener is removed');
  });
});
