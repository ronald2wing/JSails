/**
 * Jamal config barrel: the config error, loader, model types, secret
 * references, `defineJamal`, and the volume-spec parser.
 */

export { JamalConfigError } from '../error.js';
export { defineJamal, type JamalConfigInput } from './define.js';
export {
  JAMAL_CONFIG_FILENAMES,
  findJamalConfig,
  loadJamalConfig,
  normalizeJamalConfig,
  redactJamalConfig,
} from './loader.js';
export {
  JAMAL_LOCAL_APP_MODES,
  JAMAL_SERVICE_TYPES,
  type JamalCacheProxyConfig,
  type JamalConfig,
  type JamalEnvEntry,
  type JamalEnvValue,
  type JamalHealthConfig,
  type JamalLocalAppMode,
  type JamalLocalConfig,
  type JamalLoggingConfig,
  type JamalProductionConfig,
  type JamalProxyConfig,
  type JamalRegistryConfig,
  type JamalServiceConfig,
  type JamalServiceType,
  type JamalSshConfig,
  type JamalVolumeSpec,
  type RedactedJamalConfig,
} from './model.js';
export { SecretRef, secret } from './secret-ref.js';
export { parseVolumeSpec } from './volume-spec.js';
