import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  npmInstallSpawn,
  runCreateCommand,
  runDevCommand,
  type CreateDeps,
  type DevCommandDeps,
} from '../../src/cli/dispatch.js';
import { parsePackageDependencyFlags } from '../../src/cli/create-commands.js';
import {
  killOwnedProcessTree,
  type TreeKillChild,
  type TreeKillSpawn,
} from '../../src/cli/owned-process-tree.js';
import { createCliCommandRegistry } from '../../src/cli/command-registry.js';

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
  '.env.auth.example',
  '.gitignore',
  'AGENTS.md',
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
  'components/task-list.tsx',
  'jamal.config.js',
  'jsails.app.js',
  'jsails.config.js',
  'package.json',
  'pages/about.tsx',
  'pages/dashboard.tsx',
  'pages/device.tsx',
  'pages/index.tsx',
  'pages/live.tsx',
  'pages/login.tsx',
  'pages/register.tsx',
  'pages/reset-password.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/auth-migrate.mjs',
  'scripts/create-user.mjs',
  'scripts/db-migrate.mjs',
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
  'ui/reset-password.tsx',
  'ui/styles.css',
  'ui/task-notes.ts',
  'vite.config.js',
].sort();

/** Every file the `--cli` variant must produce (order-independent). */
const EXPECTED_CLI_FILES = [
  '.gitignore',
  'AGENTS.md',
  'app/application-command.ts',
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
  'pages/tags/[term].tsx',
  'pages/tags/index.tsx',
  'scripts/generate-feeds.mjs',
  'server/content.ts',
  'shared/site.ts',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/components.tsx',
  'ui/layout.tsx',
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
  it('writes the full 53-file starter set and derives the name', async () => {
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
  });

  it('honours an explicit --name', async () => {
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
  });

  it('honours a jsails dependency override', async () => {
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

  it('--cli writes the 7-file CLI-only set and no web surface', async () => {
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
    assert.match(appConfig, /name: 'about'/);
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

  it('writes the 27-file default starter set and no server surface', async () => {
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
      existsSync(join(dir, 'jamal.config.js')),
      false,
      'no Jamal config in the starter shape',
    );
    assert.equal(
      existsSync(join(dir, 'jsails.config.js')),
      false,
      'no migration config in the starter shape',
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
    assert.match(appConfig, /enabled: \[\]/);
    assert.match(appConfig, /const files = createDiskFromEnv\(\)/);
    assert.match(appConfig, /\[files\.name\]: files\.disk/);
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
    assert.doesNotMatch(appConfig, /pluginManagerPlugin/);
  });

  it('--blog adds the blog plugin, admin, plugin manager, and two blog pages', async () => {
    const dir = caseDir('blog-unit');
    const code = await runCreateCommand(dir, { admin: false, blog: true, install: false });

    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, 'pages/blog/index.tsx')), 'blog index page is generated');
    assert.ok(existsSync(join(dir, 'pages/blog/[slug].tsx')), 'blog detail page is generated');
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /@jsails\/blog/);
    assert.match(appConfig, /blogAdmin/);
    assert.match(appConfig, /createDatabaseContentRepository/);
    assert.match(appConfig, /pluginManagerPlugin/);
    assert.match(appConfig, /enabled: \["flags"\]/);
    assert.doesNotMatch(appConfig, /tenancy/);
    // One shared search engine, defaulting to Orama, feeds both surfaces.
    assert.match(appConfig, /createBlogSearchEngine/);
    assert.match(appConfig, /driver: process\.env\.SEARCH_DRIVER \?\? 'orama'/);
    assert.match(appConfig, /const search = createBlogSearchEngine\(\{/);
    assert.match(appConfig, /blogAdmin\(\{[\s\S]*?search,/);
    assert.match(appConfig, /'@jsails\/blog',[\s\S]*?search,/);
    // The managed plugin manager is DB-backed.
    assert.match(appConfig, /stateSource: pluginState/);
    assert.match(appConfig, /installer: pluginInstaller/);
    // The media library and filesystem plugin share the env-selected disk, and
    // media metadata is persisted through the shared database index.
    assert.match(appConfig, /const files = createDiskFromEnv\(\)/);
    assert.match(appConfig, /createDatabaseMediaIndex\(\{ getDataSource \}\)/);
    assert.match(appConfig, /metadata: mediaIndex/);
    assert.match(appConfig, /createMediaLibrary\(\{[\s\S]*?metadata: mediaIndex/);
    const schemaConfig = readFileSync(join(dir, 'jsails.config.js'), 'utf8');
    assert.match(schemaConfig, /mediaEntities/);
    assert.match(schemaConfig, /\.\.\.mediaEntities/);
  });

  it('--blog adds the standalone blog/editor/media workspace dependencies', async () => {
    const dir = caseDir('blog-deps-unit');
    const code = await runCreateCommand(dir, { admin: false, blog: true, install: false });

    assert.equal(code, 0);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/blog'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/editor'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/media'], '1.0.0');
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
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /from '@jsails\/tenancy'/);
    assert.match(appConfig, /'@jsails\/tenancy'/);
    assert.match(appConfig, /'@jsails\/flags'/);
    assert.match(appConfig, /resolveTenant: demoResolveTenant/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /enabled: \[\]/);
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
    assert.doesNotMatch(appConfig, /pluginManagerPlugin/);
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
    assert.equal(pkg.dependencies['@jsails/tenancy'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/flags'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/admin'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/auth'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/mail'], '1.0.0');
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

  it('honours packageDependencies overrides for plugin tarballs', async () => {
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
    assert.equal(pkg.dependencies['@jsails/auth'], '1.0.0');
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
      assert.equal(pkg.dependencies['@jsails/auth'], '1.0.0');
      assert.equal(pkg.dependencies['@jsails/mail'], '1.0.0');
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

describe('create and dev are reserved builtin names', () => {
  it('cannot be shadowed by a user command', () => {
    for (const name of ['create', 'dev']) {
      assert.throws(
        () => createCliCommandRegistry([{ name, summary: 'x', run: () => 0 }]),
        /reserved/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// owned process-tree teardown and npm-install arg assembly
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

describe('npmInstallSpawn: platform command assembly', () => {
  it('uses cmd.exe with a fixed, non-interpolated command on win32', () => {
    assert.deepEqual(npmInstallSpawn('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm install'],
    });
  });

  it('falls back to SystemRoot for cmd.exe when ComSpec is unset', () => {
    assert.deepEqual(npmInstallSpawn('win32', { SystemRoot: 'C:\\Win' }), {
      command: 'C:\\Win\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm install'],
    });
  });

  it('spawns npm directly on POSIX', () => {
    assert.deepEqual(npmInstallSpawn('linux', {}), {
      command: 'npm',
      args: ['install'],
    });
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
    assert.throws(() => parsePackageDependencyFlags(['=spec']), /<name>=<spec>/);
    assert.throws(() => parsePackageDependencyFlags(['name=']), /<name>=<spec>/);
    assert.throws(() => parsePackageDependencyFlags(['no-equals']), /<name>=<spec>/);
  });

  it('rejects control characters value-free', () => {
    assert.throws(() => parsePackageDependencyFlags(['a\u0000=b']), /control characters/);
  });
});

// ---------------------------------------------------------------------------
// subprocess: real CLI
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));

/** The framework package root, resolved from the compiled test module. */
const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The repo's own TypeScript compiler binary (used to compile the CLI fixture). */
const TSC_PATH = join(PACKAGE_ROOT, '..', 'node_modules', '@typescript', 'native', 'bin', 'tsc');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env?: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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

describe('cli: create subprocess', () => {
  it('scaffolds a fresh project and prints the next steps', () => {
    const result = runCli(['create', 'sub-fresh', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listFiles(join(workspace, 'sub-fresh')), EXPECTED_STARTER_FILES);
    assert.match(result.stdout, /npm install/);
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /deploy the generated out\/ directory/);
    assert.doesNotMatch(result.stdout, /npm run dev/);
  });

  it('commits the scaffolded project by default', () => {
    const result = runCli(['create', 'sub-committed'], workspace, GIT_IDENTITY_ENV);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Committed the initial project/);
    assert.ok(existsSync(join(workspace, 'sub-committed', '.git')), '.git is created');

    const log = spawnSync('git', ['log', '--oneline'], {
      cwd: join(workspace, 'sub-committed'),
      encoding: 'utf8',
    });
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /chore: scaffold with jsails/);

    const status = spawnSync('git', ['status', '--porcelain'], {
      cwd: join(workspace, 'sub-committed'),
      encoding: 'utf8',
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim(), '', 'the whole scaffold is committed');
  });

  it('leaves no repository when --no-git is given', () => {
    const result = runCli(['create', 'sub-uncommitted', '--no-git'], workspace, GIT_IDENTITY_ENV);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(workspace, 'sub-uncommitted', '.git')), false);
    assert.doesNotMatch(result.stdout, /Committed the initial project/);
  });

  it('derives the package name from the target directory', () => {
    const result = runCli(['create', 'my-new-app', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(join(workspace, 'my-new-app', 'package.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(pkg.name, 'my-new-app');
  });

  it('honours --name and --jsails-dependency together', () => {
    const result = runCli(
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

  it('honours --package-dependency plugin tarball overrides', () => {
    const result = runCli(
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
    assert.equal(pkg.dependencies['@jsails/mail'], '1.0.0');
  });

  it('rejects malformed --package-dependency values without creating a directory', () => {
    const cases: Array<{ args: string[]; leaked: string }> = [
      { args: ['--package-dependency', 'no-equals'], leaked: 'no-equals' },
      { args: ['--package-dependency', '=spec'], leaked: '=spec' },
      { args: ['--package-dependency', 'name='], leaked: 'name=' },
    ];
    for (const { args, leaked } of cases) {
      const result = runCli(['create', 'sub-pkg-dep-bad', ...args], workspace);
      assert.equal(result.status, 1, `create ${args.join(' ')} must fail`);
      assert.doesNotMatch(result.stderr, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(existsSync(join(workspace, 'sub-pkg-dep-bad')), false);
    }
  });

  it('rejects a control character in --package-dependency value-free', () => {
    const result = runCli(
      ['create', 'sub-pkg-dep-bad', '--package-dependency', '@jsails/admin\u0001=file:x'],
      workspace,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /control characters/);
    assert.doesNotMatch(result.stderr, /file:x/);
    assert.equal(existsSync(join(workspace, 'sub-pkg-dep-bad')), false);
  });

  it('rejects --package-dependency on non-create commands', () => {
    for (const args of [
      ['dev', '--package-dependency', 'a=b'],
      ['build', '--package-dependency', 'a=b'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--package-dependency/);
    }
  });

  it('--admin registers the admin panel and its plugin id', () => {
    const result = runCli(['create', 'sub-admin', '--admin', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const appConfig = readFileSync(join(workspace, 'sub-admin', 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /jsails\/admin/);
    assert.match(appConfig, /auth: authSessionToken/);
    assert.match(appConfig, /enabled: \[\]/);
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
  });

  it('--blog registers the admin panel, blog plugin, plugin manager, and blog pages', () => {
    const result = runCli(['create', 'sub-blog', '--blog', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-blog');
    // Two blog pages plus the theme helper are added on top of the 53-file base set (56 total).
    assert.ok(existsSync(join(dir, 'pages/blog/index.tsx')), 'blog index page is generated');
    assert.ok(existsSync(join(dir, 'pages/blog/[slug].tsx')), 'blog detail page is generated');
    assert.equal(listFiles(dir).length, 56);
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /@jsails\/blog/);
    assert.match(appConfig, /blogAdmin/);
    assert.match(appConfig, /createDatabaseContentRepository/);
    assert.match(appConfig, /pluginManagerPlugin/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /enabled: \["flags"\]/);
    assert.doesNotMatch(appConfig, /tenancy/);
    // One shared search engine, defaulting to Orama, feeds both surfaces.
    assert.match(appConfig, /createBlogSearchEngine/);
    assert.match(appConfig, /driver: process\.env\.SEARCH_DRIVER \?\? 'orama'/);
    assert.match(appConfig, /const search = createBlogSearchEngine\(\{/);
    assert.match(appConfig, /blogAdmin\(\{[\s\S]*?search,/);
    assert.match(appConfig, /'@jsails\/blog',[\s\S]*?search,/);
    // The managed plugin manager is DB-backed.
    assert.match(appConfig, /stateSource: pluginState/);
    assert.match(appConfig, /installer: pluginInstaller/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/blog'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/editor'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/media'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/auth'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/mail'], '1.0.0');
  });

  it('--saas scaffolds the 53-file web set with tenancy, flags, and admin', () => {
    const result = runCli(['create', 'sub-saas', '--saas', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    const dir = join(workspace, 'sub-saas');
    assert.deepEqual(listFiles(dir), EXPECTED_FILES);
    const appConfig = readFileSync(join(dir, 'jsails.app.js'), 'utf8');
    assert.match(appConfig, /from '@jsails\/tenancy'/);
    assert.match(appConfig, /'@jsails\/flags'/);
    assert.match(appConfig, /resolveTenant: demoResolveTenant/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
    // The saas shape prints the dev-server next steps, not the static deploy.
    assert.match(result.stdout, /npm run dev/);
    assert.doesNotMatch(result.stdout, /deploy the generated out\/ directory/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/tenancy'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/flags'], '1.0.0');
  });

  it('rejects --saas combined with --admin or --blog', () => {
    for (const args of [
      ['create', 'sub-saas-admin', '--saas', '--admin'],
      ['create', 'sub-saas-blog', '--saas', '--blog'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--saas cannot be combined with --admin or --blog/);
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --saas on non-create commands', () => {
    for (const args of [
      ['dev', '--saas'],
      ['serve', '--saas'],
      ['build', '--saas'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--saas/);
    }
  });

  it('--cli scaffolds the 7-file CLI-only project with no web surface', () => {
    const result = runCli(['create', 'sub-cli', '--cli', '--no-git'], workspace);

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

  it('rejects --cli on non-create commands', () => {
    for (const args of [
      ['dev', '--cli'],
      ['serve', '--cli'],
      ['build', '--cli'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--cli/);
    }
  });

  it('scaffolds the 27-file default starter project with no server surface', () => {
    const result = runCli(['create', 'sub-starter', '--no-git'], workspace);

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
      existsSync(join(dir, 'jamal.config.js')),
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

  it('accepts the explicit --starter flag', () => {
    const result = runCli(['create', 'sub-starter-explicit', '--starter', '--no-git'], workspace);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listFiles(join(workspace, 'sub-starter-explicit')), EXPECTED_STARTER_FILES);
  });

  it('rejects --starter on non-create commands', () => {
    for (const args of [
      ['dev', '--starter'],
      ['serve', '--starter'],
      ['build', '--starter'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--starter/);
    }
  });

  it('rejects --starter combined with --admin, --blog, --saas, or --cli', () => {
    for (const args of [
      ['create', 'sub-starter-admin', '--starter', '--admin'],
      ['create', 'sub-starter-blog', '--starter', '--blog'],
      ['create', 'sub-starter-saas', '--starter', '--saas'],
      ['create', 'sub-starter-cli', '--starter', '--cli'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--(starter|cli|saas) cannot be combined/);
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --cli combined with --admin or --blog', () => {
    for (const args of [
      ['create', 'sub-cli-admin', '--cli', '--admin'],
      ['create', 'sub-cli-blog', '--cli', '--blog'],
      ['create', 'sub-cli-both', '--cli', '--admin', '--blog'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
      assert.match(result.stderr, /--cli cannot be combined/);
      assert.equal(existsSync(join(workspace, args[1] as string)), false, 'no directory created');
    }
  });

  it('rejects --admin and --blog on non-create commands', () => {
    for (const args of [
      ['dev', '--admin'],
      ['serve', '--blog'],
      ['build', '--admin'],
      ['work', '--blog'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
    }
  });

  it('rejects the removed --auth flag', () => {
    const result = runCli(['create', 'sub-auth-flag', '--auth'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--auth/);
    assert.equal(existsSync(join(workspace, 'sub-auth-flag')), false);
  });

  it('rejects a missing target directory argument', () => {
    const result = runCli(['create'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /target directory/);
  });

  it('rejects --config (create needs no app config)', () => {
    const result = runCli(['create', 'with-config', '--config', 'jsails.app.js'], workspace);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--config/);
    assert.equal(existsSync(join(workspace, 'with-config')), false);
  });

  it('rejects an invalid --name without creating the directory', () => {
    const result = runCli(['create', 'bad-name', '--name', 'Invalid Name'], workspace);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid npm package name/);
    assert.equal(existsSync(join(workspace, 'bad-name')), false);
  });

  it('refuses to overwrite a non-empty directory', () => {
    const dir = join(workspace, 'occupied');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'sentinel');

    const result = runCli(['create', 'occupied'], workspace);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not empty/);
    assert.deepEqual(readdirSync(dir), ['keep.txt']);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'sentinel');
  });
});

describe('cli: dev subprocess (flag validation only, no toolchain)', () => {
  it('rejects every create- or migration-only flag before starting dev', () => {
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
    for (const { args, pattern } of cases) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `dev ${args.slice(1).join(' ')} must be a usage error`);
      assert.match(result.stderr, pattern);
    }
  });

  it('rejects create-only flags on migration/app commands too', () => {
    for (const args of [
      ['db:push', '--install'],
      ['build', '--jsails-dependency', 'x'],
      ['serve', '--install'],
    ]) {
      const result = runCli(args, workspace);
      assert.equal(result.status, 2, `${args.join(' ')} must be a usage error`);
    }
  });
});

describe('cli: help lists create and dev', () => {
  it('prints create and dev without importing any config', () => {
    const result = runCli(['--help'], workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /create <dir>/);
    assert.match(result.stdout, /^ {2}dev\s/m);
    assert.match(result.stdout, /--starter/);
    assert.match(result.stdout, /--admin/);
    assert.match(result.stdout, /--blog/);
    assert.match(result.stdout, /--cli/);
    assert.match(result.stdout, /--saas/);
    assert.doesNotMatch(result.stdout, /--auth/);
  });
});

// ---------------------------------------------------------------------------
// subprocess: --cli end-to-end smoke (scaffold + compile + run)
// ---------------------------------------------------------------------------

describe('cli: --cli smoke', () => {
  it('scaffolds, compiles, and runs the hello command end to end', () => {
    const create = runCli(['create', 'cli-smoke', '--cli', '--no-git'], workspace);
    assert.equal(create.status, 0, create.stderr);

    const dir = join(workspace, 'cli-smoke');

    // Resolve `jsails` and `@types/node` without a real `npm install`: symlink
    // the repo's own packages into the fixture's node_modules, then compile
    // with the repo's TypeScript. This keeps the smoke fast and offline.
    const nodeModules = join(dir, 'node_modules');
    mkdirSync(join(nodeModules, '@types'), { recursive: true });
    symlinkSync(PACKAGE_ROOT, join(nodeModules, 'jsails'), 'dir');
    symlinkSync(
      join(PACKAGE_ROOT, '..', 'node_modules', '@types', 'node'),
      join(nodeModules, '@types', 'node'),
      'dir',
    );

    const build = spawnSync(process.execPath, [TSC_PATH, '-p', join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, build.stderr);
    assert.ok(existsSync(join(dir, 'dist', 'commands', 'hello.js')), 'hello.js is compiled');
    assert.ok(existsSync(join(dir, 'dist', 'app', 'application-command.js')), 'shim is compiled');

    // Run the sample command with an explicit name (no interactive prompt).
    const run = runCli(['hello', 'World'], dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Hello, World!/);

    // `jsails <name>` discovers compiled commands; the CLI shape also ships a
    // real app config, so a config-declared command loads it.
    assert.equal(existsSync(join(dir, 'jsails.app.js')), true);
    const help = runCli(['hello', '--help'], dir);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /hello - Greet someone by name/);

    // The app config declares an `about` command; run it after tsc compiles the
    // config (plain ESM, no `dist/` import, so it loads fine).
    const about = runCli(['about'], dir);
    assert.equal(about.status, 0, about.stderr);
    assert.match(about.stdout, /JSails CLI project/);
  });
});
