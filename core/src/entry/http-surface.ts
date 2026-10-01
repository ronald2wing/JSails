/**
 * Root-only HTTP surface: the Hono application and the Node server factory.
 * Importing it never opens a port.
 */

export { createApp, HTTP_METHODS, routeTableOf, type AppOptions } from '../server/app.js';
export { assetRowsOf, type AssetRow } from '../assets/surface-rows.js';
export {
  DEFAULT_MAX_BODY_BYTES,
  MAX_ROUTE_BODY_BYTES,
  type BodyKind,
  type BodySpec,
  type MultipartFileSpec,
  type MultipartSpec,
} from '../server/route-limits.js';
export { BodyErrors, type BodyBudget } from '../server/body-budget.js';
export { MultipartErrors } from '../server/multipart.js';
export { DeadlineErrors } from '../server/deadline.js';

export { createHttpServer, type HttpServerOptions } from '../server/http-server.js';
export { readJsonBody, type ReadJsonBodyOptions } from '../api/json-body.js';
export type { AppEnv, HttpVariables } from '../server/env.js';
export { RequestScopeErrors } from '../server/request-scope.js';
export {
  currentRequestFrame,
  identitySource,
  RequestFrameErrors,
  type AppStatics,
  type ClaimedScope,
  type ClaimResult,
  type CredentialNames,
  type IdentitySource,
  type IdentitySourceOptions,
  type RequestFrame,
  type RoutedFrame,
} from '../server/request-frame.js';
export {
  RouteErrors,
  type RouteKind,
  type RouteMeta,
  type RouteOrigin,
} from '../server/route-meta.js';
export type { PluginOrigins, RouteTable } from '../server/route-table.js';
export type { ResponseTransform, RouteRateLimit } from '../server/route-boundary.js';
export {
  createHttpRoutes,
  type FetchHandler,
  type HttpContributions,
  type HttpRouteGrants,
  type HttpRoutes,
  type HttpRoutesOptions,
  type HttpRoutesRegistrar,
  type MountContribution,
  type MountOptions,
  type RouteContribution,
  type RouteMethod,
  type RouteSpec,
  type TransformContribution,
} from '../server/http-routes.js';
export { RouteModuleErrors, type RouteModuleKind } from '../routing/route-module.js';
export type {
  ClientAddress,
  HostPattern,
  RequestOrigin,
  ServerOriginConfig,
  TrustedProxies,
} from '../security/request-origin.js';

export type {
  ApiHandler,
  ApiMethod,
  ApiModule,
  Authorize,
  JsonObject,
  JsonValue,
  RequestBody,
  RequestContext,
  ResolveSession,
  RouteContext,
  Session,
  SessionStore,
} from '../contracts/http.js';
