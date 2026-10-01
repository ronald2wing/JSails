/**
 * The API report: one Markdown file per published entry point,
 * `api/<package>/<subpath>.api.md`, listing every export with its kind, tier,
 * TSDoc state and normalised declaration, read from the emitted
 * `dist/src/**\/*.d.ts` text with the oxc parser (no type checker). Declaration
 * text is stable because every workspace compiles under `isolatedDeclarations`
 * (`scripts/gates/isolated-declarations.mjs`).
 *
 * Usage:
 *   node scripts/api-report.mjs --write                  regenerate api/
 *   node scripts/api-report.mjs --write --allow-growth   ... and raise a value budget
 *   node scripts/api-report.mjs --check                  fail on any difference
 *   node scripts/api-report.mjs --record-findings        rewrite the api-untagged ledger
 *
 * `--record-findings` keeps the reason of every listed finding that still
 * occurs, drops the ones that are gone, and adds new ones with the default
 * reason; it exists for the baseline and for merges, and its diff is reviewed
 * like any other ledger change.
 *
 * An entry is a `{ types, default }` pair in a non-private workspace's
 * `exports`. The report follows `export *`, named re-exports, `import` then
 * `export`, and `export * as ns` to the declaring file, across workspaces when
 * the specifier names one. A declaration is listed in full in its home entry
 * (the entry whose barrel directory is the closest ancestor of the declaring
 * file); every other entry that exports it lists `re-export from <home>`, so a
 * changed signature shows up once.
 *
 * A declaration's line also holds every declaration its text names, followed
 * transitively through local names, imports (across files and workspaces),
 * namespace members and `import('…')` types, that no entry reports: as
 * `where <text>` when it sits in the same file and `where <file>#<name>: <text>`
 * otherwise. A named declaration that some entry reports is left as its name,
 * since its own line changes with it. So any change to a type a published
 * signature depends on changes the report, except types of external packages,
 * which the dependency's version range covers.
 *
 * Each report header carries `platform` (`node`, with the builtins, when the
 * entry's static import closure in `dist/src`, followed through relative imports
 * and other workspace entries, reaches a Node builtin; `neutral` otherwise), the
 * external packages that closure loads (which decide whether a `neutral` entry
 * runs in a browser), the export counts, and a value budget: `--write` lowers it to the current value count and
 * refuses to raise it without `--allow-growth`, so growth of the public surface
 * is a reviewed decision.
 *
 * Tiers are TSDoc tags on the declaration: `@public`, `@experimental`,
 * `@internal`. `findings()` lists, per declaration: no tier tag (`untagged`), no
 * TSDoc summary (`undocumented`), a `@public` declaration naming `@internal`
 * ones (`public-uses-internal`, whose id lists them), an `@experimental`
 * declaration exported from an entry that is not `/experimental`
 * (`experimental-outside`), and one name bound to different declarations
 * across entries (`duplicate`, whose id lists the home entry of each). An id
 * that names the offending set makes a listed finding that gets worse a new
 * finding. `scripts/gates/api-untagged.mjs` ratchets them against
 * `scripts/expected-failures/api-untagged.json`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot as defaultRoot } from './workspaces.mjs';

export const API_DIR_NAME = 'api';
const TIERS = Object.freeze(['public', 'experimental', 'internal']);
const VALUE_KINDS = new Set(['function', 'const', 'let', 'var', 'class', 'enum', 'namespace']);
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const posix = (path) => path.split(sep).join('/');

/** `parseSync` from the oxc parser core already depends on (`rolldown/utils`). */
export async function loadParser(root = defaultRoot) {
  const require = createRequire(join(root, 'core', 'package.json'));
  const module = await import(pathToFileURL(require.resolve('rolldown/utils')).href);
  return module.parseSync;
}

/** Workspaces from `<root>/package.json` (trailing `/*` globs only), as `{ name, dir, manifest }`. */
export function listWorkspaces(root = defaultRoot) {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dirs = workspaces.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [join(root, pattern)];
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(parent, entry.name, 'package.json')),
      )
      .map((entry) => join(parent, entry.name));
  });
  return dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { name: manifest.name, dir, manifest };
  });
}

/** The import specifier of an export-map key: `jsails` for `.`, `jsails/support` for `./support`. */
export function entrySpecifier(packageName, subpath) {
  return subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`;
}

/** The report file of an entry, relative to the repo root. */
export function reportPath(packageName, subpath) {
  const name = subpath === '.' ? 'index' : subpath.slice(2);
  return posix(join(API_DIR_NAME, packageName, `${name}.api.md`));
}

/** The `{ types, default }` entries of a workspace manifest, in manifest order. */
export function entriesOf({ name, dir, manifest }) {
  const entries = [];
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (target === null || typeof target !== 'object' || typeof target.types !== 'string') continue;
    entries.push({
      packageName: name,
      subpath,
      specifier: entrySpecifier(name, subpath),
      types: resolve(dir, target.types),
      runtime: typeof target.default === 'string' ? resolve(dir, target.default) : null,
      report: reportPath(name, subpath),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Declaration files
// ---------------------------------------------------------------------------

const DECLARATION_KIND = {
  TSDeclareFunction: 'function',
  FunctionDeclaration: 'function',
  ClassDeclaration: 'class',
  TSInterfaceDeclaration: 'interface',
  TSTypeAliasDeclaration: 'type',
  TSEnumDeclaration: 'enum',
  TSModuleDeclaration: 'namespace',
};

/** The leading `/** … *\/` of a statement, or null. A comment at the top of the file is its module header. */
function leadingDoc(text, comments, start) {
  let doc = null;
  for (const comment of comments) {
    if (comment.end > start) break;
    if (text.slice(comment.end, start).trim() === '') doc = comment;
  }
  if (doc === null || doc.type !== 'Block' || !doc.value.startsWith('*')) return null;
  if (text.slice(0, doc.start).trim() === '' || text.slice(0, doc.start).startsWith('#!'))
    return null;
  return doc.value;
}

/** Tier and summary of a JSDoc body (`* …` without the delimiters). */
export function parseDoc(body) {
  if (body === null) return { tier: null, tiers: [], summary: false };
  const lines = body
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''))
    .join('\n');
  const tagAt = lines.search(/(^|\s)@[a-zA-Z]/);
  const summary = (tagAt === -1 ? lines : lines.slice(0, tagAt)).trim() !== '';
  const tiers = TIERS.filter((tier) => new RegExp(`(^|\\s)@${tier}(?![\\w-])`).test(lines));
  return { tier: tiers.length === 1 ? tiers[0] : null, tiers, summary };
}

/** Collapses a declaration's text to one line with comments removed. */
function normalise(text, comments, start, end) {
  let out = '';
  let cursor = start;
  for (const comment of comments) {
    if (comment.start < start || comment.end > end) continue;
    out += text.slice(cursor, comment.start);
    cursor = comment.end;
  }
  out += text.slice(cursor, end);
  return out
    .replace(/\s+/g, ' ')
    .replace(/^declare /, '')
    .replace(/;\s*$/, '')
    .trim();
}

/**
 * A parsed declaration file: its local declarations (exported or not), its
 * imports, and its export statements, by name.
 */
function indexFile(parseSync, file) {
  const text = readFileSync(file, 'utf8');
  const parsed = parseSync(file, text, { sourceType: 'module', lang: 'dts' });
  if (parsed.errors.length > 0) {
    throw new Error(`${file}: cannot parse: ${parsed.errors[0].message}`);
  }
  const comments = parsed.comments;
  const locals = new Map();
  const imports = new Map();
  const reexports = [];
  const addLocal = (name, record) => {
    if (!locals.has(name)) locals.set(name, []);
    locals.get(name).push(record);
  };
  const declare = (node, statement, exported) => {
    const doc = parseDoc(leadingDoc(text, comments, statement.start));
    if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations) {
        if (declarator.id.type !== 'Identifier') continue;
        addLocal(declarator.id.name, {
          kind: node.kind,
          exported,
          doc,
          text: `${node.kind} ${normalise(text, comments, declarator.start, declarator.end)}`,
        });
      }
      return;
    }
    const kind = DECLARATION_KIND[node.type];
    const name = node.id?.name ?? node.id?.value;
    if (kind === undefined || name === undefined) return;
    addLocal(name, { kind, exported, doc, text: normalise(text, comments, node.start, node.end) });
  };

  for (const statement of parsed.program.body) {
    switch (statement.type) {
      case 'ImportDeclaration':
        for (const specifier of statement.specifiers ?? []) {
          const local = specifier.local.name;
          if (specifier.type === 'ImportSpecifier') {
            const imported = specifier.imported.name ?? specifier.imported.value;
            imports.set(local, { source: statement.source.value, imported });
          } else if (specifier.type === 'ImportDefaultSpecifier') {
            imports.set(local, { source: statement.source.value, imported: 'default' });
          } else {
            imports.set(local, { source: statement.source.value, imported: '*' });
          }
        }
        break;
      case 'ExportAllDeclaration':
        reexports.push({
          type: 'all',
          source: statement.source.value,
          as: statement.exported ? (statement.exported.name ?? statement.exported.value) : null,
          doc: parseDoc(leadingDoc(text, comments, statement.start)),
        });
        break;
      case 'ExportNamedDeclaration':
        if (statement.declaration) {
          declare(statement.declaration, statement, true);
        } else {
          for (const specifier of statement.specifiers ?? []) {
            reexports.push({
              type: 'named',
              source: statement.source?.value ?? null,
              local: specifier.local.name ?? specifier.local.value,
              as: specifier.exported.name ?? specifier.exported.value,
              doc: parseDoc(leadingDoc(text, comments, statement.start)),
            });
          }
        }
        break;
      case 'ExportDefaultDeclaration': {
        const node = statement.declaration;
        if (node.type === 'Identifier') {
          reexports.push({
            type: 'named',
            source: null,
            local: node.name,
            as: 'default',
            doc: null,
          });
        } else {
          const doc = parseDoc(leadingDoc(text, comments, statement.start));
          addLocal('default', {
            kind: DECLARATION_KIND[node.type] ?? 'default',
            exported: true,
            doc,
            text: normalise(text, comments, node.start, node.end),
          });
        }
        break;
      }
      case 'TSExportAssignment':
        throw new Error(`${file}: \`export =\` is not supported by the API report`);
      default:
        if (DECLARATION_KIND[statement.type] || statement.type === 'VariableDeclaration') {
          declare(statement, statement, false);
        }
    }
  }
  return { file, text, locals, imports, reexports };
}

/**
 * Resolves module specifiers and the exports of declaration files, with a
 * cache per file. `entryFiles` maps a bare specifier (`jsails/support`) to the
 * declaration file of that workspace entry.
 */
export class DeclarationGraph {
  constructor(parseSync, entryFiles) {
    this.parseSync = parseSync;
    this.entryFiles = entryFiles;
    this.files = new Map();
    this.exportCache = new Map();
  }

  file(path) {
    if (!this.files.has(path)) this.files.set(path, indexFile(this.parseSync, path));
    return this.files.get(path);
  }

  /** The declaration file a specifier names from `fromFile`, or null for an external package. */
  resolveModule(specifier, fromFile) {
    if (specifier.startsWith('.')) {
      const base = resolve(dirname(fromFile), specifier);
      const candidates = [
        base.replace(/\.js$/, '.d.ts'),
        base.replace(/\.mjs$/, '.d.mts'),
        base.replace(/\.jsx$/, '.d.ts'),
        `${base}.d.ts`,
        join(base, 'index.d.ts'),
      ];
      const found = candidates.find(
        (candidate) => candidate.endsWith('.d.ts') && existsSync(candidate),
      );
      if (found === undefined) throw new Error(`${fromFile}: cannot resolve ${specifier}`);
      return found;
    }
    return this.entryFiles.get(specifier) ?? null;
  }

  /** Bindings of the names one import binding refers to. */
  importBinding(file, local) {
    const target = file.imports.get(local);
    const module = this.resolveModule(target.source, file.file);
    if (module === null)
      return { type: 'external', source: target.source, imported: target.imported };
    if (target.imported === '*') return { type: 'namespace', file: module };
    const binding = this.exportsOf(module).get(target.imported);
    if (binding === undefined) {
      throw new Error(`${file.file}: ${target.source} has no export ${target.imported}`);
    }
    return binding;
  }

  /** The binding a local name in `file` refers to. */
  localBinding(file, local) {
    if (file.locals.has(local)) return { type: 'declaration', file: file.file, name: local };
    if (file.imports.has(local)) return this.importBinding(file, local);
    throw new Error(`${file.file}: exports unknown name ${local}`);
  }

  /** Every export of a declaration file, by exported name. */
  exportsOf(path, stack = []) {
    if (this.exportCache.has(path)) return this.exportCache.get(path);
    if (stack.includes(path)) return new Map();
    const file = this.file(path);
    const explicit = new Map();
    for (const [name, records] of file.locals) {
      if (records.some((record) => record.exported)) {
        explicit.set(name, { type: 'declaration', file: path, name });
      }
    }
    const stars = [];
    for (const reexport of file.reexports) {
      if (reexport.type === 'named') {
        if (reexport.source === null) {
          explicit.set(reexport.as, this.localBinding(file, reexport.local));
          continue;
        }
        const module = this.resolveModule(reexport.source, path);
        if (module === null) {
          explicit.set(reexport.as, {
            type: 'external',
            source: reexport.source,
            imported: reexport.local,
            doc: reexport.doc,
          });
          continue;
        }
        const binding = this.exportsOf(module, [...stack, path]).get(reexport.local);
        if (binding === undefined) {
          throw new Error(`${path}: ${reexport.source} has no export ${reexport.local}`);
        }
        explicit.set(reexport.as, binding);
      } else {
        const module = this.resolveModule(reexport.source, path);
        if (reexport.as !== null) {
          explicit.set(
            reexport.as,
            module === null
              ? { type: 'external', source: reexport.source, imported: '*', doc: reexport.doc }
              : { type: 'namespace', file: module },
          );
        } else if (module === null) {
          // Everything an external module exports, which the report cannot
          // enumerate: listed as one line so adding or removing it shows.
          explicit.set(`* from '${reexport.source}'`, {
            type: 'external',
            source: reexport.source,
            imported: '*',
            doc: reexport.doc,
          });
        } else {
          stars.push(this.exportsOf(module, [...stack, path]));
        }
      }
    }
    // A local or named export shadows a star export; the first star that
    // provides a name wins, as TypeScript reports a conflict between two.
    const result = new Map(explicit);
    for (const star of stars) {
      for (const [name, binding] of star) {
        if (name !== 'default' && !result.has(name)) result.set(name, binding);
      }
    }
    this.exportCache.set(path, result);
    return result;
  }

  /** The records of a declaration binding. */
  records(binding) {
    return this.file(binding.file).locals.get(binding.name);
  }
}

/** A stable identity for a binding: the declaring file and name, or the external module and name. */
export function identity(binding, root) {
  if (binding.type === 'declaration')
    return `${posix(relative(root, binding.file))}#${binding.name}`;
  if (binding.type === 'namespace') return `${posix(relative(root, binding.file))}#*`;
  return `${binding.source}#${binding.imported}`;
}

const IMPORT_TYPE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
const QUALIFIED_NAME = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g;

const segments = (path) => path.split('.').map((part) => part.trim());

/** Follows `members` of a namespace binding (`ns.Inner.Name`); stops at a non-namespace. */
function followMembers(graph, binding, members) {
  let current = binding;
  for (const member of members) {
    if (current?.type !== 'namespace') break;
    current = graph.exportsOf(current.file).get(member) ?? null;
  }
  return current;
}

/**
 * The bindings a declaration text in `file` names: `import('spec').Name`
 * types, names declared in the file, and imported names, with members of a
 * namespace import (`ns.Name`) followed to the member.
 */
function namedBindings(graph, file, text) {
  const index = graph.file(file);
  const out = [];
  const rest = text.replace(IMPORT_TYPE, (_, _quote, specifier, members) => {
    const module = graph.resolveModule(specifier, file);
    if (module !== null) {
      out.push(
        followMembers(graph, { type: 'namespace', file: module }, segments(members).slice(1)),
      );
    }
    return ' ';
  });
  for (const match of rest.match(QUALIFIED_NAME) ?? []) {
    const [head, ...members] = segments(match);
    let binding = null;
    if (index.locals.has(head)) binding = { type: 'declaration', file, name: head };
    else if (index.imports.has(head)) binding = graph.importBinding(index, head);
    if (binding !== null) out.push(followMembers(graph, binding, members));
    // Each member may also be a name of the file (`typeof value.key` names
    // `value`; a member that matches a local name is an over-approximation
    // the report accepts, since it only adds context).
    for (const member of members) {
      if (index.locals.has(member)) out.push({ type: 'declaration', file, name: member });
    }
  }
  return out.filter((binding) => binding !== null && binding !== undefined);
}

/**
 * Every declaration `binding`'s text names, transitively, across files. Returns
 * `{ helpers, targets }`: `helpers` are the named declarations no entry reports
 * (`reported` holds the identities every entry exports), which the report
 * inlines so a change to them changes the report line (a signature naming
 * `typeof smtpDefaults`, or an options interface imported from a file no entry
 * exports); `targets` are all named declarations, reported or not, by identity.
 * Same-file helpers come first in source order, then the others by identity.
 * A declaration an entry reports is not walked into: its own report line holds it.
 */
function referencedDeclarations(graph, binding, reported, root) {
  const self = identity(binding, root);
  const seen = new Set([self]);
  const targets = new Map();
  const helpers = [];
  const queue = graph.records(binding).map((record) => ({ file: binding.file, text: record.text }));
  while (queue.length > 0) {
    const { file, text } = queue.shift();
    for (const target of namedBindings(graph, file, text)) {
      if (target.type !== 'declaration') continue;
      const id = identity(target, root);
      if (id !== self) targets.set(id, target);
      if (seen.has(id) || reported.has(id)) continue;
      seen.add(id);
      helpers.push(target);
      for (const record of graph.records(target))
        queue.push({ file: target.file, text: record.text });
    }
  }
  const order = [...graph.file(binding.file).locals.keys()];
  const local = helpers
    .filter((helper) => helper.file === binding.file)
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const remote = helpers
    .filter((helper) => helper.file !== binding.file)
    .map((helper) => [identity(helper, root), helper])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, helper]) => helper);
  return { helpers: [...local, ...remote], targets };
}

/** One export of an entry, described from its binding. */
function describe(graph, name, binding, root, reported, prefix = '') {
  const exportName = prefix + name;
  if (binding.type === 'external') {
    const doc = binding.doc ?? parseDoc(null);
    return [
      {
        name: exportName,
        kind: 'external',
        value: true,
        identity: identity(binding, root),
        declFile: null,
        tier: doc.tier,
        tiers: doc.tiers,
        summary: doc.summary,
        signature:
          binding.imported === '*'
            ? name.startsWith('* from')
              ? `export * from '${binding.source}'`
              : `export * as ${name} from '${binding.source}'`
            : `export { ${binding.imported} } from '${binding.source}'`,
        references: new Map(),
      },
    ];
  }
  if (binding.type === 'namespace') {
    const members = [...graph.exportsOf(binding.file)].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return [
      {
        name: exportName,
        kind: 'namespace-export',
        value: true,
        identity: identity(binding, root),
        declFile: binding.file,
        tier: null,
        tiers: [],
        summary: false,
        signature: `export * as ${name} from '${posix(relative(root, binding.file))}'`,
        references: new Map(),
        namespace: true,
      },
      ...members.flatMap(([member, inner]) =>
        describe(graph, member, inner, root, reported, `${exportName}.`),
      ),
    ];
  }
  const records = graph.records(binding);
  const kinds = [...new Set(records.map((record) => record.kind))];
  const documented = records.find((record) => record.doc.tiers.length > 0 || record.doc.summary);
  const doc = documented?.doc ?? records[0].doc;
  const texts = records.map((record) => record.text);
  const { helpers, targets } = referencedDeclarations(graph, binding, reported, root);
  const clauses = helpers.flatMap((helper) => {
    const label = helper.file === binding.file ? '' : `${identity(helper, root)}: `;
    return graph.records(helper).map((record) => `where ${label}${record.text}`);
  });
  const signature = [...texts, ...clauses].join('; ');
  return [
    {
      name: exportName,
      kind: kinds.join('+'),
      value: kinds.some((kind) => VALUE_KINDS.has(kind)),
      identity: identity(binding, root),
      declFile: binding.file,
      tier: doc.tier,
      tiers: doc.tiers,
      summary: doc.summary,
      signature,
      references: targets,
      binding,
    },
  ];
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** The package name of a bare specifier (`@scope/name/sub` -> `@scope/name`). */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The Node builtins and external packages the static import closure of a
 * compiled entry reaches. Relative imports and imports of another workspace
 * entry (`runtimeFiles`) are followed; type-only imports are not runtime.
 */
export function runtimeClosure(parseSync, entryJs, runtimeFiles, cache = new Map()) {
  const builtins = new Set();
  const externals = new Set();
  if (entryJs === null || !existsSync(entryJs)) return { builtins, externals };
  const seen = new Set();
  const queue = [entryJs];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let specifiers = cache.get(file);
    if (specifiers === undefined) {
      const parsed = parseSync(file, readFileSync(file, 'utf8'), { sourceType: 'module' });
      specifiers = [];
      for (const statement of parsed.program.body) {
        if (
          (statement.type === 'ImportDeclaration' ||
            statement.type === 'ExportAllDeclaration' ||
            statement.type === 'ExportNamedDeclaration') &&
          statement.source &&
          statement.importKind !== 'type' &&
          statement.exportKind !== 'type'
        ) {
          specifiers.push(statement.source.value);
        }
      }
      cache.set(file, specifiers);
    }
    for (const specifier of specifiers) {
      if (BUILTINS.has(specifier)) builtins.add(specifier.replace(/^node:/, ''));
      else if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        if (existsSync(target)) queue.push(target);
      } else if (runtimeFiles.has(specifier)) {
        queue.push(runtimeFiles.get(specifier));
      } else {
        externals.add(packageOf(specifier));
      }
    }
  }
  return { builtins, externals };
}

// ---------------------------------------------------------------------------
// The report model
// ---------------------------------------------------------------------------

/** The barrel directory depth of an entry that a declaring file sits under, or -1. */
function homeDepth(entry, declFile) {
  const dir = dirname(entry.types) + sep;
  return declFile.startsWith(dir) ? dir.length : -1;
}

/**
 * Builds the model of every entry: `{ entries: [{ ...entry, exports, platform }] }`.
 * Each export carries `home` (the specifier of its home entry).
 */
export async function buildModel({ root = defaultRoot, parseSync } = {}) {
  const parse = parseSync ?? (await loadParser());
  const workspaces = listWorkspaces(root).filter(
    (workspace) => workspace.manifest.private !== true,
  );
  const entries = workspaces.flatMap((workspace) => entriesOf(workspace));
  const entryFiles = new Map(entries.map((entry) => [entry.specifier, entry.types]));
  for (const entry of entries) {
    if (!existsSync(entry.types)) {
      throw new Error(
        `${entry.specifier}: ${posix(relative(root, entry.types))} is missing; build first`,
      );
    }
  }
  const graph = new DeclarationGraph(parse, entryFiles);
  // Private workspaces are not reported, but a published entry may still load them.
  const runtimeFiles = new Map(
    listWorkspaces(root)
      .flatMap((workspace) => entriesOf(workspace))
      .filter((entry) => entry.runtime !== null)
      .map((entry) => [entry.specifier, entry.runtime]),
  );
  const jsCache = new Map();
  const bindings = new Map(
    entries.map((entry) => [
      entry,
      [...graph.exportsOf(entry.types)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]),
  );
  const reported = new Set(
    [...bindings.values()].flatMap((list) => list.map(([, binding]) => identity(binding, root))),
  );
  for (const entry of entries) {
    entry.exports = bindings
      .get(entry)
      .flatMap(([name, binding]) => describe(graph, name, binding, root, reported));
    const closure = runtimeClosure(parse, entry.runtime, runtimeFiles, jsCache);
    entry.platform = closure.builtins.size > 0 ? 'node' : 'neutral';
    entry.builtins = [...closure.builtins].sort();
    entry.externals = [...closure.externals].sort();
  }
  // Home: among the entries exporting a declaration, the one whose barrel
  // directory is the deepest ancestor of the declaring file; else the first
  // non-root entry in manifest order; else the first entry.
  const exporters = new Map();
  for (const entry of entries) {
    for (const item of entry.exports) {
      if (!exporters.has(item.identity)) exporters.set(item.identity, []);
      exporters.get(item.identity).push(entry);
    }
  }
  for (const entry of entries) {
    for (const item of entry.exports) {
      const candidates = exporters.get(item.identity);
      let home = candidates[0];
      if (item.declFile !== null) {
        const scored = candidates
          .map((candidate) => [candidate, homeDepth(candidate, item.declFile)])
          .filter(([, depth]) => depth >= 0)
          .sort((a, b) => b[1] - a[1]);
        if (scored.length > 0) home = scored[0][0];
        else home = candidates.find((candidate) => candidate.subpath !== '.') ?? candidates[0];
      }
      item.home = home.specifier;
    }
  }
  return { root, entries, graph };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BUDGET_LINE = /^- value budget: (\d+)$/m;

/** The value budget recorded in a report file's text, or null. */
export function readBudget(text) {
  const match = BUDGET_LINE.exec(text ?? '');
  return match === null ? null : Number(match[1]);
}

function tierLabel(item) {
  if (item.tiers.length > 1) return item.tiers.join('+');
  return item.tier ?? 'untagged';
}

/** The report text of one entry, with the given value budget. */
export function renderEntry(entry, budget, root) {
  const own = entry.exports.filter((item) => item.home === entry.specifier);
  const values = entry.exports.filter((item) => item.value && !item.namespace).length;
  const types = entry.exports.filter((item) => !item.value).length;
  const lines = [
    `<!-- Generated by scripts/api-report.mjs from ${posix(relative(root, entry.types))}. Do not edit; run \`node scripts/api-report.mjs --write\`. -->`,
    '',
    `# ${entry.specifier}`,
    '',
    `- platform: ${entry.platform}${entry.builtins.length > 0 ? ` (${entry.builtins.join(', ')})` : ''}`,
    `- external runtime imports: ${entry.externals.length > 0 ? entry.externals.join(', ') : 'none'}`,
    `- exports: ${entry.exports.length} (values ${values}, types ${types})`,
    `- declared here: ${own.length}; re-exported: ${entry.exports.length - own.length}`,
    `- value budget: ${budget}`,
    '',
    'Each line: name | kind | tier | TSDoc summary | declaration (or the entry that declares it).',
    '',
    '```text',
  ];
  for (const item of entry.exports) {
    if (item.home !== entry.specifier) {
      lines.push(`${item.name} | re-export | ${tierLabel(item)} | - | from ${item.home}`);
    } else {
      const summary = item.namespace ? '-' : item.summary ? 'yes' : 'no';
      lines.push(
        `${item.name} | ${item.kind} | ${item.namespace ? '-' : tierLabel(item)} | ${summary} | ${item.signature}`,
      );
    }
  }
  lines.push('```', '');
  return lines.join('\n');
}

/** Value-export count of an entry (namespace re-export markers excluded). */
export function valueCount(entry) {
  return entry.exports.filter((item) => item.value && !item.namespace).length;
}

/**
 * The report files the model produces, as `Map<relativePath, text>`, given the
 * current files (for budgets). Returns `{ files, growth }`, where `growth`
 * lists entries whose value count exceeds their recorded budget.
 */
export function renderReport(model, current = new Map(), { allowGrowth = false } = {}) {
  const files = new Map();
  const growth = [];
  for (const entry of model.entries) {
    const count = valueCount(entry);
    const previous = readBudget(current.get(entry.report));
    let budget = count;
    if (previous !== null && count > previous) {
      if (allowGrowth) budget = count;
      else {
        growth.push(`${entry.specifier}: ${count} value exports, budget ${previous}`);
        budget = previous;
      }
    }
    files.set(entry.report, renderEntry(entry, budget, model.root));
  }
  return { files, growth };
}

/** Every `*.api.md` under `<root>/api`, as `Map<relativePath, text>`. */
export function readCurrentReport(root = defaultRoot) {
  const files = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.api.md'))
        files.set(posix(relative(root, path)), readFileSync(path, 'utf8'));
    }
  };
  walk(join(root, API_DIR_NAME));
  return files;
}

/** Differences between the expected and current report files, as messages. */
export function compareReport(expected, current) {
  const problems = [];
  for (const [path, text] of expected) {
    const existing = current.get(path);
    if (existing === undefined) {
      problems.push(`${path} is missing`);
      continue;
    }
    if (existing === text) continue;
    const want = text.split('\n');
    const have = existing.split('\n');
    const line = want.findIndex((value, index) => value !== have[index]);
    const at = line === -1 ? have.length : line;
    problems.push(
      `${path} is stale at line ${at + 1}:\n    report: ${(have[at] ?? '<end of file>').slice(0, 300)}\n    dist:   ${(want[at] ?? '<end of file>').slice(0, 300)}`,
    );
  }
  for (const path of current.keys()) {
    if (!expected.has(path)) problems.push(`${path} names no entry`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Tier and TSDoc findings, as `{ id, kind, message }` with a stable id. Only an
 * export's home entry reports it, so each declaration is judged once.
 */
export function findings(model) {
  const out = [];
  const byIdentity = new Map();
  for (const entry of model.entries) {
    for (const item of entry.exports) {
      if (item.home !== entry.specifier || item.namespace) continue;
      byIdentity.set(item.identity, { entry, item });
      const id = `${entry.specifier} ${item.name}`;
      if (item.tiers.length > 1) {
        out.push({
          id: `${id} conflicting-tiers`,
          kind: 'conflicting-tiers',
          message: `${id} carries ${item.tiers.map((t) => `@${t}`).join(' and ')}`,
        });
      } else if (item.tier === null) {
        out.push({
          id: `${id} untagged`,
          kind: 'untagged',
          message: `${id} has no @public, @experimental or @internal tag`,
        });
      }
      if (!item.summary)
        out.push({
          id: `${id} undocumented`,
          kind: 'undocumented',
          message: `${id} has no TSDoc summary`,
        });
      if (item.tier === 'experimental' && !/(^|\/)experimental$/.test(entry.specifier)) {
        out.push({
          id: `${id} experimental-outside`,
          kind: 'experimental-outside',
          message: `${id} is @experimental but ${entry.specifier} is not an /experimental entry`,
        });
      }
    }
  }
  // A @public declaration whose signature names an @internal one, directly or
  // through declarations no entry reports. The id carries the internal set, so
  // naming one more @internal declaration is a new finding.
  for (const { entry, item } of byIdentity.values()) {
    if (item.tier !== 'public') continue;
    const internal = [...item.references]
      .filter(([, target]) =>
        model.graph.records(target).some((record) => record.doc.tier === 'internal'),
      )
      .map(([id]) => id)
      .sort();
    if (internal.length > 0) {
      const id = `${entry.specifier} ${item.name}`;
      out.push({
        id: `${id} public-uses-internal ${internal.join(',')}`,
        kind: 'public-uses-internal',
        message: `${id} is @public but names @internal ${internal.join(', ')}`,
      });
    }
  }
  // One name, two declarations, across all entries. The id carries the home
  // entry of every declaration, so a further conflicting one is a new finding.
  const byName = new Map();
  for (const entry of model.entries) {
    for (const item of entry.exports) {
      if (item.name === 'default' || item.name.includes('.')) continue;
      if (!byName.has(item.name)) byName.set(item.name, new Map());
      byName.get(item.name).set(item.identity, item.home);
    }
  }
  for (const [name, homes] of byName) {
    if (homes.size < 2) continue;
    const where = [...homes.values()].sort();
    out.push({
      id: `duplicate ${name} ${where.join(',')}`,
      kind: 'duplicate',
      message: `${name} names ${homes.size} different declarations (${where.join(', ')})`,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The findings ledger
// ---------------------------------------------------------------------------

export const FINDINGS_LEDGER = 'scripts/expected-failures/api-untagged.json';

/** The default ledger reason of a finding kind (the last word of its id). */
export const FINDING_REASONS = Object.freeze({
  untagged:
    'Exported before stability tiers existed; KRN-21 tags every export from api/criteria.json.',
  undocumented: 'No TSDoc summary; KRN-21 documents every export it keeps.',
  'conflicting-tiers': 'Carries more than one tier tag; KRN-21 keeps one.',
  'public-uses-internal':
    'A @public signature names an @internal declaration; KRN-21 resolves the tiers.',
  'experimental-outside':
    'An @experimental export outside an /experimental entry; KRN-21 moves it.',
  duplicate:
    'One name bound to different declarations in two entries; KRN-21 gives each symbol one home.',
});

/** The ledger document for the current findings, keeping existing reasons. */
export function recordFindings(current, previous) {
  const kept = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry]));
  const entries = current.map(({ id, kind }) => {
    const existing = kept.get(id);
    if (existing !== undefined) return existing;
    return { id, reason: FINDING_REASONS[kind], fixedBy: 'KRN-21' };
  });
  return {
    description:
      previous?.description ??
      'API tier and TSDoc findings of scripts/api-report.mjs, ratcheted by scripts/gates/api-untagged.mjs. Emptied by KRN-21.',
    kind: 'gate',
    gate: 'api-untagged',
    entries,
  };
}

/**
 * Formats JSON the way the repository's Prettier config does. Prettier keeps
 * an object broken across lines when its first key starts a line, so
 * `indent` (passed to `JSON.stringify`) chooses between objects collapsed
 * wherever they fit (0) and every object expanded, one key per line.
 */
export async function formatJson(root, path, value, indent = 0) {
  const require = createRequire(join(defaultRoot, 'package.json'));
  const loaded = await import(pathToFileURL(require.resolve('prettier')).href);
  const prettier = typeof loaded.format === 'function' ? loaded : loaded.default;
  const options = (await prettier.resolveConfig(join(root, path))) ?? {};
  return prettier.format(JSON.stringify(value, null, indent), {
    ...options,
    filepath: join(root, path),
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Writes the report files and removes report files that name no entry. */
export function writeReport(root, files, current) {
  for (const [path, text] of files) {
    if (current.get(path) === text) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const path of current.keys()) {
    if (!files.has(path)) rmSync(join(root, path));
  }
}

/** Runs the check or the write; returns `{ status, messages }`. */
export async function main(argv, { root = defaultRoot } = {}) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const record = argv.includes('--record-findings');
  if ([write, check, record].filter(Boolean).length !== 1) {
    return {
      status: 2,
      messages: [
        'usage: node scripts/api-report.mjs --write [--allow-growth] | --check | --record-findings',
      ],
    };
  }
  const model = await buildModel({ root });
  if (record) {
    const path = join(root, FINDINGS_LEDGER);
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const document = recordFindings(findings(model), previous);
    writeFileSync(path, await formatJson(root, FINDINGS_LEDGER, document));
    return {
      status: 0,
      messages: [`recorded ${document.entries.length} finding(s) in ${FINDINGS_LEDGER}`],
    };
  }
  const current = readCurrentReport(root);
  const { files, growth } = renderReport(model, current, {
    allowGrowth: argv.includes('--allow-growth'),
  });
  if (write) {
    if (growth.length > 0) {
      return {
        status: 1,
        messages: [
          'value exports grew past the recorded budget (pass --allow-growth to accept):',
          ...growth.map((line) => `  ${line}`),
        ],
      };
    }
    writeReport(root, files, current);
    return { status: 0, messages: [`wrote ${files.size} report file(s) under ${API_DIR_NAME}/`] };
  }
  const problems = [
    ...growth.map((line) => `value budget exceeded: ${line}`),
    ...compareReport(files, current),
  ];
  return {
    status: problems.length === 0 ? 0 : 1,
    messages:
      problems.length === 0
        ? [`${files.size} report file(s) match dist`]
        : [
            ...problems,
            'run `node scripts/api-report.mjs --write` after a build and review the diff',
          ],
  };
}

if (import.meta.main) {
  try {
    const { status, messages } = await main(process.argv.slice(2));
    for (const message of messages) (status === 0 ? console.log : console.error)(message);
    process.exitCode = status;
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
