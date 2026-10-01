/**
 * Credentials command: edit, inspect, and re-seal the encrypted
 * per-environment credentials file the CLI bootstrap decrypts into
 * `process.env`.
 *
 * ```sh
 * jsails credentials edit                    # NODE_ENV, or development
 * jsails credentials edit --env production
 * jsails credentials show --env production   # key names only; exit 1 if it cannot decrypt
 * jsails credentials regenerate --yes        # rebuild from the live environment
 * jsails credentials regenerate --yes --order keys.txt
 * ```
 *
 * `edit` decrypts into a private temporary file, opens `$VISUAL` or
 * `$EDITOR`, and re-encrypts only when the contents changed, so an unchanged
 * edit leaves the committed file and its git history alone. The first edit of
 * an environment with no key creates the key file. The plaintext never leaves
 * the temporary directory, which is removed on every path.
 *
 * `show` prints the key names, never a value, and marks a key the environment
 * already sets, since that value wins over the credentials file. It exits 1
 * when the file is missing, has no key, or does not decrypt, so it doubles as
 * a deploy-time check. The bootstrap does not load credentials for this
 * command, so a broken file can always be inspected and fixed.
 *
 * `regenerate` rebuilds the file from the values the environment actually holds.
 * The plaintext of a file that cannot be decrypted is unrecoverable, so this is
 * a re-seal, not a recovery: it reads the assembled environment (`.env` files,
 * then `process.env`), writes a NEW key and a NEW `.enc`, and never overwrites
 * the old pair in place. `--order` imposes a key order from a plain list of
 * names; keys it does not name keep their existing document order.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  CREDENTIALS_KEY_ENV,
  CredentialsError,
  credentialsEnvironment,
  credentialsPaths,
  decryptCredentials,
  encryptCredentials,
  generateCredentialsKey,
  parseCredentials,
  resolveCredentialsKey,
  runningEnvironment,
} from '../../credentials.js';
import { dotenvKeysInDocumentOrder, isEnvKey } from '../../dotenv-document.js';
import { assembleEnvironment } from '../../dotenv.js';
import { usageFailure } from '../usage-error.js';

/** The plaintext a new credentials file starts from. */
const NEW_FILE_TEMPLATE = `# Encrypted credentials, loaded into process.env by every jsails command.
# One KEY=value per line, in .env syntax. A real environment variable or a
# .env file overrides a value set here.
`;

const HELP_HINT = 'Run "jsails credentials --help" for usage.';

/** Dependency seam: the filesystem root, environment, editor, and output. */
export interface CredentialsDeps {
  readonly rootDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Open `path` in the user's editor; resolves with the editor's exit code. */
  edit(path: string): number;
  /** Whether git ignores `path`; `undefined` when that cannot be determined. */
  isIgnored(path: string): boolean | undefined;
  stdout(text: string): void;
  stderr(text: string): void;
}

function defaultDeps(): CredentialsDeps {
  return {
    rootDir: process.cwd(),
    env: process.env,
    edit: (path) => runEditor(path, process.env),
    isIgnored: (path) => gitIgnores(path),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
}

function help(): string {
  return `credentials - edit, inspect, and regenerate encrypted per-environment credentials

Usage:
  jsails credentials edit [--env <name>]
  jsails credentials show [--env <name>]
  jsails credentials regenerate [--env <name>] [--order <file>] --yes

Options:
      --env <name>    The environment (default: NODE_ENV, or development)
      --order <file>  regenerate: emit keys in the order this file lists them
      --yes           regenerate: acknowledge that the old file is replaced
  -h, --help          Show this help

regenerate rebuilds the file from the live environment. Use it when the file or
its key is lost: the old plaintext cannot be recovered, so the values come from
the .env files and process.env, and a new key is written.

Files:
  config/credentials/<env>.enc   encrypted, committed
  config/credentials/<env>.key   the key, git-ignored
  ${CREDENTIALS_KEY_ENV}         overrides the key file for the NODE_ENV environment only

Every jsails command loads the current environment's credentials into
process.env after the .env files. A real variable or a .env file wins.
`;
}

/** Parse and run `jsails credentials` from the tokens after the command name. */
export async function runCredentialsCommand(
  args: readonly string[],
  deps: CredentialsDeps = defaultDeps(),
): Promise<number> {
  let action: 'edit' | 'show' | 'regenerate' | undefined;
  let envName: string | undefined;
  let orderPath: string | undefined;
  let acknowledged = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === '--help' || token === '-h') {
      deps.stdout(help());
      return 0;
    }
    if (token === '--env' || token.startsWith('--env=')) {
      const value = token === '--env' ? args[++index] : token.slice('--env='.length);
      if (value === undefined || value === '') {
        return usageFailure(deps, HELP_HINT, '--env requires a value');
      }
      envName = value;
    } else if (token === '--order' || token.startsWith('--order=')) {
      const value = token === '--order' ? args[++index] : token.slice('--order='.length);
      if (value === undefined || value === '') {
        return usageFailure(deps, HELP_HINT, '--order requires a file path');
      }
      orderPath = value;
    } else if (token === '--yes') {
      acknowledged = true;
    } else if (token.startsWith('-')) {
      return usageFailure(deps, HELP_HINT, 'unknown option');
    } else if (
      action === undefined &&
      (token === 'edit' || token === 'show' || token === 'regenerate')
    ) {
      action = token;
    } else {
      return usageFailure(deps, HELP_HINT, 'expected one subcommand: edit, show, or regenerate');
    }
  }
  if (action === undefined) {
    return usageFailure(deps, HELP_HINT, 'expected one subcommand: edit, show, or regenerate');
  }
  if (action !== 'regenerate' && (orderPath !== undefined || acknowledged)) {
    return usageFailure(deps, HELP_HINT, '--order and --yes apply only to regenerate');
  }

  let environment: string;
  try {
    environment = credentialsEnvironment(envName ?? deps.env.NODE_ENV);
  } catch (error) {
    if (error instanceof CredentialsError) return usageFailure(deps, HELP_HINT, error.message);
    throw error;
  }

  try {
    if (action === 'edit') return editCredentials(environment, deps);
    if (action === 'show') return showCredentials(environment, deps);
    return regenerateCredentials(environment, deps, { orderPath, acknowledged });
  } catch (error) {
    if (!(error instanceof CredentialsError)) throw error;
    deps.stderr(`jsails: ${error.message}`);
    return 1;
  }
}

function editCredentials(environment: string, deps: CredentialsDeps): number {
  const paths = credentialsPaths(deps.rootDir, environment);
  const exists = existsSync(paths.file);
  let key = resolveCredentialsKey(
    deps.rootDir,
    environment,
    deps.env,
    runningEnvironment(deps.env.NODE_ENV),
  );
  if (key === undefined) {
    if (exists) {
      throw new CredentialsError(
        'missing_key',
        `no key for ${display(deps, paths.file)}; set ${CREDENTIALS_KEY_ENV} or add ${display(deps, paths.keyFile)}`,
      );
    }
    key = generateCredentialsKey();
    mkdirSync(dirname(paths.keyFile), { recursive: true });
    writeFileSync(paths.keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' });
    deps.stdout(
      `Created ${display(deps, paths.keyFile)}. Keep it out of git and share it through a password manager.`,
    );
  }
  if (existsSync(paths.keyFile) && deps.isIgnored(paths.keyFile) === false) {
    deps.stderr(
      `jsails: warning: git does not ignore ${display(deps, paths.keyFile)}; add "config/credentials/*.key" to .gitignore`,
    );
  }

  const before = exists
    ? decryptCredentials(readFileSync(paths.file, 'utf8'), key, environment)
    : NEW_FILE_TEMPLATE;

  const scratch = mkdtempSync(join(tmpdir(), 'jsails-credentials-'));
  try {
    const draft = join(scratch, `${environment}.env`);
    writeFileSync(draft, before, { mode: 0o600 });
    const status = deps.edit(draft);
    if (status !== 0) {
      deps.stderr('jsails: the editor exited with an error; nothing was saved');
      return 1;
    }
    const after = readFileSync(draft, 'utf8');
    if (exists && after === before) {
      deps.stdout('No changes.');
      return 0;
    }
    const count = Object.keys(parseCredentials(after)).length;
    mkdirSync(dirname(paths.file), { recursive: true });
    writeAtomically(paths.file, encryptCredentials(after, key, environment));
    deps.stdout(`Saved ${display(deps, paths.file)} (${count} ${count === 1 ? 'key' : 'keys'}).`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function showCredentials(environment: string, deps: CredentialsDeps): number {
  const paths = credentialsPaths(deps.rootDir, environment);
  if (!existsSync(paths.file)) {
    deps.stderr(`jsails: ${display(deps, paths.file)} does not exist`);
    return 1;
  }
  const key = resolveCredentialsKey(
    deps.rootDir,
    environment,
    deps.env,
    runningEnvironment(deps.env.NODE_ENV),
  );
  if (key === undefined) {
    throw new CredentialsError(
      'missing_key',
      `no key for ${display(deps, paths.file)}; set ${CREDENTIALS_KEY_ENV} or add ${display(deps, paths.keyFile)}`,
    );
  }
  const names = Object.keys(
    parseCredentials(decryptCredentials(readFileSync(paths.file, 'utf8'), key, environment)),
  ).sort();
  deps.stdout(`${display(deps, paths.file)} (${environment}): ${names.length} keys`);
  for (const name of names) {
    deps.stdout(name in deps.env ? `  ${name}  (overridden by the environment)` : `  ${name}`);
  }
  return 0;
}

/** Options for {@link regenerateCredentials}. */
interface ResealOptions {
  /** A file listing the key order, one name per line. */
  readonly orderPath: string | undefined;
  /** The user acknowledged that the old file is replaced. */
  readonly acknowledged: boolean;
}

/**
 * Rebuild the credentials file from the values the environment holds.
 *
 * The plaintext of a file that cannot be decrypted is unrecoverable, so this
 * never claims to recover it: it reads the assembled environment (the `.env`
 * files, then `process.env`), writes a NEW key and a NEW `.enc`, and leaves the
 * old pair untouched. The old file is only read to recover its key order, and
 * only when it still decrypts.
 */
function regenerateCredentials(
  environment: string,
  deps: CredentialsDeps,
  options: ResealOptions,
): number {
  if (!options.acknowledged) {
    return usageFailure(
      deps,
      HELP_HINT,
      'regenerate replaces the credentials file; pass --yes to confirm',
    );
  }
  const paths = credentialsPaths(deps.rootDir, environment);

  // The assembled environment is the source of truth. A scratch map keeps the
  // real `process.env` untouched, and `credentials: false` stops the loader
  // from reading the very file this command is about to replace.
  const assembled: NodeJS.ProcessEnv = { ...deps.env };
  assembleEnvironment({
    rootDir: deps.rootDir,
    nodeEnv: environment,
    env: assembled,
    credentials: false,
  });

  const existing = readExistingOrder(paths.file, environment, deps);
  const order = options.orderPath === undefined ? [] : readOrderFile(options.orderPath);

  // The order file and the old document decide the order; the assembled
  // environment decides what is written. A key the environment holds but
  // neither list names is appended, so a first regenerate writes everything.
  const present = Object.keys(assembled)
    .filter((name) => isEnvKey(name))
    .sort();
  const names = mergeOrder(order, existing, present);
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = assembled[name];
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    values[name] = value;
  }

  if (Object.keys(values).length === 0) {
    deps.stderr(`jsails: the environment holds no value for ${environment}; nothing was written`);
    return 1;
  }

  const key = generateCredentialsKey();
  const plaintext = renderDocument(values);
  mkdirSync(dirname(paths.file), { recursive: true });
  writeAtomically(paths.keyFile, `${key}\n`, 0o600);
  writeAtomically(paths.file, encryptCredentials(plaintext, key, environment));

  const count = Object.keys(values).length;
  const noun = count === 1 ? 'key' : 'keys';
  deps.stdout(
    `Wrote ${display(deps, paths.file)} (${count} ${noun}) and a new ${display(deps, paths.keyFile)}.`,
  );
  if (missing.length > 0) {
    deps.stdout(`Not in the environment, so not written: ${missing.join(', ')}`);
  }
  deps.stdout(
    'The previous key and file were left in place; delete them once the new pair is verified.',
  );
  return 0;
}

/**
 * The key order of the existing file, or an empty list when it is absent or
 * cannot be decrypted. A file that does not decrypt is not an error here: the
 * whole point of a re-seal is to replace one.
 */
function readExistingOrder(
  file: string,
  environment: string,
  deps: CredentialsDeps,
): readonly string[] {
  if (!existsSync(file)) return [];
  const key = resolveCredentialsKey(
    deps.rootDir,
    environment,
    deps.env,
    runningEnvironment(deps.env.NODE_ENV),
  );
  if (key === undefined) return [];
  try {
    const plaintext = decryptCredentials(readFileSync(file, 'utf8'), key, environment);
    return dotenvKeysInDocumentOrder(plaintext);
  } catch (error) {
    if (error instanceof CredentialsError) return [];
    throw error;
  }
}

/** The key names a `--order` file lists, in order, ignoring blanks and comments. */
function readOrderFile(path: string): readonly string[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new CredentialsError('missing_order_file', `cannot read the order file ${path}`);
  }
  const names: string[] = [];
  for (const line of raw.split('\n')) {
    const name = line.replace(/\r$/, '').trim();
    if (name === '' || name.startsWith('#')) continue;
    if (!isEnvKey(name)) {
      throw new CredentialsError(
        'invalid_order_file',
        `the order file names an invalid key: ${name}`,
      );
    }
    names.push(name);
  }
  return names;
}

/**
 * `order` first, then the old document's order, then any remaining name. A name
 * listed twice keeps its first position.
 */
function mergeOrder(
  order: readonly string[],
  existing: readonly string[],
  present: readonly string[],
): readonly string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const name of [...order, ...existing, ...present]) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  return merged;
}

/** Render `values` as a dotenv document, one `KEY=value` per line. */
function renderDocument(values: Readonly<Record<string, string>>): string {
  const lines = Object.entries(values).map(([name, value]) => `${name}=${quoteValue(value)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Quote a value only when dotenv would otherwise misread it: a leading or
 * trailing space, a `#`, a quote, a backslash, or a newline. A plain value is
 * written bare so the file stays readable.
 */
function quoteValue(value: string): string {
  if (value === '' || /[\s"'\\#]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Replace `path` through a staging file in the same directory. A leftover or
 * planted staging path is removed first (a symlink itself, never its target),
 * the staging file is created exclusively so a path that reappears is refused
 * rather than followed, and it is removed again if the swap does not happen.
 */
function writeAtomically(path: string, contents: string, mode?: number): void {
  const staged = `${path}.tmp`;
  rmSync(staged, { force: true });
  writeFileSync(staged, contents, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
  try {
    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

function display(deps: CredentialsDeps, path: string): string {
  return relative(deps.rootDir, path);
}

/**
 * Run `$VISUAL` or `$EDITOR` on `path`, attached to the terminal. The variable
 * may carry arguments (`code --wait`), split on whitespace; no shell runs.
 */
function runEditor(path: string, env: NodeJS.ProcessEnv): number {
  const command = (env.VISUAL ?? env.EDITOR ?? '').trim();
  if (command === '') {
    process.stderr.write('jsails: set $VISUAL or $EDITOR to edit credentials\n');
    return 1;
  }
  const [program, ...args] = command.split(/\s+/) as [string, ...string[]];
  const result = spawnSync(program, [...args, path], { stdio: 'inherit' });
  return result.status ?? 1;
}

/** Ask git whether it ignores `path`; `undefined` outside a repository or without git. */
function gitIgnores(path: string): boolean | undefined {
  const result = spawnSync('git', ['check-ignore', '--quiet', path], {
    cwd: dirname(path),
    stdio: 'ignore',
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return undefined;
}
