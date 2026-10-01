/**
 * Barrel for the server-components runtime: the runtime factory and its
 * handle, the lane boundary's public types, the limits schema, and the
 * value-free error class.
 */

export {
  createServerComponentsRuntime,
  type ServerComponentChildRender,
  type ServerComponentChildRenderOptions,
  type ServerComponentRenderMarks,
  type ServerComponentRenderOptions,
  type ServerComponentRoutes,
  type ServerComponentsRuntime,
  type ServerComponentsRuntimeOptions,
} from './create-runtime.js';
export {
  ComponentLimitsErrors,
  DEFAULT_RUNTIME_LIMITS,
  LANES,
  UNLIMITED_ADDRESSES,
  type AddressLimiter,
  type Lane,
  type LaneLimits,
  type RuntimeLimits,
  type RuntimeLimitsInput,
} from './admission.js';
export { ComponentAuthorizeErrors } from './authorize.js';
export { ComponentStaticErrors } from './static-errors.js';
export {
  REJECTIONS,
  type AuthorizedComponentRequest,
  type ComponentRoute,
  type Credential,
  type CredentialEnvelope,
  type LaneCredentialKind,
  type Rejection,
} from './boundary.js';
export type { ResolveUploadOptions, ResolvedUpload } from './upload-transport.js';
export { ServerComponentRuntimeError } from './value-errors.js';
