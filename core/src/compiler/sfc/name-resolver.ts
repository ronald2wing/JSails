/**
 * Name resolution for `.jsails` templates and `<script setup>`: the step of
 * the scope rule (sfc-plan §2.5) after the file's own bindings and the kind's
 * names, and before the JS built-ins.
 *
 * A {@link NameResolver} answers, for a name the file leaves free, the module
 * that exports it. The compiler imports it under that name, so a resolved
 * name is an ordinary identifier in the generated module. A resolved module
 * may be another `.jsails` file (`ui/tag-badge.jsails`, default export). The
 * resolver is passed in, so the lowering stays pure: today a fixed table
 * ({@link nameTable}); the project catalog (KRN-15) implements the same
 * interface.
 *
 * The built-in list is fixed and holds no `lib.dom` name, so a prop called
 * `name` or `status` never binds to `window.name`; `globalThis.x` is the
 * explicit escape.
 */

/** Where a resolved name is imported from. */
export type ResolvedSource =
  /** A package specifier, imported as written (`@jsails/content`). */
  | { readonly package: string }
  /**
   * A project file, as a normalized posix path relative to the project root
   * (`ui/tag-badge.jsails`, `shared/format-date.ts`).
   */
  | { readonly path: string };

/** A free name resolved to a module export. */
export interface ResolvedName {
  readonly source: ResolvedSource;
  /** The export to import: a name, or `default`. */
  readonly export: string;
}

/** Resolves a name a `.jsails` file leaves free, or returns `undefined`. */
export interface NameResolver {
  resolve(name: string): ResolvedName | undefined;
}

/** A resolver that resolves nothing. */
export const EMPTY_RESOLVER: NameResolver = Object.freeze({ resolve: () => undefined });

/** A resolver over a fixed table of names. */
export function nameTable(entries: Readonly<Record<string, ResolvedName>>): NameResolver {
  const table = new Map(Object.entries(entries));
  return Object.freeze({ resolve: (name: string) => table.get(name) });
}

/**
 * The JS built-ins a template or setup may name without a binding (step 6
 * of the scope rule). Anything else free and unresolved is a prop.
 */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'Array',
  'BigInt',
  'Boolean',
  'Date',
  'Error',
  'Infinity',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'TypeError',
  'URL',
  'URLSearchParams',
  'decodeURIComponent',
  'encodeURIComponent',
  'globalThis',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'undefined',
]);

/**
 * The import specifier of `source` from the file `fromFile` (both project
 * paths): a package as written; a project file relative to the importer,
 * with a TypeScript extension written `.js` as NodeNext resolves it, and a
 * `.jsails` file kept as it is (its shadow's bridge answers it, and the
 * bundler compiles it).
 */
export function importSpecifier(fromFile: string, source: ResolvedSource): string {
  if ('package' in source) return source.package;
  const from = fromFile.split('/').slice(0, -1);
  const to = source.path.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) {
    shared += 1;
  }
  const up = from.length - shared;
  const relative = [...Array<string>(up).fill('..'), ...to.slice(shared)].join('/');
  const specifier = up === 0 ? `./${relative}` : relative;
  return specifier.replace(/\.(?:ts|tsx|mts|cts)$/, (extension) =>
    extension === '.mts' ? '.mjs' : extension === '.cts' ? '.cjs' : '.js',
  );
}
