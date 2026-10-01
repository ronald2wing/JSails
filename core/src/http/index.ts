/**
 * HTTP (`jsails/http`).
 *
 * A thin fetch-based HTTP client seam with JSON encoding/decoding, bounded
 * timeouts, retries, a test fake, and value-free error reporting.
 *
 * It also carries the types of `createApp`'s `onError`, `errorPage`, and
 * `readiness` options, so an app can name them when it defines those
 * callbacks apart from the call. The ambient request id (`currentRequestId`)
 * and the per-route body limit (`routeBodyLimit`) are exported from
 * `jsails/app` only: they are server code, and this subpath is browser-safe.
 */

export {
  FetchHttpClient,
  HttpClientError,
  type HttpClient,
  type HttpClientErrorCode,
  type HttpClientOptions,
  type RequestOptions,
} from './client.js';

export {
  FakeHttpClientImpl,
  type FakeHttpClient,
  type FakeHttpHandler,
  type FakeHttpRequest,
  type FakeHttpResponse,
} from './fake.js';

export type {
  RequestErrorHook,
  RequestErrorInfo,
  RequestErrorPhase,
} from '../server/request-errors.js';
export type { ErrorPageRenderer, PublicError } from '../server/error-pages.js';
export type { ReadinessOptions, ReadinessProbe } from '../server/readiness.js';
