/**
 * Component resolution for the transitional `.jsails` emitter.
 *
 * A capitalized tag in a `<template>` (e.g. `<Counter />`) lowers to JSX
 * verbatim, so the emitted module needs a binding for it. This module collects
 * the capitalized tags of a parsed template, works out which of them the
 * component's own code leaves free, and resolves each free tag to an explicit
 * import the emitter prepends to the module.
 *
 * Resolution follows the file convention: tag `Counter` resolves to
 * `app/components/counter.js` (the kebab-case of the tag). A tag with no file
 * is a positioned `sfc.unresolved_component` diagnostic and is skipped, so
 * every missing component is reported in one pass and no unresolved reference
 * is emitted silently. The catalog resolver (KRN-15) replaces this convention.
 *
 * Pure except for the existence check: no module is imported and no top-level
 * code runs.
 */

import { join, relative } from 'node:path';

import { parseSync } from 'rolldown/utils';

import {
  CLIENT_COMPONENT_EXTENSIONS,
  CONVENTION_DIRS,
  kebabCase,
  probeConventionFile,
} from './conventions.js';

import { collectUnmatchedIdentifiers } from './scope-walker.js';
import type { SfcDiagnostics } from './sfc/diagnostics.js';
import type { TemplateNode } from './sfc/template-ast.js';
import { toPosixId } from '../support/project-paths.server.js';

/** A capitalized tag found in a view, with its absolute source position. */
export interface ComponentTagRef {
  /** The tag as written in the template, e.g. `Counter`. */
  readonly tag: string;
  /** Absolute offset of the tag's first character in the component source. */
  readonly start: number;
  /** Absolute offset just past the tag's last character (exclusive). */
  readonly end: number;
}

/** A capitalized tag resolved to an importable component module. */
export interface ResolvedComponent {
  /** The tag as written in the template, e.g. `Counter`. */
  readonly tag: string;
  /** Absolute path to the resolved component module. */
  readonly file: string;
  /** Import specifier relative to the emitted module, `.js`-rewritten. */
  readonly specifier: string;
}

/** Options for {@link resolveComponentTags}. */
export interface ResolveComponentsOptions {
  /** Directory of the emitted module, for the relative import specifier. */
  readonly fromDir: string;
  /** Project root, used to locate `app/components/`. */
  readonly rootDir: string;
}

/**
 * Collect the capitalized tags of a parsed template, with the range of each
 * tag's name. A member tag (`<Foo.Bar>`) contributes its root (`Foo`); tags
 * inside a `js-pre` subtree are literal markup and are skipped. Returns a
 * de-duplicated list sorted by tag.
 */
export function collectTemplateComponents(
  children: readonly TemplateNode[],
): readonly ComponentTagRef[] {
  const found = new Map<string, ComponentTagRef>();
  const walk = (list: readonly TemplateNode[]): void => {
    for (const node of list) {
      if (node.kind !== 'element' || node.raw) {
        continue;
      }
      const root = node.tag.split('.')[0] ?? '';
      if (/^[A-Z]/.test(root) && !found.has(root)) {
        const start = node.start + 1;
        found.set(root, Object.freeze({ tag: root, start, end: start + root.length }));
      }
      walk(node.children);
    }
  };
  walk(children);
  return Object.freeze([...found.values()].sort((a, b) => a.tag.localeCompare(b.tag)));
}

/**
 * The tags among `tags` that `moduleSource` leaves free. The module is parsed
 * with one probe element per tag appended, so a tag the module imports or
 * declares resolves to that binding and is not free (it needs no resolution).
 * When the probe does not parse, every tag is treated as free and the resolver
 * reports whatever it cannot find.
 */
export function freeComponentTags(
  moduleSource: string,
  tags: readonly ComponentTagRef[],
): ReadonlySet<string> {
  const all = new Set(tags.map((ref) => ref.tag));
  const probe = tags.map((ref) => `<${ref.tag} />;`).join('\n');
  try {
    const parsed = parseSync('probe.tsx', `${moduleSource}\n${probe}\n`, { sourceType: 'module' });
    if (parsed.errors.some((error) => error.severity === 'Error')) {
      return all;
    }
    const free = collectUnmatchedIdentifiers(parsed.program);
    return new Set([...all].filter((tag) => free.has(tag)));
  } catch {
    return all;
  }
}

/**
 * Resolve capitalized tags to component modules under `app/components/`.
 *
 * Each tag resolves to `app/components/<kebab-case>.js`. A tag with no module is
 * reported as a value-free `sfc.unresolved_component` diagnostic and skipped, so a
 * view with several missing components reports all of them in one pass. The
 * returned list is frozen and ordered by tag.
 */
export function resolveComponentTags(
  tags: readonly ComponentTagRef[],
  options: ResolveComponentsOptions,
  diagnostics: SfcDiagnostics,
): readonly ResolvedComponent[] {
  const componentsDir = join(options.rootDir, CONVENTION_DIRS.clientComponents);
  const resolved: ResolvedComponent[] = [];

  for (const ref of tags) {
    const file = probeConventionFile(
      componentsDir,
      kebabCase(ref.tag),
      CLIENT_COMPONENT_EXTENSIONS,
    );
    if (file === undefined) {
      diagnostics.error(
        'sfc.unresolved_component',
        'Component has no module under app/components/',
        ref.start,
        ref.end,
      );
      continue;
    }
    resolved.push(
      Object.freeze({
        tag: ref.tag,
        file,
        specifier: toSpecifier(options.fromDir, file),
      }),
    );
  }

  return Object.freeze(resolved);
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/** Build a relative import specifier with a `.js` extension. */
function toSpecifier(fromDir: string, file: string): string {
  const rel = toPosixId(relative(fromDir, file));
  const withDot = rel.startsWith('.') ? rel : './' + rel;
  return withDot.replace(/\.(tsx|ts|mtsx|mts|jsx)$/, '.js');
}
