/**
 * Scoped auto-imports: inject a small, directory-scoped set of real imports
 * into modules that use the identifiers without importing them.
 *
 * This is deliberately not the framework-global projection. A global is
 * process-wide; a scoped auto-import is per file:
 *
 * - `ui/**` and `client/**` see Preact hooks/signals.
 * - Nothing outside those directories gets those names injected.
 *
 * The browser path is a Vite transform; the server path is a post-`tsc` pass
 * over emitted `.js` files. Both share this pure injector, so they cannot drift.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { relativePathInside } from '../support/path-containment.server.js';

import { RolldownMagicString } from 'rolldown';
import { parseSync } from 'rolldown/utils';

import { collectUnmatchedIdentifiers } from './scope-walker.js';
import { walkSortedFiles } from './sorted-file-walk.js';
import { JsailsError } from '../errors/jsails-error.js';

/** One directory-scoped auto-import rule. */
export interface ScopedAutoImportRule {
  /** Root-relative directory prefixes, without a trailing slash (e.g. `ui`). */
  readonly dirs: readonly string[];
  /** Bare identifier -> module specifier. */
  readonly imports: Readonly<Record<string, string>>;
}

/** One injected import. */
export interface ScopedAutoImportInjection {
  readonly name: string;
  readonly from: string;
}

/** Stable machine codes carried by {@link ScopedAutoImportError}. */
export type ScopedAutoImportErrorCode = 'unparseable' | 'out_of_scope';

/** A scoped auto-import failure. */
export class ScopedAutoImportError extends JsailsError {
  constructor(
    readonly code: ScopedAutoImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const PREACT_HOOKS = {
  useCallback: 'preact/hooks',
  useContext: 'preact/hooks',
  useDebugValue: 'preact/hooks',
  useEffect: 'preact/hooks',
  useErrorBoundary: 'preact/hooks',
  useId: 'preact/hooks',
  useImperativeHandle: 'preact/hooks',
  useLayoutEffect: 'preact/hooks',
  useMemo: 'preact/hooks',
  useReducer: 'preact/hooks',
  useRef: 'preact/hooks',
  useState: 'preact/hooks',
} as const;

const SIGNAL_HOOKS = {
  useComputed: '@preact/signals',
  useModel: '@preact/signals',
  useSignal: '@preact/signals',
  useSignalEffect: '@preact/signals',
} as const;

/** The built-in scoped surface: UI modules only. */
export const DEFAULT_SCOPED_AUTO_IMPORTS: readonly ScopedAutoImportRule[] = Object.freeze([
  Object.freeze({
    dirs: Object.freeze(['ui', 'client']),
    imports: Object.freeze({ ...PREACT_HOOKS, ...SIGNAL_HOOKS }),
  }),
]);

/** Relative POSIX path from `rootDir`, or `undefined` when outside the root. */
function relativePath(rootDir: string, fileName: string): string | undefined {
  const rel = relativePathInside(rootDir, fileName);
  if (rel === undefined || rel === '') {
    return undefined;
  }
  return sep === '\\' ? rel.replace(/\\/g, '/') : rel;
}

/** True when `relativeFile` is under one of `rule.dirs`. */
function inScope(relativeFile: string, rule: ScopedAutoImportRule): boolean {
  return rule.dirs.some((dir) => relativeFile === dir || relativeFile.startsWith(`${dir}/`));
}

/** The first rule covering the file, if any. */
function ruleFor(
  relativeFile: string,
  rules: readonly ScopedAutoImportRule[],
): ScopedAutoImportRule | undefined {
  return rules.find((rule) => inScope(relativeFile, rule));
}

/** Parse a module and return its unmatched identifiers, value-free on failure. */
function unmatchedIdentifiers(fileName: string, code: string): readonly string[] {
  try {
    const parsed = parseSync(fileName, code, { sourceType: 'module' });
    if (parsed.errors.some((error) => error.severity === 'Error')) {
      throw new ScopedAutoImportError('unparseable', `could not parse ${fileName}`);
    }
    return [...collectUnmatchedIdentifiers(parsed.program)];
  } catch (error) {
    if (error instanceof ScopedAutoImportError) throw error;
    throw new ScopedAutoImportError('unparseable', `could not parse ${fileName}`);
  }
}

/** Render one import declaration, or an empty string when there is nothing to inject. */
function renderImports(entries: readonly ScopedAutoImportInjection[]): string {
  if (entries.length === 0) return '';
  const byModule = new Map<string, string[]>();
  for (const entry of entries) {
    const names = byModule.get(entry.from) ?? [];
    names.push(entry.name);
    byModule.set(entry.from, names);
  }
  return [...byModule.keys()]
    .sort()
    .map((from) => {
      const names = [...(byModule.get(from) ?? [])].sort();
      return `import { ${names.join(', ')} } from '${from}';`;
    })
    .join('\n');
}

/** Options for {@link injectScopedAutoImports}. */
export interface InjectScopedAutoImportsOptions {
  /** Absolute path of the module being transformed. */
  readonly fileName: string;
  /** Project root; defaults to `process.cwd()`. */
  readonly rootDir?: string;
  /** Rules to apply; defaults to {@link DEFAULT_SCOPED_AUTO_IMPORTS}. */
  readonly rules?: readonly ScopedAutoImportRule[];
  /**
   * Where to insert the import declarations. `prepend` (default) is for source
   * transforms; `append` preserves emitted source-map line numbers for a
   * post-`tsc` pass.
   */
  readonly placement?: 'prepend' | 'append';
}

/**
 * Inject the scoped imports a module needs. Returns `null` when the file is out
 * of scope or already imports every name it uses.
 */
export function injectScopedAutoImports(
  code: string,
  options: InjectScopedAutoImportsOptions,
): { readonly code: string; readonly injected: readonly ScopedAutoImportInjection[] } | null {
  const rootDir = options.rootDir ?? process.cwd();
  const rel = relativePath(rootDir, options.fileName);
  if (rel === undefined) return null;

  const rules = options.rules ?? DEFAULT_SCOPED_AUTO_IMPORTS;
  const rule = ruleFor(rel, rules);
  if (rule === undefined) return null;

  const unmatched = unmatchedIdentifiers(options.fileName, code);
  const injected: ScopedAutoImportInjection[] = [];
  for (const name of unmatched) {
    const from = rule.imports[name];
    if (from !== undefined) injected.push({ name, from });
  }
  if (injected.length === 0) return null;

  const text = renderImports(injected);
  const magic = new RolldownMagicString(code);
  if (options.placement === 'append') {
    const marker = code.lastIndexOf('\n//# sourceMappingURL=');
    if (marker >= 0) {
      magic.appendLeft(marker, `\n${text}`);
    } else {
      magic.append(`\n${text}`);
    }
  } else {
    magic.prepend(`${text}\n`);
  }
  return { code: magic.toString(), injected };
}

/** Throw when a module outside every scope uses a scoped identifier. */
export function assertNoOutOfScopeAutoImports(
  code: string,
  options: {
    readonly fileName: string;
    readonly rootDir?: string;
    readonly rules?: readonly ScopedAutoImportRule[];
  },
): void {
  const rootDir = options.rootDir ?? process.cwd();
  const rel = relativePath(rootDir, options.fileName);
  if (rel === undefined) return;
  const rules = options.rules ?? DEFAULT_SCOPED_AUTO_IMPORTS;
  if (ruleFor(rel, rules) !== undefined) return;

  const unmatched = new Set(unmatchedIdentifiers(options.fileName, code));
  for (const rule of rules) {
    for (const name of Object.keys(rule.imports)) {
      if (unmatched.has(name)) {
        throw new ScopedAutoImportError(
          'out_of_scope',
          `${rel} uses ${name} outside the auto-import scope`,
        );
      }
    }
  }
}

/** Emit the ambient declarations for the scoped auto-import surface. */
export function generateScopedAutoImportsDts(
  rules: readonly ScopedAutoImportRule[] = DEFAULT_SCOPED_AUTO_IMPORTS,
): string {
  const declarations = new Map<string, string>();
  for (const rule of rules) {
    for (const [name, from] of Object.entries(rule.imports)) {
      declarations.set(name, from);
    }
  }
  const lines = [...declarations.keys()]
    .sort()
    .map((name) => `  const ${name}: typeof import('${declarations.get(name)}').${name};`);
  return `// AUTO-GENERATED by jsails build:meta. Do not edit.\n\nexport {};\n\ndeclare global {\n${lines.join('\n')}\n}\n`;
}

const JAVASCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.js']);
const SKIPPED_OUTPUT_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules']);

/** Absolute paths of every `.js` file under `rootDir`, a directory that must exist. */
function walkJavaScript(rootDir: string): string[] {
  if (!statSync(rootDir).isDirectory()) {
    return [];
  }
  return walkSortedFiles(rootDir, {
    extensions: JAVASCRIPT_EXTENSIONS,
    skipDotEntries: true,
    skipDirectories: SKIPPED_OUTPUT_DIRECTORIES,
  }).map((relativePath) => join(rootDir, relativePath));
}

/**
 * Apply scoped auto-imports to a compiled output tree. Server modules under the
 * scope get their imports appended; a scoped name used outside the scope is a
 * hard error, because it would be a runtime `ReferenceError`.
 */
export function injectScopedAutoImportsInDirectory(
  rootDir: string,
  options: { readonly rules?: readonly ScopedAutoImportRule[] } = {},
): { readonly files: number; readonly injected: number } {
  const rules = options.rules ?? DEFAULT_SCOPED_AUTO_IMPORTS;
  let changed = 0;
  let injected = 0;
  for (const file of walkJavaScript(rootDir)) {
    const code = readFileSync(file, 'utf8');
    const result = injectScopedAutoImports(code, {
      fileName: file,
      rootDir,
      rules,
      placement: 'append',
    });
    if (result !== null) {
      writeFileSync(file, result.code, 'utf8');
      changed += 1;
      injected += result.injected.length;
      continue;
    }
    assertNoOutOfScopeAutoImports(code, { fileName: file, rootDir, rules });
  }
  return { files: changed, injected };
}
