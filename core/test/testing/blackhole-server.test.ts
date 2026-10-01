/**
 * Tests for `blackholeServer` (`jsails/testing`): a silent server accepts and
 * reads but never answers, a reset server resets a connection once it has
 * received the configured bytes, counters and the URL report what happened,
 * and `close` ends open connections.
 */

import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { describe, it } from 'node:test';

import { blackholeServer, settlesWithin, waitFor } from '../../src/testing/index.js';

function open(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** How the socket ended: 'data' if anything arrived, else its close cause. */
function outcome(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once('data', () => resolve('data'));
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    socket.once('close', () => resolve('close'));
  });
}

describe('blackholeServer', () => {
  it('accepts and reads a command but never answers it', async (t) => {
    const server = await blackholeServer();
    t.after(() => server.close());
    const socket = await open(server.port);
    t.after(() => socket.destroy());
    socket.write('PING\r\n');
    await waitFor(() => server.bytesReceived === 6, { label: 'the command bytes' });
    assert.equal(server.connections, 1);
    await assert.rejects(settlesWithin(outcome(socket), 200, 'a reply'), {
      name: 'SettleTimeoutError',
    });
  });

  it('resets a connection mid-command in reset mode', async (t) => {
    const server = await blackholeServer({ mode: 'reset', resetAfterBytes: 4 });
    t.after(() => server.close());
    const socket = await open(server.port);
    const ended = outcome(socket);
    socket.write('GE');
    socket.write('T key\r\n');
    assert.equal(await settlesWithin(ended, 2000, 'the reset'), 'ECONNRESET');
  });

  it('reports its address as a URL for any scheme', async (t) => {
    const server = await blackholeServer();
    t.after(() => server.close());
    assert.equal(server.host, '127.0.0.1');
    assert.equal(server.url('redis'), `redis://127.0.0.1:${server.port}`);
  });

  it('ends open connections on close', async () => {
    const server = await blackholeServer();
    const socket = await open(server.port);
    const ended = outcome(socket);
    await waitFor(() => server.connections === 1, { label: 'the connection' });
    await server.close();
    assert.notEqual(await settlesWithin(ended, 2000, 'the close'), 'data');
  });

  it('refuses a non-positive reset threshold', async () => {
    await assert.rejects(blackholeServer({ mode: 'reset', resetAfterBytes: 0 }), RangeError);
  });
});
