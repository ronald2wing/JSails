/**
 * JSails plugins: the packageable, extendable superset of the plain extension.
 *
 * A plugin is an extension with two additions:
 *
 * - a declarative `renderer` passthrough carried by identity for the config
 *   loader, never validated, collected, or invoked by the runner;
 * - a {@link PluginContext} whose `setup` can additionally register interceptors
 *   and observers against the per-application registry (see
 *   `src/extensions/interceptors.ts`).
 *
 * `priority` (default `0`, lower runs first), `disabled`, `requires`,
 * and `provides` are inherited from {@link JsailsExtension}, so a
 * plugin participates in the same contract-ordered setup phase as every
 * extension. A plugin compiles to the low-level
 * {@link JsailsExtension} shape at runtime — the `extensions:` config key and
 * the plain {@link JsailsExtension} remain the underlying mechanism the runner
 * consumes.
 *
 * Everything below is type-only or an identity helper, so importing this module
 * never pulls an ORM, HTTP, queue, or Socket.IO runtime into the extension
 * foundation subpath.
 */

import type { PageRenderer } from '../contracts/render.js';
import type { ExtensionCleanup, ExtensionContext, JsailsExtension } from './extension.js';
import type {
  AfterInterceptor,
  BeforeInterceptor,
  EventToken,
  InterceptorRegistry,
  Observer,
  OperationToken,
} from './interceptors.js';
import type { Awaitable } from '../contracts/awaitable.js';

/**
 * The setup context handed to a plugin's `setup`. It extends the extension
 * context with interceptor and observer registration; `priority` is the
 * plugin's own and is bound by the runner, so it is never passed here.
 */
export interface PluginContext extends ExtensionContext {
  /** Register a before hook for `operation` (or an after hook via `phase`). */
  intercept<TArgs = unknown, TResult = unknown>(
    operation: OperationToken<TArgs, TResult>,
    fn: BeforeInterceptor<TArgs>,
    options?: { phase?: 'before' },
  ): void;
  intercept<TArgs = unknown, TResult = unknown>(
    operation: OperationToken<TArgs, TResult>,
    fn: AfterInterceptor<TArgs, TResult>,
    options: { phase: 'after' },
  ): void;
  /** Register an observer for `event`. */
  observe<TPayload = unknown>(event: EventToken<TPayload>, fn: Observer<TPayload>): void;
  /**
   * Read-only handle to the shared interceptor/observer registry. A plugin can
   * wrap this as a service rather than creating an isolated local registry.
   * Registration is still guarded by the registry's own seal after setup.
   */
  readonly interceptorRegistry: InterceptorRegistry;
}

/**
 * Static schema declaration owned by a plugin.
 *
 * `db:push` / `db:diff` read this without calling `setup`, so a plugin can own
 * database entities without forcing the app to list them manually. Every entry
 * is a TypeORM entity class; the plugin's runtime `setup` remains separate.
 */
export interface PluginSchema {
  /** Entity classes owned by this plugin. */
  readonly entities?: readonly Function[];
  /**
   * Live tables this plugin's own migrator manages. `db:push`/`db:diff` plan
   * no operation for them, and an entity on one of these names is an error.
   */
  readonly unmanagedTables?: readonly string[];
}

/**
 * A packageable unit of functionality: an extension plus a declarative
 * renderer passthrough and a setup context that can register
 * interceptors and observers. `name`, `requires`, `provides`,
 * `priority`, and `disabled` are inherited from {@link JsailsExtension}.
 */
export interface JsailsPlugin extends JsailsExtension {
  /** Static schema declaration read by `db:push`/`db:diff` without `setup`. */
  readonly schema?: PluginSchema;
  /** Page renderer carried through by identity, never invoked. */
  readonly renderer?: PageRenderer;
  /**
   * Declarative metadata readable without running `setup`. Pure, side-effect-free,
   * and never invokes callbacks, signs snapshots, or performs I/O. Add fields
   * only as concrete consumers need them — this is not a generic free-form bag.
   */
  readonly describe?: () => PluginDescription;
  setup(context: PluginContext): Awaitable<void | ExtensionCleanup>;
}

/**
 * Declarative metadata a plugin exposes through {@link JsailsPlugin.describe}.
 * Each field is populated only when the plugin owns that kind of metadata;
 * a consumer merges results from every plugin that returns a description.
 */
export interface PluginDescription {
  /** Server components registered by this plugin, when it knows them without `setup`. */
  readonly components?: readonly {
    readonly name: string;
    readonly actions: readonly string[];
    readonly writableKeys: readonly string[];
  }[];
  /**
   * `true` when this plugin serves the app's compiler-generated component
   * entries (`.jsails/components.registry`). They live under the app root,
   * which a plugin only learns at `setup` ({@link ExtensionContext.rootDir}),
   * so a reader that never runs setup, such as static `jsails describe`,
   * loads them from the app root itself when `components` is absent.
   */
  readonly generatedComponents?: boolean;
  /**
   * CSS custom properties this plugin contributes to the shared theme.
   * Inert declarative metadata — never resolved at import time. Collected
   * by the extension runner and fed to {@link themePlugin}.
   */
  readonly theme?: {
    readonly tokens: Readonly<Record<string, string>>;
  };
  /**
   * Does this plugin need the live server? The single deployment-shape axis.
   *
   * - `true` — full shapes only (`auth`, `jobs`, `broadcast`, `server-components`).
   * - absent (`false`) — static and full (`content`, `seo`, `theme`, `i18n`,
   *   mail/cache's in-memory fallbacks).
   *
   * This is a boolean because it is one question — "needs live?" — not a
   * ternary. A build-time-only concern is not a runtime plugin: it belongs to
   * the build toolchain (as `tsc`/`vite build` do), a different axis than the
   * runtime plugin surface. Reserving a third `'static'` value for a future
   * runtime plugin would abstract an empty set and blur the tooling boundary.
   */
  readonly needsLive?: boolean;
}

/**
 * Identity helper for a plugin literal. Typing the parameter as
 * {@link JsailsPlugin} (rather than a `const` generic) keeps the plugin's
 * `setup` contextually typed as {@link PluginContext} even when the literal is
 * nested inside a `JsailsExtension[]` — e.g. `runExtensions([definePlugin({...})])`
 * or `config.extensions` — where an outer `JsailsExtension` context would
 * otherwise widen the parameter to {@link ExtensionContext} and hide
 * `intercept`/`observe`. Structural validation still happens later in
 * `runExtensions` / the config resolver.
 */
export function definePlugin(plugin: JsailsPlugin): JsailsPlugin {
  return Object.freeze(plugin);
}

/**
 * Structural guard for a plugin object. The activation path (discovered plugin
 * modules) and the `plugins.use` path (specifier and factory entries) both use
 * it, so they agree on what counts as a plugin before the extension runner
 * sees it.
 */
export function isJsailsPlugin(value: unknown): value is JsailsPlugin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    record['name'].trim() !== '' &&
    typeof record['setup'] === 'function'
  );
}
