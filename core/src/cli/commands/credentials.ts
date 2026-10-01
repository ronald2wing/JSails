/**
 * `jsails credentials`: create, change, inspect and rotate the sealed
 * per-environment credentials document (`environment/credentials.ts`).
 *
 * ```sh
 * jsails credentials init [--env <name>] [--from <dotenv file>]
 * jsails credentials edit [--env <name>]
 * printf %s "$TOKEN" | jsails credentials set API_TOKEN [--env <name>]
 * jsails credentials unset API_TOKEN [--env <name>]
 * jsails credentials show [--env <name>]
 * jsails credentials import <dotenv file> [--env <name>]
 * jsails credentials rotate [--finish] [--env <name>]
 * ```
 *
 * The command never reads `process.env` for what it seals: a document holds
 * exactly what `init --from`, `edit`, `set` and `import` put in it.
 *
 * - `init` creates the document and, when the environment has no key yet, its
 *   key file (mode 0600); it refuses to overwrite an existing document.
 * - `edit` decrypts into a private temporary file, opens `$VISUAL` or
 *   `$EDITOR`, and re-seals only when the contents changed. The plaintext
 *   never leaves the temporary directory, removed on every path.
 * - `set` reads the value from standard input (one trailing newline is
 *   dropped), so it never appears in an argv or a shell history; `unset`
 *   removes a name; `import` merges a dotenv file's values. These three
 *   rewrite the document one `KEY=value` per line in its key order, so a
 *   comment survives only `edit`.
 * - `show` prints the names, never a value, marking a name that a higher
 *   layer (the real environment, the secrets file, `.env.local`) overrides.
 * - `rotate` adds a fresh key to the ring as the current one and re-seals the
 *   document under it in one atomic write; the previous key stays in the ring
 *   so a server still running the old document can open it. Once every server
 *   runs the new one, `rotate --finish` drops the key that no longer seals it.
 *
 * Every change re-seals under the key that opened the document, so an edit in
 * the middle of a rotation keeps the rotation's state. The bin resolves this
 * command's environment with its secrets unused, so a broken or keyless
 * document can always be inspected and fixed; the key ring comes from
 * `JSAILS_CREDENTIALS_KEY` when the target is the environment the process
 * runs as (the bin consumed the variable and hands it over), else from the
 * key file.
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
import { dirname, join, relative, resolve } from 'node:path';
import { parseEnv } from 'node:util';

import {
  credentialsPaths,
  openCredentials,
  parseCredentials,
  readKeyFile,
  readSealedDocument,
  sealCredentials,
  sealedKeyId,
} from '../../environment/credentials.js';
import { keysInDocumentOrder, renderDotenvDocument } from '../../environment/dotenv-document.js';
import { CredentialsErrors, EnvironmentErrors } from '../../environment/errors.js';
import { KeyRing } from '../../environment/key-ring.js';
import {
  CREDENTIALS_KEY_ENV,
  DEFAULT_ENVIRONMENT,
  firstReservedKey,
  isEnvKey,
} from '../../environment/names.js';
import { appliedEnvironment } from '../../environment/resolve.js';
import type { CommandInvocation, CommandModule } from '../descriptor.js';
import type { CREDENTIALS_OPTIONS } from '../manifest.js';

/** The plaintext a new document starts from. */
const NEW_DOCUMENT = `# Sealed credentials, read by every jsails command that runs the app.
# One KEY=value per line, in .env syntax. The real environment, the secrets
# file and .env.local override a value set here.
`;

const SUBCOMMANDS = ['init', 'edit', 'set', 'unset', 'show', 'import', 'rotate'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** Dependency seam: the project root, the key ring, the editor, standard input, and output. */
export interface CredentialsDeps {
  readonly rootDir: string;
  /** The environment the process runs as; `JSAILS_CREDENTIALS_KEY` belongs to it. */
  readonly runningEnvironment: string;
  /** The ring `JSAILS_CREDENTIALS_KEY` held, which the bin consumed. */
  readonly keyVariable: KeyRing | undefined;
  /** Whether a layer above the credentials sets `name` for the running environment. */
  overridden(name: string): boolean;
  /** Open `path` in the user's editor; returns the editor's exit code. */
  edit(path: string): number;
  /** All of standard input. */
  readStdin(): string;
  /** Whether git ignores `path`; `undefined` when that cannot be determined. */
  isIgnored(path: string): boolean | undefined;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Sources that outrank the sealed credentials. */
const ABOVE_CREDENTIALS: ReadonlySet<string> = new Set(['process', 'secrets-file', '.env.local']);

/**
 * The real seams for an invocation. The key ring and the layer each variable
 * came from are the resolution's, which the dispatcher applied before the
 * command ran; the editor variables come from the command's environment.
 */
function defaultDeps(context: CommandInvocation): CredentialsDeps {
  const resolved = appliedEnvironment();
  return {
    rootDir: context.cwd,
    runningEnvironment: context.environment ?? DEFAULT_ENVIRONMENT,
    keyVariable: resolved?.keyVariable,
    overridden: (name) => ABOVE_CREDENTIALS.has(resolved?.sources[name] ?? ''),
    edit: (path) => runEditor(path, context.env, (line) => context.stderr(line)),
    readStdin: () => readFileSync(0, 'utf8'),
    isIgnored: (path) => gitIgnores(path),
    stdout: (text) => context.stdout(text),
    stderr: (text) => context.stderr(text),
  };
}

interface ParsedArgs {
  readonly action: Subcommand;
  readonly environment: string | undefined;
  readonly operand: string | undefined;
  readonly from: string | undefined;
  readonly finish: boolean;
}

/** The values `jsails credentials` parses. */
export interface CredentialsValues {
  readonly env?: string;
  readonly from?: string;
  readonly finish?: boolean;
}

function isSubcommand(value: string | undefined): value is Subcommand {
  return (SUBCOMMANDS as readonly (string | undefined)[]).includes(value);
}

/** Check the values and positionals against each other; a usage problem when they do not hold. */
function parse(values: CredentialsValues, positionals: readonly string[]): ParsedArgs | string {
  const [action, ...operands] = positionals;
  if (!isSubcommand(action)) return `expected a subcommand: ${SUBCOMMANDS.join(', ')}`;
  if (values.env === '') return '--env requires a value';
  if (values.from === '') return '--from requires a file path';
  if (values.from !== undefined && action !== 'init') return '--from applies only to init';
  const finish = values.finish === true;
  if (finish && action !== 'rotate') return '--finish applies only to rotate';
  const takesOperand = action === 'set' || action === 'unset' || action === 'import';
  if (takesOperand && operands.length !== 1) {
    return action === 'import' ? 'import takes one dotenv file' : `${action} takes one NAME`;
  }
  if (!takesOperand && operands.length > 0) return `unexpected argument for ${action}`;
  return { action, environment: values.env, operand: operands[0], from: values.from, finish };
}

/** Run `jsails credentials` over its parsed values and positionals. */
export async function runCredentialsCommand(
  values: CredentialsValues,
  positionals: readonly string[],
  deps: CredentialsDeps,
  usage: (message: string) => number,
): Promise<number> {
  const parsed = parse(values, positionals);
  if (typeof parsed === 'string') return usage(parsed);
  const environment = parsed.environment ?? deps.runningEnvironment;
  try {
    credentialsPaths(environment);
  } catch (error) {
    if (CredentialsErrors.is(error)) return usage(error.message);
    throw error;
  }
  const context = new CredentialsContext(environment, deps);
  try {
    switch (parsed.action) {
      case 'init':
        return context.init(parsed.from);
      case 'edit':
        return context.edit();
      case 'set':
        return context.set(parsed.operand as string);
      case 'unset':
        return context.unset(parsed.operand as string);
      case 'show':
        return context.show();
      case 'import':
        return context.importFile(parsed.operand as string);
      case 'rotate':
        return parsed.finish ? context.finishRotation() : context.rotate();
    }
  } catch (error) {
    if (!CredentialsErrors.is(error) && !EnvironmentErrors.is(error)) throw error;
    deps.stderr(`jsails: ${error.code}: ${error.message}`);
    if (error.suggestion !== undefined) deps.stderr(`  hint: ${error.suggestion}`);
    return 1;
  }
}

/** `jsails credentials <action>`. */
export const credentialsCommand: CommandModule<typeof CREDENTIALS_OPTIONS, 'environment'> = {
  run: (context) =>
    runCredentialsCommand(context.values, context.positionals, defaultDeps(context), (message) =>
      context.usage(message),
    ),
};

/** An open document: its plaintext and the key that opened it. */
interface OpenDocument {
  readonly ring: KeyRing;
  readonly keyId: string;
  readonly plaintext: string;
}

/** One subcommand run against one environment. */
class CredentialsContext {
  readonly #environment: string;
  readonly #deps: CredentialsDeps;
  readonly #file: string;
  readonly #keyFile: string;

  constructor(environment: string, deps: CredentialsDeps) {
    this.#environment = environment;
    this.#deps = deps;
    const paths = credentialsPaths(environment);
    this.#file = paths.file;
    this.#keyFile = paths.keyFile;
  }

  init(from: string | undefined): number {
    if (existsSync(this.#absolute(this.#file))) {
      throw new CredentialsErrors.Error('already_exists', { environment: this.#environment });
    }
    const plaintext = from === undefined ? NEW_DOCUMENT : this.#readSource(from);
    let ring = this.#ring();
    if (ring === undefined) {
      ring = KeyRing.generate();
      this.#writeKeyFile(ring, 'wx');
      this.#deps.stdout(
        `Created ${this.#keyFile}. Keep it out of git and share it through a password manager.`,
      );
    }
    this.#seal(plaintext, ring, ring.currentId, 'wx');
    const count = Object.keys(parseCredentials(plaintext, this.#environment)).length;
    this.#deps.stdout(`Created ${this.#file} (${plural(count)}).`);
    this.#warnUnignored();
    return 0;
  }

  edit(): number {
    const open = this.#open();
    const scratch = mkdtempSync(join(tmpdir(), 'jsails-credentials-'));
    try {
      const draft = join(scratch, `${this.#environment}.env`);
      writeFileSync(draft, open.plaintext, { mode: 0o600 });
      if (this.#deps.edit(draft) !== 0) {
        this.#deps.stderr('jsails: the editor exited with an error; nothing was saved');
        return 1;
      }
      const after = readFileSync(draft, 'utf8');
      if (after === open.plaintext) {
        this.#deps.stdout('No changes.');
        return 0;
      }
      const count = Object.keys(parseCredentials(after, this.#environment)).length;
      this.#seal(after, open.ring, open.keyId);
      this.#deps.stdout(`Saved ${this.#file} (${plural(count)}).`);
      return 0;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  set(name: string): number {
    assertSealableName(name);
    const value = this.#deps.readStdin().replace(/\r?\n$/, '');
    const open = this.#open();
    const values = this.#entries(open.plaintext);
    const existed = values.has(name);
    values.set(name, value);
    this.#seal(renderDotenvDocument(values), open.ring, open.keyId);
    this.#deps.stdout(`${existed ? 'Changed' : 'Added'} ${name} in ${this.#file}.`);
    return 0;
  }

  unset(name: string): number {
    assertSealableName(name);
    const open = this.#open();
    const values = this.#entries(open.plaintext);
    if (!values.delete(name)) {
      throw new CredentialsErrors.Error('unknown_name', { environment: this.#environment, name });
    }
    this.#seal(renderDotenvDocument(values), open.ring, open.keyId);
    this.#deps.stdout(`Removed ${name} from ${this.#file}.`);
    return 0;
  }

  show(): number {
    const open = this.#open();
    const names = Object.keys(parseCredentials(open.plaintext, this.#environment)).sort();
    const running = this.#environment === this.#deps.runningEnvironment;
    this.#deps.stdout(
      `${this.#file} (${this.#environment}, key ${open.keyId}): ${plural(names.length)}`,
    );
    for (const name of names) {
      this.#deps.stdout(
        running && this.#deps.overridden(name)
          ? `  ${name}  (overridden by a higher layer)`
          : `  ${name}`,
      );
    }
    return 0;
  }

  importFile(path: string): number {
    const incoming = parseCredentials(this.#readSource(path), this.#environment);
    const open = this.#open();
    const values = this.#entries(open.plaintext);
    let changed = 0;
    for (const [name, value] of Object.entries(incoming)) {
      if (values.get(name) !== value) changed += 1;
      values.set(name, value);
    }
    if (changed === 0) {
      this.#deps.stdout('No changes.');
      return 0;
    }
    this.#seal(renderDotenvDocument(values), open.ring, open.keyId);
    this.#deps.stdout(`Imported ${plural(changed)} into ${this.#file}.`);
    return 0;
  }

  rotate(): number {
    const open = this.#open();
    if (open.ring.size !== 1) {
      throw new CredentialsErrors.Error('rotation_in_progress', {
        environment: this.#environment,
      });
    }
    const next = open.ring.withNewKey();
    // The ring gains the new key before the document moves to it, so a crash
    // between the two writes leaves a document the ring still opens.
    this.#writeKeyFile(next, 'replace');
    this.#seal(open.plaintext, next, next.currentId);
    this.#deps.stdout(
      `Re-sealed ${this.#file} under key ${next.currentId}; ${this.#keyFile} keeps the previous key ${open.keyId}.`,
    );
    this.#deps.stdout(
      'Deploy the new document with the new ring, then run "jsails credentials rotate --finish".',
    );
    this.#adviseVariable();
    this.#warnUnignored();
    return 0;
  }

  finishRotation(): number {
    const open = this.#open();
    if (open.ring.size !== 2) {
      throw new CredentialsErrors.Error('no_rotation', { environment: this.#environment });
    }
    const dropped = open.ring.ids.find((id) => id !== open.keyId) as string;
    this.#writeKeyFile(open.ring.only(open.keyId), 'replace');
    this.#deps.stdout(`Removed key ${dropped} from ${this.#keyFile}.`);
    this.#adviseVariable();
    return 0;
  }

  /** The ring for this environment: the consumed variable when it is the running one, else the key file. */
  #ring(): KeyRing | undefined {
    if (
      this.#environment === this.#deps.runningEnvironment &&
      this.#deps.keyVariable !== undefined
    ) {
      return this.#deps.keyVariable;
    }
    return readKeyFile(this.#deps.rootDir, this.#environment);
  }

  #open(): OpenDocument {
    const document = readSealedDocument(this.#deps.rootDir, this.#environment);
    if (document === undefined) {
      throw new CredentialsErrors.Error('missing_document', { environment: this.#environment });
    }
    const ring = this.#ring();
    if (ring === undefined) {
      // A file that is not a v2 document says so before the missing key does.
      sealedKeyId(document, this.#environment);
      throw new CredentialsErrors.Error('missing_key', { environment: this.#environment });
    }
    const opened = openCredentials(document, ring, this.#environment);
    return { ring, keyId: opened.keyId, plaintext: opened.plaintext };
  }

  /** The document's values in document order. */
  #entries(plaintext: string): Map<string, string> {
    const parsed = parseCredentials(plaintext, this.#environment);
    return new Map(
      keysInDocumentOrder(plaintext, parsed).map((key) => [key, parsed[key] as string]),
    );
  }

  /** Read and validate a dotenv file given on the command line. */
  #readSource(path: string): string {
    const absolute = resolve(this.#deps.rootDir, path);
    let raw: string;
    try {
      raw = readFileSync(absolute, 'utf8');
    } catch (error) {
      throw new CredentialsErrors.Error('unreadable_source', {}, { cause: error });
    }
    const names = Object.keys(parseEnv(raw));
    if (names.some((name) => !isEnvKey(name)) || firstReservedKey(names) !== undefined) {
      const shown = relative(this.#deps.rootDir, absolute);
      throw new CredentialsErrors.Error('invalid_source', {
        file: shown === '' || shown.startsWith('..') ? 'the given file' : shown,
      });
    }
    return raw;
  }

  #seal(plaintext: string, ring: KeyRing, keyId: string, mode: 'wx' | 'replace' = 'replace'): void {
    const sealed = sealCredentials(plaintext, ring, this.#environment, keyId);
    const path = this.#absolute(this.#file);
    mkdirSync(dirname(path), { recursive: true });
    if (mode === 'wx') writeFileSync(path, sealed, { flag: 'wx' });
    else writeAtomically(path, sealed);
  }

  #writeKeyFile(ring: KeyRing, mode: 'wx' | 'replace'): void {
    const path = this.#absolute(this.#keyFile);
    mkdirSync(dirname(path), { recursive: true });
    if (mode === 'wx') writeFileSync(path, ring.toKeyFile(), { flag: 'wx', mode: 0o600 });
    else writeAtomically(path, ring.toKeyFile(), 0o600);
  }

  /** The variable outranks the key file just written, so it has to follow. */
  #adviseVariable(): void {
    if (
      this.#environment === this.#deps.runningEnvironment &&
      this.#deps.keyVariable !== undefined
    ) {
      this.#deps.stderr(
        `jsails: warning: ${CREDENTIALS_KEY_ENV} still holds the old ring and outranks ${this.#keyFile}; set it to the file's keys, comma-separated, wherever it is defined`,
      );
    }
  }

  #warnUnignored(): void {
    const path = this.#absolute(this.#keyFile);
    if (existsSync(path) && this.#deps.isIgnored(path) === false) {
      this.#deps.stderr(
        `jsails: warning: git does not ignore ${this.#keyFile}; add "config/credentials/*.key" to .gitignore`,
      );
    }
  }

  #absolute(file: string): string {
    return join(this.#deps.rootDir, file);
  }
}

function assertSealableName(name: string): void {
  if (!isEnvKey(name) || firstReservedKey([name]) !== undefined) {
    throw new CredentialsErrors.Error('invalid_name');
  }
}

function plural(count: number): string {
  return `${count} ${count === 1 ? 'key' : 'keys'}`;
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

/**
 * Run `$VISUAL` or `$EDITOR` on `path`, attached to the terminal. The variable
 * may carry arguments (`code --wait`), split on whitespace; no shell runs.
 */
function runEditor(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  stderr: (line: string) => void,
): number {
  const command = (env['VISUAL'] ?? env['EDITOR'] ?? '').trim();
  if (command === '') {
    stderr('jsails: set $VISUAL or $EDITOR to edit credentials');
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
