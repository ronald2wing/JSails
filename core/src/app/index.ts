/**
 * App subpath (`jsails/app`): the HTTP application surface and the app runtime
 * types, sharing one canonical export with the root `jsails` entry.
 */

// HTTP surface (shared with the root entry).
export { createApp, type AppOptions } from '../server/app.js';
export { createHttpServer, type HttpServerOptions } from '../server/http-server.js';
export { createPublicFilesMiddleware } from './public-files.js';

// Request errors, error pages, and readiness: the same bindings `jsails/http`
// exports, next to the `createApp` options that take them.
export { currentRequestId } from '../server/request-scope.js';
export {
  BodyLimitError,
  MAX_ROUTE_BODY_BYTES,
  routeBodyLimit,
  validateBodyLimit,
  type BodyLimitErrorCode,
} from '../server/body-limits.js';
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
  type LazyPingableValkey,
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
} from './application.js';
export { type AppCleanup, type AppServerConfig } from './config/index.js';
