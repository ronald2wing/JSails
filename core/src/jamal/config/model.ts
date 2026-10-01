/**
 * The normalized Jamal config model: the shape `normalizeJamalConfig` returns
 * after validating a `jamal.config.js` default export and merging its `local`
 * and `production` overlays into the base fields.
 */

import type { SecretRef } from './secret-ref.js';

/** A structured env entry with an optional alias and a clear flag. */
export interface JamalEnvEntry {
  readonly value: string | SecretRef;
  readonly alias: string | undefined;
  readonly clear: boolean;
}

/** A value in `env`: a literal string, a secret reference, or a structured entry. */
export type JamalEnvValue = string | SecretRef | JamalEnvEntry;

/** A parsed volume specification for `config.volumes`. */
export interface JamalVolumeSpec {
  /** Named volume name or host path. */
  readonly source: string;
  /** Absolute container mount path. */
  readonly containerPath: string;
  /** Access mode: `'ro'` or `'rw'`, or undefined. */
  readonly options: string | undefined;
  /** Whether the source is a host path rather than a named Docker volume. */
  readonly host: boolean;
}

/**
 * Services a Jamal app may declare. `mariadb`/`postgres`/`valkey`/
 * `meilisearch`/`typesense`/`opensearch`/`s3` are backing services (data/state
 * stores the app depends on); `mailpit`/`adminer` are dev-only tools rendered
 * by the local Compose planner and skipped by the production accessory planner.
 */
export const JAMAL_SERVICE_TYPES = Object.freeze([
  'mariadb',
  'postgres',
  'valkey',
  'meilisearch',
  'typesense',
  'opensearch',
  's3',
  'mailpit',
  'adminer',
] as const);

/** One of {@link JAMAL_SERVICE_TYPES}. */
export type JamalServiceType = (typeof JAMAL_SERVICE_TYPES)[number];

/** Health-check settings: a path plus poll intervals. */
export interface JamalHealthConfig {
  /** An absolute path starting with `/`. */
  readonly path: string;
  /** Timeout per probe, in milliseconds (positive integer). */
  readonly timeoutMs: number;
  /** Interval between probes, in milliseconds (positive integer). */
  readonly intervalMs: number;
  /** Number of retries (>= 0); undefined means the executor default. */
  readonly retries: number | undefined;
  /** Delay between retry attempts, in milliseconds (> 0). */
  readonly retryDelayMs: number | undefined;
  /** Sleep before the first health probe, in milliseconds (> 0). */
  readonly readinessDelayMs: number | undefined;
}

/** SSH connection options for the production server. */
export interface JamalSshConfig {
  readonly user: string | undefined;
  readonly port: number | undefined;
  readonly proxyCommand: string | undefined;
  readonly logLevel: string | undefined;
  readonly keysOnly: boolean;
  readonly keys: readonly string[];
  readonly config: string | undefined;
  readonly forwardAgent: boolean;
}

/** A declared backing service. */
export interface JamalServiceConfig {
  readonly type: JamalServiceType;
}

/** Registry credentials for the production image host. */
export interface JamalRegistryConfig {
  readonly server: string;
  readonly username: string;
}

/**
 * Where the app runs during local development.
 *
 * - `host`: on the developer's machine (`npm run dev`); jamal runs only the
 *   backing services.
 * - `dev`: in a container built from a Node image, with the project mounted and
 *   `jsails dev` reloading on save, like Laravel Sail.
 * - `image`: in a container built from the project's own Dockerfile, the way it
 *   runs in production.
 */
export const JAMAL_LOCAL_APP_MODES = ['host', 'dev', 'image'] as const;

/** One of {@link JAMAL_LOCAL_APP_MODES}. */
export type JamalLocalAppMode = (typeof JAMAL_LOCAL_APP_MODES)[number];

/** The local-development overlay: published ports and where the app runs. */
export interface JamalLocalConfig {
  /** Port name -> published port (1..65535). */
  readonly ports: Readonly<Record<string, number>>;
  /** Where the app runs. Defaults to `host`. */
  readonly app: JamalLocalAppMode;
}

/** The production overlay: the target server, optional domain/on-demand TLS, and registry. */
export interface JamalProductionConfig {
  readonly server: string;
  readonly domain: string | undefined;
  /**
   * On-demand TLS allowlist URL for kamal-proxy. Mutually exclusive with a
   * static `domain`: when set, the proxy routes unknown hostnames and authorizes
   * each at certificate-issuance time by calling this URL. An absolute
   * `http://`/`https://` URL or a local path starting with `/`.
   */
  readonly onDemandTlsUrl: string | undefined;
  readonly registry: JamalRegistryConfig | undefined;
  readonly ssh: JamalSshConfig | undefined;
  /**
   * Deployment destination, mirroring Kamal's `destination`. Selects
   * `<secretsPath>.<destination>` instead of `<secretsPath>` and namespaces the
   * host env-file directory. Absent means the plain secrets file.
   */
  readonly destination: string | undefined;
  /**
   * Secrets file path relative to the project root; defaults to
   * `.jamal/secrets`. Mirrors Kamal's `secrets_path`.
   */
  readonly secretsPath: string | undefined;
}

/** Logging driver + options for container run step. */
export interface JamalLoggingConfig {
  readonly driver: string;
  readonly options: Readonly<Record<string, string>>;
}

/**
 * Varnish caching reverse-proxy configuration.
 *
 * The cache proxy sits BETWEEN kamal-proxy and the application container. It is
 * OPT-IN (default OFF) — when `enabled` is absent or `false`, the deploy
 * topology is unchanged and kamal-proxy routes directly to the app container.
 * The image, memory size, backend host/port, and cookie allowlist are
 * configurable; every value is validated and defaults to a pinned version.
 */
export interface JamalCacheProxyConfig {
  /** Enable the cache proxy. Default `false` (opt-in). */
  readonly enabled: boolean;
  /** The Varnish image; defaults to `varnish:7.7`. */
  readonly image: string;
  /** The memory size string (`-e VARNISH_SIZE=...`); defaults to `256m`. */
  readonly size: string;
  /**
   * Cookie names whose pairs are stripped from a request so it can be cached.
   * Default `undefined`: every cookie-bearing request is passed through (never
   * cached). When set, only the named pairs are removed; a request that still
   * carries any other cookie is passed through (still never cached).
   */
  readonly cookieAllowlist: readonly string[] | undefined;
}

/** The normalized, frozen config model (base fields plus both overlays). */
export interface JamalConfig {
  readonly service: string;
  readonly image: string;
  readonly command: string | undefined;
  readonly health: JamalHealthConfig | undefined;
  readonly env: Readonly<Record<string, JamalEnvEntry>>;
  readonly services: Readonly<Record<string, JamalServiceConfig>>;
  readonly volumes: Readonly<Record<string, JamalVolumeSpec>>;
  readonly local: JamalLocalConfig;
  readonly production: JamalProductionConfig | undefined;
  readonly logging: JamalLoggingConfig | undefined;
  /** The optional Varnish caching reverse-proxy configuration. */
  readonly cacheProxy: JamalCacheProxyConfig | undefined;
}

/** Plan-safe model: identical to {@link JamalConfig} but with `env` values as strings. */
export interface RedactedJamalConfig {
  readonly service: string;
  readonly image: string;
  readonly command: string | undefined;
  readonly health: JamalHealthConfig | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly services: Readonly<Record<string, JamalServiceConfig>>;
  readonly volumes: Readonly<Record<string, JamalVolumeSpec>>;
  readonly local: JamalLocalConfig;
  readonly production: JamalProductionConfig | undefined;
  readonly logging: JamalLoggingConfig | undefined;
  readonly cacheProxy: JamalCacheProxyConfig | undefined;
}

// ---------------------------------------------------------------------------
// Schema (shape + type + range checks; safety checks live in the resolver)
// ---------------------------------------------------------------------------
