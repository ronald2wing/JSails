/**
 * Server-only addendum barrel for jsails/support (`jsails/support/server`).
 *
 * Re-exports the browser-safe core and layers on the server-only namespaces
 * (`Files`, `Media`, `Cookie`) plus the top-level `parseFrontmatter` helper
 * and `guardedFetch`, the one outbound HTTP primitive. The server-only crypto
 * conveniences (`hashSync`, `hmacSync`, `timingSafeEqual`) are exported under
 * distinct names; the shared async `Cryptography` is a single coherent surface
 * re-exported from `./cryptography.js` via `./index.js` (see
 * `cryptography.server.ts`). This barrel is NOT part of the browser projection:
 * reach it only from server code, and never import it statically from
 * `./index.js`.
 */

export * from './index.js';

export { FilesErrors, Files } from './files.server.js';
export type { WriteJsonOptions, CopyOptions, GlobOptions } from './files.server.js';

export { MediaErrors, Media } from './media-detect.server.js';
export type { MediaType, ImageSize } from './media-detect.server.js';

export { CookieErrors, Cookie } from './cookie.server.js';
export type {
  CookieParseOptions,
  CookieSerializeOptions,
  SetCookieParseOptions,
  ParsedSetCookie,
} from './cookie.server.js';

// Server-only crypto conveniences, sharing the ONE `Cryptography` namespace:
// `hashSync`/`hmacSync`/`timingSafeEqual` are the synchronous node:crypto
// additions; `Cryptography` itself is the same async surface the browser sees.
export {
  ServerCryptography,
  hashSync,
  hmacSync,
  timingSafeEqual,
  CryptographyErrors,
  Cryptography,
} from './cryptography.server.js';
export type { ServerHashAlgorithm, HmacAlgorithm } from './cryptography.server.js';

export {
  FrontmatterErrors,
  parseFrontmatter,
  type FrontmatterResult,
} from './frontmatter.server.js';

export {
  GuardedFetchErrors,
  createGuardedFetch,
  guardedFetch,
  type GuardedConnectTarget,
  type GuardedConnector,
  type GuardedFetch,
  type GuardedFetchMethod,
  type GuardedFetchOptions,
  type GuardedFetchTransport,
  type GuardedResolver,
  type GuardedResponse,
} from './guarded-fetch.server.js';
