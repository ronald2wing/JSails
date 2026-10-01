/**
 * The error registries of environment resolution and sealed credentials:
 * `environment.*` (choosing the environment, reading its layers, the config
 * accessor, the bounded readers) and `credentials.*` (keys, the sealed
 * document, the credentials commands).
 *
 * Every message names a variable, a project-relative file, an environment
 * name or a key id, never a value: a value read from any layer may be a
 * secret, and so may an operator's mistyped `NODE_ENV`.
 */

import { defineErrors, type ErrorRegistry, type Payload } from '../errors/registry.js';

/**
 * One value-free problem a bounded reader found: a variable path and a stable
 * code, with a message derived from the schema alone.
 *
 * @public
 */
export interface EnvironmentIssue {
  /** Location of the failure, e.g. `["DATABASE_PORT"]`. Never a raw value. */
  readonly path: readonly (string | number)[];
  /** Stable machine code, e.g. `"required"`, `"invalid_type"`, `"too_big"`. */
  readonly code: string;
  /** Short description derived only from the schema, never from input. */
  readonly message: string;
}

const ENVIRONMENT_ERRORS = {
  invalid_name: {
    kind: 'invalid',
    message:
      'the environment name must be 1 to 64 letters, digits, "-" or "_", starting with a letter or a digit',
    suggestion: 'set JSAILS_ENV (or pass --env) to a name such as development, test or production',
  },
  conflict: {
    kind: 'invalid',
    message:
      'NODE_ENV is set to something other than {expected}, the value JSAILS_ENV={name} derives',
    context: { name: 'identifier', expected: ['development', 'test', 'production'] },
    suggestion:
      'unset NODE_ENV and choose the environment with JSAILS_ENV alone; NODE_ENV follows from it',
  },
  reserved_key: {
    kind: 'invalid',
    message: '{file} defines {key}, which only the real environment may set',
    context: { file: 'relative-path', key: 'identifier' },
    suggestion: 'remove it from the file and set it in the shell or the process manager',
  },
  unreadable_file: {
    kind: 'unavailable',
    message: '{file} exists but cannot be read',
    context: { file: 'relative-path' },
    suggestion: 'fix its permissions, or remove it if it should not take part',
  },
  unreadable_secrets_file: {
    kind: 'unavailable',
    message: 'JSAILS_SECRETS_FILE names a file that cannot be read',
    suggestion: 'check the path and the mount that provides it, or unset JSAILS_SECRETS_FILE',
  },
  invalid_secrets_file: {
    kind: 'invalid',
    message: 'the file JSAILS_SECRETS_FILE names is not a secrets file: {problem}',
    context: {
      problem: [
        'not JSON',
        'not an object',
        'unsupported version',
        'no values object',
        'invalid variable name',
        'a value that is not a string',
        'a value containing NUL',
      ],
    },
    suggestion: 'write it as {"v": 1, "values": {"NAME": "value"}}',
  },
  secrets_file_reserved_key: {
    kind: 'invalid',
    message:
      'the file JSAILS_SECRETS_FILE names defines {key}, which only the real environment may set',
    context: { key: 'identifier' },
    suggestion: 'remove it from the secrets file',
  },
  invalid_marker: {
    kind: 'invalid',
    message: 'JSAILS_ENV_RESOLVED is set but is not a marker a JSails process wrote',
    suggestion: 'unset JSAILS_ENV_RESOLVED; only a parent JSails command sets it',
  },
  inherited_foreign_project: {
    kind: 'invalid',
    message:
      'this process inherited an environment a parent JSails command resolved for another project directory',
    suggestion:
      'start a command for another project from a shell that has not resolved one; a program that spawns it passes an environment without JSAILS_ENV_RESOLVED and the values its own resolution loaded',
  },
  inherited_mismatch: {
    kind: 'invalid',
    message:
      'this process inherited the {inherited} environment from a parent JSails command but was asked for {requested}',
    context: { inherited: 'identifier', requested: 'identifier' },
    suggestion:
      'run the command from a shell that has not loaded an environment, or ask for the same one',
  },
  inherited_stale: {
    kind: 'invalid',
    message:
      'this process inherited the {name} environment, resolved against another sealed credentials document than config/credentials/{name}.enc here',
    context: { name: 'identifier' },
    suggestion:
      'restart the parent command (such as jsails dev) after changing the document, or run this one from a shell that has not resolved another project',
  },
  inherited_without_secrets: {
    kind: 'invalid',
    message:
      'this command needs the sealed credentials of {name}, but the parent JSails command that resolved its environment skipped them',
    context: { name: 'identifier' },
    suggestion: 'run the command from a shell that has not loaded an environment',
  },
  invalid_variable_name: {
    kind: 'invalid',
    message: 'an environment variable name must match [A-Za-z_][A-Za-z0-9_]*',
  },
  missing_variable: {
    kind: 'invalid',
    message: 'the environment variable {name} is required but not set',
    context: { name: 'identifier' },
    suggestion:
      'set it in the real environment, the secrets file, the sealed credentials or a .env file',
  },
  invalid_variable: {
    kind: 'invalid',
    message: 'the environment variable {name} is invalid ({problem}); {count} problems in all',
    context: { name: 'identifier', problem: 'identifier', count: 'count' },
    payload: {} as Payload<{ readonly issues: readonly EnvironmentIssue[] }>,
  },
  invalid_environment: {
    kind: 'invalid',
    message: 'the environment does not satisfy its schema ({problem}); {count} problems in all',
    context: { problem: 'identifier', count: 'count' },
    payload: {} as Payload<{ readonly issues: readonly EnvironmentIssue[] }>,
  },
} as const;

/**
 * `environment.*`: the environment could not be chosen or one of its layers
 * could not be read (`resolveEnvironment`), a variable the config requires is
 * missing (`env.require`), or a bounded reader rejected the variables it read
 * (`invalid_variable` and `invalid_environment`, whose payload carries every
 * value-free issue).
 *
 * @public
 */
export const EnvironmentErrors: ErrorRegistry<'environment', typeof ENVIRONMENT_ERRORS> =
  defineErrors('environment', ENVIRONMENT_ERRORS);

const CREDENTIALS_ERRORS = {
  invalid_environment: {
    kind: 'invalid',
    message:
      'a credentials environment name must be 1 to 64 letters, digits, "-" or "_", starting with a letter or a digit',
  },
  missing_key: {
    kind: 'invalid',
    message:
      'config/credentials/{environment}.enc is sealed but no key was found for it; set JSAILS_CREDENTIALS_KEY or add config/credentials/{environment}.key',
    context: { environment: 'identifier' },
    suggestion: 'a command that runs the app needs the key; build, help and credentials do not',
  },
  invalid_key: {
    kind: 'invalid',
    message: 'a credentials key must be 32 random bytes in base64url (43 characters)',
    suggestion: 'generate one with "jsails credentials init" or "jsails credentials rotate"',
  },
  invalid_key_ring: {
    kind: 'invalid',
    message: 'a credentials key ring holds one or two distinct keys (current, then previous)',
    suggestion: 'keep one key per line in the key file, or comma-separate them in the variable',
  },
  invalid_document: {
    kind: 'invalid',
    message: 'config/credentials/{environment}.enc is not a sealed credentials document',
    context: { environment: 'identifier' },
    suggestion:
      'a file sealed before format v2 cannot be read: move it aside and run "jsails credentials init --from <dotenv file>"',
  },
  unsupported_version: {
    kind: 'invalid',
    message: 'config/credentials/{environment}.enc uses an unsupported format version',
    context: { environment: 'identifier' },
    suggestion: 'upgrade jsails, or re-create the file with "jsails credentials init"',
  },
  environment_mismatch: {
    kind: 'invalid',
    message: 'config/credentials/{environment}.enc was sealed for the {sealed} environment',
    context: { environment: 'identifier', sealed: 'identifier' },
    suggestion:
      'each environment seals its own file; copy values across with jsails credentials import <file>',
  },
  unknown_key: {
    kind: 'invalid',
    message:
      'config/credentials/{environment}.enc was sealed with key {keyId}, which the key ring does not hold',
    context: { environment: 'identifier', keyId: 'identifier' },
    suggestion: 'add that key to the ring (JSAILS_CREDENTIALS_KEY or the key file)',
  },
  decryption_failed: {
    kind: 'invalid',
    message: 'config/credentials/{environment}.enc does not decrypt: it was altered or truncated',
    context: { environment: 'identifier' },
    suggestion: 'restore the committed file from version control',
  },
  reserved_key: {
    kind: 'invalid',
    message:
      'the credentials document of {environment} defines {key}, which only the real environment may set',
    context: { environment: 'identifier', key: 'identifier' },
    suggestion: 'remove it with "jsails credentials unset"',
  },
  invalid_name: {
    kind: 'invalid',
    message: 'a credentials name must match [A-Za-z_][A-Za-z0-9_]* and not be reserved',
  },
  invalid_value: {
    kind: 'invalid',
    message: 'the value of {name} cannot be sealed: it {problem}',
    context: { name: 'identifier', problem: ['contains NUL', 'holds every quote'] },
    suggestion:
      'a dotenv value may hold any two of the three quote characters (single, double, backtick)',
  },
  invalid_source: {
    kind: 'invalid',
    message: '{file} is not a dotenv file whose names can be sealed',
    context: { file: 'relative-path' },
    suggestion:
      'use KEY=value lines with names matching [A-Za-z_][A-Za-z0-9_]* and no reserved name',
  },
  unreadable_source: {
    kind: 'unavailable',
    message: 'the file to read values from cannot be read',
    suggestion: 'check the path passed to init --from or to import, and its permissions',
  },
  already_exists: {
    kind: 'conflict',
    message: 'config/credentials/{environment}.enc already exists',
    context: { environment: 'identifier' },
    suggestion: 'init never overwrites: change it with edit, set, unset or import instead',
  },
  missing_document: {
    kind: 'not_found',
    message: 'config/credentials/{environment}.enc does not exist',
    context: { environment: 'identifier' },
    suggestion: 'create it with "jsails credentials init"',
  },
  unknown_name: {
    kind: 'not_found',
    message: 'the credentials document of {environment} does not define {name}',
    context: { environment: 'identifier', name: 'identifier' },
  },
  rotation_in_progress: {
    kind: 'conflict',
    message:
      'the key ring of {environment} already holds a previous key: a rotation has not been finished',
    context: { environment: 'identifier' },
    suggestion:
      'once every server runs the re-sealed document, run "jsails credentials rotate --finish"',
  },
  no_rotation: {
    kind: 'conflict',
    message: 'the key ring of {environment} holds one key: there is no rotation to finish',
    context: { environment: 'identifier' },
  },
} as const;

/**
 * `credentials.*`: a sealed credentials document, its key ring, or a
 * `jsails credentials` subcommand failed. No message carries a key, a
 * ciphertext or a decrypted value.
 *
 * @public
 */
export const CredentialsErrors: ErrorRegistry<'credentials', typeof CREDENTIALS_ERRORS> =
  defineErrors('credentials', CREDENTIALS_ERRORS);

/**
 * The lines a bin prints for a failed resolution: `<code>: <message>` and the
 * hint, or `undefined` when `error` is not an `environment.*` or
 * `credentials.*` error (a bug, which the caller reports its own way). Both
 * registries' messages are value-free, so the lines are safe to print.
 *
 * @internal
 */
export function environmentFailureLines(error: unknown): readonly string[] | undefined {
  if (!EnvironmentErrors.is(error) && !CredentialsErrors.is(error)) return undefined;
  const suggestion = error.suggestion;
  return suggestion === undefined
    ? [`${error.code}: ${error.message}`]
    : [`${error.code}: ${error.message}`, `  hint: ${suggestion}`];
}
