/**
 * The unified source scan: one walk of the authoring tree that feeds every
 * generated artifact.
 *
 * Before this module, each generated artifact had its own discovery pass — the
 * autoload scan walked `app/ server/ shared/`, model resolution probed
 * `models/` per class, component resolution probed `app/components/` per tag.
 * Three walks over overlapping trees, each with its own extension set and
 * naming rules, is three places for a convention to drift. This scan walks the
 * tree **once**, parses each source module **once**, and returns every derived
 * fact the build step needs:
 *
 * - the autoload registry (symbols injectable by name),
 * - the extracted models (shape of each `ApplicationRecord` subclass),
 * - the server-component modules (each `components/*.tsx` export).
 *
 * The scan is **source-driven**: modules are parsed with `parseSync`, never
 * imported. A build scan must not execute application code — running a module's
 * top-level side effects at scan time turns a syntax-level discovery pass into a
 * runtime dependency, and the emitted artifacts feed `tsc` before any module is
 * ever evaluated.
 *
 * Model extraction diagnostics (an unsupported field type, an unresolvable
 * relation, an unparseable model) are collected on the result rather than
 * dropped: the field they concern is missing from the extracted model, so
 * {@link assertNoMetaErrors} refuses to generate a schema without it.
 *
 * Inert until {@link scanProjectMeta} is called.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DiagnosticBag } from '../compiler/diagnostics.js';
import type { CompileDiagnostic } from '../compiler/errors.js';
import { JsailsError } from '../errors/jsails-error.js';

import {
  CONVENTION_DIRS,
  SOURCE_EXTENSIONS,
  camelCase,
  isMultiFileComponentPart,
} from '../compiler/conventions.js';
import { walkSortedFiles } from '../compiler/sorted-file-walk.js';
import { extractModel, type ExtractedModel } from '../compiler/model-extract.js';
import { scanAutoload, type AutoloadRegistry } from '../compiler/project-symbols-scan.js';
import { compareStrings } from '../support/compare-strings.js';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/** A server-component module discovered under `components/`. */
export interface ComponentModule {
  /** The class/const name of the component export, e.g. `taskList`. */
  readonly exportName: string;
  /** Absolute source path. */
  readonly file: string;
  /** Posix-relative path from the project root. */
  readonly relative: string;
}

/** A diagnostic raised while scanning one source module. */
export interface ProjectMetaDiagnostic {
  /** Posix-relative path from the project root. */
  readonly file: string;
  readonly diagnostic: CompileDiagnostic;
}

/** The full result of one project scan. */
export interface ProjectMeta {
  readonly autoload: AutoloadRegistry;
  readonly models: readonly ExtractedModel[];
  readonly components: readonly ComponentModule[];
  /**
   * Diagnostics from model extraction, in file order. Optional so a
   * hand-built scan result stays valid; {@link scanProjectMeta} always sets it.
   */
  readonly diagnostics?: readonly ProjectMetaDiagnostic[];
}

/** Raised when a scan carries error diagnostics, so its artifacts would be incomplete. */
export class MetaScanError extends JsailsError {
  readonly code = 'invalid_model';

  constructor(
    message: string,
    /** Every error diagnostic, positioned; messages carry names, never source text. */
    readonly diagnostics: readonly ProjectMetaDiagnostic[],
  ) {
    super(message);
  }
}

/** Render one diagnostic as `file:line:column: severity[code]: message` (no frame). */
export function formatMetaDiagnostic({ file, diagnostic }: ProjectMetaDiagnostic): string {
  const { line, column } = diagnostic.range.start;
  return `${file}:${line}:${column}: ${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`;
}

/**
 * Throw a {@link MetaScanError} listing every error diagnostic of `meta`. A
 * model field with an error was dropped from the extracted model, so writing the
 * registry would hand `db:push`/`db:diff` a schema silently missing a column.
 */
export function assertNoMetaErrors(meta: ProjectMeta): void {
  const errors = (meta.diagnostics ?? []).filter((entry) => entry.diagnostic.severity === 'error');
  if (errors.length === 0) {
    return;
  }
  throw new MetaScanError(
    `${errors.length} model diagnostic(s); fix them and rerun build:meta\n${errors.map(formatMetaDiagnostic).join('\n')}`,
    errors,
  );
}

/** Options for {@link scanProjectMeta}. */
export interface ScanProjectMetaOptions {
  /** File extensions accepted as source modules. Defaults to the source set. */
  readonly extensions?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Walk the authoring tree once and return every derived fact the build step
 * needs. Deterministic: models and components are sorted by their relative
 * path, so two scans of the same tree produce byte-identical artifacts.
 */
export async function scanProjectMeta(
  rootDir: string,
  options: ScanProjectMetaOptions = {},
): Promise<ProjectMeta> {
  const extensions = options.extensions ?? SOURCE_EXTENSIONS;

  const autoload = await scanAutoload(rootDir, { extensions });
  const diagnostics: ProjectMetaDiagnostic[] = [];
  const models = scanModels(rootDir, extensions, diagnostics);
  const components = scanComponents(rootDir, extensions);

  return Object.freeze({
    autoload,
    models: Object.freeze(models),
    components: Object.freeze(components),
    diagnostics: Object.freeze(diagnostics),
  });
}

/* ------------------------------------------------------------------ */
/*  Models                                                             */
/* ------------------------------------------------------------------ */

/**
 * Extract every model under `models/`. A module that declares no
 * `ApplicationRecord` subclass is skipped silently — `models/` may hold
 * non-model helpers. Every extraction diagnostic (positioned in its file) is
 * appended to `diagnostics`.
 */
function scanModels(
  rootDir: string,
  extensions: ReadonlySet<string>,
  diagnostics: ProjectMetaDiagnostic[],
): ExtractedModel[] {
  const modelsDir = join(rootDir, CONVENTION_DIRS.models);
  const models: ExtractedModel[] = [];

  for (const relative of walkSortedFiles(modelsDir, { extensions })) {
    if (relative.endsWith('.d.ts')) {
      continue;
    }
    const absolute = join(modelsDir, relative);
    const source = readFileSync(absolute, 'utf8');
    const bag = new DiagnosticBag({ source, frames: false });
    const model = extractModel(source, absolute, (code, message, subject, start, end) => {
      bag.errorAt(code, message, start, end, undefined, subject);
    });
    const file = `${CONVENTION_DIRS.models}/${relative}`;
    for (const diagnostic of bag.toList()) {
      diagnostics.push(Object.freeze({ file, diagnostic }));
    }
    if (model !== undefined) {
      models.push(model);
    }
  }

  models.sort((a, b) => compareStrings(a.className, b.className));
  return models;
}

/* ------------------------------------------------------------------ */
/*  Components                                                         */
/* ------------------------------------------------------------------ */

/**
 * Discover server-component modules under `components/`. A component module is
 * a `.tsx`/`.ts` file whose default or named export is the component; the
 * convention is that the file's kebab name maps to a camelCase export
 * (`task-list.tsx` → `taskList`). The scan records the module and its
 * conventional export name; the generated registry imports that name.
 */
function scanComponents(rootDir: string, extensions: ReadonlySet<string>): ComponentModule[] {
  const componentsDir = join(rootDir, CONVENTION_DIRS.serverComponents);
  const components: ComponentModule[] = [];

  for (const relative of walkSortedFiles(componentsDir, { extensions })) {
    if (relative.endsWith('.d.ts')) {
      continue;
    }
    // A nested directory is a multi-file component (MFC): its entry is the
    // `.tsx` file named after the directory, while the sibling `.model.ts`,
    // `.style.ts`, and `.server.ts` files are parts, not components. Scanning
    // every nested module would emit invalid imports such as
    // `import { card/card.model } ...`.
    if (isMultiFileComponentPart(`${CONVENTION_DIRS.serverComponents}/${relative}`)) {
      continue;
    }
    const absolute = join(componentsDir, relative);
    components.push(
      Object.freeze({
        exportName: componentExportName(relative),
        file: absolute,
        relative: `${CONVENTION_DIRS.serverComponents}/${relative}`,
      }),
    );
  }

  components.sort((a, b) => compareStrings(a.relative, b.relative));
  return components;
}

/**
 * The conventional export name for a component module: the camelCase of its
 * file base name (`task-list.tsx` → `taskList`). The generated registry imports
 * this name; a module that exports its component under a different name is a
 * build diagnostic, not a silent miss.
 */
function componentExportName(relative: string): string {
  const fileName = relative.split('/').pop() ?? relative;
  const base = fileName.replace(/\.(tsx|ts|mtsx|mts|jsx|js)$/, '');
  return camelCase(base);
}
