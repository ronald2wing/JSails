/**
 * The application config's typed keys: the {@link AppConfig} interface, its
 * Zod schema, and the resolved shape {@link ResolvedAppConfig}.
 *
 * {@link AppConfig} holds the keys the kernel keeps. Every other key a config
 * may still carry is a legacy key. The compat mapper (`legacy.ts`) owns each
 * one: its types, its hand validation, and the replacement it names. The
 * mapper splits the legacy keys off before {@link appConfigSchema} runs, so
 * the schema has no opaque (`z.unknown`) field. Callbacks are `fn()` schemas
 * and plugin entries are checked as plugin instances. An unknown key fails the
 * strict schema, and its name is never echoed.
 *
 * The activation mode (`plugins.activation`) is validated here and then
 * leaves the config: the kernel seals it on the loaded app, so no resolved
 * config carries it and no consumer can branch on it.
 *
 * The default constants live in `defaults.ts` and the value-free
 * `AppConfigError` in `errors.ts`; neither imports Zod.
 */

import { z } from 'zod';

import { fn } from '../../plugins/contract/option-schemas.js';
import type { AgreeingSchema } from '../../validation/schema-keys.js';
import { isPluginInstance, type PluginInstance } from '../../plugins/contract/instance.js';
import type { Awaitable } from '../../contracts/awaitable.js';
import type { Guard } from '../../server/request-frame.js';
import type { HostPattern, TrustedProxies } from '../../security/request-origin.js';
import { MAX_ROUTE_BODY_BYTES } from '../../server/route-limits.js';
import { MAX_SHUTDOWN_TIMEOUT_MS } from './defaults.js';
import type { LegacyAppConfig, LegacyPluginUseEntry, ResolvedLegacyAppConfig } from './legacy.js';

/**
 * Node HTTP server timeouts for `Application.serve`, in milliseconds. Each
 * unset field keeps its load-balancer-friendly default (keep-alive 65 s,
 * headers 66 s, whole request 300 s).
 */
export interface AppServerTimeouts {
  /** Idle time before a keep-alive socket closes; keep it above the proxy's idle timeout. */
  readonly keepAliveTimeoutMs?: number;
  /** Time allowed to receive the request headers; must not exceed a non-zero `requestTimeoutMs`. */
  readonly headersTimeoutMs?: number;
  /** Time allowed to receive the whole request; `0` disables it. */
  readonly requestTimeoutMs?: number;
}

/**
 * The `server` config: the public origin and hosts the app answers on, who
 * may speak for the client, the route deadline, and the HTTP server timeouts.
 */
export interface AppServerConfig extends AppServerTimeouts {
  /**
   * The canonical public `http(s)` origin, e.g. `https://example.com`. The
   * cross-site check compares a request's `Origin` with the origin the request
   * was addressed to, and a request for a host that is neither this origin's
   * nor one of {@link hosts} is answered 421. Required to serve outside the
   * development and test environments; absent, every host is its own origin.
   */
  readonly origin?: string;
  /**
   * Hosts the app also answers on, each its own origin: `example.org`,
   * `example.org:8443`, or `*.example.com` (exactly one label, e.g. tenant
   * subdomains). Requires {@link origin}.
   */
  readonly hosts?: readonly HostPattern[];
  /**
   * Who may speak for the client in `X-Forwarded-For`:
   *
   * - `'none'`: the socket peer is the client.
   * - `{ hops: n }`: exactly n proxies stand in front of the app.
   * - `{ cidrs: [...] }`: peers inside these ranges are proxies.
   *
   * Unset, a file-loaded config takes `JSAILS_TRUSTED_PROXIES` from the
   * environment it is handed (`none`, `hops=<n>`, or a CIDR list), else
   * `'none'`.
   */
  readonly trustedProxies?: TrustedProxies;
  /**
   * Milliseconds a route has to answer, from entering it to its response,
   * unless it declares its own `timeoutMs`. Past it the request is answered
   * 504 and the request's abort signal fires. `0` disables it. Defaults to
   * 30000.
   */
  readonly handlerTimeoutMs?: number;
}

/** The resolved `server` config: every request-origin field set, timeouts as given. */
export interface ResolvedServerConfig {
  /** The canonical origin, or `undefined` when none is configured. */
  readonly origin: string | undefined;
  /** The additional host patterns; empty when none. */
  readonly hosts: readonly HostPattern[];
  /** The trusted-proxy setting; `'none'` unless configured or set by the environment. */
  readonly trustedProxies: TrustedProxies;
  /** Timeout overrides with unset fields dropped; empty keeps every default. */
  readonly timeouts: AppServerTimeouts;
  /** The route deadline of a route that declares none; `0` for none. */
  readonly handlerTimeoutMs: number;
}

/**
 * Tracing settings, passed to `createApp({ telemetry })`. A request continues
 * an inbound W3C `traceparent` only when a trusted proxy
 * (`server.trustedProxies`) relayed it. `trustInbound: true` continues it from
 * any caller, for an app that only its own services can reach.
 */
export interface AppTelemetryConfig {
  /** Continue every inbound `traceparent`. Defaults to `false`. */
  readonly trustInbound?: boolean;
}

/**
 * Page rendering settings, passed to `createApp({ render })`. Pages are
 * buffered; one streams when it exports `stream = true` or a producer.
 * `streamTimeoutMs` bounds how long a streamed page's suspended subtrees may
 * take after the shell, and how long it may go without a chunk (30 seconds by
 * default).
 */
export interface AppRenderConfig {
  /**
   * Milliseconds suspended subtrees have after the shell; a positive integer
   * up to 2147483647, the largest delay a Node timer honours.
   */
  readonly streamTimeoutMs?: number;
}

/**
 * Request handling settings, passed to `createApp`. `guards` are walls in
 * front of every request (see `Guard`). Each runs in order, before every
 * extension guard, and ahead of the body limit, health probes, routes and
 * public files. The first to answer with a `Response` refuses the request.
 */
export interface AppHttpConfig {
  readonly guards?: readonly Guard[];
}

/** The resolved `http` config: the guards in order (empty when none). */
export interface ResolvedHttpConfig {
  readonly guards: readonly Guard[];
}

/** Cleanup callback a `setup` callback may return. */
export type AppCleanup = () => Awaitable<void>;

/**
 * Who may let code into the application.
 *
 * - `'locked'` (the default): only the plugins this config declares run. No
 *   database row, admin action or environment value can activate code.
 * - `'managed'`: sealed plugin state may also activate signed plugin code,
 *   for a site its owner runs without a developer.
 *
 * The mode is a literal in the config. No environment variable, CLI flag or
 * setting selects it, and the loader refuses a value it cannot read
 * statically.
 *
 * @public
 */
export type ActivationMode = 'locked' | 'managed';

/**
 * The `plugins.activation` block: the {@link ActivationMode}.
 *
 * @public
 */
export interface ActivationConfig {
  readonly mode: ActivationMode;
}

/**
 * One `plugins.use` entry: a plugin instance (`definePlugin`), or a legacy
 * specifier entry, which the compat mapper accepts until it is removed.
 */
export type PluginUseEntry = PluginInstance | LegacyPluginUseEntry;

/**
 * The plugin system: which plugins run, and who may activate more.
 *
 * @public
 */
export interface AppPluginsConfig {
  /**
   * The plugins the application runs, in order. Service dependencies come
   * first (a provider always sets up before the plugins that require it), and
   * the order breaks the remaining ties.
   */
  readonly use?: readonly PluginUseEntry[];
  /** The activation mode. Absent means `{ mode: 'locked' }`. */
  readonly activation?: ActivationConfig;
}

/**
 * The application config keys the kernel keeps. A config module states these
 * and, until each one is removed, the legacy keys of `LegacyAppConfig`.
 *
 * @public
 */
export interface AppConfig {
  /** Project root, relative to the config file's directory. Defaults to `.`. */
  readonly rootDir?: string;
  /** Listen host. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Listen port in `0..65535`. Defaults to `3000`; `0` requests ephemeral. */
  readonly port?: number;
  /**
   * Persistent-storage directory, relative to `rootDir`. Defaults to `storage`.
   * `Application.serve` creates it before listening; build and fetch never
   * do. It must not equal the project root, contain the config module, or
   * overlap the public or out directory.
   */
  readonly storage?: string;
  /**
   * Health endpoint path, or `false` to disable. Defaults to `/up`. It is
   * served for GET and HEAD as a plain-text `200` with
   * `Cache-Control: no-store`, ahead of the routes. A page or API route at
   * the same path is a boot error.
   */
  readonly healthPath?: string | false;
  /**
   * Request-body cap in bytes of a route that declares no `body`. Defaults to
   * 1 MiB. At most `MAX_ROUTE_BODY_BYTES` (100 MiB), the bound above which a
   * declared length is refused before routing.
   */
  readonly maxBodyBytes?: number;
  /**
   * Shutdown grace period in milliseconds: how long `Application.close` waits
   * for the HTTP and broadcast transports before it destroys lingering
   * sockets. Defaults to 5000; at most 300000.
   */
  readonly shutdownTimeoutMs?: number;
  /** Public origin, hosts, trusted proxies, the route deadline and the HTTP server timeouts. */
  readonly server?: AppServerConfig;
  /** Page rendering settings (streaming). */
  readonly render?: AppRenderConfig;
  /** Tracing settings (who may continue a trace). */
  readonly telemetry?: AppTelemetryConfig;
  /** Request handling: the guard tier in front of every request. */
  readonly http?: AppHttpConfig;
  /** The plugins the application runs and the activation mode. */
  readonly plugins?: AppPluginsConfig;
}

/**
 * What a config module states: the kept keys of {@link AppConfig} plus the
 * legacy keys the compat mapper still accepts.
 */
export type JsailsAppConfig = AppConfig & LegacyAppConfig;

/** The resolved `plugins` block: the entries in order. */
export interface ResolvedPluginsConfig {
  /** The `plugins.use` entries in declaration order; empty when none. */
  readonly use: readonly PluginUseEntry[];
}

/** A validated config with absolute directories and resolved defaults. */
export interface ResolvedAppConfig extends ResolvedLegacyAppConfig {
  /** Absolute path of the config module used as the resolution anchor. */
  readonly configPath: string;
  /** Absolute project root. */
  readonly rootDir: string;
  /** Absolute persistent-storage directory. The folder need not exist yet. */
  readonly storageDir: string;
  /** Listen host. */
  readonly host: string;
  /** Listen port; `0` is preserved as an ephemeral-port request. */
  readonly port: number;
  /** Health endpoint path, or `undefined` when disabled. */
  readonly healthPath: string | undefined;
  /** Request-body cap in bytes. */
  readonly maxBodyBytes: number;
  /** Shutdown grace period in milliseconds. */
  readonly shutdownTimeoutMs: number;
  /** The resolved `server` config: origin, hosts, trusted proxies, and timeouts. */
  readonly server: ResolvedServerConfig;
  /** Page rendering settings with unset fields dropped; absent keeps every default. */
  readonly render?: AppRenderConfig;
  /** Tracing settings with unset fields dropped; absent keeps every default. */
  readonly telemetry?: AppTelemetryConfig;
  /** The resolved `http` config. */
  readonly http: ResolvedHttpConfig;
  /** The plugin entries. */
  readonly plugins: ResolvedPluginsConfig;
}

/** Options for {@link validateAppConfig}. */
export interface AppConfigValidationOptions {
  /** Config path anchoring `rootDir`; defaults to `<cwd>/jsails.app.js`. */
  readonly configPath?: string;
  /** Working directory a relative `configPath` is resolved against. */
  readonly cwd?: string;
}

/** A plugin instance, checked by its brand; its factory already parsed its options. */
const pluginInstance = z.custom<PluginInstance>((value) => isPluginInstance(value), {
  message: 'must be a plugin instance',
});

/**
 * The shape of `server.trustedProxies`: `'none'`, or an object of `hops`
 * and `cidrs`. Which combinations are valid (at least one field, a positive
 * integer count, parseable non-empty ranges) is checked by
 * `createOriginPolicy`, whose value-free messages name the field.
 */
const trustedProxies = z.union([
  z.literal('none'),
  z
    .object({ hops: z.number().optional(), cidrs: z.array(z.string()).optional() })
    .strict()
    .transform((value) => value as Exclude<TrustedProxies, 'none'>),
]);

/**
 * The shape of {@link AppConfig}. Unknown keys are rejected (`.strict()`).
 * The resolver checks some fields further: the request-origin fields through
 * the compiler the request pipeline uses (`createOriginPolicy`, value-free),
 * and the timeouts together, as Node checks them.
 */
const appConfigShape = z
  .object({
    rootDir: z.string().min(1).optional(),
    host: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
    storage: z.string().min(1).optional(),
    healthPath: z.union([z.literal(false), z.string().min(1)]).optional(),
    maxBodyBytes: z.number().int().positive().max(MAX_ROUTE_BODY_BYTES).optional(),
    shutdownTimeoutMs: z.number().int().positive().max(MAX_SHUTDOWN_TIMEOUT_MS).optional(),
    server: z
      .object({
        keepAliveTimeoutMs: z.number().int().positive().optional(),
        headersTimeoutMs: z.number().int().positive().optional(),
        requestTimeoutMs: z.number().int().nonnegative().optional(),
        origin: z.string().optional(),
        hosts: z.array(z.string()).optional(),
        trustedProxies: trustedProxies.optional(),
        handlerTimeoutMs: z.number().int().nonnegative().max(2_147_483_647).optional(),
      })
      .strict()
      .optional(),
    render: z
      .object({
        streamTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
      })
      .strict()
      .optional(),
    telemetry: z.object({ trustInbound: z.boolean().optional() }).strict().optional(),
    http: z
      .object({ guards: z.array(fn<Guard>()).optional() })
      .strict()
      .optional(),
    plugins: z
      .object({
        use: z.array(pluginInstance).optional(),
        activation: z
          .object({ mode: z.enum(['locked', 'managed']) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The {@link AppConfig} schema. `AgreeingSchema` fails to compile when it and
 * the interface disagree on a key at any block, so a documented key cannot
 * be missing here (and refused at load) and an accepted key cannot be
 * undocumented.
 */
export const appConfigSchema: z.ZodType<AppConfig> = appConfigShape satisfies AgreeingSchema<
  AppConfig,
  typeof appConfigShape
>;
