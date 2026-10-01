/**
 * The framework-symbol global machinery.
 *
 * A JSails author writes `class Post extends ApplicationRecord` or
 * `export const job = defineJob(...)` with no import. TypeScript type-checks
 * those bare names against the generated `.jsails/framework-symbols.d.ts`, and the
 * emitted JavaScript resolves them against `globalThis` — which the CLI installs
 * before any app module evaluates, and the client bundle installs before island
 * hydration.
 *
 * This module holds the **mechanism**: the data types, the declaration model,
 * the collision derivation, and the namespace-key derivation — the parts that
 * are hand-written because they are stable and small. The **data** — which
 * symbols exist, on which subpath, for which runtime — is derived by the
 * compiler at `build:meta` time from the framework's own barrels and emitted as
 * `.jsails/framework-symbols.js` (the runtime half) and
 * `.jsails/framework-symbols.d.ts` (the type half). Nothing is checked in, so
 * nothing can drift.
 *
 * Each entry names the **public subpath** the symbol is imported from, so the
 * generated declaration uses the same specifier a hand-written import would.
 * The subpath must exist in `package.json` `exports`; the scan asserts that.
 *
 * This module is a leaf: it imports nothing, so it is safe to reach from any
 * layer — including the browser bundle.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * Which runtime(s) a subpath may be projected into. `server` reaches a `node:*`
 * builtin or a server-only dependency in its eager import graph; `both` is
 * browser-safe and also usable server-side.
 */
export type FrameworkSymbolTarget = 'server' | 'both';

/** One framework symbol exposed as a global. */
export interface FrameworkSymbol {
  /** The bare identifier the author writes. */
  readonly name: string;
  /** The public subpath it is imported from (e.g. `jsails/models`). */
  readonly specifier: string;
  /** The runtime(s) this subpath may be projected into. */
  readonly target: FrameworkSymbolTarget;
}

/* ------------------------------------------------------------------ */
/*  Declaration model                                                  */
/* ------------------------------------------------------------------ */

/**
 * Which public subpaths project their exports onto `globalThis`.
 *
 * **The default is `none`.** A global is never populated by accident: a
 * subpath's symbols become bare names only when a participant — the framework
 * or a plugin — explicitly opts them in. The framework opts in a curated
 * `selected` allowlist through the same mechanism a plugin uses.
 */
export type SymbolDeclaration =
  | { readonly mode: 'all' }
  | { readonly mode: 'selected'; readonly specifiers: readonly string[] }
  | { readonly mode: 'none' };

/**
 * A plugin's autoload declaration: which of its own subpaths, and which of the
 * plugins it installs, become bare `globalThis` names.
 *
 * Two axes, one field:
 * - `own` — the plugin's own surface (`all` / `selected` subpaths / `none`).
 * - `plugins` — the ids of plugins this plugin **exposes** by delegation
 *   (running that plugin's own `autoload`), when this plugin is their direct
 *   installer. A plugin it installs but does not list here is used without
 *   being exposed.
 *
 * **Default is `none`.** Nothing becomes bare without an explicit opt-in.
 *
 * Note this is the plugin-level shape and is distinct from {@link SymbolDeclaration},
 * which describes a single participant's own subpath surface (the framework uses
 * the latter; a plugin authors this richer two-axis form).
 */
export type AutoloadDeclaration =
  | { readonly mode: 'none' }
  | { readonly mode: 'all' }
  | {
      readonly mode: 'selected';
      readonly plugins?: readonly string[];
      readonly specifiers?: readonly string[];
    };

/** The declaration applied when a participant declares nothing: project nothing. */
export const NONE_SYMBOL_DECLARATION: SymbolDeclaration = Object.freeze({ mode: 'none' });

/**
 * The framework's curated autoload surface: the authoring subpaths whose exports
 * an app writes bare. Infrastructure subpaths (CLI, build, symbols, dev tooling)
 * are deliberately absent so their names never shadow application identifiers.
 * A test pins every entry to a real package export.
 */
export const FRAMEWORK_AUTOLOAD_DECLARATION: SymbolDeclaration = Object.freeze({
  mode: 'selected',
  specifiers: Object.freeze([
    'jsails/api',
    'jsails/cache',
    'jsails/data',
    'jsails/database',
    'jsails/diagnostics',
    'jsails/encryption',
    'jsails/extensions',
    'jsails/facades',
    'jsails/filesystem',
    'jsails/http',
    'jsails/i18n',
    'jsails/jobs',
    'jsails/models',
    'jsails/pages',
    'jsails/render-to-string',
    'jsails/seo',
    'jsails/services',
    'jsails/server-components',
    'jsails/signals',
    'jsails/support',
    'jsails/support/server',
    'jsails/validation',
    'jsails/zod',
  ]),
});

/**
 * Normalize a possibly-absent declaration to a concrete one. Absent → `none`.
 * A `selected` declaration with an empty list is preserved (it projects
 * nothing, like `none`, but keeps its intent legible).
 */
export function resolveSymbolDeclaration(
  declaration: SymbolDeclaration | undefined,
): SymbolDeclaration {
  return declaration ?? NONE_SYMBOL_DECLARATION;
}

/**
 * Filter a symbol table by a declaration. `all` returns the table unchanged;
 * `none` returns empty; `selected` keeps only entries whose specifier is named.
 * Pure and order-preserving.
 */
export function applySymbolDeclaration(
  globals: readonly FrameworkSymbol[],
  declaration: SymbolDeclaration,
): readonly FrameworkSymbol[] {
  switch (declaration.mode) {
    case 'all':
      return globals;
    case 'none':
      return [];
    case 'selected': {
      const allowed = new Set(declaration.specifiers);
      return globals.filter((entry) => allowed.has(entry.specifier));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Collision derivation                                               */
/* ------------------------------------------------------------------ */

/**
 * Group entries by `name` and return only groups whose bare name is shared by
 * more than one entry. Empty for the current curated table, which is kept
 * collision-free; the check guards against a new export shadowing an existing name.
 *
 * One derivation shared by the runtime installer
 * ({@link installFrameworkSymbols}) and the ambient declaration emitter
 * (`generateFrameworkSymbolsDts`), so the two can never drift.
 */
export function computeFrameworkSymbolCollisionGroups(
  globals: readonly FrameworkSymbol[],
): Map<string, readonly FrameworkSymbol[]> {
  const byName = new Map<string, FrameworkSymbol[]>();
  for (const entry of globals) {
    const list = byName.get(entry.name);
    if (list) {
      list.push(entry);
    } else {
      byName.set(entry.name, [entry]);
    }
  }
  const collisions = new Map<string, readonly FrameworkSymbol[]>();
  for (const [name, entries] of byName) {
    if (entries.length > 1) {
      collisions.set(name, entries);
    }
  }
  return collisions;
}

/**
 * Derive a deterministic, unique namespace key from a specifier's path segments.
 *
 * Rule: start with the **last** `/`-delimited segment (`jsails/content` →
 * `content`). If another specifier already claimed that key, prepend the next
 * segment with `_`. A key collision from the **same** specifier is allowed —
 * only a **different** specifier forces disambiguation. When all segments are
 * exhausted and the key still collides with a different specifier, the fallback
 * is the full specifier with non-alphanumeric characters replaced by `_`.
 *
 * One derivation shared by the runtime installer
 * ({@link installFrameworkSymbols}) and the ambient declaration emitter
 * (`generateFrameworkSymbolsDts`), so the two can never drift.
 */
export function deriveFrameworkSymbolNamespaceKeys(
  specifiers: Iterable<string>,
): ReadonlyMap<string, string> {
  const keyToSpecifier = new Map<string, string>();

  for (const specifier of specifiers) {
    const segments = specifier.split('/');
    let resolvedKey: string | undefined;

    for (let depth = 1; depth <= segments.length; depth++) {
      const candidate = segments.slice(-depth).join('_');
      const owner = keyToSpecifier.get(candidate);
      if (owner === undefined || owner === specifier) {
        keyToSpecifier.set(candidate, specifier);
        resolvedKey = candidate;
        break;
      }
      // candidate is taken by a different specifier; try deeper
    }

    // Fallback: all segments exhausted and still colliding.
    if (resolvedKey === undefined) {
      const fallback = specifier.replace(/[^a-zA-Z0-9]/g, '_');
      keyToSpecifier.set(fallback, specifier);
      resolvedKey = fallback;
    }
  }

  // Invert: specifier → namespace key.
  const result = new Map<string, string>();
  for (const [key, spec] of keyToSpecifier) {
    result.set(spec, key);
  }
  return result;
}
