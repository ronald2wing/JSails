/**
 * The static scan of an app config's import graph, run before the config is
 * imported.
 *
 * A `jsails.config.ts` root is loaded by Node's type stripping, so it may use
 * only erasable TypeScript and may reach only a small graph:
 *
 * - npm packages, by bare specifier;
 * - modules under `config/` beside the root, by a relative path naming an
 *   existing `.ts` or `.js` file, scanned under the same rules.
 *
 * A relative path elsewhere (app code such as `./models/user.ts`, which
 * would run the app at config time), an absolute path, a URL, a `node:`
 * builtin, a dynamic `import()` and a `require` call are refused. Two bare
 * spellings reach the app's own tree too, and are refused with them: a
 * `#` subpath import, which Node maps through the `imports` field of the
 * importer's `package.json`, and the importer's own package name (a
 * self-reference through its `exports`). So is syntax that type stripping
 * cannot erase: an enum, a namespace with a body, a parameter property,
 * `import =`, `export =` and a decorator.
 *
 * The scan also reads the activation mode statically, from the one place it
 * may be written: an `activation` property of an object literal that is the
 * value of a `plugins` property. An `activation` key anywhere else (plugin
 * options, an unrelated object) is not the mode and is not read. At most one
 * such property may appear in the graph, and its value must be an object
 * literal whose `mode` is the string literal `'locked'` or `'managed'`. The
 * loader then requires the config the module returns to state that same
 * mode, so no variable, environment value or setting can choose it.
 *
 * Each refusal is a `config.*` registry error naming the module by its path
 * relative to the working directory, and the line and column. No source text
 * and no specifier is echoed.
 *
 * The parser (oxc, through `rolldown/utils`) is loaded when a scan runs, so
 * importing the kernel never loads it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

import type { ActivationMode } from '../app/config/schema.js';
import { ConfigErrors } from '../plugins/contract/errors.js';
import { isPathInside } from '../support/path-containment.server.js';
import { relativePathSlot } from '../support/project-paths.server.js';

/** The directory, beside the root, whose modules a config may import. */
export const CONFIG_MODULE_DIR = 'config';

/** A place in a config module: its path relative to the working directory, line and column. */
export interface ConfigLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/** The `plugins.activation` literal the scan read, and where it is written. */
export interface ActivationLiteral {
  readonly mode: ActivationMode;
  readonly at: ConfigLocation;
}

/** What the scan learned: the modules it read, and the activation literal. */
export interface ConfigScan {
  /** Absolute paths of the root and every config module it reaches, root first. */
  readonly modules: readonly string[];
  /** The `plugins.activation` literal, or `undefined` when the graph states none. */
  readonly activation: ActivationLiteral | undefined;
}

/** Options for {@link scanConfigGraph}. */
export interface ConfigScanOptions {
  /** The working directory error paths are relative to. */
  readonly cwd: string;
  /**
   * `'graph'` (the default) walks the import graph under every rule.
   * `'activation'` reads only the root's activation literal: the legacy
   * `jsails.app.js` root, whose imports are not restricted.
   */
  readonly rules?: 'graph' | 'activation';
  /** The root's text, when the caller has already read it. */
  readonly rootSource?: string;
}

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

type ImportProblem =
  | 'relative_import'
  | 'absolute_import'
  | 'url_import'
  | 'builtin_import'
  | 'dynamic_import'
  | 'require_call'
  | 'missing_module'
  | 'subpath_import'
  | 'self_import';

type NonErasableConstruct =
  'enum' | 'namespace' | 'parameter_property' | 'import_equals' | 'export_assignment' | 'decorator';

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MODULE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.js', '.mts', '.mjs']);

/**
 * Scan the config graph rooted at `rootPath` (absolute). Rejects with the
 * first refusal as a located `config.*` error.
 */
export async function scanConfigGraph(
  rootPath: string,
  options: ConfigScanOptions,
): Promise<ConfigScan> {
  const { parseSync } = await import('rolldown/utils');
  const configDir = join(dirname(rootPath), CONFIG_MODULE_DIR);
  const rules = options.rules ?? 'graph';
  const seen = new Set<string>();
  const queue: string[] = [rootPath];
  const activations: ActivationLiteral[] = [];
  const packageNames = new Map<string, string | undefined>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source =
      file === rootPath && options.rootSource !== undefined
        ? options.rootSource
        : readFileSync(file, 'utf8');
    const lines = lineStarts(source);
    const locate = (offset: number): ConfigLocation => {
      const { line, column } = position(lines, offset);
      return { path: relativePathSlot(file, options.cwd), line, column };
    };
    const result = parseSync(file, source, { sourceType: 'module' });
    const syntaxError = result.errors.find((error) => error.severity === 'Error');
    if (syntaxError !== undefined) {
      throw new ConfigErrors.Error('invalid_syntax', locate(syntaxError.labels[0]?.start ?? 0));
    }
    const program = result.program as unknown as AstNode;
    walk(program, [], (node, ancestors) => {
      const activation = readActivation(node, ancestors, locate);
      if (activation !== undefined) activations.push(activation);
      if (rules === 'activation') return;
      const construct = nonErasable(node);
      if (construct !== undefined) {
        throw new ConfigErrors.Error('non_erasable_syntax', { ...locate(node.start), construct });
      }
      const request = moduleRequest(node);
      if (request === undefined) return;
      if (request.problem !== undefined) {
        throw new ConfigErrors.Error('outside_graph', {
          ...locate(node.start),
          problem: request.problem,
        });
      }
      if (request.specifier === undefined) return;
      const target = classify(request.specifier, file, configDir, packageNames);
      if (target.problem !== undefined) {
        throw new ConfigErrors.Error('outside_graph', {
          ...locate(node.start),
          problem: target.problem,
        });
      }
      if (target.module !== undefined) queue.push(target.module);
    });
    if (rules === 'activation') break;
  }
  if (activations.length > 1) {
    const second = activations[1] as ActivationLiteral;
    throw new ConfigErrors.Error('activation_repeated', second.at);
  }
  const activation = activations[0];
  return Object.freeze({
    modules: Object.freeze([...seen]),
    activation: activation === undefined ? undefined : Object.freeze(activation),
  });
}

/**
 * Where a specifier leads: an npm package (neither field), the absolute path
 * of a config module to scan next (`module`), or the refusal (`problem`).
 */
function classify(
  specifier: string,
  importer: string,
  configDir: string,
  packageNames: Map<string, string | undefined>,
): { readonly module?: string; readonly problem?: ImportProblem } {
  if (specifier.startsWith('node:') || isBuiltin(specifier)) return { problem: 'builtin_import' };
  if (isAbsolute(specifier)) return { problem: 'absolute_import' };
  if (URL_SCHEME.test(specifier)) return { problem: 'url_import' };
  if (specifier.startsWith('#')) return { problem: 'subpath_import' };
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    const own = ownPackageName(dirname(importer), packageNames);
    return own !== undefined && (specifier === own || specifier.startsWith(`${own}/`))
      ? { problem: 'self_import' }
      : {};
  }
  const target = resolve(dirname(importer), specifier);
  if (!isPathInside(configDir, target) || !MODULE_EXTENSIONS.has(extname(target))) {
    return { problem: 'relative_import' };
  }
  // A missing module is reported by its place in the importer; the file
  // system's own message would echo the path.
  return statSync(target, { throwIfNoEntry: false })?.isFile() === true
    ? { module: target }
    : { problem: 'missing_module' };
}

/** A module request a node makes: a specifier to follow, or a refusal. */
function moduleRequest(
  node: AstNode,
): { readonly specifier?: string; readonly problem?: ImportProblem } | undefined {
  switch (node.type) {
    case 'ImportDeclaration':
      return node['importKind'] === 'type' ? undefined : { specifier: sourceOf(node) };
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      if (node['source'] === null || node['source'] === undefined) return undefined;
      return node['exportKind'] === 'type' ? undefined : { specifier: sourceOf(node) };
    case 'ImportExpression':
      return { problem: 'dynamic_import' };
    case 'CallExpression': {
      const callee = node['callee'] as AstNode | undefined;
      return callee?.type === 'Identifier' && callee['name'] === 'require'
        ? { problem: 'require_call' }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The `name` of the `package.json` whose scope holds `dir`: the nearest one
 * above it, as Node finds it for a self-reference. `undefined` when there is
 * none, or it names nothing. Answers are cached by directory for one scan.
 */
function ownPackageName(dir: string, cache: Map<string, string | undefined>): string | undefined {
  if (cache.has(dir)) return cache.get(dir);
  const manifest = join(dir, 'package.json');
  let name: string | undefined;
  if (existsSync(manifest)) {
    name = readPackageName(manifest);
  } else {
    const parent = dirname(dir);
    name = parent === dir ? undefined : ownPackageName(parent, cache);
  }
  cache.set(dir, name);
  return name;
}

function readPackageName(manifest: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    // An unreadable or malformed package.json names no package; Node refuses
    // to resolve through it, so the import fails at load with its own report.
    return undefined;
  }
  const name = (parsed as { readonly name?: unknown } | null)?.name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

function sourceOf(node: AstNode): string | undefined {
  const source = node['source'] as AstNode | undefined;
  return typeof source?.['value'] === 'string' ? source['value'] : undefined;
}

/** The non-erasable construct a node is, if any. */
function nonErasable(node: AstNode): NonErasableConstruct | undefined {
  switch (node.type) {
    case 'TSEnumDeclaration':
      return node['declare'] === true ? undefined : 'enum';
    case 'TSModuleDeclaration':
      return node['declare'] === true || node['body'] === null || node['body'] === undefined
        ? undefined
        : 'namespace';
    case 'TSParameterProperty':
      return 'parameter_property';
    case 'TSImportEqualsDeclaration':
      return node['importKind'] === 'type' ? undefined : 'import_equals';
    case 'TSExportAssignment':
      return 'export_assignment';
    case 'Decorator':
      return 'decorator';
    default:
      return undefined;
  }
}

/**
 * The activation literal a node states, when it is the `activation` property
 * of a `plugins: { ... }` object literal (`ancestors` ends with the node's
 * parent). A value that is not an object literal with a string-literal
 * `mode` is refused.
 */
function readActivation(
  node: AstNode,
  ancestors: readonly AstNode[],
  locate: (offset: number) => ConfigLocation,
): ActivationLiteral | undefined {
  if (node.type !== 'Property' || propertyName(node) !== 'activation') return undefined;
  const object = ancestors.at(-1);
  const owner = ancestors.at(-2);
  if (
    object?.type !== 'ObjectExpression' ||
    owner?.type !== 'Property' ||
    owner['value'] !== object ||
    propertyName(owner) !== 'plugins'
  ) {
    return undefined;
  }
  const value = node['value'] as AstNode;
  if (value.type !== 'ObjectExpression') {
    throw new ConfigErrors.Error('activation_not_literal', locate(value.start));
  }
  const properties = value['properties'] as readonly AstNode[];
  for (const property of properties) {
    if (property.type !== 'Property' || property['computed'] === true) {
      throw new ConfigErrors.Error('activation_not_literal', locate(property.start));
    }
    if (propertyName(property) !== 'mode') continue;
    const mode = property['value'] as AstNode;
    if (mode.type === 'Literal' && (mode['value'] === 'locked' || mode['value'] === 'managed')) {
      return { mode: mode['value'], at: locate(node.start) };
    }
    throw new ConfigErrors.Error('activation_not_literal', locate(mode.start));
  }
  throw new ConfigErrors.Error('activation_not_literal', locate(value.start));
}

function propertyName(node: AstNode): string | undefined {
  if (node['computed'] === true) return undefined;
  const key = node['key'] as AstNode;
  if (key.type === 'Identifier') return key['name'] as string;
  if (key.type === 'Literal' && typeof key['value'] === 'string') return key['value'];
  return undefined;
}

/** Visit every node of the tree, depth first, with its ancestors (root first). */
function walk(
  node: AstNode,
  ancestors: AstNode[],
  visit: (node: AstNode, ancestors: readonly AstNode[]) => void,
): void {
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, ancestors, visit);
    } else if (isNode(child)) {
      walk(child, ancestors, visit);
    }
  }
  ancestors.pop();
}

function isNode(value: unknown): value is AstNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** The offset each line starts at. */
function lineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** The 1-based line and column of an offset. */
function position(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] as number) + 1 };
}
