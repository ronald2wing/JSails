/**
 * Root-only HTTP surface: the Hono application and the Node server factory.
 * Importing it never opens a port.
 */

export { createApp, CSRF_HEADER, HTTP_METHODS, type AppOptions } from '../server/app.js';
export { DEFAULT_MAX_BODY_BYTES } from '../server/default-body-limit.js';

export { createHttpServer, type HttpServerOptions } from '../server/http-server.js';
export { readJsonBody, type ReadJsonBodyOptions } from '../api/json-body.js';
export type { AppEnv } from '../server/env.js';
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
  RenderPage,
  RequestContext,
  ResolveSession,
  Session,
  SessionStore,
} from '../contracts/http.js';
