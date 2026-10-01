/**
 * A minimal Redis-protocol peer (`jsails/testing`).
 *
 * {@link respServer} stands in for Valkey where a test needs a real client
 * connection but no data: it answers the handshake ioredis sends on connect
 * (`CLIENT ...`, `INFO`) so a client becomes ready, answers `PING` and
 * `SUBSCRIBE`, and acknowledges every other command with `+OK`. It can also
 * reset the connection the moment a chosen command arrives, or never answer
 * it: the reset, or the silence, that lands mid-command on a connection that
 * is already in use ({@link blackholeServer} covers a peer that never answers
 * at all). Bound to loopback on an ephemeral port, so tests run in parallel.
 */

import { createServer, type Socket } from 'node:net';

/**
 * A running {@link respServer}.
 *
 * @public
 */
export interface RespServer {
  /** `redis://127.0.0.1:<port>`. */
  readonly url: string;
  /** Command names received, upper-cased, in order. */
  readonly received: readonly string[];
  /** Destroy every open connection and stop listening. */
  close(): Promise<void>;
}

/**
 * What {@link respServer} does with the named commands.
 *
 * @public
 */
export interface RespServerOptions {
  /** Reset the connection when one of these arrives. */
  readonly resetOn?: readonly string[];
  /** Reset the connection the first time one of these arrives, then answer it. */
  readonly resetFirst?: readonly string[];
  /** Never answer these (later commands on the connection still queue behind). */
  readonly silentOn?: readonly string[];
}

/** Split complete RESP arrays off the front of `buffer`. */
function takeCommands(buffer: string): { commands: string[][]; rest: string } {
  const commands: string[][] = [];
  let rest = buffer;
  for (;;) {
    if (!rest.startsWith('*')) return { commands, rest };
    const header = rest.indexOf('\r\n');
    if (header === -1) return { commands, rest };
    const count = Number(rest.slice(1, header));
    let offset = header + 2;
    const parts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const lengthEnd = rest.indexOf('\r\n', offset);
      if (lengthEnd === -1) return { commands, rest };
      const length = Number(rest.slice(offset + 1, lengthEnd));
      const start = lengthEnd + 2;
      if (rest.length < start + length + 2) return { commands, rest };
      parts.push(rest.slice(start, start + length));
      offset = start + length + 2;
    }
    commands.push(parts);
    rest = rest.slice(offset);
  }
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function reply(command: string, args: readonly string[]): string {
  if (command === 'SUBSCRIBE') {
    return args
      .map((channel, index) => `*3\r\n${bulk('subscribe')}${bulk(channel)}:${index + 1}\r\n`)
      .join('');
  }
  if (command === 'INFO') {
    return bulk('# Server\r\nredis_version:7.2.0\r\nloading:0\r\n');
  }
  if (command === 'PING') return '+PONG\r\n';
  return '+OK\r\n';
}

/**
 * Start a {@link RespServer}; `close()` it in the test's `after`.
 *
 * @public
 */
export async function respServer(options: RespServerOptions = {}): Promise<RespServer> {
  const resetOn = new Set((options.resetOn ?? []).map((name) => name.toUpperCase()));
  const silentOn = new Set((options.silentOn ?? []).map((name) => name.toUpperCase()));
  const resetFirst = new Set((options.resetFirst ?? []).map((name) => name.toUpperCase()));
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('close', () => sockets.delete(socket));
    // A reset is the end this peer exists to produce, not a failure.
    socket.on('error', () => sockets.delete(socket));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const { commands, rest } = takeCommands(buffer);
      buffer = rest;
      for (const parts of commands) {
        const name = (parts[0] ?? '').toUpperCase();
        received.push(name);
        if (resetOn.has(name) || resetFirst.delete(name)) {
          socket.resetAndDestroy();
          return;
        }
        if (!silentOn.has(name)) {
          socket.write(reply(name, parts.slice(1)));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('resp server has no TCP address');
  }
  return {
    url: `redis://127.0.0.1:${address.port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
