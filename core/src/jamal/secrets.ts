/**
 * Jamal secrets: dotenv-format secret files with shell substitution.
 *
 * Mirrors Kamal's `Kamal::Secrets` (`lib/kamal/secrets.rb`) and its
 * `InlineCommandSubstitution` patch. Two files are read, in order, with later
 * values winning:
 *
 * - `<secretsPath>-common` — shared across destinations.
 * - `<secretsPath>` — or `<secretsPath>.<destination>` when a destination is
 *   selected. The plain file is NOT read when a destination is set, matching
 *   Kamal exactly.
 *
 * The file format is dotenv, but the filename is not `.env`: `.env` is the
 * app's runtime configuration, while these files hold deploy-time credentials
 * and may contain command substitution. Keeping them separate is the point.
 *
 * ## Substitution
 *
 * Substitution mirrors the dotenv gem's `[Command, Variable]` pipeline that
 * Kamal installs (`Dotenv::Parser.substitutions`), order and lookup included:
 *
 * - `$(command)` — executed with `sh -c` (or inlined, below); a `$NAME` inside
 *   the command is expanded before it runs (dotenv's
 *   `Variable.call(command, env)`), and trailing newlines are stripped from the
 *   result.
 * - `$(jsails jamal secrets ...)` — run in-process through the `inlineSecrets`
 *   seam instead of a shell, mirroring Kamal's inline `kamal secrets` case.
 *   Without a seam the command falls back to the shell runner.
 * - `$NAME` / `${NAME}` — replaced from the values already resolved in THIS
 *   file, then from `process.env`. A name defined nowhere is replaced with an
 *   empty string (dotenv's `env[name] || ENV[name] || ""`), never left literal.
 * - `\$NAME` / `\$(command)` — the backslash is removed and the text is left
 *   literal.
 *
 * The two passes run in order, so a value produced by a command IS rescanned
 * for variables — the dotenv gem pipes the two substitutions the same way.
 *
 * ## What this module never does
 *
 * It never writes a file, never logs a value, and never puts a value in an
 * error message. {@link JamalSecretsError} carries a `code` and, at most, the
 * name of the secret that failed.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { CONTROL_CHARS } from '../support/strings.js';
import { isForbiddenKey } from '../internal/json-safe.js';

/** The default secrets path, relative to the project root. */
export const DEFAULT_JAMAL_SECRETS_PATH = '.jamal/secrets';

/** Why a secrets operation failed — never a value, never a raw errno. */
export type JamalSecretsErrorCode =
  'invalid_path' | 'invalid_destination' | 'invalid_key' | 'missing_secret' | 'command_failed';

/** A value-free secrets failure. */
export class JamalSecretsError extends Error {
  readonly code: JamalSecretsErrorCode;

  constructor(code: JamalSecretsErrorCode, message: string) {
    super(message);
    this.name = 'JamalSecretsError';
    this.code = code;
  }
}

/** Options for {@link loadJamalSecrets}. */
export interface LoadJamalSecretsOptions {
  /** Project root the secrets path resolves against. */
  readonly rootDir: string;
  /** Destination name; selects `<path>.<destination>` and skips the plain file. */
  readonly destination?: string;
  /** Secrets path relative to `rootDir`; defaults to {@link DEFAULT_JAMAL_SECRETS_PATH}. */
  readonly secretsPath?: string;
  /** Environment consulted for `$NAME` substitution; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Command runner seam; defaults to `sh -c`. Injected so tests never spawn. */
  readonly runCommand?: (command: string) => string;
  /**
   * Runs a `$(jsails jamal secrets ...)` command in-process, mirroring Kamal's
   * inline `kamal secrets` dispatch. When omitted, such a command is passed to
   * the shell runner like any other. Injected so tests never spawn and so the
   * CLI can dispatch without re-entering the shell.
   */
  readonly inlineSecrets?: (command: string) => string;
}

/** The resolved secrets: a frozen name→value map plus the files that were read. */
export interface JamalSecrets {
  /** Resolved values. Frozen; never serialized by this module. */
  readonly values: Readonly<Record<string, string>>;
  /** Absolute paths of the files that existed and were read, in load order. */
  readonly files: readonly string[];
}

/**
 * The two filenames Kamal reads, in order. `-common` first, then the
 * destination-specific file (or the plain one when no destination is set).
 */
export function secretsFilenames(secretsPath: string, destination?: string): readonly string[] {
  const suffix = destination === undefined ? '' : `.${destination}`;
  return [`${secretsPath}-common`, `${secretsPath}${suffix}`];
}

/**
 * Load and resolve the secrets files under `options.rootDir`.
 *
 * A missing file is a silent no-op, exactly as Kamal's
 * `secrets_filenames.select { |f| File.exist?(f) }` behaves. A file that exists
 * but cannot be read is a hard error.
 */
export function loadJamalSecrets(options: LoadJamalSecretsOptions): JamalSecrets {
  const secretsPath = options.secretsPath ?? DEFAULT_JAMAL_SECRETS_PATH;
  assertRelativePath(secretsPath);
  if (options.destination !== undefined) {
    assertDestination(options.destination);
  }

  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const inlineSecrets = options.inlineSecrets;
  const filenames = secretsFilenames(secretsPath, options.destination);

  const files: string[] = [];
  const values: Record<string, string> = {};

  for (const filename of filenames) {
    const absolute = join(options.rootDir, filename);
    let raw: string;
    try {
      raw = readFileSync(absolute, 'utf8');
    } catch {
      continue; // a missing secrets file is not an error.
    }
    files.push(absolute);
    const parsed = parseEnv(raw);
    // `parseEnv` drops a `__proto__` key outright (its result is null-prototype),
    // so scan the raw text for the forbidden names it cannot surface.
    assertNoForbiddenKeyLine(raw, filename);

    // Each file is resolved in document order against its own scope, mirroring
    // dotenv's per-file `@hash`: a later entry may reference an earlier one in
    // the same file, while a cross-file reference falls through to the env.
    // `parseEnv` returns keys sorted (its backing store is ordered), so the
    // order has to be recovered from the raw text.
    const fileScope: Record<string, string> = {};
    for (const key of secretKeysInDocumentOrder(raw)) {
      const value = parsed[key];
      if (value === undefined) {
        continue; // key-shaped text inside a multiline value, not an entry
      }
      assertSecretKey(key);
      fileScope[key] = substitute(value, fileScope, env, runCommand, inlineSecrets);
    }
    // Defensive: substitute any entry the key scan missed, after the ordered
    // ones, so no value is ever left raw.
    for (const [key, value] of Object.entries(parsed)) {
      if (Object.hasOwn(fileScope, key)) {
        continue;
      }
      assertSecretKey(key);
      fileScope[key] = substitute(value ?? '', fileScope, env, runCommand, inlineSecrets);
    }
    // The later file wins, like Kamal's `merge!(overwrite: true)`.
    Object.assign(values, fileScope);
  }

  return { values: Object.freeze(values), files: Object.freeze(files) };
}

/**
 * Resolve one secret by name. Throws {@link JamalSecretsError} with
 * `code: 'missing_secret'` when it is absent; the message names the secret and
 * the files that were searched, never a value.
 */
export function requireSecret(secrets: JamalSecrets, name: string): string {
  const value = secrets.values[name];
  if (value === undefined) {
    const searched =
      secrets.files.length > 0 ? secrets.files.join(', ') : 'no secrets files were found';
    throw new JamalSecretsError(
      'missing_secret',
      `secret "${name}" is not defined (searched: ${searched})`,
    );
  }
  return value;
}

/** True when the secret is defined and non-empty. */
export function hasSecret(secrets: JamalSecrets, name: string): boolean {
  const value = secrets.values[name];
  return value !== undefined && value.length > 0;
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

/**
 * `$(...)` with nesting and backslash escapes. Mirrors Kamal's
 * `INTERPOLATED_SHELL_COMMAND` regex, including the recursive `<cmd>` group
 * that allows balanced parentheses inside the command.
 */
const COMMAND_SUBSTITUTION =
  /(?<backslash>\\)?\$(?<cmd>\((?:\\.|[^()\\]|\((?:\\.|[^()\\]|\((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*\))*\))*\))/g;

/** `$NAME` or `${NAME}`; a leading backslash escapes it. */
const VARIABLE_SUBSTITUTION =
  /(?<backslash>\\)?\$(?:\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?<bare>[A-Za-z_][A-Za-z0-9_]*))/g;

/** A `$(jsails jamal secrets ...)` command, inlined like Kamal's `^\s*kamal\s*secrets`. */
const INLINE_SECRETS_COMMAND = /^\s*jsails\s+jamal\s+secrets\s+/;

/**
 * Apply command then variable substitution to one value, mirroring the dotenv
 * gem's `[Command, Variable]` pipeline that Kamal uses.
 *
 * The command pass runs first and expands variables inside each command before
 * running it (dotenv's `Variable.call(command, env)`), so `$(echo $NAME)` sees
 * `$NAME` resolved. A command that names the Jamal secrets CLI directly is
 * inlined through `inlineSecrets` instead of a shell. The variable pass then
 * runs over the whole result, so command output IS rescanned — the dotenv gem
 * pipes the two substitutions the same way.
 */
function substitute(
  value: string,
  fileScope: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
  runCommand: (command: string) => string,
  inlineSecrets: ((command: string) => string) | undefined,
): string {
  const withCommands = value.replace(
    COMMAND_SUBSTITUTION,
    (match, backslash: string | undefined, cmd: string) => {
      if (backslash !== undefined) {
        return match.slice(1); // escaped: drop the backslash, keep the text.
      }
      const command = expandVariables(cmd.slice(1, -1), fileScope, env);
      const runner =
        inlineSecrets !== undefined && INLINE_SECRETS_COMMAND.test(command)
          ? inlineSecrets
          : runCommand;
      return stripTrailingNewlines(runner(command));
    },
  );

  return expandVariables(withCommands, fileScope, env);
}

/**
 * `$NAME` / `${NAME}` substitution: this file's already-resolved values first,
 * then the environment, then an empty string. Mirrors dotenv's `Variable.call`
 * lookup (`env[name] || ENV[name] || ""`).
 */
function expandVariables(
  value: string,
  fileScope: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(
    VARIABLE_SUBSTITUTION,
    (
      match,
      backslash: string | undefined,
      braced: string | undefined,
      bare: string | undefined,
    ) => {
      if (backslash !== undefined) {
        return match.slice(1);
      }
      const name = braced ?? bare;
      if (name === undefined) {
        return match;
      }
      const fromFile = fileScope[name];
      if (fromFile !== undefined) {
        return fromFile;
      }
      const fromEnv = env[name];
      return fromEnv === undefined ? '' : fromEnv;
    },
  );
}

/**
 * The keys of a dotenv document in document order. `parseEnv` returns keys
 * sorted (its backing `std::map` is ordered), so the order has to be recovered
 * from the raw text with dotenv's own line rules: a key starts a line after
 * optional whitespace and an optional `export `, is followed by `=` or `:`, and
 * a `#` starts a comment. Key-shaped text inside a multiline value is filtered
 * out afterwards by checking each candidate against the parsed map.
 */
function secretKeysInDocumentOrder(raw: string): readonly string[] {
  const keys: string[] = [];
  for (const line of raw.split('\n')) {
    const stripped = line
      .replace(/\r$/, '')
      .replace(/^\s+/, '')
      .replace(/^export\s+/, '');
    if (stripped.length === 0 || stripped.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|:)/.exec(stripped);
    const key = match?.[1];
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

/** Strip every trailing newline, mirroring Kamal's `.chomp` on command output. */
function stripTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

/** Run a shell command and return its raw stdout; {@link substitute} strips the trailing newline. */
function defaultRunCommand(command: string): string {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new JamalSecretsError('command_failed', 'a secrets command substitution failed');
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Reject an absolute or escaping secrets path; it must stay under the root. */
function assertRelativePath(path: string): void {
  if (path.length === 0) {
    throw new JamalSecretsError('invalid_path', 'the secrets path must be non-empty');
  }
  if (CONTROL_CHARS.test(path)) {
    throw new JamalSecretsError(
      'invalid_path',
      'the secrets path must not contain control characters',
    );
  }
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    throw new JamalSecretsError(
      'invalid_path',
      'the secrets path must be relative to the project root',
    );
  }
  const segments = path.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new JamalSecretsError(
      'invalid_path',
      'the secrets path must not escape the project root',
    );
  }
}

/** A destination becomes a filename suffix, so it must be a safe token. */
function assertDestination(destination: string): void {
  if (destination.length === 0 || !/^[A-Za-z0-9_-]+$/.test(destination)) {
    throw new JamalSecretsError(
      'invalid_destination',
      'a destination must be non-empty and contain only letters, digits, "-", and "_"',
    );
  }
}

/** A secret name becomes an environment variable name. */
function assertSecretKey(key: string): void {
  if (key.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new JamalSecretsError(
      'invalid_key',
      'secret names must start with a letter or "_" and contain only letters, digits, and "_"',
    );
  }
  if (isForbiddenKey(key)) {
    throw new JamalSecretsError('invalid_key', 'secret names must not use a reserved key');
  }
}

/** A forbidden key at the start of a line, outside a `#` comment. */
const FORBIDDEN_KEY_LINE = /(?:^|\n)[\t ]*(__proto__|constructor|prototype)[\t ]*=/;

/**
 * `parseEnv` cannot surface a `__proto__` key (its result is null-prototype and
 * DROPS it), so a forbidden name that would otherwise vanish silently is
 * rejected here from the raw text. `constructor`/`prototype` surface through
 * `parseEnv` and are rejected by {@link assertSecretKey}; the raw scan also
 * covers them so a comment-free forbidden line never depends on `parseEnv`.
 */
function assertNoForbiddenKeyLine(raw: string, filename: string): void {
  if (FORBIDDEN_KEY_LINE.test(raw)) {
    throw new JamalSecretsError('invalid_key', `"${filename}" uses a reserved secret name`);
  }
}
