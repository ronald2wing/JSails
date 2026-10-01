/**
 * `jsails i18n:missing` — report translation keys used in compiled page/API
 * modules but absent from every locale catalog (and, with `--unused`, the
 * inverse). Read-only, value-free (keys and file locations are reported, never
 * translation text), and exit-code gated for CI: exit 1 when keys are missing.
 *
 * ```sh
 * jsails i18n:missing [--config jsails.app.js] [--json] [--unused]
 * ```
 *
 * Only static string-literal keys are detectable; dynamic keys
 * (`t(someVar)`) are counted and surfaced as `dynamic`, never guessed. `scope`
 * options are folded into the resolved key. Bare `t`/`choice` are matched only
 * when imported from `jsails/i18n/server` (import-aware), so a `node:test`
 * `t` context is never mistaken for the i18n helper.
 */

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import { isAppConfigError } from '../../app/config/errors.js';
import type { ResolvedAppConfig } from '../../app/config/index.js';
import { walkSortedFiles } from '../../compiler/sorted-file-walk.js';
import type { Loader, Messages } from '../../i18n/loader.js';
import { loadAppConfig } from '../config-loader.js';
import type { CommandModule } from '../descriptor.js';
import type { I18N_MISSING_OPTIONS } from '../manifest.js';
import { renderResult, writeFailure } from '../report.js';

/** A single missing-key finding: the key plus every code site referencing it. */
interface MissingKeyRef {
  readonly key: string;
  readonly refs: readonly { readonly file: string; readonly line: number }[];
}

/** The full result of the check. */
interface I18nMissingResult {
  readonly missing: readonly MissingKeyRef[];
  readonly unused: readonly string[];
  /** Dynamic call sites that could not be statically scanned. */
  readonly dynamic: number;
  readonly scannedFiles: number;
  readonly locales: readonly string[];
}

/** CLI input to the command. Exported so tests can inject fakes. */
interface I18nMissingInput {
  readonly configPath: string;
  readonly options: { readonly json?: boolean; readonly unused?: boolean };
}

/** Dependency seam for the command. */
export interface I18nMissingDeps {
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  /** List compiled `.js`/`.mjs` files under a directory, recursively. */
  listFiles(dir: string): readonly string[];
  readFile(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** The environment a failure report reads `JSAILS_DEBUG` from. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const defaultDeps: Omit<I18nMissingDeps, 'env'> = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  listFiles: listCompiledFiles,
  readFile: (path) => readFileSync(path, 'utf8'),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

const COMPILED_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs']);

/** Absolute paths of the compiled `.js`/`.mjs` files under `dir`, skipping dot entries. */
function listCompiledFiles(dir: string): string[] {
  return walkSortedFiles(dir, { extensions: COMPILED_EXTENSIONS, skipDotEntries: true }).map(
    (relativePath) => join(dir, relativePath),
  );
}

/** Build a loader from the resolved i18n config, or `undefined` when absent. */
async function loaderFor(config: ResolvedAppConfig): Promise<Loader | undefined> {
  const i18n = config.i18n;
  if (i18n === undefined) return undefined;
  const { createArrayLoader, createFileLoader } = await import('../../i18n/loader.js');
  if (i18n.loadPaths !== undefined) {
    return createFileLoader({ loadPaths: i18n.loadPaths });
  }
  if (i18n.catalogs !== undefined) {
    return createArrayLoader(i18n.catalogs as Readonly<Record<string, Messages>>);
  }
  return undefined;
}

/** The set of translation keys present in any locale's catalog. */
async function catalogKeys(loader: Loader): Promise<{ keys: Set<string>; locales: string[] }> {
  const { flattenMessageKeys } = await import('../../i18n/flatten.js');
  const locales = [...(await loader.availableLocales())].sort();
  const keys = new Set<string>();
  for (const locale of locales) {
    const catalog = await loader.load(locale);
    if (catalog !== undefined) {
      for (const key of flattenMessageKeys(catalog)) keys.add(key);
    }
  }
  return { keys, locales };
}

/** Run the check and return the result, throwing only for config-load failures. */
export async function runI18nMissing(
  input: I18nMissingInput,
  deps: Omit<I18nMissingDeps, 'env'>,
): Promise<{ result: I18nMissingResult; exitCode: number }> {
  const config = await deps.loadConfig(input.configPath);

  const loader = await loaderFor(config);
  if (loader === undefined) {
    deps.stderr(
      'jsails: i18n is not configured — declare `i18n` (with `loadPaths` or `catalogs`) in the app config',
    );
    return { result: emptyResult(), exitCode: 1 };
  }

  // Scan compiled page/API modules for translation keys. A missing directory
  // yields an empty list from `listFiles` (its readdir failure is swallowed),
  // so no existence guard is needed here.
  const scannedFiles: string[] = [];
  for (const dir of [config.pagesDir, config.apiDir]) {
    scannedFiles.push(...deps.listFiles(dir));
  }

  // Imported here rather than at the top: the extractor loads rolldown's parser.
  const { extractTranslationKeys } = await import('../../i18n/extract.js');
  const keyRefs = new Map<string, { file: string; line: number }[]>();
  let dynamic = 0;
  for (const file of scannedFiles) {
    const source = deps.readFile(file);
    const extraction = extractTranslationKeys(source);
    dynamic += extraction.dynamic;
    const rel = relative(config.rootDir, file);
    for (const ref of extraction.refs) {
      const list = keyRefs.get(ref.key);
      if (list === undefined) {
        keyRefs.set(ref.key, [{ file: rel, line: ref.line }]);
      } else {
        list.push({ file: rel, line: ref.line });
      }
    }
  }

  const { keys: catalogKeySet, locales } = await catalogKeys(loader);

  // Missing: referenced in code, absent from every catalog.
  const missing: MissingKeyRef[] = [];
  for (const [key, refs] of [...keyRefs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!catalogKeySet.has(key)) {
      missing.push({ key, refs: Object.freeze(refs) });
    }
  }

  // Unused: present in a catalog, never referenced in code.
  const unused = [...catalogKeySet]
    .filter((key) => !keyRefs.has(key))
    .sort((a, b) => a.localeCompare(b));

  const result: I18nMissingResult = {
    missing: Object.freeze(missing),
    unused: Object.freeze(unused),
    dynamic,
    scannedFiles: scannedFiles.length,
    locales: Object.freeze(locales),
  };

  return { result, exitCode: missing.length > 0 ? 1 : 0 };
}

function emptyResult(): I18nMissingResult {
  return {
    missing: Object.freeze([]),
    unused: Object.freeze([]),
    dynamic: 0,
    scannedFiles: 0,
    locales: Object.freeze([]),
  };
}

/** Render the human-readable report. */
function renderHumanReadable(
  result: I18nMissingResult,
  options: { readonly showUnused: boolean },
): string[] {
  const lines: string[] = [];
  lines.push(
    `i18n: scanned ${result.scannedFiles} files across ${result.locales.length} locale(s)`,
  );

  if (result.missing.length === 0) {
    lines.push('Missing keys: none');
  } else {
    lines.push(`Missing keys (${result.missing.length}):`);
    for (const item of result.missing) {
      lines.push(`  ${item.key}`);
      for (const ref of item.refs) {
        lines.push(`    at ${ref.file}:${ref.line}`);
      }
    }
  }

  if (options.showUnused) {
    if (result.unused.length === 0) {
      lines.push('Unused keys: none');
    } else {
      lines.push(`Unused keys (${result.unused.length}):`);
      for (const key of result.unused) {
        lines.push(`  ${key}`);
      }
    }
  }

  if (result.dynamic > 0) {
    lines.push(`Dynamic call sites (unscanned): ${result.dynamic}`);
  }

  return lines;
}

/** Run `jsails i18n:missing` and print its result; resolves with the exit code. */
export async function runI18nMissingCommand(
  input: I18nMissingInput,
  deps: I18nMissingDeps,
): Promise<number> {
  try {
    const { result, exitCode } = await runI18nMissing(input, deps);
    for (const line of renderResult(result, {
      json: input.options.json === true,
      render: (value) => renderHumanReadable(value, { showUnused: input.options.unused === true }),
    })) {
      deps.stdout(line);
    }
    return exitCode;
  } catch (error) {
    await writeFailure(error, (line) => deps.stderr(line), {
      allow: isAppConfigError,
      fallback: 'i18n:missing failed',
      env: deps.env,
    });
    return 1;
  }
}

/** `jsails i18n:missing [--json] [--unused]`. */
export const i18nMissingCommand: CommandModule<typeof I18N_MISSING_OPTIONS, 'environment'> = {
  run: (context) =>
    runI18nMissingCommand(
      {
        configPath: context.values.config ?? DEFAULT_APP_CONFIG_PATH,
        options: { json: context.values.json === true, unused: context.values.unused === true },
      },
      { ...defaultDeps, env: context.env },
    ),
};
