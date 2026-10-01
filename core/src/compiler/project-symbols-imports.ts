/**
 * Build-time import injection: scan source code for free identifiers, match
 * them against an {@link AutoloadSymbolIndex}, and prepend, append, or merge the
 * necessary {@code import} declarations.
 *
 * Pure — no I/O, no filesystem access at call time. The caller supplies the
 * source code, the symbols index, and the importing file's name + context, and
 * may supply the already-parsed program so one parse serves several passes.
 */

import { dirname, relative } from 'node:path';

import { RolldownMagicString } from 'rolldown';
import { parseSync, type ESTree } from 'rolldown/utils';

import type {
  AutoloadContext,
  AutoloadSymbol,
  AutoloadSymbolIndex,
} from './project-symbols-scan.js';
import { collectUnmatchedIdentifiers } from './scope-walker.js';
import { JsailsError } from '../errors/jsails-error.js';
import { toPosixId } from '../support/project-paths.server.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A single injected import: what name, from which module. */
export interface InjectedImport {
  readonly symbol: string;
  readonly from: string;
}

/**
 * A source map for an injected module. `sourcesContent` is omitted: the bundler
 * already holds the original text.
 */
export interface AutoloadInjectionSourceMap {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}

/** Outcome of {@link injectAutoloadImports}. */
export interface AutoloadInjectionResult {
  /** The rewritten source code. */
  readonly code: string;
  /** Every import that was injected (not merged). */
  readonly injected: readonly InjectedImport[];
  /** A map from `code` back to the input. */
  readonly map: AutoloadInjectionSourceMap;
}

/* ------------------------------------------------------------------ */
/*  Error                                                              */
/* ------------------------------------------------------------------ */

/** Stable machine codes carried by {@link AutoloadInjectionError}. */
export type AutoloadInjectionErrorCode = 'unparseable';

/** Raised when the source cannot be parsed. */
export class AutoloadInjectionError extends JsailsError {
  constructor(
    readonly code: AutoloadInjectionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/*  Injection                                                         */
/* ------------------------------------------------------------------ */

/** Options for {@link injectAutoloadImports}. */
export interface InjectAutoloadImportsOptions {
  /** The importing file's resolved (absolute) path — used for relative-specifier computation. */
  readonly fileName: string;
  /** The symbol index, pre-filtered to the injection context. */
  readonly symbols: AutoloadSymbolIndex;
  /**
   * The injection context. An `app` module sees `app` symbols; a `server`
   * module sees `server` symbols and, where no server symbol has the name,
   * `app` symbols.
   */
  readonly context: AutoloadContext;
  /**
   * Where new import declarations go. `prepend` (the default) puts each on its
   * own line at the top, shifting every line below; `append` adds them after the
   * last line, so every original line keeps its number (imports hoist, so the
   * semantics are identical) and a `'use server'` prologue stays first.
   */
  readonly placement?: 'prepend' | 'append';
  /** `code` already parsed by the caller, to skip a second parse. */
  readonly program?: ESTree.Program;
  /** The free identifiers of `program`, when the caller already computed them. */
  readonly unmatched?: ReadonlySet<string>;
}

/** Parse `code`, refusing a hard parse error value-free. */
export function parseForInjection(fileName: string, code: string): ESTree.Program {
  try {
    const parseResult = parseSync(fileName, code, { sourceType: 'module' });
    // `parseSync` is error-tolerant: it returns a partial AST plus an `errors`
    // array rather than throwing. A hard parse error must be refused value-free
    // — the error's `codeframe` embeds source text, so it is never surfaced.
    if (parseResult.errors.some((error) => error.severity === 'Error')) {
      throw new AutoloadInjectionError('unparseable', `could not parse ${fileName}`);
    }
    return parseResult.program;
  } catch (error) {
    if (error instanceof AutoloadInjectionError) {
      throw error;
    }
    throw new AutoloadInjectionError('unparseable', `could not parse ${fileName}`);
  }
}

/** The symbol an identifier resolves to in `context`, if any. */
function symbolFor(
  contexts: ReadonlyMap<AutoloadContext, AutoloadSymbol> | undefined,
  context: AutoloadContext,
): AutoloadSymbol | undefined {
  if (contexts === undefined) {
    return undefined;
  }
  return context === 'server'
    ? (contexts.get('server') ?? contexts.get('app'))
    : contexts.get('app');
}

/**
 * Parse {@code code}, find unmatched identifiers, match them against
 * {@code options.symbols}, and prepend (or merge into existing) import
 * declarations.
 *
 * Returns {@code null} when no injections are needed (idempotence guard). */
export function injectAutoloadImports(
  code: string,
  options: InjectAutoloadImportsOptions,
): AutoloadInjectionResult | null {
  const program = options.program ?? parseForInjection(options.fileName, code);
  const unmatched = options.unmatched ?? collectUnmatchedIdentifiers(program);

  // Filter to names present in the index with the target context.
  // Deterministic ordering: sort by specifier, then by name.
  const matches: { name: string; symbol: AutoloadSymbol }[] = [];
  for (const name of unmatched) {
    const symbol = symbolFor(options.symbols.get(name), options.context);
    if (symbol !== undefined) {
      matches.push({ name, symbol });
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // Group by resolved relative specifier.
  const importingDir = dirname(options.fileName);

  const bySpec = new Map<string, { name: string; symbol: AutoloadSymbol }[]>();
  for (const m of matches) {
    const spec = resolveImportSpecifier(importingDir, m.symbol.file);
    let group = bySpec.get(spec);
    if (group === undefined) {
      group = [];
      bySpec.set(spec, group);
    }
    group.push(m);
  }

  // Deterministic iteration: sort specifiers.
  const sortedSpecs = Array.from(bySpec.keys()).sort();

  // Find existing ImportDeclarations to merge with.
  const existingImports = findExistingImports(program as unknown as EstreeNode, sortedSpecs);

  const magic = new RolldownMagicString(code);
  const injected: InjectedImport[] = [];

  for (const spec of sortedSpecs) {
    const group = bySpec.get(spec)!;
    group.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const existing = existingImports.get(spec);

    if (existing !== undefined) {
      // Merge: append missing specifiers to the existing ImportDeclaration.
      const existingNames = new Set(existing.names);
      const newNames = group.filter((m) => !existingNames.has(m.name)).map((m) => m.name);

      if (newNames.length === 0) continue;

      const separator = existing.names.length > 0 ? ', ' : '';
      const newText = separator + newNames.join(', ');

      magic.prependLeft(existing.insertPos, newText);

      for (const name of newNames) {
        injected.push({ symbol: name, from: spec });
      }
    } else {
      const names = group.map((m) => m.name).join(', ');
      if (options.placement === 'append') {
        magic.append(`\nimport { ${names} } from '${spec}';`);
      } else {
        magic.prepend(`import { ${names} } from '${spec}';\n`);
      }

      for (const m of group) {
        injected.push({ symbol: m.name, from: spec });
      }
    }
  }

  if (injected.length === 0) {
    return null;
  }

  const generated = magic.generateMap({ hires: true, source: options.fileName });
  // Not frozen: the bundler normalizes a transform map in place (Rolldown adds
  // `sourcesContent`).
  const map: AutoloadInjectionSourceMap = {
    version: 3,
    sources: [...generated.sources],
    names: [...generated.names],
    mappings: generated.mappings,
  };
  return { code: magic.toString(), injected, map };
}

/* ------------------------------------------------------------------ */
/*  Estree-shaped import scanning                                     */
/* ------------------------------------------------------------------ */

type EstreeNode = {
  type: string;
  start: number;
  end: number;
  specifiers?: EstreeNode[];
  local?: EstreeNode;
  imported?: EstreeNode;
  source?: EstreeNode;
  value?: string;
  name?: string;
  body?: EstreeNode[];
};

interface ExistingImport {
  names: string[];
  /** Byte offset just after the last named specifier — where `, name` is inserted. */
  insertPos: number;
}

function findExistingImports(program: EstreeNode, targets: string[]): Map<string, ExistingImport> {
  const targetSet = new Set(targets);
  const result = new Map<string, ExistingImport>();

  const body = Array.isArray(program.body) ? program.body : [];
  for (const stmt of body) {
    if (stmt.type !== 'ImportDeclaration') continue;

    const source = stmt.source as EstreeNode;
    if (source === undefined) continue;
    const specifier = typeof source.value === 'string' ? source.value : '';
    if (!targetSet.has(specifier)) continue;

    const names: string[] = [];
    let insertPos = source.start;
    const specs = Array.isArray(stmt.specifiers) ? stmt.specifiers : [];
    for (const spec of specs) {
      if (spec.type === 'ImportSpecifier') {
        const local = spec.local;
        if (local !== undefined && typeof local.name === 'string') {
          names.push(local.name);
        }
      }
      // Track the end of the last specifier so a merge inserts `, name` before
      // the closing brace rather than before the source string.
      if (typeof spec.end === 'number') {
        insertPos = spec.end;
      }
    }

    result.set(specifier, { names, insertPos });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Relative specifier resolution                                      */
/* ------------------------------------------------------------------ */

/**
 * Resolve an absolute source file path to a posix relative specifier suitable
 * for an import statement. The result is always {@code ./}-prefixed.
 *
 * The repo is ESM-only with explicit `.js` specifiers, so a TypeScript source
 * extension is rewritten to its compiled counterpart: `.ts`/`.tsx` → `.js`,
 * `.mts`/`.mtsx` → `.mjs`. A non-TS extension is preserved.
 */
function resolveImportSpecifier(fromDir: string, toAbsolute: string): string {
  let rel = toPosixId(relative(fromDir, toAbsolute));

  rel = rel.replace(/\.(tsx|ts)$/, '.js').replace(/\.(mtsx|mts)$/, '.mjs');

  if (!rel.startsWith('.')) {
    rel = './' + rel;
  }

  return rel;
}
