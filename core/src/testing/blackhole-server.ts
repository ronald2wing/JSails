/**
 * A TCP peer that never answers (`jsails/testing`).
 *
 * {@link blackholeServer} is the fault server for every network client the
 * framework owns (Valkey, SMTP, S3, webhooks, outbound fetch): it accepts
 * connections and then either reads and discards forever (`silent`, the
 * half-dead peer behind a stuck load balancer) or resets the connection once a
 * client has sent part of a command (`reset`). A client with no timeout hangs
 * against the first and must surface a typed error, not crash, against the
 * second. Bound to loopback on an ephemeral port, so tests run in parallel.
 */

import { createServer, type Socket } from 'node:net';

/** What the server does with an accepted connection. */
export type BlackholeMode = 'silent' | 'reset';

/** Options for {@link blackholeServer}. */
export interface BlackholeServerOptions {
  /** Defaults to `'silent'`. */
  readonly mode?: BlackholeMode;
  /**
   * In `reset` mode, how many bytes a connection may send before it is reset.
   * Defaults to `1`: the reset lands mid-command.
   */
  readonly resetAfterBytes?: number;
  /** Defaults to `127.0.0.1`. */
  readonly host?: string;
}

/** A running {@link blackholeServer}. */
export interface BlackholeServer {
  readonly host: string;
  readonly port: number;
  /** Connections accepted so far. */
  readonly connections: number;
  /** Bytes received across every connection. */
  readonly bytesReceived: number;
  /** `<scheme>://<host>:<port>`, for clients configured by URL. */
  url(scheme: string): string;
  /** Destroy every open connection and stop listening. */
  close(): Promise<void>;
}

/** Start a {@link BlackholeServer}; `close()` it in the test's `after`. */
export async function blackholeServer(
  options: BlackholeServerOptions = {},
): Promise<BlackholeServer> {
  const mode = options.mode ?? 'silent';
  const resetAfterBytes = options.resetAfterBytes ?? 1;
  if (!Number.isSafeInteger(resetAfterBytes) || resetAfterBytes < 1) {
    throw new RangeError('resetAfterBytes must be a positive integer');
  }
  const host = options.host ?? '127.0.0.1';
  const sockets = new Set<Socket>();
  let connections = 0;
  let bytesReceived = 0;

  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    let received = 0;
    socket.on('close', () => sockets.delete(socket));
    // A client that gives up resets the connection; that is the expected end
    // of a blackholed connection, not a failure of the server.
    socket.on('error', () => sockets.delete(socket));
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      bytesReceived += chunk.length;
      if (mode === 'reset' && received >= resetAfterBytes) {
        socket.resetAndDestroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('blackhole server has no TCP address');
  }
  const port = address.port;

  return {
    host,
    port,
    get connections() {
      return connections;
    },
    get bytesReceived() {
      return bytesReceived;
    },
    url: (scheme) => `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
