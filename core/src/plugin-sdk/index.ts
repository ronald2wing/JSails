/**
 * Server-side plugin SDK (`jsails/plugin-sdk`).
 *
 * This is the supported seam for first-party and third-party JSails plugins.
 * It re-exports the core modules plugins legitimately share (JSON safety,
 * cleanup, HTTP helpers, route access references, the header-session check, Zod
 * issue mapping, Valkey connections, and config-module guards) without making
 * every deep source path a public package export.
 *
 * The plugin contract, service registry, and interceptor tokens remain on
 * `jsails/extensions`; browser-safe helpers remain on `jsails/support`; the
 * error kernel (`JsailsError`, `defineErrors`, `formatError`, `serializeError`)
 * is `jsails/errors`.
 */

export {
  isPublicAccess,
  publicAccess,
  type AccessRef,
  type RouteAccess,
} from '../api/access-ref.js';
export * from '../url/absolute.js';
export * from '../url/unsafe-schemes.js';
export * from '../database/owned-tables.js';
export * from '../database/upsert.js';
export * from '../validation/primitives.js';
export * from '../contracts/awaitable.js';
export * from '../valkey/backend-errors.js';
export * from '../extensions/cleanup.js';
export * from '../extensions/lazy-resource.js';
export * from '../config-modules.js';
export * from '../security/constant-time.js';
export * from '../cli/usage-error.js';
export * from '../build/generated-registry.js';
export * from '../url/origin.js';
export * from '../url/relative-path.js';
export * from '../json/shape.js';
export * from '../url/normalize.js';
export { isHeaderAuthenticatedSession } from '../security/origin-check.js';
export * from '../valkey/connection.js';
export {
  createValkeyConnections,
  DEFAULT_VALKEY_TIMEOUTS,
  ValkeyError,
  type DedicatedValkeyRole,
  type SharedValkeyRole,
  type ValkeyClient,
  type ValkeyConnections,
  type ValkeyConnectionsDependencies,
  type ValkeyConnectionsOptions,
  type ValkeyErrorCode,
  type ValkeyRole,
  type ValkeyScript,
  type ValkeyScriptDefinition,
  type ValkeyTimeouts,
} from '../valkey/connections.js';
export * from '../valkey/plugin.js';
export {
  useValkeyConnections,
  valkeyToken,
  type ValkeyConnectionsUse,
} from '../valkey/provider.js';
export * from '../valkey/app-prefix.js';
export * from '../support/first-configured.js';
export * from '../support/path-containment.server.js';
export * from '../database/primary-key.js';
export * from '../validation/zod-issues.js';
