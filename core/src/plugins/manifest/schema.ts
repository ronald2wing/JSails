/**
 * Plugin manifest v1: the static description of a plugin that tools, the
 * marketplace, and the framework read without importing any plugin code.
 *
 * One schema serves two carriers. An npm package carries the manifest in the
 * `jsails` field of its `package.json` (source `package`); a marketplace
 * bundle carries it as `manifest.json` (source `bundle`). The fields are the
 * same, except that the developer-tool fields (`commands`, `generators`,
 * `autoload`, `env`) belong to npm packages only: bare names, CLI commands,
 * and environment variables come from code a developer installed and
 * reviewed, never from a bundle an admin uploaded, so a bundle manifest that
 * carries one is invalid. Integrity is not part of the manifest: a bundle's
 * authority is the detached, signed release statement.
 *
 * The rules beyond shape:
 *
 * - every permission is one the closed registry defines (`permissions/`), so
 *   an install screen always has a sentence for it;
 * - `settings` is the closed settings-schema subset (`settings-schema/`);
 * - `jsailsCompat` is one caret or tilde range; an `experimental` plugin
 *   tracks one framework minor and must use a tilde;
 * - owning tables (`schema`) requires `data.own`, and admin navigation
 *   requires `admin.pages`, so the declared surface and the declared
 *   permissions cannot disagree.
 *
 * `checkPluginManifest` returns the parsed manifest or every issue;
 * `parsePluginManifest` throws a {@link PluginManifestError} instead. Issues
 * are value-free: a path, a stable code, and a message derived from the
 * schema, never from the input.
 */

import { z } from 'zod';

import { JsailsError } from '../../errors/jsails-error.js';
import type { AutoloadDeclaration } from '../../symbols/framework-symbols.js';
import { formatIssuePath, mapZodIssues } from '../../validation/zod-issues.js';
import { parsePermission, type PermissionIssueCode } from '../permissions/registry.js';
import { parseSettingsSchema, type SettingsSchema } from '../settings-schema/schema.js';
import { PLUGIN_ID_PATTERN } from './plugin-id.js';
import { isValidSemverRange, isValidSemverVersion, parseSemver } from './semver.js';

// ---------------------------------------------------------------------------
// Patterns and bounds
// ---------------------------------------------------------------------------

/**
 * The file a bundle carries its manifest in.
 *
 * @public
 */
export const PLUGIN_MANIFEST_FILENAME = 'manifest.json';

/**
 * The manifest format version this framework reads.
 *
 * @public
 */
export const PLUGIN_MANIFEST_VERSION = 1;

const PUBLISHER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const TABLE_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const ADMIN_PATH_PATTERN = /^\/[a-z0-9][a-z0-9/_-]{0,199}$/;
/** A bare package specifier: an optional scope, a name, and subpath segments. */
const BARE_SPECIFIER_PATTERN =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[A-Za-z0-9._~-]+)*$/;
/** A bundle entry: a JavaScript module file. */
const MODULE_FILE_PATTERN = /\.m?js$/;
/** A URL scheme (`node:`, `data:`, `https:`); a one-letter drive prefix is not one. */
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]+:/;

const MAX_ID_LENGTH = 214;
const MAX_VERSION_LENGTH = 256;
const MAX_NAME_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 280;
const MAX_PATH_LENGTH = 1024;
const MAX_LIST = 100;
const MAX_HOST_IMPORTS = 200;

// ---------------------------------------------------------------------------
// The typed manifest
// ---------------------------------------------------------------------------

/**
 * Where a manifest comes from: an npm package's `jsails` field, or a
 * marketplace bundle's `manifest.json`.
 *
 * @public
 */
export type PluginManifestSource = 'package' | 'bundle';

/**
 * A plugin's API promise: `stable` follows semver across a framework major,
 * `experimental` may break in any framework minor.
 *
 * @public
 */
export type PluginApiTier = 'stable' | 'experimental';

/**
 * A declared dependency on another plugin.
 *
 * @public
 */
export interface PluginDependency {
  /** The required plugin's id. */
  readonly id: string;
  /** The semver range its version must satisfy. */
  readonly range: string;
}

/**
 * The tables a plugin owns: every table name starts with `tablePrefix`, and a
 * bundle describes them as static model data in `file`.
 *
 * @public
 */
export interface PluginSchemaDeclaration {
  /** The prefix every table of the plugin starts with. */
  readonly tablePrefix: string;
  /** A JSON model description inside the package or bundle (required for a bundle). */
  readonly file?: string;
}

/**
 * One admin navigation entry, relative to the plugin's admin mount.
 *
 * @public
 */
export interface PluginAdminNavItem {
  readonly label: string;
  readonly path: string;
}

/**
 * A CLI command or generator a package contributes, loaded from `module` only
 * when it runs.
 *
 * @public
 */
export interface PluginToolDeclaration {
  /** The command name, lowercase and colon-separated (`auth:migrate`). */
  readonly name: string;
  /** One line for help output. */
  readonly summary: string;
  /** The package's own export that implements it. */
  readonly module: string;
}

/**
 * The kind of value an environment variable holds.
 *
 * @public
 */
export type PluginEnvKind = 'string' | 'url' | 'integer' | 'boolean' | 'secret';

/**
 * An environment variable a package reads.
 *
 * @public
 */
export interface PluginEnvDeclaration {
  readonly name: string;
  readonly kind: PluginEnvKind;
  /** Whether the plugin refuses to start without it. */
  readonly required: boolean;
  /** Whether tooling may generate a value (secrets only). */
  readonly generate: boolean;
  readonly description?: string;
}

/**
 * A validated plugin manifest, format version 1.
 *
 * @public
 */
export interface PluginManifestV1 {
  readonly manifestVersion: 1;
  /** Unique plugin id matching {@link PLUGIN_ID_PATTERN}. */
  readonly id: string;
  /** The plugin version (semver). */
  readonly version: string;
  /** Display name. */
  readonly name: string;
  /** One-sentence summary. */
  readonly summary: string;
  /** The publisher id whose release key signs the plugin. */
  readonly publisher: string;
  /** The framework versions the plugin supports: one caret or tilde range. */
  readonly jsailsCompat: string;
  readonly apiTier: PluginApiTier;
  /** Whether the entry module may load in a browser bundle. */
  readonly browserSafe: boolean;
  /** Registered permissions (`id` or `id:scope`). */
  readonly permissions: readonly string[];
  /** Required plugins, unique by id. */
  readonly plugins: readonly PluginDependency[];
  /** The entry module: a path inside the bundle, or the package's own specifier or path. */
  readonly entry: string;
  /** The settings an operator may set. */
  readonly settings?: SettingsSchema;
  /** The tables the plugin owns. */
  readonly schema?: PluginSchemaDeclaration;
  /** Admin navigation entries. */
  readonly admin?: { readonly nav: readonly PluginAdminNavItem[] };
  /** The exact host specifiers (framework packages) the plugin's code imports. */
  readonly host?: { readonly imports: readonly string[] };
  /** Whether the plugin may be distributed as a marketplace bundle. */
  readonly marketplace: boolean;
  /** CLI commands (npm packages only). */
  readonly commands?: readonly PluginToolDeclaration[];
  /** Code generators (npm packages only). */
  readonly generators?: readonly PluginToolDeclaration[];
  /** Bare-name exposure (npm packages only). */
  readonly autoload?: AutoloadDeclaration;
  /** Environment variables read (npm packages only). */
  readonly env?: readonly PluginEnvDeclaration[];
}

/**
 * A value-free manifest issue.
 *
 * @public
 */
export interface PluginManifestIssue {
  /** The location of the failure, e.g. `["permissions", 2]`. Never a raw value. */
  readonly path: readonly (string | number)[];
  /** A stable code, e.g. `unknown_permission` or `npm_only_field`. */
  readonly code: string;
  /** A short description derived from the schema, never from input. */
  readonly message: string;
}

/**
 * The result of {@link checkPluginManifest}.
 *
 * @public
 */
export type PluginManifestCheck =
  | { readonly ok: true; readonly manifest: PluginManifestV1 }
  | { readonly ok: false; readonly issues: readonly PluginManifestIssue[] };

/**
 * Stable failure code carried by {@link PluginManifestError}.
 *
 * @public
 */
export type PluginManifestErrorCode = 'invalid_manifest';

/**
 * Raised by {@link parsePluginManifest} for a manifest with any issue.
 *
 * @public
 */
export class PluginManifestError extends JsailsError {
  readonly code: PluginManifestErrorCode = 'invalid_manifest';

  /** Structured, value-free failures. */
  constructor(readonly issues: readonly PluginManifestIssue[]) {
    super(
      issues
        .map((issue) => `${formatIssuePath(issue.path, '(manifest)')}: ${issue.message}`)
        .join('; '),
    );
  }
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim() !== '' && !/[\r\n]/.test(value), {
      message: 'must be a non-empty single line',
    });
const idSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(PLUGIN_ID_PATTERN);
const bareSpecifier = z.string().max(MAX_PATH_LENGTH).regex(BARE_SPECIFIER_PATTERN);
const toolSchema = z
  .object({
    name: z.string().max(MAX_ID_LENGTH).regex(COMMAND_NAME_PATTERN),
    summary: text(MAX_SUMMARY_LENGTH),
    module: bareSpecifier,
  })
  .strict();

const autoloadSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('all') }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      plugins: z.array(idSchema).max(MAX_LIST).optional(),
      specifiers: z.array(bareSpecifier).max(MAX_LIST).optional(),
    })
    .strict(),
]);

const manifestShape = z
  .object({
    manifestVersion: z.literal(PLUGIN_MANIFEST_VERSION),
    id: idSchema,
    version: z.string().min(1).max(MAX_VERSION_LENGTH),
    name: text(MAX_NAME_LENGTH),
    summary: text(MAX_SUMMARY_LENGTH),
    publisher: z.string().regex(PUBLISHER_PATTERN),
    jsailsCompat: z.string().min(1).max(MAX_VERSION_LENGTH),
    apiTier: z.enum(['stable', 'experimental']),
    browserSafe: z.boolean().default(false),
    permissions: z.array(z.string()).max(MAX_LIST).default([]),
    plugins: z
      .array(z.object({ id: idSchema, range: z.string().min(1).max(MAX_VERSION_LENGTH) }).strict())
      .max(MAX_LIST)
      .default([]),
    entry: z.string().min(1).max(MAX_PATH_LENGTH),
    settings: z.unknown().optional(),
    schema: z
      .object({
        tablePrefix: z.string().regex(TABLE_PREFIX_PATTERN),
        file: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
      })
      .strict()
      .optional(),
    admin: z
      .object({
        nav: z
          .array(
            z
              .object({ label: text(MAX_NAME_LENGTH), path: z.string().regex(ADMIN_PATH_PATTERN) })
              .strict(),
          )
          .max(MAX_LIST),
      })
      .strict()
      .optional(),
    host: z
      .object({ imports: z.array(bareSpecifier).max(MAX_HOST_IMPORTS) })
      .strict()
      .optional(),
    marketplace: z.boolean().default(false),
    commands: z.array(toolSchema).max(MAX_LIST).optional(),
    generators: z.array(toolSchema).max(MAX_LIST).optional(),
    autoload: autoloadSchema.optional(),
    env: z
      .array(
        z
          .object({
            name: z.string().regex(ENV_NAME_PATTERN),
            kind: z.enum(['string', 'url', 'integer', 'boolean', 'secret']),
            required: z.boolean().default(false),
            generate: z.boolean().default(false),
            description: text(MAX_SUMMARY_LENGTH).optional(),
          })
          .strict(),
      )
      .max(MAX_LIST)
      .optional(),
  })
  .strict();

/** The fields only an npm package's manifest may carry. */
const NPM_ONLY_FIELDS = ['commands', 'generators', 'autoload', 'env'] as const;

// ---------------------------------------------------------------------------
// Rules beyond shape
// ---------------------------------------------------------------------------

const MESSAGES: Readonly<Record<string, string>> = {
  invalid_version: 'must be a valid semver version',
  invalid_range: 'must be a valid semver range',
  invalid_compat_range: 'must be one caret or tilde range of a release version',
  experimental_requires_tilde: 'an experimental plugin must use a tilde range',
  duplicate: 'must be unique',
  self_dependency: 'a plugin cannot depend on itself',
  permission_required: 'requires a permission the manifest does not declare',
  npm_only_field: 'only an npm package manifest may declare this field',
  bundle_requires_marketplace: 'a bundle manifest must set marketplace to true',
  invalid_entry:
    'must be a module file inside a bundle, or the package itself or a path inside it, never a URL',
  invalid_path: 'must be a relative path to a .json file inside the plugin',
  schema_file_required: 'a bundle that owns tables must describe them in a file',
  generate_requires_secret: 'only a secret may be generated',
  unknown_permission: 'is not a registered permission',
  invalid_format: 'is not a permission name',
  scope_required: 'this permission names a scope after a colon',
  scope_not_allowed: 'this permission takes no scope',
  invalid_scope: 'the scope is not valid for this permission',
  reserved_scope: 'the scope is reserved for the framework',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * An unknown key is input, and a bundle is uploaded by anyone with install
 * rights, so the key stays in the issue path only when it is a short plain
 * identifier (`checksums`, `settingsSchema`): enough to name a misspelt or
 * removed field, never a place for control characters or a payload that an
 * error message or a log line would carry.
 */
const REPORTABLE_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function shapeIssue(found: {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}): PluginManifestIssue {
  const last = found.path.at(-1);
  const path =
    found.code === 'unknown_field' && typeof last === 'string' && !REPORTABLE_KEY_PATTERN.test(last)
      ? found.path.slice(0, -1)
      : found.path;
  return Object.freeze({
    path: Object.freeze([...path]),
    code: found.code,
    message: found.message,
  });
}

function issue(path: readonly (string | number)[], code: string): PluginManifestIssue {
  return Object.freeze({
    path: Object.freeze([...path]),
    code,
    message: MESSAGES[code] ?? `invalid settings schema (${code})`,
  });
}

/**
 * A relative path that stays inside its root on every platform: no leading
 * `/`, no drive or URL prefix, no backslash, no `.`/`..`/empty segment except
 * one leading `./`, and no control character.
 */
function isPortableRelativePath(value: string): boolean {
  const path = value.startsWith('./') ? value.slice(2) : value;
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  if (URL_SCHEME_PATTERN.test(path) || /^[A-Za-z]:/.test(path)) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** One caret or tilde range of a release version (`^1.2.0`, `~0.4.1`). */
function compatOperator(range: string): '^' | '~' | undefined {
  const operator = range[0];
  if (operator !== '^' && operator !== '~') return undefined;
  const version = parseSemver(range.slice(1));
  if (version === null || version.prerelease.length > 0) return undefined;
  return operator;
}

function findDuplicates(
  values: readonly string[],
  path: readonly (string | number)[],
  issues: PluginManifestIssue[],
  suffix: readonly (string | number)[] = [],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) issues.push(issue([...path, index, ...suffix], 'duplicate'));
    seen.add(value);
  });
}

type ManifestShape = z.infer<typeof manifestShape>;

function checkRules(
  data: ManifestShape,
  source: PluginManifestSource,
): { readonly issues: PluginManifestIssue[]; readonly settings: SettingsSchema | undefined } {
  const issues: PluginManifestIssue[] = [];

  if (!isValidSemverVersion(data.version)) issues.push(issue(['version'], 'invalid_version'));
  const operator = compatOperator(data.jsailsCompat);
  if (operator === undefined) {
    issues.push(issue(['jsailsCompat'], 'invalid_compat_range'));
  } else if (data.apiTier === 'experimental' && operator !== '~') {
    issues.push(issue(['jsailsCompat'], 'experimental_requires_tilde'));
  }

  data.plugins.forEach((dependency, index) => {
    if (!isValidSemverRange(dependency.range)) {
      issues.push(issue(['plugins', index, 'range'], 'invalid_range'));
    }
    if (dependency.id === data.id) issues.push(issue(['plugins', index, 'id'], 'self_dependency'));
  });
  findDuplicates(
    data.plugins.map((dependency) => dependency.id),
    ['plugins'],
    issues,
    ['id'],
  );

  const declared = new Set<string>();
  data.permissions.forEach((permission, index) => {
    const parsed = parsePermission(permission);
    if (!parsed.ok) {
      issues.push(issue(['permissions', index], parsed.code satisfies PermissionIssueCode));
    } else if (declared.has(permission)) {
      issues.push(issue(['permissions', index], 'duplicate'));
    }
    declared.add(permission);
  });

  let settings: SettingsSchema | undefined;
  if (data.settings !== undefined) {
    const parsed = parseSettingsSchema(data.settings);
    if (parsed.ok) settings = parsed.schema;
    else
      issues.push(...parsed.issues.map((found) => issue(['settings', ...found.path], found.code)));
  }

  if (data.schema !== undefined) {
    if (!declared.has('data.own')) issues.push(issue(['schema'], 'permission_required'));
    if (
      data.schema.file !== undefined &&
      (!isPortableRelativePath(data.schema.file) || !data.schema.file.endsWith('.json'))
    ) {
      issues.push(issue(['schema', 'file'], 'invalid_path'));
    }
    if (source === 'bundle' && data.schema.file === undefined) {
      issues.push(issue(['schema'], 'schema_file_required'));
    }
  }
  if (data.admin !== undefined) {
    if (data.admin.nav.length > 0 && !declared.has('admin.pages')) {
      issues.push(issue(['admin', 'nav'], 'permission_required'));
    }
    findDuplicates(
      data.admin.nav.map((item) => item.path),
      ['admin', 'nav'],
      issues,
      ['path'],
    );
  }
  if (data.host !== undefined) findDuplicates(data.host.imports, ['host', 'imports'], issues);
  for (const field of ['commands', 'generators'] as const) {
    const tools = data[field];
    if (tools !== undefined) {
      findDuplicates(
        tools.map((tool) => tool.name),
        [field],
        issues,
        ['name'],
      );
    }
  }
  if (data.env !== undefined) {
    findDuplicates(
      data.env.map((variable) => variable.name),
      ['env'],
      issues,
      ['name'],
    );
    data.env.forEach((variable, index) => {
      if (variable.generate && variable.kind !== 'secret') {
        issues.push(issue(['env', index, 'generate'], 'generate_requires_secret'));
      }
    });
  }

  if (URL_SCHEME_PATTERN.test(data.entry)) {
    issues.push(issue(['entry'], 'invalid_entry'));
  } else if (source === 'bundle') {
    // A bundle is not an npm package and nothing resolves inside it, so its
    // entry names one module file exactly.
    if (!isPortableRelativePath(data.entry) || !MODULE_FILE_PATTERN.test(data.entry)) {
      issues.push(issue(['entry'], 'invalid_entry'));
    }
  } else if (!BARE_SPECIFIER_PATTERN.test(data.entry) && !isPortableRelativePath(data.entry)) {
    // A package entry that is not its own specifier is a path inside the package.
    issues.push(issue(['entry'], 'invalid_entry'));
  }

  if (source === 'bundle' && !data.marketplace) {
    issues.push(issue(['marketplace'], 'bundle_requires_marketplace'));
  }

  return { issues, settings };
}

function freezeAutoload(autoload: AutoloadDeclaration): AutoloadDeclaration {
  if (autoload.mode !== 'selected') return Object.freeze({ ...autoload });
  return Object.freeze({
    mode: autoload.mode,
    ...(autoload.plugins === undefined ? {} : { plugins: Object.freeze([...autoload.plugins]) }),
    ...(autoload.specifiers === undefined
      ? {}
      : { specifiers: Object.freeze([...autoload.specifiers]) }),
  });
}

function freezeManifest(
  data: ManifestShape,
  settings: SettingsSchema | undefined,
): PluginManifestV1 {
  const freezeList = <T>(items: readonly T[]): readonly T[] =>
    Object.freeze(items.map((item) => (typeof item === 'object' ? Object.freeze(item) : item)));
  return Object.freeze({
    manifestVersion: data.manifestVersion,
    id: data.id,
    version: data.version,
    name: data.name,
    summary: data.summary,
    publisher: data.publisher,
    jsailsCompat: data.jsailsCompat,
    apiTier: data.apiTier,
    browserSafe: data.browserSafe,
    permissions: freezeList(data.permissions),
    plugins: freezeList(data.plugins),
    entry: data.entry,
    ...(settings === undefined ? {} : { settings }),
    ...(data.schema === undefined ? {} : { schema: Object.freeze(data.schema) }),
    ...(data.admin === undefined
      ? {}
      : { admin: Object.freeze({ nav: freezeList(data.admin.nav) }) }),
    ...(data.host === undefined
      ? {}
      : { host: Object.freeze({ imports: freezeList(data.host.imports) }) }),
    marketplace: data.marketplace,
    ...(data.commands === undefined ? {} : { commands: freezeList(data.commands) }),
    ...(data.generators === undefined ? {} : { generators: freezeList(data.generators) }),
    ...(data.autoload === undefined ? {} : { autoload: freezeAutoload(data.autoload) }),
    ...(data.env === undefined ? {} : { env: freezeList(data.env) }),
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Check a raw manifest from `source`. Returns the frozen manifest, or every
 * value-free issue found. The input is never mutated.
 *
 * @public
 */
export function checkPluginManifest(
  raw: unknown,
  source: PluginManifestSource,
): PluginManifestCheck {
  // A bundle's npm-only fields are refused by name before the shape is read,
  // so the refusal does not depend on whether their contents happen to be
  // well formed, and the rest of the manifest is still checked in full.
  const npmOnly: PluginManifestIssue[] = [];
  let input = raw;
  if (source === 'bundle' && isRecord(raw)) {
    const present = NPM_ONLY_FIELDS.filter((field) => Object.hasOwn(raw, field));
    if (present.length > 0) {
      npmOnly.push(...present.map((field) => issue([field], 'npm_only_field')));
      input = Object.fromEntries(
        Object.entries(raw).filter(
          ([key]) => !(NPM_ONLY_FIELDS as readonly string[]).includes(key),
        ),
      );
    }
  }
  const result = manifestShape.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: Object.freeze([...npmOnly, ...mapZodIssues(result.error).map(shapeIssue)]),
    };
  }
  const { issues, settings } = checkRules(result.data, source);
  if (npmOnly.length > 0 || issues.length > 0) {
    return { ok: false, issues: Object.freeze([...npmOnly, ...issues]) };
  }
  return { ok: true, manifest: freezeManifest(result.data, settings) };
}

/**
 * Parse a raw manifest from `source`, throwing a {@link PluginManifestError}
 * with every value-free issue when it is invalid.
 *
 * @public
 */
export function parsePluginManifest(raw: unknown, source: PluginManifestSource): PluginManifestV1 {
  const result = checkPluginManifest(raw, source);
  if (!result.ok) throw new PluginManifestError(result.issues);
  return result.manifest;
}
