/**
 * First-party `live` plugin (`@jsails/live`): the Socket.IO transport for the
 * live reactivity layer, mounted onto the application's HTTP server via the
 * `onServe` hook (LIVE-PLAN.md Phases 6-7).
 *
 * `livePlugin(options)` builds a {@link JsailsPlugin} named `live` whose
 * `setup`:
 * - builds the publication registry, the change log, and the
 *   transport-agnostic {@link LiveService};
 * - registers an `onServe` hook that, when the application serves, wires the
 *   application data source's capture subscriber to the service's `ingest` and
 *   attaches the Socket.IO adapter to the same `node:http.Server` the
 *   application already owns — the plugin never opens a listener of its own and
 *   never constructs a second data source.
 *
 * **Two deployment shapes, one contract.** Without a Valkey URL the change log
 * is the in-memory ring and the service delivers its own appends directly:
 * correct for a single instance. With a Valkey URL the log is a shared stream
 * and delivery goes through the stream tailer instead (`deliverLocally: false`),
 * because routing locally *and* tailing gives two delivery paths with
 * independent timing — a local append could be routed before an earlier remote
 * append was read, and the client would see sequence 7 before 6.
 *
 * Construction is lazy: nothing connects at import, plugin construction, or
 * `setup`; the transport attaches only when the application actually serves.
 * The plugin reads publications from a registry the caller supplies (or an
 * empty one), so applications register publications before or after plugin
 * construction — the registry is a passed-in object, never plugin-owned.
 *
 * Security posture (the origin allowlist, the subscription cap, the subscribe
 * rate limit, and the params/change byte caps) lives in the Socket.IO adapter
 * (`./socket-adapter.ts`) and mirrors the broadcast adapter's posture rather
 * than inventing a new one (LIVE-PLAN.md §7).
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import {
  attachLiveSocket,
  type LiveSocketHandle,
  type LiveSocketOptions,
} from './socket-adapter.js';
import { databaseToken, type JsailsDataSource } from 'jsails/database';
import {
  createInMemoryChangeLog,
  createLiveService,
  publicationRegistryToken,
  type ChangeLog,
  type LiveService,
  type PublicationRegistry,
} from 'jsails/live';
import {
  createStreamTailer,
  createValkeyChangeBus,
  type StreamTailer,
} from './valkey-change-bus.js';
import { createValkeyChangeLog, type ValkeyLiveClient } from './valkey-change-log.js';

/**
 * Options accepted by {@link livePlugin}: the publication registry plus the
 * transport options forwarded to {@link attachLiveSocket}.
 */
export interface LivePluginOptions extends LiveSocketOptions {
  /** The publication registry the service resolves subscription names from. */
  readonly registry: PublicationRegistry;
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
   * Receives backend errors from the Valkey log, bus, and tailer. Defaults to
   * `process.emitWarning`; a throwing handler never crashes the process.
   */
  readonly onError?: (error: Error) => void;
}

/** Build the first-party `live` plugin. */
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

      const valkeyUrl = resolveValkeyUrl(options.valkeyUrl);
      const shared = valkeyUrl !== undefined;

      // The service captures its log at construction, but the shared log can
      // only be created once the app serves (it connects). A delegate keeps
      // `setup` synchronous and lets `onServe` swap the backend in place.
      const logDelegate = createLogDelegate(shared ? undefined : createInMemoryChangeLog());
      const service: LiveService = createLiveService({
        registry,
        changeLog: logDelegate.log,
        deliverLocally: !shared,
      });

      let handle: LiveSocketHandle | undefined;
      let tailer: StreamTailer | undefined;
      let bus: Awaited<ReturnType<typeof createValkeyChangeBus>> | undefined;

      onServe(async (server, context) => {
        // The data source is app-owned (provided by the `database` plugin under
        // databaseToken); the live plugin reads it, never constructs it.
        const dataSource = context.services.get<JsailsDataSource>(databaseToken);
        dataSource.liveCapture.setListener(service.ingest);

        if (shared) {
          // Connect before attaching the transport so a misconfigured Valkey
          // fails the serve rather than silently degrading to single-instance.
          const sharedLog = await createValkeyChangeLog({
            valkeyUrl,
            prefix: options.prefix,
            maxChanges: options.maxChanges,
            onError: options.onError,
          });
          logDelegate.swap(sharedLog);
          bus = await createValkeyChangeBus({
            valkeyUrl,
            prefix: options.prefix,
            onError: options.onError,
          });
          tailer = createStreamTailer({
            client: sharedLog as unknown as ValkeyLiveClient,
            streamKey: `${options.prefix ?? 'jsails:live'}:changes`,
            onChanges: (changes) => service.applyRemote(changes),
            onError: options.onError,
          });
          bus.onNotify(() => {
            void tailer?.pump();
          });
        }

        handle = attachLiveSocket(server, service, options);
      });

      return async () => {
        // Order matters: stop accepting subscribers, then stop reading the
        // stream, then release the shared connections, then stop the service.
        const closing = handle === undefined ? Promise.resolve() : handle.close();
        handle = undefined;
        await closing;
        tailer?.close();
        tailer = undefined;
        await bus?.close();
        bus = undefined;
        await logDelegate.close();
        await service.stop();
      };
    },
  });
}

/** Resolve the Valkey URL from options or the environment, skipping empties. */
function resolveValkeyUrl(value: string | undefined): string | undefined {
  for (const candidate of [value, process.env.VALKEY_URL]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * A {@link ChangeLog} that forwards to whichever backend is currently active.
 *
 * The service captures its log at construction, but the shared log connects
 * only when the app serves. The delegate lets `setup` stay synchronous and
 * `onServe` swap the backend without rebuilding the service (which would drop
 * the capture listener and every open subscription).
 */
function createLogDelegate(initial: ChangeLog | undefined): {
  readonly log: ChangeLog;
  swap(next: ChangeLog): void;
  close(): Promise<void>;
} {
  let current: ChangeLog | undefined = initial;
  const require = (): ChangeLog => {
    if (current === undefined) {
      throw new Error('the live change log is not ready');
    }
    return current;
  };
  return {
    log: {
      append: (change) => require().append(change),
      since: (sequence) => require().since(sequence),
      get head() {
        return current?.head ?? 0;
      },
      close: async () => {
        const closing = current;
        current = undefined;
        await closing?.close();
      },
    },
    swap(next: ChangeLog): void {
      current = next;
    },
    async close(): Promise<void> {
      const closing = current;
      current = undefined;
      await closing?.close();
    },
  };
}
