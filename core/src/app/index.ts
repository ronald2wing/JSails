/**
 * App subpath (`jsails/app`): the HTTP application surface and the app runtime
 * types, sharing one canonical export with the root `jsails` entry.
 */

// HTTP surface (shared with the root entry).
export { createApp, type AppOptions } from '../server/app.js';
export { createHttpServer, type HttpServerOptions } from '../server/http-server.js';

// The asset index: what `createApp` serves before routing and static export
// copies.
export {
  AssetErrors,
  createAssetIndex,
  type AssetEntry,
  type AssetIndex,
  type AssetIndexSource,
  type AssetRoot,
  type AssetVariant,
  type CreateAssetIndexOptions,
  type ResolvedAssetRoot,
  type WatchAssetRoot,
} from '../assets/index.js';

// Request errors, error pages, and readiness: the same bindings `jsails/http`
// exports, next to the `createApp` options that take them.
export {
  BodyLimitError,
  MAX_ROUTE_BODY_BYTES,
  validateBodyLimit,
  type BodyKind,
  type BodyLimitErrorCode,
  type BodySpec,
  type MultipartFileSpec,
  type MultipartSpec,
} from '../server/route-limits.js';
export { BodyErrors, type BodyBudget } from '../server/body-budget.js';
export { MultipartErrors } from '../server/multipart.js';
export { DeadlineErrors } from '../server/deadline.js';
export type {
  MultipartFieldPart,
  MultipartFilePart,
  MultipartPart,
  RequestBody,
  RouteContext,
} from '../contracts/http.js';
export type {
  RequestErrorHook,
  RequestErrorInfo,
  RequestErrorPhase,
} from '../server/request-errors.js';
export type { ErrorPageRenderer, PublicError } from '../server/error-pages.js';
export type { ReadinessOptions, ReadinessProbe } from '../server/readiness.js';
export {
  createDataSourceReadinessProbe,
  createValkeyReadinessProbe,
  type PingableValkeyConnections,
  type PingableValkeyClient,
  type QueryableDataSource,
  type ReadinessProbeOptions,
} from './readiness-probes.js';

export {
  createOnDemandTlsAllowlist,
  OnDemandTlsAllowlistError,
  type OnDemandTlsAllowlistErrorCode,
  type OnDemandTlsAllowlistHandler,
  type OnDemandTlsAllowlistOptions,
} from './on-demand-tls.js';

// App runtime types.
export {
  ApplicationError,
  type Application,
  type ApplicationErrorCode,
  type ServeHandle,
  type ServeOptions,
  type StandbyServer,
} from './application.js';
export type { ListenHandle } from './serve.js';
export { ServeErrors } from './serve-errors.js';
export { type AppCleanup, type AppServerConfig } from './config/index.js';
