/**
 * First-party `broadcast` plugin: mounts a broadcast transport onto the
 * application's HTTP server as a composable extension, via the `onServe` hook.
 *
 * `broadcastPlugin(options)` builds a {@link JsailsPlugin} named `broadcast`
 * whose `setup` registers an `onServe` hook. When the application starts
 * serving, that hook calls `attachBroadcast(server, options)` against the same
 * `node:http.Server` the application already owns — the plugin never opens a
 * listener of its own, so HTTP and broadcast share the application's single
 * public port. Both option forms are accepted, exactly as `attachBroadcast`
 * accepts them:
 *
 * - the built-in Socket.IO options ({@link BroadcastOptions}), which enforce the
 *   Socket.IO origin/auth/channel security posture; and
 * - an `{ adapter }` form carrying a custom {@link BroadcastAdapter}, which is
 *   trusted application code owning its own authentication, authorization, and
 *   serialization.
 *
 * The attached {@link Broadcast} handle is stored in the `setup` closure, and
 * the hook returns it to the server as a drain participant (`broadcast`):
 * when the application closes, the server's drain drains the transport
 * (`Broadcast.drain`), which disconnects every client and releases what the
 * transport owns without waiting on the HTTP server, so a slow HTTP request
 * is never blamed on broadcast. The returned cleanup closes it too
 * (idempotently and concurrency-safely, via the wrapper's own memoized
 * `close`). The application still owns the HTTP server and its bounded
 * shutdown. When the application is only ever built or fetched (never
 * served), `onServe` never runs and the cleanup is a no-op.
 *
 * This plugin is the one way broadcast is wired: its lifecycle lives inside the
 * extension system (declaration-ordered setup, reverse cleanup) rather than on
 * the config object, so the application core knows nothing about transports.
 *
 * With the built-in Socket.IO options and no `valkey` of their own, the plugin
 * uses the app's Valkey connections when the app has them (`valkeyToken`, or
 * `VALKEY_URL`): an app that runs against Valkey may run several processes, and
 * an in-memory adapter would silently keep each broadcast inside one of them.
 *
 * Construction is lazy: nothing connects and no handle is created at import,
 * plugin construction, or `setup` — the transport is attached only when the
 * application actually serves.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { attachBroadcast, type AttachBroadcastOptions, type Broadcast } from './server.js';
import { BroadcastServiceError, broadcastToken, type BroadcastService } from './service.js';
import type { JsonValue } from '../contracts/http.js';
import { useValkeyConnections } from '../valkey/provider.js';

/** Options accepted by {@link broadcastPlugin}: built-in Socket.IO or a custom adapter. */
export type BroadcastPluginOptions = AttachBroadcastOptions;

/**
 * Build the first-party `broadcast` plugin. The returned plugin is inert: no
 * transport is attached until the application serves, at which point the
 * `onServe` hook attaches to the application-owned HTTP server.
 */
export function broadcastPlugin(options: BroadcastPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('broadcastPlugin requires an options object');
  }

  return definePlugin({
    name: 'broadcast',
    describe: () => ({ needsLive: true }),
    setup({ services, onServe, rootDir, mode }) {
      let handle: Broadcast | undefined;
      let closed = false;
      const service: BroadcastService = Object.freeze({
        publish(channel: string, event: string, data: JsonValue) {
          if (closed) {
            throw new BroadcastServiceError('closed', 'broadcast transport is closed');
          }
          if (handle === undefined) {
            throw new BroadcastServiceError(
              'unavailable',
              'broadcast transport is not attached until the application serves',
            );
          }
          handle.broadcast(channel, event, data);
        },
        revalidate() {
          return closed || handle === undefined ? Promise.resolve() : handle.revalidate();
        },
      });
      services.provide(broadcastToken, service);

      const valkey =
        'adapter' in options || options.valkey !== undefined
          ? undefined
          : useValkeyConnections({ services, rootDir, mode });
      const attachOptions =
        valkey === undefined ? options : { ...options, valkey: valkey.connections };

      onServe(async (server) => {
        const attached = await attachBroadcast(server, attachOptions);
        handle = attached;
        // The participant ends with its own clients, never with the HTTP
        // server, whose connections the server's drain waits on itself.
        return { name: 'broadcast', drain: () => attached.drain() };
      });

      return async () => {
        closed = true;
        try {
          await handle?.close();
        } finally {
          await valkey?.release();
        }
      };
    },
  });
}
