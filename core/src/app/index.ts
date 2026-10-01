/**
 * App subpath (`jsails/app`): the HTTP application surface and the app runtime
 * types, sharing one canonical export with the root `jsails` entry.
 */

// HTTP surface (shared with the root entry).
export { createApp, type AppOptions } from '../server/app.js';
export { createHttpServer, type HttpServerOptions } from '../server/http-server.js';
export { createPublicFilesMiddleware } from './public-files.js';

// App runtime types.
export {
  ApplicationError,
  type Application,
  type ApplicationErrorCode,
  type ServeHandle,
} from './application.js';
export { type AppCleanup } from './config/index.js';
