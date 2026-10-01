import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  createStarterFiles,
  resolveStarterFeatures,
  resolveStarterPreset,
  STARTER_FEATURES,
  STARTER_PRESETS,
  StarterError,
} from '../../src/app/starter/index.js';

/** Package root, resolved from the compiled test module (not the cwd). */
const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REPO_ROOT = join(PACKAGE_ROOT, '..');

/** The framework's own version, for the default-dependency assertion. */
const FRAMEWORK_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  .version as string;

/**
 * Every key the server-rendered web starter (`admin`/`blog`) must produce,
 * order-independent: base pages + components + tests, plus the auth and
 * CLI-command files (55 files, `AGENTS.md` included). The `admin` and `blog`
 * shapes differ only in the app config; `blog` adds two blog pages plus the
 * theme helper (58 files).
 */
const EXPECTED_KEYS = [
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
  'components/load-more-feed.tsx',
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
  'pages/load-more.tsx',
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
];

/**
 * Every key `createStarterFiles({ cli: true })` must produce, order-independent.
 * The CLI-only shape is a separate Laravel-Zero-style project with no web
 * surface: project metadata, the TypeScript project, the `defineCommand` shim,
 * one sample command, a real app config (`jsails.app.js`) declaring an extension
 * seam and a config-registered `about` command, and the generated `AGENTS.md` (7 files).
 */
const EXPECTED_CLI_KEYS = [
  '.gitignore',
  'AGENTS.md',
  'app/application-command.ts',
  'commands/hello.ts',
  'jsails.app.js',
  'package.json',
  'tsconfig.json',
];

/**
 * Every key the default `starter` shape must produce, order-independent. It is
 * a separate project with a typed Markdown blog built on `jsails/content`,
 * Preact pages, and Vite, but no auth, API, server components, or Jamal:
 * project metadata, the server and client TypeScript projects, the client shim,
 * the browser entry, the shared UI, the autoloaded content config
 * (`server/content.ts`) and site metadata (`shared/site.ts`), Markdown content,
 * blog, tag, and category pages, a post-build feed script, a real app config
 * (`jsails.app.js` with `plugins.use: []`), and the generated `AGENTS.md`
 * (29 files).
 */
const EXPECTED_STARTER_KEYS = [
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
];

/** Read a generated file, failing the test if the key is absent. */
function file(files: Readonly<Record<string, string>>, key: string): string {
  const value = files[key];
  assert.ok(typeof value === 'string', `expected generated file "${key}"`);
  return value;
}

describe('createStarterFiles', () => {
  it('returns exactly the expected 55-file web starter set', async () => {
    const { files } = await createStarterFiles({ admin: true });
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_KEYS].sort());
    assert.equal(Object.keys(files).length, 55);
  });

  it('defaults to the 29-file starter shape', async () => {
    const { files } = await createStarterFiles();
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_STARTER_KEYS].sort());
    assert.equal(Object.keys(files).length, 29);
    assert.match(file(files, 'jsails.app.js'), /use: \[\]/);
    assert.match(file(files, 'AGENTS.md'), /# JSails Starter/);
  });

  it('emits a valid, rewritten package.json with the default name and version', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const pkgText = file(files, 'package.json');
    assert.doesNotMatch(pkgText, /__JSAILS_DEPENDENCY__/);

    const pkg = JSON.parse(pkgText) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'jsails-app');
    assert.equal(pkg.dependencies['jsails'], FRAMEWORK_VERSION);
  });

  it('ships zod as a runtime dependency (task component imports it) and no direct Turbo', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    // `components/task-list.tsx` imports zod for its state/action schemas.
    assert.equal(pkg.dependencies['zod'], '^4.6.7');
    // Turbo is a framework client dependency, never a direct starter dependency.
    assert.equal(pkg.dependencies['@hotwired/turbo'], undefined);
  });

  it('never ships a direct SQLite or Better Auth dependency (auth lives in the framework)', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    // Better Auth + Kysely + mysql2 ship inside the framework's `auth` plugin,
    // never as direct starter dependencies.
    assert.equal(pkg.dependencies['better-auth'], undefined);
    assert.equal(pkg.dependencies['kysely'], undefined);
    assert.equal(pkg.dependencies['mysql2'], undefined);
    assert.equal(pkg.dependencies['better-sqlite3'], undefined);
    assert.equal(pkg.devDependencies['@types/better-sqlite3'], undefined);
    assert.equal(pkg.scripts['auth:migrate'], 'node scripts/auth-migrate.mjs');
    assert.equal(pkg.scripts['user:create'], 'node scripts/create-user.mjs');
    assert.equal(pkg.scripts['db:migrate'], 'node scripts/db-migrate.mjs');
  });

  it('overrides the name and jsails dependency', async () => {
    const { files } = await createStarterFiles({
      name: 'my-counter',
      jsailsDependency: 'file:../jsails',
    });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-counter');
    assert.equal(pkg.dependencies['jsails'], 'file:../jsails');
  });

  it('merges packageDependencies over the admin variant defaults', async () => {
    const { files } = await createStarterFiles({
      admin: true,
      packageDependencies: {
        '@jsails/admin': 'file:/tmp/jsails-admin-1.0.0.tgz',
        '@jsails/auth': 'file:/tmp/jsails-auth-1.0.0.tgz',
      },
    });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    // Overridden specs replace the default 1.0.0.
    assert.equal(pkg.dependencies['@jsails/admin'], 'file:/tmp/jsails-admin-1.0.0.tgz');
    assert.equal(pkg.dependencies['@jsails/auth'], 'file:/tmp/jsails-auth-1.0.0.tgz');
    // Non-overridden defaults stay at 1.0.0.
    assert.equal(pkg.dependencies['@jsails/mail'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/filesystem'], '1.0.0');
    // The admin meta module does not import the plugin manager; only the blog shape does.
    assert.equal(pkg.dependencies['@jsails/admin-plugin-manager'], undefined);
  });

  it('merges packageDependencies over the blog variant defaults', async () => {
    const { files } = await createStarterFiles({
      blog: true,
      packageDependencies: {
        '@jsails/blog': 'file:/tmp/jsails-blog-1.0.0.tgz',
        '@jsails/editor': 'file:/tmp/jsails-editor-1.0.0.tgz',
        '@jsails/media': 'file:/tmp/jsails-media-1.0.0.tgz',
      },
    });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/blog'], 'file:/tmp/jsails-blog-1.0.0.tgz');
    assert.equal(pkg.dependencies['@jsails/editor'], 'file:/tmp/jsails-editor-1.0.0.tgz');
    assert.equal(pkg.dependencies['@jsails/media'], 'file:/tmp/jsails-media-1.0.0.tgz');
    // Admin defaults are inherited and untouched.
    assert.equal(pkg.dependencies['@jsails/admin'], '1.0.0');
  });

  it('accepts an npm semver range as a packageDependency spec', async () => {
    const { files } = await createStarterFiles({
      admin: true,
      packageDependencies: { '@jsails/mail': '^1.2.0' },
    });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/mail'], '^1.2.0');
  });

  it('rejects malformed packageDependencies value-free', async () => {
    await assert.rejects(
      createStarterFiles({ admin: true, packageDependencies: 42 as unknown as never }),
      StarterError,
    );
    await assert.rejects(
      createStarterFiles({
        admin: true,
        packageDependencies: { 'Not A Name': 'file:../x' },
      }),
      /valid npm package names/,
    );
    await assert.rejects(
      createStarterFiles({ admin: true, packageDependencies: { '@jsails/mail': '' } }),
      StarterError,
    );
    await assert.rejects(
      createStarterFiles({ admin: true, packageDependencies: { '@jsails/mail': 'file:' } }),
      StarterError,
    );
    await assert.rejects(
      createStarterFiles({ admin: true, packageDependencies: { '@jsails/mail': 'not@a@range' } }),
      StarterError,
    );
  });

  it('wires human-first scripts with no recursive build loop', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts['dev'], 'jsails dev');
    assert.equal(
      pkg.scripts['build'],
      'jsails build:meta && tsc -p tsconfig.json && jsails inject:auto-imports && vite build && jsails build --config jsails.app.js',
    );
    assert.equal(
      pkg.scripts['typecheck'],
      'jsails build:meta && tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit',
    );
    assert.equal(pkg.scripts['check'], 'npm run typecheck && npm run build');
    assert.equal(
      pkg.scripts['test'],
      'jsails build:meta && tsc -p tsconfig.json && jsails inject:auto-imports && node scripts/run-tests.mjs',
    );
    assert.equal(
      pkg.scripts['test:report'],
      'npm test -- --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results/junit.xml',
    );
    assert.equal(pkg.scripts['test:browser'], 'npm run build && playwright test');
    assert.equal(pkg.scripts['serve'], 'jsails serve --config jsails.app.js');
    assert.equal(pkg.scripts['export'], 'npm run build');
    assert.equal(pkg.scripts['auth:migrate'], 'node scripts/auth-migrate.mjs');
    assert.equal(pkg.scripts['user:create'], 'node scripts/create-user.mjs');
    assert.equal(pkg.scripts['db:migrate'], 'node scripts/db-migrate.mjs');

    // check -> build and export -> build; build never re-enters check/export.
    assert.doesNotMatch(pkg.scripts['build'], /npm run (build|check|export)/);
    assert.doesNotMatch(pkg.scripts['typecheck'], /npm run (build|check|export)/);
    assert.doesNotMatch(pkg.scripts['check'], /npm run check/);
    assert.doesNotMatch(pkg.scripts['export'], /npm run export/);
    // The default test path is server-only: no Vite build, no browser.
    assert.doesNotMatch(pkg.scripts['test'], /vite|playwright|test:browser/);
  });

  it('ships the Playwright browser wiring: files, devDependency, script, and privacy guards', async () => {
    const { files } = await createStarterFiles({ admin: true });

    // The three browser-test files are emitted with their `.template` suffix stripped.
    for (const key of [
      'playwright.config.ts',
      'test/browser/fixtures.ts',
      'test/browser/home.spec.ts',
      'test/browser/auth.spec.ts',
    ]) {
      assert.ok(file(files, key).length > 0, `${key} must be a non-empty generated file`);
    }

    const pkg = JSON.parse(file(files, 'package.json')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(pkg.scripts['test:browser'], 'npm run build && playwright test');
    assert.equal(pkg.devDependencies['@playwright/test'], '^1.64.1');
    // Browser tooling is dev-only: it never leaks into runtime dependencies.
    assert.equal(pkg.dependencies['@playwright/test'], undefined);

    const gitignore = file(files, '.gitignore');
    assert.ok(gitignore.includes('test-results/'), '.gitignore must ignore test-results/');
    assert.ok(
      gitignore.includes('playwright-report/'),
      '.gitignore must ignore playwright-report/',
    );
  });

  it('documents the browser workflow without LLM/MCP dependencies', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm run test:browser/);
    assert.match(guide, /test-results\/results\.json/);
    assert.match(guide, /playwright-report\//);
    assert.match(guide, /JSAILS_BROWSER_PATH/);
    assert.match(guide, /npx playwright install chromium/);
    assert.match(guide, /no automatic browser download/i);
    assert.match(guide, /JSAILS_TRACE=1/);
    assert.match(guide, /JSAILS_TEST_PORT/);
    assert.match(guide, /4173/);
    assert.match(guide, /standard Playwright API/);
    assert.match(guide, /no global MCP configuration/i);
    assert.match(guide, /no LLM service/i);
  });

  it('documents the in-process node:test suite and the jsails/testing seam', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm test/);
    assert.match(guide, /node:test/);
    assert.match(guide, /node:assert\/strict/);
    assert.match(guide, /createTestApp\(\{ lifecycle: t \}\)/);
    assert.match(guide, /jsails\/testing/);
    assert.match(guide, /test-results\/junit\.xml/);
    assert.match(guide, /shared by humans and AI agents/i);
    assert.match(guide, /no HTTP server listens/i);
    assert.match(guide, /no broadcast/i);
    assert.match(guide, /caller-owned/i);
    assert.match(guide, /no automatic database rollback/i);
    assert.match(guide, /no cookie jar/i);
    assert.match(guide, /isolated fixtures/i);
  });

  it('points agents at the docs site and the framework repo as the reference', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /Where to learn JSails/);
    assert.match(guide, /https:\/\/jsails\.org/);
    assert.match(guide, /https:\/\/jsails\.org\/docs\/getting-started/);
    assert.match(guide, /https:\/\/github\.com\/ronald2wing\/JSails/);
    assert.match(guide, /templates\/starter/);
    assert.match(guide, /https:\/\/jsails\.org\/docs\/architecture/);
    assert.match(guide, /docs\/CODEMAP\.md/);
    assert.match(guide, /package\.json/);
    assert.match(guide, /exports/);
  });

  it('ships the in-process test suite and runner as ready templates', async () => {
    const { files } = await createStarterFiles({ admin: true });

    const appTest = file(files, 'test/app.test.ts');
    assert.match(appTest, /from '\.\.\/app\/application-testing\.js'/);
    assert.doesNotMatch(appTest, /from 'jsails\/testing'/);
    assert.match(appTest, /createTestApp\(\{ lifecycle: t \}\)/);
    assert.match(appTest, /app\.request\(/);

    const runner = file(files, 'scripts/run-tests.mjs');
    assert.match(runner, /--enable-source-maps/);
    assert.match(runner, /--test/);
    assert.match(runner, /test-results/);
    // The runner defaults the child's NODE_ENV to test only when it was unset.
    assert.match(runner, /childEnv\.NODE_ENV === undefined/);
    assert.match(runner, /childEnv\.NODE_ENV = 'test'/);
    assert.match(runner, /env: childEnv/);
  });

  it('compiles the common server source folders with decorator metadata and source maps', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const tsconfig = JSON.parse(file(files, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
      exclude: string[];
    };
    const include = tsconfig.include.join('\n');
    for (const dir of [
      'pages',
      'api',
      'app',
      'ui',
      'models',
      'jobs',
      'extensions',
      'commands',
      'test',
    ]) {
      assert.ok(include.includes(`${dir}/**/*.ts`), `tsconfig must include ${dir}/`);
    }
    assert.doesNotMatch(include, /client\//);
    // The generated ambient `@jsails.*` namespace must be in the program so a
    // model that writes decorators without importing `jsails` type-checks.
    assert.ok(
      include.includes('.jsails/framework-symbols.d.ts'),
      'tsconfig must include the generated jsails namespace declaration',
    );
    assert.ok(
      include.includes('.jsails/auto-imports.d.ts'),
      'tsconfig must include the generated scoped auto-imports declaration',
    );
    assert.equal(tsconfig.compilerOptions['experimentalDecorators'], true);
    assert.equal(tsconfig.compilerOptions['emitDecoratorMetadata'], true);
    assert.equal(tsconfig.compilerOptions['sourceMap'], true);

    // Browser specs use Playwright's own TS loader and stay out of the server build.
    assert.ok(tsconfig.exclude.includes('test/browser'), 'tsconfig must exclude test/browser');
    for (const dir of ['node_modules', 'dist', 'public', 'out']) {
      assert.ok(tsconfig.exclude.includes(dir), `tsconfig must exclude ${dir}`);
    }
  });

  it('ships the project-local app base modules and rewrites app imports to them', async () => {
    const { files } = await createStarterFiles({ admin: true });

    // Every base module is a non-empty thin re-export of one framework symbol.
    const shims: Array<[string, RegExp]> = [
      ['app/application-component.ts', /defineServerComponent/],
      ['app/application-component.ts', /defineAction/],
      ['app/application-resource.ts', /defineResource/],
      ['app/application-plugin.ts', /definePlugin/],
      ['app/application-command.ts', /defineCommand/],
      ['app/application-client.ts', /registerIsland/],
      ['app/application-client.ts', /startClient/],
      ['app/application-testing.ts', /createTestApp/],
      ['app/application-auth.ts', /createAuth/],
      ['app/application-auth.ts', /login/],
      ['app/application-auth.ts', /loadAuthMigrations/],
      ['app/application-auth.ts', /from '@jsails\/auth'/],
    ];
    for (const [key, pattern] of shims) {
      assert.match(file(files, key), pattern, `${key} must re-export ${String(pattern)}`);
    }

    // Application code imports from `./app/*`, never from a `jsails*` entry.
    const taskList = file(files, 'components/task-list.tsx');
    assert.match(taskList, /from '\.\.\/app\/application-component\.js'/);
    assert.doesNotMatch(taskList, /from 'jsails\/server-components'/);
    for (const key of ['commands/login.ts', 'commands/logout.ts', 'commands/whoami.ts']) {
      assert.match(file(files, key), /from '\.\.\/app\/application-command\.js'/);
      assert.doesNotMatch(file(files, key), /from 'jsails'/);
    }
    const client = file(files, 'client/main.tsx');
    assert.match(client, /from '\.\.\/app\/application-client\.js'/);
    assert.doesNotMatch(client, /from 'jsails\/client'/);
    // The rich-text editor island is registered from the editor subpath and
    // passed to startClient as a declarative map.
    assert.match(client, /from '@jsails\/editor\/preact'/);
    assert.match(client, /richTextIsland/);
    assert.match(client, /startClient\(\{ islands: richTextIsland \}\)/);
    const authTest = file(files, 'test/auth.test.ts');
    assert.match(authTest, /from '\.\.\/app\/application-testing\.js'/);
    assert.doesNotMatch(authTest, /from 'jsails\/testing'/);
    // The auth suite resolves migrations through the project-local auth shim,
    // never through Better Auth's transitive `db/migration` subpath.
    assert.match(authTest, /loadAuthMigrations/);
    assert.match(authTest, /import\('\.\.\/app\/application-auth\.js'\)/);
    assert.doesNotMatch(authTest, /better-auth\/db\/migration/);

    // Components are discovered from the compiler-generated registry instead of
    // a hand-written `app/registry.ts`, so no such file ships.
    assert.equal(files['app/registry.ts'], undefined);
  });

  it('strips the .template suffix and keeps plain template names', async () => {
    const { files } = await createStarterFiles({ admin: true });
    assert.ok(file(files, '.gitignore').includes('node_modules/'));
    assert.ok(file(files, 'jsails.app.js').includes("pages: 'dist/pages'"));
    assert.ok(file(files, 'ui/field.tsx').includes('export function UiField'));
    assert.ok(file(files, 'ui/dialog.tsx').includes('export function UiDialog'));
    for (const key of Object.keys(files)) {
      assert.ok(!key.endsWith('.template'), `${key} must not keep a .template suffix`);
    }
  });

  it('ships the Tailwind + daisyUI stylesheet', async () => {
    const { files } = await createStarterFiles({ admin: true });
    assert.match(file(files, 'ui/styles.css'), /@import 'tailwindcss'/);
    assert.match(file(files, 'ui/styles.css'), /@plugin "daisyui"/);
  });

  it('the default starter uses plain daisyUI themes with no custom palette', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const css = file(files, 'ui/styles.css');
    // Plain daisyUI themes (no bespoke `shell`/`shell-dark` palette) so a user
    // can restyle freely; `aqua`/`night` are the stock built-ins chosen for the
    // JSails brand (sea/ocean).
    assert.match(css, /themes:\s*\n?\s*aqua --default,/);
    assert.match(css, /night --prefersdark;/);
    assert.doesNotMatch(css, /@plugin "daisyui\/theme"/);
    assert.doesNotMatch(css, /shell-dark|name: 'shell'/);
  });

  it('documents explicit island registration and the framework-owned lifecycle', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /explicitly registered in the client entry/i);
    assert.match(guide, /client\/main\.tsx/);
    assert.match(guide, /registerIsland/);
    assert.match(guide, /startClient/);
    assert.match(guide, /no automatic module discovery/i);
    assert.match(guide, /no hot module replacement/i);
    assert.match(guide, /jsails serve --config jsails\.app\.js/);
    assert.match(guide, /jsails build --config jsails\.app\.js/);
    assert.match(guide, /Working with JSails/);
  });

  it('documents the server-components task demo and its limits', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /jsails\/server-components/);
    assert.match(guide, /HMAC-signed snapshot/i);
    assert.match(guide, /staticFallback/);
    assert.match(guide, /static soft links/i);
    assert.match(guide, /ephemeral key/i);
    assert.match(guide, /JSAILS_COMPONENT_SECRET/);
    assert.match(guide, /PUBLIC/);
    assert.match(guide, /exactly-once/i);
  });

  it('documents dev, build, and no-HMR behavior truthfully', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm install/);
    assert.match(guide, /npm run dev/);
    assert.match(guide, /jsails dev/);
    assert.match(guide, /no hot module[\s\S]*replacement/i);
    assert.match(guide, /HMR/);
    assert.match(guide, /reload the browser manually/i);
    assert.match(guide, /npm run build/);
    assert.match(guide, /alias for `npm run build`/);
    assert.doesNotMatch(guide, /jsails init/);
  });

  it('accepts a guide override while still prepending starter instructions', async () => {
    const { files } = await createStarterFiles({ admin: true, guide: '# Custom Guide\n' });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /# Custom Guide/);
    assert.match(guide, /explicitly registered in the client entry/i);
    assert.doesNotMatch(guide, /Working with JSails/);
  });

  it('is independent of the cwd and performs no filesystem writes', async () => {
    const before = await createStarterFiles({ admin: true });
    const dir = mkdtempSync(join(tmpdir(), 'jsails-starter-'));
    const previous = process.cwd();
    try {
      process.chdir(dir);
      const after = await createStarterFiles({ admin: true });
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(readdirSync(dir), []);
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a frozen, null-prototype file map', async () => {
    const result = await createStarterFiles({ admin: true });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.files));
    assert.equal(Object.getPrototypeOf(result.files), null);
  });

  it('ships the auth files and the admin-enabled app config', async () => {
    const { files } = await createStarterFiles({ admin: true });

    for (const key of [
      'app/application-auth.ts',
      'auth/README.md',
      'pages/login.tsx',
      'pages/register.tsx',
      'pages/dashboard.tsx',
      'pages/device.tsx',
      'api/me.ts',
      'commands/login.ts',
      'commands/logout.ts',
      'commands/whoami.ts',
      'scripts/auth-migrate.mjs',
      'scripts/create-user.mjs',
      '.env.auth.example',
      'test/auth.test.ts',
      'test/browser/auth.spec.ts',
    ]) {
      assert.ok(file(files, key).length > 0, `${key} must be generated`);
    }

    // `jsails.app.js` wires the first-party `auth` plugin, not a hand-rolled
    // auth extension, and the web starter includes the admin panel. The
    // cache/filesystem/mail plugins are wired in every web variant.
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /from '@jsails\/auth'/);
    assert.match(appConfig, /@jsails\/auth/);
    assert.match(appConfig, /resolveSessionFromRequest\(createAuth\(\), request\)/);
    assert.match(appConfig, /jsails\/server-components/);
    assert.match(appConfig, /jsails\/cache/);
    assert.match(appConfig, /from '@jsails\/filesystem'/);
    assert.match(appConfig, /const files = createDiskFromEnv\(\)/);
    assert.match(appConfig, /disks: \{ \[files\.name\]: files\.disk \}/);
    assert.match(appConfig, /default: files\.name/);
    assert.match(appConfig, /@jsails\/mail/);
    assert.match(appConfig, /enabled: \[\]/);
    assert.match(appConfig, /jsails\/plugin-tools/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /@jsails\/admin/);
    assert.match(appConfig, /authSessionToken/);
    assert.doesNotMatch(appConfig, /jsails.app.js.template/);

    // The migration script resolves the plan through the framework's
    // `@jsails/auth` barrel, never through Better Auth's transitive
    // `db/migration` subpath (which npm hoisting does not guarantee).
    const authMigrate = file(files, 'scripts/auth-migrate.mjs');
    assert.match(authMigrate, /from '@jsails\/auth'/);
    assert.match(authMigrate, /loadAuthMigrations/);
    assert.doesNotMatch(authMigrate, /better-auth\/db\/migration/);
    // The Better Auth instance holds a connection pool open, so the script must
    // exit explicitly or a wrapper (verify harness, CI) hangs after the work.
    assert.match(authMigrate, /process\.exit\(0\)/);

    const createUser = file(files, 'scripts/create-user.mjs');
    assert.match(createUser, /from '@jsails\/auth'/);
    assert.match(createUser, /process\.exit\(0\)/);
  });

  it('the --admin variant wires the admin plugin with a default-deny signed-in gate', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /from '@jsails\/admin'/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /@jsails\/admin/);
    assert.match(appConfig, /authorize/);
    // Admin pages load the client bundle so the rich-text editor island hydrates.
    assert.match(appConfig, /clientScripts: \['\/assets\/app\.js'\]/);
    // The panel derives its session resolver from the auth plugin's service.
    assert.match(appConfig, /auth: authSessionToken/);
    assert.match(appConfig, /authorize: \(session\) => session !== null/);
    // The global session seam still resolves through the memoized instance.
    assert.match(appConfig, /resolveSessionFromRequest\(createAuth\(\), request\)/);
    // Auth, admin, and server-components are enabled out of the box, alongside
    // the always-wired cache/filesystem/mail plugins; managed installs live in
    // the DB. The list also gates the built-in extensions.
    assert.match(appConfig, /enabled: \[\]/);
    assert.match(appConfig, /jsails\/plugin-tools/);
    assert.match(appConfig, /managed: true/);
    assert.match(appConfig, /pluginStateEntities/);
    assert.match(appConfig, /jsails\/cache/);
    assert.match(appConfig, /jsails\/filesystem/);
    assert.match(appConfig, /@jsails\/mail/);
    // Server components are discovered from the compiler-generated registry
    // (`jsails build:meta`); the config imports no hand-written registry and
    // passes no explicit components map.
    assert.doesNotMatch(appConfig, /app\/registry/);
    assert.match(appConfig, /'jsails\/server-components'/);
    assert.doesNotMatch(appConfig, /jsails\/server-components.*\{ components \}/);
    assert.doesNotMatch(appConfig, /dist\/components\/task-list\.js/);
    // The admin variant shares the 55-file base set (no extra files).
    assert.equal(Object.keys(files).length, 55);
  });

  it('the --blog variant adds the blog plugin, admin, plugin manager, and two pages', async () => {
    const { files } = await createStarterFiles({ blog: true });

    // The blog variant ships the two extra blog pages and theme helper (58 files).
    assert.equal(Object.keys(files).length, 58);
    assert.ok(file(files, 'pages/blog/index.tsx').length > 0);
    assert.ok(file(files, 'pages/blog/[slug].tsx').length > 0);

    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /from '@jsails\/blog'/);
    assert.match(appConfig, /from '@jsails\/admin-plugin-manager'/);
    assert.match(appConfig, /@jsails\/blog/);
    assert.match(appConfig, /blogAdmin\(/);
    assert.match(appConfig, /createDatabaseContentRepository\(/);
    assert.match(appConfig, /contentEntities/);
    assert.match(appConfig, /getDataSource/);
    assert.doesNotMatch(appConfig, /createBlogStore\(/);
    assert.match(appConfig, /pluginManagerPlugin\(/);
    assert.match(appConfig, /firstPartyPluginDirectory/);
    assert.match(appConfig, /frameworkVersion: '1\.0\.0'/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /@jsails\/admin/);
    assert.match(appConfig, /clientScripts: \['\/assets\/app\.js'\]/);
    // Theme activation: a registry over the first-party built-in themes is
    // mounted as a `blog-themes` admin page over the shared repository.
    assert.match(appConfig, /from '@jsails\/theme'/);
    assert.match(appConfig, /builtinThemePackages/);
    assert.match(appConfig, /createThemeRegistry\(/);
    assert.match(appConfig, /blogThemeAdmin\(/);
    assert.match(appConfig, /registry:\s*themeRegistry/);
    assert.match(appConfig, /repository:\s*blogRepository/);
    assert.match(appConfig, /enabled: \["flags"\]/);
    assert.doesNotMatch(appConfig, /tenancy/);
    assert.match(appConfig, /managed: true/);

    // One shared search engine is selected explicitly and handed to both the
    // public blog plugin and the admin save-time indexer.
    assert.match(appConfig, /createBlogSearchEngine/);
    assert.match(appConfig, /driver: process\.env\.SEARCH_DRIVER \?\? 'orama'/);
    assert.match(appConfig, /url: process\.env\.SEARCH_URL/);
    assert.match(appConfig, /apiKey: process\.env\.SEARCH_API_KEY/);
    assert.match(appConfig, /index: process\.env\.SEARCH_INDEX/);
    assert.match(appConfig, /const search = createBlogSearchEngine\(\{/);
    assert.match(appConfig, /blogAdmin\(\{[\s\S]*?search,/);
    assert.match(appConfig, /'@jsails\/blog',[\s\S]*?search,/);

    // The managed plugin manager is DB-backed: the same state store and
    // installer are passed to the admin plugin and the plugin runtime.
    assert.match(appConfig, /stateSource: pluginState/);
    assert.match(appConfig, /installer: pluginInstaller/);
    assert.match(appConfig, /createDatabasePluginStateStore/);
    assert.match(appConfig, /createPluginInstaller/);
    // The media library and filesystem plugin share the env-selected disk, and
    // media metadata is persisted through the shared database index.
    assert.match(appConfig, /const files = createDiskFromEnv\(\)/);
    assert.match(appConfig, /createDatabaseMediaIndex\(\{ getDataSource \}\)/);
    assert.match(appConfig, /metadata: mediaIndex/);
    assert.match(appConfig, /createMediaLibrary\(\{[\s\S]*?metadata: mediaIndex/);
    assert.match(appConfig, /\[files\.name\]: files\.disk/);
    // One lazy data source backs content, media, and plugin state.
    assert.match(
      appConfig,
      /entities: \[\.\.\.contentEntities, \.\.\.mediaEntities, \.\.\.pluginStateEntities\]/,
    );
    assert.match(appConfig, /dataSource\?\.isInitialized/);

    // The schema config registers the media entity so db:push creates the table.
    const schemaConfig = file(files, 'jsails.config.js');
    assert.match(schemaConfig, /from '@jsails\/media'/);
    assert.match(schemaConfig, /mediaEntities/);
    assert.match(schemaConfig, /\.\.\.mediaEntities/);

    // The blog guide section documents the database-backed module.
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /@jsails\/blog/);
    assert.match(guide, /blogPlugin/);
    assert.match(guide, /blogAdmin/);
    assert.match(guide, /blogRepositoryToken/);
    assert.match(guide, /createDatabaseContentRepository/);
    assert.match(guide, /db:migrate/);
  });

  it('ships the server theme helper and applies persisted theme CSS on pages', async () => {
    const { files } = await createStarterFiles({ blog: true });

    // The helper ships with the blog shape, where `@jsails/blog` exists.
    assert.ok(file(files, 'server/theme.ts').length > 0, 'blog theme helper is generated');
    const themeTs = file(files, 'server/theme.ts');
    assert.match(themeTs, /export async function loadThemeCss/);
    assert.match(themeTs, /createThemeRegistry\(/);
    assert.match(themeTs, /builtinThemePackages/);
    assert.match(themeTs, /from '@jsails\/blog'/);
    assert.match(themeTs, /blogRepositoryToken/);

    // Both blog pages resolve the active theme CSS alongside the layout and
    // merge it into the assets handed to `<UiLayout>`.
    const index = file(files, 'pages/blog/index.tsx');
    const detail = file(files, 'pages/blog/[slug].tsx');
    assert.match(index, /loadThemeCss\(context\)/);
    assert.match(detail, /loadThemeCss\(context\)/);
    assert.match(index, /themeCss/);
    assert.match(detail, /themeCss/);

    // The layout inlines the resolved CSS as a `<style>` and no longer puts the
    // token map on `<html>` via a `style` attribute.
    const layout = file(files, 'ui/layout.tsx');
    assert.match(layout, /themeCss\?: string/);
    assert.match(layout, /dangerouslySetInnerHTML=\{\{ __html: themeCss \}\}/);
    assert.doesNotMatch(layout, /style=\{themeTokens\?\.toCss\(\)\}/);
    assert.doesNotMatch(layout, /themeTokens/);
  });

  it('the --blog variant depends on the standalone blog/editor/media workspace packages', async () => {
    const { files } = await createStarterFiles({ blog: true });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/blog'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/editor'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/media'], '1.0.0');
    // The theme package is a shared web-variant dependency (not blog-only).
    assert.equal(pkg.dependencies['@jsails/theme'], '1.0.0');

    // The blog pages import from the workspace packages, not framework subpaths.
    assert.match(file(files, 'pages/blog/index.tsx'), /from '@jsails\/blog'/);
    assert.match(file(files, 'pages/blog/[slug].tsx'), /from '@jsails\/blog'/);
    assert.match(file(files, 'pages/blog/[slug].tsx'), /from '@jsails\/editor\/server'/);
    assert.doesNotMatch(file(files, 'pages/blog/index.tsx'), /from 'jsails\/blog'/);
    assert.doesNotMatch(file(files, 'pages/blog/[slug].tsx'), /from 'jsails\/(blog|editor)/);
  });

  it('the --admin variant does not depend on the blog/media workspace packages', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/blog'], undefined);
    assert.equal(pkg.dependencies['@jsails/media'], undefined);
  });

  it('the --admin and --blog variants depend on the standalone auth/mail packages', async () => {
    for (const shape of [{ admin: true }, { blog: true }] as const) {
      const { files } = await createStarterFiles(shape);
      const pkg = JSON.parse(file(files, 'package.json')) as {
        dependencies: Record<string, string>;
      };
      assert.equal(pkg.dependencies['@jsails/auth'], '1.0.0');
      assert.equal(pkg.dependencies['@jsails/mail'], '1.0.0');
    }

    // The app config and scripts import from the standalone packages, never the
    // framework subpaths.
    const admin = await createStarterFiles({ admin: true });
    assert.match(file(admin.files, 'jsails.app.js'), /from '@jsails\/auth'/);
    assert.match(file(admin.files, 'jsails.app.js'), /'@jsails\/mail'/);
    assert.doesNotMatch(file(admin.files, 'jsails.app.js'), /'jsails\/auth'|'jsails\/mail'/);
    assert.match(file(admin.files, 'scripts/create-user.mjs'), /from '@jsails\/auth'/);
  });

  it('the default and --cli shapes ship no auth/mail/notifications workspace packages', async () => {
    for (const shape of [{}, { cli: true }] as const) {
      const { files } = await createStarterFiles(shape);
      const pkg = JSON.parse(file(files, 'package.json')) as {
        dependencies: Record<string, string>;
      };
      assert.equal(pkg.dependencies['@jsails/auth'], undefined);
      assert.equal(pkg.dependencies['@jsails/mail'], undefined);
      assert.equal(pkg.dependencies['@jsails/notifications'], undefined);
    }
  });

  it('the --saas variant shares the 55-file web starter set (no blog files)', async () => {
    const { files } = await createStarterFiles({ saas: true });
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_KEYS].sort());
    assert.equal(Object.keys(files).length, 55);
    assert.equal(files['pages/blog/index.tsx'], undefined);
    assert.equal(files['pages/blog/[slug].tsx'], undefined);
  });

  it('the --saas variant wires tenancy, flags, admin, and the shared web plugins', async () => {
    const { files } = await createStarterFiles({ saas: true });
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /from '@jsails\/tenancy'/);
    assert.match(appConfig, /'@jsails\/flags'/);
    assert.match(appConfig, /'@jsails\/tenancy'/);
    assert.match(appConfig, /resolveTenant: demoResolveTenant/);
    assert.match(appConfig, /from '@jsails\/admin'/);
    assert.match(appConfig, /defineAdminPanel/);
    assert.match(appConfig, /'jsails\/server-components'/);
    assert.match(appConfig, /enabled: \[\]/);
    assert.match(appConfig, /const files = createDiskFromEnv\(\)/);
    assert.match(appConfig, /\[files\.name\]: files\.disk/);
    // The saas shape ships no blog/plugin-manager wiring (blog-only concerns).
    assert.doesNotMatch(appConfig, /@jsails\/blog/);
    assert.doesNotMatch(appConfig, /@jsails\/admin-plugin-manager/);
    assert.doesNotMatch(appConfig, /pluginManagerPlugin/);
  });

  it('the web variants wire the dev plugin before the admin/blog route plugins', async () => {
    const shapes = [{ admin: true }, { blog: true }, { saas: true }] as const;
    for (const shape of shapes) {
      const { files } = await createStarterFiles(shape);
      const appConfig = file(files, 'jsails.app.js');
      const devIndex = appConfig.search(/['"]jsails\/dev['"]/);
      assert.ok(devIndex >= 0, `${JSON.stringify(shape)} must wire jsails/dev`);
      // The dev plugin mounts the live-reload SSE route and HTML injection, so
      // it must be registered before the admin/blog route hooks it augments.
      for (const plugin of ['@jsails/admin', '@jsails/blog', '@jsails/live']) {
        const useEntry = new RegExp(`\\[\\s*['"]${plugin.replaceAll('/', '\\/')}['"]`);
        const pluginIndex = appConfig.search(useEntry);
        if (pluginIndex === -1) continue;
        assert.ok(
          devIndex < pluginIndex,
          `jsails/dev must precede ${plugin} in ${JSON.stringify(shape)}`,
        );
      }
    }
  });

  it('the default static starter does not wire the dev plugin', async () => {
    const { files } = await createStarterFiles();
    assert.doesNotMatch(file(files, 'jsails.app.js'), /['"]jsails\/dev['"]/);
  });

  it('the --saas variant depends on tenancy, flags, and the admin workspace packages', async () => {
    const { files } = await createStarterFiles({ saas: true });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.dependencies['@jsails/tenancy'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/flags'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/admin'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/auth'], '1.0.0');
    assert.equal(pkg.dependencies['@jsails/mail'], '1.0.0');
    // No blog-only workspace dependencies.
    assert.equal(pkg.dependencies['@jsails/blog'], undefined);
    assert.equal(pkg.dependencies['@jsails/media'], undefined);
  });

  it('the --saas guide documents tenancy, flags, and the db:migrate workflow without blog', async () => {
    const { files } = await createStarterFiles({ saas: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /@jsails\/tenancy/);
    assert.match(guide, /@jsails\/flags/);
    assert.match(guide, /resolveTenant/);
    assert.match(guide, /db:migrate/);
    assert.doesNotMatch(guide, /blogPlugin|blogAdmin|createDatabaseContentRepository/);
    assert.doesNotMatch(guide, /pluginManagerPlugin/);
  });

  it('emits the env example and un-ignores it in the gitignore', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const envExample = file(files, '.env.auth.example');
    assert.match(envExample, /BETTER_AUTH_SECRET/);
    assert.match(envExample, /DATABASE_HOST/);
    assert.match(envExample, /DATABASE_NAME/);
    assert.match(envExample, /DATABASE_USER/);
    assert.match(envExample, /BETTER_AUTH_URL/);

    const gitignore = file(files, '.gitignore');
    assert.ok(
      gitignore.includes('!.env.auth.example'),
      '.gitignore must un-ignore .env.auth.example',
    );
  });

  it('documents the auth workflow in the guide', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /npm run auth:migrate/);
    assert.match(guide, /npm run user:create/);
    assert.match(guide, /BETTER_AUTH_SECRET/);
    assert.match(guide, /MariaDB/);
    assert.match(guide, /jamal up/);
    assert.match(guide, /DATABASE_HOST/);
    assert.match(guide, /DATABASE_NAME/);
  });

  it('documents the user-facing CLI login flow', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /jsails login/);
    assert.match(guide, /jsails whoami/);
    assert.match(guide, /jsails logout/);
    assert.match(guide, /\/device/);
    assert.match(guide, /RFC 8628/);
    assert.match(guide, /~\/\.config\/jsails\/<app>\/credentials\.json/);
    assert.match(guide, /0600/);
    assert.match(guide, /0700/);
    assert.match(guide, /commands\/\*\.ts/);
    assert.match(guide, /framework builtins/);
    assert.match(guide, /jamal/);
    assert.match(guide, /developer commands/);
  });

  it('documents the admin panel, plugin enablement, and jamal in the guide', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /admin/);
    assert.match(guide, /plugins/);
    assert.match(guide, /plugins\.enabled/);
    assert.match(guide, /jsails_plugin_state/);
    assert.match(guide, /pluginStateEntities/);
    assert.match(guide, /jamal/);
    assert.match(guide, /restrict it to an admin role/i);
  });

  it('rejects non-object options', async () => {
    await assert.rejects(createStarterFiles('nope' as unknown as never), StarterError);
    await assert.rejects(createStarterFiles(42 as unknown as never), StarterError);
    await assert.rejects(createStarterFiles(null as unknown as never), StarterError);
    await assert.rejects(createStarterFiles([] as unknown as never), StarterError);
  });

  it('rejects invalid names with StarterError', async () => {
    await assert.rejects(createStarterFiles({ name: 42 as unknown as string }), StarterError);
    await assert.rejects(createStarterFiles({ name: '' }), StarterError);
    await assert.rejects(createStarterFiles({ name: 'Invalid Name' }), StarterError);
    await assert.rejects(createStarterFiles({ name: '.hidden' }), StarterError);
    await assert.rejects(createStarterFiles({ name: 'my\u0000app' }), StarterError);
  });

  it('rejects invalid jsails dependency specs', async () => {
    await assert.rejects(
      createStarterFiles({ jsailsDependency: 42 as unknown as string }),
      StarterError,
    );
    await assert.rejects(createStarterFiles({ jsailsDependency: '' }), StarterError);
    await assert.rejects(createStarterFiles({ jsailsDependency: 'file:' }), StarterError);
    await assert.rejects(createStarterFiles({ jsailsDependency: 'file:x\u0000y' }), StarterError);
    // Not a dependency: a semver range is now the public-release path.
    await assert.rejects(createStarterFiles({ jsailsDependency: 'not@a@range' }), StarterError);
  });

  it('accepts an npm semver range for jsailsDependency', async () => {
    const { files } = await createStarterFiles({ jsailsDependency: '^1.0.0' });
    const pkg = JSON.parse(files['package.json']!) as { dependencies?: Record<string, string> };
    assert.equal(pkg.dependencies?.['jsails'], '^1.0.0');

    const pinned = await createStarterFiles({ jsailsDependency: '1.0.0' });
    const pinnedPkg = JSON.parse(pinned.files['package.json']!) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(pinnedPkg.dependencies?.['jsails'], '1.0.0');
  });

  it('rejects invalid guide values', async () => {
    await assert.rejects(createStarterFiles({ guide: 42 as unknown as string }), StarterError);
    await assert.rejects(createStarterFiles({ guide: '' }), StarterError);
    await assert.rejects(createStarterFiles({ guide: 'bad\u0000guide' }), StarterError);
  });

  it('the --cli variant returns exactly the 7-file CLI-only set', async () => {
    const { files } = await createStarterFiles({ cli: true });
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_CLI_KEYS].sort());
    assert.equal(Object.keys(files).length, 7);
    // No web surface: the CLI-only shape never ships web directories.
    for (const key of Object.keys(files)) {
      assert.ok(!key.startsWith('pages/'), `cli variant must not ship ${key}`);
      assert.ok(!key.startsWith('api/'), `cli variant must not ship ${key}`);
      assert.ok(!key.startsWith('client/'), `cli variant must not ship ${key}`);
      assert.ok(!key.startsWith('ui/'), `cli variant must not ship ${key}`);
    }
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /plugins: \{ use: \[\] \}/);
    assert.match(appConfig, /use: \[\]/);
    assert.match(appConfig, /name: 'about'/);
    assert.doesNotMatch(appConfig, /from 'jsails/);
    assert.doesNotMatch(appConfig, /\.\/dist\//);
  });

  it('the --cli variant emits a minimal private package.json with no web scripts', async () => {
    const { files } = await createStarterFiles({ cli: true, name: 'my-cli' });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      name: string;
      private: boolean;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-cli');
    assert.equal(pkg.private, true);
    assert.equal(pkg.dependencies['jsails'], FRAMEWORK_VERSION);
    // Minimal scripts: no dev/serve/export/test/browser/auth surface.
    assert.equal(pkg.scripts['build'], 'tsc -p tsconfig.json');
    assert.equal(pkg.scripts['typecheck'], 'tsc -p tsconfig.json --noEmit');
    assert.equal(pkg.scripts['check'], 'npm run typecheck && npm run build');
    for (const key of ['dev', 'serve', 'export', 'test', 'test:browser', 'test:report']) {
      assert.equal(pkg.scripts[key], undefined, `cli variant must not define ${key}`);
    }
    assert.equal(pkg.scripts['auth:migrate'], undefined);
    assert.equal(pkg.scripts['user:create'], undefined);
    // The web-only auth/UI tooling never ships in the CLI-only shape.
    assert.equal(pkg.dependencies['zod'], undefined);
    assert.equal(pkg.dependencies['preact'], undefined);
    assert.equal(pkg.devDependencies['vite'], undefined);
    assert.equal(pkg.devDependencies['@playwright/test'], undefined);
    assert.equal(pkg.devDependencies['typescript'], '^7.0.2');
  });

  it('the --cli variant compiles commands/, services/, and app/ with NodeNext and no JSX/DOM', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const tsconfig = JSON.parse(file(files, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
      exclude: string[];
    };
    assert.equal(tsconfig.compilerOptions['module'], 'NodeNext');
    assert.equal(tsconfig.compilerOptions['moduleResolution'], 'NodeNext');
    assert.equal(tsconfig.compilerOptions['jsx'], undefined, 'no JSX in the CLI-only project');
    assert.equal(tsconfig.compilerOptions['jsxImportSource'], undefined);
    assert.deepEqual(tsconfig.compilerOptions['lib'], ['ES2023'], 'no DOM lib');
    assert.equal(tsconfig.compilerOptions['experimentalDecorators'], undefined);
    assert.deepEqual(tsconfig.include, ['commands/**/*.ts', 'services/**/*.ts', 'app/**/*.ts']);
    assert.ok(tsconfig.exclude.includes('node_modules'));
    assert.ok(tsconfig.exclude.includes('dist'));
    for (const dir of ['pages', 'api', 'public', 'client', 'ui', 'test']) {
      assert.ok(
        !tsconfig.include.some((entry) => entry.startsWith(`${dir}/`)),
        `${dir} not included`,
      );
    }
  });

  it('the --cli variant ships the command-class shim and the hello sample command', async () => {
    const { files } = await createStarterFiles({ cli: true });

    const shim = file(files, 'app/application-command.ts');
    assert.match(shim, /export \{ Command, defineCommand \} from 'jsails'/);

    const hello = file(files, 'commands/hello.ts');
    assert.match(hello, /from '\.\.\/app\/application-command\.js'/);
    assert.doesNotMatch(hello, /from 'jsails'/);
    assert.match(hello, /export default class HelloCommand extends Command/);
    assert.match(hello, /static readonly signature = 'hello \{name\?\}'/);
    assert.match(hello, /static readonly summary = 'Greet someone by name'/);
    assert.match(hello, /static readonly audience = 'user' as const/);
    assert.match(hello, /this\.prompter\.text\(/);
    assert.match(hello, /this\.stdout\(`Hello, \$\{name\}!`\)/);

    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /name: 'about'/);
    assert.match(appConfig, /audience: 'developer'/);
  });

  it('the --cli variant documents the build-then-run workflow in AGENTS.md', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /# JSails CLI Starter/);
    assert.match(guide, /no web surface/i);
    assert.match(guide, /npm run build/);
    assert.match(guide, /npx jsails hello/);
    assert.match(guide, /npx jsails about/);
    assert.match(guide, /plugins\.enabled/);
    assert.match(guide, /plugins\.use/);
    assert.match(guide, /jsails\.app\.js/);
    assert.match(guide, /dist\/commands/);
    assert.match(guide, /node:readline\/promises/);
    // The framework's own guide is still bundled underneath.
    assert.match(guide, /Working with JSails/);
  });

  it('the --cli variant ships an app config with the extension seam and a config command', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const appConfig = file(files, 'jsails.app.js');
    assert.match(appConfig, /rootDir: '\.'/);
    assert.match(appConfig, /plugins: \{ use: \[\] \}/);
    assert.match(appConfig, /use: \[\]/);
    assert.match(appConfig, /commands: \[/);
    assert.match(appConfig, /name: 'about'/);
    assert.match(appConfig, /summary: 'Show framework and project information'/);
    assert.match(appConfig, /audience: 'developer'/);
    // A CLI project has no web surface: the config declares no web keys.
    assert.doesNotMatch(appConfig, /pages:/);
    assert.doesNotMatch(appConfig, /api:/);
    assert.doesNotMatch(appConfig, /public:/);
  });

  it('the --cli variant ships a gitignore without the web-specific paths', async () => {
    const { files } = await createStarterFiles({ cli: true });
    const gitignore = file(files, '.gitignore');
    assert.ok(gitignore.includes('node_modules/'));
    assert.ok(gitignore.includes('dist/'));
    assert.doesNotMatch(gitignore, /public\/assets/);
    assert.doesNotMatch(gitignore, /test-results/);
    assert.doesNotMatch(gitignore, /playwright-report/);
    assert.doesNotMatch(gitignore, /\.env\.auth\.example/);
  });

  it('rejects --cli combined with --admin or --blog', async () => {
    await assert.rejects(
      createStarterFiles({ cli: true, admin: true }),
      /options\.cli cannot be combined with options\.admin, options\.blog, options\.saas, or options\.starter/,
    );
    await assert.rejects(
      createStarterFiles({ cli: true, blog: true }),
      /options\.cli cannot be combined with options\.admin, options\.blog, options\.saas, or options\.starter/,
    );
    await assert.rejects(
      createStarterFiles({ cli: true, admin: true, blog: true }),
      /options\.cli cannot be combined/,
    );
  });

  it('rejects an invalid cli flag value', async () => {
    await assert.rejects(createStarterFiles({ cli: 'yes' as unknown as boolean }), StarterError);
  });

  it('the default starter returns exactly the 29-file static-site set', async () => {
    const { files } = await createStarterFiles({ starter: true });
    assert.deepStrictEqual(Object.keys(files).sort(), [...EXPECTED_STARTER_KEYS].sort());
    assert.equal(Object.keys(files).length, 29);
  });

  it('the default starter ships no auth, API, server-component, or Jamal files', async () => {
    const { files } = await createStarterFiles({ starter: true });
    const keys = Object.keys(files);
    for (const forbidden of [
      'api/me.ts',
      'components/task-list.tsx',
      'pages/tasks.tsx',
      'pages/login.tsx',
      'pages/dashboard.tsx',
      'pages/device.tsx',
      'jamal.config.js',
      'jsails.config.js',
      '.env.auth.example',
      'auth/README.md',
      'commands/login.ts',
      'playwright.config.ts',
    ]) {
      assert.ok(!keys.includes(forbidden), `static starter must not ship ${forbidden}`);
    }
  });

  it('the default starter emits a private package.json with build/serve scripts and no auth scripts', async () => {
    const { files } = await createStarterFiles({ starter: true, name: 'my-starter' });
    const pkg = JSON.parse(file(files, 'package.json')) as {
      name: string;
      private: boolean;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-starter');
    assert.equal(pkg.private, true);
    const build = pkg.scripts.build ?? '';
    assert.match(build, /jsails build:meta/);
    assert.match(build, /tsc -p tsconfig\.json/);
    assert.match(build, /jsails inject:auto-imports/);
    assert.match(build, /vite build/);
    assert.match(build, /jsails build --config jsails\.app\.js/);
    assert.match(
      build,
      /node --import \.\/\.jsails\/project-symbols\.js scripts\/generate-feeds\.mjs/,
    );
    assert.equal(pkg.scripts['auth:migrate'], undefined);
    assert.equal(pkg.scripts['db:migrate'], undefined);
    assert.equal(pkg.scripts['user:create'], undefined);
    assert.equal(pkg.dependencies['jsails'], FRAMEWORK_VERSION);
    assert.equal(pkg.dependencies['preact'] !== undefined, true);
    assert.equal(pkg.dependencies['zod'] !== undefined, true);
  });

  it('the default starter compiles pages/app/ui with JSX and a separate client project', async () => {
    const { files } = await createStarterFiles({ starter: true });
    const server = JSON.parse(file(files, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    assert.equal(server.compilerOptions['jsx'], 'react-jsx');
    assert.equal(server.compilerOptions['jsxImportSource'], 'jsails');
    assert.ok(server.include.some((entry) => entry.startsWith('pages/')));
    assert.ok(server.include.some((entry) => entry.startsWith('ui/')));

    const client = JSON.parse(file(files, 'tsconfig.client.json')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    assert.equal(client.compilerOptions['jsxImportSource'], 'preact');
    assert.ok(client.include.some((entry) => entry.startsWith('client/')));
  });

  it('the default starter ships an app config with an empty plugins.use and no marketplace block', async () => {
    const { files } = await createStarterFiles({ starter: true });
    const config = file(files, 'jsails.app.js');
    assert.match(config, /plugins:\s*\{/);
    assert.match(config, /use:\s*\[\]/);
    assert.doesNotMatch(config, /enabled:/);
    assert.doesNotMatch(config, /managed:/);
    assert.doesNotMatch(config, /jsails\/auth/);
    assert.doesNotMatch(config, /jsails\/server-components/);
  });

  it('the default starter uses plain daisyUI themes with no custom palette', async () => {
    const { files } = await createStarterFiles({ starter: true });
    const css = file(files, 'ui/styles.css');
    // Built-in theme names, declared straight from daisyUI so the app owns its
    // look and can switch or restyle freely — no bespoke palette is declared.
    assert.match(css, /themes:\s*\n?\s*light --default,/);
    assert.match(css, /dark --prefersdark;/);
    assert.doesNotMatch(css, /@plugin "daisyui\/theme"/);
    // No bespoke theme names may linger.
    assert.doesNotMatch(css, /paper-dark|name: 'paper'|name: 'light'|name: 'shell'/);
  });

  it('the default starter ships the client shim, browser entry, and content config', async () => {
    const { files } = await createStarterFiles({ starter: true });
    const shim = file(files, 'app/application-client.ts');
    assert.match(shim, /from 'jsails\/client'/);
    assert.match(shim, /registerIsland/);
    assert.match(shim, /startClient/);

    const entry = file(files, 'client/main.tsx');
    assert.match(entry, /startClient\(\)/);
    assert.doesNotMatch(entry, /registerIsland\('counter'/);

    const content = file(files, 'server/content.ts');
    assert.match(content, /defineContentCollection/);
    assert.match(content, /defineTaxonomies/);
    assert.doesNotMatch(content, /from 'jsails\/content'/);

    const index = file(files, 'pages/index.tsx');
    assert.match(index, /loadLayout/);
  });

  it('the default starter documents the build-and-deploy workflow in AGENTS.md', async () => {
    const { files } = await createStarterFiles({ starter: true });
    const guide = file(files, 'AGENTS.md');
    assert.match(guide, /# JSails Starter/);
    assert.match(guide, /deploy `out\/`/);
    assert.match(guide, /plugins\.use: \[\]/);
  });

  it('the default starter ships a gitignore without the auth env un-ignore', async () => {
    const { files } = await createStarterFiles({ starter: true });
    const gitignore = file(files, '.gitignore');
    assert.match(gitignore, /node_modules\//);
    assert.match(gitignore, /out\//);
    assert.doesNotMatch(gitignore, /\.env\.auth\.example/);
  });

  it('rejects --starter combined with --admin, --blog, or --cli', async () => {
    await assert.rejects(
      createStarterFiles({ starter: true, admin: true }),
      /options\.starter cannot be combined with options\.admin, options\.blog, or options\.saas/,
    );
    await assert.rejects(
      createStarterFiles({ starter: true, blog: true }),
      /options\.starter cannot be combined with options\.admin, options\.blog, or options\.saas/,
    );
    await assert.rejects(
      createStarterFiles({ starter: true, cli: true }),
      /options\.cli cannot be combined/,
    );
  });

  it('rejects --saas combined with --admin, --blog, --cli, or --starter', async () => {
    await assert.rejects(
      createStarterFiles({ saas: true, admin: true }),
      /options\.saas cannot be combined with options\.admin or options\.blog/,
    );
    await assert.rejects(
      createStarterFiles({ saas: true, blog: true }),
      /options\.saas cannot be combined with options\.admin or options\.blog/,
    );
    await assert.rejects(
      createStarterFiles({ saas: true, cli: true }),
      /options\.cli cannot be combined/,
    );
    await assert.rejects(
      createStarterFiles({ saas: true, starter: true }),
      /options\.starter cannot be combined with options\.admin, options\.blog, or options\.saas/,
    );
  });

  it('rejects an invalid saas flag value', async () => {
    await assert.rejects(createStarterFiles({ saas: 'yes' as unknown as boolean }), StarterError);
  });

  it('rejects an invalid starter flag value', async () => {
    await assert.rejects(
      createStarterFiles({ starter: 'yes' as unknown as boolean }),
      StarterError,
    );
  });
});

/**
 * The data-driven shape catalog: `STARTER_FEATURES` names the build-time
 * features and `STARTER_PRESETS` composes them into the five shapes. These
 * tests pin the catalog's invariants (unique ids, frozen arrays, referenced
 * features resolve) and prove each preset resolves the same file set as its
 * historical flag form.
 */
describe('starter presets', () => {
  function featuresFor(id: string): readonly string[] {
    const preset = STARTER_PRESETS.find((candidate) => candidate.id === id);
    assert.ok(preset !== undefined, `expected a preset with id "${id}"`);
    return preset.requires;
  }

  function fileCountFor(options: Parameters<typeof createStarterFiles>[0]): Promise<number> {
    return createStarterFiles(options).then(({ files }) => Object.keys(files).length);
  }

  it('declares five presets with unique ids', () => {
    assert.equal(STARTER_PRESETS.length, 5);
    const ids = STARTER_PRESETS.map((preset) => preset.id).sort();
    assert.deepStrictEqual(ids, ['admin', 'blog', 'cli', 'saas', 'starter']);
  });

  it('declares every feature id referenced by a preset', () => {
    const featureIds = new Set(STARTER_FEATURES.map((feature) => feature.id));
    for (const preset of STARTER_PRESETS) {
      for (const feature of preset.requires) {
        assert.ok(
          featureIds.has(feature),
          `preset "${preset.id}" references unknown feature "${feature}"`,
        );
      }
    }
  });

  it('declares every feature with a non-empty description and unique id', () => {
    const seen = new Set<string>();
    for (const feature of STARTER_FEATURES) {
      assert.ok(!seen.has(feature.id), `duplicate feature id "${feature.id}"`);
      seen.add(feature.id);
      assert.ok(feature.description.length > 0, `feature "${feature.id}" needs a description`);
    }
  });

  it('freezes the preset and feature catalogs', () => {
    assert.ok(Object.isFrozen(STARTER_PRESETS));
    assert.ok(Object.isFrozen(STARTER_FEATURES));
    for (const preset of STARTER_PRESETS) {
      assert.ok(Object.isFrozen(preset), `preset "${preset.id}" must be frozen`);
      assert.ok(Object.isFrozen(preset.requires), `preset "${preset.id}" requires must be frozen`);
    }
    for (const feature of STARTER_FEATURES) {
      assert.ok(Object.isFrozen(feature), `feature "${feature.id}" must be frozen`);
      if (feature.templates !== undefined) {
        assert.ok(Object.isFrozen(feature.templates), `feature "${feature.id}" templates frozen`);
        assert.ok(
          Object.isFrozen(feature.templates.files),
          `feature "${feature.id}" template files frozen`,
        );
      }
    }
  });

  it('declares the blog preset with the plugin-manager, blog, and media features', () => {
    const features = featuresFor('blog');
    assert.ok(features.includes('plugin-manager'));
    assert.ok(features.includes('blog'));
    assert.ok(features.includes('media'));
  });

  it('declares the saas preset with the tenancy and flags features', () => {
    const features = featuresFor('saas');
    assert.ok(features.includes('tenancy'));
    assert.ok(features.includes('flags'));
  });

  it('declares neither blog, media, nor tenancy features for the admin preset', () => {
    const features = featuresFor('admin');
    assert.ok(!features.includes('blog'));
    assert.ok(!features.includes('media'));
    assert.ok(!features.includes('tenancy'));
    assert.ok(!features.includes('plugin-manager'));
  });

  it('resolves each preset to its historical file count', async () => {
    assert.equal(await fileCountFor({}), 29); // default -> starter
    assert.equal(await fileCountFor({ starter: true }), 29);
    assert.equal(await fileCountFor({ admin: true }), 55);
    assert.equal(await fileCountFor({ blog: true }), 58);
    assert.equal(await fileCountFor({ saas: true }), 55);
    assert.equal(await fileCountFor({ cli: true }), 7);
  });

  it('resolves each flag form to its preset id', () => {
    const cases: Array<{ flags: Parameters<typeof resolveStarterPreset>[0]; id: string }> = [
      { flags: { starter: true }, id: 'starter' },
      { flags: { admin: true }, id: 'admin' },
      { flags: { blog: true }, id: 'blog' },
      { flags: { saas: true }, id: 'saas' },
      { flags: { cli: true }, id: 'cli' },
      { flags: {}, id: 'starter' },
    ];
    for (const { flags, id } of cases) {
      const resolution = resolveStarterPreset(flags);
      assert.equal(resolution.ok, true, `flags for "${id}" must resolve`);
      if (resolution.ok) {
        assert.equal(resolution.preset.id, id);
        const expectedKind = id === 'cli' ? 'cli' : id === 'starter' ? 'static' : 'web';
        assert.equal(resolution.preset.kind, expectedKind);
      }
    }
  });

  it('declares a migration config only for the web presets', () => {
    for (const preset of STARTER_PRESETS) {
      const hasMigration = resolveStarterFeatures(preset).some(
        (feature) => feature.migrationConfig !== undefined,
      );
      assert.equal(hasMigration, preset.kind === 'web', `preset "${preset.id}" migration mismatch`);
    }
  });

  it('keeps imported plugins out of the managed allow-list by default', () => {
    const byId = new Map(STARTER_PRESETS.map((preset) => [preset.id, preset]));
    assert.equal(byId.get('admin')?.managedPlugins, 'none');
    assert.equal(byId.get('saas')?.managedPlugins, 'none');
    assert.deepEqual(byId.get('blog')?.managedPlugins, ['flags']);
    assert.equal(byId.get('starter')?.managedPlugins, 'none');
    assert.equal(byId.get('cli')?.managedPlugins, 'none');
  });

  it('still enables package-imported plugins through plugins.use', async () => {
    const { files } = await createStarterFiles({ admin: true });
    const appConfig = file(files, 'jsails.app.js');
    const pkg = JSON.parse(file(files, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    assert.match(appConfig, /'@jsails\/auth'/);
    assert.match(appConfig, /enabled: \[\]/);
    assert.equal(pkg.dependencies['@jsails/auth'], '1.0.0');
  });

  it('reports a conflicting flag combination through resolveStarterPreset', () => {
    const resolution = resolveStarterPreset({ admin: true, blog: true });
    assert.equal(resolution.ok, false);
    if (!resolution.ok) {
      assert.match(resolution.message, /conflict/);
    }
  });

  it('defaults to the starter preset when no shape flag is given', () => {
    const resolution = resolveStarterPreset({});
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.preset.id, 'starter');
      assert.equal(resolution.preset.kind, 'static');
    }
  });
});

/**
 * Guards the template trees against silent lint/format regression: the starter
 * ships these files verbatim to every user, so every code template must be
 * covered by the repo's ESLint and Prettier configuration. If a future change
 * adds a template in a language the tooling does not cover (or re-adds a
 * `templates/**` ignore), this fails instead of shipping unlinted code.
 */
describe('template lint/format coverage', () => {
  /**
   * Code extensions under `templates/` the tooling is known to cover. `.template`
   * is a suffix, not a language: a file's language is the extension before it
   * (`pages/index.tsx.template` is TSX). `css`/`json` are Prettier-only (ESLint
   * does not lint them); `ts`/`tsx`/`js`/`mjs` are covered by both.
   */
  const PRETTIER_CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'mjs', 'css', 'json']);
  const ESLINT_CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'mjs']);

  /**
   * Template basenames that are deliberately NOT code and are narrow-excluded
   * by config: dotfiles without a code language, `.env.*`, and Markdown.
   */
  const NON_CODE_TEMPLATES = new Set([
    '.gitignore',
    '.env.auth.example',
    'README.md',
    'about.md',
    'islands-without-the-framework-tax.md',
    'static-sites-with-typed-content.md',
    'why-we-built-jsails.md',
  ]);

  /** Every file under a directory, relative to the package root. */
  function walk(dir: string): string[] {
    return readdirSync(join(PACKAGE_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      return entry.isDirectory() ? walk(rel) : [rel];
    });
  }

  /** A template basename with the `.template` suffix stripped. */
  function baseName(rel: string): string {
    const name = rel.split('/').pop() ?? rel;
    return name.endsWith('.template') ? name.slice(0, -'.template'.length) : name;
  }

  it('every template is either a known non-code file or a tooling-covered code language', () => {
    const templates = walk('templates');
    const uncovered = templates.filter((rel) => {
      if (NON_CODE_TEMPLATES.has(baseName(rel))) return false;
      const ext = baseName(rel).split('.').pop();
      return ext === undefined || !PRETTIER_CODE_EXTENSIONS.has(ext);
    });
    assert.deepEqual(
      uncovered,
      [],
      `templates with an uncovered extension — add them to the linter/formatter config or the non-code list: ${uncovered.join(', ')}`,
    );
  });

  it('the top-level eslint ignores do not blanket-ignore the templates tree', () => {
    // The regression: a `'templates/**'` entry in the first (top-level) `ignores`
    // array silently un-lints every template. The type-checked blocks legitimately
    // ignore `templates/**` (no tsconfig covers them), so only the top-level array
    // is checked — it precedes the first `configs.recommendedTypeChecked` spread.
    const eslintConfig = readFileSync(join(REPO_ROOT, 'eslint.config.mjs'), 'utf8');
    const head = eslintConfig.slice(0, eslintConfig.indexOf('configs.recommendedTypeChecked'));
    assert.doesNotMatch(head, /'templates\/\*\*'/);
  });

  it('prettier does not blanket-ignore template files', () => {
    const prettierIgnore = readFileSync(join(REPO_ROOT, '.prettierignore'), 'utf8');
    assert.doesNotMatch(prettierIgnore, /^\s*\*\.template\s*$/m);
    assert.doesNotMatch(prettierIgnore, /^\s*templates\/\*\*\/\*\.template\s*$/m);
  });

  it('the prettier config declares a parser override for every templated code extension', () => {
    // Prettier infers language by extension; a `foo.tsx.template` file is not
    // recognised as TSX, so a `.prettierrc.json` override must map it explicitly.
    const prettierrc = JSON.parse(readFileSync(join(REPO_ROOT, '.prettierrc.json'), 'utf8')) as {
      overrides?: { files: string }[];
    };
    const overrides = (prettierrc.overrides ?? []).map((o) => o.files).join('\n');
    for (const ext of ['ts', 'tsx', 'js', 'mjs', 'json']) {
      assert.match(
        overrides,
        new RegExp(`\\*\\.${ext}\\.template`),
        `.prettierrc.json must map .${ext}.template to a parser`,
      );
    }
  });

  it('the eslint config declares globs for every covered template code language', () => {
    // The historical miss was JS templates (`.js.template`/`.mjs.template`):
    // they end in `.template`, so no `.ts`/`.tsx` glob matched and ESLint
    // reported "ignored because no matching configuration". Assert the config
    // itself carries a glob for each ESLint-covered language so the miss cannot return.
    const eslintConfig = readFileSync(join(REPO_ROOT, 'eslint.config.mjs'), 'utf8');
    for (const ext of ESLINT_CODE_EXTENSIONS) {
      assert.match(
        eslintConfig,
        new RegExp(`templates/\\*\\*/\\*\\.${ext}`),
        `eslint.config.mjs must declare a templates glob for .${ext}`,
      );
    }
  });
});
