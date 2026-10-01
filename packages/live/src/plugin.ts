/**
 * The `live` plugin (`@jsails/live`): the Socket.IO transport for the live
 * reactivity layer, mounted onto the application's HTTP server via the
 * `onServe` hook (docs/design/live.md §13.1, §13.2).
 *
 * `livePlugin(options)` builds a {@link JsailsPlugin} named `live` whose
 * `setup` publishes the caller-supplied publication registry under
 * `publicationRegistryToken`, and whose `onServe` hook, when the application
 * serves:
 * - opens the change log (the in-memory ring, or the shared Valkey stream);
 * - builds and starts the transport-agnostic {@link LiveService};
 * - wires the application data source's capture subscriber to the service's
 *   `ingest`; and
 * - attaches the Socket.IO transport to the same `node:http.Server` the
 *   application already owns — the plugin never opens a listener of its own and
 *   never constructs a second data source.
 *
 * **Two deployment shapes, one contract.** Without a Valkey URL the change log
 * is the in-memory ring and the service delivers its own appends directly:
 * correct for a single instance. With a Valkey URL the log is a shared stream,
 * every local append publishes a notification on the bus, and delivery goes
 * through the stream tailer instead (`deliverLocally: false`), because routing
 * locally *and* tailing gives two delivery paths with independent timing — a
 * local append could be routed before an earlier remote append was read, and
 * the client would see sequence 7 before 6.
 *
 * Construction is lazy: nothing connects at import, plugin construction, or
 * `setup`; the log opens and the transport attaches only when the application
 * actually serves. The registry is a passed-in object, never plugin-owned, so
 * applications register publications before or after plugin construction.
 *
 * Security posture (the origin allowlist, the per-connection identity, the
 * subscription cap, the subscribe rate limit, and the params/change byte caps)
 * lives in the Socket.IO transport (`./socket-transport.ts`) and mirrors the
 * broadcast adapter's posture rather than inventing a new one
 * (docs/design/live.md §7). The plugin's `resolveUser` additionally receives
 * the application's service registry, so it can resolve the session through
 * the same `authSessionToken` service HTTP routes use.
 *
 * Delivery failures (a membership probe that throws) are reported through
 * `onError`, sanitized to a value-free {@link LiveDeliveryError}, and default
 * to `process.emitWarning` — a subscriber going stale is never silent.
 */

import { definePlugin, type JsailsPlugin, type ServiceRegistry } from 'jsails/extensions';
import { reportBackendError, resolveValkeyUrl } from 'jsails/plugin-sdk';
import { databaseToken, type JsailsDataSource } from 'jsails/database';
import {
  publicationRegistryToken,
  type ChangeLog,
  type LiveUser,
  type PublicationRegistry,
} from 'jsails/live';
import { createInMemoryChangeLog } from './in-memory-change-log.js';
import {
  createLiveService,
  LiveDeliveryError,
  type HeadReadingChangeLog,
  type LiveService,
} from './live-service.js';
import {
  attachLiveSocket,
  type LiveHandshake,
  type LiveSocketHandle,
  type LiveSocketOptions,
} from './socket-transport.js';
import {
  createStreamTailer,
  createValkeyChangeBus,
  type StreamTailer,
  type ValkeyBusClient,
  type ValkeyChangeBus,
} from './valkey-change-bus.js';
import { createValkeyChangeLog, type ValkeyLiveClient } from './valkey-change-log.js';

/**
 * Options accepted by {@link livePlugin}: the publication registry plus the
 * transport options forwarded to {@link attachLiveSocket}.
 */
export interface LivePluginOptions extends Omit<LiveSocketOptions, 'resolveUser'> {
  /** The publication registry the service resolves subscription names from. */
  readonly registry: PublicationRegistry;
  /**
   * Resolve a connection's user from its handshake. The second argument is the
   * application's service registry, so the resolver can read the session the
   * way HTTP does:
   *
   * ```ts
   * resolveUser: async ({ request }, services) => {
   *   const session = await services.get(authSessionToken).resolveSession(request);
   *   const user = session?.data.user;
   *   return isRecord(user) && typeof user.id === 'string' ? { id: user.id } : null;
   * }
   * ```
   *
   * Without it every connection is anonymous.
   */
  readonly resolveUser?: (
    handshake: LiveHandshake,
    services: ServiceRegistry,
  ) => LiveUser | null | undefined | Promise<LiveUser | null | undefined>;
  /** Default snapshot row cap per publication. Defaults to 1000; at most 10 000. */
  readonly maxRows?: number;
  /** Capture-flush coalescing window in milliseconds. Defaults to 16. */
  readonly flushIntervalMs?: number;
  /** Drivers allowed to probe membership at once. Defaults to 8. */
  readonly maxConcurrentProbes?: number;
  /**
   * Valkey URL for multi-instance delivery. Falls back to `VALKEY_URL`; when
   * neither is set the plugin runs single-instance with an in-memory log.
   */
  readonly valkeyUrl?: string;
  /** Key prefix for the stream, counter, and notification channel. */
  readonly prefix?: string;
  /** Approximate stream length retained by `XADD MAXLEN ~`. Defaults to 1000. */
  readonly maxChanges?: number;
  /**
   * Receives delivery failures and backend errors from the Valkey log, bus, and
   * tailer, each sanitized to a value-free error. Defaults to
   * `process.emitWarning`; a throwing handler never crashes the process.
   */
  readonly onError?: (error: Error) => void;
  /** Test seam: the change-log client constructor. Defaults to ioredis. */
  readonly createLogClient?: (url: string) => ValkeyLiveClient;
  /** Test seam: the bus subscriber/publisher client constructor. Defaults to ioredis. */
  readonly createBusClient?: (url: string) => ValkeyBusClient;
}

/** Build the `live` plugin. */
export function livePlugin(options: LivePluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('livePlugin requires an options object');
  }
  const registry = options.registry;
  if (registry === null || typeof registry !== 'object') {
    throw new TypeError('livePlugin requires a registry');
  }

  return definePlugin({
    name: 'live',
    describe: () => ({ needsLive: true }),
    setup({ services, onServe }) {
      // The registry is caller-supplied, so the live plugin is its consumer, not
      // its owner. Publishing it under a token lets publication-registering
      // plugins (the blog's `blog.posts`) add to the same registry the service
      // resolves names from, without the app having to thread it through.
      services.provide(publicationRegistryToken, registry);

      const valkeyUrl = resolveValkeyUrl({ valkeyUrl: options.valkeyUrl });

      let running: RunningLive | undefined;

      onServe(async (server, context) => {
        // The data source is app-owned (provided by the `database` plugin under
        // databaseToken); the live plugin reads it, never constructs it.
        const dataSource = context.services.get<JsailsDataSource>(databaseToken);

        // Connect before attaching the transport so a misconfigured Valkey
        // fails the serve rather than silently degrading to single-instance.
        const backend: Backend =
          valkeyUrl === undefined
            ? { shared: false, changeLog: createInMemoryChangeLog() }
            : await openSharedBackend(valkeyUrl, options);

        const service = createLiveService({
          registry,
          changeLog: backend.changeLog,
          deliverLocally: !backend.shared,
          maxRows: options.maxRows,
          flushIntervalMs: options.flushIntervalMs,
          maxConcurrentProbes: options.maxConcurrentProbes,
          onError: (error) => {
            reportBackendError(error, options.onError, 'live delivery', deliveryError);
          },
        });

        let tailer: StreamTailer | undefined;
        if (backend.shared) {
          const reader = createStreamTailer({
            client: backend.client,
            streamKey: backend.streamKey,
            startAfter: backend.changeLog.head,
            onChanges: (changes) => service.applyRemote(changes),
            onError: options.onError,
          });
          backend.bus.onNotify(() => {
            void reader.pump();
          });
          tailer = reader;
        }

        await service.start();
        dataSource.liveCapture.setListener(service.ingest);
        const resolveUser = options.resolveUser;
        const handle = attachLiveSocket(server, service, {
          ...options,
          resolveUser:
            resolveUser === undefined
              ? undefined
              : (handshake) => resolveUser(handshake, context.services),
        });
        running = {
          handle,
          service,
          tailer,
          bus: backend.shared ? backend.bus : undefined,
          changeLog: backend.changeLog,
        };
      });

      return async () => {
        const live = running;
        running = undefined;
        if (live === undefined) {
          return;
        }
        // Order matters: stop accepting subscribers, then stop reading the
        // stream, then release the shared connections, then stop the service.
        await live.handle.close();
        live.tailer?.close();
        await live.bus?.close();
        await live.changeLog.close();
        await live.service.stop();
      };
    },
  });
}

/** Everything `onServe` opened, so the cleanup can release it in order. */
interface RunningLive {
  readonly handle: LiveSocketHandle;
  readonly service: LiveService;
  readonly tailer: StreamTailer | undefined;
  readonly bus: ValkeyChangeBus | undefined;
  readonly changeLog: ChangeLog;
}

/** Pins the sanitized delivery error; the helper already suffixes any errno code. */
function deliveryError(message: string): Error {
  return new LiveDeliveryError('io_failed', message);
}

/** The single-instance backend: the per-process ring, delivered locally. */
interface LocalBackend {
  readonly shared: false;
  readonly changeLog: ChangeLog;
}

/** The shared-Valkey backend: the stream log, its connection, and the bus. */
interface SharedBackend {
  readonly shared: true;
  readonly changeLog: HeadReadingChangeLog;
  readonly client: ValkeyLiveClient;
  readonly streamKey: string;
  readonly bus: ValkeyChangeBus;
}

type Backend = LocalBackend | SharedBackend;

/**
 * Open the shared change log and the notification bus, and make every local
 * append announce itself on the bus. The announcement is fire-and-forget: the
 * bus reports its own failures, and the tailer's periodic poll is the
 * correctness backstop.
 */
async function openSharedBackend(
  valkeyUrl: string,
  options: LivePluginOptions,
): Promise<SharedBackend> {
  const log = await createValkeyChangeLog({
    valkeyUrl,
    prefix: options.prefix,
    maxChanges: options.maxChanges,
    onError: options.onError,
    createClient: options.createLogClient,
  });
  let bus: ValkeyChangeBus;
  try {
    bus = await createValkeyChangeBus({
      valkeyUrl,
      prefix: options.prefix,
      onError: options.onError,
      createClient: options.createBusClient,
    });
  } catch (error) {
    await log.close();
    throw error;
  }
  const changeLog: HeadReadingChangeLog = {
    async append(change) {
      const sequence = await log.append(change);
      void bus.publish();
      return sequence;
    },
    since: (sequence) => log.since(sequence),
    readHead: () => log.readHead(),
    get head() {
      return log.head;
    },
    close: () => log.close(),
  };
  return { shared: true, changeLog, client: log.client, streamKey: log.streamKey, bus };
}
