/**
 * The scope pass of the kind lowerings (sfc-plan §2.5 with docs/design/sfc.md
 * §9 correction 3): which names a template and `<script setup>` leave free,
 * and what each one becomes.
 *
 * It runs over the generated module itself, parsed by oxc, with the shared
 * scope walker (`../scope-walker.ts`), so the pass sees exactly the scopes
 * TypeScript will check: `js-for` aliases and slot props are arrow
 * parameters, setup bindings are locals of the render function, and
 * `<script>` bindings and imports are module bindings. The lowering names the
 * generated ranges of its render functions ({@link ScopeRegion}: a function
 * kind's one function, a live component's `render` and `staticFallback`). A
 * name none of those declares, used inside a region, is resolved in order:
 *
 * 1. a kind name of the region: `context` in a page-tree file; a live
 *    component's render tools (`errors`, `values`, `context`) and derived
 *    properties; `context` in a static form;
 * 2. a name the {@link NameResolver} knows, imported under that name;
 * 3. a JS built-in from the fixed list, left as it is;
 * 4. otherwise a prop (a live component's state field): the lowering
 *    declares `const name = __props.name;` at the top of the function, the
 *    property name an Alias of the name's first use, so a typo is TS2339
 *    there and narrowing reaches closures. A static form has no props, so
 *    there the name is `sfc.static_unbound`.
 *
 * A component tag (`<Card>`) resolves through step 2 only: an unknown tag is
 * `sfc.unresolved_component`, never a prop. A tag that resolves to a live
 * component is imported and reported in {@link ScopeResult.liveTags}, for the
 * lowering to mount (`live-mounts.ts` checks where it may), and one that
 * resolves to an island in {@link ScopeResult.islandTags}, for the lowering
 * to mount as an island or refuse by its kind. A name `<script>`
 * leaves free is at module scope, where no prop or kind name exists: the
 * resolver may provide it, and otherwise TypeScript reports it. Positions
 * come back through the shadow's span table, so the pass needs no knowledge
 * of how the lowering laid the module out beyond the regions' generated
 * ranges.
 */

import { parseSync } from 'rolldown/utils';

import { sfcKind } from '../conventions.js';
import { collectFreeReferences, type FreeReference } from '../scope-walker.js';
import type { SfcDiagnostics } from './diagnostics.js';
import { BUILTIN_NAMES, type NameResolver, type ResolvedName } from './name-resolver.js';
import { generatedToOriginal, type OriginalLocation, type Shadow } from './segments.js';
import type { SourceSpace } from './source-space.js';
import { sourceSpan, type SourceSpan } from './source-span.js';

/** A free name bound by the lowering, with the source range of its first use. */
export interface ScopeBinding {
  readonly name: string;
  readonly firstUse: SourceSpan;
}

/** A free name imported from the module the resolver named. */
export interface ScopeImport extends ScopeBinding {
  readonly resolved: ResolvedName;
}

/** A render function's generated body, and how its free names resolve. */
export interface ScopeRegion {
  readonly start: number;
  readonly end: number;
  /** The kind names the function binds. */
  readonly kindNames: ReadonlySet<string>;
  /** What a name no step resolves becomes: a prop, or an error in a static form. */
  readonly unbound: 'prop' | 'static';
}

/** What the free names of one region become. */
export interface RegionScope {
  /** Names read from the props (a live component's state), in order of first use. */
  readonly props: readonly ScopeBinding[];
  /** Kind names the function binds, in order of first use. */
  readonly kindNames: readonly ScopeBinding[];
  /** The source offset of every use of a name that became a prop. */
  readonly propUses: ReadonlySet<number>;
}

/** What the free names of a module's render functions become. */
export interface ScopeResult {
  /** One entry per region, in the order given. */
  readonly regions: readonly RegionScope[];
  /** Resolved names, in order of first use. */
  readonly imports: readonly ScopeImport[];
  /** Imported names that a tag uses and that resolve to a live component. */
  readonly liveTags: ReadonlySet<string>;
  /** Imported names that a tag uses and that resolve to an island. */
  readonly islandTags: ReadonlySet<string>;
}

/** Inputs of {@link analyseScope}. */
export interface ScopeOptions {
  /** The component's files: positions come back as offsets of this space. */
  readonly space: SourceSpace;
  readonly resolver: NameResolver;
  readonly diagnostics: SfcDiagnostics;
}

/** Names the language binds inside every function, never props. */
const FUNCTION_NAMES: ReadonlySet<string> = new Set(['arguments']);

interface NameUse {
  readonly name: string;
  firstUse: SourceSpan;
  /** The generated offset of the first use, which orders uses. */
  firstAt: number;
  jsx: SourceSpan | null;
  /** Also free in `<script>`, where no prop is in scope. */
  moduleScope: boolean;
  /** The source offset of every use. */
  readonly starts: number[];
}

/**
 * The scope pass over `shadow`, whose render functions' bodies are the
 * generated `regions`. Returns `undefined` after reporting when the generated
 * module does not parse: an author expression that is valid alone but not
 * where the template puts it.
 */
export function analyseScope(
  shadow: Shadow,
  regions: readonly ScopeRegion[],
  options: ScopeOptions,
): ScopeResult | undefined {
  const parsed = parseSync('shadow.tsx', shadow.text, { lang: 'tsx', sourceType: 'module' });
  const errors = parsed.errors.filter((entry) => entry.severity === 'Error');
  if (errors.length > 0) {
    for (const error of errors) {
      const at = inSpace(
        shadow,
        options.space,
        generatedToOriginal(shadow, error.labels[0]?.start ?? shadow.bodyStart),
      );
      options.diagnostics.error(
        'sfc.invalid_expression',
        'This code is not valid where the template places it',
        at.start,
        at.end > at.start ? at.end : at.start + (at.found ? 1 : 0),
      );
    }
    return undefined;
  }

  const regionUses = regions.map(() => new Map<string, NameUse>());
  // Uses are ordered by where they stand in the generated module, not in the
  // source: the module lays the blocks out in one order whichever files hold
  // them, so a folder component orders its imports and props as its single
  // file does.
  const moduleNames = new Map<string, { readonly span: SourceSpan; readonly at: number }>();
  for (const reference of collectFreeReferences(parsed.program)) {
    const index = regions.findIndex(
      (region) => reference.start >= region.start && reference.end <= region.end,
    );
    const span = sourceOf(shadow, options.space, reference);
    if (index === -1) {
      const seen = moduleNames.get(reference.name);
      if (seen === undefined || reference.start < seen.at) {
        moduleNames.set(reference.name, { span, at: reference.start });
      }
      continue;
    }
    if (FUNCTION_NAMES.has(reference.name)) continue;
    const uses = regionUses[index] as Map<string, NameUse>;
    const use = uses.get(reference.name);
    if (use === undefined) {
      uses.set(reference.name, {
        name: reference.name,
        firstUse: span,
        firstAt: reference.start,
        jsx: reference.jsx ? span : null,
        moduleScope: false,
        starts: [span.start],
      });
      continue;
    }
    use.starts.push(span.start);
    if (reference.start < use.firstAt) {
      use.firstUse = span;
      use.firstAt = reference.start;
    }
    if (reference.jsx && (use.jsx === null || span.start < use.jsx.start)) use.jsx = span;
  }

  const imports = new Map<string, { readonly entry: ScopeImport; readonly at: number }>();
  const liveTags = new Set<string>();
  const islandTags = new Set<string>();
  const addImport = (entry: ScopeImport, at: number): void => {
    const seen = imports.get(entry.name);
    if (seen === undefined || at < seen.at) imports.set(entry.name, { entry, at });
  };
  // A free name of <script> is module scope: only the catalog can provide it.
  for (const [name, first] of moduleNames) {
    const inRegion = regionUses.filter((uses) => uses.has(name));
    if (inRegion.length > 0) {
      for (const uses of inRegion) {
        const use = uses.get(name) as NameUse;
        if (first.at < use.firstAt) {
          use.firstUse = first.span;
          use.firstAt = first.at;
        }
        use.moduleScope = true;
      }
      continue;
    }
    const resolved = options.resolver.resolve(name);
    if (resolved !== undefined) {
      addImport(Object.freeze({ name, firstUse: first.span, resolved }), first.at);
    }
  }

  const results = regions.map((region, index): RegionScope => {
    const props: ScopeBinding[] = [];
    const kindNames: ScopeBinding[] = [];
    const propUses = new Set<number>();
    const uses = regionUses[index] as Map<string, NameUse>;
    const ordered = [...uses.values()].sort((a, b) => a.firstAt - b.firstAt);
    for (const use of ordered) {
      const binding = Object.freeze({ name: use.name, firstUse: use.firstUse });
      if (region.kindNames.has(use.name)) {
        kindNames.push(binding);
        continue;
      }
      const resolved = options.resolver.resolve(use.name);
      if (resolved !== undefined) {
        const tag = use.jsx === null ? 'name' : tagKind(resolved, use.jsx, options.diagnostics);
        if (tag === 'live') liveTags.add(use.name);
        if (tag === 'island') islandTags.add(use.name);
        if (tag !== 'refused') addImport(Object.freeze({ ...binding, resolved }), use.firstAt);
        continue;
      }
      if (use.jsx !== null) {
        options.diagnostics.error(
          'sfc.unresolved_component',
          'No import, binding or catalog entry provides this component',
          use.jsx.start,
          use.jsx.end,
        );
        continue;
      }
      if (BUILTIN_NAMES.has(use.name) || use.moduleScope) continue;
      if (region.unbound === 'static') {
        options.diagnostics.error(
          'sfc.static_unbound',
          'The static form renders without state: it names context, imports and catalog names only',
          use.firstUse.start,
          use.firstUse.end,
        );
        continue;
      }
      props.push(binding);
      for (const start of use.starts) propUses.add(start);
    }
    return Object.freeze({
      props: Object.freeze(props),
      kindNames: Object.freeze(kindNames),
      propUses,
    });
  });
  return Object.freeze({
    regions: Object.freeze(results),
    imports: Object.freeze(
      [...imports.values()].sort((a, b) => a.at - b.at).map((entry) => entry.entry),
    ),
    liveTags,
    islandTags,
  });
}

/**
 * What a tag renders, by the module its name resolved to: a component (a
 * view, or a TypeScript module), a live component or an island, which the
 * lowering mounts by the rules of its kind, or nothing it may render: a
 * page-tree file or a mail is not a component.
 */
function tagKind(
  resolved: ResolvedName,
  at: SourceSpan,
  diagnostics: SfcDiagnostics,
): 'name' | 'live' | 'island' | 'refused' {
  if (!('path' in resolved.source) || !resolved.source.path.endsWith('.jsails')) return 'name';
  const kind = sfcKind(resolved.source.path);
  if (kind === 'view') return 'name';
  if (kind === 'live' || kind === 'island') return kind;
  diagnostics.error(
    'sfc.unresolved_component',
    'This name resolves to a page or mail file, which is not a component',
    at.start,
    at.end,
  );
  return 'refused';
}

/**
 * The source range of a reference: the name itself when it is copied
 * Verbatim, or the generated chunk's owner (an expression with decoded
 * entities).
 */
function sourceOf(shadow: Shadow, space: SourceSpace, reference: FreeReference): SourceSpan {
  const location = generatedToOriginal(shadow, reference.start);
  const at = inSpace(shadow, space, location);
  if (location.fidelity === 'exact') {
    return sourceSpan(at.start, at.start + reference.name.length);
  }
  return sourceSpan(at.start, at.end);
}

/**
 * A mapped location as a range of the offset space; a location with no
 * source (the header or footer) is the empty range at 0, `found: false`.
 */
function inSpace(
  shadow: Shadow,
  space: SourceSpace,
  location: OriginalLocation,
): { readonly start: number; readonly end: number; readonly found: boolean } {
  if (location.fidelity === 'none') return { start: 0, end: 0, found: false };
  const base = space.baseOf(shadow.sources[location.source]?.name ?? '') ?? 0;
  return { start: base + location.start, end: base + location.end, found: true };
}
