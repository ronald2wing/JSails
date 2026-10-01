/**
 * Tests for `runCreateCommand` (`jsails create`): scaffolding every preset, the
 * optional install, and the initial commit.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { runDevCommand, type DevCommandDeps } from '../../../src/cli/commands/app.js';
import {
  parsePackageDependencyFlags,
  runCreateCommand,
  shellWord,
  type CreateDeps,
} from '../../../src/cli/commands/create.js';
import {
  killOwnedProcessTree,
  type TreeKillChild,
  type TreeKillSpawn,
} from '../../../src/cli/owned-process-tree.js';
import {
  CLI_SUITE_CONCURRENCY,
  runCli as spawnCli,
  mapConcurrently,
  runProcess,
  type ProcessResult,
} from '../spawn-cli.js';

/**
 * Tests for the `create` and `dev` CLI commands.
 *
 * Unit tests drive `runCreateCommand` and `runDevCommand` directly with an
 * injected install/toolchain seam so no real `npm install`, compiler, or
 * watcher is ever started. Subprocess tests spawn the compiled CLI for the
 * argument-parsing, flag-restriction, help, and on-disk scaffold paths that
 * need the real entry point.
 */

/** Every file the server-rendered web starter must produce, order-independent (mirrors starter tests). */
const EXPECTED_FILES = [
  '.dockerignore',
  '.env.auth.example',
  '.gitignore',
  'AGENTS.md',
  'Dockerfile',
  'api/me.ts',
  'app/application-auth.ts',
  'app/application-client.ts',
  'app/application-command.ts',
  'app/application-component.ts',
  'app/application-plugin.ts',
  'app/application-resource.ts',
  'app/application-testing.ts',
  'auth/README.md',
  'client/main.tsx',
  'commands/login.ts',
  'commands/logout.ts',
  'commands/whoami.ts',
  'components/load-more-feed.tsx',
  'components/task-list.tsx',
  'jamal.config.ts',
  'jsails.app.js',
  'jsails.database.js',
  'package.json',
  'pages/about.tsx',
  'pages/dashboard.tsx',
  'pages/device.tsx',
  'pages/index.tsx',
  'pages/live.tsx',
  'pages/load-more.tsx',
  'pages/login.tsx',
  'pages/register.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/auth-migrate.mjs',
  'scripts/create-user.mjs',
  'scripts/db-push.mjs',
  'scripts/run-tests.mjs',
  'test/app.test.ts',
  'test/auth.test.ts',
  'test/browser/auth.spec.ts',
  'test/browser/fixtures.ts',
  'test/browser/home.spec.ts',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/class-names.ts',
  'ui/dialog.tsx',
  'ui/field.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/live-posts.tsx',
  'ui/register-form.tsx',
  'ui/styles.css',
  'ui/task-notes.ts',
  'vite.config.js',
].sort();

/** The `--saas` variant: the web starter set plus the tenant-scoped example model. */
const EXPECTED_SAAS_FILES = [...EXPECTED_FILES, 'models/project.ts'].sort();

/** Every file the `--cli` variant must produce (order-independent). */
const EXPECTED_CLI_FILES = [
  '.gitignore',
  'AGENTS.md',
  'app/application-command.ts',
  'commands/about.ts',
  'commands/hello.ts',
  'jsails.app.js',
  'package.json',
  'tsconfig.json',
].sort();

/** Every file the default `starter` shape must produce, order-independent (mirrors starter tests). */
const EXPECTED_STARTER_FILES = [
  '.gitignore',
  'AGENTS.md',
  'app/application-client.ts',
  'client/main.tsx',
  'content/about/about.md',
  'content/posts/islands-without-the-framework-tax.md',
  'content/posts/static-sites-with-typed-content.md',
  'content/posts/why-we-built-jsails.md',
  'jsails.app.js',
  'package.json',
  'pages/about.tsx',
  'pages/blog/[slug].tsx',
  'pages/blog/index.tsx',
  'pages/categories/[term].tsx',
  'pages/categories/index.tsx',
  'pages/index.tsx',
  'pages/load-more.tsx',
  'pages/tags/[term].tsx',
  'pages/tags/index.tsx',
  'scripts/generate-feeds.mjs',
  'server/content.ts',
  'shared/site.ts',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/components.tsx',
  'ui/layout.tsx',
  'ui/load-more.tsx',
  'ui/styles.css',
  'vite.config.js',
].sort();

const workspace = mkdtempSync(join(tmpdir(), 'jsails-create-cli-'));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A fresh absolute path under the workspace (absent until written). */
function caseDir(name: string): string {
  return join(workspace, name);
}

/** Recursively list relative file paths under `dir`, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort()) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(d, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

// ---------------------------------------------------------------------------
// unit: runCreateCommand
// ---------------------------------------------------------------------------

describe('runCreateCommand: scaffold', () => {
  it('writes the full 55-file starter set and derives the name', async () => {
    const dir = caseDir('fresh');
    const code = await runCreateCommand(dir, {
      admin: true,
      blog: false,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'fresh');
  });

  it('derives a valid npm name from a messy directory basename', async () => {
    const dir = caseDir('My App!');
    const code = await runCreateCommand(dir, {
      admin: true,
      blog: false,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'myapp');
    // Jamal's Compose project follows the app, so two apps never share one.
    assert.match(readFileSync(join(dir, 'jamal.config.ts'), 'utf8'), /^ {2}service: 'myapp',$/m);
  });

  it('honors an explicit --name', async () => {
    const dir = caseDir('named');
    const code = await runCreateCommand(dir, {
      name: 'my-counter',
      admin: true,
      blog: false,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'my-counter');
    assert.match(
      readFileSync(join(dir, 'jamal.config.ts'), 'utf8'),
      /^ {2}service: 'my-counter',$/m,
    );
  });

  it('honors a jsails dependency override', async () => {
    const dir = caseDir('dep-override');
    const code = await runCreateCommand(dir, {
      jsailsDependency: 'file:../jsails',
      admin: true,
      blog: false,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['jsails'], 'file:../jsails');
  });

  it('--cli writes the 8-file CLI-only set and no web surface', async () => {
    const dir = caseDir('cli-unit');
    const code = await runCreateCommand(dir, {
      admin: false,
      blog: false,
      cli: true,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_CLI_FILES);
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true, 'the CLI shape ships an app config');
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /plugins: \{ use: \[\] \}/);
    assert.doesNotMatch(appConfig, /commands:/);
    assert.equal(existsSync(join(dir, 'pages')), false, 'no pages/ in the CLI shape');
    assert.equal(existsSync(join(dir, 'api')), false, 'no api/ in the CLI shape');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'cli-unit');
    assert.equal(pkg.scripts['build'], 'tsc -p tsconfig.json');
    assert.equal(pkg.scripts['dev'], undefined, 'no dev script in the CLI shape');
  });

  it('rejects --cli combined with --admin or --blog without writing anything', async () => {
    for (const extra of [{ admin: true }, { blog: true }] as const) {
      const dir = caseDir(`cli-conflict-${'admin' in extra ? 'admin' : 'blog'}`);
      await assert.rejects(
        runCreateCommand(dir, {
          admin: false,
          blog: false,
          cli: true,
          install: false,
          git: false,
          ...extra,
        }),
        /options\.cli cannot be combined/,
      );
      assert.equal(existsSync(dir), false, 'no directory is created on a conflict');
    }
  });

  it('writes the 29-file default starter set and no server surface', async () => {
    const dir = caseDir('starter-unit');
    const code = await runCreateCommand(dir, {
      admin: false,
      blog: false,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_STARTER_FILES);
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true, 'the starter ships an app config');
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /use: \[\]/);
    assert.doesNotMatch(appConfig, /enabled:/);
    assert.equal(existsSync(join(dir, 'api')), false, 'no api/ in the starter shape');
    assert.equal(
      existsSync(join(dir, 'components')),
      false,
      'no server components in the starter shape',
    );
    assert.equal(
      existsSync(join(dir, 'jamal.config.ts')),
      false,
      'no Jamal config in the starter shape',
    );
    assert.equal(
      existsSync(join(dir, 'jsails.database.js')),
      false,
      'no database config in the starter shape',
    );
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'starter-unit');
    assert.match(pkg.scripts['build'] ?? '', /jsails build --config jsails\.app\.js/);
    assert.equal(pkg.scripts['auth:migrate'], undefined, 'no auth script in the starter shape');
  });

  it('rejects --starter combined with --admin, --blog, or --cli without writing anything', async () => {
    for (const extra of [{ admin: true }, { blog: true }, { cli: true }] as const) {
      const label = 'admin' in extra ? 'admin' : 'blog' in extra ? 'blog' : 'cli';
      const dir = caseDir(`starter-conflict-${label}`);
      await assert.rejects(
        runCreateCommand(dir, {
          admin: false,
          blog: false,
          starter: true,
          install: false,
          git: false,
          ...extra,
        }),
        /options\.(starter|cli) cannot be combined/,
      );
      assert.equal(existsSync(dir), false, 'no directory is created on a conflict');
    }
  });

  it('--admin adds the admin panel and its plugin id', async () => {
    const dir = caseDir('admin-unit');
    const code = await runCreateCommand(dir, {
      admin: true,
      blog: false,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /jsails\/admin/);
    assert.match(appConfig, /auth: authSessionToken/);
    assert.match(appConfig, /authorize: adminOnly,/);
    assert.equal(existsSync(join(dir, 'pages', 'reset-password.tsx')), false);
    assert.doesNotMatch(appConfig, /^\s*enabled:/m);
    assert.doesNotMatch(appConfig, /managed:/);
    assert.match(
      appConfig,
      /\['@jsails\/filesystem', \{ disks: \{ files: \{ driver: 'env' \} \} \}\]/,
    );
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
    assert.doesNotMatch(appConfig, /pluginManagerAdmin/);
  });

  it('--blog adds the blog plugin, admin, and the post page, with no plugin manager', async () => {
    const dir = caseDir('blog-unit');
    const code = await runCreateCommand(dir, { admin: false, blog: true, install: false });

    assert.equal(code, 0);
    assert.ok(!existsSync(join(dir, 'pages/blog/index.tsx')), 'no page claims /blog');
    assert.ok(existsSync(join(dir, 'pages/blog/[slug].tsx')), 'blog detail page is generated');
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /@jsails\/blog/);
    assert.match(appConfig, /blogAdmin/);
    assert.match(appConfig, /createDatabaseBlogRepository/);
    assert.doesNotMatch(appConfig, /pluginManagerAdmin/);
    assert.doesNotMatch(appConfig, /^\s*enabled:/m);
    assert.doesNotMatch(appConfig, /managed:/);
    assert.doesNotMatch(appConfig, /tenancy/);
    // One shared search engine, defaulting to Orama, feeds both surfaces.
    assert.match(appConfig, /createBlogSearchEngine/);
    assert.match(appConfig, /driver: process\.env\.SEARCH_DRIVER \?\? 'orama'/);
    assert.match(appConfig, /const search = createBlogSearchEngine\(\{/);
    assert.match(appConfig, /blogAdmin\(\{[\s\S]*?search,/);
    assert.match(appConfig, /'@jsails\/blog',[\s\S]*?search,/);
    // Developer mode: no plugin state store and no installer.
    assert.doesNotMatch(appConfig, /stateSource|installer:/);
    // The media library stores on the filesystem plugin's own `files` disk,
    // resolved per operation, and media metadata is persisted through the
    // shared database index.
    assert.doesNotMatch(appConfig, /createDiskFromEnv/);
    assert.match(appConfig, /disk: \(\) => facade\(filesystemToken\)\.disk\('files'\)/);
    assert.match(appConfig, /diskName: 'files'/);
    assert.match(
      appConfig,
      /\['@jsails\/filesystem', \{ disks: \{ files: \{ driver: 'env' \} \} \}\]/,
    );
    assert.match(appConfig, /createDatabaseMediaIndex\(\{ getDataSource \}\)/);
    assert.match(appConfig, /metadata: mediaIndex/);
    assert.match(appConfig, /createMediaLibrary\(\{[\s\S]*?metadata: mediaIndex/);
    const schemaConfig = readFileSync(join(dir, 'jsails.database.js'), 'utf8');
    assert.match(schemaConfig, /mediaEntities/);
    assert.match(schemaConfig, /\.\.\.mediaEntities/);
    assert.doesNotMatch(schemaConfig, /pluginStateEntities/);
  });

  it('--blog adds the standalone blog/editor/media workspace dependencies', async () => {
    const dir = caseDir('blog-deps-unit');
    const code = await runCreateCommand(dir, { admin: false, blog: true, install: false });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/blog'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/editor'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/media'], '^1.0.0');
  });

  it('--saas adds tenancy, flags, and the admin panel without blog wiring', async () => {
    const dir = caseDir('saas-unit');
    const code = await runCreateCommand(dir, {
      admin: false,
      blog: false,
      saas: true,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_SAAS_FILES);
    assert.match(
      readFileSync(join(dir, 'models/project.ts'), 'utf8'),
      /^@tenantScoped\('tenantId'\)\nexport class Project extends ApplicationRecord \{/m,
    );
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /from '@jsails\/tenancy'/);
    assert.match(appConfig, /'@jsails\/tenancy'/);
    assert.match(appConfig, /'@jsails\/flags'/);
    assert.match(appConfig, /\{ resolveTenant \}/);
    assert.doesNotMatch(appConfig, /x-tenant-slug/i);
    assert.match(appConfig, /defineAdminPanel/);
    assert.doesNotMatch(appConfig, /^\s*enabled:/m);
    assert.doesNotMatch(appConfig, /managed:/);
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
    assert.doesNotMatch(appConfig, /pluginManagerAdmin/);
  });

  it('--saas adds the tenancy/flags workspace dependencies alongside the admin extras', async () => {
    const dir = caseDir('saas-deps-unit');
    const code = await runCreateCommand(dir, {
      admin: false,
      blog: false,
      saas: true,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/tenancy'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/flags'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/admin'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/auth'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/mail'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/blog'], undefined);
  });

  it('rejects --saas combined with --admin or --blog without writing anything', async () => {
    for (const extra of [{ admin: true }, { blog: true }] as const) {
      const dir = caseDir(`saas-conflict-${'admin' in extra ? 'admin' : 'blog'}`);
      await assert.rejects(
        runCreateCommand(dir, {
          admin: false,
          blog: false,
          cli: false,
          starter: false,
          saas: true,
          install: false,
          git: false,
          ...extra,
        }),
        /options\.saas cannot be combined with options\.admin or options\.blog/,
      );
      assert.equal(existsSync(dir), false, 'no directory is created on a conflict');
    }
  });

  it('honors packageDependencies overrides for plugin tarballs', async () => {
    const dir = caseDir('pkg-dep-override');
    const code = await runCreateCommand(dir, {
      admin: true,
      blog: false,
      install: false,
      git: false,
      packageDependencies: { '@jsails/admin': 'file:/tmp/jsails-admin-1.0.0.tgz' },
    });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/admin'], 'file:/tmp/jsails-admin-1.0.0.tgz');
    assert.equal(pkg.dependencies['@jsails/auth'], '^1.0.0');
  });

  it('--admin and --blog add the standalone auth/mail workspace dependencies', async () => {
    for (const flags of [
      { admin: true, blog: false },
      { admin: false, blog: true },
    ] as const) {
      const dir = caseDir(`auth-mail-deps-${flags.blog ? 'blog' : 'admin'}`);
      const code = await runCreateCommand(dir, { ...flags, install: false, git: false });

      assert.equal(code, 0);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      };
      assert.equal(pkg.dependencies['@jsails/auth'], '^1.0.0');
      assert.equal(pkg.dependencies['@jsails/mail'], '^1.0.0');
      // Notifications are not used by the web starter.
      assert.equal(pkg.dependencies['@jsails/notifications'], undefined);
    }
  });

  it('rejects an invalid name without writing anything', async () => {
    const dir = caseDir('invalid-name');

    await assert.rejects(
      runCreateCommand(dir, {
        name: 'Invalid Name',
        admin: false,
        blog: false,
        install: false,
        git: false,
      }),
      /valid npm package name/,
    );
    assert.equal(existsSync(dir), false, 'no directory is created on an invalid name');
  });

  it('writes into an existing empty directory', async () => {
    const dir = caseDir('empty');
    mkdirSync(dir);

    const code = await runCreateCommand(dir, {
      admin: true,
      blog: false,
      install: false,
      git: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
  });

  it('refuses a non-empty target and leaves it unchanged', async () => {
    const dir = caseDir('nonempty');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'do not touch');

    await assert.rejects(
      runCreateCommand(dir, { admin: false, blog: false, install: false }),
      /not empty/,
    );

    assert.deepEqual(readdirSync(dir), ['keep.txt']);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'do not touch');
  });

  it('refuses a symlink target and leaves it unchanged', async () => {
    const real = caseDir('symlink-real');
    mkdirSync(real);
    const link = join(workspace, 'symlink-link');
    symlinkSync(real, link);

    await assert.rejects(
      runCreateCommand(link, { admin: false, blog: false, install: false }),
      /symbolic link/,
    );

    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink is untouched');
    assert.deepEqual(readdirSync(real), [], 'the symlink target is untouched');
  });
});

describe('runCreateCommand: install', () => {
  it('does not install unless requested', async () => {
    const dir = caseDir('no-install');
    let calls = 0;
    const deps: CreateDeps = {
      install: async () => {
        calls += 1;
        return 0;
      },
    };

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false }, deps);

    assert.equal(code, 0);
    assert.equal(calls, 0);
    assert.ok(existsSync(join(dir, 'package.json')));
  });

  it('invokes install inside the created target only when requested', async () => {
    const dir = caseDir('install');
    const installed: string[] = [];
    const deps: CreateDeps = {
      install: async (cwd) => {
        installed.push(cwd);
        return 0;
      },
    };

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: true }, deps);

    assert.equal(code, 0);
    assert.deepEqual(installed, [resolve(dir)]);
    assert.ok(existsSync(join(dir, 'package.json')));
  });

  it('keeps the project and propagates the exit code when install fails', async () => {
    const dir = caseDir('install-fails');
    const deps: CreateDeps = { install: async () => 3 };

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: true }, deps);

    assert.equal(code, 3);
    assert.ok(existsSync(join(dir, 'package.json')), 'the project is kept on install failure');
  });
});

describe('runCreateCommand: initial commit', () => {
  it('commits by default, after install', async () => {
    const dir = caseDir('commit-default');
    const order: string[] = [];
    const deps: CreateDeps = {
      install: async () => {
        order.push('install');
        return 0;
      },
      commit: async (cwd) => {
        order.push(`commit:${cwd}`);
        return { status: 'committed' };
      },
    };

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: true }, deps);

    assert.equal(code, 0);
    assert.deepEqual(order, ['install', `commit:${resolve(dir)}`]);
  });

  it('commits even when install is skipped', async () => {
    const dir = caseDir('commit-no-install');
    let committed = 0;
    const deps: CreateDeps = {
      commit: async () => {
        committed += 1;
        return { status: 'committed' };
      },
    };

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false }, deps);

    assert.equal(code, 0);
    assert.equal(committed, 1);
  });

  it('does not commit when git is disabled', async () => {
    const dir = caseDir('commit-disabled');
    let committed = 0;
    const deps: CreateDeps = {
      commit: async () => {
        committed += 1;
        return { status: 'committed' };
      },
    };

    const code = await runCreateCommand(
      dir,
      { admin: false, blog: false, install: false, git: false },
      deps,
    );

    assert.equal(code, 0);
    assert.equal(committed, 0);
  });

  it('keeps the project and exits 0 when the commit is skipped', async () => {
    const dir = caseDir('commit-skipped');
    const deps: CreateDeps = {
      commit: async () => ({ status: 'skipped', reason: 'git is not installed' }),
    };

    const code = await runCreateCommand(dir, { admin: false, blog: false, install: false }, deps);

    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, 'package.json')), 'the project is kept on a skipped commit');
  });
});

// ---------------------------------------------------------------------------
// unit: runDevCommand
// ---------------------------------------------------------------------------

describe('runDevCommand', () => {
  it('dispatches to runDev with the resolved config path', async () => {
    let captured: { configPath?: string } = {};
    const deps: DevCommandDeps = {
      runDev: async (options) => {
        captured = options;
        return 0;
      },
    };

    const code = await runDevCommand('jsails.app.js', deps);

    assert.equal(code, 0);
    assert.deepEqual(captured, { configPath: 'jsails.app.js' });
  });

  it('propagates the dev exit code and installs no signal handlers', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const deps: DevCommandDeps = { runDev: async () => 7 };

    const code = await runDevCommand('custom.app.js', deps);

    assert.equal(code, 7);
    assert.equal(process.listenerCount('SIGINT'), beforeInt, 'no SIGINT handler added');
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'no SIGTERM handler added');
  });
});

// ---------------------------------------------------------------------------
// owned process-tree teardown
// ---------------------------------------------------------------------------

describe('killOwnedProcessTree: arg assembly', () => {
  it('force-terminates the owned tree on win32 via taskkill.exe /PID /T /F', () => {
    const spawns: Array<{
      command: string;
      args: readonly string[];
      options: unknown;
    }> = [];
    let errorListener = false;
    const spawn: TreeKillSpawn = (command, args, options) => {
      spawns.push({ command, args, options });
      const child: TreeKillChild = {
        once(event) {
          if (event === 'error') errorListener = true;
        },
      };
      return child;
    };

    const result = killOwnedProcessTree(4321, 'SIGTERM', {
      platform: 'win32',
      spawn,
      systemRoot: 'C:\\Windows',
    });

    assert.equal(result, true);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0]?.command, 'C:\\Windows\\System32\\taskkill.exe');
    assert.deepEqual(spawns[0]?.args, ['/PID', '4321', '/T', '/F']);
    assert.deepEqual(spawns[0]?.options, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    assert.equal(errorListener, true, 'an error listener prevents an unhandled spawn error');
  });

  it('resolves taskkill.exe from a well-known SystemRoot when none is given', () => {
    let command = '';
    const spawn: TreeKillSpawn = (c) => {
      command = c;
      return { once() {} };
    };

    killOwnedProcessTree(1, 'SIGKILL', { platform: 'win32', spawn });

    assert.equal(command, 'C:\\Windows\\System32\\taskkill.exe');
  });

  it('swallows an already-gone PID on POSIX and reports it as false', () => {
    const spawn: TreeKillSpawn = () => ({ once() {} });

    const result = killOwnedProcessTree(999999999, 'SIGTERM', {
      platform: 'linux',
      spawn,
    });

    assert.equal(result, false);
  });
});

describe('parsePackageDependencyFlags', () => {
  it('splits repeated name=spec tokens into a map', () => {
    assert.deepEqual(
      parsePackageDependencyFlags([
        '@jsails/admin=file:/tmp/a.tgz',
        '@jsails/auth=file:/tmp/b.tgz',
      ]),
      { '@jsails/admin': 'file:/tmp/a.tgz', '@jsails/auth': 'file:/tmp/b.tgz' },
    );
  });

  it('returns an empty map for undefined or no entries', () => {
    assert.deepEqual(parsePackageDependencyFlags(undefined), {});
    assert.deepEqual(parsePackageDependencyFlags([]), {});
  });

  it('rejects a token with no name or no spec without echoing it', () => {
    assert.throws(() => parsePackageDependencyFlags(['=spec']), /is invalid: not_name_equals_spec/);
    assert.throws(() => parsePackageDependencyFlags(['name=']), /is invalid: not_name_equals_spec/);
    assert.throws(
      () => parsePackageDependencyFlags(['no-equals']),
      /is invalid: not_name_equals_spec/,
    );
  });

  it('rejects control characters value-free', () => {
    assert.throws(
      () => parsePackageDependencyFlags(['a\u0000=b']),
      /is invalid: control_character/,
    );
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI
// ---------------------------------------------------------------------------

function runCli(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return spawnCli(args, { cwd, env: env === undefined ? process.env : { ...process.env, ...env } });
}

/**
 * A commit identity supplied through the environment, so the real-commit tests
 * never depend on the machine's git config and never write to it.
 */
const GIT_IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'JSails Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'JSails Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

describe('cli: create subprocess', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  it('scaffolds a fresh project and prints the next steps', async () => {
    const result = await runCli(['create', 'sub-fresh', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listFiles(join(workspace, 'sub-fresh')), EXPECTED_STARTER_FILES);
    assert.match(result.stdout, /npm install/);
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /deploy the generated out\/ directory/);
    assert.doesNotMatch(result.stdout, /npm run dev/);
  });

  it('commits the scaffolded project by default', async () => {
    const result = await runCli(['create', 'sub-committed'], workspace, GIT_IDENTITY_ENV);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Committed the initial project/);
    assert.ok(existsSync(join(workspace, 'sub-committed', '.git')), '.git is created');

    const log = await runProcess('git', ['log', '--oneline'], {
      cwd: join(workspace, 'sub-committed'),
    });
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /chore: scaffold with jsails/);

    const status = await runProcess('git', ['status', '--porcelain'], {
      cwd: join(workspace, 'sub-committed'),
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim(), '', 'the whole scaffold is committed');
  });

  it('leaves no repository when --no-git is given', async () => {
    const result = await runCli(
      ['create', 'sub-uncommitted', '--no-git'],
      workspace,
      GIT_IDENTITY_ENV,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(workspace, 'sub-uncommitted', '.git')), false);
    assert.doesNotMatch(result.stdout, /Committed the initial project/);
  });

  it('derives the package name from the target directory', async () => {
    const result = await runCli(['create', 'my-new-app', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(join(workspace, 'my-new-app', 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'my-new-app');
  });

  it('honors --name and --jsails-dependency together', async () => {
    const result = await runCli(
      ['create', 'overridden', '--name', 'custom-pkg', '--jsails-dependency', 'file:../jsails'],
      workspace,
    );

    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(join(workspace, 'overridden', 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'custom-pkg');
    assert.equal(pkg.dependencies['jsails'], 'file:../jsails');
  });

  it('honors --package-dependency plugin tarball overrides', async () => {
    const result = await runCli(
      [
        'create',
        'sub-pkg-dep',
        '--admin',
        '--package-dependency',
        '@jsails/admin=file:/tmp/jsails-admin-1.0.0.tgz',
        '--package-dependency',
        '@jsails/auth=file:/tmp/jsails-auth-1.0.0.tgz',
      ],
      workspace,
    );

    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(
      readFileSync(join(workspace, 'sub-pkg-dep', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    assert.equal(pkg.dependencies['@jsails/admin'], 'file:/tmp/jsails-admin-1.0.0.tgz');
    assert.equal(pkg.dependencies['@jsails/auth'], 'file:/tmp/jsails-auth-1.0.0.tgz');
    assert.equal(pkg.dependencies['@jsails/mail'], '^1.0.0');
  });

  it('rejects malformed --package-dependency values without creating a directory', async () => {
    const cases: Array<{ args: string[]; leaked: string }> = [
      { args: ['--package-dependency', 'no-equals'], leaked: 'no-equals' },
      { args: ['--package-dependency', '=spec'], leaked: '=spec' },
      { args: ['--package-dependency', 'name='], leaked: 'name=' },
    ];
    for (const [{ args, leaked }, result] of await mapConcurrently(cases, ({ args }) =>
      runCli(['create', 'sub-pkg-dep-bad', ...args], workspace),
    )) {
      assert.equal(result.status, 1, `create ${args.join(' ')} must fail`);
      assert.doesNotMatch(result.stderr, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(existsSync(join(workspace, 'sub-pkg-dep-bad')), false);
    }
  });

  it('rejects a control character in --package-dependency value-free', async () => {
    const result = await runCli(
      ['create', 'sub-pkg-dep-bad', '--package-dependency', '@jsails/admin\u0001=file:x'],
      workspace,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is invalid: control_character/);
    assert.doesNotMatch(result.stderr, /file:x/);
    assert.equal(existsSync(join(workspace, 'sub-pkg-dep-bad')), false);
  });

  it('rejects --package-dependency on non-create commands', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['dev', '--package-dependency', 'a=b'],
        ['build', '--package-dependency', 'a=b'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--package-dependency/);
    }
  });

  it('--admin registers the admin panel and its plugin id', async () => {
    const result = await runCli(['create', 'sub-admin', '--admin', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const appConfig = readFileSync(join(workspace, 'sub-admin', 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /jsails\/admin/);
    assert.match(appConfig, /auth: authSessionToken/);
    assert.doesNotMatch(appConfig, /^\s*enabled:/m);
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
  });

  it('prints the web first run in the order that works, naming only real files and scripts', async () => {
    const firstRunName = (preset: string): string => `sub-first-run${preset.replace('--', '-')}`;
    for (const [preset, result] of await mapConcurrently(
      ['--admin', '--blog', '--saas'],
      (preset) => runCli(['create', firstRunName(preset), preset, '--no-git'], workspace),
    )) {
      const name = firstRunName(preset);
      assert.equal(result.status, 0, result.stderr);

      const lines = result.stdout.split('\n');
      const steps = lines.slice(lines.indexOf('Next steps:') + 1).filter((line) => line !== '');
      assert.deepEqual(
        steps,
        [
          `  cd ${name}`,
          '  npm install',
          '  cp .env.auth.example .env',
          '  # in .env set BETTER_AUTH_SECRET and JSAILS_COMPONENT_SECRET (each: openssl rand -base64 32), DATABASE_HOST=127.0.0.1, DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME, and DATABASE_ROOT_PASSWORD',
          '  npx jsails jamal up',
          '  npm run build',
          '  npm run db:push',
          '  npm run auth:migrate',
          '  npm run user:create -- <email> <password> --role admin',
          '  npm run dev',
        ],
        preset,
      );

      // Every file and script the steps name exists in the generated project.
      const dir = join(workspace, name);
      const example = readFileSync(join(dir, '.env.auth.example'), 'utf8');
      for (const variable of [
        'BETTER_AUTH_SECRET',
        'JSAILS_COMPONENT_SECRET',
        'DATABASE_HOST',
        'DATABASE_USER',
        'DATABASE_PASSWORD',
        'DATABASE_NAME',
        'DATABASE_ROOT_PASSWORD',
      ]) {
        assert.match(example, new RegExp(`^${variable}=$`, 'm'), `${preset} ${variable}`);
      }
      assert.ok(existsSync(join(dir, 'jamal.config.ts')), preset);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      for (const script of ['build', 'db:push', 'auth:migrate', 'user:create', 'dev']) {
        assert.ok(pkg.scripts[script] !== undefined, `${preset} has no "${script}" script`);
      }
    }
  });

  it('prints a cd step the shell reads back literally', async () => {
    // `"` cannot appear in a Windows file name; the other characters can.
    const dirName = process.platform === 'win32' ? "it's $HOME `x` q" : `it's $HOME \`x\` "q"`;
    const result = await runCli(['create', dirName, '--name', 'quoted-app', '--no-git'], workspace);
    assert.equal(result.status, 0, result.stderr);
    const cdLine = result.stdout.split('\n').find((line) => line.startsWith('  cd '));
    assert.ok(cdLine !== undefined);
    if (process.platform === 'win32') {
      // The step is POSIX sh syntax: Windows has no system sh, and Git's sh
      // reports an MSYS path (`/c/...`), so only the printed word is checked.
      assert.equal(cdLine, `  cd ${shellWord(dirName)}`);
      return;
    }
    const shell = await runProcess('sh', ['-c', `${cdLine.trim()} && pwd -P`], {
      cwd: workspace,
    });
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(shell.stdout.trim(), realpathSync(join(workspace, dirName)));
  });

  it('quotes a shell word only when it needs to', () => {
    assert.equal(shellWord('apps/my-app_1.0'), 'apps/my-app_1.0');
    assert.equal(shellWord('my app'), "'my app'");
    assert.equal(shellWord("it's"), "'it'\\''s'");
    assert.equal(shellWord('-app'), './-app');
  });

  it('--blog registers the admin panel, blog plugin, and the post page, with no plugin manager', async () => {
    const result = await runCli(['create', 'sub-blog', '--blog', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-blog');
    // The post page plus the theme helper are added on top of the 55-file base set (57
    // total); the blog plugin's own route serves `/blog`.
    assert.ok(!existsSync(join(dir, 'pages/blog/index.tsx')), 'no page claims /blog');
    assert.ok(existsSync(join(dir, 'pages/blog/[slug].tsx')), 'blog detail page is generated');
    assert.equal(listFiles(dir).length, 57);
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /@jsails\/blog/);
    assert.match(appConfig, /blogAdmin/);
    assert.match(appConfig, /createDatabaseBlogRepository/);
    assert.doesNotMatch(appConfig, /pluginManagerAdmin/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.doesNotMatch(appConfig, /^\s*enabled:/m);
    assert.doesNotMatch(appConfig, /tenancy/);
    // One shared search engine, defaulting to Orama, feeds both surfaces.
    assert.match(appConfig, /createBlogSearchEngine/);
    assert.match(appConfig, /driver: process\.env\.SEARCH_DRIVER \?\? 'orama'/);
    assert.match(appConfig, /const search = createBlogSearchEngine\(\{/);
    assert.match(appConfig, /blogAdmin\(\{[\s\S]*?search,/);
    assert.match(appConfig, /'@jsails\/blog',[\s\S]*?search,/);
    // Developer mode: no plugin state store and no installer.
    assert.doesNotMatch(appConfig, /stateSource|installer:/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/blog'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/editor'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/media'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/auth'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/mail'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/admin-plugin-manager'], undefined);
  });

  it('--saas scaffolds the 56-file web set with tenancy, flags, admin, and a scoped model', async () => {
    const result = await runCli(['create', 'sub-saas', '--saas', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-saas');
    assert.deepEqual(listFiles(dir), EXPECTED_SAAS_FILES);
    assert.equal(EXPECTED_SAAS_FILES.length, 56);
    assert.match(
      readFileSync(join(dir, 'models/project.ts'), 'utf8'),
      /^@tenantScoped\('tenantId'\)$/m,
    );
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /from '@jsails\/tenancy'/);
    assert.match(appConfig, /'@jsails\/flags'/);
    assert.match(appConfig, /\{ resolveTenant \}/);
    assert.doesNotMatch(appConfig, /x-tenant-slug/i);
    assert.match(appConfig, /defineAdminPanel/);
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
    // The saas shape prints the dev-server next steps, not the static deploy.
    assert.match(result.stdout, /npm run dev/);
    assert.doesNotMatch(result.stdout, /deploy the generated out\/ directory/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/tenancy'], '^1.0.0');
    assert.equal(pkg.dependencies['@jsails/flags'], '^1.0.0');
  });

  it('rejects --saas combined with --admin or --blog', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['create', 'sub-saas-admin', '--saas', '--admin'],
        ['create', 'sub-saas-blog', '--saas', '--blog'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /^jsails: --(admin|blog) cannot be combined with --saas$/m);
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --saas on non-create commands', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['dev', '--saas'],
        ['serve', '--saas'],
        ['build', '--saas'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--saas/);
    }
  });

  it('--cli scaffolds the 8-file CLI-only project with no web surface', async () => {
    const result = await runCli(['create', 'sub-cli', '--cli', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-cli');
    assert.deepEqual(listFiles(dir), EXPECTED_CLI_FILES);
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true);
    assert.equal(existsSync(join(dir, 'pages')), false);
    assert.equal(existsSync(join(dir, 'client')), false);
    assert.equal(existsSync(join(dir, 'vite.config.js')), false);
    // The CLI shape prints build/run next steps, not the dev server.
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /npx jsails hello/);
    assert.match(result.stdout, /npx jsails about/);
    assert.doesNotMatch(result.stdout, /npm run dev/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'sub-cli');
    assert.equal(pkg.scripts['build'], 'tsc -p tsconfig.json');
  });

  it('rejects --cli on non-create commands', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['dev', '--cli'],
        ['serve', '--cli'],
        ['build', '--cli'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--cli/);
    }
  });

  it('scaffolds the 29-file default starter project with no server surface', async () => {
    const result = await runCli(['create', 'sub-starter', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-starter');
    assert.deepEqual(listFiles(dir), EXPECTED_STARTER_FILES);
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true);
    assert.equal(existsSync(join(dir, 'pages/index.tsx')), true);
    assert.equal(existsSync(join(dir, 'pages/about.tsx')), true);
    assert.equal(existsSync(join(dir, 'client/main.tsx')), true);
    assert.equal(existsSync(join(dir, 'vite.config.js')), true);
    assert.equal(existsSync(join(dir, 'api')), false, 'no api/ in the starter shape');
    assert.equal(
      existsSync(join(dir, 'components')),
      false,
      'no server components in the starter shape',
    );
    assert.equal(
      existsSync(join(dir, 'jamal.config.ts')),
      false,
      'no Jamal config in the starter shape',
    );
    // The starter shape prints build + deploy next steps, not the dev server.
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /deploy the generated out\/ directory/);
    assert.doesNotMatch(result.stdout, /npm run dev/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'sub-starter');
    assert.match(pkg.scripts['build'] ?? '', /jsails build --config jsails\.app\.js/);
  });

  it('accepts the explicit --starter flag', async () => {
    const result = await runCli(
      ['create', 'sub-starter-explicit', '--starter', '--no-git'],
      workspace,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listFiles(join(workspace, 'sub-starter-explicit')), EXPECTED_STARTER_FILES);
  });

  it('rejects --starter on non-create commands', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['dev', '--starter'],
        ['serve', '--starter'],
        ['build', '--starter'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--starter/);
    }
  });

  it('rejects --starter combined with --admin, --blog, --saas, or --cli', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['create', 'sub-starter-admin', '--starter', '--admin'],
        ['create', 'sub-starter-blog', '--starter', '--blog'],
        ['create', 'sub-starter-saas', '--starter', '--saas'],
        ['create', 'sub-starter-cli', '--starter', '--cli'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(
        result.stderr,
        /^jsails: --starter cannot be combined with --(admin|blog|saas|cli)$/m,
      );
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --cli combined with --admin or --blog', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['create', 'sub-cli-admin', '--cli', '--admin'],
        ['create', 'sub-cli-blog', '--cli', '--blog'],
        ['create', 'sub-cli-both', '--cli', '--admin', '--blog'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(
        result.stderr,
        /^jsails: --(admin|blog) cannot be combined with (--blog or )?--cli$/m,
      );
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --admin and --blog on non-create commands', async () => {
    for (const [args, result] of await mapConcurrently(
      [
        ['dev', '--admin'],
        ['serve', '--blog'],
        ['build', '--admin'],
        ['work', '--blog'],
      ],
      (args) => runCli(args, workspace),
    )) {
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
    }
  });

  it('rejects the removed --auth flag', async () => {
    const result = await runCli(['create', 'sub-auth-flag', '--auth'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--auth/);
    assert.equal(existsSync(join(workspace, 'sub-auth-flag')), false);
  });

  it('rejects a missing target directory argument', async () => {
    const result = await runCli(['create'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^jsails: create requires <dir>$/m);
  });

  it('rejects --config (create needs no app config)', async () => {
    const result = await runCli(['create', 'with-config', '--config', 'jsails.app.js'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--config/);
    assert.equal(existsSync(join(workspace, 'with-config')), false);
  });

  it('rejects an invalid --name without creating the directory', async () => {
    const result = await runCli(['create', 'bad-name', '--name', 'Invalid Name'], workspace);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid npm package name/);
    assert.equal(existsSync(join(workspace, 'bad-name')), false);
  });

  it('refuses to overwrite a non-empty directory', async () => {
    const dir = join(workspace, 'occupied');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'sentinel');

    const result = await runCli(['create', 'occupied'], workspace);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not empty/);
    assert.deepEqual(readdirSync(dir), ['keep.txt']);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'sentinel');
  });
});

describe(
  'cli: dev subprocess (flag validation only, no toolchain)',
  { concurrency: CLI_SUITE_CONCURRENCY },
  () => {
    it('rejects every create- or migration-only flag before starting dev', async () => {
      const cases: Array<{ args: string[]; pattern: RegExp }> = [
        { args: ['dev', '--name', 'x'], pattern: /--name/ },
        {
          args: ['dev', '--jsails-dependency', 'file:../jsails'],
          pattern: /--jsails-dependency/,
        },
        { args: ['dev', '--install'], pattern: /--install/ },
        { args: ['dev', '--migrations', 'x'], pattern: /--migrations/ },
        { args: ['dev', '--allow-destructive'], pattern: /--allow-destructive/ },
      ];
      for (const [{ args, pattern }, result] of await mapConcurrently(cases, ({ args }) =>
        runCli(args, workspace),
      )) {
        assert.equal(result.status, 2, `dev ${args.slice(1).join(' ')} must be a usage error`);
        assert.match(result.stderr, pattern);
      }
    });

    it('rejects create-only flags on migration/app commands too', async () => {
      for (const [args, result] of await mapConcurrently(
        [
          ['db:push', '--install'],
          ['build', '--jsails-dependency', 'x'],
          ['serve', '--install'],
        ],
        (args) => runCli(args, workspace),
      )) {
        assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      }
    });
  },
);

describe('cli: help lists create and dev', () => {
  it('lists create and dev, and the presets in the help of create', async () => {
    const listing = await runCli(['--help'], workspace);
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /^ {2}create\s/m);
    assert.match(listing.stdout, /^ {2}dev\s/m);
    const result = await runCli(['create', '--help'], workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}jsails create \[options\] <dir>$/m);
    assert.match(result.stdout, /--starter/);
    assert.match(result.stdout, /--admin/);
    assert.match(result.stdout, /--blog/);
    assert.match(result.stdout, /--cli/);
    assert.match(result.stdout, /--saas/);
    assert.doesNotMatch(result.stdout, /--auth/);
  });
});
