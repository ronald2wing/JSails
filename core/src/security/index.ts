/**
 * Security primitives (`jsails/security`): session/CSRF verification shared by
 * the runtime, admin, auth, and server-component surfaces, and the request
 * origin and client-address resolution the HTTP pipeline's first stage runs
 * (also for transports that resolve a client outside it).
 */

export * from './csrf.js';
// The resolution functions stay internal: the first pipeline stage runs them,
// and code reads the result from `context.client` and `context.origin`.
export {
  RequestOriginConfigError,
  type ClientAddress,
  type HostPattern,
  type RequestOrigin,
  type RequestOriginConfigErrorCode,
  type ServerOriginConfig,
  type TrustedProxies,
} from './request-origin.js';
