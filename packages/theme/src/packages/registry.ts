/**
 * Theme package activation and inheritance.
 *
 * `createThemeRegistry` turns validated {@link ThemePackage}s into an immutable
 * registry with `list`/`get`/`lineage`/`resolve`/`active`/`activate` plus the
 * folded token {@link ThemeResolution}. Exactly one theme is active at a time;
 * `active` is the raw active package, while `resolve(name)` returns its
 * effective package with parent tokens merged root-to-child. Activating a
 * child activates the child, not the parent; a parent may also be activated
 * directly.
 *
 * Parent chains follow Magento's model rather than WordPress' two-level cap:
 * a child declares a `parent` name, inheritance is recursive, and the registry
 * rejects missing parents, cycles, and chains deeper than
 * {@link MAX_THEME_PARENT_DEPTH}. Tokens merge parent-first, so a child
 * overrides individual properties. Non-token package metadata is inherited as
 * a fallback: a child's `preview`, `description`, `author`, `templates`,
 * `partials`, `contentTypes`, and `settingsSchema` are used when present;
 * parents fill gaps. Token precedence remains
 * `core defaults < parent tokens < child tokens < application tokens`.
 *
 * The registry is frozen and immutable. `activate` returns a new registry and
 * never mutates the original. Every failure is a value-free
 * {@link ThemePackageError}.
 */

import { compareStrings } from 'jsails/support';

import {
  resolveThemeTokens,
  type ThemeContribution,
  type ThemeResolution,
  type ThemeTokenMap,
} from '../tokens.js';
import type { ThemePackage } from './discovery.js';
import { ThemePackageError, type ThemeLayoutName } from './manifest.js';
import type { ThemeTemplate } from './template.js';

/** Maximum supported parent-chain depth. */
export const MAX_THEME_PARENT_DEPTH = 32;

/** Options for {@link createThemeRegistry}. */
export interface ThemeRegistryOptions {
  /** Validated theme packages, in any order (re-sorted by name). */
  readonly packages: readonly ThemePackage[];
  /** Name of the initially active theme. Defaults to the first package. */
  readonly active?: string;
  /** Application-level token overrides (highest precedence). */
  readonly appTokens?: ThemeTokenMap;
  /** Core default tokens (lowest precedence). Defaults to `{}`. */
  readonly defaults?: ThemeTokenMap;
}

/**
 * An immutable registry over activated theme packages. After creation the
 * registry never mutates: `activate` returns a new registry.
 */
export interface ThemePackageRegistry {
  /**
   * The folded tokens for this activation: `defaults < ancestors < active <
   * app` in `active`, every package's effective token map in `themes`.
   * Serialize it with {@link themeTokensToCss}.
   */
  readonly resolution: ThemeResolution;
  /** Every raw package, sorted by name, frozen. */
  list(): readonly ThemePackage[];
  /** The raw package with the given name, or `undefined`. */
  get(name: string): ThemePackage | undefined;
  /** A parent-first, child-last chain from the root ancestor to `name`. */
  lineage(name: string): readonly ThemePackage[];
  /** The effective package (inherited tokens/metadata merged), or undefined. */
  resolve(name: string): ThemePackage | undefined;
  /** The raw active package (or `undefined` when no package exists). */
  active(): ThemePackage | undefined;
  /** The effective active package, or `undefined`. */
  resolveActive(): ThemePackage | undefined;
  /** The name of the active package (or `undefined`). */
  activeName(): string | undefined;
  /** A new registry with the named theme active; the original is unchanged. */
  activate(name: string): ThemePackageRegistry;
}

/** The validated package graph every activation of one registry shares. */
interface RegistryGraph {
  readonly packages: readonly ThemePackage[];
  readonly byName: ReadonlyMap<string, ThemePackage>;
  readonly lineages: ReadonlyMap<string, readonly ThemePackage[]>;
  readonly effective: ReadonlyMap<string, ThemePackage>;
  readonly appTokens: ThemeTokenMap;
  readonly defaults: ThemeTokenMap;
}

/**
 * Build a frozen theme package registry. Validates package names, parent
 * chains, and the requested active theme; failures are value-free
 * {@link ThemePackageError}s.
 */
export function createThemeRegistry(options: ThemeRegistryOptions): ThemePackageRegistry {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ThemePackageError('invalid_input', 'createThemeRegistry requires an options object');
  }

  const rawPackages = options.packages ?? [];
  if (!Array.isArray(rawPackages)) {
    throw new ThemePackageError('invalid_input', 'packages must be an array');
  }
  const packages = Object.freeze([...rawPackages].sort((a, b) => compareStrings(a.name, b.name)));

  const byName = new Map<string, ThemePackage>();
  for (const pkg of packages) {
    if (
      pkg === null ||
      typeof pkg !== 'object' ||
      typeof (pkg as { name?: unknown }).name !== 'string'
    ) {
      throw new ThemePackageError('invalid_input', 'each package must have a string name');
    }
    if (byName.has(pkg.name)) {
      throw new ThemePackageError('duplicate_name', 'duplicate theme package name');
    }
    byName.set(pkg.name, pkg);
  }

  const lineages = resolveLineages(byName);
  const effective = new Map<string, ThemePackage>();
  for (const [name, chain] of lineages) {
    effective.set(name, mergePackage(chain));
  }

  let activeName: string | undefined;
  if (options.active !== undefined) {
    if (typeof options.active !== 'string' || !byName.has(options.active)) {
      throw new ThemePackageError('unknown_theme', 'the requested active theme is not registered');
    }
    activeName = options.active;
  } else if (packages.length > 0) {
    activeName = packages[0]!.name;
  }

  return createRegistry(
    {
      packages,
      byName,
      lineages,
      effective,
      appTokens: options.appTokens ?? {},
      defaults: options.defaults ?? {},
    },
    activeName,
  );
}

/** Resolve every package's root-to-child lineage and validate the graph. */
function resolveLineages(
  byName: Map<string, ThemePackage>,
): ReadonlyMap<string, readonly ThemePackage[]> {
  const lineages = new Map<string, readonly ThemePackage[]>();
  for (const pkg of byName.values()) {
    const chain: ThemePackage[] = [];
    const seen = new Set<string>();
    let current: ThemePackage | undefined = pkg;
    while (current !== undefined) {
      if (seen.has(current.name)) {
        throw new ThemePackageError('parent_cycle', 'theme parent cycle detected');
      }
      seen.add(current.name);
      chain.push(current);
      if (chain.length > MAX_THEME_PARENT_DEPTH) {
        throw new ThemePackageError('parent_depth', 'theme parent chain is too deep');
      }
      if (current.parent === undefined) break;
      const parent = byName.get(current.parent);
      if (parent === undefined) {
        throw new ThemePackageError('missing_parent', 'a theme references a missing parent');
      }
      current = parent;
    }
    // The walk above is child-first; the chain is stored root-first for merging.
    lineages.set(pkg.name, Object.freeze(chain.reverse()));
  }
  return lineages;
}

/** Merge a root-to-child chain into an effective package. */
function mergePackage(chain: readonly ThemePackage[]): ThemePackage {
  const child = chain[chain.length - 1]!;
  const tokens: Record<string, string> = {};
  const templates: string[] = [];
  const partials: string[] = [];
  const contentTypes: string[] = [];
  let description: string | undefined;
  let author: string | undefined;
  let preview: string | undefined;
  let settingsSchema: Readonly<Record<string, unknown>> | undefined;
  const layouts: Partial<Record<ThemeLayoutName, ThemeTemplate>> = {};
  let css = '';

  for (const pkg of chain) {
    Object.assign(tokens, pkg.tokens);
    templates.push(...pkg.templates);
    partials.push(...pkg.partials);
    contentTypes.push(...pkg.contentTypes);
    if (pkg.description !== undefined) description = pkg.description;
    if (pkg.author !== undefined) author = pkg.author;
    if (pkg.preview !== undefined) preview = pkg.preview;
    if (pkg.settingsSchema !== undefined) settingsSchema = pkg.settingsSchema;
    Object.assign(layouts, pkg.layouts);
    if (pkg.css !== '') css = css === '' ? pkg.css : `${css}\n${pkg.css}`;
  }

  return Object.freeze({
    name: child.name,
    version: child.version,
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(preview === undefined ? {} : { preview }),
    ...(child.parent === undefined ? {} : { parent: child.parent }),
    tokens: Object.freeze(tokens),
    templates: Object.freeze([...new Set(templates)]),
    partials: Object.freeze([...new Set(partials)]),
    ...(settingsSchema === undefined ? {} : { settingsSchema: Object.freeze(settingsSchema) }),
    contentTypes: Object.freeze([...new Set(contentTypes)]),
    layouts: Object.freeze(layouts),
    css,
    path: child.path,
  });
}

/** One activation of a validated graph. */
function createRegistry(
  graph: RegistryGraph,
  activeName: string | undefined,
): ThemePackageRegistry {
  const { packages, byName, lineages, effective } = graph;
  const contributions: readonly ThemeContribution[] = [
    { source: 'core', tokens: graph.defaults },
    ...packages.map((pkg) => ({
      source: pkg.name,
      name: pkg.name,
      tokens: effective.get(pkg.name)!.tokens,
    })),
  ];
  const resolution = resolveThemeTokens(graph.appTokens, contributions, { active: activeName });
  const active = activeName === undefined ? undefined : byName.get(activeName);

  return Object.freeze({
    resolution,
    list: () => packages,
    get: (name: string) => byName.get(name),
    lineage: (name: string) => {
      const chain = lineages.get(name);
      if (chain === undefined) {
        throw new ThemePackageError('unknown_theme', 'unknown theme name');
      }
      return chain;
    },
    resolve: (name: string) => effective.get(name),
    active: () => active,
    resolveActive: () => (activeName === undefined ? undefined : effective.get(activeName)),
    activeName: () => activeName,
    activate: (name: string) => {
      if (byName.has(name)) {
        return createRegistry(graph, name);
      }
      throw new ThemePackageError('unknown_theme', 'cannot activate an unknown theme name');
    },
  });
}
