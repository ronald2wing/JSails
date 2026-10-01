/**
 * `jsails/errors`: the error kernel, browser-safe and dependency-free.
 *
 * The one home of the error base, the registries that declare codes, the
 * client-audience constructors, `normalizeError` and its translators, and the
 * value-free inspection and serialization helpers. A package that only needs to
 * raise or recognize framework errors imports this subpath and loads nothing
 * else of the framework.
 *
 * The server half (the boundary table and the problem+json encoder) is exported
 * from the root entry, `jsails`.
 */

export { ERROR_BRAND } from './brand.js';
export {
  isContextKind,
  isContextValue,
  type ContextKind,
  type ContextOf,
  type ContextSchema,
  type ContextValueOf,
} from './context-schema.js';
export { errnoCode, formatError, isErrno } from './inspect.js';
export {
  isJsailsError,
  JsailsError,
  type JsailsErrorContextValue,
  type JsailsErrorOptions,
} from './jsails-error.js';
export {
  conflict,
  forbidden,
  invalid,
  notFound,
  rateLimited,
  RequestErrors,
  tooLarge,
  unauthenticated,
  type ErrorIssue,
} from './kernel.js';
export {
  ERROR_KINDS,
  isErrorKind,
  isRetryableKind,
  type ErrorAudience,
  type ErrorKind,
} from './kinds.js';
export { normalizeError, registerErrorTranslator, type ErrorTranslator } from './normalize.js';
export {
  defineErrors,
  errorRegistryConflicts,
  invariant,
  isRegistryError,
  KernelErrors,
  registeredErrorCodes,
  type CheckedDefinitions,
  type ErrorCodeDefinition,
  type ErrorCodeDefinitions,
  type ErrorRegistry,
  type MessageSlots,
  type Payload,
  type PayloadDeclaration,
  type PayloadOf,
  type RegisteredErrorCode,
  type RegistryError,
  type RegistryErrorArguments,
  type RegistryErrorClass,
  type RegistryErrorOptions,
} from './registry.js';
export { serializeError, type SerializedError } from './serialize.js';
