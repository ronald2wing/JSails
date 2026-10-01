/**
 * Jamal config barrel: the config error, loader, model types, secret
 * references, and volume-spec parser that `jamal.config.js` consumers import.
 */

export { JamalConfigError } from '../error.js';
export {
  DEFAULT_JAMAL_CONFIG_PATH,
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
  type JamalRegistryConfig,
  type JamalServiceConfig,
  type JamalServiceType,
  type JamalSshConfig,
  type JamalVolumeSpec,
  type RedactedJamalConfig,
} from './model.js';
export { SecretRef, secret } from './secret-ref.js';
export { parseVolumeSpec } from './volume-spec.js';
