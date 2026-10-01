/**
 * Theme package manifest contract: the JSON shape a shipped theme declares so
 * the framework can discover, validate, and activate it without importing any
 * package code.
 *
 * A manifest is plain JSON, validated with Zod and then checked for semver
 * soundness and safe relative paths. `parseThemePackageManifest` returns a
 * frozen {@link ThemePackageManifest} or throws a {@link ThemePackageError};
 * messages are value-free (invalid input and path/token content are never
 * echoed). The manifest describes the theme's identity (`name`, `version`),
 * its presentation (`description`, `author`, `preview`), its CSS token
 * contributions (`tokens`), its template/partial entry paths, an opaque
 * `settingsSchema` descriptor, and its supported content types. Paths are
 * package-relative and never resolved or read here; a later slice consumes
 * them. No code is ever executed.
 */

import { z } from 'zod';

import { mapZodIssues, splitDottedPath, type ZodIssueEntry } from 'jsails/plugin-sdk';
import { parseThemeTemplate, type ThemeTemplate } from './template.js';
import { isValidSemverVersion } from 'jsails/semver';
import type { ThemeTokenMap } from '../tokens.js';
import { CONTROL_CHARS } from 'jsails/support';

// ---------------------------------------------------------------------------
// Patterns and bounds
// ---------------------------------------------------------------------------

/**
 * Theme package names: a lowercase/digit start followed by lowercase letters,
 * digits, `.`, `_`, or `-`. The uniqueness domain for activation, and the key
 * used for the `[data-theme="<name>"]` blocks and the registry lookup.
 */
export const THEME_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Token names must live in the consuming `--jsails-*` namespace so a
 * contributed property is actually consumed by the admin renderer and starter
 * layout. This is stricter than {@link ThemeTokenMap} (which accepts any
 * `--*` name) because a manifest is an untrusted boundary: a name outside
 * this safe vocabulary is refused rather than injected into CSS.
 */
const TOKEN_NAME_PATTERN = /^--jsails-[a-z0-9-]+$/;

/** Supported content types are lowercase slug words (e.g. `article`, `page`). */
const CONTENT_TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Control characters and CSS-break sequences are never safe to inject. */
/** CSS may contain tab/newline/carriage-return (formatting), but no other controls. */
const CSS_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const STYLE_BREAK = /<\/style/i;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** Upper bound on the manifest name length. */
const MAX_NAME_LENGTH = 214;
/** Upper bound on a version string length. */
const MAX_VERSION_LENGTH = 256;
/** Upper bound on description/author text. */
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_AUTHOR_LENGTH = 256;
/** Upper bound on a declared path length. */
const MAX_PATH_LENGTH = 1024;
/** Upper bound on template/partial path counts. */
const MAX_PATHS = 256;
/** Upper bound on contributed token entries. */
const MAX_TOKENS = 256;
/** Upper bound on a token name/value length. */
const MAX_TOKEN_NAME_LENGTH = 256;
const MAX_TOKEN_VALUE_LENGTH = 512;
/** Upper bound on supported content types. */
const MAX_CONTENT_TYPES = 64;
const MAX_CONTENT_TYPE_LENGTH = 64;

// ---------------------------------------------------------------------------
// Typed manifest and its error
// ---------------------------------------------------------------------------

/** Named layout regions a theme package may provide. */
export const THEME_LAYOUT_NAMES = [
  'header',
  'footer',
  'blogIndex',
  'blogArchive',
  'blogSingle',
  'blogError',
] as const;

/** A named blog theme layout. */
export type ThemeLayoutName = (typeof THEME_LAYOUT_NAMES)[number];

/** A validated, frozen theme package manifest. */
export interface ThemePackageManifest {
  /** Unique theme name matching {@link THEME_NAME_PATTERN}. */
  readonly name: string;
  /** Theme version (valid semver). */
  readonly version: string;
  /**
   * Optional parent theme name. A child inherits its parent's tokens and
   * missing assets/layouts through the registry chain; a parent may be active
   * on its own. Parent names are validated as theme names, and the registry
   * rejects missing parents and cycles.
   */
  readonly parent?: string;
  /** Human-readable description. */
  readonly description?: string;
  /** Author attribution. */
  readonly author?: string;
  /** Package-relative path to a preview image. */
  readonly preview?: string;
  /** CSS token contributions in the `--jsails-*` namespace. Defaults to `{}`. */
  readonly tokens: ThemeTokenMap;
  /** Package-relative template entry paths. Defaults to `[]`. */
  readonly templates: readonly string[];
  /** Package-relative partial entry paths. Defaults to `[]`. */
  readonly partials: readonly string[];
  /** Opaque settings schema descriptor (a JSON object when present); never interpreted here. */
  readonly settingsSchema?: Readonly<Record<string, unknown>>;
  /** Supported content types (slug words). Defaults to `[]`. */
  readonly contentTypes: readonly string[];
  /** Validated declarative blog layouts, keyed by region. Defaults to `{}`. */
  readonly layouts: Readonly<Partial<Record<ThemeLayoutName, ThemeTemplate>>>;
  /** Theme CSS appended after token CSS. Defaults to `''`. */
  readonly css: string;
}

/** A value-free validation failure: a field path plus a stable code. */
export interface ThemePackageIssue {
  /** Location of the failure, e.g. `["tokens"]`. Never a raw value. */
  readonly path: readonly (string | number)[];
  /** Stable machine code, e.g. `"invalid_version"`, `"invalid_token"`. */
  readonly code: string;
  /** Short description derived only from the schema, never from input. */
  readonly message: string;
}

/**
 * Hard-error codes for the theme package surface. `invalid_manifest` is a
 * shape/semver/safety failure (carrying structured {@link ThemePackageIssue}s);
 * `invalid_path` is an unsafe package path; `unsupported_version` is a valid
 * semver outside the caller's supported range; `duplicate_name` is a repeated
 * theme name; `unknown_theme` is activation/creation against a missing name;
 * `invalid_input` is a malformed caller argument.
 */
export type ThemePackageErrorCode =
  | 'invalid_manifest'
  | 'invalid_path'
  | 'unsupported_version'
  | 'duplicate_name'
  | 'unknown_theme'
  | 'invalid_input'
  | 'missing_parent'
  | 'parent_cycle'
  | 'parent_depth';

/** Raised for a manifest, path, discovery, or activation failure. Value-free. */
export class ThemePackageError extends Error {
  readonly code: ThemePackageErrorCode;
  /** Structured, value-free failures (populated for `invalid_manifest`). */
  readonly issues?: readonly ThemePackageIssue[];

  constructor(code: ThemePackageErrorCode, message: string, issues?: readonly ThemePackageIssue[]) {
    super(message);
    this.name = 'ThemePackageError';
    this.code = code;
    if (issues !== undefined) {
      this.issues = issues;
    }
  }
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const tokenMapSchema = z.record(
  z.string().min(1).max(MAX_TOKEN_NAME_LENGTH),
  z.string().min(1).max(MAX_TOKEN_VALUE_LENGTH),
);
const pathArraySchema = z.array(pathSchema).max(MAX_PATHS);
const contentTypesSchema = z
  .array(z.string().min(1).max(MAX_CONTENT_TYPE_LENGTH).regex(CONTENT_TYPE_PATTERN))
  .max(MAX_CONTENT_TYPES);

/**
 * The manifest schema. Strict: unknown fields are rejected rather than
 * ignored, so a typo in an author's manifest surfaces instead of silently
 * dropping behavior. `tokens`, `templates`, `partials`, and `contentTypes`
 * are optional and defaulted; `description`, `author`, `preview`, and
 * `settingsSchema` are optional.
 */
export const themePackageManifestSchema = z
  .object({
    name: z.string().min(1).max(MAX_NAME_LENGTH).regex(THEME_NAME_PATTERN),
    version: z.string().min(1).max(MAX_VERSION_LENGTH),
    parent: z.string().min(1).max(MAX_NAME_LENGTH).regex(THEME_NAME_PATTERN).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    author: z.string().max(MAX_AUTHOR_LENGTH).optional(),
    preview: pathSchema.optional(),
    tokens: tokenMapSchema.optional(),
    templates: pathArraySchema.optional(),
    partials: pathArraySchema.optional(),
    settingsSchema: z.record(z.string(), z.unknown()).optional(),
    contentTypes: contentTypesSchema.optional(),
    layouts: z.record(z.enum(THEME_LAYOUT_NAMES), z.unknown()).optional(),
    css: z.string().max(200_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Whether `input` is a safe package-relative path. Rejects an empty string, a
 * leading `/` or Windows drive prefix, any backslash, any control character,
 * an empty path segment, and any `..` traversal segment. A `.` segment is
 * harmless and allowed, so `./index.html` is accepted.
 */
export function isSafeRelativePath(input: string): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  if (CONTROL_CHARS.test(input)) return false;
  if (input.includes('\\')) return false;
  if (input.startsWith('/')) return false;
  if (WINDOWS_DRIVE.test(input)) return false;
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Validate and parse a raw manifest value into a frozen
 * {@link ThemePackageManifest}. Throws a {@link ThemePackageError} with
 * code `invalid_manifest` for a shape failure, a version that is not valid
 * semver, an over-limit token count, an out-of-namespace token name, or an
 * injection-unsafe token value; code `invalid_path` for a `preview`,
 * `templates`, or `partials` entry that is not a safe package-relative path.
 * The raw input is never echoed and never mutated; the returned manifest, its
 * `tokens` map, and its `templates`/`partials`/`contentTypes` arrays are
 * frozen (`settingsSchema` is shallow-frozen because its values are opaque).
 */
export function parseThemePackageManifest(raw: unknown): ThemePackageManifest {
  const result = themePackageManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = mapThemePackageIssues(result.error);
    throw new ThemePackageError('invalid_manifest', formatIssues(issues), issues);
  }
  const data = result.data;

  if (!isValidSemverVersion(data.version)) {
    throw manifestIssueError(['version'], 'invalid_version', 'must be a valid semver version');
  }

  if (data.preview !== undefined && !isSafeRelativePath(data.preview)) {
    throw new ThemePackageError('invalid_path', 'preview must be a safe package-relative path');
  }
  for (const path of data.templates ?? []) {
    if (!isSafeRelativePath(path)) {
      throw new ThemePackageError(
        'invalid_path',
        'templates must contain only safe package-relative paths',
      );
    }
  }
  for (const path of data.partials ?? []) {
    if (!isSafeRelativePath(path)) {
      throw new ThemePackageError(
        'invalid_path',
        'partials must contain only safe package-relative paths',
      );
    }
  }

  const rawTokens = data.tokens ?? {};
  if (Object.keys(rawTokens).length > MAX_TOKENS) {
    throw manifestIssueError(['tokens'], 'too_big', `must have at most ${MAX_TOKENS} entries`);
  }
  for (const [name, value] of Object.entries(rawTokens)) {
    if (!TOKEN_NAME_PATTERN.test(name)) {
      throw manifestIssueError(
        ['tokens'],
        'invalid_token_name',
        'token names must match the --jsails-* namespace',
      );
    }
    if (CONTROL_CHARS.test(value) || STYLE_BREAK.test(value)) {
      throw manifestIssueError(
        ['tokens', name],
        'invalid_token',
        'token value is not safe for CSS injection',
      );
    }
  }

  const rawLayouts = data.layouts ?? {};
  const layouts: Partial<Record<ThemeLayoutName, ThemeTemplate>> = {};
  for (const [name, raw] of Object.entries(rawLayouts)) {
    if (raw === undefined) continue;
    layouts[name as ThemeLayoutName] = parseThemeTemplate(raw);
  }

  const css = data.css ?? '';
  if (CSS_CONTROL_CHARS.test(css) || STYLE_BREAK.test(css)) {
    throw new ThemePackageError('invalid_manifest', 'theme css contains unsafe characters');
  }

  const manifest: ThemePackageManifest = {
    name: data.name,
    version: data.version,
    ...(data.parent === undefined ? {} : { parent: data.parent }),
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.author !== undefined ? { author: data.author } : {}),
    ...(data.preview !== undefined ? { preview: data.preview } : {}),
    tokens: Object.freeze({ ...rawTokens }),
    templates: Object.freeze([...(data.templates ?? [])]),
    partials: Object.freeze([...(data.partials ?? [])]),
    ...(data.settingsSchema !== undefined
      ? { settingsSchema: Object.freeze(data.settingsSchema) }
      : {}),
    contentTypes: Object.freeze([...(data.contentTypes ?? [])]),
    layouts: Object.freeze(layouts),
    css,
  };
  return Object.freeze(manifest);
}

// ---------------------------------------------------------------------------
// Value-free issue rendering
// ---------------------------------------------------------------------------

function mapThemePackageIssues(error: z.ZodError): ThemePackageIssue[] {
  return mapZodIssues(error).map(toThemePackageIssue);
}

function toThemePackageIssue(entry: ZodIssueEntry): ThemePackageIssue {
  return {
    path: entry.path === '_root' ? [] : splitDottedPath(entry.path),
    code: entry.code,
    message: entry.message,
  };
}

function formatIssues(issues: readonly ThemePackageIssue[]): string {
  return issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join('.') : '(manifest)';
      return `${location}: ${issue.message}`;
    })
    .join('; ');
}

function manifestIssueError(
  path: readonly (string | number)[],
  code: string,
  message: string,
): never {
  const issues: ThemePackageIssue[] = [{ path, code, message }];
  throw new ThemePackageError('invalid_manifest', formatIssues(issues), issues);
}
