/**
 * Root-only environment surface: the config accessor, the bounded readers
 * over a plain string source, and the error registries of environment
 * resolution and sealed credentials.
 */

export { env, type EnvAccessor } from '../environment/accessor.js';
export {
  CredentialsErrors,
  EnvironmentErrors,
  type EnvironmentIssue,
} from '../environment/errors.js';
export {
  readDatabaseEnvironment,
  readEnvironment,
  readValkeyEnvironment,
  type DatabaseEnvironment,
  type DatabaseType,
  type ValkeyEnvironment,
} from '../environment/read.js';
