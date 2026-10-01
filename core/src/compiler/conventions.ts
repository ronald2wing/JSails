/**
 * The single source of truth for JSails authoring conventions.
 *
 * Every place that maps a symbol name to a file, or a file back to a symbol,
 * reads its rules here: the `make:*` generators, the autoload scan, model
 * resolution, server-component ids, and the kind of a `.jsails` file. When a
 * convention lived in four modules it drifted — a `make:model` file landed in a
 * different directory than the resolver looked, a naming helper disagreed with
 * another on acronym runs. One table removes that class of bug.
 *
 * Two concerns live here, deliberately together because they describe the same
 * authoring surface:
 *
 * - **Naming** — how a name splits into words and rejoins as Pascal/camel/kebab/
 *   snake case. The splitter is acronym-aware (`HTMLParser` → `HTML Parser`,
 *   not `htmlparser`), because a name like `OAuthToken` or `apiURL` is a real
 *   authoring input, not a pathological case. These deliberately differ from
 *   the general-purpose `Str` namespace (es-toolkit): a digit stays attached
 *   to its word (`v2Model` → `v2-model`, where `Str.kebab` gives `v-2-model`)
 *   and a `.` is not a separator (`my-component.server` → `MyComponent.server`,
 *   where `Str.pascal` gives `MyComponentServer`), because both are file-name
 *   conventions whose round trip through a class name must be lossless.
 * - **Layout** — which directory and extension each artifact kind uses, and
 *   which top-level trees the autoload scan covers.
 *
 * The parts of a `.jsails` component are the one such rule kept elsewhere, in
 * `routing/component-parts.ts`, because route discovery reads it in the
 * serving runtime, which does not load the compiler.
 *
 * Pure and inert: importing this module walks no directories and opens no
 * connection. The one filesystem read is {@link probeConventionFile}, called
 * explicitly by the resolvers.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/* ------------------------------------------------------------------ */
/*  Injection context                                                  */
/* ------------------------------------------------------------------ */

/** Injection context: `'app'` is client+server; `'server'` is server-only. */
export type AutoloadContext = 'app' | 'server';

/* ------------------------------------------------------------------ */
/*  Naming                                                             */
/* ------------------------------------------------------------------ */

/**
 * Split a name into words across camelCase boundaries, acronym runs, kebab-,
 * and snake_case separators.
 *
 * `BlogPost` → `['Blog', 'Post']`; `HTMLParser` → `['HTML', 'Parser']`;
 * `getHTMLId` → `['get', 'HTML', 'Id']`; `blog-post`/`blog_post` →
 * `['blog', 'post']`.
 */
export function toWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Capitalize a word, lowercasing the remainder (`HTML` → `Html`). */
function capitalizeWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** PascalCase (`blog-post` → `BlogPost`). */
export function pascalCase(name: string): string {
  return toWords(name).map(capitalizeWord).join('');
}

/** camelCase (`task-list` → `taskList`). */
export function camelCase(name: string): string {
  const words = toWords(name);
  const first = (words[0] ?? '').toLowerCase();
  const rest = words.slice(1).map(capitalizeWord);
  return first + rest.join('');
}

/** kebab-case (`BlogPost` → `blog-post`). */
export function kebabCase(name: string): string {
  return toWords(name)
    .map((word) => word.toLowerCase())
    .join('-');
}

/** snake_case (`BlogPost` → `blog_post`). */
export function snakeCase(name: string): string {
  return toWords(name)
    .map((word) => word.toLowerCase())
    .join('_');
}

/** Title Case for a human-facing label (`blog-post` → `Blog Post`). */
export function titleCase(name: string): string {
  return toWords(name).map(capitalizeWord).join(' ');
}

/** The PascalCase class name derived from a file path (`models/blog-post.ts` → `BlogPost`). */
export function classNameFromFile(fileName: string): string {
  const base = basename(fileName).replace(/\.(ts|tsx|mts|mtsx|js|jsx)$/, '');
  return pascalCase(base);
}

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

const conventionDirs = {
  pages: 'pages',
  api: 'api',
  jobs: 'jobs',
  models: 'models',
  commands: 'commands',
  serverComponents: 'components',
  serializers: 'serializers',
  middleware: 'middleware',
  content: 'content',
} as const;
/** Conventional artifact directories, as root-relative posix paths. */
export const CONVENTION_DIRS: typeof conventionDirs = Object.freeze(conventionDirs);

/**
 * The registry id of the server component at a project-relative posix path:
 * the path under `components/` without its extension, each segment
 * kebab-cased (`components/task-list.tsx` → `task-list`,
 * `components/admin/UserCard.tsx` → `admin/user-card`). A `.jsails`
 * component folder is named by its component path (`components/card.jsails`
 * for the folder `components/card/`), so it has the id `card` like the
 * single file it is interchangeable with.
 *
 * The one id helper: the meta scanner and the `.jsails` emitter both call it,
 * so the id the registry serves a component under and the id compiled code
 * signs into its snapshots cannot drift apart. Two files whose ids collide
 * (`task-list.tsx` beside `taskList.tsx`) are a duplicate-id assembly error.
 */
export function componentIdFor(posixRelPath: string): string {
  const prefix = `${CONVENTION_DIRS.serverComponents}/`;
  const relative = posixRelPath.startsWith(prefix)
    ? posixRelPath.slice(prefix.length)
    : posixRelPath;
  return relative
    .replace(/\.[^./]+$/, '')
    .split('/')
    .map(kebabCase)
    .join('/');
}

/** The `make:*` generator types, in help order. */
export const MAKE_COMMAND_TYPES = [
  'page',
  'api',
  'job',
  'model',
  'command',
  'server-component',
  'serializer',
  'middleware',
  'content',
] as const;

/** A supported `make:*` generator type. */
export type MakeCommandType = (typeof MAKE_COMMAND_TYPES)[number];

/** A generator's conventional output directory and file extension. */
export interface GeneratorLayout {
  readonly dir: string;
  readonly extension: string;
}

/** Conventional output directory and file extension for each generator type. */
export const GENERATOR_LAYOUT: Readonly<Record<MakeCommandType, GeneratorLayout>> = Object.freeze({
  page: { dir: CONVENTION_DIRS.pages, extension: '.tsx' },
  api: { dir: CONVENTION_DIRS.api, extension: '.ts' },
  job: { dir: CONVENTION_DIRS.jobs, extension: '.job.ts' },
  model: { dir: CONVENTION_DIRS.models, extension: '.ts' },
  command: { dir: CONVENTION_DIRS.commands, extension: '.ts' },
  'server-component': { dir: CONVENTION_DIRS.serverComponents, extension: '.tsx' },
  serializer: { dir: CONVENTION_DIRS.serializers, extension: '.ts' },
  middleware: { dir: CONVENTION_DIRS.middleware, extension: '.ts' },
  content: { dir: CONVENTION_DIRS.content, extension: '.md' },
});

/** Source extensions accepted as modules by the autoload scan. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mtsx',
  '.js',
  '.jsx',
  '.mjs',
]);

/** Extensions probed for a model module, in order. */
export const MODEL_EXTENSIONS = ['.ts', '.mts', '.tsx', '.mtsx', '.js', '.jsx'] as const;

/* ------------------------------------------------------------------ */
/*  Autoload scope                                                     */
/* ------------------------------------------------------------------ */

/**
 * Top-level directories that define the autoload scan scope. Each entry is
 * `[dirname, context]`. `shared/` maps to `'app'` because its modules are
 * accessible from both client and server.
 *
 * The server-only trees (`models/`, `jobs/`, `commands/`, `services/`,
 * `extensions/`, `components/`) are scanned so their symbols become autoloadable.
 * `ui/` is an app-context provider: starter components use a standout `Ui*`
 * prefix, so app-wide autoloading stays legible and collision-safe.
 * `pages/` and `api/` are deliberately absent: every page exports
 * `metadata`/`load`/`default` and every API module exports HTTP method names,
 * so including them would only manufacture same-context duplicate-symbol
 * errors without contributing an injectable symbol.
 */
export const AUTOLOAD_DIRECTORIES: readonly (readonly [string, AutoloadContext])[] = Object.freeze([
  ['app', 'app'],
  ['server', 'server'],
  ['shared', 'app'],
  ['models', 'server'],
  ['ui', 'app'],
  ['jobs', 'server'],
  ['commands', 'server'],
  ['services', 'server'],
  ['extensions', 'server'],
  ['components', 'server'],
]);

/**
 * Subdirectories whose modules are auto-imported (contribute `symbols`).
 * Checked by prefix match: `app/utils/helpers/foo.js` matches `app/utils`.
 *
 * A whole-tree entry (`models/`) makes every module under it autoloadable; the
 * server-only trees are whole-tree because a model, job, command, domain
 * service, extension, server component, or server config module is a top-level artifact, not a
 * helper nested in a utils dir. `shared/` and `server/` are whole-tree for the
 * same reason: a shared site config or a server-only content config sits at the
 * root of its tree, so a nested-only prefix would not reach it.
 */
export const AUTOLOADABLE_PREFIXES: ReadonlySet<string> = new Set([
  'app/composables/',
  'app/utils/',
  'server/',
  'shared/',
  'models/',
  'ui/',
  'jobs/',
  'commands/',
  'services/',
  'extensions/',
  'components/',
]);

/**
 * Per-directory symbol filters. `ui/` publishes components only: a PascalCase
 * named value export. Helpers and constants (`loadLayout`, `INITIAL_COUNT`)
 * stay explicit imports.
 */
export function isUiComponentExport(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

/** Directory name -> export-name filter. Unlisted directories admit every name. */
export const AUTOLOAD_SYMBOL_FILTERS: Readonly<Record<string, (name: string) => boolean>> =
  Object.freeze({ ui: isUiComponentExport });

/* ------------------------------------------------------------------ */
/*  Resolution                                                         */
/* ------------------------------------------------------------------ */

/**
 * Find the first existing file for a kebab-case base name in `dir`, probing
 * `extensions` in order. Returns `undefined` when no candidate exists.
 *
 * The existence check reads the filesystem; nothing is imported.
 */
export function probeConventionFile(
  dir: string,
  baseName: string,
  extensions: readonly string[],
): string | undefined {
  for (const extension of extensions) {
    const candidate = join(dir, baseName + extension);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  .jsails kinds                                                      */
/* ------------------------------------------------------------------ */

/**
 * What a `.jsails` file compiles to, decided by where it lives (sfc-plan
 * §2.2): a page, its layout, error and not-found pages, a live server
 * component, a hydrated island, a mail, or a plain view.
 */
export type SfcKind =
  'page' | 'layout' | 'error' | 'not-found' | 'live' | 'island' | 'mail' | 'view';

/** Every {@link SfcKind}, in the order of the kind table. */
export const SFC_KINDS: readonly SfcKind[] = Object.freeze([
  'page',
  'layout',
  'error',
  'not-found',
  'live',
  'island',
  'mail',
  'view',
]);

/** The directory whose `.jsails` files are islands. */
const ISLANDS_DIR = 'islands';

/** The path of an island under `islands/`, without its extension. */
function islandPath(posixRelPath: string): string {
  const prefix = `${ISLANDS_DIR}/`;
  const relative = posixRelPath.startsWith(prefix)
    ? posixRelPath.slice(prefix.length)
    : posixRelPath;
  return relative.replace(/\.[^./]+$/, '');
}

/**
 * The hydration id of the island at a project-relative posix path: the path
 * under `islands/` without its extension, each segment kebab-cased
 * (`islands/admin/user-card.jsails` → `admin/user-card`), as
 * {@link componentIdFor} names a live component. A folder island is named
 * by its component path. The compiled module passes it to `defineIsland`,
 * so the server markup and the browser registry read the id from the module
 * itself.
 */
export function islandIdFor(posixRelPath: string): string {
  return islandPath(posixRelPath).split('/').map(kebabCase).join('/');
}

/**
 * Whether an island's path under `islands/` already is its id, every folder
 * and file name in kebab case (`load-more.jsails`, not `LoadMore.jsails`).
 * The compiler requires it, so two island files never share an id: the
 * browser registry refuses a duplicate, and nothing that compiles one file
 * at a time could see the other.
 */
export function islandPathIsId(posixRelPath: string): boolean {
  return islandPath(posixRelPath) === islandIdFor(posixRelPath);
}

/** The page-tree file names that are not routes, by kind. */
const PAGE_FILE_KINDS: Readonly<Record<string, SfcKind>> = Object.freeze({
  'layout.jsails': 'layout',
  'error.jsails': 'error',
  'not-found.jsails': 'not-found',
});

/**
 * The kind of the `.jsails` file at a project-relative posix path. Only the
 * location decides it, never the file's content, so the compiler, the
 * project index and the client/server boundary read one table and a file
 * cannot move itself across the server boundary by what it declares.
 *
 * `pages/**` gives pages (`layout`, `error` and `not-found` by their file
 * names), `components/**` live components, `islands/**` islands, `mail/**`
 * mails, and every other path a view (`ui/**`, `app/**`, a package's
 * `src/**`). A component folder is passed as its component path
 * (`components/x.jsails` for `components/x/x.jsails`), so it has the kind of
 * its location like a single file.
 */
export function sfcKind(posixRelPath: string): SfcKind {
  const segments = posixRelPath.split('/');
  const top = segments.length > 1 ? segments[0] : undefined;
  if (top === CONVENTION_DIRS.pages) {
    const base = segments[segments.length - 1] ?? '';
    return Object.hasOwn(PAGE_FILE_KINDS, base) ? (PAGE_FILE_KINDS[base] as SfcKind) : 'page';
  }
  if (top === CONVENTION_DIRS.serverComponents) {
    return 'live';
  }
  if (top === ISLANDS_DIR) {
    return 'island';
  }
  if (top === 'mail') {
    return 'mail';
  }
  return 'view';
}
