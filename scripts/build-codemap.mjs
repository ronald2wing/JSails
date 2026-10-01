/**
 * Generates `docs/CODEMAP.md`, the annotated source map, from the file tree.
 *
 * Every file line is annotated with the first sentence of that module's
 * leading `/** … *\/` header, every directory with the header of its
 * `index.ts` barrel or, for a directory without a barrel, with the summary
 * table below. The `jsails` subpath table comes from `core/package.json`
 * `exports`, and the package list from each workspace manifest. The map
 * therefore never names a file that does not exist, and `--check` fails when
 * the committed map is stale or a directory has no summary.
 *
 * Usage: node scripts/build-codemap.mjs            (rewrite docs/CODEMAP.md)
 *        node scripts/build-codemap.mjs --check    (exit 1 when stale)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { readManifest, repoRoot, workspaceDirs } from './workspaces.mjs';

const OUTPUT = join(repoRoot, 'docs', 'CODEMAP.md');
const SUMMARY_LIMIT = 110;
/** Width of a wrapped file listing (a template preset's files), tree prefix excluded. */
const LISTING_WIDTH = 88;

/**
 * Summaries for source directories that have no `index.ts` barrel. A directory
 * listed here that disappears is reported; a barrel-less directory missing
 * from here fails `--check`.
 */
const DIRECTORY_SUMMARIES = {
  'core/src/cli/commands':
    'one module per built-in CLI command; `plugins/` holds the plugin subcommands',
  'core/src/cli/commands/plugins':
    'the `jsails plugins` subcommands: list, check, resolve, install, state changes, snapshots',
  'core/src/client/decoding':
    'browser-safe decoding of server snapshots and island props (size limits)',
  'core/src/contracts':
    'type contracts shared across subpaths (no public subpath): http, render, component, awaitable',
  'core/src/entry': 'root-only public surfaces (no subpath): the `*-surface.ts` re-export clusters',
  'core/src/errors': 'the `JsailsError` base, error inspection, and value-free serialization',
  'core/src/jamal/production':
    'production deploys: plan, execute, release, proxy, hooks, history, transport, accessories',
  'core/src/json':
    'JSON shape guards and deep freeze (no public subpath; re-exported by `jsails/plugin-sdk`)',
  'core/src/jsx': 'render subpaths (no barrel; each file is its own subpath)',
  'core/src/migrations':
    'declarative, desired-state schema reconciliation (surfaced via `entry/migrations-surface.ts`)',
  'core/src/server':
    'the Hono HTTP pipeline (no public subpath; surfaced via `entry/http-surface.ts`)',
  'core/src/url': 'URL predicates and normalizers shared by routing, security, and the plugin SDK',
  'core/src/valkey': 'Valkey connection parsing, lazy clients, and value-free backend errors',
  'packages/admin/src/routes':
    'the admin HTTP routes: pages, actions, relations, and the resource CRUD/list handlers',
  'packages/admin/src/routes/resources': 'resource list, form, and CRUD route handlers',
  'packages/blog/src/search':
    'the blog search contract and its drivers (database, Orama, Meilisearch, Typesense, OpenSearch, HTTP)',
  'packages/diagnostics/src/watchers':
    'the request, query, and exception watchers and their registry',
  'packages/editor/src/editorjs':
    'the Editor.js adapter: document conversion, DOM mount, tools, and the media picker',
  'packages/theme/src/themes': 'the built-in theme packages',
  'core/templates':
    '`jsails create` presets; `createStarterFiles` copies files from a fixed allowlist',
  'core/templates/starter': 'the default static-site preset',
  'core/templates/starter-cli': 'the `--cli` preset (no web surface)',
  'core/templates/starter-web': 'the server-rendered presets: `--admin`, `--blog`, `--saas`',
};

const REPOSITORY_SECTION = `## Repository

\`\`\`text
jsails/
├── core/                    # the \`jsails\` package (tree below)
├── packages/<name>/         # one \`@jsails/<name>\` package each (list below)
├── website/                 # the docs site, itself a JSails app (not a workspace)
├── scripts/                 # repo tooling: workspace runner, gates, starter and integration verifiers
├── docs/                    # this map and design records (docs/design/)
├── tsconfig.base.json       # every compiler option and the src/test → dist layout, shared by every workspace
├── eslint.config.mjs        # type-checked lint for every workspace's src/ and test/, the docs site, and the tooling
└── AGENTS.md                # contributor guide (core/AGENTS.md is the app-author guide)
\`\`\`

Every workspace compiles \`src/\` and \`test/\` into its own \`dist/\`.
`;

const QUICK_REFERENCE = `## Quick reference

- **Language/runtime:** TypeScript, ESM only, Node \`>=26.0.0\`
- **Data:** TypeORM Active Record over MariaDB (default), Postgres, MySQL, or SQLite (\`sqljs\`); declarative schema via \`jsails db:push\`/\`db:diff\`
- **HTTP/render:** Hono + Preact SSR; filesystem-routed pages and API routes; static export
- **Interactivity:** Turbo soft navigation, hydrated Preact islands, signed server components
- **Deploy:** Jamal (local Docker Compose, Kamal-based production planning and execution)
- **Commands:** see the root \`AGENTS.md\` ("Commands" and "Verification discipline")
`;

const problems = [];

/** The first sentence of a module's leading block comment, or `undefined`. */
function headerSummary(file) {
  const source = readFileSync(file, 'utf8');
  const match = /^(?:#![^\n]*\n)?\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (match === null) return undefined;
  const text = match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .replace(/\{@link\s+([^}|]+)(?:\|[^}]*)?\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return undefined;
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  const trimmed = sentence.replace(/[.!?]$/, '');
  return trimmed.length > SUMMARY_LIMIT ? `${trimmed.slice(0, SUMMARY_LIMIT - 1)}…` : trimmed;
}

function directorySummary(dir) {
  const barrel = join(dir, 'index.ts');
  if (existsSync(barrel)) {
    const summary = headerSummary(barrel);
    if (summary !== undefined) return summary;
  }
  const key = relative(repoRoot, dir);
  const summary = DIRECTORY_SUMMARIES[key];
  if (summary === undefined) {
    problems.push(`${key}/: no index.ts header and no entry in DIRECTORY_SUMMARIES`);
    return '';
  }
  return summary;
}

function isSourceFile(name) {
  return /\.(?:ts|tsx|mjs)$/.test(name) && !name.endsWith('.d.ts');
}

/** Builds the nested node list for a source directory. */
function sourceTree(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || isSourceFile(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  return entries.map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return {
        name: `${entry.name}/`,
        summary: directorySummary(path),
        children: sourceTree(path),
      };
    }
    const summary = headerSummary(path);
    if (summary === undefined) problems.push(`${relative(repoRoot, path)}: no module header`);
    return { name: entry.name, summary: summary ?? '', children: [] };
  });
}

/**
 * Packs `names` into lines no wider than `width`, two spaces apart. A listing
 * (a preset's files) is one node whose continuation lines wrap beneath it
 * rather than one node per name, which would make the map as long as the tree.
 */
function wrapNames(names, width) {
  const lines = [];
  for (const name of [...names].sort()) {
    const current = lines.at(-1);
    if (current !== undefined && `${current}  ${name}`.length <= width) {
      lines[lines.length - 1] = `${current}  ${name}`;
    } else {
      lines.push(name);
    }
  }
  return lines;
}

/** A template preset as two listings: its directories and its top-level files. */
function templateTree(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => `${entry.name}/`);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  return [dirs, files].map((names) => {
    const [name = '', ...continuation] = wrapNames(names, LISTING_WIDTH);
    return { name, continuation, summary: '', children: [] };
  });
}

/**
 * Renders nodes as a box-drawing tree with aligned `#` annotations. The
 * annotation column is set by the annotated lines only, so an unannotated
 * listing never pushes every other annotation out to its own width.
 */
function renderTree(root, nodes) {
  const lines = [];
  const walk = (list, prefix) => {
    list.forEach((node, index) => {
      const last = index === list.length - 1;
      lines.push({ text: `${prefix}${last ? '└── ' : '├── '}${node.name}`, summary: node.summary });
      const childPrefix = `${prefix}${last ? '    ' : '│   '}`;
      for (const line of node.continuation ?? []) {
        lines.push({ text: `${childPrefix}${line}`, summary: '' });
      }
      walk(node.children, childPrefix);
    });
  };
  walk(nodes, '');
  const annotated = lines.filter((line) => line.summary !== '');
  const width = Math.max(0, ...annotated.map((line) => line.text.length)) + 2;
  return [
    root,
    ...lines.map((line) =>
      line.summary === '' ? line.text : `${line.text.padEnd(width)}# ${line.summary}`,
    ),
  ].join('\n');
}

function coreSection() {
  const core = join(repoRoot, 'core');
  const nodes = [
    {
      name: 'src/',
      summary: directorySummary(join(core, 'src')),
      children: sourceTree(join(core, 'src')),
    },
    {
      name: 'templates/',
      summary: directorySummary(join(core, 'templates')),
      children: ['starter', 'starter-cli', 'starter-web'].map((name) => ({
        name: `${name}/`,
        summary: directorySummary(join(core, 'templates', name)),
        children: templateTree(join(core, 'templates', name)),
      })),
    },
    {
      name: 'test/',
      summary: 'node:test suites mirroring src/ (fixtures/ holds shared harness code)',
      children: [],
    },
    {
      name: 'package.json',
      summary: 'dependencies and the `exports` map (table below)',
      children: [],
    },
    { name: 'AGENTS.md', summary: 'app-author guide, copied into generated apps', children: [] },
    { name: 'README.md', summary: 'npm package page', children: [] },
  ];
  return `## Core (\`core/\`)

A directory that is a package subpath carries an \`index.ts\` barrel; private
clusters are imported by deep path. The \`#\` annotations are the first sentence
of each module's header comment.

\`\`\`text
${renderTree('core/', nodes)}
\`\`\`
`;
}

function subpathSection() {
  const manifest = readManifest(join(repoRoot, 'core'));
  const rows = Object.entries(manifest.exports).map(([subpath, target]) => {
    const file = typeof target === 'string' ? target : target.default;
    const match = /^\.\/dist\/src\/(.+)\.js$/.exec(file);
    if (match === null)
      return `| \`${subpath}\` | \`${file.replace(/^\.\//, '')}\` | Package metadata |`;
    const stem = match[1];
    const source = stem.endsWith('/index')
      ? `src/${stem.slice(0, -'/index'.length)}/`
      : `src/${stem}.ts`;
    const sourceFile = join(repoRoot, 'core', source.endsWith('/') ? `${source}index.ts` : source);
    const summary = headerSummary(sourceFile) ?? '';
    if (summary === '')
      problems.push(`${relative(repoRoot, sourceFile)}: no module header (subpath ${subpath})`);
    return `| \`${subpath}\` | \`${source}\` | ${summary} |`;
  });
  return `## \`jsails\` export subpaths

Each row is a \`core/package.json\` \`exports\` entry; the note is the first
sentence of the barrel's header.

| Subpath | Source | Notes |
| --- | --- | --- |
${rows.join('\n')}
`;
}

function packagesSection() {
  const packages = workspaceDirs()
    .filter((dir) => basename(join(dir, '..')) === 'packages')
    .map((dir) => ({ dir, manifest: readManifest(dir) }))
    .sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1));
  const listing = packages.map(({ dir, manifest }) => {
    const kind = manifest.jsails === undefined ? 'library' : 'plugin';
    const subpaths = Object.keys(manifest.exports ?? {}).filter(
      (key) => key !== '.' && key !== './package.json',
    );
    const suffix = subpaths.length > 0 ? ` Subpaths: ${subpaths.join(', ')}.` : '';
    return {
      name: `${basename(dir)}/`,
      summary: `${manifest.name} (${kind}) — ${manifest.description}${suffix}`,
      children: [],
    };
  });
  const trees = packages
    .map(({ dir, manifest }) => {
      const src = join(dir, 'src');
      return `### \`${manifest.name}\`

\`\`\`text
${renderTree(`${relative(repoRoot, src)}/`, sourceTree(src))}
\`\`\`
`;
    })
    .join('\n');
  return `## Packages (\`packages/\`)

Each \`packages/<name>/\` has \`src/\`, \`test/\`, a \`README.md\`, and a
\`package.json\`. A plugin describes itself in the \`jsails\` field of its
\`package.json\`; a library has no plugin factory and no \`jsails\` field.

\`\`\`text
${renderTree('packages/', listing)}
\`\`\`

${trees}`;
}

function render() {
  return `# JSails Codemap

An annotated map of the repository source, generated by
\`scripts/build-codemap.mjs\` (\`npm run codemap\`) from the file tree and each
module's header comment, so every path below exists. Read
[architecture](https://jsails.org/docs/architecture) for the behavior and seams
behind these directories.

${REPOSITORY_SECTION}
${coreSection()}
${packagesSection()}
${subpathSection()}
${QUICK_REFERENCE}`;
}

const check = process.argv.includes('--check');
const output = render();

for (const key of Object.keys(DIRECTORY_SUMMARIES)) {
  if (!existsSync(join(repoRoot, key)))
    problems.push(`${key}/: listed in DIRECTORY_SUMMARIES but missing`);
}

if (problems.length > 0) {
  console.error(`build-codemap: ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
}

if (check) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== output) {
    console.error('build-codemap: docs/CODEMAP.md is stale; run `npm run codemap`.');
    process.exit(1);
  }
  if (problems.length > 0) process.exit(1);
  console.log('build-codemap: docs/CODEMAP.md is current.');
} else {
  writeFileSync(OUTPUT, output);
  console.log(`build-codemap: wrote ${relative(repoRoot, OUTPUT)}.`);
  if (problems.length > 0) process.exit(1);
}
