/**
 * Security primitives (`jsails/security`): the surface registry every route
 * and the public files register in, the access chain each route request
 * passes (the cross-site check, then the gate), the cross-site check itself
 * for surfaces that run outside it, and the request origin and
 * client-address resolution the HTTP pipeline's first stage runs (also for
 * transports that resolve a client outside it).
 */

// The chain itself stays internal: the route boundary is its only caller.
export { AccessErrors } from './access-errors.js';
export {
  crossSiteVerdict,
  isUnsafeMethod,
  requiresOriginCheck,
  type CrossSiteVerdict,
} from './origin-check.js';
export {
  SurfaceErrors,
  surfacesOf,
  type CredentialKind,
  type SurfaceDescriptor,
  type SurfaceKind,
  type SurfaceMatch,
  type SurfaceRegistry,
} from './surfaces.js';
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
