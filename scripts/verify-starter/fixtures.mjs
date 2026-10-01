/**
 * The generated apps under test: the packed framework and plugin tarballs,
 * one fixture per server-rendered preset (`--admin`, `--blog`, `--saas`), and
 * the real `jsails create --install` that scaffolds each one from those
 * tarballs. Everything lives under a per-run temp root that is removed on
 * exit; nothing is installed into the framework workspace.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { npm } from '../subprocess.mjs';
import { readManifest, repoRoot } from '../workspaces.mjs';
import { NPM_TIMEOUT_MS, runCommand } from './processes.mjs';

const TEMP_ROOT = join(tmpdir(), `jsails-verify-${process.pid}-${Date.now().toString(36)}`);
const PACK_DIR = join(TEMP_ROOT, 'pack');

/** The framework's own freshly built CLI, which runs `create`. */
export const REPO_CLI = join(repoRoot, 'core', 'dist', 'src', 'cli', 'index.js');

/**
 * The `@jsails/*` workspaces a preset installs: its direct plugins plus every
 * workspace they depend on (dependencies and peers, transitively), so a new
 * plugin-to-plugin dependency is packed without editing a list.
 */
function withWorkspaceDependencies(direct) {
  const closure = new Set();
  const visit = (name) => {
    if (closure.has(name)) return;
    closure.add(name);
    const manifest = readManifest(join(repoRoot, 'packages', name.slice('@jsails/'.length)));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      if (dependency.startsWith('@jsails/')) visit(dependency);
    }
  };
  direct.forEach(visit);
  return [...closure].sort();
}

const ADMIN_PLUGINS = [
  '@jsails/admin',
  '@jsails/admin-plugin-manager',
  '@jsails/auth',
  '@jsails/cache',
  '@jsails/editor',
  '@jsails/filesystem',
  '@jsails/live',
  '@jsails/mail',
  '@jsails/theme',
];

/** A fixture: the preset it is created with, where it lives, and the plugins it installs. */
function fixture(stage, preset, dirName, name, directPlugins) {
  return Object.freeze({
    /** The `generate-*` stage that creates it. */
    stage,
    /** The `jsails create` preset flag. */
    preset,
    dir: join(TEMP_ROOT, dirName),
    name,
    plugins: withWorkspaceDependencies(directPlugins),
  });
}

/**
 * The admin fixture is the one every later stage drives. Its directory name
 * deliberately contains spaces and a literal `$` to prove no step
 * shell-interpolates project paths.
 */
export const ADMIN_FIXTURE = fixture(
  'generate-fixture',
  '--admin',
  'fixture with space$dollar',
  'jsails-verify-fixture',
  ADMIN_PLUGINS,
);
export const BLOG_FIXTURE = fixture(
  'generate-blog-fixture',
  '--blog',
  'blog fixture',
  'jsails-verify-blog-fixture',
  [...ADMIN_PLUGINS, '@jsails/blog', '@jsails/media'],
);
export const SAAS_FIXTURE = fixture(
  'generate-saas-fixture',
  '--saas',
  'saas fixture',
  'jsails-verify-saas-fixture',
  [...ADMIN_PLUGINS, '@jsails/tenancy', '@jsails/flags'],
);

/** Every workspace plugin some fixture installs. */
const PACK_PLUGINS = [
  ...new Set([...ADMIN_FIXTURE.plugins, ...BLOG_FIXTURE.plugins, ...SAAS_FIXTURE.plugins]),
].sort();

/** The packaged CLI installed into `fixtureDir`, which runs `serve` and `dev`. */
export function installedCli(fixtureDir) {
  return join(fixtureDir, 'node_modules', 'jsails', 'dist', 'src', 'cli', 'index.js');
}

/**
 * The tarball filename prefix npm uses for a package name: `@scope/name`
 * becomes `scope-name` (npm drops `@` and replaces `/` with `-`).
 */
function tarballPrefix(packageName) {
  return packageName.replace(/^@/, '').replace(/\//g, '-');
}

/**
 * Packs `jsails` and every plugin the fixtures install into the temp root, so
 * the created projects install them from local tarballs rather than
 * unpublished npm versions. Resolves with the framework tarball path, the
 * plugin tarball paths by package name, and the tarball file names.
 */
export async function packWorkspaces() {
  mkdirSync(PACK_DIR, { recursive: true });
  const workspaces = ['jsails', ...PACK_PLUGINS];
  // One invocation avoids reloading npm and the workspace graph per package.
  await runCommand(
    npm,
    ['pack', ...workspaces.map((name) => `--workspace=${name}`), '--pack-destination', PACK_DIR],
    { cwd: repoRoot, label: 'npm pack starter workspaces' },
  );
  const files = readdirSync(PACK_DIR).filter((file) => file.endsWith('.tgz'));
  if (files.length !== workspaces.length) {
    throw new Error(
      `expected ${workspaces.length} .tgz in ${PACK_DIR}, found ${JSON.stringify(files)}`,
    );
  }
  // npm names a tarball `<prefix>-<version>.tgz` (e.g. `jsails-admin-1.0.0.tgz`).
  const byPrefix = new Map(
    files.map((file) => [file.replace(/-\d+\.\d+\.\d+.*\.tgz$/, ''), join(PACK_DIR, file)]),
  );
  const resolve = (prefix) => {
    const path = byPrefix.get(prefix);
    if (path === undefined) throw new Error(`no packed tarball for ${JSON.stringify(prefix)}`);
    return path;
  };
  return {
    jsails: resolve('jsails'),
    plugins: new Map(PACK_PLUGINS.map((name) => [name, resolve(tarballPrefix(name))])),
    files,
  };
}

/**
 * Scaffolds `fixture` with the real `jsails create` CLI and a real
 * `npm install`, then checks that the created manifest and `node_modules`
 * carry the packed framework and every packed plugin.
 *
 * The install is isolated through npm's environment config so no lifecycle
 * hook runs in the public dependency graph, and `prefer-offline` serves it
 * from the local npm cache when possible: the three fixtures share one public
 * dependency graph, so a warm cache makes every fetch a hit and npm goes
 * straight to reify (measured 16 s to 11 s per install). The flag never
 * changes what is installed, only where npm reads it from. Sharing one tree
 * between fixtures was rejected: their transitive `@jsails/*` graphs differ,
 * and hardlink sharing corrupts under npm reify, which mutates files in place.
 */
export async function createFixture(fixture, tarballs) {
  const packageDependencyArgs = fixture.plugins.flatMap((name) => [
    '--package-dependency',
    `${name}=file:${tarballs.plugins.get(name)}`,
  ]);
  await runCommand(
    process.execPath,
    [
      REPO_CLI,
      'create',
      fixture.dir,
      '--name',
      fixture.name,
      '--jsails-dependency',
      `file:${tarballs.jsails}`,
      fixture.preset,
      ...packageDependencyArgs,
      '--install',
    ],
    {
      cwd: repoRoot,
      env: {
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_prefer_offline: 'true',
      },
      timeoutMs: NPM_TIMEOUT_MS,
      label: `jsails create ${fixture.preset} --install`,
    },
  );
  const label = `create ${fixture.preset} --install`;
  const manifestPath = join(fixture.dir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${label} produced no package.json under ${fixture.dir}`);
  }
  if (!existsSync(join(fixture.dir, 'node_modules', 'jsails', 'package.json'))) {
    throw new Error(`${label} did not install the packaged jsails dependency`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== fixture.name) {
    throw new Error(`created package name ${JSON.stringify(manifest.name)} != ${fixture.name}`);
  }
  if (manifest.dependencies?.jsails !== `file:${tarballs.jsails}`) {
    throw new Error(
      `created package jsails dependency ${JSON.stringify(manifest.dependencies?.jsails)} != file:${tarballs.jsails}`,
    );
  }
  for (const name of fixture.plugins) {
    const expected = `file:${tarballs.plugins.get(name)}`;
    if (manifest.dependencies?.[name] !== expected) {
      throw new Error(
        `created package ${name} dependency ${JSON.stringify(manifest.dependencies?.[name])} != ${expected}`,
      );
    }
    if (!existsSync(join(fixture.dir, 'node_modules', name, 'package.json'))) {
      throw new Error(`${label} did not install the packaged ${name} tarball`);
    }
  }
  return `scaffolded + installed ${fixture.name} via the real create CLI`;
}

/** Runs the fixture's own `npm run check`. */
export async function checkFixture(fixture) {
  await runCommand(npm, ['run', 'check'], {
    cwd: fixture.dir,
    label: `${fixture.name} npm run check`,
  });
}

/** Removes the temp root; a leftover directory is preferable to failing the run on cleanup. */
export function removeTempRoot() {
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // Reported nowhere on purpose: the run's result must not depend on cleanup.
  }
}
