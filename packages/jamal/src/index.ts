/**
 * `@jsails/jamal`: the contract a `jamal.config.ts` imports. `defineJamal`
 * types the default export against the schema the loader validates, and
 * `secret()` names a deploy secret without holding its value. Everything else
 * runs behind the `jamal` bin; importing this module plans, spawns, and
 * writes nothing.
 */
export {
  JamalConfigError,
  JamalError,
  type JamalErrorCode,
  type JamalErrorOptions,
} from './error.js';
export { defineJamal, type JamalConfigInput } from './config/define.js';
export { SecretRef, secret } from './config/secret-ref.js';
