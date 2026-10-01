/**
 * Server-components extension: the application-facing seam that binds the
 * transport runtime to a service token and hands page authors a render helper.
 *
 * `serverComponentsPlugin({ components, signingKey, limits, uploads,
 * downloads, clockToleranceMs })` returns a {@link JsailsPlugin} named
 * `server-components`. Its `setup` builds the application's own
 * {@link ComponentRegistry} (the explicit map, or the build's generated entry
 * list), then a {@link ServerComponentsRuntime} over it and a lazy snapshot
 * signer, and provides it under {@link serverComponentsToken}; the teardown
 * closes the runtime. The signer is lazy on purpose: the key is resolved only
 * when a live render or update actually signs/verifies a snapshot, so a static
 * export never needs a key. Every option is validated when the plugin is
 * built, so a bad limit or key fails before the app serves.
 *
 * Key resolution precedence, evaluated lazily on first signature:
 * 1. an explicit `signingKey`;
 * 2. the `JSAILS_COMPONENT_SECRET` environment variable;
 * 3. a fresh random key only when `NODE_ENV` is exactly `development` or `test`;
 * 4. an explicit {@link ServerComponentError} otherwise (missing key), so an
 *    unset, `staging`, or `production` environment fails a live render closed.
 *
 * Rotation: retired keys go in `previousSigningKeys` (or the comma-separated
 * {@link COMPONENT_PREVIOUS_SECRETS_ENV}); they verify snapshots already in
 * open pages, which move to the current key on their next update, and the
 * upload and download references minted before the rotation, which keep the
 * subject tag (and therefore the staging directory) they were minted with.
 *
 * `renderServerComponent(name, context)` is the page-author helper: it resolves
 * the runtime from `context.services` and renders the component to a Preact
 * host element carrying the trusted HTML. `renderServerComponentHtml` returns
 * the same HTML as a string for custom renderers or non-Preact hosts. Both
 * honor `context.renderMode` (static renders only the fallback) and bind the
 * snapshot to `context.origin` (the origin the request was addressed to).
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { h } from 'preact';
import type { VNode } from 'preact';

import type { RequestContext } from '../contracts/http.js';
import {
  definePlugin,
  type JsailsPlugin,
  type PluginDescription,
} from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { loadComponentEntries } from './bootstrap.js';
import type { ServerComponentDefinition } from './component.js';
import {
  componentRegistryFromMap,
  createComponentRegistry,
  describeComponentRegistry,
  type ComponentRegistry,
} from './registry.js';
import { resolveRuntimeLimits, type RuntimeLimitsInput } from './runtime/admission.js';
import { createServerComponentsRuntime } from './runtime/index.js';
import type { ResolvedUpload, ServerComponentsRuntime } from './runtime/index.js';
import {
  DEFAULT_CLOCK_TOLERANCE_MS,
  DEFAULT_SNAPSHOT_TTL_MS,
  HmacComponentSigner,
} from './snapshot.js';
import type { ComponentSigner, SnapshotSignerOptions } from './snapshot.js';
import {
  DEFAULT_UPLOAD_REFERENCE_TTL_MS,
  DiskUploadStore,
  createUploadReferenceSigner,
} from './uploads.js';
import type { UploadReferenceSigner, UploadStore } from './uploads.js';
import { createDownloadReferenceSigner } from './downloads.js';
import type { DownloadReferenceSigner } from './downloads.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Service token the extension registers its runtime under. */
export const serverComponentsToken: ServiceToken<ServerComponentsRuntime> =
  createServiceToken<ServerComponentsRuntime>('server-components');

/** Environment variable holding the snapshot key when `signingKey` is omitted. */
export const COMPONENT_SECRET_ENV = 'JSAILS_COMPONENT_SECRET';

/**
 * Environment variable holding retired snapshot keys (comma-separated) when
 * `previousSigningKeys` is omitted. Verification-only, for key rotation.
 */
export const COMPONENT_PREVIOUS_SECRETS_ENV = 'JSAILS_COMPONENT_PREVIOUS_SECRETS';

/** Minimum signing-key length in bytes (256 bits), mirrored from the signer. */
const MIN_SIGNING_KEY_BYTES = 32;

/** Stable codes carried by a {@link ServerComponentError}. */
export type ServerComponentErrorCode =
  'missing_signing_key' | 'invalid_signing_key' | 'missing_runtime' | 'unavailable';

/** Raised for extension wiring failures (missing key, missing runtime). Value-free. */
export class ServerComponentError extends JsailsError {
  constructor(
    readonly code: ServerComponentErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Options for the optional upload transport of the server-components plugin.
 * How many uploads run at once, and for how long, is the `upload` lane of
 * {@link ServerComponentsOptions.limits}.
 */
export interface ServerComponentsUploadOptions {
  /** Per-upload byte cap. Defaults to the framework 10 MiB cap. */
  readonly maxBytes?: number;
  /** Content-type allowlist. Defaults to raster images plus PDF (SVG excluded). */
  readonly contentTypes?: readonly string[];
  /**
   * Age after which a staged upload is deleted. Defaults to the one-hour
   * reference lifetime plus 15 minutes and may not be shorter than that
   * one-hour lifetime; an action that keeps a file must copy it to permanent
   * storage before then.
   */
  readonly retentionMs?: number;
  /**
   * Byte quota per session subject (all anonymous uploads share one, on top of
   * each accepting component's own `uploads.anonymous` quota). Defaults to
   * 100 MiB.
   */
  readonly maxBytesPerSubject?: number;
  /** File-count quota per session subject. Defaults to 100. */
  readonly maxFilesPerSubject?: number;
}

/**
 * Options for the optional download transport: an action's `download()`
 * result becomes a signed reference to a file in the upload store.
 *
 * @public
 */
export interface ServerComponentsDownloadOptions {
  /** Lifetime of a signed download reference in milliseconds. Defaults to 5 minutes. */
  readonly ttlMs?: number;
}

/** Options for {@link serverComponentsPlugin}. */
export interface ServerComponentsOptions {
  /**
   * Components keyed by component id; each definition's `name` must equal its
   * key. When omitted, the plugin reads the compiler-generated entry list
   * (`.jsails/components.registry.ts`, path-derived ids) when it is set up, so
   * an app never lists its components by hand. Pass an explicit map only for
   * out-of-tree or test wiring.
   */
  readonly components?: Readonly<Record<string, ServerComponentDefinition<any>>>;
  /**
   * Snapshot signing key (>= 32 bytes). When omitted, the extension resolves a
   * key from {@link COMPONENT_SECRET_ENV}, then a fresh random key only in
   * `development`/`test`, and otherwise fails a live render.
   */
  readonly signingKey?: string | Uint8Array;
  /**
   * Retired signing keys still accepted when verifying a snapshot, for a
   * graceful rotation: open pages keep working and move to the current key on
   * their next update. Defaults to {@link COMPONENT_PREVIOUS_SECRETS_ENV}.
   */
  readonly previousSigningKeys?: readonly (string | Uint8Array)[];
  /** Sliding snapshot lifetime in milliseconds, renewed by each update. Defaults to 1 hour. */
  readonly snapshotTtlMs?: number;
  /**
   * Absolute snapshot lifetime from mount in milliseconds, however often the
   * component updates; past it the page must be reloaded. Defaults to 24 hours.
   */
  readonly snapshotMaxAgeMs?: number;
  /**
   * Milliseconds of clock disagreement between instances tolerated by every
   * credential check (snapshot issue and expiry, upload and download reference
   * expiry). Defaults to 60 seconds.
   */
  readonly clockToleranceMs?: number;
  /**
   * Per-lane limits (`update`, `refresh`, `upload`, `download`): requests run
   * at once for the runtime and for one principal, total time, and streamed
   * body idle time. Unset fields keep their defaults.
   */
  readonly limits?: RuntimeLimitsInput;
  /**
   * Opt into server-side uploads. When present the runtime mounts the upload
   * surface (the HTTP layer wires the `/_jsails/components/upload` route) and a
   * disk store rooted at `<storagePath>/component-uploads`, and page/action
   * authors gain {@link resolveUpload}. Omitted leaves uploads disabled. Even
   * when present, only components that declare `uploads` on their definition
   * accept a file.
   */
  readonly uploads?: ServerComponentsUploadOptions;
  /**
   * Opt into downloads: an action may return `download(id)` for a file in the
   * upload store, and the `/_jsails/components/download` route streams it.
   * Omitted leaves downloads disabled.
   */
  readonly downloads?: ServerComponentsDownloadOptions;
}

/**
 * Build the server-components plugin. The registry, runtime, and signer are
 * built during `setup`, so nothing signs or runs a component callback until a
 * live render or request actually happens; every option is validated here.
 *
 * Called with no `components`, the plugin reads the compiler-generated entry
 * list from the app root at `setup` time (see {@link loadComponentEntries});
 * an explicit map replaces it entirely.
 */
export function serverComponentsPlugin(options: ServerComponentsOptions = {}): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('serverComponentsPlugin requires an options object');
  }
  const explicit =
    options.components === undefined ? undefined : componentRegistryFromMap(options.components);
  if (options.signingKey !== undefined) {
    assertKeyLength(options.signingKey);
  }
  for (const key of options.previousSigningKeys ?? []) {
    assertKeyLength(key);
  }
  const clockToleranceMs = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;
  if (!Number.isSafeInteger(clockToleranceMs) || clockToleranceMs < 0) {
    throw new TypeError('clockToleranceMs must be a non-negative integer');
  }
  const limits = resolveRuntimeLimits(options.limits);
  // The disk store is built lazily on the first upload, so a retention it would
  // refuse is rejected here, before serving, rather than on that upload.
  const retentionMs = options.uploads?.retentionMs;
  if (
    retentionMs !== undefined &&
    (!Number.isSafeInteger(retentionMs) || retentionMs < DEFAULT_UPLOAD_REFERENCE_TTL_MS)
  ) {
    throw new TypeError(
      'uploads.retentionMs must not be shorter than the upload reference lifetime',
    );
  }

  const resolveKey = makeKeyResolver(options);
  const resolveKeys = (): ResolvedKeys => ({
    key: resolveKey(),
    previousKeys: resolvePreviousKeys(options),
    clockToleranceMs,
  });
  let registry: ComponentRegistry | undefined = explicit;

  return definePlugin({
    name: 'server-components',
    describe: (): PluginDescription => ({
      needsLive: true,
      ...(explicit === undefined ? { generatedComponents: true } : {}),
      ...(registry === undefined ? {} : { components: describeComponentRegistry(registry) }),
    }),
    setup: async ({ services, rootDir }) => {
      registry = explicit ?? createComponentRegistry(await loadComponentEntries({ rootDir }));
      const store =
        options.uploads === undefined && options.downloads === undefined
          ? undefined
          : createStoreFactory(options.uploads ?? {});
      const runtime = createServerComponentsRuntime({
        components: registry,
        signer: createLazySigner(() => ({
          key: resolveKey(),
          previousKeys: resolvePreviousKeys(options),
          clockToleranceMs,
          ...(options.snapshotTtlMs === undefined ? {} : { ttlMs: options.snapshotTtlMs }),
          ...(options.snapshotMaxAgeMs === undefined ? {} : { maxAgeMs: options.snapshotMaxAgeMs }),
        })),
        snapshotTtlMs: options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
        limits,
        ...(store === undefined ? {} : { store }),
        ...(options.uploads === undefined
          ? {}
          : {
              uploads: {
                signer: createLazyUploadSigner(resolveKeys),
                ...(options.uploads.maxBytes === undefined
                  ? {}
                  : { maxBytes: options.uploads.maxBytes }),
                ...(options.uploads.contentTypes === undefined
                  ? {}
                  : { contentTypes: options.uploads.contentTypes }),
              },
            }),
        ...(options.downloads === undefined
          ? {}
          : {
              downloads: {
                signer: createLazyDownloadSigner(resolveKeys, options.downloads.ttlMs),
              },
            }),
      });
      services.provide(serverComponentsToken, runtime);
      return () => runtime.close();
    },
  });
}

/**
 * Resolve the signing key, honoring the explicit key, then the environment,
 * then a development/test-only random key. Throws when no key is available in
 * any other environment (including an unset `NODE_ENV`); the call is deferred
 * until the first signature via the lazy signer.
 */
function makeKeyResolver(options: ServerComponentsOptions): () => string | Uint8Array {
  return () => {
    if (options.signingKey !== undefined) {
      return options.signingKey;
    }
    const env = process.env[COMPONENT_SECRET_ENV];
    if (env !== undefined && env !== '') {
      return env;
    }
    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      return randomBytes(MIN_SIGNING_KEY_BYTES);
    }
    throw new ServerComponentError(
      'missing_signing_key',
      'server components require a signing key when NODE_ENV is not ' +
        `development/test: set ${COMPONENT_SECRET_ENV} or pass signingKey`,
    );
  };
}

/** Retired keys: the explicit option, else the comma-separated environment variable. */
function resolvePreviousKeys(options: ServerComponentsOptions): readonly (string | Uint8Array)[] {
  if (options.previousSigningKeys !== undefined) {
    return options.previousSigningKeys;
  }
  const env = process.env[COMPONENT_PREVIOUS_SECRETS_ENV];
  if (env === undefined || env.trim() === '') {
    return [];
  }
  const keys = env
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key !== '');
  for (const key of keys) {
    assertKeyLength(key);
  }
  return keys;
}

/** Reject an undersized key up front so a bad config fails before serving. */
function assertKeyLength(key: string | Uint8Array): void {
  const bytes = typeof key === 'string' ? Buffer.byteLength(key, 'utf8') : key.byteLength;
  if (bytes < MIN_SIGNING_KEY_BYTES) {
    throw new ServerComponentError(
      'invalid_signing_key',
      'server components signing key must be at least 32 bytes',
    );
  }
}

/**
 * A signer facade that satisfies the runtime's shape contract without resolving
 * the key. The underlying signer (and therefore the key) is created on the
 * first `subjectFor`/`sign`/`verify` call, so static-only renders never touch
 * the key or the crypto construction.
 */
function createLazySigner(resolveOptions: () => SnapshotSignerOptions): ComponentSigner {
  let signer: ComponentSigner | undefined;
  const ensure = (): ComponentSigner => {
    if (signer === undefined) {
      signer = new HmacComponentSigner(resolveOptions());
    }
    return signer;
  };
  return {
    subjectFor(id) {
      return ensure().subjectFor(id);
    },
    subjectsFor(id) {
      const resolved = ensure();
      return resolved.subjectsFor?.(id) ?? [resolved.subjectFor(id)];
    },
    sign(payload) {
      return ensure().sign(payload);
    },
    verify(token, options) {
      return ensure().verify(token, options);
    },
    renewalDue(snapshot) {
      return ensure().renewalDue(snapshot);
    },
  };
}

/** Current and retired keys, resolved together on a lazy signer's first use. */
interface ResolvedKeys {
  readonly key: string | Uint8Array;
  readonly previousKeys: readonly (string | Uint8Array)[];
  readonly clockToleranceMs: number;
}

/** A lazy download-reference signer: the keys are resolved on first use. */
function createLazyDownloadSigner(
  resolveKeys: () => ResolvedKeys,
  ttlMs: number | undefined,
): DownloadReferenceSigner {
  let signer: DownloadReferenceSigner | undefined;
  const ensure = (): DownloadReferenceSigner => {
    if (signer === undefined) {
      signer = createDownloadReferenceSigner({
        ...resolveKeys(),
        ...(ttlMs === undefined ? {} : { ttlMs }),
      });
    }
    return signer;
  };
  return {
    sign(claims) {
      return ensure().sign(claims);
    },
    verify(token) {
      return ensure().verify(token);
    },
  };
}

/** A lazy upload-reference signer: the keys are resolved on first use. */
function createLazyUploadSigner(resolveKeys: () => ResolvedKeys): UploadReferenceSigner {
  let signer: UploadReferenceSigner | undefined;
  const ensure = (): UploadReferenceSigner => {
    if (signer === undefined) {
      signer = createUploadReferenceSigner(resolveKeys());
    }
    return signer;
  };
  return {
    sign(claims) {
      return ensure().sign(claims);
    },
    verify(token) {
      return ensure().verify(token);
    },
  };
}

/**
 * A memoized disk-store factory: one store per resolved storage path. The store
 * is rooted at `<storagePath>/component-uploads` and created lazily, so a static
 * export (which never resolves a store) never touches the filesystem.
 */
function createStoreFactory(
  uploads: ServerComponentsUploadOptions,
): (storagePath: string) => UploadStore {
  const stores = new Map<string, UploadStore>();
  return (storagePath) => {
    let store = stores.get(storagePath);
    if (store === undefined) {
      store = new DiskUploadStore({
        rootDir: join(storagePath, 'component-uploads'),
        ...(uploads.maxBytes === undefined ? {} : { maxBytes: uploads.maxBytes }),
        ...(uploads.contentTypes === undefined ? {} : { contentTypes: uploads.contentTypes }),
        ...(uploads.retentionMs === undefined ? {} : { retentionMs: uploads.retentionMs }),
        ...(uploads.maxBytesPerSubject === undefined
          ? {}
          : { maxBytesPerSubject: uploads.maxBytesPerSubject }),
        ...(uploads.maxFilesPerSubject === undefined
          ? {}
          : { maxFilesPerSubject: uploads.maxFilesPerSubject }),
      });
      stores.set(storagePath, store);
    }
    return store;
  };
}

/**
 * Resolve a signed upload reference for use inside a component action or page
 * `load`. Verifies the token, checks it belongs to `expectedComponent` and the
 * current request subject, and returns a handle whose `open()`/`delete()` reach
 * the disk store for the request's storage path. Throws a value-free
 * `UploadError` on any invalid, mismatched, or expired reference.
 */
export function resolveUpload(
  reference: unknown,
  expectedComponent: string,
  context: RequestContext,
): ResolvedUpload {
  const runtime = requireRuntime(context);
  return runtime.resolveUpload(reference, {
    expectedComponent,
    expectedSubjectId: context.session?.id ?? null,
    ...(context.storagePath === undefined ? {} : { storagePath: context.storagePath }),
  });
}

/**
 * Render a server component to a Preact host element whose `dangerouslySetInnerHTML`
 * carries the component's trusted HTML. The host element is a plain wrapper
 * (the runtime already emits the marked, signed component root inside it).
 */
export async function renderServerComponent(
  name: string,
  context: RequestContext,
): Promise<VNode<any>> {
  const html = await renderServerComponentHtml(name, context);
  return h('div', { dangerouslySetInnerHTML: { __html: html } });
}

/**
 * Render a server component to its raw HTML string, for custom renderers or
 * non-Preact hosts. Honors `context.renderMode` (static renders only the
 * author's `staticFallback`, never signing); the snapshot is bound to the
 * origin the request was addressed to.
 */
export async function renderServerComponentHtml(
  name: string,
  context: RequestContext,
): Promise<string> {
  const runtime = requireRuntime(context);
  return runtime.render(name, context, { staticMode: context.renderMode === 'static' });
}

/** Resolve the registered runtime from the request context's service registry. */
function requireRuntime(context: RequestContext): ServerComponentsRuntime {
  const services = context.services;
  if (services === undefined) {
    throw new ServerComponentError(
      'unavailable',
      'server components are not available in this context',
    );
  }
  let runtime: ServerComponentsRuntime | undefined;
  try {
    runtime = services.tryGet(serverComponentsToken);
  } catch {
    runtime = undefined;
  }
  if (runtime === undefined) {
    throw new ServerComponentError(
      'missing_runtime',
      'server components runtime is not registered',
    );
  }
  return runtime;
}

export { uploadRefSchema, UploadError } from './uploads.js';
export type { UploadReference } from './protocol.js';
