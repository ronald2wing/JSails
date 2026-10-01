/**
 * Every first-party plugin is on the `definePlugin` contract of
 * `jsails/kernel` and passes its checks, or is listed in
 * `scripts/expected-failures/unconverted-plugins.json`, which only shrinks
 * (KRN-10b empties it).
 *
 * The inventory is every source file under `core/src` and `packages/<name>/src`
 * that calls `definePlugin(`, classified by the module it imports
 * `definePlugin` from: the kernel's (converted) or the legacy `JsailsPlugin`
 * identity helper of `jsails/extensions` (unconverted, so listed). A listed
 * file that is converted or gone fails until its entry is removed.
 *
 * A converted file's built module must export at least one `definePlugin`
 * factory, and each factory is checked:
 *
 * - its options schema, read from the runtime definition, follows the
 *   options rule (`checkOptionSchema`: data, `fn`, `tokenRef` and
 *   `moduleOption` only);
 * - it is proven inert: a test of its workspace (`core/test` or
 *   `packages/<name>/test`) awaits a harness run of it,
 *   `await testPlugin(<factory>(...))`, the form a passing run takes (a run
 *   expected to fail sits inside `assert.rejects`), so a plugin cannot be
 *   converted without the inert-setup proof;
 * - the public entry that exports it (the package entry, the core subpath
 *   of the file's directory, or a core subpath whose barrel re-exports it),
 *   imported in a fresh process whose resolve hook
 *   records every module, loads no `typeorm`, `better-auth` or `bullmq`, so
 *   listing the plugin in a config cannot pull a database, auth or queue
 *   runtime into the config's load.
 *
 * Agreement with a package's manifest is the `plugin-manifests` gate's, the
 * one agreement gate for both contracts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readGateLedger, ratchet } from '../expected-failures.mjs';
import { run as runProcess } from '../subprocess.mjs';
import { builtModule, classifyDeclaration, stripComments } from './plugin-manifests.mjs';

export const name = 'unconverted-plugins';
export const description =
  'every first-party plugin is on the definePlugin contract and passes its checks; unconverted plugins may only shrink';
export const needsBuild = true;

const posix = (path) => path.split(sep).join('/');

/** Packages a converted plugin's config entry must not load. */
export const FORBIDDEN_PACKAGES = Object.freeze(['typeorm', 'better-auth', 'bullmq']);

/** Every `.ts`/`.tsx` source file under `dir`, as repo-relative POSIX paths, sorted. */
function sourceFiles(root, dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'),
    )
    .map((entry) => posix(relative(root, join(entry.parentPath, entry.name))))
    .sort();
}

/**
 * The plugin declarations of the repository: `{ file, workspace, contract }`
 * or `{ file, error }`, where `workspace` is `core` or the package directory.
 */
export function inventory(root) {
  const roots = [{ workspace: 'core', src: join(root, 'core', 'src') }];
  const packages = join(root, 'packages');
  for (const entry of existsSync(packages) ? readdirSync(packages, { withFileTypes: true }) : []) {
    if (entry.isDirectory())
      roots.push({ workspace: entry.name, src: join(packages, entry.name, 'src') });
  }
  const declarations = [];
  for (const { workspace, src } of roots) {
    for (const file of sourceFiles(root, src)) {
      const classified = classifyDeclaration(readFileSync(join(root, file), 'utf8'));
      if (classified !== undefined) declarations.push({ file, workspace, ...classified });
    }
  }
  return declarations;
}

/**
 * The public specifier that exports a converted file's plugin: the package
 * itself, the core subpath whose entry lives in the file's directory, or else
 * the first core subpath whose barrel re-exports the file (`export * from`
 * its module), read through `readBarrel(sourcePath)`, which returns the
 * barrel's source text or `undefined`.
 */
export function publicEntry(file, corePackage, packageName, readBarrel = () => undefined) {
  if (!file.startsWith('core/')) return packageName;
  const built = builtModule(file).slice('core/'.length);
  const dir = `./${dirname(built)}/index.js`;
  const subpaths = Object.entries(corePackage.exports ?? {}).map(([subpath, target]) => ({
    specifier: subpath === '.' ? 'jsails' : `jsails/${subpath.slice(2)}`,
    value: typeof target === 'string' ? target : target?.default,
  }));
  const local = subpaths.find(({ value }) => value === dir);
  if (local !== undefined) return local.specifier;
  for (const { specifier, value } of subpaths) {
    const barrel = /^\.\/dist\/(src\/.+)\/index\.js$/.exec(value ?? '');
    if (barrel === null) continue;
    const source = readBarrel(`core/${barrel[1]}/index.ts`);
    if (source === undefined) continue;
    const target = posix(relative(barrel[1].slice('src/'.length), built.slice('dist/src/'.length)));
    const relativeTarget = target.startsWith('.') ? target : `./${target}`;
    if (source.includes(`export * from '${relativeTarget}'`)) return specifier;
  }
  return undefined;
}

/** The text of every test source under a workspace's `test/`, comments removed. */
function testSources(root, workspace) {
  const dir =
    workspace === 'core' ? join(root, 'core', 'test') : join(root, 'packages', workspace, 'test');
  return sourceFiles(root, dir).map((file) =>
    stripComments(readFileSync(join(root, file), 'utf8')),
  );
}

/**
 * Whether test source text awaits a harness run of a factory exported as one
 * of `names`: `await testPlugin(<name>(`.
 */
export function awaitsHarnessRun(sources, names) {
  return names.some((factory) => {
    const call = new RegExp(`\\bawait\\s+testPlugin\\(\\s*${factory}\\s*\\(`);
    return sources.some((source) => call.test(source));
  });
}

/** The forbidden packages among loaded module URLs, sorted. */
export function forbiddenLoads(urls) {
  const found = new Set();
  for (const url of urls) {
    for (const pkg of FORBIDDEN_PACKAGES) {
      if (url.includes(`/node_modules/${pkg}/`) || url.includes(`/node_modules/@${pkg}/`)) {
        found.add(pkg);
      }
    }
  }
  return [...found].sort();
}

/** A child process that imports `specifier` and prints every module URL resolved. */
const LOADED_SET_SCRIPT = `
import { registerHooks } from 'node:module';
const seen = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    seen.add(result.url);
    return result;
  },
});
await import(process.argv[1]);
process.stdout.write(JSON.stringify([...seen]));
`;

/** The module URLs importing `specifier` from `root` loads, or `undefined` when the import fails. */
async function loadedSet(root, specifier) {
  const result = await runProcess(
    process.execPath,
    ['--input-type=module', '--eval', LOADED_SET_SCRIPT, specifier],
    { cwd: root, capture: true },
  );
  return result.code === 0 ? JSON.parse(result.stdout) : undefined;
}

export async function run({ repoRoot }) {
  const failures = [];
  const declarations = inventory(repoRoot);
  for (const declaration of declarations.filter((entry) => entry.error !== undefined)) {
    failures.push(`${declaration.file}: ${declaration.error}`);
  }
  const legacy = declarations
    .filter((entry) => entry.contract === 'legacy')
    .map((entry) => entry.file);
  const { unlisted, fixed } = ratchet(readGateLedger(name, { root: repoRoot }), legacy);
  failures.push(
    ...unlisted.map(
      (file) =>
        `${file} declares a plugin with the legacy definePlugin; use definePlugin from jsails/kernel`,
    ),
    ...fixed.map(
      (file) => `fixed: ${file} is converted or gone; remove it from unconverted-plugins.json`,
    ),
  );

  const dist = join(repoRoot, 'core', 'dist', 'src', 'plugins');
  const [{ isPluginFactory }, { checkOptionSchema }] = await Promise.all(
    ['contract/define-plugin.js', 'contract/option-schemas.js'].map(
      (path) => import(pathToFileURL(join(dist, path)).href),
    ),
  );
  const corePackage = JSON.parse(readFileSync(join(repoRoot, 'core', 'package.json'), 'utf8'));
  const testsOf = new Map();

  for (const { file, workspace } of declarations.filter((entry) => entry.contract === 'kernel')) {
    const built = builtModule(file);
    if (built === undefined || !existsSync(join(repoRoot, built))) {
      failures.push(`${file}: no built module at ${built}; run the build`);
      continue;
    }
    const module = await import(pathToFileURL(join(repoRoot, built)).href);
    /** Each exported factory with every name it is exported under. */
    const factories = new Map();
    for (const [exportName, value] of Object.entries(module)) {
      if (!isPluginFactory(value)) continue;
      factories.set(value, [...(factories.get(value) ?? []), exportName]);
    }
    if (factories.size === 0) {
      failures.push(`${file}: calls the kernel definePlugin but exports no plugin factory`);
      continue;
    }
    if (!testsOf.has(workspace)) testsOf.set(workspace, testSources(repoRoot, workspace));
    for (const [{ definition }, names] of factories) {
      const label = `${file} (${definition.name})`;
      if (definition.options !== undefined) {
        for (const finding of checkOptionSchema(definition.options)) {
          failures.push(
            `${label}: option ${finding.path.join('.') || '(root)'} uses ${finding.construct}; options are data, fn(), tokenRef() or moduleOption()`,
          );
        }
      }
      if (!awaitsHarnessRun(testsOf.get(workspace), names)) {
        failures.push(
          `${label}: no test awaits testPlugin(${names[0]}(...)); prove its setup inert with the harness`,
        );
      }
    }

    const pkg =
      workspace === 'core'
        ? undefined
        : JSON.parse(readFileSync(join(repoRoot, 'packages', workspace, 'package.json'), 'utf8'));
    const entry = publicEntry(file, corePackage, pkg?.name, (path) =>
      existsSync(join(repoRoot, path)) ? readFileSync(join(repoRoot, path), 'utf8') : undefined,
    );
    if (entry === undefined) {
      failures.push(`${file}: its plugin is exported from no public entry of jsails`);
      continue;
    }
    const urls = await loadedSet(repoRoot, entry);
    if (urls === undefined) {
      failures.push(`${file}: importing ${entry} in a fresh process fails`);
      continue;
    }
    const loaded = forbiddenLoads(urls);
    if (loaded.length > 0) {
      failures.push(`${file}: importing ${entry} loads ${loaded.join(', ')}`);
    }
  }
  return failures;
}
