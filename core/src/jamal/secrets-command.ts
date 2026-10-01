/**
 * `jamal secrets`: inspect the deploy secrets files.
 *
 * Mirrors Kamal's `kamal secrets` verbs, reduced to what a single-file config
 * needs:
 *
 * - `print` — list the resolved secret names (never values).
 * - `fetch` — print one secret's value, for piping into another tool.
 * - `extract` — print one value from a JSON document on stdin, for a secrets
 *   file that stores a whole vault payload under one key.
 *
 * `print` is the safe default: it names what is defined without revealing any
 * value, so it can be pasted into an issue. `fetch` and `extract` write a value
 * to stdout and are the caller's responsibility to keep out of logs.
 */

import { formatError } from '../internal/errors.js';
import { usageFailure, type JamalDeps } from './plan-command.js';
import {
  DEFAULT_JAMAL_SECRETS_PATH,
  JamalSecretsError,
  loadJamalSecrets,
  requireSecret,
  type JamalSecrets,
} from './secrets.js';

/** The `secrets` verbs. */
export type SecretsVerb = 'print' | 'fetch' | 'extract';

/** True when `value` names a `secrets` verb. */
export function isSecretsVerb(value: string): value is SecretsVerb {
  return value === 'print' || value === 'fetch' || value === 'extract';
}

/** Options for {@link runSecretsCommand}. */
export interface SecretsCommandOptions {
  /** The verb to run. */
  readonly verb: SecretsVerb;
  /** The secret name (`fetch`) or the JSON key (`extract`). */
  readonly name: string | undefined;
  /** Secrets path override; defaults to the config's, then `.jamal/secrets`. */
  readonly secretsPath?: string;
  /** Destination override; defaults to the config's. */
  readonly destination?: string;
}

/**
 * Run one `secrets` verb. Resolves to a process exit code: 0 on success, 1 for
 * a missing secret or an unreadable file, 2 for a usage error.
 */
export async function runSecretsCommand(
  deps: JamalDeps,
  options: SecretsCommandOptions,
): Promise<number> {
  if (options.verb !== 'print' && options.name === undefined) {
    return usageFailure(deps, `\`jamal secrets ${options.verb}\` requires a name`);
  }

  const config = await loadConfigForSecrets(deps);
  const secretsPath =
    options.secretsPath ?? config?.production?.secretsPath ?? DEFAULT_JAMAL_SECRETS_PATH;
  const destination = options.destination ?? config?.production?.destination;

  let secrets: JamalSecrets;
  try {
    const loadSecrets = deps.loadSecrets ?? loadJamalSecrets;
    secrets = loadSecrets({ rootDir: deps.cwd, destination, secretsPath });
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  if (options.verb === 'print') {
    return printNames(deps, secrets);
  }

  const name = options.name;
  if (name === undefined) {
    return usageFailure(deps, `\`jamal secrets ${options.verb}\` requires a name`);
  }

  if (options.verb === 'fetch') {
    return printValue(deps, secrets, name);
  }

  return extractFromJson(deps, secrets, name);
}

/** List the resolved secret names, one per line. Never a value. */
function printNames(deps: JamalDeps, secrets: JamalSecrets): number {
  const names = Object.keys(secrets.values).sort();
  if (names.length === 0) {
    deps.stderr('jsails: no secrets are defined');
    return 1;
  }
  for (const name of names) {
    deps.stdout(name);
  }
  return 0;
}

/** Print one secret's value. */
function printValue(deps: JamalDeps, secrets: JamalSecrets, name: string): number {
  try {
    deps.stdout(requireSecret(secrets, name));
    return 0;
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
}

/**
 * Read a JSON document from the secret named `name` and print the value at
 * `key`. Mirrors Kamal's `secrets extract`, which turns a vault payload into a
 * single value. A key may be a path (`db/password`), matched against a nested
 * object or against a flat key that ends with `/<key>`.
 */
function extractFromJson(deps: JamalDeps, secrets: JamalSecrets, key: string): number {
  try {
    deps.stdout(extractValue(secrets, key));
    return 0;
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }
}

/**
 * Resolve the value at a `/`-separated path inside a JSON secret. The first
 * path segment names the secret; the rest walks the parsed document (an empty
 * rest returns the whole document). Throws a value-free
 * {@link JamalSecretsError} when the secret, the JSON, or the path is missing.
 */
function extractValue(secrets: JamalSecrets, key: string): string {
  const segments = key.split('/');
  const raw = requireSecret(secrets, segments[0] ?? key);

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new JamalSecretsError('missing_secret', 'the secret is not valid JSON');
  }

  const path = segments.slice(1).join('/');
  const value = path.length === 0 ? document : lookupJsonPath(document, path);
  if (value === undefined) {
    throw new JamalSecretsError('missing_secret', `the JSON document has no value at "${key}"`);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Walk a `/`-separated path through a JSON document. */
function lookupJsonPath(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split('/')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Split a command string into argv, handling single and double quotes and
 * backslash escapes. Covers exactly the shell syntax an inlined
 * `jsails jamal secrets ...` command uses; a nested `$(...)` stays one token
 * for the shell runner this output feeds.
 */
export function splitCommandLine(command: string): readonly string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) {
      break;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
        started = true;
      } else if (char === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next === '\\' || next === '"' || next === '$') {
          current += next ?? '';
          index += 1;
        } else {
          current += char;
        }
        started = true;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) {
        current += char;
      } else {
        current += next;
        index += 1;
      }
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (started) {
    argv.push(current);
  }
  return argv;
}

/** Options for {@link resolveSecretValueInline}. */
export interface InlineSecretOptions {
  /** Project root the secrets path resolves against. */
  readonly rootDir: string;
  /** `fetch` returns one secret; `extract` walks a `/` path inside one. */
  readonly verb: 'fetch' | 'extract';
  /** The secret name (`fetch`) or `secret/key/path` (`extract`). */
  readonly name: string;
  /** Secrets path override; defaults to {@link DEFAULT_JAMAL_SECRETS_PATH}. */
  readonly secretsPath?: string;
  /** Destination override. */
  readonly destination?: string;
}

/**
 * Resolve one value for an inlined `$(jsails jamal secrets ...)` command.
 * Loads the secrets files WITHOUT the inline seam, so an inlined command can
 * never re-run itself; resolves the value and throws a value-free error on
 * failure, which the enclosing substitution surfaces.
 */
export function resolveSecretValueInline(options: InlineSecretOptions): string {
  const secrets = loadJamalSecrets({
    rootDir: options.rootDir,
    secretsPath: options.secretsPath,
    destination: options.destination,
  });
  if (options.verb === 'fetch') {
    return requireSecret(secrets, options.name);
  }
  return extractValue(secrets, options.name);
}

/** Load the jamal config for the secrets path/destination defaults; absent is fine. */
async function loadConfigForSecrets(deps: JamalDeps) {
  const loader = deps.loadJamalConfig;
  if (loader === undefined) {
    return undefined;
  }
  try {
    return await loader(deps.cwd);
  } catch {
    // A missing or broken config is not fatal here: the secrets files can be
    // inspected without one, and the path/destination fall back to defaults.
    return undefined;
  }
}
