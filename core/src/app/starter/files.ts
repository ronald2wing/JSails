/**
 * Starter file-map assembly.
 *
 * `createStarterFiles` produces the complete file set for a fresh JSails
 * starter application as an in-memory map of portable relative paths to file
 * contents. It reads a fixed whitelist of bundled text templates from the
 * package root (resolved relative to this compiled module, never the process
 * working directory), strips the `.template` suffix, and rewrites the
 * `package.json` `name` and `jsails` dependency in place. It never writes to
 * disk, never installs dependencies, and never spawns a subprocess — the
 * caller owns every filesystem effect.
 *
 * The starter ships five shapes. The default (`starter`) is a static-site
 * build:
 * templates from `templates/starter/` with a real `jsails.app.js`
 * (`plugins.use: []`, no marketplace/DB), pages + a Preact island + Vite, and
 * no auth, API, server components, or Jamal. `admin: true`, `blog: true`, and
 * `saas: true` share the server-rendered web templates from
 * `templates/starter-web/`: admin adds the admin panel, while blog adds the
 * first-party blog plugin, the plugin manager in the admin panel, and two blog
 * pages; saas adds the admin panel plus multi-tenancy and feature flags.
 * `cli: true` is a separate,
 * Laravel-Zero-style CLI-only shape from `templates/starter-cli/` with a real
 * `jsails.app.js` (the same extension seam as the web starter, with
 * `plugins.use: []`), no web surface (`pages/`, `api/`, `public/`, `client/`,
 * auth, admin, blog, or Vite), and a trimmed `tsconfig.json`. `starter: true` is
 * an explicit spelling of the default shape; `cli` and `starter` are mutually
 * exclusive with `admin`/`blog`/`saas` and with each other.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isPlainObject } from '../../internal/json-safe.js';
import { buildCliGuide, buildDefaultGuide, buildWebGuide } from './guides.js';
import { buildPackageJson, EXTRA_SCRIPTS } from './package-json.js';
import {
  managedPluginsLiteral,
  resolveStarterFeatures,
  resolveStarterPreset,
  type StarterFeature,
  type WebStarterVariant,
} from './presets.js';
import { CONTROL_CHARS } from '../../support/strings.js';

export type { WebStarterVariant } from './presets.js';

/** Absolute path of the package root, resolved from this compiled module. */
const PACKAGE_ROOT = resolve(import.meta.dirname, '../../../../');

/** Error raised for any invalid starter option or unreadable bundled file. */
export class StarterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StarterError';
  }
}

/** Options for {@link createStarterFiles}. */
export interface StarterOptions {
  /** npm package name for the generated project. Defaults to `"jsails-app"`. */
  name?: string;
  /**
   * Value of the `jsails` entry in the generated `package.json`. Defaults to
   * the framework's own package version; when supplied it must be a non-empty
   * `file:` specifier (e.g. `"file:../jsails"`) or an npm semver range
   * (e.g. `"^1.0.0"`).
   */
  jsailsDependency?: string;
  /**
   * Package dependency overrides merged over the variant's default plugin
   * dependency map (e.g. `@jsails/admin`, `@jsails/auth`, ...). Each key is a
   * valid npm package name and each value a `file:` specifier (e.g.
   * `"file:/tmp/jsails-blog-1.0.0.tgz"`) or an npm semver range. This lets a
   * checked-out workspace install its plugins from local tarballs
   * (`jsails create --package-dependency @jsails/blog=file:...`) instead of
   * unpublished npm versions.
   */
  packageDependencies?: Readonly<Record<string, string>>;
  /**
   * Include the admin panel (`@jsails/admin`) in the generated app config.
   * Defaults to `false`; the default starter is a static site with no auth.
   */
  admin?: boolean;
  /**
   * Include the first-party blog plugin (`@jsails/blog`), the plugin manager,
   * and the blog pages. Enables the admin panel as part of the blog shape.
   * Defaults to `false`.
   */
  blog?: boolean;
  /**
   * Include multi-tenancy (`@jsails/tenancy`) and feature flags
   * (`@jsails/flags`) alongside the admin panel. Enables the admin panel as part
   * of the saas shape but ships no blog, editor, media, or plugin manager.
   * Defaults to `false`. Mutually exclusive with {@link StarterOptions.admin},
   * {@link StarterOptions.blog}, {@link StarterOptions.starter}, and
   * {@link StarterOptions.cli}.
   */
  saas?: boolean;
  /**
   * Generate the CLI-only starter (a Laravel-Zero-style command project with no
   * web surface) instead of a web or default starter. Defaults to `false`. Mutually
   * exclusive with {@link StarterOptions.admin}, {@link StarterOptions.blog},
   * and {@link StarterOptions.starter}.
   */
  cli?: boolean;
  /**
   * Generate the default static-site starter explicitly. This is the
   * default shape when no shape flag is supplied, so the flag exists mainly to
   * reject an ambiguous combination with `admin`/`blog`/`cli`. Mutually
   * exclusive with {@link StarterOptions.admin}, {@link StarterOptions.blog},
   * and {@link StarterOptions.cli}.
   */
  starter?: boolean;
  /**
   * `AGENTS.md` content for the generated project. Defaults to the framework's
   * own bundled guide; when supplied it replaces that guide, with the
   * app-specific starter instructions always prepended.
   */
  guide?: string;
}

/** The generated file set: portable relative path -> file contents. */
export interface StarterFiles {
  readonly files: Readonly<Record<string, string>>;
}

/** Default npm name of the generated project. */
const DEFAULT_NAME = 'jsails-app';

/** C0 controls plus DEL — never valid in a single-token option value. */

/** C0 controls except tab/LF/CR, plus DEL — never valid in free-form text. */
const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Conservative npm package name: lowercase, URL-safe, no leading "." or "_",
 * with an optional leading `@scope/`. This accepts the subset of names npm
 * allows for new packages.
 */
const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Maximum length npm accepts for a package name. */
const MAX_NAME_LENGTH = 214;

/** Validate the generated project name. Errors never echo the raw value. */
function assertName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StarterError('options.name must be a non-empty string');
  }
  if (CONTROL_CHARS.test(value)) {
    throw new StarterError('options.name must not contain control characters');
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new StarterError('options.name must not exceed 214 characters');
  }
  if (!NPM_NAME_PATTERN.test(value)) {
    throw new StarterError(
      'options.name must be a valid npm package name (lowercase, URL-safe, no leading "." or "_")',
    );
  }
  return value;
}

/** Validate a supplied `jsails` dependency specifier. Accepts either a
 *  `file:` specifier (a packed tarball / local path — the framework-checkout
 *  workflow) or a bare npm semver range (`^1.0.0`, `1.0.0`, `>=1.0.0 <2.0.0`)
 *  resolved from the registry — the public-release path. */
function assertDependency(value: unknown): string {
  return assertFileOrRangeSpec(value, 'options.jsailsDependency');
}

/** Validate a dependency spec as a `file:` specifier or an npm semver range. */
function assertFileOrRangeSpec(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StarterError(`${label} must be a non-empty string`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new StarterError(`${label} must not contain control characters`);
  }
  if (value.startsWith('file:')) {
    if (value.length <= 'file:'.length) {
      throw new StarterError(`${label} file: specifier must name a path`);
    }
    return value;
  }
  if (!isSemverRange(value)) {
    throw new StarterError(`${label} must be a "file:" specifier or an npm semver range`);
  }
  return value;
}

/** A loose-but-safe npm semver range check: digits/dots plus range operators and
 *  whitespace separators. Deliberately not a full semver parser — it only guards
 *  against shell-syntax/control injection; npm's own resolver does the real parse. */
const SEMVER_RANGE_PATTERN =
  /^(?:[~^><=]?\s*\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)(?:\s*(?:[~^><=]?\s*\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?))*$/;

function isSemverRange(value: string): boolean {
  return SEMVER_RANGE_PATTERN.test(value);
}

/** Validate an overriding guide. Newlines/tabs are allowed; other controls are not. */
function assertGuide(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StarterError('options.guide must be a non-empty string');
  }
  if (TEXT_CONTROL_CHARS.test(value)) {
    throw new StarterError('options.guide must not contain control characters');
  }
  return value;
}

/** Validate an `admin`/`blog` flag as a boolean (or undefined). */
function assertFlag(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new StarterError(`options.${label} must be a boolean`);
  }
  return value;
}

/**
 * Validate the package-dependency override map: a plain object keyed by valid
 * npm package names, each value a `file:` specifier or an npm semver range.
 * Returns a frozen, prototype-free copy; errors never echo the raw key/value.
 */
function assertPackageDependencies(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) {
    return Object.freeze(Object.create(null) as Record<string, string>);
  }
  if (!isPlainObject(value)) {
    throw new StarterError('options.packageDependencies must be a plain object');
  }
  const out: Record<string, string> = Object.create(null);
  for (const [name, spec] of Object.entries(value)) {
    if (!NPM_NAME_PATTERN.test(name)) {
      throw new StarterError('options.packageDependencies keys must be valid npm package names');
    }
    out[name] = assertFileOrRangeSpec(spec, 'options.packageDependencies value');
  }
  return Object.freeze(out);
}

/** The framework's own version, read from the bundled package manifest. */
async function readPackageVersion(): Promise<string> {
  const text = await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(text) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new StarterError('the jsails package must declare a non-empty version');
  }
  return pkg.version;
}

/** The framework's own reader guide, bundled at the package root. */
async function readBundledGuide(): Promise<string> {
  return readFile(join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8');
}

/** Strip the `.template` suffix from a bundled template path, if present. */
function toOutputPath(template: string): string {
  return template.endsWith('.template') ? template.slice(0, -'.template'.length) : template;
}

/**
 * Rewrite the gitignore template: un-ignore the committed `.env.auth.example`
 * (the template's `.env.*` rule would ignore it).
 */
function buildGitignore(template: string): string {
  return `${template}!.env.auth.example\n`;
}

/**
 * Generate the starter file set. Reads only the bundled templates and, when no
 * override is given, the bundled package version and guide; performs no writes,
 * installs, or subprocesses; and returns a frozen, prototype-free file map.
 */
export async function createStarterFiles(options: StarterOptions = {}): Promise<StarterFiles> {
  if (!isPlainObject(options)) {
    throw new StarterError('options must be a plain object');
  }

  const name = assertName(options.name ?? DEFAULT_NAME);
  const dependency =
    options.jsailsDependency === undefined
      ? await readPackageVersion()
      : assertDependency(options.jsailsDependency);
  const admin = assertFlag(options.admin, 'admin');
  const blog = assertFlag(options.blog, 'blog');
  const saas = assertFlag(options.saas, 'saas');
  const cli = assertFlag(options.cli, 'cli');
  const starter = assertFlag(options.starter, 'starter');
  if (cli === true && (admin === true || blog === true || saas === true || starter === true)) {
    throw new StarterError(
      'options.cli cannot be combined with options.admin, options.blog, options.saas, or options.starter',
    );
  }
  if (starter === true && (admin === true || blog === true || saas === true)) {
    throw new StarterError(
      'options.starter cannot be combined with options.admin, options.blog, or options.saas',
    );
  }
  if (saas === true && (admin === true || blog === true)) {
    throw new StarterError('options.saas cannot be combined with options.admin or options.blog');
  }
  const resolution = resolveStarterPreset({ admin, blog, saas, cli, starter });
  if (!resolution.ok) {
    // The conflict validation above already throws for any flag combination
    // `resolveStarterPreset` would reject, so this is a defensive guard.
    throw new StarterError(resolution.message);
  }
  const preset = resolution.preset;
  const features = resolveStarterFeatures(preset);
  const guide = options.guide === undefined ? await readBundledGuide() : assertGuide(options.guide);
  const packageDependencies = assertPackageDependencies(options.packageDependencies);

  // Feature modules own their package dependencies. A caller's explicit
  // `--package-dependency` override wins over every feature module.
  const extraDependencies: Record<string, string> = Object.create(null);
  for (const feature of features) {
    for (const [packageName, spec] of Object.entries(feature.dependencies ?? {})) {
      const existing = extraDependencies[packageName];
      if (existing !== undefined && existing !== spec) {
        throw new StarterError('starter feature modules disagree on a package dependency');
      }
      extraDependencies[packageName] = spec;
    }
  }
  Object.assign(extraDependencies, packageDependencies);

  const enabledLiteral = managedPluginsLiteral(preset);
  const files: Record<string, string> = Object.create(null);
  const addTemplate = async (
    template: string,
    outputPath: string,
    baseDir: 'starter' | 'starter-web' | 'starter-cli',
  ): Promise<void> => {
    const text = await readFile(join(PACKAGE_ROOT, 'templates', baseDir, template), 'utf8');
    if (outputPath === 'package.json') {
      files[outputPath] = buildPackageJson(
        text,
        name,
        dependency,
        baseDir === 'starter-web' ? EXTRA_SCRIPTS : {},
        extraDependencies,
      );
    } else if (outputPath === '.gitignore' && baseDir === 'starter-web') {
      files[outputPath] = buildGitignore(text);
    } else if (outputPath === 'jsails.app.js' && baseDir === 'starter-web') {
      if (!text.includes('__JSAILS_MANAGED_PLUGINS__')) {
        throw new StarterError('starter app config template is missing its discovery placeholder');
      }
      files[outputPath] = text.replace('__JSAILS_MANAGED_PLUGINS__', enabledLiteral);
    } else {
      files[outputPath] = text;
    }
  };

  const seenOutputs = new Set<string>();
  for (const feature of features) {
    if (feature.templates === undefined) continue;
    for (const template of feature.templates.files) {
      const outputPath = toOutputPath(template);
      if (seenOutputs.has(outputPath)) {
        throw new StarterError('starter feature modules contribute the same output file');
      }
      seenOutputs.add(outputPath);
      await addTemplate(template, outputPath, feature.templates.base);
    }
  }

  const selectProvider = (
    key: 'appConfig' | 'migrationConfig',
  ):
    | NonNullable<StarterFeature['appConfig']>
    | NonNullable<StarterFeature['migrationConfig']>
    | undefined => {
    let selected:
      | NonNullable<StarterFeature['appConfig']>
      | NonNullable<StarterFeature['migrationConfig']>
      | undefined;
    for (const feature of features) {
      const provider = feature[key];
      if (provider === undefined) continue;
      if (selected === undefined || provider.priority > selected.priority) {
        selected = provider;
      }
    }
    return selected;
  };

  const appConfig = selectProvider('appConfig');
  if (appConfig === undefined) {
    throw new StarterError('starter preset has no app config provider');
  }
  await addTemplate(appConfig.template, 'jsails.app.js', appConfig.base);

  const migrationConfig = selectProvider('migrationConfig');
  if (migrationConfig !== undefined) {
    await addTemplate(migrationConfig.template, 'jsails.config.js', migrationConfig.base);
  }

  if (preset.kind === 'cli') {
    files['AGENTS.md'] = buildCliGuide(guide);
  } else if (preset.kind === 'static') {
    files['AGENTS.md'] = buildDefaultGuide(guide);
  } else {
    files['AGENTS.md'] = buildWebGuide(guide, preset.id as WebStarterVariant, enabledLiteral);
  }

  return Object.freeze({ files: Object.freeze(files) });
}
