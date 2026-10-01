/**
 * HTTP (`jsails/http`).
 *
 * A thin fetch-based HTTP client seam with JSON encoding/decoding, bounded
 * timeouts, retries, a test fake, and value-free error reporting.
 *
 * It also carries the server's request-observability surface: the ambient
 * request id (`currentRequestId`, readable from any code a request runs, such
 * as a logger or a job dispatch, and the natural id to forward on an outbound
 * call) and the types of `createApp`'s `onError`, `errorPage`, and `readiness`
 * options, so an app can name them when it defines those callbacks apart from
 * the call.
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

export { currentRequestId } from '../server/request-scope.js';
export type {
  RequestErrorHook,
  RequestErrorInfo,
  RequestErrorPhase,
} from '../server/request-errors.js';
export type { ErrorPageRenderer, PublicError } from '../server/error-pages.js';
export type { ReadinessOptions, ReadinessProbe } from '../server/readiness.js';
