/**
 * Server-side plugin SDK (`jsails/plugin-sdk`).
 *
 * This is the supported seam for first-party and third-party JSails plugins.
 * It re-exports the core internals plugins legitimately share (value-free
 * errors, JSON safety, cleanup, HTTP helpers, trusted-mutation checks, Zod issue
 * mapping, and config-module helpers) without making every deep internal path a
 * public package export.
 *
 * The plugin contract, service registry, and interceptor tokens remain on
 * `jsails/extensions`; browser-safe helpers remain on `jsails/support`.
 */

export * from '../internal/absolute-url.js';
export * from '../internal/awaitable.js';
export * from '../internal/backend-errors.js';
export * from '../internal/cleanup.js';
export * from '../internal/config-module.js';
export * from '../internal/crypto.js';
export * from '../internal/errors.js';
export * from '../internal/generated-registry.js';
export * from '../internal/http.js';
export * from '../internal/http-responses.js';
export * from '../internal/json-safe.js';
export * from '../internal/paths.js';
export * from '../internal/redirect.js';
export * from '../internal/serialize-error.js';
export * from '../internal/trusted-mutation.js';
export * from '../internal/value-selection.js';
export * from '../internal/zod.js';
