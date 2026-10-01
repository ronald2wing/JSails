/**
 * Environment resolution: the one place a JSails process decides its
 * environment name, reads its layers, and opens its sealed credentials.
 *
 * {@link resolveEnvironment} is called by a bin (`jsails`, `jamal`) or an
 * embedding host before any app code runs, never inside a kernel stage; the
 * caller then applies the result to `process.env` with
 * {@link applyEnvironment}.
 *
 * **The name.** `--env` (the `name` option), else `JSAILS_ENV`, else the
 * command's default (`development`; `jsails test` passes `test`). `NODE_ENV`
 * is derived from it (`development`, `test`, otherwise `production`); a real
 * `NODE_ENV` that says otherwise is fatal (`environment.conflict`), since
 * libraries would then run as one environment while the app loaded another.
 *
 * **Layers**, highest precedence first:
 *
 * 1. the real process environment;
 * 2. the secrets file `JSAILS_SECRETS_FILE` names (`secrets-file.ts`);
 * 3. `.env.local`, in `development` only;
 * 4. the sealed credentials of the environment (`credentials.ts`);
 * 5. `.env.<name>`;
 * 6. `.env`.
 *
 * Only `development` and `test` read `.env` files at all. `sources` names the
 * layer each resolved variable came from.
 *
 * **Secrets.** A command declares whether it needs the sealed credentials
 * (`secrets: 'required' | 'unused'`). A required command whose environment
 * has a sealed document but no key fails with `credentials.missing_key`, in
 * every environment; an unused one (build, help, credentials) never
 * opens the document and records `credentials: 'skipped'`, so a CI image
 * build needs no production key.
 *
 * **Children.** {@link applyEnvironment} exports
 * `JSAILS_ENV_RESOLVED=<name>:<keyId>:<digest>:<root>`. A child JSails process
 * that finds it has every resolved value as a real variable already, and the
 * key was consumed, so it inherits instead of resolving again: the marker must
 * have been written for the same project root (`environment.inherited_foreign_project`),
 * name the same environment (`environment.inherited_mismatch`) and the same
 * sealed document it would read (`environment.inherited_stale`), and a child
 * that needs secrets cannot inherit from a parent that skipped them
 * (`environment.inherited_without_secrets`).
 *
 * `<root>` is a SHA-256 digest of the root's real path, so the marker carries
 * no path and a symlinked route to the same project still matches. A child in
 * another root is refused rather than resolved afresh: the parent's values
 * are real variables in its environment by now, indistinguishable from the
 * ones its own shell set, so a fresh resolution would let the parent
 * project's `.env` and credentials outrank every layer of the child's. Only
 * whoever spawns the child can give it a clean environment. The children
 * JSails starts itself (the `jsails dev` serve child, the `jamal` bin under
 * `jsails jamal`, a test runner under `jsails test`) run in the parent's
 * root; a container `jamal` starts never receives the marker, since only the
 * variables its config names reach it.
 *
 * **The key** (`JSAILS_CREDENTIALS_KEY`) is read for the environment the
 * process runs as: from the real environment, else from the secrets file (a
 * deployed container receives it there, never as a variable), else from the
 * key file. It is removed from `process.env` by {@link applyEnvironment},
 * and kept on the result (`keyVariable`) for the one command that needs it
 * after resolution (`jsails credentials`). App code and children never see it.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { CredentialsErrors, EnvironmentErrors } from './errors.js';
import {
  documentDigest,
  openCredentials,
  parseCredentials,
  readKeyFile,
  readSealedDocument,
} from './credentials.js';
import {
  DOTENV_BASE,
  DOTENV_LOCAL,
  environmentDotenvFile,
  readDotenvFile,
  readsDotenvFiles,
} from './dotenv-files.js';
import { KeyRing } from './key-ring.js';
import {
  CREDENTIALS_KEY_ENV,
  DEFAULT_ENVIRONMENT,
  deriveNodeEnv,
  ENVIRONMENT_NAME_ENV,
  isEnvironmentName,
  RESOLVED_MARKER_ENV,
  SECRETS_FILE_ENV,
  type DerivedNodeEnv,
} from './names.js';
import { readSecretsFile } from './secrets-file.js';

/**
 * Whether a command needs the sealed credentials.
 *
 * @internal
 */
export type SecretsRequirement = 'required' | 'unused';

/**
 * The layer a resolved variable came from: `process`, `secrets-file`,
 * `credentials`, a `.env` file by name, or `inherited` from a resolved parent.
 *
 * @internal
 */
export type EnvironmentSource =
  'process' | 'secrets-file' | 'credentials' | 'inherited' | `.env${string}`;

/**
 * What resolution did with the sealed credentials:
 *
 * - `absent`: the environment has no sealed document.
 * - `skipped`: it has one, and the command does not use secrets.
 * - `loaded`: the document opened with the ring key `keyId`; `ring` is the
 *   ring that opened it, for a deploy that delivers it to the server.
 * - `inherited`: a resolved parent opened (or skipped) it; `keyId` is what
 *   its marker records.
 *
 * @internal
 */
export type CredentialsResolution =
  | { readonly status: 'absent' }
  | { readonly status: 'skipped'; readonly digest: string }
  | {
      readonly status: 'loaded';
      readonly keyId: string;
      readonly digest: string;
      readonly ring: KeyRing;
    }
  | { readonly status: 'inherited'; readonly keyId: string; readonly digest: string };

/**
 * One process's resolved environment.
 *
 * @internal
 */
export interface ResolvedEnvironment {
  /** The environment name (`JSAILS_ENV`). */
  readonly name: string;
  /** The `NODE_ENV` it derives. */
  readonly nodeEnv: DerivedNodeEnv;
  /** Whether the command uses the sealed credentials. */
  readonly secrets: SecretsRequirement;
  /**
   * Every resolved variable, the real environment's included; never the
   * control variables (`JSAILS_ENV`, `NODE_ENV`, the key, the marker).
   */
  readonly values: Readonly<Record<string, string>>;
  /** The layer each of {@link values} came from. */
  readonly sources: Readonly<Record<string, EnvironmentSource>>;
  readonly credentials: CredentialsResolution;
  /**
   * Set when `JSAILS_SECRETS_FILE` named a file, which was read: `count`
   * values. A deploy's post-start check asserts it.
   */
  readonly secretsFile: { readonly consumed: true; readonly count: number } | undefined;
  /** The `JSAILS_ENV_RESOLVED` value {@link applyEnvironment} exports. */
  readonly marker: string;
  /**
   * The key ring `JSAILS_CREDENTIALS_KEY` held, from the real environment or,
   * when that has none, the secrets file; `undefined` when neither did.
   */
  readonly keyVariable: KeyRing | undefined;
}

/**
 * Options for {@link resolveEnvironment}.
 *
 * @internal
 */
export interface ResolveEnvironmentOptions {
  /** The project root; files resolve under it. */
  readonly rootDir: string;
  /** The real environment. Defaults to `process.env`; never mutated. */
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** The name the command line chose (`--env`); outranks `JSAILS_ENV`. */
  readonly name?: string | undefined;
  /** The name when neither `name` nor `JSAILS_ENV` gives one. Defaults to `development`. */
  readonly defaultName?: string;
  /** Whether the command uses the sealed credentials. */
  readonly secrets: SecretsRequirement;
}

/** The marker's key-id field when there is no sealed document, or it was skipped. */
const NO_DOCUMENT = 'none';
const SKIPPED = 'skipped';
const MARKER =
  /^([A-Za-z0-9][A-Za-z0-9_-]{0,63}):([0-9a-f]{16}|none|skipped):([0-9a-f]{64}|none):([0-9a-f]{64})$/;
/** Separates the root digest from any other SHA-256 of a path. */
const ROOT_DIGEST_DOMAIN = 'jsails-environment-root\0';

/** Variables the resolver owns, never part of the resolved values. */
const CONTROL_KEYS: ReadonlySet<string> = new Set([
  ENVIRONMENT_NAME_ENV,
  'NODE_ENV',
  CREDENTIALS_KEY_ENV,
  RESOLVED_MARKER_ENV,
]);

/**
 * Resolve the environment for a command. Reads files under `rootDir` and the
 * sealed document; never writes, and never mutates `env`. Throws an
 * `environment.*` or `credentials.*` error for every condition the module
 * header names.
 *
 * @internal
 */
export function resolveEnvironment(options: ResolveEnvironmentOptions): ResolvedEnvironment {
  const env = options.env ?? process.env;
  const name =
    options.name ??
    nonEmpty(env[ENVIRONMENT_NAME_ENV]) ??
    options.defaultName ??
    DEFAULT_ENVIRONMENT;
  if (!isEnvironmentName(name)) throw new EnvironmentErrors.Error('invalid_name');
  // A marker naming another environment says more than the NODE_ENV that
  // came with it, so it is checked first.
  const root = rootDigest(options.rootDir);
  const marker = nonEmpty(env[RESOLVED_MARKER_ENV]);
  const inheritedMarker = marker === undefined ? undefined : parseMarker(marker, name, root);
  const nodeEnv = deriveNodeEnv(name);
  const realNodeEnv = nonEmpty(env.NODE_ENV);
  if (realNodeEnv !== undefined && realNodeEnv !== nodeEnv) {
    throw new EnvironmentErrors.Error('conflict', { name, expected: nodeEnv });
  }
  const realKeyText = nonEmpty(env[CREDENTIALS_KEY_ENV]);
  const document = readSealedDocument(options.rootDir, name);
  const digest = document === undefined ? NO_DOCUMENT : documentDigest(document);

  if (marker !== undefined && inheritedMarker !== undefined) {
    const keyVariable = realKeyText === undefined ? undefined : KeyRing.parse(realKeyText);
    return inherit({
      env,
      name,
      nodeEnv,
      secrets: options.secrets,
      marker,
      parsed: inheritedMarker,
      digest,
      keyVariable,
    });
  }

  // Read before the sealed document opens: it may carry the key ring.
  const secretsPath = nonEmpty(env[SECRETS_FILE_ENV]);
  const secrets = secretsPath === undefined ? undefined : readSecretsFile(secretsPath);
  const keyText = realKeyText ?? nonEmpty(secrets?.credentialsKey);
  const keyVariable = keyText === undefined ? undefined : KeyRing.parse(keyText);

  const layers: Array<readonly [EnvironmentSource, Readonly<Record<string, string>>]> = [];
  if (readsDotenvFiles(name)) {
    for (const file of [DOTENV_BASE, environmentDotenvFile(name)]) {
      const values = readDotenvFile(options.rootDir, file);
      if (values !== undefined) layers.push([file as EnvironmentSource, values]);
    }
  }

  let credentials: CredentialsResolution = { status: 'absent' };
  if (document !== undefined) {
    if (options.secrets === 'unused') {
      credentials = { status: 'skipped', digest };
    } else {
      const ring = keyVariable ?? readKeyFile(options.rootDir, name);
      if (ring === undefined) {
        throw new CredentialsErrors.Error('missing_key', { environment: name });
      }
      const opened = openCredentials(document, ring, name);
      layers.push(['credentials', parseCredentials(opened.plaintext, name)]);
      credentials = { status: 'loaded', keyId: opened.keyId, digest, ring };
    }
  }

  if (name === 'development') {
    const local = readDotenvFile(options.rootDir, DOTENV_LOCAL);
    if (local !== undefined) layers.push([DOTENV_LOCAL, local]);
  }

  let secretsFile: ResolvedEnvironment['secretsFile'];
  if (secrets !== undefined) {
    layers.push(['secrets-file', secrets.values]);
    secretsFile = Object.freeze({
      consumed: true as const,
      count: Object.keys(secrets.values).length,
    });
  }

  const real: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) real[key] = value;
  }
  layers.push(['process', real]);

  const { values, sources } = merge(layers);
  const keyId =
    credentials.status === 'loaded'
      ? credentials.keyId
      : credentials.status === 'skipped'
        ? SKIPPED
        : NO_DOCUMENT;
  return Object.freeze({
    name,
    nodeEnv,
    secrets: options.secrets,
    values,
    sources,
    credentials: Object.freeze(credentials),
    secretsFile,
    marker: `${name}:${keyId}:${digest}:${root}`,
    keyVariable,
  });
}

/**
 * Apply `resolved` to `target` (default `process.env`): every resolved value
 * a file, the secrets file or the credentials supplied, `JSAILS_ENV`, the
 * derived `NODE_ENV`, and the `JSAILS_ENV_RESOLVED` marker; and remove
 * `JSAILS_CREDENTIALS_KEY`, so neither app code nor a child process sees it.
 * A real variable is never overwritten: it is the top layer already.
 *
 * @internal
 */
export function applyEnvironment(
  resolved: ResolvedEnvironment,
  target: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(resolved.values)) {
    if (resolved.sources[key] !== 'process') target[key] = value;
  }
  target[ENVIRONMENT_NAME_ENV] = resolved.name;
  target.NODE_ENV = resolved.nodeEnv;
  target[RESOLVED_MARKER_ENV] = resolved.marker;
  delete target[CREDENTIALS_KEY_ENV];
  if (target === process.env) applied = resolved;
}

let applied: ResolvedEnvironment | undefined;

/**
 * The variables a resolution hands to what runs under it: every resolved
 * value, with the `JSAILS_ENV` and `NODE_ENV` it resolved. The marker and the
 * credentials key are not among them.
 *
 * @internal
 */
export function environmentVariables(
  resolved: ResolvedEnvironment,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...resolved.values,
    [ENVIRONMENT_NAME_ENV]: resolved.name,
    NODE_ENV: resolved.nodeEnv,
  });
}

/**
 * The resolution {@link applyEnvironment} last applied to `process.env` in
 * this process, or `undefined` before any. A command that runs after the bin
 * resolved (`jsails credentials`) reads the consumed key ring from it.
 *
 * @internal
 */
export function appliedEnvironment(): ResolvedEnvironment | undefined {
  return applied;
}

/** The fields of a `JSAILS_ENV_RESOLVED` marker. */
interface ParsedMarker {
  readonly keyId: string;
  readonly digest: string;
}

/**
 * The marker's `<root>` field for `rootDir`: a digest of its real path, or of
 * its absolute path when it cannot be resolved (it does not exist), so two
 * routes to one directory agree and the marker never holds the path itself.
 */
function rootDigest(rootDir: string): string {
  let path: string;
  try {
    path = realpathSync.native(rootDir);
  } catch {
    // A root that cannot be resolved has no files to read either; its
    // absolute path still tells it apart from every other root.
    path = resolve(rootDir);
  }
  return createHash('sha256').update(ROOT_DIGEST_DOMAIN).update(path).digest('hex');
}

/**
 * Parse `marker` for a process in the root whose digest is `root`, asked for
 * the environment `name`. Throws `environment.invalid_marker` for a malformed
 * one, `environment.inherited_foreign_project` when another root wrote it, and
 * `environment.inherited_mismatch` when it names another environment. The
 * root is checked first: a marker from another project is wrong whatever
 * environment it names.
 */
function parseMarker(marker: string, name: string, root: string): ParsedMarker {
  const match = MARKER.exec(marker);
  if (match === null) throw new EnvironmentErrors.Error('invalid_marker');
  const [, inherited, keyId, digest, markerRoot] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (markerRoot !== root) throw new EnvironmentErrors.Error('inherited_foreign_project');
  if (inherited !== name) {
    throw new EnvironmentErrors.Error('inherited_mismatch', { inherited, requested: name });
  }
  return { keyId, digest };
}

interface InheritInput {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly name: string;
  readonly nodeEnv: DerivedNodeEnv;
  readonly secrets: SecretsRequirement;
  readonly marker: string;
  readonly parsed: ParsedMarker;
  readonly digest: string;
  readonly keyVariable: KeyRing | undefined;
}

function inherit(input: InheritInput): ResolvedEnvironment {
  const { keyId, digest } = input.parsed;
  if (digest !== input.digest) {
    throw new EnvironmentErrors.Error('inherited_stale', { name: input.name });
  }
  if (input.secrets === 'required' && keyId === SKIPPED) {
    throw new EnvironmentErrors.Error('inherited_without_secrets', { name: input.name });
  }
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const sources: Record<string, EnvironmentSource> = Object.create(null) as Record<
    string,
    EnvironmentSource
  >;
  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined || CONTROL_KEYS.has(key)) continue;
    values[key] = value;
    sources[key] = 'inherited';
  }
  const credentials: CredentialsResolution =
    digest === NO_DOCUMENT ? { status: 'absent' } : { status: 'inherited', keyId, digest };
  return Object.freeze({
    name: input.name,
    nodeEnv: input.nodeEnv,
    secrets: input.secrets,
    values: Object.freeze(values),
    sources: Object.freeze(sources),
    credentials: Object.freeze(credentials),
    secretsFile: undefined,
    marker: input.marker,
    keyVariable: input.keyVariable,
  });
}

/** Layers lowest first; a later layer wins. Control variables never become values. */
function merge(
  layers: ReadonlyArray<readonly [EnvironmentSource, Readonly<Record<string, string>>]>,
): {
  values: Readonly<Record<string, string>>;
  sources: Readonly<Record<string, EnvironmentSource>>;
} {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const sources: Record<string, EnvironmentSource> = Object.create(null) as Record<
    string,
    EnvironmentSource
  >;
  for (const [source, layer] of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (CONTROL_KEYS.has(key)) continue;
      values[key] = value;
      sources[key] = source;
    }
  }
  return { values: Object.freeze(values), sources: Object.freeze(sources) };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
