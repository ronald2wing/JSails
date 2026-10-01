/**
 * Routing subpath (`jsails/routing`): the routing surface and the token of
 * the route manifest.
 *
 * This barrel re-exports the routing helpers the root `jsails` entry already
 * exposes through `exports/routing.ts`, plus `routeManifestToken`, so a custom
 * plugin can require the manifest. The `routing` plugin that provides it is
 * one the framework adds to every application itself, so it is no subpath
 * export: the contract stays free of the plugin contract and its schemas.
 */

// Routing surface (shared with the root entry).
export {
  discoverRoutes,
  routeToOutputPath,
  substituteRouteParams,
  RouteManifestError,
  type DiscoverRoutesOptions,
  type NotFoundManifestEntry,
  type RouteManifest,
  type RouteManifestEntry,
} from './routes.js';

export { type RouteMiddleware, validateMiddlewareList } from './middleware.js';

// Signed URLs: HMAC-SHA256-signed URL generation/verification with optional
// expiry, independent of any route registry.
export {
  HmacUrlSigner,
  SignedUrlError,
  type UrlSigner,
  type UrlSignerOptions,
  type VerifiedSignedUrl,
} from './signed-urls.js';

// The manifest the framework's `routing` plugin provides.
export { routeManifestToken } from './token.js';
